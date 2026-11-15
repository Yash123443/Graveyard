/**
 * npm-acquire-driver.test.ts — the in-container acquisition driver with an INJECTED process runner
 * and real temporary directories. No npm runs, no Docker, no network. One test runs the real
 * compiled driver file as a subprocess without any mounts to check the one-line protocol and the
 * fail-closed refusal.
 *
 * What these tests show: the driver refuses bad proxy URLs and unsafe inputs, passes fixed
 * arguments and a minimal environment to npm, reports each failure mode distinctly, and exports
 * only plain cacache files. What they do not show: that real npm accepts these flags, honours the
 * proxy, or writes the modelled cache layout. That needs the opt-in harness.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACQUIRE_CACHE_NAME,
  ACQUIRE_GLOBALCONFIG_NAME,
  ACQUIRE_USERCONFIG_NAME,
  MAX_EXPORT_FILES,
  MAX_EXPORT_FILE_BYTES,
  NPM_REGISTRY_URL,
  encodeAcquireLine,
  exportCache,
  npmAcquireArgs,
  parsePrivateProxyUrl,
  runAcquisition,
  type AcquireProcessOutcome,
  type AcquireProcessSpec,
  type AcquireRunner,
} from "../npm-acquire-driver.js";
import { parseAcquireOutput } from "../npm-registry-cache.js";

const PROXY = "http://10.231.4.10:3128";
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gy-acq-driver-"));
  dirs.push(d);
  return d;
}

const HEX_A = "a".repeat(124);
const CONTENT_REL = `content-v2/sha512/aa/aa/${HEX_A.slice(4)}`;
const INDEX_REL = `index-v5/bb/bb/${"b".repeat(60)}`;

/** Writes a plausible cacache tree under `<work>/npm-cache/_cacache`. */
function writeCache(work: string, extra: Record<string, string> = {}): void {
  const root = join(work, ACQUIRE_CACHE_NAME, "_cacache");
  const files: Record<string, string> = { [CONTENT_REL]: "tarball", [INDEX_REL]: "\nhash\t{}", ...extra };
  for (const [rel, data] of Object.entries(files)) {
    const parts = rel.split("/");
    mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...parts), data);
  }
}

const OK: AcquireProcessOutcome = {
  exitCode: 0, signal: null, stdout: "added 1 package in 1s\n", stderr: "", timedOut: false, aborted: false, truncated: false,
};

interface Setup {
  src: string;
  work: string;
  calls: AcquireProcessSpec[];
  runner: (o?: Partial<AcquireProcessOutcome>, before?: (work: string) => void) => AcquireRunner;
}
function setup(withInputs = true): Setup {
  const root = tmp();
  const src = join(root, "src");
  const work = join(root, "work");
  mkdirSync(src);
  mkdirSync(work);
  if (withInputs) {
    writeFileSync(join(src, "package.json"), '{"name":"x"}\n');
    writeFileSync(join(src, "package-lock.json"), '{"lockfileVersion":3}\n');
  }
  const calls: AcquireProcessSpec[] = [];
  return {
    src, work, calls,
    runner: (o = {}, before = (w): void => writeCache(w)) => (spec) => {
      calls.push(spec);
      if ((o.exitCode ?? 0) === 0 && o.timedOut !== true && o.aborted !== true && o.truncated !== true && o.spawnError === undefined) {
        before(spec.cwd);
      }
      return Promise.resolve({ ...OK, ...o });
    },
  };
}

describe("parsePrivateProxyUrl", () => {
  it("accepts only canonical http URLs for private IPv4 literals", () => {
    assert.deepEqual(parsePrivateProxyUrl("http://10.231.4.10:3128"), { host: "10.231.4.10", port: 3128 });
    for (const u of ["http://172.16.0.2:1", "http://172.31.255.254:65535", "http://192.168.1.5:8080", "http://10.0.0.1:3128"]) {
      assert.ok(parsePrivateProxyUrl(u) !== null, u);
    }
  });
  it("rejects public, loopback, link-local, names, credentials, paths and malformed ports", () => {
    const bad = [
      "http://8.8.8.8:3128", "http://172.15.0.1:3128", "http://172.32.0.1:3128", "http://127.0.0.1:3128", "http://169.254.169.254:80",
      "http://100.64.0.1:3128", "https://10.0.0.1:3128", "http://user@10.0.0.1:3128", "http://user:pw@10.0.0.1:3128",
      "http://10.0.0.1", "http://10.0.0.1:0", "http://10.0.0.1:65536", "http://10.0.0.1:03128", "http://10.0.0.1:3128/", "http://10.0.0.1:3128?x=1",
      "http://proxy:3128", "http://proxy.internal:3128", "http://010.0.0.1:3128", "http://10.0.0.256:3128", "http://[::1]:3128", "http://[fd00::1]:3128",
      "http://10.0.0.1:3128 ", " http://10.0.0.1:3128", "HTTP://10.0.0.1:3128", "", "http://", undefined, null, 5, {}, `http://10.0.0.1:${"1".repeat(40)}`,
    ];
    for (const u of bad) assert.equal(parsePrivateProxyUrl(u), null, String(u));
  });
});

