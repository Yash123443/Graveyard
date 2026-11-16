/**
 * npm-scripts-repair.test.ts — focused regression tests for the opt-in verified Kiro repair of the
 * pinned npm-scripts profile (npm-scripts-repair.ts, its wiring in GithubJobRunner and the result
 * gate in result-view.ts): success, unsafe or rejected proposals, failed or inconclusive
 * verification, cleanup and abort handling, and agents off.
 *
 * No Docker, no network, no git, no npm, no kiro-cli and no repository code runs here: pipelines and
 * agents are fakes, the snapshot is a temporary directory. Written without running the compiler or
 * this file; it shows nothing about the real flow against Docker, GitHub or a live Kiro runtime.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePatchProposal, type Diagnosis, type FileEvidence, type PatchProposal } from "../agent-contract.js";
import { BUILD_ENTRY_NAME_RE, isBuildEntryName, parseBuildEntryScript, parseRepairTestScript, testCountsAcceptable } from "../build-entry.js";
import type { ControlledPipelineResult, PipelineRequest } from "../controlled-pipeline.js";
import { createRunDir } from "../fixture-workspace.js";
import type { StageResult as DriverStage } from "../fixture-pipeline-driver.js";
import type { AcquisitionRequest, AcquisitionResult, HandoffInfo } from "../git-acquisition.js";
import type { RootFiles } from "../github-analysis.js";
import { GithubJobRunner, type GitLike, type NpmScriptsOptions, type RegistryLike } from "../github-runner.js";
import type { AgentOutcome, AnalystRequest, FixerRequest } from "../kiro-agent.js";
import type { RegistryAcquisitionResult } from "../npm-registry-acquisition.js";
import {
  MAX_REPAIR_SOURCE_BYTES,
  buildSourceSuitable,
  checkRepairEligibility,
  deriveRepairExecutionId,
  verifyNpmScriptsRepair,
  type NpmRepairVerifyInput,
} from "../npm-scripts-repair.js";
import { planNpmScripts } from "../npm-scripts-policy.js";
import type { AgentsLike, PipelineLike } from "../pipeline-runner.js";
import { applyBuildPatch } from "../repair-verifier.js";
import { presentResult } from "../result-view.js";
import type { CleanupProof, JobRunner, RunContext } from "../runner.js";
import { operatorDoc, textsOf, type OperatorDoc } from "./operator-fixture-helpers.js";

const REPO = "https://github.com/o/r";
const COMMIT = "a".repeat(40);
const SNAPSHOT_NAME = "src-0123456789ab";

const BUILD = '"use strict";\nconst x = 1;\nthrow new Error("boom");\nconsole.log(x);\n';
const DIFF = [
  "--- a/build.js",
  "+++ b/build.js",
  "@@ -1,4 +1,3 @@",
  ' "use strict";',
  " const x = 1;",
  '-throw new Error("boom");',
  " console.log(x);",
  "",
].join("\n");
const TEST_JS = "require('node:test');\n";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "graveyard-npm-repair-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

const okProof = (executionId: string): CleanupProof => ({ confirmed: true, executionId, evidence: "fake docker: nothing carries this id" });

function scriptsDoc(scripts: Record<string, unknown> = {}): OperatorDoc {
  const d = operatorDoc();
  d.pkg["scripts"] = { build: "node build.js", test: "node --test", ...scripts };
  return d;
}

// ---------------------------------------------------------------------------
// Pure naming and patch application
// ---------------------------------------------------------------------------

describe("build entry naming", () => {
  it("accepts exactly `node FILE` and `node ./FILE` for a simple root file", () => {
    assert.equal(parseBuildEntryScript("node build.js"), "build.js");
    assert.equal(parseBuildEntryScript("node ./build.mjs"), "build.mjs");
    assert.equal(parseBuildEntryScript("node make-site_2.cjs"), "make-site_2.cjs");
  });

  it("refuses everything else", () => {
    for (const s of [
      "node  build.js",
      "node build.js --flag",
      "node build.js && node x.js",
      "node ./sub/build.js",
      "node ../build.js",
      "node /abs/build.js",
      "node .hidden.js",
      "node build.ts",
      "node a.b.js",
      "node test.js",
      "node spec-build.js",
      "npm run x",
      "node build.js; rm -rf x",
      "node $FILE.js",
      "",
    ]) {
      assert.equal(parseBuildEntryScript(s), null, s);
    }
    assert.equal(parseBuildEntryScript(undefined), null);
    assert.equal(parseBuildEntryScript(5), null);
    assert.equal(isBuildEntryName("build.mjs"), true);
    assert.equal(isBuildEntryName("x/build.mjs"), false);
    assert.equal(BUILD_ENTRY_NAME_RE.test("package.json"), false);
  });

  it("derives a distinct repair execution id", () => {
    assert.equal(deriveRepairExecutionId("job1:1"), "job1-fix:1");
    assert.notEqual(deriveRepairExecutionId("job1:1"), "job1:1");
    assert.equal(deriveRepairExecutionId("bad id"), null);
  });
});

describe("repair test script and TAP counts", () => {
  it("accepts exactly `node --test` or `node --test` plus one safe root test-like file", () => {
    assert.deepEqual(parseRepairTestScript("node --test"), { file: null });
    assert.deepEqual(parseRepairTestScript("node --test test.mjs"), { file: "test.mjs" });
    assert.deepEqual(parseRepairTestScript("node --test smoke-spec_1.cjs"), { file: "smoke-spec_1.cjs" });
  });

  it("refuses no-ops, other commands, flags, pipelines and unsafe or non-test files", () => {
    for (const s of [
      "echo ok",
      "true",
      "node build.js",
      "node test.mjs",
      "node --test ",
      "node  --test",
      "node --test  test.mjs",
      "node --test build.js",
      "node --test ./test.mjs",
      "node --test test/",
      "node --test test/*.js",
      "node --test sub/test.mjs",
      "node --test ../test.mjs",
      "node --test .test.mjs",
      "node --test a.test.js",
      "node --test test.ts",
      "node --test test.mjs other.test",
      "node --test test.mjs extra.mjs",
      "node --test --test-reporter=tap",
      "node --test --test-reporter=tap test.mjs",
      "node --test --test-name-pattern=x",
      "node --test | cat",
      "node --test && echo ok",
      "node --test; echo ok",
      "node --test || true",
      "node --test test.mjs > /dev/null",
      "node --test $FILE.mjs",
      "node --test\ttest.mjs",
      "node --test test.mjs\n",
      "NODE_OPTIONS=x node --test",
      "npm run t",
      "",
    ]) {
      assert.equal(parseRepairTestScript(s), null, JSON.stringify(s));
    }
    assert.equal(parseRepairTestScript(undefined), null);
    assert.equal(parseRepairTestScript(5), null);
  });

  it("accepts counts only when at least one test passed and none failed, were cancelled or exceed the total", () => {
    const ok = { tests: 2, pass: 1, fail: 0, cancelled: 0, skipped: 1, todo: 0 };
    assert.equal(testCountsAcceptable(ok), true);
    assert.equal(testCountsAcceptable({ ...ok, tests: 1, skipped: 0 }), true);
    for (const bad of [
      null,
      undefined,
      "x",
      [],
      {},
      { ...ok, tests: 0, pass: 0, skipped: 0 },
      { ...ok, pass: 0 },
      { ...ok, fail: 1 },
      { ...ok, cancelled: 1 },
      { ...ok, pass: 3 },
      { ...ok, skipped: 3 },
      { ...ok, todo: 3 },
      { ...ok, pass: -1 },
      { ...ok, pass: 1.5 },
      { ...ok, pass: Number.NaN },
      { ...ok, tests: "2" },
      { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0 },
    ]) {
      assert.equal(testCountsAcceptable(bad), false, JSON.stringify(bad));
    }
  });
});

describe("applyBuildPatch generalisation", () => {
  it("keeps build.mjs as the default target and applies the same exact diff to a named target", () => {
    const legacyDiff = DIFF.replaceAll("build.js", "build.mjs");
    const legacy = applyBuildPatch(BUILD, legacyDiff);
    assert.equal(legacy.ok, true);
    const named = applyBuildPatch(BUILD, DIFF, "build.js");
    if (!named.ok) return assert.fail(`expected application: ${named.reason}`);
    assert.equal(named.patched, '"use strict";\nconst x = 1;\nconsole.log(x);\n');
  });

  it("refuses a diff for another path and an unsafe or test-like target", () => {
    assert.deepEqual(applyBuildPatch(BUILD, DIFF), { ok: false, reason: "path-not-allowed" });
    for (const t of ["../build.js", "sub/build.js", "build.ts", "test.js", ""]) {
      assert.deepEqual(applyBuildPatch(BUILD, DIFF, t), { ok: false, reason: "path-not-allowed" }, t);
    }
  });
});

describe("repair eligibility and evidence suitability", () => {
  const failing = (req: PipelineRequest): ControlledPipelineResult => buildFailureResult(req);

  it("accepts only a build-stage failure of a simple node script", () => {
    const base = failing({ executionId: "job1:1", fixture: SNAPSHOT_NAME });
    const T = "node --test";
    assert.deepEqual(checkRepairEligibility("node build.js", base, "job1:1", T), { ok: true, target: "build.js" });
    assert.deepEqual(checkRepairEligibility("node build.js", base, "job1:1", "node --test test.mjs"), { ok: true, target: "build.js" });
    assert.equal(checkRepairEligibility("node ./a/b.js", base, "job1:1", T).ok, false);
    assert.equal(checkRepairEligibility("node build.js", base, "other:1", T).ok, false);
    assert.equal(checkRepairEligibility("node build.js", testFailureResult({ executionId: "job1:1", fixture: SNAPSHOT_NAME }), "job1:1", T).ok, false);
    assert.equal(checkRepairEligibility("node build.js", { ...base, cleanup: { confirmed: false, reason: "x" } }, "job1:1", T).ok, false);
    assert.equal(checkRepairEligibility("node build.js", { ...base, stagingRemoved: false }, "job1:1", T).ok, false);
    const noInstall = { ...base, stages: [st("prepare", "passed"), st("install", "failed", { reason: "exit-code", exitCode: 1 })] };
    assert.equal(checkRepairEligibility("node build.js", noInstall, "job1:1", T).ok, false);
  });

  it("refuses a test script that cannot show tests ran, even for an otherwise eligible baseline", () => {
    const base = failing({ executionId: "job1:1", fixture: SNAPSHOT_NAME });
    for (const t of ["echo ok", "node build.js", "node --test --test-reporter=tap", "node --test test/", "node --test && echo ok", "true"]) {
      const e = checkRepairEligibility("node build.js", base, "job1:1", t);
      assert.equal(e.ok, false, t);
      if (!e.ok) assert.match(e.reason, /scripts\.test/, t);
    }
  });

  it("sends source only when it is complete, bounded, unredacted and cleanly terminated", () => {
    assert.equal(buildSourceSuitable(BUILD), true);
    assert.equal(buildSourceSuitable(""), false);
    assert.equal(buildSourceSuitable("x".repeat(MAX_REPAIR_SOURCE_BYTES + 1) + "\n"), false);
    assert.equal(buildSourceSuitable("no final newline"), false);
    assert.equal(buildSourceSuitable("a\r\nb\r\n"), false);
    assert.equal(buildSourceSuitable("a\u0000b\n"), false);
    assert.equal(buildSourceSuitable('const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789";\n'), false, "redaction would change it");
  });
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const st = (stage: DriverStage["stage"], status: DriverStage["status"], extra: Partial<DriverStage> = {}): DriverStage => ({
  stage, status, durationMs: 5, ...extra,
});
/** Node's TAP summary as the in-container test stage would print it (the stdout tail). */
function tapTail(c: { tests: number; pass: number; fail?: number; cancelled?: number; skipped?: number; todo?: number }): string {
  return [
    "TAP version 13", "1..1",
    `# tests ${c.tests}`, "# suites 0", `# pass ${c.pass}`, `# fail ${c.fail ?? 0}`, `# cancelled ${c.cancelled ?? 0}`,
    `# skipped ${c.skipped ?? 0}`, `# todo ${c.todo ?? 0}`, "# duration_ms 5", "",
  ].join("\n");
}
const TAP_OK = tapTail({ tests: 1, pass: 1 });
const TAP_OK_COUNTS = { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
/** A fully passing pipeline whose test stage printed `tail`. */
function passingWithTestTail(req: PipelineRequest, tail: string | undefined): ControlledPipelineResult {
  const ok = successResult(req);
  return { ...ok, stages: [st("prepare", "passed"), st("install", "passed"), st("build", "passed"), st("test", "passed", tail === undefined ? {} : { stdoutTail: tail })] };
}
function successResult(req: PipelineRequest): ControlledPipelineResult {
  return {
    status: "success", reason: "ok", detail: "ok", failedStage: null,
    stages: [st("prepare", "passed"), st("install", "passed"), st("build", "passed"), st("test", "passed", { stdoutTail: TAP_OK })],
    exitCode: 0, durationMs: 10, truncated: false, stderrTail: "", packagesAdded: 3, expectedPackages: 3,
    violations: [], cleanup: okProof(req.executionId), stagingRemoved: true, driverSha256: "b".repeat(64), executionId: req.executionId,
  };
}
function buildFailureResult(req: PipelineRequest): ControlledPipelineResult {
  return {
    ...successResult(req),
    status: "failure", reason: "build-failed", detail: "build exited with code 1", failedStage: "build",
    stages: [
      st("prepare", "passed"), st("install", "passed"),
      st("build", "failed", { reason: "exit-code", exitCode: 1, stderrTail: "SECRET-CONTAINER-OUTPUT" }),
      st("test", "skipped"),
    ],
    exitCode: 1,
  };
}
function testFailureResult(req: PipelineRequest): ControlledPipelineResult {
  return {
    ...successResult(req),
    status: "failure", reason: "test-failed", detail: "test exited with code 1", failedStage: "test",
    stages: [
      st("prepare", "passed"), st("install", "passed"), st("build", "passed"),
      st("test", "failed", { reason: "exit-code", exitCode: 1 }),
    ],
    exitCode: 1,
  };
}
const patchedStillFailing = (req: PipelineRequest): ControlledPipelineResult => testFailureResult(req);
const inconclusive = (req: PipelineRequest): ControlledPipelineResult => ({
  ...successResult(req), status: "not-run", reason: "timed-out", detail: "timed out", stages: null, exitCode: null,
});

interface AgentScript {
  analyst?: "ok" | "unknown";
  /** "ok" proposes DIFF; "other-file" proposes a diff for package.json; "unknown" answers no patch. */
  fixer?: "ok" | "other-file" | "unknown";
  /** Aborts this controller while the Fixer runs. */
  abortInFixer?: AbortController;
}

class FakeAgents implements AgentsLike {
  analystCalls: AnalystRequest[] = [];
  fixerCalls: FixerRequest[] = [];
  constructor(private readonly script: AgentScript = {}) {}

  analyze(req: AnalystRequest): Promise<AgentOutcome<Diagnosis>> {
    this.analystCalls.push(req);
    if (this.script.analyst === "unknown") {
      return Promise.resolve({ status: "no-result", role: "analyst", code: "unknown-diagnosis", detail: "no supported diagnosis" });
    }
    const hasFile = req.evidence.some((e) => e.kind === "file");
    return Promise.resolve({
      status: "ok",
      role: "analyst",
      value: {
        category: "build-failure", summary: "The build script throws.", rootCause: "A stray throw statement aborts the build.",
        confidence: "high", evidenceRefs: ["stage-result"], affectedFiles: hasFile ? ["build.js"] : [],
      },
    });
  }

  propose(req: FixerRequest): Promise<AgentOutcome<PatchProposal>> {
    this.fixerCalls.push(req);
    this.script.abortInFixer?.abort();
    if (this.script.abortInFixer !== undefined) return Promise.resolve({ status: "aborted", role: "fixer", code: "aborted", detail: "cancelled" });
    if (this.script.fixer === "unknown") return Promise.resolve({ status: "no-result", role: "fixer", code: "no-patch", detail: "no safe patch" });
    const files = new Map<string, FileEvidence>();
    for (const e of req.evidence) if (e.kind === "file" && e.path !== undefined) files.set(e.path, { complete: e.complete === true, text: e.text });
    const diff = this.script.fixer === "other-file" ? DIFF.replaceAll("build.js", "package.json") : DIFF;
    const v = validatePatchProposal({ schemaVersion: 1, role: "fixer", verdict: "patch", summary: "Remove the stray throw.", diff }, files);
    if (v.ok) return Promise.resolve({ status: "ok", role: "fixer", value: v.value });
    return Promise.resolve({ status: "rejected", role: "fixer", code: v.code, detail: v.detail });
  }
}

interface Rig {
  runner: GithubJobRunner;
  ctx: RunContext;
  controller: AbortController;
  stages: string[];
  results: Record<string, unknown>[];
  pipelineBuilds: Array<{ runDir: string; snapshot: string; cacheDir: string; installManifest: string; expectedPackages: number }>;
  pipelineRequests: PipelineRequest[];
  /** Files of the patched copy as the fake pipeline saw them. */
  copySeen: Array<{ snapshot: string; files: Record<string, string>; entries: string[] }>;
  cleanupIds: string[];
  agents: FakeAgents | null;
  runsRoot: string;
  runDirOf: () => string;
}

function makeRig(opts: {
  scripts?: Record<string, unknown>;
  build?: string;
  baseline?: (req: PipelineRequest) => ControlledPipelineResult;
  patched?: (req: PipelineRequest) => ControlledPipelineResult;
  agents?: FakeAgents | null;
  cleanupExecution?: (id: string) => Promise<CleanupProof>;
  controller?: AbortController;
  beforeBaselineReturns?: (snapshotDir: string) => void;
} = {}): Rig {
  const runsRoot = join(tmp, "runs");
  mkdirSync(runsRoot, { recursive: true });
  const t = textsOf(scriptsDoc(opts.scripts));
  const files: RootFiles = { packageJson: t.packageJson, packageLock: t.packageLock, buildMjs: null, testMjs: null, unusable: [] };
  const stages: string[] = [];
  const results: Record<string, unknown>[] = [];
  const pipelineBuilds: Rig["pipelineBuilds"] = [];
  const pipelineRequests: PipelineRequest[] = [];
  const copySeen: Rig["copySeen"] = [];
  const cleanupIds: string[] = [];
  const agents = opts.agents === undefined ? new FakeAgents() : opts.agents;
  const controller = opts.controller ?? new AbortController();
  let lastRunDir = "";
  const handoff: HandoffInfo = {
    containerName: "graveyard-acq-test", commit: COMMIT, manifest: { files: 4, totalBytes: 100, submodulesSkipped: 0 },
    dockerBinary: "docker", remainingMs: 100_000,
  };
  const makeGit = (hook: (info: HandoffInfo) => Promise<void>): GitLike => ({
    acquire: async (req: AcquisitionRequest) => {
      await hook(handoff);
      const acquired: AcquisitionResult = {
        kind: "acquired", commit: COMMIT, manifest: handoff.manifest, durationMs: 1, cleanup: okProof(req.executionId),
      };
      return acquired;
    },
    cleanup: (req) => Promise.resolve(okProof(req.executionId)),
  });
  const registry: RegistryLike = {
    acquire: (req) =>
      Promise.resolve({
        kind: "acquired", cacheDir: join(req.runDir, "cache"), summary: { entries: 0 }, packagesAdded: 3, durationMs: 1,
        cleanup: okProof(req.executionId), stagingRemoved: true, driverSha256: "c".repeat(64), executionId: req.executionId,
      } as unknown as RegistryAcquisitionResult),
    cleanup: (req) => Promise.resolve(okProof(req.executionId)),
  };
  const fallback: JobRunner = {
    run: () => Promise.resolve({ kind: "infrastructure-unavailable", reason: "fallback" }),
    cleanup: (req) => Promise.resolve(okProof(req.executionId)),
  };
  const npmScripts: NpmScriptsOptions = {
    exportSnapshot: (_info, runDir) => {
      lastRunDir = runDir;
      const dir = join(runDir, SNAPSHOT_NAME);
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "package.json"), t.packageJson);
      writeFileSync(join(dir, "package-lock.json"), t.packageLock);
      writeFileSync(join(dir, "build.js"), opts.build ?? BUILD);
      writeFileSync(join(dir, "test", "index.test.js"), TEST_JS);
      return Promise.resolve({
        kind: "extracted" as const, name: SNAPSHOT_NAME, dir, files: 4, directories: 1, totalBytes: 100, archiveSha256: "d".repeat(64),
      });
    },
    makePipeline: (a) => {
      pipelineBuilds.push(a);
      return {
        run: (req) => {
          pipelineRequests.push(req);
          if (a.snapshot === SNAPSHOT_NAME) {
            opts.beforeBaselineReturns?.(join(a.runDir, SNAPSHOT_NAME));
            return Promise.resolve((opts.baseline ?? buildFailureResult)(req));
          }
          const dir = join(a.runDir, a.snapshot);
          const seen: Record<string, string> = {};
          for (const n of ["package.json", "package-lock.json", "build.js"]) seen[n] = readFileSync(join(dir, n), "utf8");
          seen["test/index.test.js"] = readFileSync(join(dir, "test", "index.test.js"), "utf8");
          copySeen.push({ snapshot: a.snapshot, files: seen, entries: readdirSync(dir).sort() });
          return Promise.resolve((opts.patched ?? successResult)(req));
        },
      } as PipelineLike;
    },
  };
  const runner = new GithubJobRunner({
    fallback,
    fixtureUrls: new Set(),
    pins: new Map([[REPO, COMMIT]]),
    runsRoot,
    gitImage: "alpine/git:2.47.2",
    makeGit,
    readRootFiles: () => Promise.resolve(files),
    registry,
    makePipeline: () => ({ run: (req) => Promise.resolve(successResult(req)) }),
    cleanupExecution: (id) => {
      cleanupIds.push(id);
      return (opts.cleanupExecution ?? ((x: string) => Promise.resolve(okProof(x))))(id);
    },
    ...(agents === null ? {} : { agents }),
    npmScripts,
  });
  const ctx: RunContext = {
    jobId: "job1", repoUrl: REPO, executionId: "job1:1", attempt: 1, deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    signal: controller.signal,
    report: {
      stage: (s) => {
        stages.push(s);
        return true;
      },
      result: (r) => {
        results.push(r);
        return true;
      },
    },
  };
  return { runner, ctx, controller, stages, results, pipelineBuilds, pipelineRequests, copySeen, cleanupIds, agents, runsRoot, runDirOf: () => lastRunDir };
}

