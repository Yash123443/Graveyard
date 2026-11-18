/**
 * worker-config.ts — configuration for the explicit, opt-in local worker process.
 *
 * Pure validation: reads only the injected environment and, through an injectable reader, the
 * operator's catalog file. It touches no database, no Docker and no directories (existence of
 * directories and fixtures is checked at composition time, worker-compose.ts).
 *
 * Opt-in. The worker does nothing unless GRAVEYARD_WORKER_ENABLED is exactly "1". Every other
 * value, including unset, "true", "yes" and " 1", is "disabled". Nothing in the API server reads
 * these variables or starts a worker.
 *
 * Operator catalog. A JSON file mapping canonical GitHub repository URLs to the names of fixture
 * directories the operator prepared under GRAVEYARD_FIXTURES_ROOT. A job whose URL is not a key is
 * refused by the runner; there is no setting that enables arbitrary repositories.
 *
 * Variables (all required unless a default is shown):
 *   GRAVEYARD_WORKER_ENABLED     must be "1"
 *   DATABASE_PATH                file path shared with the API (default ./data/graveyard.sqlite); ":memory:" refused
 *   GRAVEYARD_FIXTURES_ROOT      absolute directory of prepared fixtures (read only)
 *   GRAVEYARD_STAGING_ROOT       absolute, existing, worker-owned directory for staged copies
 *   GRAVEYARD_NPM_CACHE_DIR      absolute, prepopulated offline npm cache (mounted read-only)
 *   GRAVEYARD_FIXTURE_CATALOG    absolute path of the catalog JSON file (at most 16 KiB, 1 to 50 entries)
 *   GRAVEYARD_WORKER_ID          optional, [A-Za-z0-9._-]{1,64} (default worker-<pid>-<random>)
 *   GRAVEYARD_WORKER_POLL_MS     250..60000 (default 2000)
 *   GRAVEYARD_WORKER_RECOVER_MS  5000..600000 (default 30000)
 *   GRAVEYARD_WORKER_BATCH       1..20 jobs per drain before the next poll (default 5)
 *   GRAVEYARD_WORKER_SHUTDOWN_MS 1000..120000 hard exit watchdog after a stop signal (default 45000)
 *   GRAVEYARD_WORKER_AGENTS      off | kiro-v2 | kiro-v3 (default off; anything else is refused)
 *   LOG_LEVEL                    as for the API (default info)
 *
 * GitHub flow (optional; github-runner.ts). Setting ANY of the variables below turns it on and then
 * GRAVEYARD_GITHUB_CATALOG, GRAVEYARD_GITHUB_RUNS_ROOT and the three GRAVEYARD_GITHUB_EGRESS_* are required:
 *   GRAVEYARD_GITHUB_CATALOG     absolute path of a JSON file (at most 16 KiB, 1 to 50 entries) mapping canonical
 *                                repository URLs to FULL 40-hex commit SHAs the operator pinned. A URL may not
 *                                also be in the fixture catalog.
 *   GRAVEYARD_GITHUB_RUNS_ROOT   absolute, existing, worker-owned directory (separate from the other three roots)
 *   GRAVEYARD_GITHUB_GIT_IMAGE   local image with git and sleep, never pulled (default alpine/git:2.47.2)
 *   GRAVEYARD_GITHUB_EGRESS_NETWORK / _PROXY_CONTAINER / _PROXY_URL
 *                                operator-provisioned internal network and github.com-only proxy (egress-guard.ts)
 *   GRAVEYARD_REGISTRY_EGRESS_NETWORK / _PROXY_CONTAINER / _PROXY_URL
 *                                optional, all three or none: the registry.npmjs.org-only counterpart. Without it
 *                                repositories in the supported class are reported as not runnable.
 *   GRAVEYARD_GITHUB_ALLOW_UNPINNED
 *                                optional, exactly "1" (on) or "0" (off, default). On: a URL in neither catalog is fetched
 *                                at its literal HEAD in the guarded git container, resolved to a SHA and its root files read
 *                                as data; the job completes as "source-inspected". Nothing from it is installed, built or run
 *                                and no source goes to Kiro. It makes GRAVEYARD_GITHUB_CATALOG optional (an omitted catalog
 *                                means no pins); the runs root, git image and all github.com egress variables stay required.
 *   GRAVEYARD_GITHUB_NPM_SCRIPTS
 *                                optional, exactly "1" (on) or "0" (off, default). On: a PINNED repository whose package.json
 *                                declares scripts and fits the npm-scripts profile (npm-scripts-policy.ts) has a bounded source
 *                                snapshot run offline with `npm run build` and `npm run test` in the sandbox. Requires
 *                                GRAVEYARD_GITHUB_CATALOG and the GRAVEYARD_REGISTRY_EGRESS_* variables. No agent, no patch.
 *   GRAVEYARD_GITHUB_NPM_DEV_DEPENDENCIES
 *                                optional, exactly "1" (on) or "0" (off, default); "1" requires GRAVEYARD_GITHUB_NPM_SCRIPTS=1.
 *                                On: the npm-scripts profile also accepts flat, unscoped devDependencies (the whole lock stays
 *                                within the existing 8-package, 64 KiB bounds), acquired and installed with
 *                                `--include=dev --ignore-scripts`. Off: any devDependencies make the project unsupported.
 *   The proxy URLs must be http://<private IPv4>:<port>. Nothing here changes the default: without these
 *   variables the worker runs only operator fixtures and no network guard ever attests.
 *
 * @module worker-config
 */

