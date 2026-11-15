/**
 * manual-npm-install-check.ts — OPT-IN real Docker harness for the controlled OFFLINE `npm ci`
 * runner. NOT production wiring and NOT yet run by its author: every behaviour below is UNVERIFIED
 * until an operator runs it and logs the output in .kiro/PROJECT.md and backend/DEVELOPMENT.md.
 *
 * Skipped unless GRAVEYARD_MANUAL_NPM_INSTALL=1, so `pnpm test` never touches Docker.
 *
 * Why the operator supplies the package and cache. A passing install needs a lockfile whose
 * `resolved` URLs are registry URLs with real sha512 integrity values, and a cache holding exactly
 * those tarballs. Neither can be generated here without the registry, and values must not be
 * invented. A locally built tarball would not carry a registry `resolved` URL, so it would fail the
 * preliminary policy by design. Therefore the harness FAILS CLOSED unless both are provided:
 *
 *   GRAVEYARD_NPM_FIXTURE_DIR  absolute path of a directory with package.json + package-lock.json
 *                              (small: each file <= 64 KiB; passes the policy in npm-lock-policy.ts)
 *   GRAVEYARD_NPM_CACHE_DIR    absolute path of an npm cache prepopulated for exactly that lockfile
 *                              (for example by running `npm ci --cache <dir>` once, online, on the
 *                              operator's own machine, outside this harness). The harness mounts it
 *                              read-only and never writes to it.
 *
 * Cases (each in its own container where one is created; no network anywhere):
 *  1. good      operator fixture      expect success, npm's added count == lock count
 *  2. uncached  registry-form lock whose package is not in the cache (made-up integrity constant)
 *                                     expect failure (npm exits nonzero offline)
 *  3. git-dep   lock resolved from git expect not-run policy-rejected, no container
 *  4. no-lock   package.json only     expect not-run no-lockfile, no container
 *  5. cancel    pre-aborted signal    expect not-run aborted, no container
 *
 * It requires confirmed cleanup for every container, an empty staging directory afterwards, an
 * independent `docker ps -a` query showing no container from this run, and removes its generated
 * directories with removeRunDir. Timeout and mid-run cancel are exercised only by the mock tests
 * here; real Docker timeout/cancel were covered earlier for DockerFixtureSandbox itself.
 *
 * A pass shows only that these fixtures behaved as expected on this machine with this Docker, npm
 * image and cache. It says nothing about arbitrary repositories, hostile packages, or the security
 * of the policy. Assumptions that may make a first run fail closed: npm's `added N packages`
 * format, `npm ci` emptying a tmpfs-mounted node_modules, a read-only cache being sufficient for an
 * offline install, Docker Desktop reporting bind sources in the host form.
 *
 * Run (outside the restricted sandbox):
 *   pnpm run build:test
 *   $env:GRAVEYARD_MANUAL_NPM_INSTALL = "1"
 *   $env:GRAVEYARD_NPM_FIXTURE_DIR = "C:\path\to\fixture"
 *   $env:GRAVEYARD_NPM_CACHE_DIR = "C:\path\to\npm-cache"
 *   node --test dist-test/test/manual-npm-install-check.js
 */

import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { test } from "node:test";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnExecutor } from "../docker-sandbox.js";
import { createRunDir, ensureOwnedParent, removeRunDir, writeFixture } from "../fixture-workspace.js";
import { NODE_FIXTURE_IMAGE } from "../node-fixture-runner.js";
import { NpmInstallRunner, type InstallReason, type InstallResult, type InstallStatus } from "../npm-install-runner.js";

const OPT_IN = process.env["GRAVEYARD_MANUAL_NPM_INSTALL"] === "1";
const MAX_FILE = 64 * 1024;

class FailClosed extends Error {}

interface Expectation { status: InstallStatus; reason?: InstallReason; container: boolean }

function describeResult(r: InstallResult): string {
  const cl = r.cleanup === null ? "none" : r.cleanup.confirmed ? "confirmed" : `UNCONFIRMED(${r.cleanup.reason})`;
  return `${r.status} (${r.reason}) exit=${String(r.exitCode)} added=${String(r.packagesAdded)}/${String(r.expectedPackages)} ` +
    `truncated=${String(r.truncated)} cleanup=${cl} stagingRemoved=${String(r.stagingRemoved)}`;
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
  let st: Stats;
  try {
    st = lstatSync(p);
  } catch {
    throw new FailClosed(`${name} is missing from the operator fixture directory`);
  }
  if (!st.isFile() || st.size > MAX_FILE) throw new FailClosed(`${name} must be a regular file of at most ${MAX_FILE} bytes`);
  return readFileSync(p, "utf8");
}

const UNCACHED_INTEGRITY = `sha512-${"B".repeat(86)}==`;
const UNCACHED_PACKAGE = JSON.stringify({
  name: "gy-uncached", version: "1.0.0", private: true, dependencies: { "graveyard-uncached-fixture": "1.0.0" },
}, null, 2) + "\n";
const UNCACHED_LOCK = JSON.stringify({
  name: "gy-uncached", version: "1.0.0", lockfileVersion: 3, requires: true,
  packages: {
    "": { name: "gy-uncached", version: "1.0.0", dependencies: { "graveyard-uncached-fixture": "1.0.0" } },
    "node_modules/graveyard-uncached-fixture": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/graveyard-uncached-fixture/-/graveyard-uncached-fixture-1.0.0.tgz",
      integrity: UNCACHED_INTEGRITY,
    },
  },
}, null, 2) + "\n";
const GIT_LOCK = UNCACHED_LOCK.replace(
  "https://registry.npmjs.org/graveyard-uncached-fixture/-/graveyard-uncached-fixture-1.0.0.tgz",
  "git+https://github.com/example/example.git#0000000000000000000000000000000000000000",
);

