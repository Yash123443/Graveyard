/**
 * npm-acquire-driver.ts — trusted driver for the CONTROLLED npm registry acquisition. It runs
 * INSIDE one disposable container that is attached to exactly one Docker `--internal` network whose
 * only reachable endpoint is a CONNECT-only proxy for `registry.npmjs.org:443`
 * (see egress-proxy.ts, option `target`). It is not a general installer:
 *   /fixture     read-only staged directory: this driver, package.json, package-lock.json
 *   /work        bounded tmpfs, the only writable place and the cwd of every process
 *   $GRAVEYARD_NPM_PROXY   `http://<private IPv4>:<port>`, the proxy. Anything else is refused.
 *
 * Fixed behaviour, no caller-supplied commands or arguments:
 *   1. prepare: copy exactly package.json and package-lock.json into /work (lstat + O_NOFOLLOW, no
 *      symlinks, size capped, files created exclusively) and create two DISTINCT empty npm config
 *      files (npm refuses one path as both user and global config).
 *   2. install: `npm ci --ignore-scripts --no-audit --no-fund` with the registry pinned to
 *      https://registry.npmjs.org/, the proxy given on the command line, `strict-ssl=true`, an empty
 *      user/global config and the npm cache on /work. No `.npmrc` is read, no token exists.
 *   3. export: walk ONLY `<cache>/_cacache/content-v2` and `<cache>/_cacache/index-v5` with lstat,
 *      refuse anything that is not a plain directory or regular file, and put the files, as base64,
 *      on stdout. The host recomputes every hash and writes the files itself (npm-registry-cache.ts);
 *      this process never hands the host a path to open, a link to follow or a directory to mount.
 *
 * Output protocol: exactly ONE JSON line on stdout, nothing on stderr (children use pipes).
 * Exit code 0 passed, 1 failed or cancelled, 70 internal error (no line then).
 *
 * Not covered here: whether the network really is isolated (the host checks `docker inspect` and the
 * operator-run harness probes the proxy), which packages are acceptable (the host's lock policy and
 * fixed-fixture check), and whether npm behaves as modelled (unobserved: written without running
 * anything; every deviation fails closed).
 *
 * @module npm-acquire-driver
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ACQUIRE_PROTOCOL_ID = "graveyard-npm-acquire/1";
export const ACQUIRE_SOURCE_DIR = "/fixture";
export const ACQUIRE_WORK_DIR = "/work";
export const ACQUIRE_CACHE_NAME = "npm-cache";
export const ACQUIRE_PROXY_ENV = "GRAVEYARD_NPM_PROXY";
export const NPM_REGISTRY_URL = "https://registry.npmjs.org/";
export const ACQUIRE_INPUT_FILES: readonly string[] = Object.freeze(["package.json", "package-lock.json"]);
export const ACQUIRE_USERCONFIG_NAME = ".empty-npmrc";
export const ACQUIRE_GLOBALCONFIG_NAME = ".empty-npmrc-global";
export const EXIT_PASSED = 0;
export const EXIT_FAILED = 1;
export const EXIT_INTERNAL = 70;

export const MAX_INPUT_FILE_BYTES = 64 * 1024;
export const TAIL_CHARS = 1024;
/** Export bounds. The host enforces the same numbers again on what it receives. */
export const MAX_EXPORT_FILES = 64;
export const MAX_EXPORT_FILE_BYTES = 64 * 1024;
export const MAX_EXPORT_TOTAL_BYTES = 128 * 1024;
const MAX_EXPORT_DEPTH = 6;
/** Stays below the host's 256 KiB container output cap, with room for the JSON envelope. */
export const MAX_PROTOCOL_LINE_CHARS = 240 * 1024;

export const ACQUIRE_LIMITS = Object.freeze({
  installTimeoutMs: 100_000,
  maxOutputBytes: 256 * 1024,
});

export type AcquirePhase = "prepare" | "install" | "export" | "done";
export type AcquireFailure = "refused" | "exit-code" | "timeout" | "output-limit" | "cancelled" | "spawn-error" | "io-error";
export type AcquireStatus = "passed" | "failed" | "cancelled";

export interface ExportedFile {
  /** Relative to `_cacache`, for example `content-v2/sha512/ab/cd/<124 hex>`. */
  path: string;
  size: number;
  /** Base64 of the file bytes. */
  data: string;
}

