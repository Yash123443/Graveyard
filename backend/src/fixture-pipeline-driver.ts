/**
 * fixture-pipeline-driver.ts — trusted driver for the CONTROLLED fixture pipeline. It is meant to
 * run INSIDE an isolated container, for a generated fixture only:
 *   /fixture     read-only source (generated, known file names)
 *   /npm-cache   read-only prepopulated npm cache
 *   /work        bounded tmpfs, the only writable place and the cwd of every process
 *
 * Fixed behaviour, no caller-supplied commands or arguments:
 *   1. prepare: copy the fixed allowlist of fixture files from the source into the work dir. Each
 *      source entry is checked with lstat and opened without following symlinks; symlinks, other
 *      non-regular files and oversized files are refused. Files are created exclusively.
 *   2. install: npm ci --offline --ignore-scripts --no-audit --no-fund with an isolated EMPTY npm
 *      config (user and global config point at two DISTINCT empty files the driver creates).
 *   3. build:   node build.mjs /work/out
 *   4. test:    node --test test.mjs   (test.mjs absent => "not-run", never a failure)
 *
 * Processes are spawned with shell:false, cwd = work dir, a minimal explicit environment, a time
 * limit and an output limit. A stage that times out, exceeds the output limit, is cancelled or
 * cannot be spawned is "failed" (fail closed). Every stage after a failed stage is "skipped".
 *
 * Dependency policy (which packages and lockfile contents are acceptable) is the HOST's
 * responsibility and is not checked here. Not wired into the server, worker or runner.
 *
 * Unverified: written without running anything until results are logged in backend/DEVELOPMENT.md.
 *
 * @module fixture-pipeline-driver
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SOURCE_DIR = "/fixture";
export const DEFAULT_CACHE_DIR = "/npm-cache";
export const DEFAULT_WORK_DIR = "/work";

/** Fixed allowlist. `required` files must exist; a missing optional file is not an error. */
export const FIXTURE_FILES: readonly { readonly name: string; readonly required: boolean }[] = Object.freeze([
  Object.freeze({ name: "package.json", required: true }),
  Object.freeze({ name: "package-lock.json", required: true }),
  Object.freeze({ name: "build.mjs", required: true }),
  Object.freeze({ name: "test.mjs", required: false }),
]);

export const EMPTY_NPM_CONFIG_NAME = ".empty-npmrc";
/** A second, distinct empty file: npm refuses to load the same path as user and global config. */
export const EMPTY_NPM_GLOBALCONFIG_NAME = ".empty-npmrc-global";
export const BUILD_OUT_NAME = "out";
export const MAX_FIXTURE_FILE_BYTES = 256 * 1024;
export const TAIL_BYTES = 4096;

export const DEFAULT_LIMITS = Object.freeze({
  installTimeoutMs: 120_000,
  buildTimeoutMs: 60_000,
  testTimeoutMs: 60_000,
  maxOutputBytes: 1024 * 1024,
});

export type StageName = "prepare" | "install" | "build" | "test";
export type StageStatus = "passed" | "failed" | "skipped" | "not-run";
export type FailureReason =
  | "refused"
  | "exit-code"
  | "timeout"
  | "output-limit"
  | "cancelled"
  | "spawn-error"
  | "io-error";
export type PipelineStatus = "passed" | "failed" | "cancelled";

/** A fully fixed process description. `command` can only be one of two literals. */
export interface ProcessSpec {
  readonly command: "npm" | "node";
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface ProcessOutcome {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** True when combined stdout+stderr exceeded `maxOutputBytes` (the process was killed). */
  truncated: boolean;
  spawnError?: string;
}

export type ProcessRunner = (spec: ProcessSpec) => Promise<ProcessOutcome>;

export interface StageResult {
  stage: StageName;
  status: StageStatus;
  reason?: FailureReason;
  /** Human-readable, bounded, contains no process output. */
  detail?: string;
  exitCode?: number | null;
  durationMs: number;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface PipelineResult {
  status: PipelineStatus;
  stages: StageResult[];
}

export interface FixturePipelineOptions {
  sourceDir?: string;
  cacheDir?: string;
  workDir?: string;
  runner?: ProcessRunner;
  signal?: AbortSignal;
  installTimeoutMs?: number;
  buildTimeoutMs?: number;
  testTimeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => number;
}

// ---------------------------------------------------------------------------------------------
// Default process runner (shell:false, bounded time and output)
// ---------------------------------------------------------------------------------------------

function tail(s: string, max = TAIL_BYTES): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

/** Spawns one process without a shell. Never rejects. */
export const runProcess: ProcessRunner = (spec) =>
  new Promise<ProcessOutcome>((resolvePromise) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let total = 0;
    const state = { timedOut: false, aborted: false, truncated: false, settled: false };
    const outcome = (p: Partial<ProcessOutcome>): ProcessOutcome => ({
      exitCode: null,
      signal: null,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
      timedOut: state.timedOut,
      aborted: state.aborted,
      truncated: state.truncated,
      ...p,
    });

    if (spec.signal?.aborted) {
      state.aborted = true;
      resolvePromise(outcome({}));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32", // own process group so the whole tree can be killed
      });
    } catch (e) {
      resolvePromise(outcome({ spawnError: e instanceof Error ? e.message : String(e) }));
      return;
    }

