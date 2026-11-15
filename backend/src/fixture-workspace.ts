/**
 * fixture-workspace.ts — creation and removal of backend-owned temporary fixture directories,
 * for the opt-in real Docker harness. Nothing here is used by the server or worker.
 *
 * Safety rules:
 *  - Every generated path is validated: names and path segments match strict patterns, nothing
 *    may be absolute, empty, dot-prefixed or contain "..", and files are created exclusively
 *    (flag "wx") so an existing file or symlink is never overwritten or followed.
 *  - Removal never uses a recursive delete. It first proves the target is a real directory (not a
 *    symlink) named `run-<12 hex>` located DIRECTLY under the owned parent, then walks it with
 *    lstat, unlinking files and symlinks themselves (never their targets) and removing empty
 *    directories bottom-up, with depth and entry-count bounds. Anything unexpected is reported
 *    and left in place.
 *
 * Unverified: written without running anything. Tests use the real filesystem under os.tmpdir().
 *
 * @module fixture-workspace
 */

import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const OWNED_TMP_DIRNAME = ".tmp-fixtures";
const RUN_DIR_RE = /^run-[0-9a-f]{12}$/;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FORBIDDEN_PATH_CHARS = /[,"'\0\r\n]/;
const MAX_FILES = 32;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 500;

function requireRealDir(path: string, what: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${what} is not a real directory`);
}

/** Returns `<backendRoot>/.tmp-fixtures`, creating it if absent. Refuses a symlink or file. */
export function ensureOwnedParent(backendRoot: string): string {
  if (!isAbsolute(backendRoot)) throw new Error("backend root must be absolute");
  const root = resolve(backendRoot);
  requireRealDir(root, "backend root");
  const parent = join(root, OWNED_TMP_DIRNAME);
  try {
    requireRealDir(parent, "owned temp parent");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    mkdirSync(parent);
  }
  if (FORBIDDEN_PATH_CHARS.test(parent)) throw new Error("owned temp parent path contains forbidden characters");
  return parent;
}

/** Creates a fresh `run-<12 hex>` directory directly under `parent`. Fails if it already exists. */
export function createRunDir(parent: string): string {
  if (!isAbsolute(parent)) throw new Error("parent must be absolute");
  const p = resolve(parent);
  requireRealDir(p, "parent");
  const dir = join(p, `run-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir); // non-recursive: fails on collision
  if (FORBIDDEN_PATH_CHARS.test(dir)) throw new Error("run directory path contains forbidden characters");
  return dir;
}

function assertRunDir(parent: string, dir: string): void {
  if (!isAbsolute(parent) || !isAbsolute(dir)) throw new Error("paths must be absolute");
  const d = resolve(dir);
  if (dirname(d) !== resolve(parent)) throw new Error("run directory is not directly under the owned parent");
  if (!RUN_DIR_RE.test(basename(d))) throw new Error("run directory name is not a generated run name");
  requireRealDir(d, "run directory");
}

/** Writes `files` into `<runDir>/<name>/`. Returns the fixture directory. */
export function writeFixture(runDir: string, name: string, files: Readonly<Record<string, string>>): string {
  assertRunDir(dirname(resolve(runDir)), runDir);
  if (!SEGMENT_RE.test(name)) throw new Error("invalid fixture name");
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.length > MAX_FILES) throw new Error("invalid fixture file count");
  const base = join(resolve(runDir), name);
  mkdirSync(base);
  for (const [rel, content] of entries) {
    const segs = rel.split("/");
    if (segs.length > MAX_DEPTH || !segs.every((s) => SEGMENT_RE.test(s))) {
      throw new Error("invalid fixture file path");
    }
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES) {
      throw new Error("invalid fixture file content");
    }
    let dir = base;
    for (const seg of segs.slice(0, -1)) {
      dir = join(dir, seg);
      try {
        requireRealDir(dir, "fixture subdirectory");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        mkdirSync(dir);
      }
    }
    writeFileSync(join(dir, segs[segs.length - 1] as string), content, { flag: "wx", mode: 0o644 });
  }
  return base;
}

function removeContents(dir: string, depth: number, budget: { n: number }): void {
  if (depth > MAX_DEPTH) throw new Error("tree is deeper than expected");
  for (const name of readdirSync(dir)) {
    budget.n += 1;
    if (budget.n > MAX_ENTRIES) throw new Error("tree has more entries than expected");
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) {
      removeContents(p, depth + 1, budget);
      rmdirSync(p);
    } else {
      unlinkSync(p); // regular file or symlink: removes the entry itself, never a target
    }
  }
}

/** Removes a generated run directory. Never throws; failures are listed in `problems`. */
export function removeRunDir(parent: string, dir: string): { removed: boolean; problems: string[] } {
  try {
    assertRunDir(parent, dir);
    removeContents(resolve(dir), 0, { n: 0 });
    rmdirSync(resolve(dir));
    return { removed: true, problems: [] };
  } catch (e) {
    return { removed: false, problems: [`${dir}: ${e instanceof Error ? e.message : String(e)}`] };
  }
}
