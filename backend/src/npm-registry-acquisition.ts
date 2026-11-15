/**
 * npm-registry-acquisition.ts — controlled, network-ACQUIRING `npm ci` of ONE FIXED public package
 * (`is-number@7.0.0`) from `registry.npmjs.org`, followed by a verified cache handoff that the
 * network-none build/test stage (controlled-pipeline.ts) can mount read-only.
 *
 * Foundation only. NOT a JobRunner, NOT wired to the server, worker or any job. It accepts no
 * repository, no URL and no package name from a request. Two fixture modes exist:
 *  - FIXED_FIXTURE_ID (default, unchanged, externally verified): the bytes of package.json and
 *    package-lock.json are the constants below and `operatorFixture` must be absent;
 *  - OPERATOR_FIXTURE_ID (added later by Kiro, NOT compiled or run): the CALLER (operator code, never
 *    an HTTP request) passes the two file texts in `operatorFixture`. They must pass
 *    checkOperatorFixture (npm-operator-fixture.ts): the unchanged lock policy first, then at most 8
 *    flat, unscoped, production-only registry packages from a lockfileVersion 3 lock of at most
 *    64 KiB. A rejected fixture returns `rejected` before the attestation or Docker is contacted.
 *    Everything after that point (egress gates, container isolation, `--ignore-scripts`, cleanup
 *    proof, host-verified cache handoff bound to every lockfile integrity) is the same code path.
 * The default egress guard still never attests, so by default neither mode creates anything.
 * Written without running anything: until an operator runs the tests and the opt-in harness
 * (test/manual-registry-acquisition-check.ts), the operator mode is not verified.
 *
 * Order of operations. Each step fails closed; nothing later runs if an earlier step refuses:
 *  1. request validation (execution id, fixed fixture id, allowlisted image, real run directory);
 *  2. the injected EgressGuard must attest a dedicated network, an `http://<private IPv4>:<port>`
 *     proxy and exactly `["registry.npmjs.org"]`. The default guard (UnavailableEgressGuard)
 *     never attests, so by default nothing is created. THIS MODULE NEVER ATTESTS ANYTHING ITSELF;
 *  3. `docker network inspect` must show that exact network as an `Internal` bridge network
 *     without IPv6, whose IPAM subnet contains the proxy address (not the gateway);
 *  4. package.json and package-lock.json must equal the fixed constants AND pass checkNpmFixture
 *     (registry-form lock, sha512 integrity, no scripts, no git/url/file specifiers);
 *  5. the trusted compiled driver (npm-acquire-driver.js, optionally pinned by sha256) and those two
 *     files are staged into a fresh directory, mounted read-only at /fixture. No .npmrc, no token,
 *     no host environment variable, no Docker socket, no other mount;
 *  6. one disposable container: the attested network ONLY (never the default bridge), non-root,
 *     all capabilities dropped, no-new-privileges, read-only root, bounded tmpfs /tmp and /work,
 *     bounded memory/pids/cpu/time/output, `--pull never`. Its configuration is read back with
 *     `docker inspect` and compared with the intent BEFORE it is started. The only command is
 *     `node /fixture/npm-acquire-driver.mjs` (fixed argv, no shell, no request input);
 *  7. the container is removed with proof (inspect + label query) and the staging directory is
 *     removed. Only then is the report looked at;
 *  8. the report is parsed strictly, npm's own `added N packages` must equal the lock's package
 *     count, and the exported cache files are verified and written by the HOST
 *     (npm-registry-cache.ts: exact cacache paths, SHA-512 of content equals its path, tarball bound
 *     to the lockfile integrity, bounded, confined writes, lstat audit, re-read and compare).
 *
 * What a result means:
 *  - `acquired`: the container ran to exit 0, cleanup and staging removal are confirmed, and the
 *    handoff cache on disk passed every check above. Nothing more. In particular it does NOT prove
 *    the network is isolated (the attestation is the guard's claim), that the proxy enforces its
 *    allowlist, or that npm will accept the cache offline (the next stage decides that).
 *  - every other kind is a refusal. None of them is a verdict on the package.
 *
 * Not covered: arbitrary packages or repositories (deliberately), install scripts (disabled by
 * flag and absent from the fixed lock, not sandbox-proven), npm behaving as modelled (unobserved:
 * proxy flags, `added` line, cache layout), IPv6 inside the container (the network is required to
 * be IPv4-only; no sysctl is set), DNS inside the internal network, a trusted Docker daemon.
 *
 * @module npm-registry-acquisition
 */

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitize, validateEgressAttestation, type EgressGuard } from "./acquisition-policy.js";
import { removeStagedPipeline } from "./controlled-pipeline.js";
import type { ProcessExecutor, ProcessResult } from "./docker-sandbox.js";
import { NODE_FIXTURE_IMAGE } from "./node-fixture-runner.js";
import { ACQUIRE_PROXY_ENV, EXIT_FAILED, EXIT_PASSED, parsePrivateProxyUrl } from "./npm-acquire-driver.js";
import { parseNpmAdded } from "./npm-install-runner.js";
import { MAX_LOCKFILE_BYTES, MAX_PACKAGE_JSON_BYTES, checkNpmFixture } from "./npm-lock-policy.js";
import { checkOperatorFixture } from "./npm-operator-fixture.js";
import {
  handoffNpmCache,
  parseAcquireOutput,
  type AcquireReport,
  type CacheSummary,
  type ExpectedTarball,
} from "./npm-registry-cache.js";
import type { CleanupProof } from "./runner.js";

