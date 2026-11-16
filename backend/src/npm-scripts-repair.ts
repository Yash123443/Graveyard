/**
 * npm-scripts-repair.ts — opt-in verified Kiro repair for the pinned npm-scripts profile.
 * Written without a shell, compiler or test run (UNVERIFIED until an operator compiles and runs the
 * suite and a real-Docker check; see backend/DEVELOPMENT.md and .kiro/KIRO_USAGE.md).
 *
 * When it applies. Only inside GithubJobRunner's npm-scripts mode, only when the operator ALSO
 * configured the existing explicit Kiro agent setup (GRAVEYARD_WORKER_AGENTS), and only for this
 * narrow class (`checkRepairEligibility`):
 *   - the pinned baseline run of the UNMODIFIED snapshot failed at the BUILD stage (a nonzero exit
 *     of `npm run build`), with prepare and install observed as passed, the test stage not run,
 *     confirmed container cleanup and removed staging for exactly the baseline execution id;
 *   - `scripts.build` is exactly `node FILE` or `node ./FILE` where FILE is a safe, simple, root-level
 *     `.mjs`, `.cjs` or `.js` name that is not test-like (build-entry.ts);
 *   - `scripts.test` is exactly `node --test` or `node --test FILE` (one safe root test-like file name, no
 *     flags, pipelines or other commands), so that a pass can show tests ran. `echo ok`, `node build.js` or a
 *     glob that finds no tests never earns a verification.
 * Anything else keeps the earlier behaviour: no agent runs, no source leaves the host, no repair.
 * With agents off nothing here runs at all, so the baseline behaviour is unchanged.
 *
 * What the agents see (`buildRepairEvidence`). Bounded stage evidence (the existing Analyst text
 * builder, redacted by the agent contract), the two declared script commands, and the COMPLETE build
 * entry source as the ONLY file evidence, so a proposal can only name that one path. The source is
 * sent only when it passes `buildSourceSuitable` (at most 4096 bytes, no control characters or CR,
 * final newline, and unchanged by secret redaction). Otherwise only the Analyst runs, on the stage and
 * script evidence, and the Fixer is skipped (`build-source-unsuitable`). A truncated or redacted
 * original is never shown as complete and is never used to apply a patch: the original is re-read from
 * the host snapshot and must equal the text the agents were shown.
 *
 * Fixer guidance and retry. The Fixer is called with the trusted flag `singleBuildEntry`, so the
 * adapter adds fixed copy-exactly and hunk-position rules and, when it fits the evidence cap, a
 * line-numbered reference of the same redacted file (kiro-agent.ts). If and only if the proposal is
 * rejected with `context-mismatch` and the job is not aborted, the Fixer is called ONCE more with the
 * fixed `contextRetry` flag. No-result, timeout, unsafe-path or any other outcome is not retried. The
 * retried proposal goes through exactly the same validation and verification.
 *
 * Verification (`verifyNpmScriptsRepair`), in order, every step failing closed:
 *   1. baseline gate (above) and a verification execution id that differs from the baseline's;
 *   2. the proposal names exactly the build entry, was context-verified, and the evidence was complete;
 *   3. the original is re-read from the baseline snapshot and must equal the evidence text;
 *   4. `applyBuildPatch` (repair-verifier.ts, now parameterised by target, default `build.mjs`)
 *      re-validates the diff against the exact original and applies it IN MEMORY, re-checking every
 *      old-side line at its position;
 *   5. an audited copy of the snapshot is made under the SAME run directory (a fresh `run-<hex>`
 *      directory, regular files and directories only, no symlinks, exclusive creates, the bounds of
 *      the snapshot export) where every file is byte-identical except the patched target; the copy is
 *      re-read and its hashes compared before anything runs. The baseline snapshot is never touched;
 *   6. the existing offline pipeline runs install, build and the ORIGINAL tests on the copy, with the
 *      SAME verified read-only npm cache and a DISTINCT execution id (`deriveRepairExecutionId`);
 *   7. the copy is removed (removeRunDir) on every path; an unremovable copy is infrastructure.
 * `verified` needs: pipeline success, Tester `passed`, prepare/install/build/test all observed
 * passed, TAP counts parsed (parseTapCounts) from the test stage's stdout tail showing at least one
 * passed test, none failed or cancelled, and no count above the total (otherwise `tests-not-confirmed`,
 * not a repair), confirmed container cleanup, removed staging, and a removed copy. The counts are stored
 * and re-checked by the result view. A tested failure is
 * `tested-failing`. A refusal is `not-attempted`. A run that produced no verdict but whose cleanup
 * and staging are confirmed is recorded as `not-attempted` / `verification-inconclusive` (the
 * baseline result and the advisory outcomes are kept). Unconfirmed cleanup, an unremovable copy or
 * an abort is NOT a result: the job fails or aborts as infrastructure and the worker's cleanup
 * (which also proves the repair execution id, see GithubJobRunner.cleanup) gates any retry.
 *
 * The original snapshot, the repository and the pinned commit are never modified. `patchApplied`
 * stays false in the result view. Package files, the lockfile, test files, other source files,
 * network policy and resource limits are untouched; only one file of the disposable copy differs.
 *
 * Known limits: a passing re-run shows the tests pass with the patch; it is not a review of the
 * change and does not show the tests are sufficient. The model sees at most 4 KiB of source and the
 * bounded, redacted failure output of the baseline build.
 *
 * @module npm-scripts-repair
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { redactSecrets, sanitizeText, type Diagnosis, type EvidenceItem, type PatchProposal } from "./agent-contract.js";
import { NPM_SCRIPTS_PATCH_CLASS, isBuildEntryName, parseBuildEntryScript, parseRepairTestScript, testCountsAcceptable } from "./build-entry.js";
import type { ControlledPipelineResult, PipelineRequest } from "./controlled-pipeline.js";
import { createRunDir, removeRunDir } from "./fixture-workspace.js";
import type { AgentOutcome, FixerRequest } from "./kiro-agent.js";
import { parseTapCounts, type TestCounts } from "./node-fixture-runner.js";
import { SCRIPTS_DRIVER_NAME, SCRIPTS_INSTALL_MANIFEST_NAME } from "./npm-scripts-driver.js";
import { NPM_SCRIPTS_RUN_MODE, type ScriptsPlanOk } from "./npm-scripts-policy.js";
import { SNAPSHOT_LIMITS } from "./npm-scripts-snapshot.js";
import { buildStageEvidenceText, projectAnalyst, projectFixer, projectPipeline, type AgentsLike, type PipelineLike } from "./pipeline-runner.js";
import { applyBuildPatch } from "./repair-verifier.js";
import type { JobProgress } from "./runner.js";
import { buildPipelineTesterReport, type PipelineTesterReport } from "./tester.js";

/** The agent adapter cuts evidence items at 4096 bytes; a file is only "complete" below that. */
export const MAX_REPAIR_SOURCE_BYTES = 4096;
const MAX_TARGET_READ_BYTES = 64 * 1024;
const EXECUTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,100}:[0-9]{1,6}$/;
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const RESERVED_ROOT = new Set<string>([SCRIPTS_DRIVER_NAME, SCRIPTS_INSTALL_MANIFEST_NAME]);

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** `<uuid>-fix:<n>` for the baseline id `<uuid>:<n>`. Differs from the baseline and the registry (`-npm`) ids. */
export function deriveRepairExecutionId(executionId: string): string | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,90}):([0-9]{1,6})$/.exec(executionId);
  if (m === null) return null;
  return `${m[1] as string}-fix:${m[2] as string}`;
}

