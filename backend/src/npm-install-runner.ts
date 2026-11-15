/**
 * npm-install-runner.ts — controlled, OFFLINE `npm ci` for CONTROLLED LOCAL TEST FIXTURES ONLY.
 *
 * Foundation only. NOT a JobRunner, NOT wired to the server, worker or any job, and it must not be
 * pointed at arbitrary repositories. Written without running anything: until an operator runs the
 * tests and the opt-in harness, none of this is verified (see backend/DEVELOPMENT.md).
 *
 * Order of operations. Every host-side check happens before any process or container exists:
 *  1. request validation, then the fixture directory is resolved inside `fixturesRoot` (realpath);
 *  2. package.json and package-lock.json are read as regular files (no symlinks, size capped);
 *     missing files give `no-package-json` / `no-lockfile`, nothing else is read;
 *  3. `checkNpmFixture` (npm-lock-policy.ts) must accept both files, otherwise `policy-rejected`;
 *  4. ONLY those two validated byte strings are copied into a fresh staging directory, together
 *     with an empty `node_modules` mount point and two empty runner-created npm config files. Nothing else from the source directory is copied,
 *     so a stray `.npmrc` or `.git` never reaches the container;
 *  5. one fixed command runs in a disposable container through DockerFixtureSandbox:
 *       npm ci --offline --ignore-scripts --no-audit --no-fund --no-update-notifier --logs-max=0
 *              --cache /npm-cache --userconfig /fixture/.npm-user-config
 *              --globalconfig /fixture/.npm-global-config   (two distinct empty staged files;
 *              /dev/null for both makes npm exit 1 with "double-loading config")
 *     Network none, non-root, caps dropped, read-only root, bounded memory / pids / time / output,
 *     `--pull never`, isolation read back from `docker inspect` before start. The staged directory
 *     is the read-only /fixture; /fixture/node_modules and /tmp are bounded noexec tmpfs mounts, so
 *     the install lands in memory and disappears with the container; the operator-supplied npm
 *     cache is a read-only bind at /npm-cache. No host secrets, no environment variables, no
 *     registry, URL, git or path is taken from the request;
 *  6. the container is removed with proof (sandbox cleanup) and the staging directory is removed.
 *
 * Status is independent of build/test status and is exactly one of:
 *  - success: exit 0, untruncated output, npm's own summary `added N packages` with N equal to the
 *    lock's package count, confirmed container cleanup AND staging removal;
 *  - failure: npm ran and exited nonzero (for example an offline cache miss);
 *  - not-run: everything inconclusive (no package.json, no lockfile, policy rejection, missing
 *    cache, timeout, cancel, Docker unavailable, isolation mismatch, truncated or unparseable
 *    output, count mismatch, unconfirmed cleanup).
 * No install is ever reported without a container that actually ran npm to exit 0.
 *
 * Limits. The evidence for `success` is npm's own stdout; the installed tree is not inspected (it
 * lives in a tmpfs that is destroyed). The policy is preliminary, not production security. The npm
 * behaviours assumed (output format, `ci` emptying a tmpfs node_modules instead of removing the
 * mount point, tolerating a read-only cache) are unobserved; a different behaviour fails closed as
 * failure or not-run, never as success.
 *
 * @module npm-install-runner
 */

import {
  lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  DockerFixtureSandbox,
  containerNameFor,
  type ProcessExecutor,
  type SandboxLimits,
  type SandboxResult,
} from "./docker-sandbox.js";
import { NODE_FIXTURE_IMAGE, tailOf } from "./node-fixture-runner.js";
import { MAX_LOCKFILE_BYTES, MAX_PACKAGE_JSON_BYTES, checkNpmFixture } from "./npm-lock-policy.js";
import type { CleanupProof } from "./runner.js";

export const NPM_CACHE_MOUNT = "/npm-cache";
export const NPM_MODULES_MOUNT = "/fixture/node_modules";
export const NPM_INSTALL_COMMAND_ID = "npm-ci-offline";

/**
 * Two DISTINCT, empty, runner-created files staged next to package.json. npm refuses to load the
 * same path as both user and global config ("double-loading"), so /dev/null cannot serve both.
 * Neither is named `.npmrc`, and no host config or credential is ever copied in.
 */
