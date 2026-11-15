/**
 * manual-clone-check.ts — OPT-IN real-clone integration harness. NOT production wiring and NOT
 * yet run by this author: every behaviour below is UNVERIFIED until an operator runs it and logs
 * the output in .kiro/PROJECT.md and backend/DEVELOPMENT.md.
 *
 * Skipped unless GRAVEYARD_MANUAL_CLONE=1, so `pnpm test` never touches Docker or the network.
 *
 * Required env when opted in (missing or malformed => fail closed, nothing is created):
 *   GRAVEYARD_CLONE_REPO_URL  canonical https://github.com/<owner>/<repo> of a known PUBLIC fixture
 *   GRAVEYARD_CLONE_COMMIT    exact full lowercase 40-hex SHA of that fixture
 * Optional:
 *   GRAVEYARD_CLONE_IMAGE     git-containing image, default alpine/git:2.47.2. Must already exist
 *                             locally (never pulled) and provide `git` and `sleep`.
 *
 * Topology (random per-run names, label graveyard.manual-clone=<run id>), same shape as
 * manual-egress-check.ts: an --internal network with a fixed /24, an egress-proxy container
 * (node:22-alpine; internal + default bridge for upstream) running the compiled EgressProxy, and
 * the acquisition container created by GitAcquisition on the internal network only.
 *
 * Trust: the guard below lives only in this file. It attests only after this run itself saw the
 * network report Internal, the proxy attached to exactly {bridge, internal}, and the proxy answer
 * 403 to CONNECT example.com:443. That is a narrow probe, not proof of isolation. Production keeps
 * UnavailableEgressGuard, which never attests.
 *
 * Handoff: after GitAcquisition's identity, tree-policy and HEAD checks, the afterCheckout hook
 * runs `docker exec <container> git archive --format=tar <sha>` (argument array, no shell, no
 * bind mount for the acquisition container), collects the bytes with a hard cap, validates the
 * whole tar with extractArchiveIntoFixture (no links, no unsafe paths, bounded; validated with a
 * no-op sink BEFORE any write) and extracts into a fresh backend/.tmp-fixtures/run-<12 hex>/clone
 * directory (exclusive create, lstat audit). The archive commit, file count and byte total must
 * equal the requested SHA and the ls-tree manifest. Anything else fails closed.
 *
 * Runner step (new, UNVERIFIED until an operator runs it): only for the known fixture
 * octocat/Hello-World at 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d (1 file, 13 bytes, no build.mjs),
 * NodeFixtureRunner.verify runs against the extracted ORIGINAL files; nothing is injected. The
 * expected result is build not-run (no-build-script), test not-run, overall not-run, no container
 * created, no leftover container by execution-id label. That is NOT a build or test success. A
 * real passing build/test is demonstrated only by manual-archive-build-check.ts using controlled,
 * locally generated fixtures. Any other repository stops before the runner. The run directory is
 * removed with removeRunDir (exact path only).
 *
 * Images: GRAVEYARD_CLONE_IMAGE=graveyard-git-fixture:local works if that local image has `git`
 * and `sleep`; node:22-alpine must also exist locally. Nothing is pulled.
 *
 * Known limits: `.gitattributes` export-ignore/export-subst in the fixture would change the
 * archive and fail the manifest comparison (fail closed). Paths over 100 bytes need pax/long-name
 * entries, which the extractor rejects. The proxy container bind-mounts a temp directory holding
 * only four compiled files, read-only; the acquisition container has no mounts.
 */

import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_SHA_RE, ACQ_UID_GID, WORK_DIR, checkAcquisitionLimits, validateSource, type EgressAttestation, type EgressGuard } from "../acquisition-policy.js";
import { extractArchiveIntoFixture } from "../archive-handoff.js";
import { GitAcquisition, type HandoffInfo } from "../git-acquisition.js";
import { spawnExecutor } from "../docker-sandbox.js";
import { createRunDir, ensureOwnedParent, removeRunDir } from "../fixture-workspace.js";
import { NODE_FIXTURE_IMAGE, NodeFixtureRunner, type VerificationResult } from "../node-fixture-runner.js";

/** The single known public fixture the build-runner step is allowed to touch. */
const KNOWN_REPO_URL = "https://github.com/octocat/hello-world";
const KNOWN_COMMIT = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";
const KNOWN_FILES = 1;
const KNOWN_BYTES = 13;
const CLONE_FIXTURE = "clone";

