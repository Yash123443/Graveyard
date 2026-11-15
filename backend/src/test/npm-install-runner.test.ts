/**
 * npm-install-runner.test.ts — offline `npm ci` runner for controlled fixtures, with a MOCKED docker
 * CLI. No docker process is spawned, no npm runs, no network. Real temporary directories under
 * os.tmpdir() are used for the fixture, staging and cache directories.
 *
 * These tests check the fixed argv, the arguments handed to Docker, the host-side checks that must
 * happen before any process, and how outcomes map to success / failure / not-run. They do NOT show
 * that real npm prints the modelled summary or that Docker enforces these settings; that needs the
 * opt-in harness (manual-npm-install-check.ts), which has not been run by this author.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DockerFixtureSandbox,
  type ProcessExecutor,
  type ProcessOptions,
  type ProcessResult,
  type SandboxOptions,
  type SandboxResult,
} from "../docker-sandbox.js";
import {
  NPM_CACHE_MOUNT,
  NPM_CI_ARGV,
  NPM_GLOBALCONFIG_NAME,
  NPM_GLOBALCONFIG_PATH,
  NPM_MODULES_MOUNT,
  NPM_USERCONFIG_NAME,
  NPM_USERCONFIG_PATH,
  NpmInstallRunner,
  classifyInstall,
  parseNpmAdded,
  removeStaged,
  type NpmInstallRunnerOptions,
} from "../npm-install-runner.js";
import { NODE_FIXTURE_IMAGE } from "../node-fixture-runner.js";

const IMAGE = NODE_FIXTURE_IMAGE;
const MB = 1024 * 1024;
const INTEG = `sha512-${"A".repeat(86)}==`;

const res = (p: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, ...p,
});

const PKG = JSON.stringify({ name: "fx", version: "1.0.0", private: true, dependencies: { "left-pad": "^1.3.0" } }) + "\n";
const LOCK = JSON.stringify({
  name: "fx", version: "1.0.0", lockfileVersion: 3, requires: true,
  packages: {
    "": { name: "fx", version: "1.0.0", dependencies: { "left-pad": "^1.3.0" } },
    "node_modules/left-pad": {
      version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", integrity: INTEG,
    },
  },
}) + "\n";
const ADDED_OK = "\nadded 1 package in 2s\n";

type Behaviour = ProcessResult | Error | ((opts: ProcessOptions) => Promise<ProcessResult> | ProcessResult);

interface Doc {
  Config: Record<string, unknown>;
  HostConfig: Record<string, unknown>;
  State: Record<string, unknown>;
  Mounts: Array<Record<string, unknown>>;
}

function valuesOf(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === flag) out.push(String(args[i + 1])); });
  return out;
}

/** The inspect document a correctly isolating Docker would report for these create args. */
function docFromCreate(args: readonly string[]): Doc {
  const imageIdx = args.indexOf(IMAGE);
  const labels: Record<string, string> = {};
  for (const l of valuesOf(args, "--label")) {
    const i = l.indexOf("=");
    labels[l.slice(0, i)] = l.slice(i + 1);
  }
  const tmpfs: Record<string, string> = {};
  for (const t of valuesOf(args, "--tmpfs")) {
    const i = t.indexOf(":");
    tmpfs[t.slice(0, i)] = t.slice(i + 1);
  }
  const mounts = valuesOf(args, "--mount").map((m) => {
    const kv: Record<string, string> = {};
    for (const part of m.split(",")) {
      const [k, ...rest] = part.split("=");
      kv[k as string] = rest.join("=");
    }
    return { Type: kv["type"], Source: kv["source"], Destination: kv["target"], RW: !m.endsWith(",readonly") };
  });
  return {
    Config: { User: "65532:65532", Image: IMAGE, Cmd: args.slice(imageIdx + 1), Entrypoint: [""], Labels: labels },
    HostConfig: {
      NetworkMode: "none", Privileged: false, ReadonlyRootfs: true, CapDrop: ["ALL"], CapAdd: null,
      SecurityOpt: ["no-new-privileges"], Memory: 512 * MB, MemorySwap: 512 * MB, PidsLimit: 128,
      NanoCpus: 1_000_000_000, PidMode: "", IpcMode: "private", Binds: null, Devices: [], VolumesFrom: null,
      Tmpfs: tmpfs,
      LogConfig: { Type: "json-file", Config: { "max-size": "64k", "max-file": "1" } },
    },
    State: { Status: "created", Running: false, ExitCode: 0, Error: "", StartedAt: "0001-01-01T00:00:00Z" },
    Mounts: mounts,
  };
}

