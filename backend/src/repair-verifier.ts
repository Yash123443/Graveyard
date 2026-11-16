/**
 * repair-verifier.ts — verification of ONE model-proposed patch against a disposable copy.
 *
 * Written without a shell or compiler (see backend/DEVELOPMENT.md): compiled and run only when an
 * operator does so. Nothing here is verified until external results are logged.
 *
 * What it does, in order. Every step fails closed; a refusal is data (`not-attempted`), an
 * infrastructure problem or an abort is reported to the caller, never as a repair:
 *   1. Gate: the baseline run of the UNMODIFIED source observed a repository failure, with
 *      confirmed container cleanup and staging removal for the same execution id.
 *   2. Patch class: the only supported patch modifies the complete original root `build.mjs`.
 *      The original `test.mjs`, `package.json` and `package-lock.json` are never changed. An
 *      original without `test.mjs` is refused (no tests means nothing can verify a repair).
 *   3. Evidence: the file the agents saw must have been complete and must still equal the
 *      original read now (stale evidence is refused).
 *   4. Application: `applyBuildPatch` re-runs the strict diff validation (agent-contract
 *      parseUnifiedDiff) against the exact original text, then applies the hunks IN MEMORY,
 *      re-checking every old-side line at its exact position. No `patch`, no `git apply`, no
 *      subprocess. An empty result or a no-op is refused.
 *   5. Verification: the patched `build.mjs` plus the byte-identical `test.mjs`, `package.json`
 *      and `package-lock.json` are written to a fresh clone directory owned by this call
 *      (fixture-workspace: exclusive creates, non-recursive removal), and the existing offline
 *      pipeline runs install, build and test in the network-`none` container, reusing the offline
 *      npm cache that is mounted read-only. The clone is removed before returning on every path.
 *      The original source directory is only ever read, and nothing from the repository runs on
 *      the host.
 *   6. The verdict is `verified` only when the pipeline reports success, the Tester report
 *      (re-derived from the observed stages) is `passed`, and container cleanup and staging
 *      removal are confirmed. A pipeline failure is `tested-failing`. Anything inconclusive is
 *      infrastructure, never a verdict on the patch.
 *
 * Execution id. The verification reuses the baseline's execution id. That is only allowed because
 * the baseline's container cleanup and staging removal were confirmed first, and the two runs are
 * strictly serial. The worker's cleanup and recovery proof, which asks Docker for any container
 * labelled with the execution id, therefore covers the second run too.
 *
 * Known limits: the evidence that the patch is a repair is the offline install, build and test of
 * the patched copy. It is not a review of the change and does not show the tests are sufficient.
 * `package.json` and the lockfile of a catalog fixture are re-read from disk for the clone; a
 * change made by someone else between the baseline run and the clone would not be detected there.
 *
 * @module repair-verifier
 */

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseUnifiedDiff, type PatchProposal } from "./agent-contract.js";
import type { ControlledPipelineResult, PipelineRequest } from "./controlled-pipeline.js";
import { isBuildEntryName } from "./build-entry.js";
import { createRunDir, removeRunDir, writeFixture } from "./fixture-workspace.js";
import { buildPipelineTesterReport, type PipelineTesterReport } from "./tester.js";

export const PATCH_TARGET = "build.mjs";
export const PATCH_CLASS = "root-build-mjs-only";
const MAX_FILE_BYTES = 64 * 1024;
const FIXTURE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

export interface RepairOriginals {
  packageJson: string;
  packageLock: string;
  buildMjs: string;
  /** null when the original has no test.mjs. */
  testMjs: string | null;
}

/** Same shape as the pipeline's own `run` contract (structural, avoids a module cycle). */
export interface VerifyPipelineLike {
  run(req: PipelineRequest): Promise<ControlledPipelineResult>;
}

export interface RepairOptions {
  /** Existing real directory that owns the clone directories (`run-<12 hex>`, created and removed here). */
  workRoot: string;
  /**
   * Offline pipeline whose fixturesRoot is `cloneRoot`, with the offline cache bound already.
   * Returns null when there is no verification environment (then nothing is attempted). May throw
   * (reported as infrastructure).
   */
  makePipeline: (cloneRoot: string) => VerifyPipelineLike | null;
  /** Injectable clock (ms). */
  now?: () => number;
  /** Injectable clone fixture name; must match the fixture name pattern. */
  cloneName?: () => string;
}

