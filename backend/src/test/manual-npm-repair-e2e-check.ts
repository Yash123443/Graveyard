/**
 * manual-npm-repair-e2e-check.ts — OPT-IN real Docker + real kiro-cli harness for the integrated
 * npm-scripts repair path of GithubJobRunner. NOT production wiring and NOT yet run by its author:
 * every behaviour below is UNVERIFIED until an operator runs it and logs the output in
 * .kiro/PROJECT.md and backend/DEVELOPMENT.md. The repair integration it checks is implemented
 * elsewhere; this file only drives the existing public GithubJobRunner interfaces.
 *
 * Skipped unless GRAVEYARD_MANUAL_NPM_REPAIR_E2E=1, so `pnpm test` never touches Docker or Kiro.
 *
 *   GRAVEYARD_NPM_FIXTURE_DIR  absolute path with package.json + package-lock.json whose lock holds
 *                              exactly is-number and is-buffer (registry form, sha512 integrity)
 *   GRAVEYARD_NPM_CACHE_DIR    absolute path of an npm cache prepopulated for exactly that lock
 *                              (mounted read-only by the real pipeline, never written)
 *   GRAVEYARD_WORKER_AGENTS    kiro-v2 (default, stdin path) or kiro-v3 (as configured by the operator)
 *
 * Real: NpmScriptsPipeline + spawnExecutor (network-none container), Docker cleanup proofs, the
 * KiroAgentAdapter (spawns kiro-cli; Kiro receives only the root build file `build.js`, the two declared
 * script commands and bounded, redacted stage evidence, not the four source files), presentResult.
 * Faked, and reported in the log: Git acquisition and the snapshot handoff (a temporary local
 * 4-file "pinned" source under .tmp-fixtures with a valid cleanup proof) and registry acquisition
 * (it only hands over the provided cache). No public repository is contacted, no registry is
 * contacted, nothing is cloned, git is never run, and the harness starts no shell.
 *
 * Controlled source: package.json (scripts build `node build.js`, test `node --test test.mjs`; the test
 * script must be exactly `node --test` or `node --test FILE` or no verification is possible),
 * package-lock.json (operator), build.js (inverted is-number guard, so the original build fails)
 * and test.mjs (checks the artifact build.js writes). A good repair changes only build.js.
 *
 * A pass shows only that this controlled fixture behaved as expected on this machine with this
 * Docker, image, cache and kiro-cli. It is not evidence about arbitrary repositories.
 *
 * Run (outside the restricted sandbox):
 *   pnpm run build:test
 *   $env:GRAVEYARD_MANUAL_NPM_REPAIR_E2E = "1"
 *   $env:GRAVEYARD_NPM_FIXTURE_DIR = "C:\path\to\fixture"
 *   $env:GRAVEYARD_NPM_CACHE_DIR = "C:\path\to\npm-cache"
 *   node --test dist-test/test/manual-npm-repair-e2e-check.js
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { test } from "node:test";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DockerFixtureSandbox, spawnExecutor } from "../docker-sandbox.js";
import { testCountsAcceptable } from "../build-entry.js";
import { createRunDir, ensureOwnedParent, removeRunDir, writeFixture } from "../fixture-workspace.js";
import { KiroAgentAdapter, spawnAgentProcess } from "../kiro-agent.js";
import { NODE_FIXTURE_IMAGE } from "../node-fixture-runner.js";
import { GithubJobRunner, type GitLike, type RegistryLike } from "../github-runner.js";
import { NpmScriptsPipeline, SCRIPTS_ARGV, SCRIPTS_COMMAND_ID } from "../npm-scripts-pipeline.js";
import type { SnapshotOutcome } from "../npm-scripts-snapshot.js";
import type { RegistryAcquisitionRequest, RegistryAcquisitionResult } from "../npm-registry-acquisition.js";
import type { HandoffInfo } from "../git-acquisition.js";
import type { JobResultRecord } from "../jobs.js";
import type { RootFiles } from "../github-analysis.js";
import { presentResult } from "../result-view.js";
import type { CleanupProof, JobProgress, JobRunner, RunContext, RunOutcome } from "../runner.js";

const OPT_IN = process.env["GRAVEYARD_MANUAL_NPM_REPAIR_E2E"] === "1";
const MAX_FILE = 64 * 1024;
const DEADLINE_MS = 8 * 60_000;
const REPO_URL = "https://github.com/graveyard-local/npm-repair-fixture";
const SOURCE_FILES = ["package.json", "package-lock.json", "build.js", "test.mjs"] as const;

class FailClosed extends Error {}

const BUILD_JS = [
  'const { writeFileSync } = require("node:fs");',
  'const { join } = require("node:path");',
  'const isNumber = require("is-number");',
  'const isBuffer = require("is-buffer");',
  "",
  "// BUG: the guard is inverted, so this throws for a value is-number accepts.",
  "if (isNumber(42)) {",
  '  throw new Error("is-number rejected 42");',
  "}",
  'writeFileSync(join(process.cwd(), "out.txt"), `built:${String(isBuffer(Buffer.from("x")))}\\n`);',
  "",
].join("\n");

const TEST_MJS = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { readFileSync } from "node:fs";',
  'import { join } from "node:path";',
  "",
  'test("build wrote its artifact", () => {',
  '  assert.equal(readFileSync(join(process.cwd(), "out.txt"), "utf8"), "built:true\\n");',
  "});",
  "",
].join("\n");

const sha256 = (v: string | Buffer): string => createHash("sha256").update(v).digest("hex");
const okProof = (executionId: string, evidence: string): CleanupProof => ({ confirmed: true, executionId, evidence });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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

function requireAbsoluteDir(envName: string): string {
  const v = process.env[envName];
  if (v === undefined || v === "") throw new FailClosed(`${envName} is not set; the harness needs an operator-supplied controlled input`);
  if (!isAbsolute(v)) throw new FailClosed(`${envName} must be an absolute path`);
  let real: string;
  try {
    real = realpathSync(v);
    if (!lstatSync(real).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new FailClosed(`${envName} does not point to an existing directory`);
  }
  return real;
}

function readOperatorFile(dir: string, name: string): string {
  const p = join(dir, name);
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > MAX_FILE) throw new Error("bad file");
    return readFileSync(p, "utf8");
  } catch {
    throw new FailClosed(`${name} must be a regular file of at most ${MAX_FILE} bytes in the operator fixture directory`);
  }
}

/** Path -> "size:mtime" for every entry below `root` (lstat; never follows links). */
function treeState(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p);
      out[p] = `${st.isDirectory() ? "d" : "f"}:${st.size}:${st.mtimeMs}`;
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

