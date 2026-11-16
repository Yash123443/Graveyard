/**
 * npm-scripts-driver.ts — trusted driver for the opt-in npm-scripts mode. It runs INSIDE an isolated
 * container (network none, non-root, read-only root, no capabilities) for a source snapshot that the
 * host extracted and audited (npm-scripts-snapshot.ts):
 *   /fixture     read-only snapshot of the pinned commit, plus two host-written files: this driver and
 *                the SANITIZED install manifest (the original package.json without `scripts`)
 *   /npm-cache   read-only, host-verified offline npm cache
 *   /work        bounded noexec tmpfs, the only writable place
 * Written without a shell or a test run (UNVERIFIED; see backend/DEVELOPMENT.md).
 *
 * The file is self-contained on purpose: it is staged alone as `.mjs` and may only import Node
 * built-ins. Its protocol is the existing fixture-pipeline protocol (same id, same four stage names,
 * same strict host parser), so the host reuses parseProtocolOutput and classifyPipeline unchanged. A
 * test asserts that PROTOCOL_ID equals the one in fixture-pipeline-driver.ts.
 *
 * Fixed behaviour, no caller-supplied commands or arguments:
 *   1. prepare   copy the snapshot to /work/project. Each entry is checked with lstat; a symlink, a
 *                special file or anything over the bounds is refused. Files are created exclusively.
 *                The copied root package.json is the SANITIZED manifest; the original bytes are kept
 *                in memory only. A sha256 of every copied file is recorded.
 *   2. install   `npm ci --offline --ignore-scripts` against the sanitized manifest and the unchanged
 *                lockfile, with isolated EMPTY npm configuration. Installation scripts never run.
 *   3. build     restore the ORIGINAL package.json, then `npm run build --ignore-scripts`.
 *   4. test      verify that package.json, package-lock.json and every test-like file still equal the
 *                original bytes (a build must not rewrite its tests), then `npm run test --ignore-scripts`.
 * `--ignore-scripts` does not stop `npm run` from running the NAMED script; it only disables the
 * pre/post hooks and every lifecycle script of the dependencies. The two scripts are the only
 * repository-authored commands that ever run; they run through npm's own script shell (`sh -c`) inside
 * this container. The driver spawns only `npm` with fixed argument arrays and shell:false.
 *
 * Known limitation (unverified): /work is a noexec tmpfs, so a script that executes a dependency's
 * `node_modules/.bin` entry directly cannot be executed there; it fails and is reported as that
 * stage failing. Scripts that call `node <file>` or `node --test` are unaffected.
 *
 * The result is one JSON line on stdout and nothing on stderr; exit 0 passed, 1 failed or cancelled,
 * 70 internal error.
 *
 * @module npm-scripts-driver
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FailureReason, PipelineResult, ProcessOutcome, ProcessRunner, ProcessSpec, StageName, StageResult } from "./fixture-pipeline-driver.js";

export const SCRIPTS_PROTOCOL_ID = "graveyard-fixture-pipeline/1";
export const SCRIPTS_DRIVER_NAME = ".graveyard-npm-scripts-driver.mjs";
export const SCRIPTS_INSTALL_MANIFEST_NAME = ".graveyard-install-package.json";
export const SCRIPTS_PROJECT_DIR = "project";
export const SCRIPTS_SOURCE_DIR = "/fixture";
export const SCRIPTS_CACHE_DIR = "/npm-cache";
export const SCRIPTS_WORK_DIR = "/work";
export const SCRIPTS_EXIT_PASSED = 0;
export const SCRIPTS_EXIT_FAILED = 1;
export const SCRIPTS_EXIT_INTERNAL = 70;

const EMPTY_NPMRC = ".empty-npmrc";
const EMPTY_NPMRC_GLOBAL = ".empty-npmrc-global";
const RUN_CACHE_DIR = ".npm-run-cache";
const TAIL_BYTES = 4096;
const PROTOCOL_TAIL_CHARS = 1024;

export const SCRIPTS_COPY_LIMITS = Object.freeze({
  maxFiles: 128,
  maxEntries: 320,
  maxDepth: 8,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
});

/** Their sum stays below the host container timeout (120 s). */
export const SCRIPTS_CONTAINER_LIMITS = Object.freeze({
  installTimeoutMs: 40_000,
  buildTimeoutMs: 30_000,
  testTimeoutMs: 30_000,
  maxOutputBytes: 256 * 1024,
});

/** Paths that a build must not change before the tests run: tests, the manifest and the lockfile. */
export const TEST_LIKE_RE = /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i;
const ALWAYS_PROTECTED: readonly string[] = ["package.json", "package-lock.json"];