export interface AcquireResult {
  status: AcquireStatus;
  /** The phase that failed, or "done" when everything passed. */
  phase: AcquirePhase;
  reason?: AcquireFailure;
  /** Short, bounded, contains no process output. */
  detail?: string;
  exitCode?: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  files: ExportedFile[];
}

// ---------------------------------------------------------------------------------------------
// Proxy URL (shared with the host so both sides apply the same rule)
// ---------------------------------------------------------------------------------------------

const PROXY_URL_RE = /^http:\/\/(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2}):([1-9][0-9]{0,4})$/;

/**
 * Accepts only `http://<private IPv4 literal>:<port>`: 10/8, 172.16/12 or 192.168/16, canonical
 * dotted quad, no credentials, no path, no host name. Anything else returns null.
 */
export function parsePrivateProxyUrl(url: unknown): { host: string; port: number } | null {
  if (typeof url !== "string" || url.length > 40) return null;
  const m = PROXY_URL_RE.exec(url);
  if (m === null) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((n) => n > 255)) return null;
  const port = Number(m[5]);
  if (port > 65535) return null;
  const a = o[0] as number;
  const b = o[1] as number;
  const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  return isPrivate ? { host: o.join("."), port } : null;
}

/** The fixed `npm ci` argument list. Every value is a constant or a validated path/URL. */
export function npmAcquireArgs(proxyUrl: string, cacheDir: string, userConfig: string, globalConfig: string): string[] {
  return [
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--logs-max=0",
    "--registry", NPM_REGISTRY_URL,
    "--proxy", proxyUrl,
    "--https-proxy", proxyUrl,
    "--strict-ssl=true",
    "--fetch-retries=1",
    "--fetch-timeout=30000",
    "--maxsockets=2",
    "--userconfig", userConfig,
    "--globalconfig", globalConfig,
    "--cache", cacheDir,
  ];
}

// ---------------------------------------------------------------------------------------------
// Process runner (shell:false, bounded time and output)
// ---------------------------------------------------------------------------------------------

