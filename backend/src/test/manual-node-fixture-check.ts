/**
 * manual-node-fixture-check.ts — OPT-IN real Docker harness for the controlled Node fixture
 * build/test runner. NOT production wiring and NOT yet run by its author: every behaviour below is
 * UNVERIFIED until an operator runs it and logs the output in .kiro/PROJECT.md and
 * backend/DEVELOPMENT.md.
 *
 * Skipped unless GRAVEYARD_MANUAL_NODE_FIXTURE=1, so `pnpm test` never touches Docker.
 *
 * What it does (no network, no npm, no dependency install, no GitHub, no user job):
 *  1. Fails closed unless the Docker daemon answers and the image node:22-alpine already exists
 *     locally (it is never pulled).
 *  2. Locates the backend package root from this file's compiled location (must contain a
 *     package.json named "graveyard-backend"), creates backend/.tmp-fixtures/run-<12 hex>
 *     (gitignored), and writes four generated fixtures into it with exclusive-create:
 *       pass        build ok, 2 tests pass          expect build passed, test passed, run passed
 *       fail-test   build ok, 1 test fails          expect build passed, test failed, run failed
 *       fail-build  build throws                    expect build failed, test not-run, run failed
 *       no-tests    build ok, no tests              expect build passed, test not-run, run not-run
 *  3. Runs NodeFixtureRunner.verify for each (network none, non-root, read-only fixture mount,
 *     bounded /tmp, limits, per-stage cleanup proof) and compares with the expectation above.
 *  4. Requires every stage that created a container to report confirmed cleanup, then
 *     independently queries `docker ps -a` for any container left from this run.
 *  5. Removes the generated directory with removeRunDir (validated path, lstat walk, no recursive
 *     delete). A removal problem is reported and fails the test.
 *
 * A pass shows only that these four generated fixtures behaved as expected on this machine and
 * Docker version. It says nothing about arbitrary repositories.
 *
 * Possible fail-closed causes to expect on first run: Docker Desktop reporting the bind-mount
 * Source in a form that differs from the host path (isolation-violation), `node --test` TAP
 * output differing from the modelled format (not-run / test-summary-unparseable), and Docker file
 * sharing not covering backend/.tmp-fixtures.
 *
 * Run (outside the restricted sandbox):
 *   pnpm run build:test
 *   $env:GRAVEYARD_MANUAL_NODE_FIXTURE = "1"
 *   node --test dist-test/test/manual-node-fixture-check.js
 */

import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnExecutor } from "../docker-sandbox.js";
import { createRunDir, ensureOwnedParent, removeRunDir, writeFixture } from "../fixture-workspace.js";
import { FIXTURE_KINDS, fixtureFiles, type FixtureKind } from "../node-fixture-files.js";
import { NODE_FIXTURE_IMAGE, NodeFixtureRunner, type StageResult, type StageStatus } from "../node-fixture-runner.js";

const OPT_IN = process.env["GRAVEYARD_MANUAL_NODE_FIXTURE"] === "1";

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
  const o = s.buildOutput === null ? "" : ` output=${JSON.stringify(s.buildOutput)}`;
  const cl = s.cleanup === null ? "none" : s.cleanup.confirmed ? "confirmed" : `UNCONFIRMED(${s.cleanup.reason})`;
  return `${s.stage}: ${s.status} (${s.reason}) exit=${String(s.exitCode)} truncated=${String(s.truncated)} cleanup=${cl}${c}${o}`;
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
  "manual node fixture build/test harness (opt-in: GRAVEYARD_MANUAL_NODE_FIXTURE=1)",
  { skip: OPT_IN ? false : "set GRAVEYARD_MANUAL_NODE_FIXTURE=1 to run against real Docker", timeout: 600_000 },
  async () => {
    const runId = randomBytes(5).toString("hex");
    const log: string[] = [];
    const problems: string[] = [];
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
      for (const kind of FIXTURE_KINDS) writeFixture(runDir, kind, fixtureFiles(kind));
      log.push(`generated fixtures under ${runDir}`);

      const runner = new NodeFixtureRunner({ executor: spawnExecutor, fixturesRoot: runDir });
      for (const kind of FIXTURE_KINDS) {
        const r = await runner.verify({ idPrefix: `nodefix-${runId}-${kind}`, fixture: kind });
        log.push(`[${kind}] run=${r.status}`, `  ${describeStage(r.build)}`, `  ${describeStage(r.test)}`);
        const want = EXPECTED[kind];
        if (r.build.status !== want.build) problems.push(`${kind}: build ${r.build.status}, expected ${want.build}`);
        if (r.test.status !== want.test) problems.push(`${kind}: test ${r.test.status}, expected ${want.test}`);
        if (r.status !== want.run) problems.push(`${kind}: run ${r.status}, expected ${want.run}`);
        for (const s of [r.build, r.test]) {
          if (s.cleanup !== null && !s.cleanup.confirmed) problems.push(`${kind}/${s.stage}: cleanup not confirmed`);
        }
        if (kind === "pass" && (r.test.counts?.pass ?? 0) < 2) problems.push("pass: expected at least 2 passing tests");
        if (kind === "fail-test" && (r.test.counts?.fail ?? 0) < 1) problems.push("fail-test: expected at least 1 failing test");
        if (kind === "fail-build" && !/intentional build failure/.test(r.build.stderrTail)) {
          problems.push("fail-build: stderr did not show the intentional failure");
        }
      }

      const left = await dockerQuery(["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=graveyard-nodefix-${runId}`]);
      if (!left.ok) problems.push("could not query leftover containers");
      else if (left.stdout.trim() !== "") problems.push(`containers left from this run: ${left.stdout.trim()}`);
      else log.push("independent docker ps: no containers left from this run");
    } catch (e) {
      failure = e;
    } finally {
      if (runDir !== undefined && parent !== undefined) {
        const r = removeRunDir(parent, runDir);
        if (r.removed) log.push("generated fixture directory removed");
        else problems.push(...r.problems.map((p) => `removal: ${p}`));
      }
      for (const l of log) console.log(`INFO  ${l}`);
      if (problems.length > 0) console.log(`PROBLEMS:\n${problems.join("\n")}`);
      if (failure instanceof FailClosed) {
        console.log(`FAIL-CLOSED: ${failure.message}\nNo claim is made about the runner or Docker behaviour.`);
      }
    }
    if (failure !== undefined) throw failure;
    if (problems.length > 0) throw new Error(`node fixture harness found ${problems.length} problem(s)`);
  },
);
