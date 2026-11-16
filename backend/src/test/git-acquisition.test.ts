/**
 * git-acquisition.test.ts — acquisition adapter against a MOCKED docker CLI.
 *
 * No process is spawned and no Docker daemon, git, proxy or network is used.
 * These tests check the arguments the adapter builds, that it fails closed
 * without verified egress, how it handles timeout/abort/hostile input, and
 * its cleanup proof. They do NOT show that real Docker or git enforce the
 * settings, or that any proxy restricts traffic to github.com.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GitAcquisition,
  acquisitionContainerName,
  type AcquisitionOptions,
} from "../git-acquisition.js";
import {
  GIT_ENV,
  UnavailableEgressGuard,
  type EgressAttestation,
  type EgressGuard,
} from "../acquisition-policy.js";
import type { ProcessExecutor, ProcessOptions, ProcessResult } from "../docker-sandbox.js";

const EXEC = "0b1c2d3e-aaaa-bbbb:1";
const NAME = "graveyard-acq-0b1c2d3e-aaaa-bbbb_1";
const IMAGE = "graveyard-git:local";
const NET = "acq-egress";
const PROXY = "http://egress-proxy:3128";
const URL_ = "https://github.com/owner/repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const OID = "89abcdef0123456789abcdef0123456789abcdef";
const MB = 1024 * 1024;

const res = (p: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, ...p,
});
const noSuch = (): ProcessResult => res({ exitCode: 1, stderr: `Error: No such object: ${NAME}\n` });
const entry = (mode: string, size: string, path: string): string =>
  `${mode} ${mode === "160000" ? "commit" : "blob"} ${OID} ${size.padStart(7, " ")}\t${path}\0`;
const GOOD_TREE = entry("100644", "20", "README.md") + entry("100755", "30", "bin/run");

const goodEgress: EgressAttestation = {
  verified: true, network: NET, proxyUrl: PROXY, allowedHosts: ["github.com"], evidence: "test attestation",
};
class CountingGuard implements EgressGuard {
  calls = 0;
  constructor(private readonly a: EgressAttestation | Error) {}
  attest(): Promise<EgressAttestation> {
    this.calls += 1;
    return this.a instanceof Error ? Promise.reject(this.a) : Promise.resolve(this.a);
  }
}
const guard = (a: EgressAttestation | Error): CountingGuard => new CountingGuard(a);

interface Doc {
  Config: Record<string, unknown>;
  HostConfig: Record<string, unknown>;
  NetworkSettings: Record<string, unknown>;
  Mounts: unknown[];
}

/** Independent statement of what a correctly isolated acquisition container looks like. */
function goodDoc(): Doc {
  return {
    Config: {
      User: "65532:65532",
      Image: IMAGE,
      Entrypoint: [""],
      Env: ["PATH=/usr/bin", ...GIT_ENV],
      Labels: { "graveyard.managed": "true", "graveyard.acquisition-id": EXEC },
    },
    HostConfig: {
      NetworkMode: NET,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      CapAdd: null,
      SecurityOpt: ["no-new-privileges"],
      Memory: 512 * MB,
      MemorySwap: 512 * MB,
      PidsLimit: 128,
      NanoCpus: 1_000_000_000,
      PidMode: "",
      IpcMode: "private",
      Binds: null,
      Devices: [],
      VolumesFrom: null,
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,nodev,size=16m",
        "/work": "rw,noexec,nosuid,nodev,size=256m,uid=65532,gid=65532,mode=0700",
        "/git": "rw,noexec,nosuid,nodev,size=16m",
      },
      LogConfig: { Type: "json-file", Config: { "max-size": "64k", "max-file": "1" } },
    },
    NetworkSettings: { Networks: { [NET]: {} } },
    Mounts: [],
  };
}

type Hook = (opts: ProcessOptions) => Promise<ProcessResult>;

/** Identifies which git step a `docker exec` call is, skipping the `-c k=v` hardening pairs. */
function gitKey(args: readonly string[]): string {
  let i = args.indexOf("git") + 1;
  while (args[i] === "-c") i += 2;
  const sub = String(args[i]);
  if (sub === "rev-parse") return args.includes("--verify") ? "verify-commit" : "head";
  return sub;
}