class FakeDocker {
  readonly calls: Array<{ file: string; args: readonly string[]; opts: ProcessOptions }> = [];
  behaviour: Behaviour = res({ stdout: ADDED_OK });
  versionResult: ProcessResult = res({ stdout: "27.0.0\n" });
  rmRemoves = true;
  tamper: ((d: Doc) => void) | null = null;
  private readonly containers = new Map<string, { doc: Doc; started: boolean; exit: number | null }>();

  readonly executor: ProcessExecutor = async (file, args, opts) => {
    this.calls.push({ file, args, opts });
    const name = String(args[args.length - 1]);
    switch (args[0]) {
      case "version":
        return this.versionResult;
      case "create":
        this.containers.set(valuesOf(args, "--name")[0] as string, { doc: docFromCreate(args), started: false, exit: null });
        return res({ stdout: "id\n" });
      case "inspect": {
        const c = this.containers.get(name);
        if (c === undefined) return res({ exitCode: 1, stderr: `Error: No such object: ${name}\n` });
        const doc = JSON.parse(JSON.stringify(c.doc)) as Doc;
        if (c.started) Object.assign(doc.State, { Status: "exited", ExitCode: c.exit ?? 0, StartedAt: "2026-11-15T10:00:00Z" });
        this.tamper?.(doc);
        return res({ stdout: JSON.stringify([doc]) });
      }
      case "start": {
        const c = this.containers.get(name);
        assert.ok(c, "start of unknown container");
        c.started = true;
        const b = this.behaviour;
        if (b instanceof Error) throw b;
        const r = typeof b === "function" ? await b(opts) : b;
        c.exit = r.exitCode;
        return r;
      }
      case "rm":
        if (this.rmRemoves) this.containers.delete(name);
        return res();
      case "ps":
        return res({ stdout: "" });
      default:
        throw new Error(`unexpected docker subcommand ${String(args[0])}`);
    }
  };

  verbs(): string[] { return this.calls.map((c) => String(c.args[0])); }
  creates(): Array<readonly string[]> { return this.calls.filter((c) => c.args[0] === "create").map((c) => c.args); }
}

interface Env { base: string; fixtures: string; staging: string; cache: string }
const made: string[] = [];

function makeEnv(files: Record<string, string | null> = { "package.json": PKG, "package-lock.json": LOCK }): Env {
  const base = mkdtempSync(join(tmpdir(), "gy-npm-"));
  made.push(base);
  const fixtures = join(base, "fixtures");
  const staging = join(base, "staging");
  const cache = join(base, "cache");
  for (const d of [fixtures, staging, cache, join(fixtures, "case1")]) mkdirSync(d);
  for (const [name, content] of Object.entries(files)) {
    if (content !== null) writeFileSync(join(fixtures, "case1", name), content);
  }
  return { base, fixtures, staging, cache };
}

afterEach(() => {
  for (const b of made.splice(0)) rmSync(b, { recursive: true, force: true });
});

function runner(fake: FakeDocker, env: Env, extra: Partial<NpmInstallRunnerOptions> = {}): NpmInstallRunner {
  return new NpmInstallRunner({
    executor: fake.executor, fixturesRoot: env.fixtures, stagingRoot: env.staging, cacheDir: env.cache, ...extra,
  });
}

const req = { executionId: "npmfix-aaa:1", fixture: "case1" };
const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 1000 && !cond(); i += 1) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), "condition not reached");
};

