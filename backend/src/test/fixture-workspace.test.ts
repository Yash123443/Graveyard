/**
 * fixture-workspace.test.ts — path validation and safe removal, plus a sanity check of the
 * fixture file contents. Uses the REAL filesystem, but only inside a fresh directory created
 * under os.tmpdir(). No Docker, no process execution, no fixture code is run.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunDir, ensureOwnedParent, removeRunDir, writeFixture } from "../fixture-workspace.js";
import { FIXTURE_KINDS, fixtureFiles } from "../node-fixture-files.js";
import { BUILD_MARKER, NODE_FIXTURE_COMMANDS } from "../node-fixture-runner.js";

const base = mkdtempSync(join(tmpdir(), "graveyard-fw-test-"));
const created: string[] = [];

/** Test-only cleanup: unlinks the exact files and directories this test created, no recursion. */
after(() => {
  try { unlinkSync(join(base, "outside.txt")); } catch { /* absent */ }
  for (const d of created.reverse()) { try { rmdirSync(d); } catch { /* left for the OS temp cleaner */ } }
  try { rmdirSync(base); } catch { /* left for the OS temp cleaner */ }
});

describe("ensureOwnedParent / createRunDir", () => {
  it("creates .tmp-fixtures once and a fresh run-<12 hex> directory under it", () => {
    const root = join(base, "backend-root");
    mkdirSync(root);
    created.push(root);
    const parent = ensureOwnedParent(root);
    created.push(parent);
    assert.equal(parent, join(root, ".tmp-fixtures"));
    assert.equal(ensureOwnedParent(root), parent);
    const run = createRunDir(parent);
    created.push(run);
    assert.match(run.slice(parent.length + 1), /^run-[0-9a-f]{12}$/);
    assert.ok(lstatSync(run).isDirectory());
    assert.notEqual(createRunDir(parent), run);
    removeRunDir(parent, run);
  });

  it("rejects relative paths and missing roots", () => {
    assert.throws(() => ensureOwnedParent("relative/dir"));
    assert.throws(() => createRunDir("relative/dir"));
    assert.throws(() => ensureOwnedParent(join(base, "does-not-exist")));
  });

  it("refuses a symlinked parent", (t) => {
    const real = join(base, "real-parent");
    const link = join(base, "link-parent");
    mkdirSync(real);
    created.push(real);
    try { symlinkSync(real, link, "junction"); } catch { t.skip("cannot create symlink here"); return; }
    created.push(link);
    assert.throws(() => createRunDir(link));
  });
});

describe("writeFixture", () => {
  const parent = join(base, "wf-parent");
  mkdirSync(parent);
  created.push(parent);

  it("writes nested files exclusively with validated names", () => {
    const run = createRunDir(parent);
    const dir = writeFixture(run, "case1", { "a.txt": "A", "sub/b.txt": "B" });
    assert.equal(readFileSync(join(dir, "sub", "b.txt"), "utf8"), "B");
    assert.throws(() => writeFixture(run, "case1", { "a.txt": "again" }), /EEXIST/);
    assert.deepEqual(removeRunDir(parent, run).problems, []);
  });

  it("rejects unsafe fixture names and file paths before writing anything outside", () => {
    const run = createRunDir(parent);
    for (const bad of ["../x", "a/b", ".hidden", "", "x y", "a\\b"]) {
      assert.throws(() => writeFixture(run, bad, { "a.txt": "A" }), `name ${bad}`);
    }
    assert.deepEqual(removeRunDir(parent, run).problems, []);
    for (const bad of ["../outside.txt", "/abs.txt", "a//b.txt", ".hidden", "a/../b.txt", "a\\b.txt", ""]) {
      const r = createRunDir(parent);
      assert.throws(() => writeFixture(r, "ok", { [bad]: "x" }), `path ${bad}`);
      assert.equal(existsSync(join(base, "outside.txt")), false);
      // a failed write may leave a partial tree; removal must still work
      assert.deepEqual(removeRunDir(parent, r).problems, []);
    }
  });

  it("rejects empty, oversized and too many files", () => {
    const run = createRunDir(parent);
    assert.throws(() => writeFixture(run, "e", {}));
    assert.throws(() => writeFixture(run, "big", { "a.txt": "x".repeat(70_000) }));
    const many: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) many[`f${i}.txt`] = "x";
    assert.throws(() => writeFixture(run, "many", many));
    removeRunDir(parent, run);
  });

  it("refuses to write into a directory that is not a generated run directory", () => {
    const notRun = join(parent, "not-a-run");
    mkdirSync(notRun);
    created.push(notRun);
    assert.throws(() => writeFixture(notRun, "x", { "a.txt": "A" }));
  });
});

