/**
 * npm-scripts-snapshot.ts — bounded source snapshot for the opt-in npm-scripts mode. Exports the
 * checked-out PINNED commit from the guarded git acquisition container as a `git archive` tar and
 * hands it to the host through the existing safe archive path (tar-extract.ts and
 * archive-handoff.ts). Written without a shell or a test run (UNVERIFIED until the operator runs the
 * suite and the real-Docker harness; see backend/DEVELOPMENT.md).
 *
 * Why a snapshot at all. The root-files-only read (github-source.ts) is enough for a root build.mjs,
 * but `npm run build` and `npm run test` normally execute files elsewhere in the repository. The
 * snapshot is the smallest widening of what the host receives: a bounded, validated, regular-file
 * tree that is then mounted READ-ONLY into the network-`none` container. The host never executes,
 * imports or interprets any of it.
 *
 * Bounds (SNAPSHOT_LIMITS). At most 100 files, 1 MiB of content, 160 entries (files plus
 * directories) and 5 directory levels. The depth and entry bounds are chosen so the run directory can
 * still be removed by fixture-workspace.removeRunDir (its own bounds are depth 6 and 500 entries,
 * counted from the run directory). A repository above any bound is "refused", which the runner
 * reports as an unsupported repository. Nothing is truncated.
 *
 * Checks, in order, each failing closed:
 *   1. the tree manifest the git container already produced (file count, bytes, no submodules) is
 *      compared with the bounds BEFORE any export is started;
 *   2. `docker exec <container> git archive --format=tar <commit>` (argument array, no shell, the
 *      40-hex commit re-validated), binary output with a hard cap; a transport failure THROWS, which
 *      fails the acquisition and therefore the job as infrastructure;
 *   3. the whole tar is validated with a recording sink (no links, no unsafe paths, bounded; nothing
 *      written), then scanned for names this mode refuses: a root `.npmrc` (project npm
 *      configuration), a root `npm-shrinkwrap.json` (it would override the lockfile), any
 *      `node_modules` directory, the two reserved driver names, too deep or too many entries, and a
 *      missing root package.json or package-lock.json;
 *   4. extractArchiveIntoFixture creates a NEW `<runDir>/src-<12 hex>` directory (exclusive create,
 *      lstat audit) and requires the archive commit comment, file count and byte total to equal the
 *      git container's own manifest. `.gitattributes` export-ignore or export-subst therefore fails
 *      this comparison and the repository is refused;
 *   5. the extracted package.json and package-lock.json must be byte-identical to the blobs that were
 *      analysed (read through `git cat-file`), so the manifest that was policy-checked is the one that
 *      runs.
 * A refusal is returned (`kind: "refused"`); the caller removes the run directory.
 *
 * @module npm-scripts-snapshot
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACQ_UID_GID, GIT_SHA_RE, WORK_DIR, sanitize, type Validated } from "./acquisition-policy.js";
import { extractArchiveIntoFixture } from "./archive-handoff.js";
import type { HandoffInfo } from "./git-acquisition.js";
import { SCRIPTS_DRIVER_NAME, SCRIPTS_INSTALL_MANIFEST_NAME } from "./npm-scripts-driver.js";
import { extractTar, type ExtractSink } from "./tar-extract.js";

export const SNAPSHOT_LIMITS = Object.freeze({
  maxFiles: 100,
  maxTotalBytes: 1024 * 1024,
  /** Files plus directories. */
  maxEntries: 160,
  /** Directory levels below the snapshot root (a file at `a/b/c.js` is at level 2). */
  maxDirDepth: 5,
});

/** Names the host writes into the snapshot directory; a repository containing them is refused. */
export const SNAPSHOT_DRIVER_NAME = SCRIPTS_DRIVER_NAME;
export const SNAPSHOT_INSTALL_MANIFEST_NAME = SCRIPTS_INSTALL_MANIFEST_NAME;
const RESERVED_ROOT_NAMES: readonly string[] = [SNAPSHOT_DRIVER_NAME, SNAPSHOT_INSTALL_MANIFEST_NAME, ".npmrc", "npm-shrinkwrap.json"];

const EXPORT_TIMEOUT_MS = 60_000;
const MIN_REMAINING_MS = 5_000;

