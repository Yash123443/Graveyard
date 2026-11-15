/**
 * repair-verifier.test.ts — patch security, in-memory application, disposable-copy verification and
 * the integration with PipelineJobRunner, JobWorker and the result view.
 *
 * No Docker, no network, no kiro-cli, no repository code and no subprocess. The offline pipelines are
 * fakes that return prepared results; the fake VERIFICATION pipeline also reads the disposable copy it
 * is given, so what would be mounted into the container is asserted. Real temporary directories,
 * a real in-memory SQLite database and the real JobWorker are used.
 *
 * Written without a shell: compiled and run only when an operator does so.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import { createJob } from "../jobs.js";
import { generateRawToken } from "../token.js";
import { JobWorker } from "../worker.js";
import { validatePatchProposal, type Diagnosis, type FileEvidence, type PatchProposal } from "../agent-contract.js";
import type { ControlledPipelineResult, PipelineRequest } from "../controlled-pipeline.js";
import type { StageResult as DriverStage } from "../fixture-pipeline-driver.js";
import type { AgentOutcome, AnalystRequest, FixerRequest } from "../kiro-agent.js";
import type { CleanupProof, JobProgress, RunContext, RunOutcome } from "../runner.js";
import { presentResult } from "../result-view.js";
import { PipelineJobRunner, type AgentsLike, type ControlledSource, type PipelineLike } from "../pipeline-runner.js";
import {
  PATCH_CLASS,
  applyBuildPatch,
  readFixtureOriginals,
  verifyRepair,
  type RepairOptions,
  type RepairOriginals,
  type VerifyInput,
  type VerifyPipelineLike,
} from "../repair-verifier.js";

const REPO = "https://github.com/o/r";
const EXEC = "job-1:1";

const BUILD = ['import { writeFileSync } from "node:fs";', 'throw new Error("intentional build failure");', 'console.log("never");', ""].join("\n");
const TEST = 'import { test } from "node:test";\ntest("x", () => {});\n';
const PKG = '{"name":"fx","version":"1.0.0"}\n';
const LOCK = '{"lockfileVersion":3}\n';
const ORIGINALS: RepairOriginals = { packageJson: PKG, packageLock: LOCK, buildMjs: BUILD, testMjs: TEST };

const GOOD_DIFF = [
  "--- a/build.mjs",
  "+++ b/build.mjs",
  "@@ -1,3 +1,3 @@",
  ' import { writeFileSync } from "node:fs";',
  '-throw new Error("intentional build failure");',
  '+console.log("fixed");',
  ' console.log("never");',
  "",
].join("\n");

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const st = (stage: DriverStage["stage"], status: DriverStage["status"], extra: Partial<DriverStage> = {}): DriverStage => ({
  stage, status, durationMs: 5, ...extra,
});
const okCleanup = (executionId: string): CleanupProof => ({ confirmed: true, executionId, evidence: "fake docker: no container" });

function successResult(req: PipelineRequest): ControlledPipelineResult {
  return {
    status: "success", reason: "ok", detail: "ok", failedStage: null,
    stages: [st("prepare", "passed"), st("install", "passed"), st("build", "passed"), st("test", "passed")],
    exitCode: 0, durationMs: 10, truncated: false, stderrTail: "", packagesAdded: 1, expectedPackages: 1,
    violations: [], cleanup: okCleanup(req.executionId), stagingRemoved: true, driverSha256: "a".repeat(64),
    executionId: req.executionId,
  };
}
function baselineFailure(req: PipelineRequest): ControlledPipelineResult {
  return {
    ...successResult(req),
    status: "failure", reason: "build-failed", detail: "build exited with code 1", failedStage: "build",
    stages: [
      st("prepare", "passed"), st("install", "passed"),
      st("build", "failed", { reason: "exit-code", exitCode: 1, stderrTail: "Error: intentional build failure" }),
      st("test", "skipped"),
    ],
    exitCode: 1,
  };
}
function patchedTestFailure(req: PipelineRequest): ControlledPipelineResult {
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
const notRun = (req: PipelineRequest, reason: ControlledPipelineResult["reason"]): ControlledPipelineResult => ({
  ...successResult(req), status: "not-run", reason, stages: null, exitCode: null,
});

const baselineReq: PipelineRequest = { executionId: EXEC, fixture: "fx1" };

const ALL_FILES = new Map<string, FileEvidence>([
  ["build.mjs", { complete: true, text: BUILD }],
  ["test.mjs", { complete: true, text: TEST }],
  ["package.json", { complete: true, text: PKG }],
]);

/** A proposal that passed the agent-contract validation against `files`, as the real adapter would produce. */
function proposalFor(diff: string, files: ReadonlyMap<string, FileEvidence> = ALL_FILES): PatchProposal {
  const v = validatePatchProposal({ schemaVersion: 1, role: "fixer", verdict: "patch", summary: "fix the build", diff }, files);
  assert.ok(v.ok, v.ok ? "" : `${v.code}: ${v.detail}`);
  return v.value;
}

const diagnosis: Diagnosis = {
  category: "build-failure",
  summary: "build.mjs throws",
  rootCause: "build.mjs throws unconditionally",
  confidence: "medium",
  evidenceRefs: ["stage-result"],
  affectedFiles: ["build.mjs"],
};

class FakeAgents implements AgentsLike {
  fixerCalls = 0;
  constructor(private readonly outcome: () => AgentOutcome<PatchProposal>) {}
  analyze(_req: AnalystRequest): Promise<AgentOutcome<Diagnosis>> {
    return Promise.resolve<AgentOutcome<Diagnosis>>({ status: "ok", role: "analyst", value: diagnosis });
  }
  propose(_req: FixerRequest): Promise<AgentOutcome<PatchProposal>> {
    this.fixerCalls += 1;
    return Promise.resolve(this.outcome());
  }
}

