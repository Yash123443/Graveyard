/**
 * worker-config.test.ts — opt-in switch, safe configuration and catalog validation of the local
 * worker. Pure: no Docker, no database, no directories are touched (the catalog reader is injected).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MAX_CATALOG_BYTES,
  MAX_CATALOG_ENTRIES,
  WorkerConfigError,
  WorkerDisabledError,
  isWorkerEnabled,
  loadWorkerConfig,
  parseCatalog,
} from "../worker-config.js";

const ROOT = resolve(tmpdir(), "graveyard-worker-config-test");
const p = (name: string): string => join(ROOT, name);
const REPO = "https://github.com/o/r";
const CATALOG = JSON.stringify({ [REPO]: "fx1" });

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    GRAVEYARD_WORKER_ENABLED: "1",
    GRAVEYARD_FIXTURES_ROOT: p("fixtures"),
    GRAVEYARD_STAGING_ROOT: p("staging"),
    GRAVEYARD_NPM_CACHE_DIR: p("cache"),
    GRAVEYARD_FIXTURE_CATALOG: p("catalog.json"),
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

const deps = (text: string = CATALOG): { readCatalog: () => string; randomId: () => string; pid: number } => ({
  readCatalog: () => text,
  randomId: () => "abc123",
  pid: 42,
});

function problemsOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof WorkerConfigError, `expected WorkerConfigError, got ${String(e)}`);
    return e.problems;
  }
  assert.fail("expected the configuration to be refused");
}

const has = (problems: readonly string[], fragment: string): boolean => problems.some((x) => x.includes(fragment));

describe("worker opt-in switch", () => {
  for (const value of [undefined, "", "0", "true", "yes", "TRUE", " 1", "1 ", "01", "on"]) {
    it(`is disabled for GRAVEYARD_WORKER_ENABLED=${JSON.stringify(value)}`, () => {
      const e = env({ GRAVEYARD_WORKER_ENABLED: value });
      assert.equal(isWorkerEnabled(e), false);
      assert.throws(() => loadWorkerConfig(e, deps()), WorkerDisabledError);
    });
  }

  it("is enabled only for exactly 1", () => {
    assert.equal(isWorkerEnabled(env()), true);
  });

  it("does not read the catalog while disabled", () => {
    let reads = 0;
    assert.throws(
      () => loadWorkerConfig(env({ GRAVEYARD_WORKER_ENABLED: undefined }), { readCatalog: () => { reads += 1; return CATALOG; } }),
      WorkerDisabledError,
    );
    assert.equal(reads, 0);
  });
});

describe("loadWorkerConfig: defaults and accepted values", () => {
  it("returns the documented defaults", () => {
    const c = loadWorkerConfig(env(), deps());
    assert.equal(c.databasePath, "./data/graveyard.sqlite");
    assert.equal(c.fixturesRoot, p("fixtures"));
    assert.equal(c.stagingRoot, p("staging"));
    assert.equal(c.cacheDir, p("cache"));
    assert.equal(c.pollMs, 2_000);
    assert.equal(c.recoverMs, 30_000);
    assert.equal(c.batch, 5);
    assert.equal(c.shutdownMs, 45_000);
    assert.equal(c.agents, "off");
    assert.equal(c.logLevel, "info");
    assert.equal(c.workerId, "worker-42-abc123");
    assert.deepEqual(c.catalog, { [REPO]: "fx1" });
    assert.ok(Object.isFrozen(c.catalog));
  });

  it("accepts explicit values at the range edges", () => {
    const c = loadWorkerConfig(
      env({
        DATABASE_PATH: "./x/y.sqlite",
        GRAVEYARD_WORKER_ID: "w.1_a-b",
        GRAVEYARD_WORKER_POLL_MS: "250",
        GRAVEYARD_WORKER_RECOVER_MS: "600000",
        GRAVEYARD_WORKER_BATCH: "20",
        GRAVEYARD_WORKER_SHUTDOWN_MS: "1000",
        GRAVEYARD_WORKER_AGENTS: "kiro-v3",
        LOG_LEVEL: "warn",
      }),
      deps(),
    );
    assert.equal(c.databasePath, "./x/y.sqlite");
    assert.equal(c.workerId, "w.1_a-b");
    assert.equal(c.pollMs, 250);
    assert.equal(c.recoverMs, 600_000);
    assert.equal(c.batch, 20);
    assert.equal(c.shutdownMs, 1_000);
    assert.equal(c.agents, "kiro-v3");
    assert.equal(c.logLevel, "warn");
  });
});

describe("loadWorkerConfig: refusals", () => {
  it("requires the four paths", () => {
    const pr = problemsOf(() =>
      loadWorkerConfig(
        env({
          GRAVEYARD_FIXTURES_ROOT: undefined,
          GRAVEYARD_STAGING_ROOT: undefined,
          GRAVEYARD_NPM_CACHE_DIR: undefined,
          GRAVEYARD_FIXTURE_CATALOG: undefined,
        }),
        deps(),
      ),
    );
    for (const name of ["GRAVEYARD_FIXTURES_ROOT", "GRAVEYARD_STAGING_ROOT", "GRAVEYARD_NPM_CACHE_DIR", "GRAVEYARD_FIXTURE_CATALOG"]) {
      assert.ok(has(pr, `${name} is required`), name);
    }
  });

  it("refuses relative paths", () => {
    const pr = problemsOf(() => loadWorkerConfig(env({ GRAVEYARD_FIXTURES_ROOT: "fixtures", GRAVEYARD_NPM_CACHE_DIR: "./cache" }), deps()));
    assert.ok(has(pr, "GRAVEYARD_FIXTURES_ROOT must be an absolute path"));
    assert.ok(has(pr, "GRAVEYARD_NPM_CACHE_DIR must be an absolute path"));
  });

  it("refuses a NUL byte in a path", () => {
    const pr = problemsOf(() => loadWorkerConfig(env({ GRAVEYARD_STAGING_ROOT: `${p("staging")}\0x` }), deps()));
    assert.ok(has(pr, "GRAVEYARD_STAGING_ROOT must be an absolute path"));
  });

  it("refuses an in-memory database, which cannot be shared with the API", () => {
    assert.ok(has(problemsOf(() => loadWorkerConfig(env({ DATABASE_PATH: ":memory:" }), deps())), ":memory:"));
  });

  it("refuses an empty DATABASE_PATH", () => {
    assert.ok(has(problemsOf(() => loadWorkerConfig(env({ DATABASE_PATH: "  " }), deps())), "DATABASE_PATH"));
  });

  it("refuses directories that equal or contain each other", () => {
    const same = problemsOf(() => loadWorkerConfig(env({ GRAVEYARD_STAGING_ROOT: p("fixtures") }), deps()));
    assert.ok(has(same, "must be separate directories"));
    const staged = problemsOf(() => loadWorkerConfig(env({ GRAVEYARD_STAGING_ROOT: join(p("fixtures"), "staging") }), deps()));
    assert.ok(has(staged, "must be separate directories"));
    const parent = problemsOf(() => loadWorkerConfig(env({ GRAVEYARD_FIXTURES_ROOT: ROOT }), deps()));
    assert.ok(has(parent, "must be separate directories"));
    const cache = problemsOf(() => loadWorkerConfig(env({ GRAVEYARD_NPM_CACHE_DIR: join(p("staging"), "c") }), deps()));
    assert.ok(has(cache, "must be separate directories"));
  });

  it("refuses out-of-range and non-integer numbers", () => {
    const cases: Array<[string, string]> = [
      ["GRAVEYARD_WORKER_POLL_MS", "249"],
      ["GRAVEYARD_WORKER_POLL_MS", "60001"],
      ["GRAVEYARD_WORKER_POLL_MS", "1e3"],
      ["GRAVEYARD_WORKER_POLL_MS", "-5"],
      ["GRAVEYARD_WORKER_POLL_MS", " 500"],
      ["GRAVEYARD_WORKER_POLL_MS", ""],
      ["GRAVEYARD_WORKER_RECOVER_MS", "4999"],
      ["GRAVEYARD_WORKER_RECOVER_MS", "600001"],
      ["GRAVEYARD_WORKER_BATCH", "0"],
      ["GRAVEYARD_WORKER_BATCH", "21"],
      ["GRAVEYARD_WORKER_BATCH", "2.5"],
      ["GRAVEYARD_WORKER_SHUTDOWN_MS", "999"],
      ["GRAVEYARD_WORKER_SHUTDOWN_MS", "120001"],
    ];
    for (const [name, value] of cases) {
      const pr = problemsOf(() => loadWorkerConfig(env({ [name]: value }), deps()));
      assert.ok(has(pr, `${name} must be an integer between`), `${name}=${JSON.stringify(value)}`);
    }
  });

  it("refuses an unknown agent mode, worker id or log level", () => {
    assert.ok(has(problemsOf(() => loadWorkerConfig(env({ GRAVEYARD_WORKER_AGENTS: "on" }), deps())), "GRAVEYARD_WORKER_AGENTS"));
    assert.ok(has(problemsOf(() => loadWorkerConfig(env({ GRAVEYARD_WORKER_AGENTS: "KIRO-V2" }), deps())), "GRAVEYARD_WORKER_AGENTS"));
    assert.ok(has(problemsOf(() => loadWorkerConfig(env({ GRAVEYARD_WORKER_ID: "has space" }), deps())), "GRAVEYARD_WORKER_ID"));
    assert.ok(has(problemsOf(() => loadWorkerConfig(env({ GRAVEYARD_WORKER_ID: "x".repeat(65) }), deps())), "GRAVEYARD_WORKER_ID"));
    assert.ok(has(problemsOf(() => loadWorkerConfig(env({ LOG_LEVEL: "loud" }), deps())), "LOG_LEVEL"));
  });

  it("reports every problem at once", () => {
    const pr = problemsOf(() =>
      loadWorkerConfig(env({ GRAVEYARD_WORKER_BATCH: "0", GRAVEYARD_WORKER_POLL_MS: "1", GRAVEYARD_WORKER_AGENTS: "x" }), deps()),
    );
    assert.ok(pr.length >= 3);
  });

  it("refuses an unreadable catalog without echoing the reader's message", () => {
    const pr = problemsOf(() =>
      loadWorkerConfig(env(), { readCatalog: () => { throw new Error("EACCES secret-looking-detail"); }, randomId: () => "r" }),
    );
    assert.ok(has(pr, "GRAVEYARD_FIXTURE_CATALOG must be a regular file"));
    assert.ok(!pr.join("\n").includes("secret-looking-detail"));
  });

  it("refuses an oversized catalog even if the reader returned it", () => {
    const big = JSON.stringify({ [REPO]: "fx1", pad: "x".repeat(MAX_CATALOG_BYTES) });
    assert.ok(has(problemsOf(() => loadWorkerConfig(env(), deps(big))), "at most"));
  });

  it("the error message carries no environment values beyond the problem text", () => {
    try {
      loadWorkerConfig(env({ GRAVEYARD_WORKER_AGENTS: "super-secret-value-123" }), deps());
      assert.fail("expected refusal");
    } catch (e) {
      assert.ok(e instanceof WorkerConfigError);
      assert.ok(!e.message.includes("super-secret-value-123"));
    }
  });
});

describe("parseCatalog", () => {
  const ok = (text: string): Record<string, string> => {
    const r = parseCatalog(text);
    assert.ok(r.ok, "expected the catalog to be accepted");
    return r.catalog;
  };
  const bad = (text: string): string[] => {
    const r = parseCatalog(text);
    assert.ok(!r.ok, "expected the catalog to be refused");
    return r.problems;
  };

  it("accepts canonical URLs mapped to safe fixture names", () => {
    assert.deepEqual(
      ok(JSON.stringify({ "https://github.com/octocat/Hello-World": "hello.1", "https://github.com/a/b.c": "fx_2" })),
      { "https://github.com/octocat/Hello-World": "hello.1", "https://github.com/a/b.c": "fx_2" },
    );
  });

  it("refuses non-JSON, arrays, scalars and the empty object", () => {
    assert.ok(bad("{not json").some((x) => x.includes("not valid JSON")));
    assert.ok(bad("[]").some((x) => x.includes("JSON object")));
    assert.ok(bad("null").some((x) => x.includes("JSON object")));
    assert.ok(bad('"x"').some((x) => x.includes("JSON object")));
    assert.ok(bad("{}").some((x) => x.includes("no entries")));
  });

  it("refuses keys that are not already canonical", () => {
    for (const key of [
      "https://github.com/o/r/",
      "https://github.com/o/r.git",
      "http://github.com/o/r",
      "https://github.com/o",
      "https://github.com/o/r/tree/main",
      "https://evil.example/o/r",
      "https://github.com/o/..",
      "git@github.com:o/r",
      "",
    ]) {
      assert.ok(bad(JSON.stringify({ [key]: "fx1" })).some((x) => x.includes("canonical GitHub repository URL")), JSON.stringify(key));
    }
  });

  it("refuses unsafe fixture names and non-string values", () => {
    for (const value of ["../x", "a/b", "a\\b", "", ".hidden", "-x", "x".repeat(65), "a b", "C:\\x"]) {
      assert.ok(bad(JSON.stringify({ [REPO]: value })).some((x) => x.includes("fixture name")), JSON.stringify(value));
    }
    for (const value of [1, null, true, ["fx1"], { a: 1 }]) {
      assert.ok(bad(JSON.stringify({ [REPO]: value })).some((x) => x.includes("fixture name")), JSON.stringify(value));
    }
  });

  it("refuses more than the entry limit", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= MAX_CATALOG_ENTRIES; i += 1) many[`https://github.com/o/r${i}`] = "fx1";
    assert.ok(bad(JSON.stringify(many)).some((x) => x.includes("more than")));
  });

  it("does not let a __proto__ key through", () => {
    assert.ok(bad('{"__proto__":"fx1"}').some((x) => x.includes("canonical")));
  });
});
