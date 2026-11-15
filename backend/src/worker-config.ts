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
 * @module worker-config
 */

import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { LOG_LEVELS, type LogLevel } from "./config.js";
import { validateGithubUrl } from "./url.js";
import { FIXTURE_NAME_RE } from "./pipeline-runner.js";

export const WORKER_ENABLE_VAR = "GRAVEYARD_WORKER_ENABLED";
export const MAX_CATALOG_BYTES = 16 * 1024;
export const MAX_CATALOG_ENTRIES = 50;

export type AgentMode = "off" | "kiro-v2" | "kiro-v3";

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
  };
}
