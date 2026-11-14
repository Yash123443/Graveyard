/**
 * egress-proxy.ts — reusable core of a CONNECT-only egress proxy that can
 * tunnel to exactly `github.com:443`. FOUNDATION ONLY.
 *
 * Status, stated plainly:
 *  - Nothing instantiates this class. It is not wired into the server, worker,
 *    acquisition adapter or any EgressGuard. `UnavailableEgressGuard` remains
 *    the only guard, so default egress stays unavailable and acquisition stays
 *    disabled.
 *  - It has no Docker network, no firewall and no attestation. Nothing here
 *    proves that a container can reach ONLY this proxy. Docker network
 *    attestation is a separate, unbuilt piece of infrastructure.
 *  - Written without running anything. Not production ready, not a security
 *    review.
 *
 * What the core does:
 *  - Binds only to a configured private or loopback IP literal. There is no
 *    default bind address. 0.0.0.0, ::, public addresses and host names are
 *    refused.
 *  - Accepts only `CONNECT github.com:443` over HTTP/1.1. The authority must
 *    equal that string exactly. Every other method gets 405. Absolute-form
 *    targets, paths, credentials, other ports, IP literals, other host names,
 *    case variants and malformed authorities are rejected before any DNS or
 *    network activity.
 *  - Rejects Proxy-Authorization, Authorization, Content-Length,
 *    Transfer-Encoding, Upgrade, Expect, duplicate or mismatched Host,
 *    control or non-ASCII bytes in headers, too many or too large headers,
 *    and any bytes sent before the 200 reply (pipelined or smuggled data).
 *  - Resolves github.com itself (never a client-supplied name) over IPv4 only
 *    (`family: 4`), requires EVERY answer to be a public IPv4 address (any
 *    IPv6 answer, including NAT64/DNS64, rejects the set), then connects to ONE validated IP literal
 *    ("pinning"). The connector never receives a name, so the connection cannot
 *    be re-resolved to a different address (DNS rebinding). Each CONNECT
 *    resolves and validates afresh.
 *  - After the 200 reply the bytes are relayed untouched in both directions
 *    (TLS passthrough). The proxy does not parse, follow or rewrite
 *    redirects, and it forwards no headers or credentials upstream.
 *  - Bounds: concurrent connections, bytes per tunnel, header size and count,
 *    header-read time, DNS time, connect time, idle time and total tunnel
 *    time. `close()` destroys everything and aborts pending DNS/connects.
 *
 * Not covered: rate limiting per client, authentication of clients (the
 * network binding is the only access control), DNS-level trust (the resolver
 * is the system resolver by default; a poisoned resolver that returns a public
 * attacker address is not detected), and the IP-to-github.com binding (TLS
 * verification is the client's job, which is why git must keep
 * `http.sslVerify=true`).
 *
 * @module egress-proxy
 */

import * as dns from "node:dns";
import * as http from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import { ALLOWED_EGRESS_HOSTS, type Validated } from "./acquisition-policy.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET_HOST = "github.com";
const TARGET_PORT = 443;
const TARGET_AUTHORITY = `${TARGET_HOST}:${TARGET_PORT}`;

if (ALLOWED_EGRESS_HOSTS.length !== 1 || ALLOWED_EGRESS_HOSTS[0] !== TARGET_HOST) {
  throw new Error("egress-proxy target must match ALLOWED_EGRESS_HOSTS");
}

/**
 * The only request line accepted, byte for byte. Node's HTTP parser (llhttp)
 * tolerates some irregular spacing in the request line, so `req.url` and
 * `req.method` cannot prove the line was canonical. The proxy therefore
 * captures the raw bytes before the parser sees them and compares them to
 * this string.
 */
const EXPECTED_REQUEST_LINE = `CONNECT ${TARGET_AUTHORITY} HTTP/1.1`;

