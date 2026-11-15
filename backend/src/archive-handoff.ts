/**
 * archive-handoff.ts — bridges a validated tar archive (git archive format) to a fresh,
 * backend-owned fixture directory that NodeFixtureRunner can mount read-only. Harness and test
 * support only: not wired into the server, worker or any job. Written without running anything
 * (unverified until external results are logged).
 *
 * Safety rules:
 *  - The target is `<runDir>/<name>`, created non-recursively so it must not exist. `runDir` must
 *    be a real directory (not a symlink) named `run-<12 hex>` (see fixture-workspace.ts).
 *  - The archive and the expected commit/file/byte manifest are validated first with a no-op sink,
 *    before the target directory is created. A mismatch writes nothing and returns dir: null.
 *  - extractTar validates the whole archive before the sink is called. The sink re-checks every
 *    path against the target (resolve + prefix), requires each parent to be a real directory
 *    (lstat), and creates files exclusively ("wx"), so nothing existing is overwritten or followed.
 *  - After extraction the tree is audited with lstat (no symlinks or special files) and the file
 *    and byte totals must equal the extraction summary and, if given, the expected manifest and
 *    commit. Any mismatch fails closed; the caller removes the run directory with removeRunDir.
 *
 * buildGitArchiveTar produces tar bytes in the layout of `git archive` (pax global header with
 * `comment=<sha>`, directory entries, regular files). It is NOT produced by git, so a test using
 * it proves nothing about real `git archive` output or any network clone.
 *
 * @module archive-handoff
 */

import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { extractTar, type ExtractLimits, type ExtractSink, type ExtractSummary } from "./tar-extract.js";

const RUN_DIR_RE = /^run-[0-9a-f]{12}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const AUDIT_MAX_DEPTH = 8;
const AUDIT_MAX_ENTRIES = 1000;

export interface HandoffExpectation {
  commit?: string;
  files?: number;
  totalBytes?: number;
}

export type HandoffResult =
  | { ok: true; dir: string; summary: ExtractSummary }
  | { ok: false; reason: string; dir: string | null };

function isRealDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Sink confined to one root. Every path is re-checked; parents must be real directories. */
export class ConfinedDirSink implements ExtractSink {
  constructor(private readonly root: string) {}
  private target(rel: string): string {
    if (rel === "" || isAbsolute(rel) || rel.includes("\\") || rel.split("/").some((s) => s === "" || s === "." || s === "..")) {
      throw new Error("invalid relative path");
    }
    const p = resolve(this.root, rel);
    if (!p.startsWith(this.root + sep)) throw new Error("path escapes the fixture directory");
    const parent = resolve(p, "..");
    if (parent !== this.root && !isRealDir(parent)) throw new Error("parent is not a real directory");
    return p;
  }
  mkdir(rel: string): void {
    mkdirSync(this.target(rel), { mode: 0o755 });
  }
  writeFile(rel: string, data: Uint8Array, executable: boolean): void {
    writeFileSync(this.target(rel), data, { flag: "wx", mode: executable ? 0o755 : 0o644 });
  }
}

/** Validation-only sink: accepts every call and touches nothing. */
const NOOP_SINK: ExtractSink = {
  mkdir(): void {},
  writeFile(): void {},
};

/** lstat walk: no symlinks or special files, bounded depth and entry count. */
export function auditTree(root: string): { files: number; directories: number; bytes: number } {
  let files = 0;
  let directories = 0;
  let bytes = 0;
  let entries = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > AUDIT_MAX_DEPTH) throw new Error("tree is deeper than expected");
    for (const name of readdirSync(dir)) {
      entries += 1;
      if (entries > AUDIT_MAX_ENTRIES) throw new Error("tree has more entries than expected");
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error("symlink found in extracted tree");
      if (st.isDirectory()) {
        directories += 1;
        walk(p, depth + 1);
      } else if (st.isFile()) {
        files += 1;
        bytes += st.size;
      } else {
        throw new Error("special file found in extracted tree");
      }
    }
  };
  walk(root, 0);
  return { files, directories, bytes };
}

/**
 * Extracts `archive` into a NEW directory `<runDir>/<name>`. Never throws. On failure after the
 * directory was created, `dir` is returned so the caller can clean up (removeRunDir on runDir).
 */
