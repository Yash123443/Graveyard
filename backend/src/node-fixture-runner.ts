/**
 * node-fixture-runner.ts — build/test stage runner for CONTROLLED NODE FIXTURES.
 *
 * Foundation only. NOT a JobRunner, NOT wired to the server, worker or any job, and it must not
 * be pointed at arbitrary repositories. Nothing here has been run against real Docker by its
 * author (see backend/DEVELOPMENT.md for what has and has not been observed).
 *
 * Shape:
 *  - Two FIXED commands, chosen by stage name, never built from caller input. They run through
 *    DockerFixtureSandbox: network none, non-root, all capabilities dropped, read-only root,
 *    resource limits, `--pull never`, isolation read back from `docker inspect` before start,
 *    explicit cleanup with proof.
 *  - The fixture directory is mounted READ-ONLY at /fixture. The only writable place is the
 *    bounded noexec tmpfs at /tmp.
 *      build: `node /fixture/build.mjs /tmp/out`   (writes /tmp/out, prints a GRAVEYARD_BUILD_OK marker)
 *      test:  `node --test --test-reporter=tap`     (cwd /fixture; each container is fresh, so the
 *             fixture's own tests rebuild into /tmp before importing the output)
 *    No npm, no dependency install, no network.
 *  - Each stage result is exactly one of passed / failed / not-run. `passed` needs a clean exit,
 *    machine-checked evidence in the output (build marker; TAP counts with at least one executed
 *    passing test and no failures), untruncated output AND confirmed container cleanup.
 *    Anything inconclusive (timeout, cancel, Docker unavailable, isolation mismatch, truncated or
 *    unparseable output, no tests, unconfirmed cleanup) is `not-run`, never `failed` and never
 *    `passed`. A nonzero exit is `failed`.
 *
 * Limits: fixture code controls its own stdout, so a hostile fixture can print a forged marker or
 * TAP summary. That is acceptable only because fixtures are controlled and written by this
 * project; it is one more reason arbitrary repositories are out of scope. The TAP summary format
 * of `node --test` on node:22-alpine is an assumption until observed (a different format fails
 * closed as not-run).
 *
 * @module node-fixture-runner
 */

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  DockerFixtureSandbox,
  type ProcessExecutor,
  type SandboxLimits,
  type SandboxResult,
} from "./docker-sandbox.js";
import type { CleanupProof } from "./runner.js";

export const NODE_FIXTURE_IMAGE = "node:22-alpine";
export const BUILD_OUT_DIR = "/tmp/out";
export const BUILD_MARKER = "GRAVEYARD_BUILD_OK";

export type StageName = "build" | "test";
export type StageStatus = "passed" | "failed" | "not-run";

/** Fixed registry. Frozen; callers select by StageName only. */
export const NODE_FIXTURE_COMMANDS: Readonly<Record<StageName, readonly string[]>> = Object.freeze({
  build: Object.freeze(["node", "/fixture/build.mjs", BUILD_OUT_DIR]),
  test: Object.freeze(["node", "--test", "--test-reporter=tap"]),
});

const COMMAND_IDS: Readonly<Record<StageName, string>> = Object.freeze({
  build: "node-fixture-build",
  test: "node-fixture-test",
});

/** Node needs some headroom over the adapter default; everything else stays within sandbox ranges. */
export const DEFAULT_NODE_FIXTURE_LIMITS: Readonly<Partial<SandboxLimits>> = Object.freeze({
  memoryMb: 256,
  cpus: 1,
  pids: 64,
  tmpfsMb: 16,
  timeoutMs: 60_000,
  maxOutputBytes: 64 * 1024,
});

export type StageReason =
  | "ok"
  | "exit-nonzero"
  | "tests-failed"
  | "no-build-script"
  | "build-output-unverified"
  | "no-tests-found"
  | "no-tests-executed"
  | "test-summary-unparseable"
  | "output-truncated"
  | "timed-out"
  | "aborted"
  | "isolation-violation"
  | "docker-unavailable"
  | "rejected"
  | "cleanup-unconfirmed"
  | "skipped-build-did-not-pass";

export interface TestCounts {
  tests: number;
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
  todo: number;
}

export interface StageResult {
  stage: StageName;
  status: StageStatus;
  reason: StageReason;
  /** Short human-readable explanation. Not machine-parsed. */
  detail: string;
  exitCode: number | null;
  durationMs: number | null;
  /** True if the sandbox cut captured output at its cap. */
  truncated: boolean;
  /** Last part of captured output, sanitised to printable ASCII. */
  stdoutTail: string;
  stderrTail: string;
  counts: TestCounts | null;
  buildOutput: { files: number; bytes: number } | null;
  /** null only when no container could have been created. */
  cleanup: CleanupProof | null;
  executionId: string | null;
}

