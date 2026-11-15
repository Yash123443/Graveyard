/**
 * manual-worker-e2e-check.ts — OPT-IN end-to-end harness: real API over real localhost HTTP, the real
 * worker composition (startWorker -> composeWorker -> ControlledPipeline -> DockerFixtureSandbox)
 * and REAL Docker, for one controlled fixture. It is not a mock: if Docker, the image, the driver or
 * the operator inputs are unavailable it FAILS CLOSED with a clear message and makes no claim.
 *
 * Status: written without being compiled or run. A pass is evidence only once an operator has run it
 * and recorded the output (see backend/DEVELOPMENT.md).
 *
 * Skipped unless GRAVEYARD_MANUAL_WORKER_E2E=1, so `pnpm test` (which globs dist-test/test/*.js)
 * reports it as skipped and never touches Docker. The single explicit command is:
 *
 *   pnpm run test:worker-e2e
 *
 * Operator-supplied inputs (never invented; same inputs as manual-controlled-pipeline-check.ts):
 *   GRAVEYARD_NPM_FIXTURE_DIR  absolute directory with package.json + package-lock.json for the single
 *                              dependency is-number@7.0.0 (registry lockfile, passes npm-lock-policy).
 *   GRAVEYARD_NPM_CACHE_DIR    absolute npm cache prepopulated for exactly that lockfile. Mounted
 *                              read-only by the sandbox; never written. Must not be under backend/.tmp-fixtures.
 * Also required locally: a running Docker daemon and the image node:22-alpine (never pulled).
 *
 * What it does:
 *   1. Generates temporary directories under backend/.tmp-fixtures (gitignored): a database + catalog
 *      directory, a fixtures root (one `pass` fixture: operator package files + trusted generated
 *      build.mjs/test.mjs from controlled-pipeline-fixtures.ts), and a staging root.
 *      The real data/ database and any existing user data are never opened.
 *   2. Starts the real API (buildApp) on 127.0.0.1 with an ephemeral port, on the temporary database.
 *   3. Starts the real worker through startWorker with an explicit environment object (not process.env):
 *      catalog = one controlled URL -> `pass` fixture, agents `off`. No test seam is injected, so the
 *      real spawnExecutor, ControlledPipeline and Docker cleanup proof are used.
 *   4. POST /api/jobs with consent, then checks authorization (no token -> 401, other token -> 403),
 *      then polls GET /api/jobs/:id/result with the owner token until terminal or a bounded deadline.
 *   5. Expects status completed, outcome passing, verdict verified, repair.verified false and
 *      repair.patchApplied false, Cache-Control no-store, and no token in the body or worker log.
 *   6. Stops the worker (requires cleanup proof for any active job), closes the API, checks with
 *      `docker ps -a` that no container labelled with the job's execution ids remains, and removes
 *      the temporary directories with removeRunDir.
 *
 * Network: only 127.0.0.1 between this process and its own API. Containers run with network none.
 * No GitHub, no registry, no clone, no kiro-cli (agents off), no untrusted repository: the catalog URL
 * is only a lookup key. Docker is never faked.
 *
 * Second, additional opt-in scenario (GRAVEYARD_MANUAL_WORKER_E2E_REPAIR=1 as well; `pnpm run
 * test:worker-e2e:repair`): a generated BROKEN fixture (`fail-build`: build.mjs throws, test.mjs is
 * the passing test file). The real worker runs with `agents: off` in its configuration but is given
 * SCRIPTED Analyst and Fixer objects through the composeWorker `agents` seam. Their raw outputs (a
 * diagnosis and a whole-file diff of build.mjs) go through the REAL contract validators against the
 * evidence the runner supplies, so the result is reproducible. This does NOT exercise the live Kiro
 * runtime or any model. Everything else is real: the API, the worker, Docker, the offline baseline
 * run (expected to fail at build), the in-memory patch application, the disposable copy under the
 * staging root and the second offline install/build/test of that copy under the same execution id.
 * Expected: outcome repair-verified, repair.verified true, repair.patchApplied false, verifiedDiff equal
 * to the scripted diff, an unchanged original fixture build.mjs, an empty staging root, no container
 * left for either execution id. A pass would show this on this machine only.
 *
 * What a pass shows: this controlled fixture, this operator cache and this Docker daemon produced a
 * durable `passing` result through the real API and worker on this machine. It does not show repair,
 * arbitrary-repository safety, timeout/cancel behaviour of the worker, or a production deployment.
 */

