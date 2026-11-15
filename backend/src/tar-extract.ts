/**
 * tar-extract.ts — strict, validate-first extraction of a `git archive` tar held in memory.
 * Foundation / harness support only. Not wired into the server or worker, and not run against
 * real `git archive` output yet (unverified; see backend/DEVELOPMENT.md).
 *
 * Policy (fail closed, nothing is written unless the whole archive validates):
 *  - Only regular files ("0"/NUL) and directories ("5") plus one pax global header ("g", the
 *    commit comment git writes). Symlinks, hard links, devices, FIFOs, per-entry pax ("x"),
 *    GNU long names ("L"/"K") and anything else are rejected.
 *  - Every path passes unsafePathReason (no absolute, "..", ".git", control chars, backslash)
 *    and must be unique ignoring case. A path may not be both a file and a directory/parent.
 *  - Bounded: input bytes, file count and total content bytes. Base-256 sizes are rejected.
 *  - The sink only ever receives relative, validated paths. It must create files exclusively.
 *    Because no link entries are ever accepted, extraction cannot create a symlink to follow.
 *  - Modes are not taken from the archive: files are 0644 or 0755 (executable bit only).
 *
 * @module tar-extract
 */

import { unsafePathReason, type Validated } from "./acquisition-policy.js";

export interface ExtractLimits {
  maxArchiveBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
}

export interface ExtractSink {
  /** Create a directory (parents already created before children). Must not follow symlinks. */
  mkdir(relPath: string): void;
  /** Create a new file exclusively (fail if it exists). */
  writeFile(relPath: string, data: Uint8Array, executable: boolean): void;
}

export interface ExtractSummary {
  files: number;
  directories: number;
  totalBytes: number;
  /** Commit id from the pax global header comment, if present. */
  archiveCommit: string | null;
}

const BLOCK = 512;
const MAX_PAX_BYTES = 8192;

function cstr(buf: Uint8Array, start: number, len: number): string {
  let end = start;
  const stop = start + len;
  while (end < stop && buf[end] !== 0) end += 1;
  return Buffer.from(buf.subarray(start, end)).toString("utf8");
}

function octal(buf: Uint8Array, start: number, len: number): number | null {
  if ((buf[start] ?? 0) & 0x80) return null; // base-256: not accepted
  const s = cstr(buf, start, len).trim();
  if (s === "") return 0;
  if (!/^[0-7]{1,12}$/.test(s)) return null;
  return parseInt(s, 8);
}

function isZeroBlock(buf: Uint8Array, off: number): boolean {
  for (let i = off; i < off + BLOCK; i += 1) if (buf[i] !== 0) return false;
  return true;
}

interface Entry {
  path: string;
  dir: boolean;
  exec: boolean;
  data: Uint8Array;
}

export function extractTar(archive: Uint8Array, limits: ExtractLimits, sink: ExtractSink): Validated<ExtractSummary> {
  if (archive.length === 0 || archive.length > limits.maxArchiveBytes) {
    return { ok: false, reason: "archive is empty or exceeds the byte limit" };
  }
  const entries: Entry[] = [];
  let off = 0;
  let ended = false;
  let archiveCommit: string | null = null;
  let sawGlobal = false;
  let files = 0;
  let totalBytes = 0;

  while (off < archive.length) {
    if (off + BLOCK > archive.length) return { ok: false, reason: "truncated tar header" };
    if (isZeroBlock(archive, off)) {
      for (let i = off; i < archive.length; i += 1) {
        if (archive[i] !== 0) return { ok: false, reason: "data after end of archive" };
      }
      ended = true;
      break;
    }
    const h = archive.subarray(off, off + BLOCK);
    const stored = octal(h, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
    if (stored === null || stored !== sum) return { ok: false, reason: "tar header checksum mismatch" };

    const size = octal(h, 124, 12);
    if (size === null) return { ok: false, reason: "unsupported tar size encoding" };
    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156] as number);
    const dataStart = off + BLOCK;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (dataStart + padded > archive.length) return { ok: false, reason: "truncated tar entry" };
    const data = archive.subarray(dataStart, dataStart + size);
    off = dataStart + padded;

    if (type === "g") {
      if (sawGlobal || size > MAX_PAX_BYTES) return { ok: false, reason: "unexpected pax global header" };
      sawGlobal = true;
      const m = /(?:^|\n)\d+ comment=([0-9a-f]{40})\n/.exec(Buffer.from(data).toString("latin1"));
      if (m !== null) archiveCommit = m[1] as string;
      continue;
    }
    if (type !== "0" && type !== "5") {
      return { ok: false, reason: `unsupported tar entry type (${type === "2" || type === "1" ? "link" : "other"})` };
    }

    const name = cstr(h, 0, 100);
    const prefix = cstr(h, 345, 155);
    let path = prefix === "" ? name : `${prefix}/${name}`;
    const dir = type === "5";
    if (dir) {
      if (size !== 0) return { ok: false, reason: "directory entry with content" };
      if (path.endsWith("/")) path = path.slice(0, -1);
    }
    const bad = unsafePathReason(path);
    if (bad !== null) return { ok: false, reason: `unsafe path in archive: ${bad}` };
    const mode = octal(h, 100, 8);
    if (mode === null) return { ok: false, reason: "invalid tar mode" };

    if (!dir) {
      files += 1;
      totalBytes += size;
      if (files > limits.maxFiles) return { ok: false, reason: "archive has too many files" };
      if (totalBytes > limits.maxTotalBytes) return { ok: false, reason: "archive content exceeds the size limit" };
    }
    entries.push({ path, dir, exec: !dir && (mode & 0o111) !== 0, data });
  }
  if (!ended && off !== archive.length) return { ok: false, reason: "malformed archive" };
  if (entries.length === 0) return { ok: false, reason: "archive contains no entries" };

  // Path-structure validation, before anything is written.
  const kinds = new Map<string, "file" | "dir">();
  const note = (path: string, kind: "file" | "dir", explicit: boolean): string | null => {
    const key = path.toLowerCase();
    const prev = kinds.get(key);
    if (prev === undefined) {
      kinds.set(key, kind);
      return null;
    }
    if (prev === "dir" && kind === "dir") return explicit && dirExplicit.has(key) ? "duplicate path" : null;
    return "duplicate or conflicting path";
  };
  const dirExplicit = new Set<string>();
  for (const e of entries) {
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const r = note(parts.slice(0, i).join("/"), "dir", false);
      if (r !== null) return { ok: false, reason: r };
    }
    const r = note(e.path, e.dir ? "dir" : "file", true);
    if (r !== null) return { ok: false, reason: r };
    if (e.dir) dirExplicit.add(e.path.toLowerCase());
  }

  // Write phase. Parents come first; entries were validated above.
  const made = new Set<string>();
  const mk = (p: string): void => {
    if (made.has(p)) return;
    made.add(p);
    sink.mkdir(p);
  };
  let directories = 0;
  for (const e of entries) {
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i += 1) mk(parts.slice(0, i).join("/"));
    if (e.dir) mk(e.path);
    else sink.writeFile(e.path, e.data, e.exec);
  }
  directories = made.size;
  return { ok: true, value: { files, directories, totalBytes, archiveCommit } };
}
