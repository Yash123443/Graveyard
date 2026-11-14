/**
 * docker-sandbox.test.ts — Docker fixture adapter, with a MOCKED docker CLI.
 *
 * No docker process is spawned and nothing touches a real daemon, image,
 * network or filesystem fixture. These tests check the arguments the adapter
 * builds, its handling of timeout/abort/unavailability/cleanup failure, and
 * its verification of inspect output. They do NOT show that real Docker
 * enforces these settings, and nothing here shows the sandbox is production
 * safe. The real spawnExecutor is not exercised.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  DockerFixtureSandbox,
  containerNameFor,
  type ProcessExecutor,
  type ProcessOptions,
  type ProcessResult,
  type SandboxOptions,
} from "../docker-sandbox.js";

const EXEC = "0b1c2d3e-aaaa-bbbb:1";
const NAME = "graveyard-0b1c2d3e-aaaa-bbbb_1";
const IMAGE = "graveyard-fixture:local";
const CMD = ["/fixture/run-check.sh", "--quick"];
const ROOT = resolve("/graveyard-fixtures");
const MB = 1024 * 1024;

const res = (p: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, ...p,
});
const noSuch = (): ProcessResult => res({ exitCode: 1, stderr: `Error: No such object: ${NAME}\n` });

interface Doc {
  Config: Record<string, unknown>;
  HostConfig: Record<string, unknown>;
  State: Record<string, unknown>;
  Mounts: unknown[];
}

/** Independent statement of what a correctly isolated container looks like in `docker inspect`. */
function goodDoc(withFixture: boolean): Doc {
  return {
    Config: {
      User: "65532:65532",
      Image: IMAGE,
      Cmd: CMD,
      Entrypoint: [""],
      Labels: { "graveyard.managed": "true", "graveyard.execution-id": EXEC },
    },
    HostConfig: {
      NetworkMode: "none",
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      CapAdd: null,
      SecurityOpt: ["no-new-privileges"],
      Memory: 128 * MB,
      MemorySwap: 128 * MB,
      PidsLimit: 64,
      NanoCpus: 500_000_000,
      PidMode: "",
      IpcMode: "private",
      Binds: null,
      Devices: [],
      VolumesFrom: null,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
      LogConfig: { Type: "json-file", Config: { "max-size": "64k", "max-file": "1" } },
    },
    State: { Status: "created", Running: false, ExitCode: 0, Error: "", StartedAt: "0001-01-01T00:00:00Z" },
    Mounts: withFixture
      ? [{ Type: "bind", Source: resolve(ROOT, "case1"), Destination: "/fixture", RW: false }]
      : [],
  };
}

class FakeDocker {
  readonly calls: Array<{ file: string; args: readonly string[]; opts: ProcessOptions }> = [];
  exists = false;
  withFixture = false;
  tamper: ((d: Doc) => void) | null = null;
  versionResult: ProcessResult | Error = res({ stdout: "27.0.0\n" });
  startResult: ProcessResult | Error = res({ stdout: "ok\n" });
  rmRemoves = true;
  inspectFailure: ProcessResult | null = null;
  inspectFailureOnlyAfterRm = false;
  psStdout = "";
  psFailure: ProcessResult | null = null;
  foreignOwner = false;
  started = false;
  /** Overrides State fields reported by inspect once start was called. */
  stateAfterStart: Record<string, unknown> | null = null;
  private rmCalled = false;