describe("npmAcquireArgs", () => {
  const args = npmAcquireArgs(PROXY, "/work/npm-cache", "/work/u", "/work/g");
  it("is `npm ci` with scripts, audit and funding off, and is not offline", () => {
    assert.equal(args[0], "ci");
    for (const f of ["--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier", "--logs-max=0", "--strict-ssl=true"]) {
      assert.ok(args.includes(f), f);
    }
    assert.equal(args.includes("--offline"), false);
    assert.equal(args.includes("--prefer-offline"), false);
  });
  it("pins the registry, both proxy settings, empty configs and the cache", () => {
    const after = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    assert.equal(after("--registry"), NPM_REGISTRY_URL);
    assert.equal(NPM_REGISTRY_URL, "https://registry.npmjs.org/");
    assert.equal(after("--proxy"), PROXY);
    assert.equal(after("--https-proxy"), PROXY);
    assert.equal(after("--userconfig"), "/work/u");
    assert.equal(after("--globalconfig"), "/work/g");
    assert.equal(after("--cache"), "/work/npm-cache");
  });
  it("contains no token, no auth, no other registry and no URL besides the registry and the proxy", () => {
    const urls = args.filter((a) => /:\/\//.test(a));
    assert.deepEqual(urls.sort(), [NPM_REGISTRY_URL, PROXY, PROXY].sort());
    assert.equal(args.some((a) => /token|auth|password|_authToken|git/i.test(a)), false);
  });
});

describe("runAcquisition", () => {
  it("copies the two inputs, creates two distinct empty configs, runs npm once and exports the cache", async () => {
    const s = setup();
    const r = await runAcquisition({ sourceDir: s.src, workDir: s.work, proxyUrl: PROXY, runner: s.runner() });
    assert.equal(r.status, "passed");
    assert.equal(r.phase, "done");
    assert.equal(r.files.length, 2);
    assert.deepEqual(r.files.map((f) => f.path).sort(), [CONTENT_REL, INDEX_REL].sort());
    assert.equal(Buffer.from(r.files.find((f) => f.path === CONTENT_REL)?.data ?? "", "base64").toString(), "tarball");
    assert.equal(readFileSync(join(s.work, "package.json"), "utf8"), '{"name":"x"}\n');
    assert.equal(readFileSync(join(s.work, ACQUIRE_USERCONFIG_NAME), "utf8"), "");
    assert.equal(readFileSync(join(s.work, ACQUIRE_GLOBALCONFIG_NAME), "utf8"), "");
    assert.notEqual(ACQUIRE_USERCONFIG_NAME, ACQUIRE_GLOBALCONFIG_NAME);
    assert.equal(s.calls.length, 1);
    const spec = s.calls[0] as AcquireProcessSpec;
    assert.equal(spec.command, "npm");
    assert.equal(spec.cwd, s.work);
    assert.deepEqual(
      [...spec.args],
      npmAcquireArgs(PROXY, join(s.work, ACQUIRE_CACHE_NAME), join(s.work, ACQUIRE_USERCONFIG_NAME), join(s.work, ACQUIRE_GLOBALCONFIG_NAME)),
    );
  });

  it("gives npm a minimal environment with no proxy variable, token or host credential", async () => {
    const s = setup();
    await runAcquisition({ sourceDir: s.src, workDir: s.work, proxyUrl: PROXY, runner: s.runner() });
    const env = (s.calls[0] as AcquireProcessSpec).env;
    assert.deepEqual(Object.keys(env).sort(), ["CI", "HOME", "NODE_ENV", "NPM_CONFIG_UPDATE_NOTIFIER", "PATH"]);
    assert.equal(env["HOME"], s.work);
    assert.equal(JSON.stringify(env).includes("10.231"), false);
  });

  it("refuses a missing, public or malformed proxy before touching anything or running npm", async () => {
    for (const proxyUrl of [undefined, "", "http://8.8.8.8:3128", "http://proxy:3128", "https://10.0.0.1:3128", "http://user@10.0.0.1:3128"]) {
      const s = setup();
      const r = await runAcquisition({ sourceDir: s.src, workDir: s.work, proxyUrl, runner: s.runner() });
      assert.equal(r.status, "failed", String(proxyUrl));
      assert.equal(r.phase, "prepare");
      assert.equal(r.reason, "refused");
      assert.equal(s.calls.length, 0);
      assert.equal(existsSync(join(s.work, "package.json")), false);
    }
  });

  it("refuses missing inputs, an oversized input and a non-regular input", async () => {
    const missing = setup(false);
    writeFileSync(join(missing.src, "package.json"), "{}\n");
    let r = await runAcquisition({ sourceDir: missing.src, workDir: missing.work, proxyUrl: PROXY, runner: missing.runner() });
    assert.ok(r.status === "failed" && r.phase === "prepare" && r.reason === "refused");
    assert.equal(missing.calls.length, 0);

    const big = setup();
    writeFileSync(join(big.src, "package-lock.json"), "x".repeat(65 * 1024));
    r = await runAcquisition({ sourceDir: big.src, workDir: big.work, proxyUrl: PROXY, runner: big.runner() });
    assert.ok(r.status === "failed" && r.reason === "refused");
    assert.equal(big.calls.length, 0);

    const dirInput = setup(false);
    mkdirSync(join(dirInput.src, "package.json"));
    writeFileSync(join(dirInput.src, "package-lock.json"), "{}\n");
    r = await runAcquisition({ sourceDir: dirInput.src, workDir: dirInput.work, proxyUrl: PROXY, runner: dirInput.runner() });
    assert.ok(r.status === "failed" && r.reason === "refused");
  });

  it("refuses a symlinked input (skipped where symlinks cannot be created)", async (t) => {
    const s = setup(false);
    writeFileSync(join(s.src, "real.json"), "{}\n");
    writeFileSync(join(s.src, "package-lock.json"), "{}\n");
    try {
      symlinkSync(join(s.src, "real.json"), join(s.src, "package.json"));
    } catch {
      t.skip("cannot create symlinks here");
      return;
    }
    const r = await runAcquisition({ sourceDir: s.src, workDir: s.work, proxyUrl: PROXY, runner: s.runner() });
    assert.ok(r.status === "failed" && r.phase === "prepare" && r.reason === "refused");
    assert.equal(s.calls.length, 0);
  });

  it("does not overwrite an existing file in the work directory", async () => {
    const s = setup();
    writeFileSync(join(s.work, "package.json"), "pre-existing");
    const r = await runAcquisition({ sourceDir: s.src, workDir: s.work, proxyUrl: PROXY, runner: s.runner() });
    assert.ok(r.status === "failed" && r.reason === "io-error");
    assert.equal(readFileSync(join(s.work, "package.json"), "utf8"), "pre-existing");
    assert.equal(s.calls.length, 0);
  });

  it("reports an npm failure, timeout, output limit, spawn error and cancellation distinctly, with no files", async () => {
    const cases: Array<[Partial<AcquireProcessOutcome>, string, string]> = [
      [{ exitCode: 1, stderr: "npm error" }, "failed", "exit-code"],
      [{ exitCode: null, signal: "SIGKILL" }, "failed", "exit-code"],
      [{ exitCode: null, timedOut: true }, "failed", "timeout"],
      [{ exitCode: null, truncated: true }, "failed", "output-limit"],
      [{ exitCode: null, spawnError: "ENOENT" }, "failed", "spawn-error"],
      [{ exitCode: null, aborted: true }, "cancelled", "cancelled"],
    ];
    for (const [o, status, reason] of cases) {
      const s = setup();
      const r = await runAcquisition({ sourceDir: s.src, workDir: s.work, proxyUrl: PROXY, runner: s.runner(o) });
      assert.equal(r.status, status, JSON.stringify(o));
      assert.equal(r.phase, "install");
      assert.equal(r.reason, reason);
      assert.deepEqual(r.files, []);
    }
  });

  it("does not run npm when already cancelled", async () => {
    const s = setup();
    const ac = new AbortController();
    ac.abort();
    const r = await runAcquisition({ sourceDir: s.src, workDir: s.work, proxyUrl: PROXY, runner: s.runner(), signal: ac.signal });
    assert.equal(r.status, "cancelled");
    assert.equal(s.calls.length, 0);
  });

  it("fails the export, never partially, when the cache is missing or has no files", async () => {
    const none = setup();
    let r = await runAcquisition({ sourceDir: none.src, workDir: none.work, proxyUrl: PROXY, runner: none.runner({}, () => undefined) });
    assert.ok(r.status === "failed" && r.phase === "export" && r.reason === "refused");
    assert.deepEqual(r.files, []);

    const empty = setup();
    r = await runAcquisition({
      sourceDir: empty.src, workDir: empty.work, proxyUrl: PROXY,
      runner: empty.runner({}, (w) => {
        const root = join(w, ACQUIRE_CACHE_NAME, "_cacache");
        mkdirSync(join(root, "content-v2"), { recursive: true });
        mkdirSync(join(root, "index-v5"), { recursive: true });
      }),
    });
    assert.ok(r.status === "failed" && r.phase === "export");
  });
});

describe("exportCache", () => {
  function cacheRoot(extra: Record<string, string> = {}): string {
    const work = tmp();
    writeCache(work, extra);
    return join(work, ACQUIRE_CACHE_NAME, "_cacache");
  }

  it("exports only content-v2 and index-v5 and ignores other entries such as tmp and _logs", () => {
    const root = cacheRoot();
    mkdirSync(join(root, "tmp"));
    writeFileSync(join(root, "tmp", "leftover"), "x");
    const r = exportCache(root);
    assert.ok(r.ok);
    assert.deepEqual(r.files.map((f) => f.path).sort(), [CONTENT_REL, INDEX_REL].sort());
  });

  it("refuses a symlink anywhere in the exported trees (skipped where symlinks cannot be created)", (t) => {
    const root = cacheRoot();
    try {
      symlinkSync("/etc/passwd", join(root, "content-v2", "sha512", "aa", "link"));
    } catch {
      t.skip("cannot create symlinks here");
      return;
    }
    const r = exportCache(root);
    assert.ok(!r.ok && r.reason === "refused");
  });

  it("refuses a missing tree, too many files, an oversized file and a total over the limit", () => {
    const work = tmp();
    mkdirSync(join(work, "c", "content-v2"), { recursive: true });
    assert.equal(exportCache(join(work, "c")).ok, false); // index-v5 missing

    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_EXPORT_FILES + 1; i += 1) many[`content-v2/sha512/aa/bb/${String(i).padStart(124, "0")}`] = "x";
    assert.equal(exportCache(cacheRoot(many)).ok, false);

    assert.equal(exportCache(cacheRoot({ "content-v2/sha512/aa/bb/big": "x".repeat(MAX_EXPORT_FILE_BYTES + 1) })).ok, false);

    const chunk = "y".repeat(MAX_EXPORT_FILE_BYTES);
    assert.equal(exportCache(cacheRoot({ "content-v2/sha512/aa/bb/c1": chunk, "content-v2/sha512/aa/bb/c2": chunk, "content-v2/sha512/aa/bb/c3": chunk })).ok, false);
  });
});

