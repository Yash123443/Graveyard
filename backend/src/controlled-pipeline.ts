/**
 * controlled-pipeline.ts — host orchestration of the integrated CONTROLLED fixture pipeline:
 * offline `npm ci`, build and test of a controlled fixture inside ONE disposable container.
 *
 * Foundation only. NOT a JobRunner, NOT wired to the server, worker or any job, and it must not be
 * pointed at user projects, live jobs or cloned repositories. The mounted fixture content must come
 * from generated, trusted fixtures (controlled-pipeline-fixtures.ts plus an operator-supplied
 * package.json and package-lock.json). Written without running anything: until an operator runs the
 * tests and the opt-in harness, none of this is verified (see backend/DEVELOPMENT.md).
 *
 * Host side, before any container exists:
 *  1. request validation; the fixture directory is resolved inside `fixturesRoot` (realpath);
 *  2. package.json, package-lock.json and build.mjs are read as regular files (no symlinks, size
 *     capped); test.mjs is optional. Nothing else in the directory is read;
 *  3. `checkNpmFixture` (npm-lock-policy.ts) must accept package.json + lockfile, otherwise
 *     `policy-rejected`;
 *  4. the trusted COMPILED driver (fixture-pipeline-driver.js, optionally pinned by sha256) is read;
 *  5. exactly those files plus the driver are staged into a fresh directory. A stray .npmrc or .git
 *     in the source never reaches the container.
 *
 * Container (DockerFixtureSandbox): network none, uid 65532, all capabilities dropped,
 * no-new-privileges, read-only root, `--pull never`, bounded memory / pids / time / output.
 * Mounts: staged dir read-only at /fixture; operator npm cache read-only at /npm-cache; /work and
 * /tmp are bounded noexec tmpfs. Isolation is read back from `docker inspect` before start.
 * The ONLY command is `node /fixture/fixture-pipeline-driver.mjs` (fixed argv, no shell, no
 * request input). The driver copies the allowlisted files to /work and runs, with a minimal
 * environment: `npm ci --offline --ignore-scripts ...`, `node build.mjs /work/out`,
 * `node --test test.mjs`.
 *
 * Protocol. The driver writes exactly one JSON line to stdout and nothing to stderr. The host
 * parses it strictly (parseProtocolOutput): exact keys, four stages in fixed order, consistent
 * statuses, no truncation, exit code consistent with the status. Anything else is `not-run`.
 *
 * Status:
 *  - success: exit 0, untruncated, strictly valid protocol with EVERY stage passed (prepare,
 *    install, build and test; a fixture without test.mjs is not-run/`tests-not-run`), npm's own `added N packages` count equal to
 *    the lock's package count, confirmed container cleanup AND staging removal;
 *  - failure: the protocol is valid and the first failing stage (install, build or test) exited
 *    nonzero, with confirmed cleanup and staging removal;
 *  - not-run: everything inconclusive (policy rejection, missing inputs, Docker problems, timeout,
 *    cancel, truncated or malformed output, stage timeout or output limit inside the container,
 *    unconfirmed cleanup, ...). Inconclusive is never reported as failure or success.
 *
 * Limits. The evidence for `success` is the driver's own report from inside the container; the
 * installed tree is not inspected from the host. Unobserved assumptions (npm's output format, npm
 * working with a read-only cache and a tmpfs /work, node:test on noexec tmpfs) fail closed.
 *
 * @module controlled-pipeline
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DockerFixtureSandbox,
  containerNameFor,
  type ProcessExecutor,
  type SandboxLimits,
  type SandboxResult,
} from "./docker-sandbox.js";
import { PROTOCOL_ID, EXIT_FAILED, EXIT_PASSED, type FailureReason, type PipelineStatus, type StageName, type StageResult, type StageStatus } from "./fixture-pipeline-driver.js";
import { NODE_FIXTURE_IMAGE, tailOf } from "./node-fixture-runner.js";
import { MAX_LOCKFILE_BYTES, MAX_PACKAGE_JSON_BYTES, checkNpmFixture } from "./npm-lock-policy.js";
import { parseNpmAdded } from "./npm-install-runner.js";
import type { CleanupProof } from "./runner.js";

export const PIPELINE_CACHE_MOUNT = "/npm-cache";
export const PIPELINE_WORK_MOUNT = "/work";
export const PIPELINE_WORK_TMPFS_MB = 64;
export const PIPELINE_COMMAND_ID = "fixture-pipeline";
/** Name of the trusted driver inside the staged directory. `.mjs` so it is ESM regardless of package.json. */
export const STAGED_DRIVER_NAME = "fixture-pipeline-driver.mjs";
export const PIPELINE_ARGV: readonly string[] = Object.freeze(["node", `/fixture/${STAGED_DRIVER_NAME}`]);