export const NPM_USERCONFIG_NAME = ".npm-user-config";
export const NPM_GLOBALCONFIG_NAME = ".npm-global-config";
export const NPM_USERCONFIG_PATH = `/fixture/${NPM_USERCONFIG_NAME}`;
export const NPM_GLOBALCONFIG_PATH = `/fixture/${NPM_GLOBALCONFIG_NAME}`;

/** Fixed argv. Frozen; no request input is ever added to it. */
export const NPM_CI_ARGV: readonly string[] = Object.freeze([
  "npm", "ci",
  "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
  "--no-update-notifier", "--logs-max=0",
  "--cache", NPM_CACHE_MOUNT,
  "--userconfig", NPM_USERCONFIG_PATH,
  "--globalconfig", NPM_GLOBALCONFIG_PATH,
]);

export const DEFAULT_NPM_INSTALL_LIMITS: Readonly<Partial<SandboxLimits>> = Object.freeze({
  memoryMb: 512,
  cpus: 1,
  pids: 128,
  tmpfsMb: 64,
  timeoutMs: 90_000,
  maxOutputBytes: 64 * 1024,
});
/** Size of the tmpfs mounted over /fixture/node_modules. */
export const NODE_MODULES_TMPFS_MB = 64;

export type InstallStatus = "success" | "failure" | "not-run";

export type InstallReason =
  | "ok"
  | "npm-exit-nonzero"
  | "summary-missing"
  | "summary-mismatch"
  | "output-truncated"
  | "timed-out"
  | "aborted"
  | "isolation-violation"
  | "docker-unavailable"
  | "rejected"
  | "unconfigured"
  | "cache-unavailable"
  | "no-package-json"
  | "no-lockfile"
  | "unreadable-input"
  | "policy-rejected"
  | "staging-failed"
  | "staging-cleanup-failed"
  | "cleanup-unconfirmed";

export interface InstallResult {
  status: InstallStatus;
  reason: InstallReason;
  /** Short human-readable explanation. Not machine-parsed. */
  detail: string;
  exitCode: number | null;
  durationMs: number | null;
  truncated: boolean;
  stdoutTail: string;
  stderrTail: string;
  /** Number reported by npm's own `added N packages` line, or null. */
  packagesAdded: number | null;
  /** Number of lock entries the policy counted, or null when the policy did not accept the files. */
  expectedPackages: number | null;
  /** Policy violations (empty unless `policy-rejected`). */
  violations: string[];
  /** null only when no container could have been created. */
  cleanup: CleanupProof | null;
  /** null when nothing was staged. */
  stagingRemoved: boolean | null;
  executionId: string | null;
}

