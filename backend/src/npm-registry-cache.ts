/**
 * npm-registry-cache.ts — strict parsing of the acquisition driver's single output line and
 * verified HANDOFF of the npm cache it exports. Pure functions plus one filesystem step.
 * Written without running anything: unverified until an operator runs the tests and the opt-in
 * harness (see backend/DEVELOPMENT.md).
 *
 * Why this exists. The acquisition container has network access (through a registry-only proxy) and
 * is therefore the less trusted side of the handoff. The build/test stage runs with network `none`
 * and mounts a cache read-only. Nothing from the acquisition container may reach that mount
 * unchecked. The rules:
 *
 *  - No mount, no `docker cp`, no tar. The container only prints bytes; the host owns every path,
 *    every directory and every file that is created. A link or special file cannot be handed over
 *    because the format has no way to express one.
 *  - Every received path must match the exact cacache layout (`content-v2/sha512/xx/yy/<124 hex>`
 *    or `index-v5/xx/yy/<60 hex>`). Nothing else is accepted: no `..`, no absolute path, no
 *    `_logs`, no `tmp`, no extra directories.
 *  - Content files are content-addressed: the SHA-512 of the bytes must equal the hex in the path.
 *    The tarball the lockfile names must be present under exactly the hash the LOCKFILE gives, so
 *    the bytes are bound to the lockfile integrity by the host, independently of npm.
 *  - Index files: every line must carry the SHA-1 of its JSON (cacache's own check), the bucket path
 *    must equal SHA-256 of the entry key, keys are limited to the registry URLs of the expected
 *    packages, every integrity must resolve to a handed-over content file with the stated size,
 *    and no content file may be left unreferenced.
 *  - Bounded: file count, per-file bytes and total bytes.
 *  - The host writes through the confined sink of archive-handoff.ts (new directories only,
 *    exclusive file creation, parents re-checked with lstat), then audits the result with lstat (no
 *    symlinks or special files, counts and bytes equal) and re-reads every file and compares hashes.
 *
 * Not covered, stated plainly: this does not prove the packages are safe or that the registry
 * served what the maintainers published (only that bytes match the lockfile integrity); the
 * `metadata` inside index entries is npm's own data and is not interpreted (a poisoned entry could
 * at worst make the offline install fail); and the cacache layout rules above are from the author's
 * understanding of npm's cache, UNOBSERVED. A different layout fails closed as `handoff-rejected`.
 *
 * @module npm-registry-cache
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Validated } from "./acquisition-policy.js";
import { ConfinedDirSink, auditTree } from "./archive-handoff.js";
import {
  ACQUIRE_PROTOCOL_ID,
  MAX_EXPORT_FILES,
  MAX_EXPORT_FILE_BYTES,
  MAX_EXPORT_TOTAL_BYTES,
  type AcquireFailure,
  type AcquirePhase,
  type AcquireStatus,
  type ExportedFile,
} from "./npm-acquire-driver.js";

export const REGISTRY_ORIGIN = "https://registry.npmjs.org";
export const CACHE_KEY_PREFIX = "make-fetch-happen:request-cache:";
export const CACHE_ROOT_DIR = "_cacache";
const MAX_INDEX_LINES = 4;
const MAX_TAIL_CHARS = 1024;
const MAX_DETAIL_CHARS = 300;
const MAX_PROTOCOL_CHARS = 250 * 1024;

const CONTENT_RE = /^content-v2\/sha512\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{124})$/;
const INDEX_RE = /^index-v5\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{60})$/;
const LINE_RE = /^([0-9a-f]{40})\t(\{[\s\S]*\})$/;
const INTEGRITY_RE = /^sha512-([A-Za-z0-9+/]{86}==)$/;
const EXPECTED_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const DIR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sha = (algo: "sha1" | "sha256" | "sha512", data: Uint8Array | string): string =>
  createHash(algo).update(data).digest("hex");

// ---------------------------------------------------------------------------
// Integrity helpers
// ---------------------------------------------------------------------------

/** `sha512-<base64>` to the 128-char hex that names the cacache content file, or null. */
export function integrityToHex(integrity: unknown): string | null {
  if (typeof integrity !== "string") return null;
  const m = INTEGRITY_RE.exec(integrity);
  if (m === null) return null;
  const raw = Buffer.from(m[1] as string, "base64");
  if (raw.length !== 64 || raw.toString("base64") !== m[1]) return null;
  return raw.toString("hex");
}

