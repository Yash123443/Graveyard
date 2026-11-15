/**
 * node-fixture-runner.test.ts — Node fixture build/test runner with a MOCKED docker CLI.
 *
 * No docker process is spawned and no real filesystem fixture is touched. These tests check the
 * fixed command registry, the arguments handed to Docker, and how docker/sandbox outcomes map to
 * passed / failed / not-run. They do NOT show that real Docker or real `node --test` output
 * behaves as modelled; that is the job of the opt-in harness (manual-node-fixture-check.ts),
 * which has not been run by this author.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { ProcessExecutor, ProcessOptions, ProcessResult, SandboxResult } from "../docker-sandbox.js";
import {
  BUILD_MARKER,
  NODE_FIXTURE_COMMANDS,
  NODE_FIXTURE_IMAGE,
  NodeFixtureRunner,
  classifyBuild,
  classifyTest,
  parseBuildMarker,
  parseTapCounts,
  tailOf,
  type NodeFixtureRunnerOptions,
  type StageName,
} from "../node-fixture-runner.js";

const IMAGE = NODE_FIXTURE_IMAGE;
const ROOT = resolve("/graveyard-fixtures");
const MB = 1024 * 1024;

const res = (p: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, ...p,
});

const BUILD_OK = `${BUILD_MARKER} files=1 bytes=120\n`;
const tap = (t: number, p: number, f: number, c = 0, s = 0, todo = 0): string =>
  `TAP version 13\n# Subtest: x\nok 1 - x\n1..1\n# tests ${t}\n# suites 0\n# pass ${p}\n# fail ${f}\n# cancelled ${c}\n# skipped ${s}\n# todo ${todo}\n# duration_ms 12.5\n`;

type Behaviour = ProcessResult | Error | ((opts: ProcessOptions) => Promise<ProcessResult>);

interface Doc {
  Config: Record<string, unknown>;
  HostConfig: Record<string, unknown>;
  State: Record<string, unknown>;
  Mounts: unknown[];
}

function valuesOf(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === flag) out.push(String(args[i + 1])); });
  return out;
}

/** Builds the inspect document a correctly isolating Docker would report for these create args. */
function docFromCreate(args: readonly string[]): Doc {
  const imageIdx = args.indexOf(IMAGE);
  const labels: Record<string, string> = {};
  for (const l of valuesOf(args, "--label")) {
    const i = l.indexOf("=");
    labels[l.slice(0, i)] = l.slice(i + 1);
  }
  const mount = valuesOf(args, "--mount")[0];
  const source = mount === undefined ? undefined : /source=([^,]+)/.exec(mount)?.[1];
  return {
    Config: {
      User: "65532:65532", Image: IMAGE, Cmd: args.slice(imageIdx + 1), Entrypoint: [""], Labels: labels,
    },
    HostConfig: {
      NetworkMode: "none", Privileged: false, ReadonlyRootfs: true, CapDrop: ["ALL"], CapAdd: null,
      SecurityOpt: ["no-new-privileges"], Memory: 256 * MB, MemorySwap: 256 * MB, PidsLimit: 64,
      NanoCpus: 1_000_000_000, PidMode: "", IpcMode: "private", Binds: null, Devices: [], VolumesFrom: null,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
      LogConfig: { Type: "json-file", Config: { "max-size": "64k", "max-file": "1" } },
    },
    State: { Status: "created", Running: false, ExitCode: 0, Error: "", StartedAt: "0001-01-01T00:00:00Z" },
    Mounts: source === undefined ? [] : [{ Type: "bind", Source: source, Destination: "/fixture", RW: false }],
  };
}

class FakeDocker {
  readonly calls: Array<{ file: string; args: readonly string[]; opts: ProcessOptions }> = [];
  readonly behaviour: Record<StageName, Behaviour> = {
    build: res({ stdout: BUILD_OK }),
    test: res({ stdout: tap(2, 2, 0) }),
  };
  versionResult: ProcessResult = res({ stdout: "27.0.0\n" });
  rmRemoves = true;
  tamper: ((d: Doc) => void) | null = null;
  private readonly containers = new Map<string, { doc: Doc; stage: StageName; started: boolean; exit: number | null }>();