export const DEFAULT_PIPELINE_LIMITS: Readonly<Partial<SandboxLimits>> = Object.freeze({
  memoryMb: 512,
  cpus: 1,
  pids: 128,
  tmpfsMb: 64,
  timeoutMs: 120_000,
  maxOutputBytes: 128 * 1024,
});

export const MAX_SCRIPT_BYTES = 64 * 1024;
export const MAX_DRIVER_BYTES = 128 * 1024;
const MAX_PROTOCOL_BYTES = 120 * 1024;
const MAX_TAIL_CHARS = 1024;
const MAX_DETAIL_CHARS = 300;

export type PipelineVerdict = "success" | "failure" | "not-run";

export type PipelineReason =
  | "ok"
  | "tests-not-run"
  | "install-failed"
  | "build-failed"
  | "test-failed"
  | "stage-inconclusive"
  | "driver-cancelled"
  | "driver-error"
  | "protocol-error"
  | "output-truncated"
  | "summary-mismatch"
  | "timed-out"
  | "aborted"
  | "isolation-violation"
  | "docker-unavailable"
  | "rejected"
  | "unconfigured"
  | "cache-unavailable"
  | "driver-unavailable"
  | "no-package-json"
  | "no-lockfile"
  | "no-build-script"
  | "unreadable-input"
  | "policy-rejected"
  | "staging-failed"
  | "staging-cleanup-failed"
  | "cleanup-unconfirmed";

export interface ControlledPipelineResult {
  status: PipelineVerdict;
  reason: PipelineReason;
  /** Short human-readable explanation. Not machine-parsed. */
  detail: string;
  /** The stage that failed or was inconclusive, when the protocol identified one. */
  failedStage: StageName | null;
  /** The strictly validated per-stage report, or null when no valid protocol line was received. */
  stages: StageResult[] | null;
  exitCode: number | null;
  durationMs: number | null;
  truncated: boolean;
  /** Bounded tail of container stderr (the driver writes none, so anything here is unexpected). */
  stderrTail: string;
  packagesAdded: number | null;
  expectedPackages: number | null;
  violations: string[];
  /** null only when no container could have been created. */
  cleanup: CleanupProof | null;
  /** null when nothing was staged. */
  stagingRemoved: boolean | null;
  /** sha256 of the driver bytes that were staged, or null when none were. */
  driverSha256: string | null;
  executionId: string | null;
}