    const kill = (): void => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      state.timedOut = true;
      kill();
    }, spec.timeoutMs);
    const onAbort = (): void => {
      state.aborted = true;
      kill();
    };
    spec.signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (bucket: Buffer[]) => (chunk: Buffer): void => {
      if (state.truncated) return;
      const room = spec.maxOutputBytes - total;
      if (chunk.length > room) {
        if (room > 0) bucket.push(chunk.subarray(0, room));
        total = spec.maxOutputBytes;
        state.truncated = true;
        kill();
        return;
      }
      bucket.push(chunk);
      total += chunk.length;
    };
    child.stdout?.on("data", collect(out));
    child.stderr?.on("data", collect(err));

    const finish = (p: Partial<ProcessOutcome>): void => {
      if (state.settled) return;
      state.settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      resolvePromise(outcome(p));
    };
    child.on("error", (e) => finish({ spawnError: e.message }));
    child.on("close", (code, sig) => finish({ exitCode: code, signal: sig }));
  });

// ---------------------------------------------------------------------------------------------
// Copy of the controlled fixture files
// ---------------------------------------------------------------------------------------------

type CopyResult =
  | { ok: true; present: Set<string> }
  | { ok: false; reason: FailureReason; detail: string };

/** Reads a regular file without following a symlink. Throws on anything unexpected. */
function readRegularFile(path: string): Buffer {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new RefusedError("is a symlink");
  if (!st.isFile()) throw new RefusedError("is not a regular file");
  if (st.size > MAX_FIXTURE_FILE_BYTES) throw new RefusedError("is too large");
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const fst = fstatSync(fd);
    // Re-check on the open descriptor: guards against a swap between lstat and open.
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) throw new RefusedError("changed while reading");
    if (fst.size > MAX_FIXTURE_FILE_BYTES) throw new RefusedError("is too large");
    const buf = Buffer.alloc(fst.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    if (off !== buf.length) throw new RefusedError("changed while reading");
    return buf;
  } finally {
    closeSync(fd);
  }
}

class RefusedError extends Error {}

function copyFixture(sourceDir: string, workDir: string): CopyResult {
  const present = new Set<string>();
  try {
    const srcRoot = lstatSync(sourceDir);
    if (srcRoot.isSymbolicLink() || !srcRoot.isDirectory()) {
      return { ok: false, reason: "refused", detail: "source is not a real directory" };
    }
    const workRoot = lstatSync(workDir);
    if (workRoot.isSymbolicLink() || !workRoot.isDirectory()) {
      return { ok: false, reason: "refused", detail: "work dir is not a real directory" };
    }
  } catch (e) {
    return { ok: false, reason: "io-error", detail: `directory check failed: ${errCode(e)}` };
  }

  for (const f of FIXTURE_FILES) {
    let data: Buffer;
    try {
      data = readRegularFile(join(sourceDir, f.name));
    } catch (e) {
      if (e instanceof RefusedError) {
        return { ok: false, reason: "refused", detail: `${f.name} ${e.message}` };
      }
      const code = errCode(e);
      if (code === "ENOENT" && !f.required) continue;
      if (code === "ENOENT") return { ok: false, reason: "refused", detail: `${f.name} is missing` };
      // ELOOP/EMLINK come from O_NOFOLLOW on a symlink swapped in after lstat.
      if (code === "ELOOP" || code === "EMLINK") return { ok: false, reason: "refused", detail: `${f.name} is a symlink` };
      return { ok: false, reason: "io-error", detail: `${f.name} could not be read: ${code}` };
    }
    try {
      writeFileSync(join(workDir, f.name), data, { flag: "wx", mode: 0o644 });
    } catch (e) {
      return { ok: false, reason: "io-error", detail: `${f.name} could not be written: ${errCode(e)}` };
    }
    present.add(f.name);
  }

  try {
    writeFileSync(join(workDir, EMPTY_NPM_CONFIG_NAME), "", { flag: "wx", mode: 0o644 });
    writeFileSync(join(workDir, EMPTY_NPM_GLOBALCONFIG_NAME), "", { flag: "wx", mode: 0o644 });
  } catch (e) {
    return { ok: false, reason: "io-error", detail: `empty npm config could not be written: ${errCode(e)}` };
  }
  return { ok: true, present };
}

function errCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "unknown";
}

// ---------------------------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------------------------

function positive(n: number | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Runs prepare, install, build and test in that fixed order. Never throws. */
export async function runFixturePipeline(options: FixturePipelineOptions = {}): Promise<PipelineResult> {
  const sourceDir = resolve(options.sourceDir ?? DEFAULT_SOURCE_DIR);
  const cacheDir = resolve(options.cacheDir ?? DEFAULT_CACHE_DIR);
  const workDir = resolve(options.workDir ?? DEFAULT_WORK_DIR);
  const runner = options.runner ?? runProcess;
  const now = options.now ?? Date.now;
  const signal = options.signal;
  const maxOutputBytes = positive(options.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes);
  const emptyConfig = join(workDir, EMPTY_NPM_CONFIG_NAME);
  const emptyGlobalConfig = join(workDir, EMPTY_NPM_GLOBALCONFIG_NAME);
  const outDir = join(workDir, BUILD_OUT_NAME);

  const env: Readonly<Record<string, string>> = Object.freeze({
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: workDir,
    NODE_ENV: "production",
    CI: "true",
    NPM_CONFIG_USERCONFIG: emptyConfig,
    NPM_CONFIG_GLOBALCONFIG: emptyGlobalConfig,
    NPM_CONFIG_CACHE: cacheDir,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  });

  const stages: StageResult[] = [];
  let failed = false;
  let cancelled = false;

  const skip = (stage: StageName): void => {
    stages.push({ stage, status: "skipped", detail: "skipped because an earlier stage did not pass", durationMs: 0 });
  };

  const runStage = async (stage: StageName, spec: ProcessSpec): Promise<void> => {
    const started = now();
    const o = await runner(spec);
    const durationMs = Math.max(0, now() - started);
    const base = {
      stage,
      exitCode: o.exitCode,
      durationMs,
      stdoutTail: tail(o.stdout ?? ""),
      stderrTail: tail(o.stderr ?? ""),
    };
    const fail = (reason: FailureReason, detail: string): void => {
      failed = true;
      if (reason === "cancelled") cancelled = true;
      stages.push({ ...base, status: "failed", reason, detail });
    };
    // Order matters: cancellation and limits take precedence over whatever exit code the kill produced.
    if (o.aborted) fail("cancelled", "cancelled");
    else if (o.spawnError !== undefined) fail("spawn-error", "process could not be started");
    else if (o.timedOut) fail("timeout", `exceeded ${spec.timeoutMs} ms`);
    else if (o.truncated) fail("output-limit", `output exceeded ${spec.maxOutputBytes} bytes`);
    else if (o.exitCode !== 0) {
      fail("exit-code", o.signal ? `terminated by ${o.signal}` : `exited with code ${String(o.exitCode)}`);
    } else stages.push({ ...base, status: "passed" });
  };

  const spec = (
    command: "npm" | "node",
    args: readonly string[],
    timeoutMs: number,
  ): ProcessSpec => ({
    command,
    args,
    cwd: workDir,
    env,
    timeoutMs,
    maxOutputBytes,
    ...(signal ? { signal } : {}),
  });

  // prepare
  const prepStart = now();
  let present = new Set<string>();
  if (signal?.aborted) {
    failed = cancelled = true;
    stages.push({ stage: "prepare", status: "failed", reason: "cancelled", detail: "cancelled", durationMs: 0 });
  } else {
    const copy = copyFixture(sourceDir, workDir);
    const durationMs = Math.max(0, now() - prepStart);
    if (copy.ok) {
      present = copy.present;
      stages.push({ stage: "prepare", status: "passed", durationMs });
    } else {
      failed = true;
      stages.push({ stage: "prepare", status: "failed", reason: copy.reason, detail: copy.detail, durationMs });
    }
  }

  // install
  if (failed) skip("install");
  else if (signal?.aborted) {
    failed = cancelled = true;
    stages.push({ stage: "install", status: "failed", reason: "cancelled", detail: "cancelled", durationMs: 0 });
  } else {
    await runStage(
      "install",
      spec(
        "npm",
        [
          "ci",
          "--offline",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--no-update-notifier",
          "--logs-max=0",
          "--userconfig",
          emptyConfig,
          "--globalconfig",
          emptyGlobalConfig,
          "--cache",
          cacheDir,
        ],
        positive(options.installTimeoutMs, DEFAULT_LIMITS.installTimeoutMs),
      ),
    );
  }

  // build
  if (failed) skip("build");
  else if (signal?.aborted) {
    failed = cancelled = true;
    stages.push({ stage: "build", status: "failed", reason: "cancelled", detail: "cancelled", durationMs: 0 });
  } else {
    await runStage(
      "build",
      spec("node", ["build.mjs", outDir], positive(options.buildTimeoutMs, DEFAULT_LIMITS.buildTimeoutMs)),
    );
  }

  // test
  if (failed) skip("test");
  else if (!present.has("test.mjs")) {
    stages.push({ stage: "test", status: "not-run", detail: "no test.mjs in the fixture", durationMs: 0 });
  } else if (signal?.aborted) {
    failed = cancelled = true;
    stages.push({ stage: "test", status: "failed", reason: "cancelled", detail: "cancelled", durationMs: 0 });
  } else {
    await runStage(
      "test",
      spec("node", ["--test", "test.mjs"], positive(options.testTimeoutMs, DEFAULT_LIMITS.testTimeoutMs)),
    );
  }

  return { status: cancelled ? "cancelled" : failed ? "failed" : "passed", stages };
}

// ---------------------------------------------------------------------------------------------
// Process protocol (the container entry point)
// ---------------------------------------------------------------------------------------------

/**
 * When the compiled file is run as `node fixture-pipeline-driver.mjs` inside the container it writes
 * exactly ONE line to stdout: a JSON object `{"protocol", "status", "stages"}` followed by "\n".
 * Nothing else is ever written to stdout or stderr (child processes use pipes, not inherited
 * streams). Exit code: 0 pipeline passed, 1 pipeline failed or cancelled, 70 internal error (and
 * then no line is written). The host (controlled-pipeline.ts) parses the line strictly.
 */
export const PROTOCOL_ID = "graveyard-fixture-pipeline/1";
export const EXIT_PASSED = 0;
export const EXIT_FAILED = 1;
export const EXIT_INTERNAL = 70;
/** Per-stream tail length put on the wire. Keeps the whole line well below the host output cap. */
export const PROTOCOL_TAIL_CHARS = 1024;

/**
 * Stage limits used by the container entry point. Their sum stays below the host's container
 * timeout (120 s) so a slow stage is reported by the driver instead of killing the container.
 */
export const CONTAINER_LIMITS = Object.freeze({
  installTimeoutMs: 60_000,
  buildTimeoutMs: 20_000,
  testTimeoutMs: 20_000,
  maxOutputBytes: 256 * 1024,
});

/** Serialises a result as the single protocol line. Only known fields are written. */
export function encodeProtocolLine(result: PipelineResult): string {
  const stages = result.stages.map((s) => {
    const o: Record<string, unknown> = { stage: s.stage, status: s.status };
    if (s.reason !== undefined) o["reason"] = s.reason;
    if (s.detail !== undefined) o["detail"] = s.detail.slice(0, 300);
    if (s.exitCode !== undefined) o["exitCode"] = s.exitCode;
    o["durationMs"] = s.durationMs;
    if (s.stdoutTail !== undefined) o["stdoutTail"] = tail(s.stdoutTail, PROTOCOL_TAIL_CHARS);
    if (s.stderrTail !== undefined) o["stderrTail"] = tail(s.stderrTail, PROTOCOL_TAIL_CHARS);
    return o;
  });
  return `${JSON.stringify({ protocol: PROTOCOL_ID, status: result.status, stages })}\n`;
}

/** Runs the fixed pipeline with the container limits and writes the protocol line. Returns the exit code. */
export async function driverMain(): Promise<number> {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  try {
    const result = await runFixturePipeline({ ...CONTAINER_LIMITS, signal: controller.signal });
    const line = encodeProtocolLine(result);
    await new Promise<void>((done, fail) => {
      process.stdout.write(line, (e) => (e ? fail(e) : done()));
    });
    return result.status === "passed" ? EXIT_PASSED : EXIT_FAILED;
  } catch {
    return EXIT_INTERNAL;
  }
}

function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Importing this module (tests, host) never runs the pipeline; only running the file itself does.
if (isEntryPoint()) {
  void driverMain().then((code) => {
    process.exitCode = code;
  });
}