// ---------------------------------------------------------------------------
// Binary-safe executor (injectable)
// ---------------------------------------------------------------------------

export interface BytesOptions {
  timeoutMs: number;
  /** Hard cap on stdout. Exceeding it kills the client and sets `truncated`. */
  maxBytes: number;
  signal?: AbortSignal;
}

export interface BytesResult {
  exitCode: number | null;
  stdout: Buffer;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
}

/** Rejects only when the process cannot be started. */
export type BytesExecutor = (file: string, args: readonly string[], options: BytesOptions) => Promise<BytesResult>;

const ENV_ALLOWLIST = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "HOME", "USERPROFILE", "XDG_RUNTIME_DIR"];

/** Real executor: spawn with shell:false, stdin closed, minimal environment, capped stdout. Not exercised by unit tests. */
export const spawnBytesExecutor: BytesExecutor = (file, args, options) =>
  new Promise<BytesResult>((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ENV_ALLOWLIST) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    const child = spawn(file, [...args], { shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const kill = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    child.stdout?.on("data", (c: Buffer) => {
      if (truncated) return;
      if (size + c.length > options.maxBytes) {
        truncated = true;
        kill();
        return;
      }
      chunks.push(c);
      size += c.length;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const done = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      done();
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      done();
      resolvePromise({ exitCode: code, stdout: Buffer.concat(chunks), timedOut, aborted, truncated });
    });
  });

// ---------------------------------------------------------------------------
// Archive scan (pure)
// ---------------------------------------------------------------------------

export interface SnapshotScan {
  files: number;
  directories: number;
  totalBytes: number;
  entries: number;
  maxDirDepth: number;
  archiveCommit: string | null;
}

export function snapshotArchiveCap(manifest: { files: number; totalBytes: number }): number {
  // 512-byte header plus up to 511 bytes of padding per file, one header per directory (at most one
  // per file), the pax global header and the end-of-archive blocks.
  return manifest.totalBytes + manifest.files * 1536 + 8 * 1024;
}

/**
 * Validates the whole tar (nothing is written) and applies this mode's name and shape rules.
 * Reasons are fixed texts and never echo repository-controlled names.
 */
export function scanSnapshotArchive(archive: Uint8Array, maxArchiveBytes: number): Validated<SnapshotScan> {
  const dirs = new Set<string>();
  const files: string[] = [];
  const sink: ExtractSink = {
    mkdir: (rel) => {
      dirs.add(rel);
    },
    writeFile: (rel) => {
      files.push(rel);
    },
  };
  const r = extractTar(
    archive,
    { maxArchiveBytes, maxFiles: SNAPSHOT_LIMITS.maxFiles, maxTotalBytes: SNAPSHOT_LIMITS.maxTotalBytes },
    sink,
  );
  if (!r.ok) return { ok: false, reason: `archive refused: ${r.reason}` };

  let maxDirDepth = 0;
  for (const d of dirs) maxDirDepth = Math.max(maxDirDepth, d.split("/").length);
  for (const f of files) maxDirDepth = Math.max(maxDirDepth, f.split("/").length - 1);
  const entries = files.length + dirs.size;
  if (maxDirDepth > SNAPSHOT_LIMITS.maxDirDepth) return { ok: false, reason: `the tree is deeper than ${SNAPSHOT_LIMITS.maxDirDepth} directory levels` };
  if (entries > SNAPSHOT_LIMITS.maxEntries) return { ok: false, reason: `the tree has more than ${SNAPSHOT_LIMITS.maxEntries} entries` };

  for (const p of [...files, ...dirs]) {
    const segs = p.split("/");
    if (segs.some((s) => s.toLowerCase() === "node_modules")) return { ok: false, reason: "the tree contains a node_modules directory" };
    if (segs.length === 1 && RESERVED_ROOT_NAMES.includes(segs[0]?.toLowerCase() ?? "")) {
      return { ok: false, reason: "the tree contains a root file this mode reserves or refuses (.npmrc, npm-shrinkwrap.json or a driver name)" };
    }
  }
  if (!files.includes("package.json") || !files.includes("package-lock.json")) {
    return { ok: false, reason: "the tree has no root package.json or package-lock.json" };
  }
  return {
    ok: true,
    value: {
      files: files.length,
      directories: dirs.size,
      totalBytes: r.value.totalBytes,
      entries,
      maxDirDepth,
      archiveCommit: r.value.archiveCommit,
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type SnapshotOutcome =
  | {
      kind: "extracted";
      /** Directory name under the run directory (`src-<12 hex>`). */
      name: string;
      dir: string;
      files: number;
      directories: number;
      totalBytes: number;
      /** sha256 of the exact tar bytes the host received. */
      archiveSha256: string;
    }
  /** The repository is outside this mode's bounds or shape. Not an infrastructure failure. */
  | { kind: "refused"; reason: string };

/**
 * Exports the checked-out commit and extracts it into a NEW directory of `runDir`. THROWS on a
 * transport problem (docker failed, timed out, was aborted, output over the cap), so the acquisition
 * fails closed as infrastructure. Policy refusals are returned, never thrown.
 */
export async function exportSnapshot(
  exec: BytesExecutor,
  info: HandoffInfo,
  runDir: string,
  expect: { packageJson: string; packageLock: string },
  newSuffix: () => string = () => randomBytes(6).toString("hex"),
): Promise<SnapshotOutcome> {
  if (!GIT_SHA_RE.test(info.commit)) throw new Error("the commit is not a full lowercase SHA");
  const m = info.manifest;
  if (m.submodulesSkipped !== 0) return { kind: "refused", reason: "the repository has submodules" };
  if (m.files > SNAPSHOT_LIMITS.maxFiles) return { kind: "refused", reason: `the tree has more than ${SNAPSHOT_LIMITS.maxFiles} files` };
  if (m.totalBytes > SNAPSHOT_LIMITS.maxTotalBytes) {
    return { kind: "refused", reason: `the tree is larger than ${SNAPSHOT_LIMITS.maxTotalBytes} bytes` };
  }
  if (info.signal?.aborted === true) throw new Error("aborted");
  if (info.remainingMs < MIN_REMAINING_MS) throw new Error("no time left for the source export");

  const cap = snapshotArchiveCap(m);
  const r = await exec(
    info.dockerBinary,
    ["exec", "--user", ACQ_UID_GID, "--workdir", WORK_DIR, info.containerName, "git", "archive", "--format=tar", info.commit],
    {
      timeoutMs: Math.min(EXPORT_TIMEOUT_MS, info.remainingMs),
      maxBytes: cap,
      ...(info.signal === undefined ? {} : { signal: info.signal }),
    },
  );
  if (r.timedOut || r.aborted) throw new Error("the source export timed out or was aborted");
  if (r.truncated) throw new Error("the source export is larger than its cap");
  if (r.exitCode !== 0) throw new Error("the source export failed");

  const scan = scanSnapshotArchive(r.stdout, cap);
  if (!scan.ok) return { kind: "refused", reason: sanitize(scan.reason, 200) };

  const name = `src-${newSuffix()}`;
  const h = extractArchiveIntoFixture(
    r.stdout,
    runDir,
    name,
    { maxArchiveBytes: cap, maxFiles: SNAPSHOT_LIMITS.maxFiles, maxTotalBytes: SNAPSHOT_LIMITS.maxTotalBytes },
    { commit: info.commit, files: m.files, totalBytes: m.totalBytes },
  );
  if (!h.ok) return { kind: "refused", reason: sanitize(h.reason, 200) };

  try {
    const pj = readFileSync(join(h.dir, "package.json"));
    const lk = readFileSync(join(h.dir, "package-lock.json"));
    if (!pj.equals(Buffer.from(expect.packageJson, "utf8")) || !lk.equals(Buffer.from(expect.packageLock, "utf8"))) {
      return { kind: "refused", reason: "the archived package.json or package-lock.json differs from the blob that was analysed" };
    }
  } catch {
    return { kind: "refused", reason: "the extracted package files could not be read back" };
  }
  return {
    kind: "extracted",
    name,
    dir: h.dir,
    files: h.summary.files,
    directories: h.summary.directories,
    totalBytes: h.summary.totalBytes,
    archiveSha256: createHash("sha256").update(r.stdout).digest("hex"),
  };
}