test(
  "manual offline npm ci harness (opt-in: GRAVEYARD_MANUAL_NPM_INSTALL=1)",
  { skip: OPT_IN ? false : "set GRAVEYARD_MANUAL_NPM_INSTALL=1 to run against real Docker", timeout: 600_000 },
  async () => {
    const runId = randomBytes(5).toString("hex");
    const log: string[] = [];
    const problems: string[] = [];
    let parent: string | undefined;
    let fixturesDir: string | undefined;
    let stagingDir: string | undefined;
    let failure: unknown;

    try {
      const fixtureSrc = requireAbsoluteDir("GRAVEYARD_NPM_FIXTURE_DIR");
      const cacheDir = requireAbsoluteDir("GRAVEYARD_NPM_CACHE_DIR");
      if (readdirSync(cacheDir).length === 0) throw new FailClosed("GRAVEYARD_NPM_CACHE_DIR is empty; it must be prepopulated");
      const goodPkg = readOperatorFile(fixtureSrc, "package.json");
      const goodLock = readOperatorFile(fixtureSrc, "package-lock.json");

      const v = await dockerQuery(["version", "--format", "{{.Server.Version}}"]);
      if (!v.ok || v.stdout.trim() === "") throw new FailClosed("docker daemon is not available");
      log.push(`docker server ${v.stdout.trim()}`);
      const img = await dockerQuery(["image", "inspect", "--format", "{{.Id}}", NODE_FIXTURE_IMAGE]);
      if (!img.ok) throw new FailClosed(`image ${NODE_FIXTURE_IMAGE} must already exist locally (never pulled)`);

      parent = ensureOwnedParent(backendRoot());
      fixturesDir = createRunDir(parent);
      stagingDir = createRunDir(parent);
      writeFixture(fixturesDir, "good", { "package.json": goodPkg, "package-lock.json": goodLock });
      writeFixture(fixturesDir, "uncached", { "package.json": UNCACHED_PACKAGE, "package-lock.json": UNCACHED_LOCK });
      writeFixture(fixturesDir, "git-dep", { "package.json": UNCACHED_PACKAGE, "package-lock.json": GIT_LOCK });
      writeFixture(fixturesDir, "no-lock", { "package.json": UNCACHED_PACKAGE });
      log.push(`generated fixtures under ${fixturesDir}; staging under ${stagingDir}`);

      const runner = new NpmInstallRunner({
        executor: spawnExecutor, fixturesRoot: fixturesDir, stagingRoot: stagingDir, cacheDir,
      });
      const cases: Array<{ fixture: string; want: Expectation; abort?: boolean }> = [
        { fixture: "good", want: { status: "success", reason: "ok", container: true } },
        { fixture: "uncached", want: { status: "failure", reason: "npm-exit-nonzero", container: true } },
        { fixture: "git-dep", want: { status: "not-run", reason: "policy-rejected", container: false } },
        { fixture: "no-lock", want: { status: "not-run", reason: "no-lockfile", container: false } },
        { fixture: "good", want: { status: "not-run", reason: "aborted", container: false }, abort: true },
      ];
      let n = 0;
      for (const c of cases) {
        n += 1;
        const ac = new AbortController();
        if (c.abort === true) ac.abort();
        const r = await runner.install({
          executionId: `npmfix-${runId}-${n}:1`, fixture: c.fixture, signal: ac.signal,
        });
        const label = `[${n}:${c.fixture}${c.abort === true ? " pre-aborted" : ""}]`;
        log.push(`${label} ${describeResult(r)}`);
        if (r.stderrTail !== "") log.push(`${label} stderr tail: ${r.stderrTail.slice(-400)}`);
        if (r.status !== c.want.status) problems.push(`${label} status ${r.status}, expected ${c.want.status}`);
        if (c.want.reason !== undefined && r.reason !== c.want.reason) problems.push(`${label} reason ${r.reason}, expected ${c.want.reason}`);
        if (c.want.container && r.cleanup === null) problems.push(`${label} expected a container but no cleanup proof`);
        if (!c.want.container && r.cleanup !== null) problems.push(`${label} no container expected but a cleanup proof exists`);
        if (r.cleanup !== null && !r.cleanup.confirmed) problems.push(`${label} container cleanup not confirmed`);
        if (r.stagingRemoved === false) problems.push(`${label} staging directory not removed`);
        if (c.want.status === "success" && r.packagesAdded !== r.expectedPackages) problems.push(`${label} added count differs from the lock`);
      }

      if (readdirSync(stagingDir).length !== 0) problems.push("staging directory is not empty after the run");
      const left = await dockerQuery(["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=graveyard-npmfix-${runId}`]);
      if (!left.ok) problems.push("could not query leftover containers");
      else if (left.stdout.trim() !== "") problems.push(`containers left from this run: ${left.stdout.trim()}`);
      else log.push("independent docker ps: no containers left from this run");
    } catch (e) {
      failure = e;
    } finally {
      if (parent !== undefined) {
        for (const d of [fixturesDir, stagingDir]) {
          if (d === undefined) continue;
          const r = removeRunDir(parent, d);
          if (r.removed) log.push(`removed ${d}`);
          else problems.push(...r.problems.map((p) => `removal: ${p}`));
        }
      }
      for (const l of log) console.log(`INFO  ${l}`);
      if (problems.length > 0) console.log(`PROBLEMS:\n${problems.join("\n")}`);
      if (failure instanceof FailClosed) {
        console.log(`FAIL-CLOSED: ${failure.message}\nNo claim is made about the runner, npm or Docker behaviour.`);
      }
    }
    if (failure !== undefined) throw failure;
    if (problems.length > 0) throw new Error(`npm install harness found ${problems.length} problem(s)`);
  },
);