class FakeDocker {
  readonly calls: Array<{ file: string; args: readonly string[]; opts: ProcessOptions }> = [];
  readonly gitOrder: string[] = [];
  exists = false;
  started = false;
  rmCalled = false;
  rmRemoves = true;
  foreignOwner = false;
  psStdout = "";
  tamper: ((d: Doc) => void) | null = null;
  versionResult: ProcessResult | Error = res({ stdout: "29.0.0\n" });
  networkResult: ProcessResult = res({ stdout: JSON.stringify([{ Name: NET, Internal: true }]) });
  results: Record<string, ProcessResult | Error> = {
    init: res(),
    fetch: res(),
    "verify-commit": res({ stdout: `${SHA}\n` }),
    "ls-tree": res({ stdout: GOOD_TREE }),
    checkout: res(),
    head: res({ stdout: `${SHA}\n` }),
  };
  hooks: Record<string, Hook> = {};

  readonly executor: ProcessExecutor = (file, args, opts) => {
    this.calls.push({ file, args, opts });
    switch (args[0]) {
      case "version":
        return this.versionResult instanceof Error ? Promise.reject(this.versionResult) : Promise.resolve(this.versionResult);
      case "network":
        return Promise.resolve(this.networkResult);
      case "create":
        this.exists = true;
        return Promise.resolve(res({ stdout: "abc123\n" }));
      case "inspect": {
        if (!this.exists) return Promise.resolve(noSuch());
        const doc = goodDoc();
        if (this.foreignOwner) doc.Config["Labels"] = { other: "x" };
        this.tamper?.(doc);
        return Promise.resolve(res({ stdout: JSON.stringify([doc]) }));
      }
      case "start":
        this.started = true;
        return Promise.resolve(res());
      case "exec": {
        const key = gitKey(args);
        this.gitOrder.push(key);
        const hook = this.hooks[key];
        if (hook !== undefined) return hook(opts);
        const r = this.results[key];
        if (r === undefined) return Promise.reject(new Error(`unexpected git step ${key}`));
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      }
      case "rm":
        this.rmCalled = true;
        if (this.rmRemoves) this.exists = false;
        return Promise.resolve(res());
      case "ps":
        return Promise.resolve(res({ stdout: this.psStdout }));
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

function make(
  fake: FakeDocker,
  g: EgressGuard = guard(goodEgress),
  extra: Partial<AcquisitionOptions> = {},
): GitAcquisition {
  return new GitAcquisition({ executor: fake.executor, egress: g, allowedImages: [IMAGE], ...extra });
}

const req = { executionId: EXEC, repoUrl: URL_, commit: SHA, image: IMAGE };

function valuesOf(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === flag) out.push(String(args[i + 1]));
  });
  return out;
}

// ---------------------------------------------------------------------------

describe("successful acquisition (mock)", () => {
  it("runs the steps in order, verifies identity, and proves cleanup", async () => {
    const fake = new FakeDocker();
    const r = await make(fake).acquire(req);
    assert.equal(r.kind, "acquired");
    if (r.kind === "acquired") {
      assert.equal(r.commit, SHA);
      assert.deepEqual(r.manifest, { files: 2, totalBytes: 50, submodulesSkipped: 0 });
    }
    assert.deepEqual(fake.gitOrder, ["init", "fetch", "verify-commit", "ls-tree", "checkout", "head"]);
    const v = fake.verbs();
    assert.ok(v.indexOf("version") < v.indexOf("network"));
    assert.ok(v.indexOf("network") < v.indexOf("create"));
    assert.ok(v.indexOf("create") < v.indexOf("start"));
    assert.ok(v.indexOf("start") < v.indexOf("exec"));
    assert.ok(v.indexOf("exec") < v.indexOf("rm"));
    assert.deepEqual(r.cleanup && r.cleanup.confirmed, true);
    assert.equal(fake.exists, false);
  });

  it("lists and checks the tree before checking anything out", async () => {
    const fake = new FakeDocker();
    await make(fake).acquire(req);
    assert.ok(fake.gitOrder.indexOf("ls-tree") < fake.gitOrder.indexOf("checkout"));
  });
});