export interface AcquireProcessSpec {
  readonly command: "npm";
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface AcquireProcessOutcome {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  spawnError?: string;
}

export type AcquireRunner = (spec: AcquireProcessSpec) => Promise<AcquireProcessOutcome>;

function tail(s: string, max = TAIL_CHARS): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

/** Spawns one process without a shell. Never rejects. */
export const runNpm: AcquireRunner = (spec) =>
  new Promise<AcquireProcessOutcome>((resolvePromise) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let total = 0;
    const state = { timedOut: false, aborted: false, truncated: false, settled: false };
    const outcome = (p: Partial<AcquireProcessOutcome>): AcquireProcessOutcome => ({
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
        detached: process.platform !== "win32",
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
    const finish = (p: Partial<AcquireProcessOutcome>): void => {
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
// Safe file reads and the cache export walk
// ---------------------------------------------------------------------------------------------

class RefusedError extends Error {}

function errCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "unknown";
}

/** Reads a regular file without following a symlink. Throws RefusedError or an fs error. */
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

export type ExportOutcome =
  | { ok: true; files: ExportedFile[] }
  | { ok: false; reason: AcquireFailure; detail: string };

/**
 * Collects the cacache content and index trees. Anything other than plain directories and regular
 * files, any bound exceeded, or a missing tree is a refusal (never a partial export).
 */
export function exportCache(cacheRoot: string): ExportOutcome {
  const files: ExportedFile[] = [];
  let total = 0;
  const fail = (detail: string): ExportOutcome => ({ ok: false, reason: "refused", detail });

  const walk = (dir: string, rel: string, depth: number): ExportOutcome | null => {
    if (depth > MAX_EXPORT_DEPTH) return fail("cache tree is deeper than expected");
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (e) {
      return { ok: false, reason: "io-error", detail: `cache directory could not be listed: ${errCode(e)}` };
    }
    for (const name of names) {
      const p = join(dir, name);
      const r = `${rel}/${name}`;
      let st;
      try {
        st = lstatSync(p);
      } catch (e) {
        return { ok: false, reason: "io-error", detail: `cache entry could not be inspected: ${errCode(e)}` };
      }
      if (st.isSymbolicLink()) return fail("cache contains a symlink");
      if (st.isDirectory()) {
        const sub = walk(p, r, depth + 1);
        if (sub !== null) return sub;
        continue;
      }
      if (!st.isFile()) return fail("cache contains a special file");
      if (files.length >= MAX_EXPORT_FILES) return fail("cache has more files than allowed");
      let data: Buffer;
      try {
        data = readRegularFile(p, MAX_EXPORT_FILE_BYTES);
      } catch (e) {
        if (e instanceof RefusedError) return fail(`a cache file ${e.message}`);
        return { ok: false, reason: "io-error", detail: `cache file could not be read: ${errCode(e)}` };
      }
      total += data.length;
      if (total > MAX_EXPORT_TOTAL_BYTES) return fail("cache is larger than allowed");
      files.push({ path: r.slice(1), size: data.length, data: data.toString("base64") });
    }
    return null;
  };

  for (const sub of ["content-v2", "index-v5"]) {
    const dir = join(cacheRoot, sub);
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      return fail(`expected cache directory ${sub} is missing`);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return fail(`${sub} is not a real directory`);
    const r = walk(dir, `/${sub}`, 0);
    if (r !== null) return r;
  }
  if (files.length === 0) return fail("cache contains no files");
  return { ok: true, files };
}

// ---------------------------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------------------------

export interface AcquireOptions {
  sourceDir?: string;
  workDir?: string;
  /** Default: process.env[GRAVEYARD_NPM_PROXY]. */
  proxyUrl?: string | undefined;
  runner?: AcquireRunner;
  signal?: AbortSignal;
  installTimeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => number;
}

function positive(n: number | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Runs prepare, install and export in that order. Never throws. */
export async function runAcquisition(options: AcquireOptions = {}): Promise<AcquireResult> {
  const sourceDir = resolve(options.sourceDir ?? ACQUIRE_SOURCE_DIR);
  const workDir = resolve(options.workDir ?? ACQUIRE_WORK_DIR);
  const runner = options.runner ?? runNpm;
  const now = options.now ?? Date.now;
  const signal = options.signal;
  const started = now();
  const cacheDir = join(workDir, ACQUIRE_CACHE_NAME);
  const userConfig = join(workDir, ACQUIRE_USERCONFIG_NAME);
  const globalConfig = join(workDir, ACQUIRE_GLOBALCONFIG_NAME);
  const proxyUrl = "proxyUrl" in options ? options.proxyUrl : process.env[ACQUIRE_PROXY_ENV];

  const result = (
    status: AcquireStatus,
    phase: AcquirePhase,
    extra: Partial<AcquireResult> = {},
  ): AcquireResult => ({
    status, phase, durationMs: Math.max(0, now() - started), stdoutTail: "", stderrTail: "", files: [], ...extra,
  });
  const refused = (phase: AcquirePhase, reason: AcquireFailure, detail: string): AcquireResult =>
    result("failed", phase, { reason, detail });

  if (signal?.aborted) return result("cancelled", "prepare", { reason: "cancelled", detail: "cancelled" });

  // 1. prepare
  if (parsePrivateProxyUrl(proxyUrl) === null) {
    return refused("prepare", "refused", "proxy url is missing or is not http://<private IPv4>:<port>");
  }
  const proxy = proxyUrl as string;
  try {
    const srcRoot = lstatSync(sourceDir);
    const workRoot = lstatSync(workDir);
    if (srcRoot.isSymbolicLink() || !srcRoot.isDirectory() || workRoot.isSymbolicLink() || !workRoot.isDirectory()) {
      return refused("prepare", "refused", "source or work directory is not a real directory");
    }
  } catch (e) {
    return refused("prepare", "io-error", `directory check failed: ${errCode(e)}`);
  }
  for (const name of ACQUIRE_INPUT_FILES) {
    let data: Buffer;
    try {
      data = readRegularFile(join(sourceDir, name), MAX_INPUT_FILE_BYTES);
    } catch (e) {
      if (e instanceof RefusedError) return refused("prepare", "refused", `${name} ${e.message}`);
      const code = errCode(e);
      if (code === "ENOENT") return refused("prepare", "refused", `${name} is missing`);
      if (code === "ELOOP" || code === "EMLINK") return refused("prepare", "refused", `${name} is a symlink`);
      return refused("prepare", "io-error", `${name} could not be read: ${code}`);
    }
    try {
      writeFileSync(join(workDir, name), data, { flag: "wx", mode: 0o644 });
    } catch (e) {
      return refused("prepare", "io-error", `${name} could not be written: ${errCode(e)}`);
    }
  }
  try {
    writeFileSync(userConfig, "", { flag: "wx", mode: 0o644 });
    writeFileSync(globalConfig, "", { flag: "wx", mode: 0o644 });
  } catch (e) {
    return refused("prepare", "io-error", `empty npm config could not be written: ${errCode(e)}`);
  }

  // 2. install
  if (signal?.aborted) return result("cancelled", "install", { reason: "cancelled", detail: "cancelled" });
  const maxOutputBytes = positive(options.maxOutputBytes, ACQUIRE_LIMITS.maxOutputBytes);
  const installTimeoutMs = positive(options.installTimeoutMs, ACQUIRE_LIMITS.installTimeoutMs);
  const env: Readonly<Record<string, string>> = Object.freeze({
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: workDir,
    NODE_ENV: "production",
    CI: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  });
  const o = await runner({
    command: "npm",
    args: npmAcquireArgs(proxy, cacheDir, userConfig, globalConfig),
    cwd: workDir,
    env,
    timeoutMs: installTimeoutMs,
    maxOutputBytes,
    ...(signal ? { signal } : {}),
  });
  const base = { exitCode: o.exitCode, stdoutTail: tail(o.stdout ?? ""), stderrTail: tail(o.stderr ?? "") };
  const failed = (status: AcquireStatus, reason: AcquireFailure, detail: string): AcquireResult =>
    result(status, "install", { ...base, reason, detail });
  if (o.aborted) return failed("cancelled", "cancelled", "cancelled");
  if (o.spawnError !== undefined) return failed("failed", "spawn-error", "npm could not be started");
  if (o.timedOut) return failed("failed", "timeout", `exceeded ${installTimeoutMs} ms`);
  if (o.truncated) return failed("failed", "output-limit", `output exceeded ${maxOutputBytes} bytes`);
  if (o.exitCode !== 0) {
    return failed("failed", "exit-code", o.signal ? `terminated by ${o.signal}` : `exited with code ${String(o.exitCode)}`);
  }

  // 3. export
  const exported = exportCache(join(cacheDir, "_cacache"));
  if (!exported.ok) return result("failed", "export", { ...base, reason: exported.reason, detail: exported.detail });
  return result("passed", "done", { ...base, files: exported.files });
}

// ---------------------------------------------------------------------------------------------
// Process protocol (the container entry point)
// ---------------------------------------------------------------------------------------------

/** Serialises a result as the single protocol line. Only known fields are written. */
export function encodeAcquireLine(r: AcquireResult): string {
  const line = (x: AcquireResult): string => {
    const o: Record<string, unknown> = { protocol: ACQUIRE_PROTOCOL_ID, status: x.status, phase: x.phase };
    if (x.reason !== undefined) o["reason"] = x.reason;
    if (x.detail !== undefined) o["detail"] = x.detail.slice(0, 300);
    if (x.exitCode !== undefined) o["exitCode"] = x.exitCode;
    o["durationMs"] = x.durationMs;
    o["stdoutTail"] = tail(x.stdoutTail);
    o["stderrTail"] = tail(x.stderrTail);
    o["files"] = x.files.map((f) => ({ path: f.path, size: f.size, data: f.data }));
    return `${JSON.stringify(o)}\n`;
  };
  const full = line(r);
  if (full.length <= MAX_PROTOCOL_LINE_CHARS) return full;
  return line({
    ...r, status: "failed", phase: "export", reason: "output-limit", detail: "export is larger than the protocol allows", files: [],
  });
}

/** Runs the fixed acquisition and writes the protocol line. Returns the exit code. */
export async function driverMain(): Promise<number> {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  try {
    const result = await runAcquisition({ signal: controller.signal });
    const line = encodeAcquireLine(result);
    await new Promise<void>((done, fail) => {
      process.stdout.write(line, (e) => (e ? fail(e) : done()));
    });
    const ok = result.status === "passed" && line.includes('"status":"passed"');
    return ok ? EXIT_PASSED : EXIT_FAILED;
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

// Importing this module (tests, host) never runs anything; only running the file itself does.
if (isEntryPoint()) {
  void driverMain().then((code) => {
    process.exitCode = code;
  });
}
