/**
 * npm-scripts-policy.ts — pure static acceptance of ONE narrow repository profile for the opt-in
 * "npm scripts" mode: a small conventional single-package npm project whose root package.json
 * declares `scripts.build` and `scripts.test` and whose dependencies fit the existing operator lock
 * policy. No I/O, no process, no network. Written without a shell or a test run (UNVERIFIED until the
 * operator runs the suite and the real-Docker harness; see backend/DEVELOPMENT.md).
 *
 * What this module decides, from the two root files read as data:
 *   1. the repository declares `scripts`, and `scripts.build` and `scripts.test` are bounded
 *      printable-ASCII one-liners; the `npm init` placeholder test script is refused (it always fails
 *      and would be reported as a failing repository);
 *   2. no lifecycle hook of the two scripts exists (prebuild, postbuild, pretest, posttest). The mode
 *      runs `npm run <name> --ignore-scripts`, which does not run pre/post hooks, so such a project
 *      would not be run the way its author intended. It is reported as unsupported instead of being
 *      run differently;
 *   3. the ORIGINAL manifest passes checkNpmFixture (no install-time scripts such as preinstall,
 *      install, postinstall or prepare; no workspaces, overrides, git/url/file/alias specs);
 *   4. the SANITIZED manifest (the minimized install manifest: exactly name, version, `private: true`,
 *      description, license, dependencies; `scripts` and validated inert metadata such as type, main,
 *      engines, author, repository, keywords, homepage and bugs are dropped, and any other key is kept
 *      so the strict gate rejects it) passes checkOperatorFixture together with the unchanged lockfile.
 *      That gate is what makes the lock root and the manifest agree on identical dependencies, restricts
 *      the lock to lockfileVersion 3, at most 8 flat unscoped registry packages with sha512 integrity,
 *      and production dependencies only. `bin`, `devDependencies`, `exports`, `files` and similar fields
 *      still make a project unsupported in this slice. A lock root `engines` is accepted only when it
 *      equals the original package.json engines (key order ignored); the plan then reports
 *      `lockRootEngines: true` and the runner passes the explicit `allowLockRootEngines` opt-in to the
 *      registry acquisition, which applies it only with the operator fixture. The lockfile is never edited.
 *
 *   The default is that profile: production dependencies only. With the explicit shared option
 *   `allowDevDependencies` (opts of planNpmScripts; off unless set) the strict gate additionally accepts
 *   flat unscoped `devDependencies` whose lock entries are marked `dev: true` exactly when reachable only
 *   through them (npm-operator-fixture.ts). The plan then carries `allowDevDependencies: true` so the
 *   acquisition request and the pipeline are given the same option. Nothing else about the profile changes.
 *
 * The sanitized manifest is used ONLY for dependency acquisition and the offline install. The
 * original manifest, with its scripts, is restored inside the container only for the two named
 * script runs. The original text is never edited; the sanitized text is derived from it as above.
 *
 * @module npm-scripts-policy
 */

import { createHash } from "node:crypto";
import { sanitize } from "./acquisition-policy.js";
import { checkNpmFixture, type NpmDependencyPolicy } from "./npm-lock-policy.js";
import { checkOperatorFixture } from "./npm-operator-fixture.js";

/** Value of `runMode` in stored results of this mode. */
export const NPM_SCRIPTS_RUN_MODE = "npm-scripts";
export const MAX_SCRIPT_CHARS = 300;
const MAX_POLICY_FINDINGS = 5;

/** Hooks that `npm run <name> --ignore-scripts` would silently skip. */
const HOOK_SCRIPTS: readonly string[] = ["prebuild", "postbuild", "pretest", "posttest"];
const PRINTABLE_ONE_LINE_RE = /^[\x20-\x7e]+$/;
const PLACEHOLDER_TEST_RE = /no test specified/i;