describe("container and git arguments", () => {
  it("uses only argument arrays on the docker binary, never a shell", async () => {
    const fake = new FakeDocker();
    await make(fake).acquire(req);
    for (const c of fake.calls) {
      assert.equal(c.file, "docker");
      assert.ok(c.args.every((a) => typeof a === "string"));
    }
    const all = fake.calls.flatMap((c) => [...c.args]);
    for (const banned of ["sh", "bash", "-c sh", "cmd", "powershell", "/bin/sh"]) {
      assert.ok(!all.includes(banned), banned);
    }
    assert.ok(!all.some((a) => a.includes("docker.sock")));
  });

  it("creates a locked-down container on the attested network, with no mounts, ports or host env", async () => {
    const fake = new FakeDocker();
    await make(fake).acquire(req);
    const a = fake.call("create").args;
    assert.deepEqual(valuesOf(a, "--network"), [NET]);
    assert.deepEqual(valuesOf(a, "--user"), ["65532:65532"]);
    assert.deepEqual(valuesOf(a, "--cap-drop"), ["ALL"]);
    assert.deepEqual(valuesOf(a, "--security-opt"), ["no-new-privileges"]);
    assert.deepEqual(valuesOf(a, "--pull"), ["never"]);
    assert.deepEqual(valuesOf(a, "--memory"), ["512m"]);
    assert.deepEqual(valuesOf(a, "--memory-swap"), ["512m"]);
    assert.deepEqual(valuesOf(a, "--pids-limit"), ["128"]);
    assert.deepEqual(valuesOf(a, "--name"), [NAME]);
    assert.deepEqual(valuesOf(a, "--entrypoint"), [""]);
    assert.ok(a.includes("--read-only"));
    assert.deepEqual(valuesOf(a, "--tmpfs"), [
      "/tmp:rw,noexec,nosuid,nodev,size=16m",
      "/work:rw,noexec,nosuid,nodev,size=256m,uid=65532,gid=65532,mode=0700",
      "/git:rw,noexec,nosuid,nodev,size=16m",
    ]);
    assert.deepEqual(valuesOf(a, "--env"), [...GIT_ENV]);
    for (const banned of [
      "--privileged", "-v", "--volume", "--mount", "-p", "--publish", "-P", "--env-file", "--device",
      "--volumes-from", "--pid", "--ipc", "--uts", "--cap-add", "--add-host", "--link",
    ]) {
      assert.ok(!a.includes(banned), banned);
    }
    for (const bad of ["bridge", "host", "none", "default"]) assert.ok(!valuesOf(a, "--network").includes(bad));
    // image, then a bounded sleep as the only container command.
    const i = a.indexOf(IMAGE);
    assert.deepEqual(a.slice(i, i + 2), [IMAGE, "sleep"]);
    assert.equal(a.length, i + 3);
    assert.ok(Number(a[i + 2]) >= 330);
  });

  it("runs every git step as non-root with hardening before the subcommand and bounded options", async () => {
    const fake = new FakeDocker();
    await make(fake).acquire(req);
    const execs = fake.calls.filter((c) => c.args[0] === "exec");
    assert.equal(execs.length, 6);
    for (const c of execs) {
      const a = c.args;
      assert.deepEqual(a.slice(0, 7), ["exec", "--user", "65532:65532", "--workdir", "/work", NAME, "git"]);
      for (const need of [
        "core.hooksPath=/dev/null", "credential.helper=", "protocol.allow=never", "protocol.https.allow=always",
        "submodule.recurse=false", "filter.lfs.smudge=", "core.symlinks=false", `http.proxy=${PROXY}`,
      ]) {
        assert.ok(a.includes(need), need);
      }
      assert.ok(c.opts.timeoutMs > 0 && c.opts.timeoutMs <= 120_000);
      assert.ok(c.opts.maxOutputBytes > 0);
    }
    const fetch = execs.find((c) => gitKey(c.args) === "fetch");
    assert.ok(fetch);
    assert.deepEqual(fetch.args.slice(-8), [
      "fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", URL_, SHA,
    ]);
    const ls = execs.find((c) => gitKey(c.args) === "ls-tree");
    assert.equal(ls?.opts.maxOutputBytes, 4 * MB);
  });

  it("passes a canonical URL as a single argument", async () => {
    const fake = new FakeDocker();
    await make(fake).acquire({ ...req, repoUrl: "https://github.com/owner/repo.git" });
    const fetch = fake.calls.find((c) => c.args[0] === "exec" && gitKey(c.args) === "fetch");
    assert.equal(fetch?.args.filter((a) => a.includes("github.com")).length, 1);
    assert.ok(fetch?.args.includes(URL_));
  });
});

