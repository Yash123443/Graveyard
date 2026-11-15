/**
 * controlled-pipeline.test.ts — host orchestration of the integrated controlled fixture pipeline
 * with a MOCKED docker CLI. No docker process is spawned, no npm runs, no network. Real temporary
 * directories under os.tmpdir() are used for fixture, staging, cache and a stand-in driver file.
 *
 * These tests check the Docker arguments, the host checks that happen before any container, what
 * is staged, strict parsing of the driver's single-line protocol, and how outcomes map to
 * success / failure / not-run. One test runs the real compiled driver file as a subprocess WITHOUT
 * fixture mounts to check the one-line protocol. They do NOT show that real Docker enforces the
 * isolation, that real npm prints the modelled summary, or that the pipeline works in a container;
 * that needs the opt-in harness (manual-controlled-pipeline-check.ts), which has not been run by
 * this author.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { ProcessExecutor, ProcessOptions, ProcessResult } from "../docker-sandbox.js";
import {
  ControlledPipeline,
  PIPELINE_ARGV,
  STAGED_DRIVER_NAME,
  classifyPipeline,
  parseProtocolOutput,
  type ControlledPipelineOptions,
} from "../controlled-pipeline.js";
import { PIPELINE_FIXTURE_KINDS, pipelineFixtureScripts } from "../controlled-pipeline-fixtures.js";
import {
  PROTOCOL_ID,
  PROTOCOL_TAIL_CHARS,
  encodeProtocolLine,
  type PipelineResult,
  type StageName,
  type StageResult,
} from "../fixture-pipeline-driver.js";
import { NODE_FIXTURE_IMAGE } from "../node-fixture-runner.js";

const IMAGE = NODE_FIXTURE_IMAGE;
const MB = 1024 * 1024;
const INTEG = `sha512-${"A".repeat(86)}==`;

const res = (p: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, ...p,
});

const PKG = JSON.stringify({ name: "fx", version: "1.0.0", private: true, dependencies: { "is-number": "7.0.0" } }) + "\n";
const LOCK = JSON.stringify({
  name: "fx", version: "1.0.0", lockfileVersion: 3, requires: true,
  packages: {
    "": { name: "fx", version: "1.0.0", dependencies: { "is-number": "7.0.0" } },
    "node_modules/is-number": {
      version: "7.0.0", resolved: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz", integrity: INTEG,
    },
  },
}) + "\n";
const GIT_LOCK = LOCK.replace("https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz", "git+https://github.com/x/y.git#abc");
const BUILD = "// build\n";
const TEST = "// test\n";
const DRIVER_BYTES = "// stand-in for the compiled driver\n";
const ADDED_OK = "\nadded 1 package in 2s\n";

// ---- protocol helpers ----

const NAMES: readonly StageName[] = ["prepare", "install", "build", "test"];

function passedStage(stage: StageName): StageResult {
  return { stage, status: "passed", durationMs: 5, ...(stage === "install" ? { stdoutTail: ADDED_OK } : {}) };
}

/** A pipeline report: stages before `failAt` pass, `failAt` fails with `reason`, the rest are skipped. */
function report(
  failAt: StageName | null,
  opts: { reason?: StageResult["reason"]; exitCode?: number; testPresent?: boolean; installTail?: string } = {},
): PipelineResult {
  const testPresent = opts.testPresent ?? true;
  const stages: StageResult[] = [];
  let failed = false;
  for (const n of NAMES) {
    if (failed) {
      stages.push({ stage: n, status: "skipped", detail: "skipped because an earlier stage did not pass", durationMs: 0 });
    } else if (n === failAt) {
      failed = true;
      const reason = opts.reason ?? "exit-code";
      stages.push({
        stage: n, status: "failed", reason, detail: "x", durationMs: 5,
        ...(reason === "exit-code" ? { exitCode: opts.exitCode ?? 1 } : {}),
      });
    } else if (n === "test" && !testPresent) {
      stages.push({ stage: n, status: "not-run", detail: "no test.mjs in the fixture", durationMs: 0 });
    } else {
      const s = passedStage(n);
      if (n === "install" && opts.installTail !== undefined) s.stdoutTail = opts.installTail;
      stages.push(s);
    }
  }
  const status = failAt === null ? "passed" : opts.reason === "cancelled" ? "cancelled" : "failed";
  return { status, stages };
}