describe("fixed argv and docker arguments", () => {
  it("has a frozen fixed argv: offline, no scripts, no audit, no fund, fixed cache, no shell, no URL", () => {
    assert.deepEqual([...NPM_CI_ARGV], [
      "npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      "--no-update-notifier", "--logs-max=0", "--cache", "/npm-cache",
      "--userconfig", "/fixture/.npm-user-config", "--globalconfig", "/fixture/.npm-global-config",
    ]);
    assert.notEqual(NPM_USERCONFIG_PATH, NPM_GLOBALCONFIG_PATH, "npm rejects the same path as user and global config");
    assert.ok(!NPM_CI_ARGV.includes("/dev/null"));
    assert.ok(![NPM_USERCONFIG_NAME, NPM_GLOBALCONFIG_NAME].includes(".npmrc"));
    assert.ok(Object.isFrozen(NPM_CI_ARGV));
    for (const a of NPM_CI_ARGV) {
      assert.ok(!["sh", "bash", "-c", "npx", "pnpm"].includes(a));
      assert.ok(!/:\/\/|registry|git|file:/.test(a));
    }
  });

  it("creates one container with network none, non-root, read-only mounts, bounded tmpfs and no env or ports", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    const out = await runner(fake, env).install(req);
    assert.equal(out.status, "success");
    const [a] = fake.creates();
    assert.ok(a);
    assert.deepEqual(valuesOf(a, "--network"), ["none"]);
    assert.deepEqual(valuesOf(a, "--user"), ["65532:65532"]);
    assert.deepEqual(valuesOf(a, "--cap-drop"), ["ALL"]);
    assert.deepEqual(valuesOf(a, "--pull"), ["never"]);
    assert.deepEqual(valuesOf(a, "--memory"), ["512m"]);
    assert.deepEqual(valuesOf(a, "--pids-limit"), ["128"]);
    assert.deepEqual(valuesOf(a, "--workdir"), ["/fixture"]);
    assert.ok(a.includes("--read-only"));
    assert.deepEqual(valuesOf(a, "--tmpfs").sort(), [
      "/fixture/node_modules:rw,noexec,nosuid,nodev,size=64m",
      "/tmp:rw,noexec,nosuid,nodev,size=64m",
    ]);
    const mounts = valuesOf(a, "--mount");
    assert.equal(mounts.length, 2);
    assert.ok(mounts.every((m) => m.startsWith("type=bind,") && m.endsWith(",readonly")));
    assert.ok(mounts.some((m) => m.includes(`,target=/fixture,`)));
    assert.ok(mounts.some((m) => m.includes(`,target=${NPM_CACHE_MOUNT},`)));
    assert.ok(mounts.some((m) => m.includes(`source=${join(realpathSync(env.staging), "case1")},`)), "the staged directory is mounted");
    assert.ok(!mounts.some((m) => m.includes(realpathSync(env.fixtures))), "the source fixture directory is never mounted");
    for (const flag of ["--env", "-e", "--env-file", "--publish", "-p", "--volume", "-v", "--privileged", "--network-alias"]) {
      assert.ok(!a.includes(flag), `unexpected flag ${flag}`);
    }
    assert.deepEqual(a.slice(a.indexOf(IMAGE) + 1), [...NPM_CI_ARGV]);
    assert.ok(fake.calls.every((c) => c.file === "docker" && c.args.every((x) => typeof x === "string")));
    assert.equal(NPM_MODULES_MOUNT, "/fixture/node_modules");
  });

  it("stages only the two validated files plus two distinct empty npm configs; a stray .npmrc or .git in the source never reaches the mount", async () => {
    const env = makeEnv({
      "package.json": PKG, "package-lock.json": LOCK, ".npmrc": "registry=https://evil.example/\n", "extra.js": "x",
    });
    mkdirSync(join(env.fixtures, "case1", ".git"));
    const fake = new FakeDocker();
    let seen: string[] = [];
    let seenPkg = "";
    let seenLock = "";
    let seenUserCfg: string | null = null;
    let seenGlobalCfg: string | null = null;
    fake.behaviour = () => {
      seen = readdirSync(join(env.staging, "case1")).sort();
      seenUserCfg = readFileSync(join(env.staging, "case1", ".npm-user-config"), "utf8");
      seenGlobalCfg = readFileSync(join(env.staging, "case1", ".npm-global-config"), "utf8");
      seenPkg = readFileSync(join(env.staging, "case1", "package.json"), "utf8");
      seenLock = readFileSync(join(env.staging, "case1", "package-lock.json"), "utf8");
      return res({ stdout: ADDED_OK });
    };
    const out = await runner(fake, env).install(req);
    assert.equal(out.status, "success");
    assert.deepEqual(seen, [".npm-global-config", ".npm-user-config", "node_modules", "package-lock.json", "package.json"]);
    assert.equal(seenUserCfg, "");
    assert.equal(seenGlobalCfg, "");
    assert.ok(!seen.includes(".npmrc"));
    assert.equal(seenPkg, PKG);
    assert.equal(seenLock, LOCK);
  });
});