describe("fail closed without verified controlled egress", () => {
  it("the default guard disables acquisition and nothing runs", async () => {
    const fake = new FakeDocker();
    const r = await make(fake, new UnavailableEgressGuard()).acquire(req);
    assert.equal(r.kind, "network-unavailable");
    assert.equal(r.cleanup, null);
    assert.equal(fake.calls.length, 0);
  });

  it("a throwing guard fails closed", async () => {
    const fake = new FakeDocker();
    const r = await make(fake, guard(new Error("boom"))).acquire(req);
    assert.equal(r.kind, "network-unavailable");
    assert.equal(fake.calls.length, 0);
  });

  it("an attestation naming the default bridge or host network is refused", async () => {
    for (const network of ["bridge", "host", "none"]) {
      const fake = new FakeDocker();
      const r = await make(fake, guard({ ...goodEgress, network } as EgressAttestation)).acquire(req);
      assert.equal(r.kind, "network-unavailable", network);
      assert.equal(fake.calls.length, 0, network);
    }
  });

  it("a network that docker does not report as Internal is refused before any container exists", async () => {
    for (const out of [
      res({ stdout: JSON.stringify([{ Name: NET, Internal: false }]) }),
      res({ stdout: JSON.stringify([{ Name: NET }]) }),
      res({ stdout: JSON.stringify([{ Name: "other", Internal: true }]) }),
      res({ stdout: "not json" }),
      res({ exitCode: 1, stderr: "network not found" }),
      res({ timedOut: true, exitCode: null }),
    ]) {
      const fake = new FakeDocker();
      fake.networkResult = out;
      const r = await make(fake).acquire(req);
      assert.equal(r.kind, "network-unavailable");
      assert.ok(!fake.verbs().includes("create"));
      assert.equal(r.cleanup, null);
    }
  });

  it("an unreachable docker daemon fails closed", async () => {
    const down = new FakeDocker();
    down.versionResult = res({ exitCode: 1, stderr: "cannot connect" });
    const a = await make(down).acquire(req);
    assert.equal(a.kind, "unavailable");
    assert.ok(!down.verbs().includes("create"));

    const missing = new FakeDocker();
    missing.versionResult = new Error("ENOENT");
    const b = await make(missing).acquire(req);
    assert.equal(b.kind, "unavailable");
  });
});

describe("hostile input", () => {
  it("rejects bad requests before contacting the guard or docker", async () => {
    const bad = [
      { ...req, commit: "main" },
      { ...req, commit: SHA.slice(0, 10) },
      { ...req, commit: "--upload-pack=x" },
      { ...req, repoUrl: "https://evil.example/owner/repo" },
      { ...req, repoUrl: "https://github.com/owner/repo; rm -rf /" },
      { ...req, repoUrl: "file:///etc" },
      { ...req, image: "alpine/git:latest" },
      { ...req, executionId: "x;y:1" },
      { ...req, executionId: "../../etc:1" },
    ];
    for (const b of bad) {
      const fake = new FakeDocker();
      const g = guard(goodEgress);
      const r = await make(fake, g).acquire(b);
      assert.equal(r.kind, "rejected", JSON.stringify(b));
      assert.equal(g.calls, 0);
      assert.equal(fake.calls.length, 0);
      assert.equal(r.cleanup, null);
    }
  });

  it("sanitises git stderr that tries to inject control characters", async () => {
    const fake = new FakeDocker();
    fake.results["fetch"] = res({ exitCode: 128, stderr: "fatal: bad\r\nFAKE-LOG-LINE \u001b[31m\u202e" });
    const r = await make(fake).acquire(req);
    assert.equal(r.kind, "failed");
    if (r.kind === "failed") {
      assert.equal(r.step, "fetch");
      assert.ok(/^[\x20-\x7e]*$/.test(r.reason));
    }
    assert.equal(r.cleanup?.confirmed, true);
  });
});

