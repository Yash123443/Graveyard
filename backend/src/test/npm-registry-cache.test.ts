/**
 * npm-registry-cache.test.ts — strict verification and handoff of the exported npm cache, and
 * strict parsing of the acquisition driver's single output line. Pure functions plus real
 * temporary directories under os.tmpdir(). No Docker, no npm, no network.
 *
 * These tests use SYNTHETIC cache bytes whose hashes are computed here. They show that the checks
 * refuse what they are written to refuse. They do NOT show that real npm writes the layout assumed
 * by the verifier (that is unobserved and needs the opt-in harness), and they do not use the real
 * is-number tarball.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACQUIRE_PROTOCOL_ID,
  MAX_EXPORT_FILES,
  encodeAcquireLine,
  type AcquireResult,
  type ExportedFile,
} from "../npm-acquire-driver.js";
import {
  contentPathFor,
  handoffNpmCache,
  hexToIntegrity,
  indexPathFor,
  integrityToHex,
  packumentKey,
  parseAcquireOutput,
  tarballKey,
  verifyNpmCacheFiles,
  type ExpectedTarball,
} from "../npm-registry-cache.js";

const sha = (algo: "sha1" | "sha256" | "sha512", d: Uint8Array | string): string => createHash(algo).update(d).digest("hex");
const TGZ = Buffer.from("synthetic tarball bytes, not a real tarball\n");
const PACKUMENT = Buffer.from('{"name":"is-number","versions":{}}\n');

function pkgFor(bytes: Buffer): ExpectedTarball {
  return { name: "is-number", version: "7.0.0", integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}
function file(path: string, bytes: Buffer): ExportedFile {
  return { path, size: bytes.length, data: bytes.toString("base64") };
}
function indexBytes(...entries: object[]): Buffer {
  return Buffer.from(
    entries
      .map((e) => {
        const json = JSON.stringify(e);
        return `\n${sha("sha1", json)}\t${json}`;
      })
      .join(""),
  );
}
function entryFor(key: string, integrity: string, bytes: Buffer): Record<string, unknown> {
  return { key, integrity, time: 1700000000000, size: bytes.length, metadata: { url: "https://registry.npmjs.org/x" } };
}

interface Built {
  expected: ExpectedTarball;
  files: ExportedFile[];
}
function build(bytes: Buffer = TGZ): Built {
  const expected = pkgFor(bytes);
  const key = tarballKey(expected);
  return {
    expected,
    files: [
      file(contentPathFor(expected.integrity) as string, bytes),
      file(indexPathFor(key), indexBytes(entryFor(key, expected.integrity, bytes))),
    ],
  };
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gy-cache-test-"));
  dirs.push(d);
  return d;
}

function mustFail(r: { ok: boolean }, label: string): void {
  assert.equal(r.ok, false, label);
}

// ---------------------------------------------------------------------------

describe("integrity and path helpers", () => {
  it("round-trips a canonical sha512 value and rejects everything else", () => {
    const i = pkgFor(TGZ).integrity;
    const hex = integrityToHex(i);
    assert.ok(hex !== null && hex.length === 128);
    assert.equal(hexToIntegrity(hex), i);
    for (const bad of ["", "sha512-", "sha1-abc", `sha512-${"A".repeat(86)}`, `sha512-${"A".repeat(87)}==`, `${i} sha512-x`, `${i}\n`, undefined, 5, null]) {
      assert.equal(integrityToHex(bad), null, String(bad));
    }
    // Non-canonical base64: last character carries bits that a 64-byte value cannot have.
    assert.equal(integrityToHex(`sha512-${"A".repeat(85)}B==`), null);
  });

  it("builds the cacache paths with the expected shape", () => {
    const i = pkgFor(TGZ).integrity;
    assert.match(contentPathFor(i) as string, /^content-v2\/sha512\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{124}$/);
    assert.match(indexPathFor("k"), /^index-v5\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{60}$/);
    assert.equal(contentPathFor("nope"), null);
  });

  it("keys name only registry.npmjs.org URLs", () => {
    const p = pkgFor(TGZ);
    assert.equal(tarballKey(p), "make-fetch-happen:request-cache:https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz");
    assert.equal(packumentKey(p), "make-fetch-happen:request-cache:https://registry.npmjs.org/is-number");
  });
});

describe("verifyNpmCacheFiles", () => {
  it("accepts a consistent cache and binds the tarball to the lockfile integrity", () => {
    const b = build();
    const v = verifyNpmCacheFiles(b.files, [b.expected]);
    assert.ok(v.ok);
    assert.equal(v.value.summary.files, 2);
    assert.equal(v.value.summary.contentFiles, 1);
    assert.equal(v.value.summary.indexFiles, 1);
    assert.equal(v.value.summary.totalBytes, b.files.reduce((n, f) => n + f.size, 0));
    assert.deepEqual(v.value.summary.tarballs, [b.expected]);
    assert.equal(v.value.entries[0]?.bytes.equals(TGZ), true);
  });

  it("also accepts the packument entry for the expected package", () => {
    const b = build();
    const pkey = packumentKey(b.expected);
    const pInteg = `sha512-${createHash("sha512").update(PACKUMENT).digest("base64")}`;
    const files = [
      ...b.files,
      file(contentPathFor(pInteg) as string, PACKUMENT),
      file(indexPathFor(pkey), indexBytes(entryFor(pkey, pInteg, PACKUMENT))),
    ];
    const v = verifyNpmCacheFiles(files, [b.expected]);
    assert.ok(v.ok);
    assert.equal(v.value.summary.contentFiles, 2);
  });

  it("rejects tarball bytes that do not match the hash in their path", () => {
    const b = build();
    const bad = [file(b.files[0]?.path as string, Buffer.from("tampered")), b.files[1] as ExportedFile];
    mustFail(verifyNpmCacheFiles(bad, [b.expected]), "tampered content");
  });

  it("rejects a tarball whose hash is not the one the lockfile names", () => {
    const b = build();
    const other = pkgFor(Buffer.from("different bytes"));
    mustFail(verifyNpmCacheFiles(b.files, [other]), "expected integrity differs from what was handed over");
  });

  it("rejects hostile and unknown paths, even when everything else is valid", () => {
    const b = build();
    const hex = "a".repeat(128);
    const hostile = [
      "../evil", "/abs/path", "content-v2/sha512/ab/cd/../../x", "_logs/2026-11-15.log", "tmp/x", ".git/config",
      "content-v2/sha512/AB/cd/" + "a".repeat(124), "content-v2/sha512/ab/cd/short", "content-v2/sha1/ab/cd/" + "a".repeat(124),
      `content-v2/sha512/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4)}/extra`, "index-v5/zz/zz/" + "a".repeat(60),
      "index-v5/ab/cd/" + "a".repeat(59), "index-v5/ab/cd/" + "a".repeat(61), "a\\b", "content-v2\\x", "", " ", "_cacache/index-v5/ab/cd/" + "a".repeat(60),
      "content-v2/sha512/ab/cd/" + "a".repeat(124) + "\n",
    ];
    for (const p of hostile) {
      mustFail(verifyNpmCacheFiles([...b.files, file(p, Buffer.from("x"))], [b.expected]), JSON.stringify(p));
    }
  });

  it("rejects duplicate paths", () => {
    const b = build();
    mustFail(verifyNpmCacheFiles([...b.files, b.files[0] as ExportedFile], [b.expected]), "duplicate");
  });

  it("rejects non-canonical base64, a wrong declared size and malformed entries", () => {
    const b = build();
    const f0 = b.files[0] as ExportedFile;
    const rest = b.files.slice(1);
    mustFail(verifyNpmCacheFiles([{ ...f0, data: f0.data.replace(/=+$/, "") + "\n" }, ...rest], [b.expected]), "whitespace");
    mustFail(verifyNpmCacheFiles([{ ...f0, data: f0.data.replace(/\+/g, "-").replace(/\//g, "_") + "!" }, ...rest], [b.expected]), "url-safe or junk");
    mustFail(verifyNpmCacheFiles([{ ...f0, size: f0.size + 1 }, ...rest], [b.expected]), "size lies");
    mustFail(verifyNpmCacheFiles([{ ...f0, size: -1 }, ...rest], [b.expected]), "negative size");
    mustFail(verifyNpmCacheFiles([{ ...f0, extra: 1 } as unknown as ExportedFile, ...rest], [b.expected]), "extra key");
    mustFail(verifyNpmCacheFiles([{ path: f0.path, size: f0.size } as unknown as ExportedFile, ...rest], [b.expected]), "missing key");
    mustFail(verifyNpmCacheFiles([null, ...rest], [b.expected]), "null entry");
    mustFail(verifyNpmCacheFiles("files", [b.expected]), "not an array");
    mustFail(verifyNpmCacheFiles([], [b.expected]), "empty");
  });

  it("enforces the file count, per-file and total byte limits", () => {
    const b = build();
    assert.ok(verifyNpmCacheFiles(b.files, [b.expected], { maxFiles: 2, maxFileBytes: 1024, maxTotalBytes: 4096 }).ok);
    mustFail(verifyNpmCacheFiles(b.files, [b.expected], { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 4096 }), "count");
    mustFail(verifyNpmCacheFiles(b.files, [b.expected], { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 4096 }), "per file");
    mustFail(verifyNpmCacheFiles(b.files, [b.expected], { maxFiles: 2, maxFileBytes: 1024, maxTotalBytes: 60 }), "total");
  });

  it("rejects index entries for keys that are not the expected registry URLs", () => {
    const b = build();
    for (const key of [
      "make-fetch-happen:request-cache:https://evil.example/is-number/-/is-number-7.0.0.tgz",
      "make-fetch-happen:request-cache:https://registry.npmjs.org/other-package",
      "make-fetch-happen:request-cache:http://registry.npmjs.org/is-number",
      "make-fetch-happen:request-cache:https://registry.npmjs.org/is-number/-/is-number-7.0.1.tgz",
      "something-else",
    ]) {
      const e = entryFor(key, b.expected.integrity, TGZ);
      mustFail(verifyNpmCacheFiles([b.files[0] as ExportedFile, file(indexPathFor(key), indexBytes(e))], [b.expected]), key);
    }
  });

  it("rejects an index bucket whose path does not match its key", () => {
    const b = build();
    const key = tarballKey(b.expected);
    const wrongPath = indexPathFor("another key");
    mustFail(verifyNpmCacheFiles([b.files[0] as ExportedFile, file(wrongPath, indexBytes(entryFor(key, b.expected.integrity, TGZ)))], [b.expected]), "bucket");
  });

  it("rejects index lines with a bad sha1, bad JSON, missing fields or too many entries", () => {
    const b = build();
    const key = tarballKey(b.expected);
    const content = b.files[0] as ExportedFile;
    const good = entryFor(key, b.expected.integrity, TGZ);
    const json = JSON.stringify(good);
    const variants: Array<[string, Buffer]> = [
      ["bad sha1", Buffer.from(`\n${"0".repeat(40)}\t${json}`)],
      ["not json", Buffer.from(`\n${sha("sha1", "{nope")}\t{nope`)],
      ["no tab", Buffer.from(`\n${sha("sha1", json)} ${json}`)],
      ["array", Buffer.from(`\n${sha("sha1", "[1]")}\t[1]`)],
      ["no time", indexBytes({ key, integrity: b.expected.integrity, size: TGZ.length })],
      ["no size", indexBytes({ key, integrity: b.expected.integrity, time: 1 })],
      ["size differs", indexBytes({ ...good, size: TGZ.length + 1 })],
      ["empty", Buffer.from("\n\n")],
      ["too many", indexBytes(good, good, good, good, good)],
      ["not utf8", Buffer.from([0x0a, 0xff, 0xfe])],
    ];
    for (const [label, bytes] of variants) {
      mustFail(verifyNpmCacheFiles([content, file(indexPathFor(key), bytes)], [b.expected]), label);
    }
  });

  it("rejects an index entry that points at content that was not handed over", () => {
    const b = build();
    const key = tarballKey(b.expected);
    const ghost = pkgFor(Buffer.from("never handed over"));
    const e = entryFor(key, ghost.integrity, Buffer.from("never handed over"));
    mustFail(verifyNpmCacheFiles([b.files[0] as ExportedFile, file(indexPathFor(key), indexBytes(e))], [b.expected]), "dangling");
  });

  it("rejects content that no index entry references", () => {
    const b = build();
    const extra = Buffer.from("orphan content");
    const files = [...b.files, file(contentPathFor(pkgFor(extra).integrity) as string, extra)];
    mustFail(verifyNpmCacheFiles(files, [b.expected]), "orphan");
  });

  it("rejects a tarball entry that carries a different integrity than the lockfile", () => {
    const b = build();
    const decoy = Buffer.from("decoy tarball");
    const decoyInteg = pkgFor(decoy).integrity;
    const key = tarballKey(b.expected);
    const files = [
      file(contentPathFor(decoyInteg) as string, decoy),
      file(contentPathFor(b.expected.integrity) as string, TGZ),
      file(indexPathFor(key), indexBytes(entryFor(key, decoyInteg, decoy))),
    ];
    mustFail(verifyNpmCacheFiles(files, [b.expected]), "decoy bound to the tarball key");
  });

  it("rejects a cache with content but no index, or the reverse", () => {
    const b = build();
    mustFail(verifyNpmCacheFiles([b.files[0] as ExportedFile], [b.expected]), "no index");
    mustFail(verifyNpmCacheFiles([b.files[1] as ExportedFile], [b.expected]), "no content");
  });

  it("rejects unsupported expectations", () => {
    const b = build();
    mustFail(verifyNpmCacheFiles(b.files, []), "none");
    mustFail(verifyNpmCacheFiles(b.files, [{ ...b.expected, name: "@scope/pkg" }]), "scoped");
    mustFail(verifyNpmCacheFiles(b.files, [{ ...b.expected, name: "Is-Number" }]), "uppercase");
    mustFail(verifyNpmCacheFiles(b.files, [{ ...b.expected, version: "^7.0.0" }]), "range");
    mustFail(verifyNpmCacheFiles(b.files, [{ ...b.expected, integrity: "sha1-abc" }]), "integrity");
  });
});

describe("handoffNpmCache (real temporary directories)", () => {
  it("writes the verified tree under <runDir>/<name>/_cacache and re-verifies it on disk", () => {
    const b = build();
    const run = tmp();
    const r = handoffNpmCache(b.files, [b.expected], run, "cache");
    assert.ok(r.ok);
    assert.equal(r.cacheDir, join(run, "cache"));
    assert.equal(r.summary.files, 2);
    const contentRel = (contentPathFor(b.expected.integrity) as string).split("/");
    const onDisk = readFileSync(join(r.cacheDir, "_cacache", ...contentRel));
    assert.equal(onDisk.equals(TGZ), true);
    assert.equal(sha("sha512", onDisk), `${contentRel[2]}${contentRel[3]}${contentRel[4]}`);
    assert.equal(lstatSync(join(r.cacheDir, "_cacache")).isDirectory(), true);
    assert.deepEqual(readdirSync(r.cacheDir), ["_cacache"]);
    assert.deepEqual(readdirSync(join(r.cacheDir, "_cacache")).sort(), ["content-v2", "index-v5"]);
  });

  it("creates nothing when verification fails", () => {
    const b = build();
    const run = tmp();
    const bad = [file(b.files[0]?.path as string, Buffer.from("tampered")), b.files[1] as ExportedFile];
    const r = handoffNpmCache(bad, [b.expected], run, "cache");
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.dir === null);
    assert.deepEqual(readdirSync(run), []);
  });

  it("refuses an existing target and leaves it untouched", () => {
    const b = build();
    const run = tmp();
    mkdirSync(join(run, "cache"));
    writeFileSync(join(run, "cache", "keep.txt"), "keep");
    const r = handoffNpmCache(b.files, [b.expected], run, "cache");
    assert.ok(!r.ok && r.dir === null);
    assert.deepEqual(readdirSync(join(run, "cache")), ["keep.txt"]);
  });

  it("refuses a run directory that is missing, relative or a file, and bad names", () => {
    const b = build();
    const run = tmp();
    writeFileSync(join(run, "afile"), "x");
    for (const d of [join(run, "missing"), "relative/dir", join(run, "afile"), "", undefined as unknown as string]) {
      const r = handoffNpmCache(b.files, [b.expected], d, "cache");
      assert.ok(!r.ok && r.dir === null, String(d));
    }
    for (const n of ["", "../x", "a/b", ".hidden", "a b", "x".repeat(65)]) {
      const r = handoffNpmCache(b.files, [b.expected], run, n);
      assert.ok(!r.ok && r.dir === null, n);
    }
    assert.deepEqual(readdirSync(run), ["afile"]);
  });
});

describe("parseAcquireOutput", () => {
  const passed = (files: ExportedFile[]): AcquireResult => ({
    status: "passed", phase: "done", durationMs: 12, stdoutTail: "added 1 package in 1s\n", stderrTail: "", exitCode: 0, files,
  });
  const failed = (extra: Partial<AcquireResult> = {}): AcquireResult => ({
    status: "failed", phase: "install", reason: "exit-code", detail: "exited with code 1", exitCode: 1, durationMs: 5,
    stdoutTail: "", stderrTail: "npm error", files: [], ...extra,
  });
  const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;
  const base = (): Record<string, unknown> => JSON.parse(encodeAcquireLine(failed())) as Record<string, unknown>;

  it("accepts a passed report with files, a failed one and a cancelled one", () => {
    const b = build();
    const p = parseAcquireOutput(encodeAcquireLine(passed(b.files)));
    assert.ok(p.ok && p.value.status === "passed" && p.value.files.length === 2);
    const f = parseAcquireOutput(encodeAcquireLine(failed()));
    assert.ok(f.ok && f.value.reason === "exit-code" && f.value.phase === "install" && f.value.exitCode === 1);
    const c = parseAcquireOutput(encodeAcquireLine(failed({ status: "cancelled", reason: "cancelled", exitCode: null })));
    assert.ok(c.ok && c.value.status === "cancelled");
  });

  it("rejects malformed framing", () => {
    const ok = encodeAcquireLine(failed());
    for (const s of ["", ok.trim(), `${ok}${ok}`, ok.replace("\n", "\r\n"), "not json\n", "[]\n", "null\n", `${ok}\n`, ` ${ok}`]) {
      mustFail(parseAcquireOutput(s), JSON.stringify(s.slice(0, 30)));
    }
    mustFail(parseAcquireOutput(undefined as unknown as string), "undefined");
    mustFail(parseAcquireOutput(`${"x".repeat(260 * 1024)}\n`), "too large");
  });

  it("rejects unknown keys, missing keys and a wrong protocol", () => {
    mustFail(parseAcquireOutput(line({ ...base(), extra: 1 })), "extra");
    for (const k of ["protocol", "status", "phase", "durationMs", "stdoutTail", "stderrTail", "files"]) {
      const o = base();
      delete o[k];
      mustFail(parseAcquireOutput(line(o)), `missing ${k}`);
    }
    mustFail(parseAcquireOutput(line({ ...base(), protocol: `${ACQUIRE_PROTOCOL_ID}x` })), "protocol");
  });

  it("rejects inconsistent status, phase, reason and files", () => {
    const b = build();
    const p = JSON.parse(encodeAcquireLine(passed(b.files))) as Record<string, unknown>;
    mustFail(parseAcquireOutput(line({ ...p, phase: "install" })), "passed in a failure phase");
    mustFail(parseAcquireOutput(line({ ...p, reason: "exit-code" })), "passed with a reason");
    mustFail(parseAcquireOutput(line({ ...p, files: [] })), "passed without files");
    mustFail(parseAcquireOutput(line({ ...base(), files: b.files })), "failed with files");
    mustFail(parseAcquireOutput(line({ ...base(), phase: "done" })), "failed in phase done");
    mustFail(parseAcquireOutput(line({ ...base(), reason: undefined })), "failed without reason");
    mustFail(parseAcquireOutput(line({ ...base(), reason: "cancelled" })), "failed with cancelled reason");
    mustFail(parseAcquireOutput(line({ ...base(), status: "cancelled" })), "cancelled with other reason");
    mustFail(parseAcquireOutput(line({ ...base(), status: "weird" })), "status");
    mustFail(parseAcquireOutput(line({ ...base(), phase: "weird" })), "phase");
    mustFail(parseAcquireOutput(line({ ...base(), reason: "weird" })), "reason");
  });

  it("rejects out-of-range fields and malformed file entries", () => {
    mustFail(parseAcquireOutput(line({ ...base(), detail: "x".repeat(301) })), "detail");
    mustFail(parseAcquireOutput(line({ ...base(), stdoutTail: "x".repeat(1025) })), "stdoutTail");
    mustFail(parseAcquireOutput(line({ ...base(), stderrTail: 5 })), "stderrTail");
    mustFail(parseAcquireOutput(line({ ...base(), durationMs: -1 })), "durationMs");
    mustFail(parseAcquireOutput(line({ ...base(), exitCode: 1.5 })), "exitCode");
    const b = build();
    const p = JSON.parse(encodeAcquireLine(passed(b.files))) as Record<string, unknown>;
    mustFail(parseAcquireOutput(line({ ...p, files: [{ path: "x", size: 1 }] })), "file missing data");
    mustFail(parseAcquireOutput(line({ ...p, files: [{ path: "x", size: 1, data: "AA==", extra: 1 }] })), "file extra key");
    mustFail(parseAcquireOutput(line({ ...p, files: [{ path: "x", size: 1e9, data: "AA==" }] })), "file size");
    mustFail(parseAcquireOutput(line({ ...p, files: new Array(MAX_EXPORT_FILES + 1).fill({ path: "x", size: 0, data: "" }) })), "too many files");
  });
});