  readonly executor: ProcessExecutor = (file, args, opts) => {
    this.calls.push({ file, args, opts });
    switch (args[0]) {
      case "version":
        if (this.versionResult instanceof Error) return Promise.reject(this.versionResult);
        return Promise.resolve(this.versionResult);
      case "create":
        this.exists = true;
        return Promise.resolve(res({ stdout: "abc123\n" }));
      case "inspect": {
        if (this.inspectFailure !== null && (!this.inspectFailureOnlyAfterRm || this.rmCalled)) {
          return Promise.resolve(this.inspectFailure);
        }
        if (!this.exists) return Promise.resolve(noSuch());
        const doc = goodDoc(this.withFixture);
        if (this.started && this.stateAfterStart !== null) Object.assign(doc.State, this.stateAfterStart);
        else if (this.started) {
          Object.assign(doc.State, {
            Status: "exited", ExitCode: this.startResult instanceof Error ? 0 : (this.startResult.exitCode ?? 0),
            StartedAt: "2026-11-14T16:00:00Z",
          });
        }
        if (this.foreignOwner) doc.Config["Labels"] = { other: "x" };
        this.tamper?.(doc);
        return Promise.resolve(res({ stdout: JSON.stringify([doc]) }));
      }
      case "start":
        this.started = true;
        if (this.startResult instanceof Error) return Promise.reject(this.startResult);
        return Promise.resolve(this.startResult);
      case "rm":
        this.rmCalled = true;
        if (this.rmRemoves) this.exists = false;
        return Promise.resolve(res());
      case "ps":
        return Promise.resolve(this.psFailure ?? res({ stdout: this.psStdout }));
      default:
        return Promise.reject(new Error(`unexpected docker subcommand ${String(args[0])}`));
    }
  };

  verbs(): string[] {
    return this.calls.map((c) => String(c.args[0]));
  }
  call(verb: string): { file: string; args: readonly string[]; opts: ProcessOptions } {
    const c = this.calls.find((x) => x.args[0] === verb);
    assert.ok(c, `no ${verb} call`);
    return c;
  }
}

function make(fake: FakeDocker, extra: Partial<SandboxOptions> = {}): DockerFixtureSandbox {
  return new DockerFixtureSandbox({
    executor: fake.executor,
    allowedImages: [IMAGE],
    commands: { "run-check": CMD },
    fixturesRoot: ROOT,
    realpath: (p) => p,
    ...extra,
  });
}

const req = { executionId: EXEC, commandId: "run-check", image: IMAGE };

/** Returns the value following each occurrence of `flag`. */
function valuesOf(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === flag) out.push(String(args[i + 1]));
  });
  return out;
}

describe("docker create arguments", () => {
  it("builds the fixed isolation argument array with no shell", async () => {
    const fake = new FakeDocker();
    const r = await make(fake).execute(req);
    assert.equal(r.kind, "exited");
    const create = fake.call("create");
    const a = create.args;

    assert.equal(create.file, "docker");
    assert.ok(a.every((x) => typeof x === "string"));
    assert.deepEqual(valuesOf(a, "--network"), ["none"]);
    assert.deepEqual(valuesOf(a, "--user"), ["65532:65532"]);
    assert.deepEqual(valuesOf(a, "--cap-drop"), ["ALL"]);
    assert.deepEqual(valuesOf(a, "--security-opt"), ["no-new-privileges"]);
    assert.deepEqual(valuesOf(a, "--pull"), ["never"]);
    assert.deepEqual(valuesOf(a, "--memory"), ["128m"]);
    assert.deepEqual(valuesOf(a, "--memory-swap"), ["128m"]);
    assert.deepEqual(valuesOf(a, "--cpus"), ["0.5"]);
    assert.deepEqual(valuesOf(a, "--pids-limit"), ["64"]);
    assert.deepEqual(valuesOf(a, "--tmpfs"), ["/tmp:rw,noexec,nosuid,nodev,size=16m"]);
    assert.deepEqual(valuesOf(a, "--entrypoint"), [""]);
    assert.deepEqual(valuesOf(a, "--name"), [NAME]);
    assert.ok(a.includes("--read-only"));

    const labels = valuesOf(a, "--label");
    assert.ok(labels.includes("graveyard.managed=true"));
    assert.ok(labels.includes(`graveyard.execution-id=${EXEC}`));

    // image then the fixed argv, exactly, at the end.
    assert.deepEqual(a.slice(-(CMD.length + 1)), [IMAGE, ...CMD]);
  });

  it("never uses a shell, privileged mode, host namespaces, volumes, env, docker socket or published ports", async () => {
    const fake = new FakeDocker();
    fake.withFixture = true;
    await make(fake).execute({ ...req, fixture: "case1" });
    for (const c of fake.calls) {
      assert.equal(c.file, "docker");
      for (const bad of ["sh", "bash", "cmd", "-c", "--privileged", "-v", "--volume", "-e", "--env", "--env-file",
        "-p", "--publish", "--device", "--cap-add", "--pid", "--ipc", "--userns", "--network=host", "host"]) {
        assert.ok(!c.args.includes(bad), `forbidden argument ${bad} in ${c.args.join(" ")}`);
      }
      assert.ok(!c.args.some((x) => /docker\.sock|\\\\\.\\pipe/.test(x)));
    }
  });

  it("mounts only the validated fixture, read-only, at /fixture", async () => {
    const fake = new FakeDocker();
    fake.withFixture = true;
    await make(fake).execute({ ...req, fixture: "case1" });
    const a = fake.call("create").args;
    assert.deepEqual(valuesOf(a, "--mount"), [`type=bind,source=${resolve(ROOT, "case1")},target=/fixture,readonly`]);
    assert.deepEqual(valuesOf(a, "--workdir"), ["/fixture"]);
    assert.ok(valuesOf(a, "--label").includes("graveyard.fixture=case1"));
  });

  it("adds no mount at all without a fixture", async () => {
    const fake = new FakeDocker();
    await make(fake).execute(req);
    assert.deepEqual(valuesOf(fake.call("create").args, "--mount"), []);
  });

  it("starts with an argument array naming only the container", async () => {
    const fake = new FakeDocker();
    await make(fake).execute(req);
    assert.deepEqual(fake.call("start").args, ["start", "--attach", NAME]);
  });

  it("passes the bounds to the executor", async () => {
    const fake = new FakeDocker();
    await make(fake, { limits: { timeoutMs: 5_000, maxOutputBytes: 2_048 } }).execute(req);
    const start = fake.call("start");
    assert.equal(start.opts.timeoutMs, 5_000);
    assert.equal(start.opts.maxOutputBytes, 2_048);
    assert.ok(fake.call("inspect").opts.timeoutMs <= 60_000);
  });
});