const view = (result: Record<string, unknown>): ReturnType<typeof presentResult> =>
  presentResult({ jobId: "job1", stage: "done", status: "completed", attemptCount: 1, maxAttempts: 3, infraError: null, result });
const verificationOf = (result: Record<string, unknown> | undefined): Record<string, unknown> =>
  (result as { verification: Record<string, unknown> }).verification;

// ---------------------------------------------------------------------------
// Runner wiring
// ---------------------------------------------------------------------------

describe("npm scripts verified repair in the GitHub runner", () => {
  it("verifies a Kiro proposal on an audited disposable copy with the same cache and a distinct execution id", async () => {
    const rig = makeRig();
    const out = await rig.runner.run(rig.ctx);
    assert.deepEqual(out, { kind: "completed" });
    assert.deepEqual(rig.stages, ["cloning", "analyzing", "building", "testing", "diagnosing", "repairing", "verifying"]);

    const result = rig.results[0] as Record<string, unknown>;
    assert.equal(result["verdict"], "repository-failing");
    assert.equal(result["runMode"], "npm-scripts");
    const v = verificationOf(result);
    assert.equal(v["status"], "verified");
    assert.equal(v["patchClass"], "npm-scripts-build-entry");
    assert.equal(v["targetPath"], "build.js");
    assert.deepEqual(v["patchedFiles"], ["build.js"]);
    assert.equal(v["distinctExecutionId"], true);
    assert.equal(v["sameCache"], true);
    assert.equal(v["testScript"], "node --test");
    assert.deepEqual(v["testCounts"], TAP_OK_COUNTS);
    assert.equal(v["originalModified"], false);
    assert.match(String(v["originalTargetSha256"]), /^[0-9a-f]{64}$/);
    assert.match(String(v["patchedTargetSha256"]), /^[0-9a-f]{64}$/);
    assert.notEqual(v["originalTargetSha256"], v["patchedTargetSha256"]);

    // Two pipeline runs: the baseline on the snapshot and the patched copy under a distinct id and the same cache.
    assert.equal(rig.pipelineRequests.length, 2);
    assert.equal(rig.pipelineRequests[0]?.executionId, "job1:1");
    assert.equal(rig.pipelineRequests[1]?.executionId, "job1-fix:1");
    assert.equal(rig.pipelineRequests[0]?.fixture, SNAPSHOT_NAME);
    assert.match(rig.pipelineRequests[1]?.fixture ?? "", /^run-[0-9a-f]{12}$/);
    assert.equal(rig.pipelineBuilds[1]?.cacheDir, rig.pipelineBuilds[0]?.cacheDir);
    assert.equal(rig.pipelineBuilds[1]?.installManifest, rig.pipelineBuilds[0]?.installManifest);
    assert.equal(rig.pipelineBuilds[1]?.runDir, rig.pipelineBuilds[0]?.runDir);

    // The copy differed from the snapshot in exactly one file.
    const copy = rig.copySeen[0];
    assert.equal(copy?.files["build.js"], '"use strict";\nconst x = 1;\nconsole.log(x);\n');
    assert.equal(copy?.files["test/index.test.js"], TEST_JS);
    assert.equal(copy?.files["package.json"], textsOf(scriptsDoc()).packageJson);
    assert.equal(copy?.files["package-lock.json"], textsOf(scriptsDoc()).packageLock);
    assert.deepEqual(copy?.entries, ["build.js", "package-lock.json", "package.json", "test"]);

    // What the agents saw: stage evidence, the scripts, and the complete build entry as the only file.
    const evidence = rig.agents?.analystCalls[0]?.evidence ?? [];
    assert.deepEqual(evidence.map((e) => e.id), ["stage-result", "scripts", "build-entry"]);
    const files = evidence.filter((e) => e.kind === "file");
    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, "build.js");
    assert.equal(files[0]?.complete, true);
    assert.equal(files[0]?.text, BUILD);
    assert.equal(JSON.stringify(evidence).includes("lockfileVersion"), false);

    // The stored result and the view.
    assert.equal(JSON.stringify(result).includes("SECRET-CONTAINER-OUTPUT"), false);
    const view1 = view(result);
    assert.equal(view1.outcome, "repair-verified");
    assert.equal(view1.repair.verified, true);
    assert.equal(view1.repair.patchApplied, false);
    assert.equal(view1.verifiedDiff, DIFF);
    assert.deepEqual(readdirSync(rig.runsRoot), [], "the run directory and every copy must be removed");
  });

  it("with agents off keeps the baseline behaviour: no agent, no second run, no verification", async () => {
    const rig = makeRig({ agents: null });
    const out = await rig.runner.run(rig.ctx);
    assert.deepEqual(out, { kind: "completed" });
    assert.deepEqual(rig.stages, ["cloning", "analyzing", "building", "testing"]);
    assert.equal(rig.pipelineRequests.length, 1);
    const result = rig.results[0] as Record<string, unknown>;
    assert.equal(result["verdict"], "repository-failing");
    assert.equal(result["verification"], undefined);
    assert.equal(result["repairEligibility"], undefined);
    assert.deepEqual(result["analyst"], { status: "not-applicable", reason: "npm-scripts mode sends no repository source to any model" });
    assert.equal(view(result).outcome, "failing-undiagnosed");
    // Cleanup now also checks the old repair container, even when agents are off.
    const proof = await rig.runner.cleanup({ jobId: "job1", executionId: "job1:1", attempt: 1, workerId: null });
    assert.equal(proof.confirmed, true);
    assert.deepEqual(rig.cleanupIds, ["job1-fix:1"]);
  });

  it("does not contact agents for a failure outside the class", async () => {
    for (const c of [
      { label: "test-stage failure", opts: { baseline: testFailureResult } },
      { label: "non-simple build script", opts: { scripts: { build: "node ./sub/build.js" } } },
      { label: "unmatched build script", opts: { scripts: { build: "node build.js --fast" } } },
      { label: "no-op echo test script", opts: { scripts: { test: "echo ok" } } },
      { label: "test script that runs the build", opts: { scripts: { test: "node build.js" } } },
      { label: "node --test with a reporter flag", opts: { scripts: { test: "node --test --test-reporter=tap" } } },
      { label: "node --test over a directory", opts: { scripts: { test: "node --test test/" } } },
      { label: "node --test with a chained command", opts: { scripts: { test: "node --test && echo ok" } } },
    ]) {
      const rig = makeRig(c.opts);
      const out = await rig.runner.run(rig.ctx);
      assert.deepEqual(out, { kind: "completed" }, c.label);
      assert.equal(rig.agents?.analystCalls.length, 0, c.label);
      assert.equal(rig.pipelineRequests.length, 1, c.label);
      const result = rig.results[0] as Record<string, unknown>;
      assert.equal(result["verification"], undefined, c.label);
      assert.equal(view(result).outcome, "failing-undiagnosed", c.label);
    }
  });

  it("proves the repair execution id absent in cleanup and blocks when it cannot", async () => {
    const rig = makeRig({ cleanupExecution: (id) => Promise.resolve(id.includes("-fix:") ? { confirmed: false, reason: "container still present" } : okProof(id)) });
    const proof = await rig.runner.cleanup({ jobId: "job1", executionId: "job1:1", attempt: 1, workerId: null });
    assert.equal(proof.confirmed, false);
    assert.ok(rig.cleanupIds.includes("job1-fix:1"));
    const ok = makeRig();
    const proof2 = await ok.runner.cleanup({ jobId: "job1", executionId: "job1:1", attempt: 1, workerId: null });
    assert.equal(proof2.confirmed, true);
    assert.deepEqual(ok.cleanupIds, ["job1-fix:1"]);
  });

  it("rejects an out-of-scope proposal (another path) before anything is applied or run", async () => {
    const rig = makeRig({ agents: new FakeAgents({ fixer: "other-file" }) });
    const out = await rig.runner.run(rig.ctx);
    assert.deepEqual(out, { kind: "completed" });
    assert.equal(rig.pipelineRequests.length, 1);
    const result = rig.results[0] as Record<string, unknown>;
    assert.equal(result["verification"], undefined);
    assert.equal((result["fixer"] as Record<string, unknown>)["status"], "rejected");
    assert.equal(view(result).outcome, "failing-with-diagnosis");
    assert.equal(view(result).repair.verified, false);
  });

  it("keeps the diagnosis when the Fixer has no safe patch", async () => {
    const rig = makeRig({ agents: new FakeAgents({ fixer: "unknown" }) });
    await rig.runner.run(rig.ctx);
    assert.equal(rig.pipelineRequests.length, 1);
    const result = rig.results[0] as Record<string, unknown>;
    assert.equal((result["fixer"] as Record<string, unknown>)["status"], "no-result");
    assert.equal(view(result).outcome, "failing-with-diagnosis");
  });

  it("skips the Fixer, and never sends the file, when the build source is not suitable complete evidence", async () => {
    const big = `${'"use strict";\n'}${"// padding line to exceed the evidence bound\n".repeat(120)}throw new Error("boom");\n`;
    const rig = makeRig({ build: big });
    const out = await rig.runner.run(rig.ctx);
    assert.deepEqual(out, { kind: "completed" });
    assert.equal(rig.agents?.analystCalls.length, 1);
    assert.equal(rig.agents?.analystCalls[0]?.evidence.some((e) => e.kind === "file"), false);
    assert.equal(rig.agents?.fixerCalls.length, 0);
    assert.equal(rig.pipelineRequests.length, 1);
    const result = rig.results[0] as Record<string, unknown>;
    assert.deepEqual(result["fixer"], { status: "not-attempted" });
    assert.equal((result["repairEligibility"] as Record<string, unknown>)["skipped"], "build-source-unsuitable");
    assert.equal(view(result).outcome, "failing-with-diagnosis");
  });

  it("records a tested failure honestly: not a repair", async () => {
    const rig = makeRig({ patched: patchedStillFailing });
    const out = await rig.runner.run(rig.ctx);
    assert.deepEqual(out, { kind: "completed" });
    const result = rig.results[0] as Record<string, unknown>;
    assert.equal(verificationOf(result)["status"], "tested-failing");
    const v = view(result);
    assert.equal(v.outcome, "patch-failed-verification");
    assert.equal(v.repair.verified, false);
    assert.equal(v.verifiedDiff, null);
    assert.deepEqual(readdirSync(rig.runsRoot), []);
  });

  it("records an inconclusive but cleaned-up verification as not attempted and keeps the proposal", async () => {
    const rig = makeRig({ patched: inconclusive });
    const out = await rig.runner.run(rig.ctx);
    assert.deepEqual(out, { kind: "completed" });
    const v = verificationOf(rig.results[0]);
    assert.equal(v["status"], "not-attempted");
    assert.equal(v["reason"], "verification-inconclusive");
    const presented = view(rig.results[0] as Record<string, unknown>);
    assert.equal(presented.outcome, "failing-with-patch-proposal");
    assert.equal(presented.repair.verified, false);
  });

  it("verifies with the explicit `node --test test.mjs` form used by the live harness", async () => {
    const rig = makeRig({ scripts: { test: "node --test test.mjs" } });
    const out = await rig.runner.run(rig.ctx);
    assert.deepEqual(out, { kind: "completed" });
    const result = rig.results[0] as Record<string, unknown>;
    assert.equal(verificationOf(result)["testScript"], "node --test test.mjs");
    assert.equal(view(result).outcome, "repair-verified");
  });

  it("never verifies a passing patched copy whose test output shows no passed test", async () => {
    const cases: Array<[string, string | undefined]> = [
      ["no test output", undefined],
      ["empty output", ""],
      ["no TAP summary", "> pkg@1.0.0 test\n> node --test\n\nok\n"],
      ["zero tests", tapTail({ tests: 0, pass: 0 })],
      ["zero passed", tapTail({ tests: 1, pass: 0, skipped: 1 })],
      ["a failed test despite exit 0", tapTail({ tests: 2, pass: 1, fail: 1 })],
      ["a cancelled test", tapTail({ tests: 2, pass: 1, cancelled: 1 })],
      ["pass above total", tapTail({ tests: 1, pass: 2 })],
      ["indented counts only", "  # tests 1\n  # pass 1\n  # fail 0\n  # cancelled 0\n"],
    ];
    for (const [label, tail] of cases) {
      const rig = makeRig({ patched: (req) => passingWithTestTail(req, tail) });
      const out = await rig.runner.run(rig.ctx);
      assert.deepEqual(out, { kind: "completed" }, label);
      const result = rig.results[0] as Record<string, unknown>;
      const v = verificationOf(result);
      assert.equal(v["status"], "not-attempted", label);
      assert.equal(v["reason"], "tests-not-confirmed", label);
      const presented = view(result);
      assert.equal(presented.outcome, "failing-with-patch-proposal", label);
      assert.equal(presented.repair.verified, false, label);
      assert.equal(presented.verifiedDiff, null, label);
      assert.deepEqual(readdirSync(rig.runsRoot), [], label);
    }
  });

  it("fails as infrastructure, with no result, when the patched run's cleanup is not confirmed", async () => {
    const rig = makeRig({ patched: (req) => ({ ...successResult(req), cleanup: { confirmed: false, reason: "still there" } }) });
    const out = await rig.runner.run(rig.ctx);
    assert.equal(out.kind, "infrastructure-unavailable");
    assert.equal(rig.results.length, 0);
    assert.deepEqual(readdirSync(rig.runsRoot), []);
  });

  it("fails as infrastructure when the patched run reports success without removed staging", async () => {
    const rig = makeRig({ patched: (req) => ({ ...successResult(req), stagingRemoved: false }) });
    const out = await rig.runner.run(rig.ctx);
    assert.equal(out.kind, "infrastructure-unavailable");
    assert.equal(rig.results.length, 0);
  });

  it("fails as infrastructure when the patched run answers for another execution id", async () => {
    const rig = makeRig({ patched: (req) => ({ ...successResult(req), executionId: "job1:1" }) });
    const out = await rig.runner.run(rig.ctx);
    assert.equal(out.kind, "infrastructure-unavailable");
    assert.equal(rig.results.length, 0);
  });

  it("aborts without a result when cancelled during the Fixer, and starts no verification", async () => {
    const controller = new AbortController();
    const rig = makeRig({ controller, agents: new FakeAgents({ abortInFixer: controller }) });
    const out = await rig.runner.run(rig.ctx);
    assert.deepEqual(out, { kind: "aborted" });
    assert.equal(rig.results.length, 0);
    assert.equal(rig.pipelineRequests.length, 1);
    assert.deepEqual(readdirSync(rig.runsRoot), []);
  });

  it("does not repair a baseline that was not cleaned up", async () => {
    const rig = makeRig({ baseline: (req) => ({ ...buildFailureResult(req), stagingRemoved: false }) });
    const out = await rig.runner.run(rig.ctx);
    assert.equal(out.kind, "infrastructure-unavailable");
    assert.equal(rig.agents?.analystCalls.length, 0);
    assert.equal(rig.results.length, 0);
  });
});