export type ScriptsFindingCode =
  | "no-package-json"
  | "no-package-lock"
  | "package-json-unparsable"
  | "no-build-script"
  | "no-test-script"
  | "script-not-supported"
  | "placeholder-test-script"
  | "lifecycle-hook-script"
  | "dependency-policy-rejected"
  | "package-metadata-rejected"
  | "dependency-acquisition-not-configured"
  | "source-snapshot-refused";

export interface ScriptsFinding {
  code: ScriptsFindingCode;
  detail: string;
}

export interface ScriptsPlanOk {
  ok: true;
  /** package.json without `scripts`. The only manifest used for acquisition and installation. */
  sanitizedPackageJson: string;
  buildScript: string;
  testScript: string;
  /** Packages `npm ci` is expected to add (the lock's own count). */
  expectedPackages: number;
  originalPackageJsonSha256: string;
  sanitizedPackageJsonSha256: string;
  packageLockSha256: string;
  /**
   * True when the lock root carries an `engines` object that equals the original package.json engines
   * (key order ignored). Acquisition must then be asked, explicitly, to accept that lock root field.
   */
  lockRootEngines?: boolean;
  /**
   * Present (true) only when the plan was made with the shared `allowDevDependencies` option: the install
   * manifest may then carry `devDependencies` and the acquisition and pipeline must be given the same option.
   * Absent: the legacy production-only profile.
   */
  allowDevDependencies?: true;
}

export type ScriptsPlan = ScriptsPlanOk | { ok: false; findings: ScriptsFinding[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Own key/value equality of two plain objects of strings, irrespective of key order. */
function sameEngines(a: unknown, b: unknown): boolean {
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => has(b, k) && a[k] === b[k]);
}

/** True when the text parses to an object that has its own `scripts` key. Never throws. */
export function declaresScripts(packageJsonText: string | null): boolean {
  if (packageJsonText === null) return false;
  try {
    const doc: unknown = JSON.parse(packageJsonText);
    return isObj(doc) && has(doc, "scripts") && doc["scripts"] !== undefined;
  } catch {
    return false;
  }
}

/**
 * Ordinary metadata that is validated and then DROPPED from the install manifest. None of it is read by
 * `npm ci --offline --ignore-scripts`; the byte-identical original (with `type`, `main`, ...) is what
 * the two named scripts run against.
 */
const INERT_KEYS: readonly string[] = ["type", "main", "engines", "author", "repository", "keywords", "homepage", "bugs"];
const MAX_META_STRING = 200;
const MAIN_RE = /^(?:\.\/)?[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,99}$/;
const ENGINE_RANGE_RE = /^[0-9A-Za-z.^~<>=*|+\- ]{1,50}$/;

/**
 * The install/acquisition manifest: the original reduced to `name`, `version`, `private: true`,
 * `description`, `license`, `dependencies`. `scripts` and the validated inert metadata are removed and
 * `private` is forced to true. Any other key is kept as is so the strict operator gate still rejects it.
 * For a manifest that already fits the legacy allowlist the result equals the original minus `scripts`.
 * Throws if the text is not a JSON object.
 */
export function sanitizeManifest(packageJsonText: string): string {
  const doc: unknown = JSON.parse(packageJsonText);
  if (!isObj(doc)) throw new Error("package.json is not an object");
  const entries: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(doc)) {
    if (k === "scripts" || INERT_KEYS.includes(k)) continue;
    entries.push([k, k === "private" ? true : v]);
  }
  if (!entries.some(([k]) => k === "private")) entries.push(["private", true]);
  // fromEntries defines own data properties, so a `__proto__` key survives and the strict gate rejects it.
  const copy = Object.fromEntries(entries);
  return `${JSON.stringify(copy, null, 2)}\n`;
}

const text = (v: unknown, max = MAX_META_STRING): v is string => typeof v === "string" && v.length > 0 && v.length <= max && PRINTABLE_ONE_LINE_RE.test(v);
/** A printable string, or an object with only the listed printable-string keys. */
const strOrObj = (v: unknown, keys: readonly string[]): boolean =>
  text(v) || (isObj(v) && Object.keys(v).length > 0 && Object.entries(v).every(([k, x]) => keys.includes(k) && text(x)));

