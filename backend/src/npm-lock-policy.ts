/**
 * npm-lock-policy.ts — PRELIMINARY static policy for the package.json / package-lock.json pair of a
 * CONTROLLED local test fixture, checked BEFORE any process or container is started.
 *
 * Pure: no I/O, no process, no network. It is a preliminary allowlist, NOT production security. It
 * does not prove that a package is safe, that the integrity hashes are the ones a registry serves,
 * or that npm interprets the files the way this module does. Arbitrary repositories remain out of
 * scope. Unverified: written without running anything.
 *
 * Accepted (everything else is a violation):
 *  - package.json: object <= 16 KiB; dependency maps with plain semver-range specs only; none of
 *    workspaces, overrides, resolutions, packageManager, pnpm, bundled dependencies or install-time
 *    scripts (preinstall, install, postinstall, prepare, ...).
 *  - package-lock.json: <= 512 KiB, lockfileVersion 2 or 3, a `packages` map of at most 200 entries.
 *    Every non-root key is a plain `node_modules/<name>` path (nested allowed). Every entry has a
 *    strict semver `version`, a `resolved` URL of exactly
 *    `https://registry.npmjs.org/<name>/-/<file>-<version>.tgz`, and a single `sha512-` integrity
 *    value of 64 bytes. Rejected: link, inBundle/bundled, hasInstallScript, aliases (`name`),
 *    platform filters (`os`, `cpu`, `libc`; they make the expected package count unknowable), and
 *    any git, http, file, link, tarball or alias specifier anywhere (also in the legacy v2
 *    `dependencies` tree).
 *
 * @module npm-lock-policy
 */

export const MAX_PACKAGE_JSON_BYTES = 16 * 1024;
export const MAX_LOCKFILE_BYTES = 512 * 1024;
export const MAX_LOCK_PACKAGES = 200;
export const MAX_DEPENDENCIES_PER_MAP = 100;

const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const MAX_VIOLATIONS = 20;
const MAX_KEY_CHARS = 300;
const MAX_LEGACY_VISITS = 1000;
const MAX_LEGACY_DEPTH = 12;

const NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/;
/** Range spec: starts with a digit or a range operator; ":", "/", "@", "#" and "\" cannot occur. */
const SPEC_RE = /^[0-9^~<>=*xX][0-9A-Za-z.^~<>=*|+\- ]{0,99}$/;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;
const SEG = "(?:@[a-z0-9][a-z0-9._-]{0,63}\\/)?[a-z0-9][a-z0-9._-]{0,63}";
const KEY_RE = new RegExp(`^node_modules/${SEG}(?:/node_modules/${SEG}){0,9}$`);

const FORBIDDEN_ROOT_FIELDS: readonly string[] = [
  "workspaces", "overrides", "resolutions", "packageManager", "pnpm", "devEngines",
  "bundledDependencies", "bundleDependencies",
];
const FORBIDDEN_SCRIPTS: readonly string[] = [
  "preinstall", "install", "postinstall", "prepare", "preprepare", "postprepare", "prepublish",
];
const DEP_FIELDS: readonly string[] = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const FORBIDDEN_ENTRY_FIELDS: readonly string[] = [
  "link", "inBundle", "bundled", "bundleDependencies", "hasInstallScript", "name", "os", "cpu", "libc",
];

export type PolicyResult =
  | { ok: true; packageCount: number; rootDependencyCount: number }
  | { ok: false; violations: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const clip = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s);
/** Printable ASCII only, so a violation message cannot carry control characters from the input. */
const safe = (s: string): string => clip(s.replace(/[^\x20-\x7e]/g, "?"));

class Collector {
  readonly items: string[] = [];
  add(msg: string): void {
    if (this.items.length < MAX_VIOLATIONS) this.items.push(msg);
  }
}

