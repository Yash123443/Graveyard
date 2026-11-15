/**
 * kiro-agent.test.ts — Analyst/Fixer adapter against an injected fake executor.
 * kiro-cli is never started. The only real processes are `node` children in the spawnAgentProcess
 * group, which show shell:false, explicit environment and timeout kill. Written without running
 * the compiler or tests; results are unverified until logged (see backend/DEVELOPMENT.md).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KiroAgentAdapter,
  buildAgentEnv,
  buildKiroArgs,
  spawnAgentProcess,
  systemWorkDirs,
  type AgentProcessExecutor,
  type AgentProcessOptions,
  type AgentProcessResult,
  type KiroAgentConfig,
  type WorkDirProvider,
} from "../kiro-agent.js";
import { beginMarker, endMarker, type Diagnosis, type EvidenceItem } from "../agent-contract.js";

const NONCE = "abcdef0123456789abcd";
const KEY = "sk-test-secret-123456";
const FILE_TEXT = "line1\nline2\n";

const EVIDENCE: EvidenceItem[] = [
  { id: "log1", kind: "log", text: "Error: boom at src/a.js:2" },
  { id: "f1", kind: "file", path: "src/a.js", complete: true, text: FILE_TEXT },
];

const DIAGNOSIS: Diagnosis = {
  category: "runtime-error",
  summary: "line2 throws",
  rootCause: "src/a.js line2 is wrong",
  confidence: "high",
  evidenceRefs: ["log1", "f1"],
  affectedFiles: ["src/a.js"],
};

const diagJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ schemaVersion: 1, role: "analyst", verdict: "diagnosis", ...DIAGNOSIS, ...over });

const GOOD_DIFF = "--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,2 @@\n line1\n-line2\n+line3\n";
const patchJson = (diff: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ schemaVersion: 1, role: "fixer", verdict: "patch", summary: "fix line2", diff, ...over });

const marked = (json: string, nonce = NONCE): string => `chatter\n${beginMarker(nonce)}\n${json}\n${endMarker(nonce)}\nbye\n`;

interface Call {
  file: string;
  args: readonly string[];
  options: AgentProcessOptions;
}

function fakeExec(reply: (c: Call) => Partial<AgentProcessResult> | Promise<Partial<AgentProcessResult>>): {
  calls: Call[];
  fn: AgentProcessExecutor;
} {
  const calls: Call[] = [];
  const fn: AgentProcessExecutor = async (file, args, options) => {
    const c = { file, args, options };
    calls.push(c);
    const r = await reply(c);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, ...r };
  };
  return { calls, fn };
}

function fakeDirs(entries: string[] = []): WorkDirProvider & { created: string[]; removed: string[] } {
  const created: string[] = [];
  const removed: string[] = [];
  return {
    created,
    removed,
    create: () => {
      const d = `/fake/agent-${String(created.length)}`;
      created.push(d);
      return d;
    },
    entries: () => entries,
    remove: (d) => {
      removed.push(d);
    },
  };
}

function adapter(fn: AgentProcessExecutor, dirs: WorkDirProvider, extra: Partial<KiroAgentConfig> = {}): KiroAgentAdapter {
  return new KiroAgentAdapter({
    executor: fn,
    cliGeneration: "v2",
    workDirs: dirs,
    nonce: () => NONCE,
    baseEnv: { PATH: "/bin" },
    ...extra,
  });
}

const okExec = (json: string): ReturnType<typeof fakeExec> => fakeExec(() => ({ stdout: marked(json) }));

describe("Analyst", () => {
  it("accepts a valid bounded diagnosis", async () => {
    const ex = okExec(diagJson());
    const out = await adapter(ex.fn, fakeDirs()).analyze({ evidence: EVIDENCE });
    assert.equal(out.status, "ok");
    if (out.status === "ok") {
      assert.equal(out.value.category, "runtime-error");
      assert.deepEqual(out.value.evidenceRefs, ["log1", "f1"]);
    }
    assert.equal(ex.calls.length, 1);
  });

  it("answers unknown as no-result, not a diagnosis", async () => {
    const ex = okExec(JSON.stringify({ schemaVersion: 1, role: "analyst", verdict: "unknown" }));
    const out = await adapter(ex.fn, fakeDirs()).analyze({ evidence: EVIDENCE });
    assert.equal(out.status, "no-result");
  });

  const malformed: Array<[string, string, string]> = [
    ["not JSON", "this is { not json", "invalid-json"],
    ["extra key", diagJson({ extra: 1 }), "schema-violation"],
    ["bad category", diagJson({ category: "nope" }), "schema-violation"],
    ["wrong role", diagJson({ role: "fixer" }), "schema-violation"],
    ["unsupplied evidence ref", diagJson({ evidenceRefs: ["ghost"] }), "unknown-evidence-ref"],
    ["unsupplied file", diagJson({ affectedFiles: ["src/other.js"] }), "path-not-in-evidence"],
    ["unsafe path", diagJson({ affectedFiles: [".git/config"] }), "unsafe-path"],
    ["overlong summary", diagJson({ summary: "x".repeat(401) }), "schema-violation"],
  ];
  for (const [name, json, code] of malformed) {
    it(`rejects malformed output: ${name}`, async () => {
      const ex = okExec(json);
      const out = await adapter(ex.fn, fakeDirs()).analyze({ evidence: EVIDENCE });
      assert.equal(out.status, "rejected");
      assert.equal(out.code, code);
    });
  }

  it("rejects missing markers, echoed (duplicate) markers and wrong nonce", async () => {
    const cases: Array<[string, string]> = [
      ["no markers", diagJson()],
      ["wrong nonce", marked(diagJson(), "ffffffffffffffffffff")],
      ["duplicate markers", marked(diagJson()) + marked(diagJson())],
    ];
    for (const [name, stdout] of cases) {
      const out = await adapter(fakeExec(() => ({ stdout })).fn, fakeDirs()).analyze({ evidence: EVIDENCE });
      assert.equal(out.status, "rejected", name);
    }
  });

  it("rejects output over the size bound", async () => {
    const big = diagJson({ rootCause: "r".repeat(70 * 1024) });
    const out = await adapter(okExec(big).fn, fakeDirs()).analyze({ evidence: EVIDENCE });
    assert.equal(out.status, "rejected");
    assert.equal(out.code, "output-too-large");
  });

  it("rejects when the executor reports truncated output", async () => {
    const ex = fakeExec(() => ({ stdout: marked(diagJson()), truncated: true }));
    const out = await adapter(ex.fn, fakeDirs()).analyze({ evidence: EVIDENCE });
    assert.equal(out.status, "rejected");
  });

  it("rejects over-large or invalid evidence without calling the executor", async () => {
    const ex = okExec(diagJson());
    const a = adapter(ex.fn, fakeDirs());
    const many = Array.from({ length: 17 }, (_, i) => ({ id: `e${String(i)}`, kind: "log" as const, text: "x" }));
    const r1 = await a.analyze({ evidence: many });
    const r2 = await a.analyze({ evidence: [] });
    const r3 = await a.analyze({ evidence: [{ id: "f", kind: "file", path: "../x", text: "t" }] });
    assert.equal(r1.status, "rejected");
    assert.equal(r2.status, "rejected");
    assert.equal(r3.status, "rejected");
    assert.equal(ex.calls.length, 0);
  });

  it("rejects evidence that contains the call nonce", async () => {
    const ex = okExec(diagJson());
    const out = await adapter(ex.fn, fakeDirs()).analyze({ evidence: [{ id: "log1", kind: "log", text: `x ${NONCE} y` }] });
    assert.equal(out.status, "rejected");
    assert.equal(ex.calls.length, 0);
  });
});

describe("Fixer", () => {
  it("accepts a valid bounded patch as a proposal only", async () => {
    const ex = okExec(patchJson(GOOD_DIFF));
    const out = await adapter(ex.fn, fakeDirs()).propose({ diagnosis: DIAGNOSIS, evidence: EVIDENCE });
    assert.equal(out.status, "ok");
    if (out.status === "ok") {
      assert.equal(out.value.proposalOnly, true);
      assert.deepEqual(out.value.files, ["src/a.js"]);
      assert.equal(out.value.contextVerified, true);
      assert.equal(out.value.added, 1);
      assert.equal(out.value.removed, 1);
    }
  });

  it("answers unknown as no-result", async () => {
    const ex = okExec(JSON.stringify({ schemaVersion: 1, role: "fixer", verdict: "unknown" }));
    const out = await adapter(ex.fn, fakeDirs()).propose({ diagnosis: DIAGNOSIS, evidence: EVIDENCE });
    assert.equal(out.status, "no-result");
  });

  it("rejects malformed JSON and unexpected keys", async () => {
    const a = await adapter(okExec("{oops").fn, fakeDirs()).propose({ diagnosis: DIAGNOSIS, evidence: EVIDENCE });
    assert.equal(a.status, "rejected");
    const b = await adapter(okExec(patchJson(GOOD_DIFF, { extra: true })).fn, fakeDirs()).propose({ diagnosis: DIAGNOSIS, evidence: EVIDENCE });
    assert.equal(b.status, "rejected");
  });

  it("rejects an invalid input diagnosis before calling the executor", async () => {
    const ex = okExec(patchJson(GOOD_DIFF));
    const bad: Diagnosis = { ...DIAGNOSIS, evidenceRefs: ["ghost"] };
    const out = await adapter(ex.fn, fakeDirs()).propose({ diagnosis: bad, evidence: EVIDENCE });
    assert.equal(out.status, "rejected");
    assert.equal(ex.calls.length, 0);
  });

  it("requires file evidence", async () => {
    const ex = okExec(patchJson(GOOD_DIFF));
    const ev: EvidenceItem[] = [{ id: "log1", kind: "log", text: "boom" }];
    const out = await adapter(ex.fn, fakeDirs()).propose({ diagnosis: { ...DIAGNOSIS, evidenceRefs: ["log1"], affectedFiles: [] }, evidence: ev });
    assert.equal(out.status, "rejected");
    assert.equal(ex.calls.length, 0);
  });

  describe("dangerous patches are rejected, never applied or truncated", () => {
    const hdr = (a: string, b = a): string => `--- a/${a}\n+++ b/${b}\n@@ -1,2 +1,2 @@\n line1\n-line2\n+line3\n`;
    const cases: Array<[string, string, string]> = [
      ["touches .git", hdr(".git/config"), "unsafe-path"],
      ["touches .github workflow", hdr(".github/workflows/ci.yml"), "unsafe-path"],
      ["path traversal", hdr("../outside.js"), "unsafe-path"],
      ["absolute path", hdr("/etc/passwd"), "unsafe-path"],
      ["file not supplied", hdr("src/other.js"), "path-not-in-evidence"],
      ["new file", "--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1 @@\n+x\n", "diff-invalid"],
      ["deleted file", "--- a/src/a.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-line1\n-line2\n", "diff-invalid"],
      ["rename", "--- a/src/a.js\n+++ b/src/b.js\n@@ -1,2 +1,2 @@\n line1\n-line2\n+line3\n", "diff-invalid"],
      ["git extended header", `diff --git a/src/a.js b/src/a.js\nindex 1..2 100644\n${GOOD_DIFF}`, "diff-invalid"],
      ["context mismatch", "--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,2 @@\n line1\n-WRONG\n+line3\n", "context-mismatch"],
      ["hunk count mismatch", "--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,3 @@\n line1\n-line2\n+line3\n", "diff-invalid"],
      ["control characters", GOOD_DIFF.replace("line3", "li\u0000ne3"), "diff-invalid"],
      ["oversize diff", `--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,2 @@\n line1\n-line2\n+${"y".repeat(30 * 1024)}\n`, "diff-too-large"],
    ];
    for (const [name, diff, code] of cases) {
      it(name, async () => {
        const dirs = fakeDirs();
        const out = await adapter(okExec(patchJson(diff)).fn, dirs).propose({ diagnosis: DIAGNOSIS, evidence: EVIDENCE });
        assert.equal(out.status, "rejected");
        assert.equal(out.code, code);
        assert.equal(dirs.removed.length, 1);
      });
    }
  });
});

describe("process invocation", () => {
  it("passes an argument array that trusts no tools, has no positional input, and sends instructions + packet on stdin", async () => {
    const ex = okExec(diagJson());
    await adapter(ex.fn, fakeDirs(), { model: "claude-x", agentName: "empty-agent" }).analyze({ evidence: EVIDENCE });
    const c = ex.calls[0];
    assert.ok(c);
    assert.equal(c.file, "kiro-cli");
    assert.ok(Array.isArray(c.args));
    assert.deepEqual(c.args, ["chat", "--no-interactive", "--trust-tools=", "--wrap", "never", "--agent", "empty-agent", "--model", "claude-x"]);
    assert.ok(c.args.includes("--no-interactive"));
    assert.ok(c.args.includes("--trust-tools="));
    assert.ok(!c.args.some((a) => /trust-all|^-a$/.test(a)));
    const joined = c.args.join("\n");
    assert.ok(!joined.includes("Error: boom"), "evidence must not be in argv");
    assert.ok(!joined.includes("line1"), "evidence must not be in argv");
    assert.ok(!joined.includes("GRAVEYARD Analyst"), "instructions must not be in argv");
    assert.ok(!joined.includes(beginMarker(NONCE)), "instructions must not be in argv");
    const stdin = c.options.stdin;
    assert.ok(stdin.includes("You are the GRAVEYARD Analyst"));
    assert.ok(stdin.includes(beginMarker(NONCE)));
    assert.ok(stdin.includes("Error: boom at src/a.js:2"));
    assert.ok(stdin.includes(`=== EVIDENCE ${NONCE} BEGIN id=log1`));
    assert.ok(stdin.indexOf("You are the GRAVEYARD Analyst") < stdin.indexOf("GRAVEYARD EVIDENCE PACKET"));
    assert.equal("shell" in c.options, false);
  });

  it("sends the Fixer instructions, diagnosis and evidence on stdin with no positional input", async () => {
    const ex = okExec(patchJson(GOOD_DIFF));
    await adapter(ex.fn, fakeDirs()).propose({ diagnosis: DIAGNOSIS, evidence: EVIDENCE });
    const c = ex.calls[0];
    assert.ok(c);
    assert.deepEqual(c.args, ["chat", "--no-interactive", "--trust-tools=", "--wrap", "never"]);
    assert.ok(c.options.stdin.includes("You are the GRAVEYARD Fixer"));
    assert.ok(c.options.stdin.includes(`=== DIAGNOSIS ${NONCE} BEGIN ===`));
    assert.ok(c.options.stdin.includes("line1\nline2"));
  });

  it("buildKiroArgs never emits a trust-all flag or a positional input", () => {
    const args = buildKiroArgs({});
    assert.deepEqual(args, ["chat", "--no-interactive", "--trust-tools=", "--wrap", "never"]);
    assert.ok(!args.some((a) => a.includes("trust-all")));
  });

  it("source never enables trust-all-tools or a shell", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = join(here, "..", "..", "src", "kiro-agent.ts");
    assert.ok(existsSync(src), `expected source at ${src}`);
    const code = readFileSync(src, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    assert.ok(!/trust-all-tools/.test(code));
    assert.ok(!/shell:\s*true/.test(code));
    assert.ok(!/\b(exec|execSync|execFile|execFileSync|spawnSync)\s*\(/.test(code));
  });

  it("uses a fresh empty controlled cwd, removes it, and never uses the repository cwd", async () => {
    const dirs = fakeDirs();
    const ex = okExec(diagJson());
    await adapter(ex.fn, dirs).analyze({ evidence: EVIDENCE });
    const c = ex.calls[0];
    assert.ok(c);
    assert.equal(c.options.cwd, "/fake/agent-0");
    assert.notEqual(c.options.cwd, process.cwd());
    assert.deepEqual(dirs.removed, ["/fake/agent-0"]);
  });

  it("rejects the result if the process left files in the working directory", async () => {
    const dirs = fakeDirs([".kiro"]);
    const out = await adapter(okExec(diagJson()).fn, dirs).analyze({ evidence: EVIDENCE });
    assert.equal(out.status, "rejected");
    assert.equal(out.code, "workspace-modified");
    assert.equal(dirs.removed.length, 1);
  });

  it("fails closed when no safe working directory can be created", async () => {
    const ex = okExec(diagJson());
    const dirs: WorkDirProvider = {
      create: () => {
        throw new Error("ancestor has .kiro");
      },
      entries: () => [],
      remove: () => undefined,
    };
    const out = await adapter(ex.fn, dirs).analyze({ evidence: EVIDENCE });
    assert.equal(out.status, "unavailable");
    assert.equal(ex.calls.length, 0);
  });

  it("reports an unstartable binary as unavailable", async () => {
    const dirs = fakeDirs();
    const fn: AgentProcessExecutor = () => Promise.reject(new Error("ENOENT"));
    const out = await adapter(fn, dirs).analyze({ evidence: EVIDENCE });
    assert.equal(out.status, "unavailable");
    assert.equal(dirs.removed.length, 1);
  });

  it("maps a nonzero exit to failed", async () => {
    const out = await adapter(fakeExec(() => ({ exitCode: 2, stdout: marked(diagJson()) })).fn, fakeDirs()).analyze({ evidence: EVIDENCE });
    assert.equal(out.status, "failed");
  });

  it("systemWorkDirs creates a real empty directory under temp and removes it", (t) => {
    const w = systemWorkDirs({});
    let dir: string;
    try {
      dir = w.create();
    } catch (e) {
      t.skip(`fail-closed in this environment: ${(e as Error).message}`);
      return;
    }
    assert.ok(dir.includes("graveyard-agent-"));
    assert.deepEqual(w.entries(dir), []);
    w.remove(dir);
    assert.equal(existsSync(dir), false);
  });
});

describe("timeout and abort", () => {
  it("maps executor timeout to timed-out", async () => {
    const ex = fakeExec(() => ({ timedOut: true, exitCode: null }));
    const dirs = fakeDirs();
    const out = await adapter(ex.fn, dirs, { timeoutMs: 50 }).analyze({ evidence: EVIDENCE });
    assert.equal(out.status, "timed-out");
    assert.equal(ex.calls[0]?.options.timeoutMs, 50);
    assert.equal(dirs.removed.length, 1);
  });

  it("does not start when already aborted", async () => {
    const ex = okExec(diagJson());
    const ac = new AbortController();
    ac.abort();
    const out = await adapter(ex.fn, fakeDirs()).analyze({ evidence: EVIDENCE, signal: ac.signal });
    assert.equal(out.status, "aborted");
    assert.equal(ex.calls.length, 0);
  });

  it("discards a valid-looking result when the signal aborts during the call", async () => {
    const ac = new AbortController();
    const ex = fakeExec(() => {
      ac.abort();
      return { stdout: marked(diagJson()) };
    });
    const out = await adapter(ex.fn, fakeDirs()).analyze({ evidence: EVIDENCE, signal: ac.signal });
    assert.equal(out.status, "aborted");
  });

  it("maps executor aborted to aborted and forwards the signal", async () => {
    const ac = new AbortController();
    const ex = fakeExec(() => ({ aborted: true, exitCode: null }));
    const out = await adapter(ex.fn, fakeDirs()).propose({ diagnosis: DIAGNOSIS, evidence: EVIDENCE, signal: ac.signal });
    assert.equal(out.status, "aborted");
    assert.equal(ex.calls[0]?.options.signal, ac.signal);
  });

  it("validates timeout configuration", () => {
    const base = { executor: okExec("").fn, cliGeneration: "v2" as const };
    assert.throws(() => new KiroAgentAdapter({ ...base, timeoutMs: 300_001 }));
    assert.throws(() => new KiroAgentAdapter({ ...base, timeoutMs: 0 }));
    assert.throws(() => new KiroAgentAdapter({ ...base, cliGeneration: "v9" as unknown as "v2" }));
  });
});

describe("credentials", () => {
  it("does not forward host secrets and only passes an explicit key via env", async () => {
    const baseEnv = { PATH: "/bin", KIRO_API_KEY: "host-key-aaaaaaaa", GITHUB_TOKEN: "ghp_" + "a".repeat(30), GRAVEYARD_OWNER_TOKEN: "owner-secret-1" };
    const ex1 = okExec(diagJson());
    await adapter(ex1.fn, fakeDirs(), { baseEnv }).analyze({ evidence: EVIDENCE });
    const env1 = ex1.calls[0]?.options.env ?? {};
    assert.deepEqual(Object.keys(env1).filter((k) => /KEY|TOKEN|GRAVEYARD/.test(k)), []);

    const ex2 = okExec(diagJson());
    await adapter(ex2.fn, fakeDirs(), { baseEnv, apiKey: KEY }).analyze({ evidence: EVIDENCE });
    const c = ex2.calls[0];
    assert.ok(c);
    assert.equal(c.options.env["KIRO_API_KEY"], KEY);
    assert.ok(!c.args.join("\n").includes(KEY));
    assert.ok(!c.options.stdin.includes(KEY));
    assert.equal(buildAgentEnv(baseEnv)["GITHUB_TOKEN"], undefined);
  });

  it("redacts the configured key and token shapes from evidence before it reaches stdin", async () => {
    const ex = okExec(diagJson());
    const evidence: EvidenceItem[] = [
      { id: "log1", kind: "log", text: `key ${KEY} and GITHUB_TOKEN=abcd1234secret and ghp_${"b".repeat(30)}` },
      EVIDENCE[1] as EvidenceItem,
    ];
    await adapter(ex.fn, fakeDirs(), { apiKey: KEY }).analyze({ evidence });
    const stdin = ex.calls[0]?.options.stdin ?? "";
    assert.ok(stdin.includes("[REDACTED]"));
    assert.ok(!stdin.includes(KEY));
    assert.ok(!stdin.includes("abcd1234secret"));
    assert.ok(!stdin.includes("b".repeat(30)));
  });

  it("keeps the key and raw agent stderr out of every returned outcome", async () => {
    const stderr = `auth failed for ${KEY}`;
    const outcomes = [
      await adapter(fakeExec(() => ({ exitCode: 1, stderr })).fn, fakeDirs(), { apiKey: KEY }).analyze({ evidence: EVIDENCE }),
      await adapter(fakeExec(() => ({ stdout: marked("not json " + KEY), stderr })).fn, fakeDirs(), { apiKey: KEY }).analyze({ evidence: EVIDENCE }),
      await adapter(fakeExec(() => ({ timedOut: true, stderr })).fn, fakeDirs(), { apiKey: KEY }).propose({ diagnosis: DIAGNOSIS, evidence: EVIDENCE }),
    ];
    for (const o of outcomes) assert.ok(!JSON.stringify(o).includes(KEY));
  });

  it("rejects a malformed api key", () => {
    assert.throws(() => new KiroAgentAdapter({ executor: okExec("").fn, cliGeneration: "v2", apiKey: "short" }));
  });
});

describe("spawnAgentProcess (real node children, no kiro-cli)", () => {
  const baseEnv: Record<string, string> = {};
  for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir"]) {
    const v = process.env[k];
    if (typeof v === "string") baseEnv[k] = v;
  }
  const opts = (over: Partial<AgentProcessOptions> = {}): AgentProcessOptions => ({
    cwd: tmpdir(),
    env: baseEnv,
    stdin: "",
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
    ...over,
  });

  it("does not use a shell: metacharacters arrive as literal arguments", async () => {
    const weird = "a;echo INJECTED&&b $HOME `id` | x";
    const r = await spawnAgentProcess(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", weird], opts());
    assert.equal(r.exitCode, 0);
    assert.deepEqual(JSON.parse(r.stdout), [weird]);
  });

  it("passes only the explicit environment and delivers stdin", async () => {
    process.env["GRAVEYARD_TEST_LEAK"] = "leak-value";
    try {
      const script = "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.stringify({leak:process.env.GRAVEYARD_TEST_LEAK??null,d})))";
      const r = await spawnAgentProcess(process.execPath, ["-e", script], opts({ stdin: "hello" }));
      assert.deepEqual(JSON.parse(r.stdout), { leak: null, d: "hello" });
    } finally {
      delete process.env["GRAVEYARD_TEST_LEAK"];
    }
  });

  it("kills a process that exceeds the timeout", async () => {
    const r = await spawnAgentProcess(process.execPath, ["-e", "setTimeout(()=>{},60000)"], opts({ timeoutMs: 400 }));
    assert.equal(r.timedOut, true);
  });

  it("kills on abort", async () => {
    const ac = new AbortController();
    const p = spawnAgentProcess(process.execPath, ["-e", "setTimeout(()=>{},60000)"], opts({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 300);
    const r = await p;
    assert.equal(r.aborted, true);
  });

  it("stops and flags output over the cap", async () => {
    const r = await spawnAgentProcess(process.execPath, ["-e", "setInterval(()=>process.stdout.write('x'.repeat(4096)),5)"], opts({ maxOutputBytes: 8192 }));
    assert.equal(r.truncated, true);
    assert.ok(r.stdout.length <= 8192);
  });

  it("rejects when the binary does not exist", async () => {
    await assert.rejects(spawnAgentProcess("graveyard-no-such-binary-xyz", [], opts()));
  });
});