describe("removeRunDir", () => {
  const parent = join(base, "rm-parent");
  mkdirSync(parent);
  created.push(parent);

  it("removes a generated tree without recursion helpers and reports success", () => {
    const run = createRunDir(parent);
    writeFixture(run, "case1", { "a.txt": "A", "x/y/z.txt": "Z" });
    const r = removeRunDir(parent, run);
    assert.deepEqual(r, { removed: true, problems: [] });
    assert.equal(existsSync(run), false);
  });

  it("refuses anything that is not a direct run-<hex> child of the parent", () => {
    const other = join(base, "other-dir");
    mkdirSync(other);
    created.push(other);
    assert.equal(removeRunDir(parent, other).removed, false);
    assert.equal(removeRunDir(parent, parent).removed, false);
    assert.equal(removeRunDir(parent, join(parent, "run-ZZZZZZZZZZZZ")).removed, false);
    assert.equal(removeRunDir(parent, join(parent, "..", "run-aaaaaaaaaaaa")).removed, false);
    assert.equal(removeRunDir("relative", "relative/run-aaaaaaaaaaaa").removed, false);
    assert.ok(existsSync(other));
  });

  it("refuses a run-named symlink and leaves its target untouched", (t) => {
    const target = join(base, "symlink-target");
    mkdirSync(target);
    created.push(target);
    writeFileSync(join(target, "keep.txt"), "keep");
    const link = join(parent, "run-abcdef012345");
    try { symlinkSync(target, link, "junction"); } catch { t.skip("cannot create symlink here"); return; }
    const r = removeRunDir(parent, link);
    assert.equal(r.removed, false);
    assert.equal(readFileSync(join(target, "keep.txt"), "utf8"), "keep");
    unlinkSync(join(target, "keep.txt"));
    try { rmdirSync(link); } catch { try { unlinkSync(link); } catch { /* left */ } }
  });

  it("reports a missing directory as a problem without throwing", () => {
    const r = removeRunDir(parent, join(parent, "run-000000000000"));
    assert.equal(r.removed, false);
    assert.equal(r.problems.length, 1);
  });
});

describe("fixture files", () => {
  it("every fixture is dependency-free, installs nothing and uses only safe relative paths", () => {
    for (const kind of FIXTURE_KINDS) {
      const files = fixtureFiles(kind);
      assert.ok(files["build.mjs"] !== undefined && files["package.json"] !== undefined);
      const pkg = JSON.parse(files["package.json"] as string) as Record<string, unknown>;
      assert.equal(pkg["dependencies"], undefined);
      assert.equal(pkg["devDependencies"], undefined);
      assert.equal(pkg["scripts"], undefined);
      for (const [path, content] of Object.entries(files)) {
        assert.match(path, /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/);
        assert.ok(!path.includes(".."));
        assert.ok(!/child_process|node:net|node:http|node:dns|npm|fetch\(/.test(content), `${kind}:${path}`);
      }
    }
  });

  it("build output goes only under /tmp and the CLI prints the marker the runner requires", () => {
    const cli = fixtureFiles("pass")["build.mjs"] as string;
    assert.ok(cli.includes(BUILD_MARKER));
    assert.ok(cli.includes('startsWith("/tmp/")'));
    assert.equal(NODE_FIXTURE_COMMANDS.build[2], "/tmp/out");
    const test = fixtureFiles("pass")["test/index.test.mjs"] as string;
    assert.ok(test.includes('"/tmp/graveyard-test-out"'));
  });

  it("kinds differ as intended", () => {
    assert.ok(fixtureFiles("pass")["test/index.test.mjs"]?.includes("equal(built.add(2, 2), 4)"));
    assert.ok(fixtureFiles("fail-test")["test/index.test.mjs"]?.includes("equal(built.add(2, 2), 5)"));
    assert.ok(fixtureFiles("fail-build")["lib/build.mjs"]?.includes("intentional build failure"));
    assert.equal(fixtureFiles("no-tests")["test/index.test.mjs"], undefined);
    assert.ok(!fixtureFiles("pass")["lib/build.mjs"]?.includes("intentional"));
  });
});
