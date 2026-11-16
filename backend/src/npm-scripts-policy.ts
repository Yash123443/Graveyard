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
 *   4. the SANITIZED manifest, which is the original with exactly the `scripts` key removed and
 *      nothing else changed, passes checkOperatorFixture together with the unchanged lockfile. That
 *      gate is what makes the lock root and the manifest agree on identical dependencies, restricts the
 *      lock to lockfileVersion 3, at most 8 flat unscoped registry packages with sha512 integrity, and
 *      production dependencies only. Its package.json allowlist (name, version, private: true,
 *      description, license, dependencies) therefore also applies; `type`, `main`, `bin`, `engines`,
 *      `devDependencies` and similar fields make a project unsupported in this slice.
 *
 * The sanitized manifest is used ONLY for dependency acquisition and the offline install. The
 * original manifest, with its scripts, is restored inside the container only for the two named
 * script runs. Neither text is ever edited beyond removing `scripts`.
 *
 * @module npm-scripts-policy
 */

import { createHash } from "node:crypto";
import { sanitize } from "./acquisition-policy.js";
import { checkNpmFixture } from "./npm-lock-policy.js";
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
}

export type ScriptsPlan = ScriptsPlanOk | { ok: false; findings: ScriptsFinding[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

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

/** The original manifest with exactly the `scripts` key removed. Throws if the text is not a JSON object. */
export function sanitizeManifest(packageJsonText: string): string {
  const doc: unknown = JSON.parse(packageJsonText);
  if (!isObj(doc)) throw new Error("package.json is not an object");
  const copy: Record<string, unknown> = { ...doc };
  delete copy["scripts"];
  return `${JSON.stringify(copy, null, 2)}\n`;
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
  opts: { dependencyAcquisition: boolean },
): ScriptsPlan {
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

  // Gate 1: the unchanged static policy on the ORIGINAL manifest (install-time scripts, specs, size).
  const original = checkNpmFixture(files.packageJson, files.packageLock);
  if (!original.ok) {
    return {
      ok: false,
      findings: original.violations.slice(0, MAX_POLICY_FINDINGS).map((v) => ({ code: "dependency-policy-rejected" as const, detail: sanitize(v, 200) })),
    };
  }

  // Gate 2: the SANITIZED manifest (only `scripts` removed) against the unchanged lockfile.
  const sanitized = sanitizeManifest(files.packageJson);
  const strict = checkOperatorFixture(sanitized, files.packageLock);
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
  };
}
