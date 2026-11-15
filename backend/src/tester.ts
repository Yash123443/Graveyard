/**
 * tester.ts — deterministic Tester report derived ONLY from independently observed stage results.
 *
 * Foundation only. Pure function, no model, no process, no I/O. Not wired to any job. Written
 * without running the compiler or tests (see backend/DEVELOPMENT.md).
 *
 * The input is the `StageResult` records produced by the sandbox runner (node-fixture-runner.ts),
 * which come from observed exit codes, machine-checked output and confirmed container cleanup.
 * There is deliberately no parameter that accepts agent or model text, so a model cannot assert
 * that a build or test passed. The Tester re-checks the evidence behind every "passed" instead of
 * trusting the runner's label alone:
 *   passed  = observed exit code 0 AND container cleanup confirmed AND output not truncated
 *             (tests also: at least one test passed, none failed or were cancelled)
 *   failed  = observed nonzero exit code, or the test counts show failures
 *   not-run = everything else: missing stage, inconclusive runner result, timeout, cancel, no tests
 *
 * @module tester
 */

import type { StageResult } from "./node-fixture-runner.js";
import type { ControlledPipelineResult } from "./controlled-pipeline.js";

export type TesterStatus = "passed" | "failed" | "not-run";

export type TesterStageReason =
  | "observed-pass"
  | "observed-failure"
  | "not-observed"
  | "stage-mismatch"
  | "no-tests"
  | "inconclusive"
  | "unconfirmed-evidence";

export interface TesterStage {
  status: TesterStatus;
  reason: TesterStageReason;
  /** The runner's own reason code, copied verbatim (restricted charset), for traceability. */
  runnerReason: string | null;
}

export type TesterReason = "all-stages-passed" | "stage-failed" | "tests-not-run" | "stage-not-run";

export interface TesterReport {
  /** passed only when both stages are passed. */
  status: TesterStatus;
  reason: TesterReason;
  build: TesterStage;
  test: TesterStage;
  /** Always the runner: this report never contains model-authored content. */
  source: "runner-observation";
}

export interface TesterInput {
  build: StageResult | null;
  test: StageResult | null;
}

const NOT_OBSERVED: TesterStage = Object.freeze({ status: "not-run", reason: "not-observed", runnerReason: null });

function safeReason(s: unknown): string | null {
  return typeof s === "string" && /^[a-z0-9-]{1,48}$/.test(s) ? s : null;
}

function judgeStage(expected: "build" | "test", r: StageResult | null): TesterStage {
  if (r === null || r === undefined) return { ...NOT_OBSERVED };
  const runnerReason = safeReason(r.reason);
  if (r.stage !== expected) return { status: "not-run", reason: "stage-mismatch", runnerReason };

  if (r.status === "failed") {
    const nonzeroExit = typeof r.exitCode === "number" && r.exitCode !== 0;
    const countedFailures = expected === "test" && r.counts !== null && r.counts !== undefined && r.counts.fail > 0;
    if (nonzeroExit || countedFailures) return { status: "failed", reason: "observed-failure", runnerReason };
    return { status: "not-run", reason: "inconclusive", runnerReason };
  }

  if (r.status === "passed") {
    const cleanupConfirmed = r.cleanup !== null && r.cleanup !== undefined && r.cleanup.confirmed === true;
    if (r.exitCode !== 0 || r.truncated || !cleanupConfirmed) {
      return { status: "not-run", reason: "unconfirmed-evidence", runnerReason };
    }
    if (expected === "test") {
      const c = r.counts;
      if (c === null || c === undefined || c.pass < 1 || c.fail !== 0 || c.cancelled !== 0) {
        return { status: "not-run", reason: "unconfirmed-evidence", runnerReason };
      }
    }
    return { status: "passed", reason: "observed-pass", runnerReason };
  }

  const noTests = r.reason === "no-tests-found" || r.reason === "no-tests-executed";
  return { status: "not-run", reason: expected === "test" && noTests ? "no-tests" : "inconclusive", runnerReason };
}