export interface PipelineRequest {
  /** `<id>:<number>`, same format as the sandbox. */
  executionId: string;
  /** Directory name under fixturesRoot with package.json, package-lock.json, build.mjs and optionally test.mjs. */
  fixture: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ControlledPipelineOptions {
  executor: ProcessExecutor;
  /** Absolute directory whose direct subdirectories are the controlled fixtures (read only by the host). */
  fixturesRoot: string;
  /** Absolute backend-owned directory where the staged copy is created. Must exist and differ from fixturesRoot. */
  stagingRoot: string;
  /** Absolute operator-supplied, prepopulated npm cache. Mounted read-only. Absent: every run is not-run. */
  cacheDir: string;
  /** Default node:22-alpine. Must contain node and npm and exist locally; never pulled. */
  image?: string;
  /** Absolute path of the compiled driver. Default: fixture-pipeline-driver.js next to this module. */
  driverPath?: string;
  /** When set, the driver bytes must hash to this lowercase hex sha256 or the run is not-run. */
  expectedDriverSha256?: string;
  limits?: Partial<SandboxLimits>;
  dockerBinary?: string;
  /** Injectable for tests. */
  realpath?: (path: string) => string;
}

const FIXTURE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const STAGE_ORDER: readonly StageName[] = ["prepare", "install", "build", "test"];
const STAGE_STATUSES: readonly StageStatus[] = ["passed", "failed", "skipped", "not-run"];
const FAILURE_REASONS: readonly FailureReason[] = [
  "refused", "exit-code", "timeout", "output-limit", "cancelled", "spawn-error", "io-error",
];
const PIPELINE_STATUSES: readonly PipelineStatus[] = ["passed", "failed", "cancelled"];
const STAGE_KEYS: readonly string[] = [
  "stage", "status", "reason", "detail", "exitCode", "durationMs", "stdoutTail", "stderrTail",
];

// ---------------------------------------------------------------------------
// Strict protocol parser (pure, exported for tests)
// ---------------------------------------------------------------------------

export type ProtocolParse =
  | { ok: true; status: PipelineStatus; stages: StageResult[] }
  | { ok: false; problem: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (problem: string): ProtocolParse => ({ ok: false, problem });

/**
 * Parses the driver's single output line. `testPresent` is what the HOST staged: it decides whether
 * the test stage must have run. Never throws.
 */
export function parseProtocolOutput(stdout: string, testPresent: boolean): ProtocolParse {
  if (typeof stdout !== "string" || stdout.length === 0) return bad("no output");
  if (stdout.length > MAX_PROTOCOL_BYTES) return bad("output is larger than the protocol allows");
  const nl = stdout.indexOf("\n");
  if (nl !== stdout.length - 1) return bad("output is not exactly one newline-terminated line");
  if (stdout.includes("\r")) return bad("output contains a carriage return");

  let doc: unknown;
  try {
    doc = JSON.parse(stdout.slice(0, nl));
  } catch {
    return bad("output is not valid JSON");
  }
  if (!isObj(doc)) return bad("output is not a JSON object");
  const topKeys = Object.keys(doc).sort().join(",");
  if (topKeys !== "protocol,stages,status") return bad("unexpected top-level keys");
  if (doc["protocol"] !== PROTOCOL_ID) return bad("unknown protocol identifier");
  const status = doc["status"];
  if (typeof status !== "string" || !PIPELINE_STATUSES.includes(status as PipelineStatus)) return bad("invalid pipeline status");
  const raw = doc["stages"];
  if (!Array.isArray(raw) || raw.length !== STAGE_ORDER.length) return bad("stages must be an array of exactly four entries");

  const stages: StageResult[] = [];
  for (let i = 0; i < STAGE_ORDER.length; i += 1) {
    const s: unknown = raw[i];
    const name = STAGE_ORDER[i] as StageName;
    if (!isObj(s)) return bad(`stage ${name} is not an object`);
    for (const k of Object.keys(s)) if (!STAGE_KEYS.includes(k)) return bad(`stage ${name} has an unexpected key`);
    if (s["stage"] !== name) return bad(`stage ${i} is not ${name}`);
    const st = s["status"];
    if (typeof st !== "string" || !STAGE_STATUSES.includes(st as StageStatus)) return bad(`stage ${name} has an invalid status`);
    const dur = s["durationMs"];
    if (typeof dur !== "number" || !Number.isFinite(dur) || dur < 0) return bad(`stage ${name} has an invalid durationMs`);

    const out: StageResult = { stage: name, status: st as StageStatus, durationMs: dur };
    const reason = s["reason"];
    if (st === "failed") {
      if (typeof reason !== "string" || !FAILURE_REASONS.includes(reason as FailureReason)) return bad(`failed stage ${name} has no valid reason`);
      out.reason = reason as FailureReason;
    } else if (reason !== undefined) return bad(`stage ${name} has a reason but did not fail`);
    if (s["detail"] !== undefined) {
      const d = s["detail"];
      if (typeof d !== "string" || d.length > MAX_DETAIL_CHARS) return bad(`stage ${name} has an invalid detail`);
      out.detail = d;
    }
    if (s["exitCode"] !== undefined) {
      const ec = s["exitCode"];
      if (ec === null) out.exitCode = null;
      else if (typeof ec === "number" && Number.isInteger(ec)) out.exitCode = ec;
      else return bad(`stage ${name} has an invalid exitCode`);
    }
    for (const k of ["stdoutTail", "stderrTail"] as const) {
      const t = s[k];
      if (t === undefined) continue;
      if (typeof t !== "string" || t.length > MAX_TAIL_CHARS) return bad(`stage ${name} has an invalid ${k}`);
      out[k] = t;
    }
    if (st === "failed" && out.reason === "exit-code" && (typeof out.exitCode !== "number" || out.exitCode === 0)) {
      return bad(`stage ${name} failed with exit-code but has no nonzero exit code`);
    }
    stages.push(out);
  }

  // Cross-stage consistency.
  let failedAt = -1;
  for (let i = 0; i < stages.length; i += 1) {
    const s = stages[i] as StageResult;
    const name = s.stage;
    if (failedAt >= 0) {
      if (s.status !== "skipped") return bad(`stage ${name} ran after a failed stage`);
      continue;
    }
    if (s.status === "skipped") return bad(`stage ${name} was skipped without an earlier failure`);
    if (s.status === "not-run") {
      if (name !== "test") return bad(`stage ${name} cannot be not-run`);
      if (testPresent) return bad("test stage reported not-run although a test file was staged");
    }
    if (name === "test" && s.status === "passed" && !testPresent) return bad("test stage passed although no test file was staged");
    if (name === "test" && s.status === "failed" && !testPresent) return bad("test stage failed although no test file was staged");
    if (s.status === "failed") failedAt = i;
  }
  if (failedAt < 0) {
    const last = stages[3] as StageResult;
    if (testPresent && last.status !== "passed") return bad("test file was staged but the test stage did not pass");
  }
  const expected: PipelineStatus =
    failedAt < 0 ? "passed" : (stages[failedAt] as StageResult).reason === "cancelled" ? "cancelled" : "failed";
  if (status !== expected) return bad("pipeline status contradicts the stage results");
  return { ok: true, status: expected, stages };
}

// ---------------------------------------------------------------------------
// Classification (pure, exported for tests)
// ---------------------------------------------------------------------------

interface Verdict {
  status: PipelineVerdict;
  reason: PipelineReason;
  detail: string;
  failedStage: StageName | null;
  stages: StageResult[] | null;
  packagesAdded: number | null;
}

const verdict = (
  status: PipelineVerdict, reason: PipelineReason, detail: string,
  extra: Partial<Pick<Verdict, "failedStage" | "stages" | "packagesAdded">> = {},
): Verdict => ({ status, reason, detail, failedStage: null, stages: null, packagesAdded: null, ...extra });

export function classifyPipeline(r: SandboxResult, expectedPackages: number, testPresent: boolean): Verdict {
  switch (r.kind) {
    case "timed-out":
      return verdict("not-run", "timed-out", "the container hit its time limit; result is inconclusive");
    case "aborted":
      return verdict("not-run", "aborted", "the pipeline was cancelled; result is inconclusive");
    case "isolation-violation":
      return verdict("not-run", "isolation-violation", `container was not started: ${r.reason}`);
    case "unavailable":
      return verdict("not-run", "docker-unavailable", r.reason);
    case "rejected":
      return verdict("not-run", "rejected", r.reason);
    case "exited":
      break;
  }
  if (r.truncated) return verdict("not-run", "output-truncated", "container output was truncated; the report cannot be trusted");
  if (r.exitCode !== EXIT_PASSED && r.exitCode !== EXIT_FAILED) {
    return verdict("not-run", "driver-error", `the driver exited with code ${r.exitCode} and no usable report`);
  }
  if (r.stderr !== "") return verdict("not-run", "protocol-error", "the driver wrote to stderr, which the protocol forbids");
  const parsed = parseProtocolOutput(r.stdout, testPresent);
  if (!parsed.ok) return verdict("not-run", "protocol-error", `invalid driver output: ${parsed.problem}`);
  const stages = parsed.stages;
  if ((r.exitCode === EXIT_PASSED) !== (parsed.status === "passed")) {
    return verdict("not-run", "protocol-error", "exit code contradicts the reported status", { stages });
  }

  if (parsed.status === "passed") {
    const install = stages.find((s) => s.stage === "install") as StageResult;
    const added = parseNpmAdded(install.stdoutTail ?? "");
    if (added === null) {
      return verdict("not-run", "summary-mismatch", "install passed but npm's `added N packages` summary was not found", { stages });
    }
    if (added !== expectedPackages) {
      return verdict("not-run", "summary-mismatch", `npm reported ${added} package(s), the lockfile lists ${expectedPackages}`, {
        stages, packagesAdded: added,
      });
    }
    // Success requires prepare, install, build AND test all passed. No tests is never success.
    if (!stages.every((s) => s.status === "passed")) {
      const testStage = stages.find((s) => s.stage === "test") as StageResult;
      if (testStage.status === "not-run") {
        return verdict("not-run", "tests-not-run", "install and build passed but the fixture has no tests; tests were not run, so this is not a success", {
          stages, packagesAdded: added, failedStage: "test",
        });
      }
      return verdict("not-run", "protocol-error", "driver reported passed but not every stage passed", { stages });
    }
    return verdict("success", "ok", `install, build and test completed offline (${added} package(s))`, {
      stages, packagesAdded: added,
    });
  }

  const failed = stages.find((s) => s.status === "failed") as StageResult;
  if (parsed.status === "cancelled") {
    return verdict("not-run", "driver-cancelled", `the driver was cancelled during ${failed.stage}`, { stages, failedStage: failed.stage });
  }
  if (failed.reason === "exit-code" && (failed.stage === "install" || failed.stage === "build" || failed.stage === "test")) {
    return verdict("failure", `${failed.stage}-failed` as const, `${failed.stage} exited with code ${String(failed.exitCode)}`, {
      stages, failedStage: failed.stage,
    });
  }
  return verdict("not-run", "stage-inconclusive", `${failed.stage} did not complete (${failed.reason ?? "unknown"}); this is not a verdict on the fixture`, {
    stages, failedStage: failed.stage,
  });
}

// ---------------------------------------------------------------------------
// Host-side file helpers
// ---------------------------------------------------------------------------

type ReadResult = { kind: "missing" } | { kind: "other" } | { kind: "too-large" } | { kind: "file"; bytes: Buffer };

function readCapped(path: string, max: number): ReadResult {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "other" };
  }
  if (!st.isFile()) return { kind: "other" }; // symlinks, directories, devices
  if (st.size > max) return { kind: "too-large" };
  try {
    return { kind: "file", bytes: readFileSync(path) };
  } catch {
    return { kind: "other" };
  }
}

