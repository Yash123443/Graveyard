/**
 * npm-scripts-flow.ts — pure result building for the opt-in npm-scripts mode. No I/O, no process.
 * Written without a shell or a test run (UNVERIFIED; see backend/DEVELOPMENT.md).
 *
 * The stored result keeps the existing result contract so GET /api/jobs/:id/result and result-view.ts
 * need no change:
 *   verdict "verified"            install, build and test all passed (measured), cleanup confirmed
 *   verdict "repository-failing"  install, build or test exited nonzero (measured), cleanup confirmed
 *   verdict "unsupported-repository"  outside the profile (nothing was run)
 * Anything inconclusive (timeout, truncation, malformed protocol, summary mismatch, unconfirmed
 * cleanup, a test stage that did not run) is NOT a result: the job fails as infrastructure.
 * The result view therefore reports "passing" or "failing-undiagnosed". Without the explicit agent setup
 * there is never an analyst diagnosis, a fixer proposal or a verification record in this mode: no
 * repository source is sent to Kiro and no patch is proposed, applied or verified, so
 * `repair.verified` is always false. With agents configured AND a build-stage failure of a simple
 * `node FILE` build script, github-runner.ts adds the opt-in verified repair on top of this payload
 * (npm-scripts-repair.ts: `analyst`, `fixer`, `verification` and `repairEligibility` are added; the
 * verdict, pipeline, Tester and snapshot facts are unchanged).
 *
 * Container output (the per-stage stdout/stderr tails) is untrusted text and is NOT stored. The
 * result carries only observed statuses, exit codes and durations.
 *
 * @module npm-scripts-flow
 */

import type { ControlledPipelineResult } from "./controlled-pipeline.js";
import { SCRIPTS_CONTAINER_LIMITS, SCRIPTS_COPY_LIMITS } from "./npm-scripts-driver.js";
import { NPM_SCRIPTS_RUN_MODE, type ScriptsFinding, type ScriptsPlanOk } from "./npm-scripts-policy.js";
import { SNAPSHOT_LIMITS } from "./npm-scripts-snapshot.js";
import { projectPipeline } from "./pipeline-runner.js";
import { buildPipelineTesterReport } from "./tester.js";

export interface ScriptsSnapshotFacts {
  name: string;
  files: number;
  directories: number;
  totalBytes: number;
  archiveSha256: string;
}

export type ScriptsJudgement = { kind: "infrastructure"; reason: string } | { kind: "result"; payload: Record<string, unknown> };

/** The fixed limits of this mode, recorded in every executed result so a reader knows what was bounded. */
export function scriptsRuntimeLimits(): Record<string, unknown> {
  return {
    network: "none",
    user: "65532:65532",
    snapshotMaxFiles: SNAPSHOT_LIMITS.maxFiles,
    snapshotMaxBytes: SNAPSHOT_LIMITS.maxTotalBytes,
    installTimeoutMs: SCRIPTS_CONTAINER_LIMITS.installTimeoutMs,
    buildTimeoutMs: SCRIPTS_CONTAINER_LIMITS.buildTimeoutMs,
    testTimeoutMs: SCRIPTS_CONTAINER_LIMITS.testTimeoutMs,
    containerTimeoutMs: 120_000,
    copyMaxFiles: SCRIPTS_COPY_LIMITS.maxFiles,
  };
}

/**
 * Turns the offline pipeline result into a stored result or an infrastructure failure. The checks
 * mirror PipelineJobRunner: a verdict needs proof for exactly this execution whatever the pipeline
 * said, and the Tester re-derives the statuses from the observed stages.
 */
export function judgeScriptsRun(args: {
  pipeline: ControlledPipelineResult;
  executionId: string;
  repoUrl: string;
  commit: string;
  plan: ScriptsPlanOk;
  snapshot: ScriptsSnapshotFacts;
}): ScriptsJudgement {
  const r = args.pipeline;
  let effective = r;
  if (r.status !== "not-run" && (r.executionId !== args.executionId || r.cleanup === null || r.cleanup.confirmed !== true || r.stagingRemoved !== true)) {
    effective = { ...r, status: "not-run", reason: "cleanup-unconfirmed" };
  }
  if (effective.status === "not-run") {
    return { kind: "infrastructure", reason: `The npm scripts run did not produce a verdict (${effective.reason}); no result was recorded.` };
  }
  const tester = buildPipelineTesterReport(effective);
  let verdict: "verified" | "repository-failing";
  if (effective.status === "success" && tester.status === "passed") verdict = "verified";
  else if (effective.status === "failure" && tester.status === "failed") verdict = "repository-failing";
  else return { kind: "infrastructure", reason: "The pipeline verdict and the Tester report disagree; no result was recorded." };

  return {
    kind: "result",
    payload: {
      verdict,
      sourceKind: "github-pinned",
      runMode: NPM_SCRIPTS_RUN_MODE,
      source: { repoUrl: args.repoUrl, commit: args.commit },
      fixture: args.snapshot.name,
      executed: true,
      scripts: {
        build: { command: "npm run build", declared: args.plan.buildScript },
        test: { command: "npm run test", declared: args.plan.testScript },
        hooksDisabled: true,
        installScriptsDisabled: true,
      },
      snapshot: {
        files: args.snapshot.files,
        directories: args.snapshot.directories,
        totalBytes: args.snapshot.totalBytes,
        archiveSha256: args.snapshot.archiveSha256,
        packageJsonSha256: args.plan.originalPackageJsonSha256,
        installManifestSha256: args.plan.sanitizedPackageJsonSha256,
        packageLockSha256: args.plan.packageLockSha256,
      },
      limits: scriptsRuntimeLimits(),
      pipeline: projectPipeline(effective),
      tester,
      analyst: { status: "not-applicable", reason: "npm-scripts mode sends no repository source to any model" },
      fixer: { status: "not-applicable", reason: "npm-scripts mode never proposes, applies or verifies a patch" },
      notes: [
        "The source is a public GitHub repository fetched at the pinned commit. A bounded snapshot of its files was mounted read-only into a network-none container.",
        "Dependencies were acquired through the registry-only proxy from a manifest with its scripts removed and the unchanged lockfile, then installed offline with lifecycle scripts disabled.",
        "The repository's own `npm run build` and `npm run test` were run with pre/post hooks disabled. Their output is not stored. This is a measurement, not a repair: no patch was proposed, applied or verified.",
      ],
    },
  };
}

/** Payload for a repository outside the profile. Nothing was run; this is not a verdict on the repository. */
export function scriptsUnsupportedPayload(repoUrl: string, commit: string, findings: readonly ScriptsFinding[]): Record<string, unknown> {
  return {
    verdict: "unsupported-repository",
    sourceKind: "github-pinned",
    runMode: NPM_SCRIPTS_RUN_MODE,
    source: { repoUrl, commit },
    analysis: {
      supported: false,
      findings: findings.map((f) => ({ code: f.code, detail: f.detail })),
    },
    executed: false,
    notes: [
      "The commit was fetched in a disposable container and inspected as data. Nothing was installed, built or run.",
      "Unsupported means outside this worker's narrow npm-scripts profile. It is not a verdict that the repository is broken or fixable.",
    ],
  };
}