import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { LOG_LEVELS, type LogLevel } from "./config.js";
import { GIT_SHA_RE } from "./acquisition-policy.js";
import { validateGithubUrl } from "./url.js";
import { FIXTURE_NAME_RE } from "./pipeline-runner.js";

export const WORKER_ENABLE_VAR = "GRAVEYARD_WORKER_ENABLED";
export const MAX_CATALOG_BYTES = 16 * 1024;
export const MAX_CATALOG_ENTRIES = 50;

/** Setting any of these (except as documented) turns on the GitHub flow and requires the rest. */
export const GITHUB_ENV_VARS: readonly string[] = Object.freeze([
  "GRAVEYARD_GITHUB_CATALOG",
  "GRAVEYARD_GITHUB_RUNS_ROOT",
  "GRAVEYARD_GITHUB_GIT_IMAGE",
  "GRAVEYARD_GITHUB_EGRESS_NETWORK",
  "GRAVEYARD_GITHUB_EGRESS_PROXY_CONTAINER",
  "GRAVEYARD_GITHUB_EGRESS_PROXY_URL",
  "GRAVEYARD_REGISTRY_EGRESS_NETWORK",
  "GRAVEYARD_REGISTRY_EGRESS_PROXY_CONTAINER",
  "GRAVEYARD_REGISTRY_EGRESS_PROXY_URL",
  "GRAVEYARD_GITHUB_ALLOW_UNPINNED",
  "GRAVEYARD_GITHUB_NPM_SCRIPTS",
  "GRAVEYARD_GITHUB_NPM_DEV_DEPENDENCIES",
]);
export const ALLOW_UNPINNED_VAR = "GRAVEYARD_GITHUB_ALLOW_UNPINNED";
export const NPM_SCRIPTS_VAR = "GRAVEYARD_GITHUB_NPM_SCRIPTS";
export const NPM_DEV_DEPENDENCIES_VAR = "GRAVEYARD_GITHUB_NPM_DEV_DEPENDENCIES";
export const DEFAULT_GIT_IMAGE = "alpine/git:2.47.2";
const IMAGE_RE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;
const EGRESS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const FORBIDDEN_NETWORK_NAMES = new Set(["bridge", "host", "none", "default", "docker_gwbridge", "ingress"]);
const PRIVATE_PROXY_RE = /^http:\/\/(?:10\.[0-9]{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])|192\.168)\.[0-9]{1,3}\.[0-9]{1,3}:[1-9][0-9]{0,4}$/;