describe("successful run", () => {
  it("creates, inspects, starts, then removes and proves absence", async () => {
    const fake = new FakeDocker();
    const r = await make(fake).execute(req);
    assert.equal(r.kind, "exited");
    if (r.kind !== "exited") return;
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "ok\n");
    assert.deepEqual(fake.verbs(), ["version", "create", "inspect", "start", "inspect", "rm", "inspect", "ps"]);
    assert.ok(r.cleanup !== null && r.cleanup.confirmed === true);
    if (r.cleanup !== null && r.cleanup.confirmed) {
      assert.equal(r.cleanup.executionId, EXEC);
      assert.notEqual(r.cleanup.evidence.trim(), "");
    }
    assert.equal(fake.exists, false);
  });

  it("reports a non-zero container exit code as exited, not success", async () => {
    const fake = new FakeDocker();
    fake.startResult = res({ exitCode: 3, stderr: "boom" });
    const r = await make(fake).execute(req);
    assert.equal(r.kind, "exited");
    if (r.kind === "exited") assert.equal(r.exitCode, 3);
  });

  it("reports truncated output from the executor", async () => {
    const fake = new FakeDocker();
    fake.startResult = res({ stdout: "x".repeat(10), truncated: true });
    const r = await make(fake).execute(req);
    assert.equal(r.kind === "exited" && r.truncated, true);
  });
});

describe("fail closed", () => {
  it("treats a missing docker CLI as unavailable and creates nothing", async () => {
    const fake = new FakeDocker();
    fake.versionResult = new Error("spawn docker ENOENT");
    const r = await make(fake).execute(req);
    assert.equal(r.kind, "unavailable");
    assert.equal(r.cleanup, null);
    assert.deepEqual(fake.verbs(), ["version"]);
  });

  it("treats an unreachable daemon as unavailable and creates nothing", async () => {
    const fake = new FakeDocker();
    fake.versionResult = res({ exitCode: 1, stderr: "Cannot connect to the Docker daemon" });
    const r = await make(fake).execute(req);
    assert.equal(r.kind, "unavailable");
    assert.deepEqual(fake.verbs(), ["version"]);
  });

  it("treats an empty server version as unavailable", async () => {
    const fake = new FakeDocker();
    fake.versionResult = res({ stdout: "  \n" });
    assert.equal((await make(fake).execute(req)).kind, "unavailable");
  });

  it("does not start the container when create fails, and still attempts cleanup", async () => {
    const fake = new FakeDocker();
    const orig = fake.executor;
    const failing: ProcessExecutor = (f, a, o) =>
      a[0] === "create" ? Promise.resolve(res({ exitCode: 125, stderr: "Unable to find image locally" })) : orig(f, a, o);
    const r = await make(fake, { executor: failing }).execute(req);
    assert.equal(r.kind, "unavailable");
    assert.ok(!fake.verbs().includes("start"));
    assert.ok(r.cleanup !== null);
  });

  it("reports unavailable when the executor throws during start, with cleanup attempted", async () => {
    const fake = new FakeDocker();
    fake.startResult = new Error("spawn failed");
    const r = await make(fake).execute(req);
    assert.equal(r.kind, "unavailable");
    assert.ok(fake.verbs().includes("rm"));
    assert.equal(r.cleanup?.confirmed, true);
  });
});