/** Removes exactly the expected staged files. Anything unexpected is left in place and reported. Never throws. */
export function removeStagedPipeline(dir: string, names: readonly string[]): { removed: boolean; problem: string | null } {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return { removed: false, problem: "staging path is not a real directory" };
    const have = readdirSync(dir).sort();
    const want = [...names].sort();
    if (have.length !== want.length || !have.every((n, i) => n === want[i])) {
      return { removed: false, problem: "staging directory has unexpected contents" };
    }
    for (const n of want) {
      if (!lstatSync(join(dir, n)).isFile()) return { removed: false, problem: `staged ${n} is not a regular file` };
    }
    for (const n of want) unlinkSync(join(dir, n));
    rmdirSync(dir);
    return { removed: true, problem: null };
  } catch (e) {
    return { removed: false, problem: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function defaultDriverPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "fixture-pipeline-driver.js");
}

export class ControlledPipeline {
  private readonly sandbox: DockerFixtureSandbox | null;
  private readonly image: string;
  private readonly root: string | null;
  private readonly staging: string | null;
  private readonly driverPath: string;
  private readonly expectedSha: string | null;
  private readonly unavailable: { reason: PipelineReason; detail: string } | null;
  private readonly realpath: (p: string) => string;

  constructor(opts: ControlledPipelineOptions) {
    this.image = opts.image ?? NODE_FIXTURE_IMAGE;
    this.realpath = opts.realpath ?? ((p: string): string => realpathSync(p));
    this.driverPath = opts.driverPath ?? defaultDriverPath();
    this.expectedSha = opts.expectedDriverSha256 ?? null;
    let root: string | null = null;
    let staging: string | null = null;
    let sandbox: DockerFixtureSandbox | null = null;
    let unavailable: { reason: PipelineReason; detail: string } | null = null;

    try {
      if (![opts.fixturesRoot, opts.stagingRoot, opts.cacheDir, this.driverPath].every((p) => typeof p === "string" && isAbsolute(p))) {
        throw new Error("fixturesRoot, stagingRoot, cacheDir and driverPath must be absolute paths");
      }
      if (this.expectedSha !== null && !SHA256_RE.test(this.expectedSha)) throw new Error("expectedDriverSha256 must be 64 lowercase hex characters");
      root = this.realpath(resolve(opts.fixturesRoot));
      staging = this.realpath(resolve(opts.stagingRoot));
      if (root === staging) throw new Error("stagingRoot must differ from fixturesRoot");
    } catch (e) {
      unavailable = { reason: "unconfigured", detail: e instanceof Error ? e.message : "invalid configuration" };
    }

    if (unavailable === null && staging !== null) {
      let cache: string | null = null;
      try {
        cache = this.realpath(resolve(opts.cacheDir));
        if (!lstatSync(cache).isDirectory()) cache = null;
      } catch {
        cache = null;
      }
      if (cache === null) {
        unavailable = { reason: "cache-unavailable", detail: "the offline npm cache directory does not exist; nothing was run" };
      } else {
        try {
          sandbox = new DockerFixtureSandbox({
            executor: opts.executor,
            allowedImages: [this.image],
            commands: { [PIPELINE_COMMAND_ID]: PIPELINE_ARGV },
            fixturesRoot: staging,
            readonlyBinds: [{ source: cache, target: PIPELINE_CACHE_MOUNT }],
            extraTmpfs: [{ target: PIPELINE_WORK_MOUNT, sizeMb: PIPELINE_WORK_TMPFS_MB }],
            limits: { ...DEFAULT_PIPELINE_LIMITS, ...(opts.limits ?? {}) },
            realpath: this.realpath,
            ...(opts.dockerBinary === undefined ? {} : { dockerBinary: opts.dockerBinary }),
          });
        } catch (e) {
          unavailable = { reason: "unconfigured", detail: e instanceof Error ? e.message : "invalid sandbox configuration" };
        }
      }
    }
    this.root = root;
    this.staging = staging;
    this.sandbox = sandbox;
    this.unavailable = unavailable;
  }