/** Verification pipeline: records what the disposable copy contains when the container would start. */
class VerifyPipeline implements VerifyPipelineLike {
  readonly seen: Array<{ req: PipelineRequest; files: Record<string, string> }> = [];
  constructor(
    private readonly cloneRoot: string,
    private readonly make: (req: PipelineRequest) => ControlledPipelineResult | Promise<ControlledPipelineResult>,
    private readonly hook?: (dir: string) => void,
  ) {}
  async run(req: PipelineRequest): Promise<ControlledPipelineResult> {
    const dir = join(this.cloneRoot, req.fixture);
    const files: Record<string, string> = {};
    for (const n of readdirSync(dir).sort()) files[n] = readFileSync(join(dir, n), "utf8");
    this.seen.push({ req, files });
    this.hook?.(dir);
    return this.make(req);
  }
}

let tmp: string;
let workRoot: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "graveyard-repair-"));
  workRoot = join(tmp, "work");
  mkdirSync(workRoot);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

interface Harness {
  opts: RepairOptions;
  pipelines: VerifyPipeline[];
}
function harness(
  make: (req: PipelineRequest) => ControlledPipelineResult | Promise<ControlledPipelineResult> = successResult,
  extra: { hook?: (dir: string) => void; none?: boolean } = {},
): Harness {
  const pipelines: VerifyPipeline[] = [];
  const opts: RepairOptions = {
    workRoot,
    makePipeline: (cloneRoot) => {
      if (extra.none === true) return null;
      const p = new VerifyPipeline(cloneRoot, make, extra.hook);
      pipelines.push(p);
      return p;
    },
  };
  return { opts, pipelines };
}

function input(over: Partial<VerifyInput> = {}): VerifyInput {
  return {
    executionId: EXEC,
    proposal: proposalFor(GOOD_DIFF),
    baseline: baselineFailure(baselineReq),
    evidenceBuild: { text: BUILD, complete: true },
    evidenceTest: { text: TEST },
    originals: () => ORIGINALS,
    signal: new AbortController().signal,
    ...over,
  };
}

const workRootEntries = (): string[] => readdirSync(workRoot);

// ---------------------------------------------------------------------------
// Pure in-memory application and patch security
// ---------------------------------------------------------------------------

describe("applyBuildPatch (pure, in memory)", () => {
  it("applies a valid hunk to the exact original", () => {
    const r = applyBuildPatch(BUILD, GOOD_DIFF);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.patched, ['import { writeFileSync } from "node:fs";', 'console.log("fixed");', 'console.log("never");', ""].join("\n"));
      assert.equal(r.hunks, 1);
      assert.equal(r.added, 1);
      assert.equal(r.removed, 1);
    }
  });

  it("applies several hunks and an insertion-only hunk at exact positions", () => {
    const orig = ["a", "b", "c", "d", "e", "f", ""].join("\n");
    const diff = ["--- a/build.mjs", "+++ b/build.mjs", "@@ -1,2 +1,2 @@", "-a", "+A", " b", "@@ -4,0 +5,1 @@", "+inserted", "@@ -6 +7 @@", "-f", "+F", ""].join("\n");
    const r = applyBuildPatch(orig, diff);
    assert.ok(r.ok, r.ok ? "" : r.reason);
    if (r.ok) assert.equal(r.patched, ["A", "b", "c", "d", "inserted", "e", "F", ""].join("\n"));
  });

  it("refuses a diff for any other path (tests, manifest, lockfile, traversal)", () => {
    for (const p of ["test.mjs", "package.json", "package-lock.json", "src/build.mjs", "../build.mjs", ".git/config"]) {
      const diff = [`--- a/${p}`, `+++ b/${p}`, "@@ -1 +1 @@", "-x", "+y", ""].join("\n");
      const r = applyBuildPatch(BUILD, diff);
      assert.equal(r.ok, false, p);
      if (!r.ok) assert.equal(r.reason, "path-not-allowed", p);
    }
  });

  it("refuses a diff that touches build.mjs and another file", () => {
    const diff = GOOD_DIFF + ["--- a/test.mjs", "+++ b/test.mjs", "@@ -1 +1 @@", "-x", "+y", ""].join("\n");
    const r = applyBuildPatch(BUILD, diff);
    assert.equal(r.ok, false);
  });

  it("refuses stale content and stale hunk positions", () => {
    const wrongText = GOOD_DIFF.replace('-throw new Error("intentional build failure");', '-throw new Error("something else");');
    const a = applyBuildPatch(BUILD, wrongText);
    assert.deepEqual(a.ok ? null : a.reason, "hunk-mismatch");
    const shifted = GOOD_DIFF.replace("@@ -1,3 +1,3 @@", "@@ -2,3 +2,3 @@");
    const b = applyBuildPatch(BUILD, shifted);
    assert.deepEqual(b.ok ? null : b.reason, "hunk-mismatch");
  });

  it("refuses wrong new-side hunk coordinates", () => {
    for (const header of ["@@ -1,3 +2,3 @@", "@@ -1,3 +0,3 @@"]) {
      const diff = GOOD_DIFF.replace("@@ -1,3 +1,3 @@", header);
      const r = applyBuildPatch(BUILD, diff);
      assert.equal(r.ok, false, header);
      if (!r.ok) assert.equal(r.reason, "hunk-mismatch", header);
    }
    const orig = ["a", "b", "c", "d", ""].join("\n");
    const later = ["--- a/build.mjs", "+++ b/build.mjs", "@@ -3 +9 @@", "-c", "+C", ""].join("\n");
    const r = applyBuildPatch(orig, later);
    assert.deepEqual(r.ok ? null : r.reason, "hunk-mismatch");
  });

  it("refuses a no-op and a diff whose changes cancel out", () => {
    const noop = ["--- a/build.mjs", "+++ b/build.mjs", "@@ -2 +2 @@", '-throw new Error("intentional build failure");', '+throw new Error("intentional build failure");', ""].join("\n");
    const r = applyBuildPatch(BUILD, noop);
    assert.deepEqual(r.ok ? null : r.reason, "no-op");
  });

  it("refuses malformed, new-file, delete, rename and binary diffs", () => {
    const bad = [
      "",
      "not a diff\n",
      ["--- /dev/null", "+++ b/build.mjs", "@@ -0,0 +1 @@", "+x", ""].join("\n"),
      ["diff --git a/build.mjs b/build.mjs", "--- a/build.mjs", "+++ b/build.mjs", "@@ -1 +1 @@", "-x", "+y", ""].join("\n"),
      ["--- a/build.mjs", "+++ b/build.mjs", "@@ -1,3 +1,1 @@", " import { writeFileSync } from \"node:fs\";", ""].join("\n"),
      ["--- a/build.mjs", "+++ b/build.mjs", "Binary files differ", ""].join("\n"),
    ];
    for (const d of bad) assert.equal(applyBuildPatch(BUILD, d).ok, false, d);
  });

  it("refuses no-newline markers and an original that cannot be patched exactly", () => {
    const marker = GOOD_DIFF.replace('+console.log("fixed");\n', '+console.log("fixed");\n\\ No newline at end of file\n');
    assert.equal(applyBuildPatch(BUILD, marker).ok, false);
    const crlf = BUILD.replace(/\n/g, "\r\n");
    assert.deepEqual((applyBuildPatch(crlf, GOOD_DIFF) as { reason?: string }).reason, "original-unsuitable");
    assert.deepEqual((applyBuildPatch(BUILD.trimEnd(), GOOD_DIFF) as { reason?: string }).reason, "original-unsuitable");
    assert.deepEqual((applyBuildPatch("", GOOD_DIFF) as { reason?: string }).reason, "original-unsuitable");
  });

  it("refuses a diff that would empty the file", () => {
    const orig = "only\n";
    const diff = ["--- a/build.mjs", "+++ b/build.mjs", "@@ -1 +0,0 @@", "-only", ""].join("\n");
    const r = applyBuildPatch(orig, diff);
    assert.equal(r.ok, false);
  });

  it("is deterministic and never changes its inputs", () => {
    const o = `${BUILD}`;
    const d = `${GOOD_DIFF}`;
    const a = applyBuildPatch(o, d);
    const b = applyBuildPatch(o, d);
    assert.deepEqual(a, b);
    assert.equal(o, BUILD);
    assert.equal(d, GOOD_DIFF);
  });
});