export type AgentMode = "off" | "kiro-v2" | "kiro-v3";

/** Operator-provisioned proxy topology for one target host (see egress-guard.ts). */
export interface EgressSettings {
  network: string;
  proxyContainer: string;
  proxyUrl: string;
}

/**
 * The GitHub flow (github-runner.ts). Present only when the operator set GRAVEYARD_GITHUB_CATALOG
 * and everything it needs. Its absence leaves the worker exactly as it was: fixtures only.
 */
export interface GithubConfig {
  /** Absolute path of the pin catalog, or "" when it was omitted (allowed only with allowUnpinned). */
  catalogPath: string;
  /** Canonical repository URL to the full lowercase 40-hex commit the operator pinned. May be empty only with allowUnpinned. */
  pins: Readonly<Record<string, string>>;
  /**
   * Opt-in (GRAVEYARD_GITHUB_ALLOW_UNPINNED=1): URLs in neither catalog are inspected at their
   * resolved HEAD and reported as "source-inspected". Nothing from them is installed, built or run.
   * Absent or false: unchanged behaviour.
   */
  allowUnpinned?: boolean;
  /**
   * Opt-in (GRAVEYARD_GITHUB_NPM_SCRIPTS=1): a PINNED repository whose package.json declares
   * `scripts` and fits the npm-scripts profile has its `npm run build` and `npm run test` run offline
   * in the sandbox. Requires the registry egress variables. Present only when true; absent: off.
   */
  npmScripts?: boolean;
  /**
   * Opt-in (GRAVEYARD_GITHUB_NPM_DEV_DEPENDENCIES=1, requires npmScripts): the shared dev-dependency
   * policy option. Flat unscoped `devDependencies` (for example `typescript`) are then accepted by the
   * npm-scripts profile, acquired with `--include=dev` and installed the same way offline. Present only
   * when true; absent: the production-only profile.
   */
  npmDevDependencies?: boolean;
  /** Existing worker-owned directory; one run directory per job is created inside it. */
  runsRoot: string;
  gitImage: string;
  /** github.com-only proxy topology. */
  gitEgress: EgressSettings;
  /** registry.npmjs.org-only proxy topology. Null: supported repositories are reported as not runnable. */
  registryEgress: EgressSettings | null;
}

export interface WorkerConfig {
  databasePath: string;
  fixturesRoot: string;
  stagingRoot: string;
  cacheDir: string;
  catalogPath: string;
  /** Canonical repository URL to fixture directory name. */
  catalog: Readonly<Record<string, string>>;
  workerId: string;
  pollMs: number;
  recoverMs: number;
  batch: number;
  shutdownMs: number;
  agents: AgentMode;
  logLevel: LogLevel;
  /** Absent or null: the GitHub flow is off. */
  github?: GithubConfig | null;
}

/** The opt-in switch is not set. Not a failure of configuration. */
export class WorkerDisabledError extends Error {
  constructor() {
    super(`worker is disabled: set ${WORKER_ENABLE_VAR}=1 to run it`);
    this.name = "WorkerDisabledError";
  }
}

export class WorkerConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Worker configuration error(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "WorkerConfigError";
    this.problems = problems;
  }
}

export interface ConfigDeps {
  /** Reads the catalog file. Must throw when it is not a regular file or is larger than MAX_CATALOG_BYTES. */
  readCatalog?: (path: string) => string;
  /** Source of the default worker id suffix. */
  randomId?: () => string;
  pid?: number;
}

export function isWorkerEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[WORKER_ENABLE_VAR] === "1";
}

function defaultReadCatalog(path: string): string {
  const st = lstatSync(path); // lstat: a symlink is not a regular file and is refused
  if (!st.isFile()) throw new Error("not a regular file");
  if (st.size > MAX_CATALOG_BYTES) throw new Error("too large");
  return readFileSync(path, "utf8");
}