describe("isolation verification via inspect", () => {
  const cases: Array<[string, (d: Doc) => void]> = [
    ["network is not none", (d) => { d.HostConfig["NetworkMode"] = "bridge"; }],
    ["privileged", (d) => { d.HostConfig["Privileged"] = true; }],
    ["writable root", (d) => { d.HostConfig["ReadonlyRootfs"] = false; }],
    ["caps not dropped", (d) => { d.HostConfig["CapDrop"] = null; }],
    ["caps added", (d) => { d.HostConfig["CapAdd"] = ["SYS_ADMIN"]; }],
    ["no-new-privileges missing", (d) => { d.HostConfig["SecurityOpt"] = null; }],
    ["root user", (d) => { d.Config["User"] = ""; }],
    ["memory differs", (d) => { d.HostConfig["Memory"] = 0; }],
    ["swap differs", (d) => { d.HostConfig["MemorySwap"] = -1; }],
    ["pids differs", (d) => { d.HostConfig["PidsLimit"] = 0; }],
    ["cpu differs", (d) => { d.HostConfig["NanoCpus"] = 0; }],
    ["host pid", (d) => { d.HostConfig["PidMode"] = "host"; }],
    ["binds present", (d) => { d.HostConfig["Binds"] = ["/var/run/docker.sock:/var/run/docker.sock"]; }],
    ["devices", (d) => { d.HostConfig["Devices"] = [{ PathOnHost: "/dev/kvm" }]; }],
    ["extra tmpfs", (d) => { d.HostConfig["Tmpfs"] = { "/tmp": "rw", "/data": "rw" }; }],
    ["unexpected mount", (d) => { d.Mounts = [{ Type: "bind", Destination: "/host", RW: true }]; }],
    ["wrong command", (d) => { d.Config["Cmd"] = ["/bin/sh", "-c", "id"]; }],
    ["entrypoint kept", (d) => { d.Config["Entrypoint"] = ["/bin/sh"]; }],
    ["labels missing", (d) => { d.Config["Labels"] = {}; }],
    ["log driver is local", (d) => { d.HostConfig["LogConfig"] = { Type: "local", Config: {} }; }],
    ["log max-file differs", (d) => { d.HostConfig["LogConfig"] = { Type: "json-file", Config: { "max-size": "64k", "max-file": "3" } }; }],
    ["log max-size differs", (d) => { d.HostConfig["LogConfig"] = { Type: "json-file", Config: { "max-size": "10m", "max-file": "1" } }; }],
    ["log has extra option", (d) => { d.HostConfig["LogConfig"] = { Type: "json-file", Config: { "max-size": "64k", "max-file": "1", compress: "true" } }; }],
    ["log config missing", (d) => { delete d.HostConfig["LogConfig"]; }],
    ["tmpfs lacks noexec", (d) => { d.HostConfig["Tmpfs"] = { "/tmp": "rw,nosuid,nodev,size=16m" }; }],
    ["tmpfs lacks nosuid", (d) => { d.HostConfig["Tmpfs"] = { "/tmp": "rw,noexec,nodev,size=16m" }; }],
    ["tmpfs lacks nodev", (d) => { d.HostConfig["Tmpfs"] = { "/tmp": "rw,noexec,nosuid,size=16m" }; }],
    ["tmpfs size differs", (d) => { d.HostConfig["Tmpfs"] = { "/tmp": "rw,noexec,nosuid,nodev,size=64m" }; }],
    ["tmpfs size missing", (d) => { d.HostConfig["Tmpfs"] = { "/tmp": "rw,noexec,nosuid,nodev" }; }],
    ["tmpfs options not a string", (d) => { d.HostConfig["Tmpfs"] = { "/tmp": null }; }],
    ["tmpfs conflicting exec", (d) => { d.HostConfig["Tmpfs"] = { "/tmp": "rw,noexec,exec,nosuid,nodev,size=16m" }; }],
  ];
  for (const [label, mutate] of cases) {
    it(`refuses to start when ${label}`, async () => {
      const fake = new FakeDocker();
      fake.tamper = mutate;
      // Cleanup of a mislabelled container is refused; that case is asserted separately.
      const r = await make(fake).execute(req);
      assert.equal(r.kind, "isolation-violation");
      assert.ok(!fake.verbs().includes("start"), "start must not be called");
    });
  }

  it("removes a violating container that carries this adapter's labels", async () => {
    const fake = new FakeDocker();
    fake.tamper = (d) => { d.HostConfig["NetworkMode"] = "bridge"; };
    const r = await make(fake).execute(req);
    assert.ok(fake.verbs().includes("rm"));
    assert.equal(fake.exists, false);
    assert.equal(r.cleanup?.confirmed, true);
  });

  it("rejects a fixture mount that is writable", async () => {
    const fake = new FakeDocker();
    fake.withFixture = true;
    fake.tamper = (d) => { d.Mounts = [{ Type: "bind", Destination: "/fixture", RW: true }]; };
    const r = await make(fake).execute({ ...req, fixture: "case1" });
    assert.equal(r.kind, "isolation-violation");
  });

  it("rejects a mount when none was requested", async () => {
    const fake = new FakeDocker();
    fake.tamper = (d) => { d.Mounts = [{ Type: "bind", Destination: "/fixture", RW: false }]; };
    assert.equal((await make(fake).execute(req)).kind, "isolation-violation");
  });
});

