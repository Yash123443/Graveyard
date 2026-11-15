/**
 * manual-registry-acquisition-check.ts — OPT-IN real Docker harness for the controlled npm registry
 * acquisition of the FIXED fixture is-number@7.0.0, followed by the existing network-none offline
 * install, build and test with the handed-over cache. NOT production wiring and NOT yet run by its
 * author: every behaviour below is UNVERIFIED until an operator runs it and logs the output in
 * .kiro/PROJECT.md and backend/DEVELOPMENT.md.
 *
 * Skipped unless GRAVEYARD_MANUAL_REGISTRY_ACQUISITION=1, so `pnpm test` never touches Docker or
 * the network. Needs only the local image node:22-alpine (nothing is pulled; run `pnpm run
 * build:test` first). No operator-supplied files: the fixture is the constant in
 * npm-registry-acquisition.ts. No untrusted repository, no credential, no host environment value
 * and no Docker socket reaches any container.
 *
 * Topology (all names and the label `graveyard.manual-registry` carry a random per-run id):
 *   - an `--internal` Docker network with an explicit random 10.x /24 subnet
 *   - proxy container (node:22-alpine): internal network at a fixed IP, plus the default bridge for
 *     its upstream. Runs the compiled EgressProxy with `target: "registry.npmjs.org"`
 *   - probe client container (node:22-alpine): internal network only
 *   - the acquisition container is created by NpmRegistryAcquisition itself on the internal network
 *     only (never on the bridge), and the offline pipeline container has network none.
 *
 * Steps. Every precondition failure fails closed and issues NO attestation:
 *   0. default guard check: with UnavailableEgressGuard, acquire() refuses and creates nothing;
 *   1. probes from the client container: it reaches the proxy; direct TCP/443 to two public IPs
 *      fails; CONNECT answers 403 for example.com, github.com, the metadata IP, a private IP and
 *      registry.npmjs.org:80; CONNECT registry.npmjs.org:443 answers 200;
 *   2. ONLY when every probe passed, this harness's own guard attests the run (network, proxy URL,
 *      exactly registry.npmjs.org, evidence = the probe list). That attestation is the harness's
 *      claim for this one run and is not stored or reused. Production has no such guard;
 *   3. acquire(): npm ci through the proxy in an isolated container, cleanup proof, verified cache
 *      handoff written by the host;
 *   4. the offline pipeline (ControlledPipeline, network none) mounts that cache read-only and
 *      runs `npm ci --offline`, build and test. Expected overall: success;
 *   5. an independent `docker ps -a` shows no container of this run; own resources are removed
 *      only after their label equals the run id.
 *
 * A pass shows only that these steps behaved as listed on this machine with this Docker and image
 * for this fixture. It does not show the network is safe on any other host, that `--internal`
 * blocks every escape path, or anything about other packages or repositories. Likely first-run
 * failure points (all fail closed): the integrity constant in npm-registry-acquisition.ts was
 * written from memory and must equal `npm view is-number@7.0.0 dist.integrity`; npm's proxy
 * CONNECT may send a Host header the strict proxy rejects; npm's cache layout may differ from the
 * layout assumed by npm-registry-cache.ts.
 *
 * Run (outside the restricted sandbox):
 *   pnpm run build:test
 *   $env:GRAVEYARD_MANUAL_REGISTRY_ACQUISITION = "1"
 *   node --test dist-test/test/manual-registry-acquisition-check.js
 *
 * OPERATOR FIXTURE MODE (added later by Kiro, NOT compiled or run). Additionally set
 *   $env:GRAVEYARD_MANUAL_REGISTRY_FIXTURE_DIR = "C:\absolute\path\to\fixture"
 * to a real directory holding exactly the operator's `package.json` and `package-lock.json`
 * (lockfileVersion 3, at most 8 flat unscoped production packages from registry.npmjs.org with real
 * sha512 integrity values; see npm-operator-fixture.ts). The files are read with lstat (no symlink,
 * regular file, at most 64 KiB), checked with checkOperatorFixture BEFORE Docker is contacted (a
 * rejected fixture fails closed and nothing is created), then used instead of the fixed constants for
 * the same steps: a policy-violating copy must be `rejected` with no container, and `npm ci` must
 * report exactly the lockfile's package count. Kiro cannot supply a real multi-package lockfile: it
 * has no registry access and would have to invent integrity values. Without the variable the fixed
 * is-number@7.0.0 behaviour above is unchanged.
 */