const lineOf = (r: PipelineResult): string => encodeProtocolLine(r);
const exitFor = (r: PipelineResult): number => (r.status === "passed" ? 0 : 1);
const driverResult = (r: PipelineResult): ProcessResult => res({ exitCode: exitFor(r), stdout: lineOf(r) });

// ---- fake docker ----

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
  behaviour: Behaviour = driverResult(report(null));
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

// ---- environment ----

interface Env { base: string; fixtures: string; staging: string; cache: string; driver: string }
const made: string[] = [];

function makeEnv(files: Record<string, string | null> = {
  "package.json": PKG, "package-lock.json": LOCK, "build.mjs": BUILD, "test.mjs": TEST,
}): Env {
  const base = mkdtempSync(join(tmpdir(), "gy-pipe-"));
  made.push(base);
  const fixtures = join(base, "fixtures");
  const staging = join(base, "staging");
  const cache = join(base, "cache");
  const driver = join(base, "driver.js");
  for (const d of [fixtures, staging, cache, join(fixtures, "case1")]) mkdirSync(d);
  writeFileSync(driver, DRIVER_BYTES);
  for (const [name, content] of Object.entries(files)) {
    if (content !== null) writeFileSync(join(fixtures, "case1", name), content);
  }
  return { base, fixtures, staging, cache, driver };
}

afterEach(() => {
  for (const b of made.splice(0)) rmSync(b, { recursive: true, force: true });
});

function pipeline(fake: FakeDocker, env: Env, extra: Partial<ControlledPipelineOptions> = {}): ControlledPipeline {
  return new ControlledPipeline({
    executor: fake.executor, fixturesRoot: env.fixtures, stagingRoot: env.staging, cacheDir: env.cache,
    driverPath: env.driver, ...extra,
  });
}

const req = { executionId: "pipefix-aaa:1", fixture: "case1" };

// ---------------------------------------------------------------------------------------------

describe("fixed argv and docker arguments", () => {
  it("runs one fixed node entry point and no request input reaches the argv", () => {
    assert.deepEqual([...PIPELINE_ARGV], ["node", `/fixture/${STAGED_DRIVER_NAME}`]);
    assert.ok(Object.isFrozen(PIPELINE_ARGV));
  });

  it("creates one container: network none, non-root, caps dropped, read-only mounts, bounded tmpfs, no env or ports", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    const r = await pipeline(fake, env).run(req);
    assert.equal(r.status, "success", r.detail);
    assert.equal(fake.creates().length, 1);
    const a = fake.creates()[0] as readonly string[];
    const pair = (flag: string, value: string): boolean => a.some((x, i) => x === flag && a[i + 1] === value);
    assert.ok(pair("--network", "none"));
    assert.ok(pair("--user", "65532:65532"));
    assert.ok(pair("--cap-drop", "ALL"));
    assert.ok(pair("--security-opt", "no-new-privileges"));
    assert.ok(pair("--pull", "never"));
    assert.ok(a.includes("--read-only"));
    assert.ok(pair("--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m"));
    assert.ok(pair("--tmpfs", "/work:rw,noexec,nosuid,nodev,size=64m"));
    for (const forbidden of ["-e", "--env", "--env-file", "-p", "--publish", "--privileged", "--volume", "-v", "--cap-add", "--device"]) {
      assert.ok(!a.includes(forbidden), forbidden);
    }
    const mounts = valuesOf(a, "--mount");
    assert.equal(mounts.length, 2);
    assert.ok(mounts.every((m) => m.endsWith(",readonly")));
    assert.ok(mounts.some((m) => m.includes("target=/fixture,")));
    assert.ok(mounts.some((m) => m.includes("target=/npm-cache,")));
    assert.deepEqual(a.slice(a.indexOf(IMAGE)), [IMAGE, "node", `/fixture/${STAGED_DRIVER_NAME}`]);
    // every docker call is an argv array without a shell
    for (const c of fake.calls) assert.equal(c.file, "docker");
  });

  it("uses the container limits: 120 s, 128 KiB output", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    await pipeline(fake, env).run(req);
    const start = fake.calls.find((c) => c.args[0] === "start");
    assert.equal(start?.opts.timeoutMs, 120_000);
    assert.equal(start?.opts.maxOutputBytes, 128 * 1024);
  });
});