function intVar(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[0-9]{1,9}$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return Number(raw);
}

function absPath(env: NodeJS.ProcessEnv, name: string, problems: string[]): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    problems.push(`${name} is required`);
    return "";
  }
  if (raw.length > 1024 || raw.includes("\0") || !isAbsolute(raw)) {
    problems.push(`${name} must be an absolute path`);
    return "";
  }
  return resolve(raw);
}

function sameOrInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Parses the operator catalog. Every key must already be the canonical form that
 * validateGithubUrl produces (so lookups by a job's canonical URL are exact); every value must be a
 * safe fixture directory name. Returns the catalog or the problems found.
 */
export function parseCatalog(text: string): { ok: true; catalog: Record<string, string> } | { ok: false; problems: string[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["catalog is not valid JSON"] };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, problems: ["catalog must be a JSON object mapping repository URLs to fixture names"] };
  }
  const entries = Object.entries(doc as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, problems: ["catalog has no entries; the worker would have nothing it may run"] };
  if (entries.length > MAX_CATALOG_ENTRIES) return { ok: false, problems: [`catalog has more than ${MAX_CATALOG_ENTRIES} entries`] };

  const problems: string[] = [];
  const catalog: Record<string, string> = {};
  entries.forEach(([url, fixture], i) => {
    const v = validateGithubUrl(url);
    if (!v.ok || v.url !== url) problems.push(`catalog entry ${i + 1}: key is not a canonical GitHub repository URL`);
    if (typeof fixture !== "string" || !FIXTURE_NAME_RE.test(fixture)) {
      problems.push(`catalog entry ${i + 1}: fixture name must match ${String(FIXTURE_NAME_RE)}`);
    }
    if (problems.length === 0 && typeof fixture === "string") catalog[url] = fixture;
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, catalog };
}

/**
 * Parses the GitHub pin catalog: canonical repository URL -> full lowercase 40-hex commit. Branches,
 * tags and abbreviated ids are refused, so a job can only ever fetch the exact commit the operator chose.
 */
export function parsePins(text: string): { ok: true; pins: Record<string, string> } | { ok: false; problems: string[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["GitHub catalog is not valid JSON"] };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, problems: ["GitHub catalog must be a JSON object mapping repository URLs to full commit SHAs"] };
  }
  const entries = Object.entries(doc as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, problems: ["GitHub catalog has no entries"] };
  if (entries.length > MAX_CATALOG_ENTRIES) return { ok: false, problems: [`GitHub catalog has more than ${MAX_CATALOG_ENTRIES} entries`] };
  const problems: string[] = [];
  const pins: Record<string, string> = {};
  entries.forEach(([url, commit], i) => {
    const v = validateGithubUrl(url);
    if (!v.ok || v.url !== url) problems.push(`GitHub catalog entry ${i + 1}: key is not a canonical GitHub repository URL`);
    if (typeof commit !== "string" || !GIT_SHA_RE.test(commit)) {
      problems.push(`GitHub catalog entry ${i + 1}: commit must be a full 40-character lowercase hex SHA`);
    }
    if (problems.length === 0 && typeof commit === "string") pins[url] = commit;
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, pins };
}