export interface ScriptsDriverOptions {
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
export const runScriptsProcess: ProcessRunner = (spec: ProcessSpec) =>
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
// Snapshot copy
// ---------------------------------------------------------------------------------------------

class RefusedError extends Error {}

function errCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "unknown";
}

/** Reads a regular file without following a symlink. Throws RefusedError on anything unexpected. */
function readRegularFile(path: string, maxBytes: number): Buffer {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new RefusedError("is a symlink");
  if (!st.isFile()) throw new RefusedError("is not a regular file");
  if (st.size > maxBytes) throw new RefusedError("is too large");
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) throw new RefusedError("changed while reading");
    if (fst.size > maxBytes) throw new RefusedError("is too large");
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

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

export interface Prepared {
  projectDir: string;
  originalPackageJson: Buffer;
  /** relative path -> sha256 of the bytes as the snapshot held them (the ORIGINAL package.json for the root one). */
  digests: Map<string, string>;
  files: number;
  bytes: number;
}

export type PrepareResult = { ok: true; value: Prepared } | { ok: false; reason: FailureReason; detail: string };

const refuse = (detail: string): PrepareResult => ({ ok: false, reason: "refused", detail });

function isRealDir(path: string): boolean {
  const st = lstatSync(path);
  return st.isDirectory() && !st.isSymbolicLink();
}

/** Copies the snapshot into `<work>/project` and writes the empty npm configuration files into `<work>`. */
export function prepareProject(sourceDir: string, workDir: string): PrepareResult {
  let installManifest: Buffer = Buffer.alloc(0);
  try {
    if (!isRealDir(sourceDir)) return refuse("source is not a real directory");
    if (!isRealDir(workDir)) return refuse("work dir is not a real directory");
    installManifest = readRegularFile(join(sourceDir, SCRIPTS_INSTALL_MANIFEST_NAME), 64 * 1024);
    const parsed: unknown = JSON.parse(installManifest.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.prototype.hasOwnProperty.call(parsed, "scripts")) {
      return refuse("the install manifest is not a scripts-free JSON object");
    }
  } catch (e) {
    if (e instanceof RefusedError) return refuse(`install manifest ${e.message}`);
    return { ok: false, reason: "io-error", detail: `install manifest could not be read: ${errCode(e)}` };
  }

  const projectDir = join(workDir, SCRIPTS_PROJECT_DIR);
  const digests = new Map<string, string>();
  const original: { packageJson: Buffer | null } = { packageJson: null };
  let files = 0;
  let entries = 0;
  let bytes = 0;

  const walk = (rel: string, depth: number): PrepareResult | null => {
    if (depth > SCRIPTS_COPY_LIMITS.maxDepth) return refuse("the tree is deeper than allowed");
    const srcDir = rel === "" ? sourceDir : join(sourceDir, rel);
    const dstDir = rel === "" ? projectDir : join(projectDir, rel);
    for (const name of readdirSync(srcDir).sort()) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      if (rel === "" && (name === SCRIPTS_DRIVER_NAME || name === SCRIPTS_INSTALL_MANIFEST_NAME)) continue;
      entries += 1;
      if (entries > SCRIPTS_COPY_LIMITS.maxEntries) return refuse("the tree has more entries than allowed");
      const src = join(sourceDir, childRel);
      const st = lstatSync(src);
      if (st.isSymbolicLink()) return refuse("the tree contains a symlink");
      if (st.isDirectory()) {
        mkdirSync(join(dstDir, name), { mode: 0o755 });
        const r = walk(childRel, depth + 1);
        if (r !== null) return r;
      } else if (st.isFile()) {
        files += 1;
        if (files > SCRIPTS_COPY_LIMITS.maxFiles) return refuse("the tree has more files than allowed");
        const data = readRegularFile(src, SCRIPTS_COPY_LIMITS.maxFileBytes);
        bytes += data.length;
        if (bytes > SCRIPTS_COPY_LIMITS.maxTotalBytes) return refuse("the tree is larger than allowed");
        digests.set(childRel, sha256(data));
        let toWrite = data;
        if (childRel === "package.json") {
          original.packageJson = data;
          toWrite = installManifest;
        }
        writeFileSync(join(dstDir, name), toWrite, { flag: "wx", mode: (st.mode & 0o111) !== 0 ? 0o755 : 0o644 });
      } else {
        return refuse("the tree contains a special file");
      }
    }
    return null;
  };

  try {
    mkdirSync(projectDir, { mode: 0o755 });
    const r = walk("", 0);
    if (r !== null) return r;
    if (original.packageJson === null || !digests.has("package-lock.json")) return refuse("package.json or package-lock.json is missing");
    mkdirSync(join(workDir, RUN_CACHE_DIR), { mode: 0o755 });
    writeFileSync(join(workDir, EMPTY_NPMRC), "", { flag: "wx", mode: 0o644 });
    writeFileSync(join(workDir, EMPTY_NPMRC_GLOBAL), "", { flag: "wx", mode: 0o644 });
  } catch (e) {
    if (e instanceof RefusedError) return refuse(e.message);
    return { ok: false, reason: "io-error", detail: `the snapshot could not be copied: ${errCode(e)}` };
  }
  return { ok: true, value: { projectDir, originalPackageJson: original.packageJson as Buffer, digests, files, bytes } };
}

