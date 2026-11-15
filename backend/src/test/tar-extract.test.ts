/**
 * tar-extract.test.ts — strict tar extraction against hand-built in-memory archives.
 * No filesystem, Docker, git or network. Shows the validator's decisions on crafted input only;
 * it has not been run against real `git archive` output.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractTar, type ExtractSink } from "../tar-extract.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const LIMITS = { maxArchiveBytes: 1024 * 1024, maxFiles: 100, maxTotalBytes: 10_000 };

function header(name: string, type: string, size: number, mode = 0o644, prefix = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  h.write(type, 156, 1, "ascii");
  h.write("ustar\0" + "00", 257, 8, "latin1");
  h.write(prefix, 345, 155, "utf8");
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}
const body = (s: string): Buffer => {
  const b = Buffer.from(s);
  return Buffer.concat([b, Buffer.alloc(Math.ceil(b.length / 512) * 512 - b.length)]);
};
const file = (name: string, content: string, mode = 0o644): Buffer =>
  Buffer.concat([header(name, "0", Buffer.byteLength(content), mode), body(content)]);
const dir = (name: string): Buffer => header(name, "5", 0, 0o755);
const link = (name: string, type: "1" | "2"): Buffer => header(name, type, 0);
const END = Buffer.alloc(1024);
const tar = (...parts: Buffer[]): Buffer => Buffer.concat([...parts, END]);

class MemSink implements ExtractSink {
  ops: string[] = [];
  mkdir(p: string): void { this.ops.push(`d ${p}`); }
  writeFile(p: string, d: Uint8Array, x: boolean): void { this.ops.push(`f ${p} ${d.length}${x ? " x" : ""}`); }
}

describe("extractTar", () => {
  it("extracts regular files and directories, creating parents first", () => {
    const sink = new MemSink();
    const glob = body(`52 comment=${SHA}\n`);
    const g = Buffer.concat([header("pax_global_header", "g", 52), glob]);
    const r = extractTar(tar(g, file("README.md", "hello"), dir("src/"), file("src/bin/run", "x", 0o755)), LIMITS, sink);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.files, 2);
      assert.equal(r.value.totalBytes, 6);
      assert.equal(r.value.archiveCommit, SHA);
    }
    assert.deepEqual(sink.ops, ["f README.md 5", "d src", "d src/bin", "f src/bin/run 1 x"]);
  });

  it("rejects symlinks and hard links and writes nothing", () => {
    for (const t of ["1", "2"] as const) {
      const sink = new MemSink();
      const r = extractTar(tar(file("a", "x"), link("evil", t)), LIMITS, sink);
      assert.equal(r.ok, false);
      assert.deepEqual(sink.ops, []);
    }
  });

  it("rejects traversal, absolute, backslash and .git paths", () => {
    for (const p of ["../x", "a/../../x", "/etc/passwd", "a\\b", ".git/config", "a/.GIT/x", "a//b"]) {
      const sink = new MemSink();
      const r = extractTar(tar(file(p, "x")), LIMITS, sink);
      assert.equal(r.ok, false, p);
      assert.deepEqual(sink.ops, [], p);
    }
  });

  it("applies the ustar prefix to the path check", () => {
    const h = header("x", "0", 1, 0o644, "../up");
    const r = extractTar(tar(Buffer.concat([h, body("a")])), LIMITS, new MemSink());
    assert.equal(r.ok, false);
  });

  it("rejects case-colliding and file/directory conflicting paths", () => {
    assert.equal(extractTar(tar(file("A.txt", "1"), file("a.txt", "2")), LIMITS, new MemSink()).ok, false);
    assert.equal(extractTar(tar(file("a", "1"), file("a/b", "2")), LIMITS, new MemSink()).ok, false);
    assert.equal(extractTar(tar(file("a/b", "2"), file("a", "1")), LIMITS, new MemSink()).ok, false);
    assert.equal(extractTar(tar(dir("d/"), dir("d/")), LIMITS, new MemSink()).ok, false);
  });

  it("rejects per-entry pax, GNU long-name and device entries", () => {
    for (const t of ["x", "L", "K", "3", "4", "6"]) {
      assert.equal(extractTar(tar(header("n", t, 0)), LIMITS, new MemSink()).ok, false, t);
    }
  });

  it("enforces byte, file-count and archive-size bounds", () => {
    assert.equal(extractTar(tar(file("a", "x".repeat(600)), file("b", "y".repeat(600))), { ...LIMITS, maxTotalBytes: 1000 }, new MemSink()).ok, false);
    assert.equal(extractTar(tar(file("a", "1"), file("b", "2")), { ...LIMITS, maxFiles: 1 }, new MemSink()).ok, false);
    assert.equal(extractTar(tar(file("a", "1")), { ...LIMITS, maxArchiveBytes: 1024 }, new MemSink()).ok, false);
  });

  it("rejects a bad checksum, truncation, trailing data and base-256 sizes", () => {
    const bad = file("a", "x");
    bad[0] = bad[0] === 0x62 ? 0x63 : 0x62;
    assert.equal(extractTar(tar(bad), LIMITS, new MemSink()).ok, false);
    assert.equal(extractTar(file("a", "x".repeat(600)).subarray(0, 700), LIMITS, new MemSink()).ok, false);
    assert.equal(extractTar(Buffer.concat([tar(file("a", "x")), Buffer.from("junk")]), LIMITS, new MemSink()).ok, false);
    const b256 = header("a", "0", 1);
    b256[124] = 0x80;
    assert.equal(extractTar(tar(b256), LIMITS, new MemSink()).ok, false);
  });

  it("rejects an empty archive", () => {
    assert.equal(extractTar(Buffer.alloc(0), LIMITS, new MemSink()).ok, false);
    assert.equal(extractTar(END, LIMITS, new MemSink()).ok, false);
  });
});