// ---------------------------------------------------------------------------
// The verifier on its own (host-side refusals)
// ---------------------------------------------------------------------------

describe("verifyNpmScriptsRepair refusals", () => {
  function setup(extra: { build?: string; symlink?: boolean } = {}): { runDir: string; input: NpmRepairVerifyInput; runs: string[] } {
    const parent = join(tmp, "work");
    mkdirSync(parent, { recursive: true });
    const runDir = createRunDir(parent);
    const dir = join(runDir, SNAPSHOT_NAME);
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, "package-lock.json"), "{}\n");
    writeFileSync(join(dir, "build.js"), extra.build ?? BUILD);
    if (extra.symlink === true) symlinkSync(join(dir, "package.json"), join(dir, "link.js"));
    const runs: string[] = [];
    const proposalOf = (diff: string, files: string[] = ["build.js"]): PatchProposal => ({
      diff, files, hunks: 1, added: 0, removed: 1, contextVerified: true, summary: "x", proposalOnly: true,
    });
    const input: NpmRepairVerifyInput = {
      baselineExecutionId: "job1:1",
      verifyExecutionId: "job1-fix:1",
      proposal: proposalOf(DIFF),
      baseline: buildFailureResult({ executionId: "job1:1", fixture: SNAPSHOT_NAME }),
      target: "build.js",
      testScript: "node --test",
      evidenceBuild: { text: extra.build ?? BUILD, complete: true },
      runDir,
      snapshotName: SNAPSHOT_NAME,
      cacheDir: join(parent, "cache"),
      makePipeline: ({ snapshot }) => ({
        run: (req) => {
          runs.push(snapshot);
          return Promise.resolve(successResult(req));
        },
      }),
      signal: new AbortController().signal,
    };
    return { runDir, input, runs };
  }
  const reasonOf = (r: Awaited<ReturnType<typeof verifyNpmScriptsRepair>>): string =>
    r.kind === "verification" ? `${r.verification.status}:${r.verification.reason}` : r.kind;

  it("verifies the happy path on its own", async () => {
    const { input, runs, runDir } = setup();
    const r = await verifyNpmScriptsRepair(input);
    assert.equal(reasonOf(r), "verified:all-stages-passed");
    if (r.kind !== "verification") return assert.fail("expected a verification record");
    assert.deepEqual(r.verification.testCounts, TAP_OK_COUNTS);
    assert.equal(r.verification.testScript, "node --test");
    assert.equal(runs.length, 1);
    assert.deepEqual(readdirSync(runDir), [SNAPSHOT_NAME], "only the baseline snapshot remains");
    assert.equal(readFileSync(join(runDir, SNAPSHOT_NAME, "build.js"), "utf8"), BUILD);
  });

  it("refuses without running anything", async () => {
    const cases: Array<[string, (i: NpmRepairVerifyInput) => NpmRepairVerifyInput, string]> = [
      ["same execution id", (i) => ({ ...i, verifyExecutionId: i.baselineExecutionId }), "not-attempted:execution-id-not-distinct"],
      ["bad execution id", (i) => ({ ...i, verifyExecutionId: "bad id" }), "not-attempted:execution-id-not-distinct"],
      ["no-op echo test script", (i) => ({ ...i, testScript: "echo ok" }), "not-attempted:test-script-not-supported"],
      ["test script that runs the build", (i) => ({ ...i, testScript: "node build.js" }), "not-attempted:test-script-not-supported"],
      ["test script with a flag", (i) => ({ ...i, testScript: "node --test --test-reporter=tap" }), "not-attempted:test-script-not-supported"],
      ["test script naming a non-test file", (i) => ({ ...i, testScript: "node --test build.js" }), "not-attempted:test-script-not-supported"],
      ["test script that was never given", (i) => ({ ...i, testScript: "" }), "not-attempted:test-script-not-supported"],
      ["other path in proposal", (i) => ({ ...i, proposal: { ...i.proposal, files: ["package.json"] } }), "not-attempted:path-not-allowed"],
      ["two paths in proposal", (i) => ({ ...i, proposal: { ...i.proposal, files: ["build.js", "package.json"] } }), "not-attempted:path-not-allowed"],
      ["test-like target", (i) => ({ ...i, target: "test.js" }), "not-attempted:path-not-allowed"],
      ["unverified context", (i) => ({ ...i, proposal: { ...i.proposal, contextVerified: false } }), "not-attempted:evidence-incomplete"],
      ["no evidence", (i) => ({ ...i, evidenceBuild: null }), "not-attempted:evidence-incomplete"],
      ["incomplete evidence", (i) => ({ ...i, evidenceBuild: { text: BUILD, complete: false } }), "not-attempted:evidence-incomplete"],
      ["stale evidence", (i) => ({ ...i, evidenceBuild: { text: `${BUILD}// changed\n`, complete: true } }), "not-attempted:evidence-stale"],
      ["no cache", (i) => ({ ...i, cacheDir: null }), "not-attempted:no-verification-environment"],
      ["missing snapshot", (i) => ({ ...i, snapshotName: "src-ffffffffffff" }), "not-attempted:originals-unavailable"],
      [
        "hunk that does not match the original",
        (i) => ({ ...i, proposal: { ...i.proposal, diff: DIFF.replace(" const x = 1;", " const y = 2;") } }),
        "not-attempted:hunk-mismatch",
      ],
      ["unusable baseline", (i) => ({ ...i, baseline: { ...i.baseline, cleanup: { confirmed: false, reason: "x" } } }), "not-attempted:baseline-not-observed"],
      ["test-stage baseline", (i) => ({ ...i, baseline: testFailureResult({ executionId: "job1:1", fixture: SNAPSHOT_NAME }) }), "not-attempted:baseline-not-observed"],
      ["pre-aborted", (i) => ({ ...i, signal: AbortSignal.abort() }), "aborted"],
    ];
    for (const [label, mutate, expected] of cases) {
      const { input, runs, runDir } = setup();
      const r = await verifyNpmScriptsRepair(mutate(input));
      assert.equal(reasonOf(r), expected, label);
      assert.equal(runs.length, 0, label);
      assert.deepEqual(readdirSync(runDir), [SNAPSHOT_NAME], `${label}: no copy may remain`);
    }
  });

  it("does not verify a passing patched copy without a passed-test count, and removes the copy", async () => {
    const tails: Array<[string, string | undefined]> = [
      ["missing", undefined],
      ["zero tests", tapTail({ tests: 0, pass: 0 })],
      ["zero passed", tapTail({ tests: 3, pass: 0, skipped: 3 })],
      ["failed count", tapTail({ tests: 2, pass: 1, fail: 1 })],
      ["inconsistent", tapTail({ tests: 1, pass: 5 })],
    ];
    for (const [label, tail] of tails) {
      const { input, runs, runDir } = setup();
      const r = await verifyNpmScriptsRepair({
        ...input,
        makePipeline: ({ snapshot }) => ({
          run: (req) => {
            runs.push(snapshot);
            return Promise.resolve(passingWithTestTail(req, tail));
          },
        }),
      });
      assert.equal(reasonOf(r), "not-attempted:tests-not-confirmed", label);
      assert.equal(runs.length, 1, label);
      assert.deepEqual(readdirSync(runDir), [SNAPSHOT_NAME], `${label}: no copy may remain`);
    }
  });

  it("refuses a no-op diff and a patch that would empty the file", async () => {
    const { input } = setup({ build: "throw 1;\n" });
    const emptying = ["--- a/build.js", "+++ b/build.js", "@@ -1,1 +0,0 @@", "-throw 1;", ""].join("\n");
    const r = await verifyNpmScriptsRepair({ ...input, proposal: { ...input.proposal, diff: emptying } });
    assert.equal(reasonOf(r), "not-attempted:patched-unsuitable");
  });

  it("refuses a snapshot that contains a symlink and leaves no partial copy", async () => {
    let made = true;
    let s: ReturnType<typeof setup>;
    try {
      s = setup({ symlink: true });
    } catch {
      made = false;
      s = setup();
    }
    if (!made) return; // symlinks are not permitted in this environment
    const r = await verifyNpmScriptsRepair(s.input);
    assert.equal(reasonOf(r), "not-attempted:snapshot-copy-refused");
    assert.equal(s.runs.length, 0);
    assert.deepEqual(readdirSync(s.runDir).sort(), [SNAPSHOT_NAME]);
  });

  it("reports a verification run that raises as infrastructure and still removes the copy", async () => {
    const { input, runDir } = setup();
    const r = await verifyNpmScriptsRepair({ ...input, makePipeline: () => ({ run: () => Promise.reject(new Error("boom")) }) });
    assert.equal(r.kind, "infrastructure");
    assert.deepEqual(readdirSync(runDir), [SNAPSHOT_NAME]);
  });

  it("aborts when the signal fires during the patched run, and still removes the copy", async () => {
    const controller = new AbortController();
    const { input, runDir } = setup();
    const r = await verifyNpmScriptsRepair({
      ...input,
      signal: controller.signal,
      makePipeline: () => ({
        run: (req) => {
          controller.abort();
          return Promise.resolve(inconclusive(req));
        },
      }),
    });
    assert.equal(r.kind, "aborted");
    assert.deepEqual(readdirSync(runDir), [SNAPSHOT_NAME]);
  });
});