export function extractArchiveIntoFixture(
  archive: Uint8Array,
  runDir: string,
  name: string,
  limits: ExtractLimits,
  expect: HandoffExpectation = {},
): HandoffResult {
  if (!isAbsolute(runDir) || !RUN_DIR_RE.test(basename(resolve(runDir))) || !isRealDir(resolve(runDir))) {
    return { ok: false, reason: "run directory is not a real generated run directory", dir: null };
  }
  if (typeof name !== "string" || !NAME_RE.test(name)) return { ok: false, reason: "invalid fixture name", dir: null };
  if (expect.commit !== undefined && !SHA_RE.test(expect.commit)) return { ok: false, reason: "invalid expected commit", dir: null };

  // Phase 1: validate the whole archive and the expectations with a no-op sink. Nothing is
  // created on disk, so any refusal or mismatch leaves no target directory and no files.
  try {
    const pre = extractTar(archive, limits, NOOP_SINK);
    if (!pre.ok) return { ok: false, reason: `extraction refused: ${pre.reason}`, dir: null };
    const p = pre.value;
    if (expect.commit !== undefined && p.archiveCommit !== expect.commit) {
      return { ok: false, reason: "archive commit comment does not match the expected commit", dir: null };
    }
    if (expect.files !== undefined && p.files !== expect.files) return { ok: false, reason: "file count differs from the manifest", dir: null };
    if (expect.totalBytes !== undefined && p.totalBytes !== expect.totalBytes) {
      return { ok: false, reason: "byte total differs from the manifest", dir: null };
    }
  } catch (e) {
    return { ok: false, reason: `archive validation failed: ${e instanceof Error ? e.message : String(e)}`, dir: null };
  }

  // Phase 2: create the fresh target and extract for real.
  const dir = join(resolve(runDir), name);
  try {
    mkdirSync(dir, { mode: 0o755 }); // non-recursive: fails if it exists
  } catch (e) {
    return { ok: false, reason: `cannot create fixture directory: ${e instanceof Error ? e.message : String(e)}`, dir: null };
  }
  try {
    const r = extractTar(archive, limits, new ConfinedDirSink(dir));
    if (!r.ok) return { ok: false, reason: `extraction refused: ${r.reason}`, dir };
    const s = r.value;
    const audit = auditTree(dir);
    if (audit.files !== s.files || audit.bytes !== s.totalBytes || audit.directories !== s.directories) {
      return { ok: false, reason: "on-disk audit differs from the extraction summary", dir };
    }
    return { ok: true, dir, summary: s };
  } catch (e) {
    return { ok: false, reason: `extraction failed: ${e instanceof Error ? e.message : String(e)}`, dir };
  }
}

// ---------------------------------------------------------------------------
// Controlled archive builder (tests and harness only)
// ---------------------------------------------------------------------------

function header(name: string, type: string, size: number, mode: number): Buffer {
  const h = Buffer.alloc(512);
  if (Buffer.byteLength(name) > 100) throw new Error("tar name too long for a plain ustar header");
  h.write(name, 0, 100, "utf8");
  h.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  h.write(type, 156, 1, "ascii");
  h.write("ustar\0" + "00", 257, 8, "latin1");
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

function padded(b: Buffer): Buffer {
  return Buffer.concat([b, Buffer.alloc(Math.ceil(b.length / 512) * 512 - b.length)]);
}

/**
 * Builds a tar in the layout of `git archive`: pax global header carrying `comment=<commit>`,
 * parent directory entries, then regular files. Not produced by git.
 */
export function buildGitArchiveTar(files: Readonly<Record<string, string>>, commit: string): Buffer {
  if (!SHA_RE.test(commit)) throw new Error("commit must be 40 lowercase hex characters");
  const parts: Buffer[] = [];
  const pax = Buffer.from(`52 comment=${commit}\n`, "latin1");
  parts.push(header("pax_global_header", "g", pax.length, 0o666), padded(pax));
  const dirs = new Set<string>();
  for (const rel of Object.keys(files)) {
    const segs = rel.split("/");
    for (let i = 1; i < segs.length; i += 1) dirs.add(segs.slice(0, i).join("/"));
  }
  for (const d of [...dirs].sort()) parts.push(header(`${d}/`, "5", 0, 0o755));
  for (const [rel, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    parts.push(header(rel, "0", data.length, 0o644), padded(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