describe("staging", () => {
  it("stages only the allowlisted fixture files plus the trusted driver; stray files never reach the mount", async () => {
    const env = makeEnv({
      "package.json": PKG, "package-lock.json": LOCK, "build.mjs": BUILD, "test.mjs": TEST,
      ".npmrc": "registry=http://evil.example\n", "evil.mjs": "x", "postinstall.sh": "x",
    });
    mkdirSync(join(env.fixtures, "case1", ".git"));
    const fake = new FakeDocker();
    let seen: string[] = [];
    fake.behaviour = () => {
      seen = readdirSync(join(env.staging, "case1")).sort();
      return driverResult(report(null));
    };
    const r = await pipeline(fake, env).run(req);
    assert.equal(r.status, "success", r.detail);
    assert.deepEqual(seen, ["build.mjs", "fixture-pipeline-driver.mjs", "package-lock.json", "package.json", "test.mjs"]);
    assert.deepEqual(readdirSync(env.staging), [], "staging removed");
    assert.equal(r.stagingRemoved, true);
    assert.equal(r.driverSha256, createHash("sha256").update(DRIVER_BYTES).digest("hex"));
  });

  it("omits test.mjs when the fixture has none; overall is not-run/tests-not-run, never success", async () => {
    const env = makeEnv({ "package.json": PKG, "package-lock.json": LOCK, "build.mjs": BUILD });
    const fake = new FakeDocker();
    let seen: string[] = [];
    fake.behaviour = () => {
      seen = readdirSync(join(env.staging, "case1")).sort();
      return driverResult(report(null, { testPresent: false }));
    };
    const r = await pipeline(fake, env).run(req);
    assert.notEqual(r.status, "success", "no tests must never be success");
    assert.equal(r.status, "not-run");
    assert.equal(r.reason, "tests-not-run");
    assert.equal(r.failedStage, "test");
    assert.ok(!seen.includes("test.mjs"));
    assert.equal(r.stages?.[3]?.status, "not-run");
    assert.equal(r.cleanup?.confirmed, true);
    assert.deepEqual(readdirSync(env.staging), []);
  });

  it("refuses an existing staging directory without touching it", async () => {
    const env = makeEnv();
    mkdirSync(join(env.staging, "case1"));
    writeFileSync(join(env.staging, "case1", "keep.txt"), "x");
    const fake = new FakeDocker();
    const r = await pipeline(fake, env).run(req);
    assert.equal(r.status, "not-run");
    assert.equal(r.reason, "staging-failed");
    assert.equal(fake.calls.length, 0);
    assert.ok(existsSync(join(env.staging, "case1", "keep.txt")));
  });

  it("reports staging-cleanup-failed instead of success when something unexpected is left in the staging directory", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    fake.behaviour = () => {
      writeFileSync(join(env.staging, "case1", "surprise.txt"), "x");
      return driverResult(report(null));
    };
    const r = await pipeline(fake, env).run(req);
    assert.equal(r.status, "not-run");
    assert.equal(r.reason, "staging-cleanup-failed");
    assert.equal(r.stagingRemoved, false);
  });
});