  readonly executor: ProcessExecutor = async (file, args, opts) => {
    this.calls.push({ file, args, opts });
    const name = String(args[args.length - 1]);
    switch (args[0]) {
      case "version":
        return this.versionResult;
      case "create": {
        const stage: StageName = args.includes("/fixture/build.mjs") ? "build" : "test";
        const n = valuesOf(args, "--name")[0] as string;
        this.containers.set(n, { doc: docFromCreate(args), stage, started: false, exit: null });
        return res({ stdout: "id\n" });
      }
      case "inspect": {
        const c = this.containers.get(name);
        if (c === undefined) return res({ exitCode: 1, stderr: `Error: No such object: ${name}\n` });
        const doc: Doc = JSON.parse(JSON.stringify(c.doc)) as Doc;
        if (c.started) {
          Object.assign(doc.State, { Status: "exited", ExitCode: c.exit ?? 0, StartedAt: "2026-11-15T10:00:00Z" });
        }
        this.tamper?.(doc);
        return res({ stdout: JSON.stringify([doc]) });
      }
      case "start": {
        const c = this.containers.get(name);
        assert.ok(c, "start of unknown container");
        c.started = true;
        const b = this.behaviour[c.stage];
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

function make(fake: FakeDocker, extra: Partial<NodeFixtureRunnerOptions> = {}): NodeFixtureRunner {
  return new NodeFixtureRunner({
    executor: fake.executor,
    fixturesRoot: ROOT,
    realpath: (p) => p,
    fileKind: () => "file",
    ...extra,
  });
}

const stageReq = { executionId: "nodefix-aaa:1", fixture: "case1" };
const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 1000 && !cond(); i += 1) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), "condition not reached");
};

describe("fixed registry and docker arguments", () => {
  it("exposes a frozen fixed command registry with no shell, npm or install", () => {
    assert.deepEqual(NODE_FIXTURE_COMMANDS.build, ["node", "/fixture/build.mjs", "/tmp/out"]);
    assert.deepEqual(NODE_FIXTURE_COMMANDS.test, ["node", "--test", "--test-reporter=tap"]);
    assert.ok(Object.isFrozen(NODE_FIXTURE_COMMANDS));
    assert.ok(Object.isFrozen(NODE_FIXTURE_COMMANDS.build));
    for (const argv of Object.values(NODE_FIXTURE_COMMANDS)) {
      for (const a of argv) assert.ok(!["sh", "bash", "npm", "pnpm", "npx", "-c"].includes(a) && !a.includes("install"));
    }
  });

  it("runs each stage with network none, non-root, read-only fixture mount and bounded tmpfs", async () => {
    const fake = new FakeDocker();
    const r = make(fake);
    await r.runStage("build", stageReq);
    await r.runStage("test", { ...stageReq, executionId: "nodefix-aaa:2" });
    const [b, t] = fake.creates();
    assert.ok(b && t);
    for (const a of [b, t]) {
      assert.deepEqual(valuesOf(a, "--network"), ["none"]);
      assert.deepEqual(valuesOf(a, "--user"), ["65532:65532"]);
      assert.deepEqual(valuesOf(a, "--cap-drop"), ["ALL"]);
      assert.deepEqual(valuesOf(a, "--pull"), ["never"]);
      assert.deepEqual(valuesOf(a, "--memory"), ["256m"]);
      assert.deepEqual(valuesOf(a, "--pids-limit"), ["64"]);
      assert.deepEqual(valuesOf(a, "--tmpfs"), ["/tmp:rw,noexec,nosuid,nodev,size=16m"]);
      assert.deepEqual(valuesOf(a, "--workdir"), ["/fixture"]);
      const mount = valuesOf(a, "--mount")[0] ?? "";
      assert.match(mount, /^type=bind,source=.+,target=\/fixture,readonly$/);
      assert.ok(a.includes("--read-only"));
      assert.equal(a[a.indexOf(IMAGE)], IMAGE);
    }
    assert.deepEqual(b.slice(b.indexOf(IMAGE) + 1), NODE_FIXTURE_COMMANDS.build);
    assert.deepEqual(t.slice(t.indexOf(IMAGE) + 1), NODE_FIXTURE_COMMANDS.test);
    assert.ok(fake.calls.every((c) => c.file === "docker" && c.args.every((x) => typeof x === "string")));
  });

  it("uses the pinned image for every container; requests cannot choose an image or command", async () => {
    const fake = new FakeDocker();
    const out = await make(fake).verify({ idPrefix: "nodefix-img", fixture: "case1" });
    assert.equal(out.status, "passed");
    assert.ok(fake.creates().every((a) => a.filter((x) => x === IMAGE).length === 1));
  });
});