// ---------------------------------------------------------------------------
// Fixed fixture
// ---------------------------------------------------------------------------

/** The hosts an attestation for this module must list, exactly. */
export const REGISTRY_EGRESS_HOSTS: readonly string[] = Object.freeze(["registry.npmjs.org"]);

export const FIXED_FIXTURE_ID = "is-number-7.0.0";

/** Selects operator-supplied files (see npm-operator-fixture.ts). Requires `operatorFixture`. */
export const OPERATOR_FIXTURE_ID = "operator-lockfile-v3";

/**
 * is-number@7.0.0. The integrity value was written from the author's memory of the public registry
 * entry; web access was unavailable when it was written, so it is NOT verified here. Operators must
 * confirm it with `npm view is-number@7.0.0 dist.integrity` before relying on a run. A wrong value
 * cannot produce a false success: npm would fail with EINTEGRITY and the host would reject the
 * handed-over tarball because its SHA-512 would not match.
 */
export const FIXED_PACKAGE: Readonly<ExpectedTarball> = Object.freeze({
  name: "is-number",
  version: "7.0.0",
  integrity: "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==",
});

/** Reads the flag through a function so TypeScript does not keep a stale narrowing across awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

const FIXTURE_NAME = "graveyard-registry-fixture";

export const FIXED_PACKAGE_JSON: string =
  JSON.stringify({ name: FIXTURE_NAME, version: "1.0.0", private: true, dependencies: { [FIXED_PACKAGE.name]: FIXED_PACKAGE.version } }, null, 2) + "\n";

export const FIXED_LOCKFILE: string =
  JSON.stringify(
    {
      name: FIXTURE_NAME,
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: FIXTURE_NAME, version: "1.0.0", dependencies: { [FIXED_PACKAGE.name]: FIXED_PACKAGE.version } },
        [`node_modules/${FIXED_PACKAGE.name}`]: {
          version: FIXED_PACKAGE.version,
          resolved: `https://registry.npmjs.org/${FIXED_PACKAGE.name}/-/${FIXED_PACKAGE.name}-${FIXED_PACKAGE.version}.tgz`,
          integrity: FIXED_PACKAGE.integrity,
        },
      },
    },
    null,
    2,
  ) + "\n";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ACQ_UID_GID = "65532:65532";
export const STAGED_ACQ_DRIVER_NAME = "npm-acquire-driver.mjs";
export const FIXTURE_MOUNT = "/fixture";
export const WORK_MOUNT = "/work";
export const NPM_ACQ_LABEL_MANAGED = "graveyard.managed";
export const NPM_ACQ_LABEL_ID = "graveyard.npm-acquisition-id";
export const NPM_ACQ_LOG_DRIVER = "json-file";
export const NPM_ACQ_LOG_MAX_SIZE = "64k";
export const NPM_ACQ_LOG_MAX_FILE = "1";
export const NPM_ACQ_ARGV: readonly string[] = Object.freeze(["node", `${FIXTURE_MOUNT}/${STAGED_ACQ_DRIVER_NAME}`]);
export const NPM_ACQ_CACHE_DIR_NAME = "cache";
export const MAX_ACQ_DRIVER_BYTES = 128 * 1024;
const NAME_PREFIX = "graveyard-npmacq-";
const CONTROL_OUTPUT_BYTES = 256 * 1024;
const CONTAINER_OUTPUT_BYTES = 256 * 1024;
const MEMORY_MB = 512;
const CPUS = 1;
const PIDS = 128;
const TMP_MB = 16;
const WORK_MB = 64;
const STAGED_NAMES: readonly string[] = [STAGED_ACQ_DRIVER_NAME, "package.json", "package-lock.json"];

const EXECUTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,100}:[0-9]{1,6}$/;
const IMAGE_RE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const FORBIDDEN_PATH_CHARS = /[,"'\0\r\n]/;
/** Environment names that must not exist in the container besides the one proxy variable. */
const SUSPECT_ENV_RE = /TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|NPM_CONFIG|PROXY/i;