const fileHashes = (dir: string, names: readonly string[]): Record<string, string> =>
  Object.fromEntries(names.map((n) => [n, sha256(readFileSync(join(dir, n)))]));

/** Paths named by the `---` / `+++` headers of a unified diff. */
function diffTargets(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    const m = /^(?:---|\+\+\+) (?:a|b)\/(.+)$/.exec(line);
    if (m !== null) out.push(m[1] as string);
    else if (/^(?:---|\+\+\+) /.test(line)) out.push(line.slice(4));
  }
  return out;
}

const SAFE_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DIAG_KEYS = ["status", "code", "outcome", "failedStage", "reason"] as const;

/** A fixed-vocabulary token or "?" (never free text, so no source, diff, output or credential can leak). */
const safeToken = (v: unknown): string => (typeof v === "string" && SAFE_CODE.test(v) ? v : "?");

/** Whitelisted short codes and statuses of one record section; anything else is omitted. */
function sectionDiag(name: string, section: unknown): string {
  if (!isObj(section)) return `${name}=absent`;
  const parts = DIAG_KEYS.filter((k) => k in section).map((k) => `${k}:${safeToken(section[k])}`);
  return `${name}={${parts.join(",")}}`;
}

/**
 * One line from the recorded analyst, fixer and verification fields. Only keys in DIAG_KEYS whose value
 * is a short lowercase code, and small non-negative integer TAP counts, are printed. No diff, evidence,
 * diagnosis text, reason text or command output is ever included.
 */