import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UnavailableEgressGuard, type EgressAttestation, type EgressGuard } from "../acquisition-policy.js";
import { ControlledPipeline } from "../controlled-pipeline.js";
import { pipelineFixtureScripts } from "../controlled-pipeline-fixtures.js";
import { spawnExecutor } from "../docker-sandbox.js";
import { createRunDir, ensureOwnedParent, removeRunDir, writeFixture } from "../fixture-workspace.js";
import { NODE_FIXTURE_IMAGE } from "../node-fixture-runner.js";
import {
  FIXED_FIXTURE_ID,
  FIXED_LOCKFILE,
  FIXED_PACKAGE,
  FIXED_PACKAGE_JSON,
  NpmRegistryAcquisition,
  OPERATOR_FIXTURE_ID,
  type RegistryAcquisitionResult,
} from "../npm-registry-acquisition.js";
import { MAX_OPERATOR_LOCK_BYTES, checkOperatorFixture } from "../npm-operator-fixture.js";
import { runRegistryThenOffline } from "../registry-pipeline.js";

const OPT_IN = process.env["GRAVEYARD_MANUAL_REGISTRY_ACQUISITION"] === "1";
const FIXTURE_DIR = process.env["GRAVEYARD_MANUAL_REGISTRY_FIXTURE_DIR"] ?? "";
const IMAGE = NODE_FIXTURE_IMAGE;
const LABEL = "graveyard.manual-registry";
const PROXY_PORT = "3128";
const PROBE_BUDGET_MS = 120_000;
const OUTPUT_CAP = 64 * 1024;
const ENV_ALLOWLIST = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];

class FailClosed extends Error {}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface RunOptions {
  timeoutMs: number;
  input?: string;
  stopWhen?: (stdout: string) => boolean;
}

