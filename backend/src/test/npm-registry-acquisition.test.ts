/**
 * npm-registry-acquisition.test.ts — the controlled npm registry acquisition with a MOCKED docker
 * CLI. No docker process is spawned, no npm runs, no network. Real temporary directories are used
 * for the staging root, the run directory and a stand-in driver file.
 *
 * What these tests show: the Docker arguments contain no unrestricted network, mount, port, device
 * or credential; every host check happens before a container exists; a configuration that differs
 * from the intent is never started; the report is only trusted after proven cleanup; and the
 * handoff is gated on the verified cache. The attestation used here is a TEST STUB. These tests do
 * NOT show that Docker isolates anything, that the proxy enforces its allowlist, that npm accepts
 * the flags, or that the handed-over cache works offline; that needs the opt-in harness
 * (manual-registry-acquisition-check.ts), which has not been run by its author.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnavailableEgressGuard, type EgressAttestation, type EgressGuard } from "../acquisition-policy.js";
import type { ProcessExecutor, ProcessResult } from "../docker-sandbox.js";
import { NODE_FIXTURE_IMAGE } from "../node-fixture-runner.js";
import { encodeAcquireLine, type AcquireResult } from "../npm-acquire-driver.js";
import { checkNpmFixture } from "../npm-lock-policy.js";
import {
  FIXED_FIXTURE_ID,
  FIXED_LOCKFILE,
  FIXED_PACKAGE,
  FIXED_PACKAGE_JSON,
  NPM_ACQ_ARGV,
  NpmRegistryAcquisition,
  OPERATOR_FIXTURE_ID,
  REGISTRY_EGRESS_HOSTS,
  STAGED_ACQ_DRIVER_NAME,
  buildCreateArgs,
  checkFixedFixture,
  ipv4InCidr,
  networkProblem,
  npmAcquisitionContainerName,
  type RegistryAcquisitionOptions,
  type RegistryAcquisitionRequest,
  type RunCtx,
} from "../npm-registry-acquisition.js";
import { contentPathFor, indexPathFor, tarballKey } from "../npm-registry-cache.js";
import {
  EXPECTED_DEFAULT,
  cacheFilesFor,
  lockEntry,
  operatorDoc,
  tarballBytesFor,
  textsOf,
  withExtraRootPackages,
  type Json,
  type OperatorDoc,
} from "./operator-fixture-helpers.js";

const IMAGE = NODE_FIXTURE_IMAGE;
const MB = 1024 * 1024;
const NET = "gy-registry-net";
const PROXY_IP = "10.231.4.10";
const PROXY_URL = `http://${PROXY_IP}:3128`;
const EXEC_ID = "regacq-abc123-1:1";

const res = (p: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, ...p,
});

const NETWORK_JSON = (over: Record<string, unknown> = {}): string =>
  JSON.stringify([{
    Name: NET, Driver: "bridge", Internal: true, EnableIPv6: false,
    IPAM: { Config: [{ Subnet: "10.231.4.0/24", Gateway: "10.231.4.1" }] }, ...over,
  }]);

/** TEST STUB. It is not an attestation of anything; it only lets the unit tests reach the code under test. */
function stubGuard(over: Record<string, unknown> = {}): EgressGuard {
  return {
    attest: (): Promise<EgressAttestation> =>
      Promise.resolve({
        verified: true, network: NET, proxyUrl: PROXY_URL, allowedHosts: ["registry.npmjs.org"],
        evidence: "unit-test stub, not a real attestation", ...over,
      } as EgressAttestation),
  };
}

const REPORT_OK: AcquireResult = {
  status: "passed", phase: "done", durationMs: 7, exitCode: 0, stdoutTail: "\nadded 1 package in 2s\n", stderrTail: "",
  files: [{ path: "content-v2/sha512/aa/bb/x", size: 1, data: "eA==" }],
};
const reportFail = (extra: Partial<AcquireResult> = {}): AcquireResult => ({
  status: "failed", phase: "install", reason: "exit-code", detail: "exited with code 1", exitCode: 1, durationMs: 3,
  stdoutTail: "", stderrTail: "npm error code ECONNREFUSED", files: [], ...extra,
});
const exited = (r: AcquireResult): ProcessResult => res({ exitCode: r.status === "passed" ? 0 : 1, stdout: encodeAcquireLine(r) });

// ---- fake docker ----

type Behaviour = ProcessResult | Error | ((source: string) => ProcessResult);

interface Doc {
  Config: Record<string, unknown>;
  HostConfig: Record<string, unknown>;
  NetworkSettings: { Networks: Record<string, unknown> };
  State: Record<string, unknown>;
  Mounts: Array<Record<string, unknown>>;
}

function valuesOf(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === flag) out.push(String(args[i + 1])); });
  return out;
}

function docFromCreate(args: readonly string[]): Doc {
  const imageIdx = args.indexOf(IMAGE);
  const labels: Record<string, string> = {};
  for (const l of valuesOf(args, "--label")) {
    const i = l.indexOf("=");
    labels[l.slice(0, i)] = l.slice(i + 1);
  }
  const tmpfs: Record<string, string> = {};
  for (const t of valuesOf(args, "--tmpfs")) {
    const i = t.indexOf(":");
    tmpfs[t.slice(0, i)] = t.slice(i + 1);
  }
  const mounts = valuesOf(args, "--mount").map((m) => {
    const kv: Record<string, string> = {};
    for (const part of m.split(",")) {
      const [k, ...rest] = part.split("=");
      kv[k as string] = rest.join("=");
    }
    return { Type: kv["type"], Source: kv["source"], Destination: kv["target"], RW: !m.endsWith(",readonly") };
  });
  const net = valuesOf(args, "--network")[0] as string;
  return {
    Config: {
      User: "65532:65532", Image: IMAGE, Cmd: args.slice(imageIdx + 1), Entrypoint: [""], Labels: labels,
      Env: [...valuesOf(args, "--env"), "PATH=/usr/local/bin:/usr/bin", "NODE_VERSION=22.0.0", "YARN_VERSION=1.22.22"],
    },
    HostConfig: {
      NetworkMode: net, Privileged: false, ReadonlyRootfs: true, CapDrop: ["ALL"], CapAdd: null,
      SecurityOpt: ["no-new-privileges"], Memory: 512 * MB, MemorySwap: 512 * MB, PidsLimit: 128,
      NanoCpus: 1_000_000_000, PidMode: "", IpcMode: "private", Binds: null, Devices: [], VolumesFrom: null,
      PortBindings: {}, Dns: null, ExtraHosts: null, Tmpfs: tmpfs,
      LogConfig: { Type: "json-file", Config: { "max-size": "64k", "max-file": "1" } },
    },
    NetworkSettings: { Networks: { [net]: {} } },
    State: { Status: "created", Running: false, ExitCode: 0, Error: "", StartedAt: "0001-01-01T00:00:00Z" },
    Mounts: mounts,
  };
}