/** Container name for an execution. "_" cannot occur in an id, so this is injective. */
export function npmAcquisitionContainerName(executionId: string): string {
  if (!EXECUTION_ID_RE.test(executionId)) throw new Error("invalid execution id");
  return `${NAME_PREFIX}${executionId.replace(":", "_")}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryAcquisitionLimits {
  /** Wall-clock bound for the container. */
  timeoutMs: number;
  controlTimeoutMs: number;
}

export const DEFAULT_REGISTRY_ACQUISITION_LIMITS: Readonly<RegistryAcquisitionLimits> = Object.freeze({
  timeoutMs: 150_000,
  controlTimeoutMs: 15_000,
});

export interface RegistryAcquisitionOptions {
  executor: ProcessExecutor;
  /** Controlled egress. UnavailableEgressGuard (the default everywhere) never attests. */
  egress: EgressGuard;
  /** Absolute backend-owned directory where the staged copy is created. Must exist. */
  stagingRoot: string;
  /** Default node:22-alpine. Must contain node and npm and exist locally; never pulled. */
  image?: string;
  /** Absolute path of the compiled driver. Default: npm-acquire-driver.js next to this module. */
  driverPath?: string;
  /** When set, the driver bytes must hash to this lowercase hex sha256 or nothing runs. */
  expectedDriverSha256?: string;
  limits?: Partial<RegistryAcquisitionLimits>;
  dockerBinary?: string;
  /** Injectable for tests. */
  realpath?: (path: string) => string;
  /** Injectable for tests. Default handoffNpmCache. */
  handoff?: typeof handoffNpmCache;
}

/** The exact text of both files. Validated by checkOperatorFixture before anything else happens. */
export interface OperatorFixtureInput {
  packageJson: string;
  packageLock: string;
}

export interface RegistryAcquisitionRequest {
  /** `<id>:<number>`, same format as the other adapters. */
  executionId: string;
  /** FIXED_FIXTURE_ID (no `operatorFixture`) or OPERATOR_FIXTURE_ID (needs `operatorFixture`). */
  fixture: string;
  /** Only with OPERATOR_FIXTURE_ID. Supplied by operator code, never by an HTTP request. */
  operatorFixture?: OperatorFixtureInput;
  /** Exact image reference from the allowlist. */
  image: string;
  /** Existing real directory. The verified cache is written to `<runDir>/cache`. */
  runDir: string;
  signal?: AbortSignal;
}

export type RegistryAcquisitionOutcome =
  | {
      kind: "acquired";
      /** `<runDir>/cache`, containing `_cacache`. Mount it read-only; the caller removes the run directory. */
      cacheDir: string;
      summary: CacheSummary;
      packagesAdded: number;
      durationMs: number;
    }
  /** Request failed validation; nothing was contacted. */
  | { kind: "rejected"; reason: string }
  /** No verified controlled egress, or the Docker network is not what was attested. Nothing was created. */
  | { kind: "network-unavailable"; reason: string }
  /** Docker, the driver or the staging area could not be used. */
  | { kind: "unavailable"; reason: string }
  /** Container configuration read back from Docker differs from the intent; it was not started. */
  | { kind: "isolation-violation"; reason: string }
  /** The driver reported a failure (for example npm exited nonzero). Not a verdict on the package. */
  | { kind: "install-failed"; phase: string; reason: string; detail: string; diagnostic: string }
  /** Output was truncated, malformed or inconsistent. Nothing in it is trusted. */
  | { kind: "protocol-error"; reason: string }
  /** npm's `added N packages` count differs from the lock. */
  | { kind: "summary-mismatch"; reason: string }
  /** The exported cache failed verification. `dir` is set if a directory was created and must be removed. */
  | { kind: "handoff-rejected"; reason: string; dir: string | null }
  | { kind: "cleanup-unconfirmed"; reason: string }
  | { kind: "staging-cleanup-failed"; reason: string }
  | { kind: "timed-out" }
  | { kind: "aborted" };

export type RegistryAcquisitionResult = RegistryAcquisitionOutcome & {
  /** null only when no container could have been created. */
  cleanup: CleanupProof | null;
  /** null when nothing was staged. */
  stagingRemoved: boolean | null;
  driverSha256: string | null;
  executionId: string | null;
};

type RunOutcome =
  | { kind: "exited"; exitCode: number; stdout: string; stderr: string; truncated: boolean; durationMs: number }
  | { kind: "timed-out" }
  | { kind: "aborted" }
  | { kind: "isolation-violation"; reason: string }
  | { kind: "unavailable"; reason: string };

type InspectState =
  | { state: "absent" }
  | { state: "present"; info: Record<string, unknown> }
  | { state: "error"; reason: string };

/** The validated fixture an acquisition will stage and expect back. */
interface AcqFixture {
  packageJson: string;
  lock: string;
  expected: ExpectedTarball[];
  packageCount: number;
  /** False for the fixed fixture, which is additionally compared byte for byte with the constants. */
  operator: boolean;
}

export interface Plan {
  name: string;
  executionId: string;
  image: string;
  runDir: string;
  signal: AbortSignal | undefined;
}

export interface Egress {
  network: string;
  proxyUrl: string;
  proxyHost: string;
}

export interface RunCtx {
  plan: Plan;
  egress: Egress;
  stagedDir: string;
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** True when the two fixed texts are exactly the constants and pass the static lock policy for one package. */
export function checkFixedFixture(packageJsonText: unknown, lockText: unknown): { ok: true; packageCount: number } | { ok: false; reason: string } {
  if (packageJsonText !== FIXED_PACKAGE_JSON || lockText !== FIXED_LOCKFILE) {
    return { ok: false, reason: "fixture files are not the fixed is-number@7.0.0 fixture" };
  }
  const p = checkNpmFixture(packageJsonText, lockText);
  if (!p.ok) return { ok: false, reason: `fixed fixture violates the lock policy: ${p.violations[0] ?? ""}` };
  if (p.packageCount !== 1) return { ok: false, reason: "fixed fixture must list exactly one package" };
  return { ok: true, packageCount: p.packageCount };
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(ip);
  if (m === null) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((n) => n > 255)) return null;
  return (o[0] as number) * 16777216 + (o[1] as number) * 65536 + (o[2] as number) * 256 + (o[3] as number);
}

/** True when `ip` lies inside the IPv4 CIDR `cidr` (prefix 8 to 30). Anything unparsable is false. */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  const m = /^([0-9.]{7,15})\/([0-9]{1,2})$/.exec(cidr);
  if (m === null) return false;
  const prefix = Number(m[2]);
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(m[1] as string);
  if (a === null || b === null || prefix < 8 || prefix > 30) return false;
  const size = 2 ** (32 - prefix);
  return Math.floor(a / size) === Math.floor(b / size);
}

/**
 * Null when `docker network inspect` shows exactly this network as an Internal, IPv4-only bridge
 * whose subnet contains the proxy address. Otherwise a short reason. Cannot verify the proxy itself.
 */
export function networkProblem(r: ProcessResult, name: string, proxyHost: string): string | null {
  if (r.exitCode !== 0 || r.timedOut || r.truncated) return "egress network could not be inspected";
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return "egress network inspect output is not JSON";
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) return "egress network is missing";
  const n = obj(parsed[0]);
  if (n["Name"] !== name) return "egress network name differs";
  if (n["Internal"] !== true) return "egress network is not an Internal docker network";
  if (n["Driver"] !== "bridge") return "egress network is not a bridge network";
  if (n["EnableIPv6"] === true) return "egress network has IPv6 enabled";
  const cfg = obj(n["IPAM"])["Config"];
  const entries = Array.isArray(cfg) ? (cfg as unknown[]) : [];
  let inside = false;
  for (const e of entries) {
    const subnet = obj(e)["Subnet"];
    if (typeof subnet !== "string") continue;
    if (subnet.includes(":")) return "egress network has an IPv6 subnet";
    if (obj(e)["Gateway"] === proxyHost) return "proxy address is the network gateway";
    if (ipv4InCidr(proxyHost, subnet)) inside = true;
  }
  return inside ? null : "proxy address is not inside the egress network's subnet";
}

/** Docker CLI arguments for `docker create`. Every element is a separate argv entry. */
export function buildCreateArgs(ctx: RunCtx): string[] {
  const { plan, egress } = ctx;
  return [
    "create",
    "--name", plan.name,
    "--pull", "never",
    "--network", egress.network,
    "--user", ACQ_UID_GID,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${TMP_MB}m`,
    "--tmpfs", `${WORK_MOUNT}:rw,noexec,nosuid,nodev,size=${WORK_MB}m,uid=65532,gid=65532,mode=0700`,
    "--shm-size", "4m",
    "--memory", `${MEMORY_MB}m`,
    "--memory-swap", `${MEMORY_MB}m`,
    "--cpus", String(CPUS),
    "--pids-limit", String(PIDS),
    "--restart", "no",
    "--log-driver", NPM_ACQ_LOG_DRIVER,
    "--log-opt", `max-size=${NPM_ACQ_LOG_MAX_SIZE}`,
    "--log-opt", `max-file=${NPM_ACQ_LOG_MAX_FILE}`,
    "--label", `${NPM_ACQ_LABEL_MANAGED}=true`,
    "--label", `${NPM_ACQ_LABEL_ID}=${plan.executionId}`,
    "--workdir", WORK_MOUNT,
    "--entrypoint", "",
    "--env", `${ACQUIRE_PROXY_ENV}=${egress.proxyUrl}`,
    "--mount", `type=bind,source=${ctx.stagedDir},target=${FIXTURE_MOUNT},readonly`,
    plan.image,
    ...NPM_ACQ_ARGV,
  ];
}