// ---------------------------------------------------------------------------
// Eligibility (pure)
// ---------------------------------------------------------------------------

export type Eligibility = { ok: true; target: string } | { ok: false; reason: string };

/**
 * Decides whether a pinned npm-scripts baseline is inside the repair class. Pure. The reasons are
 * fixed texts.
 */
export function checkRepairEligibility(
  buildScript: string,
  baseline: ControlledPipelineResult,
  executionId: string,
  testScript: string,
): Eligibility {
  const target = parseBuildEntryScript(buildScript);
  if (target === null) return { ok: false, reason: "scripts.build is not exactly `node FILE` for a simple root .mjs, .cjs or .js file" };
  if (parseRepairTestScript(testScript) === null) {
    return { ok: false, reason: "scripts.test is not exactly `node --test` or `node --test FILE` for a simple root test file, so a pass could not show that tests ran" };
  }
  if (!baselineGateHolds(baseline, executionId)) {
    return { ok: false, reason: "the baseline did not fail at the build stage with install proven passed and cleanup confirmed" };
  }
  return { ok: true, target };
}

function baselineGateHolds(b: ControlledPipelineResult, executionId: string): boolean {
  if (b.status !== "failure" || b.failedStage !== "build" || b.executionId !== executionId) return false;
  if (b.cleanup === null || b.cleanup.confirmed !== true || b.stagingRemoved !== true || b.truncated) return false;
  const stages = b.stages;
  if (stages === null) return false;
  const stage = (name: string) => stages.find((s) => s.stage === name);
  const prepare = stage("prepare");
  const install = stage("install");
  const build = stage("build");
  const test = stage("test");
  if (prepare?.status !== "passed" || install?.status !== "passed") return false;
  if (build?.status !== "failed" || build.reason !== "exit-code" || typeof build.exitCode !== "number" || build.exitCode === 0) return false;
  if (test !== undefined && test.status === "passed") return false;
  return buildPipelineTesterReport(b).status === "failed";
}