export function hexToIntegrity(hex: string): string {
  return `sha512-${Buffer.from(hex, "hex").toString("base64")}`;
}

/** The cacache content path for an integrity value, or null when it is not a canonical sha512. */
export function contentPathFor(integrity: string): string | null {
  const hex = integrityToHex(integrity);
  return hex === null ? null : `content-v2/sha512/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4)}`;
}

/** The cacache index bucket path for a key: SHA-256 of the key, split 2/2/rest. */
export function indexPathFor(key: string): string {
  const h = sha("sha256", key);
  return `index-v5/${h.slice(0, 2)}/${h.slice(2, 4)}/${h.slice(4)}`;
}

export interface ExpectedTarball {
  name: string;
  version: string;
  /** The lockfile's `sha512-` integrity. */
  integrity: string;
}

export function tarballKey(p: ExpectedTarball): string {
  return `${CACHE_KEY_PREFIX}${REGISTRY_ORIGIN}/${p.name}/-/${p.name}-${p.version}.tgz`;
}

export function packumentKey(p: ExpectedTarball): string {
  return `${CACHE_KEY_PREFIX}${REGISTRY_ORIGIN}/${p.name}`;
}

// ---------------------------------------------------------------------------
// Protocol line (what the container printed)
// ---------------------------------------------------------------------------

export interface AcquireReport {
  status: AcquireStatus;
  phase: AcquirePhase;
  reason: AcquireFailure | null;
  detail: string;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  files: ExportedFile[];
}

const STATUSES: readonly string[] = ["passed", "failed", "cancelled"];
const PHASES: readonly string[] = ["prepare", "install", "export", "done"];
const REASONS: readonly string[] = ["refused", "exit-code", "timeout", "output-limit", "cancelled", "spawn-error", "io-error"];
const TOP_KEYS: readonly string[] = [
  "protocol", "status", "phase", "reason", "detail", "exitCode", "durationMs", "stdoutTail", "stderrTail", "files",
];
const REQUIRED_TOP: readonly string[] = ["protocol", "status", "phase", "durationMs", "stdoutTail", "stderrTail", "files"];