describe("source policy", () => {
  it("rejects a fetched commit whose identity differs, and never checks out", async () => {
    const fake = new FakeDocker();
    fake.results["verify-commit"] = res({ stdout: `${OTHER_SHA}\n` });
    const r = await make(fake).acquire(req);
    assert.equal(r.kind, "source-rejected");
    assert.ok(!fake.gitOrder.includes("checkout"));
    assert.equal(r.cleanup?.confirmed, true);
  });

  it("rejects symlinks, traversal paths, and git-directory paths before checkout", async () => {
    for (const tree of [
      GOOD_TREE + entry("120000", "10", "escape"),
      GOOD_TREE + entry("100644", "1", "../../outside"),
      GOOD_TREE + entry("100644", "1", ".git/hooks/post-checkout"),
      GOOD_TREE + entry("100644", "1", "readme.MD"),
    ]) {
      const fake = new FakeDocker();
      fake.results["ls-tree"] = res({ stdout: tree });
      const r = await make(fake).acquire(req);
      assert.equal(r.kind, "source-rejected");
      assert.ok(!fake.gitOrder.includes("checkout"));
      assert.equal(r.cleanup?.confirmed, true);
    }
  });

  it("rejects a truncated tree listing instead of trusting a prefix", async () => {
    const fake = new FakeDocker();
    fake.results["ls-tree"] = res({ stdout: GOOD_TREE, truncated: true });
    const r = await make(fake).acquire(req);
    assert.equal(r.kind, "source-rejected");
    assert.ok(!fake.gitOrder.includes("checkout"));
  });

  it("rejects an oversized tree by file count", async () => {
    const fake = new FakeDocker();
    const a = make(fake, guard(goodEgress), { limits: { maxFiles: 1 } });
    const r = await a.acquire(req);
    assert.equal(r.kind, "source-rejected");
    assert.ok(!fake.gitOrder.includes("checkout"));
  });

  it("rejects a checkout whose HEAD differs from the requested SHA", async () => {
    const fake = new FakeDocker();
    fake.results["head"] = res({ stdout: `${OTHER_SHA}\n` });
    const r = await make(fake).acquire(req);
    assert.equal(r.kind, "source-rejected");
  });

  it("reports a nonexistent commit as a failure, not success", async () => {
    const fake = new FakeDocker();
    fake.results["fetch"] = res({ exitCode: 128, stderr: "fatal: remote error: upload-pack: not our ref" });
    const r = await make(fake).acquire(req);
    assert.equal(r.kind, "failed");
    assert.ok(!fake.gitOrder.includes("checkout"));
  });
});

describe("isolation verification", () => {
  const GIT_TMPFS = "rw,noexec,nosuid,nodev,size=16m";
  const setGit = (d: Doc, opts: string): void => {
    (d.HostConfig["Tmpfs"] as Record<string, string>)["/git"] = opts;
  };
  const tampers: Array<[string, (d: Doc) => void]> = [
    ["default bridge network", (d) => { d.HostConfig["NetworkMode"] = "bridge"; }],
    ["host network", (d) => { d.HostConfig["NetworkMode"] = "host"; }],
    ["extra attached network", (d) => { d.NetworkSettings["Networks"] = { [NET]: {}, bridge: {} }; }],
    ["privileged", (d) => { d.HostConfig["Privileged"] = true; }],
    ["docker socket bind", (d) => { d.HostConfig["Binds"] = ["/var/run/docker.sock:/var/run/docker.sock"]; }],
    ["mount present", (d) => { d.Mounts = [{ Type: "bind", Source: "/", Destination: "/host" }]; }],
    ["capabilities added", (d) => { d.HostConfig["CapAdd"] = ["NET_ADMIN"]; }],
    ["writable root", (d) => { d.HostConfig["ReadonlyRootfs"] = false; }],
    ["root user", (d) => { d.Config["User"] = "0:0"; }],
    ["missing git env", (d) => { d.Config["Env"] = ["PATH=/usr/bin"]; }],
    ["no /work tmpfs", (d) => {
      d.HostConfig["Tmpfs"] = { "/tmp": "rw,noexec,nosuid,nodev,size=16m", "/git": GIT_TMPFS };
    }],
    ["oversized /work tmpfs", (d) => {
      d.HostConfig["Tmpfs"] = {
        "/tmp": "rw,noexec,nosuid,nodev,size=16m",
        "/work": "rw,noexec,nosuid,nodev,size=9999m",
        "/git": GIT_TMPFS,
      };
    }],
    ["exec-capable /work", (d) => {
      d.HostConfig["Tmpfs"] = {
        "/tmp": "rw,noexec,nosuid,nodev,size=16m",
        "/work": "rw,exec,nosuid,nodev,size=256m",
        "/git": GIT_TMPFS,
      };
    }],
    ["missing /git tmpfs", (d) => { delete (d.HostConfig["Tmpfs"] as Record<string, string>)["/git"]; }],
    ["anonymous /git volume mount", (d) => {
      delete (d.HostConfig["Tmpfs"] as Record<string, string>)["/git"];
      d.Mounts = [{ Type: "volume", Destination: "/git", RW: true }];
    }],
    ["exec-capable /git", (d) => { setGit(d, "rw,exec,nosuid,nodev,size=16m"); }],
    ["suid-capable /git", (d) => { setGit(d, "rw,noexec,suid,nodev,size=16m"); }],
    ["dev-capable /git", (d) => { setGit(d, "rw,noexec,nosuid,dev,size=16m"); }],
    ["read-only /git", (d) => { setGit(d, "ro,noexec,nosuid,nodev,size=16m"); }],
    ["oversized /git", (d) => { setGit(d, "rw,noexec,nosuid,nodev,size=32m"); }],
    ["unsized /git", (d) => { setGit(d, "rw,noexec,nosuid,nodev"); }],
    ["/git with extra option", (d) => { setGit(d, "rw,noexec,nosuid,nodev,size=16m,mode=1777"); }],
    ["unexpected extra tmpfs", (d) => {
      (d.HostConfig["Tmpfs"] as Record<string, string>)["/extra"] = "rw,noexec,nosuid,nodev,size=1m";
    }],
    ["pids limit", (d) => { d.HostConfig["PidsLimit"] = 0; }],
    ["host pid namespace", (d) => { d.HostConfig["PidMode"] = "host"; }],
    ["unbounded logs", (d) => { d.HostConfig["LogConfig"] = { Type: "json-file", Config: {} }; }],
  ];
  for (const [label, fn] of tampers) {
    it(`does not start the container: ${label}`, async () => {
      const fake = new FakeDocker();
      fake.tamper = fn;
      const r = await make(fake).acquire(req);
      assert.equal(r.kind, "isolation-violation");
      assert.equal(fake.started, false);
      assert.equal(fake.gitOrder.length, 0);
      assert.equal(r.cleanup?.confirmed, true);
      assert.equal(fake.exists, false);
    });
  }
});