describe("log configuration", () => {
  it("passes an explicit bounded json-file log driver to create", async () => {
    const fake = new FakeDocker();
    await make(fake).execute(req);
    const a = fake.call("create").args;
    assert.deepEqual(valuesOf(a, "--log-driver"), ["json-file"]);
    assert.deepEqual(valuesOf(a, "--log-opt"), ["max-size=64k", "max-file=1"]);
  });

  it("does not start when Docker reports a different log driver", async () => {
    const fake = new FakeDocker();
    fake.tamper = (d) => { d.HostConfig["LogConfig"] = { Type: "local", Config: {} }; };
    const r = await make(fake).execute(req);
    assert.equal(r.kind, "isolation-violation");
    assert.ok(!fake.verbs().includes("start"));
    assert.equal(r.cleanup?.confirmed, true);
  });
});

describe("fixture mount source", () => {
  it("accepts a source equal to the resolved fixture path", async () => {
    const fake = new FakeDocker();
    fake.withFixture = true;
    assert.equal((await make(fake).execute({ ...req, fixture: "case1" })).kind, "exited");
  });

  for (const [label, source] of [
    ["another directory", resolve("/etc")],
    ["the fixtures root", ROOT],
    ["a prefix-sharing sibling", `${resolve(ROOT, "case1")}-other`],
    ["empty", ""],
    ["not a string", 42],
    ["absent", undefined],
  ] as Array<[string, unknown]>) {
    it(`refuses to start when the source is ${label}`, async () => {
      const fake = new FakeDocker();
      fake.withFixture = true;
      fake.tamper = (d) => { d.Mounts = [{ Type: "bind", Source: source, Destination: "/fixture", RW: false }]; };
      const r = await make(fake).execute({ ...req, fixture: "case1" });
      assert.equal(r.kind, "isolation-violation");
      assert.ok(!fake.verbs().includes("start"));
      assert.equal(r.cleanup?.confirmed, true);
    });
  }

  it("compares against the realpath-resolved source, not the requested name", async () => {
    const real = resolve("/graveyard-fixtures/case1-target");
    const fake = new FakeDocker();
    fake.withFixture = true;
    fake.tamper = (d) => { d.Mounts = [{ Type: "bind", Source: real, Destination: "/fixture", RW: false }]; };
    const sb = make(fake, { realpath: (p) => (p.endsWith("case1") ? real : p) });
    assert.equal((await sb.execute({ ...req, fixture: "case1" })).kind, "exited");
    assert.ok(valuesOf(fake.call("create").args, "--mount")[0]?.includes(`source=${real},`));
  });
});