  /** Never throws. Always reports container cleanup evidence when a container could exist. */
  async run(req: PipelineRequest): Promise<ControlledPipelineResult> {
    const executionId = typeof req?.executionId === "string" ? req.executionId : null;
    const notRun = (reason: PipelineReason, detail: string, extra: Partial<ControlledPipelineResult> = {}): ControlledPipelineResult => ({
      status: "not-run", reason, detail, failedStage: null, stages: null, exitCode: null, durationMs: null,
      truncated: false, stderrTail: "", packagesAdded: null, expectedPackages: null, violations: [],
      cleanup: null, stagingRemoved: null, driverSha256: null, executionId, ...extra,
    });

    if (req?.signal?.aborted === true) return notRun("aborted", "cancelled before start; nothing was created");
    if (this.unavailable !== null || this.sandbox === null || this.root === null || this.staging === null) {
      const u = this.unavailable ?? { reason: "unconfigured" as const, detail: "pipeline is not configured" };
      return notRun(u.reason, u.detail);
    }
    try {
      containerNameFor(req.executionId);
    } catch {
      return notRun("rejected", "invalid execution id");
    }
    if (typeof req.fixture !== "string" || !FIXTURE_NAME_RE.test(req.fixture)) return notRun("rejected", "invalid fixture name");

    // 1. Resolve the source directory inside the fixtures root.
    let source: string;
    try {
      source = this.realpath(resolve(this.root, req.fixture));
    } catch {
      return notRun("rejected", "fixture directory does not exist");
    }
    const rel = relative(this.root, source);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return notRun("rejected", "fixture escapes fixturesRoot");

    // 2. Read the fixed set of inputs. Nothing else in the directory is read.
    const pkg = readCapped(join(source, "package.json"), MAX_PACKAGE_JSON_BYTES);
    if (pkg.kind === "missing") return notRun("no-package-json", "fixture has no package.json; nothing was run");
    const lock = readCapped(join(source, "package-lock.json"), MAX_LOCKFILE_BYTES);
    if (lock.kind === "missing") return notRun("no-lockfile", "fixture has no package-lock.json; npm ci needs one and nothing was run");
    const build = readCapped(join(source, "build.mjs"), MAX_SCRIPT_BYTES);
    if (build.kind === "missing") return notRun("no-build-script", "fixture has no build.mjs; nothing was run");
    const testFile = readCapped(join(source, "test.mjs"), MAX_SCRIPT_BYTES);
    if ([pkg, lock, build, testFile].some((x) => x.kind === "other")) {
      return notRun("unreadable-input", "a fixture input is not a readable regular file; nothing was run");
    }
    if ([pkg, lock, build, testFile].some((x) => x.kind === "too-large")) {
      return notRun("policy-rejected", "a fixture input is larger than the allowed size", {
        violations: ["input file larger than the allowed size"],
      });
    }
    if (pkg.kind !== "file" || lock.kind !== "file" || build.kind !== "file") {
      return notRun("unreadable-input", "a fixture input could not be read; nothing was run");
    }
    const testBytes = testFile.kind === "file" ? testFile.bytes : null; // "missing" is allowed
    const testPresent = testBytes !== null;

    // 3. Static dependency policy, before any process exists.
    const policy = checkNpmFixture(pkg.bytes.toString("utf8"), lock.bytes.toString("utf8"));
    if (!policy.ok) {
      return notRun("policy-rejected", `${policy.violations.length} policy violation(s); first: ${policy.violations[0] ?? ""}`, {
        violations: policy.violations,
      });
    }
    const expectedPackages = policy.packageCount;

    // 4. The trusted compiled driver.
    const driver = readCapped(this.driverPath, MAX_DRIVER_BYTES);
    if (driver.kind !== "file") return notRun("driver-unavailable", "the compiled driver is missing or unreadable; run the build first", { expectedPackages });
    const driverSha256 = createHash("sha256").update(driver.bytes).digest("hex");
    if (this.expectedSha !== null && this.expectedSha !== driverSha256) {
      return notRun("driver-unavailable", "the compiled driver does not match the pinned sha256; nothing was run", { expectedPackages, driverSha256 });
    }

    // 5. Stage exactly the validated bytes.
    const staged: Array<[string, Buffer]> = [
      [STAGED_DRIVER_NAME, driver.bytes],
      ["package.json", pkg.bytes],
      ["package-lock.json", lock.bytes],
      ["build.mjs", build.bytes],
    ];
    if (testBytes !== null) staged.push(["test.mjs", testBytes]);
    const stagedNames = staged.map(([n]) => n);
    const stagedDir = join(this.staging, req.fixture);
    try {
      mkdirSync(stagedDir); // non-recursive: an existing entry is refused and never touched
    } catch {
      return notRun("staging-failed", "could not create the staging directory (it may already exist); nothing was run", { expectedPackages, driverSha256 });
    }
    try {
      for (const [name, bytes] of staged) writeFileSync(join(stagedDir, name), bytes, { flag: "wx", mode: 0o644 });
    } catch {
      const removal = removeStagedPipeline(stagedDir, stagedNames.filter((n) => existsAsFile(join(stagedDir, n))));
      return notRun("staging-failed", "could not write the staged files; nothing was run", {
        expectedPackages, driverSha256, stagingRemoved: removal.removed,
      });
    }

    // 6. One fixed command in a disposable container.
    let res: SandboxResult | null = null;
    let cleanup: CleanupProof | null = null;
    try {
      res = await this.sandbox.execute({
        executionId: req.executionId,
        commandId: PIPELINE_COMMAND_ID,
        image: this.image,
        fixture: req.fixture,
        ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
        ...(req.signal === undefined ? {} : { signal: req.signal }),
      });
      cleanup = res.cleanup;
    } catch {
      cleanup = await this.sandbox.cleanup({ executionId: req.executionId });
    }

    // 7. Remove the staged copy regardless of the outcome.
    const removal = removeStagedPipeline(stagedDir, stagedNames);

    if (res === null) {
      return notRun("docker-unavailable", "sandbox call failed unexpectedly", {
        expectedPackages, driverSha256, cleanup, stagingRemoved: removal.removed,
      });
    }

    let v = classifyPipeline(res, expectedPackages, testPresent);
    if (v.status !== "not-run" && cleanup?.confirmed !== true) {
      const why = cleanup === null ? "no cleanup proof" : cleanup.confirmed ? "" : cleanup.reason;
      v = { ...v, status: "not-run", reason: "cleanup-unconfirmed", detail: `container cleanup was not confirmed (${why}); no verdict can be reported` };
    } else if (v.status !== "not-run" && !removal.removed) {
      v = { ...v, status: "not-run", reason: "staging-cleanup-failed", detail: `staging directory was not removed (${removal.problem ?? "unknown"}); no verdict can be reported` };
    }

    const out = outputOf(res);
    return {
      status: v.status,
      reason: v.reason,
      detail: v.detail,
      failedStage: v.failedStage,
      stages: v.stages,
      exitCode: out.exitCode,
      durationMs: out.durationMs,
      truncated: out.truncated,
      stderrTail: tailOf(out.stderr),
      packagesAdded: v.packagesAdded,
      expectedPackages,
      violations: [],
      cleanup,
      stagingRemoved: removal.removed,
      driverSha256,
      executionId,
    };
  }
}

/** Captured output exists only when the container actually ran. */
function outputOf(r: SandboxResult): { exitCode: number | null; durationMs: number | null; truncated: boolean; stderr: string } {
  if (r.kind === "exited" || r.kind === "timed-out" || r.kind === "aborted") {
    return {
      exitCode: r.kind === "exited" ? r.exitCode : null,
      durationMs: r.durationMs,
      truncated: r.truncated,
      stderr: r.stderr,
    };
  }
  return { exitCode: null, durationMs: null, truncated: false, stderr: "" };
}

function existsAsFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}