describe("success, failure and not-run", () => {
  it("success: exit 0, matching npm summary, confirmed container cleanup and staging removed", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    const out = await runner(fake, env).install(req);
    assert.equal(out.status, "success");
    assert.equal(out.reason, "ok");
    assert.equal(out.packagesAdded, 1);
    assert.equal(out.expectedPackages, 1);
    assert.equal(out.cleanup?.confirmed, true);
    assert.equal(out.stagingRemoved, true);
    assert.ok(!existsSync(join(env.staging, "case1")));
    assert.deepEqual(fake.verbs().slice(-1), ["ps"]);
    assert.ok(fake.verbs().includes("rm"));
    assert.ok(existsSync(join(env.fixtures, "case1", "package.json")), "the source fixture is untouched");
  });

  it("failure: npm exits nonzero (for example an offline cache miss); cleanup still proven", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    fake.behaviour = res({ exitCode: 1, stderr: "npm error code ENOTCACHED\n" });
    const out = await runner(fake, env).install(req);
    assert.equal(out.status, "failure");
    assert.equal(out.reason, "npm-exit-nonzero");
    assert.equal(out.exitCode, 1);
    assert.match(out.stderrTail, /ENOTCACHED/);
    assert.equal(out.packagesAdded, null);
    assert.equal(out.cleanup?.confirmed, true);
    assert.equal(out.stagingRemoved, true);
  });

  it("not-run: exit 0 without npm's summary is not an install", async () => {
    const fake = new FakeDocker();
    fake.behaviour = res({ stdout: "done\n" });
    const out = await runner(fake, makeEnv()).install(req);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "summary-missing");
  });

  it("not-run: the reported count must equal the lock's count", async () => {
    const fake = new FakeDocker();
    fake.behaviour = res({ stdout: "added 5 packages in 1s\n" });
    const out = await runner(fake, makeEnv()).install(req);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "summary-mismatch");
    assert.equal(out.packagesAdded, 5);
  });

  it("not-run: exit 0 with truncated output", async () => {
    const fake = new FakeDocker();
    fake.behaviour = res({ stdout: ADDED_OK, truncated: true });
    const out = await runner(fake, makeEnv()).install(req);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "output-truncated");
    assert.equal(out.truncated, true);
  });

  it("failure with truncated output is still a failure and reports truncation", async () => {
    const fake = new FakeDocker();
    fake.behaviour = res({ exitCode: 1, stdout: "x".repeat(50), truncated: true });
    const out = await runner(fake, makeEnv()).install(req);
    assert.equal(out.status, "failure");
    assert.equal(out.truncated, true);
  });

  it("not-run: timeout is neither success nor failure; cleanup still proven", async () => {
    const fake = new FakeDocker();
    fake.behaviour = res({ exitCode: null, timedOut: true, stdout: ADDED_OK });
    const out = await runner(fake, makeEnv()).install(req);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "timed-out");
    assert.equal(out.packagesAdded, null);
    assert.equal(out.cleanup?.confirmed, true);
    assert.equal(out.stagingRemoved, true);
  });

  it("not-run: cancel during the run; the signal reaches docker start; cleanup proven", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    fake.behaviour = (opts) => new Promise<ProcessResult>((done) => {
      opts.signal?.addEventListener("abort", () => done(res({ exitCode: null, aborted: true, stdout: "partial" })), { once: true });
    });
    const ac = new AbortController();
    const p = runner(fake, env).install({ ...req, signal: ac.signal });
    await waitFor(() => fake.verbs().includes("start"));
    assert.equal(fake.calls.find((c) => c.args[0] === "start")?.opts.signal, ac.signal);
    ac.abort();
    const out = await p;
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "aborted");
    assert.equal(out.cleanup?.confirmed, true);
    assert.equal(out.stagingRemoved, true);
    assert.ok(fake.verbs().includes("rm"));
  });

  it("not-run: an already-aborted signal does nothing at all", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    const ac = new AbortController();
    ac.abort();
    const out = await runner(fake, env).install({ ...req, signal: ac.signal });
    assert.equal(out.reason, "aborted");
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(readdirSync(env.staging), []);
  });

  it("not-run: docker unavailable creates nothing and the staged copy is removed", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    fake.versionResult = res({ exitCode: 1, stderr: "cannot connect" });
    const out = await runner(fake, env).install(req);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "docker-unavailable");
    assert.deepEqual(fake.verbs(), ["version"]);
    assert.equal(out.cleanup, null);
    assert.equal(out.stagingRemoved, true);
    assert.deepEqual(readdirSync(env.staging), []);
  });

  it("not-run: a thrown docker error during start still cleans up", async () => {
    const fake = new FakeDocker();
    fake.behaviour = new Error("spawn docker ENOENT");
    const out = await runner(fake, makeEnv()).install(req);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "docker-unavailable");
    assert.equal(out.cleanup?.confirmed, true);
    assert.ok(fake.verbs().includes("rm"));
  });

  const tampers: Array<[string, (d: Doc) => void]> = [
    ["network not none", (d) => { d.HostConfig["NetworkMode"] = "bridge"; }],
    ["node_modules tmpfs missing", (d) => { delete (d.HostConfig["Tmpfs"] as Record<string, string>)["/fixture/node_modules"]; }],
    ["node_modules tmpfs executable", (d) => { (d.HostConfig["Tmpfs"] as Record<string, string>)["/fixture/node_modules"] = "rw,nosuid,nodev,size=64m"; }],
    ["node_modules tmpfs wrong size", (d) => { (d.HostConfig["Tmpfs"] as Record<string, string>)["/fixture/node_modules"] = "rw,noexec,nosuid,nodev,size=999m"; }],
    ["cache mount writable", (d) => { for (const m of d.Mounts) if (m["Destination"] === NPM_CACHE_MOUNT) m["RW"] = true; }],
    ["cache mount from another path", (d) => { for (const m of d.Mounts) if (m["Destination"] === NPM_CACHE_MOUNT) m["Source"] = "/etc"; }],
    ["extra mount", (d) => { d.Mounts.push({ Type: "bind", Source: "/", Destination: "/host", RW: false }); }],
    ["cache mount missing", (d) => { d.Mounts = d.Mounts.filter((m) => m["Destination"] !== NPM_CACHE_MOUNT); }],
  ];
  for (const [label, fn] of tampers) {
    it(`not-run: isolation mismatch (${label}) means the container is never started`, async () => {
      const env = makeEnv();
      const fake = new FakeDocker();
      fake.tamper = fn;
      const out = await runner(fake, env).install(req);
      assert.equal(out.status, "not-run");
      assert.equal(out.reason, "isolation-violation");
      assert.ok(!fake.verbs().includes("start"));
      assert.equal(out.cleanup?.confirmed, true);
      assert.equal(out.stagingRemoved, true);
    });
  }

  it("cleanup proof: unconfirmed container removal downgrades success to not-run; failure stays failure", async () => {
    const fake = new FakeDocker();
    fake.rmRemoves = false;
    const ok = await runner(fake, makeEnv()).install(req);
    assert.equal(ok.status, "not-run");
    assert.equal(ok.reason, "cleanup-unconfirmed");
    assert.equal(ok.cleanup?.confirmed, false);

    const fake2 = new FakeDocker();
    fake2.rmRemoves = false;
    fake2.behaviour = res({ exitCode: 1 });
    const bad = await runner(fake2, makeEnv()).install({ ...req, executionId: "npmfix-bbb:1" });
    assert.equal(bad.status, "failure");
    assert.equal(bad.cleanup?.confirmed, false);
  });

  it("staging cleanup: unexpected staged content downgrades success and the directory is left in place", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    fake.behaviour = () => {
      writeFileSync(join(env.staging, "case1", "surprise.txt"), "x");
      return res({ stdout: ADDED_OK });
    };
    const out = await runner(fake, env).install(req);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "staging-cleanup-failed");
    assert.equal(out.stagingRemoved, false);
    assert.ok(existsSync(join(env.staging, "case1", "surprise.txt")), "nothing unexpected is deleted");
  });
});

