/**
 * github-analysis.ts — pure static analysis of the four root files of a fetched public GitHub
 * commit. No I/O, no process, no network. Written without a shell; later compiled and covered by
 * the passing tests in test/github-runner.test.ts (external run).
 *
 * What the worker reads from a repository (github-source.ts): ONLY the top-level files
 * package.json, package-lock.json, build.mjs and test.mjs, each at most 64 KiB, as raw git blobs
 * (no checkout filters). Nothing else from the repository ever reaches the host.
 *
 * Supported class (narrow on purpose; everything else is reported as unsupported with the exact
 * reason, and nothing is built or run):
 *   - package.json and package-lock.json at the repository root that pass checkOperatorFixture
 *     (npm-operator-fixture.ts): lockfileVersion 3, at most 8 flat unscoped registry packages,
 *     production dependencies only, an allowlisted package.json WITHOUT scripts, workspaces or
 *     overrides, registry.npmjs.org tarballs with sha512 integrity;
 *   - a build.mjs at the root (the controlled pipeline runs `node build.mjs`); test.mjs is optional.
 * Because the package.json allowlist has no `scripts`, ordinary projects (which build through npm
 * scripts) are unsupported. That is a limit of this slice, not a statement about the repository.
 *
 * Findings carry fixed texts, except dependency-policy violations, which are bounded, printable
 * ASCII messages from the policy modules (they may contain a package name from the repository).
 *
 * @module github-analysis
 */

import { sanitize } from "./acquisition-policy.js";
import { checkOperatorFixture } from "./npm-operator-fixture.js";

export const ROOT_FILE_NAMES: readonly string[] = Object.freeze(["package.json", "package-lock.json", "build.mjs", "test.mjs"]);
export const MAX_ROOT_FILE_BYTES = 64 * 1024;
const MAX_POLICY_FINDINGS = 5;

/** The root files read from the commit. `null` text means absent or unusable (see `unusable`). */
export interface RootFiles {
  packageJson: string | null;
  packageLock: string | null;
  buildMjs: string | null;
  testMjs: string | null;
  /** Names present at the root but not usable: not a regular file, or larger than MAX_ROOT_FILE_BYTES. */
  unusable: string[];
}

export type FindingCode =
  | "source-policy-rejected"
  | "no-package-json"
  | "no-package-lock"
  | "no-build-script"
  | "file-unusable"
  | "dependency-policy-rejected"
  | "dependency-acquisition-not-configured";

export interface Finding {
  code: FindingCode;
  detail: string;
}

export interface PackageFacts {
  /** False when package.json is not a JSON object. */
  parsed: boolean;
  scriptCount: number;
  dependencyCount: number;
  devDependencyCount: number;
  hasWorkspaces: boolean;
}

export interface AnalysisFacts {
  present: { packageJson: boolean; packageLock: boolean; buildMjs: boolean; testMjs: boolean };
  packageJson: PackageFacts | null;
  /** From the lockfile's own lockfileVersion field, or null when absent or not parsable. */
  lockfileVersion: number | null;
  /** Number of packages `npm ci` is expected to add; set only when the strict policy accepted the files. */
  expectedPackages: number | null;
}

export interface Analysis {
  supported: boolean;
  findings: Finding[];
  facts: AnalysisFacts;
}

const FIXED: Readonly<Record<Exclude<FindingCode, "dependency-policy-rejected" | "source-policy-rejected" | "file-unusable">, string>> = {
  "no-package-json": "There is no package.json at the repository root.",
  "no-package-lock": "There is no package-lock.json at the repository root; npm ci needs one.",
  "no-build-script": "There is no build.mjs at the repository root; the controlled pipeline only runs a root build.mjs.",
  "dependency-acquisition-not-configured":
    "The repository is in the supported class, but this worker has no registry egress configured, so its dependencies cannot be acquired.",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function countKeys(doc: Record<string, unknown>, key: string): number {
  const v = doc[key];
  return isObj(v) ? Object.keys(v).length : 0;
}

function describePackageJson(text: string): PackageFacts {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { parsed: false, scriptCount: 0, dependencyCount: 0, devDependencyCount: 0, hasWorkspaces: false };
  }
  if (!isObj(doc)) return { parsed: false, scriptCount: 0, dependencyCount: 0, devDependencyCount: 0, hasWorkspaces: false };
  return {
    parsed: true,
    scriptCount: countKeys(doc, "scripts"),
    dependencyCount: countKeys(doc, "dependencies"),
    devDependencyCount: countKeys(doc, "devDependencies"),
    hasWorkspaces: doc["workspaces"] !== undefined,
  };
}

function lockVersionOf(text: string): number | null {
  try {
    const doc: unknown = JSON.parse(text);
    if (isObj(doc) && typeof doc["lockfileVersion"] === "number" && Number.isInteger(doc["lockfileVersion"])) {
      return doc["lockfileVersion"];
    }
  } catch {
    // not JSON
  }
  return null;
}

export function emptyFacts(): AnalysisFacts {
  return {
    present: { packageJson: false, packageLock: false, buildMjs: false, testMjs: false },
    packageJson: null,
    lockfileVersion: null,
    expectedPackages: null,
  };
}

/**
 * Decides whether the root files are in the supported class. `dependencyAcquisition` says whether
 * this worker can fetch dependencies at all; when it cannot, an otherwise supported repository is
 * still reported as not runnable, with its own finding.
 */
export function analyzeRootFiles(files: RootFiles, opts: { dependencyAcquisition: boolean }): Analysis {
  const findings: Finding[] = [];
  const facts = emptyFacts();
  facts.present = {
    packageJson: files.packageJson !== null,
    packageLock: files.packageLock !== null,
    buildMjs: files.buildMjs !== null,
    testMjs: files.testMjs !== null,
  };
  if (files.packageJson !== null) facts.packageJson = describePackageJson(files.packageJson);
  if (files.packageLock !== null) facts.lockfileVersion = lockVersionOf(files.packageLock);

  for (const name of files.unusable) {
    if (ROOT_FILE_NAMES.includes(name)) {
      findings.push({ code: "file-unusable", detail: `${name} is not a regular file of at most ${MAX_ROOT_FILE_BYTES} bytes.` });
    }
  }
  const unusable = (name: string): boolean => files.unusable.includes(name);
  if (files.packageJson === null && !unusable("package.json")) findings.push({ code: "no-package-json", detail: FIXED["no-package-json"] });
  if (files.packageLock === null && !unusable("package-lock.json")) findings.push({ code: "no-package-lock", detail: FIXED["no-package-lock"] });
  if (files.buildMjs === null && !unusable("build.mjs")) findings.push({ code: "no-build-script", detail: FIXED["no-build-script"] });

  if (files.packageJson !== null && files.packageLock !== null) {
    const r = checkOperatorFixture(files.packageJson, files.packageLock);
    if (r.ok) {
      facts.expectedPackages = r.packageCount;
    } else {
      for (const v of r.violations.slice(0, MAX_POLICY_FINDINGS)) {
        findings.push({ code: "dependency-policy-rejected", detail: sanitize(v, 200) });
      }
    }
  }

  if (findings.length === 0 && !opts.dependencyAcquisition) {
    findings.push({ code: "dependency-acquisition-not-configured", detail: FIXED["dependency-acquisition-not-configured"] });
  }
  return { supported: findings.length === 0, findings, facts };
}

/** A plain JSON projection for the stored result. */
export function projectAnalysis(a: Analysis): Record<string, unknown> {
  return {
    supported: a.supported,
    findings: a.findings.map((f) => ({ code: f.code, detail: f.detail })),
    facts: a.facts,
  };
}
