/**
 * npm-operator-fixture.ts — STRICT static acceptance of an OPERATOR-SUPPLIED multi-package npm
 * fixture (package.json + package-lock.json, lockfileVersion 3) for the controlled registry
 * acquisition. Pure: no I/O, no process, no network. Written by Kiro without running anything:
 * UNVERIFIED until an operator runs the tests and the opt-in harness.
 *
 * This is a second gate ON TOP of `checkNpmFixture` (npm-lock-policy.ts), which is applied first and
 * unchanged: registry.npmjs.org tarball URLs only, one canonical sha512 integrity per entry, no
 * git/http/file/link/alias specs, no install-script flags, no workspaces/overrides. The operator
 * gate then narrows what the acquisition pipeline can actually verify and reproduce:
 *
 *  - Bounds: package.json <= 8 KiB, lockfile <= 64 KiB (the driver's own input cap), at most
 *    MAX_OPERATOR_PACKAGES (8, the cache verifier's cap) packages, at most 16 dependencies per map.
 *    Sizes of the tarballs are not known from a lockfile; the driver's export bounds (64 files,
 *    64 KiB per file, 128 KiB in total) apply and an oversized cache fails closed at export.
 *  - lockfileVersion exactly 3, no legacy `dependencies` tree, only known top-level keys.
 *  - Flat layout only: every key is `node_modules/<name>` with an UNSCOPED lowercase name, so each
 *    name appears once. Scoped, nested and alias paths are rejected (the cache verifier supports
 *    unscoped names and plain x.y.z versions only; it would reject them later, this rejects them
 *    before anything is contacted).
 *  - Plain x.y.z versions (no prerelease or build metadata), unique integrity values.
 *  - Only production dependencies BY DEFAULT. `devDependencies`, `optionalDependencies`, `peerDependencies`
 *    and the lock flags dev, devOptional, optional and peer are rejected: the acquisition driver
 *    runs npm with NODE_ENV=production, so such entries would not be installed and the expected
 *    package count would be unknowable. With the explicit option `allowDevDependencies` (off by
 *    default, shared with checkNpmFixture, planNpmScripts, the acquisition request and the npm-scripts
 *    pipeline) flat unscoped `devDependencies` are accepted: the lock root must list the same
 *    devDependencies, every entry must be reachable from either map, and `dev: true` must be set on
 *    exactly the entries reachable only through devDependencies. optional, peer and devOptional stay
 *    rejected. The package, file and size bounds do not change.
 *  - package.json is an allowlist (name, version, private: true, description, license,
 *    dependencies); it therefore has no scripts at all. The lock root must agree with it.
 *  - Every `dependencies` entry of a lock entry names another entry, and every entry is reachable
 *    from the root dependencies, so `packageCount` is exactly what `npm ci` is expected to add.
 *
 * Not covered: whether a version satisfies the range that requires it (npm ci checks that and a
 * mismatch fails the install), whether an integrity value is the one the registry serves (npm and
 * the host's tarball binding check that), duplicate JSON keys (JSON.parse, npm and this module all
 * keep the last value, so they agree), and what the packages contain.
 *
 * @module npm-operator-fixture
 */

import { createHash } from "node:crypto";
import { MAX_INPUT_FILE_BYTES } from "./npm-acquire-driver.js";
import { checkNpmFixture, type NpmDependencyPolicy } from "./npm-lock-policy.js";
import type { ExpectedTarball } from "./npm-registry-cache.js";

export const MAX_OPERATOR_PACKAGES = 8;
export const MAX_OPERATOR_PACKAGE_JSON_BYTES = 8 * 1024;
/** The driver refuses input files larger than this, so a larger lockfile could never be staged. */
export const MAX_OPERATOR_LOCK_BYTES = MAX_INPUT_FILE_BYTES;
export const MAX_OPERATOR_DEPS_PER_MAP = 16;
const MAX_VIOLATIONS = 20;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KEY_RE = /^node_modules\/([a-z0-9][a-z0-9._-]{0,63})$/;
const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

const PACKAGE_JSON_KEYS: readonly string[] = ["name", "version", "private", "description", "license", "dependencies"];
const LOCK_KEYS: readonly string[] = ["name", "version", "lockfileVersion", "requires", "packages"];
const ROOT_ENTRY_KEYS: readonly string[] = ["name", "version", "dependencies", "license"];
const ENTRY_KEYS: readonly string[] = [
  "version", "resolved", "integrity", "dependencies", "license", "engines", "bin", "funding", "deprecated",
];