/** True when the build source may be sent as COMPLETE evidence and later used to apply a patch. */
export function buildSourceSuitable(text: string): boolean {
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > MAX_REPAIR_SOURCE_BYTES) return false;
  if (!text.endsWith("\n") || CONTROL_RE.test(text)) return false;
  // The agent contract marks a file complete only if hygiene and redaction leave it unchanged.
  return redactSecrets(sanitizeText(text)) === text;
}

/**
 * Evidence for the Analyst and Fixer: stage evidence, the declared commands, and (only when
 * suitable) the complete build entry as the single file item.
 */
export function buildRepairEvidence(
  baseline: ControlledPipelineResult,
  plan: { buildScript: string; testScript: string },
  target: string,
  sourceText: string | null,
): EvidenceItem[] {
  const items: EvidenceItem[] = [
    { id: "stage-result", kind: "stage-result", text: buildStageEvidenceText(baseline) },
    { id: "scripts", kind: "manifest", text: `scripts.build: ${plan.buildScript}\nscripts.test: ${plan.testScript}` },
  ];
  if (sourceText !== null) items.push({ id: "build-entry", kind: "file", path: target, complete: true, text: sourceText });
  return items;
}

// ---------------------------------------------------------------------------
// Host-side snapshot reading and audited copy
// ---------------------------------------------------------------------------

class TreeRefused extends Error {}

interface TreeFile {
  rel: string;
  data: Buffer;
  exec: boolean;
}
interface Tree {
  files: TreeFile[];
  /** Parents before children. */
  dirs: string[];
}

/** Reads a directory with lstat only. Throws TreeRefused for anything outside the snapshot bounds or shape. */
function readTree(root: string): Tree {
  const files: TreeFile[] = [];
  const dirs: string[] = [];
  let bytes = 0;
  const walk = (rel: string): void => {
    const here = rel === "" ? root : join(root, ...rel.split("/"));
    for (const name of readdirSync(here).sort()) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      if (rel === "" && RESERVED_ROOT.has(name)) throw new TreeRefused("reserved name");
      if (files.length + dirs.length >= SNAPSHOT_LIMITS.maxEntries) throw new TreeRefused("too many entries");
      const p = join(here, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new TreeRefused("symlink");
      if (st.isDirectory()) {
        if (childRel.split("/").length > SNAPSHOT_LIMITS.maxDirDepth) throw new TreeRefused("too deep");
        dirs.push(childRel);
        walk(childRel);
      } else if (st.isFile()) {
        if (childRel.split("/").length - 1 > SNAPSHOT_LIMITS.maxDirDepth) throw new TreeRefused("too deep");
        if (files.length >= SNAPSHOT_LIMITS.maxFiles) throw new TreeRefused("too many files");
        if (st.size > SNAPSHOT_LIMITS.maxTotalBytes) throw new TreeRefused("file too large");
        const data = readFileSync(p);
        bytes += data.length;
        if (bytes > SNAPSHOT_LIMITS.maxTotalBytes) throw new TreeRefused("tree too large");
        files.push({ rel: childRel, data, exec: (st.mode & 0o111) !== 0 });
      } else {
        throw new TreeRefused("special file");
      }
    }
  };
  walk("");
  return { files, dirs };
}

/** Resolves `<runDir>/<name>` and proves it is a real directory directly inside `runDir`. */
function resolveSnapshot(runDir: string, name: string): { root: string; dir: string } | null {
  try {
    if (!isAbsolute(runDir)) return null;
    const root = realpathSync(resolve(runDir));
    const dir = realpathSync(resolve(root, name));
    const rel = relative(root, dir);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/") || rel.includes("\\")) return null;
    if (!lstatSync(dir).isDirectory()) return null;
    return { root, dir };
  } catch {
    return null;
  }
}

/** Reads the exact original build entry from the baseline snapshot: a plain regular file, exact UTF-8. */
export function readOriginalTarget(runDir: string, snapshotName: string, target: string): string | null {
  try {
    if (!isBuildEntryName(target)) return null;
    const snap = resolveSnapshot(runDir, snapshotName);
    if (snap === null) return null;
    const p = join(snap.dir, target);
    const st = lstatSync(p);
    if (!st.isFile() || st.size > MAX_TARGET_READ_BYTES) return null;
    const buf = readFileSync(p);
    const text = buf.toString("utf8");
    return Buffer.from(text, "utf8").equals(buf) ? text : null;
  } catch {
    return null;
  }
}

