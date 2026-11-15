/**
 * manual-archive-build-check.ts — OPT-IN combined harness: validated archive handoff ->
 * NodeFixtureRunner build + tests, against real Docker. NOT production wiring and NOT yet run by
 * its author: every behaviour below is UNVERIFIED until an operator runs it and logs the output
 * in .kiro/PROJECT.md and backend/DEVELOPMENT.md.
 *
 * Skipped unless GRAVEYARD_MANUAL_ARCHIVE_BUILD=1, so `pnpm test` never touches Docker.
 *
 * NO NETWORK CLONE IS TESTED HERE. The archives are generated locally by buildGitArchiveTar from
 * the controlled fixtures in node-fixture-files.ts, in the layout of `git archive` (pax global
 * header with the commit, directory entries, regular files). They are NOT produced by git. The
 * real-clone handoff (manual-clone-check.ts) is a separate harness and is not exercised here.
 * No untrusted repository, no npm install, no dependency acquisition, no live job.
 *
 * What it does:
 *  1. Fails closed unless the Docker daemon answers and node:22-alpine exists locally (never pulled).
 *  2. Creates backend/.tmp-fixtures/run-<12 hex> (gitignored, validated path).
 *  3. For each fixture kind: builds the archive, extracts it with extractTar into a FRESH
 *     <runDir>/<kind> directory (exclusive create, confined sink), requires the archive commit,
 *     file count and byte total to match, and audits the tree with lstat.
 *  4. Runs NodeFixtureRunner.verify on that directory. The sandbox mounts it read-only at /fixture
 *     with network none and reads the container configuration back with `docker inspect` BEFORE
 *     start; a mismatch yields isolation-violation (not-run), which this harness reports as a
 *     problem. Expected: pass => passed/passed; fail-test => passed/failed; fail-build =>
 *     failed/not-run; no-tests => passed/not-run.
 *  5. Negative case: a tampered archive (wrong commit comment) must be refused at handoff and no
 *     container may be created for it.
 *  6. Requires confirmed cleanup for every stage, then independently queries `docker ps -a` by the
 *     exact execution-id label of each stage run (and the refused one) for leftovers.
 *  7. Removes the run directory with removeRunDir (exact path, lstat walk, no recursive delete).
 *
 * A pass shows only that these generated archives behaved as expected on this machine. It says
 * nothing about real git output, network clones or arbitrary repositories.
 *
 * Run (outside the restricted sandbox):
 *   pnpm run build:test
 *   $env:GRAVEYARD_MANUAL_ARCHIVE_BUILD = "1"
 *   node --test dist-test/test/manual-archive-build-check.js
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAcquisitionLimits } from "../acquisition-policy.js";
import { buildGitArchiveTar, extractArchiveIntoFixture } from "../archive-handoff.js";
import { spawnExecutor } from "../docker-sandbox.js";
import { createRunDir, ensureOwnedParent, removeRunDir } from "../fixture-workspace.js";
import { FIXTURE_KINDS, fixtureFiles, type FixtureKind } from "../node-fixture-files.js";
import { NODE_FIXTURE_IMAGE, NodeFixtureRunner, type StageResult, type StageStatus } from "../node-fixture-runner.js";

const OPT_IN = process.env["GRAVEYARD_MANUAL_ARCHIVE_BUILD"] === "1";
const SHA = "0123456789abcdef0123456789abcdef01234567";

class FailClosed extends Error {}

interface Expectation { build: StageStatus; test: StageStatus; run: StageStatus }
const EXPECTED: Readonly<Record<FixtureKind, Expectation>> = {
  "pass": { build: "passed", test: "passed", run: "passed" },
  "fail-test": { build: "passed", test: "failed", run: "failed" },
  "fail-build": { build: "failed", test: "not-run", run: "failed" },
  "no-tests": { build: "passed", test: "not-run", run: "not-run" },
};

function describeStage(s: StageResult): string {
  const c = s.counts === null ? "" : ` counts=${JSON.stringify(s.counts)}`;
  const cl = s.cleanup === null ? "none" : s.cleanup.confirmed ? "confirmed" : `UNCONFIRMED(${s.cleanup.reason})`;
  return `${s.stage}: ${s.status} (${s.reason}) exit=${String(s.exitCode)} truncated=${String(s.truncated)} cleanup=${cl}${c}`;
}

async function dockerQuery(args: readonly string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const r = await spawnExecutor("docker", args, { timeoutMs: 20_000, maxOutputBytes: 64 * 1024 });
    return { ok: r.exitCode === 0 && !r.timedOut && !r.truncated, stdout: r.stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function backendRoot(): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown }).name;
  } catch {
    throw new FailClosed(`cannot read package.json at the expected backend root ${root}`);
  }
  if (name !== "graveyard-backend") throw new FailClosed(`${root} is not the graveyard-backend package`);
  return realpathSync(root);
}

test(
  "manual archive handoff -> node fixture build/test (opt-in: GRAVEYARD_MANUAL_ARCHIVE_BUILD=1)",
  { skip: OPT_IN ? false : "set GRAVEYARD_MANUAL_ARCHIVE_BUILD=1 to run against real Docker", timeout: 600_000 },
  async () => {
    const runId = randomBytes(5).toString("hex");
    const log: string[] = [];
    const problems: string[] = [];
    const executionIds: string[] = [];
    let parent: string | undefined;
    let runDir: string | undefined;
    let failure: unknown;

    try {
      const v = await dockerQuery(["version", "--format", "{{.Server.Version}}"]);
      if (!v.ok || v.stdout.trim() === "") throw new FailClosed("docker daemon is not available");
      log.push(`docker server ${v.stdout.trim()}`);
      const img = await dockerQuery(["image", "inspect", "--format", "{{.Id}}", NODE_FIXTURE_IMAGE]);
      if (!img.ok) throw new FailClosed(`image ${NODE_FIXTURE_IMAGE} must already exist locally (never pulled)`);

      parent = ensureOwnedParent(backendRoot());
      runDir = createRunDir(parent);
      log.push(`run directory ${runDir}`);
      const limits = checkAcquisitionLimits();
      const extractLimits = { maxArchiveBytes: 1024 * 1024, maxFiles: limits.maxFiles, maxTotalBytes: limits.maxTotalBytes };
      const runner = new NodeFixtureRunner({ executor: spawnExecutor, fixturesRoot: runDir });

      for (const kind of FIXTURE_KINDS) {
        const files = fixtureFiles(kind);
        const manifestBytes = Object.values(files).reduce((n, c) => n + Buffer.byteLength(c), 0);
        const h = extractArchiveIntoFixture(buildGitArchiveTar(files, SHA), runDir, kind, extractLimits, {
          commit: SHA, files: Object.keys(files).length, totalBytes: manifestBytes,
        });
        if (!h.ok) { problems.push(`${kind}: handoff refused: ${h.reason}`); continue; }
        log.push(`[${kind}] handoff ok: ${h.summary.files} files, ${h.summary.totalBytes} bytes, commit ${String(h.summary.archiveCommit)}`);

        const idPrefix = `archfix-${runId}-${kind}`;
        executionIds.push(`${idPrefix}:1`, `${idPrefix}:2`);
        const r = await runner.verify({ idPrefix, fixture: kind });
        log.push(`[${kind}] run=${r.status}`, `  ${describeStage(r.build)}`, `  ${describeStage(r.test)}`);
        const want = EXPECTED[kind];
        if (r.build.status !== want.build) problems.push(`${kind}: build ${r.build.status}, expected ${want.build}`);
        if (r.test.status !== want.test) problems.push(`${kind}: test ${r.test.status}, expected ${want.test}`);
        if (r.status !== want.run) problems.push(`${kind}: run ${r.status}, expected ${want.run}`);
        for (const s of [r.build, r.test]) {
          if (s.reason === "isolation-violation") problems.push(`${kind}/${s.stage}: isolation violation (${s.detail})`);
          if (s.cleanup !== null && !s.cleanup.confirmed) problems.push(`${kind}/${s.stage}: cleanup not confirmed`);
        }
        if (kind === "pass" && (r.test.counts?.pass ?? 0) < 2) problems.push("pass: expected at least 2 passing tests");
        if (kind === "fail-test" && (r.test.counts?.fail ?? 0) < 1) problems.push("fail-test: expected at least 1 failing test");
        if (kind === "fail-build" && !/intentional build failure/.test(r.build.stderrTail)) {
          problems.push("fail-build: stderr did not show the intentional failure");
        }
      }

      // Negative: tampered archive (commit comment differs) must be refused before any container.
      const tampered = extractArchiveIntoFixture(buildGitArchiveTar(fixtureFiles("pass"), "f".repeat(40)), runDir, "tampered", extractLimits, { commit: SHA });
      if (tampered.ok) problems.push("tampered archive was accepted");
      else log.push(`[tampered] refused at handoff: ${tampered.reason}`);
      if (existsSync(join(runDir, "tampered", "build.mjs"))) problems.push("tampered archive left files on disk");

      for (const id of executionIds) {
        const left = await dockerQuery(["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=graveyard.execution-id=${id}`]);
        if (!left.ok) problems.push(`could not query leftover containers for ${id}`);
        else if (left.stdout.trim() !== "") problems.push(`container left for ${id}: ${left.stdout.trim()}`);
      }
      const byName = await dockerQuery(["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=graveyard-archfix-${runId}`]);
      if (!byName.ok) problems.push("could not query leftover containers by name");
      else if (byName.stdout.trim() !== "") problems.push(`containers left from this run: ${byName.stdout.trim()}`);
      else log.push(`independent docker ps: no containers left for ${executionIds.length} execution ids or by name`);
    } catch (e) {
      failure = e;
    } finally {
      if (runDir !== undefined && parent !== undefined) {
        const r = removeRunDir(parent, runDir);
        if (r.removed) log.push(`removed ${runDir}`);
        else problems.push(...r.problems.map((p) => `removal: ${p}`));
      }
      for (const l of log) console.log(`INFO  ${l}`);
      console.log("NOTE  archives were generated locally (not by git); no network clone was tested");
      if (problems.length > 0) console.log(`PROBLEMS:\n${problems.join("\n")}`);
      if (failure instanceof FailClosed) {
        console.log(`FAIL-CLOSED: ${failure.message}\nNo claim is made about the runner or Docker behaviour.`);
      }
    }
    if (failure !== undefined) throw failure;
    if (problems.length > 0) throw new Error(`archive build harness found ${problems.length} problem(s)`);
  },
);
