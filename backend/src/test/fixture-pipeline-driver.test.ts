/**
 * fixture-pipeline-driver.test.ts — driver tests with an INJECTED process runner. Copy tests use
 * real temporary directories under os.tmpdir(). No npm is run. Two tests exercise the default
 * runner with the current node binary (no shell) to check timeout and output-limit handling.
 *
 * Unverified until run: these tests were written without being executed.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_NPM_CONFIG_NAME,
  EMPTY_NPM_GLOBALCONFIG_NAME,
  runFixturePipeline,
  runProcess,
  type ProcessOutcome,
  type ProcessRunner,
  type ProcessSpec,
} from "../fixture-pipeline-driver.js";

const ok = (p: Partial<ProcessOutcome> = {}): ProcessOutcome => ({
  exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, ...p,
});

let root: string;
let src: string;
let work: string;
let cache: string;

function seed(files: Record<string, string> = {}): void {
  const all = { "package.json": "{}", "package-lock.json": "{}", "build.mjs": "//b", "test.mjs": "//t", ...files };
  for (const [k, v] of Object.entries(all)) writeFileSync(join(src, k), v);
}

function recorder(outcomes: Partial<Record<"npm" | "node-build" | "node-test", ProcessOutcome>> = {}) {
  const calls: ProcessSpec[] = [];
  const runner: ProcessRunner = async (spec) => {
    calls.push(spec);
    const key = spec.command === "npm" ? "npm" : spec.args[0] === "--test" ? "node-test" : "node-build";
    return outcomes[key] ?? ok();
  };
  return { calls, runner };
}

const opts = () => ({ sourceDir: src, workDir: work, cacheDir: cache });
const statuses = (r: { stages: { stage: string; status: string }[] }) =>
  r.stages.map((s) => `${s.stage}:${s.status}`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpd-"));
  src = join(root, "fixture");
  work = join(root, "work");
  cache = join(root, "npm-cache");
  for (const d of [src, work, cache]) mkdirSync(d);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("fixture pipeline driver: happy path and fixed commands", () => {
  it("passes all stages and runs only the fixed commands without a shell", async () => {
    seed();
    const { calls, runner } = recorder();
    const r = await runFixturePipeline({ ...opts(), runner });
    assert.equal(r.status, "passed");
    assert.deepEqual(statuses(r), ["prepare:passed", "install:passed", "build:passed", "test:passed"]);
    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.equal(c.cwd, work);
      assert.ok(c.timeoutMs > 0 && c.maxOutputBytes > 0);
      assert.ok(!("shell" in c));
    }
    const [npm, build, test] = calls as [ProcessSpec, ProcessSpec, ProcessSpec];
    assert.equal(npm.command, "npm");
    for (const a of ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"]) {
      assert.ok(npm.args.includes(a), a);
    }
    const cfg = join(work, EMPTY_NPM_CONFIG_NAME);
    const gcfg = join(work, EMPTY_NPM_GLOBALCONFIG_NAME);
    assert.notEqual(cfg, gcfg);
    assert.equal(npm.args[npm.args.indexOf("--userconfig") + 1], cfg);
    assert.equal(npm.args[npm.args.indexOf("--globalconfig") + 1], gcfg);
    assert.equal(npm.args[npm.args.indexOf("--cache") + 1], cache);
    assert.equal(readFileSync(cfg, "utf8"), "");
    assert.equal(readFileSync(gcfg, "utf8"), "");
    assert.equal(build.command, "node");
    assert.deepEqual(build.args, ["build.mjs", join(work, "out")]);
    assert.deepEqual(test.args, ["--test", "test.mjs"]);
  });

  it("copies the allowlisted files only and gives processes a minimal env", async () => {
    seed({ "evil.mjs": "x" });
    process.env["SECRET_TOKEN_FOR_TEST"] = "s3cret";
    const { calls, runner } = recorder();
    await runFixturePipeline({ ...opts(), runner });
    delete process.env["SECRET_TOKEN_FOR_TEST"];
    assert.ok(existsSync(join(work, "build.mjs")));
    assert.ok(!existsSync(join(work, "evil.mjs")));
    for (const c of calls) {
      assert.ok(!("SECRET_TOKEN_FOR_TEST" in c.env));
      assert.equal(c.env["NPM_CONFIG_USERCONFIG"], join(work, EMPTY_NPM_CONFIG_NAME));
    }
  });
});

describe("fixture pipeline driver: failures and strict skipping", () => {
  it("install failure skips build and test", async () => {
    seed();
    const { calls, runner } = recorder({ npm: ok({ exitCode: 1, stderr: "boom" }) });
    const r = await runFixturePipeline({ ...opts(), runner });
    assert.equal(r.status, "failed");
    assert.deepEqual(statuses(r), ["prepare:passed", "install:failed", "build:skipped", "test:skipped"]);
    assert.equal(r.stages[1]?.reason, "exit-code");
    assert.equal(r.stages[1]?.stderrTail, "boom");
    assert.equal(calls.length, 1);
  });

  it("build failure skips test", async () => {
    seed();
    const { calls, runner } = recorder({ "node-build": ok({ exitCode: 1 }) });
    const r = await runFixturePipeline({ ...opts(), runner });
    assert.deepEqual(statuses(r), ["prepare:passed", "install:passed", "build:failed", "test:skipped"]);
    assert.equal(calls.length, 2);
  });

  it("test failure is reported as failed", async () => {
    seed();
    const { runner } = recorder({ "node-test": ok({ exitCode: 1 }) });
    const r = await runFixturePipeline({ ...opts(), runner });
    assert.equal(r.status, "failed");
    assert.equal(r.stages[3]?.status, "failed");
  });

  it("a signal-terminated process is a failure even without an exit code", async () => {
    seed();
    const { runner } = recorder({ npm: ok({ exitCode: null, signal: "SIGKILL" }) });
    const r = await runFixturePipeline({ ...opts(), runner });
    assert.equal(r.stages[1]?.status, "failed");
    assert.equal(r.stages[1]?.reason, "exit-code");
  });

  it("timeout, output limit and spawn error are failures with distinct reasons", async () => {
    const cases: [Partial<ProcessOutcome>, string][] = [
      [{ timedOut: true, exitCode: null, signal: "SIGKILL" }, "timeout"],
      [{ truncated: true, exitCode: null, signal: "SIGKILL" }, "output-limit"],
      [{ truncated: true, exitCode: 0 }, "output-limit"],
      [{ spawnError: "ENOENT", exitCode: null }, "spawn-error"],
    ];
    for (const [outcome, reason] of cases) {
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work);
      seed();
      const { runner } = recorder({ "node-build": ok(outcome) });
      const r = await runFixturePipeline({ ...opts(), runner });
      assert.equal(r.status, "failed");
      assert.equal(r.stages[2]?.status, "failed");
      assert.equal(r.stages[2]?.reason, reason);
      assert.equal(r.stages[3]?.status, "skipped");
    }
  });

  it("an exit code 0 with a timeout flag is still a failure", async () => {
    seed();
    const { runner } = recorder({ "node-test": ok({ timedOut: true }) });
    const r = await runFixturePipeline({ ...opts(), runner });
    assert.equal(r.stages[3]?.reason, "timeout");
  });

  it("passes configured limits through and ignores invalid ones", async () => {
    seed();
    const { calls, runner } = recorder();
    await runFixturePipeline({
      ...opts(), runner, installTimeoutMs: 11, buildTimeoutMs: 22, testTimeoutMs: -5, maxOutputBytes: 333,
    });
    assert.equal(calls[0]?.timeoutMs, 11);
    assert.equal(calls[1]?.timeoutMs, 22);
    assert.ok((calls[2]?.timeoutMs ?? 0) > 0 && calls[2]?.timeoutMs !== -5);
    for (const c of calls) assert.equal(c.maxOutputBytes, 333);
  });

  it("bounds the output tails", async () => {
    seed();
    const { runner } = recorder({ npm: ok({ exitCode: 1, stdout: "x".repeat(100_000) }) });
    const r = await runFixturePipeline({ ...opts(), runner });
    assert.ok((r.stages[1]?.stdoutTail?.length ?? 0) <= 4096);
  });
});

describe("fixture pipeline driver: missing tests", () => {
  it("missing test.mjs is not-run and the pipeline still passes", async () => {
    seed();
    rmSync(join(src, "test.mjs"));
    const { calls, runner } = recorder();
    const r = await runFixturePipeline({ ...opts(), runner });
    assert.equal(r.status, "passed");
    assert.deepEqual(statuses(r), ["prepare:passed", "install:passed", "build:passed", "test:not-run"]);
    assert.equal(calls.length, 2);
  });

  it("refuses and runs no test when the build overwrites the copied test.mjs", async () => {
    seed();
    const calls: ProcessSpec[] = [];
    const runner: ProcessRunner = async (spec) => {
      calls.push(spec);
      if (spec.command === "node" && spec.args[0] === "build.mjs") {
        writeFileSync(join(work, "test.mjs"), "// tampered by build");
      }
      return ok();
    };
    const r = await runFixturePipeline({ ...opts(), runner });
    assert.equal(r.status, "failed");
    assert.deepEqual(statuses(r), ["prepare:passed", "install:passed", "build:passed", "test:failed"]);
    assert.equal(r.stages[3]?.reason, "refused");
    assert.equal(calls.length, 2);
    assert.ok(!calls.some((c) => c.args[0] === "--test"));
  });

  it("missing tests after a build failure is skipped, not not-run", async () => {
    seed();
    rmSync(join(src, "test.mjs"));
    const { runner } = recorder({ "node-build": ok({ exitCode: 1 }) });
    const r = await runFixturePipeline({ ...opts(), runner });
    assert.equal(r.stages[3]?.status, "skipped");
  });
});

describe("fixture pipeline driver: prepare refusals", () => {
  it("refuses a missing required file and runs nothing", async () => {
    seed();
    rmSync(join(src, "package-lock.json"));
    const { calls, runner } = recorder();
    const r = await runFixturePipeline({ ...opts(), runner });
    assert.deepEqual(statuses(r), ["prepare:failed", "install:skipped", "build:skipped", "test:skipped"]);
    assert.equal(r.stages[0]?.reason, "refused");
    assert.equal(calls.length, 0);
  });

  it("refuses a symlinked fixture file", async (t) => {
    seed();
    rmSync(join(src, "build.mjs"));
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "top secret");
    try {
      symlinkSync(secret, join(src, "build.mjs"));
    } catch {
      t.skip("symlinks unavailable on this platform");
      return;
    }
    const { calls, runner } = recorder();
    const r = await runFixturePipeline({ ...opts(), runner });
    assert.equal(r.stages[0]?.status, "failed");
    assert.equal(r.stages[0]?.reason, "refused");
    assert.match(r.stages[0]?.detail ?? "", /symlink/);
    assert.ok(!existsSync(join(work, "build.mjs")) || readFileSync(join(work, "build.mjs"), "utf8") !== "top secret");
    assert.equal(calls.length, 0);
  });

  it("refuses a symlinked optional test file instead of treating it as missing", async (t) => {
    seed();
    rmSync(join(src, "test.mjs"));
    const target = join(root, "t.txt");
    writeFileSync(target, "x");
    try {
      symlinkSync(target, join(src, "test.mjs"));
    } catch {
      t.skip("symlinks unavailable on this platform");
      return;
    }
    const { runner } = recorder();
    const r = await runFixturePipeline({ ...opts(), runner });
    assert.equal(r.stages[0]?.reason, "refused");
  });

  it("refuses a directory in place of a file and an oversized file", async () => {
    seed();
    rmSync(join(src, "build.mjs"));
    mkdirSync(join(src, "build.mjs"));
    let r = await runFixturePipeline({ ...opts(), runner: recorder().runner });
    assert.equal(r.stages[0]?.reason, "refused");

    rmSync(join(src, "build.mjs"), { recursive: true });
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work);
    seed({ "build.mjs": "x".repeat(300 * 1024) });
    r = await runFixturePipeline({ ...opts(), runner: recorder().runner });
    assert.equal(r.stages[0]?.reason, "refused");
  });

  it("refuses a symlinked source directory", async (t) => {
    seed();
    const link = join(root, "fixture-link");
    try {
      symlinkSync(src, link, "dir");
    } catch {
      t.skip("symlinks unavailable on this platform");
      return;
    }
    const r = await runFixturePipeline({ sourceDir: link, workDir: work, cacheDir: cache, runner: recorder().runner });
    assert.equal(r.stages[0]?.reason, "refused");
  });

  it("does not overwrite files already present in the work dir", async () => {
    seed();
    writeFileSync(join(work, "build.mjs"), "preexisting");
    const { calls, runner } = recorder();
    const r = await runFixturePipeline({ ...opts(), runner });
    assert.equal(r.stages[0]?.reason, "io-error");
    assert.equal(readFileSync(join(work, "build.mjs"), "utf8"), "preexisting");
    assert.equal(calls.length, 0);
  });
});

describe("fixture pipeline driver: cancellation", () => {
  it("an already-aborted signal runs nothing", async () => {
    seed();
    const ac = new AbortController();
    ac.abort();
    const { calls, runner } = recorder();
    const r = await runFixturePipeline({ ...opts(), runner, signal: ac.signal });
    assert.equal(r.status, "cancelled");
    assert.equal(calls.length, 0);
    assert.deepEqual(statuses(r), ["prepare:failed", "install:skipped", "build:skipped", "test:skipped"]);
  });

  it("aborting during build cancels it and skips test", async () => {
    seed();
    const ac = new AbortController();
    const calls: ProcessSpec[] = [];
    const runner: ProcessRunner = async (spec) => {
      calls.push(spec);
      if (spec.args[0] === "build.mjs") {
        ac.abort();
        return ok({ aborted: true, exitCode: null, signal: "SIGKILL" });
      }
      return ok();
    };
    const r = await runFixturePipeline({ ...opts(), runner, signal: ac.signal });
    assert.equal(r.status, "cancelled");
    assert.deepEqual(statuses(r), ["prepare:passed", "install:passed", "build:failed", "test:skipped"]);
    assert.equal(r.stages[2]?.reason, "cancelled");
    assert.equal(calls.length, 2);
  });
});

describe("fixture pipeline driver: default runner (no shell)", () => {
  const base = (args: string[], extra: Partial<ProcessSpec> = {}): ProcessSpec => ({
    command: "node", args, cwd: tmpdir(), env: { PATH: process.env["PATH"] ?? "" },
    timeoutMs: 10_000, maxOutputBytes: 1024, ...extra,
  });
  // The default runner always spawns by name; point PATH at node's directory-independent lookup.
  const node = (spec: ProcessSpec): ProcessSpec => spec;

  it("kills a process that exceeds its timeout", async () => {
    const o = await runProcess(node(base(["-e", "setTimeout(()=>{}, 60000)"], { timeoutMs: 300 })));
    assert.equal(o.timedOut, true);
    assert.equal(o.exitCode, null);
  });

  it("kills a process that exceeds the output limit", async () => {
    const o = await runProcess(
      node(base(["-e", "setInterval(()=>process.stdout.write('x'.repeat(500)), 5)"], { maxOutputBytes: 1000 })),
    );
    assert.equal(o.truncated, true);
    assert.ok(o.stdout.length <= 1000);
  });

  it("aborts on signal", async () => {
    const ac = new AbortController();
    const p = runProcess(node(base(["-e", "setTimeout(()=>{}, 60000)"], { signal: ac.signal })));
    setTimeout(() => ac.abort(), 200);
    const o = await p;
    assert.equal(o.aborted, true);
  });

  it("does not interpret shell metacharacters", async () => {
    const o = await runProcess(node(base(["-p", "process.argv[1]", "a; echo injected"])));
    assert.equal(o.exitCode, 0);
    assert.equal(o.stdout.trim(), "a; echo injected");
  });
});