describe("encodeAcquireLine", () => {
  it("round-trips through the host parser", async () => {
    const s = setup();
    const r = await runAcquisition({ sourceDir: s.src, workDir: s.work, proxyUrl: PROXY, runner: s.runner() });
    const parsed = parseAcquireOutput(encodeAcquireLine(r));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value.files, r.files);
  });

  it("replaces an oversized report with a short failure the host also accepts", () => {
    const big = "A".repeat(100 * 1024);
    const line = encodeAcquireLine({
      status: "passed", phase: "done", durationMs: 1, stdoutTail: "", stderrTail: "",
      files: [0, 1, 2, 3].map((i) => ({ path: `content-v2/sha512/aa/bb/${i}`, size: 1, data: big })),
    });
    const parsed = parseAcquireOutput(line);
    assert.ok(parsed.ok);
    assert.equal(parsed.value.status, "failed");
    assert.equal(parsed.value.reason, "output-limit");
    assert.deepEqual(parsed.value.files, []);
  });
});

describe("compiled driver as a subprocess (no mounts, no proxy)", () => {
  it("writes exactly one protocol line, nothing on stderr, and fails closed", (t) => {
    const driver = join(dirname(fileURLToPath(import.meta.url)), "..", "npm-acquire-driver.js");
    if (!existsSync(driver)) {
      t.skip("compiled driver not found next to the tests");
      return;
    }
    const r = spawnSync(process.execPath, [driver], {
      encoding: "utf8", timeout: 20_000, env: { PATH: process.env["PATH"] ?? "" }, windowsHide: true,
    });
    assert.equal(r.stderr, "");
    assert.equal(r.status, 1);
    const parsed = parseAcquireOutput(r.stdout);
    assert.ok(parsed.ok, r.stdout.slice(0, 200));
    assert.equal(parsed.value.status, "failed");
    assert.equal(parsed.value.phase, "prepare");
    assert.equal(parsed.value.reason, "refused");
  });
});
