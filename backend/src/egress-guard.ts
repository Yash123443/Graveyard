/**
 * egress-guard.ts — an EgressGuard for an OPERATOR-PROVISIONED proxy topology. Written without a
 * shell; later compiled and unit-tested (fake executor) in an external run. Not yet run against
 * real Docker or GitHub; the opt-in harness test/manual-github-e2e-check.ts is written and unrun.
 *
 * The default guard (UnavailableEgressGuard) still never attests, and nothing in this module is
 * reachable unless the operator sets the GRAVEYARD_GITHUB_* variables (worker-config.ts). This
 * guard builds nothing. The operator creates, outside this process:
 *   - an `--internal` Docker bridge network (IPv4 only);
 *   - a proxy container running egress-proxy.ts for exactly ONE target host (github.com, or
 *     registry.npmjs.org for the second instance), attached to that network and to a network with
 *     upstream access, labelled `graveyard.egress-proxy=<host>`, with `node` available inside.
 * See backend/README.md for the commands.
 *
 * attest() verifies, on every call, with docker commands (argument arrays, no shell):
 *   1. the network exists, is Internal, is an IPv4 bridge and its subnet contains the proxy address
 *      (networkProblem, the same check the acquisition adapters repeat);
 *   2. the named proxy container is running, carries the label for this host, is attached to the
 *      network with exactly the configured IPv4 address, is not privileged and not host-networked;
 *   3. a probe executed INSIDE the proxy container asks it for `CONNECT example.com:443` and for
 *      `CONNECT <the other supported host>:443`; both must be answered `403`.
 * Only then does it return an attestation naming exactly this host.
 *
 * What that proves, and what it does not: the probes show that the running proxy refuses two
 * destinations other than its own. They do not prove that the allowed host is reachable, that the
 * proxy is the egress-proxy.ts code, that no other container is on the network, that the network
 * has no other route out, or that DNS and TLS behave. The attestation is the operator's claim,
 * narrowly spot-checked. Do not describe it as verified isolation.
 *
 * @module egress-guard
 */

import type { EgressAttestation, EgressGuard } from "./acquisition-policy.js";
import type { ProcessExecutor, ProcessResult } from "./docker-sandbox.js";
import { EGRESS_TARGET_HOSTS, type EgressTargetHost } from "./egress-proxy.js";
import { parsePrivateProxyUrl } from "./npm-acquire-driver.js";
import { networkProblem } from "./npm-registry-acquisition.js";

export const EGRESS_PROXY_LABEL = "graveyard.egress-proxy";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const FORBIDDEN_NETWORKS = new Set(["bridge", "host", "none", "default", "docker_gwbridge", "ingress"]);
const CONTROL_OUTPUT_BYTES = 256 * 1024;

/** Run inside the proxy container. Inputs arrive as environment variables set by this module. */
export const PROBE_SCRIPT = [
  'const s = require("net").connect(Number(process.env.GRAVEYARD_PROBE_PORT), process.env.GRAVEYARD_PROXY_BIND);',
  'let d = ""; s.setTimeout(4000, () => { console.log("timeout"); s.destroy(); });',
  's.on("data", (c) => { d += c; if (d.includes("\\r\\n")) { console.log(d.split("\\r\\n")[0]); s.destroy(); } });',
  's.on("error", (e) => console.log("error " + e.code));',
  's.on("connect", () => s.write("CONNECT " + process.env.GRAVEYARD_PROBE_AUTHORITY + " HTTP/1.1\\r\\nHost: " + process.env.GRAVEYARD_PROBE_AUTHORITY + "\\r\\n\\r\\n"));',
].join("\n");