export interface VerificationResult {
  status: StageStatus;
  build: StageResult;
  test: StageResult;
}

export interface StageRequest {
  /** `<id>:<number>`, same format as the sandbox. */
  executionId: string;
  /** Directory name under fixturesRoot. */
  fixture: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface VerifyRequest {
  /** Letters, digits and "-" only. Build uses `<idPrefix>:1`, test uses `<idPrefix>:2`. */
  idPrefix: string;
  fixture: string;
  /** Applied to each stage separately. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface NodeFixtureRunnerOptions {
  executor: ProcessExecutor;
  /** Absolute directory whose direct subdirectories are the controlled fixtures. */
  fixturesRoot: string;
  /** Default node:22-alpine. Must exist locally; it is never pulled. */
  image?: string;
  limits?: Partial<SandboxLimits>;
  dockerBinary?: string;
  /** Injectable for tests. */
  realpath?: (path: string) => string;
  /** Injectable for tests: is `path` a regular file, absent, or something else? */
  fileKind?: (path: string) => "file" | "missing" | "other";
}

const FIXTURE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,80}$/;
const TAIL_CHARS = 2000;
const MARKER_RE = new RegExp(`^${BUILD_MARKER} files=(\\d{1,6}) bytes=(\\d{1,9})\\r?$`, "gm");
const TAP_RE = /^# (tests|pass|fail|cancelled|skipped|todo) (\d{1,9})\r?$/gm;

// ---------------------------------------------------------------------------
// Pure classification (exported for tests)
// ---------------------------------------------------------------------------

/** Printable ASCII only, then the last `max` characters. */
export function tailOf(s: string, max: number = TAIL_CHARS): string {
  const clean = s.replace(/[^\n\x20-\x7e]/g, "?");
  return clean.length > max ? clean.slice(clean.length - max) : clean;
}

/** Last GRAVEYARD_BUILD_OK marker at the start of a line, with files>=1 and bytes>=1. */
export function parseBuildMarker(stdout: string): { files: number; bytes: number } | null {
  let last: { files: number; bytes: number } | null = null;
  for (const m of stdout.matchAll(MARKER_RE)) {
    last = { files: Number(m[1]), bytes: Number(m[2]) };
  }
  return last !== null && last.files >= 1 && last.bytes >= 1 ? last : null;
}

/**
 * Parses the `# tests/pass/fail/cancelled/...` summary of the TAP reporter. Only lines that START
 * with "# " count, so indented per-test diagnostics are ignored. The last occurrence wins.
 * `tests`, `pass`, `fail` and `cancelled` must all be present.
 */
export function parseTapCounts(stdout: string): TestCounts | null {
  const seen = new Map<string, number>();
  for (const m of stdout.matchAll(TAP_RE)) seen.set(m[1] as string, Number(m[2]));
  const tests = seen.get("tests");
  const pass = seen.get("pass");
  const fail = seen.get("fail");
  const cancelled = seen.get("cancelled");
  if (tests === undefined || pass === undefined || fail === undefined || cancelled === undefined) return null;
  return { tests, pass, fail, cancelled, skipped: seen.get("skipped") ?? 0, todo: seen.get("todo") ?? 0 };
}

interface Verdict {
  status: StageStatus;
  reason: StageReason;
  detail: string;
  counts: TestCounts | null;
  buildOutput: { files: number; bytes: number } | null;
}

const verdict = (
  status: StageStatus,
  reason: StageReason,
  detail: string,
  extra: Partial<Pick<Verdict, "counts" | "buildOutput">> = {},
): Verdict => ({ status, reason, detail, counts: extra.counts ?? null, buildOutput: extra.buildOutput ?? null });

/** Maps every sandbox outcome that is not a normal exit to not-run. */
function nonExitVerdict(r: SandboxResult): Verdict | null {
  switch (r.kind) {
    case "exited":
      return null;
    case "timed-out":
      return verdict("not-run", "timed-out", "the stage hit its time limit; result is inconclusive");
    case "aborted":
      return verdict("not-run", "aborted", "the stage was cancelled; result is inconclusive");
    case "isolation-violation":
      return verdict("not-run", "isolation-violation", `container was not started: ${r.reason}`);
    case "unavailable":
      return verdict("not-run", "docker-unavailable", r.reason);
    case "rejected":
      return verdict("not-run", "rejected", r.reason);
  }
}