/** Replaces the project's package.json with the ORIGINAL bytes. False on any problem. */
function restoreOriginalManifest(p: Prepared): boolean {
  try {
    const path = join(p.projectDir, "package.json");
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    writeFileSync(path, p.originalPackageJson, { flag: "w", mode: 0o644 });
    return true;
  } catch {
    return false;
  }
}

/** True only if package.json, package-lock.json and every test-like file still equal the snapshot bytes. */
export function protectedFilesUnchanged(p: Prepared): boolean {
  try {
    for (const [rel, digest] of p.digests) {
      if (!ALWAYS_PROTECTED.includes(rel) && !TEST_LIKE_RE.test(rel)) continue;
      const now = readRegularFile(join(p.projectDir, ...rel.split("/")), SCRIPTS_COPY_LIMITS.maxFileBytes);
      if (sha256(now) !== digest) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------------------------

function positive(n: number | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Runs prepare, install, build and test in that fixed order. Never throws. */
export async function runScriptsPipeline(options: ScriptsDriverOptions = {}): Promise<PipelineResult> {
  const sourceDir = resolve(options.sourceDir ?? SCRIPTS_SOURCE_DIR);
  const cacheDir = resolve(options.cacheDir ?? SCRIPTS_CACHE_DIR);
  const workDir = resolve(options.workDir ?? SCRIPTS_WORK_DIR);
  const runner = options.runner ?? runScriptsProcess;
  const now = options.now ?? Date.now;
  const signal = options.signal;
  const maxOutputBytes = positive(options.maxOutputBytes, SCRIPTS_CONTAINER_LIMITS.maxOutputBytes);
  const emptyConfig = join(workDir, EMPTY_NPMRC);
  const emptyGlobalConfig = join(workDir, EMPTY_NPMRC_GLOBAL);
  const projectDir = join(workDir, SCRIPTS_PROJECT_DIR);
  const runCache = join(workDir, RUN_CACHE_DIR);

  const baseEnv = {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: workDir,
    CI: "true",
    NPM_CONFIG_USERCONFIG: emptyConfig,
    NPM_CONFIG_GLOBALCONFIG: emptyGlobalConfig,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  };
  const installEnv: Readonly<Record<string, string>> = Object.freeze({ ...baseEnv, NODE_ENV: "production", NPM_CONFIG_CACHE: cacheDir });
  const buildEnv: Readonly<Record<string, string>> = Object.freeze({ ...baseEnv, NODE_ENV: "production", NPM_CONFIG_CACHE: runCache });
  const testEnv: Readonly<Record<string, string>> = Object.freeze({ ...baseEnv, NODE_ENV: "test", NPM_CONFIG_CACHE: runCache });

  const stages: StageResult[] = [];
  let failed = false;
  let cancelled = false;

  const skip = (stage: StageName): void => {
    stages.push({ stage, status: "skipped", detail: "skipped because an earlier stage did not pass", durationMs: 0 });
  };
  const failNow = (stage: StageName, reason: FailureReason, detail: string): void => {
    failed = true;
    if (reason === "cancelled") cancelled = true;
    stages.push({ stage, status: "failed", reason, detail, durationMs: 0 });
  };

  const runStage = async (stage: StageName, spec: ProcessSpec): Promise<void> => {
    const started = now();
    const o = await runner(spec);
    const durationMs = Math.max(0, now() - started);
    const base = { stage, exitCode: o.exitCode, durationMs, stdoutTail: tail(o.stdout ?? ""), stderrTail: tail(o.stderr ?? "") };
    const fail = (reason: FailureReason, detail: string): void => {
      failed = true;
      if (reason === "cancelled") cancelled = true;
      stages.push({ ...base, status: "failed", reason, detail });
    };
    // Cancellation and limits take precedence over whatever exit code the kill produced.
    if (o.aborted) fail("cancelled", "cancelled");
    else if (o.spawnError !== undefined) fail("spawn-error", "process could not be started");
    else if (o.timedOut) fail("timeout", `exceeded ${spec.timeoutMs} ms`);
    else if (o.truncated) fail("output-limit", `output exceeded ${spec.maxOutputBytes} bytes`);
    else if (o.exitCode !== 0) fail("exit-code", o.signal ? `terminated by ${o.signal}` : `exited with code ${String(o.exitCode)}`);
    else stages.push({ ...base, status: "passed" });
  };

  const npmSpec = (args: readonly string[], env: Readonly<Record<string, string>>, timeoutMs: number): ProcessSpec => ({
    command: "npm",
    args,
    cwd: projectDir,
    env,
    timeoutMs,
    maxOutputBytes,
    ...(signal ? { signal } : {}),
  });
  const commonFlags = ["--no-update-notifier", "--logs-max=0", "--userconfig", emptyConfig, "--globalconfig", emptyGlobalConfig];

  // prepare
  const prepStart = now();
  let prepared: Prepared | null = null;
  if (signal?.aborted) {
    failNow("prepare", "cancelled", "cancelled");
  } else {
    const r = prepareProject(sourceDir, workDir);
    const durationMs = Math.max(0, now() - prepStart);
    if (r.ok) {
      prepared = r.value;
      stages.push({ stage: "prepare", status: "passed", durationMs });
    } else {
      failed = true;
      stages.push({ stage: "prepare", status: "failed", reason: r.reason, detail: r.detail, durationMs });
    }
  }

  // install: sanitized manifest (no scripts) + unchanged lockfile, no lifecycle scripts, offline.
  if (failed) skip("install");
  else if (signal?.aborted) failNow("install", "cancelled", "cancelled");
  else {
    await runStage(
      "install",
      npmSpec(
        ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", ...commonFlags, "--cache", cacheDir],
        installEnv,
        positive(options.installTimeoutMs, SCRIPTS_CONTAINER_LIMITS.installTimeoutMs),
      ),
    );
  }

  // build: original manifest restored, then exactly `npm run build` with hooks disabled.
  if (failed || prepared === null) skip("build");
  else if (signal?.aborted) failNow("build", "cancelled", "cancelled");
  else if (!restoreOriginalManifest(prepared)) failNow("build", "io-error", "the original package.json could not be restored");
  else {
    await runStage(
      "build",
      npmSpec(
        ["run", "build", "--ignore-scripts", ...commonFlags, "--cache", runCache],
        buildEnv,
        positive(options.buildTimeoutMs, SCRIPTS_CONTAINER_LIMITS.buildTimeoutMs),
      ),
    );
  }

  // test: the original tests must be intact, then exactly `npm run test` with hooks disabled.
  if (failed || prepared === null) skip("test");
  else if (signal?.aborted) failNow("test", "cancelled", "cancelled");
  else if (!protectedFilesUnchanged(prepared)) failNow("test", "refused", "package files or test files changed during the build");
  else {
    await runStage(
      "test",
      npmSpec(
        ["run", "test", "--ignore-scripts", ...commonFlags, "--cache", runCache],
        testEnv,
        positive(options.testTimeoutMs, SCRIPTS_CONTAINER_LIMITS.testTimeoutMs),
      ),
    );
  }

  return { status: cancelled ? "cancelled" : failed ? "failed" : "passed", stages };
}

// ---------------------------------------------------------------------------------------------
// Process protocol (the container entry point)
// ---------------------------------------------------------------------------------------------

/** Serialises a result as the single protocol line. Only known fields are written. */
export function encodeScriptsProtocolLine(result: PipelineResult): string {
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
  return `${JSON.stringify({ protocol: SCRIPTS_PROTOCOL_ID, status: result.status, stages })}\n`;
}

export async function scriptsDriverMain(): Promise<number> {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  try {
    const result = await runScriptsPipeline({ ...SCRIPTS_CONTAINER_LIMITS, signal: controller.signal });
    const line = encodeScriptsProtocolLine(result);
    await new Promise<void>((done, fail) => {
      process.stdout.write(line, (e) => (e ? fail(e) : done()));
    });
    return result.status === "passed" ? SCRIPTS_EXIT_PASSED : SCRIPTS_EXIT_FAILED;
  } catch {
    return SCRIPTS_EXIT_INTERNAL;
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
  void scriptsDriverMain().then((code) => {
    process.exitCode = code;
  });
}