// ---------------------------------------------------------------------------
// Result gate
// ---------------------------------------------------------------------------

describe("result gate for the npm-scripts repair class", () => {
  async function verifiedResult(): Promise<Record<string, unknown>> {
    const rig = makeRig();
    await rig.runner.run(rig.ctx);
    return JSON.parse(JSON.stringify(rig.results[0])) as Record<string, unknown>;
  }

  it("accepts the stored record and reports the verified path", async () => {
    const result = await verifiedResult();
    const v = view(result);
    assert.equal(v.outcome, "repair-verified");
    assert.equal(verificationOf(result)["targetPath"], "build.js");
  });

  it("downgrades a record that was tampered with to an unverified proposal", async () => {
    const mutations: Array<[string, (r: Record<string, unknown>) => void]> = [
      ["target path changed", (r) => { verificationOf(r)["targetPath"] = "other.js"; }],
      ["unsafe target path", (r) => { verificationOf(r)["targetPath"] = "../build.js"; }],
      ["patched files changed", (r) => { verificationOf(r)["patchedFiles"] = ["package.json"]; }],
      ["diff changed", (r) => { (r["fixer"] as Record<string, unknown>)["diff"] = `${DIFF}\n`; }],
      ["cleanup not confirmed", (r) => { (verificationOf(r)["cleanup"] as Record<string, unknown>)["confirmed"] = false; }],
      ["same execution id", (r) => { verificationOf(r)["distinctExecutionId"] = false; }],
      ["cache not reused", (r) => { verificationOf(r)["sameCache"] = false; }],
      ["original hash equals patched hash", (r) => { verificationOf(r)["patchedTargetSha256"] = verificationOf(r)["originalTargetSha256"]; }],
      ["baseline not a build failure", (r) => { (r["pipeline"] as Record<string, unknown>)["failedStage"] = "test"; }],
      ["unknown class", (r) => { verificationOf(r)["patchClass"] = "something-else"; }],
      ["run mode removed", (r) => { delete r["runMode"]; }],
      [
        "a patched stage did not pass",
        (r) => {
          const stages = (verificationOf(r)["patched"] as { stages: Array<Record<string, unknown>> }).stages;
          const last = stages[stages.length - 1] as Record<string, unknown>;
          last["status"] = "skipped";
        },
      ],
      ["tester not passed", (r) => { (verificationOf(r)["tester"] as Record<string, unknown>)["status"] = "not-run"; }],
      ["test counts removed", (r) => { verificationOf(r)["testCounts"] = null; }],
      ["test counts missing", (r) => { delete verificationOf(r)["testCounts"]; }],
      ["zero tests recorded", (r) => { verificationOf(r)["testCounts"] = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 }; }],
      ["zero passed recorded", (r) => { (verificationOf(r)["testCounts"] as Record<string, unknown>)["pass"] = 0; }],
      ["failed test recorded", (r) => { (verificationOf(r)["testCounts"] as Record<string, unknown>)["fail"] = 1; }],
      ["cancelled test recorded", (r) => { (verificationOf(r)["testCounts"] as Record<string, unknown>)["cancelled"] = 1; }],
      ["pass above total recorded", (r) => { (verificationOf(r)["testCounts"] as Record<string, unknown>)["pass"] = 9; }],
      ["non-integer count recorded", (r) => { (verificationOf(r)["testCounts"] as Record<string, unknown>)["tests"] = 1.5; }],
      ["no-op test script recorded", (r) => { verificationOf(r)["testScript"] = "echo ok"; }],
      ["flagged test script recorded", (r) => { verificationOf(r)["testScript"] = "node --test --test-reporter=tap"; }],
      ["test script removed", (r) => { delete verificationOf(r)["testScript"]; }],
    ];
    for (const [label, mutate] of mutations) {
      const result = await verifiedResult();
      mutate(result);
      const v = view(result);
      assert.equal(v.outcome === "repair-verified", false, label);
      assert.equal(v.repair.verified, false, label);
      assert.equal(v.verifiedDiff, null, label);
    }
  });
});

// A policy sanity check used by the rig: the document is inside the npm-scripts profile.
describe("test fixture sanity", () => {
  it("the generated manifest is accepted by the npm-scripts policy", () => {
    const plan = planNpmScripts(textsOf(scriptsDoc()), { dependencyAcquisition: true });
    assert.equal(plan.ok, true);
  });
});
