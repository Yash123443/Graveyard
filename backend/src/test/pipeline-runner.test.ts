/**
 * pipeline-runner.test.ts — integration of JobWorker, PipelineJobRunner, the pipeline result,
 * the Tester and the agents, with every dependency injected.
 *
 * No Docker, no network, no kiro-cli, no repository code. The pipeline, the cleanup check and the
 * agents are fakes that return prepared values. A real in-memory SQLite database and the real
 * JobWorker and lease code are used, so the stage events, the result event and the final job state
 * are what the worker would really write.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import { createJob } from "../jobs.js";
import { generateRawToken } from "../token.js";
import {
  claimNextJob,
  fenceOwnLease,
  recordLeasedResult,
  recordLeasedStage,
  MAX_RESULT_BYTES,
} from "../leases.js";
import { JobWorker, drainQueue } from "../worker.js";
import type { CleanupProof, JobProgress, RunContext } from "../runner.js";
import type { ControlledPipelineResult, PipelineRequest } from "../controlled-pipeline.js";
import type { StageResult as DriverStage } from "../fixture-pipeline-driver.js";
import type { Diagnosis, PatchProposal } from "../agent-contract.js";
import type { AgentOutcome, AnalystRequest, FixerRequest } from "../kiro-agent.js";
import { buildPipelineTesterReport } from "../tester.js";
import {
  PipelineJobRunner,
  REPOSITORY_UNSUPPORTED_REASON,
  NO_REPORTER_REASON,
  SOURCE_INVALID_REASON,
  buildEvidence,
  createCatalogResolver,
  readFixtureEvidence,
  type AgentsLike,
  type ControlledSource,
  type PipelineLike,
  type SourceFile,
} from "../pipeline-runner.js";

const REPO = "https://github.com/o/r";

// ---------------------------------------------------------------------------
// Fakes and builders
// ---------------------------------------------------------------------------

const st = (stage: DriverStage["stage"], status: DriverStage["status"], extra: Partial<DriverStage> = {}): DriverStage => ({
  stage, status, durationMs: 5, ...extra,
});

function okCleanup(executionId: string): CleanupProof {
  return { confirmed: true, executionId, evidence: "fake docker: no container carries this execution id" };
}

const badCleanup = (): Promise<CleanupProof> => Promise.resolve({ confirmed: false, reason: "docker unreachable" });

function successResult(req: PipelineRequest): ControlledPipelineResult {
  return {
    status: "success", reason: "ok", detail: "ok", failedStage: null,
    stages: [st("prepare", "passed"), st("install", "passed"), st("build", "passed"), st("test", "passed")],
    exitCode: 0, durationMs: 10, truncated: false, stderrTail: "", packagesAdded: 1, expectedPackages: 1,
    violations: [], cleanup: okCleanup(req.executionId), stagingRemoved: true, driverSha256: "a".repeat(64),
    executionId: req.executionId,
  };
}

function failureResult(req: PipelineRequest): ControlledPipelineResult {
  return {
    ...successResult(req),
    status: "failure", reason: "build-failed", detail: "build exited with code 1", failedStage: "build",
    stages: [
      st("prepare", "passed"),
      st("install", "passed"),
      st("build", "failed", { reason: "exit-code", exitCode: 1, stderrTail: "Error: intentional build failure" }),
      st("test", "skipped"),
    ],
    exitCode: 1,
  };
}

function noTestsResult(req: PipelineRequest): ControlledPipelineResult {
  return {
    ...successResult(req),
    status: "not-run", reason: "tests-not-run", failedStage: "test",
    stages: [st("prepare", "passed"), st("install", "passed"), st("build", "passed"), st("test", "not-run")],
  };
}

function timedOutResult(req: PipelineRequest): ControlledPipelineResult {
  return {
    ...successResult(req),
    status: "not-run", reason: "timed-out", stages: null, exitCode: null,
  };
}

class FakePipeline implements PipelineLike {
  readonly requests: PipelineRequest[] = [];
  constructor(private readonly make: (req: PipelineRequest) => ControlledPipelineResult | Promise<ControlledPipelineResult>) {}
  async run(req: PipelineRequest): Promise<ControlledPipelineResult> {
    this.requests.push(req);
    return this.make(req);
  }
}

const SOURCE_FILES: SourceFile[] = [
  { path: "package.json", text: '{"name":"fx"}\n', complete: true },
  { path: "build.mjs", text: 'throw new Error("intentional build failure");\n', complete: true },
];

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
  diff: "--- a/build.mjs\n+++ b/build.mjs\n@@ -1 +1 @@\n-throw new Error(\"intentional build failure\");\n+console.log(\"ok\");\n",
  files: ["build.mjs"],
  hunks: 1,
  added: 1,
  removed: 1,
  contextVerified: true,
  proposalOnly: true,
};

class FakeAgents implements AgentsLike {
  readonly analyses: AnalystRequest[] = [];
  readonly proposals: FixerRequest[] = [];
  analyst: () => Promise<AgentOutcome<Diagnosis>> = () => Promise.resolve<AgentOutcome<Diagnosis>>({ status: "ok", role: "analyst", value: diagnosis });
  fixer: () => Promise<AgentOutcome<PatchProposal>> = () => Promise.resolve<AgentOutcome<PatchProposal>>({ status: "ok", role: "fixer", value: proposal });
  analyze(req: AnalystRequest): Promise<AgentOutcome<Diagnosis>> {
    this.analyses.push(req);
    return this.analyst();
  }
  propose(req: FixerRequest): Promise<AgentOutcome<PatchProposal>> {
    this.proposals.push(req);
    return this.fixer();
  }
}

interface Rig {
  db: DatabaseSync;
  pipeline: FakePipeline;
  cleanups: string[];
  runner: PipelineJobRunner;
  worker: JobWorker;
}

function makeRig(opts: {
  make?: (req: PipelineRequest) => ControlledPipelineResult | Promise<ControlledPipelineResult>;
  resolve?: (url: string) => ControlledSource | null | Promise<ControlledSource | null>;
  agents?: AgentsLike;
  cleanup?: (id: string) => Promise<CleanupProof>;
  db: DatabaseSync;
}): Rig {
  const pipeline = new FakePipeline(opts.make ?? successResult);
  const cleanups: string[] = [];
  const runner = new PipelineJobRunner({
    resolve: opts.resolve ?? ((url) => (url === REPO ? { fixture: "fx1", files: SOURCE_FILES } : null)),
    pipeline,
    cleanupExecution: (id) => {
      cleanups.push(id);
      return opts.cleanup !== undefined ? opts.cleanup(id) : Promise.resolve(okCleanup(id));
    },
    ...(opts.agents === undefined ? {} : { agents: opts.agents }),
  });
  const worker = new JobWorker({ db: opts.db, workerId: "w-test", runner });
  return { db: opts.db, pipeline, cleanups, runner, worker };
}

function newJob(db: DatabaseSync, url: string = REPO): string {
  return createJob(db, { repoUrl: url, rawToken: generateRawToken() }).jobId;
}

function row(db: DatabaseSync, id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown>;
}

function events(db: DatabaseSync, id: string): Array<{ type: string; payload: Record<string, unknown> }> {
  const rows = db
    .prepare("SELECT event_type, payload FROM job_events WHERE job_id = ? ORDER BY seq")
    .all(id) as Array<{ event_type: string; payload: string }>;
  return rows.map((r) => ({ type: r.event_type, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}

const stageNames = (db: DatabaseSync, id: string): unknown[] =>
  events(db, id).filter((e) => e.type === "stage").map((e) => e.payload["stage"]);

function resultOf(db: DatabaseSync, id: string): Record<string, unknown> | null {
  const e = events(db, id).filter((x) => x.type === "result");
  if (e.length === 0) return null;
  assert.equal(e.length, 1, "exactly one result event per attempt");
  return (e[0] as { payload: Record<string, unknown> }).payload["result"] as Record<string, unknown>;
}

function infra(db: DatabaseSync, id: string): { kind: string; message: string } | null {
  const raw = row(db, id)["infra_error"] as string | null;
  return raw === null ? null : (JSON.parse(raw) as { kind: string; message: string });
}

let db: DatabaseSync;
beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Worker + runner: successful paths
// ---------------------------------------------------------------------------

describe("PipelineJobRunner through JobWorker: successful paths", () => {
  it("a passing pipeline completes the job with a verified result and Tester pass", async () => {
    const rig = makeRig({ db });
    const id = newJob(db);
    const res = await rig.worker.runOnce();
    assert.deepEqual(res, { kind: "finished", jobId: id, outcome: "completed" });

    assert.equal(row(db, id)["status"], "completed");
    assert.equal(row(db, id)["stage"], "done");
    assert.deepEqual(stageNames(db, id), ["building", "testing"]);

    const result = resultOf(db, id) as Record<string, unknown>;
    assert.equal(result["verdict"], "verified");
    assert.equal(result["sourceKind"], "controlled-fixture");
    assert.equal(result["fixture"], "fx1");
    assert.equal((result["tester"] as { status: string }).status, "passed");
    assert.deepEqual(result["analyst"], { status: "not-configured" });
    assert.deepEqual(result["fixer"], { status: "not-configured" });

    assert.equal(rig.pipeline.requests.length, 1);
    assert.equal(rig.pipeline.requests[0]?.fixture, "fx1");
    assert.equal(rig.pipeline.requests[0]?.executionId, `${id}:1`);
    assert.deepEqual(rig.cleanups, [`${id}:1`]);
    assert.equal(infra(db, id), null);
  });

  it("agents are not called when the pipeline passes", async () => {
    const agents = new FakeAgents();
    const rig = makeRig({ db, agents });
    newJob(db);
    await rig.worker.runOnce();
    assert.equal(agents.analyses.length, 0);
    assert.equal(agents.proposals.length, 0);
  });

  it("a failing build completes with repository-failing, diagnosis and a proposal that is not applied", async () => {
    const agents = new FakeAgents();
    const rig = makeRig({ db, make: failureResult, agents });
    const id = newJob(db);
    const res = await rig.worker.runOnce();
    assert.deepEqual(res, { kind: "finished", jobId: id, outcome: "completed" });
    assert.deepEqual(stageNames(db, id), ["building", "testing", "diagnosing", "repairing"]);

    const result = resultOf(db, id) as Record<string, unknown>;
    assert.equal(result["verdict"], "repository-failing");
    const tester = result["tester"] as { status: string; reason: string; build: { status: string }; install: { status: string } };
    assert.equal(tester.status, "failed");
    assert.equal(tester.reason, "stage-failed");
    assert.equal(tester.build.status, "failed");
    assert.equal(tester.install.status, "passed");

    const analyst = result["analyst"] as Record<string, unknown>;
    assert.equal(analyst["status"], "ok");
    assert.equal(analyst["modelAuthored"], true);
    assert.equal(analyst["category"], "build-failure");

    const fixer = result["fixer"] as Record<string, unknown>;
    assert.equal(fixer["status"], "ok");
    assert.equal(fixer["proposalOnly"], true);
    assert.equal(fixer["applied"], false);
    assert.equal(fixer["diff"], proposal.diff);

    assert.equal(row(db, id)["status"], "completed");
  });

  it("the Analyst receives bounded evidence: stage result with the failing tail, plus the catalog files", async () => {
    const agents = new FakeAgents();
    const rig = makeRig({ db, make: failureResult, agents });
    newJob(db);
    await rig.worker.runOnce();

    const ev = agents.analyses[0]?.evidence ?? [];
    assert.deepEqual(ev.map((e) => e.id), ["stage-result", "file-1", "file-2"]);
    assert.ok(ev[0]?.text.includes("stage build: failed (exit-code) exit=1"));
    assert.ok(ev[0]?.text.includes("intentional build failure"));
    assert.deepEqual(ev.slice(1).map((e) => e.path), ["package.json", "build.mjs"]);
    assert.ok(agents.analyses[0]?.signal instanceof AbortSignal);
    // The Fixer gets the same evidence and the accepted diagnosis.
    assert.deepEqual(agents.proposals[0]?.diagnosis, diagnosis);
    assert.equal(agents.proposals[0]?.evidence.length, 3);
  });

  it("a failing build without agents still completes, with no diagnosis and no patch", async () => {
    const rig = makeRig({ db, make: failureResult });
    const id = newJob(db);
    await rig.worker.runOnce();
    const result = resultOf(db, id) as Record<string, unknown>;
    assert.equal(result["verdict"], "repository-failing");
    assert.deepEqual(result["analyst"], { status: "not-configured" });
    assert.deepEqual(result["fixer"], { status: "not-configured" });
    assert.deepEqual(stageNames(db, id), ["building", "testing"]);
  });

  it("an Analyst no-result skips the Fixer and is recorded as such", async () => {
    const agents = new FakeAgents();
    agents.analyst = () => Promise.resolve<AgentOutcome<Diagnosis>>({ status: "no-result", role: "analyst", code: "unknown-diagnosis", detail: "unknown" });
    const rig = makeRig({ db, make: failureResult, agents });
    const id = newJob(db);
    await rig.worker.runOnce();
    const result = resultOf(db, id) as Record<string, unknown>;
    assert.deepEqual(result["analyst"], { status: "no-result", code: "unknown-diagnosis" });
    assert.deepEqual(result["fixer"], { status: "no-diagnosis" });
    assert.equal(agents.proposals.length, 0);
    assert.deepEqual(stageNames(db, id), ["building", "testing", "diagnosing"]);
    assert.equal(row(db, id)["status"], "completed");
  });

  it("an agent that raises is recorded as failed and does not fail the job", async () => {
    const agents = new FakeAgents();
    agents.analyst = () => Promise.reject(new Error("secret-ish internal message"));
    const rig = makeRig({ db, make: failureResult, agents });
    const id = newJob(db);
    await rig.worker.runOnce();
    const result = resultOf(db, id) as Record<string, unknown>;
    assert.deepEqual(result["analyst"], { status: "failed", code: "agent-raised" });
    assert.ok(!JSON.stringify(result).includes("secret-ish"));
    assert.equal(row(db, id)["status"], "completed");
  });

  it("a Fixer rejection is recorded and the job still completes", async () => {
    const agents = new FakeAgents();
    agents.fixer = () => Promise.resolve<AgentOutcome<PatchProposal>>({ status: "rejected", role: "fixer", code: "diff-invalid", detail: "bad" });
    const rig = makeRig({ db, make: failureResult, agents });
    const id = newJob(db);
    await rig.worker.runOnce();
    const result = resultOf(db, id) as Record<string, unknown>;
    assert.deepEqual(result["fixer"], { status: "rejected", code: "diff-invalid" });
    assert.equal(row(db, id)["status"], "completed");
  });

  it("a fixture without tests completes as tests-not-run, never verified", async () => {
    const agents = new FakeAgents();
    const rig = makeRig({ db, make: noTestsResult, agents });
    const id = newJob(db);
    const res = await rig.worker.runOnce();
    assert.deepEqual(res, { kind: "finished", jobId: id, outcome: "completed" });
    const result = resultOf(db, id) as Record<string, unknown>;
    assert.equal(result["verdict"], "tests-not-run");
    const tester = result["tester"] as { status: string; reason: string; test: { reason: string } };
    assert.equal(tester.status, "not-run");
    assert.equal(tester.reason, "tests-not-run");
    assert.equal(tester.test.reason, "no-tests");
    assert.equal(agents.analyses.length, 0);
  });

  it("result events carry no lease token and no recovery token", async () => {
    const rig = makeRig({ db, make: failureResult, agents: new FakeAgents() });
    const id = newJob(db);
    await rig.worker.runOnce();
    const token = (row(db, id)["lease_token"] as string | null) ?? "";
    const all = JSON.stringify(events(db, id));
    assert.ok(!/lease_?token|recovery_?token/i.test(all));
    assert.equal(token, "");
  });
});

// ---------------------------------------------------------------------------
// Worker + runner: failure and refusal paths
// ---------------------------------------------------------------------------

describe("PipelineJobRunner through JobWorker: refusal and failure paths", () => {
  it("a repository that is not in the catalog fails closed before anything runs", async () => {
    const rig = makeRig({ db, agents: new FakeAgents() });
    const id = newJob(db, "https://github.com/someone/else");
    const res = await rig.worker.runOnce();
    assert.deepEqual(res, { kind: "finished", jobId: id, outcome: "failed" });
    assert.equal(row(db, id)["status"], "failed");
    assert.equal(rig.pipeline.requests.length, 0);
    assert.equal(resultOf(db, id), null);
    assert.deepEqual(stageNames(db, id), []);
    const e = infra(db, id);
    assert.equal(e?.kind, "infrastructure-unavailable");
    assert.equal(e?.message, REPOSITORY_UNSUPPORTED_REASON);
  });

  it("a resolver that throws is treated as unsupported", async () => {
    const rig = makeRig({ db, resolve: () => { throw new Error("disk error"); } });
    const id = newJob(db);
    await rig.worker.runOnce();
    assert.equal(row(db, id)["status"], "failed");
    assert.equal(infra(db, id)?.message, REPOSITORY_UNSUPPORTED_REASON);
    assert.equal(rig.pipeline.requests.length, 0);
  });

  it("an invalid catalog entry is refused before the pipeline runs", async () => {
    const bad: ControlledSource[] = [
      { fixture: "../escape", files: [] },
      { fixture: "fx1", files: [{ path: "../x", text: "t", complete: true }] },
      { fixture: "fx1", files: [{ path: ".git/config", text: "t", complete: true }] },
      { fixture: "fx1", files: [SOURCE_FILES[0] as SourceFile, SOURCE_FILES[0] as SourceFile] },
    ];
    for (const source of bad) {
      const rig = makeRig({ db, resolve: () => source });
      const id = newJob(db);
      await rig.worker.runOnce();
      assert.equal(row(db, id)["status"], "failed");
      assert.equal(infra(db, id)?.message, SOURCE_INVALID_REASON);
      assert.equal(rig.pipeline.requests.length, 0);
    }
  });

  it("an inconclusive pipeline (timed out) fails the job as infrastructure and records no result", async () => {
    const agents = new FakeAgents();
    const rig = makeRig({ db, make: timedOutResult, agents });
    const id = newJob(db);
    const res = await rig.worker.runOnce();
    assert.deepEqual(res, { kind: "finished", jobId: id, outcome: "failed" });
    assert.equal(resultOf(db, id), null);
    const e = infra(db, id);
    assert.equal(e?.kind, "infrastructure-unavailable");
    assert.ok(e?.message.includes("timed-out"));
    assert.equal(agents.analyses.length, 0);
  });

  it("a pipeline that claims success without confirmed container cleanup is not trusted", async () => {
    const rig = makeRig({
      db,
      make: (req) => ({ ...successResult(req), cleanup: { confirmed: false, reason: "docker down" } }),
    });
    const id = newJob(db);
    await rig.worker.runOnce();
    assert.equal(row(db, id)["status"], "failed");
    assert.equal(resultOf(db, id), null);
    assert.ok(infra(db, id)?.message.includes("cleanup-unconfirmed"));
  });

  it("a pipeline that claims success without removing the staging directory is not trusted", async () => {
    const rig = makeRig({ db, make: (req) => ({ ...successResult(req), stagingRemoved: false }) });
    const id = newJob(db);
    await rig.worker.runOnce();
    assert.equal(row(db, id)["status"], "failed");
    assert.equal(resultOf(db, id), null);
  });

  it("a pipeline result for a different execution id is not trusted", async () => {
    const rig = makeRig({ db, make: (req) => ({ ...successResult(req), executionId: "other:1" }) });
    const id = newJob(db);
    await rig.worker.runOnce();
    assert.equal(row(db, id)["status"], "failed");
    assert.equal(resultOf(db, id), null);
  });

  it("truncated output downgrades a claimed success to not-run (Tester re-check)", async () => {
    const rig = makeRig({ db, make: (req) => ({ ...successResult(req), truncated: true }) });
    const id = newJob(db);
    await rig.worker.runOnce();
    assert.equal(row(db, id)["status"], "failed");
    assert.equal(resultOf(db, id), null);
  });

  it("a pipeline that throws fails the job and the cleanup check still runs", async () => {
    const rig = makeRig({ db, make: () => { throw new Error("boom"); } });
    const id = newJob(db);
    const res = await rig.worker.runOnce();
    assert.deepEqual(res, { kind: "finished", jobId: id, outcome: "failed" });
    assert.equal(resultOf(db, id), null);
    assert.deepEqual(rig.cleanups, [`${id}:1`]);
    assert.ok(!(infra(db, id)?.message ?? "").includes("boom"));
  });

  it("unconfirmed cleanup blocks the job even after a good result", async () => {
    const rig = makeRig({ db, cleanup: badCleanup });
    const id = newJob(db);
    const res = await rig.worker.runOnce();
    assert.deepEqual(res, { kind: "finished", jobId: id, outcome: "blocked" });
    const r = row(db, id);
    assert.equal(r["status"], "running");
    assert.equal(r["recovery_required"], 1);
    assert.equal(infra(db, id)?.kind, "cleanup-unconfirmed");
    assert.notEqual(r["stage"], "done");
  });

  it("a cleanup proof for another execution id is rejected by the runner", async () => {
    const rig = makeRig({ db, cleanup: () => Promise.resolve(okCleanup("someone-else:1")) });
    const proof = await rig.runner.cleanup({ jobId: "j", executionId: "j:1", attempt: 1, workerId: null });
    assert.equal(proof.confirmed, false);
  });

  it("a cleanup check that throws is unconfirmed", async () => {
    const rig = makeRig({ db, cleanup: () => Promise.reject(new Error("x")) });
    const proof = await rig.runner.cleanup({ jobId: "j", executionId: "j:1", attempt: 1, workerId: null });
    assert.equal(proof.confirmed, false);
  });

  it("cleanup is requested even for an execution this process never ran (recovery)", async () => {
    const rig = makeRig({ db });
    const proof = await rig.runner.cleanup({ jobId: "j", executionId: "j:2", attempt: 2, workerId: "other" });
    assert.equal(proof.confirmed, true);
    assert.deepEqual(rig.cleanups, ["j:2"]);
  });
});

// ---------------------------------------------------------------------------
// Runner used directly (no worker)
// ---------------------------------------------------------------------------

describe("PipelineJobRunner.run directly", () => {
  function ctx(report: JobProgress | undefined, signal: AbortSignal = new AbortController().signal): RunContext {
    return {
      jobId: "j", repoUrl: REPO, executionId: "j:1", attempt: 1,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(), signal,
      ...(report === undefined ? {} : { report }),
    };
  }
  const recorder = (accept: { stage?: (s: string) => boolean; result?: boolean } = {}): JobProgress & { stages: string[]; results: Record<string, unknown>[] } => {
    const stages: string[] = [];
    const results: Record<string, unknown>[] = [];
    return {
      stages, results,
      stage: (s) => { stages.push(s); return accept.stage === undefined ? true : accept.stage(s); },
      result: (r) => { results.push(r); return accept.result ?? true; },
    };
  };

  it("refuses to run without a progress channel", async () => {
    const rig = makeRig({ db });
    const out = await rig.runner.run(ctx(undefined));
    assert.deepEqual(out, { kind: "infrastructure-unavailable", reason: NO_REPORTER_REASON });
    assert.equal(rig.pipeline.requests.length, 0);
  });

  it("an already aborted signal starts nothing", async () => {
    const rig = makeRig({ db });
    const c = new AbortController();
    c.abort();
    const out = await rig.runner.run(ctx(recorder(), c.signal));
    assert.deepEqual(out, { kind: "aborted" });
    assert.equal(rig.pipeline.requests.length, 0);
  });

  it("an abort during the pipeline run discards its result", async () => {
    const c = new AbortController();
    const rig = makeRig({ db, make: (req) => { c.abort(); return successResult(req); } });
    const rec = recorder();
    const out = await rig.runner.run(ctx(rec, c.signal));
    assert.deepEqual(out, { kind: "aborted" });
    assert.deepEqual(rec.results, []);
  });

  it("the abort signal is handed to the pipeline", async () => {
    const rig = makeRig({ db });
    const c = new AbortController();
    await rig.runner.run(ctx(recorder(), c.signal));
    assert.equal(rig.pipeline.requests[0]?.signal, c.signal);
  });

  it("a rejected stage write stops the run before the pipeline starts", async () => {
    const rig = makeRig({ db });
    const rec = recorder({ stage: () => false });
    const out = await rig.runner.run(ctx(rec));
    assert.deepEqual(out, { kind: "aborted" });
    assert.equal(rig.pipeline.requests.length, 0);
  });

  it("a rejected result write is not reported as completed", async () => {
    const rig = makeRig({ db });
    const out = await rig.runner.run(ctx(recorder({ result: false })));
    assert.deepEqual(out, { kind: "aborted" });
  });

  it("constructor refuses missing dependencies", () => {
    assert.throws(() => new PipelineJobRunner({} as never));
  });
});

// ---------------------------------------------------------------------------
// Fenced stage and result writes (leases.ts)
// ---------------------------------------------------------------------------

describe("recordLeasedStage and recordLeasedResult", () => {
  it("accept the lease holder and update the stage", () => {
    const id = newJob(db);
    const claim = claimNextJob(db, { workerId: "w" });
    assert.ok(claim);
    assert.deepEqual(recordLeasedStage(db, { jobId: id, leaseToken: claim.leaseToken, stage: "building", note: "n" }), { accepted: true });
    assert.equal(row(db, id)["stage"], "building");
    const ev = events(db, id).filter((e) => e.type === "stage");
    assert.equal(ev.length, 1);
    assert.equal(ev[0]?.payload["note"], "n");
    assert.equal(ev[0]?.payload["attemptCount"], 1);
  });

  it("reject a wrong token with no side effects", () => {
    const id = newJob(db);
    claimNextJob(db, { workerId: "w" });
    const before = events(db, id).length;
    assert.deepEqual(recordLeasedStage(db, { jobId: id, leaseToken: "0".repeat(64), stage: "building" }), { accepted: false });
    assert.deepEqual(recordLeasedResult(db, { jobId: id, leaseToken: "0".repeat(64), result: { a: 1 } }), { accepted: false });
    assert.equal(events(db, id).length, before);
    assert.equal(row(db, id)["stage"], "queued");
  });

  it("reject a fenced lease and an expired lease", () => {
    const id = newJob(db);
    const claim = claimNextJob(db, { workerId: "w" });
    assert.ok(claim);
    const later = new Date(Date.parse(claim.leaseExpiresAt) + 1000);
    assert.deepEqual(recordLeasedStage(db, { jobId: id, leaseToken: claim.leaseToken, stage: "building", now: later }), { accepted: false });
    assert.ok(fenceOwnLease(db, { jobId: id, leaseToken: claim.leaseToken, reason: "test" }));
    assert.deepEqual(recordLeasedStage(db, { jobId: id, leaseToken: claim.leaseToken, stage: "building" }), { accepted: false });
    assert.deepEqual(recordLeasedResult(db, { jobId: id, leaseToken: claim.leaseToken, result: { a: 1 } }), { accepted: false });
  });

  it("refuse queued, done and unknown stages", () => {
    const id = newJob(db);
    const claim = claimNextJob(db, { workerId: "w" });
    assert.ok(claim);
    for (const stage of ["queued", "done", "nonsense"]) {
      assert.throws(() => recordLeasedStage(db, { jobId: id, leaseToken: claim.leaseToken, stage: stage as never }));
    }
  });

  it("allow one result per attempt and refuse oversize payloads without truncating", () => {
    const id = newJob(db);
    const claim = claimNextJob(db, { workerId: "w" });
    assert.ok(claim);
    assert.throws(
      () => recordLeasedResult(db, { jobId: id, leaseToken: claim.leaseToken, result: { blob: "x".repeat(MAX_RESULT_BYTES) } }),
      /too large/,
    );
    assert.equal(events(db, id).filter((e) => e.type === "result").length, 0);
    assert.deepEqual(recordLeasedResult(db, { jobId: id, leaseToken: claim.leaseToken, result: { ok: true } }), { accepted: true });
    assert.deepEqual(recordLeasedResult(db, { jobId: id, leaseToken: claim.leaseToken, result: { ok: false } }), { accepted: false });
    assert.equal(events(db, id).filter((e) => e.type === "result").length, 1);
  });

  it("refuse a non-object result", () => {
    const id = newJob(db);
    const claim = claimNextJob(db, { workerId: "w" });
    assert.ok(claim);
    assert.throws(() => recordLeasedResult(db, { jobId: id, leaseToken: claim.leaseToken, result: [] as never }));
    assert.throws(() => recordLeasedResult(db, { jobId: id, leaseToken: claim.leaseToken, result: null as never }));
  });
});

// ---------------------------------------------------------------------------
// Bounded drain
// ---------------------------------------------------------------------------

describe("drainQueue", () => {
  it("processes queued jobs sequentially until the queue is idle", async () => {
    const rig = makeRig({ db });
    const a = newJob(db);
    const b = newJob(db);
    const out = await drainQueue(rig.worker, { maxJobs: 5 });
    assert.equal(out.stoppedBecause, "idle");
    assert.deepEqual(out.finished.map((f) => f.outcome), ["completed", "completed"]);
    assert.deepEqual(new Set(out.finished.map((f) => f.jobId)), new Set([a, b]));
  });

  it("never exceeds maxJobs", async () => {
    const rig = makeRig({ db });
    newJob(db);
    newJob(db);
    newJob(db);
    const out = await drainQueue(rig.worker, { maxJobs: 2 });
    assert.equal(out.stoppedBecause, "limit");
    assert.equal(out.finished.length, 2);
    const queued = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").get() as { n: number };
    assert.equal(Number(queued.n), 1);
  });

  it("stops at the first blocked job", async () => {
    const rig = makeRig({ db, cleanup: badCleanup });
    newJob(db);
    newJob(db);
    const out = await drainQueue(rig.worker, { maxJobs: 5 });
    assert.equal(out.stoppedBecause, "stopped");
    assert.deepEqual(out.finished.map((f) => f.outcome), ["blocked"]);
    const queued = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").get() as { n: number };
    assert.equal(Number(queued.n), 1);
  });

  it("an empty queue is idle", async () => {
    const rig = makeRig({ db });
    assert.deepEqual(await drainQueue(rig.worker, { maxJobs: 1 }), { finished: [], stoppedBecause: "idle" });
  });

  it("rejects an invalid bound", async () => {
    const rig = makeRig({ db });
    for (const n of [0, -1, 101, 1.5, Number.NaN]) {
      await assert.rejects(() => drainQueue(rig.worker, { maxJobs: n }));
    }
  });
});

// ---------------------------------------------------------------------------
// Tester report for the pipeline
// ---------------------------------------------------------------------------

describe("buildPipelineTesterReport", () => {
  const req: PipelineRequest = { executionId: "j:1", fixture: "fx1" };

  it("passes only when the pipeline succeeded with confirmed evidence", () => {
    const r = buildPipelineTesterReport(successResult(req));
    assert.equal(r.status, "passed");
    assert.equal(r.reason, "all-stages-passed");
    assert.equal(r.source, "runner-observation");
  });

  it("reports an observed failure and leaves later stages unobserved", () => {
    const r = buildPipelineTesterReport(failureResult(req));
    assert.equal(r.status, "failed");
    assert.equal(r.install.status, "passed");
    assert.equal(r.build.status, "failed");
    assert.equal(r.test.status, "not-run");
    assert.equal(r.test.reason, "not-observed");
  });

  it("reports an observed install failure", () => {
    const r = buildPipelineTesterReport({
      ...failureResult(req),
      reason: "install-failed", failedStage: "install",
      stages: [st("prepare", "passed"), st("install", "failed", { reason: "exit-code", exitCode: 1 }), st("build", "skipped"), st("test", "skipped")],
    });
    assert.equal(r.status, "failed");
    assert.equal(r.install.status, "failed");
    assert.equal(r.build.status, "not-run");
  });

  it("treats missing tests as not-run, not as passed or failed", () => {
    const r = buildPipelineTesterReport(noTestsResult(req));
    assert.equal(r.status, "not-run");
    assert.equal(r.reason, "tests-not-run");
  });

  it("downgrades a claimed pass when cleanup, staging removal, truncation or stages are missing", () => {
    const base = successResult(req);
    const cases: ControlledPipelineResult[] = [
      { ...base, cleanup: null },
      { ...base, cleanup: { confirmed: false, reason: "x" } },
      { ...base, stagingRemoved: false },
      { ...base, stagingRemoved: null },
      { ...base, truncated: true },
      { ...base, stages: null },
      { ...base, executionId: null },
    ];
    for (const c of cases) {
      const r = buildPipelineTesterReport(c);
      assert.equal(r.status, "not-run");
      assert.equal(r.reason, "evidence-unconfirmed");
    }
  });

  it("does not pass when the pipeline verdict itself is not success", () => {
    const r = buildPipelineTesterReport({ ...successResult(req), status: "not-run", reason: "summary-mismatch" });
    assert.equal(r.status, "not-run");
    assert.equal(r.reason, "stage-not-run");
  });

  it("a stage that failed for a non-exit reason (timeout) is inconclusive, not a failure", () => {
    const r = buildPipelineTesterReport({
      ...failureResult(req),
      stages: [st("prepare", "passed"), st("install", "passed"), st("build", "failed", { reason: "timeout" }), st("test", "skipped")],
    });
    assert.equal(r.build.status, "not-run");
    assert.equal(r.build.reason, "inconclusive");
    assert.equal(r.status, "not-run");
  });

  it("never copies container text into the report", () => {
    const r = buildPipelineTesterReport(failureResult(req));
    assert.ok(!JSON.stringify(r).includes("intentional build failure"));
  });
});

// ---------------------------------------------------------------------------
// Evidence and catalog helpers
// ---------------------------------------------------------------------------

describe("buildEvidence", () => {
  const req: PipelineRequest = { executionId: "j:1", fixture: "fx1" };

  it("truncates large files and marks them incomplete", () => {
    const big: SourceFile = { path: "big.mjs", text: "a".repeat(10_000), complete: true };
    const items = buildEvidence(failureResult(req), [big]);
    assert.ok(items);
    const f = items[1];
    assert.equal(f?.kind, "file");
    assert.equal(f?.complete, false);
    assert.ok((f?.text.length ?? 0) <= 3500);
  });

  it("keeps small complete files complete", () => {
    const items = buildEvidence(failureResult(req), SOURCE_FILES);
    assert.equal(items?.[1]?.complete, true);
  });

  it("refuses more than six files and duplicate paths", () => {
    const many = Array.from({ length: 7 }, (_, i): SourceFile => ({ path: `f${i}.mjs`, text: "x", complete: true }));
    assert.equal(buildEvidence(failureResult(req), many), null);
    assert.equal(buildEvidence(failureResult(req), [SOURCE_FILES[0] as SourceFile, SOURCE_FILES[0] as SourceFile]), null);
  });
});

describe("readFixtureEvidence and createCatalogResolver", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "graveyard-catalog-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fixture(name: string, files: Record<string, string>): void {
    mkdirSync(join(root, name));
    for (const [n, t] of Object.entries(files)) writeFileSync(join(root, name, n), t);
  }

  it("reads the fixed file names only", () => {
    fixture("fx1", { "package.json": "{}", "build.mjs": "b", "test.mjs": "t", "secret.txt": "nope" });
    const files = readFixtureEvidence(root, "fx1");
    assert.deepEqual(files?.map((f) => f.path), ["package.json", "build.mjs", "test.mjs"]);
    assert.ok(files?.every((f) => f.complete));
  });

  it("test.mjs is optional, build.mjs and package.json are required", () => {
    fixture("ok", { "package.json": "{}", "build.mjs": "b" });
    fixture("nobuild", { "package.json": "{}" });
    fixture("nopkg", { "build.mjs": "b" });
    assert.equal(readFixtureEvidence(root, "ok")?.length, 2);
    assert.equal(readFixtureEvidence(root, "nobuild"), null);
    assert.equal(readFixtureEvidence(root, "nopkg"), null);
  });

  it("refuses bad names, relative roots, missing directories and oversized files", () => {
    fixture("big", { "package.json": "x".repeat(70_000), "build.mjs": "b" });
    assert.equal(readFixtureEvidence(root, "../x"), null);
    assert.equal(readFixtureEvidence(root, "nothere"), null);
    assert.equal(readFixtureEvidence("relative/root", "fx1"), null);
    assert.equal(readFixtureEvidence(root, "big"), null);
  });

  it("marks files over 3500 bytes incomplete", () => {
    fixture("long", { "package.json": "{}", "build.mjs": "x".repeat(4000) });
    const files = readFixtureEvidence(root, "long");
    assert.equal(files?.find((f) => f.path === "build.mjs")?.complete, false);
  });

  it("the catalog resolves exact URLs only", async () => {
    fixture("fx1", { "package.json": "{}", "build.mjs": "b" });
    const resolve = createCatalogResolver({ [REPO]: "fx1" }, root);
    const hit = await resolve(REPO);
    assert.equal(hit?.fixture, "fx1");
    assert.equal(await resolve(`${REPO}/`), null);
    assert.equal(await resolve("https://github.com/o/R"), null);
    assert.equal(await resolve("constructor"), null);
    assert.equal(await resolve("__proto__"), null);
  });

  it("the catalog resolves to null when the evidence cannot be read", async () => {
    const resolve = createCatalogResolver({ [REPO]: "missing" }, root);
    assert.equal(await resolve(REPO), null);
  });

  it("a job for a catalog URL runs end to end with the files read from disk", async () => {
    fixture("fx1", { "package.json": "{}", "build.mjs": "throw new Error('x')\n" });
    const agents = new FakeAgents();
    const rig = makeRig({ db, make: failureResult, agents, resolve: createCatalogResolver({ [REPO]: "fx1" }, root) });
    const id = newJob(db);
    await rig.worker.runOnce();
    assert.equal(row(db, id)["status"], "completed");
    assert.deepEqual(agents.analyses[0]?.evidence.map((e) => e.path ?? null), [null, "package.json", "build.mjs"]);
  });
});