describe("checks before any container", () => {
  const cases: Array<[string, Record<string, string | null>, string]> = [
    ["no package.json", { "package-lock.json": LOCK, "build.mjs": BUILD }, "no-package-json"],
    ["no lockfile", { "package.json": PKG, "build.mjs": BUILD }, "no-lockfile"],
    ["no build.mjs", { "package.json": PKG, "package-lock.json": LOCK }, "no-build-script"],
    ["git dependency in the lockfile", { "package.json": PKG, "package-lock.json": GIT_LOCK, "build.mjs": BUILD }, "policy-rejected"],
    ["oversized build.mjs", { "package.json": PKG, "package-lock.json": LOCK, "build.mjs": "x".repeat(70 * 1024) }, "policy-rejected"],
  ];
  for (const [label, files, reason] of cases) {
    it(`${label}: not-run ${reason}, no docker call, nothing staged`, async () => {
      const env = makeEnv(files);
      const fake = new FakeDocker();
      const r = await pipeline(fake, env).run(req);
      assert.equal(r.status, "not-run");
      assert.equal(r.reason, reason);
      assert.equal(fake.calls.length, 0);
      assert.equal(r.cleanup, null);
      assert.deepEqual(readdirSync(env.staging), []);
    });
  }

  it("rejects a symlinked build.mjs (never followed)", async () => {
    const env = makeEnv({ "package.json": PKG, "package-lock.json": LOCK });
    writeFileSync(join(env.base, "outside.mjs"), "x");
    try {
      symlinkSync(join(env.base, "outside.mjs"), join(env.fixtures, "case1", "build.mjs"));
    } catch {
      return; // symlinks unavailable here (for example Windows without privilege)
    }
    const fake = new FakeDocker();
    const r = await pipeline(fake, env).run(req);
    assert.equal(r.status, "not-run");
    assert.equal(r.reason, "unreadable-input");
    assert.equal(fake.calls.length, 0);
  });

  it("rejects bad fixture names, traversal and bad execution ids without docker", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    const p = pipeline(fake, env);
    for (const fixture of ["../x", "a/b", "", ".hidden", "nope"]) {
      const r = await p.run({ executionId: "pipefix-aaa:1", fixture });
      assert.equal(r.status, "not-run", fixture);
      assert.equal(r.reason, "rejected", fixture);
    }
    const r = await p.run({ executionId: "bad id", fixture: "case1" });
    assert.equal(r.reason, "rejected");
    assert.equal(fake.calls.length, 0);
  });

  it("is not-run when the driver file is missing or does not match the pinned hash", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    const missing = await pipeline(fake, env, { driverPath: join(env.base, "absent.js") }).run(req);
    assert.equal(missing.reason, "driver-unavailable");
    const pinned = await pipeline(fake, env, { expectedDriverSha256: "0".repeat(64) }).run(req);
    assert.equal(pinned.reason, "driver-unavailable");
    const ok = await pipeline(fake, env, {
      expectedDriverSha256: createHash("sha256").update(DRIVER_BYTES).digest("hex"),
    }).run(req);
    assert.equal(ok.status, "success", ok.detail);
    assert.equal(fake.creates().length, 1);
  });

  it("is not-run without any docker call when the cache directory is missing or roots are not absolute", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    const noCache = await pipeline(fake, env, { cacheDir: join(env.base, "absent-cache") }).run(req);
    assert.equal(noCache.reason, "cache-unavailable");
    const relative = await pipeline(fake, env, { fixturesRoot: "fixtures" }).run(req);
    assert.equal(relative.reason, "unconfigured");
    const same = await pipeline(fake, env, { stagingRoot: env.fixtures }).run(req);
    assert.equal(same.reason, "unconfigured");
    assert.equal(fake.calls.length, 0);
  });

  it("does nothing when the signal is already aborted", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    const ac = new AbortController();
    ac.abort();
    const r = await pipeline(fake, env).run({ ...req, signal: ac.signal });
    assert.equal(r.reason, "aborted");
    assert.equal(fake.calls.length, 0);
  });
});