describe("build stage status", () => {
  it("passed: exit 0 with a valid marker and confirmed cleanup", async () => {
    const fake = new FakeDocker();
    const out = await make(fake).runStage("build", stageReq);
    assert.equal(out.status, "passed");
    assert.equal(out.reason, "ok");
    assert.deepEqual(out.buildOutput, { files: 1, bytes: 120 });
    assert.equal(out.cleanup?.confirmed, true);
    assert.deepEqual(fake.verbs().slice(-1), ["ps"]);
    assert.ok(fake.verbs().includes("rm"));
  });

  it("failed: nonzero exit is a failure with stderr kept", async () => {
    const fake = new FakeDocker();
    fake.behaviour.build = res({ exitCode: 1, stderr: "Error: intentional build failure\n" });
    const out = await make(fake).runStage("build", stageReq);
    assert.equal(out.status, "failed");
    assert.equal(out.reason, "exit-nonzero");
    assert.equal(out.exitCode, 1);
    assert.match(out.stderrTail, /intentional build failure/);
    assert.equal(out.cleanup?.confirmed, true);
  });

  it("not-run: exit 0 without a marker is not a pass", async () => {
    const fake = new FakeDocker();
    fake.behaviour.build = res({ stdout: "done\n" });
    const out = await make(fake).runStage("build", stageReq);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "build-output-unverified");
    assert.equal(out.buildOutput, null);
  });

  it("not-run: a marker with zero files or bytes, or not at line start, is not accepted", () => {
    assert.equal(parseBuildMarker(`${BUILD_MARKER} files=0 bytes=0\n`), null);
    assert.equal(parseBuildMarker(`  ${BUILD_MARKER} files=1 bytes=5\n`), null);
    assert.equal(parseBuildMarker(`x ${BUILD_MARKER} files=1 bytes=5\n`), null);
    assert.deepEqual(parseBuildMarker(`${BUILD_MARKER} files=2 bytes=5\r\n`), { files: 2, bytes: 5 });
  });

  it("not-run: no build.mjs means nothing is run", async () => {
    const fake = new FakeDocker();
    const out = await make(fake, { fileKind: () => "missing" }).runStage("build", stageReq);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "no-build-script");
    assert.deepEqual(fake.calls, []);
  });

  it("a build.mjs that exists but is not a plain file still goes to the container and cannot pass without a marker", async () => {
    const fake = new FakeDocker();
    fake.behaviour.build = res({ exitCode: 1, stderr: "cannot find module" });
    const out = await make(fake, { fileKind: () => "other" }).runStage("build", stageReq);
    assert.equal(out.status, "failed");
  });
});