function parseJson(text: unknown, maxBytes: number, what: string, c: Collector): Record<string, unknown> | null {
  if (typeof text !== "string") {
    c.add(`${what}: content is not text`);
    return null;
  }
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > maxBytes) {
    c.add(`${what}: empty or larger than ${maxBytes} bytes`);
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObj(parsed)) {
      c.add(`${what}: top level is not an object`);
      return null;
    }
    return parsed;
  } catch {
    c.add(`${what}: not valid JSON`);
    return null;
  }
}

function checkDepMap(map: unknown, where: string, c: Collector): number {
  if (map === undefined) return 0;
  if (!isObj(map)) {
    c.add(`${where}: not an object`);
    return 0;
  }
  const names = Object.keys(map);
  if (names.length > MAX_DEPENDENCIES_PER_MAP) c.add(`${where}: more than ${MAX_DEPENDENCIES_PER_MAP} entries`);
  for (const name of names.slice(0, MAX_DEPENDENCIES_PER_MAP)) {
    const spec = map[name];
    if (!NAME_RE.test(name)) c.add(`${where}: invalid package name ${safe(name)}`);
    else if (typeof spec !== "string" || !SPEC_RE.test(spec)) {
      c.add(`${where}: ${name} has a spec that is not a plain version range (git, url, file, link, alias and tag specs are rejected)`);
    }
  }
  return names.length;
}

function checkPackageJson(pkg: Record<string, unknown>, c: Collector): number {
  for (const f of FORBIDDEN_ROOT_FIELDS) {
    if (has(pkg, f)) c.add(`package.json: field ${f} is not allowed`);
  }
  const scripts = pkg["scripts"];
  if (scripts !== undefined) {
    if (!isObj(scripts)) c.add("package.json: scripts is not an object");
    else for (const s of FORBIDDEN_SCRIPTS) if (has(scripts, s)) c.add(`package.json: install-time script ${s} is not allowed`);
  }
  let count = 0;
  for (const f of DEP_FIELDS) count += checkDepMap(pkg[f], `package.json ${f}`, c);
  return count;
}

/** `resolved` must be exactly the registry tarball URL for this name and version. */
function checkResolved(resolved: unknown, name: string, version: string): boolean {
  if (typeof resolved !== "string" || resolved.length > 300) return false;
  const base = name.includes("/") ? (name.split("/")[1] as string) : name;
  return resolved === `${REGISTRY_ORIGIN}/${name}/-/${base}-${version}.tgz`;
}

function checkIntegrity(integrity: unknown): boolean {
  return typeof integrity === "string" && INTEGRITY_RE.test(integrity);
}

function checkEntry(key: string, e: unknown, c: Collector): void {
  const k = safe(key);
  if (!isObj(e)) {
    c.add(`lock ${k}: entry is not an object`);
    return;
  }
  for (const f of FORBIDDEN_ENTRY_FIELDS) {
    if (has(e, f)) c.add(`lock ${k}: field ${f} is not allowed`);
  }
  const version = e["version"];
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    c.add(`lock ${k}: version is missing or not a plain semver version`);
    return;
  }
  const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  if (!checkResolved(e["resolved"], name, version)) {
    c.add(`lock ${k}: resolved is not ${REGISTRY_ORIGIN}/<name>/-/<file>-<version>.tgz`);
  }
  if (!checkIntegrity(e["integrity"])) c.add(`lock ${k}: integrity is missing or not a single sha512 value`);
  for (const f of ["dev", "optional", "peer", "devOptional"]) {
    if (has(e, f) && typeof e[f] !== "boolean") c.add(`lock ${k}: ${f} is not a boolean`);
  }
  for (const f of DEP_FIELDS) {
    if (has(e, f)) checkDepMap(e[f], `lock ${k} ${f}`, c);
  }
}