import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../app.js";
import { pipelineFixtureScripts, type PipelineFixtureKind } from "../controlled-pipeline-fixtures.js";
import {
  prepareEvidence,
  validateDiagnosis,
  validatePatchProposal,
  type Diagnosis,
  type EvidenceItem,
  type FileEvidence,
  type PatchProposal,
} from "../agent-contract.js";
import type { AgentOutcome } from "../kiro-agent.js";
import type { AgentsLike } from "../pipeline-runner.js";
import { LABEL_EXECUTION, containerNameFor, spawnExecutor } from "../docker-sandbox.js";
import { createRunDir, ensureOwnedParent, removeRunDir, writeFixture } from "../fixture-workspace.js";
import { executionIdFor } from "../leases.js";
import { NODE_FIXTURE_IMAGE } from "../node-fixture-runner.js";
import type { ResultView } from "../result-view.js";
import { startWorker, type StartResult } from "../worker-process.js";

const OPT_IN = process.env["GRAVEYARD_MANUAL_WORKER_E2E"] === "1";
/** Second opt-in for the broken-fixture repair scenario (scripted agents). */
const REPAIR_OPT_IN = process.env["GRAVEYARD_MANUAL_WORKER_E2E_REPAIR"] === "1";
const MAX_FILE = 64 * 1024;
/** Upper bound for the job to reach a terminal state (pipeline container limit is 120 s). */
const JOB_DEADLINE_MS = 240_000;
const POLL_MS = 500;
/** Catalog key only. Never fetched, cloned or contacted. */
const CATALOG_URL = "https://github.com/graveyard-local/controlled-fixture";

class FailClosed extends Error {}