describe("host-side checks before any process", () => {
  it("no lockfile: not-run, nothing staged, docker never contacted", async () => {
    const env = makeEnv({ "package.json": PKG, "package-lock.json": null });
    const fake = new FakeDocker();
    const out = await runner(fake, env).install(req);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "no-lockfile");
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(readdirSync(env.staging), []);
  });

  it("no package.json: not-run, docker never contacted", async () => {
    const env = makeEnv({ "package.json": null, "package-lock.json": LOCK });
    const fake = new FakeDocker();
    const out = await runner(fake, env).install(req);
    assert.equal(out.reason, "no-package-json");
    assert.deepEqual(fake.calls, []);
  });

  it("policy rejection: not-run with violations, nothing staged, docker never contacted", async () => {
    const gitLock = LOCK.replace("https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", "git+https://github.com/a/b.git");
    const env = makeEnv({ "package.json": PKG, "package-lock.json": gitLock });
    const fake = new FakeDocker();
    const out = await runner(fake, env).install(req);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "policy-rejected");
    assert.ok(out.violations.length >= 1);
    assert.match(out.violations.join("\n"), /resolved/);
    assert.equal(out.expectedPackages, null);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(readdirSync(env.staging), []);
  });

  it("policy rejection: install scripts and package manager fields in package.json", async () => {
    const bad = JSON.stringify({ name: "fx", version: "1.0.0", dependencies: { "left-pad": "^1.3.0" }, scripts: { postinstall: "node x" }, overrides: {} });
    const env = makeEnv({ "package.json": bad, "package-lock.json": LOCK });
    const fake = new FakeDocker();
    const out = await runner(fake, env).install(req);
    assert.equal(out.reason, "policy-rejected");
    assert.deepEqual(fake.calls, []);
  });

  it("policy rejection: oversized inputs are never read into the policy", async () => {
    const env = makeEnv({ "package.json": PKG, "package-lock.json": "x".repeat(600 * 1024) });
    const fake = new FakeDocker();
    const out = await runner(fake, env).install(req);
    assert.equal(out.reason, "policy-rejected");
    assert.deepEqual(fake.calls, []);
  });

  it("a symlinked package-lock.json is not followed", async (t) => {
    const env = makeEnv({ "package.json": PKG, "package-lock.json": null });
    writeFileSync(join(env.base, "real-lock.json"), LOCK);
    try {
      symlinkSync(join(env.base, "real-lock.json"), join(env.fixtures, "case1", "package-lock.json"));
    } catch {
      t.skip("symlinks cannot be created here");
      return;
    }
    const fake = new FakeDocker();
    const out = await runner(fake, env).install(req);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "unreadable-input");
    assert.deepEqual(fake.calls, []);
  });

  it("missing cache directory fails closed without contacting docker", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    const out = await runner(fake, env, { cacheDir: join(env.base, "no-such-cache") }).install(req);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "cache-unavailable");
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(readdirSync(env.staging), []);
  });

  it("a cache path that is a file, a relative path or a missing staging root is not usable", async () => {
    const env = makeEnv();
    writeFileSync(join(env.base, "cachefile"), "x");
    for (const extra of [
      { cacheDir: join(env.base, "cachefile") },
      { cacheDir: "relative/cache" },
      { stagingRoot: join(env.base, "no-such-staging") },
      { stagingRoot: env.fixtures },
    ]) {
      const fake = new FakeDocker();
      const out = await runner(fake, env, extra).install(req);
      assert.equal(out.status, "not-run");
      assert.ok(["cache-unavailable", "unconfigured"].includes(out.reason), out.reason);
      assert.deepEqual(fake.calls, []);
    }
  });

  it("rejects bad execution ids, fixture names and traversal without staging or contacting docker", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    const r = runner(fake, env);
    for (const bad of [
      { ...req, executionId: "bad id" },
      { ...req, fixture: "../fixtures" },
      { ...req, fixture: "case1/../case1" },
      { ...req, fixture: "" },
      { ...req, fixture: "missing-dir" },
    ]) {
      const out = await r.install(bad);
      assert.equal(out.status, "not-run");
      assert.equal(out.reason, "rejected");
    }
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(readdirSync(env.staging), []);
  });

  it("an existing staging directory is refused and left untouched", async () => {
    const env = makeEnv();
    mkdirSync(join(env.staging, "case1"));
    writeFileSync(join(env.staging, "case1", "keep.txt"), "mine");
    const fake = new FakeDocker();
    const out = await runner(fake, env).install(req);
    assert.equal(out.reason, "staging-failed");
    assert.deepEqual(fake.calls, []);
    assert.equal(readFileSync(join(env.staging, "case1", "keep.txt"), "utf8"), "mine");
  });
});