function egressSettings(env: NodeJS.ProcessEnv, prefix: string, required: boolean, problems: string[]): EgressSettings | null {
  const names = [`${prefix}_NETWORK`, `${prefix}_PROXY_CONTAINER`, `${prefix}_PROXY_URL`] as const;
  const any = names.some((n) => env[n] !== undefined);
  if (!any) {
    if (required) problems.push(`${names.join(", ")} are required`);
    return null;
  }
  const missing = names.filter((n) => env[n] === undefined || env[n] === "");
  if (missing.length > 0) {
    problems.push(`${missing.join(", ")} must be set together with the other ${prefix}_* variables`);
    return null;
  }
  const network = env[names[0]] as string;
  const proxyContainer = env[names[1]] as string;
  const proxyUrl = env[names[2]] as string;
  let ok = true;
  if (!EGRESS_NAME_RE.test(network) || FORBIDDEN_NETWORK_NAMES.has(network.toLowerCase())) {
    problems.push(`${names[0]} must be a dedicated user-defined Docker network name, not a default network`);
    ok = false;
  }
  if (!EGRESS_NAME_RE.test(proxyContainer)) {
    problems.push(`${names[1]} must match [A-Za-z0-9][A-Za-z0-9_.-]{0,63}`);
    ok = false;
  }
  const portOk = ((): boolean => {
    const m = /:([0-9]{1,5})$/.exec(proxyUrl);
    return m !== null && Number(m[1]) >= 1 && Number(m[1]) <= 65535;
  })();
  if (!PRIVATE_PROXY_RE.test(proxyUrl) || !portOk) {
    problems.push(`${names[2]} must be http://<private IPv4 literal>:<port>`);
    ok = false;
  }
  return ok ? { network, proxyContainer, proxyUrl } : null;
}

