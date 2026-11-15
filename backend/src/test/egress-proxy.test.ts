/**
 * egress-proxy.test.ts — adversarial tests for the CONNECT proxy core.
 *
 * Resolver and connector are injected; no test touches the real network or
 * real DNS. Tests that open sockets use 127.0.0.1 ephemeral ports (they will
 * fail in an environment that forbids that). These tests were written without
 * being run. They show the core refuses what it should against a fake
 * upstream; they do not show Docker-network isolation or production safety.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import {
  EgressProxy,
  checkEgressProxyLimits,
  checkEgressTarget,
  classifyIp,
  validateBindHost,
  validateConnectAuthority,
  validateConnectRequest,
  type EgressConnector,
  type EgressProxyLimits,
  type EgressResolver,
  type EgressTargetHost,
  type PinnedTarget,
  type ProxyEvent,
} from "../egress-proxy.js";
import { UnavailableEgressGuard } from "../acquisition-policy.js";

const PUBLIC_V4 = "140.82.112.3";
const PUBLIC_V4_B = "140.82.113.4";
const PUBLIC_V6 = "2606:50c0:8000::154";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  proxy: EgressProxy;
  port: number;
  targets: PinnedTarget[];
  resolverCalls: { n: number };
  events: ProxyEvent[];
  upstreamReceived: Buffer[];
  upstreamPort: number;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function harness(
  over: { resolver?: EgressResolver; connector?: EgressConnector; limits?: Partial<EgressProxyLimits>; upstream?: (s: net.Socket) => void; target?: EgressTargetHost } = {},
): Promise<Harness> {
  const upstreamReceived: Buffer[] = [];
  const upstreamSockets = new Set<net.Socket>();
  const upstreamServer = net.createServer((s) => {
    upstreamSockets.add(s);
    s.on("close", () => upstreamSockets.delete(s));
    s.on("error", () => undefined);
    s.on("data", (d) => upstreamReceived.push(d));
    if (over.upstream !== undefined) over.upstream(s);
    else s.on("data", (d) => s.write(d)); // echo
  });
  await new Promise<void>((r) => upstreamServer.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstreamServer.address() as net.AddressInfo).port;

  const targets: PinnedTarget[] = [];
  const resolverCalls = { n: 0 };
  const events: ProxyEvent[] = [];
  const resolver: EgressResolver =
    over.resolver ??
    ((): Promise<string[]> => {
      return Promise.resolve([PUBLIC_V4]);
    });
  const connector: EgressConnector =
    over.connector ??
    ((_t, _sig): Promise<Duplex> =>
      new Promise((resolve, reject) => {
        const s = net.connect(upstreamPort, "127.0.0.1");
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      }));

  const proxy = new EgressProxy({
    bindHost: "127.0.0.1",
    port: 0,
    ...(over.target === undefined ? {} : { target: over.target }),
    limits: over.limits ?? {},
    resolver: (h, sig) => {
      resolverCalls.n += 1;
      return resolver(h, sig);
    },
    connector: (t, sig) => {
      targets.push(t);
      return connector(t, sig);
    },
    onEvent: (e) => events.push(e),
  });
  const { port } = await proxy.start();
  cleanups.push(async () => {
    await proxy.close();
    for (const s of upstreamSockets) s.destroy();
    await new Promise<void>((r) => upstreamServer.close(() => r()));
  });
  return { proxy, port, targets, resolverCalls, events, upstreamReceived, upstreamPort };
}

/** Sends raw bytes and returns everything received until the proxy closes the socket (or 1.5 s). */
function raw(port: number, payload: string | Buffer, waitMs = 1500): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const s = net.connect(port, "127.0.0.1", () => s.write(payload));
    s.on("data", (d) => chunks.push(d));
    s.on("error", () => undefined);
    const done = (): void => {
      clearTimeout(t);
      s.destroy();
      resolve(Buffer.concat(chunks).toString("latin1"));
    };
    const t = setTimeout(done, waitMs);
    s.on("close", done);
  });
}

function statusOf(text: string): number | null {
  const m = /^HTTP\/1\.1 (\d{3}) /.exec(text);
  return m === null ? null : Number(m[1]);
}

const CONNECT_OK = "CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n";

interface Tunnel {
  socket: net.Socket;
  received: Buffer[];
  statusLine: string;
}

/** Opens a tunnel and waits for the reply head. Later bytes accumulate in `received`. */
function openTunnel(port: number, request = CONNECT_OK): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const received: Buffer[] = [];
    let buf = Buffer.alloc(0);
    let opened = false;
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    socket.on("error", (e) => {
      if (!opened) reject(e);
    });
    socket.on("data", (d) => {
      if (opened) {
        received.push(d);
        return;
      }
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n\r\n");
      if (i < 0) return;
      opened = true;
      const rest = buf.subarray(i + 4);
      if (rest.length > 0) received.push(rest);
      resolve({ socket, received, statusLine: buf.subarray(0, i).toString("latin1") });
    });
    socket.on("close", () => {
      if (!opened) reject(new Error("closed before reply"));
    });
  });
}