const MIB = 1024 * 1024;

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: "Bad Request",
  403: "Forbidden",
  405: "Method Not Allowed",
  431: "Request Header Fields Too Large",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** Headers that must not appear on a CONNECT. Presence is a rejection, never a pass-through. */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  "proxy-authorization",
  "authorization",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "expect",
]);

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Tab is allowed; every other control character, DEL and any non-ASCII byte is not.
// eslint-disable-next-line no-control-regex
const BAD_HEADER_VALUE_RE = /[\u0000-\u0008\u000a-\u001f\u007f-\uffff]/;
const WELL_FORMED_AUTHORITY_RE = /^[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$/;

// ---------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------

export type IpVerdict =
  | { allowed: true; family: 4 | 6; address: string }
  | { allowed: false; reason: string };

/** Strict dotted-quad: four decimal octets, no leading zeros, no octal/hex/short forms. */
function parseIPv4(s: string): number[] | null {
  const m = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(s);
  if (m === null) return null;
  const out: number[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const n = Number(m[i]);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function v4int(o: readonly number[]): number {
  const [a = 0, b = 0, c = 0, d = 0] = o;
  return a * 16777216 + b * 65536 + c * 256 + d;
}

/** Every IPv4 range that is not ordinary public unicast, by name. */
const BLOCKED_V4: ReadonlyArray<readonly [string, string, number]> = [
  ["this-network", "0.0.0.0", 8],
  ["private", "10.0.0.0", 8],
  ["shared-address-space", "100.64.0.0", 10],
  ["loopback", "127.0.0.0", 8],
  ["link-local-or-metadata", "169.254.0.0", 16],
  ["private", "172.16.0.0", 12],
  ["ietf-protocol-assignments", "192.0.0.0", 24],
  ["documentation", "192.0.2.0", 24],
  ["6to4-relay", "192.88.99.0", 24],
  ["private", "192.168.0.0", 16],
  ["benchmarking", "198.18.0.0", 15],
  ["documentation", "198.51.100.0", 24],
  ["documentation", "203.0.113.0", 24],
  ["multicast", "224.0.0.0", 4],
  ["reserved-or-broadcast", "240.0.0.0", 4],
];

function inV4Range(addr: number, base: string, prefix: number): boolean {
  const size = 2 ** (32 - prefix);
  const b = parseIPv4(base);
  if (b === null) return false;
  return Math.floor(addr / size) === Math.floor(v4int(b) / size);
}

function blockedV4Reason(o: readonly number[]): string | null {
  const a = v4int(o);
  for (const [name, base, prefix] of BLOCKED_V4) {
    if (inV4Range(a, base, prefix)) return name;
  }
  return null;
}

function parseIPv6(s: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null; // also rejects zone ids ("%")
  let str = s;
  if (s.includes(".")) {
    const i = s.lastIndexOf(":");
    const v4 = parseIPv4(s.slice(i + 1));
    if (v4 === null) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    str = `${s.slice(0, i + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const groupsOf = (p: string): number[] | null => {
    if (p === "") return [];
    const out: number[] = [];
    for (const g of p.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const halves = str.split("::");
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const g = groupsOf(str);
    return g !== null && g.length === 8 ? g : null;
  }
  const head = groupsOf(halves[0] ?? "");
  const tail = groupsOf(halves[1] ?? "");
  if (head === null || tail === null || head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

function blockedV6Reason(g: readonly number[]): string | null {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0xffff) return "ipv4-mapped";
    return "unspecified-loopback-or-ipv4-compatible";
  }
  // Allowlist: only global unicast 2000::/3 may continue.
  if ((g0 & 0xe000) !== 0x2000) return "not-global-unicast";
  if (g0 === 0x2001 && g1 < 0x0200) return "ietf-protocol-assignments-or-teredo";
  if (g0 === 0x2001 && g1 === 0x0db8) return "documentation";
  if (g0 === 0x2002) return "6to4";
  if (g0 === 0x3fff && g1 < 0x1000) return "documentation";
  return null;
}

/**
 * Allows only ordinary public unicast addresses written in canonical literal
 * form. Everything else, including text that is not an IP literal, is refused.
 * IPv4-mapped, IPv4-compatible, NAT64, 6to4 and Teredo IPv6 forms are refused
 * outright instead of being unwrapped.
 */
export function classifyIp(address: unknown): IpVerdict {
  if (typeof address !== "string" || address.length === 0 || address.length > 45) {
    return { allowed: false, reason: "not-an-ip-literal" };
  }
  const v4 = parseIPv4(address);
  if (v4 !== null) {
    const why = blockedV4Reason(v4);
    return why === null ? { allowed: true, family: 4, address } : { allowed: false, reason: why };
  }
  const v6 = parseIPv6(address);
  if (v6 !== null) {
    const why = blockedV6Reason(v6);
    return why === null ? { allowed: true, family: 6, address } : { allowed: false, reason: why };
  }
  return { allowed: false, reason: "not-an-ip-literal" };
}

/**
 * The bind address must be an IP literal on a private or loopback range
 * (10/8, 172.16/12, 192.168/16, 127/8, ::1, fc00::/7). Wildcards, public
 * addresses, link-local addresses and host names are refused.
 */
export function validateBindHost(host: unknown): Validated<string> {
  if (typeof host !== "string" || host.length === 0) return { ok: false, reason: "bindHost is required" };
  const v4 = parseIPv4(host);
  if (v4 !== null) {
    const a = v4int(v4);
    const ok =
      inV4Range(a, "10.0.0.0", 8) ||
      inV4Range(a, "172.16.0.0", 12) ||
      inV4Range(a, "192.168.0.0", 16) ||
      inV4Range(a, "127.0.0.0", 8);
    return ok ? { ok: true, value: host } : { ok: false, reason: "bindHost must be a private or loopback IPv4 address" };
  }
  const v6 = parseIPv6(host);
  if (v6 !== null) {
    const [g0 = 0] = v6;
    const loopback = v6.slice(0, 7).every((x) => x === 0) && v6[7] === 1;
    const ula = (g0 & 0xfe00) === 0xfc00;
    return loopback || ula ? { ok: true, value: host } : { ok: false, reason: "bindHost must be ::1 or a unique-local IPv6 address" };
  }
  return { ok: false, reason: "bindHost must be an IP literal" };
}

// ---------------------------------------------------------------------------
// Request validation (pure)
// ---------------------------------------------------------------------------

export type AuthorityVerdict =
  | { ok: true }
  | { ok: false; status: 400 | 403; code: "malformed-authority" | "authority-not-allowed" };

/** The CONNECT target must be exactly `github.com:443`. Nothing else passes. */
export function validateConnectAuthority(raw: unknown): AuthorityVerdict {
  if (raw === TARGET_AUTHORITY) return { ok: true };
  if (typeof raw === "string" && WELL_FORMED_AUTHORITY_RE.test(raw)) {
    return { ok: false, status: 403, code: "authority-not-allowed" };
  }
  return { ok: false, status: 400, code: "malformed-authority" };
}

export interface ConnectRequestView {
  method: string | undefined;
  url: string | undefined;
  httpVersion: string;
  /** Flat [name, value, name, value, ...] exactly as received. */
  rawHeaders: readonly string[];
  /** Bytes that arrived after the header block. Must be zero. */
  headBytes: number;
  /**
   * The request line exactly as received (without CRLF), or null when it could
   * not be captured. When the field is present it must equal
   * `CONNECT github.com:443 HTTP/1.1`; null fails closed. Omitted only by pure
   * unit tests of the other checks.
   */
  rawRequestLine?: string | null | undefined;
}

export type RequestVerdict = { ok: true } | { ok: false; status: number; code: string };

export function validateConnectRequest(view: ConnectRequestView, limits: { maxHeaders: number }): RequestVerdict {
  if (view.method !== "CONNECT") return { ok: false, status: 405, code: "method-not-allowed" };
  if (view.httpVersion !== "1.1") return { ok: false, status: 400, code: "http-version" };
  const auth = validateConnectAuthority(view.url);
  if (!auth.ok) return { ok: false, status: auth.status, code: auth.code };
  if (view.rawRequestLine !== undefined && view.rawRequestLine !== EXPECTED_REQUEST_LINE) {
    return { ok: false, status: 400, code: "request-line" };
  }
  if (view.rawHeaders.length % 2 !== 0 || view.rawHeaders.length / 2 > limits.maxHeaders) {
    return { ok: false, status: 431, code: "too-many-headers" };
  }
  let hosts = 0;
  for (let i = 0; i < view.rawHeaders.length; i += 2) {
    const name = view.rawHeaders[i] ?? "";
    const value = view.rawHeaders[i + 1] ?? "";
    if (!HEADER_NAME_RE.test(name)) return { ok: false, status: 400, code: "bad-header-name" };
    if (BAD_HEADER_VALUE_RE.test(value)) return { ok: false, status: 400, code: "bad-header-value" };
    const lower = name.toLowerCase();
    if (lower === "proxy-authorization" || lower === "authorization") {
      return { ok: false, status: 403, code: "credentials-rejected" };
    }
    if (FORBIDDEN_HEADERS.has(lower)) return { ok: false, status: 400, code: "forbidden-header" };
    if (lower === "host") {
      hosts += 1;
      if (hosts > 1 || value !== TARGET_AUTHORITY) return { ok: false, status: 400, code: "host-mismatch" };
    }
  }
  if (view.headBytes > 0) return { ok: false, status: 400, code: "early-data" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What the connector receives: an IP literal that already passed validation. Never a name to resolve. */
export interface PinnedTarget {
  readonly hostname: typeof TARGET_HOST;
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: typeof TARGET_PORT;
}

/** Resolves `hostname` (always "github.com") to IP literals. Must honour `signal`. */
export type EgressResolver = (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;

/** Opens a raw byte stream to exactly the pinned IP. Must not resolve names and must honour `signal`. */
export type EgressConnector = (target: PinnedTarget, signal: AbortSignal) => Promise<Duplex>;

/** Structured, sanitized events. They never contain client-supplied text. */
export type ProxyEvent =
  | { kind: "rejected"; status: number; code: string }
  | { kind: "tunnel-open"; address: string }
  | { kind: "tunnel-closed"; reason: string; bytes: number };

export interface EgressProxyLimits {
  maxClients: number;
  /** Bytes in both directions combined, per tunnel. */
  maxTunnelBytes: number;
  maxHeaderBytes: number;
  maxHeaders: number;
  headerTimeoutMs: number;
  resolveTimeoutMs: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  /** Wall-clock bound for one tunnel. */
  maxTunnelMs: number;
}

export const DEFAULT_EGRESS_PROXY_LIMITS: Readonly<EgressProxyLimits> = Object.freeze({
  maxClients: 16,
  maxTunnelBytes: 256 * MIB,
  maxHeaderBytes: 4096,
  maxHeaders: 32,
  headerTimeoutMs: 10_000,
  resolveTimeoutMs: 5_000,
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 30_000,
  maxTunnelMs: 300_000,
});

const LIMIT_RANGES: Record<keyof EgressProxyLimits, [number, number]> = {
  maxClients: [1, 256],
  maxTunnelBytes: [1024, 2048 * MIB],
  maxHeaderBytes: [512, 16 * 1024],
  maxHeaders: [1, 64],
  headerTimeoutMs: [10, 60_000],
  resolveTimeoutMs: [10, 60_000],
  connectTimeoutMs: [10, 60_000],
  idleTimeoutMs: [10, 600_000],
  maxTunnelMs: [10, 3_600_000],
};

export function checkEgressProxyLimits(partial?: Partial<EgressProxyLimits>): EgressProxyLimits {
  const l: EgressProxyLimits = { ...DEFAULT_EGRESS_PROXY_LIMITS, ...(partial ?? {}) };
  for (const key of Object.keys(LIMIT_RANGES) as Array<keyof EgressProxyLimits>) {
    const [lo, hi] = LIMIT_RANGES[key];
    const v = l[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
      throw new Error(`proxy limit ${key} must be an integer between ${lo} and ${hi}`);
    }
  }
  return l;
}

export interface EgressProxyOptions {
  /** Private or loopback IP literal. No default: the proxy never picks an interface for you. */
  bindHost: string;
  /** 0 selects an ephemeral port. */
  port?: number;
  limits?: Partial<EgressProxyLimits>;
  /** Default: system resolver (`dns.lookup`, IPv4 only, all answers). */
  resolver?: EgressResolver;
  /** Default: `net.connect` to the pinned IP literal. */
  connector?: EgressConnector;
  onEvent?: (event: ProxyEvent) => void;
}

// ---------------------------------------------------------------------------
// Default resolver and connector
// ---------------------------------------------------------------------------

// IPv4-only lookup (family: 4) through the default resolver. This avoids
// DNS64-synthesized AAAA answers (e.g. 64:ff9b::/96) in NAT64 environments
// without trusting them. The proxy still validates every returned address and
// rejects any non-IPv4 answer from an injected resolver.
export const systemResolver: EgressResolver = async (hostname) => {
  const all = await dns.promises.lookup(hostname, { all: true, family: 4 });
  return all.map((a) => a.address);
};

export const directConnector: EgressConnector = (target, signal) =>
  new Promise<Duplex>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    // The host is an IP literal, so net.connect performs no DNS lookup.
    const s = net.connect({ host: target.address, port: target.port, family: target.family, noDelay: true });
    const onAbort = (): void => {
      s.destroy();
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    s.once("connect", () => {
      signal.removeEventListener("abort", onAbort);
      s.removeAllListeners("error");
      resolve(s);
    });
    s.once("error", (e) => {
      signal.removeEventListener("abort", onAbort);
      reject(e);
    });
  });

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

class StageTimeout extends Error {}

interface Tunnel {
  end(reason: string): void;
}

export class EgressProxy {
  private readonly bindHost: string;
  private readonly port: number;
  private readonly limits: EgressProxyLimits;
  private readonly resolver: EgressResolver;
  private readonly connector: EgressConnector;
  private readonly onEvent: ((e: ProxyEvent) => void) | undefined;
  private readonly server: http.Server;
  /** Tracked client sockets, each mapped to a promise that resolves on its 'close' event. */
  private readonly sockets = new Map<net.Socket, Promise<void>>();
  private readonly tunnels = new Set<Tunnel>();
  private readonly pending = new Set<AbortController>();
  private readonly requestLines = new WeakMap<net.Socket, string>();
  private closePromise: Promise<void> | undefined;
  private listening = false;
  private closing = false;

  constructor(opts: EgressProxyOptions) {
    const bind = validateBindHost(opts?.bindHost);
    if (!bind.ok) throw new Error(bind.reason);
    this.bindHost = bind.value;
    const port = opts.port ?? 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer 0-65535");
    this.port = port;
    this.limits = checkEgressProxyLimits(opts.limits);
    this.resolver = opts.resolver ?? systemResolver;
    this.connector = opts.connector ?? directConnector;
    this.onEvent = opts.onEvent;

    this.server = http.createServer({ maxHeaderSize: this.limits.maxHeaderBytes }, (req, res) => {
      // Every non-CONNECT request, including absolute-form proxy requests, ends here.
      this.emit({ kind: "rejected", status: 405, code: "method-not-allowed" });
      res.writeHead(405, { Allow: "CONNECT", Connection: "close", "Content-Length": "0" });
      res.end();
      req.resume();
    });
    this.server.maxConnections = this.limits.maxClients;
    this.server.maxRequestsPerSocket = 1;
    this.server.on("connection", (s) => this.onConnection(s));
    this.server.on("connect", (req, socket, head) => {
      void this.onConnect(req, socket as net.Socket, head);
    });
    this.server.on("upgrade", (_req, socket) => {
      this.rejectSocket(socket as net.Socket, 400, "upgrade-rejected");
    });
    this.server.on("clientError", (err, socket) => {
      const code = (err as NodeJS.ErrnoException).code;
      const status = code === "HPE_HEADER_OVERFLOW" ? 431 : 400;
      this.rejectSocket(socket as net.Socket, status, "malformed-request");
    });
  }

  /** Starts listening on the configured private address only. */
  start(): Promise<{ host: string; port: number }> {
    if (this.closing || this.listening) return Promise.reject(new Error("proxy already started or closed"));
    return new Promise((resolve, reject) => {
      const onError = (e: Error): void => reject(e);
      this.server.once("error", onError);
      this.server.listen({ host: this.bindHost, port: this.port, exclusive: true }, () => {
        this.server.off("error", onError);
        const a = this.server.address();
        if (a === null || typeof a === "string") {
          this.server.close();
          reject(new Error("proxy did not bind to a TCP address"));
          return;
        }
        this.listening = true;
        resolve({ host: a.address, port: a.port });
      });
    });
  }

  /**
   * Stops accepting, ends every tunnel, aborts pending DNS/connects, destroys
   * every socket and resolves only after each client socket has emitted
   * 'close' (so `activeConnections` is 0). Idempotent: concurrent and later
   * calls share one promise. Rejects if a socket has not closed after 5 s.
   */
  close(): Promise<void> {
    this.closePromise ??= this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.closing = true;
    for (const ac of [...this.pending]) ac.abort();
    for (const t of [...this.tunnels]) t.end("shutdown");
    // Each tracked socket has a promise that resolves on its own 'close' event
    // (registered in onConnection), so a socket that already closed is never missed.
    const closed = [...this.sockets.values()];
    for (const s of this.sockets.keys()) s.destroy();
    const listenerClosed = this.listening
      ? new Promise<void>((resolve) => {
          this.listening = false;
          this.server.close(() => resolve());
        })
      : Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), 5000);
    });
    try {
      const r = await Promise.race([Promise.all([...closed, listenerClosed]).then(() => "ok" as const), limit]);
      if (r === "timeout") throw new Error("proxy sockets did not close within 5 s");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  get activeConnections(): number {
    return this.sockets.size;
  }

  // -------------------------------------------------------------------------

  private emit(e: ProxyEvent): void {
    try {
      this.onEvent?.(e);
    } catch {
      /* observers must not affect the proxy */
    }
  }

  private onConnection(s: net.Socket): void {
    if (this.closing) {
      s.destroy();
      return;
    }
    this.sockets.set(
      s,
      new Promise<void>((resolve) => {
        s.once("close", () => {
          this.sockets.delete(s);
          resolve();
        });
      }),
    );
    s.on("error", () => s.destroy());
    // Capture the raw request line before Node's parser can normalise it. The
    // listener is prepended so it runs first, stops at the first CRLF and is
    // bounded by maxHeaderBytes. A line that never ends in CRLF stays unset,
    // and onConnect treats that as a rejection.
    let acc = Buffer.alloc(0);
    const capture = (chunk: Buffer | string): void => {
      acc = Buffer.concat([acc, typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk]);
      const i = acc.indexOf("\r\n");
      if (i >= 0) {
        this.requestLines.set(s, acc.subarray(0, i).toString("latin1"));
        s.off("data", capture);
      } else if (acc.length > this.limits.maxHeaderBytes) {
        s.off("data", capture);
      }
    };
    s.prependListener("data", capture);
    // Slow-header bound. Cleared once the CONNECT head has been parsed.
    s.setTimeout(this.limits.headerTimeoutMs, () => s.destroy());
  }

  private rejectSocket(socket: net.Socket, status: number, code: string): void {
    this.emit({ kind: "rejected", status, code });
    socket.setTimeout(0);
    if (!socket.destroyed && socket.writable) {
      const text = STATUS_TEXT[status] ?? "Error";
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      // Do not wait for a client that never closes its side.
      const t = setTimeout(() => socket.destroy(), 1000);
      socket.once("close", () => clearTimeout(t));
    } else {
      socket.destroy();
    }
  }

  /**
   * Runs `make` bounded by `ms` and by `parent`. Aborting `parent` (client
   * gone, early data, close()) rejects at once and aborts the signal handed to
   * `make`. A result that arrives after that point is passed to `late`.
   */
  private bounded<T>(
    ms: number,
    parent: AbortSignal,
    make: (signal: AbortSignal) => Promise<T>,
    late?: (v: T) => void,
  ): Promise<T> {
    if (parent.aborted) return Promise.reject(new Error("aborted"));
    const ac = new AbortController();
    return new Promise<T>((resolve, reject) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        parent.removeEventListener("abort", onParent);
      };
      const onParent = (): void => {
        if (done) return;
        finish();
        ac.abort();
        reject(new Error("aborted"));
      };
      timer = setTimeout(() => {
        if (done) return;
        finish();
        ac.abort();
        reject(new StageTimeout("timeout"));
      }, ms);
      parent.addEventListener("abort", onParent, { once: true });
      Promise.resolve()
        .then(() => {
          if (ac.signal.aborted) throw new Error("aborted");
          return make(ac.signal);
        })
        .then(
          (v) => {
            if (done) {
              late?.(v);
              return;
            }
            finish();
            resolve(v);
          },
          (e: unknown) => {
            if (done) return;
            finish();
            reject(e instanceof Error ? e : new Error("failed"));
          },
        );
    });
  }

  private async onConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    socket.setTimeout(0);
    if (this.closing) {
      this.rejectSocket(socket, 503, "shutting-down");
      return;
    }
    const verdict = validateConnectRequest(
      {
        method: req.method,
        url: req.url,
        httpVersion: req.httpVersion,
        rawHeaders: req.rawHeaders,
        headBytes: head.length,
        rawRequestLine: this.requestLines.get(socket) ?? null,
      },
      { maxHeaders: this.limits.maxHeaders },
    );
    if (!verdict.ok) {
      this.rejectSocket(socket, verdict.status, verdict.code);
      return;
    }

    // One controller per CONNECT. Client close, early data and close() all abort it,
    // which cancels pending DNS and connect and keeps the connector from being called.
    const life = new AbortController();
    this.pending.add(life);
    // The HTTP server creates sockets with allowHalfOpen, so a client that disconnects
    // delivers "end" and "close" only after we end our side. Treat "end" and "error" as
    // a disconnect too, otherwise pending DNS would never be cancelled.
    const onClientClose = (): void => {
      life.abort();
      if (!socket.destroyed) socket.destroy();
    };
    socket.once("close", onClientClose);
    socket.once("end", onClientClose);
    socket.once("error", onClientClose);

    // A client must wait for the 200 reply. Anything earlier is pipelined or smuggled data.
    let early = false;
    const onEarly = (): void => {
      early = true;
      life.abort();
      socket.destroy();
    };
    socket.on("data", onEarly);

    let upstream: Duplex | undefined;
    try {
      let answers: readonly string[];
      try {
        answers = await this.bounded(this.limits.resolveTimeoutMs, life.signal, (sig) =>
          this.resolver(TARGET_HOST, sig),
        );
      } catch (e) {
        this.failStage(socket, e, "dns-failed", "dns-timeout");
        return;
      }
      if (life.signal.aborted) {
        socket.destroy();
        return;
      }
      if (!Array.isArray(answers) || answers.length === 0 || answers.length > 32) {
        this.rejectSocket(socket, 502, "dns-failed");
        return;
      }
      // Fail closed: one unacceptable answer rejects the whole set.
      const ok: Array<{ address: string; family: 4 | 6 }> = [];
      for (const a of answers) {
        const v = classifyIp(a);
        if (!v.allowed) {
          this.rejectSocket(socket, 403, "blocked-address");
          return;
        }
        // IPv4 only. Any IPv6 answer (including DNS64/NAT64 synthesized ones)
        // rejects the whole set. Never filtered out, never trusted.
        if (v.family !== 4) {
          this.rejectSocket(socket, 403, "non-ipv4-address");
          return;
        }
        ok.push({ address: v.address, family: v.family });
      }
      const pin = ok[0];
      if (pin === undefined) {
        this.rejectSocket(socket, 502, "dns-failed");
        return;
      }
      const target: PinnedTarget = Object.freeze({
        hostname: TARGET_HOST,
        address: pin.address,
        family: pin.family,
        port: TARGET_PORT,
      });

      try {
        upstream = await this.bounded(
          this.limits.connectTimeoutMs,
          life.signal,
          (sig) => this.connector(target, sig),
          (late) => late.destroy(),
        );
      } catch (e) {
        this.failStage(socket, e, "connect-failed", "connect-timeout");
        return;
      }
      if (early || life.signal.aborted || socket.destroyed || this.closing) {
        upstream.destroy();
        socket.destroy();
        return;
      }
      socket.off("data", onEarly);
      socket.pause();
      this.startTunnel(socket, upstream, pin.address);
    } catch {
      upstream?.destroy();
      socket.destroy();
    } finally {
      // The tunnel (if any) now owns the sockets. Stop tracking the setup phase.
      socket.off("close", onClientClose);
      socket.off("end", onClientClose);
      socket.off("error", onClientClose);
      this.pending.delete(life);
    }
  }

  private failStage(socket: net.Socket, e: unknown, code: string, timeoutCode: string): void {
    if (this.closing || socket.destroyed) {
      socket.destroy();
      return;
    }
    if (e instanceof StageTimeout) this.rejectSocket(socket, 504, timeoutCode);
    else this.rejectSocket(socket, 502, code);
  }

  /** Sends the bare 200 reply, then relays bytes untouched until a bound is hit or either side closes. */
  private startTunnel(client: net.Socket, upstream: Duplex, address: string): void {
    let bytes = 0;
    let ended = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let maxTimer: NodeJS.Timeout | undefined;

    const tunnel: Tunnel = {
      end: (reason: string): void => {
        if (ended) return;
        ended = true;
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        if (maxTimer !== undefined) clearTimeout(maxTimer);
        this.tunnels.delete(tunnel);
        client.destroy();
        upstream.destroy();
        this.emit({ kind: "tunnel-closed", reason, bytes });
      },
    };
    const arm = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => tunnel.end("idle-timeout"), this.limits.idleTimeoutMs);
    };
    const relay = (from: Duplex, to: Duplex): void => {
      from.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > this.limits.maxTunnelBytes) {
          tunnel.end("byte-limit");
          return;
        }
        arm();
        if (!to.write(chunk)) {
          from.pause();
          to.once("drain", () => from.resume());
        }
      });
      from.on("end", () => {
        if (!ended) to.end();
      });
      from.on("error", () => tunnel.end("stream-error"));
      from.on("close", () => tunnel.end("closed"));
    };

    this.tunnels.add(tunnel);
    arm();
    maxTimer = setTimeout(() => tunnel.end("max-duration"), this.limits.maxTunnelMs);
    this.emit({ kind: "tunnel-open", address });
    relay(client, upstream);
    relay(upstream, client);
    // The reply carries no headers: no proxy identity, no credentials, nothing from upstream.
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    client.resume();
  }
}