describe("test stage status", () => {
  it("passed: exit 0, TAP counts show executed passing tests, cleanup confirmed", async () => {
    const fake = new FakeDocker();
    const out = await make(fake).runStage("test", stageReq);
    assert.equal(out.status, "passed");
    assert.deepEqual(out.counts, { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  });

  it("failed: failing tests with nonzero exit", async () => {
    const fake = new FakeDocker();
    fake.behaviour.test = res({ exitCode: 1, stdout: tap(2, 1, 1) });
    const out = await make(fake).runStage("test", stageReq);
    assert.equal(out.status, "failed");
    assert.equal(out.reason, "tests-failed");
    assert.equal(out.counts?.fail, 1);
  });

  it("failed: exit 0 but a failure count is still a failure", () => {
    const v = classifyTest(exitedResult(0, tap(2, 1, 1)));
    assert.equal(v.status, "failed");
  });

  it("failed: nonzero exit without any summary", () => {
    const v = classifyTest(exitedResult(2, "boom"));
    assert.equal(v.status, "failed");
    assert.equal(v.reason, "exit-nonzero");
  });

  it("not-run: zero tests (missing tests) is never a pass", async () => {
    const fake = new FakeDocker();
    fake.behaviour.test = res({ stdout: tap(0, 0, 0) });
    const out = await make(fake).runStage("test", stageReq);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "no-tests-found");
  });

  it("not-run: all tests skipped, or only todo", () => {
    assert.equal(classifyTest(exitedResult(0, tap(3, 0, 0, 0, 3))).reason, "no-tests-executed");
    assert.equal(classifyTest(exitedResult(0, tap(1, 0, 0, 0, 0, 1))).status, "not-run");
  });

  it("not-run: exit 0 with no or partial summary", () => {
    assert.equal(classifyTest(exitedResult(0, "all good\n")).reason, "test-summary-unparseable");
    assert.equal(classifyTest(exitedResult(0, "# tests 3\n# pass 3\n")).status, "not-run");
  });

  it("not-run: inconsistent counts", () => {
    assert.equal(classifyTest(exitedResult(0, tap(1, 5, 0))).status, "not-run");
  });

  it("ignores indented summary lines printed by test code", () => {
    assert.equal(parseTapCounts("    # tests 9\n    # pass 9\n    # fail 0\n    # cancelled 0\n"), null);
    const forged = `# tests 9\n# pass 9\n# fail 0\n# cancelled 0\n${tap(2, 1, 1)}`;
    assert.equal(parseTapCounts(forged)?.fail, 1); // the last real summary wins
  });
});

describe("truncated output", () => {
  it("exit 0 with truncated output is not-run for both stages", async () => {
    const fake = new FakeDocker();
    fake.behaviour.build = res({ stdout: BUILD_OK, truncated: true });
    fake.behaviour.test = res({ stdout: tap(2, 2, 0), truncated: true });
    const r = make(fake);
    const b = await r.runStage("build", stageReq);
    const t = await r.runStage("test", { ...stageReq, executionId: "nodefix-aaa:2" });
    assert.equal(b.status, "not-run");
    assert.equal(b.reason, "output-truncated");
    assert.equal(b.truncated, true);
    assert.equal(t.status, "not-run");
    assert.equal(t.reason, "output-truncated");
    assert.equal(t.counts, null);
  });

  it("nonzero exit with truncated output is still a failure and reports truncation", async () => {
    const fake = new FakeDocker();
    fake.behaviour.test = res({ exitCode: 1, stdout: "x".repeat(100), truncated: true });
    const t = await make(fake).runStage("test", stageReq);
    assert.equal(t.status, "failed");
    assert.equal(t.truncated, true);
  });

  it("output tails are bounded and sanitised to printable ASCII", async () => {
    const fake = new FakeDocker();
    fake.behaviour.build = res({ exitCode: 1, stdout: `${"a".repeat(10_000)}\u001b[31mé END`, stderr: "ok" });
    const out = await make(fake).runStage("build", stageReq);
    assert.ok(out.stdoutTail.length <= 2000);
    assert.ok(out.stdoutTail.endsWith("[31m? END"));
    assert.ok(!/[^\n\x20-\x7e]/.test(out.stdoutTail));
    assert.equal(tailOf("abc", 2), "bc");
  });
});

describe("timeout, cancellation and unavailability are never failures or passes", () => {
  it("timeout is not-run and cleanup is still proven", async () => {
    const fake = new FakeDocker();
    fake.behaviour.build = res({ exitCode: null, timedOut: true, stdout: BUILD_OK });
    const out = await make(fake).runStage("build", stageReq);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "timed-out");
    assert.equal(out.buildOutput, null);
    assert.equal(out.cleanup?.confirmed, true);
  });

  it("cancel during the run is not-run, the signal reaches docker, cleanup is proven", async () => {
    const fake = new FakeDocker();
    fake.behaviour.test = (opts) => new Promise<ProcessResult>((done) => {
      opts.signal?.addEventListener("abort", () => done(res({ exitCode: null, aborted: true, stdout: "partial" })), { once: true });
    });
    const ac = new AbortController();
    const p = make(fake).runStage("test", { ...stageReq, signal: ac.signal });
    await waitFor(() => fake.verbs().includes("start"));
    const start = fake.calls.find((c) => c.args[0] === "start");
    assert.equal(start?.opts.signal, ac.signal);
    ac.abort();
    const out = await p;
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "aborted");
    assert.equal(out.cleanup?.confirmed, true);
    assert.ok(fake.verbs().includes("rm"));
  });

  it("already-aborted signal creates nothing", async () => {
    const fake = new FakeDocker();
    const ac = new AbortController();
    ac.abort();
    const out = await make(fake).runStage("build", { ...stageReq, signal: ac.signal });
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "aborted");
    assert.deepEqual(fake.calls, []);
  });

  it("docker unavailable is not-run and nothing is created", async () => {
    const fake = new FakeDocker();
    fake.versionResult = res({ exitCode: 1, stderr: "cannot connect" });
    const out = await make(fake).runStage("build", stageReq);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "docker-unavailable");
    assert.deepEqual(fake.verbs(), ["version"]);
    assert.equal(out.cleanup, null);
  });

  it("an isolation mismatch is not-run and the container is never started", async () => {
    const fake = new FakeDocker();
    fake.tamper = (d) => { d.HostConfig["NetworkMode"] = "bridge"; };
    const out = await make(fake).runStage("build", stageReq);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "isolation-violation");
    assert.ok(!fake.verbs().includes("start"));
    assert.equal(out.cleanup?.confirmed, true);
  });

  it("a rejected request (bad fixture name) is not-run without touching docker", async () => {
    const fake = new FakeDocker();
    const out = await make(fake).runStage("build", { ...stageReq, fixture: "../etc" });
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "rejected");
    assert.deepEqual(fake.calls, []);
  });
});