function closedWithin(s: net.Socket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (s.destroyed) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    s.once("close", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const total = (bufs: Buffer[]): number => bufs.reduce((n, b) => n + b.length, 0);

// ---------------------------------------------------------------------------
// Pure checks
// ---------------------------------------------------------------------------

describe("classifyIp", () => {
  const blocked = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255",
    "127.0.0.1", "127.255.255.254", "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255",
    "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.1",
    "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::2", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "::ffff:140.82.112.3",
    "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:db8::1", "3fff::1", "fec0::1", "100::1",
    "", "github.com", "localhost", "127.1", "0177.0.0.1", "2130706433", "0x7f.0.0.1", "01.2.3.4", "1.2.3", "1.2.3.4.5",
    "256.1.1.1", "1.2.3.4 ", " 1.2.3.4", "1.2.3.4\n", "fe80::1%eth0", "[::1]", "::1/128", "1::2::3", "12345::1", "1:2:3:4:5:6:7:8:9",
  ];
  for (const a of blocked) {
    it(`blocks ${JSON.stringify(a)}`, () => {
      assert.equal(classifyIp(a).allowed, false);
    });
  }

  it("blocks non-strings", () => {
    for (const v of [undefined, null, 5, {}, [], ["1.1.1.1"]]) assert.equal(classifyIp(v).allowed, false);
  });

  it("allows ordinary public addresses", () => {
    for (const a of [PUBLIC_V4, "8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", PUBLIC_V6, "2a00:1450:4001::1"]) {
      assert.equal(classifyIp(a).allowed, true, a);
    }
  });

  it("reports the family", () => {
    const v4 = classifyIp(PUBLIC_V4);
    const v6 = classifyIp(PUBLIC_V6);
    assert.ok(v4.allowed && v4.family === 4);
    assert.ok(v6.allowed && v6.family === 6);
  });
});

describe("validateBindHost", () => {
  it("accepts private and loopback IP literals", () => {
    for (const h of ["127.0.0.1", "10.1.2.3", "172.18.0.1", "192.168.0.5", "::1", "fd12:3456::1"]) {
      assert.equal(validateBindHost(h).ok, true, h);
    }
  });
  it("rejects wildcard, public, link-local, hostnames and junk", () => {
    for (const h of ["0.0.0.0", "::", "8.8.8.8", "140.82.112.3", "169.254.1.1", "fe80::1", "2606:50c0::1", "localhost", "github.com", "", "127.0.0.1:80", "172.32.0.1", undefined, null, 5]) {
      assert.equal(validateBindHost(h).ok, false, String(h));
    }
  });
  it("EgressProxy refuses a public or missing bind address at construction", () => {
    assert.throws(() => new EgressProxy({ bindHost: "0.0.0.0" }));
    assert.throws(() => new EgressProxy({ bindHost: "::" }));
    assert.throws(() => new EgressProxy({ bindHost: "8.8.8.8" }));
    assert.throws(() => new EgressProxy({} as unknown as { bindHost: string }));
  });
});

describe("validateConnectAuthority", () => {
  it("accepts only the exact string", () => {
    assert.equal(validateConnectAuthority("github.com:443").ok, true);
  });
  it("rejects everything else", () => {
    const bad = [
      "github.com", "github.com:80", "github.com:8443", "github.com:0443", "github.com:00443", "github.com:443 ", " github.com:443",
      "GitHub.com:443", "GITHUB.COM:443", "github.com.:443", "api.github.com:443", "evilgithub.com:443", "github.com.evil.com:443",
      "user@github.com:443", "user:pw@github.com:443", "github.com:443@evil.com:443", "github.com:443,evil.com:443",
      "http://github.com:443/", "https://github.com/", "/github.com:443", "github.com:443/x", "github.com:443?x", "github.com:443#x",
      "[::1]:443", "127.0.0.1:443", "169.254.169.254:443", "2130706433:443", "github.com:443\r\nHost: evil", "github.com\u0000:443",
      "github%2ecom:443", "github.com\\:443", "", "*", undefined, null, 443, {},
    ];
    for (const a of bad) assert.equal(validateConnectAuthority(a).ok, false, JSON.stringify(a));
  });
  it("uses 403 for well-formed but disallowed and 400 for malformed", () => {
    const a = validateConnectAuthority("example.com:443");
    assert.ok(!a.ok && a.status === 403);
    const b = validateConnectAuthority("user@github.com:443");
    assert.ok(!b.ok && b.status === 400);
  });
});

describe("validateConnectRequest", () => {
  const base = { method: "CONNECT", url: "github.com:443", httpVersion: "1.1", rawHeaders: ["Host", "github.com:443"], headBytes: 0 };
  const lim = { maxHeaders: 8 };
  it("accepts the baseline", () => {
    assert.equal(validateConnectRequest(base, lim).ok, true);
    assert.equal(validateConnectRequest({ ...base, rawHeaders: [] }, lim).ok, true);
    assert.equal(validateConnectRequest({ ...base, rawHeaders: ["Host", "github.com:443", "User-Agent", "git/2.45\tx"] }, lim).ok, true);
  });
  it("rejects each adversarial variation", () => {
    const cases: Array<Partial<typeof base>> = [
      { method: "GET" }, { method: "connect" }, { method: undefined }, { httpVersion: "1.0" }, { httpVersion: "2.0" },
      { url: "github.com:80" }, { headBytes: 1 },
      { rawHeaders: ["Host", "github.com:443", "Host", "github.com:443"] },
      { rawHeaders: ["Host", "evil.com:443"] }, { rawHeaders: ["Host", "github.com"] },
      { rawHeaders: ["Proxy-Authorization", "Basic eDp5"] }, { rawHeaders: ["proxy-authorization", "x"] },
      { rawHeaders: ["Authorization", "Bearer x"] },
      { rawHeaders: ["Content-Length", "0"] }, { rawHeaders: ["content-length", "5"] },
      { rawHeaders: ["Transfer-Encoding", "chunked"] },
      { rawHeaders: ["Content-Length", "4", "Transfer-Encoding", "chunked"] },
      { rawHeaders: ["Upgrade", "websocket"] }, { rawHeaders: ["Expect", "100-continue"] },
      { rawHeaders: ["X", "a\u0000b"] }, { rawHeaders: ["X", "a\rb"] }, { rawHeaders: ["X", "a\nb"] }, { rawHeaders: ["X", "a\u001bb"] },
      { rawHeaders: ["X", "a\u007fb"] }, { rawHeaders: ["X", "caf\u00e9"] },
      { rawHeaders: ["X Y", "a"] }, { rawHeaders: ["X:", "a"] }, { rawHeaders: ["", "a"] }, { rawHeaders: ["X\r\nY", "a"] },
      { rawHeaders: ["X"] },
      { rawHeaders: Array.from({ length: 18 }, (_, i) => (i % 2 === 0 ? `X${i}` : "v")) },
    ];
    for (const c of cases) {
      const v = validateConnectRequest({ ...base, ...c }, lim);
      assert.equal(v.ok, false, JSON.stringify(c));
    }
  });
  it("requires the raw request line to match byte for byte when it is supplied, and fails closed on null", () => {
    const ok = "CONNECT github.com:443 HTTP/1.1";
    assert.equal(validateConnectRequest({ ...base, rawRequestLine: ok }, lim).ok, true);
    for (const bad of [null, "", "CONNECT  github.com:443 HTTP/1.1", "CONNECT github.com:443 HTTP/1.1 ", "connect github.com:443 HTTP/1.1", "CONNECT github.com:443 HTTP/1.0"]) {
      const v = validateConnectRequest({ ...base, rawRequestLine: bad }, lim);
      assert.ok(!v.ok && v.status === 400, JSON.stringify(bad));
    }
  });
  it("answers 405 for other methods and 403 for credentials", () => {
    const m = validateConnectRequest({ ...base, method: "GET" }, lim);
    assert.ok(!m.ok && m.status === 405);
    const c = validateConnectRequest({ ...base, rawHeaders: ["Proxy-Authorization", "x"] }, lim);
    assert.ok(!c.ok && c.status === 403);
  });
});

describe("checkEgressProxyLimits", () => {
  it("accepts defaults and rejects out-of-range, zero, negative, fractional and NaN", () => {
    assert.doesNotThrow(() => checkEgressProxyLimits());
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e12]) {
      assert.throws(() => checkEgressProxyLimits({ maxClients: bad }));
      assert.throws(() => checkEgressProxyLimits({ idleTimeoutMs: bad }));
      assert.throws(() => checkEgressProxyLimits({ maxTunnelBytes: bad }));
    }
  });
});