const OPT_IN = process.env["GRAVEYARD_MANUAL_CLONE"] === "1";
const PROXY_IMAGE = "node:22-alpine";
const DEFAULT_GIT_IMAGE = "alpine/git:2.47.2";
const LABEL = "graveyard.manual-clone";
const PROXY_PORT = "3128";
const TOTAL_MS = 240_000;
const ENV_ALLOWLIST = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];

class FailClosed extends Error {}

interface Run { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function docker(args: readonly string[], timeoutMs: number): Promise<Run> {
  return new Promise<Run>((done) => {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ENV_ALLOWLIST) { const v = process.env[k]; if (v !== undefined) env[k] = v; }
    let stdout = ""; let stderr = ""; let timedOut = false; let settled = false;
    const child = spawn("docker", [...args], { shell: false, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (code: number | null): void => {
      if (settled) return; settled = true; clearTimeout(timer); done({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); setTimeout(() => finish(null), 500); }, Math.max(1, timeoutMs));
    child.stdout.on("data", (c: Buffer) => { if (stdout.length < 65536) stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { if (stderr.length < 65536) stderr += c.toString("utf8"); });
    child.on("error", (e) => { stderr += `spawn error: ${e.message}`; finish(null); });
    child.on("close", (code) => finish(code));
  });
}

/** Binary-safe `docker <args>` with a hard byte cap. Exceeding the cap kills the client and fails. */
function dockerBytes(bin: string, args: readonly string[], capBytes: number, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolveBytes, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ENV_ALLOWLIST) { const v = process.env[k]; if (v !== undefined) env[k] = v; }
    const chunks: Buffer[] = []; let n = 0; let err = ""; let over = false; let timedOut = false; let settled = false;
    const child = spawn(bin, [...args], { shell: false, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, Math.max(1, timeoutMs));
    const onAbort = (): void => { child.kill("SIGKILL"); };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c: Buffer) => {
      n += c.length;
      if (n > capBytes) { over = true; child.kill("SIGKILL"); return; }
      chunks.push(c);
    });
    child.stderr.on("data", (c: Buffer) => { if (err.length < 2000) err += c.toString("utf8"); });
    const end = (fn: () => void): void => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); fn();
    };
    child.on("error", () => end(() => reject(new Error("could not start docker for export"))));
    child.on("close", (code) => end(() => {
      if (over) reject(new Error("exported archive exceeds the byte cap"));
      else if (timedOut) reject(new Error("export timed out"));
      else if (signal?.aborted === true) reject(new Error("export aborted"));
      else if (code !== 0) reject(new Error(`git archive exited ${String(code)}`));
      else resolveBytes(Buffer.concat(chunks));
    }));
  });
}

const HARDENING: readonly string[] = [
  "--pull", "never", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
  "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
  "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.5", "--pids-limit", "64", "--user", "65532:65532",
  "--log-driver", "json-file", "--log-opt", "max-size=64k", "--log-opt", "max-file=1",
];

const PROXY_SCRIPT = `import { EgressProxy } from "/app/egress-proxy.js";
const proxy = new EgressProxy({ bindHost: process.env.GRAVEYARD_PROXY_BIND, port: ${PROXY_PORT}, onEvent: (e) => console.log(JSON.stringify(e)) });
const a = await proxy.start();
console.log(JSON.stringify({ kind: "listening", host: a.host, port: a.port }));
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { proxy.close().finally(() => process.exit(0)); });
`;

/** Probe run inside the proxy container (which has node): expects "HTTP/1.1 403" for example.com. */
const PROBE_SCRIPT = `const s = require("net").connect(${PROXY_PORT}, process.env.GRAVEYARD_PROXY_BIND);
let d = ""; s.setTimeout(4000, () => { console.log("timeout"); s.destroy(); });
s.on("data", (c) => { d += c; if (d.includes("\\r\\n")) { console.log(d.split("\\r\\n")[0]); s.destroy(); } });
s.on("error", (e) => console.log("error " + e.code));
s.on("connect", () => s.write("CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n"));`;