class FakeDocker {
  readonly calls: Array<{ args: readonly string[] }> = [];
  behaviour: Behaviour = exited(REPORT_OK);
  versionResult: ProcessResult = res({ stdout: "27.0.0\n" });
  networkResult: ProcessResult = res({ stdout: NETWORK_JSON() });
  rmRemoves = true;
  tamper: ((d: Doc) => void) | null = null;
  /** Files seen in the staged directory when the container was created. */
  stagedAtCreate: string[] | null = null;
  private readonly containers = new Map<string, { doc: Doc; started: boolean; exit: number | null }>();

  readonly executor: ProcessExecutor = (_file, args) => {
    this.calls.push({ args });
    return Promise.resolve(this.handle(args));
  };

  private handle(args: readonly string[]): ProcessResult {
    const name = String(args[args.length - 1]);
    switch (args[0]) {
      case "version":
        return this.versionResult;
      case "network":
        return this.networkResult;
      case "create": {
        const doc = docFromCreate(args);
        const src = String(doc.Mounts[0]?.["Source"] ?? "");
        this.stagedAtCreate = existsSync(src) ? readdirSync(src).sort() : null;
        this.containers.set(valuesOf(args, "--name")[0] as string, { doc, started: false, exit: null });
        return res({ stdout: "id\n" });
      }
      case "inspect": {
        const c = this.containers.get(name);
        if (c === undefined) return res({ exitCode: 1, stderr: `Error: No such object: ${name}\n` });
        const doc = JSON.parse(JSON.stringify(c.doc)) as Doc;
        if (c.started) Object.assign(doc.State, { Status: "exited", ExitCode: c.exit ?? 0, StartedAt: "2026-11-15T10:00:00Z" });
        this.tamper?.(doc);
        return res({ stdout: JSON.stringify([doc]) });
      }
      case "start": {
        const c = this.containers.get(name);
        assert.ok(c, "start of an unknown container");
        c.started = true;
        const b = this.behaviour;
        if (b instanceof Error) throw b;
        const r = typeof b === "function" ? b(String(c.doc.Mounts[0]?.["Source"] ?? "")) : b;
        c.exit = r.exitCode;
        return r;
      }
      case "rm":
        if (this.rmRemoves) this.containers.delete(name);
        return res();
      case "ps":
        return res({ stdout: this.containers.size > 0 ? "deadbeef\n" : "" });
      default:
        throw new Error(`unexpected docker subcommand: ${String(args[0])}`);
    }
  }

  get names(): string[] {
    return this.calls.map((c) => (c.args[0] === "network" ? `network ${String(c.args[1])}` : String(c.args[0])));
  }
  get created(): boolean {
    return this.names.includes("create");
  }
  get started(): boolean {
    return this.names.includes("start");
  }
}

// ---- harness ----

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

interface Rig {
  docker: FakeDocker;
  acq: NpmRegistryAcquisition;
  staging: string;
  runDir: string;
  driver: string;
  req: RegistryAcquisitionRequest;
  handoffCalls: Array<{ files: unknown; expected: unknown; runDir: string; name: string }>;
}

function rig(over: Partial<RegistryAcquisitionOptions> = {}, useStubHandoff = true): Rig {
  const root = mkdtempSync(join(tmpdir(), "gy-regacq-"));
  roots.push(root);
  const staging = join(root, "staging");
  const runDir = join(root, "run");
  const driver = join(root, "npm-acquire-driver.js");
  mkdirSync(staging);
  mkdirSync(runDir);
  writeFileSync(driver, "// stand-in for the compiled driver\n");
  const docker = new FakeDocker();
  const handoffCalls: Rig["handoffCalls"] = [];
  const stub: NonNullable<RegistryAcquisitionOptions["handoff"]> = (files, expected, rd, name) => {
    handoffCalls.push({ files, expected, runDir: rd, name });
    return {
      ok: true as const,
      cacheDir: join(rd, name),
      summary: { files: 2, contentFiles: 1, indexFiles: 1, totalBytes: 3, directories: 6, tarballs: [{ ...FIXED_PACKAGE }] },
    };
  };
  const acq = new NpmRegistryAcquisition({
    executor: docker.executor,
    egress: stubGuard(),
    stagingRoot: staging,
    driverPath: driver,
    ...(useStubHandoff ? { handoff: stub } : {}),
    ...over,
  });
  return { docker, acq, staging, runDir, driver, handoffCalls, req: { executionId: EXEC_ID, fixture: FIXED_FIXTURE_ID, image: IMAGE, runDir } };
}

const ALLOWED_SUBCOMMANDS = new Set(["version", "network inspect", "create", "inspect", "start", "rm", "ps"]);

// ---------------------------------------------------------------------------