// ---------------------------------------------------------------------------
// verifyRepair
// ---------------------------------------------------------------------------

describe("verifyRepair", () => {
  it("verifies a good patch on a disposable copy that has only the patched build.mjs changed", async () => {
    const h = harness(successResult);
    const r = await verifyRepair(h.opts, input());
    assert.equal(r.kind, "verification");
    if (r.kind !== "verification") return;
    const v = r.verification;
    assert.equal(v.status, "verified");
    assert.equal(v.reason, "all-stages-passed");
    assert.equal(v.patchClass, PATCH_CLASS);
    assert.equal(v.originalModified, false);
    assert.equal(v.diffSha256, sha(GOOD_DIFF));
    assert.deepEqual(v.patchedFiles, ["build.mjs"]);
    assert.equal(v.tester?.status, "passed");
    assert.deepEqual(v.cleanup, { confirmed: true, stagingRemoved: true, cloneRemoved: true });
    assert.equal(typeof v.measuredMs, "number");
    assert.equal(v.baseline.status, "failure");

    assert.equal(h.pipelines.length, 1);
    const seen = (h.pipelines[0] as VerifyPipeline).seen[0];
    assert.ok(seen !== undefined);
    assert.equal(seen.req.executionId, EXEC, "the baseline execution id is reused");
    assert.notEqual(seen.req.fixture, "fx1");
    assert.match(seen.req.fixture, /^repair-[0-9a-f]{12}$/);
    assert.deepEqual(Object.keys(seen.files), ["build.mjs", "package-lock.json", "package.json", "test.mjs"]);
    assert.equal(seen.files["test.mjs"], TEST, "tests are byte for byte the original");
    assert.equal(seen.files["package.json"], PKG);
    assert.equal(seen.files["package-lock.json"], LOCK);
    assert.equal(seen.files["build.mjs"], (applyBuildPatch(BUILD, GOOD_DIFF) as { patched: string }).patched);
    assert.equal(v.patchedBuildSha256, sha(seen.files["build.mjs"] as string));
    assert.deepEqual(workRootEntries(), [], "the disposable copy is removed");
  });

  it("records a tested failure when the patched copy still fails", async () => {
    const h = harness(patchedTestFailure);
    const r = await verifyRepair(h.opts, input());
    assert.equal(r.kind, "verification");
    if (r.kind !== "verification") return;
    assert.equal(r.verification.status, "tested-failing");
    assert.equal(r.verification.reason, "test-failed");
    assert.equal(r.verification.tester?.status, "failed");
    assert.deepEqual(workRootEntries(), []);
  });

  it("does not attempt without original tests", async () => {
    const h = harness();
    const r = await verifyRepair(h.opts, input({ evidenceTest: null }));
    assert.equal(r.kind, "verification");
    if (r.kind === "verification") {
      assert.equal(r.verification.status, "not-attempted");
      assert.equal(r.verification.reason, "no-original-tests");
      assert.equal(r.verification.patched, null);
    }
    assert.equal(h.pipelines.length, 0);
    assert.deepEqual(workRootEntries(), []);
  });

  it("does not attempt without an observed baseline failure with confirmed cleanup", async () => {
    const cases: ControlledPipelineResult[] = [
      successResult(baselineReq),
      { ...baselineFailure(baselineReq), cleanup: { confirmed: false, reason: "docker down" } },
      { ...baselineFailure(baselineReq), cleanup: null },
      { ...baselineFailure(baselineReq), stagingRemoved: false },
      { ...baselineFailure(baselineReq), executionId: "other:1" },
      notRun(baselineReq, "timed-out"),
    ];
    for (const baseline of cases) {
      const h = harness();
      const r = await verifyRepair(h.opts, input({ baseline }));
      assert.equal(r.kind === "verification" ? r.verification.reason : r.kind, "baseline-not-observed");
      assert.equal(h.pipelines.length, 0);
    }
  });

  it("does not attempt on incomplete evidence or an unverified context", async () => {
    const h = harness();
    const a = await verifyRepair(h.opts, input({ evidenceBuild: { text: BUILD, complete: false } }));
    assert.equal(a.kind === "verification" ? a.verification.reason : a.kind, "evidence-incomplete");
    const b = await verifyRepair(h.opts, input({ evidenceBuild: null }));
    assert.equal(b.kind === "verification" ? b.verification.reason : b.kind, "evidence-incomplete");
    const incomplete = proposalFor(GOOD_DIFF, new Map([["build.mjs", { complete: false, text: BUILD }]]));
    assert.equal(incomplete.contextVerified, false);
    const c = await verifyRepair(h.opts, input({ proposal: incomplete }));
    assert.equal(c.kind === "verification" ? c.verification.reason : c.kind, "evidence-incomplete");
    assert.equal(h.pipelines.length, 0);
  });

  it("does not attempt on stale evidence or unreadable originals", async () => {
    const h = harness();
    const a = await verifyRepair(h.opts, input({ originals: () => ({ ...ORIGINALS, buildMjs: `${BUILD}// changed\n` }) }));
    assert.equal(a.kind === "verification" ? a.verification.reason : a.kind, "evidence-stale");
    const b = await verifyRepair(h.opts, input({ originals: () => ({ ...ORIGINALS, testMjs: `${TEST}// changed\n` }) }));
    assert.equal(b.kind === "verification" ? b.verification.reason : b.kind, "evidence-stale");
    const c = await verifyRepair(h.opts, input({ originals: () => ({ ...ORIGINALS, testMjs: null }) }));
    assert.equal(c.kind === "verification" ? c.verification.reason : c.kind, "evidence-stale");
    const d = await verifyRepair(h.opts, input({ originals: () => null }));
    assert.equal(d.kind === "verification" ? d.verification.reason : d.kind, "originals-unavailable");
    const e = await verifyRepair(h.opts, input({ originals: () => ({ ...ORIGINALS, packageLock: "x".repeat(70 * 1024) }) }));
    assert.equal(e.kind === "verification" ? e.verification.reason : e.kind, "originals-too-large");
    assert.equal(h.pipelines.length, 0);
    assert.deepEqual(workRootEntries(), []);
  });

  it("refuses edits to tests and other paths even when the proposal was valid for the agents", async () => {
    const h = harness();
    const testDiff = ["--- a/test.mjs", "+++ b/test.mjs", "@@ -1,2 +1,2 @@", ' import { test } from "node:test";', '-test("x", () => {});', '+test("x", () => { /* weakened */ });', ""].join("\n");
    const a = await verifyRepair(h.opts, input({ proposal: proposalFor(testDiff) }));
    assert.equal(a.kind === "verification" ? a.verification.reason : a.kind, "path-not-allowed");
    const pkgDiff = ["--- a/package.json", "+++ b/package.json", "@@ -1 +1 @@", `-${PKG.trimEnd()}`, '+{"name":"fx","version":"2.0.0"}', ""].join("\n");
    const b = await verifyRepair(h.opts, input({ proposal: proposalFor(pkgDiff) }));
    assert.equal(b.kind === "verification" ? b.verification.reason : b.kind, "path-not-allowed");
    assert.equal(h.pipelines.length, 0);
  });

  it("refuses stale hunk positions and a no-op", async () => {
    const h = harness();
    // Valid against a different (longer) text the agents might have seen, but not against the original.
    const longer = `// header\n${BUILD}`;
    const shiftedDiff = ["--- a/build.mjs", "+++ b/build.mjs", "@@ -3,1 +3,1 @@", '-throw new Error("intentional build failure");', '+console.log("fixed");', ""].join("\n");
    const prop = proposalFor(shiftedDiff, new Map([["build.mjs", { complete: true, text: longer }]]));
    const a = await verifyRepair(h.opts, input({ proposal: prop }));
    assert.equal(a.kind === "verification" ? a.verification.reason : a.kind, "hunk-mismatch");

    const noop = ["--- a/build.mjs", "+++ b/build.mjs", "@@ -2 +2 @@", '-throw new Error("intentional build failure");', '+throw new Error("intentional build failure");', ""].join("\n");
    const b = await verifyRepair(h.opts, input({ proposal: proposalFor(noop) }));
    assert.equal(b.kind === "verification" ? b.verification.reason : b.kind, "no-op");
    assert.equal(h.pipelines.length, 0);
  });

  it("refuses a proposal whose diff is not in the normalised form it was validated in", async () => {
    const h = harness();
    const p = { ...proposalFor(GOOD_DIFF), diff: GOOD_DIFF.trimEnd() };
    const r = await verifyRepair(h.opts, input({ proposal: p }));
    assert.equal(r.kind === "verification" ? r.verification.reason : r.kind, "diff-invalid");
  });

  it("reports no verification environment as not attempted", async () => {
    const h = harness(successResult, { none: true });
    const r = await verifyRepair(h.opts, input());
    assert.equal(r.kind === "verification" ? r.verification.reason : r.kind, "no-verification-environment");
    assert.deepEqual(workRootEntries(), []);
  });

  it("treats an inconclusive run as infrastructure, never as a verdict", async () => {
    for (const reason of ["timed-out", "docker-unavailable", "output-truncated", "cleanup-unconfirmed"] as const) {
      const h = harness((req) => notRun(req, reason));
      const r = await verifyRepair(h.opts, input());
      assert.equal(r.kind, "infrastructure", reason);
      assert.deepEqual(workRootEntries(), [], reason);
    }
  });

  it("treats a success without confirmed cleanup or staging removal as infrastructure", async () => {
    const bad: Array<(req: PipelineRequest) => ControlledPipelineResult> = [
      (req) => ({ ...successResult(req), cleanup: { confirmed: false, reason: "x" } }),
      (req) => ({ ...successResult(req), cleanup: null }),
      (req) => ({ ...successResult(req), stagingRemoved: false }),
      (req) => ({ ...successResult(req), executionId: "other:1" }),
    ];
    for (const make of bad) {
      const r = await verifyRepair(harness(make).opts, input());
      assert.equal(r.kind, "infrastructure");
    }
  });

  it("treats a pipeline that throws as infrastructure and still removes the copy", async () => {
    const h = harness(() => {
      throw new Error("boom");
    });
    const r = await verifyRepair(h.opts, input());
    assert.equal(r.kind, "infrastructure");
    assert.deepEqual(workRootEntries(), []);
  });

  it("propagates an abort and removes the copy", async () => {
    const ac = new AbortController();
    const h = harness((req) => {
      ac.abort();
      return notRun(req, "aborted");
    });
    const r = await verifyRepair(h.opts, input({ signal: ac.signal }));
    assert.equal(r.kind, "aborted");
    assert.deepEqual(workRootEntries(), []);

    const pre = new AbortController();
    pre.abort();
    const h2 = harness();
    const r2 = await verifyRepair(h2.opts, input({ signal: pre.signal }));
    assert.equal(r2.kind, "aborted");
    assert.equal(h2.pipelines.length, 0);
  });

  it("an abort after a clean success still wins: nothing is claimed", async () => {
    const ac = new AbortController();
    const h = harness((req) => {
      ac.abort();
      return successResult(req);
    });
    const r = await verifyRepair(h.opts, input({ signal: ac.signal }));
    assert.equal(r.kind, "aborted");
  });

  it("fails closed when the disposable copy cannot be removed", async () => {
    const h = harness(successResult, {
      hook: (dir) => {
        // Deeper than the removal walker allows: it refuses and leaves the tree in place.
        let d = dir;
        for (let i = 0; i < 8; i += 1) {
          d = join(d, `d${String(i)}`);
          mkdirSync(d);
        }
      },
    });
    const r = await verifyRepair(h.opts, input());
    assert.equal(r.kind, "infrastructure");
    if (r.kind === "infrastructure") assert.match(r.reason, /could not be removed/);
  });

  it("fails closed when the work root is unusable", async () => {
    const h = harness();
    const r = await verifyRepair({ ...h.opts, workRoot: join(tmp, "missing") }, input());
    assert.equal(r.kind, "infrastructure");
    assert.equal(h.pipelines.length, 0);
  });

  it("measures the verification separately with the injected clock", async () => {
    let t = 1000;
    const h = harness(successResult);
    const r = await verifyRepair({ ...h.opts, now: () => (t += 250) }, input());
    assert.equal(r.kind, "verification");
    if (r.kind === "verification") assert.ok(r.verification.measuredMs >= 250);
  });

  it("never modifies the originals it was given", async () => {
    const o = { ...ORIGINALS };
    await verifyRepair(harness().opts, input({ originals: () => o }));
    assert.deepEqual(o, ORIGINALS);
  });
});