export type NotAttemptedReason =
  | "baseline-not-observed"
  | "no-original-tests"
  | "evidence-incomplete"
  | "evidence-stale"
  | "originals-unavailable"
  | "originals-too-large"
  | "original-unsuitable"
  | "diff-invalid"
  | "path-not-allowed"
  | "hunk-mismatch"
  | "no-op"
  | "patched-unsuitable"
  | "no-verification-environment";

const DETAILS: Readonly<Record<NotAttemptedReason, string>> = {
  "baseline-not-observed": "No repository failure with confirmed cleanup was observed for the original, so no repair was attempted.",
  "no-original-tests": "The original has no test.mjs. Without tests nothing can verify a repair, so the proposal was not applied.",
  "evidence-incomplete": "The proposal was not based on the complete original build.mjs, so it was not applied.",
  "evidence-stale": "The evidence the proposal was based on no longer equals the original files, so it was not applied.",
  "originals-unavailable": "The original files could not be read for the disposable copy, so nothing was applied.",
  "originals-too-large": "An original file is larger than the verification copy allows, so nothing was applied.",
  "original-unsuitable": "The original build.mjs cannot be patched exactly (control characters, carriage returns or no final newline).",
  "diff-invalid": "The proposed diff is not a valid, supported diff of the original build.mjs, so it was not applied.",
  "path-not-allowed": "The proposed diff touches a path other than the root build.mjs, so it was not applied.",
  "hunk-mismatch": "The proposed hunks do not match the exact original lines and positions, so it was not applied.",
  "no-op": "The proposed diff does not change the original build.mjs, so there is nothing to verify.",
  "patched-unsuitable": "The patched build.mjs would be empty or too large, so it was not run.",
  "no-verification-environment": "No offline environment was available to verify the proposal, so it was not run.",
};

export type VerificationStatus = "verified" | "tested-failing" | "not-attempted";

/** The recorded, JSON-safe verification of one proposal. Fixed vocabulary; no model or container text. */
export interface RepairVerification {
  status: VerificationStatus;
  /** NotAttemptedReason, `all-stages-passed`, or the pipeline's failure reason (install-failed, build-failed, test-failed). */
  reason: string;
  /** Fixed explanatory text chosen by this module. */
  detail: string;
  patchClass: typeof PATCH_CLASS;
  /** sha256 of the exact diff text that was applied (and is stored as fixer.diff). */
  diffSha256: string | null;
  patchedFiles: string[];
  /** sha256 of the patched build.mjs when a copy was built. */
  patchedBuildSha256: string | null;
  /** Always false: the original source is never modified. The patch exists only in a disposable copy. */
  originalModified: false;
  baseline: { status: string; reason: string; failedStage: string | null };
  /** Observed result of the patched copy's pipeline run; null when nothing was run. */
  patched: Record<string, unknown> | null;
  /** Tester report of the patched copy's run; null when nothing was run. */
  tester: PipelineTesterReport | null;
  /** Wall time of this separate verification (patch, copy, offline run, removal), measured by the host. */
  measuredMs: number;
  /** The patched pipeline's own total duration of its container, when reported. */
  pipelineMs: number | null;
  cleanup: { confirmed: boolean; stagingRemoved: boolean; cloneRemoved: boolean } | null;
}

export type RepairAttempt =
  | { kind: "verification"; verification: RepairVerification }
  | { kind: "aborted" }
  | { kind: "infrastructure"; reason: string };

// ---------------------------------------------------------------------------
// Pure patch application
// ---------------------------------------------------------------------------

export type ApplyResult =
  | { ok: true; patched: string; hunks: number; added: number; removed: number }
  | { ok: false; reason: NotAttemptedReason };

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const rej = (reason: NotAttemptedReason): { ok: false; reason: NotAttemptedReason } => ({ ok: false, reason });

/**
 * Applies `diff` to the COMPLETE original `build.mjs` text in memory. Pure: no filesystem, no
 * process. Strict validation (agent-contract) first, then an independent position-by-position
 * application that re-checks every context and removed line against the original.
 */
