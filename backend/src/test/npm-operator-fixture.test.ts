/**
 * npm-operator-fixture.test.ts — adversarial tests for the operator multi-package lockfile v3 gate.
 * Pure: no Docker, no npm, no network, no filesystem. Fixtures are SYNTHETIC (see
 * operator-fixture-helpers.ts). They show that the gate refuses what it is written to refuse and
 * accepts one well-formed shape. They do NOT show that real npm or the registry accept such files.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIXED_LOCKFILE, FIXED_PACKAGE_JSON } from "../npm-registry-acquisition.js";
import {
  MAX_OPERATOR_DEPS_PER_MAP,
  MAX_OPERATOR_LOCK_BYTES,
  MAX_OPERATOR_PACKAGES,
  checkOperatorFixture,
} from "../npm-operator-fixture.js";
import {
  EXPECTED_DEFAULT,
  integrityOf,
  lockEntry,
  operatorDoc,
  textsOf,
  withExtraRootPackages,
  type Json,
  type OperatorDoc,
} from "./operator-fixture-helpers.js";

function check(d: OperatorDoc): ReturnType<typeof checkOperatorFixture> {
  const t = textsOf(d);
  return checkOperatorFixture(t.packageJson, t.packageLock);
}

function rejected(d: OperatorDoc, label: string): void {
  const r = check(d);
  assert.equal(r.ok, false, label);
  if (!r.ok) {
    assert.ok(r.violations.length >= 1 && r.violations.length <= 20, label);
    for (const v of r.violations) assert.match(v, /^[\x20-\x7e…]*$/u, `${label}: violation is printable ASCII`);
  }
}

const pk = (d: OperatorDoc): Json => d.lock["packages"];

describe("checkOperatorFixture: acceptance", () => {
  it("accepts a three-package chain and returns the exact texts, sorted expectations and hashes", () => {
    const d = operatorDoc();
    const t = textsOf(d);
    const r = checkOperatorFixture(t.packageJson, t.packageLock);
    assert.ok(r.ok);
    assert.equal(r.packageJson, t.packageJson);
    assert.equal(r.lock, t.packageLock);
    assert.equal(r.packageCount, 3);
    assert.equal(r.rootDependencyCount, 1);
    assert.deepEqual(r.packages, EXPECTED_DEFAULT);
    assert.match(r.packageJsonSha256, /^[0-9a-f]{64}$/);
    assert.match(r.lockSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(r.packageJsonSha256, r.lockSha256);
  });

  it("accepts the fixed is-number fixture as a one-package operator fixture", () => {
    const r = checkOperatorFixture(FIXED_PACKAGE_JSON, FIXED_LOCKFILE);
    assert.ok(r.ok);
    assert.equal(r.packageCount, 1);
    assert.equal(r.packages[0]?.name, "is-number");
  });

  it("accepts exactly the maximum package count and the usual optional metadata fields", () => {
    const d = withExtraRootPackages(operatorDoc(), MAX_OPERATOR_PACKAGES - 3);
    const e = pk(d)["node_modules/gamma"] as Json;
    Object.assign(e, { license: "MIT", engines: { node: ">=10" }, bin: { g: "bin/g.js" }, funding: { url: "https://example.org/fund" }, deprecated: "old" });
    pk(d)["node_modules/alpha"]["bin"] = "cli.js";
    const r = check(d);
    assert.ok(r.ok);
    assert.equal(r.packageCount, MAX_OPERATOR_PACKAGES);
  });

  it("handles package names that collide with Object.prototype members without confusion", () => {
    const d = operatorDoc();
    d.pkg["dependencies"] = { constructor: "^1.0.0" };
    pk(d)[""]["dependencies"] = { constructor: "^1.0.0" };
    delete pk(d)["node_modules/alpha"];
    delete pk(d)["node_modules/beta"];
    delete pk(d)["node_modules/gamma"];
    pk(d)["node_modules/constructor"] = lockEntry("constructor", "1.0.0", { dependencies: { tostring: "^1.0.0" } });
    pk(d)["node_modules/tostring"] = lockEntry("tostring", "1.0.0");
    const r = check(d);
    assert.ok(r.ok);
    assert.deepEqual(r.packages.map((p) => p.name), ["constructor", "tostring"]);
  });
});

describe("checkOperatorFixture: bounds", () => {
  it("rejects more than the maximum package count", () => {
    rejected(withExtraRootPackages(operatorDoc(), MAX_OPERATOR_PACKAGES - 2), "9 packages");
    rejected(withExtraRootPackages(operatorDoc(), 40), "43 packages");
  });

  it("rejects a lockfile above the driver's input cap even though the base policy allows 512 KiB", () => {
    const d = operatorDoc();
    pk(d)["node_modules/gamma"]["license"] = "x".repeat(MAX_OPERATOR_LOCK_BYTES);
    rejected(d, "oversized lock");
  });

  it("rejects an oversized package.json", () => {
    const d = operatorDoc();
    d.pkg["description"] = "x".repeat(9000);
    rejected(d, "oversized package.json");
  });

  it("rejects too many dependencies in one map", () => {
    const d = operatorDoc();
    const many: Json = {};
    for (let i = 0; i <= MAX_OPERATOR_DEPS_PER_MAP; i += 1) many[`dep-${i}`] = "^1.0.0";
    pk(d)["node_modules/gamma"]["dependencies"] = many;
    rejected(d, "entry dependency map");
    const e = operatorDoc();
    e.pkg["dependencies"] = many;
    pk(e)[""]["dependencies"] = many;
    rejected(e, "root dependency map");
  });

  it("rejects an empty package list and a missing root", () => {
    const d = operatorDoc();
    d.lock["packages"] = { "": pk(d)[""] };
    d.pkg["dependencies"] = {};
    pk(d)[""]["dependencies"] = {};
    rejected(d, "no packages");
    const e = operatorDoc();
    delete pk(e)[""];
    rejected(e, "no root entry");
  });

  it("rejects inputs that are not two JSON object texts", () => {
    const t = textsOf(operatorDoc());
    for (const [p, l] of [
      [undefined, undefined], [null, t.packageLock], [t.packageJson, 5], [{}, {}], ["", ""], ["{", "}"], ["[]", "[]"], ["null", "null"],
      [`\uFEFF${t.packageJson}`, t.packageLock], [t.packageJson, `\uFEFF${t.packageLock}`],
    ] as const) {
      const r = checkOperatorFixture(p, l);
      assert.equal(r.ok, false, JSON.stringify([p, l]).slice(0, 40));
    }
  });
});

describe("checkOperatorFixture: lockfile shape", () => {
  it("requires lockfileVersion exactly 3 and no legacy tree", () => {
    for (const v of [1, 2, "3", 4, null]) {
      const d = operatorDoc();
      d.lock["lockfileVersion"] = v;
      rejected(d, `lockfileVersion ${String(v)}`);
    }
    const d = operatorDoc();
    d.lock["dependencies"] = {};
    rejected(d, "legacy tree");
  });

  it("rejects unknown top-level, root and entry fields", () => {
    const a = operatorDoc();
    a.lock["extra"] = 1;
    rejected(a, "top-level");
    const b = operatorDoc();
    pk(b)[""]["scripts"] = {};
    rejected(b, "root entry");
    for (const f of ["scripts", "bundleDependencies", "peerDependenciesMeta", "optionalDependencies", "cpu", "os", "libc", "name", "link", "inBundle", "hasInstallScript", "bundled", "extraneous"]) {
      const d = operatorDoc();
      pk(d)["node_modules/gamma"][f] = f === "link" || f === "inBundle" || f === "hasInstallScript" || f === "bundled" ? true : f === "name" ? "other" : {};
      rejected(d, `entry field ${f}`);
    }
  });

  it("rejects dev, devOptional, optional and peer entries, which NODE_ENV=production would not install", () => {
    for (const f of ["dev", "devOptional", "optional", "peer"]) {
      const d = operatorDoc();
      pk(d)["node_modules/gamma"][f] = true;
      rejected(d, f);
    }
    for (const f of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
      const d = operatorDoc();
      d.pkg[f] = { gamma: "^0.3.0" };
      rejected(d, `package.json ${f}`);
      const e = operatorDoc();
      pk(e)[""][f] = { gamma: "^0.3.0" };
      rejected(e, `lock root ${f}`);
    }
  });

  it("rejects nested, scoped, traversal, workspace and alias keys", () => {
    const keys = [
      "node_modules/alpha/node_modules/beta",
      "node_modules/@scope/pkg",
      "node_modules/../x",
      "node_modules/./x",
      "node_modules/",
      "node_modules/UPPER",
      "node_modules/_hidden",
      "node_modules/__proto__",
      "packages/workspace-a",
      "../outside",
      "/abs/path",
      "node_modules\\alpha2",
      "node_modules/a b",
      "node_modules/gamma2\u0007",
      "alpha2",
    ];
    for (const k of keys) {
      const d = operatorDoc();
      pk(d)[k] = lockEntry("alpha2", "1.0.0");
      rejected(d, JSON.stringify(k));
    }
  });

  it("rejects non-plain versions: prerelease, build metadata, ranges and leading zeros", () => {
    for (const v of ["1.0.0-beta.1", "1.0.0+build.5", "^1.0.0", "01.0.0", "1.0", "1.0.0.0", "latest", ""]) {
      const d = operatorDoc();
      pk(d)["node_modules/gamma"] = lockEntry("gamma", v);
      rejected(d, JSON.stringify(v));
    }
  });

  it("rejects any resolved URL other than the exact registry.npmjs.org tarball URL", () => {
    const bad = [
      "https://evil.example/gamma/-/gamma-0.3.4.tgz",
      "http://registry.npmjs.org/gamma/-/gamma-0.3.4.tgz",
      "https://registry.npmjs.org.evil.example/gamma/-/gamma-0.3.4.tgz",
      "https://registry.npmjs.org@evil.example/gamma/-/gamma-0.3.4.tgz",
      "https://user:pw@registry.npmjs.org/gamma/-/gamma-0.3.4.tgz",
      "https://registry.npmjs.org:444/gamma/-/gamma-0.3.4.tgz",
      "https://registry.npmjs.org/gamma/-/gamma-0.3.4.tgz?x=1",
      "https://registry.npmjs.org/gamma/-/gamma-0.3.4.tgz#sha1=abc",
      "https://registry.npmjs.org/other/-/gamma-0.3.4.tgz",
      "https://registry.npmjs.org/gamma/-/gamma-0.3.5.tgz",
      "git+https://github.com/u/gamma.git#abc",
      "git+ssh://git@github.com/u/gamma.git",
      "github:u/gamma",
      "file:../gamma",
      "file:///etc/passwd",
      "https://github.com/u/gamma/archive/main.tar.gz",
      "",
    ];
    for (const r of bad) {
      const d = operatorDoc();
      pk(d)["node_modules/gamma"]["resolved"] = r;
      rejected(d, r);
    }
    const missing = operatorDoc();
    delete pk(missing)["node_modules/gamma"]["resolved"];
    rejected(missing, "missing resolved");
  });

  it("rejects anything but a single canonical sha512 integrity", () => {
    const good = integrityOf("x");
    const bad = [
      undefined, "", "sha1-abc", `sha1-${"A".repeat(27)}=`, `sha256-${"A".repeat(43)}=`, `${good} ${good}`, `${good} sha1-abc`, `${good}\n`,
      good.replace("sha512-", "SHA512-"), `sha512-${"A".repeat(86)}`, `sha512-${"A".repeat(88)}`, `sha512-${"!".repeat(86)}==`, 5, null, ["x"],
    ];
    for (const i of bad) {
      const d = operatorDoc();
      if (i === undefined) delete pk(d)["node_modules/gamma"]["integrity"];
      else pk(d)["node_modules/gamma"]["integrity"] = i;
      rejected(d, JSON.stringify(i));
    }
  });

  it("rejects a shared integrity value, so one tarball cannot stand in for two packages", () => {
    const d = operatorDoc();
    pk(d)["node_modules/gamma"]["integrity"] = pk(d)["node_modules/alpha"]["integrity"];
    rejected(d, "shared integrity");
  });

  it("rejects unreachable entries and dependencies without an entry", () => {
    const orphan = operatorDoc();
    pk(orphan)["node_modules/orphan"] = lockEntry("orphan", "1.0.0");
    rejected(orphan, "orphan");
    const dangling = operatorDoc();
    pk(dangling)["node_modules/gamma"]["dependencies"] = { missing: "^1.0.0" };
    rejected(dangling, "dangling");
    const cutRoot = operatorDoc();
    delete pk(cutRoot)["node_modules/gamma"];
    rejected(cutRoot, "beta needs gamma");
  });

  it("accepts a dependency cycle between listed packages (reachability is a set, not a tree)", () => {
    const d = operatorDoc();
    pk(d)["node_modules/gamma"]["dependencies"] = { alpha: "^1.0.0" };
    assert.ok(check(d).ok);
  });

  it("rejects wrongly typed metadata", () => {
    const cases: Array<[string, unknown]> = [["license", 5], ["engines", "node"], ["bin", 7], ["deprecated", true], ["dependencies", ["x"]]];
    for (const [f, v] of cases) {
      const d = operatorDoc();
      pk(d)["node_modules/gamma"][f] = v;
      rejected(d, f);
    }
  });
});

describe("checkOperatorFixture: package.json", () => {
  it("rejects any scripts at all, including harmless-looking ones and an empty object", () => {
    for (const s of [{ postinstall: "node x.js" }, { preinstall: "x" }, { install: "x" }, { prepare: "x" }, { test: "echo ok" }, {}]) {
      const d = operatorDoc();
      d.pkg["scripts"] = s;
      rejected(d, JSON.stringify(s));
    }
  });

  it("rejects fields that change how npm resolves or installs", () => {
    const fields: Array<[string, unknown]> = [
      ["workspaces", ["packages/*"]], ["overrides", { gamma: "1.0.0" }], ["resolutions", { gamma: "1.0.0" }], ["packageManager", "yarn@4"],
      ["pnpm", {}], ["bundledDependencies", ["alpha"]], ["bundleDependencies", ["alpha"]], ["devEngines", {}], ["config", {}], ["main", "x.js"],
      ["bin", "x"], ["publishConfig", { registry: "https://evil.example" }], ["repository", "github:u/r"], ["os", ["linux"]], ["engines", { node: "1" }],
    ];
    for (const [f, v] of fields) {
      const d = operatorDoc();
      d.pkg[f] = v;
      rejected(d, f);
    }
  });

  it("requires private: true", () => {
    for (const v of [false, "true", 1, undefined]) {
      const d = operatorDoc();
      if (v === undefined) delete d.pkg["private"];
      else d.pkg["private"] = v;
      rejected(d, String(v));
    }
  });

  it("rejects git, url, file, link, alias, tag and scoped dependency specs", () => {
    const specs = [
      "git+https://github.com/u/r.git", "github:u/r", "u/r", "file:../x", "link:../x", "npm:other@1.0.0", "latest", "http://example.com/x.tgz",
      "https://registry.npmjs.org/x/-/x-1.0.0.tgz", "workspace:*", "",
    ];
    for (const s of specs) {
      const d = operatorDoc();
      d.pkg["dependencies"]["alpha"] = s;
      pk(d)[""]["dependencies"]["alpha"] = s;
      rejected(d, s);
      const e = operatorDoc();
      pk(e)["node_modules/alpha"]["dependencies"]["beta"] = s;
      rejected(e, `entry ${s}`);
    }
    const scoped = operatorDoc();
    scoped.pkg["dependencies"] = { "@scope/pkg": "^1.0.0" };
    pk(scoped)[""]["dependencies"] = { "@scope/pkg": "^1.0.0" };
    rejected(scoped, "scoped dependency");
  });

  it("rejects bad names and versions, and lock/package.json disagreement", () => {
    for (const n of ["", "Upper", "@s/x", "a b", "x".repeat(65), "../x"]) {
      const d = operatorDoc();
      d.pkg["name"] = n;
      d.lock["name"] = n;
      pk(d)[""]["name"] = n;
      rejected(d, JSON.stringify(n));
    }
    const v = operatorDoc();
    v.pkg["version"] = "1.0.0-rc.1";
    v.lock["version"] = "1.0.0-rc.1";
    pk(v)[""]["version"] = "1.0.0-rc.1";
    rejected(v, "prerelease root");
    const a = operatorDoc();
    a.lock["name"] = "other";
    rejected(a, "lock name");
    const b = operatorDoc();
    pk(b)[""]["version"] = "9.9.9";
    rejected(b, "root version");
    const c = operatorDoc();
    pk(c)[""]["dependencies"] = { alpha: "^2.0.0" };
    rejected(c, "root deps differ in spec");
    const e = operatorDoc();
    pk(e)[""]["dependencies"] = { alpha: "^1.0.0", gamma: "^0.3.0" };
    rejected(e, "root deps differ in keys");
  });
});

describe("checkOperatorFixture: hostile text", () => {
  it("never echoes control characters from keys or names", () => {
    const d = operatorDoc();
    pk(d)["node_modules/\u001b[31mred\u0000"] = lockEntry("x", "1.0.0");
    pk(d)["node_modules/gamma"]["dependencies"] = { "\u0007bell": "^1.0.0" };
    const r = check(d);
    assert.equal(r.ok, false);
    if (!r.ok) for (const v of r.violations) assert.match(v, /^[\x20-\x7e…]*$/u);
  });

  it("caps the number of reported violations", () => {
    const d = operatorDoc();
    for (let i = 0; i < 30; i += 1) pk(d)[`bad/${i}`] = lockEntry("a", "1.0.0");
    const r = check(d);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.violations.length <= 20);
  });

  it("rejects __proto__ and constructor-style keys written as raw JSON", () => {
    const d = operatorDoc();
    const t = textsOf(d);
    const rawLock = t.packageLock.replace('"packages": {', '"packages": {\n    "__proto__": {"polluted": true},');
    assert.equal(checkOperatorFixture(t.packageJson, rawLock).ok, false);
    const rawPkg = t.packageJson.replace('"dependencies": {', '"dependencies": {\n    "__proto__": "^1.0.0",');
    assert.equal(checkOperatorFixture(rawPkg, t.packageLock).ok, false);
    assert.equal(({} as Json)["polluted"], undefined);
  });

  it("with duplicate JSON keys the last value wins everywhere, and a bad last value is still rejected", () => {
    const d = operatorDoc();
    const t = textsOf(d);
    const dup = t.packageLock.replace('"lockfileVersion": 3,', '"lockfileVersion": 3,\n  "lockfileVersion": 2,');
    assert.notEqual(dup, t.packageLock);
    assert.equal(checkOperatorFixture(t.packageJson, dup).ok, false);
  });
});