export type OperatorFixtureResult =
  | {
      ok: true;
      /** The exact accepted texts. These, and only these, may be staged. */
      packageJson: string;
      lock: string;
      /** One entry per lock package, sorted by name. Passed to the cache verifier as the expectation. */
      packages: ExpectedTarball[];
      packageCount: number;
      rootDependencyCount: number;
      /** Present only when `allowDevDependencies` was set: packages that are installed only for development. */
      devPackageCount?: number;
      packageJsonSha256: string;
      lockSha256: string;
    }
  | { ok: false; violations: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** Printable ASCII only and bounded, so a message cannot carry control characters from the input. */
const safe = (s: string): string => {
  const t = s.replace(/[^\x20-\x7e]/g, "?");
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
};
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export interface OperatorFixtureOptions extends NpmDependencyPolicy {
  /**
   * Accept an `engines` object on the lock ROOT entry (npm writes it when the repository's package.json
   * declares engines). Off by default, so every legacy caller is unchanged. Only the shape is checked
   * here; the npm-scripts planner additionally requires it to equal the original package.json's engines.
   */
  allowLockRootEngines?: boolean;
  /**
   * (inherited, default off) Accept flat, unscoped `devDependencies`. The lock must then agree exactly:
   * root `devDependencies` equal package.json's, every entry reachable from `dependencies` or
   * `devDependencies`, and `dev: true` set on exactly the entries reachable ONLY through
   * `devDependencies`. Same bounds as production packages (MAX_OPERATOR_PACKAGES in total, no scoped,
   * nested, optional, peer or platform-filtered entries, every entry bound to one sha512 integrity).
   */
}

export function checkOperatorFixture(packageJsonText: unknown, lockText: unknown, options: OperatorFixtureOptions = {}): OperatorFixtureResult {
  const dev = options.allowDevDependencies === true;
  const violations: string[] = [];
  const add = (m: string): void => {
    if (violations.length < MAX_VIOLATIONS) violations.push(m);
  };
  const fail = (): OperatorFixtureResult => ({ ok: false, violations });
  const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[], where: string): void => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) add(`${where}: field ${safe(k)} is not allowed`);
  };

  if (typeof packageJsonText !== "string" || typeof lockText !== "string") {
    add("fixture files must be text");
    return fail();
  }
  if (Buffer.byteLength(packageJsonText, "utf8") > MAX_OPERATOR_PACKAGE_JSON_BYTES) {
    add(`package.json is larger than ${MAX_OPERATOR_PACKAGE_JSON_BYTES} bytes`);
  }
  if (Buffer.byteLength(lockText, "utf8") > MAX_OPERATOR_LOCK_BYTES) {
    add(`package-lock.json is larger than ${MAX_OPERATOR_LOCK_BYTES} bytes`);
  }
  if (violations.length > 0) return fail();

  // Gate 1: the existing static policy, unchanged. Everything below assumes it passed.
  const base = checkNpmFixture(packageJsonText, lockText, dev ? { allowDevDependencies: true } : {});
  if (!base.ok) {
    for (const m of base.violations) add(`policy: ${m}`);
    return fail();
  }
  const pkg = JSON.parse(packageJsonText) as unknown;
  const lock = JSON.parse(lockText) as unknown;
  if (!isObj(pkg) || !isObj(lock)) {
    add("fixture files are not JSON objects");
    return fail();
  }

  // Gate 2a: package.json allowlist.
  onlyKeys(pkg, dev ? [...PACKAGE_JSON_KEYS, "devDependencies"] : PACKAGE_JSON_KEYS, "package.json");
  const pname = pkg["name"];
  const pversion = pkg["version"];
  if (typeof pname !== "string" || !NAME_RE.test(pname)) add("package.json: name must be a plain unscoped lowercase name");
  if (typeof pversion !== "string" || !VERSION_RE.test(pversion)) add("package.json: version must be plain x.y.z");
  if (pkg["private"] !== true) add("package.json: private must be true");
  for (const f of ["description", "license"]) {
    const val = pkg[f];
    if (has(pkg, f) && (typeof val !== "string" || val.length > 200)) add(`package.json: ${f} must be a short string`);
  }
  const rootDeps = pkg["dependencies"];
  const rootNames: string[] = [];
  // With dev dependencies enabled `dependencies` becomes optional, but at least one of the two maps must exist.
  if (dev && !has(pkg, "dependencies")) {
    if (!has(pkg, "devDependencies")) add("package.json: dependencies or devDependencies must list at least one package");
  } else if (!isObj(rootDeps) || Object.keys(rootDeps).length === 0) {
    add("package.json: dependencies must list at least one package");
  } else {
    const names = Object.keys(rootDeps);
    if (names.length > MAX_OPERATOR_DEPS_PER_MAP) add(`package.json: more than ${MAX_OPERATOR_DEPS_PER_MAP} dependencies`);
    for (const n of names.slice(0, MAX_OPERATOR_DEPS_PER_MAP)) {
      if (!NAME_RE.test(n)) add(`package.json: dependency ${safe(n)} is not a plain unscoped name`);
      else rootNames.push(n);
    }
  }
  const devDeps = dev ? pkg["devDependencies"] : undefined;
  const devNames: string[] = [];
  if (dev && has(pkg, "devDependencies")) {
    if (!isObj(devDeps) || Object.keys(devDeps).length === 0) {
      add("package.json: devDependencies must list at least one package when present");
    } else {
      const names = Object.keys(devDeps);
      if (names.length > MAX_OPERATOR_DEPS_PER_MAP) add(`package.json: more than ${MAX_OPERATOR_DEPS_PER_MAP} devDependencies`);
      for (const n of names.slice(0, MAX_OPERATOR_DEPS_PER_MAP)) {
        if (!NAME_RE.test(n)) add(`package.json: devDependency ${safe(n)} is not a plain unscoped name`);
        else if (isObj(rootDeps) && has(rootDeps, n)) add(`package.json: ${n} is listed in both dependencies and devDependencies`);
        else devNames.push(n);
      }
    }
  }

  // Gate 2b: lockfile allowlist and agreement with package.json.
  onlyKeys(lock, LOCK_KEYS, "lock");
  if (lock["lockfileVersion"] !== 3) add("lock: lockfileVersion must be exactly 3");
  if (has(lock, "requires") && lock["requires"] !== true) add("lock: requires must be true when present");
  if (has(lock, "name") && lock["name"] !== pname) add("lock: name differs from package.json");
  if (has(lock, "version") && lock["version"] !== pversion) add("lock: version differs from package.json");

  const rawPackages = lock["packages"];
  const packages: Record<string, unknown> = isObj(rawPackages) ? rawPackages : {};
  const keys = Object.keys(packages);
  const installable = keys.filter((k) => k !== "").length;
  if (installable < 1 || installable > MAX_OPERATOR_PACKAGES) {
    add(`lock: must list between 1 and ${MAX_OPERATOR_PACKAGES} packages`);
  }

  const root = packages[""];
  if (!isObj(root)) {
    add("lock: root entry is missing");
  } else {
    const rootKeys = [
      ...ROOT_ENTRY_KEYS,
      ...(options.allowLockRootEngines === true ? ["engines"] : []),
      ...(dev ? ["devDependencies"] : []),
    ];
    onlyKeys(root, rootKeys, "lock root");
    if (has(root, "engines") && !isObj(root["engines"])) add("lock root: engines must be an object");
    if (root["name"] !== pname || root["version"] !== pversion) add("lock root: name or version differs from package.json");
    const sameMap = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
      const ka = Object.keys(a).sort();
      const kb = Object.keys(b).sort();
      return ka.length === kb.length && ka.every((n, i) => n === kb[i] && a[n] === b[n]);
    };
    if (dev) {
      // Each map must be present in both files with identical names and specs, or absent from both.
      for (const f of ["dependencies", "devDependencies"] as const) {
        const pm = pkg[f];
        const lm = root[f];
        if (pm === undefined) {
          if (lm !== undefined) add(`lock root: ${f} differ from package.json`);
        } else if (!isObj(pm) || !isObj(lm) || !sameMap(lm, pm)) {
          add(`lock root: ${f} differ from package.json`);
        }
      }
    } else {
      const rd = root["dependencies"];
      if (!isObj(rd) || !isObj(rootDeps)) {
        add("lock root: dependencies are missing");
      } else {
        const a = Object.keys(rd).sort();
        const b = Object.keys(rootDeps).sort();
        if (a.length !== b.length || a.some((n, i) => n !== b[i] || rd[n] !== rootDeps[n])) {
          add("lock root: dependencies differ from package.json");
        }
      }
    }
  }

  interface Entry {
    version: string;
    integrity: string;
    deps: string[];
    /** The lock's own `dev` flag: true only when it was present (it may only be `true`). */
    dev: boolean;
  }
  const entries = new Map<string, Entry>();
  const integrities = new Set<string>();
  for (const key of keys.slice(0, MAX_OPERATOR_PACKAGES + 1)) {
    if (key === "") continue;
    const m = KEY_RE.exec(key);
    if (m === null) {
      add(`lock: key ${safe(key)} is not a flat node_modules/<unscoped name> path (nested, scoped and alias paths are rejected)`);
      continue;
    }
    const name = m[1] as string;
    const e = packages[key];
    if (!isObj(e)) {
      add(`lock ${name}: entry is not an object`);
      continue;
    }
    onlyKeys(e, dev ? [...ENTRY_KEYS, "dev"] : ENTRY_KEYS, `lock ${name}`);
    if (dev && has(e, "dev") && e["dev"] !== true) add(`lock ${name}: dev must be true when present`);
    const version = e["version"];
    const integrity = e["integrity"];
    if (typeof version !== "string" || !VERSION_RE.test(version)) {
      add(`lock ${name}: version must be plain x.y.z`);
      continue;
    }
    if (typeof integrity !== "string") {
      add(`lock ${name}: integrity is missing`);
      continue;
    }
    if (integrities.has(integrity)) add(`lock ${name}: integrity value is shared with another entry`);
    integrities.add(integrity);
    if (has(e, "license") && typeof e["license"] !== "string") add(`lock ${name}: license must be a string`);
    if (has(e, "deprecated") && typeof e["deprecated"] !== "string") add(`lock ${name}: deprecated must be a string`);
    if (has(e, "engines") && !isObj(e["engines"])) add(`lock ${name}: engines must be an object`);
    if (has(e, "bin") && typeof e["bin"] !== "string" && !isObj(e["bin"])) add(`lock ${name}: bin must be a string or an object`);
    const deps: string[] = [];
    if (has(e, "dependencies")) {
      const d = e["dependencies"];
      if (!isObj(d)) {
        add(`lock ${name}: dependencies must be an object`);
      } else {
        const dn = Object.keys(d);
        if (dn.length > MAX_OPERATOR_DEPS_PER_MAP) add(`lock ${name}: more than ${MAX_OPERATOR_DEPS_PER_MAP} dependencies`);
        for (const n of dn.slice(0, MAX_OPERATOR_DEPS_PER_MAP)) {
          if (!NAME_RE.test(n)) add(`lock ${name}: dependency ${safe(n)} is not a plain unscoped name`);
          else deps.push(n);
        }
      }
    }
    entries.set(name, { version, integrity, deps, dev: e["dev"] === true });
  }

  // Every dependency resolves to an entry, and every entry is reachable from the root.
  const missingReported = new Set<string>();
  const reach = (start: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const queue: string[] = [...start];
    while (queue.length > 0) {
      const n = queue.pop() as string;
      if (seen.has(n)) continue;
      const ent = entries.get(n);
      if (ent === undefined) {
        if (!missingReported.has(n)) add(`lock: dependency ${safe(n)} has no node_modules entry`);
        missingReported.add(n);
        continue;
      }
      seen.add(n);
      for (const d of ent.deps) queue.push(d);
    }
    return seen;
  };
  const prodReached = reach(rootNames);
  const reached = dev ? reach([...rootNames, ...devNames]) : prodReached;
  for (const n of entries.keys()) if (!reached.has(n)) add(`lock: ${n} is not reachable from the root dependencies`);
  // The lock's dev flag must be exactly "reachable only through devDependencies".
  if (dev) {
    for (const [n, ent] of entries) {
      if (!reached.has(n)) continue;
      const devOnly = !prodReached.has(n);
      if (devOnly && !ent.dev) add(`lock ${n}: reachable only from devDependencies, so dev must be true`);
      if (!devOnly && ent.dev) add(`lock ${n}: reachable from dependencies, so dev must not be set`);
    }
  }

  if (violations.length > 0) return fail();

  const packagesOut: ExpectedTarball[] = [...entries.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, e]) => ({ name, version: e.version, integrity: e.integrity }));
  return {
    ok: true,
    packageJson: packageJsonText,
    lock: lockText,
    packages: packagesOut,
    packageCount: packagesOut.length,
    rootDependencyCount: rootNames.length,
    ...(dev ? { devPackageCount: [...entries.keys()].filter((n) => !prodReached.has(n)).length } : {}),
    packageJsonSha256: sha256(packageJsonText),
    lockSha256: sha256(lockText),
  };
}