describe("pure helpers", () => {
  it("parseNpmAdded reads only npm's summary line at the start of a line; the last one wins", () => {
    assert.equal(parseNpmAdded("added 1 package in 2s\n"), 1);
    assert.equal(parseNpmAdded("\nadded 12 packages in 523ms\r\n"), 12);
    assert.equal(parseNpmAdded("  added 3 packages in 1s\n"), null);
    assert.equal(parseNpmAdded("x added 3 packages in 1s\n"), null);
    assert.equal(parseNpmAdded("added 3 packages\n"), null);
    assert.equal(parseNpmAdded("added 3 packages in 1s\nadded 4 packages in 1s\n"), 4);
    assert.equal(parseNpmAdded("up to date in 1s\n"), null);
  });

  it("classifyInstall maps every non-exit sandbox outcome to not-run", () => {
    const outcomes: SandboxResult[] = [
      { kind: "timed-out", stdout: "", stderr: "", truncated: false, durationMs: 1, cleanup: null },
      { kind: "aborted", stdout: "", stderr: "", truncated: false, durationMs: 1, cleanup: null },
      { kind: "isolation-violation", reason: "x", cleanup: null },
      { kind: "unavailable", reason: "x", cleanup: null },
      { kind: "rejected", reason: "x", cleanup: null },
    ];
    for (const o of outcomes) assert.equal(classifyInstall(o, 1).status, "not-run");
  });

  it("removeStaged refuses a directory with unexpected contents or a non-empty node_modules", () => {
    const env = makeEnv();
    const dir = join(env.staging, "x");
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), "{}");
    assert.equal(removeStaged(dir).removed, false);
    writeFileSync(join(dir, "package-lock.json"), "{}");
    writeFileSync(join(dir, ".npm-user-config"), "");
    writeFileSync(join(dir, ".npm-global-config"), "");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "leftover"), "x");
    const r = removeStaged(dir);
    assert.equal(r.removed, false);
    assert.match(r.problem ?? "", /node_modules/);
    assert.ok(existsSync(join(dir, "node_modules", "leftover")));
    rmSync(join(dir, "node_modules", "leftover"));
    // a non-empty config file (possible credentials) is never silently deleted
    writeFileSync(join(dir, ".npm-user-config"), "//registry/:_authToken=x\n");
    const r2 = removeStaged(dir);
    assert.equal(r2.removed, false);
    assert.match(r2.problem ?? "", /not empty/);
    assert.ok(existsSync(join(dir, "package.json")), "nothing is deleted when verification fails");
    writeFileSync(join(dir, ".npm-user-config"), "");
    assert.equal(removeStaged(dir).removed, true);
    assert.ok(!existsSync(dir));
  });
});