// ---------------------------------------------------------------------------
// Listener behaviour
// ---------------------------------------------------------------------------

describe("EgressProxy binding", () => {
  it("listens only on the configured address", async () => {
    const h = await harness();
    const addr = ((h.proxy as unknown) as { server: net.Server }).server.address() as net.AddressInfo;
    assert.equal(addr.address, "127.0.0.1");
  });
  it("does not start twice and does not restart after close", async () => {
    const h = await harness();
    await assert.rejects(h.proxy.start());
    await h.proxy.close();
    await assert.rejects(h.proxy.start());
  });
  it("is not connected to the default egress guard", async () => {
    const r = await new UnavailableEgressGuard().attest();
    assert.equal(r.verified, false);
  });
});

describe("EgressProxy happy path", () => {
  it("opens a tunnel to the pinned address and relays bytes verbatim in both directions", async () => {
    const h = await harness();
    const t = await openTunnel(h.port);
    assert.equal(t.statusLine, "HTTP/1.1 200 Connection Established");
    const payload = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x00, 0xff, 0x00, 0x80, 0x0d, 0x0a, 0x0d, 0x0a]);
    t.socket.write(payload);
    await sleep(150);
    assert.deepEqual(Buffer.concat(t.received), payload);
    assert.deepEqual(Buffer.concat(h.upstreamReceived), payload);
    assert.equal(h.targets.length, 1);
    assert.deepEqual({ ...h.targets[0] }, { hostname: "github.com", address: PUBLIC_V4, family: 4, port: 443 });
    t.socket.destroy();
  });

  it("rejects IPv6 answers even when an IPv4 answer is also present, and never connects", async () => {
    const h = await harness({ resolver: () => Promise.resolve([PUBLIC_V6, PUBLIC_V4]) });
    const out = await raw(h.port, CONNECT_OK);
    assert.equal(statusOf(out), 403);
    assert.equal(h.targets.length, 0);
    assert.deepEqual(h.events, [{ kind: "rejected", status: 403, code: "non-ipv4-address" }]);
  });

  it("rejects the observed Docker answer set (public IPv4 plus NAT64 64:ff9b::/96) and never connects", async () => {
    const h = await harness({ resolver: () => Promise.resolve(["135.235.149.144", "64:ff9b::4ba:9dc0"]) });
    const out = await raw(h.port, CONNECT_OK);
    assert.equal(statusOf(out), 403);
    assert.equal(h.targets.length, 0);
  });

  it("rejects IPv6-only answers and never connects", async () => {
    const h = await harness({ resolver: () => Promise.resolve([PUBLIC_V6]) });
    const out = await raw(h.port, CONNECT_OK);
    assert.equal(statusOf(out), 403);
    assert.equal(h.targets.length, 0);
  });

  it("rejects a public IPv4 mixed with a private, loopback or metadata IPv4, in either order", async () => {
    for (const bad of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "192.168.1.1"]) {
      for (const set of [[PUBLIC_V4, bad], [bad, PUBLIC_V4]]) {
        const h = await harness({ resolver: () => Promise.resolve(set) });
        const out = await raw(h.port, CONNECT_OK);
        assert.equal(statusOf(out), 403, set.join(","));
        assert.equal(h.targets.length, 0, set.join(","));
      }
    }
  });

  it("pins the first validated IPv4 when several public IPv4 answers are returned", async () => {
    const h = await harness({ resolver: () => Promise.resolve([PUBLIC_V4_B, PUBLIC_V4]) });
    const t = await openTunnel(h.port);
    assert.equal(h.targets.length, 1);
    assert.deepEqual({ ...h.targets[0] }, { hostname: "github.com", address: PUBLIC_V4_B, family: 4, port: 443 });
    t.socket.destroy();
  });

  it("forwards nothing but the client's tunnel bytes: no proxy headers or credentials upstream", async () => {
    const h = await harness();
    const t = await openTunnel(h.port);
    await sleep(100);
    assert.equal(total(h.upstreamReceived), 0);
    t.socket.write("hello");
    await sleep(100);
    assert.equal(Buffer.concat(h.upstreamReceived).toString(), "hello");
    assert.deepEqual(Object.keys(h.targets[0] ?? {}).sort(), ["address", "family", "hostname", "port"]);
    t.socket.destroy();
  });

  it("does not interpret upstream bytes: a redirect response passes through as data and nothing is followed", async () => {
    const redirect = "HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/\r\n\r\n";
    const h = await harness({ upstream: (s) => s.write(redirect) });
    const t = await openTunnel(h.port);
    await sleep(150);
    assert.equal(Buffer.concat(t.received).toString("latin1"), redirect);
    assert.equal(h.targets.length, 1);
    assert.equal(h.resolverCalls.n, 1);
    t.socket.destroy();
  });

  it("resolves and validates afresh for every CONNECT", async () => {
    const h = await harness();
    (await openTunnel(h.port)).socket.destroy();
    (await openTunnel(h.port)).socket.destroy();
    assert.equal(h.resolverCalls.n, 2);
  });
});