function loadGithubConfig(
  env: NodeJS.ProcessEnv,
  deps: ConfigDeps,
  problems: string[],
  otherDirs: ReadonlyArray<[string, string]>,
  fixtureCatalog: Readonly<Record<string, string>>,
): GithubConfig | null {
  const before = problems.length;
  // Unpinned intake is opt-in and exactly "1"; "0" is explicit off; anything else is a mistake.
  const unpinnedRaw = env[ALLOW_UNPINNED_VAR];
  let allowUnpinned = false;
  if (unpinnedRaw === "1") allowUnpinned = true;
  else if (unpinnedRaw !== undefined && unpinnedRaw !== "0") problems.push(`${ALLOW_UNPINNED_VAR} must be exactly 1 or 0`);

  // npm-scripts mode is opt-in and exactly "1"; "0" is explicit off; anything else is a mistake.
  const scriptsRaw = env[NPM_SCRIPTS_VAR];
  let npmScripts = false;
  if (scriptsRaw === "1") npmScripts = true;
  else if (scriptsRaw !== undefined && scriptsRaw !== "0") problems.push(`${NPM_SCRIPTS_VAR} must be exactly 1 or 0`);

  // The dev-dependency option is opt-in, exactly "1", and only meaningful with npm-scripts mode.
  const devRaw = env[NPM_DEV_DEPENDENCIES_VAR];
  let npmDevDependencies = false;
  if (devRaw === "1") npmDevDependencies = true;
  else if (devRaw !== undefined && devRaw !== "0") problems.push(`${NPM_DEV_DEPENDENCIES_VAR} must be exactly 1 or 0`);
  if (npmDevDependencies && !npmScripts) problems.push(`${NPM_DEV_DEPENDENCIES_VAR}=1 requires ${NPM_SCRIPTS_VAR}=1`);

  // The pin catalog is optional ONLY when unpinned intake is enabled. All other settings stay required.
  const catalogGiven = env["GRAVEYARD_GITHUB_CATALOG"] !== undefined;
  if (!catalogGiven && !allowUnpinned) {
    problems.push(
      `GRAVEYARD_GITHUB_CATALOG is required when any other GRAVEYARD_GITHUB_* or GRAVEYARD_REGISTRY_* variable is set (it is optional only with ${ALLOW_UNPINNED_VAR}=1)`,
    );
    return null;
  }
  const catalogPath = catalogGiven ? absPath(env, "GRAVEYARD_GITHUB_CATALOG", problems) : "";
  const runsRoot = absPath(env, "GRAVEYARD_GITHUB_RUNS_ROOT", problems);
  if (runsRoot !== "") {
    for (const [name, dir] of otherDirs) {
      if (dir !== "" && (sameOrInside(runsRoot, dir) || sameOrInside(dir, runsRoot))) {
        problems.push(`GRAVEYARD_GITHUB_RUNS_ROOT and ${name} must be separate directories (neither may equal or contain the other)`);
      }
    }
  }
  const gitImage = env["GRAVEYARD_GITHUB_GIT_IMAGE"] ?? DEFAULT_GIT_IMAGE;
  if (gitImage.length > 255 || !IMAGE_RE.test(gitImage)) problems.push("GRAVEYARD_GITHUB_GIT_IMAGE is not a valid image reference");

  const gitEgress = egressSettings(env, "GRAVEYARD_GITHUB_EGRESS", true, problems);
  const registryEgress = egressSettings(env, "GRAVEYARD_REGISTRY_EGRESS", false, problems);
  if (npmScripts && registryEgress === null) {
    problems.push(`${NPM_SCRIPTS_VAR}=1 requires the GRAVEYARD_REGISTRY_EGRESS_* variables (dependencies must be acquired through the registry-only proxy)`);
  }
  if (npmScripts && !catalogGiven) {
    problems.push(`${NPM_SCRIPTS_VAR}=1 applies to pinned repositories only and therefore requires GRAVEYARD_GITHUB_CATALOG`);
  }
  if (gitEgress !== null && registryEgress !== null) {
    if (gitEgress.network === registryEgress.network || gitEgress.proxyContainer === registryEgress.proxyContainer) {
      problems.push("the GitHub and registry egress must use different networks and different proxy containers");
    }
  }

  let pins: Record<string, string> = {};
  if (catalogPath !== "") {
    let text: string | null = null;
    try {
      text = (deps.readCatalog ?? defaultReadCatalog)(catalogPath);
    } catch {
      problems.push(`GRAVEYARD_GITHUB_CATALOG must be a regular file of at most ${MAX_CATALOG_BYTES} bytes`);
    }
    if (text !== null) {
      if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) {
        problems.push(`GRAVEYARD_GITHUB_CATALOG must be a regular file of at most ${MAX_CATALOG_BYTES} bytes`);
      } else {
        const parsed = parsePins(text);
        if (parsed.ok) pins = parsed.pins;
        else problems.push(...parsed.problems);
      }
    }
  }
  for (const url of Object.keys(pins)) {
    if (Object.prototype.hasOwnProperty.call(fixtureCatalog, url)) {
      problems.push("a repository URL may be in the fixture catalog or the GitHub catalog, not both");
      break;
    }
  }

  if (problems.length > before || gitEgress === null) return null;
  return { catalogPath, pins: Object.freeze(pins), runsRoot, gitImage, gitEgress, registryEgress, allowUnpinned, ...(npmScripts ? { npmScripts: true } : {}), ...(npmScripts && npmDevDependencies ? { npmDevDependencies: true } : {}) };
}