/** Legacy lockfileVersion 2 `dependencies` tree: same restrictions, bounded walk. */
function checkLegacyTree(tree: unknown, c: Collector): void {
  let visits = 0;
  const walk = (node: unknown, depth: number): void => {
    if (!isObj(node)) {
      c.add("lock dependencies: not an object");
      return;
    }
    if (depth > MAX_LEGACY_DEPTH) {
      c.add("lock dependencies: nested deeper than allowed");
      return;
    }
    for (const name of Object.keys(node)) {
      visits += 1;
      if (visits > MAX_LEGACY_VISITS) {
        c.add("lock dependencies: more entries than allowed");
        return;
      }
      const e = node[name];
      if (!NAME_RE.test(name) || !isObj(e)) {
        c.add(`lock dependencies: invalid entry ${safe(name)}`);
        continue;
      }
      const version = e["version"];
      if (typeof version !== "string" || !VERSION_RE.test(version)) {
        c.add(`lock dependencies ${safe(name)}: version is not a plain semver version`);
        continue;
      }
      if (!checkResolved(e["resolved"], name, version)) c.add(`lock dependencies ${safe(name)}: resolved is not the registry tarball URL`);
      if (!checkIntegrity(e["integrity"])) c.add(`lock dependencies ${safe(name)}: integrity is missing or not a single sha512 value`);
      for (const f of ["bundled", "inBundle", "link", "hasInstallScript"]) {
        if (has(e, f)) c.add(`lock dependencies ${safe(name)}: field ${f} is not allowed`);
      }
      if (has(e, "dependencies")) walk(e["dependencies"], depth + 1);
    }
  };
  walk(tree, 0);
}

/**
 * Validates the exact text of both files. `packageCount` is the number of non-root lock entries,
 * which is what `npm ci` is expected to report as added when the policy holds.
 */
export function checkNpmFixture(packageJsonText: unknown, lockText: unknown): PolicyResult {
  const c = new Collector();
  const pkg = parseJson(packageJsonText, MAX_PACKAGE_JSON_BYTES, "package.json", c);
  const lock = parseJson(lockText, MAX_LOCKFILE_BYTES, "package-lock.json", c);
  let rootDeps = 0;
  if (pkg !== null) rootDeps = checkPackageJson(pkg, c);

  let packageCount = 0;
  if (lock !== null) {
    const v = lock["lockfileVersion"];
    if (v !== 2 && v !== 3) c.add("lock: lockfileVersion must be 2 or 3");
    const packages = lock["packages"];
    if (!isObj(packages)) {
      c.add("lock: packages map is missing");
    } else {
      const keys = Object.keys(packages);
      const root = packages[""];
      if (!has(packages, "")) c.add("lock: root entry is missing");
      else if (!isObj(root)) c.add("lock: root entry is not an object");
      else {
        for (const f of FORBIDDEN_ROOT_FIELDS) if (has(root, f)) c.add(`lock root: field ${f} is not allowed`);
        for (const f of ["link", "inBundle", "bundled", "hasInstallScript"]) if (has(root, f)) c.add(`lock root: field ${f} is not allowed`);
      }
      packageCount = keys.length - (has(packages, "") ? 1 : 0);
      if (packageCount < 1) c.add("lock: no installable packages");
      if (packageCount > MAX_LOCK_PACKAGES) c.add(`lock: more than ${MAX_LOCK_PACKAGES} packages`);
      for (const key of keys.slice(0, MAX_LOCK_PACKAGES + 1)) {
        if (key === "") continue;
        if (key.length > MAX_KEY_CHARS || !KEY_RE.test(key)) {
          c.add(`lock: key ${safe(key)} is not a plain node_modules path (workspace, link and traversal paths are rejected)`);
          continue;
        }
        checkEntry(key, packages[key], c);
      }
    }
    if (has(lock, "dependencies")) {
      if (v === 3) c.add("lock: lockfileVersion 3 must not have a legacy dependencies tree");
      else checkLegacyTree(lock["dependencies"], c);
    }
  }

  if (c.items.length > 0) return { ok: false, violations: c.items };
  return { ok: true, packageCount, rootDependencyCount: rootDeps };
}