describe("fixed fixture", () => {
  it("is exactly one registry-form package that passes the static lock policy", () => {
    const p = checkNpmFixture(FIXED_PACKAGE_JSON, FIXED_LOCKFILE);
    assert.ok(p.ok);
    assert.equal(p.packageCount, 1);
    assert.equal(p.rootDependencyCount, 1);
    assert.deepEqual(checkFixedFixture(FIXED_PACKAGE_JSON, FIXED_LOCKFILE), { ok: true, packageCount: 1 });
  });

  it("names is-number@7.0.0 with the pinned integrity and the exact registry URL", () => {
    const lock = JSON.parse(FIXED_LOCKFILE) as { packages: Record<string, Record<string, unknown>> };
    const e = lock.packages["node_modules/is-number"] as Record<string, unknown>;
    assert.equal(e["version"], "7.0.0");
    assert.equal(e["resolved"], "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz");
    assert.equal(e["integrity"], FIXED_PACKAGE.integrity);
    assert.deepEqual(Object.keys(lock.packages).sort(), ["", "node_modules/is-number"]);
    assert.match(FIXED_PACKAGE.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.notEqual(contentPathFor(FIXED_PACKAGE.integrity), null);
  });

  it("rejects any other bytes, even a harmless-looking edit", () => {
    for (const [p, l] of [
      [FIXED_PACKAGE_JSON + " ", FIXED_LOCKFILE],
      [FIXED_PACKAGE_JSON, FIXED_LOCKFILE.replace("7.0.0", "7.0.1")],
      [FIXED_PACKAGE_JSON, FIXED_LOCKFILE.replace("https://registry.npmjs.org", "https://evil.example")],
      ["{}", "{}"], [undefined, undefined], [FIXED_PACKAGE_JSON, null],
    ] as const) {
      assert.equal(checkFixedFixture(p, l).ok, false);
    }
  });

  it("the egress allowlist for this module is exactly registry.npmjs.org", () => {
    assert.deepEqual([...REGISTRY_EGRESS_HOSTS], ["registry.npmjs.org"]);
  });
});

describe("ipv4InCidr and networkProblem", () => {
  it("checks CIDR membership strictly", () => {
    assert.equal(ipv4InCidr("10.231.4.10", "10.231.4.0/24"), true);
    assert.equal(ipv4InCidr("10.231.5.10", "10.231.4.0/24"), false);
    assert.equal(ipv4InCidr("10.231.5.10", "10.231.4.0/23"), true);
    assert.equal(ipv4InCidr("10.0.0.1", "10.231.4.0/7"), false);
    assert.equal(ipv4InCidr("10.0.0.1", "10.231.4.0/31"), false);
    for (const c of ["", "10.231.4.0", "10.231.4.0/", "fd00::/64", "999.1.1.1/24", "10.231.4.0/24 "]) assert.equal(ipv4InCidr("10.231.4.10", c), false, c);
    assert.equal(ipv4InCidr("not-an-ip", "10.231.4.0/24"), false);
  });

  it("accepts only an Internal, IPv4-only bridge whose subnet holds the proxy", () => {
    assert.equal(networkProblem(res({ stdout: NETWORK_JSON() }), NET, PROXY_IP), null);
    const bad: Array<[string, ProcessResult]> = [
      ["not internal", res({ stdout: NETWORK_JSON({ Internal: false }) })],
      ["internal missing", res({ stdout: NETWORK_JSON({ Internal: undefined }) })],
      ["wrong name", res({ stdout: NETWORK_JSON({ Name: "other" }) })],
      ["overlay", res({ stdout: NETWORK_JSON({ Driver: "overlay" }) })],
      ["ipv6", res({ stdout: NETWORK_JSON({ EnableIPv6: true }) })],
      ["ipv6 subnet", res({ stdout: NETWORK_JSON({ IPAM: { Config: [{ Subnet: "fd00::/64" }, { Subnet: "10.231.4.0/24" }] } }) })],
      ["proxy outside subnet", res({ stdout: NETWORK_JSON({ IPAM: { Config: [{ Subnet: "10.99.0.0/24" }] } }) })],
      ["proxy is gateway", res({ stdout: NETWORK_JSON({ IPAM: { Config: [{ Subnet: "10.231.4.0/24", Gateway: PROXY_IP }] } }) })],
      ["no ipam", res({ stdout: NETWORK_JSON({ IPAM: undefined }) })],
      ["not json", res({ stdout: "oops" })],
      ["empty list", res({ stdout: "[]" })],
      ["two networks", res({ stdout: `[${JSON.stringify({ Name: NET })},${JSON.stringify({ Name: NET })}]` })],
      ["docker error", res({ exitCode: 1, stderr: "no such network" })],
      ["timed out", res({ timedOut: true })],
      ["truncated", res({ truncated: true })],
    ];
    for (const [label, r] of bad) assert.notEqual(networkProblem(r, NET, PROXY_IP), null, label);
  });
});

describe("buildCreateArgs", () => {
  const ctx: RunCtx = {
    plan: { name: npmAcquisitionContainerName(EXEC_ID), executionId: EXEC_ID, image: IMAGE, runDir: "/tmp/run", signal: undefined },
    egress: { network: NET, proxyUrl: PROXY_URL, proxyHost: PROXY_IP },
    stagedDir: "/staging/acq-0123456789ab",
    timeoutMs: 1000,
  };
  const args = buildCreateArgs(ctx);

  it("attaches the attested internal network only, and never bridge, host or none", () => {
    assert.deepEqual(valuesOf(args, "--network"), [NET]);
    for (const bad of ["bridge", "host", "none", "default", "container:x"]) assert.equal(args.includes(bad), false, bad);
  });

  it("has no privileged mode, extra capability, device, published port, extra mount, volume or credential", () => {
    for (const f of [
      "--privileged", "--cap-add", "--device", "--publish", "-p", "-P", "--volume", "-v", "--volumes-from", "--add-host", "--dns",
      "--env-file", "--pid", "--ipc", "--uts", "--userns", "--security-opt=seccomp=unconfined", "--ulimit", "--init", "--cgroupns",
    ]) assert.equal(args.includes(f), false, f);
    assert.equal(args.some((a) => /docker\.sock|\/var\/run|\.npmrc|\.ssh|\.aws|\.docker/i.test(a)), false);
    const mounts = valuesOf(args, "--mount");
    assert.deepEqual(mounts, [`type=bind,source=${ctx.stagedDir},target=/fixture,readonly`]);
    assert.deepEqual(valuesOf(args, "--env"), [`GRAVEYARD_NPM_PROXY=${PROXY_URL}`]);
  });

  it("is non-root, capability-free, read-only and bounded, and never pulls", () => {
    assert.deepEqual(valuesOf(args, "--user"), ["65532:65532"]);
    assert.deepEqual(valuesOf(args, "--cap-drop"), ["ALL"]);
    assert.deepEqual(valuesOf(args, "--security-opt"), ["no-new-privileges"]);
    assert.ok(args.includes("--read-only"));
    assert.deepEqual(valuesOf(args, "--pull"), ["never"]);
    assert.deepEqual(valuesOf(args, "--restart"), ["no"]);
    for (const f of ["--memory", "--memory-swap", "--cpus", "--pids-limit"]) assert.equal(valuesOf(args, f).length, 1, f);
    assert.equal(valuesOf(args, "--tmpfs").length, 2);
    for (const t of valuesOf(args, "--tmpfs")) assert.match(t, /noexec,nosuid,nodev/);
  });

  it("ends with the image and the fixed argv, and carries only validated values", () => {
    assert.deepEqual(args.slice(-3), [IMAGE, ...NPM_ACQ_ARGV]);
    assert.deepEqual([...NPM_ACQ_ARGV], ["node", `/fixture/${STAGED_ACQ_DRIVER_NAME}`]);
    assert.equal(args.includes("sh"), false);
    assert.equal(args.includes("-c"), false);
    assert.deepEqual(valuesOf(args, "--entrypoint"), [""]);
  });
});

describe("acquire: gates before any container exists", () => {
  it("is unavailable by default: the default guard never attests and docker is never contacted", async () => {
    const r = rig({ egress: new UnavailableEgressGuard() });
    const out = await r.acq.acquire(r.req);
    assert.equal(out.kind, "network-unavailable");
    assert.deepEqual(r.docker.names, []);
    assert.equal(out.cleanup, null);
  });

  it("refuses an attestation for github.com, extra hosts, a default network or a hostname proxy", async () => {
    const cases: Array<Record<string, unknown>> = [
      { allowedHosts: ["github.com"] },
      { allowedHosts: ["registry.npmjs.org", "github.com"] },
      { allowedHosts: [] },
      { allowedHosts: ["registry.npmjs.org."] },
      { network: "bridge" },
      { network: "host" },
      { proxyUrl: "http://proxy.internal:3128" },
      { proxyUrl: "http://8.8.8.8:3128" },
      { proxyUrl: "https://10.231.4.10:3128" },
      { proxyUrl: "http://user:pw@10.231.4.10:3128" },
      { evidence: "" },
      { verified: false, reason: "no proxy" },
    ];
    for (const c of cases) {
      const r = rig({ egress: stubGuard(c) });
      const out = await r.acq.acquire(r.req);
      assert.equal(out.kind, "network-unavailable", JSON.stringify(c));
      assert.deepEqual(r.docker.names, [], JSON.stringify(c));
    }
  });

  it("fails closed when the guard throws", async () => {
    const r = rig({ egress: { attest: () => Promise.reject(new Error("boom")) } });
    assert.equal((await r.acq.acquire(r.req)).kind, "network-unavailable");
    assert.deepEqual(r.docker.names, []);
  });

  it("rejects bad requests without contacting docker", async () => {
    const r = rig();
    const bad: Array<Partial<RegistryAcquisitionRequest>> = [
      { fixture: "lodash" }, { fixture: "is-number-7.0.1" }, { fixture: "" }, { image: "alpine:3.21" }, { image: "node:latest" },
      { executionId: "bad id" }, { executionId: "x:1; rm -rf /" }, { runDir: "relative" }, { runDir: join(r.runDir, "missing") },
      { runDir: join(r.staging, "..", "nonexistent") },
    ];
    for (const b of bad) {
      const out = await r.acq.acquire({ ...r.req, ...b });
      assert.equal(out.kind, "rejected", JSON.stringify(b));
    }
    assert.equal((await r.acq.acquire(null as unknown as RegistryAcquisitionRequest)).kind, "rejected");
    assert.deepEqual(r.docker.names, []);
  });

  it("does nothing when already aborted", async () => {
    const r = rig();
    const ac = new AbortController();
    ac.abort();
    const out = await r.acq.acquire({ ...r.req, signal: ac.signal });
    assert.equal(out.kind, "aborted");
    assert.deepEqual(r.docker.names, []);
  });

  it("is unavailable when the daemon does not answer, and creates nothing", async () => {
    const r = rig();
    r.docker.versionResult = res({ exitCode: 1, stderr: "cannot connect" });
    assert.equal((await r.acq.acquire(r.req)).kind, "unavailable");
    assert.equal(r.docker.created, false);
  });

  it("refuses a network that is not Internal, or whose subnet does not hold the proxy, and creates nothing", async () => {
    for (const result of [res({ stdout: NETWORK_JSON({ Internal: false }) }), res({ stdout: NETWORK_JSON({ IPAM: { Config: [{ Subnet: "10.9.0.0/24" }] } }) }), res({ exitCode: 1 })]) {
      const r = rig();
      r.docker.networkResult = result;
      const out = await r.acq.acquire(r.req);
      assert.equal(out.kind, "network-unavailable");
      assert.equal(r.docker.created, false);
      assert.equal(out.cleanup, null);
    }
  });

  it("refuses a missing or unpinned driver and creates nothing", async () => {
    const missing = rig({ driverPath: join(tmpdir(), "gy-no-such-driver.js") });
    assert.equal((await missing.acq.acquire(missing.req)).kind, "unavailable");
    assert.equal(missing.docker.created, false);

    const pinned = rig({ expectedDriverSha256: "0".repeat(64) });
    const out = await pinned.acq.acquire(pinned.req);
    assert.equal(out.kind, "unavailable");
    assert.equal(pinned.docker.created, false);
    assert.deepEqual(readdirSync(pinned.staging), []);
  });

  it("rejects construction with invalid options", () => {
    const r = rig();
    const base = { executor: r.docker.executor, egress: stubGuard(), stagingRoot: r.staging, driverPath: r.driver };
    assert.throws(() => new NpmRegistryAcquisition({ ...base, stagingRoot: "relative" }));
    assert.throws(() => new NpmRegistryAcquisition({ ...base, stagingRoot: join(r.staging, "missing") }));
    assert.throws(() => new NpmRegistryAcquisition({ ...base, image: "Bad Image" }));
    assert.throws(() => new NpmRegistryAcquisition({ ...base, expectedDriverSha256: "xyz" }));
    assert.throws(() => new NpmRegistryAcquisition({ ...base, dockerBinary: "docker; rm" }));
    assert.throws(() => new NpmRegistryAcquisition({ ...base, limits: { timeoutMs: 1 } }));
    assert.throws(() => new NpmRegistryAcquisition({ ...base, egress: undefined as unknown as EgressGuard }));
  });
});

describe("acquire: container isolation", () => {
  it("stages exactly the driver and the two fixed files, read-only, and removes them afterwards", async () => {
    const r = rig();
    const out = await r.acq.acquire(r.req);
    assert.equal(out.kind, "acquired");
    assert.deepEqual(r.docker.stagedAtCreate, ["npm-acquire-driver.mjs", "package-lock.json", "package.json"]);
    assert.deepEqual(readdirSync(r.staging), []);
    assert.equal(out.stagingRemoved, true);
  });

  it("stages the fixed fixture bytes and a copy of the driver", async () => {
    const r = rig();
    let seen: Record<string, string> = {};
    r.docker.behaviour = (source) => {
      seen = Object.fromEntries(readdirSync(source).map((n) => [n, readFileSync(join(source, n), "utf8")]));
      return exited(REPORT_OK);
    };
    await r.acq.acquire(r.req);
    assert.equal(seen["package.json"], FIXED_PACKAGE_JSON);
    assert.equal(seen["package-lock.json"], FIXED_LOCKFILE);
    assert.equal(seen["npm-acquire-driver.mjs"], "// stand-in for the compiled driver\n");
  });

  it("only ever issues the expected docker subcommands, never exec, run, cp, pull, load or build", async () => {
    const r = rig();
    await r.acq.acquire(r.req);
    for (const n of new Set(r.docker.names)) assert.ok(ALLOWED_SUBCOMMANDS.has(n), n);
    const networkCalls = r.docker.calls.filter((c) => c.args[0] === "network");
    assert.ok(networkCalls.every((c) => c.args[1] === "inspect"));
  });

  const tampers: Array<[string, (d: Doc) => void]> = [
    ["default bridge network", (d) => { d.HostConfig["NetworkMode"] = "bridge"; }],
    ["host network", (d) => { d.HostConfig["NetworkMode"] = "host"; }],
    ["none network", (d) => { d.HostConfig["NetworkMode"] = "none"; }],
    ["a second network", (d) => { d.NetworkSettings.Networks = { [NET]: {}, bridge: {} }; }],
    ["published ports", (d) => { d.HostConfig["PortBindings"] = { "80/tcp": [{ HostPort: "80" }] }; }],
    ["custom dns", (d) => { d.HostConfig["Dns"] = ["8.8.8.8"]; }],
    ["extra hosts", (d) => { d.HostConfig["ExtraHosts"] = ["x:1.2.3.4"]; }],
    ["privileged", (d) => { d.HostConfig["Privileged"] = true; }],
    ["added capability", (d) => { d.HostConfig["CapAdd"] = ["NET_ADMIN"]; }],
    ["capabilities not dropped", (d) => { d.HostConfig["CapDrop"] = []; }],
    ["writable root", (d) => { d.HostConfig["ReadonlyRootfs"] = false; }],
    ["root user", (d) => { d.Config["User"] = "0:0"; }],
    ["different image", (d) => { d.Config["Image"] = "alpine:3.21"; }],
    ["different command", (d) => { d.Config["Cmd"] = ["sh"]; }],
    ["entrypoint set", (d) => { d.Config["Entrypoint"] = ["sh"]; }],
    ["proxy variable missing", (d) => { d.Config["Env"] = ["PATH=/x"]; }],
    ["an extra proxy variable", (d) => { (d.Config["Env"] as string[]).push("HTTPS_PROXY=http://example.com:3128"); }],
    ["an npm config variable", (d) => { (d.Config["Env"] as string[]).push("NPM_CONFIG_REGISTRY=https://evil.example/"); }],
    ["a token variable", (d) => { (d.Config["Env"] as string[]).push("NPM_TOKEN=abc"); }],
    ["a bind", (d) => { d.HostConfig["Binds"] = ["/var/run/docker.sock:/var/run/docker.sock"]; }],
    ["an extra mount", (d) => { d.Mounts.push({ Type: "bind", Source: "/", Destination: "/host", RW: true }); }],
    ["a writable staged mount", (d) => { (d.Mounts[0] as Record<string, unknown>)["RW"] = true; }],
    ["a different staged source", (d) => { (d.Mounts[0] as Record<string, unknown>)["Source"] = "/etc"; }],
    ["no mounts", (d) => { d.Mounts = []; }],
    ["devices", (d) => { d.HostConfig["Devices"] = [{ PathOnHost: "/dev/mem" }]; }],
    ["host pid namespace", (d) => { d.HostConfig["PidMode"] = "host"; }],
    ["weaker memory limit", (d) => { d.HostConfig["Memory"] = 0; }],
    ["no pids limit", (d) => { d.HostConfig["PidsLimit"] = 0; }],
    ["extra tmpfs", (d) => { (d.HostConfig["Tmpfs"] as Record<string, string>)["/extra"] = "rw"; }],
    ["exec tmpfs", (d) => { (d.HostConfig["Tmpfs"] as Record<string, string>)["/work"] = "rw,exec,size=64m"; }],
    ["wrong log config", (d) => { d.HostConfig["LogConfig"] = { Type: "local", Config: {} }; }],
    ["missing labels", (d) => { d.Config["Labels"] = {}; }],
  ];
  for (const [label, tamper] of tampers) {
    it(`never starts a container with ${label}`, async () => {
      const r = rig();
      r.docker.tamper = tamper;
      const out = await r.acq.acquire(r.req);
      // A missing label also makes cleanup refuse, which is the other safe outcome.
      assert.ok(out.kind === "isolation-violation" || out.kind === "unavailable", out.kind);
      assert.equal(r.docker.started, false);
      assert.equal(r.handoffCalls.length, 0);
    });
  }
});

describe("acquire: outcomes", () => {
  it("acquired: container ran to exit 0, cleanup and staging are proven, and the handoff was asked for the fixed package only", async () => {
    const r = rig();
    const out = await r.acq.acquire(r.req);
    assert.equal(out.kind, "acquired");
    assert.ok(out.cleanup?.confirmed === true);
    assert.equal(out.stagingRemoved, true);
    assert.equal(out.executionId, EXEC_ID);
    assert.match(out.driverSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(r.handoffCalls.length, 1);
    assert.deepEqual(r.handoffCalls[0]?.expected, [FIXED_PACKAGE]);
    assert.equal(r.handoffCalls[0]?.runDir, r.runDir);
    assert.equal(r.handoffCalls[0]?.name, "cache");
    assert.ok(out.kind === "acquired" && out.cacheDir === join(r.runDir, "cache") && out.packagesAdded === 1);
    assert.deepEqual(r.docker.names.slice(0, 4), ["version", "network inspect", "create", "inspect"]);
    assert.ok(r.docker.names.indexOf("create") < r.docker.names.indexOf("start"));
    assert.ok(r.docker.names.lastIndexOf("rm") > r.docker.names.indexOf("start"));
  });

  it("a driver failure is install-failed with a bounded diagnostic, never acquired, and the container is still removed", async () => {
    const r = rig();
    r.docker.behaviour = exited(reportFail());
    const out = await r.acq.acquire(r.req);
    assert.ok(out.kind === "install-failed");
    assert.equal(out.phase, "install");
    assert.equal(out.reason, "exit-code");
    assert.match(out.diagnostic, /ECONNREFUSED/);
    assert.ok(out.cleanup?.confirmed === true);
    assert.equal(r.handoffCalls.length, 0);
  });

  it("a cancelled report is aborted, and a timeout or abort from the executor is reported as such", async () => {
    const c = rig();
    c.docker.behaviour = exited(reportFail({ status: "cancelled", reason: "cancelled", exitCode: null }));
    assert.equal((await c.acq.acquire(c.req)).kind, "aborted");

    const t = rig();
    t.docker.behaviour = res({ exitCode: null, timedOut: true });
    const to = await t.acq.acquire(t.req);
    assert.equal(to.kind, "timed-out");
    assert.ok(to.cleanup?.confirmed === true);

    const a = rig();
    a.docker.behaviour = res({ exitCode: null, aborted: true });
    assert.equal((await a.acq.acquire(a.req)).kind, "aborted");
    assert.equal(a.handoffCalls.length, 0);
  });

  it("untrusted output is a protocol error: truncated, stderr, odd exit code, contradiction, garbage", async () => {
    const line = encodeAcquireLine(REPORT_OK);
    const cases: ProcessResult[] = [
      res({ exitCode: 0, stdout: line, truncated: true }),
      res({ exitCode: 0, stdout: line, stderr: "warning" }),
      res({ exitCode: 2, stdout: line }),
      res({ exitCode: 137, stdout: "" }),
      res({ exitCode: 1, stdout: line }), // exit 1 but report says passed
      res({ exitCode: 0, stdout: encodeAcquireLine(reportFail()) }), // exit 0 but report says failed
      res({ exitCode: 0, stdout: "added 1 package\n" }),
      res({ exitCode: 0, stdout: "" }),
      res({ exitCode: 0, stdout: `${line}${line}` }),
    ];
    for (const behaviour of cases) {
      const r = rig();
      r.docker.behaviour = behaviour;
      const out = await r.acq.acquire(r.req);
      // A nonzero exit code that inspect cannot confirm is `unavailable`, which is also a refusal.
      assert.ok(out.kind === "protocol-error" || out.kind === "unavailable", `${out.kind} for exit ${String(behaviour.exitCode)}`);
      assert.equal(r.handoffCalls.length, 0);
    }
  });

  it("refuses when npm's own package count differs from the lockfile", async () => {
    for (const tailText of ["\nadded 2 packages in 2s\n", "", "nothing here\n", "added 0 packages in 1s\n"]) {
      const r = rig();
      r.docker.behaviour = exited({ ...REPORT_OK, stdoutTail: tailText });
      const out = await r.acq.acquire(r.req);
      assert.equal(out.kind, "summary-mismatch", tailText);
      assert.equal(r.handoffCalls.length, 0);
    }
  });

  it("does not trust the output when container cleanup cannot be proven", async () => {
    const r = rig();
    r.docker.rmRemoves = false;
    const out = await r.acq.acquire(r.req);
    assert.equal(out.kind, "cleanup-unconfirmed");
    assert.ok(out.cleanup?.confirmed === false);
    assert.equal(r.handoffCalls.length, 0);
  });

  it("does not trust the output when the staging directory cannot be removed", async () => {
    const r = rig();
    r.docker.behaviour = (source) => {
      writeFileSync(join(source, "intruder"), "x");
      return exited(REPORT_OK);
    };
    const out = await r.acq.acquire(r.req);
    assert.equal(out.kind, "staging-cleanup-failed");
    assert.equal(out.stagingRemoved, false);
    assert.equal(r.handoffCalls.length, 0);
  });

  it("with the real handoff, bytes that do not match the lockfile integrity are rejected and nothing is written", async () => {
    const r = rig({}, false);
    const key = tarballKey(FIXED_PACKAGE);
    const wrong = Buffer.from("these are not the bytes the lockfile names");
    const json = JSON.stringify({ key, integrity: FIXED_PACKAGE.integrity, time: 1, size: wrong.length });
    const files = [
      { path: contentPathFor(FIXED_PACKAGE.integrity) as string, size: wrong.length, data: wrong.toString("base64") },
      (() => {
        const idx = Buffer.from(`\n${"0".repeat(40)}\t${json}`);
        return { path: indexPathFor(key), size: idx.length, data: idx.toString("base64") };
      })(),
    ];
    r.docker.behaviour = exited({ ...REPORT_OK, files });
    const out = await r.acq.acquire(r.req);
    assert.ok(out.kind === "handoff-rejected");
    assert.equal(out.dir, null);
    assert.deepEqual(readdirSync(r.runDir), []);
    assert.ok(out.cleanup?.confirmed === true);
  });

  it("never throws, even when the executor does", async () => {
    const r = rig();
    r.docker.behaviour = new Error("spawn failed");
    const out = await r.acq.acquire(r.req);
    assert.notEqual(out.kind, "acquired");
    assert.ok(out.cleanup !== null);
    assert.deepEqual(readdirSync(r.staging), []);
  });
});

describe("cleanup", () => {
  it("refuses to remove a container that lacks this adapter's labels", async () => {
    const r = rig();
    const name = npmAcquisitionContainerName(EXEC_ID);
    // Build a foreign container directly in the fake: same name, no labels.
    r.docker.executor("docker", ["create", "--name", name, "--network", NET, IMAGE], { timeoutMs: 1, maxOutputBytes: 1 });
    await Promise.resolve();
    const proof = await r.acq.cleanup({ executionId: EXEC_ID });
    assert.equal(proof.confirmed, false);
    assert.equal(r.docker.names.includes("rm"), false);
  });

  it("is confirmed when nothing exists, and rejects an invalid id without contacting docker", async () => {
    const r = rig();
    assert.equal((await r.acq.cleanup({ executionId: EXEC_ID })).confirmed, true);
    const before = r.docker.calls.length;
    assert.equal((await r.acq.cleanup({ executionId: "bad id" })).confirmed, false);
    assert.equal(r.docker.calls.length, before);
  });
});


// ---------------------------------------------------------------------------
// Operator-supplied multi-package lockfile v3 fixtures. Synthetic data, mocked docker. These show the
// gating and the plumbing only; they do not show that real npm or the registry accept such files.
// ---------------------------------------------------------------------------

describe("acquire: operator fixture", () => {
  const REPORT_3: AcquireResult = { ...REPORT_OK, stdoutTail: "\nadded 3 packages in 2s\n" };
  const opReq = (r: Rig, d: OperatorDoc = operatorDoc()): RegistryAcquisitionRequest => ({
    ...r.req,
    fixture: OPERATOR_FIXTURE_ID,
    operatorFixture: textsOf(d),
  });
  const pk = (d: OperatorDoc): Json => d.lock["packages"];

  it("is unavailable by default: the default guard never attests and docker is never contacted", async () => {
    const r = rig({ egress: new UnavailableEgressGuard() });
    const out = await r.acq.acquire(opReq(r));
    assert.equal(out.kind, "network-unavailable");
    assert.deepEqual(r.docker.names, []);
    assert.equal(out.cleanup, null);
  });

  it("rejects a policy-violating fixture before the guard is asked and before docker is contacted", async () => {
    const mutations: Array<[string, (d: OperatorDoc) => void]> = [
      ["devDependencies", (d) => { d.pkg["devDependencies"] = { gamma: "^0.3.0" }; }],
      ["install script", (d) => { d.pkg["scripts"] = { postinstall: "node x.js" }; }],
      ["lockfileVersion 2", (d) => { d.lock["lockfileVersion"] = 2; }],
      ["git specifier", (d) => { d.pkg["dependencies"]["alpha"] = "git+https://github.com/u/r.git"; }],
      ["other registry", (d) => { pk(d)["node_modules/gamma"]["resolved"] = "https://evil.example/gamma/-/gamma-0.3.4.tgz"; }],
      ["sha1 integrity", (d) => { pk(d)["node_modules/gamma"]["integrity"] = "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA="; }],
      ["nested package", (d) => { pk(d)["node_modules/alpha/node_modules/gamma"] = lockEntry("gamma", "0.3.4"); }],
      ["too many packages", (d) => { withExtraRootPackages(d, 6); }],
      ["optional entry", (d) => { pk(d)["node_modules/gamma"]["optional"] = true; }],
    ];
    for (const [label, mutate] of mutations) {
      let asked = 0;
      const guard: EgressGuard = {
        attest: (): Promise<EgressAttestation> => {
          asked += 1;
          return stubGuard().attest();
        },
      };
      const r = rig({ egress: guard });
      const d = operatorDoc();
      mutate(d);
      const out = await r.acq.acquire(opReq(r, d));
      assert.equal(out.kind, "rejected", label);
      assert.equal(asked, 0, label);
      assert.deepEqual(r.docker.names, [], label);
      assert.deepEqual(readdirSync(r.staging), [], label);
    }
  });

  it("rejects mismatched fixture selectors and malformed operator input", async () => {
    const r = rig();
    const t = textsOf(operatorDoc());
    const bad: Array<Partial<RegistryAcquisitionRequest>> = [
      { fixture: FIXED_FIXTURE_ID, operatorFixture: t },
      { fixture: OPERATOR_FIXTURE_ID },
      { fixture: OPERATOR_FIXTURE_ID, operatorFixture: undefined },
      { fixture: OPERATOR_FIXTURE_ID, operatorFixture: null as unknown as RegistryAcquisitionRequest["operatorFixture"] },
      { fixture: OPERATOR_FIXTURE_ID, operatorFixture: {} as unknown as RegistryAcquisitionRequest["operatorFixture"] },
      { fixture: OPERATOR_FIXTURE_ID, operatorFixture: { ...t, extra: "x" } as unknown as RegistryAcquisitionRequest["operatorFixture"] },
      { fixture: OPERATOR_FIXTURE_ID, operatorFixture: { packageJson: 1, packageLock: 2 } as unknown as RegistryAcquisitionRequest["operatorFixture"] },
      { fixture: OPERATOR_FIXTURE_ID, operatorFixture: { packageJson: t.packageJson } as unknown as RegistryAcquisitionRequest["operatorFixture"] },
      { fixture: "operator-lockfile-v2", operatorFixture: t },
      { fixture: "", operatorFixture: t },
    ];
    for (const b of bad) {
      const out = await r.acq.acquire({ ...r.req, ...b });
      assert.equal(out.kind, "rejected", JSON.stringify(Object.keys(b)));
    }
    assert.deepEqual(r.docker.names, []);
  });

  it("stages exactly the operator's bytes, expects exactly its packages, and requires npm's own count to match", async () => {
    const r = rig();
    const d = operatorDoc();
    const t = textsOf(d);
    let seen: Record<string, string> = {};
    r.docker.behaviour = (source) => {
      seen = Object.fromEntries(readdirSync(source).map((n) => [n, readFileSync(join(source, n), "utf8")]));
      return exited(REPORT_3);
    };
    const out = await r.acq.acquire(opReq(r, d));
    assert.equal(out.kind, "acquired");
    assert.ok(out.kind === "acquired" && out.packagesAdded === 3);
    assert.equal(seen["package.json"], t.packageJson);
    assert.equal(seen["package-lock.json"], t.packageLock);
    assert.deepEqual(Object.keys(seen).sort(), ["npm-acquire-driver.mjs", "package-lock.json", "package.json"]);
    assert.deepEqual(r.handoffCalls[0]?.expected, EXPECTED_DEFAULT);
    assert.equal(out.stagingRemoved, true);
    assert.ok(out.cleanup?.confirmed === true);
    assert.deepEqual(readdirSync(r.staging), []);
  });

  it("refuses when npm adds a different number of packages than the lockfile lists", async () => {
    for (const tailText of ["\nadded 1 package in 2s\n", "\nadded 2 packages in 2s\n", "\nadded 4 packages in 2s\n", "", "nothing here\n"]) {
      const r = rig();
      r.docker.behaviour = exited({ ...REPORT_OK, stdoutTail: tailText });
      const out = await r.acq.acquire(opReq(r));
      assert.equal(out.kind, "summary-mismatch", tailText);
      assert.equal(r.handoffCalls.length, 0);
    }
  });

  it("builds the same container isolation as the fixed fixture; the fixture only changes staged bytes", async () => {
    const createArgs = async (mode: "fixed" | "operator"): Promise<string[]> => {
      const r = rig();
      if (mode === "operator") r.docker.behaviour = exited(REPORT_3);
      await r.acq.acquire(mode === "fixed" ? r.req : opReq(r));
      const call = r.docker.calls.find((c) => c.args[0] === "create");
      assert.ok(call);
      return call.args.map((a) => a.replace(/source=[^,]+/, "source=<staged>"));
    };
    const fixed = await createArgs("fixed");
    const operator = await createArgs("operator");
    assert.deepEqual(operator, fixed);
    assert.equal(operator.some((a) => /alpha|beta|gamma|op-fixture/.test(a)), false, "no operator text reaches docker arguments");
  });

  it("never starts a container whose configuration differs from the intent, in operator mode too", async () => {
    for (const tamper of [
      (x: Doc) => { x.HostConfig["NetworkMode"] = "bridge"; },
      (x: Doc) => { x.HostConfig["Privileged"] = true; },
      (x: Doc) => { x.Config["Env"] = [...(x.Config["Env"] as string[]), "NPM_CONFIG_REGISTRY=https://evil.example/"]; },
      (x: Doc) => { x.Mounts.push({ Type: "bind", Source: "/", Destination: "/host", RW: true }); },
    ]) {
      const r = rig();
      r.docker.tamper = tamper;
      const out = await r.acq.acquire(opReq(r));
      assert.equal(out.kind, "isolation-violation");
      assert.equal(r.docker.started, false);
      assert.equal(r.handoffCalls.length, 0);
    }
  });

  it("does not trust the output when cleanup or staging removal cannot be proven", async () => {
    const a = rig();
    a.docker.behaviour = exited(REPORT_3);
    a.docker.rmRemoves = false;
    assert.equal((await a.acq.acquire(opReq(a))).kind, "cleanup-unconfirmed");
    assert.equal(a.handoffCalls.length, 0);

    const b = rig();
    b.docker.behaviour = (source) => {
      writeFileSync(join(source, "intruder"), "x");
      return exited(REPORT_3);
    };
    assert.equal((await b.acq.acquire(opReq(b))).kind, "staging-cleanup-failed");
    assert.equal(b.handoffCalls.length, 0);
  });

  it("a driver failure is install-failed and never acquired", async () => {
    const r = rig();
    r.docker.behaviour = exited(reportFail());
    const out = await r.acq.acquire(opReq(r));
    assert.equal(out.kind, "install-failed");
    assert.equal(r.handoffCalls.length, 0);
    assert.ok(out.cleanup?.confirmed === true);
  });

  describe("with the real cache handoff", () => {
    it("writes a verified cache binding every package to its lockfile integrity", async () => {
      const r = rig({}, false);
      r.docker.behaviour = exited({ ...REPORT_3, files: cacheFilesFor(EXPECTED_DEFAULT) });
      const out = await r.acq.acquire(opReq(r));
      assert.equal(out.kind, "acquired");
      assert.ok(out.kind === "acquired");
      assert.equal(out.summary.files, 6);
      assert.equal(out.summary.contentFiles, 3);
      assert.equal(out.summary.indexFiles, 3);
      assert.deepEqual(out.summary.tarballs, EXPECTED_DEFAULT);
      assert.deepEqual(readdirSync(join(r.runDir, "cache", "_cacache")).sort(), ["content-v2", "index-v5"]);
    });

    it("rejects the cache and writes nothing when one tarball's bytes are not the lockfile's", async () => {
      const r = rig({}, false);
      const swapped = (name: string, version: string): Buffer =>
        name === "beta" ? Buffer.from("not the tarball the lockfile names\n") : tarballBytesFor(name, version);
      r.docker.behaviour = exited({ ...REPORT_3, files: cacheFilesFor(EXPECTED_DEFAULT, swapped) });
      const out = await r.acq.acquire(opReq(r));
      assert.equal(out.kind, "handoff-rejected");
      assert.deepEqual(readdirSync(r.runDir), []);
      assert.ok(out.cleanup?.confirmed === true);
    });

    it("rejects the cache when a listed package is missing, even though npm's count matched", async () => {
      const r = rig({}, false);
      const files = cacheFilesFor(EXPECTED_DEFAULT.filter((p) => p.name !== "gamma"));
      r.docker.behaviour = exited({ ...REPORT_3, files });
      const out = await r.acq.acquire(opReq(r));
      assert.equal(out.kind, "handoff-rejected");
      assert.deepEqual(readdirSync(r.runDir), []);
    });

    it("rejects a cache carrying an extra, unlisted package", async () => {
      const r = rig({}, false);
      const unlisted = cacheFilesFor([{ name: "intruder", version: "1.0.0", integrity: "unused: derived from the exported bytes" }]);
      r.docker.behaviour = exited({ ...REPORT_3, files: [...cacheFilesFor(EXPECTED_DEFAULT), ...unlisted] });
      const out = await r.acq.acquire(opReq(r));
      assert.equal(out.kind, "handoff-rejected");
      assert.deepEqual(readdirSync(r.runDir), []);
    });
  });
});