export function applyBuildPatch(original: string, diff: string, target: string = PATCH_TARGET): ApplyResult {
  if (typeof original !== "string" || typeof diff !== "string") return rej("diff-invalid");
  // `target` is the one file the diff may touch: the legacy default `build.mjs`, or (npm-scripts
  // mode) a simple root build entry chosen by the caller from the declared build script.
  if (!isBuildEntryName(target)) return rej("path-not-allowed");
  if (Buffer.byteLength(original, "utf8") > MAX_FILE_BYTES) return rej("originals-too-large");
  if (original.length === 0 || CONTROL_RE.test(original) || !original.endsWith("\n")) return rej("original-unsuitable");

  const parsed = parseUnifiedDiff(diff, new Map([[target, { complete: true, text: original }]]));
  if (!parsed.ok) {
    if (parsed.code === "path-not-in-evidence" || parsed.code === "unsafe-path") return rej("path-not-allowed");
    if (parsed.code === "context-mismatch") return rej("hunk-mismatch");
    return rej("diff-invalid");
  }
  const p = parsed.value;
  if (p.files.length !== 1 || p.files[0] !== target || !p.contextVerified) return rej("path-not-allowed");
  if (p.diff !== diff) return rej("diff-invalid"); // must already be the normalised, newline-terminated form

  const dl = diff.split("\n");
  dl.pop(); // text ends with "\n"
  if (dl.some((l) => l.startsWith("\\"))) return rej("diff-invalid"); // no-newline markers are not supported

  const orig = original.split("\n");
  orig.pop(); // original ends with "\n"
  const out: string[] = [];
  let pos = 0;
  let i = 2; // after the two file headers, which parseUnifiedDiff has checked
  let hunks = 0;
  let added = 0;
  let removed = 0;
  while (i < dl.length) {
    const m = HUNK_RE.exec(dl[i] ?? "");
    if (m === null) return rej("diff-invalid");
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    i += 1;
    const startIdx = oldCount === 0 ? oldStart : oldStart - 1;
    if (startIdx < pos || startIdx > orig.length) return rej("hunk-mismatch");
    for (; pos < startIdx; pos += 1) out.push(orig[pos] as string);
    // The new-side start must equal the position this hunk really has in the patched output:
    // the 1-based line after the lines already emitted, or, for a zero-count new side
    // (pure deletion), the line BEFORE the hunk, which is the number of lines already emitted.
    const expectedNewStart = newCount === 0 ? out.length : out.length + 1;
    if (newStart !== expectedNewStart) return rej("hunk-mismatch");
    let o = 0;
    let n = 0;
    while (o < oldCount || n < newCount) {
      const l = dl[i];
      if (l === undefined) return rej("diff-invalid");
      const tag = l.charAt(0);
      const body = l.slice(1);
      if (tag === " ") {
        if (orig[pos] !== body) return rej("hunk-mismatch");
        out.push(body);
        pos += 1;
        o += 1;
        n += 1;
      } else if (tag === "-") {
        if (orig[pos] !== body) return rej("hunk-mismatch");
        pos += 1;
        o += 1;
        removed += 1;
      } else if (tag === "+") {
        out.push(body);
        n += 1;
        added += 1;
      } else {
        return rej("diff-invalid");
      }
      i += 1;
    }
    hunks += 1;
  }
  for (; pos < orig.length; pos += 1) out.push(orig[pos] as string);
  if (hunks === 0) return rej("diff-invalid");
  if (out.length === 0) return rej("patched-unsuitable");

  const patched = `${out.join("\n")}\n`;
  if (patched === original) return rej("no-op");
  if (Buffer.byteLength(patched, "utf8") > MAX_FILE_BYTES) return rej("patched-unsuitable");
  return { ok: true, patched, hunks, added, removed };
}

// ---------------------------------------------------------------------------
// Reading originals of a catalog fixture (host reads plain files only)
// ---------------------------------------------------------------------------