describe("readFixtureOriginals", () => {
  it("reads the four files as plain regular files and never writes", () => {
    const dir = join(tmp, "fixtures", "fx1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), PKG);
    writeFileSync(join(dir, "package-lock.json"), LOCK);
    writeFileSync(join(dir, "build.mjs"), BUILD);
    writeFileSync(join(dir, "test.mjs"), TEST);
    const root = join(tmp, "fixtures");
    assert.deepEqual(readFixtureOriginals(root, "fx1"), ORIGINALS);
    rmSync(join(dir, "test.mjs"));
    assert.equal(readFixtureOriginals(root, "fx1")?.testMjs, null);
    rmSync(join(dir, "build.mjs"));
    assert.equal(readFixtureOriginals(root, "fx1"), null);
    assert.equal(readFixtureOriginals(root, "../fixtures"), null);
    assert.equal(readFixtureOriginals("relative", "fx1"), null);
    assert.equal(readFixtureOriginals(root, "missing"), null);
  });

  it("refuses files that are not exact UTF-8 or too large", () => {
    const dir = join(tmp, "fixtures", "fx2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), PKG);
    writeFileSync(join(dir, "package-lock.json"), LOCK);
    writeFileSync(join(dir, "build.mjs"), Buffer.from([0x61, 0xff, 0x0a]));
    assert.equal(readFixtureOriginals(join(tmp, "fixtures"), "fx2"), null);
    writeFileSync(join(dir, "build.mjs"), "x".repeat(70 * 1024));
    assert.equal(readFixtureOriginals(join(tmp, "fixtures"), "fx2"), null);
  });
});

// ---------------------------------------------------------------------------
// PipelineJobRunner integration (direct run, and through JobWorker)
// ---------------------------------------------------------------------------

interface Recorded {
  stages: string[];
  results: Array<Record<string, unknown>>;
}

function makeReport(rec: Recorded): JobProgress {
  return {
    stage: (s) => {
      rec.stages.push(s);
      return true;
    },
    result: (r) => {
      rec.results.push(r);
      return true;
    },
  };
}

class Baseline implements PipelineLike {
  readonly requests: PipelineRequest[] = [];
  constructor(private readonly make: (req: PipelineRequest) => ControlledPipelineResult = baselineFailure) {}
  run(req: PipelineRequest): Promise<ControlledPipelineResult> {
    this.requests.push(req);
    return Promise.resolve(this.make(req));
  }
}

function sourceWith(over: { test?: boolean; originals?: boolean } = {}): ControlledSource {
  const files = [
    { path: "package.json", text: PKG, complete: true },
    { path: "build.mjs", text: BUILD, complete: true },
    ...(over.test === false ? [] : [{ path: "test.mjs", text: TEST, complete: true }]),
  ];
  return {
    fixture: "fx1",
    files,
    ...(over.originals === false ? {} : { originals: () => ({ ...ORIGINALS, testMjs: over.test === false ? null : TEST }) }),
  };
}

function runnerWith(opts: {
  baseline?: Baseline;
  verify?: Harness;
  agents?: AgentsLike;
  source?: ControlledSource;
  cleanups?: string[];
  withRepair?: boolean;
}): { runner: PipelineJobRunner; baseline: Baseline; verify: Harness } {
  const baseline = opts.baseline ?? new Baseline();
  const verify = opts.verify ?? harness(successResult);
  const cleanups = opts.cleanups ?? [];
  const runner = new PipelineJobRunner({
    resolve: () => opts.source ?? sourceWith(),
    pipeline: baseline,
    cleanupExecution: (id) => {
      cleanups.push(id);
      return Promise.resolve(okCleanup(id));
    },
    ...(opts.agents === undefined ? {} : { agents: opts.agents }),
    ...(opts.withRepair === false ? {} : { repair: verify.opts }),
  });
  return { runner, baseline, verify };
}

function ctxOf(rec: Recorded, signal: AbortSignal = new AbortController().signal): RunContext {
  return {
    jobId: "job-1", repoUrl: REPO, executionId: EXEC, attempt: 1,
    deadlineAt: new Date(Date.now() + 600_000).toISOString(), signal, report: makeReport(rec),
  };
}

const goodAgents = (): FakeAgents => new FakeAgents(() => ({ status: "ok", role: "fixer", value: proposalFor(GOOD_DIFF) }));

describe("PipelineJobRunner with repair verification", () => {
  it("records a verified repair as a separate, measured verification and keeps the proposal fields", async () => {
    const { runner, baseline, verify } = runnerWith({ agents: goodAgents() });
    const rec: Recorded = { stages: [], results: [] };
    const out = await runner.run(ctxOf(rec));
    assert.deepEqual(out, { kind: "completed" });
    assert.deepEqual(rec.stages, ["building", "testing", "diagnosing", "repairing", "verifying"]);
    assert.equal(rec.results.length, 1);
    const result = rec.results[0] as Record<string, unknown>;
    assert.equal(result["verdict"], "repository-failing", "prior verdict vocabulary is unchanged");
    assert.equal((result["fixer"] as Record<string, unknown>)["applied"], false);
    assert.equal((result["fixer"] as Record<string, unknown>)["proposalOnly"], true);
    const v = result["verification"] as Record<string, unknown>;
    assert.equal(v["status"], "verified");
    assert.equal(v["originalModified"], false);
    assert.equal(baseline.requests.length, 1);
    assert.equal(verify.pipelines.length, 1);
    assert.equal((verify.pipelines[0] as VerifyPipeline).seen[0]?.req.executionId, baseline.requests[0]?.executionId);
    assert.deepEqual(workRootEntries(), []);
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 64 * 1024);

    const view = presentResult({ jobId: "job-1", stage: "done", status: "completed", attemptCount: 1, maxAttempts: 2, infraError: null, result });
    assert.equal(view.outcome, "repair-verified");
    assert.equal(view.repair.verified, true);
    assert.equal(view.repair.patchApplied, false);
    assert.equal(view.verifiedDiff, GOOD_DIFF);
    assert.match(view.summary, /disposable copy/);
  });

  it("without the repair option a proposal is only recorded: no verification, prior behaviour", async () => {
    const { runner, verify } = runnerWith({ agents: goodAgents(), withRepair: false });
    const rec: Recorded = { stages: [], results: [] };
    assert.deepEqual(await runner.run(ctxOf(rec)), { kind: "completed" });
    assert.deepEqual(rec.stages, ["building", "testing", "diagnosing", "repairing"]);
    const result = rec.results[0] as Record<string, unknown>;
    assert.equal("verification" in result, false);
    assert.deepEqual((result["notes"] as string[])[1], "A patch proposal is never applied; no repair was verified.");
    assert.equal(verify.pipelines.length, 0);
    const view = presentResult({ jobId: "j", stage: "done", status: "completed", attemptCount: 1, maxAttempts: 2, infraError: null, result });
    assert.equal(view.outcome, "failing-with-patch-proposal");
    assert.equal(view.repair.verified, false);
    assert.equal(view.verifiedDiff, null);
  });

  it("a source without an originals reader is never repaired", async () => {
    const { runner, verify } = runnerWith({ agents: goodAgents(), source: sourceWith({ originals: false }) });
    const rec: Recorded = { stages: [], results: [] };
    assert.deepEqual(await runner.run(ctxOf(rec)), { kind: "completed" });
    assert.equal(verify.pipelines.length, 0);
    assert.equal("verification" in (rec.results[0] as Record<string, unknown>), false);
  });

  it("a tested failure is recorded and never presented as a repair", async () => {
    const { runner } = runnerWith({ agents: goodAgents(), verify: harness(patchedTestFailure) });
    const rec: Recorded = { stages: [], results: [] };
    assert.deepEqual(await runner.run(ctxOf(rec)), { kind: "completed" });
    const result = rec.results[0] as Record<string, unknown>;
    assert.equal((result["verification"] as Record<string, unknown>)["status"], "tested-failing");
    const view = presentResult({ jobId: "j", stage: "done", status: "completed", attemptCount: 1, maxAttempts: 2, infraError: null, result });
    assert.equal(view.outcome, "patch-failed-verification");
    assert.equal(view.repair.verified, false);
    assert.equal(view.verifiedDiff, null);
    assert.match(view.summary, /not a repair/);
  });

  it("a fixture without tests is not attempted and stays an unverified proposal", async () => {
    const { runner, verify } = runnerWith({ agents: goodAgents(), source: sourceWith({ test: false }) });
    const rec: Recorded = { stages: [], results: [] };
    assert.deepEqual(await runner.run(ctxOf(rec)), { kind: "completed" });
    const result = rec.results[0] as Record<string, unknown>;
    const v = result["verification"] as Record<string, unknown>;
    assert.equal(v["status"], "not-attempted");
    assert.equal(v["reason"], "no-original-tests");
    assert.equal(verify.pipelines.length, 0);
    const view = presentResult({ jobId: "j", stage: "done", status: "completed", attemptCount: 1, maxAttempts: 2, infraError: null, result });
    assert.equal(view.outcome, "failing-with-patch-proposal");
    assert.equal(view.repair.verified, false);
  });

  it("only one proposal is requested and verified", async () => {
    const agents = goodAgents();
    const { runner, verify } = runnerWith({ agents });
    await runner.run(ctxOf({ stages: [], results: [] }));
    assert.equal(agents.fixerCalls, 1);
    assert.equal(verify.pipelines.length, 1);
    assert.equal((verify.pipelines[0] as VerifyPipeline).seen.length, 1);
  });

  it("a Fixer that gave nothing is not verified", async () => {
    const agents = new FakeAgents(() => ({ status: "no-result", role: "fixer", code: "no-patch", detail: "none" }));
    const { runner, verify } = runnerWith({ agents });
    const rec: Recorded = { stages: [], results: [] };
    assert.deepEqual(await runner.run(ctxOf(rec)), { kind: "completed" });
    assert.equal(verify.pipelines.length, 0);
    assert.deepEqual(rec.stages, ["building", "testing", "diagnosing", "repairing"]);
  });

  it("a passing original is never repaired or verified", async () => {
    const { runner, verify } = runnerWith({ agents: goodAgents(), baseline: new Baseline(successResult) });
    const rec: Recorded = { stages: [], results: [] };
    assert.deepEqual(await runner.run(ctxOf(rec)), { kind: "completed" });
    assert.equal((rec.results[0] as Record<string, unknown>)["verdict"], "verified");
    assert.equal(verify.pipelines.length, 0);
    const view = presentResult({ jobId: "j", stage: "done", status: "completed", attemptCount: 1, maxAttempts: 2, infraError: null, result: rec.results[0] as Record<string, unknown> });
    assert.equal(view.outcome, "passing");
  });

  it("an inconclusive verification fails the job with no result", async () => {
    const { runner } = runnerWith({ agents: goodAgents(), verify: harness((req) => notRun(req, "docker-unavailable")) });
    const rec: Recorded = { stages: [], results: [] };
    const out: RunOutcome = await runner.run(ctxOf(rec));
    assert.equal(out.kind, "infrastructure-unavailable");
    assert.equal(rec.results.length, 0);
    assert.deepEqual(workRootEntries(), []);
  });

  it("an abort during verification is propagated and records no result", async () => {
    const ac = new AbortController();
    const { runner } = runnerWith({
      agents: goodAgents(),
      verify: harness((req) => {
        ac.abort();
        return notRun(req, "aborted");
      }),
    });
    const rec: Recorded = { stages: [], results: [] };
    assert.deepEqual(await runner.run(ctxOf(rec, ac.signal)), { kind: "aborted" });
    assert.equal(rec.results.length, 0);
    assert.deepEqual(workRootEntries(), []);
  });

  it("a rejected progress write for the verifying stage stops the run before any copy exists", async () => {
    const { runner, verify } = runnerWith({ agents: goodAgents() });
    const rec: Recorded = { stages: [], results: [] };
    const base = makeReport(rec);
    const ctx: RunContext = { ...ctxOf(rec), report: { ...base, stage: (s) => (s === "verifying" ? false : base.stage(s)) } };
    assert.deepEqual(await runner.run(ctx), { kind: "aborted" });
    assert.equal(verify.pipelines.length, 0);
    assert.equal(rec.results.length, 0);
  });

  it("the runner's cleanup proof for the shared execution id is requested for the verified run", async () => {
    const cleanups: string[] = [];
    const { runner } = runnerWith({ agents: goodAgents(), cleanups });
    await runner.run(ctxOf({ stages: [], results: [] }));
    const proof = await runner.cleanup({ jobId: "job-1", executionId: EXEC, attempt: 1, workerId: "w" });
    assert.equal(proof.confirmed, true);
    assert.deepEqual(cleanups, [EXEC]);
  });
});

describe("repair verification through JobWorker and the result view", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("stores one result with the verification and the view re-checks it", async () => {
    const { runner } = runnerWith({ agents: goodAgents() });
    const worker = new JobWorker({ db, workerId: "w-test", runner });
    const id = createJob(db, { repoUrl: REPO, rawToken: generateRawToken() }).jobId;
    const res = await worker.runOnce();
    assert.deepEqual(res, { kind: "finished", jobId: id, outcome: "completed" });

    const rows = db.prepare("SELECT event_type, payload FROM job_events WHERE job_id = ? ORDER BY seq").all(id) as Array<{ event_type: string; payload: string }>;
    const stages = rows.filter((r) => r.event_type === "stage").map((r) => (JSON.parse(r.payload) as { stage: string }).stage);
    assert.deepEqual(stages, ["building", "testing", "diagnosing", "repairing", "verifying"]);
    const results = rows.filter((r) => r.event_type === "result");
    assert.equal(results.length, 1);
    const result = (JSON.parse((results[0] as { payload: string }).payload) as { result: Record<string, unknown> }).result;
    assert.equal((result["verification"] as Record<string, unknown>)["status"], "verified");
    const job = db.prepare("SELECT status, stage FROM jobs WHERE id = ?").get(id) as { status: string; stage: string };
    assert.equal(job.status, "completed");
    assert.equal(job.stage, "done");
    const view = presentResult({ jobId: id, stage: "done", status: "completed", attemptCount: 1, maxAttempts: 2, infraError: null, result });
    assert.equal(view.outcome, "repair-verified");
  });

  it("a worker shutdown while verifying discards the result and removes the copy", async () => {
    const holder: { w: JobWorker | null } = { w: null };
    const { runner } = runnerWith({
      agents: goodAgents(),
      verify: harness((req) => {
        // shutdown() aborts the run synchronously; it is deliberately not awaited from inside the run.
        void holder.w?.shutdown();
        return successResult(req);
      }),
    });
    holder.w = new JobWorker({ db, workerId: "w-test", runner });
    const id = createJob(db, { repoUrl: REPO, rawToken: generateRawToken() }).jobId;
    const res = await holder.w.runOnce();
    assert.equal(res.kind, "finished");
    const results = db.prepare("SELECT 1 FROM job_events WHERE job_id = ? AND event_type = 'result'").all(id);
    assert.equal(results.length, 0, "no result is stored after an abort");
    assert.deepEqual(workRootEntries(), []);
  });
});