export function classifyBuild(r: SandboxResult): Verdict {
  const non = nonExitVerdict(r);
  if (non !== null) return non;
  if (r.kind !== "exited") return verdict("not-run", "docker-unavailable", "unexpected outcome");
  if (r.exitCode !== 0) return verdict("failed", "exit-nonzero", `build exited with code ${r.exitCode}`);
  if (r.truncated) return verdict("not-run", "output-truncated", "build output was truncated; cannot verify the build marker");
  const out = parseBuildMarker(r.stdout);
  if (out === null) return verdict("not-run", "build-output-unverified", "build exited 0 but printed no valid output marker");
  return verdict("passed", "ok", `build produced ${out.files} file(s), ${out.bytes} byte(s) in ${BUILD_OUT_DIR}`, { buildOutput: out });
}

export function classifyTest(r: SandboxResult): Verdict {
  const non = nonExitVerdict(r);
  if (non !== null) return non;
  if (r.kind !== "exited") return verdict("not-run", "docker-unavailable", "unexpected outcome");
  const counts = r.truncated ? null : parseTapCounts(r.stdout);
  if (r.exitCode !== 0) {
    if (counts !== null && (counts.fail > 0 || counts.cancelled > 0)) {
      return verdict("failed", "tests-failed", `${counts.fail} failed, ${counts.cancelled} cancelled of ${counts.tests}`, { counts });
    }
    return verdict("failed", "exit-nonzero", `test run exited with code ${r.exitCode}`, { counts });
  }
  if (r.truncated) return verdict("not-run", "output-truncated", "test output was truncated; cannot verify results");
  if (counts === null) return verdict("not-run", "test-summary-unparseable", "no TAP summary found in test output");
  if (counts.fail > 0 || counts.cancelled > 0) {
    return verdict("failed", "tests-failed", `${counts.fail} failed, ${counts.cancelled} cancelled of ${counts.tests}`, { counts });
  }
  if (counts.tests === 0) return verdict("not-run", "no-tests-found", "the fixture has no tests", { counts });
  if (counts.pass < 1) return verdict("not-run", "no-tests-executed", "no test executed and passed (all skipped or todo)", { counts });
  if (counts.pass > counts.tests) return verdict("not-run", "test-summary-unparseable", "inconsistent TAP counts", { counts });
  return verdict("passed", "ok", `${counts.pass} of ${counts.tests} test(s) passed`, { counts });
}

/** passed needs confirmed cleanup; failed and not-run keep their status. */
function applyCleanup(v: Verdict, cleanup: CleanupProof | null): Verdict {
  if (v.status !== "passed" || cleanup?.confirmed === true) return v;
  const why = cleanup === null ? "no cleanup proof" : cleanup.confirmed ? "" : cleanup.reason;
  return { ...v, status: "not-run", reason: "cleanup-unconfirmed", detail: `container cleanup was not confirmed (${why}); a pass cannot be reported` };
}