export interface InstallRequest {
  /** `<id>:<number>`, same format as the sandbox. */
  executionId: string;
  /** Directory name under fixturesRoot containing package.json and package-lock.json. */
  fixture: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface NpmInstallRunnerOptions {
  executor: ProcessExecutor;
  /** Absolute directory whose direct subdirectories are the controlled fixtures (read only by the host). */
  fixturesRoot: string;
  /** Absolute backend-owned directory where the two validated files are staged. Must exist. */
  stagingRoot: string;
  /** Absolute operator-supplied, prepopulated npm cache. Mounted read-only. Absent: every install is not-run. */
  cacheDir: string;
  /** Default node:22-alpine. Must contain npm and exist locally; never pulled. */
  image?: string;
  limits?: Partial<SandboxLimits>;
  dockerBinary?: string;
  /** Injectable for tests. */
  realpath?: (path: string) => string;
}

const FIXTURE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ADDED_RE = /^added (\d{1,6}) packages? in [^\r\n]{1,24}\r?$/gm;
const STAGED_NAMES: readonly string[] = [
  NPM_GLOBALCONFIG_NAME, NPM_USERCONFIG_NAME, "node_modules", "package-lock.json", "package.json",
].sort();

// ---------------------------------------------------------------------------
// Pure classification (exported for tests)
// ---------------------------------------------------------------------------

/** The last `added N packages in <time>` line at the start of a line, or null. */
export function parseNpmAdded(stdout: string): number | null {
  let last: number | null = null;
  for (const m of stdout.matchAll(ADDED_RE)) last = Number(m[1]);
  return last;
}

interface Verdict {
  status: InstallStatus;
  reason: InstallReason;
  detail: string;
  packagesAdded: number | null;
}

const verdict = (status: InstallStatus, reason: InstallReason, detail: string, packagesAdded: number | null = null): Verdict =>
  ({ status, reason, detail, packagesAdded });

export function classifyInstall(r: SandboxResult, expectedPackages: number): Verdict {
  switch (r.kind) {
    case "timed-out":
      return verdict("not-run", "timed-out", "npm hit its time limit; result is inconclusive");
    case "aborted":
      return verdict("not-run", "aborted", "the install was cancelled; result is inconclusive");
    case "isolation-violation":
      return verdict("not-run", "isolation-violation", `container was not started: ${r.reason}`);
    case "unavailable":
      return verdict("not-run", "docker-unavailable", r.reason);
    case "rejected":
      return verdict("not-run", "rejected", r.reason);
    case "exited":
      break;
  }
  if (r.exitCode !== 0) return verdict("failure", "npm-exit-nonzero", `npm ci exited with code ${r.exitCode}`);
  if (r.truncated) return verdict("not-run", "output-truncated", "npm output was truncated; cannot verify the summary");
  const added = parseNpmAdded(r.stdout);
  if (added === null) return verdict("not-run", "summary-missing", "npm exited 0 but printed no `added N packages` summary");
  if (added !== expectedPackages) {
    return verdict("not-run", "summary-mismatch", `npm reported ${added} package(s), the lockfile lists ${expectedPackages}`, added);
  }
  return verdict("success", "ok", `npm ci added ${added} package(s) offline`, added);
}

// ---------------------------------------------------------------------------
// Host-side file helpers
// ---------------------------------------------------------------------------

type ReadResult = { kind: "missing" } | { kind: "other" } | { kind: "too-large" } | { kind: "file"; text: string };

function readCapped(path: string, max: number): ReadResult {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "other" };
  }
  if (!st.isFile()) return { kind: "other" }; // symlinks, directories, devices
  if (st.size > max) return { kind: "too-large" };
  try {
    return { kind: "file", text: readFileSync(path, "utf8") };
  } catch {
    return { kind: "other" };
  }
}

/** Writes exactly the staged entries (two inputs, two empty npm configs, node_modules) into a directory this runner just created. */
function fillStaged(dir: string, pkgText: string, lockText: string): void {
  writeFileSync(join(dir, NPM_USERCONFIG_NAME), "", { flag: "wx", mode: 0o644 });
  writeFileSync(join(dir, NPM_GLOBALCONFIG_NAME), "", { flag: "wx", mode: 0o644 });
  writeFileSync(join(dir, "package.json"), pkgText, { flag: "wx", mode: 0o644 });
  writeFileSync(join(dir, "package-lock.json"), lockText, { flag: "wx", mode: 0o644 });
  mkdirSync(join(dir, "node_modules"));
}