describe("success, failure and not-run from the driver report", () => {
  it("success: stages are returned, count matches, cleanup is confirmed", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    const r = await pipeline(fake, env).run(req);
    assert.equal(r.status, "success");
    assert.equal(r.reason, "ok");
    assert.equal(r.packagesAdded, 1);
    assert.equal(r.expectedPackages, 1);
    assert.equal(r.exitCode, 0);
    assert.equal(r.cleanup?.confirmed, true);
    assert.deepEqual(r.stages?.map((s) => s.status), ["passed", "passed", "passed", "passed"]);
    assert.ok(fake.verbs().includes("rm"), "container was removed explicitly");
  });

  for (const stage of ["install", "build", "test"] as const) {
    it(`failure: ${stage} exits nonzero`, async () => {
      const env = makeEnv();
      const fake = new FakeDocker();
      fake.behaviour = driverResult(report(stage));
      const r = await pipeline(fake, env).run(req);
      assert.equal(r.status, "failure");
      assert.equal(r.reason, `${stage}-failed`);
      assert.equal(r.failedStage, stage);
      assert.equal(r.exitCode, 1);
      assert.equal(r.cleanup?.confirmed, true);
      assert.equal(r.stages?.at(-1)?.status, stage === "test" ? "failed" : "skipped");
    });
  }

  for (const reason of ["timeout", "output-limit", "spawn-error"] as const) {
    it(`inconclusive: a ${reason} inside the container is not-run, never failure`, async () => {
      const env = makeEnv();
      const fake = new FakeDocker();
      fake.behaviour = driverResult(report("build", { reason }));
      const r = await pipeline(fake, env).run(req);
      assert.equal(r.status, "not-run");
      assert.equal(r.reason, "stage-inconclusive");
      assert.equal(r.failedStage, "build");
    });
  }

  it("prepare refusal (for example a symlink in the mount) is not-run", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    fake.behaviour = driverResult(report("prepare", { reason: "refused" }));
    const r = await pipeline(fake, env).run(req);
    assert.equal(r.status, "not-run");
    assert.equal(r.reason, "stage-inconclusive");
  });

  it("driver cancelled: not-run", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    fake.behaviour = driverResult(report("install", { reason: "cancelled" }));
    const r = await pipeline(fake, env).run(req);
    assert.equal(r.status, "not-run");
    assert.equal(r.reason, "driver-cancelled");
  });

  it("npm summary missing or different from the lock count is not-run", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    fake.behaviour = driverResult(report(null, { installTail: "" }));
    assert.equal((await pipeline(fake, env).run(req)).reason, "summary-mismatch");
    fake.behaviour = driverResult(report(null, { installTail: "\nadded 2 packages in 1s\n" }));
    const r = await pipeline(fake, env).run({ ...req, executionId: "pipefix-aaa:2" });
    assert.equal(r.status, "not-run");
    assert.equal(r.reason, "summary-mismatch");
    assert.equal(r.packagesAdded, 2);
  });

  it("docker timeout and cancel mid-run are not-run with confirmed cleanup", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    fake.behaviour = res({ exitCode: null, timedOut: true });
    const t = await pipeline(fake, env).run(req);
    assert.equal(t.status, "not-run");
    assert.equal(t.reason, "timed-out");
    assert.equal(t.cleanup?.confirmed, true);
    fake.behaviour = res({ exitCode: null, aborted: true });
    const a = await pipeline(fake, env).run({ ...req, executionId: "pipefix-aaa:2" });
    assert.equal(a.reason, "aborted");
    assert.equal(a.cleanup?.confirmed, true);
  });

  it("docker unavailable and isolation mismatch are not-run; a mismatch never starts the container", async () => {
    const env = makeEnv();
    const down = new FakeDocker();
    down.versionResult = res({ exitCode: 1, stderr: "cannot connect" });
    const d = await pipeline(down, env).run(req);
    assert.equal(d.reason, "docker-unavailable");
    assert.ok(!down.verbs().includes("create"));

    const bad = new FakeDocker();
    bad.tamper = (doc) => { doc.HostConfig["NetworkMode"] = "bridge"; };
    const b = await pipeline(bad, env).run({ ...req, executionId: "pipefix-aaa:2" });
    assert.equal(b.status, "not-run");
    assert.equal(b.reason, "isolation-violation");
    assert.ok(!bad.verbs().includes("start"));
    assert.deepEqual(readdirSync(env.staging), []);
  });

  it("a missing /work tmpfs in the inspect output is an isolation violation", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    fake.tamper = (doc) => { delete (doc.HostConfig["Tmpfs"] as Record<string, string>)["/work"]; };
    const r = await pipeline(fake, env).run(req);
    assert.equal(r.reason, "isolation-violation");
    assert.ok(!fake.verbs().includes("start"));
  });

  it("unconfirmed cleanup downgrades success and failure to not-run", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    fake.rmRemoves = false;
    const s = await pipeline(fake, env).run(req);
    assert.equal(s.status, "not-run");
    assert.equal(s.reason, "cleanup-unconfirmed");
    assert.equal(s.cleanup?.confirmed, false);

    fake.behaviour = driverResult(report("build"));
    const f = await pipeline(fake, env).run({ ...req, executionId: "pipefix-aaa:2" });
    assert.equal(f.status, "not-run");
    assert.equal(f.reason, "cleanup-unconfirmed");
  });
});

