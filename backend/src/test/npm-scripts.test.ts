/**
 * npm-scripts.test.ts — focused regression tests for the security boundary of the opt-in npm-scripts
 * mode: the profile policy and manifest sanitizer, the bounded snapshot export, the in-container
 * driver (run here with a fake process runner on temporary directories), the host pipeline's
 * pre-flight refusals, the runner wiring (through the real GithubJobRunner with fakes) and the
 * configuration switch.
 *
 * No Docker, no network, no git, no npm and no repository code runs here. Written without running
 * the compiler or this file; it shows nothing about the real flow against Docker or GitHub.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildGitArchiveTar } from "../archive-handoff.js";
import { createRunDir } from "../fixture-workspace.js";
import { PROTOCOL_ID, type ProcessOutcome, type ProcessRunner, type ProcessSpec, type StageResult as DriverStage } from "../fixture-pipeline-driver.js";
import { parseProtocolOutput, type ControlledPipelineResult, type PipelineRequest } from "../controlled-pipeline.js";
import type { ProcessExecutor } from "../docker-sandbox.js";
import type { AcquisitionRequest, AcquisitionResult, HandoffInfo } from "../git-acquisition.js";
import type { RootFiles } from "../github-analysis.js";
import { GithubJobRunner, type GitLike, type NpmScriptsOptions, type RegistryLike } from "../github-runner.js";
import type { RegistryAcquisitionRequest, RegistryAcquisitionResult } from "../npm-registry-acquisition.js";
import {
  SCRIPTS_DRIVER_NAME,
  SCRIPTS_INSTALL_MANIFEST_NAME,
  SCRIPTS_PROTOCOL_ID,
  encodeScriptsProtocolLine,
  runScriptsPipeline,
} from "../npm-scripts-driver.js";
import { NpmScriptsPipeline } from "../npm-scripts-pipeline.js";
import { declaresScripts, planNpmScripts } from "../npm-scripts-policy.js";
import {
  SNAPSHOT_LIMITS,
  exportSnapshot,
  scanSnapshotArchive,
  type BytesExecutor,
  type BytesOptions,
  type BytesResult,
  type SnapshotOutcome,
} from "../npm-scripts-snapshot.js";
import type { Diagnosis, PatchProposal } from "../agent-contract.js";
import type { AgentOutcome, AnalystRequest, FixerRequest } from "../kiro-agent.js";
import type { AgentsLike, PipelineLike } from "../pipeline-runner.js";
import { presentResult } from "../result-view.js";
import type { CleanupProof, JobRunner, RunContext } from "../runner.js";
import { WorkerConfigError, loadWorkerConfig } from "../worker-config.js";
import { operatorDoc, textsOf, type OperatorDoc } from "./operator-fixture-helpers.js";

const REPO = "https://github.com/o/r";
const COMMIT = "a".repeat(40);
const SNAPSHOT_NAME = "src-0123456789ab";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "graveyard-npm-scripts-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

function scriptsDoc(scripts: Record<string, unknown> = {}): OperatorDoc {
  const d = operatorDoc();
  d.pkg["scripts"] = { build: "node build.js", test: "node --test", ...scripts };
  return d;
}

const okProof = (executionId: string): CleanupProof => ({ confirmed: true, executionId, evidence: "fake docker: nothing carries this id" });
const codesOf = (plan: ReturnType<typeof planNpmScripts>): string[] => (plan.ok ? [] : plan.findings.map((f) => f.code));

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe("npm scripts policy", () => {
  it("accepts the profile and sanitizes by removing exactly the scripts key", () => {
    const t = textsOf(scriptsDoc());
    const plan = planNpmScripts(t, { dependencyAcquisition: true });
    if (!plan.ok) return assert.fail(`expected acceptance: ${JSON.stringify(plan.findings)}`);
    const expected = JSON.parse(t.packageJson) as Record<string, unknown>;
    delete expected["scripts"];
    assert.deepEqual(JSON.parse(plan.sanitizedPackageJson), expected);
    assert.equal(plan.sanitizedPackageJson.includes("scripts"), false);
    assert.equal(plan.expectedPackages, 3);
    assert.equal(plan.buildScript, "node build.js");
    assert.equal(plan.testScript, "node --test");
    assert.notEqual(plan.originalPackageJsonSha256, plan.sanitizedPackageJsonSha256);
  });

  it("refuses a missing, placeholder or unusable build and test script", () => {
    const noTest = scriptsDoc();
    delete (noTest.pkg["scripts"] as Record<string, unknown>)["test"];
    assert.deepEqual(codesOf(planNpmScripts(textsOf(noTest), { dependencyAcquisition: true })), ["no-test-script"]);

    const placeholder = scriptsDoc({ test: 'echo "Error: no test specified" && exit 1' });
    assert.deepEqual(codesOf(planNpmScripts(textsOf(placeholder), { dependencyAcquisition: true })), ["placeholder-test-script"]);

    const multiline = scriptsDoc({ build: "node a.js\nnode b.js" });
    assert.deepEqual(codesOf(planNpmScripts(textsOf(multiline), { dependencyAcquisition: true })), ["script-not-supported"]);

    const noScripts = operatorDoc();
    assert.deepEqual(codesOf(planNpmScripts(textsOf(noScripts), { dependencyAcquisition: true })), ["no-build-script"]);
  });

  it("refuses lifecycle hooks of the named scripts because --ignore-scripts would skip them", () => {
    for (const hook of ["prebuild", "postbuild", "pretest", "posttest"]) {
      const codes = codesOf(planNpmScripts(textsOf(scriptsDoc({ [hook]: "node x.js" })), { dependencyAcquisition: true }));
      assert.deepEqual(codes, ["lifecycle-hook-script"], hook);
    }
  });

  it("refuses install-time scripts, extra manifest fields and dev dependencies through the existing lock policy", () => {
    for (const bad of [{ postinstall: "node x.js" }, { prepare: "node x.js" }, { preinstall: "node x.js" }]) {
      const codes = codesOf(planNpmScripts(textsOf(scriptsDoc(bad)), { dependencyAcquisition: true }));
      assert.ok(codes.length > 0 && codes.every((c) => c === "dependency-policy-rejected"), JSON.stringify(bad));
    }
    const withType = scriptsDoc();
    withType.pkg["type"] = "module";
    assert.ok(codesOf(planNpmScripts(textsOf(withType), { dependencyAcquisition: true })).includes("dependency-policy-rejected"));
    const withDev = scriptsDoc();
    withDev.pkg["devDependencies"] = { typescript: "^5.0.0" };
    assert.ok(codesOf(planNpmScripts(textsOf(withDev), { dependencyAcquisition: true })).includes("dependency-policy-rejected"));
  });

  it("reports an otherwise supported repository as not runnable without registry egress", () => {
    assert.deepEqual(codesOf(planNpmScripts(textsOf(scriptsDoc()), { dependencyAcquisition: false })), ["dependency-acquisition-not-configured"]);
  });

  it("refuses missing files and detects declared scripts without throwing", () => {
    const t = textsOf(scriptsDoc());
    assert.deepEqual(codesOf(planNpmScripts({ packageJson: null, packageLock: t.packageLock }, { dependencyAcquisition: true })), ["no-package-json"]);
    assert.deepEqual(codesOf(planNpmScripts({ packageJson: t.packageJson, packageLock: null }, { dependencyAcquisition: true })), ["no-package-lock"]);
    assert.deepEqual(codesOf(planNpmScripts({ packageJson: "{nope", packageLock: t.packageLock }, { dependencyAcquisition: true })), ["package-json-unparsable"]);
    assert.equal(declaresScripts(t.packageJson), true);
    assert.equal(declaresScripts(textsOf(operatorDoc()).packageJson), false);
    assert.equal(declaresScripts("{nope"), false);
    assert.equal(declaresScripts(null), false);
  });
});

// ---------------------------------------------------------------------------
// Snapshot export
// ---------------------------------------------------------------------------

describe("npm scripts snapshot export", () => {
  const texts = textsOf(scriptsDoc());
  const goodFiles = (): Record<string, string> => ({
    "package.json": texts.packageJson,
    "package-lock.json": texts.packageLock,
    "build.js": "console.log('built');\n",
    "src/index.js": "module.exports = 1;\n",
    "test/index.test.js": "require('node:test');\n",
  });
  const infoFor = (files: Record<string, string>, extra: Partial<HandoffInfo> = {}): HandoffInfo => ({
    containerName: "graveyard-acq-job1_1",
    commit: COMMIT,
    manifest: {
      files: Object.keys(files).length,
      totalBytes: Object.values(files).reduce((n, s) => n + Buffer.byteLength(s, "utf8"), 0),
      submodulesSkipped: 0,
    },
    dockerBinary: "docker",
    remainingMs: 100_000,
    ...extra,
  });
  const execReturning = (
    r: Partial<BytesResult>,
    calls: Array<{ file: string; args: readonly string[]; options: BytesOptions }> = [],
  ): BytesExecutor => (file, args, options) => {
    calls.push({ file, args, options });
    return Promise.resolve({ exitCode: 0, stdout: Buffer.alloc(0), timedOut: false, aborted: false, truncated: false, ...r });
  };

  it("exports the pinned commit with a fixed argument array and extracts it into a new directory", async () => {
    const runDir = createRunDir(tmp);
    const files = goodFiles();
    const calls: Array<{ file: string; args: readonly string[]; options: BytesOptions }> = [];
    const out = await exportSnapshot(execReturning({ stdout: buildGitArchiveTar(files, COMMIT) }, calls), infoFor(files), runDir, texts);
    if (out.kind !== "extracted") return assert.fail(`expected extraction: ${JSON.stringify(out)}`);
    assert.match(out.name, /^src-[0-9a-f]{12}$/);
    assert.equal(out.files, 5);
    assert.equal(readFileSync(join(out.dir, "src", "index.js"), "utf8"), files["src/index.js"]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, [
      "exec", "--user", "65532:65532", "--workdir", "/work", "graveyard-acq-job1_1", "git", "archive", "--format=tar", COMMIT,
    ]);
    assert.ok((calls[0]?.options.maxBytes ?? 0) > 0);
  });

  it("refuses names and shapes outside the profile before anything is written", async () => {
    const cases: Record<string, Record<string, string>> = {
      "root .npmrc": { ".npmrc": "registry=http://x\n" },
      "root npm-shrinkwrap.json": { "npm-shrinkwrap.json": "{}" },
      "reserved driver name": { [SCRIPTS_DRIVER_NAME]: "x" },
      "reserved manifest name": { [SCRIPTS_INSTALL_MANIFEST_NAME]: "{}" },
      "node_modules": { "node_modules/x/index.js": "x" },
      "too deep": { "a/b/c/d/e/f/x.js": "x" },
    };
    for (const [label, extra] of Object.entries(cases)) {
      const runDir = createRunDir(tmp);
      const files = { ...goodFiles(), ...extra };
      const out = await exportSnapshot(execReturning({ stdout: buildGitArchiveTar(files, COMMIT) }), infoFor(files), runDir, texts);
      assert.equal(out.kind, "refused", label);
      assert.deepEqual(readdirSync(runDir), [], `${label}: nothing may be extracted`);
    }
    const noLock = goodFiles();
    delete noLock["package-lock.json"];
    const scan = scanSnapshotArchive(buildGitArchiveTar(noLock, COMMIT), 1024 * 1024);
    assert.equal(scan.ok, false);
  });

  it("refuses oversized trees and submodules without starting an export", async () => {
    const runDir = createRunDir(tmp);
    const calls: Array<{ file: string; args: readonly string[]; options: BytesOptions }> = [];
    const exec = execReturning({}, calls);
    const files = goodFiles();
    const base = infoFor(files);
    const submodules = await exportSnapshot(exec, { ...base, manifest: { ...base.manifest, submodulesSkipped: 1 } }, runDir, texts);
    const manyFiles = await exportSnapshot(exec, { ...base, manifest: { ...base.manifest, files: SNAPSHOT_LIMITS.maxFiles + 1 } }, runDir, texts);
    const manyBytes = await exportSnapshot(exec, { ...base, manifest: { ...base.manifest, totalBytes: SNAPSHOT_LIMITS.maxTotalBytes + 1 } }, runDir, texts);
    for (const out of [submodules, manyFiles, manyBytes]) assert.equal(out.kind, "refused");
    assert.equal(calls.length, 0);
  });

  it("refuses when the archive disagrees with the git manifest or with the analysed manifests", async () => {
    const files = goodFiles();
    const wrongCount = infoFor(files);
    const r1 = await exportSnapshot(
      execReturning({ stdout: buildGitArchiveTar(files, COMMIT) }),
      { ...wrongCount, manifest: { ...wrongCount.manifest, files: wrongCount.manifest.files + 1 } },
      createRunDir(tmp),
      texts,
    );
    assert.equal(r1.kind, "refused");
    const r2 = await exportSnapshot(
      execReturning({ stdout: buildGitArchiveTar(files, "b".repeat(40)) }),
      infoFor(files),
      createRunDir(tmp),
      texts,
    );
    assert.equal(r2.kind, "refused");
    const r3 = await exportSnapshot(
      execReturning({ stdout: buildGitArchiveTar(files, COMMIT) }),
      infoFor(files),
      createRunDir(tmp),
      { packageJson: `${texts.packageJson} `, packageLock: texts.packageLock },
    );
    assert.equal(r3.kind, "refused");
  });

  it("throws on a transport failure so the acquisition fails closed as infrastructure", async () => {
    const files = goodFiles();
    const run = (r: Partial<BytesResult>): Promise<SnapshotOutcome> =>
      exportSnapshot(execReturning({ stdout: buildGitArchiveTar(files, COMMIT), ...r }), infoFor(files), createRunDir(tmp), texts);
    await assert.rejects(run({ timedOut: true }));
    await assert.rejects(run({ aborted: true }));
    await assert.rejects(run({ truncated: true }));
    await assert.rejects(run({ exitCode: 1 }));
    await assert.rejects(exportSnapshot(execReturning({}), { ...infoFor(files), commit: "main" }, createRunDir(tmp), texts));
  });
});

// ---------------------------------------------------------------------------
// In-container driver (fake process runner, temporary directories)
// ---------------------------------------------------------------------------

describe("npm scripts driver", () => {
  const doc = scriptsDoc();
  const texts = textsOf(doc);
  const sanitizedDoc = JSON.parse(texts.packageJson) as Record<string, unknown>;
  delete sanitizedDoc["scripts"];
  const sanitized = `${JSON.stringify(sanitizedDoc, null, 2)}\n`;

  function makeSource(extra: Record<string, string> = {}): { source: string; work: string } {
    const source = join(tmp, "fixture");
    const work = join(tmp, "work");
    mkdirSync(join(source, "src"), { recursive: true });
    mkdirSync(join(source, "test"), { recursive: true });
    mkdirSync(work, { recursive: true });
    const files: Record<string, string> = {
      "package.json": texts.packageJson,
      "package-lock.json": texts.packageLock,
      "src/a.js": "module.exports = 1;\n",
      "test/a.test.js": "// original test\n",
      [SCRIPTS_INSTALL_MANIFEST_NAME]: sanitized,
      [SCRIPTS_DRIVER_NAME]: "// driver\n",
      ...extra,
    };
    for (const [rel, text] of Object.entries(files)) writeFileSync(join(source, ...rel.split("/")), text);
    return { source, work };
  }

  interface Call { command: string; args: string[]; cwd: string; manifest: string }
  function recorder(onCall: (n: number, spec: ProcessSpec) => void = () => undefined, exitCodes: number[] = []): { runner: ProcessRunner; calls: Call[] } {
    const calls: Call[] = [];
    const runner: ProcessRunner = (spec) => {
      calls.push({ command: spec.command, args: [...spec.args], cwd: spec.cwd, manifest: readFileSync(join(spec.cwd, "package.json"), "utf8") });
      onCall(calls.length, spec);
      const outcome: ProcessOutcome = {
        exitCode: exitCodes[calls.length - 1] ?? 0, signal: null, stdout: "added 3 packages", stderr: "",
        timedOut: false, aborted: false, truncated: false,
      };
      return Promise.resolve(outcome);
    };
    return { runner, calls };
  }

  it("installs from the sanitized manifest, runs only the two named scripts from the original and keeps hooks disabled", async () => {
    const { source, work } = makeSource();
    const { runner, calls } = recorder();
    const result = await runScriptsPipeline({ sourceDir: source, cacheDir: join(tmp, "cache"), workDir: work, runner });
    assert.equal(result.status, "passed");
    assert.deepEqual(result.stages.map((s) => `${s.stage}:${s.status}`), ["prepare:passed", "install:passed", "build:passed", "test:passed"]);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.command === "npm" && c.args.includes("--ignore-scripts")));
    assert.deepEqual(calls[0]?.args.slice(0, 3), ["ci", "--offline", "--ignore-scripts"]);
    assert.equal(calls[0]?.manifest, sanitized);
    assert.equal(calls[0]?.manifest.includes("scripts"), false);
    assert.deepEqual(calls[1]?.args.slice(0, 3), ["run", "build", "--ignore-scripts"]);
    assert.deepEqual(calls[2]?.args.slice(0, 3), ["run", "test", "--ignore-scripts"]);
    assert.equal(calls[1]?.manifest, texts.packageJson);
    assert.equal(calls[2]?.manifest, texts.packageJson);
    const project = join(work, "project");
    assert.equal(existsSync(join(project, "src", "a.js")), true);
    assert.equal(existsSync(join(project, SCRIPTS_DRIVER_NAME)), false);
    assert.equal(existsSync(join(project, SCRIPTS_INSTALL_MANIFEST_NAME)), false);
  });

  it("speaks the existing pipeline protocol, accepted by the strict host parser", async () => {
    assert.equal(SCRIPTS_PROTOCOL_ID, PROTOCOL_ID);
    const { source, work } = makeSource();
    const result = await runScriptsPipeline({ sourceDir: source, workDir: work, cacheDir: join(tmp, "cache"), runner: recorder().runner });
    assert.equal(parseProtocolOutput(encodeScriptsProtocolLine(result), true).ok, true);
  });

  it("does not run the tests when the build rewrote a test file or the manifest", async () => {
    for (const tamper of [
      (project: string): void => writeFileSync(join(project, "test", "a.test.js"), "// rewritten by the build\n"),
      (project: string): void => writeFileSync(join(project, "package.json"), '{"scripts":{"test":"echo ok"}}\n'),
    ]) {
      rmSync(join(tmp, "fixture"), { recursive: true, force: true });
      rmSync(join(tmp, "work"), { recursive: true, force: true });
      const { source, work } = makeSource();
      const { runner, calls } = recorder((n) => {
        if (n === 2) tamper(join(work, "project"));
      });
      const result = await runScriptsPipeline({ sourceDir: source, workDir: work, cacheDir: join(tmp, "cache"), runner });
      assert.equal(calls.length, 2, "the test script must not run");
      const test = result.stages.find((s) => s.stage === "test") as DriverStage;
      assert.equal(test.status, "failed");
      assert.equal(test.reason, "refused");
      assert.equal(result.status, "failed");
    }
  });

  it("does not run the tests when the build rewrote root test.mjs or the file named by `node --test FILE`", async () => {
    const named = `${JSON.stringify({ ...(JSON.parse(texts.packageJson) as object), scripts: { build: "node build.js", test: "node --test ./check.js" } })}\n`;
    const cases: Array<{ extra: Record<string, string>; file: string }> = [
      { extra: { "test.mjs": "// original\n" }, file: "test.mjs" },
      { extra: { "package.json": named, "check.js": "// original\n" }, file: "check.js" },
    ];
    for (const c of cases) {
      rmSync(join(tmp, "fixture"), { recursive: true, force: true });
      rmSync(join(tmp, "work"), { recursive: true, force: true });
      const { source, work } = makeSource(c.extra);
      const { runner, calls } = recorder((n) => {
        if (n === 2) writeFileSync(join(work, "project", c.file), "// rewritten by the build\n");
      });
      const result = await runScriptsPipeline({ sourceDir: source, workDir: work, cacheDir: join(tmp, "cache"), runner });
      assert.equal(calls.length, 2, `${c.file}: the test script must not run`);
      const test = result.stages.find((s) => s.stage === "test") as DriverStage;
      assert.equal(test.reason, "refused", c.file);
    }
  });

  it("allows a build to change non-test files (generated output)", async () => {
    const { source, work } = makeSource();
    const { runner } = recorder((n) => {
      if (n === 2) writeFileSync(join(work, "project", "src", "a.js"), "module.exports = 2;\n");
    });
    const result = await runScriptsPipeline({ sourceDir: source, workDir: work, cacheDir: join(tmp, "cache"), runner });
    assert.equal(result.status, "passed");
  });

  it("refuses a snapshot with a symlink, a missing or scripted install manifest, and runs nothing", async () => {
    const run = async (extra: Record<string, string>, mutate?: (source: string) => void): Promise<{ status: string; calls: number; prepare: DriverStage }> => {
      rmSync(join(tmp, "fixture"), { recursive: true, force: true });
      rmSync(join(tmp, "work"), { recursive: true, force: true });
      const { source, work } = makeSource(extra);
      mutate?.(source);
      const { runner, calls } = recorder();
      const result = await runScriptsPipeline({ sourceDir: source, workDir: work, cacheDir: join(tmp, "cache"), runner });
      return { status: result.status, calls: calls.length, prepare: result.stages[0] as DriverStage };
    };
    const scripted = await run({ [SCRIPTS_INSTALL_MANIFEST_NAME]: texts.packageJson });
    assert.equal(scripted.prepare.status, "failed");
    assert.equal(scripted.calls, 0);
    const missing = await run({}, (source) => rmSync(join(source, SCRIPTS_INSTALL_MANIFEST_NAME)));
    assert.equal(missing.prepare.status, "failed");
    assert.equal(missing.calls, 0);

    let linked = true;
    const link = await run({}, (source) => {
      try {
        symlinkSync(join(tmp, "outside"), join(source, "src", "link"));
      } catch {
        linked = false; // symlinks need privileges on some hosts; nothing to assert then
      }
    });
    if (linked) {
      assert.equal(link.prepare.status, "failed");
      assert.equal(link.prepare.reason, "refused");
      assert.equal(link.calls, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Host pipeline pre-flight (the sandbox is never reached)
// ---------------------------------------------------------------------------

describe("NpmScriptsPipeline pre-flight", () => {
  function setup(): { runDir: string; snapshotDir: string; cache: string; calls: { n: number }; exec: ProcessExecutor } {
    const runDir = createRunDir(tmp);
    const snapshotDir = join(runDir, SNAPSHOT_NAME);
    mkdirSync(snapshotDir);
    writeFileSync(join(snapshotDir, "package.json"), "{}\n");
    const cache = join(tmp, "cache");
    mkdirSync(cache);
    const calls = { n: 0 };
    const exec: ProcessExecutor = () => {
      calls.n += 1;
      return Promise.reject(new Error("docker must not be reached"));
    };
    return { runDir, snapshotDir, cache, calls, exec };
  }
  const options = (s: ReturnType<typeof setup>, driverPath: string): ConstructorParameters<typeof NpmScriptsPipeline>[0] => ({
    executor: s.exec, runDir: s.runDir, snapshot: SNAPSHOT_NAME, cacheDir: s.cache, installManifest: "{}\n", expectedPackages: 3, driverPath,
  });

  it("refuses a snapshot that already contains a reserved name and leaves the file untouched", async () => {
    const s = setup();
    const driver = join(tmp, "driver.js");
    writeFileSync(driver, "// trusted\n");
    writeFileSync(join(s.snapshotDir, SCRIPTS_DRIVER_NAME), "mine");
    const r = await new NpmScriptsPipeline(options(s, driver)).run({ executionId: "job1:1", fixture: SNAPSHOT_NAME });
    assert.equal(r.status, "not-run");
    assert.equal(r.reason, "staging-failed");
    assert.equal(readFileSync(join(s.snapshotDir, SCRIPTS_DRIVER_NAME), "utf8"), "mine");
    assert.equal(s.calls.n, 0);
  });

  it("stages nothing when the driver is missing or the request names another snapshot", async () => {
    const s = setup();
    const before = readdirSync(s.snapshotDir).sort();
    const p = new NpmScriptsPipeline(options(s, join(tmp, "missing-driver.js")));
    const missing = await p.run({ executionId: "job1:1", fixture: SNAPSHOT_NAME });
    assert.equal(missing.reason, "driver-unavailable");
    const other = await p.run({ executionId: "job1:1", fixture: "src-ffffffffffff" });
    assert.equal(other.reason, "rejected");
    assert.deepEqual(readdirSync(s.snapshotDir).sort(), before);
    assert.equal(s.calls.n, 0);
  });
});

// ---------------------------------------------------------------------------
// Runner wiring (GithubJobRunner with fakes)
// ---------------------------------------------------------------------------

const st = (stage: DriverStage["stage"], status: DriverStage["status"], extra: Partial<DriverStage> = {}): DriverStage => ({
  stage, status, durationMs: 5, ...extra,
});
function successResult(req: PipelineRequest): ControlledPipelineResult {
  return {
    status: "success", reason: "ok", detail: "ok", failedStage: null,
    stages: [st("prepare", "passed"), st("install", "passed"), st("build", "passed"), st("test", "passed")],
    exitCode: 0, durationMs: 10, truncated: false, stderrTail: "", packagesAdded: 3, expectedPackages: 3,
    violations: [], cleanup: okProof(req.executionId), stagingRemoved: true, driverSha256: "b".repeat(64), executionId: req.executionId,
  };
}
function testFailureResult(req: PipelineRequest): ControlledPipelineResult {
  return {
    ...successResult(req),
    status: "failure", reason: "test-failed", detail: "test exited with code 1", failedStage: "test",
    stages: [
      st("prepare", "passed"), st("install", "passed"), st("build", "passed"),
      st("test", "failed", { reason: "exit-code", exitCode: 1, stderrTail: "SECRET-CONTAINER-OUTPUT" }),
    ],
    exitCode: 1,
  };
}
function inconclusiveResult(req: PipelineRequest): ControlledPipelineResult {
  return { ...successResult(req), status: "not-run", reason: "timed-out", detail: "timed out", stages: null, exitCode: null };
}

class CountingAgents implements AgentsLike {
  calls = 0;
  analyze(_req: AnalystRequest): Promise<AgentOutcome<Diagnosis>> {
    this.calls += 1;
    return Promise.reject(new Error("agents must not run in npm-scripts mode"));
  }
  propose(_req: FixerRequest): Promise<AgentOutcome<PatchProposal>> {
    this.calls += 1;
    return Promise.reject(new Error("agents must not run in npm-scripts mode"));
  }
}

interface Rig {
  runner: GithubJobRunner;
  ctx: RunContext;
  stages: string[];
  results: Record<string, unknown>[];
  exported: Array<{ runDir: string; packageJson: string }>;
  registryRequests: RegistryAcquisitionRequest[];
  pipelineBuilds: Array<{ runDir: string; snapshot: string; cacheDir: string; installManifest: string; expectedPackages: number }>;
  pipelineRequests: PipelineRequest[];
  gitRequests: AcquisitionRequest[];
  agents: CountingAgents;
  runsRoot: string;
}

function makeRig(opts: {
  files?: RootFiles;
  enabled?: boolean;
  snapshot?: SnapshotOutcome;
  pipeline?: (req: PipelineRequest) => ControlledPipelineResult;
  pins?: Map<string, string>;
  allowUnpinned?: boolean;
} = {}): Rig {
  const runsRoot = join(tmp, "runs");
  mkdirSync(runsRoot, { recursive: true });
  const t = textsOf(scriptsDoc());
  const files: RootFiles = opts.files ?? { packageJson: t.packageJson, packageLock: t.packageLock, buildMjs: null, testMjs: null, unusable: [] };
  const stages: string[] = [];
  const results: Record<string, unknown>[] = [];
  const exported: Rig["exported"] = [];
  const registryRequests: RegistryAcquisitionRequest[] = [];
  const pipelineBuilds: Rig["pipelineBuilds"] = [];
  const pipelineRequests: PipelineRequest[] = [];
  const gitRequests: AcquisitionRequest[] = [];
  const agents = new CountingAgents();
  const handoff: HandoffInfo = {
    containerName: "graveyard-acq-test", commit: COMMIT, manifest: { files: 5, totalBytes: 100, submodulesSkipped: 0 },
    dockerBinary: "docker", remainingMs: 100_000,
  };
  const makeGit = (hook: (info: HandoffInfo) => Promise<void>): GitLike => ({
    acquire: async (req) => {
      gitRequests.push(req);
      await hook(handoff);
      const acquired: AcquisitionResult = {
        kind: "acquired", commit: COMMIT, manifest: handoff.manifest, durationMs: 1, cleanup: okProof(req.executionId),
        ...(req.resolveHead === true ? { resolvedFromHead: true as const } : {}),
      };
      return acquired;
    },
    cleanup: (req) => Promise.resolve(okProof(req.executionId)),
  });
  const registry: RegistryLike = {
    acquire: (req) => {
      registryRequests.push(req);
      return Promise.resolve({
        kind: "acquired", cacheDir: join(req.runDir, "cache"), summary: { entries: 0 }, packagesAdded: 3, durationMs: 1,
        cleanup: okProof(req.executionId), stagingRemoved: true, driverSha256: "c".repeat(64), executionId: req.executionId,
      } as unknown as RegistryAcquisitionResult);
    },
    cleanup: (req) => Promise.resolve(okProof(req.executionId)),
  };
  const classic: PipelineLike = { run: (req) => Promise.resolve(successResult(req)) };
  const fallback: JobRunner = {
    run: () => Promise.resolve({ kind: "infrastructure-unavailable", reason: "fallback" }),
    cleanup: (req) => Promise.resolve(okProof(req.executionId)),
  };
  const npmScripts: NpmScriptsOptions = {
    exportSnapshot: (_info, runDir, expect) => {
      exported.push({ runDir, packageJson: expect.packageJson });
      return Promise.resolve(
        opts.snapshot ?? {
          kind: "extracted", name: SNAPSHOT_NAME, dir: join(runDir, SNAPSHOT_NAME), files: 5, directories: 2, totalBytes: 100, archiveSha256: "d".repeat(64),
        },
      );
    },
    makePipeline: (a) => {
      pipelineBuilds.push(a);
      return {
        run: (req) => {
          pipelineRequests.push(req);
          return Promise.resolve((opts.pipeline ?? successResult)(req));
        },
      };
    },
  };
  const runner = new GithubJobRunner({
    fallback,
    fixtureUrls: new Set(),
    pins: opts.pins ?? new Map([[REPO, COMMIT]]),
    ...(opts.allowUnpinned === undefined ? {} : { allowUnpinned: opts.allowUnpinned }),
    runsRoot,
    gitImage: "alpine/git:2.47.2",
    makeGit,
    readRootFiles: () => Promise.resolve(files),
    registry,
    makePipeline: () => classic,
    cleanupExecution: (id) => Promise.resolve(okProof(id)),
    agents,
    ...(opts.enabled === false ? {} : { npmScripts }),
  });
  const ctx: RunContext = {
    jobId: "job1", repoUrl: REPO, executionId: "job1:1", attempt: 1, deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    signal: new AbortController().signal,
    report: {
      stage: (s) => {
        stages.push(s);
        return true;
      },
      result: (r) => {
        results.push(r);
        return true;
      },
    },
  };
  return { runner, ctx, stages, results, exported, registryRequests, pipelineBuilds, pipelineRequests, gitRequests, agents, runsRoot };
}

const view = (result: Record<string, unknown>): ReturnType<typeof presentResult> =>
  presentResult({ jobId: "job1", stage: "done", status: "completed", attemptCount: 1, maxAttempts: 3, infraError: null, result });

describe("npm scripts mode in the GitHub runner", () => {
  it("is off by default: a repository with scripts stays unsupported and nothing is exported or acquired", async () => {
    const rig = makeRig({ enabled: false });
    const out = await rig.runner.run(rig.ctx);
    assert.deepEqual(out, { kind: "completed" });
    assert.equal(rig.results[0]?.["verdict"], "unsupported-repository");
    assert.equal(rig.results[0]?.["runMode"], undefined);
    assert.equal(rig.exported.length, 0);
    assert.equal(rig.registryRequests.length, 0);
  });

  it("runs the profile: sanitized manifest for acquisition, snapshot pipeline, measured verdict, no agents, no repair claim", async () => {
    const rig = makeRig();
    const out = await rig.runner.run(rig.ctx);
    assert.deepEqual(out, { kind: "completed" });
    assert.deepEqual(rig.stages, ["cloning", "analyzing", "building", "testing"]);
    const result = rig.results[0] as Record<string, unknown>;
    assert.equal(result["verdict"], "verified");
    assert.equal(result["runMode"], "npm-scripts");
    assert.equal(result["sourceKind"], "github-pinned");
    assert.equal(result["verification"], undefined);

    const acquisition = rig.registryRequests[0];
    assert.equal(acquisition?.operatorFixture?.packageJson.includes("scripts"), false, "scripts must never reach dependency acquisition");
    assert.equal(rig.pipelineBuilds[0]?.installManifest, acquisition?.operatorFixture?.packageJson);
    assert.equal(rig.pipelineBuilds[0]?.snapshot, SNAPSHOT_NAME);
    assert.equal(rig.pipelineRequests[0]?.fixture, SNAPSHOT_NAME);
    assert.equal(rig.agents.calls, 0);

    const v = view(result);
    assert.equal(v.outcome, "passing");
    assert.equal(v.repair.verified, false);
    assert.equal(v.repair.patchApplied, false);
    assert.equal(v.repair.patchProposed, false);
    assert.equal(v.verifiedDiff, null);
    assert.deepEqual(readdirSync(rig.runsRoot), [], "the run directory must be removed");
  });

  it("reports a measured failure without a diagnosis, a proposal, a repair or container output", async () => {
    const rig = makeRig({ pipeline: testFailureResult });
    const out = await rig.runner.run(rig.ctx);
    assert.deepEqual(out, { kind: "completed" });
    const result = rig.results[0] as Record<string, unknown>;
    assert.equal(result["verdict"], "repository-failing");
    assert.equal(JSON.stringify(result).includes("SECRET-CONTAINER-OUTPUT"), false);
    const v = view(result);
    assert.equal(v.outcome, "failing-undiagnosed");
    assert.equal(v.repair.verified, false);
    assert.equal(v.repair.diagnosed, false);
    assert.equal(rig.agents.calls, 0);
  });

  it("fails as infrastructure, with no result, when the run is inconclusive", async () => {
    const rig = makeRig({ pipeline: inconclusiveResult });
    const out = await rig.runner.run(rig.ctx);
    assert.equal(out.kind, "infrastructure-unavailable");
    assert.equal(rig.results.length, 0);
  });

  it("fails as infrastructure when the pipeline reports success without confirmed cleanup", async () => {
    const rig = makeRig({ pipeline: (req) => ({ ...successResult(req), cleanup: { confirmed: false, reason: "still there" } }) });
    const out = await rig.runner.run(rig.ctx);
    assert.equal(out.kind, "infrastructure-unavailable");
    assert.equal(rig.results.length, 0);
  });

  it("exports nothing and acquires nothing for a repository outside the profile", async () => {
    const d = scriptsDoc();
    d.pkg["devDependencies"] = { typescript: "^5.0.0" };
    const t = textsOf(d);
    const rig = makeRig({ files: { packageJson: t.packageJson, packageLock: t.packageLock, buildMjs: null, testMjs: null, unusable: [] } });
    const out = await rig.runner.run(rig.ctx);
    assert.deepEqual(out, { kind: "completed" });
    assert.equal(rig.results[0]?.["verdict"], "unsupported-repository");
    assert.equal(rig.results[0]?.["runMode"], "npm-scripts");
    assert.equal(rig.exported.length, 0);
    assert.equal(rig.registryRequests.length, 0);
  });

  it("reports a refused snapshot as unsupported and never contacts the registry", async () => {
    const rig = makeRig({ snapshot: { kind: "refused", reason: "the tree has more than 100 files" } });
    const out = await rig.runner.run(rig.ctx);
    assert.deepEqual(out, { kind: "completed" });
    const findings = ((rig.results[0] as Record<string, unknown>)["analysis"] as { findings: Array<{ code: string }> }).findings;
    assert.deepEqual(findings.map((f) => f.code), ["source-snapshot-refused"]);
    assert.equal(rig.registryRequests.length, 0);
    assert.equal(rig.pipelineBuilds.length, 0);
  });

  it("keeps the root build.mjs flow when package.json declares no scripts, even when enabled", async () => {
    const t = textsOf(operatorDoc());
    const rig = makeRig({
      files: { packageJson: t.packageJson, packageLock: t.packageLock, buildMjs: "console.log(1);\n", testMjs: 'import "node:test";\n', unusable: [] },
    });
    const out = await rig.runner.run(rig.ctx);
    assert.deepEqual(out, { kind: "completed" });
    assert.equal(rig.exported.length, 0);
    assert.equal(rig.pipelineBuilds.length, 0);
    assert.equal(rig.results[0]?.["verdict"], "verified");
    assert.equal(rig.results[0]?.["runMode"], undefined);
  });

  it("never exports or runs anything for unpinned intake, even when enabled", async () => {
    const rig = makeRig({ pins: new Map(), allowUnpinned: true });
    const out = await rig.runner.run(rig.ctx);
    assert.deepEqual(out, { kind: "completed" });
    assert.equal(rig.results[0]?.["verdict"], "source-inspected");
    assert.equal(rig.exported.length, 0);
    assert.equal(rig.registryRequests.length, 0);
    assert.equal(rig.pipelineBuilds.length, 0);
  });

  it("rejects a malformed npmScripts option", () => {
    assert.throws(
      () =>
        new GithubJobRunner({
          fallback: { run: () => Promise.reject(new Error("x")), cleanup: () => Promise.reject(new Error("x")) },
          fixtureUrls: new Set(),
          pins: new Map(),
          allowUnpinned: true,
          runsRoot: tmp,
          gitImage: "alpine/git:2.47.2",
          makeGit: () => ({ acquire: () => Promise.reject(new Error("x")), cleanup: () => Promise.reject(new Error("x")) }),
          readRootFiles: () => Promise.reject(new Error("x")),
          registry: null,
          makePipeline: () => ({ run: () => Promise.reject(new Error("x")) }),
          cleanupExecution: () => Promise.reject(new Error("x")),
          npmScripts: {} as never,
        }),
    );
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("npm scripts configuration switch", () => {
  const ROOT = resolve(tmpdir(), "graveyard-npm-scripts-config-test");
  const p = (n: string): string => join(ROOT, n);
  const PINS = JSON.stringify({ [REPO]: COMMIT });
  const CATALOG = JSON.stringify({ "https://github.com/f/fixture": "fx1" });
  const REGISTRY = {
    GRAVEYARD_REGISTRY_EGRESS_NETWORK: "npm-net",
    GRAVEYARD_REGISTRY_EGRESS_PROXY_CONTAINER: "npm-proxy",
    GRAVEYARD_REGISTRY_EGRESS_PROXY_URL: "http://10.202.5.10:3128",
  };
  function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {
      GRAVEYARD_WORKER_ENABLED: "1",
      GRAVEYARD_FIXTURES_ROOT: p("fixtures"),
      GRAVEYARD_STAGING_ROOT: p("staging"),
      GRAVEYARD_NPM_CACHE_DIR: p("cache"),
      GRAVEYARD_FIXTURE_CATALOG: p("catalog.json"),
      GRAVEYARD_GITHUB_CATALOG: p("github.json"),
      GRAVEYARD_GITHUB_RUNS_ROOT: p("runs"),
      GRAVEYARD_GITHUB_EGRESS_NETWORK: "gh-net",
      GRAVEYARD_GITHUB_EGRESS_PROXY_CONTAINER: "gh-proxy",
      GRAVEYARD_GITHUB_EGRESS_PROXY_URL: "http://10.201.5.10:3128",
    };
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
    return out;
  }
  const deps = { readCatalog: (path: string): string => (path.endsWith("github.json") ? PINS : CATALOG), randomId: (): string => "abc123", pid: 42 };
  const problemsOf = (e: NodeJS.ProcessEnv): readonly string[] => {
    try {
      loadWorkerConfig(e, deps);
    } catch (err) {
      assert.ok(err instanceof WorkerConfigError);
      return err.problems;
    }
    return assert.fail("expected the configuration to be refused");
  };

  it("is off by default and when 0", () => {
    assert.equal(loadWorkerConfig(env(), deps).github?.npmScripts, undefined);
    assert.equal(loadWorkerConfig(env({ ...REGISTRY, GRAVEYARD_GITHUB_NPM_SCRIPTS: "0" }), deps).github?.npmScripts, undefined);
  });

  it("turns on with exactly 1 and the registry egress", () => {
    assert.equal(loadWorkerConfig(env({ ...REGISTRY, GRAVEYARD_GITHUB_NPM_SCRIPTS: "1" }), deps).github?.npmScripts, true);
  });

  it("requires the registry egress and the pin catalog, and refuses any other value", () => {
    assert.ok(problemsOf(env({ GRAVEYARD_GITHUB_NPM_SCRIPTS: "1" })).some((x) => x.includes("GRAVEYARD_REGISTRY_EGRESS")));
    assert.ok(
      problemsOf(env({ ...REGISTRY, GRAVEYARD_GITHUB_NPM_SCRIPTS: "1", GRAVEYARD_GITHUB_CATALOG: undefined, GRAVEYARD_GITHUB_ALLOW_UNPINNED: "1" })).some((x) =>
        x.includes("GRAVEYARD_GITHUB_CATALOG"),
      ),
    );
    for (const bad of ["true", "yes", " 1", "2", ""]) {
      assert.ok(problemsOf(env({ ...REGISTRY, GRAVEYARD_GITHUB_NPM_SCRIPTS: bad })).some((x) => x.includes("GRAVEYARD_GITHUB_NPM_SCRIPTS")), JSON.stringify(bad));
    }
  });
});