describe("EgressProxy method and target rejection", () => {
  const methods = ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH", "TRACE"];
  for (const m of methods) {
    it(`${m} gets 405 and never resolves or connects`, async () => {
      const h = await harness();
      const out = await raw(h.port, `${m} http://github.com/ HTTP/1.1\r\nHost: github.com\r\n\r\n`);
      assert.equal(statusOf(out), 405);
      assert.match(out, /Allow: CONNECT/i);
      assert.equal(h.resolverCalls.n, 0);
      assert.equal(h.targets.length, 0);
    });
  }

  it("rejects absolute-form GET and origin-form paths", async () => {
    const h = await harness();
    for (const line of ["GET http://github.com:443/ HTTP/1.1", "GET / HTTP/1.1", "GET https://github.com/x HTTP/1.1"]) {
      const out = await raw(h.port, `${line}\r\nHost: github.com:443\r\n\r\n`);
      assert.equal(statusOf(out), 405);
    }
    assert.equal(h.targets.length, 0);
  });

  it("rejects unknown methods without success", async () => {
    const h = await harness();
    const out = await raw(h.port, "FOO github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n");
    assert.notEqual(statusOf(out), 200);
    assert.equal(h.targets.length, 0);
  });

  const badAuthorities = [
    "github.com:80", "github.com:8443", "github.com:22", "github.com", "GITHUB.COM:443", "GitHub.com:443", "github.com.:443",
    "api.github.com:443", "evilgithub.com:443", "github.com.evil.com:443", "example.com:443",
    "user@github.com:443", "user:pw@github.com:443", "github.com:443@evil.com:443", "github.com@evil.com:443",
    "http://github.com:443/", "https://github.com:443/", "/github.com:443", "github.com:443/path", "github.com:443?x=1",
    "[::1]:443", "[2606:50c0:8000::154]:443", "127.0.0.1:443", "169.254.169.254:443", "10.0.0.1:443", "140.82.112.3:443",
    "github.com:0443", "github.com:443:443", "github.com:99999", "github.com:-1", "github.com:",
    ":443", "github.com:443,evil.com:443", "github%2ecom:443", "github.com\\:443", "*",
  ];
  for (const a of badAuthorities) {
    it(`rejects CONNECT ${JSON.stringify(a)} before any DNS or connect`, async () => {
      const h = await harness();
      const out = await raw(h.port, `CONNECT ${a} HTTP/1.1\r\nHost: ${a}\r\n\r\n`);
      const s = statusOf(out);
      assert.ok(s === 400 || s === 403, `status ${String(s)}`);
      assert.equal(h.resolverCalls.n, 0);
      assert.equal(h.targets.length, 0);
    });
  }

  it("rejects a canonical-looking CONNECT whose raw request line has irregular spacing, with 400 and no DNS", async () => {
    // Node's HTTP parser accepts these and reports method/url as if they were canonical,
    // so only the raw-byte comparison can catch them.
    const h = await harness();
    for (const line of [
      "CONNECT  github.com:443 HTTP/1.1",
      "CONNECT github.com:443  HTTP/1.1",
      "CONNECT\tgithub.com:443 HTTP/1.1",
      "CONNECT github.com:443 HTTP/1.1 ",
      " CONNECT github.com:443 HTTP/1.1",
    ]) {
      const out = await raw(h.port, `${line}\r\nHost: github.com:443\r\n\r\n`, 700);
      assert.notEqual(statusOf(out), 200, JSON.stringify(line));
    }
    const dbl = await raw(h.port, "CONNECT  github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n", 700);
    assert.equal(statusOf(dbl), 400);
    assert.equal(h.targets.length, 0);
    assert.equal(h.resolverCalls.n, 0);
  });

  it("rejects a request line with bare LF endings (no CRLF captured)", async () => {
    const h = await harness();
    const out = await raw(h.port, "CONNECT github.com:443 HTTP/1.1\nHost: github.com:443\n\n", 700);
    assert.notEqual(statusOf(out), 200);
    assert.equal(h.targets.length, 0);
  });

  it("rejects request lines with spaces, control characters and a missing authority", async () => {
    const h = await harness();
    for (const line of [
      "CONNECT github.com:443 extra HTTP/1.1",
      "CONNECT  github.com:443 HTTP/1.1",
      "CONNECT github.com:443\u0000 HTTP/1.1",
      "CONNECT github.com:443\u0001 HTTP/1.1",
      "CONNECT HTTP/1.1",
      "CONNECT github.com:443 HTTP/1.0",
      "CONNECT github.com:443 HTTP/9.9",
      "CONNECT github.com:443",
    ]) {
      const out = await raw(h.port, `${line}\r\nHost: github.com:443\r\n\r\n`, 700);
      assert.notEqual(statusOf(out), 200, JSON.stringify(line));
    }
    assert.equal(h.targets.length, 0);
    assert.equal(h.resolverCalls.n, 0);
  });
});

