/**
 * worker-process.test.ts — startup refusals, the availability gate, and end-to-end processing through
 * the real composition (config -> compose -> WorkerService -> JobWorker -> PipelineJobRunner) against
 * the real API app, sharing one temporary SQLite file as the two processes would.
 *
 * Faked, and only these: the docker CLI (a recording executor), the controlled pipeline and the
 * cleanup check (prepared results), and the agents (prepared outcomes). No Docker, no network, no
 * kiro-cli, no repository code. What these tests do NOT show is that real Docker isolation works;
 * that is covered only by the opt-in manual harnesses.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDatabase } from "../db.js";
import type { ProcessExecutor } from "../docker-sandbox.js";
import type { ControlledPipelineResult, PipelineRequest } from "../controlled-pipeline.js";
import type { StageResult as DriverStage } from "../fixture-pipeline-driver.js";
import type { Diagnosis, PatchProposal } from "../agent-contract.js";
import type { AgentOutcome, AnalystRequest, FixerRequest } from "../kiro-agent.js";
import type { CleanupProof } from "../runner.js";
import type { AgentsLike, PipelineLike } from "../pipeline-runner.js";
import type { ResultView } from "../result-view.js";
import type { ComposeDeps } from "../worker-compose.js";
import type { ServiceLogLevel } from "../worker-service.js";
import { startWorker, type StartResult } from "../worker-process.js";

const REPO = "https://github.com/o/r";
const OTHER_REPO = "https://github.com/o/not-in-catalog";

type Started = Extract<StartResult, { started: true }>;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeDocker {
  calls: string[][] = [];
  up = true;
  readonly executor: ProcessExecutor = (file, args) => {
    this.calls.push([file, ...args]);
    const ok = args[0] === "version" && this.up;
    return Promise.resolve({
      exitCode: ok ? 0 : 1,
      stdout: ok ? "29.0.0\n" : "",
      stderr: "",
      timedOut: false,
      aborted: false,
      truncated: false,
    });
  };
}

const st = (stage: DriverStage["stage"], status: DriverStage["status"], extra: Partial<DriverStage> = {}): DriverStage => ({
  stage,
  status,
  durationMs: 5,
  ...extra,
});

const okCleanup = (executionId: string): CleanupProof => ({
  confirmed: true,
  executionId,
  evidence: "fake docker: no container carries this execution id",
});

function successResult(req: PipelineRequest): ControlledPipelineResult {
  return {
    status: "success",
    reason: "ok",
    detail: "ok",
    failedStage: null,
    stages: [st("prepare", "passed"), st("install", "passed"), st("build", "passed"), st("test", "passed")],
    exitCode: 0,
    durationMs: 10,
    truncated: false,
    stderrTail: "",
    packagesAdded: 1,
    expectedPackages: 1,
    violations: [],
    cleanup: okCleanup(req.executionId),
    stagingRemoved: true,
    driverSha256: "a".repeat(64),
    executionId: req.executionId,
  };
}

function failureResult(req: PipelineRequest): ControlledPipelineResult {
  return {
    ...successResult(req),
    status: "failure",
    reason: "build-failed",
    detail: "build exited with code 1",
    failedStage: "build",
    stages: [
      st("prepare", "passed"),
      st("install", "passed"),
      st("build", "failed", { reason: "exit-code", exitCode: 1, stderrTail: "Error: intentional build failure" }),
      st("test", "skipped"),
    ],
    exitCode: 1,
  };
}

const timedOutResult = (req: PipelineRequest): ControlledPipelineResult => ({
  ...successResult(req),
  status: "not-run",
  reason: "timed-out",
  stages: null,
  exitCode: null,
});

const abortedResult = (req: PipelineRequest): ControlledPipelineResult => ({
  ...timedOutResult(req),
  reason: "aborted",
  cleanup: null,
  stagingRemoved: null,
});

class FakePipeline implements PipelineLike {
  readonly requests: PipelineRequest[] = [];
  constructor(private readonly make: (req: PipelineRequest) => ControlledPipelineResult | Promise<ControlledPipelineResult>) {}
  async run(req: PipelineRequest): Promise<ControlledPipelineResult> {
    this.requests.push(req);
    return this.make(req);
  }
}

const diagnosis: Diagnosis = {
  category: "build-failure",
  summary: "build.mjs throws on purpose",
  rootCause: "build.mjs contains an unconditional throw",
  confidence: "medium",
  evidenceRefs: ["stage-result"],
  affectedFiles: ["build.mjs"],
};

const proposal: PatchProposal = {
  summary: "remove the throw",
  diff: '--- a/build.mjs\n+++ b/build.mjs\n@@ -1 +1 @@\n-throw new Error("intentional build failure");\n+console.log("ok");\n',
  files: ["build.mjs"],
  hunks: 1,
  added: 1,
  removed: 1,
  contextVerified: true,
  proposalOnly: true,
};

class FakeAgents implements AgentsLike {
  calls = 0;
  analyze(_req: AnalystRequest): Promise<AgentOutcome<Diagnosis>> {
    this.calls += 1;
    return Promise.resolve<AgentOutcome<Diagnosis>>({ status: "ok", role: "analyst", value: diagnosis });
  }
  propose(_req: FixerRequest): Promise<AgentOutcome<PatchProposal>> {
    this.calls += 1;
    return Promise.resolve<AgentOutcome<PatchProposal>>({ status: "ok", role: "fixer", value: proposal });
  }
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

let root: string;
let dbPath: string;
let app: FastifyInstance;
let docker: FakeDocker;
let started: Started | null;
let logs: Array<{ level: ServiceLogLevel; message: string; fields: Record<string, unknown> | undefined }>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "graveyard-worker-proc-"));
  for (const d of ["fixtures/fx1", "staging", "cache", "data"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "fixtures", "fx1", "package.json"), '{"name":"fx1","version":"1.0.0"}\n');
  writeFileSync(join(root, "fixtures", "fx1", "package-lock.json"), "{}\n");
  writeFileSync(join(root, "fixtures", "fx1", "build.mjs"), 'throw new Error("intentional build failure");\n');
  writeFileSync(join(root, "catalog.json"), JSON.stringify({ [REPO]: "fx1" }));
  writeFileSync(join(root, "driver.js"), "// stand-in for the compiled pipeline driver\n");
  dbPath = join(root, "data", "graveyard.sqlite");
  docker = new FakeDocker();
  started = null;
  logs = [];
  app = await buildApp({ logLevel: "silent", databasePath: dbPath });
});

afterEach(async () => {
  if (started !== null) await started.stop();
  await app.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function workerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    GRAVEYARD_WORKER_ENABLED: "1",
    DATABASE_PATH: dbPath,
    GRAVEYARD_FIXTURES_ROOT: join(root, "fixtures"),
    GRAVEYARD_STAGING_ROOT: join(root, "staging"),
    GRAVEYARD_NPM_CACHE_DIR: join(root, "cache"),
    GRAVEYARD_FIXTURE_CATALOG: join(root, "catalog.json"),
    GRAVEYARD_WORKER_POLL_MS: "250",
    GRAVEYARD_WORKER_ID: "w-test",
    ...extra,
  };
}

function start(deps: ComposeDeps = {}, envExtra: Record<string, string> = {}): Started {
  const r = startWorker(workerEnv(envExtra), {
    executor: docker.executor,
    log: (level, message, fields) => logs.push({ level, message, fields }),
    ...deps,
  });
  assert.ok(r.started, r.started ? "" : r.message);
  started = r;
  return r;
}

function refused(envExtra: Record<string, string>, deps: ComposeDeps = {}): Extract<StartResult, { started: false }> {
  const r = startWorker(workerEnv(envExtra), { executor: docker.executor, ...deps });
  if (r.started) {
    started = r;
    assert.fail("expected the worker to refuse to start");
  }
  return r;
}

async function newJob(repoUrl: string = REPO): Promise<{ jobId: string; token: string }> {
  const res = await app.inject({ method: "POST", url: "/api/jobs", payload: { repoUrl, consent: true } });
  assert.equal(res.statusCode, 202);
  return res.json<{ jobId: string; token: string }>();
}

async function result(jobId: string, token: string): Promise<ResultView> {
  const res = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/result`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  return res.json<ResultView>();
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function settle(jobId: string, token: string, pred: (v: ResultView) => boolean, label: string): Promise<ResultView> {
  const end = Date.now() + 8_000;
  for (;;) {
    const v = await result(jobId, token);
    if (pred(v)) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${label}; last status ${v.status}, outcome ${v.outcome}`);
    await delay(40);
  }
}

async function until(cond: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 8_000;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${label}`);
    await delay(20);
  }
}

const terminal = (v: ResultView): boolean => v.terminal;

// ---------------------------------------------------------------------------
// Startup and configuration
// ---------------------------------------------------------------------------

describe("worker process startup", () => {
  it("is disabled unless explicitly enabled: exit code 2, nothing opened, nothing run", () => {
    let opened = 0;
    const env = workerEnv();
    delete env["GRAVEYARD_WORKER_ENABLED"];
    const r = startWorker(env, {
      executor: docker.executor,
      openDb: (p) => {
        opened += 1;
        return openDatabase(p);
      },
    });
    assert.equal(r.started, false);
    if (!r.started) {
      assert.equal(r.exitCode, 2);
      assert.match(r.message, /GRAVEYARD_WORKER_ENABLED=1/);
    }
    assert.equal(opened, 0);
    assert.equal(docker.calls.length, 0);
  });

  it("refuses invalid configuration with exit code 1 and lists the problem", () => {
    const r = refused({ GRAVEYARD_WORKER_BATCH: "0" });
    assert.equal(r.exitCode, 1);
    assert.match(r.message, /GRAVEYARD_WORKER_BATCH/);
    assert.equal(docker.calls.length, 0);
  });

  it("refuses a missing fixtures root, staging root or cache before opening the database", () => {
    for (const [name, variable] of [
      ["fixtures", "GRAVEYARD_FIXTURES_ROOT"],
      ["staging", "GRAVEYARD_STAGING_ROOT"],
      ["cache", "GRAVEYARD_NPM_CACHE_DIR"],
    ] as const) {
      let opened = 0;
      const r = refused(
        { [variable]: join(root, `${name}-does-not-exist`) },
        { openDb: (p) => { opened += 1; return openDatabase(p); }, driverPath: join(root, "driver.js") },
      );
      assert.equal(r.exitCode, 1);
      assert.match(r.message, new RegExp(`${variable} is not an existing directory`));
      assert.equal(opened, 0, name);
    }
    assert.equal(docker.calls.length, 0);
  });

  it("refuses a catalog entry whose fixture is missing required files", () => {
    writeFileSync(join(root, "catalog.json"), JSON.stringify({ [REPO]: "fx1", "https://github.com/o/ghost": "ghost" }));
    mkdirSync(join(root, "fixtures", "ghost"));
    writeFileSync(join(root, "fixtures", "ghost", "package.json"), "{}\n"); // no build.mjs, no lockfile
    const r = refused({}, { driverPath: join(root, "driver.js") });
    assert.equal(r.exitCode, 1);
    assert.match(r.message, /names fixture "ghost"/);
    assert.ok(!/names fixture "fx1"/.test(r.message), "the complete fixture is not reported");
  });

  it("refuses to start when the compiled pipeline driver is missing", () => {
    const r = refused({}, { driverPath: join(root, "no-such-driver.js") });
    assert.equal(r.exitCode, 1);
    assert.match(r.message, /pipeline driver/);
  });

  it("opens the database and starts the loop for a valid configuration", async () => {
    const r = start({ driverPath: join(root, "driver.js") });
    assert.equal(r.composed.config.workerId, "w-test");
    assert.deepEqual(r.composed.config.catalog, { [REPO]: "fx1" });
    await until(() => logs.some((l) => l.message === "worker loop started"), "loop start");
    assert.ok(existsSync(dbPath));
  });
});

// ---------------------------------------------------------------------------
// Unavailable runtime
// ---------------------------------------------------------------------------

describe("worker with an unavailable isolation runtime", () => {
  it("claims no job and runs nothing but the availability probe; the job stays queued", async () => {
    docker.up = false;
    const { jobId, token } = await newJob();
    const r = start({ driverPath: join(root, "driver.js") }); // real ControlledPipeline and sandbox, fake docker CLI
    await until(() => r.composed.service.snapshot().runtimeAvailable === false, "availability probe");
    await delay(600); // more than two poll intervals
    const v = await result(jobId, token);
    assert.equal(v.status, "queued");
    assert.equal(v.outcome, "pending");
    assert.ok(docker.calls.length >= 1);
    assert.ok(docker.calls.every((c) => c[0] === "docker" && c[1] === "version"), `unexpected docker use: ${JSON.stringify(docker.calls)}`);
    assert.ok(logs.some((l) => l.level === "warn" && l.message.includes("unavailable")));
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

describe("worker processing, end to end", () => {
  it("runs a catalogued job and exposes a durable passing result to its owner", async () => {
    const pipeline = new FakePipeline(successResult);
    const cleanups: string[] = [];
    const { jobId, token } = await newJob();
    const r = start({
      pipeline,
      cleanupExecution: (id) => {
        cleanups.push(id);
        return Promise.resolve(okCleanup(id));
      },
    });

    const v = await settle(jobId, token, terminal, "the job to finish");
    assert.equal(v.status, "completed");
    assert.equal(v.stage, "done");
    assert.equal(v.outcome, "passing");
    assert.deepEqual(v.repair, { verified: false, patchApplied: false, patchProposed: false, diagnosed: false });
    assert.equal((v.result as Record<string, unknown>)["fixture"], "fx1");
    assert.equal((v.result as Record<string, unknown>)["sourceKind"], "controlled-fixture");

    assert.equal(pipeline.requests.length, 1);
    assert.equal(pipeline.requests[0]?.fixture, "fx1");
    assert.equal(pipeline.requests[0]?.executionId, `${jobId}:1`);
    assert.ok(cleanups.includes(`${jobId}:1`), "cleanup proof was requested for the exact execution id");

    const stages = (r.composed.db
      .prepare("SELECT payload FROM job_events WHERE job_id = ? AND event_type = 'stage' ORDER BY seq")
      .all(jobId) as Array<{ payload: string }>).map((e) => (JSON.parse(e.payload) as { stage: string }).stage);
    assert.deepEqual(stages, ["building", "testing"]);

    const meta = await app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(meta.json<{ status: string }>().status, "completed");

    assert.ok(!JSON.stringify(logs).includes(token), "the bearer token never reaches the worker log");
  });

  it("reports a failing fixture with a model-authored patch proposal that was never applied or verified", async () => {
    const agents = new FakeAgents();
    const pipeline = new FakePipeline(failureResult);
    const { jobId, token } = await newJob();
    start({ pipeline, agents, cleanupExecution: (id) => Promise.resolve(okCleanup(id)) });

    const v = await settle(jobId, token, terminal, "the job to finish");
    assert.equal(v.status, "completed", "completed means the work finished, not that anything was repaired");
    assert.equal(v.outcome, "failing-with-patch-proposal");
    assert.deepEqual(v.repair, { verified: false, patchApplied: false, patchProposed: true, diagnosed: true });
    const fixer = (v.result as Record<string, Record<string, unknown>>)["fixer"] as Record<string, unknown>;
    assert.equal(fixer["proposalOnly"], true);
    assert.equal(fixer["applied"], false);
    assert.equal(pipeline.requests.length, 1, "the pipeline ran once; no patched re-run exists");
    assert.equal(agents.calls, 2);
  });

  it("with agents enabled but kiro-cli unavailable, the job still completes and says there was no diagnosis", async () => {
    const pipeline = new FakePipeline(failureResult);
    const { jobId, token } = await newJob();
    start(
      {
        pipeline,
        cleanupExecution: (id) => Promise.resolve(okCleanup(id)),
        agentExecutor: () => Promise.reject(new Error("kiro-cli is not installed")),
      },
      { GRAVEYARD_WORKER_AGENTS: "kiro-v3" },
    );
    const v = await settle(jobId, token, terminal, "the job to finish");
    assert.equal(v.status, "completed");
    assert.equal(v.outcome, "failing-undiagnosed");
    assert.equal(v.repair.diagnosed, false);
    assert.equal(v.repair.patchProposed, false);
    const analyst = (v.result as Record<string, Record<string, unknown>>)["analyst"] as Record<string, unknown>;
    assert.notEqual(analyst["status"], "ok");
  });

  it("refuses a repository that is not in the operator catalog: the job fails, nothing runs, nothing is completed", async () => {
    const pipeline = new FakePipeline(successResult);
    const { jobId, token } = await newJob(OTHER_REPO);
    start({ pipeline, cleanupExecution: (id) => Promise.resolve(okCleanup(id)) });

    const v = await settle(jobId, token, terminal, "the job to finish");
    assert.equal(v.status, "failed");
    assert.equal(v.outcome, "infrastructure-failed");
    assert.equal(v.result, null);
    assert.equal(v.infrastructure?.kind, "infrastructure-unavailable");
    assert.match(v.infrastructure?.message ?? "", /no controlled execution path/);
    assert.equal(pipeline.requests.length, 0, "the pipeline is never asked to run an uncatalogued repository");
  });

  it("an inconclusive pipeline (timed out) fails the job as infrastructure, with no result", async () => {
    const { jobId, token } = await newJob();
    start({ pipeline: new FakePipeline(timedOutResult), cleanupExecution: (id) => Promise.resolve(okCleanup(id)) });
    const v = await settle(jobId, token, terminal, "the job to finish");
    assert.equal(v.status, "failed");
    assert.equal(v.outcome, "infrastructure-failed");
    assert.equal(v.result, null);
    assert.match(v.infrastructure?.message ?? "", /timed-out/);
  });

  it("unproven cleanup blocks the job: it is never completed and its result stays hidden", async () => {
    const { jobId, token } = await newJob();
    const r = start({
      pipeline: new FakePipeline(successResult),
      cleanupExecution: () => Promise.resolve<CleanupProof>({ confirmed: false, reason: "docker unreachable" }),
    });
    await until(
      () =>
        (r.composed.db
          .prepare("SELECT 1 AS x FROM job_events WHERE job_id = ? AND event_type = 'cleanup-unconfirmed'")
          .all(jobId) as unknown[]).length > 0,
      "the cleanup-unconfirmed record",
    );
    const types = (r.composed.db.prepare("SELECT event_type FROM job_events WHERE job_id = ?").all(jobId) as Array<{ event_type: string }>).map(
      (e) => e.event_type,
    );
    assert.ok(types.includes("result"), "the runner did record a result event before cleanup failed");

    const v = await result(jobId, token);
    assert.equal(v.status, "running");
    assert.equal(v.terminal, false);
    assert.equal(v.outcome, "pending");
    assert.equal(v.result, null, "a result is exposed only after cleanup was proven and the job completed");
  });

  it("a stop request mid-job settles the job (requeued with cleanup proof), ends the loop and closes the database", async () => {
    let running!: () => void;
    const hasStarted = new Promise<void>((resolve) => {
      running = resolve;
    });
    const pipeline = new FakePipeline(
      (req) =>
        new Promise<ControlledPipelineResult>((resolve) => {
          running();
          req.signal?.addEventListener("abort", () => resolve(abortedResult(req)), { once: true });
        }),
    );
    const { jobId, token } = await newJob();
    const r = start({ pipeline, cleanupExecution: (id) => Promise.resolve(okCleanup(id)) });
    await hasStarted;

    await r.stop();
    await r.done;
    assert.equal(r.composed.service.snapshot().state, "stopped");
    assert.throws(() => r.composed.db.prepare("SELECT 1"), "the worker's database handle is closed");

    const v = await result(jobId, token);
    assert.equal(v.status, "queued", "the job is requeued, not lost and not completed");
    assert.equal(v.outcome, "pending");
    assert.equal(v.result, null);
    await r.stop(); // idempotent
  });
});