describe("result view re-checks the stored verification", () => {
  async function storedVerified(): Promise<Record<string, unknown>> {
    const { runner } = runnerWith({ agents: goodAgents() });
    const rec: Recorded = { stages: [], results: [] };
    await runner.run(ctxOf(rec));
    return JSON.parse(JSON.stringify(rec.results[0])) as Record<string, unknown>;
  }
  const outcomeOf = (result: Record<string, unknown>): string =>
    presentResult({ jobId: "j", stage: "done", status: "completed", attemptCount: 1, maxAttempts: 2, infraError: null, result }).outcome;

  it("downgrades a record that no longer matches its diff", async () => {
    const r = await storedVerified();
    assert.equal(outcomeOf(r), "repair-verified");
    (r["fixer"] as Record<string, unknown>)["diff"] = `${GOOD_DIFF}\n`;
    assert.equal(outcomeOf(r), "failing-with-patch-proposal");
  });

  it("downgrades when the observed statuses, cleanup or patch class do not support the claim", async () => {
    const mutations: Array<(v: Record<string, unknown>, r: Record<string, unknown>) => void> = [
      (v) => ((v["patched"] as Record<string, unknown>)["status"] = "failure"),
      (v) => ((v["tester"] as Record<string, unknown>)["status"] = "not-run"),
      (v) => ((v["cleanup"] as Record<string, unknown>)["confirmed"] = false),
      (v) => ((v["cleanup"] as Record<string, unknown>)["stagingRemoved"] = false),
      (v) => ((v["cleanup"] as Record<string, unknown>)["cloneRemoved"] = false),
      (v) => (v["cleanup"] = null),
      (v) => (v["patchClass"] = "anything"),
      (v) => (v["originalModified"] = true),
      (v) => (v["patchedFiles"] = ["build.mjs", "test.mjs"]),
      (v) => ((v["baseline"] as Record<string, unknown>)["status"] = "success"),
      (v) => (v["measuredMs"] = "fast"),
      (_v, r) => ((r["tester"] as Record<string, unknown>)["status"] = "passed"),
      (_v, r) => ((r["pipeline"] as Record<string, unknown>)["status"] = "success"),
      (_v, r) => ((r["fixer"] as Record<string, unknown>)["files"] = ["test.mjs"]),
    ];
    for (const [i, mutate] of mutations.entries()) {
      const r = await storedVerified();
      mutate(r["verification"] as Record<string, unknown>, r);
      assert.equal(outcomeOf(r), "failing-with-patch-proposal", `mutation ${String(i)}`);
    }
  });

  it("a verified record without a modelAuthored proposal is not a repair", async () => {
    const r = await storedVerified();
    (r["fixer"] as Record<string, unknown>)["modelAuthored"] = false;
    assert.equal(outcomeOf(r), "failing-with-diagnosis");
  });

  it("results stored before verification existed keep their outcome", () => {
    const old: Record<string, unknown> = {
      verdict: "repository-failing",
      analyst: { status: "ok", modelAuthored: true },
      fixer: { status: "ok", modelAuthored: true, proposalOnly: true, applied: false, diff: GOOD_DIFF, files: ["build.mjs"] },
    };
    assert.equal(outcomeOf(old), "failing-with-patch-proposal");
  });
});