describe("timeout, cancellation and deadline", () => {
  it("reports a step timeout and still proves cleanup", async () => {
    const fake = new FakeDocker();
    fake.results["fetch"] = res({ exitCode: null, timedOut: true });
    const r = await make(fake).acquire(req);
    assert.equal(r.kind, "timed-out");
    if (r.kind === "timed-out") assert.equal(r.step, "fetch");
    assert.ok(!fake.gitOrder.includes("checkout"));
    assert.equal(r.cleanup?.confirmed, true);
    assert.equal(fake.exists, false);
  });

  it("abort during fetch stops the run, passes the signal, and removes the container", async () => {
    const fake = new FakeDocker();
    const ac = new AbortController();
    fake.hooks["fetch"] = (opts) =>
      new Promise<ProcessResult>((resolve) => {
        assert.equal(opts.signal, ac.signal);
        opts.signal?.addEventListener("abort", () => resolve(res({ exitCode: null, aborted: true })), { once: true });
        queueMicrotask(() => ac.abort());
      });
    const r = await make(fake).acquire({ ...req, signal: ac.signal });
    assert.equal(r.kind, "aborted");
    assert.ok(!fake.gitOrder.includes("verify-commit"));
    assert.equal(r.cleanup?.confirmed, true);
    assert.equal(fake.rmCalled, true);
  });

  it("abort between steps stops before the next step", async () => {
    const fake = new FakeDocker();
    const ac = new AbortController();
    fake.hooks["init"] = () => {
      ac.abort();
      return Promise.resolve(res());
    };
    const r = await make(fake).acquire({ ...req, signal: ac.signal });
    assert.equal(r.kind, "aborted");
    assert.deepEqual(fake.gitOrder, ["init"]);
    assert.equal(r.cleanup?.confirmed, true);
  });

  it("an already-aborted signal creates nothing", async () => {
    const fake = new FakeDocker();
    const ac = new AbortController();
    ac.abort();
    const r = await make(fake).acquire({ ...req, signal: ac.signal });
    assert.equal(r.kind, "aborted");
    assert.equal(fake.calls.length, 0);
    assert.equal(r.cleanup, null);
  });

  it("enforces the total deadline across steps using the injected clock", async () => {
    const fake = new FakeDocker();
    let t = 1_000_000;
    fake.hooks["fetch"] = () => {
      t += 400_000; // beyond the default 300 s total
      return Promise.resolve(res());
    };
    const r = await make(fake, guard(goodEgress), { now: () => t }).acquire(req);
    assert.equal(r.kind, "timed-out");
    if (r.kind === "timed-out") assert.equal(r.step, "verify-commit");
    assert.equal(r.cleanup?.confirmed, true);
  });

  it("caps each step timeout at the remaining total time", async () => {
    const fake = new FakeDocker();
    let t = 0;
    fake.hooks["init"] = () => {
      t += 250_000;
      return Promise.resolve(res());
    };
    await make(fake, guard(goodEgress), { now: () => t }).acquire(req);
    const fetch = fake.calls.find((c) => c.args[0] === "exec" && gitKey(c.args) === "fetch");
    assert.equal(fetch?.opts.timeoutMs, 50_000);
  });
});