describe("EgressProxy header and smuggling rejection", () => {
  const headerCases: Array<[string, string]> = [
    ["Proxy-Authorization", "Proxy-Authorization: Basic dXNlcjpwdw==\r\n"],
    ["Authorization", "Authorization: Bearer x\r\n"],
    ["Content-Length", "Content-Length: 5\r\n"],
    ["Transfer-Encoding", "Transfer-Encoding: chunked\r\n"],
    ["CL + TE", "Content-Length: 4\r\nTransfer-Encoding: chunked\r\n"],
    ["TE + CL", "Transfer-Encoding: chunked\r\nContent-Length: 4\r\n"],
    ["Upgrade", "Upgrade: websocket\r\nConnection: Upgrade\r\n"],
    ["Expect", "Expect: 100-continue\r\n"],
    ["second Host", "Host: github.com:443\r\n"],
    ["wrong second Host", "Host: evil.com:443\r\n"],
    ["NUL in value", "X-A: a\u0000b\r\n"],
    ["ESC in value", "X-A: a\u001bb\r\n"],
    ["bare CR in value", "X-A: a\rb: c\r\n"],
    ["DEL in value", "X-A: a\u007fb\r\n"],
    ["high byte in value", "X-A: caf\u00e9\r\n"],
    ["space in name", "X A: b\r\n"],
    ["obs-fold continuation", "X-A: a\r\n b\r\n"],
    ["empty name", ": b\r\n"],
    ["no colon", "garbage\r\n"],
  ];
  for (const [name, hdr] of headerCases) {
    it(`rejects ${name} without resolving or connecting`, async () => {
      const h = await harness();
      const out = await raw(h.port, `CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n${hdr}\r\n`, 800);
      assert.notEqual(statusOf(out), 200);
      assert.equal(h.resolverCalls.n, 0);
      assert.equal(h.targets.length, 0);
    });
  }

  it("rejects a mismatched Host header", async () => {
    const h = await harness();
    const out = await raw(h.port, "CONNECT github.com:443 HTTP/1.1\r\nHost: evil.com:443\r\n\r\n");
    assert.equal(statusOf(out), 400);
    assert.equal(h.targets.length, 0);
  });

  it("rejects bytes sent in the same packet after the header block (pipelined request)", async () => {
    const h = await harness();
    const out = await raw(h.port, `${CONNECT_OK}GET http://169.254.169.254/ HTTP/1.1\r\nHost: x\r\n\r\n`);
    assert.notEqual(statusOf(out), 200);
    assert.equal(h.targets.length, 0);
  });

  it("rejects CONNECT with a smuggled body", async () => {
    const h = await harness();
    const out = await raw(h.port, "CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nContent-Length: 40\r\n\r\nGET /admin HTTP/1.1\r\nHost: x\r\n\r\n");
    assert.notEqual(statusOf(out), 200);
    assert.equal(h.targets.length, 0);
  });

  it("drops a client that sends data while DNS/connect is still pending and never opens a tunnel", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = await harness({
      resolver: async () => {
        await gate;
        return [PUBLIC_V4];
      },
    });
    const received: Buffer[] = [];
    const s = net.connect(h.port, "127.0.0.1", () => s.write(CONNECT_OK));
    s.on("data", (d) => received.push(d));
    s.on("error", () => undefined);
    await sleep(100);
    s.write("early bytes");
    assert.equal(await closedWithin(s, 1000), true);
    release?.();
    await sleep(100);
    assert.equal(Buffer.concat(received).toString().includes("200"), false);
    assert.equal(h.targets.length, 0);
    assert.equal(total(h.upstreamReceived), 0);
  });

  it("cancels pending DNS when the client disconnects, and never calls the connector", async () => {
    let aborted = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = await harness({
      // Deliberately ignores the abort signal and still answers later.
      resolver: async (_h, sig) => {
        sig.addEventListener("abort", () => {
          aborted = true;
        });
        await gate;
        return [PUBLIC_V4];
      },
    });
    const s = net.connect(h.port, "127.0.0.1", () => s.write(CONNECT_OK));
    s.on("error", () => undefined);
    await sleep(100);
    s.destroy();
    await sleep(100);
    assert.equal(aborted, true);
    release?.();
    await sleep(100);
    assert.equal(h.targets.length, 0);
    assert.equal(h.proxy.activeConnections, 0);
  });

  it("cancels a pending connector when the client sends early data, and destroys its late socket", async () => {
    let late: Duplex | undefined;
    let release: (() => void) | undefined;
    let aborted = false;
    const h = await harness({
      connector: (_t, sig) =>
        new Promise<Duplex>((resolve) => {
          sig.addEventListener("abort", () => {
            aborted = true;
          });
          release = (): void => {
            const s = new net.Socket();
            late = s;
            resolve(s);
          };
        }),
    });
    const s = net.connect(h.port, "127.0.0.1", () => s.write(CONNECT_OK));
    s.on("error", () => undefined);
    await sleep(100);
    assert.equal(h.targets.length, 1);
    s.write("early");
    assert.equal(await closedWithin(s, 1000), true);
    assert.equal(aborted, true);
    release?.();
    await sleep(100);
    assert.equal(late?.destroyed, true);
    assert.equal(h.events.some((e) => e.kind === "tunnel-open"), false);
  });

  it("rejects oversized headers", async () => {
    const h = await harness({ limits: { maxHeaderBytes: 1024 } });
    const out = await raw(h.port, `CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nX-Big: ${"a".repeat(4000)}\r\n\r\n`);
    assert.notEqual(statusOf(out), 200);
    assert.equal(h.targets.length, 0);
  });

  it("rejects too many headers", async () => {
    const h = await harness({ limits: { maxHeaders: 4 } });
    let hdrs = "";
    for (let i = 0; i < 10; i += 1) hdrs += `X-${i}: v\r\n`;
    const out = await raw(h.port, `CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n${hdrs}\r\n`);
    assert.equal(statusOf(out), 431);
    assert.equal(h.targets.length, 0);
  });

  it("never echoes client-supplied text in responses or events", async () => {
    const h = await harness();
    const marker = "zq9marker";
    const out1 = await raw(h.port, `CONNECT ${marker}.example:443 HTTP/1.1\r\nHost: ${marker}.example:443\r\n\r\n`);
    const out2 = await raw(h.port, `GET http://${marker}.example/ HTTP/1.1\r\nHost: ${marker}.example\r\n\r\n`);
    const out3 = await raw(h.port, `CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nX-${marker}: \u0001\r\n\r\n`, 700);
    for (const o of [out1, out2, out3]) assert.equal(o.includes(marker), false);
    assert.equal(JSON.stringify(h.events).includes(marker), false);
    assert.equal(out1.toLowerCase().includes("proxy-authenticate"), false);
  });
});