/** Validates ordinary package.json metadata. Returns the reasons it is refused (bounded, fixed texts). */
function checkMetadata(doc: Record<string, unknown>): string[] {
  const bad: string[] = [];
  if (has(doc, "private") && typeof doc["private"] !== "boolean") bad.push("private must be a boolean when present");
  if (has(doc, "type") && doc["type"] !== "module" && doc["type"] !== "commonjs") bad.push('type must be "module" or "commonjs"');
  if (has(doc, "main")) {
    const m = doc["main"];
    const segs = text(m, 100) && MAIN_RE.test(m) ? m.replace(/^\.\//, "").split("/") : null;
    if (segs === null || segs.some((s) => s === "" || s === "." || s === "..")) {
      bad.push("main must be a short relative file path without . or .. segments");
    }
  }
  if (has(doc, "engines")) {
    const e = doc["engines"];
    if (!isObj(e) || Object.keys(e).length === 0 || Object.keys(e).length > 2 ||
        !Object.entries(e).every(([k, v]) => (k === "node" || k === "npm") && typeof v === "string" && ENGINE_RANGE_RE.test(v))) {
      bad.push("engines may only set node and npm to plain version ranges");
    }
  }
  if (has(doc, "author") && !strOrObj(doc["author"], ["name", "email", "url"])) bad.push("author must be a short string or {name,email,url}");
  if (has(doc, "repository") && !strOrObj(doc["repository"], ["type", "url", "directory"])) bad.push("repository must be a short string or {type,url,directory}");
  if (has(doc, "bugs") && !strOrObj(doc["bugs"], ["url", "email"])) bad.push("bugs must be a short string or {url,email}");
  if (has(doc, "homepage") && !text(doc["homepage"])) bad.push("homepage must be a short printable string");
  if (has(doc, "keywords")) {
    const k = doc["keywords"];
    if (!Array.isArray(k) || k.length > 20 || !k.every((x) => text(x, 50))) bad.push("keywords must be at most 20 short strings");
  }
  return bad;
}

function checkScript(name: "build" | "test", value: unknown, out: ScriptsFinding[]): string | null {
  if (value === undefined) {
    out.push({
      code: name === "build" ? "no-build-script" : "no-test-script",
      detail: `package.json scripts.${name} is missing; this mode runs exactly \`npm run ${name}\`.`,
    });
    return null;
  }
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_SCRIPT_CHARS || !PRINTABLE_ONE_LINE_RE.test(value)) {
    out.push({
      code: "script-not-supported",
      detail: `scripts.${name} must be a printable ASCII one-liner of at most ${MAX_SCRIPT_CHARS} characters.`,
    });
    return null;
  }
  if (name === "test" && PLACEHOLDER_TEST_RE.test(value)) {
    out.push({
      code: "placeholder-test-script",
      detail: "scripts.test is the npm init placeholder, which always fails. There is no real test to run.",
    });
    return null;
  }
  return value;
}

/**
 * Decides whether the two root files are in the npm-scripts profile. `dependencyAcquisition` says
 * whether the worker can fetch dependencies at all. Never throws; every refusal is a finding with a
 * fixed text or a bounded printable-ASCII policy message.
 */