function readPlain(path: string, optional: boolean): string | null | undefined {
  // string: content, null: optional and absent, undefined: unacceptable
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
    const buf = readFileSync(path);
    const text = buf.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buf)) return undefined; // not exact UTF-8: the copy would differ byte for byte
    return text;
  } catch (e) {
    if (optional && (e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return undefined;
  }
}

/**
 * Reads package.json, package-lock.json, build.mjs and (optionally) test.mjs of
 * `<fixturesRoot>/<fixture>` as plain regular files, at most 64 KiB each, exact UTF-8. Returns null
 * when anything is wrong. Never throws.
 */
export function readFixtureOriginals(fixturesRoot: string, fixture: string): RepairOriginals | null {
  try {
    if (!isAbsolute(fixturesRoot) || !FIXTURE_NAME_RE.test(fixture)) return null;
    const root = realpathSync(resolve(fixturesRoot));
    const dir = realpathSync(resolve(root, fixture));
    const rel = relative(root, dir);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    const packageJson = readPlain(join(dir, "package.json"), false);
    const packageLock = readPlain(join(dir, "package-lock.json"), false);
    const buildMjs = readPlain(join(dir, "build.mjs"), false);
    const testMjs = readPlain(join(dir, "test.mjs"), true);
    if (typeof packageJson !== "string" || typeof packageLock !== "string" || typeof buildMjs !== "string" || testMjs === undefined) return null;
    return { packageJson, packageLock, buildMjs, testMjs };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyInput {
  /** The baseline's execution id. The verification reuses it (see the module header). */
  executionId: string;
  proposal: PatchProposal;
  /** The baseline result of the UNMODIFIED source, after the runner's own evidence checks. */
  baseline: ControlledPipelineResult;
  /** build.mjs as the agents were shown it. */
  evidenceBuild: { text: string; complete: boolean } | null;
  /** test.mjs as the agents were shown it. */
  evidenceTest: { text: string } | null;
  /** Reads the originals now (fixture: from disk; GitHub: the in-memory root files). */
  originals: () => RepairOriginals | null;
  signal: AbortSignal;
}

function projectPatched(r: ControlledPipelineResult): Record<string, unknown> {
  return {
    status: r.status,
    reason: r.reason,
    failedStage: r.failedStage,
    packagesAdded: r.packagesAdded,
    expectedPackages: r.expectedPackages,
    stages: (r.stages ?? []).map((s) => ({
      stage: s.stage,
      status: s.status,
      reason: s.reason ?? null,
      exitCode: s.exitCode ?? null,
      durationMs: s.durationMs,
    })),
  };
}

/** Never throws. Serial: the caller must not run anything else under the same execution id meanwhile. */
export async function verifyRepair(opts: RepairOptions, input: VerifyInput): Promise<RepairAttempt> {
  const now = opts.now ?? ((): number => Date.now());
  const started = now();
  try {
    return await verifyInner(opts, input, now, started);
  } catch {
    return { kind: "infrastructure", reason: "The repair verification raised an unexpected error; no verdict was recorded." };
  }
}

async function verifyInner(opts: RepairOptions, input: VerifyInput, now: () => number, started: number): Promise<RepairAttempt> {
  if (input.signal.aborted) return { kind: "aborted" };
  const b = input.baseline;
  const baseline = { status: b.status, reason: b.reason, failedStage: b.failedStage };
  const diff = input.proposal.diff;
  const diffSha256 = typeof diff === "string" ? sha256(diff) : null;

  const refuse = (reason: NotAttemptedReason): RepairAttempt => ({
    kind: "verification",
    verification: {
      status: "not-attempted",
      reason,
      detail: DETAILS[reason],
      patchClass: PATCH_CLASS,
      diffSha256,
      patchedFiles: [],
      patchedBuildSha256: null,
      originalModified: false,
      baseline,
      patched: null,
      tester: null,
      measuredMs: Math.max(0, now() - started),
      pipelineMs: null,
      cleanup: null,
    },
  });

  // 1. Baseline gate.
  if (
    b.status !== "failure" ||
    b.executionId !== input.executionId ||
    b.cleanup === null ||
    b.cleanup.confirmed !== true ||
    b.stagingRemoved !== true
  ) {
    return refuse("baseline-not-observed");
  }
  const baseTester = buildPipelineTesterReport(b);
  if (baseTester.status !== "failed") return refuse("baseline-not-observed");

  // 2. Original tests are required.
  if (input.evidenceTest === null) return refuse("no-original-tests");

  // 3. Evidence completeness and freshness.
  if (input.evidenceBuild === null || input.evidenceBuild.complete !== true || input.proposal.contextVerified !== true) {
    return refuse("evidence-incomplete");
  }
  const originals = input.originals();
  if (originals === null) return refuse("originals-unavailable");
  if (originals.testMjs === null) return refuse("evidence-stale");
  if (originals.buildMjs !== input.evidenceBuild.text || originals.testMjs !== input.evidenceTest.text) return refuse("evidence-stale");
  for (const text of [originals.packageJson, originals.packageLock, originals.buildMjs, originals.testMjs]) {
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) return refuse("originals-too-large");
  }

  // 4. Pure, in-memory application with exact position re-checks.
  if (typeof diff !== "string") return refuse("diff-invalid");
  const applied = applyBuildPatch(originals.buildMjs, diff);
  if (!applied.ok) return refuse(applied.reason);

  // 5. Disposable copy. Created and removed here, on every path.
  const cloneName = (opts.cloneName ?? ((): string => `repair-${randomBytes(6).toString("hex")}`))();
  if (!FIXTURE_NAME_RE.test(cloneName)) {
    return { kind: "infrastructure", reason: "The verification copy name is invalid; nothing was run." };
  }
  let cloneRun: string;
  try {
    cloneRun = createRunDir(opts.workRoot);
  } catch {
    return { kind: "infrastructure", reason: "A directory for the verification copy could not be created; nothing was run." };
  }

  let result: ControlledPipelineResult | null = null;
  let problem: string | null = null;
  let noEnvironment = false;
  try {
    writeFixture(cloneRun, cloneName, {
      "package.json": originals.packageJson,
      "package-lock.json": originals.packageLock,
      "build.mjs": applied.patched,
      "test.mjs": originals.testMjs,
    });
    const pipeline = opts.makePipeline(cloneRun);
    if (pipeline === null) {
      noEnvironment = true;
    } else if (input.signal.aborted) {
      problem = "aborted";
    } else {
      // Serial with the baseline: its cleanup and staging removal were confirmed above.
      result = await pipeline.run({ executionId: input.executionId, fixture: cloneName, signal: input.signal });
    }
  } catch {
    problem = "The verification run raised an error; no verdict was recorded.";
  }
  const removal = removeRunDir(opts.workRoot, cloneRun);

  if (!removal.removed) {
    return { kind: "infrastructure", reason: "The verification copy could not be removed, so no verdict was recorded." };
  }
  if (input.signal.aborted || problem === "aborted") return { kind: "aborted" };
  if (problem !== null) return { kind: "infrastructure", reason: problem };
  if (noEnvironment) return refuse("no-verification-environment");
  if (result === null) return { kind: "infrastructure", reason: "The verification run produced no result." };

  // 6. Verdict only from observed, cleaned-up evidence for this exact execution.
  if (
    result.status === "not-run" ||
    result.executionId !== input.executionId ||
    result.cleanup === null ||
    result.cleanup.confirmed !== true ||
    result.stagingRemoved !== true
  ) {
    return {
      kind: "infrastructure",
      reason: `The verification run did not produce a verdict (${result.reason}); no repair is claimed.`,
    };
  }
  const tester = buildPipelineTesterReport(result);
  let status: VerificationStatus;
  let reason: string;
  let detail: string;
  if (result.status === "success" && tester.status === "passed") {
    status = "verified";
    reason = "all-stages-passed";
    detail =
      "The patched disposable copy installed its locked dependencies, built and passed its original tests offline in the sandbox. The original source was not modified.";
  } else if (result.status === "failure" && tester.status === "failed") {
    status = "tested-failing";
    reason = result.reason;
    detail = "The patched disposable copy was built and tested offline and still failed. This is not a repair.";
  } else {
    return { kind: "infrastructure", reason: "The verification result and the Tester report disagree; no repair is claimed." };
  }

  const measuredMs = Math.max(0, now() - started);
  return {
    kind: "verification",
    verification: {
      status,
      reason,
      detail,
      patchClass: PATCH_CLASS,
      diffSha256,
      patchedFiles: [PATCH_TARGET],
      patchedBuildSha256: sha256(applied.patched),
      originalModified: false,
      baseline,
      patched: projectPatched(result),
      tester,
      measuredMs,
      pipelineMs: typeof result.durationMs === "number" ? result.durationMs : null,
      cleanup: { confirmed: true, stagingRemoved: true, cloneRemoved: true },
    },
  };
}