/** Runs `docker <args>` with no shell, a minimal environment, bounded output and a hard timeout. */
function docker(args: readonly string[], opts: RunOptions): Promise<Run> {
  return new Promise<Run>((resolveRun) => {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ENV_ALLOWLIST) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn("docker", [...args], { shell: false, windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      setTimeout(() => finish(null), 500);
    }, Math.max(1, opts.timeoutMs));
    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += c.toString("utf8");
      if (opts.stopWhen?.(stdout) === true) child.kill();
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += c.toString("utf8");
    });
    child.on("error", (e) => {
      stderr += `spawn error: ${e.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => undefined);
    if (opts.input !== undefined) child.stdin.write(opts.input);
    else child.stdin.end();
  });
}

const brief = (r: Run): string => `exit=${String(r.code)}${r.timedOut ? " (timed out)" : ""} ${r.stderr.trim().slice(0, 300)}`.trim();

function safeMountPath(p: string, what: string): string {
  const abs = resolve(p);
  if (!isAbsolute(abs) || /[,"'\r\n]/.test(abs)) {
    throw new FailClosed(`${what} path is unusable for a bind mount (must be absolute, no comma, quote or newline): ${abs}`);
  }
  return abs;
}

interface HarnessFixture {
  operator: boolean;
  packageJson: string;
  packageLock: string;
  /** What `npm ci` must report as added. */
  expectedAdded: number;
  label: string;
}

/** Reads and policy-checks the operator's two files. Fails closed before Docker is contacted. */
function loadOperatorFixture(dir: string): HarnessFixture {
  if (!isAbsolute(dir) || /[\0\r\n]/.test(dir)) throw new FailClosed("GRAVEYARD_MANUAL_REGISTRY_FIXTURE_DIR must be an absolute path");
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("not a real directory");
  } catch {
    throw new FailClosed(`fixture directory ${dir} is not an existing real directory`);
  }
  const texts: string[] = [];
  for (const name of ["package.json", "package-lock.json"]) {
    const p = join(dir, name);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_OPERATOR_LOCK_BYTES) throw new Error("bad file");
      texts.push(readFileSync(p, "utf8"));
    } catch {
      throw new FailClosed(`${name} in ${dir} is missing, is not a plain file or is larger than ${MAX_OPERATOR_LOCK_BYTES} bytes`);
    }
  }
  const r = checkOperatorFixture(texts[0], texts[1]);
  if (!r.ok) throw new FailClosed(`operator fixture rejected by policy (nothing was contacted): ${r.violations.slice(0, 5).join("; ")}`);
  return {
    operator: true,
    packageJson: r.packageJson,
    packageLock: r.lock,
    expectedAdded: r.packageCount,
    label: `operator fixture ${r.packages.map((p) => `${p.name}@${p.version}`).join(",")} (package.json sha256 ${r.packageJsonSha256.slice(0, 12)}, lock sha256 ${r.lockSha256.slice(0, 12)})`,
  };
}

function backendRoot(): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown }).name;
  } catch {
    throw new FailClosed(`cannot read package.json at the expected backend root ${root}`);
  }
  if (name !== "graveyard-backend") throw new FailClosed(`${root} is not the graveyard-backend package`);
  return realpathSync(root);
}

async function dockerQuery(args: readonly string[]): Promise<{ ok: boolean; stdout: string }> {
  const r = await docker(args, { timeoutMs: 20_000 });
  return { ok: r.code === 0 && !r.timedOut, stdout: r.stdout };
}

const HARDENING: readonly string[] = [
  "--pull", "never",
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges",
  "--read-only",
  "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
  "--memory", "128m",
  "--memory-swap", "128m",
  "--cpus", "0.5",
  "--pids-limit", "64",
  "--user", "65532:65532",
  "--log-driver", "json-file",
  "--log-opt", "max-size=64k",
  "--log-opt", "max-file=1",
];

const PROXY_SCRIPT = `import { EgressProxy } from "/app/egress-proxy.js";
const proxy = new EgressProxy({
  bindHost: process.env.GRAVEYARD_PROXY_BIND,
  port: ${PROXY_PORT},
  target: "registry.npmjs.org",
  onEvent: (e) => console.log(JSON.stringify(e)),
});
const a = await proxy.start();
console.log(JSON.stringify({ kind: "listening", host: a.host, port: a.port }));
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { proxy.close().finally(() => process.exit(0)); });
`;

function describeResult(r: RegistryAcquisitionResult): string {
  const cl = r.cleanup === null ? "none" : r.cleanup.confirmed ? "confirmed" : `UNCONFIRMED(${r.cleanup.reason})`;
  const extra = r.kind === "acquired"
    ? ` added=${r.packagesAdded} files=${r.summary.files} bytes=${r.summary.totalBytes}`
    : "reason" in r ? ` reason=${r.reason}` : "";
  const diag = r.kind === "install-failed" ? ` phase=${r.phase}/${r.reason} diag=${r.diagnostic.slice(-300)}` : "";
  return `${r.kind}${extra}${diag} cleanup=${cl} stagingRemoved=${String(r.stagingRemoved)}`;
}

test(
  "manual registry acquisition harness (opt-in: GRAVEYARD_MANUAL_REGISTRY_ACQUISITION=1)",
  { skip: OPT_IN ? false : "set GRAVEYARD_MANUAL_REGISTRY_ACQUISITION=1 to run against real Docker", timeout: 900_000 },
  async () => {
    const runId = randomBytes(5).toString("hex");
    const base = "gyreg";
    const names = { net: `${base}-net-${runId}`, proxy: `${base}-proxy-${runId}`, client: `${base}-client-${runId}` };
    const attempted = { net: false, proxy: false, client: false };
    const octetA = 200 + randomInt(40);
    const octetB = randomInt(256);
    const subnet = `10.${octetA}.${octetB}.0/24`;
    const proxyIp = `10.${octetA}.${octetB}.10`; // .1 is the Docker gateway
    const proxyUrl = `http://${proxyIp}:${PROXY_PORT}`;
    const deadline = Date.now() + PROBE_BUDGET_MS;
    const labelArgs = ["--label", `${LABEL}=${runId}`];
    const log: string[] = [];
    const probes: Array<{ name: string; ok: boolean; detail: string }> = [];
    const problems: string[] = [];
    let tmpDir: string | undefined;
    let parent: string | undefined;
    const runDirs: string[] = [];
    let failure: unknown;

    const d = (args: readonly string[], o: Omit<RunOptions, "timeoutMs"> & { timeoutMs?: number } = {}): Promise<Run> => {
      const left = deadline - Date.now();
      if (left <= 0) throw new FailClosed("probe time budget exhausted before the checks finished");
      return docker(args, { ...o, timeoutMs: Math.min(o.timeoutMs ?? 20_000, left) });
    };
    const must = async (what: string, args: readonly string[], o?: Omit<RunOptions, "timeoutMs"> & { timeoutMs?: number }): Promise<Run> => {
      const r = await d(args, o);
      if (r.code !== 0) throw new FailClosed(`${what} failed: ${brief(r)}`);
      return r;
    };
    const record = (name: string, ok: boolean, detail: string): void => {
      probes.push({ name, ok, detail });
    };

    /** Removes only resources this run attempted to create and whose label equals the run id. */
    const cleanupTopology = async (): Promise<string[]> => {
      const out: string[] = [];
      const owned = async (kind: "container" | "network", name: string): Promise<boolean | "absent"> => {
        const fmt = kind === "container" ? `{{index .Config.Labels "${LABEL}"}}` : `{{index .Labels "${LABEL}"}}`;
        const args = kind === "container" ? ["inspect", "--type", "container", "--format", fmt, name] : ["network", "inspect", "--format", fmt, name];
        const r = await docker(args, { timeoutMs: 15_000 });
        if (r.code !== 0) {
          const notFound = new RegExp(`no such (container|network|object): ${name}\\b|network ${name} not found`, "i");
          return notFound.test(r.stderr) ? "absent" : false;
        }
        return r.stdout.trim() === runId;
      };
      const steps: Array<["container" | "network", string, boolean]> = [
        ["container", names.client, attempted.client],
        ["container", names.proxy, attempted.proxy],
        ["network", names.net, attempted.net],
      ];
      for (const [kind, name, was] of steps) {
        if (!was) continue;
        const own = await owned(kind, name);
        if (own === "absent") continue;
        if (own !== true) {
          out.push(`${kind} ${name}: not removed (label check failed or inspect error)`);
          continue;
        }
        const rm = kind === "container" ? ["rm", "-f", name] : ["network", "rm", name];
        const r = await docker(rm, { timeoutMs: 30_000 });
        if (r.code !== 0) out.push(`${kind} ${name}: remove failed: ${brief(r)}`);
        if ((await owned(kind, name)) !== "absent") out.push(`${kind} ${name}: still present after removal`);
      }
      return out;
    };
    const onSigint = (): void => {
      void cleanupTopology().finally(() => process.exit(130));
    };
    process.once("SIGINT", onSigint);

    try {
      // Fixture selection happens first so a rejected operator fixture never reaches Docker.
      const fixture: HarnessFixture = FIXTURE_DIR === ""
        ? { operator: false, packageJson: FIXED_PACKAGE_JSON, packageLock: FIXED_LOCKFILE, expectedAdded: 1, label: `fixed ${FIXED_PACKAGE.name}@${FIXED_PACKAGE.version}` }
        : loadOperatorFixture(FIXTURE_DIR);
      log.push(`fixture: ${fixture.label}`);
      const fixtureId = fixture.operator ? OPERATOR_FIXTURE_ID : FIXED_FIXTURE_ID;
      const operatorInput = fixture.operator ? { operatorFixture: { packageJson: fixture.packageJson, packageLock: fixture.packageLock } } : {};

      // Preconditions (fail closed).
      const v = await dockerQuery(["version", "--format", "{{.Server.Version}}"]);
      if (!v.ok || v.stdout.trim() === "") throw new FailClosed("docker daemon is not available");
      log.push(`docker server ${v.stdout.trim()}`);
      const img = await dockerQuery(["image", "inspect", "--format", "{{.Id}}", IMAGE]);
      if (!img.ok) throw new FailClosed(`image ${IMAGE} must already exist locally (this harness never pulls)`);

      parent = ensureOwnedParent(backendRoot());
      const stagingDir = createRunDir(parent);
      const fixturesDir = createRunDir(parent);
      const pipeStagingDir = createRunDir(parent);
      const handoffRun = createRunDir(parent);
      runDirs.push(stagingDir, fixturesDir, pipeStagingDir, handoffRun);

      // 0. The default guard never attests: nothing may be created.
      {
        const refusing = new NpmRegistryAcquisition({ executor: spawnExecutor, egress: new UnavailableEgressGuard(), stagingRoot: stagingDir });
        const r = await refusing.acquire({ executionId: `regacq-${runId}-0:1`, fixture: fixtureId, image: IMAGE, runDir: handoffRun, ...operatorInput });
        log.push(`[0:default-guard] ${describeResult(r)}`);
        if (r.kind !== "network-unavailable") problems.push(`[0] default guard: expected network-unavailable, got ${r.kind}`);
        if (r.cleanup !== null) problems.push("[0] default guard: a container was involved");

        if (fixture.operator) {
          // A policy-violating copy (resolved points at another host) must be rejected before anything is contacted.
          const doc = JSON.parse(fixture.packageLock) as { packages: Record<string, { resolved?: string }> };
          const firstKey = Object.keys(doc.packages).find((k) => k !== "");
          const entry = firstKey === undefined ? undefined : doc.packages[firstKey];
          if (entry === undefined) {
            problems.push("[0b] operator fixture has no package entry to mutate");
          } else {
            entry.resolved = "https://evil.example/x/-/x-1.0.0.tgz";
            const hostile = await refusing.acquire({
              executionId: `regacq-${runId}-0b:1`, fixture: OPERATOR_FIXTURE_ID, image: IMAGE, runDir: handoffRun,
              operatorFixture: { packageJson: fixture.packageJson, packageLock: JSON.stringify(doc, null, 2) },
            });
            log.push(`[0b:hostile-copy] ${describeResult(hostile)}`);
            if (hostile.kind !== "rejected") problems.push(`[0b] hostile copy: expected rejected, got ${hostile.kind}`);
            if (hostile.cleanup !== null) problems.push("[0b] hostile copy: a container was involved");
          }
        }
      }

      // Topology.
      const here = dirname(fileURLToPath(import.meta.url));
      const compiledDir = resolve(here, "..");
      tmpDir = mkdtempSync(join(tmpdir(), "graveyard-registry-"));
      for (const f of ["egress-proxy.js", "acquisition-policy.js", "url.js"]) {
        const src = join(compiledDir, f);
        if (!existsSync(src)) throw new FailClosed(`compiled ${f} not found in ${compiledDir}; run pnpm run build:test first`);
        copyFileSync(src, join(tmpDir, f));
      }
      writeFileSync(join(tmpDir, "package.json"), '{"type":"module"}\n');
      writeFileSync(join(tmpDir, "run.mjs"), PROXY_SCRIPT);
      const appDir = safeMountPath(tmpDir, "temporary app directory");

      attempted.net = true;
      await must("create internal network", ["network", "create", "--driver", "bridge", "--internal", "--subnet", subnet, ...labelArgs, names.net]);
      const netInfo = JSON.parse((await must("inspect network", ["network", "inspect", names.net])).stdout) as Array<{ Internal?: boolean }>;
      if (netInfo[0]?.Internal !== true) throw new FailClosed(`network ${names.net} is not Internal; refusing to continue (platform: ${process.platform})`);

      attempted.proxy = true;
      await must("create proxy container", [
        "create", "--name", names.proxy, "--network", names.net, "--ip", proxyIp, ...HARDENING, ...labelArgs,
        "--mount", `type=bind,source=${appDir},target=/app,readonly`,
        "--env", `GRAVEYARD_PROXY_BIND=${proxyIp}`,
        IMAGE, "node", "/app/run.mjs",
      ]);
      await must("connect proxy to default bridge (upstream)", ["network", "connect", "bridge", names.proxy]);
      attempted.client = true;
      await must("create probe client", ["create", "--name", names.client, "--network", names.net, ...HARDENING, ...labelArgs, IMAGE, "sleep", "300"]);

      const attach = async (name: string): Promise<string[]> => {
        const j = JSON.parse((await must("inspect container", ["inspect", "--type", "container", name])).stdout) as Array<{
          NetworkSettings?: { Networks?: Record<string, unknown> };
        }>;
        return Object.keys(j[0]?.NetworkSettings?.Networks ?? {}).sort();
      };
      const clientNets = await attach(names.client);
      const proxyNets = await attach(names.proxy);
      if (clientNets.join() !== names.net) throw new FailClosed(`client networks are [${clientNets.join(", ")}], expected only ${names.net}`);
      if (proxyNets.join() !== ["bridge", names.net].sort().join()) throw new FailClosed(`proxy networks are [${proxyNets.join(", ")}], expected bridge + ${names.net}`);

      await must("start probe client", ["start", names.client]);
      await must("start proxy", ["start", names.proxy]);

      let ready = false;
      for (let i = 0; i < 20 && !ready; i += 1) {
        const st = await d(["inspect", "--format", "{{.State.Running}}", names.proxy], { timeoutMs: 10_000 });
        if (st.stdout.trim() !== "true") {
          const logs = await d(["logs", "--tail", "20", names.proxy], { timeoutMs: 10_000 });
          throw new FailClosed(`proxy container is not running. logs: ${(logs.stdout + logs.stderr).trim().slice(0, 600)}`);
        }
        ready = (await d(["exec", names.client, "nc", "-z", "-w", "2", proxyIp, PROXY_PORT], { timeoutMs: 10_000 })).code === 0;
        if (!ready) await new Promise((r) => setTimeout(r, 500));
      }
      if (!ready) throw new FailClosed("client could not reach the proxy on the internal network; no checks are meaningful");
      record("positive control: client reaches proxy", true, `${proxyIp}:${PROXY_PORT}`);

      // 1. Probes.
      for (const ip of ["1.1.1.1", "8.8.8.8"]) {
        const r = await d(["exec", names.client, "nc", "-z", "-w", "3", ip, "443"], { timeoutMs: 10_000 });
        record(`client cannot reach ${ip}:443 directly`, r.code !== 0 && r.code !== null, r.code === 0 ? "CONNECTED (unexpected)" : brief(r));
      }
      const connect = async (authority: string, wantStatus: number): Promise<void> => {
        const input = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`;
        const r = await d(["exec", "-i", names.client, "nc", "-w", "4", proxyIp, PROXY_PORT], {
          timeoutMs: 15_000, input, stopWhen: (o) => o.includes("\r\n"),
        });
        const m = /^HTTP\/1\.1 (\d{3}) /.exec(r.stdout);
        const status = m === null ? null : Number(m[1]);
        record(`CONNECT ${authority} -> ${wantStatus}`, status === wantStatus, `got ${status === null ? `no HTTP status (${brief(r)})` : String(status)}`);
      };
      await connect("example.com:443", 403);
      await connect("github.com:443", 403);
      await connect("169.254.169.254:80", 403);
      await connect("10.0.0.1:443", 403);
      await connect("registry.npmjs.org:80", 403);
      await connect("registry.npmjs.org:443", 200);
      for (const p of probes) log.push(`${p.ok ? "PASS" : "FAIL"}  ${p.name}  [${p.detail}]`);
      const failedProbes = probes.filter((p) => !p.ok);
      if (failedProbes.length > 0) {
        throw new FailClosed(`${failedProbes.length} probe(s) failed (${failedProbes.map((p) => p.name).join("; ")}); no attestation is issued`);
      }

      // 2. The harness's own guard, issued only now and only for this run.
      const evidence = `harness run ${runId}: internal network ${names.net} verified Internal, ${probes.length} probes passed (${probes.map((p) => p.name).join("; ")})`;
      const guard: EgressGuard = {
        attest: (): Promise<EgressAttestation> =>
          Promise.resolve({ verified: true, network: names.net, proxyUrl, allowedHosts: ["registry.npmjs.org"], evidence }),
      };

      // 3. Acquisition.
      const acquisition = new NpmRegistryAcquisition({ executor: spawnExecutor, egress: guard, stagingRoot: stagingDir });
      const acqId = `regacq-${runId}-1:1`;
      const pipeId = `regpipe-${runId}-1:1`;
      writeFixture(fixturesDir, "pass", { "package.json": fixture.packageJson, "package-lock.json": fixture.packageLock, ...pipelineFixtureScripts("pass") });

      // 4. Offline stage with the handed-over cache.
      const overall = await runRegistryThenOffline(
        {
          acquire: (req) => acquisition.acquire(req),
          makePipeline: (cacheDir) =>
            new ControlledPipeline({ executor: spawnExecutor, fixturesRoot: fixturesDir, stagingRoot: pipeStagingDir, cacheDir }),
        },
        {
          acquisition: { executionId: acqId, fixture: fixtureId, image: IMAGE, runDir: handoffRun, ...operatorInput },
          pipeline: { executionId: pipeId, fixture: "pass" },
        },
      );
      const a = overall.acquisition;
      log.push(`[1:acquisition] ${describeResult(a)}`);
      if (a.kind === "install-failed") log.push(`[1:acquisition] driver detail: ${a.detail}`);
      if (a.kind === "acquired") log.push(`[1:acquisition] handoff cache: ${a.summary.files} file(s), ${a.summary.totalBytes} bytes, tarballs ${a.summary.tarballs.map((t) => `${t.name}@${t.version}`).join(",")}`);
      if (a.kind !== "acquired") problems.push(`acquisition: expected acquired, got ${a.kind}`);
      if (a.cleanup === null || !a.cleanup.confirmed) problems.push("acquisition: container cleanup not confirmed");
      if (a.stagingRemoved !== true) problems.push("acquisition: staging directory not removed");
      if (a.kind === "acquired" && a.packagesAdded !== fixture.expectedAdded) problems.push(`acquisition: npm did not report exactly ${fixture.expectedAdded} added package(s)`);

      const p = overall.pipeline;
      if (p === null) {
        log.push("[2:offline pipeline] not started");
      } else {
        const stages = p.stages === null ? "no-report" : p.stages.map((s) => `${s.stage}:${s.status}`).join(",");
        log.push(`[2:offline pipeline] ${p.status} (${p.reason}) added=${String(p.packagesAdded)}/${String(p.expectedPackages)} stages=[${stages}] stagingRemoved=${String(p.stagingRemoved)}`);
        for (const s of p.stages ?? []) {
          if (s.status === "failed" && s.stderrTail) log.push(`[2:offline pipeline] ${s.stage} stderr tail: ${s.stderrTail.slice(-300)}`);
        }
        if (p.cleanup === null || !p.cleanup.confirmed) problems.push("offline pipeline: container cleanup not confirmed");
        if (p.stagingRemoved !== true) problems.push("offline pipeline: staging directory not removed");
      }
      log.push(`[overall] ${overall.status} decidedBy=${overall.decidedBy}: ${overall.detail}`);
      if (overall.status !== "success") problems.push(`overall: expected success, got ${overall.status}`);

      // Proxy events show what npm actually asked for.
      const logs = await d(["logs", "--tail", "40", names.proxy], { timeoutMs: 10_000 });
      log.push(`proxy events (sanitized, from container logs):\n${logs.stdout.trim().slice(0, 4000)}`);

      // 5. Independent leftover checks.
      for (const prefix of [`graveyard-npmacq-regacq-${runId}`, `graveyard-regpipe-${runId}`]) {
        const left = await dockerQuery(["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=${prefix}`]);
        if (!left.ok) problems.push(`could not query leftover containers for ${prefix}`);
        else if (left.stdout.trim() !== "") problems.push(`containers left from this run (${prefix}): ${left.stdout.trim()}`);
        else log.push(`independent docker ps: no container named ${prefix}*`);
      }
      if (readdirSync(stagingDir).length !== 0) problems.push("acquisition staging directory is not empty after the run");
      if (readdirSync(pipeStagingDir).length !== 0) problems.push("pipeline staging directory is not empty after the run");
    } catch (e) {
      failure = e;
    } finally {
      process.off("SIGINT", onSigint);
      if (tmpDir !== undefined) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) {
          problems.push(`temporary directory ${tmpDir}: remove failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      try {
        problems.push(...(await cleanupTopology()));
      } catch (e) {
        problems.push(`topology cleanup threw: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (parent !== undefined) {
        for (const dir of runDirs) {
          if (!existsSync(dir) || !lstatSync(dir).isDirectory()) continue;
          const r = removeRunDir(parent, dir);
          if (r.removed) log.push(`removed ${dir}`);
          else problems.push(...r.problems.map((x) => `removal: ${x}`));
        }
      }
      for (const l of log) console.log(`INFO  ${l}`);
      if (problems.length > 0) console.log(`PROBLEMS (remove leftovers manually, run id ${runId}):\n${problems.join("\n")}`);
      if (failure instanceof FailClosed) {
        console.log(`FAIL-CLOSED: ${failure.message}\nNo claim is made about isolation, the proxy, npm or the cache. Platform: ${process.platform}.`);
      }
    }
    if (failure !== undefined) throw failure;
    if (problems.length > 0) throw new Error(`registry acquisition harness found ${problems.length} problem(s)`);
  },
);