describe("cleanup proof", () => {
  it("is not confirmed when the container survives removal, and the result still carries it", async () => {
    const fake = new FakeDocker();
    fake.rmRemoves = false;
    const r = await make(fake).acquire(req);
    assert.equal(r.kind, "acquired");
    assert.equal(r.cleanup?.confirmed, false);
  });

  it("is not confirmed when a labelled container still exists", async () => {
    const fake = new FakeDocker();
    fake.psStdout = "abc123\n";
    const r = await make(fake).acquire(req);
    assert.equal(r.cleanup?.confirmed, false);
  });

  it("refuses to remove a container it does not own", async () => {
    const fake = new FakeDocker();
    fake.exists = true;
    fake.foreignOwner = true;
    const proof = await make(fake).cleanup({ executionId: EXEC });
    assert.equal(proof.confirmed, false);
    assert.equal(fake.rmCalled, false);
  });

  it("is idempotent and confirms when nothing exists", async () => {
    const fake = new FakeDocker();
    const a = make(fake);
    const first = await a.cleanup({ executionId: EXEC });
    const second = await a.cleanup({ executionId: EXEC });
    assert.equal(first.confirmed, true);
    assert.equal(second.confirmed, true);
    if (second.confirmed) assert.equal(second.executionId, EXEC);
  });

  it("rejects an invalid execution id without calling docker", async () => {
    const fake = new FakeDocker();
    const proof = await make(fake).cleanup({ executionId: "a;b" });
    assert.equal(proof.confirmed, false);
    assert.equal(fake.calls.length, 0);
  });

  it("never throws when docker cannot be run", async () => {
    const throwing: ProcessExecutor = () => Promise.reject(new Error("ENOENT"));
    const a = new GitAcquisition({ executor: throwing, egress: guard(goodEgress), allowedImages: [IMAGE] });
    const proof = await a.cleanup({ executionId: EXEC });
    assert.equal(proof.confirmed, false);
  });
});

describe("construction", () => {
  const ex: ProcessExecutor = () => Promise.resolve(res());
  it("requires an executor, an egress guard and valid allowed images", () => {
    assert.throws(() => new GitAcquisition({ executor: undefined as never, egress: guard(goodEgress), allowedImages: [IMAGE] }));
    assert.throws(() => new GitAcquisition({ executor: ex, egress: undefined as never, allowedImages: [IMAGE] }));
    assert.throws(() => new GitAcquisition({ executor: ex, egress: guard(goodEgress), allowedImages: [] }));
    assert.throws(() => new GitAcquisition({ executor: ex, egress: guard(goodEgress), allowedImages: ["bad image;x"] }));
    assert.throws(() => new GitAcquisition({ executor: ex, egress: guard(goodEgress), allowedImages: [IMAGE], dockerBinary: "a b" }));
    assert.throws(() => new GitAcquisition({ executor: ex, egress: guard(goodEgress), allowedImages: [IMAGE], limits: { depth: 0 } }));
  });

  it("derives an injective container name and rejects invalid ids", () => {
    assert.equal(acquisitionContainerName(EXEC), NAME);
    assert.throws(() => acquisitionContainerName("a b:1"));
  });
});


describe("afterCheckout handoff hook (mock)", () => {
  it("runs after checkout and before cleanup, with identity from the verified acquisition", async () => {
    const fake = new FakeDocker();
    let seen: { containerName: string; commit: string; files: number } | undefined;
    const r = await make(fake, undefined, {
      afterCheckout: (info) => {
        seen = { containerName: info.containerName, commit: info.commit, files: info.manifest.files };
        return Promise.resolve();
      },
    }).acquire(req);
    assert.equal(r.kind, "acquired");
    assert.deepEqual(seen, { containerName: NAME, commit: SHA, files: 2 });
    assert.equal(r.cleanup?.confirmed, true);
  });

  it("a throwing hook fails the acquisition closed and cleanup still runs", async () => {
    const fake = new FakeDocker();
    const r = await make(fake, undefined, {
      afterCheckout: () => Promise.reject(new Error("export \u0007failed")),
    }).acquire(req);
    assert.equal(r.kind, "failed");
    if (r.kind === "failed") {
      assert.equal(r.step, "handoff");
      assert.doesNotMatch(r.reason, /\u0007/);
    }
    assert.equal(r.cleanup?.confirmed, true);
  });
});