describe("protocol handling in the host", () => {
  const okLine = lineOf(report(null));

  const bads: Array<[string, ProcessResult, string]> = [
    ["truncated output", res({ stdout: okLine, truncated: true }), "output-truncated"],
    ["truncated even with a failing exit", res({ exitCode: 1, stdout: okLine, truncated: true }), "output-truncated"],
    ["empty output", res({ stdout: "" }), "protocol-error"],
    ["driver internal error exit", res({ exitCode: 70 }), "driver-error"],
    ["container killed (exit 137)", res({ exitCode: 137, stdout: okLine }), "driver-error"],
    ["text before the JSON", res({ stdout: `hello\n${okLine}` }), "protocol-error"],
    ["two JSON lines", res({ stdout: okLine + okLine }), "protocol-error"],
    ["no trailing newline", res({ stdout: okLine.trimEnd() }), "protocol-error"],
    ["not JSON", res({ stdout: "passed\n" }), "protocol-error"],
    ["output on stderr", res({ stdout: okLine, stderr: "warning" }), "protocol-error"],
    ["exit 1 with a passed report", res({ exitCode: 1, stdout: okLine }), "protocol-error"],
    ["exit 0 with a failed report", res({ exitCode: 0, stdout: lineOf(report("build")) }), "protocol-error"],
  ];
  for (const [label, result, reason] of bads) {
    it(`${label}: not-run ${reason}`, async () => {
      const env = makeEnv();
      const fake = new FakeDocker();
      fake.behaviour = result;
      const r = await pipeline(fake, env).run(req);
      assert.equal(r.status, "not-run");
      assert.equal(r.reason, reason);
      assert.equal(r.cleanup?.confirmed, true, "container is still cleaned up");
      assert.deepEqual(readdirSync(env.staging), []);
    });
  }

  it("a test stage reported not-run although test.mjs was staged is not-run", async () => {
    const env = makeEnv();
    const fake = new FakeDocker();
    fake.behaviour = driverResult(report(null, { testPresent: false }));
    const r = await pipeline(fake, env).run(req);
    assert.equal(r.status, "not-run");
    assert.equal(r.reason, "protocol-error");
  });
});

describe("parseProtocolOutput (strict)", () => {
  const good = (): Record<string, unknown> => JSON.parse(lineOf(report(null))) as Record<string, unknown>;
  const enc = (o: unknown): string => `${JSON.stringify(o)}\n`;
  const stagesOf = (o: Record<string, unknown>): Array<Record<string, unknown>> => o["stages"] as Array<Record<string, unknown>>;

  it("accepts a valid report", () => {
    const p = parseProtocolOutput(lineOf(report(null)), true);
    assert.equal(p.ok, true);
  });

  it("rejects unknown keys, a wrong protocol id, wrong stage order and a wrong stage count", () => {
    const a = good(); a["extra"] = 1;
    assert.equal(parseProtocolOutput(enc(a), true).ok, false);
    const b = good(); b["protocol"] = "other/1";
    assert.equal(parseProtocolOutput(enc(b), true).ok, false);
    const c = good(); stagesOf(c).reverse();
    assert.equal(parseProtocolOutput(enc(c), true).ok, false);
    const d = good(); stagesOf(d).pop();
    assert.equal(parseProtocolOutput(enc(d), true).ok, false);
    const e = good(); (stagesOf(e)[1] as Record<string, unknown>)["extra"] = true;
    assert.equal(parseProtocolOutput(enc(e), true).ok, false);
  });

  it("rejects invalid field types, oversized tails and a reason on a non-failed stage", () => {
    const a = good(); (stagesOf(a)[0] as Record<string, unknown>)["durationMs"] = "5";
    assert.equal(parseProtocolOutput(enc(a), true).ok, false);
    const b = good(); (stagesOf(b)[1] as Record<string, unknown>)["stdoutTail"] = "x".repeat(2000);
    assert.equal(parseProtocolOutput(enc(b), true).ok, false);
    const c = good(); (stagesOf(c)[2] as Record<string, unknown>)["reason"] = "exit-code";
    assert.equal(parseProtocolOutput(enc(c), true).ok, false);
    const d = good(); (stagesOf(d)[2] as Record<string, unknown>)["status"] = "ok";
    assert.equal(parseProtocolOutput(enc(d), true).ok, false);
  });

  it("rejects contradictory statuses", () => {
    const a = good(); a["status"] = "failed";
    assert.equal(parseProtocolOutput(enc(a), true).ok, false);
    const b = JSON.parse(lineOf(report("build"))) as Record<string, unknown>; b["status"] = "passed";
    assert.equal(parseProtocolOutput(enc(b), true).ok, false);
    // a stage that ran after a failure
    const c = JSON.parse(lineOf(report("build"))) as Record<string, unknown>;
    (stagesOf(c)[3] as Record<string, unknown>)["status"] = "passed";
    assert.equal(parseProtocolOutput(enc(c), true).ok, false);
    // exit-code failure without a nonzero exit code
    const d = JSON.parse(lineOf(report("build"))) as Record<string, unknown>;
    (stagesOf(d)[2] as Record<string, unknown>)["exitCode"] = 0;
    assert.equal(parseProtocolOutput(enc(d), true).ok, false);
    // skipped without a prior failure
    const e = good(); (stagesOf(e)[3] as Record<string, unknown>)["status"] = "skipped";
    assert.equal(parseProtocolOutput(enc(e), true).ok, false);
  });

  it("requires not-run for the test stage exactly when no test file was staged", () => {
    assert.equal(parseProtocolOutput(lineOf(report(null)), false).ok, false);
    assert.equal(parseProtocolOutput(lineOf(report(null, { testPresent: false })), false).ok, true);
    assert.equal(parseProtocolOutput(lineOf(report(null, { testPresent: false })), true).ok, false);
  });

  it("never throws on junk input", () => {
    for (const junk of ["", "\n", "null\n", "[]\n", "{}\n", '{"protocol":1}\n', "\u0000\n", "x".repeat(200_000) + "\n"]) {
      assert.equal(parseProtocolOutput(junk, true).ok, false);
    }
    assert.equal(parseProtocolOutput(undefined as unknown as string, true).ok, false);
  });
});