/** Parses the single-line report. Never throws. A passed report must carry files, any other none. */
export function parseAcquireOutput(stdout: string): Validated<AcquireReport> {
  const bad = (reason: string): Validated<AcquireReport> => ({ ok: false, reason });
  if (typeof stdout !== "string" || stdout.length === 0) return bad("no output");
  if (stdout.length > MAX_PROTOCOL_CHARS) return bad("output is larger than the protocol allows");
  const nl = stdout.indexOf("\n");
  if (nl !== stdout.length - 1) return bad("output is not exactly one newline-terminated line");
  if (stdout.includes("\r")) return bad("output contains a carriage return");
  if (stdout[0] !== "{" || stdout[nl - 1] !== "}") return bad("output is not a bare JSON object line");
  let doc: unknown;
  try {
    doc = JSON.parse(stdout.slice(0, nl));
  } catch {
    return bad("output is not valid JSON");
  }
  if (!isObj(doc)) return bad("output is not a JSON object");
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k)) return bad("unexpected top-level key");
  for (const k of REQUIRED_TOP) if (!Object.prototype.hasOwnProperty.call(doc, k)) return bad("missing top-level key");
  if (doc["protocol"] !== ACQUIRE_PROTOCOL_ID) return bad("unknown protocol identifier");
  const status = doc["status"];
  const phase = doc["phase"];
  if (typeof status !== "string" || !STATUSES.includes(status)) return bad("invalid status");
  if (typeof phase !== "string" || !PHASES.includes(phase)) return bad("invalid phase");
  let reason: AcquireFailure | null = null;
  if (doc["reason"] !== undefined) {
    if (typeof doc["reason"] !== "string" || !REASONS.includes(doc["reason"])) return bad("invalid reason");
    reason = doc["reason"] as AcquireFailure;
  }
  let detail = "";
  if (doc["detail"] !== undefined) {
    if (typeof doc["detail"] !== "string" || doc["detail"].length > MAX_DETAIL_CHARS) return bad("invalid detail");
    detail = doc["detail"];
  }
  let exitCode: number | null = null;
  if (doc["exitCode"] !== undefined && doc["exitCode"] !== null) {
    if (typeof doc["exitCode"] !== "number" || !Number.isInteger(doc["exitCode"])) return bad("invalid exitCode");
    exitCode = doc["exitCode"];
  }
  const dur = doc["durationMs"];
  if (typeof dur !== "number" || !Number.isFinite(dur) || dur < 0) return bad("invalid durationMs");
  const out = doc["stdoutTail"];
  const err = doc["stderrTail"];
  if (typeof out !== "string" || out.length > MAX_TAIL_CHARS) return bad("invalid stdoutTail");
  if (typeof err !== "string" || err.length > MAX_TAIL_CHARS) return bad("invalid stderrTail");

  const rawFiles = doc["files"];
  if (!Array.isArray(rawFiles) || rawFiles.length > MAX_EXPORT_FILES) return bad("files is not a bounded array");
  const files: ExportedFile[] = [];
  for (const f of rawFiles as unknown[]) {
    if (!isObj(f)) return bad("file entry is not an object");
    const keys = Object.keys(f).sort().join(",");
    if (keys !== "data,path,size") return bad("file entry has unexpected keys");
    const { path, size, data } = f;
    if (typeof path !== "string" || path.length > 200) return bad("invalid file path");
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > MAX_EXPORT_FILE_BYTES) return bad("invalid file size");
    if (typeof data !== "string") return bad("invalid file data");
    files.push({ path, size, data });
  }

  // Consistency between status, phase, reason and files.
  if (status === "passed") {
    if (phase !== "done" || reason !== null || files.length === 0) return bad("passed report is inconsistent");
  } else {
    if (phase === "done" || reason === null || files.length !== 0) return bad("failure report is inconsistent");
    if (status === "cancelled" && reason !== "cancelled") return bad("cancelled report is inconsistent");
    if (status === "failed" && reason === "cancelled") return bad("failed report is inconsistent");
  }
  return {
    ok: true,
    value: { status: status as AcquireStatus, phase: phase as AcquirePhase, reason, detail, exitCode, durationMs: dur, stdoutTail: out, stderrTail: err, files },
  };
}

// ---------------------------------------------------------------------------
// Cache verification (pure)
// ---------------------------------------------------------------------------

export interface CacheLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_CACHE_LIMITS: Readonly<CacheLimits> = Object.freeze({
  maxFiles: MAX_EXPORT_FILES,
  maxFileBytes: MAX_EXPORT_FILE_BYTES,
  maxTotalBytes: MAX_EXPORT_TOTAL_BYTES,
});

export interface VerifiedCacheEntry {
  /** Relative to the `_cacache` directory. */
  path: string;
  bytes: Buffer;
}

export interface CacheSummary {
  files: number;
  contentFiles: number;
  indexFiles: number;
  totalBytes: number;
  directories: number;
  /** Tarballs bound to the lockfile integrity by the host. */
  tarballs: ExpectedTarball[];
}

export interface VerifiedCache {
  entries: VerifiedCacheEntry[];
  summary: Omit<CacheSummary, "directories">;
}

/**
 * Verifies the exported files against the expected tarballs (from the lockfile). Nothing is
 * written. Reasons never echo exported text.
 */
