/**
 * archive-handoff.test.ts — archive extraction into a backend-owned fixture directory, using the
 * real filesystem under os.tmpdir() and a mock executor for the runner. No Docker, git or network.
 * The archives are built by buildGitArchiveTar, not by git, so this says nothing about real
 * `git archive` output.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditTree, buildGitArchiveTar, extractArchiveIntoFixture } from "../archive-handoff.js";
import { createRunDir, ensureOwnedParent, removeRunDir } from "../fixture-workspace.js";
import { FIXTURE_KINDS, fixtureFiles } from "../node-fixture-files.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const LIMITS = { maxArchiveBytes: 1024 * 1024, maxFiles: 100, maxTotalBytes: 100_000 };
const sizeOf = (f: Record<string, string>): number => Object.values(f).reduce((n, c) => n + Buffer.byteLength(c), 0);

describe("extractArchiveIntoFixture", () => {
  let backendRoot: string;
  let parent: string;
  let runDir: string;

  before(() => {
    backendRoot = mkdtempSync(join(tmpdir(), "graveyard-handoff-test-"));
    parent = ensureOwnedParent(backendRoot);
    runDir = createRunDir(parent);
  });
  after(() => {
    const r = removeRunDir(parent, runDir);
    assert.equal(r.removed, true, r.problems.join(";"));
    assert.equal(existsSync(runDir), false);
    rmSync(backendRoot, { recursive: true, force: true });
  });

  it("extracts every controlled kind with exact manifest, commit and audit", () => {
    for (const kind of FIXTURE_KINDS) {
      const files = fixtureFiles(kind);
      const r = extractArchiveIntoFixture(buildGitArchiveTar(files, SHA), runDir, kind, LIMITS, {
        commit: SHA, files: Object.keys(files).length, totalBytes: sizeOf(files),
      });
      assert.equal(r.ok, true, kind);
      if (!r.ok) continue;
      assert.equal(r.dir, join(runDir, kind));
      for (const [rel, content] of Object.entries(files)) {
        assert.equal(readFileSync(join(r.dir, rel), "utf8"), content);
      }
      const a = auditTree(r.dir);
      assert.equal(a.files, Object.keys(files).length);
      assert.equal(a.bytes, sizeOf(files));
    }
  });

  it("refuses an existing target directory and leaves it untouched", () => {
    const files = fixtureFiles("pass");
    const again = extractArchiveIntoFixture(buildGitArchiveTar(files, SHA), runDir, "pass", LIMITS);
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.dir, null);
    assert.equal(readFileSync(join(runDir, "pass", "package.json"), "utf8"), files["package.json"]);
  });

  it("fails closed on commit, file count and byte mismatches", () => {
    const files = fixtureFiles("pass");
    const tarBytes = buildGitArchiveTar(files, SHA);
    const n = Object.keys(files).length;
    const cases: Array<[string, Record<string, unknown>]> = [
      ["m-commit", { commit: "f".repeat(40) }],
      ["m-files", { files: n + 1 }],
      ["m-bytes", { totalBytes: sizeOf(files) + 1 }],
    ];
    for (const [name, expect] of cases) {
      const r = extractArchiveIntoFixture(tarBytes, runDir, name, LIMITS, expect);
      assert.equal(r.ok, false, name);
    }
  });

  it("rejects bad run directories and fixture names without creating anything", () => {
    const tarBytes = buildGitArchiveTar(fixtureFiles("pass"), SHA);
    assert.equal(extractArchiveIntoFixture(tarBytes, parent, "x", LIMITS).ok, false);
    assert.equal(extractArchiveIntoFixture(tarBytes, "relative", "x", LIMITS).ok, false);
    for (const bad of ["", "..", "a/b", ".hidden", "a b"]) {
      assert.equal(extractArchiveIntoFixture(tarBytes, runDir, bad, LIMITS).ok, false, bad);
    }
  });

  it("rejects a symlink run directory", (t) => {
    const link = join(parent, "run-aaaaaaaaaaaa");
    try {
      symlinkSync(runDir, link, "dir");
    } catch {
      t.skip("symlink creation not permitted here");
      return;
    }
    try {
      const r = extractArchiveIntoFixture(buildGitArchiveTar(fixtureFiles("pass"), SHA), link, "viaLink", LIMITS);
      assert.equal(r.ok, false);
      assert.equal(existsSync(join(runDir, "viaLink")), false);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it("writes nothing when the archive is refused, and reports the created dir for cleanup", () => {
    const bad = buildGitArchiveTar({ "../evil": "x" }, SHA);
    const r = extractArchiveIntoFixture(bad, runDir, "evil", LIMITS);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.dir, null);
    assert.equal(existsSync(join(runDir, "evil")), false);
    assert.equal(existsSync(join(runDir, "..", "evil")), false);
  });

  it("leaves no target directory or files on commit, file count or byte mismatch", () => {
    const files = fixtureFiles("pass");
    const tarBytes = buildGitArchiveTar(files, SHA);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["nw-commit", { commit: "f".repeat(40) }],
      ["nw-files", { files: Object.keys(files).length + 1 }],
      ["nw-bytes", { totalBytes: sizeOf(files) + 1 }],
    ];
    for (const [name, expect] of cases) {
      const r = extractArchiveIntoFixture(tarBytes, runDir, name, LIMITS, expect);
      assert.equal(r.ok, false, name);
      if (!r.ok) assert.equal(r.dir, null, name);
      assert.equal(existsSync(join(runDir, name)), false, name);
    }
  });

  it("applies byte limits", () => {
    const r = extractArchiveIntoFixture(buildGitArchiveTar(fixtureFiles("pass"), SHA), runDir, "limited", { ...LIMITS, maxTotalBytes: 10 });
    assert.equal(r.ok, false);
  });

  it("removeRunDir removes the exact extracted tree", () => {
    const rd = createRunDir(parent);
    const r = extractArchiveIntoFixture(buildGitArchiveTar(fixtureFiles("pass"), SHA), rd, "pass", LIMITS);
    assert.equal(r.ok, true);
    assert.equal(lstatSync(join(rd, "pass", "lib")).isDirectory(), true);
    const rm = removeRunDir(parent, rd);
    assert.equal(rm.removed, true, rm.problems.join(";"));
    assert.equal(existsSync(rd), false);
    assert.equal(existsSync(parent), true);
  });
});

describe("buildGitArchiveTar", () => {
  it("requires a 40-hex commit", () => {
    assert.throws(() => buildGitArchiveTar({ a: "x" }, "abc"));
  });
  it("rejects names a plain ustar header cannot hold", () => {
    assert.throws(() => buildGitArchiveTar({ ["a".repeat(101)]: "x" }, SHA));
  });
});