describe("EgressProxy DNS handling", () => {
  const blockedAnswers: Array<[string, string[]]> = [
    ["loopback", ["127.0.0.1"]],
    ["private 10/8", ["10.0.0.5"]],
    ["private 172.16/12", ["172.16.5.5"]],
    ["private 192.168/16", ["192.168.1.1"]],
    ["metadata", ["169.254.169.254"]],
    ["link-local", ["169.254.1.1"]],
    ["CGNAT", ["100.64.0.1"]],
    ["unspecified", ["0.0.0.0"]],
    ["IPv6 loopback", ["::1"]],
    ["IPv6 link-local", ["fe80::1"]],
    ["IPv6 ULA", ["fd00::1"]],
    ["IPv4-mapped loopback", ["::ffff:127.0.0.1"]],
    ["IPv4-mapped metadata", ["::ffff:169.254.169.254"]],
    ["IPv4-mapped hex form", ["::ffff:a00:1"]],
    ["NAT64 private", ["64:ff9b::a00:1"]],
    ["not an IP", ["localhost"]],
    ["name instead of IP", ["github.com"]],
    ["public first, private second", [PUBLIC_V4, "10.0.0.1"]],
    ["private first, public second", ["10.0.0.1", PUBLIC_V4]],
    ["public first, metadata last", [PUBLIC_V4, PUBLIC_V4_B, "169.254.169.254"]],
    ["public first, mapped last", [PUBLIC_V4, "::ffff:10.0.0.1"]],
  ];
  for (const [name, answers] of blockedAnswers) {
    it(`403 and no connect for ${name}`, async () => {
      const h = await harness({ resolver: () => Promise.resolve(answers) });
      const out = await raw(h.port, CONNECT_OK);
      assert.equal(statusOf(out), 403);
      assert.equal(h.targets.length, 0);
      assert.equal(total(h.upstreamReceived), 0);
    });
  }

  it("502 for empty, non-array and throwing resolvers", async () => {
    for (const r of [
      (): Promise<string[]> => Promise.resolve([]),
      (): Promise<string[]> => Promise.resolve(null as unknown as string[]),
      (): Promise<string[]> => Promise.reject(new Error("ENOTFOUND")),
    ]) {
      const h = await harness({ resolver: r });
      const out = await raw(h.port, CONNECT_OK);
      assert.equal(statusOf(out), 502);
      assert.equal(h.targets.length, 0);
    }
  });

  it("504 when DNS hangs, and the abort signal reaches the resolver", async () => {
    let aborted = false;
    const h = await harness({
      limits: { resolveTimeoutMs: 60 },
      resolver: (_h, sig) =>
        new Promise<string[]>(() => {
          sig.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    });
    const out = await raw(h.port, CONNECT_OK);
    assert.equal(statusOf(out), 504);
    assert.equal(aborted, true);
    assert.equal(h.targets.length, 0);
  });

  it("resolves only the fixed name, never anything the client sent", async () => {
    const seen: string[] = [];
    const h = await harness({
      resolver: (name) => {
        seen.push(name);
        return Promise.resolve([PUBLIC_V4]);
      },
    });
    await raw(h.port, "CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n");
    (await openTunnel(h.port)).socket.destroy();
    assert.deepEqual(seen, ["github.com"]);
  });

  it("DNS rebinding: a validated address is pinned, and a later private answer is refused", async () => {
    let calls = 0;
    const h = await harness({
      resolver: () => {
        calls += 1;
        return Promise.resolve(calls === 1 ? [PUBLIC_V4] : ["169.254.169.254"]);
      },
    });
    const first = await openTunnel(h.port);
    first.socket.destroy();
    const second = await raw(h.port, CONNECT_OK);
    assert.equal(statusOf(second), 403);
    assert.equal(h.targets.length, 1);
    assert.equal(h.targets[0]?.address, PUBLIC_V4);
    assert.equal(calls, 2);
  });

  it("hands the connector an IP literal that is frozen and never a name", async () => {
    const h = await harness({ resolver: () => Promise.resolve([PUBLIC_V4_B, PUBLIC_V4]) });
    (await openTunnel(h.port)).socket.destroy();
    const t = h.targets[0];
    assert.ok(t !== undefined);
    assert.ok(Object.isFrozen(t));
    assert.equal(classifyIp(t.address).allowed, true);
    assert.equal(net.isIP(t.address) !== 0, true);
    assert.equal(t.address, PUBLIC_V4_B);
  });
});

describe("EgressProxy connector handling", () => {
  it("502 when the connector fails", async () => {
    const h = await harness({ connector: () => Promise.reject(new Error("ECONNREFUSED")) });
    const out = await raw(h.port, CONNECT_OK);
    assert.equal(statusOf(out), 502);
    assert.equal(out.includes("ECONNREFUSED"), false);
  });

  it("504 when the connector hangs, and a late socket is destroyed", async () => {
    let late: Duplex | undefined;
    let aborted = false;
    const h = await harness({
      limits: { connectTimeoutMs: 60 },
      connector: (_t, sig) =>
        new Promise<Duplex>((resolve) => {
          sig.addEventListener("abort", () => {
            aborted = true;
          });
          setTimeout(() => {
            const s = new net.Socket();
            late = s;
            resolve(s);
          }, 200);
        }),
    });
    const out = await raw(h.port, CONNECT_OK);
    assert.equal(statusOf(out), 504);
    assert.equal(aborted, true);
    await sleep(350);
    assert.equal(late?.destroyed, true);
  });
});

describe("EgressProxy bounds", () => {
  it("limits concurrent clients", async () => {
    const h = await harness({ limits: { maxClients: 2 } });
    const a = await openTunnel(h.port);
    const b = await openTunnel(h.port);
    const out = await raw(h.port, CONNECT_OK, 800);
    assert.equal(statusOf(out), null);
    assert.equal(h.targets.length, 2);
    a.socket.destroy();
    b.socket.destroy();
    await sleep(100);
    const c = await openTunnel(h.port);
    assert.match(c.statusLine, /200/);
    c.socket.destroy();
  });

  it("closes a tunnel that exceeds the byte limit", async () => {
    const h = await harness({ limits: { maxTunnelBytes: 1024 } });
    const t = await openTunnel(h.port);
    t.socket.write(Buffer.alloc(4096, 1));
    assert.equal(await closedWithin(t.socket, 1500), true);
    assert.ok(total(t.received) <= 1024);
    assert.ok(h.events.some((e) => e.kind === "tunnel-closed" && e.reason === "byte-limit"));
  });

  it("closes an idle tunnel", async () => {
    const h = await harness({ limits: { idleTimeoutMs: 100 } });
    const t = await openTunnel(h.port);
    assert.equal(await closedWithin(t.socket, 1500), true);
    assert.ok(h.events.some((e) => e.kind === "tunnel-closed" && e.reason === "idle-timeout"));
  });

  it("closes a busy tunnel at the maximum duration", async () => {
    const h = await harness({ limits: { maxTunnelMs: 200, idleTimeoutMs: 5000 } });
    const t = await openTunnel(h.port);
    const iv = setInterval(() => t.socket.write("x"), 20);
    const closed = await closedWithin(t.socket, 1500);
    clearInterval(iv);
    assert.equal(closed, true);
    assert.ok(h.events.some((e) => e.kind === "tunnel-closed" && e.reason === "max-duration"));
  });

  it("closes a slow-header client (slowloris)", async () => {
    const h = await harness({ limits: { headerTimeoutMs: 100 } });
    const s = net.connect(h.port, "127.0.0.1", () => s.write("CONNECT github.com:443 HTT"));
    s.on("error", () => undefined);
    assert.equal(await closedWithin(s, 1500), true);
    assert.equal(h.targets.length, 0);
  });

  it("closes the upstream when the client disconnects", async () => {
    const h = await harness();
    const t = await openTunnel(h.port);
    t.socket.destroy();
    await sleep(200);
    assert.ok(h.events.some((e) => e.kind === "tunnel-closed"));
    assert.equal(h.proxy.activeConnections, 0);
  });

  it("closes the client when the upstream disconnects", async () => {
    const h = await harness({ upstream: (s) => setTimeout(() => s.destroy(), 50) });
    const t = await openTunnel(h.port);
    assert.equal(await closedWithin(t.socket, 1500), true);
  });
});

describe("EgressProxy shutdown", () => {
  it("close() ends tunnels, pending connects and stops listening; it is idempotent", async () => {
    const h = await harness();
    const t = await openTunnel(h.port);
    await h.proxy.close();
    assert.equal(await closedWithin(t.socket, 1000), true);
    assert.equal(h.proxy.activeConnections, 0);
    await h.proxy.close();
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        const s = net.connect(h.port, "127.0.0.1", () => {
          s.destroy();
          resolve();
        });
        s.once("error", reject);
      }),
    );
  });

  it("close() while DNS is pending aborts the lookup and drops the client", async () => {
    let aborted = false;
    const h = await harness({
      resolver: (_h, sig) =>
        new Promise<string[]>(() => {
          sig.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    });
    const s = net.connect(h.port, "127.0.0.1", () => s.write(CONNECT_OK));
    s.on("error", () => undefined);
    await sleep(100);
    await h.proxy.close();
    assert.equal(aborted, true);
    assert.equal(await closedWithin(s, 1000), true);
    assert.equal(h.targets.length, 0);
  });

  it("close() while the connector is pending destroys the late upstream", async () => {
    let late: Duplex | undefined;
    let release: (() => void) | undefined;
    const h = await harness({
      connector: () =>
        new Promise<Duplex>((resolve) => {
          release = (): void => {
            const s = new net.Socket();
            late = s;
            resolve(s);
          };
        }),
    });
    const s = net.connect(h.port, "127.0.0.1", () => s.write(CONNECT_OK));
    s.on("error", () => undefined);
    await sleep(100);
    await h.proxy.close();
    release?.();
    await sleep(100);
    assert.equal(late === undefined || late.destroyed, true);
    assert.equal(await closedWithin(s, 1000), true);
  });
});


// ---------------------------------------------------------------------------
// registry.npmjs.org target (same rules as github.com, one host per instance)
// Written without being run. Fake resolver, connector and upstream only.
// ---------------------------------------------------------------------------

const REG = "registry.npmjs.org";
const REG_OK = `CONNECT ${REG}:443 HTTP/1.1\r\nHost: ${REG}:443\r\n\r\n`;

describe("registry target: pure checks", () => {
  it("checkEgressTarget accepts only the closed set and defaults to github.com", () => {
    assert.equal(checkEgressTarget(undefined), "github.com");
    assert.equal(checkEgressTarget("github.com"), "github.com");
    assert.equal(checkEgressTarget(REG), REG);
    for (const t of ["example.com", "GitHub.com", "registry.npmjs.org:443", "*.npmjs.org", "", null, 5, {}, ["github.com"]]) {
      assert.throws(() => checkEgressTarget(t), Error, JSON.stringify(t));
    }
  });

  it("the registry target accepts exactly registry.npmjs.org:443", () => {
    assert.equal(validateConnectAuthority(`${REG}:443`, REG).ok, true);
    const bad = [
      "github.com:443", `${REG}`, `${REG}:80`, `${REG}:8443`, `${REG}:0443`, `${REG}:443 `, ` ${REG}:443`,
      `REGISTRY.NPMJS.ORG:443`, `${REG}.:443`, `evil${REG}:443`, `${REG}.evil.com:443`, `user@${REG}:443`,
      `npmjs.org:443`, `www.npmjs.org:443`, `registry.npmjs.com:443`, "127.0.0.1:443", "169.254.169.254:80", "[::1]:443", "",
      undefined, null, 443,
    ];
    for (const a of bad) assert.equal(validateConnectAuthority(a, REG).ok, false, JSON.stringify(a));
  });

  it("each target rejects the other's authority", () => {
    assert.equal(validateConnectAuthority(`${REG}:443`).ok, false);
    assert.equal(validateConnectAuthority("github.com:443", REG).ok, false);
    const a = validateConnectAuthority("github.com:443", REG);
    assert.ok(!a.ok && a.status === 403);
  });

  it("the request line and Host header are checked against the chosen target", () => {
    const view = {
      method: "CONNECT", url: `${REG}:443`, httpVersion: "1.1", rawHeaders: ["Host", `${REG}:443`], headBytes: 0,
      rawRequestLine: `CONNECT ${REG}:443 HTTP/1.1`,
    };
    const limits = { maxHeaders: 32 };
    assert.equal(validateConnectRequest(view, limits, REG).ok, true);
    assert.equal(validateConnectRequest(view, limits).ok, false); // default target is github.com
    assert.equal(validateConnectRequest({ ...view, rawRequestLine: `CONNECT  ${REG}:443 HTTP/1.1` }, limits, REG).ok, false);
    assert.equal(validateConnectRequest({ ...view, rawHeaders: ["Host", "github.com:443"] }, limits, REG).ok, false);
    assert.equal(validateConnectRequest({ ...view, rawHeaders: ["Host", REG] }, limits, REG).ok, false);
    assert.equal(validateConnectRequest({ ...view, rawHeaders: ["Host", `${REG}:443`, "Proxy-Authorization", "Basic eA=="] }, limits, REG).ok, false);
    assert.equal(validateConnectRequest({ ...view, headBytes: 1 }, limits, REG).ok, false);
  });

  it("the constructor refuses a target outside the closed set", () => {
    assert.throws(() => new EgressProxy({ bindHost: "127.0.0.1", target: "example.com" as unknown as EgressTargetHost }));
    assert.throws(() => new EgressProxy({ bindHost: "127.0.0.1", target: "github.com:443" as unknown as EgressTargetHost }));
  });
});

describe("registry target: proxy behaviour", () => {
  it("tunnels registry.npmjs.org:443, resolving and pinning only that name", async () => {
    const names: string[] = [];
    const h = await harness({
      target: REG,
      resolver: (host) => {
        names.push(host);
        return Promise.resolve([PUBLIC_V4]);
      },
    });
    const t = await openTunnel(h.port, REG_OK);
    assert.equal(t.statusLine, "HTTP/1.1 200 Connection Established");
    assert.deepEqual(names, [REG]);
    assert.equal(h.targets.length, 1);
    assert.equal(h.targets[0]?.hostname, REG);
    assert.equal(h.targets[0]?.address, PUBLIC_V4);
    assert.equal(h.targets[0]?.port, 443);
    t.socket.destroy();
  });

  it("relays bytes untouched after the 200 reply", async () => {
    const h = await harness({ target: REG });
    const t = await openTunnel(h.port, REG_OK);
    t.socket.write("ping");
    await sleep(100);
    assert.equal(Buffer.concat(t.received).toString("latin1"), "ping"); // echo upstream
    t.socket.destroy();
  });

  it("refuses github.com:443 on the registry proxy before any DNS or connect", async () => {
    const h = await harness({ target: REG });
    assert.equal(statusOf(await raw(h.port, CONNECT_OK)), 403);
    assert.equal(h.resolverCalls.n, 0);
    assert.equal(h.targets.length, 0);
  });

  it("refuses registry.npmjs.org:443 on the default (github) proxy before any DNS or connect", async () => {
    const h = await harness();
    assert.equal(statusOf(await raw(h.port, REG_OK)), 403);
    assert.equal(h.resolverCalls.n, 0);
    assert.equal(h.targets.length, 0);
  });

  it("refuses every other authority with no DNS and no connect", async () => {
    const h = await harness({ target: REG });
    const authorities = [
      "example.com:443", "api.github.com:443", "169.254.169.254:80", "169.254.169.254:443", "10.0.0.1:443", "127.0.0.1:443",
      "192.168.1.1:443", "[::1]:443", `${REG}:80`, `${REG}:8443`, "REGISTRY.NPMJS.ORG:443", `${REG}.:443`,
      `www.${REG}:443`, `user@${REG}:443`, "npmjs.org:443",
    ];
    for (const a of authorities) {
      const status = statusOf(await raw(h.port, `CONNECT ${a} HTTP/1.1\r\nHost: ${a}\r\n\r\n`));
      assert.ok(status === 400 || status === 403, `${a} -> ${String(status)}`);
    }
    assert.equal(h.resolverCalls.n, 0);
    assert.equal(h.targets.length, 0);
  });

  it("refuses a Host header that is not the target, a pipelined request and forbidden headers", async () => {
    const h = await harness({ target: REG });
    const cases: Array<[string, number[]]> = [
      [`CONNECT ${REG}:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n`, [400]],
      [`CONNECT ${REG}:443 HTTP/1.1\r\nHost: ${REG}\r\n\r\n`, [400]],
      [`CONNECT ${REG}:443 HTTP/1.1\r\nHost: ${REG}:443\r\nHost: ${REG}:443\r\n\r\n`, [400]],
      [`CONNECT ${REG}:443 HTTP/1.1\r\nHost: ${REG}:443\r\nProxy-Authorization: Basic eDp5\r\n\r\n`, [403]],
      [`CONNECT ${REG}:443 HTTP/1.1\r\nHost: ${REG}:443\r\nAuthorization: Bearer x\r\n\r\n`, [403]],
      [`CONNECT ${REG}:443 HTTP/1.1\r\nHost: ${REG}:443\r\nContent-Length: 4\r\n\r\nabcd`, [400]],
      [`CONNECT  ${REG}:443 HTTP/1.1\r\nHost: ${REG}:443\r\n\r\n`, [400]],
      [`${REG_OK}GET / HTTP/1.1\r\nHost: x\r\n\r\n`, [400]],
      [`GET https://${REG}/is-number HTTP/1.1\r\nHost: ${REG}\r\n\r\n`, [405]],
    ];
    for (const [payload, wanted] of cases) {
      const status = statusOf(await raw(h.port, payload));
      assert.ok(status !== null && wanted.includes(status), `${JSON.stringify(payload.slice(0, 60))} -> ${String(status)}`);
    }
    assert.equal(h.resolverCalls.n, 0);
    assert.equal(h.targets.length, 0);
  });

  const answerSets: Array<[string, string[], number]> = [
    ["a private answer", ["10.0.0.5"], 403],
    ["a loopback answer", ["127.0.0.1"], 403],
    ["a link-local metadata answer", ["169.254.169.254"], 403],
    ["a shared-address-space answer", ["100.64.0.1"], 403],
    ["public then private", [PUBLIC_V4, "10.0.0.5"], 403],
    ["private then public", ["10.0.0.5", PUBLIC_V4], 403],
    ["public then metadata", [PUBLIC_V4, "169.254.169.254"], 403],
    ["public v4 plus public v6 (mixed)", [PUBLIC_V4, PUBLIC_V6], 403],
    ["public v6 then public v4 (mixed)", [PUBLIC_V6, PUBLIC_V4], 403],
    ["v4 plus NAT64 synthesized v6", [PUBLIC_V4, "64:ff9b::8c52:7003"], 403],
    ["v6 only", [PUBLIC_V6], 403],
    ["an IPv4-mapped IPv6 answer", ["::ffff:140.82.112.3"], 403],
    ["a non-IP answer", ["registry.internal"], 403],
    ["an empty answer set", [], 502],
  ];
  for (const [label, answers, status] of answerSets) {
    it(`fails closed on ${label}: ${status}, no connect`, async () => {
      const h = await harness({ target: REG, resolver: () => Promise.resolve(answers) });
      assert.equal(statusOf(await raw(h.port, REG_OK)), status);
      assert.equal(h.resolverCalls.n, 1);
      assert.equal(h.targets.length, 0);
    });
  }

  it("pins the first validated IPv4 answer and offers no name to the connector", async () => {
    const h = await harness({ target: REG, resolver: () => Promise.resolve([PUBLIC_V4, PUBLIC_V4_B]) });
    const t = await openTunnel(h.port, REG_OK);
    assert.equal(h.targets.length, 1);
    assert.equal(h.targets[0]?.address, PUBLIC_V4);
    assert.equal(classifyIp(h.targets[0]?.address).allowed, true);
    t.socket.destroy();
  });

  it("emits only sanitized events", async () => {
    const h = await harness({ target: REG });
    await raw(h.port, `CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n`);
    const rejected = h.events.find((e) => e.kind === "rejected");
    assert.ok(rejected !== undefined && rejected.kind === "rejected");
    assert.equal(rejected.code, "authority-not-allowed");
    assert.equal(JSON.stringify(h.events).includes("evil.example"), false);
  });
});