/** Compares `docker inspect` output with the isolation that was asked for. Empty array: no violation. */
export function verifyAcquisitionIsolation(info: Record<string, unknown>, ctx: RunCtx): string[] {
  const v: string[] = [];
  const { plan, egress } = ctx;
  const cfg = obj(info["Config"]);
  const host = obj(info["HostConfig"]);
  const labels = obj(cfg["Labels"]);

  if (cfg["User"] !== ACQ_UID_GID) v.push("user is not the fixed non-root uid:gid");
  if (cfg["Image"] !== plan.image) v.push("image differs");
  if (!sameArray(cfg["Cmd"], NPM_ACQ_ARGV)) v.push("command differs");
  const ep = cfg["Entrypoint"];
  if (!(ep === null || ep === undefined || (Array.isArray(ep) && ep.every((e) => e === "")))) v.push("entrypoint was not cleared");
  if (labels[NPM_ACQ_LABEL_MANAGED] !== "true" || labels[NPM_ACQ_LABEL_ID] !== plan.executionId) v.push("identifying labels missing");

  const env = Array.isArray(cfg["Env"]) ? (cfg["Env"] as unknown[]) : [];
  const proxyVar = `${ACQUIRE_PROXY_ENV}=${egress.proxyUrl}`;
  if (env.filter((e) => e === proxyVar).length !== 1) v.push("proxy environment variable missing or duplicated");
  for (const e of env) {
    if (typeof e !== "string") {
      v.push("malformed environment entry");
      continue;
    }
    if (e !== proxyVar && SUSPECT_ENV_RE.test(e.split("=")[0] ?? "")) v.push("unexpected credential, proxy or npm environment variable");
  }

  // The network must be exactly the attested one: never the default bridge, host or none.
  if (host["NetworkMode"] !== egress.network) v.push("container network is not the attested network");
  const nets = Object.keys(obj(obj(info["NetworkSettings"])["Networks"]));
  if (nets.length > 0 && (nets.length !== 1 || nets[0] !== egress.network)) v.push("container is attached to other networks");
  if (!isEmpty(host["PortBindings"])) v.push("ports are published");
  if (!isEmpty(host["Dns"]) || !isEmpty(host["ExtraHosts"])) v.push("custom dns or extra hosts");

  if (host["Privileged"] !== false) v.push("privileged");
  if (host["ReadonlyRootfs"] !== true) v.push("root filesystem is writable");
  if (!sameArray(host["CapDrop"], ["ALL"])) v.push("capabilities not dropped");
  if (!isEmpty(host["CapAdd"])) v.push("capabilities added");
  const sec = host["SecurityOpt"];
  if (!Array.isArray(sec) || !sec.some((s) => s === "no-new-privileges" || s === "no-new-privileges=true")) v.push("no-new-privileges missing");
  const mem = MEMORY_MB * 1024 * 1024;
  if (host["Memory"] !== mem || host["MemorySwap"] !== mem) v.push("memory limit differs");
  if (host["PidsLimit"] !== PIDS) v.push("pids limit differs");
  if (host["NanoCpus"] !== Math.round(CPUS * 1e9)) v.push("cpu limit differs");
  if (host["PidMode"] === "host" || host["IpcMode"] === "host" || host["UTSMode"] === "host") v.push("host namespace shared");
  if (!isEmpty(host["Binds"])) v.push("unexpected binds");
  if (!isEmpty(host["Devices"])) v.push("devices attached");
  if (!isEmpty(host["VolumesFrom"])) v.push("volumes-from set");

  const tmpfs = obj(host["Tmpfs"]);
  const keys = Object.keys(tmpfs).sort();
  if (keys.length !== 2 || keys[0] !== "/tmp" || keys[1] !== WORK_MOUNT) {
    v.push("unexpected tmpfs mounts");
  } else {
    for (const [path, mb] of [["/tmp", TMP_MB], [WORK_MOUNT, WORK_MB]] as const) {
      const raw = tmpfs[path];
      const opts = typeof raw === "string" ? raw.split(",").map((o) => o.trim()) : [];
      for (const need of ["noexec", "nosuid", "nodev", `size=${mb}m`]) {
        if (!opts.includes(need)) v.push(`tmpfs ${path} option ${need} missing`);
      }
      if (opts.includes("exec") || opts.includes("suid") || opts.includes("dev") || opts.includes("ro")) {
        v.push(`tmpfs ${path} has a conflicting option`);
      }
    }
  }

  const log = obj(host["LogConfig"]);
  const logCfg = obj(log["Config"]);
  const logKeys = Object.keys(logCfg).sort();
  if (
    log["Type"] !== NPM_ACQ_LOG_DRIVER ||
    logKeys.length !== 2 || logKeys[0] !== "max-file" || logKeys[1] !== "max-size" ||
    logCfg["max-size"] !== NPM_ACQ_LOG_MAX_SIZE || logCfg["max-file"] !== NPM_ACQ_LOG_MAX_FILE
  ) {
    v.push("log config is not json-file with max-size=64k and max-file=1");
  }

  const mounts = Array.isArray(info["Mounts"]) ? (info["Mounts"] as unknown[]) : [];
  if (mounts.length !== 1) {
    v.push("unexpected mount count");
  } else {
    const m = obj(mounts[0]);
    if (m["Type"] !== "bind" || m["Destination"] !== FIXTURE_MOUNT || m["RW"] !== false) v.push("staged mount is not a read-only bind at /fixture");
    if (typeof m["Source"] !== "string" || m["Source"] !== ctx.stagedDir) v.push("staged mount source differs from the staged directory");
  }
  return v;
}