/**
 * Validates the environment. Throws WorkerDisabledError when the opt-in switch is not "1", and
 * WorkerConfigError (listing every problem, never any secret) when anything else is invalid.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env, deps: ConfigDeps = {}): WorkerConfig {
  if (!isWorkerEnabled(env)) throw new WorkerDisabledError();

  const problems: string[] = [];

  let databasePath = env["DATABASE_PATH"] ?? "./data/graveyard.sqlite";
  if (databasePath.trim() === "") {
    problems.push("DATABASE_PATH must be a non-empty string");
    databasePath = "./data/graveyard.sqlite";
  } else if (databasePath === ":memory:") {
    problems.push("DATABASE_PATH must be a file shared with the API; :memory: cannot be shared between processes");
  }

  const fixturesRoot = absPath(env, "GRAVEYARD_FIXTURES_ROOT", problems);
  const stagingRoot = absPath(env, "GRAVEYARD_STAGING_ROOT", problems);
  const cacheDir = absPath(env, "GRAVEYARD_NPM_CACHE_DIR", problems);
  const catalogPath = absPath(env, "GRAVEYARD_FIXTURE_CATALOG", problems);

  const named: Array<[string, string]> = [
    ["GRAVEYARD_FIXTURES_ROOT", fixturesRoot],
    ["GRAVEYARD_STAGING_ROOT", stagingRoot],
    ["GRAVEYARD_NPM_CACHE_DIR", cacheDir],
  ];
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      const [an, a] = named[i] as [string, string];
      const [bn, b] = named[j] as [string, string];
      if (a !== "" && b !== "" && (sameOrInside(a, b) || sameOrInside(b, a))) {
        problems.push(`${an} and ${bn} must be separate directories (neither may equal or contain the other)`);
      }
    }
  }

  let workerId = env["GRAVEYARD_WORKER_ID"];
  if (workerId === undefined) {
    const suffix = (deps.randomId ?? ((): string => randomBytes(4).toString("hex")))();
    workerId = `worker-${String(deps.pid ?? process.pid)}-${suffix}`;
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(workerId)) {
    problems.push("GRAVEYARD_WORKER_ID must match [A-Za-z0-9._-]{1,64}");
    workerId = "worker-invalid";
  }

  const pollMs = intVar(env, "GRAVEYARD_WORKER_POLL_MS", 2_000, 250, 60_000, problems);
  const recoverMs = intVar(env, "GRAVEYARD_WORKER_RECOVER_MS", 30_000, 5_000, 600_000, problems);
  const batch = intVar(env, "GRAVEYARD_WORKER_BATCH", 5, 1, 20, problems);
  const shutdownMs = intVar(env, "GRAVEYARD_WORKER_SHUTDOWN_MS", 45_000, 1_000, 120_000, problems);

  const agentRaw = env["GRAVEYARD_WORKER_AGENTS"] ?? "off";
  let agents: AgentMode = "off";
  if (agentRaw === "off" || agentRaw === "kiro-v2" || agentRaw === "kiro-v3") agents = agentRaw;
  else problems.push("GRAVEYARD_WORKER_AGENTS must be one of off, kiro-v2, kiro-v3");

  const levelRaw = env["LOG_LEVEL"] ?? "info";
  let logLevel: LogLevel = "info";
  if ((LOG_LEVELS as readonly string[]).includes(levelRaw)) logLevel = levelRaw as LogLevel;
  else problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);

  let catalog: Record<string, string> = {};
  if (catalogPath !== "") {
    let text: string | null = null;
    try {
      text = (deps.readCatalog ?? defaultReadCatalog)(catalogPath);
    } catch {
      problems.push(`GRAVEYARD_FIXTURE_CATALOG must be a regular file of at most ${MAX_CATALOG_BYTES} bytes`);
    }
    if (text !== null) {
      if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) {
        problems.push(`GRAVEYARD_FIXTURE_CATALOG must be a regular file of at most ${MAX_CATALOG_BYTES} bytes`);
      } else {
        const parsed = parseCatalog(text);
        if (parsed.ok) catalog = parsed.catalog;
        else problems.push(...parsed.problems);
      }
    }
  }

  let github: GithubConfig | null = null;
  if (GITHUB_ENV_VARS.some((n) => env[n] !== undefined)) {
    github = loadGithubConfig(
      env,
      deps,
      problems,
      [
        ["GRAVEYARD_FIXTURES_ROOT", fixturesRoot],
        ["GRAVEYARD_STAGING_ROOT", stagingRoot],
        ["GRAVEYARD_NPM_CACHE_DIR", cacheDir],
      ],
      catalog,
    );
  }

  if (problems.length > 0) throw new WorkerConfigError(problems);

  return {
    databasePath,
    fixturesRoot,
    stagingRoot,
    cacheDir,
    catalogPath,
    catalog: Object.freeze(catalog),
    workerId,
    pollMs,
    recoverMs,
    batch,
    shutdownMs,
    agents,
    logLevel,
    github,
  };
}
