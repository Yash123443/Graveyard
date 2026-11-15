/**
 * npm-lock-policy.test.ts — pure tests for the preliminary npm fixture policy. No process, no
 * Docker, no network, no filesystem. A pass shows only that this module classifies these inputs as
 * intended; it is not a security proof and says nothing about what npm itself would do.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LOCKFILE_BYTES,
  MAX_LOCK_PACKAGES,
  MAX_PACKAGE_JSON_BYTES,
  checkNpmFixture,
} from "../npm-lock-policy.js";

const INTEG = `sha512-${"A".repeat(86)}==`;
const url = (name: string, version: string): string => {
  const base = name.includes("/") ? (name.split("/")[1] as string) : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
};
const entry = (name: string, version = "1.0.0"): Record<string, unknown> => ({
  version, resolved: url(name, version), integrity: INTEG,
});

type Json = Record<string, unknown>;
const pkgJson = (extra: Json = {}): string =>
  JSON.stringify({ name: "fx", version: "1.0.0", private: true, dependencies: { "left-pad": "^1.3.0" }, ...extra });

function lock(packages: Json, extra: Json = {}): string {
  return JSON.stringify({
    name: "fx", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "fx", version: "1.0.0", dependencies: { "left-pad": "^1.3.0" } }, ...packages },
    ...extra,
  });
}
const goodLock = (): string => lock({ "node_modules/left-pad": entry("left-pad", "1.3.0") });

function violations(p: unknown, l: unknown): string[] {
  const r = checkNpmFixture(p, l);
  assert.equal(r.ok, false, "expected the policy to reject this input");
  return r.ok ? [] : r.violations;
}
const joined = (v: string[]): string => v.join("\n");

describe("accepted inputs", () => {
  it("accepts a plain v3 lock with one registry package and reports the package count", () => {
    const r = checkNpmFixture(pkgJson(), goodLock());
    assert.deepEqual(r, { ok: true, packageCount: 1, rootDependencyCount: 1 });
  });

  it("accepts scoped and nested packages", () => {
    const l = lock({
      "node_modules/@scope/pkg": entry("@scope/pkg", "2.1.0-beta.1"),
      "node_modules/left-pad": entry("left-pad", "1.3.0"),
      "node_modules/left-pad/node_modules/inner": { ...entry("inner", "0.0.1"), dev: true },
    });
    const r = checkNpmFixture(pkgJson(), l);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.packageCount, 3);
  });

  it("accepts a v2 lock whose legacy dependencies tree follows the same rules", () => {
    const l = lock(
      { "node_modules/left-pad": entry("left-pad", "1.3.0") },
      { lockfileVersion: 2, dependencies: { "left-pad": entry("left-pad", "1.3.0") } },
    );
    assert.equal(checkNpmFixture(pkgJson(), l).ok, true);
  });

  it("accepts ordinary scripts that are not install-time", () => {
    assert.equal(checkNpmFixture(pkgJson({ scripts: { test: "node --test", build: "node build.mjs" } }), goodLock()).ok, true);
  });
});

describe("package.json rejections", () => {
  const cases: Array<[string, Json, RegExp]> = [
    ["workspaces", { workspaces: ["packages/*"] }, /workspaces/],
    ["overrides", { overrides: { "left-pad": "1.0.0" } }, /overrides/],
    ["resolutions", { resolutions: { "left-pad": "1.0.0" } }, /resolutions/],
    ["packageManager", { packageManager: "pnpm@10.12.1" }, /packageManager/],
    ["pnpm block", { pnpm: { overrides: {} } }, /pnpm/],
    ["bundled dependencies", { bundledDependencies: ["left-pad"] }, /bundledDependencies/],
    ["preinstall", { scripts: { preinstall: "node x.js" } }, /preinstall/],
    ["install", { scripts: { install: "node x.js" } }, /install-time script install/],
    ["postinstall", { scripts: { postinstall: "node x.js" } }, /postinstall/],
    ["prepare", { scripts: { prepare: "node x.js" } }, /prepare/],
    ["git spec", { dependencies: { "left-pad": "github:a/b" } }, /left-pad/],
    ["git+https spec", { dependencies: { "left-pad": "git+https://github.com/a/b.git" } }, /left-pad/],
    ["http spec", { dependencies: { "left-pad": "http://example.com/x.tgz" } }, /left-pad/],
    ["https tarball spec", { dependencies: { "left-pad": "https://example.com/x.tgz" } }, /left-pad/],
    ["file spec", { dependencies: { "left-pad": "file:../x" } }, /left-pad/],
    ["link spec", { dependencies: { "left-pad": "link:../x" } }, /left-pad/],
    ["alias spec", { dependencies: { "left-pad": "npm:other@1.0.0" } }, /left-pad/],
    ["tag spec", { dependencies: { "left-pad": "latest" } }, /left-pad/],
    ["path spec", { dependencies: { "left-pad": "../x" } }, /left-pad/],
    ["non-string spec", { dependencies: { "left-pad": 1 } }, /left-pad/],
    ["uppercase or traversal name", { devDependencies: { "../x": "1.0.0" } }, /invalid package name/],
    ["scripts not an object", { scripts: "node x" }, /scripts/],
  ];
  for (const [label, extra, re] of cases) {
    it(`rejects ${label}`, () => {
      const v = violations(pkgJson(extra), goodLock());
      assert.match(joined(v), re);
    });
  }

  it("rejects malformed, oversized, empty and non-object package.json", () => {
    assert.match(joined(violations("{", goodLock())), /package.json: not valid JSON/);
    assert.match(joined(violations("[]", goodLock())), /not an object/);
    assert.match(joined(violations("", goodLock())), /empty or larger/);
    assert.match(joined(violations(`{"pad":"${"x".repeat(MAX_PACKAGE_JSON_BYTES)}"}`, goodLock())), /larger than/);
    assert.match(joined(violations(undefined, goodLock())), /not text/);
  });
});

describe("package-lock.json rejections", () => {
  const bad = (e: Json, key = "node_modules/left-pad"): string => lock({ [key]: e });
  const cases: Array<[string, string, RegExp]> = [
    ["git resolved", bad({ ...entry("left-pad", "1.3.0"), resolved: "git+ssh://git@github.com/a/b.git#abc" }), /resolved/],
    ["http resolved", bad({ ...entry("left-pad", "1.3.0"), resolved: "http://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz" }), /resolved/],
    ["file resolved", bad({ ...entry("left-pad", "1.3.0"), resolved: "file:../left-pad" }), /resolved/],
    ["other registry", bad({ ...entry("left-pad", "1.3.0"), resolved: "https://evil.example/left-pad/-/left-pad-1.3.0.tgz" }), /resolved/],
    ["registry lookalike host", bad({ ...entry("left-pad", "1.3.0"), resolved: "https://registry.npmjs.org.evil.example/left-pad/-/left-pad-1.3.0.tgz" }), /resolved/],
    ["credentials in resolved", bad({ ...entry("left-pad", "1.3.0"), resolved: "https://u:p@registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz" }), /resolved/],
    ["query in resolved", bad({ ...entry("left-pad", "1.3.0"), resolved: `${url("left-pad", "1.3.0")}?x=1` }), /resolved/],
    ["resolved for another version", bad({ ...entry("left-pad", "1.3.0"), resolved: url("left-pad", "9.9.9") }), /resolved/],
    ["resolved for another package", bad({ ...entry("left-pad", "1.3.0"), resolved: url("right-pad", "1.3.0") }), /resolved/],
    ["missing resolved", bad({ version: "1.3.0", integrity: INTEG }), /resolved/],
    ["missing integrity", bad({ version: "1.3.0", resolved: url("left-pad", "1.3.0") }), /integrity/],
    ["sha1 integrity", bad({ ...entry("left-pad", "1.3.0"), integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }), /integrity/],
    ["sha256 integrity", bad({ ...entry("left-pad", "1.3.0"), integrity: `sha256-${"A".repeat(43)}=` }), /integrity/],
    ["two integrity values", bad({ ...entry("left-pad", "1.3.0"), integrity: `${INTEG} ${INTEG}` }), /integrity/],
    ["short sha512", bad({ ...entry("left-pad", "1.3.0"), integrity: `sha512-${"A".repeat(20)}==` }), /integrity/],
    ["link", bad({ ...entry("left-pad", "1.3.0"), link: true }), /link/],
    ["inBundle", bad({ ...entry("left-pad", "1.3.0"), inBundle: true }), /inBundle/],
    ["hasInstallScript", bad({ ...entry("left-pad", "1.3.0"), hasInstallScript: true }), /hasInstallScript/],
    ["alias name", bad({ ...entry("left-pad", "1.3.0"), name: "other" }), /field name/],
    ["os filter", bad({ ...entry("left-pad", "1.3.0"), os: ["linux"] }), /field os/],
    ["cpu filter", bad({ ...entry("left-pad", "1.3.0"), cpu: ["x64"] }), /field cpu/],
    ["non-semver version", bad({ ...entry("left-pad", "1.3.0"), version: "github:a/b" }), /version/],
    ["missing version", bad({ resolved: url("left-pad", "1.3.0"), integrity: INTEG }), /version/],
    ["non-boolean flag", bad({ ...entry("left-pad", "1.3.0"), dev: "yes" }), /dev is not a boolean/],
    ["git spec inside an entry", bad({ ...entry("left-pad", "1.3.0"), dependencies: { x: "github:a/b" } }), /dependencies/],
    ["workspace key", bad(entry("a", "1.0.0"), "packages/a"), /not a plain node_modules path/],
    ["traversal key", bad(entry("a", "1.0.0"), "node_modules/../../etc"), /not a plain node_modules path/],
    ["backslash key", bad(entry("a", "1.0.0"), "node_modules\\a"), /not a plain node_modules path/],
    ["absolute key", bad(entry("a", "1.0.0"), "/node_modules/a"), /not a plain node_modules path/],
    ["entry not an object", lock({ "node_modules/left-pad": "1.3.0" }), /not an object/],
    ["lockfileVersion 1", lock({ "node_modules/left-pad": entry("left-pad", "1.3.0") }, { lockfileVersion: 1 }), /lockfileVersion/],
    ["lockfileVersion 4", lock({ "node_modules/left-pad": entry("left-pad", "1.3.0") }, { lockfileVersion: 4 }), /lockfileVersion/],
    ["lockfileVersion as string", lock({ "node_modules/left-pad": entry("left-pad", "1.3.0") }, { lockfileVersion: "3" }), /lockfileVersion/],
    ["v3 with a legacy tree", lock({ "node_modules/left-pad": entry("left-pad", "1.3.0") }, { dependencies: {} }), /legacy/],
    ["no packages", lock({}), /no installable packages/],
    ["workspaces in the root entry", JSON.stringify({ lockfileVersion: 3, packages: { "": { workspaces: ["a"] }, "node_modules/left-pad": entry("left-pad", "1.3.0") } }), /workspaces/],
    ["missing root entry", JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/left-pad": entry("left-pad", "1.3.0") } }), /root entry/],
    ["missing packages map", JSON.stringify({ lockfileVersion: 3 }), /packages map/],
  ];
  for (const [label, text, re] of cases) {
    it(`rejects ${label}`, () => {
      assert.match(joined(violations(pkgJson(), text)), re);
    });
  }

  it("rejects a legacy v2 tree entry with a git resolution or missing integrity", () => {
    const base = { "node_modules/left-pad": entry("left-pad", "1.3.0") };
    const gitTree = lock(base, { lockfileVersion: 2, dependencies: { "left-pad": { version: "1.3.0", resolved: "git+https://github.com/a/b.git" } } });
    assert.match(joined(violations(pkgJson(), gitTree)), /dependencies left-pad/);
    const nested = lock(base, {
      lockfileVersion: 2,
      dependencies: { "left-pad": { ...entry("left-pad", "1.3.0"), dependencies: { inner: { version: "file:../x" } } } },
    });
    assert.match(joined(violations(pkgJson(), nested)), /dependencies inner/);
  });

  it("rejects malformed, oversized and non-object lock text", () => {
    assert.match(joined(violations(pkgJson(), "{")), /package-lock.json: not valid JSON/);
    assert.match(joined(violations(pkgJson(), "null")), /not an object/);
    assert.match(joined(violations(pkgJson(), "")), /empty or larger/);
    assert.match(joined(violations(pkgJson(), `{"x":"${"y".repeat(MAX_LOCKFILE_BYTES)}"}`)), /larger than/);
    assert.match(joined(violations(pkgJson(), 42)), /not text/);
  });

  it("rejects more packages than the limit", () => {
    const many: Json = {};
    for (let i = 0; i <= MAX_LOCK_PACKAGES; i += 1) many[`node_modules/p${i}`] = entry(`p${i}`);
    assert.match(joined(violations(pkgJson(), lock(many))), /more than 200 packages/);
  });

  it("bounds the violation list and keeps messages printable ASCII", () => {
    const many: Json = {};
    for (let i = 0; i < 100; i += 1) many[`bad\u0007\u00e9${i}`] = entry("x");
    const v = violations(pkgJson(), lock(many));
    assert.ok(v.length <= 20);
    for (const m of v) assert.ok(!/[^\x20-\x7e]/.test(m), `non-printable character in: ${m}`);
  });

  it("does not treat __proto__ keys specially", () => {
    const text = '{"lockfileVersion":3,"packages":{"":{},"__proto__":{"version":"1.0.0"}}}';
    assert.match(joined(violations(pkgJson(), text)), /not a plain node_modules path/);
  });
});