describe("docker start failure versus fixture failure", () => {
  const daemonFailure = "docker: Error response from daemon: cannot start container";

  it("reports unavailable when inspect shows the container never started", async () => {
    const fake = new FakeDocker();
    fake.startResult = res({ exitCode: 125, stderr: daemonFailure });
    fake.stateAfterStart = { Status: "created", StartedAt: "0001-01-01T00:00:00Z", ExitCode: 0 };
    const r = await make(fake).execute(req);
    assert.equal(r.kind, "unavailable");
    assert.equal(r.cleanup?.confirmed, true);
    assert.equal(fake.exists, false);
  });

  it("reports unavailable when State.Error is set, even with a start time", async () => {
    const fake = new FakeDocker();
    fake.startResult = res({ exitCode: 126, stderr: "oci runtime error" });
    fake.stateAfterStart = { Status: "exited", StartedAt: "2026-11-14T16:00:00Z", ExitCode: 126, Error: "failed to create shim task" };
    const r = await make(fake).execute(req);
    assert.equal(r.kind, "unavailable");
    assert.equal(r.cleanup?.confirmed, true);
  });

  it("reports unavailable when the recorded exit code differs from docker start's", async () => {
    const fake = new FakeDocker();
    fake.startResult = res({ exitCode: 125 });
    fake.stateAfterStart = { Status: "exited", StartedAt: "2026-11-14T16:00:00Z", ExitCode: 0 };
    assert.equal((await make(fake).execute(req)).kind, "unavailable");
  });

  it("reports unavailable when the container state cannot be read, and still cleans up", async () => {
    const fake = new FakeDocker();
    fake.startResult = res({ exitCode: 125, stderr: daemonFailure });
    const orig = fake.executor;
    let afterStart = false;
    let failed = false;
    const flaky: ProcessExecutor = (f, a, o) => {
      if (a[0] === "start") afterStart = true;
      if (a[0] === "inspect" && afterStart && !failed) {
        failed = true;
        fake.calls.push({ file: f, args: a, opts: o });
        return Promise.resolve(res({ exitCode: 1, stderr: "daemon unreachable" }));
      }
      return orig(f, a, o);
    };
    const r = await make(fake, { executor: flaky }).execute(req);
    assert.equal(r.kind, "unavailable");
    assert.ok(fake.verbs().includes("rm"));
    assert.equal(r.cleanup?.confirmed, true);
  });

  it("still reports exited for a container that ran and failed itself", async () => {
    const fake = new FakeDocker();
    fake.startResult = res({ exitCode: 3, stderr: "assertion failed" });
    const r = await make(fake).execute(req);
    assert.equal(r.kind, "exited");
    if (r.kind === "exited") assert.equal(r.exitCode, 3);
  });

  it("does not claim cleanup when removal fails after a start failure", async () => {
    const fake = new FakeDocker();
    fake.startResult = res({ exitCode: 125, stderr: daemonFailure });
    fake.stateAfterStart = { Status: "created", StartedAt: "0001-01-01T00:00:00Z" };
    fake.rmRemoves = false;
    const r = await make(fake).execute(req);
    assert.equal(r.kind, "unavailable");
    assert.equal(r.cleanup?.confirmed, false);
  });
});