/** Harness-only guard. Attests only after the harness itself has checked the topology. */
class HarnessGuard implements EgressGuard {
  attestation: EgressAttestation = { verified: false, reason: "harness topology not verified yet" };
  attest(): Promise<EgressAttestation> { return Promise.resolve(this.attestation); }
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

function buildScriptAbsent(dir: string): boolean {
  try {
    lstatSync(join(dir, "build.mjs"));
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}

test(
  "manual real-clone harness (opt-in: GRAVEYARD_MANUAL_CLONE=1)",
  { skip: OPT_IN ? false : "set GRAVEYARD_MANUAL_CLONE=1 (plus repo URL and commit env) to run against real Docker", timeout: TOTAL_MS + 60_000 },
  async () => {
    const repoUrl = process.env["GRAVEYARD_CLONE_REPO_URL"];
    const commit = process.env["GRAVEYARD_CLONE_COMMIT"];
    const image = process.env["GRAVEYARD_CLONE_IMAGE"] ?? DEFAULT_GIT_IMAGE;
    const src = validateSource(repoUrl, commit);
    if (!src.ok || typeof commit !== "string" || !GIT_SHA_RE.test(commit)) {
      throw new FailClosed(`GRAVEYARD_CLONE_REPO_URL / GRAVEYARD_CLONE_COMMIT missing or invalid: ${src.ok ? "bad commit" : src.reason}`);
    }

    const runId = randomBytes(6).toString("hex");
    const names = { net: `graveyard-clone-net-${runId}`, proxy: `graveyard-clone-proxy-${runId}` };
    const attempted = { net: false, proxy: false };
    const octetA = 200 + randomInt(40);
    const octetB = randomInt(256);
    const subnet = `10.${octetA}.${octetB}.0/24`;
    const proxyIp = `10.${octetA}.${octetB}.10`;
    const deadline = Date.now() + TOTAL_MS;
    const labelArgs = ["--label", `${LABEL}=${runId}`];
    const log: string[] = [];
    let tmpApp: string | undefined;
    let parent: string | undefined;
    let runDir: string | undefined;
    const runnerIds = [`clonebuild-${runId}:1`, `clonebuild-${runId}:2`];
    let verification: VerificationResult | undefined;
    const problems: string[] = [];

    const must = async (what: string, args: readonly string[], ms = 20_000): Promise<Run> => {
      const left = deadline - Date.now();
      if (left <= 0) throw new FailClosed("overall timeout reached");
      const r = await docker(args, Math.min(ms, left));
      if (r.code !== 0) throw new FailClosed(`${what} failed: exit=${String(r.code)} ${r.stderr.trim().slice(0, 300)}`);
      return r;
    };

    const owned = async (kind: "container" | "network", name: string): Promise<boolean | "absent"> => {
      const fmt = kind === "container" ? `{{index .Config.Labels "${LABEL}"}}` : `{{index .Labels "${LABEL}"}}`;
      const args = kind === "container" ? ["inspect", "--type", "container", "--format", fmt, name] : ["network", "inspect", "--format", fmt, name];
      const r = await docker(args, 15_000);
      if (r.code !== 0) return new RegExp(`no such (container|network|object): ${name}\\b|network ${name} not found`, "i").test(r.stderr) ? "absent" : false;
      return r.stdout.trim() === runId;
    };
    const cleanup = async (): Promise<string[]> => {
      const problems: string[] = [];
      for (const [kind, name, was] of [["container", names.proxy, attempted.proxy], ["network", names.net, attempted.net]] as const) {
        if (!was) continue;
        const own = await owned(kind, name);
        if (own === "absent") continue;
        if (own !== true) { problems.push(`${kind} ${name}: not removed (label check failed)`); continue; }
        await docker(kind === "container" ? ["rm", "-f", name] : ["network", "rm", name], 30_000);
        if ((await owned(kind, name)) !== "absent") problems.push(`${kind} ${name}: still present after removal`);
      }
      return problems;
    };

    let failure: unknown;
    let acquisitionCleanup: { confirmed: boolean } | null = null;
    try {
      await must("docker daemon check", ["version", "--format", "{{.Server.Version}}"], 15_000);
      for (const img of [PROXY_IMAGE, image, NODE_FIXTURE_IMAGE]) {
        await must(`image ${img} must already exist locally (never pulled)`, ["image", "inspect", "--format", "{{.Id}}", img]);
      }

      const compiledDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      tmpApp = mkdtempSync(join(tmpdir(), "graveyard-clone-app-"));
      for (const f of ["egress-proxy.js", "acquisition-policy.js", "url.js"]) {
        if (!existsSync(join(compiledDir, f))) throw new FailClosed(`compiled ${f} not found; run pnpm run build:test first`);
        copyFileSync(join(compiledDir, f), join(tmpApp, f));
      }
      writeFileSync(join(tmpApp, "package.json"), '{"type":"module"}\n');
      writeFileSync(join(tmpApp, "run.mjs"), PROXY_SCRIPT);
      const appDir = resolve(tmpApp);
      if (/[,"'\r\n]/.test(appDir)) throw new FailClosed("temporary directory path is unusable for a bind mount");

      attempted.net = true;
      await must("create internal network", ["network", "create", "--driver", "bridge", "--internal", "--subnet", subnet, ...labelArgs, names.net]);
      const netInfo = JSON.parse((await must("inspect network", ["network", "inspect", names.net])).stdout) as Array<{ Internal?: boolean }>;
      if (netInfo[0]?.Internal !== true) throw new FailClosed("network is not Internal");

      attempted.proxy = true;
      await must("create proxy container", [
        "create", "--name", names.proxy, "--network", names.net, "--ip", proxyIp, ...HARDENING, ...labelArgs,
        "--mount", `type=bind,source=${appDir},target=/app,readonly`, "--env", `GRAVEYARD_PROXY_BIND=${proxyIp}`,
        PROXY_IMAGE, "node", "/app/run.mjs",
      ]);
      await must("connect proxy to default bridge (upstream)", ["network", "connect", "bridge", names.proxy]);
      const pj = JSON.parse((await must("inspect proxy", ["inspect", "--type", "container", names.proxy])).stdout) as Array<{ NetworkSettings?: { Networks?: Record<string, unknown> } }>;
      const pn = Object.keys(pj[0]?.NetworkSettings?.Networks ?? {}).sort().join();
      if (pn !== ["bridge", names.net].sort().join()) throw new FailClosed(`proxy networks are [${pn}]`);
      await must("start proxy", ["start", names.proxy]);

      let listening = false;
      for (let i = 0; i < 20 && !listening; i += 1) {
        const l = await docker(["logs", "--tail", "20", names.proxy], 10_000);
        listening = (l.stdout + l.stderr).includes('"kind":"listening"');
        if (!listening) await new Promise((r) => setTimeout(r, 500));
      }
      if (!listening) throw new FailClosed("proxy did not report listening");
      const probe = await must("proxy policy probe", ["exec", "--env", `GRAVEYARD_PROXY_BIND=${proxyIp}`, names.proxy, "node", "-e", PROBE_SCRIPT], 15_000);
      if (!/^HTTP\/1\.1 403/.test(probe.stdout.trim())) throw new FailClosed(`proxy did not refuse example.com (got: ${probe.stdout.trim().slice(0, 80)})`);
      log.push("proxy refused CONNECT example.com:443 (403)");

      const guard = new HarnessGuard();
      guard.attestation = {
        verified: true, network: names.net, proxyUrl: `http://${proxyIp}:${PROXY_PORT}`, allowedHosts: ["github.com"],
        evidence: "harness-built internal network; proxy attachments checked; example.com probe refused (narrow probe, not proof)",
      };

      const limits = checkAcquisitionLimits();
      parent = ensureOwnedParent(backendRoot());
      runDir = createRunDir(parent);
      const managedRunDir = runDir;
      log.push(`managed run directory ${managedRunDir}`);
      let handoff: { files: number; bytes: number; commit: string | null; dir: string } | undefined;

      const afterCheckout = async (info: HandoffInfo): Promise<void> => {
        const cap = info.manifest.totalBytes + info.manifest.files * 2048 + 1024 * 1024;
        const tarBytes = await dockerBytes(
          info.dockerBinary,
          ["exec", "--user", ACQ_UID_GID, "--workdir", WORK_DIR, info.containerName, "git", "archive", "--format=tar", info.commit],
          cap, Math.min(info.remainingMs, 60_000), info.signal,
        );
        // extractArchiveIntoFixture validates the whole tar plus commit/file/byte expectations with a
        // no-op sink BEFORE creating the target directory, then audits the written tree with lstat.
        const h = extractArchiveIntoFixture(
          tarBytes, managedRunDir, CLONE_FIXTURE,
          { maxArchiveBytes: cap, maxFiles: limits.maxFiles, maxTotalBytes: limits.maxTotalBytes },
          { commit: info.commit, files: info.manifest.files, totalBytes: info.manifest.totalBytes },
        );
        if (!h.ok) throw new Error(`handoff refused: ${h.reason}`);
        handoff = { files: h.summary.files, bytes: h.summary.totalBytes, commit: h.summary.archiveCommit, dir: h.dir };
      };

      const acq = new GitAcquisition({ executor: spawnExecutor, egress: guard, allowedImages: [image], limits, afterCheckout });
      const result = await acq.acquire({ executionId: `manual-${runId}:1`, repoUrl: src.value.repoUrl, commit: src.value.commit, image });
      acquisitionCleanup = result.cleanup;
      log.push(`acquisition outcome: ${result.kind}`);
      if (result.kind !== "acquired") {
        const detail = "reason" in result ? result.reason : "step" in result ? result.step : "";
        throw new FailClosed(`acquisition did not succeed: ${result.kind} ${detail}`);
      }
      if (result.cleanup?.confirmed !== true) throw new Error("acquisition container cleanup not confirmed");
      if (handoff === undefined) throw new Error("handoff hook did not complete");
      log.push(`source identity verified: ${result.commit}`);
      log.push(`tree policy passed: ${result.manifest.files} files, ${result.manifest.totalBytes} bytes`);
      log.push(`handoff extracted and audited: ${handoff.files} files, ${handoff.bytes} bytes`);

      // Build-runner step: ONLY for the single known fixture, and only if the extracted tree is
      // exactly what was measured before (1 file, 13 bytes) and has no build.mjs. The original
      // files are used as-is; no script is injected. Any other repository stops here.
      const isKnown = src.value.repoUrl.toLowerCase() === KNOWN_REPO_URL && src.value.commit === KNOWN_COMMIT;
      if (!isKnown) {
        log.push("runner step skipped: not the known octocat/Hello-World fixture (no runner is ever pointed at other repositories)");
      } else {
        if (handoff.files !== KNOWN_FILES || handoff.bytes !== KNOWN_BYTES) {
          throw new FailClosed(`known fixture shape changed (${handoff.files} files, ${handoff.bytes} bytes); runner not started`);
        }
        if (!buildScriptAbsent(handoff.dir)) throw new FailClosed("build.mjs is present in the clone; runner not started");
        const runner = new NodeFixtureRunner({ executor: spawnExecutor, fixturesRoot: managedRunDir });
        verification = await runner.verify({ idPrefix: `clonebuild-${runId}`, fixture: CLONE_FIXTURE });
        const v = verification;
        log.push(
          `runner: overall=${v.status}; build=${v.build.status} (${v.build.reason}); test=${v.test.status} (${v.test.reason})`,
          `runner cleanup proofs: build=${v.build.cleanup === null ? "none (no container created)" : String(v.build.cleanup.confirmed)}, test=${v.test.cleanup === null ? "none (no container created)" : String(v.test.cleanup.confirmed)}`,
        );
        // Expected for Hello-World: it has no build script, so nothing may report passed.
        if (v.status !== "not-run") problems.push(`runner overall ${v.status}, expected not-run`);
        if (v.build.status !== "not-run" || v.build.reason !== "no-build-script") problems.push(`build ${v.build.status}/${v.build.reason}, expected not-run/no-build-script`);
        if (v.test.status !== "not-run") problems.push(`test ${v.test.status}, expected not-run`);
        if (v.build.cleanup !== null || v.test.cleanup !== null) problems.push("a container was unexpectedly created for the no-build-script fixture");
        for (const id of runnerIds) {
          const left = await docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=graveyard.execution-id=${id}`], 20_000);
          if (left.code !== 0) problems.push(`could not query leftover containers for ${id}`);
          else if (left.stdout.trim() !== "") problems.push(`container left for ${id}: ${left.stdout.trim()}`);
        }
      }
    } catch (e) {
      failure = e;
    } finally {
      for (const d of [tmpApp]) {
        if (d === undefined) continue;
        try { rmSync(d, { recursive: true, force: true }); } catch (e) { problems.push(`${d}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (runDir !== undefined && parent !== undefined) {
        const rr = removeRunDir(parent, runDir);
        if (rr.removed) log.push(`removed managed run directory ${runDir}`);
        else problems.push(...rr.problems.map((p) => `removal: ${p}`));
      }
      try { problems.push(...(await cleanup())); } catch (e) { problems.push(`cleanup threw: ${e instanceof Error ? e.message : String(e)}`); }
      for (const l of log) console.log(`INFO  ${l}`);
      console.log(`acquisition container cleanup confirmed: ${String(acquisitionCleanup?.confirmed ?? "n/a")}`);
      console.log("NOTE  the GitHub fixture has no build script: its build and test are not-run, never passed. A real build/test pass is shown only by manual-archive-build-check.ts with controlled generated fixtures.");
      if (problems.length > 0) {
        console.log(`CLEANUP/RUNNER PROBLEMS (remove manually, run id ${runId}):\n${problems.join("\n")}`);
        failure ??= new Error("cleanup not confirmed or runner expectations not met");
      }
      if (failure instanceof FailClosed) console.log(`FAIL-CLOSED: ${failure.message}\nNo claim is made about isolation, proxy behaviour or source handoff.`);
    }
    if (failure !== undefined) throw failure;
  },
);