export interface OperatorEgressGuardOptions {
  executor: ProcessExecutor;
  /** The single host this proxy instance tunnels to. */
  host: EgressTargetHost;
  network: string;
  proxyContainer: string;
  /** `http://<private IPv4>:<port>`. */
  proxyUrl: string;
  dockerBinary?: string;
  /** Per docker command. Default 15 000. */
  timeoutMs?: number;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export class OperatorEgressGuard implements EgressGuard {
  private readonly exec: ProcessExecutor;
  private readonly host: EgressTargetHost;
  private readonly network: string;
  private readonly container: string;
  private readonly proxyUrl: string;
  private readonly proxyHost: string;
  private readonly proxyPort: number;
  private readonly docker: string;
  private readonly timeoutMs: number;

  constructor(opts: OperatorEgressGuardOptions) {
    if (typeof opts?.executor !== "function") throw new Error("executor is required");
    if (!(EGRESS_TARGET_HOSTS as readonly string[]).includes(opts.host)) throw new Error("unsupported egress host");
    if (typeof opts.network !== "string" || !NAME_RE.test(opts.network) || FORBIDDEN_NETWORKS.has(opts.network.toLowerCase())) {
      throw new Error("egress network must be a dedicated user-defined network name");
    }
    if (typeof opts.proxyContainer !== "string" || !NAME_RE.test(opts.proxyContainer)) throw new Error("invalid proxy container name");
    const proxy = parsePrivateProxyUrl(opts.proxyUrl);
    if (proxy === null) throw new Error("proxyUrl must be http://<private IPv4 literal>:<port>");
    this.exec = opts.executor;
    this.host = opts.host;
    this.network = opts.network;
    this.container = opts.proxyContainer;
    this.proxyUrl = opts.proxyUrl;
    this.proxyHost = proxy.host;
    this.proxyPort = proxy.port;
    this.docker = opts.dockerBinary ?? "docker";
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(this.docker)) throw new Error("invalid dockerBinary");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 60_000) throw new Error("invalid timeoutMs");
  }

  /** Never throws. Anything unexpected is `verified: false`. */
  async attest(signal?: AbortSignal): Promise<EgressAttestation> {
    const no = (reason: string): EgressAttestation => ({ verified: false, reason });
    try {
      if (signal?.aborted === true) return no("egress check was aborted");

      const net = await this.control(["network", "inspect", this.network], signal);
      const problem = networkProblem(net, this.network, this.proxyHost);
      if (problem !== null) return no(problem);

      const info = await this.control(["inspect", "--type", "container", this.container], signal);
      const why = this.containerProblem(info);
      if (why !== null) return no(why);

      const others = EGRESS_TARGET_HOSTS.filter((h) => h !== this.host);
      for (const authority of ["example.com:443", ...others.map((h) => `${h}:443`)]) {
        const answer = await this.probe(authority, signal);
        if (answer === null) return no("proxy probe could not be run");
        if (!/^HTTP\/1\.1 403\b/.test(answer)) return no("proxy did not refuse a destination outside its single allowed host");
      }

      return {
        verified: true,
        network: this.network,
        proxyUrl: this.proxyUrl,
        allowedHosts: [this.host],
        evidence:
          `operator-provisioned: network ${this.network} is Internal; proxy container ${this.container} is running, labelled for ${this.host}, ` +
          `attached at ${this.proxyHost}; it refused CONNECT to example.com and to the other supported host (narrow probe, not proof of isolation)`,
      };
    } catch {
      return no("egress check could not be run");
    }
  }

  /** Null when the inspected container matches what the operator promised. */
  private containerProblem(r: ProcessResult): string | null {
    if (r.exitCode !== 0 || r.timedOut || r.truncated) return "proxy container could not be inspected";
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      return "proxy container inspect output is not JSON";
    }
    if (!Array.isArray(parsed) || parsed.length !== 1) return "proxy container is missing";
    const info = obj(parsed[0]);
    if (obj(info["State"])["Running"] !== true) return "proxy container is not running";
    if (obj(obj(info["Config"])["Labels"])[EGRESS_PROXY_LABEL] !== this.host) return "proxy container is not labelled for this host";
    const host = obj(info["HostConfig"]);
    if (host["Privileged"] === true || host["NetworkMode"] === "host") return "proxy container is privileged or host-networked";
    const networks = obj(obj(info["NetworkSettings"])["Networks"]);
    if (Object.keys(networks).length > 2) return "proxy container is attached to more than two networks";
    const mine = obj(networks[this.network]);
    if (mine["IPAddress"] !== this.proxyHost) return "proxy container is not attached to the egress network at the configured address";
    return null;
  }

  /** The first response line, or null when the probe did not run cleanly. */
  private async probe(authority: string, signal: AbortSignal | undefined): Promise<string | null> {
    const r = await this.control(
      [
        "exec",
        "--env", `GRAVEYARD_PROXY_BIND=${this.proxyHost}`,
        "--env", `GRAVEYARD_PROBE_PORT=${String(this.proxyPort)}`,
        "--env", `GRAVEYARD_PROBE_AUTHORITY=${authority}`,
        this.container, "node", "-e", PROBE_SCRIPT,
      ],
      signal,
    );
    if (r.exitCode !== 0 || r.timedOut || r.aborted || r.truncated) return null;
    return r.stdout.trim().split("\n")[0]?.trim() ?? null;
  }

  private control(args: readonly string[], signal: AbortSignal | undefined): Promise<ProcessResult> {
    return this.exec(this.docker, args, {
      timeoutMs: this.timeoutMs,
      maxOutputBytes: CONTROL_OUTPUT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}