/** Captured output exists only when the container actually ran. */
function outputOf(r: SandboxResult): { exitCode: number | null; durationMs: number | null; truncated: boolean; stdout: string; stderr: string } {
  if (r.kind === "exited" || r.kind === "timed-out" || r.kind === "aborted") {
    return {
      exitCode: r.kind === "exited" ? r.exitCode : null,
      durationMs: r.durationMs,
      truncated: r.truncated,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  }
  return { exitCode: null, durationMs: null, truncated: false, stdout: "", stderr: "" };
}

/** Removes only the three expected staged entries. Anything unexpected is left in place and reported. Never throws. */
export function removeStaged(dir: string): { removed: boolean; problem: string | null } {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return { removed: false, problem: "staging path is not a real directory" };
    const names = readdirSync(dir).sort();
    if (names.length !== STAGED_NAMES.length || !names.every((n, i) => n === STAGED_NAMES[i])) {
      return { removed: false, problem: "staging directory has unexpected contents" };
    }
    const nm = join(dir, "node_modules");
    const nmStat = lstatSync(nm);
    if (nmStat.isSymbolicLink() || !nmStat.isDirectory() || readdirSync(nm).length !== 0) {
      return { removed: false, problem: "staged node_modules is not an empty directory" };
    }
    const files = ["package.json", "package-lock.json", NPM_USERCONFIG_NAME, NPM_GLOBALCONFIG_NAME];
    // Verify everything before deleting anything.
    for (const f of files) {
      const s = lstatSync(join(dir, f));
      if (!s.isFile()) return { removed: false, problem: `staged ${f} is not a regular file` };
      if ((f === NPM_USERCONFIG_NAME || f === NPM_GLOBALCONFIG_NAME) && s.size !== 0) {
        return { removed: false, problem: `staged ${f} is not empty` };
      }
    }
    for (const f of files) unlinkSync(join(dir, f));
    rmdirSync(nm);
    rmdirSync(dir);
    return { removed: true, problem: null };
  } catch (e) {
    return { removed: false, problem: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class NpmInstallRunner {
  private readonly sandbox: DockerFixtureSandbox | null;
  private readonly image: string;
  private readonly root: string | null;
  private readonly staging: string | null;
  private readonly unavailable: { reason: InstallReason; detail: string } | null;
  private readonly realpath: (p: string) => string;

  constructor(opts: NpmInstallRunnerOptions) {
    this.image = opts.image ?? NODE_FIXTURE_IMAGE;
    this.realpath = opts.realpath ?? ((p: string): string => realpathSync(p));
    let root: string | null = null;
    let staging: string | null = null;
    let sandbox: DockerFixtureSandbox | null = null;
    let unavailable: { reason: InstallReason; detail: string } | null = null;

    try {
      if (![opts.fixturesRoot, opts.stagingRoot, opts.cacheDir].every((p) => typeof p === "string" && isAbsolute(p))) {
        throw new Error("fixturesRoot, stagingRoot and cacheDir must be absolute paths");
      }
      root = this.realpath(resolve(opts.fixturesRoot));
      staging = this.realpath(resolve(opts.stagingRoot));
      if (root === staging) throw new Error("stagingRoot must differ from fixturesRoot");
    } catch (e) {
      unavailable = { reason: "unconfigured", detail: e instanceof Error ? e.message : "invalid roots" };
    }

    if (unavailable === null && staging !== null) {
      let cache: string | null = null;
      try {
        cache = this.realpath(resolve(opts.cacheDir));
        if (!lstatSync(cache).isDirectory()) cache = null;
      } catch {
        cache = null;
      }
      if (cache === null) {
        unavailable = { reason: "cache-unavailable", detail: "the offline npm cache directory does not exist; nothing was run" };
      } else {
        try {
          sandbox = new DockerFixtureSandbox({
            executor: opts.executor,
            allowedImages: [this.image],
            commands: { [NPM_INSTALL_COMMAND_ID]: NPM_CI_ARGV },
            fixturesRoot: staging,
            readonlyBinds: [{ source: cache, target: NPM_CACHE_MOUNT }],
            extraTmpfs: [{ target: NPM_MODULES_MOUNT, sizeMb: NODE_MODULES_TMPFS_MB }],
            limits: { ...DEFAULT_NPM_INSTALL_LIMITS, ...(opts.limits ?? {}) },
            realpath: this.realpath,
            ...(opts.dockerBinary === undefined ? {} : { dockerBinary: opts.dockerBinary }),
          });
        } catch (e) {
          unavailable = { reason: "unconfigured", detail: e instanceof Error ? e.message : "invalid sandbox configuration" };
        }
      }
    }
    this.root = root;
    this.staging = staging;
    this.sandbox = sandbox;
    this.unavailable = unavailable;
  }

  /** Never throws. Always reports container cleanup evidence when a container could exist. */
  async install(req: InstallRequest): Promise<InstallResult> {
    const executionId = typeof req?.executionId === "string" ? req.executionId : null;
    const notRun = (reason: InstallReason, detail: string, extra: Partial<InstallResult> = {}): InstallResult => ({
      status: "not-run", reason, detail, exitCode: null, durationMs: null, truncated: false,
      stdoutTail: "", stderrTail: "", packagesAdded: null, expectedPackages: null, violations: [],
      cleanup: null, stagingRemoved: null, executionId, ...extra,
    });

    if (req?.signal?.aborted === true) return notRun("aborted", "cancelled before start; nothing was created");
    if (this.unavailable !== null || this.sandbox === null || this.root === null || this.staging === null) {
      const u = this.unavailable ?? { reason: "unconfigured" as const, detail: "runner is not configured" };
      return notRun(u.reason, u.detail);
    }
    try {
      containerNameFor(req.executionId);
    } catch {
      return notRun("rejected", "invalid execution id");
    }
    if (typeof req.fixture !== "string" || !FIXTURE_NAME_RE.test(req.fixture)) return notRun("rejected", "invalid fixture name");

    // 1. Resolve the source directory inside the fixtures root.
    let source: string;
    try {
      source = this.realpath(resolve(this.root, req.fixture));
    } catch {
      return notRun("rejected", "fixture directory does not exist");
    }
    const rel = relative(this.root, source);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return notRun("rejected", "fixture escapes fixturesRoot");

    // 2. Read the two inputs. Nothing else in the directory is read.
    const pkg = readCapped(join(source, "package.json"), MAX_PACKAGE_JSON_BYTES);
    if (pkg.kind === "missing") return notRun("no-package-json", "fixture has no package.json; nothing was run");
    const lock = readCapped(join(source, "package-lock.json"), MAX_LOCKFILE_BYTES);
    if (lock.kind === "missing") return notRun("no-lockfile", "fixture has no package-lock.json; npm ci needs one and nothing was run");
    if (pkg.kind === "other" || lock.kind === "other") {
      return notRun("unreadable-input", "package.json or package-lock.json is not a readable regular file; nothing was run");
    }
    if (pkg.kind === "too-large" || lock.kind === "too-large") {
      return notRun("policy-rejected", "package.json or package-lock.json is larger than the allowed size", {
        violations: ["input file larger than the allowed size"],
      });
    }

    // 3. Static policy, before any process exists.
    const policy = checkNpmFixture(pkg.text, lock.text);
    if (!policy.ok) {
      return notRun("policy-rejected", `${policy.violations.length} policy violation(s); first: ${policy.violations[0] ?? ""}`, {
        violations: policy.violations,
      });
    }

    // 4. Stage exactly the validated bytes.
    const stagedDir = join(this.staging, req.fixture);
    try {
      mkdirSync(stagedDir); // non-recursive: an existing entry is refused and never touched
    } catch {
      return notRun("staging-failed", "could not create the staging directory (it may already exist); nothing was run", {
        expectedPackages: policy.packageCount,
      });
    }
    try {
      fillStaged(stagedDir, pkg.text, lock.text);
    } catch {
      const removal = removeStaged(stagedDir); // we created this directory, so partial contents are ours
      return notRun("staging-failed", "could not write the staged files; nothing was run", {
        expectedPackages: policy.packageCount,
        stagingRemoved: removal.removed,
      });
    }

    // 5. One fixed command in a disposable container.
    let res: SandboxResult | null = null;
    let cleanup: CleanupProof | null = null;
    try {
      res = await this.sandbox.execute({
        executionId: req.executionId,
        commandId: NPM_INSTALL_COMMAND_ID,
        image: this.image,
        fixture: req.fixture,
        ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
        ...(req.signal === undefined ? {} : { signal: req.signal }),
      });
      cleanup = res.cleanup;
    } catch {
      cleanup = await this.sandbox.cleanup({ executionId: req.executionId });
    }

    // 6. Remove the staged copy regardless of the outcome.
    const staged = removeStaged(stagedDir);

    if (res === null) {
      return notRun("docker-unavailable", "sandbox call failed unexpectedly", {
        expectedPackages: policy.packageCount, cleanup, stagingRemoved: staged.removed,
      });
    }

    let v = classifyInstall(res, policy.packageCount);
    if (v.status === "success" && cleanup?.confirmed !== true) {
      const why = cleanup === null ? "no cleanup proof" : cleanup.confirmed ? "" : cleanup.reason;
      v = { ...v, status: "not-run", reason: "cleanup-unconfirmed", detail: `container cleanup was not confirmed (${why}); success cannot be reported` };
    } else if (v.status === "success" && !staged.removed) {
      v = { ...v, status: "not-run", reason: "staging-cleanup-failed", detail: `staging directory was not removed (${staged.problem ?? "unknown"}); success cannot be reported` };
    }

    const out = outputOf(res);
    return {
      status: v.status,
      reason: v.reason,
      detail: v.detail,
      exitCode: out.exitCode,
      durationMs: out.durationMs,
      truncated: out.truncated,
      stdoutTail: tailOf(out.stdout),
      stderrTail: tailOf(out.stderr),
      packagesAdded: v.packagesAdded,
      expectedPackages: policy.packageCount,
      violations: [],
      cleanup,
      stagingRemoved: staged.removed,
      executionId,
    };
  }
}
