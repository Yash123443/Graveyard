/**
 * github-runner.test.ts — the GitHub repository flow of the opt-in worker, with every dependency
 * injected: analysis, root-file reading, the egress guard, the runner through the real JobWorker and
 * lease code, result presentation, configuration and composition.
 *
 * No Docker, no network, no git, no repository code. Fakes stand in for the acquisition adapters,
 * the registry acquisition and the offline pipeline; the real filesystem under os.tmpdir() is used
 * for run directories. Nothing here shows that the real flow works against Docker or GitHub.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import { createJob } from "../jobs.js";
import { generateRawToken } from "../token.js";
import { JobWorker } from "../worker.js";
import { presentResult } from "../result-view.js";
import { validateEgressAttestation } from "../acquisition-policy.js";
import type { AcquisitionRequest, AcquisitionResult, HandoffInfo } from "../git-acquisition.js";
import type { ProcessExecutor, ProcessOptions, ProcessResult } from "../docker-sandbox.js";
import type { CleanupProof, CleanupRequest, RunContext } from "../runner.js";
import type { ControlledPipelineResult, PipelineRequest } from "../controlled-pipeline.js";
import type { StageResult as DriverStage } from "../fixture-pipeline-driver.js";
import type { Diagnosis, PatchProposal } from "../agent-contract.js";
import type { AgentOutcome, AnalystRequest, FixerRequest } from "../kiro-agent.js";
import { OPERATOR_FIXTURE_ID, type RegistryAcquisitionRequest, type RegistryAcquisitionResult } from "../npm-registry-acquisition.js";
import { MAX_ROOT_FILE_BYTES, analyzeRootFiles, type RootFiles } from "../github-analysis.js";
import { readRootFiles } from "../github-source.js";
import { EGRESS_PROXY_LABEL, OperatorEgressGuard } from "../egress-guard.js";
import { GithubJobRunner, deriveRegistryExecutionId, type GitLike, type RegistryLike } from "../github-runner.js";
import { PipelineJobRunner, REPOSITORY_UNSUPPORTED_REASON, type AgentsLike, type PipelineLike, type SourceFile } from "../pipeline-runner.js";
import { WorkerConfigError, loadWorkerConfig, parsePins } from "../worker-config.js";
import { composeWorker } from "../worker-compose.js";
import { operatorDoc, textsOf } from "./operator-fixture-helpers.js";

const REPO = "https://github.com/o/r";
const FIXTURE_REPO = "https://github.com/f/fixture";
const COMMIT = "a".repeat(40);
const BUILD_MJS = 'console.log("built");\n';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function supportedFiles(): RootFiles {
  const t = textsOf(operatorDoc());
  return { packageJson: t.packageJson, packageLock: t.packageLock, buildMjs: BUILD_MJS, testMjs: 'import "node:test";\n', unusable: [] };
}

const okProof = (executionId: string): CleanupProof => ({ confirmed: true, executionId, evidence: "fake docker: nothing carries this id" });

const st = (stage: DriverStage["stage"], status: DriverStage["status"], extra: Partial<DriverStage> = {}): DriverStage => ({
  stage, status, durationMs: 5, ...extra,
});

function successResult(req: PipelineRequest): ControlledPipelineResult {
  return {
    status: "success", reason: "ok", detail: "ok", failedStage: null,
    stages: [st("prepare", "passed"), st("install", "passed"), st("build", "passed"), st("test", "passed")],
    exitCode: 0, durationMs: 10, truncated: false, stderrTail: "", packagesAdded: 3, expectedPackages: 3,
    violations: [], cleanup: okProof(req.executionId), stagingRemoved: true, driverSha256: "b".repeat(64),
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

class FakePipeline implements PipelineLike {
  readonly requests: PipelineRequest[] = [];
  constructor(private readonly make: (req: PipelineRequest) => ControlledPipelineResult) {}
  run(req: PipelineRequest): Promise<ControlledPipelineResult> {
    this.requests.push(req);
    return Promise.resolve(this.make(req));
  }
}

const diagnosis: Diagnosis = {
  category: "build-failure",
  summary: "build.mjs throws",
  rootCause: "build.mjs throws on purpose",
  confidence: "medium",
  evidenceRefs: ["stage-result"],
  affectedFiles: ["build.mjs"],
};
const proposal: PatchProposal = {
  summary: "remove the throw",
  diff: "--- a/build.mjs\n+++ b/build.mjs\n@@ -1 +1 @@\n-throw new Error(\"x\");\n+console.log(\"ok\");\n",
  files: ["build.mjs"],
  hunks: 1,
  added: 1,
  removed: 1,
  contextVerified: true,
  proposalOnly: true,
};
class FakeAgents implements AgentsLike {
  readonly analyses: AnalystRequest[] = [];
  analyze(req: AnalystRequest): Promise<AgentOutcome<Diagnosis>> {
    this.analyses.push(req);
    return Promise.resolve<AgentOutcome<Diagnosis>>({ status: "ok", role: "analyst", value: diagnosis });
  }
  propose(_req: FixerRequest): Promise<AgentOutcome<PatchProposal>> {
    return Promise.resolve<AgentOutcome<PatchProposal>>({ status: "ok", role: "fixer", value: proposal });
  }
}

const acquired = (): AcquisitionResult => ({
  kind: "acquired",
  commit: COMMIT,
  manifest: { files: 3, totalBytes: 100, submodulesSkipped: 0 },
  durationMs: 1,
  cleanup: okProof("x"),
});

const handoffInfo = (): HandoffInfo => ({
  containerName: "graveyard-acq-test",
  commit: COMMIT,
  manifest: { files: 3, totalBytes: 100, submodulesSkipped: 0 },
  dockerBinary: "docker",
  remainingMs: 100_000,
});

// ---------------------------------------------------------------------------
// Rig: GithubJobRunner + JobWorker + in-memory database
// ---------------------------------------------------------------------------

interface GitState {
  script: (req: AcquisitionRequest) => AcquisitionResult;
  requests: AcquisitionRequest[];
  hookCalls: number;
  files: RootFiles;
  cleanup: (req: { executionId: string }) => Promise<CleanupProof>;
}

interface RegistryState {
  script: (req: RegistryAcquisitionRequest) => RegistryAcquisitionResult;
  requests: RegistryAcquisitionRequest[];
  cleanup: (req: { executionId: string }) => Promise<CleanupProof>;
}

const registryAcquired = (req: RegistryAcquisitionRequest): RegistryAcquisitionResult =>
  ({
    kind: "acquired",
    cacheDir: join(req.runDir, "cache"),
    summary: { entries: 0 },
    packagesAdded: 3,
    durationMs: 1,
    cleanup: okProof(req.executionId),
    stagingRemoved: true,
    driverSha256: "c".repeat(64),
    executionId: req.executionId,
  }) as unknown as RegistryAcquisitionResult;

interface Rig {
  db: DatabaseSync;
  worker: JobWorker;
  runner: GithubJobRunner;
  git: GitState;
  registry: RegistryState | null;
  pipeline: FakePipeline;
  fixturePipeline: FakePipeline;
  makePipelineCalls: Array<{ runDir: string; cacheDir: string }>;
  runsRoot: string;
  seenDuringRun: { fixtureFiles: string[] | null };
}

let tmp: string;
let db: DatabaseSync;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "graveyard-github-runner-"));
  db = openDatabase(":memory:");
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

function makeRig(opts: {
  registry?: boolean;
  make?: (req: PipelineRequest) => ControlledPipelineResult;
  agents?: AgentsLike;
  files?: RootFiles;
} = {}): Rig {
  const runsRoot = join(tmp, "runs");
  mkdirSync(runsRoot, { recursive: true });
  const git: GitState = {
    script: acquired,
    requests: [],
    hookCalls: 0,
    files: opts.files ?? supportedFiles(),
    cleanup: (req) => Promise.resolve(okProof(req.executionId)),
  };
  const registry: RegistryState | null =
    opts.registry === false ? null : { script: registryAcquired, requests: [], cleanup: (req) => Promise.resolve(okProof(req.executionId)) };
  const seenDuringRun: Rig["seenDuringRun"] = { fixtureFiles: null };
  const makePipelineCalls: Rig["makePipelineCalls"] = [];
  const pipeline = new FakePipeline((req) => {
    // Record what the offline stage would be able to read from the run directory.
    const call = makePipelineCalls[makePipelineCalls.length - 1];
    if (call !== undefined) {
      const dir = join(call.runDir, req.fixture);
      seenDuringRun.fixtureFiles = existsSync(dir) ? readdirSync(dir).sort() : [];
    }
    return (opts.make ?? successResult)(req);
  });
  const fixturePipeline = new FakePipeline(successResult);

  const gitLike = (hook: (info: HandoffInfo) => Promise<void>): GitLike => ({
    acquire: async (req) => {
      git.requests.push(req);
      const r = git.script(req);
      if (r.kind === "acquired") {
        git.hookCalls += 1;
        await hook(handoffInfo());
        return { ...r, cleanup: okProof(req.executionId) };
      }
      return r;
    },
    cleanup: (req) => git.cleanup(req),
  });

  const fixtureSource: SourceFile[] = [{ path: "package.json", text: "{}\n", complete: true }];
  const cleanupExecution = (id: string): Promise<CleanupProof> => Promise.resolve(okProof(id));
  const fallback = new PipelineJobRunner({
    resolve: (url) => (url === FIXTURE_REPO ? { fixture: "fx1", files: fixtureSource } : null),
    pipeline: fixturePipeline,
    cleanupExecution,
  });
  const runner = new GithubJobRunner({
    fallback,
    fixtureUrls: new Set([FIXTURE_REPO]),
    pins: new Map([[REPO, COMMIT], [FIXTURE_REPO, COMMIT]]),
    runsRoot,
    gitImage: "alpine/git:2.47.2",
    makeGit: gitLike,
    readRootFiles: () => Promise.resolve(git.files),
    registry:
      registry === null
        ? null
        : {
            acquire: (req) => {
              registry.requests.push(req);
              return Promise.resolve(registry.script(req));
            },
            cleanup: (req) => registry.cleanup(req),
          } satisfies RegistryLike,
    makePipeline: (runDir, cacheDir) => {
      makePipelineCalls.push({ runDir, cacheDir });
      return pipeline;
    },
    cleanupExecution,
    ...(opts.agents === undefined ? {} : { agents: opts.agents }),
  });
  const worker = new JobWorker({ db, workerId: "w-test", runner });
  return { db, worker, runner, git, registry, pipeline, fixturePipeline, makePipelineCalls, runsRoot, seenDuringRun };
}

const newJob = (url: string = REPO): string => createJob(db, { repoUrl: url, rawToken: generateRawToken() }).jobId;

function row(id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown>;
}
function events(id: string): Array<{ type: string; payload: Record<string, unknown> }> {
  const rows = db.prepare("SELECT event_type, payload FROM job_events WHERE job_id = ? ORDER BY seq").all(id) as Array<{
    event_type: string;
    payload: string;
  }>;
  return rows.map((r) => ({ type: r.event_type, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}
const stageNames = (id: string): unknown[] => events(id).filter((e) => e.type === "stage").map((e) => e.payload["stage"]);
function resultOf(id: string): Record<string, unknown> | null {
  const e = events(id).filter((x) => x.type === "result");
  if (e.length === 0) return null;
  assert.equal(e.length, 1);
  return (e[0] as { payload: Record<string, unknown> }).payload["result"] as Record<string, unknown>;
}
function infraOf(id: string): { kind: string; message: string } | null {
  const raw = row(id)["infra_error"] as string | null;
  return raw === null ? null : (JSON.parse(raw) as { kind: string; message: string });
}
const findingCodes = (result: Record<string, unknown>): string[] =>
  ((result["analysis"] as { findings: Array<{ code: string }> }).findings).map((f) => f.code);

// ---------------------------------------------------------------------------
// Pure analysis
// ---------------------------------------------------------------------------

describe("analyzeRootFiles", () => {
  it("accepts a package.json without scripts, a lockfile v3 within policy and a build.mjs", () => {
    const a = analyzeRootFiles(supportedFiles(), { dependencyAcquisition: true });
    assert.equal(a.supported, true);
    assert.deepEqual(a.findings, []);
    assert.equal(a.facts.expectedPackages, 3);
    assert.equal(a.facts.lockfileVersion, 3);
    assert.equal(a.facts.packageJson?.scriptCount, 0);
    assert.equal(a.facts.present.testMjs, true);
  });

  it("reports each missing required file with its own code", () => {
    const a = analyzeRootFiles({ packageJson: null, packageLock: null, buildMjs: null, testMjs: null, unusable: [] }, { dependencyAcquisition: true });
    assert.equal(a.supported, false);
    assert.deepEqual(a.findings.map((f) => f.code), ["no-package-json", "no-package-lock", "no-build-script"]);
  });

  it("rejects an ordinary project whose package.json has npm scripts, and counts them", () => {
    const d = operatorDoc();
    d.pkg["scripts"] = { build: "tsc", test: "jest" };
    const t = textsOf(d);
    const a = analyzeRootFiles({ ...supportedFiles(), packageJson: t.packageJson, packageLock: t.packageLock }, { dependencyAcquisition: true });
    assert.equal(a.supported, false);
    assert.ok(a.findings.every((f) => f.code === "dependency-policy-rejected"));
    assert.equal(a.facts.packageJson?.scriptCount, 2);
    assert.equal(a.facts.expectedPackages, null);
  });

  it("rejects a lockfile version other than 3", () => {
    const d = operatorDoc();
    d.lock["lockfileVersion"] = 2;
    const t = textsOf(d);
    const a = analyzeRootFiles({ ...supportedFiles(), packageJson: t.packageJson, packageLock: t.packageLock }, { dependencyAcquisition: true });
    assert.equal(a.supported, false);
    assert.equal(a.facts.lockfileVersion, 2);
  });

  it("does not crash on files that are not JSON", () => {
    const a = analyzeRootFiles({ ...supportedFiles(), packageJson: "not json", packageLock: "{" }, { dependencyAcquisition: true });
    assert.equal(a.supported, false);
    assert.equal(a.facts.packageJson?.parsed, false);
    assert.equal(a.facts.lockfileVersion, null);
  });

  it("reports an unusable root file once and does not also say it is missing", () => {
    const a = analyzeRootFiles({ ...supportedFiles(), buildMjs: null, unusable: ["build.mjs"] }, { dependencyAcquisition: true });
    assert.deepEqual(a.findings.map((f) => f.code), ["file-unusable"]);
  });

  it("an otherwise supported repository is not runnable without registry egress", () => {
    const a = analyzeRootFiles(supportedFiles(), { dependencyAcquisition: false });
    assert.equal(a.supported, false);
    assert.deepEqual(a.findings.map((f) => f.code), ["dependency-acquisition-not-configured"]);
  });
});

// ---------------------------------------------------------------------------
// Root-file reader (executor is a fake; no Docker)
// ---------------------------------------------------------------------------

describe("readRootFiles", () => {
  const SHA = (c: string): string => c.repeat(40);
  const proc = (extra: Partial<ProcessResult>): ProcessResult => ({
    exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, ...extra,
  });

  function scripted(listing: string, blobs: Record<string, ProcessResult>): { exec: ProcessExecutor; calls: string[][] } {
    const calls: string[][] = [];
    const exec: ProcessExecutor = (_file: string, args: readonly string[], _o: ProcessOptions) => {
      calls.push([...args]);
      if (args.includes("ls-tree")) return Promise.resolve(proc({ stdout: listing }));
      const id = args[args.length - 1] as string;
      return Promise.resolve(blobs[id] ?? proc({ exitCode: 128 }));
    };
    return { exec, calls };
  }

  it("lists the root with fixed names, then reads each regular file as a raw blob", async () => {
    const listing = `100644 blob ${SHA("1")}\tpackage.json\x00100755 blob ${SHA("2")}\tbuild.mjs\0`;
    const { exec, calls } = scripted(listing, {
      [SHA("1")]: proc({ stdout: '{"name":"x"}' }),
      [SHA("2")]: proc({ stdout: "export {};" }),
    });
    const files = await readRootFiles(exec, handoffInfo());
    assert.equal(files.packageJson, '{"name":"x"}');
    assert.equal(files.buildMjs, "export {};");
    assert.equal(files.packageLock, null);
    assert.equal(files.testMjs, null);
    assert.deepEqual(files.unusable, []);

    const first = calls[0] as string[];
    assert.deepEqual(first.slice(0, 8), ["exec", "--user", "65532:65532", "--workdir", "/work", "graveyard-acq-test", "git", "ls-tree"]);
    assert.deepEqual(first.slice(-5), ["--", "package.json", "package-lock.json", "build.mjs", "test.mjs"].slice(-5));
    assert.ok(calls.every((c) => !c.includes("sh") && !c.includes("-c")), "no shell is involved");
    assert.deepEqual((calls[1] as string[]).slice(-3), ["cat-file", "blob", SHA("1")]);
  });

  it("marks a directory, a submodule and an oversize file unusable without reading the first two", async () => {
    const listing = [
      `040000 tree ${SHA("3")}\tpackage.json`,
      `160000 commit ${SHA("4")}\tbuild.mjs`,
      `100644 blob ${SHA("5")}\ttest.mjs`,
    ].join("\0");
    const big = "x".repeat(MAX_ROOT_FILE_BYTES + 1);
    const { exec, calls } = scripted(listing, { [SHA("5")]: proc({ stdout: big, truncated: true }) });
    const files = await readRootFiles(exec, handoffInfo());
    assert.deepEqual(files.unusable, ["build.mjs", "package.json", "test.mjs"]);
    assert.equal(files.packageJson, null);
    assert.equal(calls.length, 2, "only the one regular blob was read");
  });

  it("throws on an unexpected tree entry, a failed read, a timeout and an abort", async () => {
    await assert.rejects(readRootFiles(scripted(`100644 blob ${SHA("1")}\tother.txt`, {}).exec, handoffInfo()));
    await assert.rejects(readRootFiles(scripted(`100644 blob ${SHA("1")}\tpackage.json`, {}).exec, handoffInfo()));
    const timedOut: ProcessExecutor = () => Promise.resolve(proc({ timedOut: true, exitCode: null }));
    await assert.rejects(readRootFiles(timedOut, handoffInfo()));
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(readRootFiles(scripted("", {}).exec, { ...handoffInfo(), signal: ac.signal }));
    await assert.rejects(readRootFiles(scripted("", {}).exec, { ...handoffInfo(), remainingMs: 10 }));
  });
});

// ---------------------------------------------------------------------------
// Runner through JobWorker
// ---------------------------------------------------------------------------

describe("deriveRegistryExecutionId", () => {
  it("is different from the execution id and keeps the attempt", () => {
    assert.equal(deriveRegistryExecutionId("abc-123:2"), "abc-123-npm:2");
    assert.equal(deriveRegistryExecutionId("not valid"), null);
    assert.equal(deriveRegistryExecutionId("abc:"), null);
  });
});

describe("GithubJobRunner through JobWorker: supported repository", () => {
  it("fetches the pin, acquires dependencies, runs the offline pipeline and records a verified github-pinned result", async () => {
    const rig = makeRig();
    const id = newJob();
    const res = await rig.worker.runOnce();
    assert.deepEqual(res, { kind: "finished", jobId: id, outcome: "completed" });

    assert.equal(rig.git.requests.length, 1);
    assert.equal(rig.git.requests[0]?.repoUrl, REPO);
    assert.equal(rig.git.requests[0]?.commit, COMMIT, "the pinned commit, never a branch");
    assert.equal(rig.git.requests[0]?.executionId, `${id}:1`);
    assert.equal(rig.git.hookCalls, 1);

    assert.equal(rig.registry?.requests.length, 1);
    const acq = rig.registry?.requests[0] as RegistryAcquisitionRequest;
    assert.equal(acq.fixture, OPERATOR_FIXTURE_ID);
    assert.equal(acq.executionId, `${id}-npm:1`);
    assert.deepEqual(acq.operatorFixture, { packageJson: supportedFiles().packageJson, packageLock: supportedFiles().packageLock });

    assert.equal(rig.makePipelineCalls.length, 1);
    assert.equal(rig.makePipelineCalls[0]?.cacheDir, join(acq.runDir, "cache"));
    assert.equal(rig.pipeline.requests[0]?.executionId, `${id}:1`);
    assert.deepEqual(rig.seenDuringRun.fixtureFiles, ["build.mjs", "package-lock.json", "package.json", "test.mjs"]);

    assert.equal(row(id)["status"], "completed");
    assert.deepEqual(stageNames(id), ["cloning", "analyzing", "building", "testing"]);
    const result = resultOf(id) as Record<string, unknown>;
    assert.equal(result["verdict"], "verified");
    assert.equal(result["sourceKind"], "github-pinned");
    assert.deepEqual(result["source"], { repoUrl: REPO, commit: COMMIT });
    assert.deepEqual(readdirSync(rig.runsRoot), [], "the run directory is removed");
    assert.equal(infraOf(id), null);

    const view = presentResult({
      jobId: id, stage: "done", status: "completed", attemptCount: 1, maxAttempts: 2, infraError: null, result,
    });
    assert.equal(view.outcome, "passing");
    assert.match(view.summary, /GitHub repository/);
    assert.doesNotMatch(view.summary, /operator-prepared/);
    assert.equal(view.repair.verified, false);
    assert.equal(view.repair.patchApplied, false);
  });

  it("a failing build is a github-pinned repository-failing result with a diagnosis and an unapplied proposal", async () => {
    const agents = new FakeAgents();
    const rig = makeRig({ make: failureResult, agents });
    const id = newJob();
    await rig.worker.runOnce();
    assert.deepEqual(stageNames(id), ["cloning", "analyzing", "building", "testing", "diagnosing", "repairing", "verifying"]);
    const result = resultOf(id) as Record<string, unknown>;
    assert.equal(result["verdict"], "repository-failing");
    assert.equal(result["sourceKind"], "github-pinned");
    assert.equal((result["fixer"] as Record<string, unknown>)["applied"], false);
    // The fake proposal does not match the root build.mjs, so the verifier refuses it and runs nothing.
    assert.equal((result["verification"] as Record<string, unknown>)["status"], "not-attempted");
    assert.equal(rig.pipeline.requests.length, 1);
    assert.equal(agents.analyses.length, 1);
    const view = presentResult({ jobId: id, stage: "done", status: "completed", attemptCount: 1, maxAttempts: 2, infraError: null, result });
    assert.equal(view.outcome, "failing-with-patch-proposal");
    assert.doesNotMatch(view.summary, /operator-prepared/);
    assert.equal(view.repair.verified, false);
  });

  it("a refused registry acquisition fails the job with the reason and no result, and never starts the offline stage", async () => {
    const rig = makeRig();
    (rig.registry as RegistryState).script = () =>
      ({ kind: "network-unavailable", reason: "egress not verified", cleanup: null, stagingRemoved: null, driverSha256: null, executionId: "x" }) as RegistryAcquisitionResult;
    const id = newJob();
    const res = await rig.worker.runOnce();
    assert.deepEqual(res, { kind: "finished", jobId: id, outcome: "failed" });
    assert.equal(rig.pipeline.requests.length, 0);
    assert.equal(resultOf(id), null);
    const e = infraOf(id);
    assert.equal(e?.kind, "infrastructure-unavailable");
    assert.match(e?.message ?? "", /network-unavailable/);
    assert.deepEqual(readdirSync(rig.runsRoot), []);
  });
});

describe("GithubJobRunner through JobWorker: unsupported repository", () => {
  it("completes with unsupported-repository and the exact findings, runs nothing", async () => {
    const rig = makeRig({ files: { ...supportedFiles(), buildMjs: null } });
    const id = newJob();
    const res = await rig.worker.runOnce();
    assert.deepEqual(res, { kind: "finished", jobId: id, outcome: "completed" });
    assert.deepEqual(stageNames(id), ["cloning", "analyzing"]);
    assert.equal(rig.registry?.requests.length, 0);
    assert.equal(rig.pipeline.requests.length, 0);
    assert.equal(rig.makePipelineCalls.length, 0);

    const result = resultOf(id) as Record<string, unknown>;
    assert.equal(result["verdict"], "unsupported-repository");
    assert.equal(result["sourceKind"], "github-pinned");
    assert.deepEqual(findingCodes(result), ["no-build-script"]);
    assert.deepEqual(readdirSync(rig.runsRoot), []);

    const view = presentResult({ jobId: id, stage: "done", status: "completed", attemptCount: 1, maxAttempts: 2, infraError: null, result });
    assert.equal(view.outcome, "unsupported-repository");
    assert.equal(view.repair.diagnosed, false);
    assert.equal(view.repair.verified, false);
  });

  it("reports a supported repository as not runnable when registry egress is not configured", async () => {
    const rig = makeRig({ registry: false });
    const id = newJob();
    await rig.worker.runOnce();
    const result = resultOf(id) as Record<string, unknown>;
    assert.equal(result["verdict"], "unsupported-repository");
    assert.deepEqual(findingCodes(result), ["dependency-acquisition-not-configured"]);
    assert.equal(rig.pipeline.requests.length, 0);
  });

  it("a tree rejected by the acquisition policy is an unsupported result, not an infrastructure failure", async () => {
    const rig = makeRig();
    rig.git.script = () => ({ kind: "source-rejected", reason: "tree contains a symbolic link", cleanup: okProof("x") });
    const id = newJob();
    const res = await rig.worker.runOnce();
    assert.deepEqual(res, { kind: "finished", jobId: id, outcome: "completed" });
    const result = resultOf(id) as Record<string, unknown>;
    assert.equal(result["verdict"], "unsupported-repository");
    assert.deepEqual(findingCodes(result), ["source-policy-rejected"]);
    assert.equal(rig.git.hookCalls, 0);
  });
});

describe("GithubJobRunner through JobWorker: fail-closed paths", () => {
  const refusals: Array<[string, AcquisitionResult]> = [
    ["network-unavailable", { kind: "network-unavailable", reason: "no controlled egress proxy is configured", cleanup: null }],
    ["unavailable", { kind: "unavailable", reason: "docker daemon is not available", cleanup: null }],
    ["isolation-violation", { kind: "isolation-violation", reason: "capabilities not dropped", cleanup: okProof("x") }],
    ["failed", { kind: "failed", step: "fetch", reason: "fatal: not found", cleanup: okProof("x") }],
    ["timed-out", { kind: "timed-out", step: "fetch", cleanup: okProof("x") }],
    ["rejected", { kind: "rejected", reason: "invalid execution id", cleanup: null }],
  ];
  for (const [name, outcome] of refusals) {
    it(`acquisition ${name} fails the job without a result`, async () => {
      const rig = makeRig();
      rig.git.script = () => outcome;
      const id = newJob();
      const res = await rig.worker.runOnce();
      assert.deepEqual(res, { kind: "finished", jobId: id, outcome: "failed" });
      assert.equal(resultOf(id), null);
      assert.equal(infraOf(id)?.kind, "infrastructure-unavailable");
      assert.match(infraOf(id)?.message ?? "", new RegExp(name));
      assert.equal(rig.registry?.requests.length, 0);
      assert.equal(rig.pipeline.requests.length, 0);
      assert.deepEqual(readdirSync(rig.runsRoot), []);
    });
  }

  it("an acquisition whose container cleanup is unconfirmed is not used", async () => {
    const reports: string[] = [];
    let hookRan = false;
    const unconfirmed: CleanupProof = { confirmed: false, reason: "container still present after removal" };
    const makeGit = (hook: (i: HandoffInfo) => Promise<void>): GitLike => ({
      acquire: async () => {
        await hook(handoffInfo());
        hookRan = true;
        return { ...acquired(), cleanup: unconfirmed };
      },
      cleanup: () => Promise.resolve(unconfirmed),
    });
    const rig = makeRig();
    const runner = new GithubJobRunner({
      fallback: new PipelineJobRunner({ resolve: () => null, pipeline: rig.fixturePipeline, cleanupExecution: (id) => Promise.resolve(okProof(id)) }),
      fixtureUrls: new Set(),
      pins: new Map([[REPO, COMMIT]]),
      runsRoot: rig.runsRoot,
      gitImage: "alpine/git:2.47.2",
      makeGit,
      readRootFiles: () => Promise.resolve(supportedFiles()),
      registry: null,
      makePipeline: () => rig.pipeline,
      cleanupExecution: (id) => Promise.resolve(okProof(id)),
    });
    const ctx: RunContext = {
      jobId: "j", repoUrl: REPO, executionId: "j:1", attempt: 1, deadlineAt: new Date().toISOString(), signal: new AbortController().signal,
      report: {
        stage: (s) => { reports.push(`stage:${s}`); return true; },
        result: () => { reports.push("result"); return true; },
      },
    };
    const out = await runner.run(ctx);
    assert.equal(hookRan, true);
    assert.equal(out.kind, "infrastructure-unavailable");
    assert.deepEqual(reports, ["stage:cloning"], "nothing was analysed and no result was recorded");
    assert.deepEqual(readdirSync(rig.runsRoot), []);
    assert.equal((await runner.cleanup({ jobId: "j", executionId: "j:1", attempt: 1, workerId: null })).confirmed, false);
  });

  it("an unpinned repository is refused by the fallback and nothing is fetched", async () => {
    const rig = makeRig();
    const id = newJob("https://github.com/someone/else");
    await rig.worker.runOnce();
    assert.equal(row(id)["status"], "failed");
    assert.equal(infraOf(id)?.message, REPOSITORY_UNSUPPORTED_REASON);
    assert.equal(rig.git.requests.length, 0);
    assert.equal(rig.registry?.requests.length, 0);
  });

  it("a URL in the fixture catalog goes to the fixture runner even when it is also pinned", async () => {
    const rig = makeRig();
    const id = newJob(FIXTURE_REPO);
    await rig.worker.runOnce();
    assert.equal(rig.git.requests.length, 0);
    assert.equal(rig.fixturePipeline.requests.length, 1);
    assert.equal((resultOf(id) as Record<string, unknown>)["sourceKind"], "controlled-fixture");
  });

  it("refuses to run without a progress channel", async () => {
    const rig = makeRig();
    const ctx: RunContext = {
      jobId: "j", repoUrl: REPO, executionId: "j:1", attempt: 1, deadlineAt: new Date().toISOString(), signal: new AbortController().signal,
    };
    const out = await rig.runner.run(ctx);
    assert.equal(out.kind, "infrastructure-unavailable");
    assert.equal(rig.git.requests.length, 0);
  });
});

describe("GithubJobRunner.cleanup", () => {
  const req = (): CleanupRequest => ({ jobId: "j", executionId: "abc-1:1", attempt: 1, workerId: null });

  it("confirms only when the sandbox, git and registry proofs are all confirmed", async () => {
    const rig = makeRig();
    const p = await rig.runner.cleanup(req());
    assert.equal(p.confirmed, true);
  });

  it("is unconfirmed when the registry proof is unconfirmed", async () => {
    const rig = makeRig();
    (rig.registry as RegistryState).cleanup = () => Promise.resolve({ confirmed: false, reason: "still there" });
    const p = await rig.runner.cleanup(req());
    assert.equal(p.confirmed, false);
  });

  it("is unconfirmed when the git proof is unconfirmed, raises an error or names another execution", async () => {
    const rig = makeRig();
    rig.git.cleanup = () => Promise.resolve({ confirmed: false, reason: "label query failed" });
    assert.equal((await rig.runner.cleanup(req())).confirmed, false);
    rig.git.cleanup = () => Promise.reject(new Error("boom"));
    assert.equal((await rig.runner.cleanup(req())).confirmed, false);
    rig.git.cleanup = () => Promise.resolve(okProof("other:1"));
    assert.equal((await rig.runner.cleanup(req())).confirmed, false);
  });

  it("is unconfirmed for an execution id of an unexpected form", async () => {
    const rig = makeRig();
    const p = await rig.runner.cleanup({ ...req(), executionId: "bad id" });
    assert.equal(p.confirmed, false);
  });
});

// ---------------------------------------------------------------------------
// Egress guard (fake executor)
// ---------------------------------------------------------------------------

describe("OperatorEgressGuard", () => {
  const NET = "graveyard-gh-net";
  const PROXY = "graveyard-gh-proxy";
  const IP = "10.201.5.10";
  const proc = (extra: Partial<ProcessResult>): ProcessResult => ({
    exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, ...extra,
  });
  const netJson = (over: Record<string, unknown> = {}): string =>
    JSON.stringify([{ Name: NET, Internal: true, Driver: "bridge", EnableIPv6: false, IPAM: { Config: [{ Subnet: "10.201.5.0/24", Gateway: "10.201.5.1" }] }, ...over }]);
  const ctrJson = (over: Record<string, unknown> = {}): string =>
    JSON.stringify([
      {
        State: { Running: true },
        Config: { Labels: { [EGRESS_PROXY_LABEL]: "github.com" } },
        HostConfig: { NetworkMode: NET, Privileged: false },
        NetworkSettings: { Networks: { [NET]: { IPAddress: IP }, bridge: { IPAddress: "172.17.0.2" } } },
        ...over,
      },
    ]);

  function guardWith(opts: { net?: string; ctr?: string; probe?: (authority: string) => ProcessResult }): { guard: OperatorEgressGuard; calls: string[][] } {
    const calls: string[][] = [];
    const exec: ProcessExecutor = (_f, args) => {
      calls.push([...args]);
      if (args[0] === "network") return Promise.resolve(proc({ stdout: opts.net ?? netJson() }));
      if (args[0] === "inspect") return Promise.resolve(proc({ stdout: opts.ctr ?? ctrJson() }));
      if (args[0] === "exec") {
        const authority = (args.find((a) => a.startsWith("GRAVEYARD_PROBE_AUTHORITY=")) ?? "").split("=")[1] ?? "";
        return Promise.resolve(opts.probe !== undefined ? opts.probe(authority) : proc({ stdout: "HTTP/1.1 403 Forbidden\n" }));
      }
      return Promise.resolve(proc({ exitCode: 1 }));
    };
    return { guard: new OperatorEgressGuard({ executor: exec, host: "github.com", network: NET, proxyContainer: PROXY, proxyUrl: `http://${IP}:3128` }), calls };
  }

  it("attests exactly github.com after checking the network, the proxy container and two refusals", async () => {
    const { guard, calls } = guardWith({});
    const a = await guard.attest();
    assert.equal(a.verified, true);
    const v = validateEgressAttestation(a);
    assert.equal(v.ok, true);
    if (a.verified) {
      assert.deepEqual([...a.allowedHosts], ["github.com"]);
      assert.equal(a.network, NET);
      assert.equal(a.proxyUrl, `http://${IP}:3128`);
    }
    const probes = calls.filter((c) => c[0] === "exec").map((c) => c.find((x) => x.startsWith("GRAVEYARD_PROBE_AUTHORITY=")));
    assert.deepEqual(probes, ["GRAVEYARD_PROBE_AUTHORITY=example.com:443", "GRAVEYARD_PROBE_AUTHORITY=registry.npmjs.org:443"]);
    assert.ok(calls.every((c) => c[0] !== "sh" && c[0] !== "-c"));
  });

  it("the registry instance probes github.com as the other host and attests registry.npmjs.org", async () => {
    const calls: string[][] = [];
    const exec: ProcessExecutor = (_f, args) => {
      calls.push([...args]);
      if (args[0] === "network") return Promise.resolve(proc({ stdout: netJson() }));
      if (args[0] === "inspect") return Promise.resolve(proc({ stdout: ctrJson({ Config: { Labels: { [EGRESS_PROXY_LABEL]: "registry.npmjs.org" } } }) }));
      return Promise.resolve(proc({ stdout: "HTTP/1.1 403 Forbidden\n" }));
    };
    const g = new OperatorEgressGuard({ executor: exec, host: "registry.npmjs.org", network: NET, proxyContainer: PROXY, proxyUrl: `http://${IP}:3128` });
    const a = await g.attest();
    assert.equal(a.verified, true);
    assert.ok(calls.some((c) => c.includes("GRAVEYARD_PROBE_AUTHORITY=github.com:443")));
  });

  const refused: Array<[string, Parameters<typeof guardWith>[0]]> = [
    ["a network that is not Internal", { net: netJson({ Internal: false }) }],
    ["a network with IPv6", { net: netJson({ EnableIPv6: true }) }],
    ["a proxy address outside the subnet", { net: netJson({ IPAM: { Config: [{ Subnet: "10.99.0.0/24", Gateway: "10.99.0.1" }] } }) }],
    ["a proxy container that is not running", { ctr: ctrJson({ State: { Running: false } }) }],
    ["a proxy container labelled for another host", { ctr: ctrJson({ Config: { Labels: { [EGRESS_PROXY_LABEL]: "registry.npmjs.org" } } }) }],
    ["a proxy container without the label", { ctr: ctrJson({ Config: { Labels: {} } }) }],
    ["a proxy container at another address", { ctr: ctrJson({ NetworkSettings: { Networks: { [NET]: { IPAddress: "10.201.5.99" } } } }) }],
    ["a privileged proxy container", { ctr: ctrJson({ HostConfig: { NetworkMode: NET, Privileged: true } }) }],
    ["a proxy attached to three networks", { ctr: ctrJson({ NetworkSettings: { Networks: { [NET]: { IPAddress: IP }, a: {}, b: {} } } }) }],
    ["a proxy that tunnels to example.com", { probe: (a: string) => proc({ stdout: a.startsWith("example") ? "HTTP/1.1 200 Connection Established\n" : "HTTP/1.1 403 Forbidden\n" }) }],
    ["a proxy that tunnels to the other supported host", { probe: (a: string) => proc({ stdout: a.startsWith("registry") ? "HTTP/1.1 200 OK\n" : "HTTP/1.1 403 Forbidden\n" }) }],
    ["a probe that does not answer", { probe: () => proc({ exitCode: 1 }) }],
    ["a probe that times out", { probe: () => proc({ stdout: "timeout\n" }) }],
  ];
  for (const [name, opts] of refused) {
    it(`does not attest ${name}`, async () => {
      const a = await guardWith(opts).guard.attest();
      assert.equal(a.verified, false);
      assert.equal(validateEgressAttestation(a).ok, false);
    });
  }

  it("does not attest when docker cannot be started, and never throws", async () => {
    const exec: ProcessExecutor = () => Promise.reject(new Error("spawn docker ENOENT"));
    const g = new OperatorEgressGuard({ executor: exec, host: "github.com", network: NET, proxyContainer: PROXY, proxyUrl: `http://${IP}:3128` });
    assert.equal((await g.attest()).verified, false);
  });

  it("does not attest when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    assert.equal((await guardWith({}).guard.attest(ac.signal)).verified, false);
  });

  it("rejects unsafe construction", () => {
    const exec: ProcessExecutor = () => Promise.resolve(proc({}));
    const base = { executor: exec, host: "github.com" as const, network: NET, proxyContainer: PROXY, proxyUrl: `http://${IP}:3128` };
    assert.throws(() => new OperatorEgressGuard({ ...base, network: "bridge" }));
    assert.throws(() => new OperatorEgressGuard({ ...base, network: "-x" }));
    assert.throws(() => new OperatorEgressGuard({ ...base, proxyContainer: "a b" }));
    assert.throws(() => new OperatorEgressGuard({ ...base, proxyUrl: "http://8.8.8.8:3128" }));
    assert.throws(() => new OperatorEgressGuard({ ...base, proxyUrl: "http://proxy.local:3128" }));
    assert.throws(() => new OperatorEgressGuard({ ...base, host: "example.com" as never }));
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("GitHub worker configuration", () => {
  const ROOT = resolve(tmpdir(), "graveyard-github-config-test");
  const p = (n: string): string => join(ROOT, n);
  const PINS = JSON.stringify({ [REPO]: COMMIT });
  const CATALOG = JSON.stringify({ "https://github.com/f/fixture": "fx1" });

  function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {
      GRAVEYARD_WORKER_ENABLED: "1",
      GRAVEYARD_FIXTURES_ROOT: p("fixtures"),
      GRAVEYARD_STAGING_ROOT: p("staging"),
      GRAVEYARD_NPM_CACHE_DIR: p("cache"),
      GRAVEYARD_FIXTURE_CATALOG: p("catalog.json"),
    };
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
    return out;
  }
  const full = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
    env({
      GRAVEYARD_GITHUB_CATALOG: p("github.json"),
      GRAVEYARD_GITHUB_RUNS_ROOT: p("runs"),
      GRAVEYARD_GITHUB_EGRESS_NETWORK: "gh-net",
      GRAVEYARD_GITHUB_EGRESS_PROXY_CONTAINER: "gh-proxy",
      GRAVEYARD_GITHUB_EGRESS_PROXY_URL: "http://10.201.5.10:3128",
      ...extra,
    });
  const deps = (pins: string = PINS): { readCatalog: (path: string) => string; randomId: () => string; pid: number } => ({
    readCatalog: (path) => (path.endsWith("github.json") ? pins : CATALOG),
    randomId: () => "abc123",
    pid: 42,
  });
  function problemsOf(fn: () => unknown): readonly string[] {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof WorkerConfigError, `expected WorkerConfigError, got ${String(e)}`);
      return e.problems;
    }
    assert.fail("expected the configuration to be refused");
  }
  const has = (problems: readonly string[], fragment: string): boolean => problems.some((x) => x.includes(fragment));

  it("leaves the GitHub flow off when none of its variables is set", () => {
    const c = loadWorkerConfig(env(), deps());
    assert.equal(c.github, null);
  });

  it("accepts a complete GitHub configuration without registry egress", () => {
    const c = loadWorkerConfig(full(), deps());
    assert.ok(c.github !== null && c.github !== undefined);
    assert.deepEqual(c.github.pins, { [REPO]: COMMIT });
    assert.equal(c.github.runsRoot, p("runs"));
    assert.equal(c.github.gitImage, "alpine/git:2.47.2");
    assert.deepEqual(c.github.gitEgress, { network: "gh-net", proxyContainer: "gh-proxy", proxyUrl: "http://10.201.5.10:3128" });
    assert.equal(c.github.registryEgress, null);
  });

  it("accepts the registry egress when all three variables are set", () => {
    const c = loadWorkerConfig(
      full({
        GRAVEYARD_REGISTRY_EGRESS_NETWORK: "npm-net",
        GRAVEYARD_REGISTRY_EGRESS_PROXY_CONTAINER: "npm-proxy",
        GRAVEYARD_REGISTRY_EGRESS_PROXY_URL: "http://10.202.5.10:3128",
      }),
      deps(),
    );
    assert.deepEqual(c.github?.registryEgress, { network: "npm-net", proxyContainer: "npm-proxy", proxyUrl: "http://10.202.5.10:3128" });
  });

  it("refuses other GitHub variables without the catalog", () => {
    assert.ok(has(problemsOf(() => loadWorkerConfig(env({ GRAVEYARD_GITHUB_RUNS_ROOT: p("runs") }), deps())), "GRAVEYARD_GITHUB_CATALOG"));
  });

  it("refuses a missing runs root and missing egress settings", () => {
    const noRuns = problemsOf(() => loadWorkerConfig(full({ GRAVEYARD_GITHUB_RUNS_ROOT: undefined }), deps()));
    assert.ok(has(noRuns, "GRAVEYARD_GITHUB_RUNS_ROOT is required"));
    const noEgress = problemsOf(() =>
      loadWorkerConfig(
        full({ GRAVEYARD_GITHUB_EGRESS_NETWORK: undefined, GRAVEYARD_GITHUB_EGRESS_PROXY_CONTAINER: undefined, GRAVEYARD_GITHUB_EGRESS_PROXY_URL: undefined }),
        deps(),
      ),
    );
    assert.ok(has(noEgress, "GRAVEYARD_GITHUB_EGRESS_NETWORK"));
  });

  it("refuses a partial egress group, default networks, a public proxy address and a shared topology", () => {
    assert.ok(has(problemsOf(() => loadWorkerConfig(full({ GRAVEYARD_GITHUB_EGRESS_PROXY_URL: undefined }), deps())), "GRAVEYARD_GITHUB_EGRESS_PROXY_URL"));
    assert.ok(has(problemsOf(() => loadWorkerConfig(full({ GRAVEYARD_GITHUB_EGRESS_NETWORK: "bridge" }), deps())), "dedicated user-defined"));
    assert.ok(has(problemsOf(() => loadWorkerConfig(full({ GRAVEYARD_GITHUB_EGRESS_PROXY_URL: "http://8.8.8.8:3128" }), deps())), "private IPv4"));
    assert.ok(has(problemsOf(() => loadWorkerConfig(full({ GRAVEYARD_GITHUB_EGRESS_PROXY_URL: "http://10.0.0.5:99999" }), deps())), "private IPv4"));
    assert.ok(has(problemsOf(() => loadWorkerConfig(full({ GRAVEYARD_REGISTRY_EGRESS_NETWORK: "npm-net" }), deps())), "GRAVEYARD_REGISTRY_EGRESS_PROXY_CONTAINER"));
    const shared = problemsOf(() =>
      loadWorkerConfig(
        full({
          GRAVEYARD_REGISTRY_EGRESS_NETWORK: "gh-net",
          GRAVEYARD_REGISTRY_EGRESS_PROXY_CONTAINER: "npm-proxy",
          GRAVEYARD_REGISTRY_EGRESS_PROXY_URL: "http://10.202.5.10:3128",
        }),
        deps(),
      ),
    );
    assert.ok(has(shared, "different networks"));
  });

  it("refuses a runs root that overlaps another worker directory", () => {
    assert.ok(has(problemsOf(() => loadWorkerConfig(full({ GRAVEYARD_GITHUB_RUNS_ROOT: join(p("staging"), "runs") }), deps())), "separate directories"));
    assert.ok(has(problemsOf(() => loadWorkerConfig(full({ GRAVEYARD_GITHUB_RUNS_ROOT: p("cache") }), deps())), "separate directories"));
  });

  it("refuses an invalid git image", () => {
    assert.ok(has(problemsOf(() => loadWorkerConfig(full({ GRAVEYARD_GITHUB_GIT_IMAGE: "Bad Image" }), deps())), "GRAVEYARD_GITHUB_GIT_IMAGE"));
  });

  it("refuses a URL that is in both catalogs", () => {
    const both = JSON.stringify({ "https://github.com/f/fixture": COMMIT });
    assert.ok(has(problemsOf(() => loadWorkerConfig(full(), deps(both))), "not both"));
  });

  it("parsePins accepts only canonical URLs with full lowercase commit SHAs", () => {
    assert.equal(parsePins(PINS).ok, true);
    for (const bad of [
      "{}", "[]", "not json", JSON.stringify({ [REPO]: "main" }), JSON.stringify({ [REPO]: "abc1234" }),
      JSON.stringify({ [REPO]: COMMIT.toUpperCase() }), JSON.stringify({ [REPO]: 5 }),
      JSON.stringify({ "https://github.com/O/R/": COMMIT }), JSON.stringify({ "https://example.com/o/r": COMMIT }),
    ]) {
      assert.equal(parsePins(bad).ok, false, bad);
    }
  });
});

// ---------------------------------------------------------------------------
// Composition: the real wiring, fail-closed with a fake docker
// ---------------------------------------------------------------------------

describe("composeWorker with the GitHub flow", () => {
  let root: string;
  const dirs = (): Record<string, string> => ({
    fixtures: join(root, "fixtures"),
    staging: join(root, "staging"),
    cache: join(root, "cache"),
    runs: join(root, "runs"),
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "graveyard-github-compose-"));
    for (const d of Object.values(dirs())) mkdirSync(d);
    const fx = join(dirs()["fixtures"] as string, "fx1");
    mkdirSync(fx);
    writeFileSync(join(fx, "package.json"), "{}\n");
    writeFileSync(join(fx, "package-lock.json"), "{}\n");
    writeFileSync(join(fx, "build.mjs"), "\n");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const env = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
    const d = dirs();
    const out: NodeJS.ProcessEnv = {
      GRAVEYARD_WORKER_ENABLED: "1",
      GRAVEYARD_FIXTURES_ROOT: d["fixtures"],
      GRAVEYARD_STAGING_ROOT: d["staging"],
      GRAVEYARD_NPM_CACHE_DIR: d["cache"],
      GRAVEYARD_FIXTURE_CATALOG: join(root, "catalog.json"),
      GRAVEYARD_GITHUB_CATALOG: join(root, "github.json"),
      GRAVEYARD_GITHUB_RUNS_ROOT: d["runs"],
      GRAVEYARD_GITHUB_EGRESS_NETWORK: "gh-net",
      GRAVEYARD_GITHUB_EGRESS_PROXY_CONTAINER: "gh-proxy",
      GRAVEYARD_GITHUB_EGRESS_PROXY_URL: "http://10.201.5.10:3128",
    };
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
    return out;
  };
  const cfg = (extra: Record<string, string | undefined> = {}): ReturnType<typeof loadWorkerConfig> =>
    loadWorkerConfig(env(extra), {
      readCatalog: (path) => (path.endsWith("github.json") ? JSON.stringify({ [REPO]: COMMIT }) : JSON.stringify({ "https://github.com/f/fixture": "fx1" })),
      randomId: () => "abc123",
      pid: 1,
    });

  /** A docker that knows no network and no container: every egress check fails, every cleanup proof is clean. */
  const emptyDocker: ProcessExecutor = (_f, args) => {
    const ok = (extra: Partial<ProcessResult> = {}): ProcessResult => ({
      exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, ...extra,
    });
    if (args[0] === "network") return Promise.resolve(ok({ exitCode: 1, stderr: "Error response from daemon: network gh-net not found" }));
    if (args[0] === "inspect") return Promise.resolve(ok({ exitCode: 1, stderr: "Error: No such object: x" }));
    return Promise.resolve(ok());
  };

  it("refuses to start when the runs root is not a directory", () => {
    const c = cfg();
    rmSync(dirs()["runs"] as string, { recursive: true });
    assert.throws(
      () => composeWorker(c, { pipeline: new FakePipeline(successResult), openDb: () => openDatabase(":memory:"), executor: emptyDocker }),
      /GRAVEYARD_GITHUB_RUNS_ROOT is not an existing directory/,
    );
  });

  it("a pinned job fails closed when the operator egress topology is not in place, and nothing is created", async () => {
    const created: string[][] = [];
    const exec: ProcessExecutor = (f, args, o) => {
      if (args[0] === "create" || args[0] === "run" || args[0] === "start") created.push([...args]);
      return emptyDocker(f, args, o);
    };
    const composed = composeWorker(cfg(), {
      pipeline: new FakePipeline(successResult),
      openDb: () => openDatabase(":memory:"),
      executor: exec,
      cleanupExecution: (id) => Promise.resolve(okProof(id)),
    });
    try {
      const id = createJob(composed.db, { repoUrl: REPO, rawToken: generateRawToken() }).jobId;
      const res = await composed.worker.runOnce();
      assert.deepEqual(res, { kind: "finished", jobId: id, outcome: "failed" });
      const infra = JSON.parse((composed.db.prepare("SELECT infra_error FROM jobs WHERE id = ?").get(id) as { infra_error: string }).infra_error) as {
        kind: string;
        message: string;
      };
      assert.equal(infra.kind, "infrastructure-unavailable");
      assert.match(infra.message, /network-unavailable/);
      assert.deepEqual(created, [], "no container was created");
      assert.deepEqual(readdirSync(dirs()["runs"] as string), []);
      const events = composed.db.prepare("SELECT event_type FROM job_events WHERE job_id = ?").all(id) as Array<{ event_type: string }>;
      assert.equal(events.some((e) => e.event_type === "result"), false);
    } finally {
      composed.close();
    }
  });

  it("builds without the GitHub flow when it is not configured", () => {
    const c = cfg({
      GRAVEYARD_GITHUB_CATALOG: undefined,
      GRAVEYARD_GITHUB_RUNS_ROOT: undefined,
      GRAVEYARD_GITHUB_EGRESS_NETWORK: undefined,
      GRAVEYARD_GITHUB_EGRESS_PROXY_CONTAINER: undefined,
      GRAVEYARD_GITHUB_EGRESS_PROXY_URL: undefined,
    });
    assert.equal(c.github, null);
    const composed = composeWorker(c, { pipeline: new FakePipeline(successResult), openDb: () => openDatabase(":memory:"), executor: emptyDocker });
    composed.close();
  });
});