describe("timeout and cancellation", () => {
  it("reports timed-out, keeps partial bounded output and removes the container", async () => {
    const fake = new FakeDocker();
    fake.startResult = res({ exitCode: null, timedOut: true, stdout: "partial", truncated: true });
    const r = await make(fake).execute(req);
    assert.equal(r.kind, "timed-out");
    if (r.kind === "timed-out") {
      assert.equal(r.stdout, "partial");
      assert.equal(r.truncated, true);
    }
    assert.ok(fake.verbs().includes("rm"));
    assert.equal(r.cleanup?.confirmed, true);
  });

  it("passes the abort signal to the start call and reports aborted", async () => {
    const fake = new FakeDocker();
    const ac = new AbortController();
    fake.startResult = res({ exitCode: null, aborted: true });
    const r = await make(fake).execute({ ...req, signal: ac.signal });
    assert.equal(r.kind, "aborted");
    assert.equal(fake.call("start").opts.signal, ac.signal);
    assert.equal(r.cleanup?.confirmed, true);
  });

  it("does not start when already aborted, and still cleans up", async () => {
    const fake = new FakeDocker();
    const ac = new AbortController();
    ac.abort();
    const r = await make(fake).execute({ ...req, signal: ac.signal });
    assert.equal(r.kind, "aborted");
    assert.ok(!fake.verbs().includes("start"));
    assert.equal(r.cleanup?.confirmed, true);
  });

  it("clamps per-request timeouts to the configured maximum", async () => {
    const fake = new FakeDocker();
    const r = await make(fake, { limits: { timeoutMs: 5_000 } }).execute({ ...req, timeoutMs: 60_000 });
    assert.equal(r.kind, "rejected");
    assert.deepEqual(fake.calls, []);
  });

  it("uses a shorter requested timeout", async () => {
    const fake = new FakeDocker();
    await make(fake).execute({ ...req, timeoutMs: 2_000 });
    assert.equal(fake.call("start").opts.timeoutMs, 2_000);
  });
});

describe("cleanup failures are never reported as confirmed", () => {
  it("rm that does not remove the container", async () => {
    const fake = new FakeDocker();
    fake.rmRemoves = false;
    const r = await make(fake).execute(req);
    assert.equal(r.kind, "exited");
    assert.equal(r.cleanup?.confirmed, false);
  });

  it("daemon error while proving absence", async () => {
    const fake = new FakeDocker();
    fake.inspectFailure = res({ exitCode: 1, stderr: "Cannot connect to the Docker daemon" });
    fake.inspectFailureOnlyAfterRm = true;
    const r = await make(fake).execute(req);
    assert.equal(r.cleanup?.confirmed, false);
  });

  it("inspect timeout", async () => {
    const fake = new FakeDocker();
    const proof = await make(Object.assign(fake, { inspectFailure: res({ exitCode: null, timedOut: true }) })).cleanup({ executionId: EXEC });
    assert.equal(proof.confirmed, false);
  });

  it("label query still lists a container", async () => {
    const fake = new FakeDocker();
    fake.psStdout = "deadbeef\n";
    const proof = await make(fake).cleanup({ executionId: EXEC });
    assert.equal(proof.confirmed, false);
  });

  it("label query failure", async () => {
    const fake = new FakeDocker();
    fake.psFailure = res({ exitCode: 1, stderr: "denied" });
    assert.equal((await make(fake).cleanup({ executionId: EXEC })).confirmed, false);
  });

  it("refuses to remove a container whose labels do not match", async () => {
    const fake = new FakeDocker();
    fake.exists = true;
    fake.foreignOwner = true;
    const proof = await make(fake).cleanup({ executionId: EXEC });
    assert.equal(proof.confirmed, false);
    assert.ok(!fake.verbs().includes("rm"));
  });

  it("executor failure during cleanup", async () => {
    const boom: ProcessExecutor = () => Promise.reject(new Error("spawn failed"));
    const proof = await make(new FakeDocker(), { executor: boom }).cleanup({ executionId: EXEC });
    assert.equal(proof.confirmed, false);
  });

  it("invalid execution id never reaches docker", async () => {
    const fake = new FakeDocker();
    const proof = await make(fake).cleanup({ executionId: "x;rm -rf /:1" });
    assert.equal(proof.confirmed, false);
    assert.deepEqual(fake.calls, []);
  });

  it("is idempotent when nothing exists and then confirms from inspect", async () => {
    const fake = new FakeDocker();
    const proof = await make(fake).cleanup({ executionId: EXEC });
    assert.equal(proof.confirmed, true);
    assert.deepEqual(fake.verbs(), ["inspect", "ps"]);
    if (proof.confirmed) assert.equal(proof.executionId, EXEC);
  });
});