describe("cleanup proof", () => {
  it("a pass is downgraded to not-run when cleanup cannot be confirmed", async () => {
    const fake = new FakeDocker();
    fake.rmRemoves = false;
    const out = await make(fake).runStage("build", stageReq);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "cleanup-unconfirmed");
    assert.equal(out.cleanup?.confirmed, false);
  });

  it("a failure stays a failure and reports the unconfirmed cleanup", async () => {
    const fake = new FakeDocker();
    fake.rmRemoves = false;
    fake.behaviour.test = res({ exitCode: 1, stdout: tap(1, 0, 1) });
    const out = await make(fake).runStage("test", stageReq);
    assert.equal(out.status, "failed");
    assert.equal(out.cleanup?.confirmed, false);
  });

  it("cleanup removes the container by name and proves absence by inspect and label query", async () => {
    const fake = new FakeDocker();
    const out = await make(fake).runStage("build", stageReq);
    assert.equal(out.cleanup?.confirmed, true);
    const rm = fake.calls.find((c) => c.args[0] === "rm");
    assert.deepEqual(rm?.args, ["rm", "--force", "--volumes", "graveyard-nodefix-aaa_1"]);
    const ps = fake.calls.find((c) => c.args[0] === "ps");
    assert.ok(ps?.args.includes("label=graveyard.execution-id=nodefix-aaa:1"));
  });

  it("a thrown docker error during start still leads to a cleanup attempt and not-run", async () => {
    const fake = new FakeDocker();
    fake.behaviour.build = new Error("spawn docker ENOENT");
    const out = await make(fake).runStage("build", stageReq);
    assert.equal(out.status, "not-run");
    assert.equal(out.reason, "docker-unavailable");
    assert.ok(fake.verbs().includes("rm"));
    assert.equal(out.cleanup?.confirmed, true);
  });
});