type CopyResult =
  | { ok: true; name: string; dir: string; root: string; files: number; directories: number; totalBytes: number }
  | { ok: false; kind: "refused" | "io" };

/**
 * Copies the baseline snapshot into a new `run-<hex>` directory of the same run directory, replacing
 * exactly `target` with `patched`, then re-reads the copy and compares every file hash. On any problem
 * the partial copy is removed. The baseline snapshot is only read.
 */
function copyPatchedSnapshot(runDir: string, snapshotName: string, target: string, original: string, patched: string): CopyResult {
  const snap = resolveSnapshot(runDir, snapshotName);
  if (snap === null) return { ok: false, kind: "refused" };
  let tree: Tree;
  try {
    tree = readTree(snap.dir);
  } catch (e) {
    return { ok: false, kind: e instanceof TreeRefused ? "refused" : "io" };
  }
  const targetFile = tree.files.find((f) => f.rel === target);
  if (targetFile === undefined || !targetFile.data.equals(Buffer.from(original, "utf8"))) return { ok: false, kind: "refused" };

  const patchedBuf = Buffer.from(patched, "utf8");
  const expected = new Map<string, string>();
  let totalBytes = 0;
  for (const f of tree.files) {
    const data = f.rel === target ? patchedBuf : f.data;
    expected.set(f.rel, sha256(data));
    totalBytes += data.length;
  }
  if (totalBytes > SNAPSHOT_LIMITS.maxTotalBytes + MAX_TARGET_READ_BYTES) return { ok: false, kind: "refused" };

  let dest: string;
  try {
    dest = createRunDir(snap.root);
  } catch {
    return { ok: false, kind: "io" };
  }
  const discard = (kind: "refused" | "io"): CopyResult => {
    removeRunDir(snap.root, dest);
    return { ok: false, kind };
  };
  try {
    for (const d of tree.dirs) mkdirSync(join(dest, ...d.split("/")), { mode: 0o755 });
    for (const f of tree.files) {
      const data = f.rel === target ? patchedBuf : f.data;
      writeFileSync(join(dest, ...f.rel.split("/")), data, { flag: "wx", mode: f.exec ? 0o755 : 0o644 });
    }
  } catch {
    return discard("io");
  }
  // Audit the copy before anything runs: same shape, every file hash as expected.
  try {
    const audit = readTree(dest);
    if (audit.files.length !== tree.files.length || audit.dirs.length !== tree.dirs.length) return discard("refused");
    for (const f of audit.files) {
      if (expected.get(f.rel) !== sha256(f.data)) return discard("refused");
    }
  } catch (e) {
    return discard(e instanceof TreeRefused ? "refused" : "io");
  }
  const name = dest.slice(snap.root.length + 1);
  return { ok: true, name, dir: dest, root: snap.root, files: tree.files.length, directories: tree.dirs.length, totalBytes };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type VerificationStatus = "verified" | "tested-failing" | "not-attempted";

const DETAILS: Readonly<Record<string, string>> = {
  "baseline-not-observed": "No build-stage failure with confirmed cleanup was observed for the original, so no repair was attempted.",
  "execution-id-not-distinct": "The verification execution id was not distinct from the baseline's, so nothing was run.",
  "evidence-incomplete": "The proposal was not based on the complete original build entry, so it was not applied.",
  "evidence-stale": "The evidence the proposal was based on no longer equals the original build entry, so it was not applied.",
  "originals-unavailable": "The original build entry could not be read from the snapshot, so nothing was applied.",
  "originals-too-large": "The original build entry is larger than the verification allows, so nothing was applied.",
  "original-unsuitable": "The original build entry cannot be patched exactly (control characters, carriage returns or no final newline).",
  "diff-invalid": "The proposed diff is not a valid, supported diff of the original build entry, so it was not applied.",
  "path-not-allowed": "The proposed diff touches a path other than the single build entry, so it was not applied.",
  "hunk-mismatch": "The proposed hunks do not match the exact original lines and positions, so it was not applied.",
  "no-op": "The proposed diff does not change the original build entry, so there is nothing to verify.",
  "patched-unsuitable": "The patched build entry would be empty or too large, so it was not run.",
  "snapshot-copy-refused": "A disposable audited copy of the snapshot could not be made within its bounds, so nothing was run.",
  "no-verification-environment": "No offline environment with the verified npm cache was available, so the proposal was not run.",
  "test-script-not-supported":
    "scripts.test is not exactly `node --test` or `node --test FILE`, so a pass could not show that tests ran. Nothing was run.",
  "tests-not-confirmed":
    "The patched copy's stages passed, but its test output did not show at least one passed test with consistent counts and none failed or cancelled. The proposal is not verified and is not a repair.",
  "verification-inconclusive":
    "The patched copy's offline run produced no verdict (cleanup was confirmed). The proposal is not verified and is not a repair.",
};
const detailOf = (reason: string): string => DETAILS[reason] ?? "The proposal was not applied.";

/** The recorded, JSON-safe verification of one proposal. Fixed vocabulary; no model or container text. */
export interface NpmScriptsRepairVerification {
  status: VerificationStatus;
  /** A refusal reason, `all-stages-passed`, or the pipeline's failure reason. */
  reason: string;
  detail: string;
  patchClass: typeof NPM_SCRIPTS_PATCH_CLASS;
  runMode: typeof NPM_SCRIPTS_RUN_MODE;
  /** The single verified path, a root build entry. */
  targetPath: string;
  /** The declared `scripts.test` the patched copy ran (exactly `node --test` or `node --test FILE`). */
  testScript: string;
  /** TAP counts parsed from the patched copy's test stage output; null when none were parsed or nothing ran. */
  testCounts: TestCounts | null;
  /** sha256 of the exact diff text (stored as fixer.diff). */
  diffSha256: string | null;
  patchedFiles: string[];
  originalTargetSha256: string | null;
  patchedTargetSha256: string | null;
  /** Always false: the original snapshot and repository are never modified. */
  originalModified: false;
  baseline: { status: string; reason: string; failedStage: string | null };
  /** Observed result of the patched copy's pipeline run; null when nothing was run. */
  patched: Record<string, unknown> | null;
  tester: PipelineTesterReport | null;
  /** True when the patched run used an execution id different from the baseline's. */
  distinctExecutionId: boolean;
  /** True when the patched run mounted the same verified offline npm cache directory as the baseline. */
  sameCache: boolean;
  snapshotCopy: { files: number; directories: number; totalBytes: number } | null;
  measuredMs: number;
  pipelineMs: number | null;
  cleanup: { confirmed: boolean; stagingRemoved: boolean; cloneRemoved: boolean } | null;
}

export type NpmRepairAttempt =
  | { kind: "verification"; verification: NpmScriptsRepairVerification }
  | { kind: "aborted" }
  | { kind: "infrastructure"; reason: string };

export interface NpmRepairVerifyInput {
  /** Baseline (unmodified snapshot) execution id and the distinct id for the patched run. */
  baselineExecutionId: string;
  verifyExecutionId: string;
  proposal: PatchProposal;
  baseline: ControlledPipelineResult;
  /** The one root build entry file name. */
  target: string;
  /** The declared `scripts.test`; it must be exactly `node --test` or `node --test FILE` (parseRepairTestScript). */
  testScript: string;
  /** The build entry as the agents were shown it; null when it was not sent. */
  evidenceBuild: { text: string; complete: boolean } | null;
  /** Run directory that owns the baseline snapshot and receives the disposable copy. */
  runDir: string;
  snapshotName: string;
  /** The baseline's verified offline cache directory. Null: nothing is attempted. */
  cacheDir: string | null;
  /** Offline pipeline for one snapshot directory name of `runDir`, with the SAME cache. May return null. */
  makePipeline: (a: { snapshot: string; cacheDir: string }) => PipelineLike | null;
  signal: AbortSignal;
  now?: () => number;
}

/** Never throws. Strictly serial with the baseline run, whose cleanup was confirmed first. */
export async function verifyNpmScriptsRepair(input: NpmRepairVerifyInput): Promise<NpmRepairAttempt> {
  const now = input.now ?? ((): number => Date.now());
  const started = now();
  try {
    return await verifyInner(input, now, started);
  } catch {
    return { kind: "infrastructure", reason: "The repair verification raised an unexpected error; no verdict was recorded." };
  }
}

async function verifyInner(input: NpmRepairVerifyInput, now: () => number, started: number): Promise<NpmRepairAttempt> {
  if (input.signal.aborted) return { kind: "aborted" };
  const b = input.baseline;
  const baseline = { status: b.status, reason: b.reason, failedStage: b.failedStage };
  const diff = input.proposal.diff;
  const diffSha256 = typeof diff === "string" ? sha256(diff) : null;
  const target = input.target;
  const targetPath = isBuildEntryName(target) ? target : "";

  const record = (
    status: VerificationStatus,
    reason: string,
    detail: string,
    extra: Partial<NpmScriptsRepairVerification> = {},
  ): NpmRepairAttempt => ({
    kind: "verification",
    verification: {
      status,
      reason,
      detail,
      patchClass: NPM_SCRIPTS_PATCH_CLASS,
      runMode: NPM_SCRIPTS_RUN_MODE,
      targetPath,
      testScript: typeof input.testScript === "string" ? input.testScript : "",
      testCounts: null,
      diffSha256,
      patchedFiles: [],
      originalTargetSha256: null,
      patchedTargetSha256: null,
      originalModified: false,
      baseline,
      patched: null,
      tester: null,
      distinctExecutionId: input.verifyExecutionId !== input.baselineExecutionId,
      sameCache: false,
      snapshotCopy: null,
      measuredMs: Math.max(0, now() - started),
      pipelineMs: null,
      cleanup: null,
      ...extra,
    },
  });
  const refuse = (reason: string): NpmRepairAttempt => record("not-attempted", reason, detailOf(reason));

  // 1. Baseline gate and distinct execution id.
  if (!baselineGateHolds(b, input.baselineExecutionId)) return refuse("baseline-not-observed");
  if (
    input.verifyExecutionId === input.baselineExecutionId ||
    !EXECUTION_ID_RE.test(input.verifyExecutionId) ||
    !EXECUTION_ID_RE.test(input.baselineExecutionId)
  ) {
    return refuse("execution-id-not-distinct");
  }
  if (parseRepairTestScript(input.testScript) === null) return refuse("test-script-not-supported");

  // 2. The single path, complete evidence and a context-verified proposal.
  if (!isBuildEntryName(target)) return refuse("path-not-allowed");
  if (input.proposal.files.length !== 1 || input.proposal.files[0] !== target) return refuse("path-not-allowed");
  if (input.evidenceBuild === null || input.evidenceBuild.complete !== true || input.proposal.contextVerified !== true) {
    return refuse("evidence-incomplete");
  }
  if (typeof diff !== "string") return refuse("diff-invalid");
  if (input.cacheDir === null) return refuse("no-verification-environment");

  // 3. The original comes from the host snapshot, never from the (possibly cut or redacted) evidence.
  const original = readOriginalTarget(input.runDir, input.snapshotName, target);
  if (original === null) return refuse("originals-unavailable");
  if (original !== input.evidenceBuild.text) return refuse("evidence-stale");

  // 4. Pure, in-memory application with exact position re-checks.
  const applied = applyBuildPatch(original, diff, target);
  if (!applied.ok) return refuse(applied.reason);
  const originalSha = sha256(original);
  const patchedSha = sha256(applied.patched);
  if (input.signal.aborted) return { kind: "aborted" };

  // 5. Audited disposable copy under the same run directory.
  const copy = copyPatchedSnapshot(input.runDir, input.snapshotName, target, original, applied.patched);
  if (!copy.ok) {
    if (copy.kind === "refused") return refuse("snapshot-copy-refused");
    return { kind: "infrastructure", reason: "A disposable copy of the snapshot could not be created; nothing was run." };
  }

  // 6. Offline run with the same cache and a distinct execution id. The copy is removed on every path.
  let result: ControlledPipelineResult | null = null;
  let problem: string | null = null;
  let noEnvironment = false;
  try {
    const pipeline = input.makePipeline({ snapshot: copy.name, cacheDir: input.cacheDir });
    if (pipeline === null) noEnvironment = true;
    else if (input.signal.aborted) problem = "aborted";
    else {
      const req: PipelineRequest = { executionId: input.verifyExecutionId, fixture: copy.name, signal: input.signal };
      result = await pipeline.run(req);
    }
  } catch {
    problem = "The verification run raised an error; no verdict was recorded.";
  }
  const removal = removeRunDir(copy.root, copy.dir);
  if (!removal.removed) {
    return { kind: "infrastructure", reason: "The verification copy could not be removed, so no verdict was recorded." };
  }
  if (input.signal.aborted || problem === "aborted") return { kind: "aborted" };
  if (problem !== null) return { kind: "infrastructure", reason: problem };
  if (noEnvironment) return refuse("no-verification-environment");
  if (result === null) return { kind: "infrastructure", reason: "The verification run produced no result." };

  // 7. A verdict needs observed, cleaned-up evidence for exactly this execution.
  const cleanupOk =
    result.executionId === input.verifyExecutionId && result.cleanup !== null && result.cleanup.confirmed === true && result.stagingRemoved === true;
  if (!cleanupOk) {
    return { kind: "infrastructure", reason: `The verification run's cleanup was not confirmed (${result.reason}); no repair is claimed.` };
  }
  const common: Partial<NpmScriptsRepairVerification> = {
    patchedFiles: [target],
    originalTargetSha256: originalSha,
    patchedTargetSha256: patchedSha,
    sameCache: true,
    snapshotCopy: { files: copy.files, directories: copy.directories, totalBytes: copy.totalBytes },
    cleanup: { confirmed: true, stagingRemoved: true, cloneRemoved: true },
  };
  if (result.status === "not-run") {
    return record("not-attempted", "verification-inconclusive", detailOf("verification-inconclusive"), { ...common, patched: projectPipeline(result) });
  }
  const tester = buildPipelineTesterReport(result);
  const stages = result.stages ?? [];
  const allPassed = ["prepare", "install", "build", "test"].every((n) => stages.find((s) => s.stage === n)?.status === "passed");
  const measured = {
    ...common,
    patched: projectPipeline(result),
    tester,
    measuredMs: Math.max(0, now() - started),
    pipelineMs: typeof result.durationMs === "number" ? result.durationMs : null,
  };
  if (result.status === "success" && tester.status === "passed" && allPassed) {
    // A pass needs proof that tests ran: TAP counts from the test stage output, parsed on the host.
    const testStage = stages.find((s) => s.stage === "test");
    const counts = parseTapCounts(testStage?.stdoutTail ?? "");
    if (!testCountsAcceptable(counts)) {
      return record("not-attempted", "tests-not-confirmed", detailOf("tests-not-confirmed"), { ...measured, testCounts: counts });
    }
    return record(
      "verified",
      "all-stages-passed",
      "The patched disposable copy installed its locked dependencies, built and passed its original tests offline in the sandbox. The original source was not modified.",
      { ...measured, testCounts: counts },
    );
  }
  if (result.status === "failure" && tester.status === "failed") {
    return record(
      "tested-failing",
      result.reason,
      "The patched disposable copy was built and tested offline and still failed. This is not a repair.",
      measured,
    );
  }
  return record("not-attempted", "verification-inconclusive", detailOf("verification-inconclusive"), { ...common, patched: projectPipeline(result), tester });
}

// ---------------------------------------------------------------------------
// Orchestration for the GitHub runner
// ---------------------------------------------------------------------------

export interface RepairStepArgs {
  agents: AgentsLike;
  report: JobProgress;
  signal: AbortSignal;
  executionId: string;
  /** The measured baseline pipeline result (cleanup already judged by the caller). */
  baseline: ControlledPipelineResult;
  plan: ScriptsPlanOk;
  runDir: string;
  snapshotName: string;
  /** The baseline's verified offline cache, or null when unknown. */
  cacheDir: string | null;
  /** Builds the offline pipeline for a snapshot name of `runDir` and the given cache. */
  makePipeline: (a: { snapshot: string; cacheDir: string }) => PipelineLike | null;
}

export type RepairStep =
  | { kind: "aborted" }
  | { kind: "infrastructure"; reason: string }
  | { kind: "not-eligible"; reason: string }
  | {
      kind: "done";
      target: string;
      sourceSent: boolean;
      analyst: AgentOutcome<Diagnosis>;
      fixer: AgentOutcome<PatchProposal> | null;
      fixerSkipped: "no-diagnosis" | "not-attempted";
      verification: NpmScriptsRepairVerification | null;
    };

async function callAgent<T>(role: "analyst" | "fixer", call: () => Promise<AgentOutcome<T>>): Promise<AgentOutcome<T>> {
  try {
    return await call();
  } catch {
    return { status: "failed", role, code: "agent-raised", detail: "the agent adapter raised an error" };
  }
}

/** Never throws. Agent failures are data; verification trouble follows the abort and cleanup rules above. */
export async function runNpmScriptsRepairStep(a: RepairStepArgs): Promise<RepairStep> {
  try {
    return await stepInner(a);
  } catch {
    return { kind: "infrastructure", reason: "The npm-scripts repair step raised an unexpected error; no result was recorded." };
  }
}

async function stepInner(a: RepairStepArgs): Promise<RepairStep> {
  const elig = checkRepairEligibility(a.plan.buildScript, a.baseline, a.executionId, a.plan.testScript);
  if (!elig.ok) return { kind: "not-eligible", reason: elig.reason };
  const target = elig.target;
  const verifyId = deriveRepairExecutionId(a.executionId);
  if (verifyId === null) return { kind: "not-eligible", reason: "the execution id has an unexpected form" };

  const original = readOriginalTarget(a.runDir, a.snapshotName, target);
  const sourceText = original !== null && buildSourceSuitable(original) ? original : null;
  const evidence = buildRepairEvidence(a.baseline, a.plan, target, sourceText);

  if (a.signal.aborted) return { kind: "aborted" };
  if (!a.report.stage("diagnosing", "the Analyst reads bounded, redacted evidence")) return { kind: "aborted" };
  const analyst = await callAgent("analyst", () => a.agents.analyze({ evidence, signal: a.signal }));
  if (a.signal.aborted) return { kind: "aborted" };
  if (analyst.status !== "ok") {
    return { kind: "done", target, sourceSent: sourceText !== null, analyst, fixer: null, fixerSkipped: "no-diagnosis", verification: null };
  }
  if (sourceText === null) {
    return { kind: "done", target, sourceSent: false, analyst, fixer: null, fixerSkipped: "not-attempted", verification: null };
  }

  const diagnosis = analyst.value;
  if (!a.report.stage("repairing", "the Fixer proposes a patch; it is not applied to the original")) return { kind: "aborted" };
  // Trusted fixed flags only: npm build-entry guidance, and at most ONE retry, only after an exact
  // `context-mismatch` rejection and only while not aborted. No model text is fed back; validation of
  // the retried proposal is identical (exact comparison with the complete original).
  const fixerRequest = (contextRetry: boolean): FixerRequest => ({
    diagnosis,
    evidence,
    signal: a.signal,
    singleBuildEntry: true,
    ...(contextRetry ? { contextRetry: true } : {}),
  });
  let fixer = await callAgent("fixer", () => a.agents.propose(fixerRequest(false)));
  if (a.signal.aborted) return { kind: "aborted" };
  if (fixer.status === "rejected" && fixer.code === "context-mismatch") {
    fixer = await callAgent("fixer", () => a.agents.propose(fixerRequest(true)));
    if (a.signal.aborted) return { kind: "aborted" };
  }
  if (fixer.status !== "ok") {
    return { kind: "done", target, sourceSent: true, analyst, fixer, fixerSkipped: "no-diagnosis", verification: null };
  }

  if (!a.report.stage("verifying", "the proposal is applied to an audited disposable copy and verified offline")) return { kind: "aborted" };
  const attempt = await verifyNpmScriptsRepair({
    baselineExecutionId: a.executionId,
    verifyExecutionId: verifyId,
    proposal: fixer.value,
    baseline: a.baseline,
    target,
    testScript: a.plan.testScript,
    evidenceBuild: { text: sourceText, complete: true },
    runDir: a.runDir,
    snapshotName: a.snapshotName,
    cacheDir: a.cacheDir,
    makePipeline: a.makePipeline,
    signal: a.signal,
  });
  if (a.signal.aborted || attempt.kind === "aborted") return { kind: "aborted" };
  if (attempt.kind === "infrastructure") return { kind: "infrastructure", reason: attempt.reason };
  return { kind: "done", target, sourceSent: true, analyst, fixer, fixerSkipped: "no-diagnosis", verification: attempt.verification };
}

/**
 * Adds the repair step's outcome to an npm-scripts result payload. A step that was not eligible adds
 * only a fixed `repairEligibility` note. The baseline verdict, pipeline, Tester and snapshot facts are
 * never changed here.
 */
export function applyRepairStep(payload: Record<string, unknown>, step: RepairStep & { kind: "done" | "not-eligible" }): Record<string, unknown> {
  if (step.kind === "not-eligible") {
    return { ...payload, repairEligibility: { eligible: false, reason: step.reason } };
  }
  const keep = Array.isArray(payload["notes"]) ? (payload["notes"] as unknown[]).filter((n): n is string => typeof n === "string").slice(0, 2) : [];
  const v = step.verification;
  return {
    ...payload,
    analyst: projectAnalyst(step.analyst),
    fixer: projectFixer(step.fixer, step.fixerSkipped),
    ...(v === null ? {} : { verification: v }),
    repairEligibility: {
      eligible: true,
      patchClass: NPM_SCRIPTS_PATCH_CLASS,
      targetPath: step.target,
      sourceSentToModel: step.sourceSent,
      ...(step.sourceSent ? {} : { skipped: "build-source-unsuitable" }),
    },
    notes: [
      ...keep,
      step.sourceSent
        ? "Bounded, redacted stage output, the two declared script commands and the complete root build entry file (at most 4 KiB) were sent to the Kiro runtime agent. Nothing else from the repository was."
        : "Bounded, redacted stage output and the two declared script commands were sent to the Kiro runtime agent. The build entry file was not sent because it is not suitable as complete evidence, so no patch was requested.",
      v === null
        ? "No patch was applied or verified. The original snapshot was not modified."
        : "A patch proposal is never applied to the original. It was applied only to an audited disposable copy of the snapshot; the verification record says whether that copy passed its original tests offline.",
    ],
  };
}