export function buildTesterReport(input: TesterInput): TesterReport {
  const build = judgeStage("build", input.build);
  const test = judgeStage("test", input.test);
  let status: TesterStatus;
  let reason: TesterReason;
  if (build.status === "failed" || test.status === "failed") {
    status = "failed";
    reason = "stage-failed";
  } else if (build.status === "passed" && test.status === "passed") {
    status = "passed";
    reason = "all-stages-passed";
  } else {
    status = "not-run";
    reason = build.status === "passed" && test.reason === "no-tests" ? "tests-not-run" : "stage-not-run";
  }
  return { status, reason, build, test, source: "runner-observation" };
}



// ---------------------------------------------------------------------------
// Report for the integrated controlled pipeline (install, build, test in one container)
// ---------------------------------------------------------------------------

export type PipelineTesterReason =
  | "all-stages-passed"
  | "stage-failed"
  | "tests-not-run"
  | "stage-not-run"
  | "evidence-unconfirmed";

export interface PipelineTesterReport {
  status: TesterStatus;
  reason: PipelineTesterReason;
  install: TesterStage;
  build: TesterStage;
  test: TesterStage;
  source: "runner-observation";
}

type PipelineStageName = "install" | "build" | "test";

function judgePipelineStage(name: PipelineStageName, r: ControlledPipelineResult): TesterStage {
  const s = r.stages?.find((x) => x.stage === name);
  if (s === undefined) return { ...NOT_OBSERVED };
  const runnerReason = safeReason(s.reason);
  if (s.status === "passed") return { status: "passed", reason: "observed-pass", runnerReason };
  if (s.status === "failed") {
    const nonzeroExit = s.reason === "exit-code" && typeof s.exitCode === "number" && s.exitCode !== 0;
    return nonzeroExit
      ? { status: "failed", reason: "observed-failure", runnerReason }
      : { status: "not-run", reason: "inconclusive", runnerReason };
  }
  if (s.status === "not-run") {
    return { status: "not-run", reason: name === "test" ? "no-tests" : "inconclusive", runnerReason };
  }
  return { status: "not-run", reason: "not-observed", runnerReason };
}

/**
 * Tester report for a ControlledPipelineResult. It re-checks the evidence instead of trusting the
 * pipeline's label: a "passed" or "failed" overall status needs the pipeline's own matching verdict
 * (success / failure), a strictly parsed stage list, confirmed container cleanup, confirmed staging
 * removal and untruncated output. Anything else is "not-run" with `evidence-unconfirmed`. No model
 * or free text is accepted; per-stage text from the container never enters the report.
 */
export function buildPipelineTesterReport(r: ControlledPipelineResult): PipelineTesterReport {
  const evidenceOk =
    r.stages !== null &&
    r.cleanup !== null && r.cleanup.confirmed === true &&
    r.stagingRemoved === true &&
    !r.truncated &&
    r.executionId !== null;
  if (!evidenceOk) {
    return {
      status: "not-run",
      reason: "evidence-unconfirmed",
      install: { status: "not-run", reason: "unconfirmed-evidence", runnerReason: null },
      build: { status: "not-run", reason: "unconfirmed-evidence", runnerReason: null },
      test: { status: "not-run", reason: "unconfirmed-evidence", runnerReason: null },
      source: "runner-observation",
    };
  }
  const install = judgePipelineStage("install", r);
  const build = judgePipelineStage("build", r);
  const test = judgePipelineStage("test", r);

  let status: TesterStatus;
  let reason: PipelineTesterReason;
  if (r.status === "success" && install.status === "passed" && build.status === "passed" && test.status === "passed") {
    status = "passed";
    reason = "all-stages-passed";
  } else if (r.status === "failure" && [install, build, test].some((s) => s.status === "failed")) {
    status = "failed";
    reason = "stage-failed";
  } else {
    status = "not-run";
    reason =
      r.reason === "tests-not-run" && install.status === "passed" && build.status === "passed" && test.reason === "no-tests"
        ? "tests-not-run"
        : "stage-not-run";
  }
  return { status, reason, install, build, test, source: "runner-observation" };
}