// ---------------------------------------------------------------------------
// Host-side file helpers
// ---------------------------------------------------------------------------

type ReadResult = { kind: "file"; bytes: Buffer } | { kind: "bad" };

function readCapped(path: string, max: number): ReadResult {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    return { kind: "bad" };
  }
  if (!st.isFile() || st.size > max) return { kind: "bad" };
  try {
    return { kind: "file", bytes: readFileSync(path) };
  } catch {
    return { kind: "bad" };
  }
}

function isRealDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function defaultDriverPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "npm-acquire-driver.js");
}

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

export class NpmRegistryAcquisition {
  private readonly exec: ProcessExecutor;
  private readonly egress: EgressGuard;
  private readonly image: string;
  private readonly docker: string;
  private readonly limits: RegistryAcquisitionLimits;
  private readonly staging: string;
  private readonly driverPath: string;
  private readonly expectedSha: string | null;
  private readonly realpath: (p: string) => string;
  private readonly handoff: typeof handoffNpmCache;

  constructor(opts: RegistryAcquisitionOptions) {
    if (typeof opts?.executor !== "function") throw new Error("executor is required");
    this.handoff = opts.handoff ?? handoffNpmCache;
    if (typeof opts.egress !== "object" || opts.egress === null || typeof opts.egress.attest !== "function") {
      throw new Error("egress guard is required");
    }
    this.exec = opts.executor;
    this.egress = opts.egress;
    this.image = opts.image ?? NODE_FIXTURE_IMAGE;
    if (this.image.length > 255 || !IMAGE_RE.test(this.image)) throw new Error("invalid image reference");
    this.docker = opts.dockerBinary ?? "docker";
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(this.docker)) throw new Error("invalid dockerBinary");
    this.limits = { ...DEFAULT_REGISTRY_ACQUISITION_LIMITS, ...(opts.limits ?? {}) };
    for (const [k, lo, hi] of [["timeoutMs", 10_000, 600_000], ["controlTimeoutMs", 1_000, 60_000]] as const) {
      const val = this.limits[k];
      if (typeof val !== "number" || !Number.isInteger(val) || val < lo || val > hi) {
        throw new Error(`limit ${k} must be an integer between ${lo} and ${hi}`);
      }
    }
    this.realpath = opts.realpath ?? ((p: string): string => realpathSync(p));
    this.driverPath = opts.driverPath ?? defaultDriverPath();
    if (!isAbsolute(opts.stagingRoot) || !isAbsolute(this.driverPath)) throw new Error("stagingRoot and driverPath must be absolute");
    this.expectedSha = opts.expectedDriverSha256 ?? null;
    if (this.expectedSha !== null && !SHA256_RE.test(this.expectedSha)) throw new Error("expectedDriverSha256 must be 64 lowercase hex characters");
    this.staging = this.realpath(resolve(opts.stagingRoot));
    if (!isRealDir(this.staging) || FORBIDDEN_PATH_CHARS.test(this.staging)) throw new Error("stagingRoot must be an existing directory without forbidden characters");
  }

  /** Never throws. Reports container cleanup evidence whenever a container could exist. */
  async acquire(req: RegistryAcquisitionRequest): Promise<RegistryAcquisitionResult> {
    const executionId = typeof req?.executionId === "string" ? req.executionId : null;
    const finish = (o: RegistryAcquisitionOutcome, extra: Partial<Omit<RegistryAcquisitionResult, "kind">> = {}): RegistryAcquisitionResult =>
      ({ ...o, cleanup: null, stagingRemoved: null, driverSha256: null, executionId, ...extra }) as RegistryAcquisitionResult;

    // 1. Request.
    const planned = this.plan(req);
    if ("reason" in planned) return finish({ kind: "rejected", reason: planned.reason });
    const plan = planned;
    if (plan.signal?.aborted === true) return finish({ kind: "aborted" });

    // 1b. Fixture files. Operator files are validated here, before the attestation or Docker is touched.
    const resolvedFixture = this.resolveFixture(req);
    if (!resolvedFixture.ok) return finish({ kind: "rejected", reason: resolvedFixture.reason });
    const fx = resolvedFixture.value;

    // 2. Attestation. This module never creates one.
    let attestation: unknown;
    try {
      attestation = await this.egress.attest(plan.signal);
    } catch {
      attestation = { verified: false, reason: "egress guard raised an error" };
    }
    const valid = validateEgressAttestation(attestation, REGISTRY_EGRESS_HOSTS);
    if (!valid.ok) return finish({ kind: "network-unavailable", reason: valid.reason });
    const proxy = parsePrivateProxyUrl(valid.value.proxyUrl);
    if (proxy === null) {
      return finish({ kind: "network-unavailable", reason: "proxyUrl must be http://<private IPv4 literal>:<port>" });
    }
    if (isAborted(plan.signal)) return finish({ kind: "aborted" });
    const egress: Egress = { network: valid.value.network, proxyUrl: valid.value.proxyUrl, proxyHost: proxy.host };

    // 3. Docker and network gates: nothing is created unless both pass.
    try {
      const v = await this.control(["version", "--format", "{{.Server.Version}}"]);
      if (v.exitCode !== 0 || v.timedOut || v.stdout.trim() === "") return finish({ kind: "unavailable", reason: "docker daemon is not available" });
      const net = await this.control(["network", "inspect", egress.network]);
      const problem = networkProblem(net, egress.network, egress.proxyHost);
      if (problem !== null) return finish({ kind: "network-unavailable", reason: problem });
    } catch {
      return finish({ kind: "unavailable", reason: "docker CLI could not be started" });
    }

    // 4. Fixture and trusted driver.
    if (!fx.operator) {
      const fixed = checkFixedFixture(fx.packageJson, fx.lock);
      if (!fixed.ok) return finish({ kind: "unavailable", reason: fixed.reason });
    }
    if (Buffer.byteLength(fx.packageJson) > MAX_PACKAGE_JSON_BYTES || Buffer.byteLength(fx.lock) > MAX_LOCKFILE_BYTES) {
      return finish({ kind: "unavailable", reason: "fixture exceeds the policy size limits" });
    }
    const driver = readCapped(this.driverPath, MAX_ACQ_DRIVER_BYTES);
    if (driver.kind !== "file") return finish({ kind: "unavailable", reason: "the compiled driver is missing or unreadable; run the build first" });
    const driverSha256 = createHash("sha256").update(driver.bytes).digest("hex");
    if (this.expectedSha !== null && this.expectedSha !== driverSha256) {
      return finish({ kind: "unavailable", reason: "the compiled driver does not match the pinned sha256; nothing was run" }, { driverSha256 });
    }

    // 5. Stage exactly the validated bytes.
    const stagedDir = join(this.staging, `acq-${randomBytes(6).toString("hex")}`);
    const staged: Array<[string, Buffer]> = [
      [STAGED_ACQ_DRIVER_NAME, driver.bytes],
      ["package.json", Buffer.from(fx.packageJson, "utf8")],
      ["package-lock.json", Buffer.from(fx.lock, "utf8")],
    ];
    try {
      mkdirSync(stagedDir); // non-recursive: an existing entry is refused
    } catch {
      return finish({ kind: "unavailable", reason: "could not create the staging directory; nothing was run" }, { driverSha256 });
    }
    try {
      for (const [name, bytes] of staged) writeFileSync(join(stagedDir, name), bytes, { flag: "wx", mode: 0o644 });
      if (FORBIDDEN_PATH_CHARS.test(stagedDir)) throw new Error("staged path");
    } catch {
      const removal = removeStagedPipeline(stagedDir, STAGED_NAMES.filter((n) => isFile(join(stagedDir, n))));
      return finish({ kind: "unavailable", reason: "could not stage the files; nothing was run" }, { driverSha256, stagingRemoved: removal.removed });
    }

    // 6. One fixed command in one disposable container.
    const ctx: RunCtx = { plan, egress, stagedDir, timeoutMs: this.limits.timeoutMs };
    let run: RunOutcome;
    try {
      run = await this.createVerifyStart(ctx);
    } catch {
      run = { kind: "unavailable", reason: "docker command could not be run" };
    }

    // 7. Cleanup before anything in the output is looked at.
    const cleanup = await this.cleanup({ executionId: plan.executionId });
    const removal = removeStagedPipeline(stagedDir, STAGED_NAMES);
    const common = { cleanup, stagingRemoved: removal.removed, driverSha256 };

    const classified = this.classify(run);
    if ("outcome" in classified) return finish(classified.outcome, common);
    if (!cleanup.confirmed) {
      return finish({ kind: "cleanup-unconfirmed", reason: `container cleanup was not confirmed (${cleanup.reason}); the output is not trusted` }, common);
    }
    if (!removal.removed) {
      return finish({ kind: "staging-cleanup-failed", reason: `staging directory was not removed (${removal.problem ?? "unknown"}); the output is not trusted` }, common);
    }

    // 8. Count check, then the verified handoff written by the host.
    const report = classified.passed;
    const added = parseNpmAdded(report.stdoutTail);
    if (added !== fx.packageCount) {
      return finish({ kind: "summary-mismatch", reason: `npm reported ${added === null ? "no package summary" : `${added} package(s)`}, the lockfile lists ${fx.packageCount}` }, common);
    }
    const handoff = this.handoff(report.files, fx.expected, plan.runDir, NPM_ACQ_CACHE_DIR_NAME);
    if (!handoff.ok) return finish({ kind: "handoff-rejected", reason: sanitize(handoff.reason), dir: handoff.dir }, common);
    return finish(
      { kind: "acquired", cacheDir: handoff.cacheDir, summary: handoff.summary, packagesAdded: added, durationMs: report.durationMs },
      common,
    );
  }

  /**
   * Idempotent. Removes this execution's container only if it carries this adapter's labels for
   * exactly this id, then proves absence by inspect and a label query. Never throws.
   */
  async cleanup(req: { executionId: string }): Promise<CleanupProof> {
    const executionId = req.executionId;
    const fail = (reason: string): CleanupProof => ({ confirmed: false, reason: sanitize(reason) });
    if (typeof executionId !== "string" || !EXECUTION_ID_RE.test(executionId)) return fail("invalid execution id; cleanup not attempted");
    const name = npmAcquisitionContainerName(executionId);
    try {
      const before = await this.inspect(name);
      if (before.state === "error") return fail(`inspect failed: ${before.reason}`);
      if (before.state === "present") {
        const labels = obj(obj(before.info["Config"])["Labels"]);
        if (labels[NPM_ACQ_LABEL_MANAGED] !== "true" || labels[NPM_ACQ_LABEL_ID] !== executionId) {
          return fail("container with this name lacks this adapter's labels; refusing to remove it");
        }
        // The result of rm is not trusted; the inspect below is the proof.
        await this.control(["rm", "--force", "--volumes", name]);
        const after = await this.inspect(name);
        if (after.state === "error") return fail(`inspect after removal failed: ${after.reason}`);
        if (after.state === "present") return fail("container still present after removal");
      }
      const ps = await this.control(["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${NPM_ACQ_LABEL_ID}=${executionId}`]);
      if (ps.exitCode !== 0 || ps.timedOut || ps.truncated) return fail("label query failed");
      if (ps.stdout.trim() !== "") return fail("a container with this execution label still exists");
      return {
        confirmed: true,
        executionId,
        evidence: `docker inspect reports no container ${name}; label query for ${executionId} is empty`,
      };
    } catch {
      return fail("docker cleanup command could not be run");
    }
  }

  // -------------------------------------------------------------------------

  /** Chooses the fixture files. Operator files must pass checkOperatorFixture; nothing is contacted before that. */
  private resolveFixture(req: RegistryAcquisitionRequest): { ok: true; value: AcqFixture } | { ok: false; reason: string } {
    if (req.fixture === FIXED_FIXTURE_ID) {
      if (req.operatorFixture !== undefined) return { ok: false, reason: "the fixed fixture does not accept operator files" };
      return {
        ok: true,
        value: { packageJson: FIXED_PACKAGE_JSON, lock: FIXED_LOCKFILE, expected: [FIXED_PACKAGE], packageCount: 1, operator: false },
      };
    }
    const input: unknown = req.operatorFixture;
    const shape = obj(input);
    if (Object.keys(shape).sort().join(",") !== "packageJson,packageLock") {
      return { ok: false, reason: "operatorFixture must be exactly { packageJson, packageLock }" };
    }
    const r = checkOperatorFixture(shape["packageJson"], shape["packageLock"]);
    if (!r.ok) return { ok: false, reason: sanitize(`operator fixture violates the policy: ${r.violations[0] ?? "unknown"}`) };
    return { ok: true, value: { packageJson: r.packageJson, lock: r.lock, expected: r.packages, packageCount: r.packageCount, operator: true } };
  }

  private plan(req: RegistryAcquisitionRequest): Plan | { reason: string } {
    if (typeof req !== "object" || req === null) return { reason: "request must be an object" };
    if (typeof req.executionId !== "string" || !EXECUTION_ID_RE.test(req.executionId)) return { reason: "invalid execution id" };
    if (req.fixture !== FIXED_FIXTURE_ID && req.fixture !== OPERATOR_FIXTURE_ID) {
      return { reason: "fixture is not supported (only the fixed fixture or an operator lockfile v3 fixture)" };
    }
    if (typeof req.image !== "string" || req.image !== this.image) return { reason: "image is not in the allowlist" };
    if (typeof req.runDir !== "string" || !isAbsolute(req.runDir) || !isRealDir(resolve(req.runDir))) {
      return { reason: "runDir must be an existing real directory" };
    }
    return {
      name: npmAcquisitionContainerName(req.executionId),
      executionId: req.executionId,
      image: req.image,
      runDir: resolve(req.runDir),
      signal: req.signal,
    };
  }

  /** Maps the container outcome. `passed` still needs cleanup confirmation and the verified handoff. */
  private classify(run: RunOutcome): { outcome: RegistryAcquisitionOutcome } | { passed: AcquireReport } {
    switch (run.kind) {
      case "timed-out":
        return { outcome: { kind: "timed-out" } };
      case "aborted":
        return { outcome: { kind: "aborted" } };
      case "isolation-violation":
        return { outcome: { kind: "isolation-violation", reason: run.reason } };
      case "unavailable":
        return { outcome: { kind: "unavailable", reason: run.reason } };
      case "exited":
        break;
    }
    const perr = (reason: string): { outcome: RegistryAcquisitionOutcome } => ({ outcome: { kind: "protocol-error", reason } });
    if (run.truncated) return perr("container output was truncated; the report cannot be trusted");
    if (run.exitCode !== EXIT_PASSED && run.exitCode !== EXIT_FAILED) return perr(`the driver exited with code ${run.exitCode} and no usable report`);
    if (run.stderr !== "") return perr("the driver wrote to stderr, which the protocol forbids");
    const parsed = parseAcquireOutput(run.stdout);
    if (!parsed.ok) return perr(`invalid driver output: ${parsed.reason}`);
    const r = parsed.value;
    if ((run.exitCode === EXIT_PASSED) !== (r.status === "passed")) return perr("exit code contradicts the reported status");
    if (r.status === "passed") return { passed: r };
    if (r.status === "cancelled") return { outcome: { kind: "aborted" } };
    return {
      outcome: {
        kind: "install-failed",
        phase: r.phase,
        reason: r.reason ?? "unknown",
        detail: sanitize(r.detail),
        diagnostic: sanitize(r.stderrTail.slice(-400)),
      },
    };
  }

  private async createVerifyStart(ctx: RunCtx): Promise<RunOutcome> {
    const { plan } = ctx;
    const started = Date.now();
    const created = await this.control(buildCreateArgs(ctx));
    if (created.exitCode !== 0 || created.timedOut) {
      return { kind: "unavailable", reason: `docker create failed: ${sanitize(created.stderr.trim())}` };
    }
    const info = await this.inspect(plan.name);
    if (info.state !== "present") return { kind: "unavailable", reason: "created container could not be inspected" };
    const violations = verifyAcquisitionIsolation(info.info, ctx);
    if (violations.length > 0) return { kind: "isolation-violation", reason: sanitize(violations.join("; ")) };
    if (plan.signal?.aborted === true) return { kind: "aborted" };

    const run = await this.exec(this.docker, ["start", "--attach", plan.name], {
      timeoutMs: ctx.timeoutMs,
      maxOutputBytes: CONTAINER_OUTPUT_BYTES,
      ...(plan.signal === undefined ? {} : { signal: plan.signal }),
    });
    if (run.timedOut) return { kind: "timed-out" };
    if (run.aborted) return { kind: "aborted" };
    if (run.exitCode === null) return { kind: "unavailable", reason: "docker start ended without an exit code" };
    if (run.exitCode !== 0) {
      // A nonzero code may come from the daemon failing to start the container rather than from the
      // driver. Only report "exited" if inspect proves the container ran and exited with this code.
      const after = await this.inspect(plan.name);
      if (after.state !== "present") return { kind: "unavailable", reason: "docker start failed and container state could not be read" };
      const st = obj(after.info["State"]);
      const err = typeof st["Error"] === "string" ? st["Error"] : "";
      const startedAt = st["StartedAt"];
      const neverStarted =
        typeof startedAt !== "string" || startedAt === "" || startedAt.startsWith("0001-01-01") || st["Status"] === "created";
      if (err !== "" || neverStarted || st["Running"] !== false || st["ExitCode"] !== run.exitCode) {
        return {
          kind: "unavailable",
          reason: sanitize(`docker start failed; container did not run to completion: ${err !== "" ? err : run.stderr.trim()}`),
        };
      }
    }
    return { kind: "exited", exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, truncated: run.truncated, durationMs: Date.now() - started };
  }

  private async inspect(name: string): Promise<InspectState> {
    const r = await this.control(["inspect", "--type", "container", name]);
    if (r.timedOut || r.truncated) return { state: "error", reason: "inspect timed out or output too large" };
    if (r.exitCode === 0) {
      try {
        const parsed: unknown = JSON.parse(r.stdout);
        if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === "object" && parsed[0] !== null) {
          return { state: "present", info: parsed[0] as Record<string, unknown> };
        }
      } catch { /* fall through */ }
      return { state: "error", reason: "unparsable inspect output" };
    }
    if (/no such (object|container)/i.test(r.stderr)) return { state: "absent" };
    return { state: "error", reason: sanitize(r.stderr.trim() || "inspect failed") };
  }

  private control(args: readonly string[]): Promise<ProcessResult> {
    return this.exec(this.docker, args, { timeoutMs: this.limits.controlTimeoutMs, maxOutputBytes: CONTROL_OUTPUT_BYTES });
  }
}

// ---------------------------------------------------------------------------

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
}

function sameArray(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((x, i) => x === expected[i]);
}