describe("sandbox extension validation", () => {
  const base = (env: Env, extra: Record<string, unknown>): DockerFixtureSandbox =>
    new DockerFixtureSandbox({
      executor: new FakeDocker().executor,
      allowedImages: [IMAGE],
      commands: { c: ["node", "-v"] },
      fixturesRoot: env.staging,
      ...(extra as Partial<SandboxOptions>),
    });

  it("accepts well-formed fixed extras", () => {
    const env = makeEnv();
    assert.doesNotThrow(() => base(env, {
      readonlyBinds: [{ source: env.cache, target: "/npm-cache" }],
      extraTmpfs: [{ target: "/fixture/node_modules", sizeMb: 64 }],
    }));
  });

  it("rejects reserved, duplicate, malformed and relative targets and bad sizes", () => {
    const env = makeEnv();
    const bind = (target: string, source = env.cache): Record<string, unknown> => ({ readonlyBinds: [{ source, target }] });
    assert.throws(() => base(env, bind("/tmp")));
    assert.throws(() => base(env, bind("/fixture")));
    assert.throws(() => base(env, bind("relative")));
    assert.throws(() => base(env, bind("/a b")));
    assert.throws(() => base(env, bind("/ok", "relative/source")));
    assert.throws(() => base(env, { readonlyBinds: [{ source: env.cache, target: "/c" }, { source: env.cache, target: "/c" }] }));
    assert.throws(() => base(env, { extraTmpfs: [{ target: "/tmp", sizeMb: 8 }] }));
    assert.throws(() => base(env, { extraTmpfs: [{ target: "/x", sizeMb: 0 }] }));
    assert.throws(() => base(env, { extraTmpfs: [{ target: "/x", sizeMb: 9999 }] }));
    assert.throws(() => base(env, { extraTmpfs: [{ target: "/x", sizeMb: 8 }], readonlyBinds: [{ source: env.cache, target: "/x" }] }));
  });
});