describe("classifyPipeline", () => {
  it("maps sandbox outcomes that never ran the driver to not-run", () => {
    for (const [r, reason] of [
      [{ kind: "unavailable", reason: "x", cleanup: null }, "docker-unavailable"],
      [{ kind: "rejected", reason: "x", cleanup: null }, "rejected"],
      [{ kind: "isolation-violation", reason: "x", cleanup: null }, "isolation-violation"],
    ] as const) {
      const v = classifyPipeline(r, 1, true);
      assert.equal(v.status, "not-run");
      assert.equal(v.reason, reason);
    }
  });
});

describe("controlled fixture scripts", () => {
  it("are generated for each kind; only no-tests lacks test.mjs; none touch the network or spawn processes", () => {
    for (const kind of PIPELINE_FIXTURE_KINDS) {
      const files = pipelineFixtureScripts(kind);
      assert.ok(files["build.mjs"]);
      assert.equal("test.mjs" in files, kind !== "no-tests");
      for (const content of Object.values(files)) {
        assert.ok(!/child_process|node:net|node:http|fetch\(|process\.env|eval\(/.test(content), kind);
      }
    }
    assert.ok(/intentional build failure/.test(pipelineFixtureScripts("fail-build")["build.mjs"] as string));
  });
});

describe("driver protocol (real compiled file, no fixture mounts)", () => {
  it("encodeProtocolLine writes one bounded line with only known keys", () => {
    const long = "é\n\"".repeat(2000);
    const line = encodeProtocolLine({
      status: "failed",
      stages: [
        { stage: "prepare", status: "passed", durationMs: 1 },
        { stage: "install", status: "failed", reason: "exit-code", exitCode: 1, durationMs: 2, stdoutTail: long, stderrTail: long },
        { stage: "build", status: "skipped", durationMs: 0 },
        { stage: "test", status: "skipped", durationMs: 0 },
      ],
    });
    assert.ok(line.endsWith("\n"));
    assert.equal(line.indexOf("\n"), line.length - 1);
    const doc = JSON.parse(line) as { protocol: string; stages: Array<{ stdoutTail?: string }> };
    assert.equal(doc.protocol, PROTOCOL_ID);
    assert.ok((doc.stages[1]?.stdoutTail?.length ?? 0) <= PROTOCOL_TAIL_CHARS);
    assert.ok(line.length < 100 * 1024);
    assert.equal(parseProtocolOutput(line, true).ok, true);
  });

  it("running the compiled file prints exactly one valid line and exits 1 when /fixture is absent", (t) => {
    if (existsSync("/fixture") || existsSync("/work")) {
      t.skip("/fixture or /work exists on this machine; not running the default-path driver");
      return;
    }
    const file = fileURLToPath(new URL("../fixture-pipeline-driver.js", import.meta.url));
    const r = spawnSync(process.execPath, [file], { encoding: "utf8", shell: false, timeout: 30_000, windowsHide: true });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, "");
    const p = parseProtocolOutput(r.stdout, false);
    assert.equal(p.ok, true, p.ok ? "" : p.problem);
    assert.equal(p.ok && p.stages[0]?.status, "failed");
    assert.deepEqual(p.ok && p.stages.slice(1).map((s) => s.status), ["skipped", "skipped", "skipped"]);
  });
});