interface HttpReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function httpCall(port: number, method: "GET" | "POST", path: string, headers: Record<string, string>, body?: string): Promise<HttpReply> {
  return new Promise<HttpReply>((resolveReply, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolveReply({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("http request timed out")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function dockerQuery(args: readonly string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const r = await spawnExecutor("docker", args, { timeoutMs: 20_000, maxOutputBytes: 64 * 1024 });
    return { ok: r.exitCode === 0 && !r.timedOut && !r.truncated, stdout: r.stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
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

function requireAbsoluteDir(envName: string): string {
  const v = process.env[envName];
  if (v === undefined || v === "") throw new FailClosed(`${envName} is not set; the harness needs an operator-supplied controlled input`);
  if (!isAbsolute(v)) throw new FailClosed(`${envName} must be an absolute path`);
  let real: string;
  try {
    real = realpathSync(v);
    if (!lstatSync(real).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new FailClosed(`${envName} does not point to an existing directory`);
  }
  return real;
}

function readOperatorFile(dir: string, name: string): string {
  const p = join(dir, name);
  let st: Stats;
  try {
    st = lstatSync(p);
  } catch {
    throw new FailClosed(`${name} is missing from the operator fixture directory`);
  }
  if (!st.isFile() || st.size > MAX_FILE) throw new FailClosed(`${name} must be a regular file of at most ${MAX_FILE} bytes`);
  return readFileSync(p, "utf8");
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface ScenarioCtx {
  /** The fixture directory under the temporary fixtures root, as written by this harness. */
  fixtureDir: string;
  /** The temporary staging root. */
  stagingDir: string;
  /** build.mjs exactly as written before the job ran. */
  originalBuild: string;
  problems: string[];
  log: string[];
}

interface Scenario {
  /** Fixture directory name and catalog target. */
  fixtureName: string;
  /** Generated, trusted scripts (controlled-pipeline-fixtures.ts). */
  kind: PipelineFixtureKind;
  /** Injected deterministic Analyst and Fixer (never kiro-cli). Absent: agents off, nothing injected. */
  agents?: () => AgentsLike;
  /** Judges the terminal view; pushes into ctx.problems. */
  expect: (view: ResultView, ctx: ScenarioCtx) => void;
}

/** Unified diff that replaces the whole file: every old line removed, every new line added. */
export function wholeFileDiff(path: string, oldText: string, newText: string): string {
  const o = oldText.split("\n");
  const n = newText.split("\n");
  if (o[o.length - 1] === "") o.pop();
  if (n[n.length - 1] === "") n.pop();
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${String(o.length)} +1,${String(n.length)} @@`, ...o.map((l) => `-${l}`), ...n.map((l) => `+${l}`), ""].join("\n");
}

const BROKEN_BUILD = pipelineFixtureScripts("fail-build")["build.mjs"] as string;
const FIXED_BUILD = pipelineFixtureScripts("pass")["build.mjs"] as string;
const REPAIR_DIFF = wholeFileDiff("build.mjs", BROKEN_BUILD, FIXED_BUILD);

/**
 * Deterministic stand-ins for the model. Their raw outputs go through the REAL contract validators
 * (validateDiagnosis, validatePatchProposal) against the evidence the runner supplies, so only the
 * model's words are scripted. This is NOT a test of the live Kiro runtime.
 */
function scriptedAgents(): AgentsLike {
  const prep = (evidence: readonly EvidenceItem[]): ReturnType<typeof prepareEvidence> => prepareEvidence(evidence);
  return {
    analyze: (req): Promise<AgentOutcome<Diagnosis>> => {
      const p = prep(req.evidence);
      if (!p.ok) return Promise.resolve<AgentOutcome<Diagnosis>>({ status: "rejected", role: "analyst", code: p.code, detail: p.detail });
      const v = validateDiagnosis(
        {
          schemaVersion: 1, role: "analyst", verdict: "diagnosis", category: "build-failure",
          summary: "build.mjs throws unconditionally",
          rootCause: "build.mjs raises an intentional error before it writes any build output.",
          confidence: "high", evidenceRefs: ["stage-result"], affectedFiles: ["build.mjs"],
        },
        {
          evidenceIds: new Set(p.items.map((e) => e.id)),
          evidencePaths: new Set(p.items.flatMap((e) => (e.kind === "file" && e.path !== null ? [e.path] : []))),
        },
      );
      return Promise.resolve<AgentOutcome<Diagnosis>>(
        v.ok ? { status: "ok", role: "analyst", value: v.value } : { status: "rejected", role: "analyst", code: v.code, detail: v.detail },
      );
    },
    propose: (req): Promise<AgentOutcome<PatchProposal>> => {
      const p = prep(req.evidence);
      if (!p.ok) return Promise.resolve<AgentOutcome<PatchProposal>>({ status: "rejected", role: "fixer", code: p.code, detail: p.detail });
      const files = new Map<string, FileEvidence>();
      for (const e of p.items) if (e.kind === "file" && e.path !== null) files.set(e.path, { complete: e.complete, text: e.text });
      const v = validatePatchProposal(
        { schemaVersion: 1, role: "fixer", verdict: "patch", summary: "replace the failing build.mjs with the working build", diff: REPAIR_DIFF },
        files,
      );
      return Promise.resolve<AgentOutcome<PatchProposal>>(
        v.ok ? { status: "ok", role: "fixer", value: v.value } : { status: "rejected", role: "fixer", code: v.code, detail: v.detail },
      );
    },
  };
}

const PASS_SCENARIO: Scenario = {
  fixtureName: "pass",
  kind: "pass",
  expect: (view, ctx) => {
    if (view.outcome !== "passing") ctx.problems.push(`outcome ${view.outcome}, expected passing`);
    if (view.repair.verified !== false || view.repair.patchApplied !== false) ctx.problems.push("repair.verified or repair.patchApplied is not false");
    if (view.result === null || view.result["verdict"] !== "verified") ctx.problems.push("stored result verdict is not verified");
    if (view.result !== null && "verification" in view.result) ctx.problems.push("a passing original must carry no verification record");
  },
};

const REPAIR_SCENARIO: Scenario = {
  fixtureName: "broken",
  kind: "fail-build",
  agents: scriptedAgents,
  expect: (view, ctx) => {
    if (view.outcome !== "repair-verified") ctx.problems.push(`outcome ${view.outcome}, expected repair-verified`);
    if (view.repair.verified !== true) ctx.problems.push("repair.verified is not true");
    if (view.repair.patchApplied !== false) ctx.problems.push("repair.patchApplied is not false");
    if (view.verifiedDiff !== REPAIR_DIFF) ctx.problems.push("verifiedDiff is not the exact scripted diff");
    const r = view.result;
    if (r === null || r["verdict"] !== "repository-failing") ctx.problems.push("stored baseline verdict is not repository-failing");
    const v = r === null ? undefined : (r["verification"] as Record<string, unknown> | undefined);
    if (v === undefined) {
      ctx.problems.push("no verification record");
    } else {
      if (v["status"] !== "verified") ctx.problems.push(`verification status ${String(v["status"])}, expected verified`);
      if (typeof v["measuredMs"] !== "number") ctx.problems.push("verification has no measured duration");
      else ctx.log.push(`verification measured ${String(v["measuredMs"])} ms`);
    }
    // The original fixture and the staging root must be untouched and clean.
    try {
      if (readFileSync(join(ctx.fixtureDir, "build.mjs"), "utf8") !== ctx.originalBuild) ctx.problems.push("the ORIGINAL fixture build.mjs changed");
    } catch {
      ctx.problems.push("the original fixture build.mjs could not be re-read");
    }
    const left = readdirSync(ctx.stagingDir);
    if (left.length !== 0) ctx.problems.push(`staging root is not empty after the job: ${left.join(", ")}`);
  },
};

async function runScenario(scn: Scenario): Promise<void> {
  {
    const log: string[] = [];
    const problems: string[] = [];
    const workerLog: string[] = [];
    let parent: string | undefined;
    const dirs: string[] = [];
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    let worker: Extract<StartResult, { started: true }> | undefined;
    let jobId: string | undefined;
    let token: string | undefined;
    let failure: unknown;

    try {
      // ---- Fail-closed preconditions: nothing is created before all of these hold. ----
      const fixtureSrc = requireAbsoluteDir("GRAVEYARD_NPM_FIXTURE_DIR");
      const cacheDir = requireAbsoluteDir("GRAVEYARD_NPM_CACHE_DIR");
      if (readdirSync(cacheDir).length === 0) throw new FailClosed("GRAVEYARD_NPM_CACHE_DIR is empty; it must be prepopulated");
      const goodPkg = readOperatorFile(fixtureSrc, "package.json");
      const goodLock = readOperatorFile(fixtureSrc, "package-lock.json");
      if (!goodLock.includes('"node_modules/is-number"')) {
        throw new FailClosed("the operator lockfile does not contain node_modules/is-number; the generated scripts need it");
      }
      const root = backendRoot();
      if (isInside(join(root, ".tmp-fixtures"), cacheDir)) {
        throw new FailClosed("GRAVEYARD_NPM_CACHE_DIR must not be inside backend/.tmp-fixtures");
      }
      const driver = join(dirname(fileURLToPath(import.meta.url)), "..", "fixture-pipeline-driver.js");
      try {
        if (!lstatSync(driver).isFile()) throw new Error("not a file");
      } catch {
        throw new FailClosed("compiled fixture-pipeline-driver.js not found next to the test output; run `pnpm run test:worker-e2e` (it builds first)");
      }

      const v = await dockerQuery(["version", "--format", "{{.Server.Version}}"]);
      if (!v.ok || v.stdout.trim() === "") throw new FailClosed("docker daemon is not available; this harness never fakes Docker");
      log.push(`docker server ${v.stdout.trim()}`);
      const img = await dockerQuery(["image", "inspect", "--format", "{{.Id}}", NODE_FIXTURE_IMAGE]);
      if (!img.ok) throw new FailClosed(`image ${NODE_FIXTURE_IMAGE} must already exist locally (never pulled)`);

      // ---- Temporary workspace under backend/.tmp-fixtures only. ----
      parent = ensureOwnedParent(root);
      const dataDir = createRunDir(parent);
      dirs.push(dataDir);
      const fixturesDir = createRunDir(parent);
      dirs.push(fixturesDir);
      const stagingDir = createRunDir(parent);
      dirs.push(stagingDir);

      const scripts = pipelineFixtureScripts(scn.kind);
      const fixtureDir = writeFixture(fixturesDir, scn.fixtureName, {
        "package.json": goodPkg,
        "package-lock.json": goodLock,
        ...scripts,
      });
      const cfgDir = writeFixture(dataDir, "cfg", { "catalog.json": JSON.stringify({ [CATALOG_URL]: scn.fixtureName }) });
      const catalogPath = join(cfgDir, "catalog.json");
      const databasePath = join(dataDir, "e2e.sqlite");
      if (!isInside(parent, databasePath)) throw new FailClosed("temporary database path escaped the owned directory");
      log.push(`temporary workspace: data ${dataDir}, fixtures ${fixturesDir}, staging ${stagingDir}`);

      // ---- Real API on an ephemeral localhost port, on the temporary database. ----
      app = await buildApp({ logLevel: "silent", databasePath });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new FailClosed("API did not bind a TCP port");
      const port = (address as AddressInfo).port;
      log.push(`API listening on 127.0.0.1:${String(port)}`);

      // ---- Real worker composition. Only the log sink and, for the repair scenario, scripted agents are injected. ----
      const started = startWorker(
        {
          GRAVEYARD_WORKER_ENABLED: "1",
          DATABASE_PATH: databasePath,
          GRAVEYARD_FIXTURES_ROOT: fixturesDir,
          GRAVEYARD_STAGING_ROOT: stagingDir,
          GRAVEYARD_NPM_CACHE_DIR: cacheDir,
          GRAVEYARD_FIXTURE_CATALOG: catalogPath,
          GRAVEYARD_WORKER_ID: `e2e-${randomBytes(3).toString("hex")}`,
          GRAVEYARD_WORKER_POLL_MS: "250",
          GRAVEYARD_WORKER_AGENTS: "off",
        },
        {
          log: (level, message, fields) => workerLog.push(`${level} ${message}${fields === undefined ? "" : ` ${JSON.stringify(fields)}`}`),
          ...(scn.agents === undefined ? {} : { agents: scn.agents() }),
        },
      );
      if (!started.started) throw new FailClosed(`worker refused to start: ${started.message}`);
      worker = started;
      if (worker.composed.config.agents !== "off") throw new FailClosed("agents must be off in this harness");
      log.push(
        scn.agents === undefined
          ? "worker started (real ControlledPipeline, real Docker executor, agents off)"
          : "worker started (real ControlledPipeline, real Docker executor, SCRIPTED Analyst and Fixer injected; live Kiro is NOT exercised)",
      );

      // ---- Authorized job creation. ----
      const created = await httpCall(port, "POST", "/api/jobs", {}, JSON.stringify({ repoUrl: CATALOG_URL, consent: true }));
      if (created.status !== 202) throw new FailClosed(`job creation returned ${String(created.status)}`);
      const createdBody = JSON.parse(created.body) as { jobId?: unknown; token?: unknown };
      if (typeof createdBody.jobId !== "string" || typeof createdBody.token !== "string" || !/^[0-9a-f]{64}$/.test(createdBody.token)) {
        throw new FailClosed("job creation response had an unexpected shape");
      }
      jobId = createdBody.jobId;
      token = createdBody.token;
      log.push(`job ${jobId} created (token withheld from output)`);

      const resultPath = `/api/jobs/${jobId}/result`;
      const noAuth = await httpCall(port, "GET", resultPath, {});
      if (noAuth.status !== 401) problems.push(`GET result without a token returned ${String(noAuth.status)}, expected 401`);
      const otherToken = randomBytes(32).toString("hex");
      const wrong = await httpCall(port, "GET", resultPath, { authorization: `Bearer ${otherToken}` });
      if (wrong.status !== 403) problems.push(`GET result with another well-formed token returned ${String(wrong.status)}, expected 403`);

      // ---- Bounded wait for a terminal state. ----
      const end = Date.now() + JOB_DEADLINE_MS;
      let view: ResultView | undefined;
      let lastStatus = "(none)";
      for (;;) {
        const r = await httpCall(port, "GET", resultPath, { authorization: `Bearer ${token}` });
        if (r.status !== 200) throw new Error(`GET result returned ${String(r.status)}`);
        const cc = r.headers["cache-control"];
        if (typeof cc !== "string" || !/no-store/.test(cc)) problems.push("GET result response lacks Cache-Control: no-store");
        const cur = JSON.parse(r.body) as ResultView;
        lastStatus = `${cur.status}/${cur.stage}/${cur.outcome}`;
        if (r.body.includes(token)) problems.push("the result body contains the job token");
        if (cur.terminal) {
          view = cur;
          break;
        }
        if (Date.now() > end) break;
        await delay(POLL_MS);
      }

      if (view === undefined) {
        problems.push(`job did not reach a terminal state within ${String(JOB_DEADLINE_MS / 1000)} s (last: ${lastStatus})`);
      } else {
        log.push(`terminal: status=${view.status} stage=${view.stage} outcome=${view.outcome}`);
        if (view.status !== "completed") problems.push(`status ${view.status}, expected completed`);
        if (view.stage !== "done") problems.push(`stage ${view.stage}, expected done`);
        if (view.infrastructure !== null) problems.push(`unexpected infrastructure record: ${view.infrastructure.kind}`);
        if (view.infrastructure !== null) log.push(`infrastructure message: ${view.infrastructure.message}`);
        scn.expect(view, { fixtureDir, stagingDir, originalBuild: scripts["build.mjs"] as string, problems, log });
      }
    } catch (e) {
      failure = e;
    } finally {
      // ---- Cleanup, in order: worker (needs cleanup proof), API, containers check, directories. ----
      if (worker !== undefined) {
        try {
          await worker.stop();
          log.push("worker stopped");
        } catch (e) {
          problems.push(`worker stop failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (app !== undefined) {
        try {
          await app.close();
        } catch (e) {
          problems.push(`API close failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (jobId !== undefined) {
        // A job runs at most max_attempts (2) times; query both execution ids by label and by name.
        for (const attempt of [1, 2]) {
          const id = executionIdFor(jobId, attempt);
          const byLabel = await dockerQuery(["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${LABEL_EXECUTION}=${id}`]);
          const byName = await dockerQuery(["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=${containerNameFor(id)}`]);
          if (!byLabel.ok || !byName.ok) problems.push(`could not query leftover containers for attempt ${String(attempt)}`);
          else if (byLabel.stdout.trim() !== "" || byName.stdout.trim() !== "") {
            problems.push(`container left for execution ${id}: ${(byLabel.stdout + byName.stdout).trim()}`);
          }
        }
        log.push("independent docker ps: queried leftover containers for this job's execution ids");
      }
      if (token !== undefined && workerLog.some((l) => l.includes(token as string))) problems.push("the worker log contains the job token");
      if (parent !== undefined) {
        for (const d of dirs) {
          const r = removeRunDir(parent, d);
          if (r.removed) log.push(`removed ${d}`);
          else problems.push(...r.problems.map((p) => `removal: ${p}`));
        }
      }
      for (const l of log) console.log(`INFO  ${l}`);
      if (problems.length > 0 || failure !== undefined) {
        for (const l of workerLog.slice(-40)) console.log(`WORKER ${l}`);
      }
      if (problems.length > 0) console.log(`PROBLEMS:\n${problems.join("\n")}`);
      if (failure instanceof FailClosed) {
        console.log(`FAIL-CLOSED: ${failure.message}\nNo claim is made about the worker, API, npm or Docker behaviour.`);
      }
    }
    if (failure !== undefined) throw failure;
    if (problems.length > 0) throw new Error(`worker e2e harness found ${String(problems.length)} problem(s)`);
  }
}

test(
  "manual worker end-to-end harness (opt-in: GRAVEYARD_MANUAL_WORKER_E2E=1; real Docker, real API, real worker)",
  { skip: OPT_IN ? false : "set GRAVEYARD_MANUAL_WORKER_E2E=1 (use `pnpm run test:worker-e2e`) to run against real Docker", timeout: 480_000 },
  () => runScenario(PASS_SCENARIO),
);

test(
  "manual worker repair harness (opt-in: GRAVEYARD_MANUAL_WORKER_E2E=1 and GRAVEYARD_MANUAL_WORKER_E2E_REPAIR=1; real Docker, real API, real worker, SCRIPTED agents)",
  {
    skip: OPT_IN && REPAIR_OPT_IN ? false : "set GRAVEYARD_MANUAL_WORKER_E2E=1 and GRAVEYARD_MANUAL_WORKER_E2E_REPAIR=1 (use `pnpm run test:worker-e2e:repair`) to run against real Docker",
    timeout: 720_000,
  },
  () => runScenario(REPAIR_SCENARIO),
);