export function verifyNpmCacheFiles(
  files: unknown,
  expected: readonly ExpectedTarball[],
  limits: CacheLimits = DEFAULT_CACHE_LIMITS,
): Validated<VerifiedCache> {
  const bad = (reason: string): Validated<VerifiedCache> => ({ ok: false, reason });
  if (!Array.isArray(expected) || expected.length === 0 || expected.length > 8) return bad("expected package list is invalid");
  const wanted = new Map<string, { kind: "tarball" | "packument"; pkg: ExpectedTarball }>();
  for (const p of expected) {
    if (!isObj(p) || typeof p.name !== "string" || !EXPECTED_NAME_RE.test(p.name)) return bad("expected package name is unsupported");
    if (typeof p.version !== "string" || !VERSION_RE.test(p.version)) return bad("expected package version is unsupported");
    if (integrityToHex(p.integrity) === null) return bad("expected integrity is not a canonical sha512 value");
    if (typeof p.integrity !== "string") return bad("expected integrity is not a canonical sha512 value");
    const pkg: ExpectedTarball = { name: p.name, version: p.version, integrity: p.integrity };
    wanted.set(tarballKey(pkg), { kind: "tarball", pkg });
    wanted.set(packumentKey(pkg), { kind: "packument", pkg });
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > limits.maxFiles) return bad("file count is out of range");

  const seen = new Set<string>();
  const entries: VerifiedCacheEntry[] = [];
  const content = new Map<string, Buffer>(); // integrity -> bytes
  const indexFiles: VerifiedCacheEntry[] = [];
  let total = 0;
  const maxB64 = Math.ceil(limits.maxFileBytes / 3) * 4;

  for (const f of files as unknown[]) {
    if (!isObj(f) || Object.keys(f).sort().join(",") !== "data,path,size") return bad("file entry is malformed");
    const { path, size, data } = f;
    if (typeof path !== "string" || typeof data !== "string" || typeof size !== "number") return bad("file entry is malformed");
    if (seen.has(path)) return bad("duplicate path");
    seen.add(path);
    if (!Number.isInteger(size) || size < 0 || size > limits.maxFileBytes) return bad("file size is out of range");
    if (data.length > maxB64) return bad("file data is larger than allowed");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length !== size || bytes.toString("base64") !== data) return bad("file data is not canonical base64 of the declared size");
    total += size;
    if (total > limits.maxTotalBytes) return bad("files exceed the total size limit");

    const c = CONTENT_RE.exec(path);
    if (c !== null) {
      const hex = `${c[1]}${c[2]}${c[3]}`;
      if (sha("sha512", bytes) !== hex) return bad("a content file does not match the hash in its path");
      content.set(hexToIntegrity(hex), bytes);
      entries.push({ path, bytes });
      continue;
    }
    if (INDEX_RE.test(path)) {
      const e = { path, bytes };
      entries.push(e);
      indexFiles.push(e);
      continue;
    }
    return bad("a path is not a cacache content or index path");
  }
  if (content.size === 0 || indexFiles.length === 0) return bad("cache has no content or no index entries");

  const referenced = new Set<string>();
  const tarballSeen = new Set<string>();
  for (const idx of indexFiles) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(idx.bytes);
    } catch {
      return bad("an index file is not valid UTF-8");
    }
    const lines = text.split("\n").filter((l) => l !== "");
    if (lines.length === 0 || lines.length > MAX_INDEX_LINES) return bad("an index file has an unexpected number of entries");
    for (const line of lines) {
      const m = LINE_RE.exec(line);
      if (m === null) return bad("an index entry is malformed");
      if (sha("sha1", m[2] as string) !== m[1]) return bad("an index entry hash does not match its JSON");
      let parsed: unknown;
      try {
        parsed = JSON.parse(m[2] as string);
      } catch {
        return bad("an index entry is not valid JSON");
      }
      if (!isObj(parsed)) return bad("an index entry is not an object");
      const key = parsed["key"];
      const integrity = parsed["integrity"];
      const size = parsed["size"];
      if (typeof key !== "string" || typeof integrity !== "string" || typeof size !== "number" || !Number.isInteger(size)) {
        return bad("an index entry lacks key, integrity or size");
      }
      if (typeof parsed["time"] !== "number") return bad("an index entry lacks a time");
      const want = wanted.get(key);
      if (want === undefined) return bad("an index key is not an expected registry URL");
      if (indexPathFor(key) !== idx.path) return bad("an index bucket path does not match its key");
      if (integrityToHex(integrity) === null) return bad("an index integrity is not a canonical sha512 value");
      const bytes = content.get(integrity);
      if (bytes === undefined) return bad("an index entry points at content that was not handed over");
      if (bytes.length !== size) return bad("an index entry size differs from its content");
      if (want.kind === "tarball") {
        if (integrity !== want.pkg.integrity) return bad("a tarball entry does not carry the lockfile integrity");
        tarballSeen.add(want.pkg.name);
      }
      referenced.add(integrity);
    }
  }
  for (const integ of content.keys()) if (!referenced.has(integ)) return bad("a content file is not referenced by any index entry");
  for (const p of expected) if (!tarballSeen.has(p.name)) return bad("an expected tarball has no index entry");
  for (const p of expected) {
    const cp = contentPathFor(p.integrity);
    if (cp === null || !seen.has(cp)) return bad("an expected tarball content file is missing");
  }

  return {
    ok: true,
    value: {
      entries,
      summary: {
        files: entries.length,
        contentFiles: content.size,
        indexFiles: indexFiles.length,
        totalBytes: total,
        tarballs: expected.map((p) => ({ name: p.name, version: p.version, integrity: p.integrity })),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Handoff to disk
// ---------------------------------------------------------------------------

export type CacheHandoffResult =
  | { ok: true; cacheDir: string; summary: CacheSummary }
  /** `dir` is set when a directory was created before the failure, so the caller can remove it. */
  | { ok: false; reason: string; dir: string | null };

function isRealDir(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Verifies `files` and writes them to a NEW directory `<runDir>/<name>/_cacache/...`. The returned
 * `cacheDir` is `<runDir>/<name>`, which is what `npm --cache` (and the read-only `/npm-cache`
 * mount of controlled-pipeline.ts) expects. Never throws.
 */
export function handoffNpmCache(
  files: unknown,
  expected: readonly ExpectedTarball[],
  runDir: string,
  name: string,
  limits: CacheLimits = DEFAULT_CACHE_LIMITS,
): CacheHandoffResult {
  if (typeof runDir !== "string" || !isAbsolute(runDir) || !isRealDir(resolve(runDir))) {
    return { ok: false, reason: "run directory is not an existing real directory", dir: null };
  }
  if (typeof name !== "string" || !DIR_NAME_RE.test(name)) return { ok: false, reason: "invalid cache directory name", dir: null };

  const v = verifyNpmCacheFiles(files, expected, limits);
  if (!v.ok) return { ok: false, reason: v.reason, dir: null };

  const dir = join(resolve(runDir), name);
  try {
    mkdirSync(dir, { mode: 0o755 }); // non-recursive: fails if it exists
  } catch (e) {
    return { ok: false, reason: `cannot create cache directory: ${e instanceof Error ? e.message : String(e)}`, dir: null };
  }
  try {
    const sink = new ConfinedDirSink(dir);
    const made = new Set<string>();
    const mk = (rel: string): void => {
      if (made.has(rel)) return;
      made.add(rel);
      sink.mkdir(rel);
    };
    mk(CACHE_ROOT_DIR);
    for (const e of v.value.entries) {
      const parts = `${CACHE_ROOT_DIR}/${e.path}`.split("/");
      for (let i = 1; i < parts.length; i += 1) mk(parts.slice(0, i).join("/"));
      sink.writeFile(`${CACHE_ROOT_DIR}/${e.path}`, e.bytes, false);
    }

    const audit = auditTree(dir);
    const s = v.value.summary;
    if (audit.files !== s.files || audit.bytes !== s.totalBytes || audit.directories !== made.size) {
      return { ok: false, reason: "on-disk audit differs from the verified cache", dir };
    }
    // Re-read from disk: what a read-only mount will serve must be what was verified.
    for (const e of v.value.entries) {
      const p = join(dir, CACHE_ROOT_DIR, ...e.path.split("/"));
      const st = lstatSync(p);
      if (!st.isFile() || st.isSymbolicLink() || st.size !== e.bytes.length) return { ok: false, reason: "a written file is not what was verified", dir };
      if (sha("sha256", readFileSync(p)) !== sha("sha256", e.bytes)) return { ok: false, reason: "a written file differs from the verified bytes", dir };
    }
    return { ok: true, cacheDir: dir, summary: { ...s, directories: made.size } };
  } catch (e) {
    return { ok: false, reason: `cache handoff failed: ${e instanceof Error ? e.message : String(e)}`, dir };
  }
}