function diagnostics(result: Record<string, unknown>): string {
  const parts: string[] = [];
  parts.push(sectionDiag("pipeline", result["pipeline"]));
  parts.push(sectionDiag("analyst", result["analyst"]));
  parts.push(sectionDiag("fixer", result["fixer"]));
  const ver = result["verification"];
  parts.push(sectionDiag("verification", ver));
  if (isObj(ver)) {
    parts.push(sectionDiag("verification.patched", ver["patched"]));
    parts.push(sectionDiag("verification.tester", ver["tester"]));
    const c = ver["testCounts"];
    if (isObj(c)) {
      const counts = ["tests", "pass", "fail", "cancelled", "skipped", "todo"]
        .map((k) => `${k}:${typeof c[k] === "number" && Number.isInteger(c[k]) && (c[k] as number) >= 0 && (c[k] as number) < 1_000_000 ? String(c[k]) : "?"}`);
      parts.push(`testCounts={${counts.join(",")}}`);
    } else parts.push("testCounts=absent");
  }
  return parts.join(" ");
}

test(
  "manual npm-scripts Kiro repair harness (opt-in: GRAVEYARD_MANUAL_NPM_REPAIR_E2E=1)",
  { skip: OPT_IN ? false : "set GRAVEYARD_MANUAL_NPM_REPAIR_E2E=1 to run against real Docker and kiro-cli", timeout: DEADLINE_MS + 120_000 },
  async () => {
    const log: string[] = [];
    const problems: string[] = [];
    let parent: string | undefined;
    let sourceRoot: string | undefined;
    let runsRoot: string | undefined;
    let failure: unknown;
    let timer: NodeJS.Timeout | undefined;
    const executionBase = randomUUID();
    const executionId = `${executionBase}:1`;

    try {
      const fixtureSrc = requireAbsoluteDir("GRAVEYARD_NPM_FIXTURE_DIR");
      const cacheDir = requireAbsoluteDir("GRAVEYARD_NPM_CACHE_DIR");
      if (readdirSync(cacheDir).length === 0) throw new FailClosed("GRAVEYARD_NPM_CACHE_DIR is empty; it must be prepopulated");
      const agentMode = process.env["GRAVEYARD_WORKER_AGENTS"] ?? "kiro-v2";
      if (agentMode !== "kiro-v2" && agentMode !== "kiro-v3") throw new FailClosed("GRAVEYARD_WORKER_AGENTS must be kiro-v2 or kiro-v3 for this harness");

      const operatorPkg: unknown = JSON.parse(readOperatorFile(fixtureSrc, "package.json"));
      const lockText = readOperatorFile(fixtureSrc, "package-lock.json");
      const deps = isObj(operatorPkg) && isObj(operatorPkg["dependencies"]) ? Object.keys(operatorPkg["dependencies"]).sort() : [];
      if (!isObj(operatorPkg) || deps.join(",") !== "is-buffer,is-number" || !lockText.includes("node_modules/is-number") || !lockText.includes("node_modules/is-buffer")) {
        throw new FailClosed("the operator fixture must depend on exactly is-number and is-buffer, in both package.json and package-lock.json");
      }
      const packageJson = `${JSON.stringify({ ...operatorPkg, scripts: { build: "node build.js", test: "node --test test.mjs" } }, null, 2)}\n`;
      const source: Record<string, string> = { "package.json": packageJson, "package-lock.json": lockText, "build.js": BUILD_JS, "test.mjs": TEST_MJS };

      const driverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "npm-scripts-driver.js");
      if (!existsSync(driverPath)) throw new FailClosed("the compiled npm-scripts-driver.js is missing; run pnpm run build:test first");
      const v = await dockerQuery(["version", "--format", "{{.Server.Version}}"]);
      if (!v.ok || v.stdout.trim() === "") throw new FailClosed("docker daemon is not available");
      log.push(`docker server ${v.stdout.trim()}`);
      const img = await dockerQuery(["image", "inspect", "--format", "{{.Id}}", NODE_FIXTURE_IMAGE]);
      if (!img.ok) throw new FailClosed(`image ${NODE_FIXTURE_IMAGE} must already exist locally (never pulled)`);

      parent = ensureOwnedParent(backendRoot());
      sourceRoot = createRunDir(parent);
      runsRoot = createRunDir(parent);
      const pinnedDir = writeFixture(sourceRoot, "pinned", source);
      const commit = sha256(Object.values(source).join("\u0000")).slice(0, 40);
      log.push(`BOUNDARY: git acquisition and snapshot handoff are FAKED from a local 4-file source (${pinnedDir}); no public repository is contacted`);
      log.push("BOUNDARY: registry acquisition is FAKED and only hands over the provided read-only cache; no registry is contacted");
      log.push(`REAL: network-none Docker pipeline, Docker cleanup proofs, kiro-cli (${agentMode}); Kiro receives only build.js, the declared build and test commands and bounded, redacted stage evidence, not package.json, package-lock.json or test.mjs`);

      const sourceBefore = fileHashes(pinnedDir, SOURCE_FILES);
      const operatorBefore = fileHashes(fixtureSrc, ["package.json", "package-lock.json"]);
      const cacheBefore = treeState(cacheDir);

      // --- composition: fakes only where stated above --------------------------------------------
      const sandbox = new DockerFixtureSandbox({
        executor: spawnExecutor,
        allowedImages: [NODE_FIXTURE_IMAGE],
        commands: { [SCRIPTS_COMMAND_ID]: SCRIPTS_ARGV },
      });
      const fallback: JobRunner = {
        run: () => Promise.resolve<RunOutcome>({ kind: "infrastructure-unavailable", reason: "fallback runner is not used by this harness" }),
        cleanup: (req) => Promise.resolve(okProof(req.executionId, "fallback runner never started anything")),
      };
      const makeGit = (hook: (info: HandoffInfo) => Promise<void>): GitLike => ({
        acquire: async (req) => {
          const manifest = { files: SOURCE_FILES.length, totalBytes: Object.values(source).reduce((n, t) => n + Buffer.byteLength(t), 0), submodulesSkipped: 0 };
          await hook({ containerName: "graveyard-fake-acquisition", commit, manifest, dockerBinary: "docker", remainingMs: DEADLINE_MS });
          return {
            kind: "acquired",
            commit,
            manifest,
            durationMs: 1,
            cleanup: okProof(req.executionId, "fake git acquisition: no container was created"),
          };
        },
        cleanup: (req) => Promise.resolve(okProof(req.executionId, "fake git acquisition: no container was created")),
      });
      const registry: RegistryLike = {
        acquire: (req: RegistryAcquisitionRequest) =>
          Promise.resolve({
            kind: "acquired",
            cacheDir,
            summary: { entries: 0 },
            packagesAdded: 2,
            durationMs: 1,
            cleanup: okProof(req.executionId, "fake registry acquisition: no container was created"),
            stagingRemoved: true,
            driverSha256: "0".repeat(64),
            executionId: req.executionId,
          } as unknown as RegistryAcquisitionResult),
        cleanup: (req) => Promise.resolve(okProof(req.executionId, "fake registry acquisition: no container was created")),
      };
      const readRootFiles = (): Promise<RootFiles> =>
        Promise.resolve({ packageJson, packageLock: lockText, buildMjs: null, testMjs: null, unusable: [] });

      const runner = new GithubJobRunner({
        fallback,
        fixtureUrls: new Set(),
        pins: new Map([[REPO_URL, commit]]),
        runsRoot,
        gitImage: "alpine/git:2.47.2",
        makeGit,
        readRootFiles,
        registry,
        makePipeline: () => {
          throw new Error("the build.mjs pipeline must not be used in npm-scripts mode");
        },
        cleanupExecution: (id) => sandbox.cleanup({ executionId: id }),
        agents: new KiroAgentAdapter({ executor: spawnAgentProcess, cliGeneration: agentMode === "kiro-v2" ? "v2" : "v3" }),
        npmScripts: {
          exportSnapshot: (_info, runDir, expect): Promise<SnapshotOutcome> => {
            if (readFileSync(join(pinnedDir, "package.json"), "utf8") !== expect.packageJson || readFileSync(join(pinnedDir, "package-lock.json"), "utf8") !== expect.packageLock) {
              return Promise.resolve({ kind: "refused", reason: "fake snapshot: root files differ from the analysed blobs" });
            }
            const files: Record<string, string> = {};
            for (const n of SOURCE_FILES) files[n] = readFileSync(join(pinnedDir, n), "utf8");
            const name = `src-${randomBytes(6).toString("hex")}`;
            const dir = writeFixture(runDir, name, files);
            return Promise.resolve({
              kind: "extracted",
              name,
              dir,
              files: SOURCE_FILES.length,
              directories: 0,
              totalBytes: Object.values(files).reduce((n, t) => n + Buffer.byteLength(t), 0),
              archiveSha256: sha256(Object.values(files).join("\u0000")),
            });
          },
          makePipeline: (a) =>
            new NpmScriptsPipeline({
              executor: spawnExecutor,
              runDir: a.runDir,
              snapshot: a.snapshot,
              cacheDir: a.cacheDir,
              installManifest: a.installManifest,
              expectedPackages: a.expectedPackages,
            }),
        },
      });

      // --- run ------------------------------------------------------------------------------------
      const ac = new AbortController();
      timer = setTimeout(() => ac.abort(), DEADLINE_MS);
      let stage = "queued";
      const stages: string[] = [];
      const results: Record<string, unknown>[] = [];
      const report: JobProgress = {
        stage: (s, note) => {
          stage = s;
          stages.push(s);
          log.push(`stage ${s}${note === undefined ? "" : `: ${note}`}`);
          return !ac.signal.aborted;
        },
        result: (r) => {
          if (results.length > 0 || ac.signal.aborted) return false;
          results.push(JSON.parse(JSON.stringify(r)) as Record<string, unknown>);
          return true;
        },
      };
      const ctx: RunContext = {
        jobId: randomUUID(),
        repoUrl: REPO_URL,
        executionId,
        attempt: 1,
        deadlineAt: new Date(Date.now() + DEADLINE_MS).toISOString(),
        signal: ac.signal,
        report,
      };
      const started = Date.now();
      const outcome = await runner.run(ctx);
      log.push(`runner outcome ${outcome.kind}${outcome.kind === "infrastructure-unavailable" ? ` (${outcome.reason})` : ""} after ${Date.now() - started} ms`);
      const proof = await runner.cleanup({ jobId: ctx.jobId, executionId, attempt: 1, workerId: null });
      log.push(`runner cleanup: ${proof.confirmed ? "confirmed" : `UNCONFIRMED (${proof.reason})`}`);
      if (!proof.confirmed) problems.push("runner cleanup was not confirmed");

      // --- sanitized diagnostics (printed even when the run failed) -------------------------------
      log.push(`DIAG ${results.length === 0 ? "no result record was stored" : diagnostics(results[0] as Record<string, unknown>)}`);

      // --- assertions through presentResult -------------------------------------------------------
      if (outcome.kind !== "completed") problems.push(`runner outcome was ${outcome.kind}, expected completed`);
      if (results.length !== 1) problems.push(`expected exactly one result record, got ${results.length}`);
      const result = results[0];
      if (result !== undefined) {
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > 64 * 1024) problems.push("result payload exceeds 64 KiB");
        const record: JobResultRecord = { jobId: ctx.jobId, stage, status: "completed", attemptCount: 1, maxAttempts: 1, infraError: null, result };
        const view = presentResult(record);
        log.push(`presentResult outcome=${view.outcome} verified=${String(view.repair.verified)}`);
        log.push(`summary: ${view.summary}`);
        const pipeline = result["pipeline"];
        if (view.outcome !== "repair-verified") problems.push(`outcome ${view.outcome}, expected repair-verified`);
        if (!view.repair.verified) problems.push("repair.verified is not true");
        if (view.repair.patchApplied !== false) problems.push("repair.patchApplied must stay false");
        if (!isObj(pipeline) || pipeline["status"] !== "failure" || pipeline["failedStage"] !== "build") {
          problems.push("the original run did not fail at the build stage");
        }
        const verification = result["verification"];
        const fixer = result["fixer"];
        if (!isObj(verification) || !isObj(verification["patched"]) || verification["patched"]["status"] !== "success") problems.push("the patched copy did not succeed");
        if (!isObj(verification) || !isObj(verification["tester"]) || verification["tester"]["status"] !== "passed") problems.push("the original test did not pass on the patched copy");
        if (!isObj(verification) || !testCountsAcceptable(verification["testCounts"])) problems.push("the patched copy's TAP counts do not show a passed test");
        else log.push(`patched copy test counts: ${JSON.stringify(verification["testCounts"])}`);
        const diff = view.verifiedDiff;
        if (diff === null || diff === "") problems.push("no downloadable verified diff");
        else {
          log.push(`verified diff:\n${diff}`);
          const targets = diffTargets(diff);
          if (targets.length !== 2 || targets.some((t) => t !== "build.js")) problems.push(`the diff must change only build.js; headers name: ${targets.join(", ")}`);
          if (!isObj(fixer) || fixer["diff"] !== diff) problems.push("verifiedDiff differs from the stored Fixer diff");
          if (isObj(verification) && verification["diffSha256"] !== sha256(diff)) problems.push("diffSha256 does not match the downloadable diff");
        }
      }

      // --- no mutation, no leftovers --------------------------------------------------------------
      if (JSON.stringify(fileHashes(pinnedDir, SOURCE_FILES)) !== JSON.stringify(sourceBefore)) problems.push("the controlled source files changed");
      if (JSON.stringify(fileHashes(fixtureSrc, ["package.json", "package-lock.json"])) !== JSON.stringify(operatorBefore)) problems.push("the operator fixture files changed");
      if (JSON.stringify(treeState(cacheDir)) !== JSON.stringify(cacheBefore)) problems.push("the npm cache directory changed");
      const leftover = readdirSync(runsRoot);
      if (leftover.length !== 0) problems.push(`staging directories left under the runs root: ${leftover.join(", ")}`);
      else log.push("runs root is empty after the run");
      const left = await dockerQuery(["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=${executionBase}`]);
      if (!left.ok) problems.push("could not query leftover containers");
      else if (left.stdout.trim() !== "") problems.push(`containers left from this run: ${left.stdout.trim()}`);
      else log.push("independent docker ps: no containers left from this run");
    } catch (e) {
      failure = e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (parent !== undefined) {
        for (const d of [runsRoot, sourceRoot]) {
          if (d === undefined) continue;
          const r = removeRunDir(parent, d);
          if (r.removed) log.push(`removed ${d}`);
          else problems.push(...r.problems.map((p) => `removal: ${p}`));
        }
      }
      for (const l of log) console.log(`INFO  ${l}`);
      if (problems.length > 0) console.log(`PROBLEMS:\n${problems.join("\n")}`);
      if (failure instanceof FailClosed) {
        console.log(`FAIL-CLOSED: ${failure.message}\nNo claim is made about the runner, Kiro or Docker behaviour.`);
      }
    }
    if (failure !== undefined) throw failure;
    if (problems.length > 0) throw new Error(`npm repair harness found ${problems.length} problem(s)`);
  },
);
