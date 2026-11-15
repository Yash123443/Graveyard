/**
 * github-source.ts — reads the four root files of the acquired commit INSIDE the acquisition
 * container, as the afterCheckout hook of GitAcquisition. Written without a shell; later compiled
 * and unit-tested (fake executor) in an external run. Not yet run against real Docker or GitHub.
 *
 * Why not export the tree: the host never receives the repository. It receives at most four small
 * text files, read as raw git blobs (`git cat-file blob`, which applies no checkout filters):
 *   1. `git ls-tree -z <commit> -- <fixed names>` lists which of the names exist at the root, with
 *      their mode and blob id (the names are constants; nothing from the repository is used in an
 *      argument except the 40-hex blob ids that git itself printed and this module re-validates);
 *   2. `git cat-file blob <id>` for each regular file (mode 100644 or 100755), output capped at
 *      MAX_ROOT_FILE_BYTES + 1 so an oversize file is detected, not truncated and trusted.
 * Entries that are not regular files (a directory or submodule named package.json) and oversize
 * files are reported as `unusable`; they are never read. All commands are `docker exec` argument
 * arrays through the injected executor (no shell). A failed or timed-out git command throws, which
 * fails the acquisition closed.
 *
 * @module github-source
 */

import { ACQ_UID_GID, WORK_DIR } from "./acquisition-policy.js";
import type { ProcessExecutor, ProcessResult } from "./docker-sandbox.js";
import type { HandoffInfo } from "./git-acquisition.js";
import { MAX_ROOT_FILE_BYTES, ROOT_FILE_NAMES, type RootFiles } from "./github-analysis.js";

const STEP_TIMEOUT_MS = 30_000;
const LISTING_CAP_BYTES = 8 * 1024;
const REGULAR_MODES: readonly string[] = ["100644", "100755"];
const TREE_RECORD_RE = /^([0-7]{6}) ([a-z]{4,6}) ([0-9a-f]{40})\t(package\.json|package-lock\.json|build\.mjs|test\.mjs)$/;

export async function readRootFiles(executor: ProcessExecutor, info: HandoffInfo): Promise<RootFiles> {
  const run = async (gitArgs: readonly string[], cap: number): Promise<ProcessResult> => {
    if (info.signal?.aborted === true) throw new Error("aborted");
    if (info.remainingMs < 1_000) throw new Error("no time left for reading the root files");
    const r = await executor(
      info.dockerBinary,
      ["exec", "--user", ACQ_UID_GID, "--workdir", WORK_DIR, info.containerName, "git", ...gitArgs],
      {
        timeoutMs: Math.min(STEP_TIMEOUT_MS, info.remainingMs),
        maxOutputBytes: cap,
        ...(info.signal === undefined ? {} : { signal: info.signal }),
      },
    );
    if (r.timedOut || r.aborted) throw new Error("a git read timed out or was aborted");
    if (r.exitCode !== 0) throw new Error("a git read failed");
    return r;
  };

  const listing = await run(["ls-tree", "-z", info.commit, "--", ...ROOT_FILE_NAMES], LISTING_CAP_BYTES);
  if (listing.truncated) throw new Error("root listing is larger than expected");

  const blobs = new Map<string, string>();
  const unusable: string[] = [];
  for (const record of listing.stdout.split("\0")) {
    if (record === "") continue;
    const m = TREE_RECORD_RE.exec(record);
    if (m === null) throw new Error("unexpected root tree entry");
    const mode = m[1] as string;
    const id = m[3] as string;
    const name = m[4] as string;
    if (!REGULAR_MODES.includes(mode) || m[2] !== "blob") unusable.push(name);
    else blobs.set(name, id);
  }

  const text = new Map<string, string>();
  for (const [name, id] of blobs) {
    const r = await run(["cat-file", "blob", id], MAX_ROOT_FILE_BYTES + 1);
    if (r.truncated || Buffer.byteLength(r.stdout, "utf8") > MAX_ROOT_FILE_BYTES) {
      unusable.push(name);
      continue;
    }
    text.set(name, r.stdout);
  }

  return {
    packageJson: text.get("package.json") ?? null,
    packageLock: text.get("package-lock.json") ?? null,
    buildMjs: text.get("build.mjs") ?? null,
    testMjs: text.get("test.mjs") ?? null,
    unusable: unusable.sort(),
  };
}