// ---------------------------------------------------------------------------

describe("unpinned HEAD intake (mock)", () => {
  const headReq = { executionId: EXEC, repoUrl: URL_, resolveHead: true as const, image: IMAGE };
  const execArgs = (fake: FakeDocker, sub: string): readonly string[] => {
    const c = fake.calls.find((x) => x.args[0] === "exec" && gitKey(x.args) === sub);
    assert.ok(c, `no ${sub} exec`);
    return c.args;
  };

  it("fetches only the literal HEAD, uses the resolved SHA for tree audit, checkout and HEAD verification", async () => {
    const fake = new FakeDocker();
    const r = await make(fake).acquire(headReq);
    assert.equal(r.kind, "acquired");
    if (r.kind === "acquired") {
      assert.equal(r.commit, SHA);
      assert.equal(r.resolvedFromHead, true);
    }
    assert.deepEqual(fake.gitOrder, ["init", "fetch", "verify-commit", "ls-tree", "checkout", "head"]);
    const fetchArgs = execArgs(fake, "fetch");
    assert.deepEqual(fetchArgs.slice(-3), ["--", URL_, "HEAD"]);
    assert.ok(fetchArgs.includes("http.followRedirects=false"));
    assert.ok(!fetchArgs.includes(SHA));
    assert.ok(execArgs(fake, "verify-commit").includes("FETCH_HEAD^{commit}"));
    assert.ok(execArgs(fake, "ls-tree").includes(SHA));
    assert.ok(execArgs(fake, "checkout").includes(SHA));
    assert.equal(r.cleanup?.confirmed, true);
    assert.equal(fake.exists, false);
  });

  it("rejects anything but one lowercase 40-hex id from FETCH_HEAD before listing or checkout", async () => {
    for (const bad of ["", "\n", SHA.toUpperCase() + "\n", SHA.slice(0, 39) + "\n", `${SHA}\n${OTHER_SHA}\n`, `${SHA}${SHA}\n`, `ref: ${SHA}\n`]) {
      const fake = new FakeDocker();
      fake.results["verify-commit"] = res({ stdout: bad });
      const r = await make(fake).acquire(headReq);
      assert.equal(r.kind, "source-rejected", JSON.stringify(bad));
      assert.ok(!fake.gitOrder.includes("ls-tree") && !fake.gitOrder.includes("checkout"));
      assert.equal(r.cleanup?.confirmed, true);
    }
  });

  it("rejects a checked-out HEAD that differs from the resolved SHA, and a tree rejection carries the resolved id", async () => {
    const fake = new FakeDocker();
    fake.results["head"] = res({ stdout: `${OTHER_SHA}\n` });
    const r = await make(fake).acquire(headReq);
    assert.equal(r.kind, "source-rejected");
    if (r.kind === "source-rejected") assert.equal(r.commit, SHA);

    const fake2 = new FakeDocker();
    fake2.results["ls-tree"] = res({ stdout: entry("120000", "5", "link") });
    const r2 = await make(fake2).acquire(headReq);
    assert.equal(r2.kind, "source-rejected");
    if (r2.kind === "source-rejected") assert.equal(r2.commit, SHA);
    assert.ok(!fake2.gitOrder.includes("checkout"));
  });

  it("refuses non-GitHub hosts, a commit together with resolveHead, and a non-true flag, touching nothing", async () => {
    const cases: unknown[] = [
      { ...headReq, repoUrl: "https://gitlab.com/owner/repo" },
      { ...headReq, repoUrl: "http://github.com/owner/repo" },
      { ...headReq, commit: SHA },
      { ...headReq, resolveHead: "yes" },
      { ...headReq, resolveHead: false },
      { executionId: EXEC, repoUrl: URL_, image: IMAGE },
    ];
    for (const c of cases) {
      const fake = new FakeDocker();
      const g = guard(goodEgress);
      const r = await make(fake, g).acquire(c as never);
      assert.equal(r.kind, "rejected", JSON.stringify(c));
      assert.equal(g.calls, 0);
      assert.equal(fake.calls.length, 0);
    }
  });

  it("still fails closed without verified egress", async () => {
    const fake = new FakeDocker();
    const r = await make(fake, new UnavailableEgressGuard()).acquire(headReq);
    assert.equal(r.kind, "network-unavailable");
    assert.equal(fake.calls.length, 0);
  });
});