describe("verify (build then test)", () => {
  it("passes only when both stages pass, using separate containers", async () => {
    const fake = new FakeDocker();
    const v = await make(fake).verify({ idPrefix: "nodefix-bbb", fixture: "case1" });
    assert.equal(v.status, "passed");
    assert.equal(v.build.executionId, "nodefix-bbb:1");
    assert.equal(v.test.executionId, "nodefix-bbb:2");
    const names = fake.creates().map((a) => valuesOf(a, "--name")[0]);
    assert.deepEqual(names, ["graveyard-nodefix-bbb_1", "graveyard-nodefix-bbb_2"]);
  });

  it("a failed build fails the run and the test stage is not-run and never started", async () => {
    const fake = new FakeDocker();
    fake.behaviour.build = res({ exitCode: 1, stderr: "boom" });
    const v = await make(fake).verify({ idPrefix: "nodefix-bbb", fixture: "case1" });
    assert.equal(v.status, "failed");
    assert.equal(v.test.status, "not-run");
    assert.equal(v.test.reason, "skipped-build-did-not-pass");
    assert.equal(fake.creates().length, 1);
  });

  it("failing tests fail the run", async () => {
    const fake = new FakeDocker();
    fake.behaviour.test = res({ exitCode: 1, stdout: tap(2, 1, 1) });
    const v = await make(fake).verify({ idPrefix: "nodefix-bbb", fixture: "case1" });
    assert.equal(v.status, "failed");
    assert.equal(v.build.status, "passed");
    assert.equal(v.test.status, "failed");
  });

  it("missing tests leave the run not-run, not passed", async () => {
    const fake = new FakeDocker();
    fake.behaviour.test = res({ stdout: tap(0, 0, 0) });
    const v = await make(fake).verify({ idPrefix: "nodefix-bbb", fixture: "case1" });
    assert.equal(v.status, "not-run");
    assert.equal(v.build.status, "passed");
    assert.equal(v.test.reason, "no-tests-found");
  });

  it("a build timeout leaves the run not-run and skips tests", async () => {
    const fake = new FakeDocker();
    fake.behaviour.build = res({ exitCode: null, timedOut: true });
    const v = await make(fake).verify({ idPrefix: "nodefix-bbb", fixture: "case1" });
    assert.equal(v.status, "not-run");
    assert.equal(v.test.reason, "skipped-build-did-not-pass");
  });

  it("cancellation between stages skips the test stage", async () => {
    const fake = new FakeDocker();
    const ac = new AbortController();
    fake.behaviour.build = () => { ac.abort(); return Promise.resolve(res({ stdout: BUILD_OK })); };
    const v = await make(fake).verify({ idPrefix: "nodefix-bbb", fixture: "case1", signal: ac.signal });
    assert.equal(v.build.status, "passed");
    assert.equal(v.test.status, "not-run");
    assert.equal(v.test.reason, "aborted");
    assert.equal(v.status, "not-run");
    assert.equal(fake.creates().length, 1);
  });

  it("rejects an invalid id prefix without touching docker", async () => {
    const fake = new FakeDocker();
    const v = await make(fake).verify({ idPrefix: "bad:id", fixture: "case1" });
    assert.equal(v.status, "not-run");
    assert.equal(v.build.reason, "rejected");
    assert.deepEqual(fake.calls, []);
  });
});

function exitedResult(exitCode: number, stdout: string, truncated = false): SandboxResult {
  return {
    kind: "exited", exitCode, stdout, stderr: "", truncated, durationMs: 5,
    cleanup: { confirmed: true, executionId: "x:1", evidence: "test" },
  };
}

describe("pure classification", () => {
  it("classifyBuild covers truncated and failing builds", () => {
    assert.equal(classifyBuild(exitedResult(0, BUILD_OK)).status, "passed");
    assert.equal(classifyBuild(exitedResult(0, BUILD_OK, true)).status, "not-run");
    assert.equal(classifyBuild(exitedResult(3, "")).status, "failed");
  });

  it("every non-exit sandbox outcome is not-run", () => {
    const outcomes: SandboxResult[] = [
      { kind: "timed-out", stdout: "", stderr: "", truncated: false, durationMs: 1, cleanup: null },
      { kind: "aborted", stdout: "", stderr: "", truncated: false, durationMs: 1, cleanup: null },
      { kind: "isolation-violation", reason: "x", cleanup: null },
      { kind: "unavailable", reason: "x", cleanup: null },
      { kind: "rejected", reason: "x", cleanup: null },
    ];
    for (const o of outcomes) {
      assert.equal(classifyBuild(o).status, "not-run");
      assert.equal(classifyTest(o).status, "not-run");
    }
  });
});