describe("request and configuration validation (no docker contact)", () => {
  const rejects = async (r: Partial<typeof req> & { fixture?: string }, why: RegExp): Promise<void> => {
    const fake = new FakeDocker();
    const out = await make(fake).execute({ ...req, ...r });
    assert.equal(out.kind, "rejected");
    if (out.kind === "rejected") assert.match(out.reason, why);
    assert.deepEqual(fake.calls, []);
  };

  it("unknown command id", () => rejects({ commandId: "sh -c id" }, /unknown command/));
  it("image outside the allowlist", () => rejects({ image: "alpine:latest" }, /allowlist/));
  it("shell metacharacters in the execution id", () => rejects({ executionId: "a;b:1" }, /execution id/));
  it("command substitution in the execution id", () => rejects({ executionId: "$(id):1" }, /execution id/));
  it("fixture traversal", () => rejects({ fixture: ".." }, /fixture name/));
  it("fixture with a path separator", () => rejects({ fixture: "a/b" }, /fixture name/));
  it("fixture with mount-option injection", () => rejects({ fixture: "a,source=/etc" }, /fixture name/));
  it("fixture with command substitution", () => rejects({ fixture: "$(id)" }, /fixture name/));

  it("fixture symlink escaping the root", async () => {
    const fake = new FakeDocker();
    const sb = make(fake, { realpath: (p) => (p.endsWith("evil") ? resolve("/etc") : p) });
    const out = await sb.execute({ ...req, fixture: "evil" });
    assert.equal(out.kind, "rejected");
    assert.deepEqual(fake.calls, []);
  });

  it("missing fixture directory", async () => {
    const fake = new FakeDocker();
    const sb = make(fake, { realpath: (p) => { if (p.endsWith("gone")) throw new Error("ENOENT"); return p; } });
    assert.equal((await sb.execute({ ...req, fixture: "gone" })).kind, "rejected");
  });

  it("fixture without a configured root", async () => {
    const fake = new FakeDocker();
    const sb = new DockerFixtureSandbox({
      executor: fake.executor, allowedImages: [IMAGE], commands: { "run-check": CMD },
    });
    assert.equal((await sb.execute({ ...req, fixture: "case1" })).kind, "rejected");
  });

  it("rejects bad construction", () => {
    const ok: SandboxOptions = { executor: new FakeDocker().executor, allowedImages: [IMAGE], commands: { a: ["/x"] } };
    assert.throws(() => new DockerFixtureSandbox({ ...ok, allowedImages: [] }));
    assert.throws(() => new DockerFixtureSandbox({ ...ok, allowedImages: ["-v /:/h evil"] }));
    assert.throws(() => new DockerFixtureSandbox({ ...ok, allowedImages: ["Image With Space"] }));
    assert.throws(() => new DockerFixtureSandbox({ ...ok, commands: {} }));
    assert.throws(() => new DockerFixtureSandbox({ ...ok, commands: { a: [] } }));
    assert.throws(() => new DockerFixtureSandbox({ ...ok, commands: { a: ["x\0y"] } }));
    assert.throws(() => new DockerFixtureSandbox({ ...ok, commands: { "Bad Id": ["/x"] } }));
    assert.throws(() => new DockerFixtureSandbox({ ...ok, limits: { memoryMb: 100_000 } }));
    assert.throws(() => new DockerFixtureSandbox({ ...ok, limits: { cpus: 0 } }));
    assert.throws(() => new DockerFixtureSandbox({ ...ok, limits: { pids: Number.NaN } }));
    assert.throws(() => new DockerFixtureSandbox({ ...ok, dockerBinary: "docker; id" }));
    assert.throws(() => new DockerFixtureSandbox({ ...ok, fixturesRoot: "relative/dir" }));
  });

  it("maps execution ids to container names injectively and rejects invalid ids", () => {
    assert.equal(containerNameFor(EXEC), NAME);
    assert.throws(() => containerNameFor("no-attempt"));
    assert.throws(() => containerNameFor("a b:1"));
  });
});