/** Captured output exists only when the container actually ran. */
function outputOf(r: SandboxResult): {
  exitCode: number | null; durationMs: number | null; truncated: boolean; stdout: string; stderr: string;
} {
  if (r.kind === "exited" || r.kind === "timed-out" || r.kind === "aborted") {
    return {
      exitCode: r.kind === "exited" ? r.exitCode : null,
      durationMs: r.durationMs,
      truncated: r.truncated,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  }
  return { exitCode: null, durationMs: null, truncated: false, stdout: "", stderr: "" };
}

function skippedResult(stage: StageName, reason: StageReason, detail: string, executionId: string | null): StageResult {
  return {
    stage, status: "not-run", reason, detail, exitCode: null, durationMs: null, truncated: false,
    stdoutTail: "", stderrTail: "", counts: null, buildOutput: null, cleanup: null, executionId,
  };
}

/** failed anywhere => failed; both passed => passed; otherwise not-run. */
export function overallStatus(build: StageResult, test: StageResult): StageStatus {
  if (build.status === "failed" || test.status === "failed") return "failed";
  if (build.status === "passed" && test.status === "passed") return "passed";
  return "not-run";
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function defaultFileKind(path: string): "file" | "missing" | "other" {
  try {
    return lstatSync(path).isFile() ? "file" : "other";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "other";
  }
}

export class NodeFixtureRunner {
  private readonly sandbox: DockerFixtureSandbox;
  private readonly image: string;
  private readonly root: string;
  private readonly realpath: (p: string) => string;
  private readonly fileKind: (p: string) => "file" | "missing" | "other";

  constructor(opts: NodeFixtureRunnerOptions) {
    this.image = opts.image ?? NODE_FIXTURE_IMAGE;
    this.realpath = opts.realpath ?? ((p: string): string => realpathSync(p));
    this.fileKind = opts.fileKind ?? defaultFileKind;
    if (!isAbsolute(opts.fixturesRoot)) throw new Error("fixturesRoot must be an absolute path");
    this.root = this.realpath(resolve(opts.fixturesRoot));
    this.sandbox = new DockerFixtureSandbox({
      executor: opts.executor,
      allowedImages: [this.image],
      commands: {
        [COMMAND_IDS.build]: NODE_FIXTURE_COMMANDS.build,
        [COMMAND_IDS.test]: NODE_FIXTURE_COMMANDS.test,
      },
      fixturesRoot: this.root,
      limits: { ...DEFAULT_NODE_FIXTURE_LIMITS, ...(opts.limits ?? {}) },
      realpath: this.realpath,
      ...(opts.dockerBinary === undefined ? {} : { dockerBinary: opts.dockerBinary }),
    });
  }

  /** Runs one stage in a fresh container and always reports cleanup evidence. Never throws. */
  async runStage(stage: StageName, req: StageRequest): Promise<StageResult> {
    const executionId = typeof req.executionId === "string" ? req.executionId : null;
    if (req.signal?.aborted === true) {
      return skippedResult(stage, "aborted", "cancelled before start; nothing was created", executionId);
    }
    if (stage === "build" && this.buildScriptMissing(req.fixture)) {
      return skippedResult(stage, "no-build-script", "fixture has no build.mjs; nothing was run", executionId);
    }

    let res: SandboxResult;
    try {
      res = await this.sandbox.execute({
        executionId: req.executionId,
        commandId: COMMAND_IDS[stage],
        image: this.image,
        fixture: req.fixture,
        timeoutMs: req.timeoutMs,
        ...(req.signal === undefined ? {} : { signal: req.signal }),
      });
    } catch {
      const cleanup = await this.sandbox.cleanup({ executionId: req.executionId });
      return {
        ...skippedResult(stage, "docker-unavailable", "sandbox call failed unexpectedly", executionId),
        cleanup,
      };
    }

    const base = stage === "build" ? classifyBuild(res) : classifyTest(res);
    const v = applyCleanup(base, res.cleanup);
    const out = outputOf(res);
    return {
      stage,
      status: v.status,
      reason: v.reason,
      detail: v.detail,
      exitCode: out.exitCode,
      durationMs: out.durationMs,
      truncated: out.truncated,
      stdoutTail: tailOf(out.stdout),
      stderrTail: tailOf(out.stderr),
      counts: v.counts,
      buildOutput: v.buildOutput,
      cleanup: res.cleanup,
      executionId,
    };
  }

  /**
   * Build, then test. The test stage is skipped (not-run) unless the build passed, and when the
   * signal aborts between stages. Each stage uses its own container.
   */
  async verify(req: VerifyRequest): Promise<VerificationResult> {
    if (typeof req.idPrefix !== "string" || !ID_PREFIX_RE.test(req.idPrefix)) {
      const build = skippedResult("build", "rejected", "invalid idPrefix", null);
      const test = skippedResult("test", "rejected", "invalid idPrefix", null);
      return { status: "not-run", build, test };
    }
    const stageReq = (n: number): StageRequest => ({
      executionId: `${req.idPrefix}:${n}`,
      fixture: req.fixture,
      timeoutMs: req.timeoutMs,
      ...(req.signal === undefined ? {} : { signal: req.signal }),
    });
    const build = await this.runStage("build", stageReq(1));
    let test: StageResult;
    if (build.status !== "passed") {
      test = skippedResult("test", "skipped-build-did-not-pass", `build ${build.status} (${build.reason}); tests were not run`, `${req.idPrefix}:2`);
    } else if (req.signal?.aborted === true) {
      test = skippedResult("test", "aborted", "cancelled before the test stage", `${req.idPrefix}:2`);
    } else {
      test = await this.runStage("test", stageReq(2));
    }
    return { status: overallStatus(build, test), build, test };
  }

  /** True only when the fixture resolves inside the root and build.mjs is positively absent. */
  private buildScriptMissing(fixture: string): boolean {
    if (typeof fixture !== "string" || !FIXTURE_NAME_RE.test(fixture)) return false;
    let real: string;
    try {
      real = this.realpath(resolve(this.root, fixture));
    } catch {
      return false;
    }
    const rel = relative(this.root, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
    return this.fileKind(join(real, "build.mjs")) === "missing";
  }
}