export function planNpmScripts(
  files: { packageJson: string | null; packageLock: string | null },
  opts: { dependencyAcquisition: boolean } & NpmDependencyPolicy,
): ScriptsPlan {
  const dev = opts.allowDevDependencies === true;
  const policy: NpmDependencyPolicy = dev ? { allowDevDependencies: true } : {};
  const findings: ScriptsFinding[] = [];
  if (files.packageJson === null) findings.push({ code: "no-package-json", detail: "There is no usable package.json at the repository root." });
  if (files.packageLock === null) {
    findings.push({ code: "no-package-lock", detail: "There is no usable package-lock.json at the repository root; npm ci needs one." });
  }
  if (files.packageJson === null || files.packageLock === null) return { ok: false, findings };

  let doc: unknown;
  try {
    doc = JSON.parse(files.packageJson);
  } catch {
    doc = null;
  }
  if (!isObj(doc)) return { ok: false, findings: [{ code: "package-json-unparsable", detail: "package.json is not a JSON object." }] };

  const scripts = doc["scripts"];
  if (!isObj(scripts)) {
    return { ok: false, findings: [{ code: "no-build-script", detail: "package.json has no scripts object; this mode runs `npm run build` and `npm run test`." }] };
  }
  const buildScript = checkScript("build", scripts["build"], findings);
  const testScript = checkScript("test", scripts["test"], findings);
  for (const hook of HOOK_SCRIPTS) {
    if (has(scripts, hook)) {
      findings.push({
        code: "lifecycle-hook-script",
        detail: `scripts.${hook} exists. This mode runs the named scripts with --ignore-scripts, which skips pre/post hooks, so the project would not run as its author intended.`,
      });
    }
  }
  if (findings.length > 0) return { ok: false, findings };

  const metaBad = checkMetadata(doc);
  if (metaBad.length > 0) {
    return { ok: false, findings: metaBad.slice(0, MAX_POLICY_FINDINGS).map((d) => ({ code: "package-metadata-rejected" as const, detail: d })) };
  }

  // A lock root `engines` (npm writes it when package.json has engines) must equal the original's.
  let lockDoc: unknown;
  try {
    lockDoc = JSON.parse(files.packageLock);
  } catch {
    lockDoc = null; // gate 1 reports the unparsable lock
  }
  const lockRoot = isObj(lockDoc) && isObj(lockDoc["packages"]) ? (lockDoc["packages"] as Record<string, unknown>)[""] : undefined;
  if (isObj(lockRoot) && has(lockRoot, "engines") && !sameEngines(lockRoot["engines"], doc["engines"])) {
    return { ok: false, findings: [{ code: "package-metadata-rejected", detail: "The lock root engines differ from package.json engines." }] };
  }
  const lockRootEngines = isObj(lockRoot) && has(lockRoot, "engines");
  // Gate 1: the unchanged static policy on the ORIGINAL manifest (install-time scripts, specs, size).
  const original = checkNpmFixture(files.packageJson, files.packageLock, policy);
  if (!original.ok) {
    return {
      ok: false,
      findings: original.violations.slice(0, MAX_POLICY_FINDINGS).map((v) => ({ code: "dependency-policy-rejected" as const, detail: sanitize(v, 200) })),
    };
  }

  // Gate 2: the SANITIZED manifest (only `scripts` removed) against the unchanged lockfile.
  const sanitized = sanitizeManifest(files.packageJson);
  const strict = checkOperatorFixture(sanitized, files.packageLock, { allowLockRootEngines: true, ...policy });
  if (!strict.ok) {
    return {
      ok: false,
      findings: strict.violations.slice(0, MAX_POLICY_FINDINGS).map((v) => ({ code: "dependency-policy-rejected" as const, detail: sanitize(v, 200) })),
    };
  }
  if (!opts.dependencyAcquisition) {
    return {
      ok: false,
      findings: [
        {
          code: "dependency-acquisition-not-configured",
          detail: "The repository is in the npm-scripts profile, but this worker has no registry egress configured, so its dependencies cannot be acquired.",
        },
      ],
    };
  }
  return {
    ok: true,
    sanitizedPackageJson: strict.packageJson,
    buildScript: buildScript as string,
    testScript: testScript as string,
    expectedPackages: strict.packageCount,
    originalPackageJsonSha256: sha256(files.packageJson),
    sanitizedPackageJsonSha256: strict.packageJsonSha256,
    packageLockSha256: strict.lockSha256,
    lockRootEngines,
    ...(dev ? { allowDevDependencies: true as const } : {}),
  };
}
