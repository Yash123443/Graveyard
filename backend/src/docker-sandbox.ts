/**
 * docker-sandbox.ts — narrow Docker adapter for CONTROLLED LOCAL FIXTURES.
 *
 * Foundation only. It is NOT wired into the server, worker or UnavailableRunner,
 * it does not implement JobRunner, and it must not be pointed at arbitrary
 * GitHub repositories. Nothing here has been run against a real Docker daemon.
 *
 * Design rules:
 *  - The docker CLI is invoked through an injectable ProcessExecutor with an
 *    argument ARRAY and no shell. No caller-supplied string is ever
 *    concatenated into a command line.
 *  - Callers choose a command by ID from a registry fixed at construction.
 *    Images must appear in a construction-time allowlist and are never pulled
 *    (--pull never).
 *  - The container is created first, its configuration is read back with
 *    `docker inspect` and compared with the intended isolation settings, and
 *    only then started. A mismatch fails closed without starting it.
 *  - Cleanup is explicit: remove by name, then prove absence with `docker
 *    inspect` and a label query. Anything unproven returns confirmed:false.
 *  - If Docker cannot be reached, nothing runs.
 *
 * Not covered: arbitrary repositories, network egress, dependency installs by the adapter itself
 * (npm-install-runner.ts builds a fixed offline `npm ci` on top of the optional readonlyBinds and
 * extraTmpfs options), seccomp/AppArmor profile choice (Docker defaults apply), user namespaces,
 * rootless mode, concurrent execute()/cleanup() for one execution id, and
 * proof that the Docker daemon itself is trustworthy.
 *
 * @module docker-sandbox
 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { CleanupProof } from "./runner.js";

// ---------------------------------------------------------------------------
// Process executor (injectable)
// ---------------------------------------------------------------------------

export interface ProcessOptions {
  timeoutMs: number;
  /** Combined cap per stream. Output beyond it is discarded and `truncated` is set. */
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
}

/** Rejects only when the process cannot be started (for example docker is missing). */
export type ProcessExecutor = (
  file: string,
  args: readonly string[],
  options: ProcessOptions,
) => Promise<ProcessResult>;

/** Environment variables passed to the docker CLI. DOCKER_HOST and credentials are deliberately absent. */
const ENV_ALLOWLIST = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "HOME", "USERPROFILE", "XDG_RUNTIME_DIR"];

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/**
 * Real executor: child_process.spawn with shell:false, stdin closed, minimal
 * environment, bounded output, timeout and abort kill. Not exercised by the
 * unit tests (they inject a mock), so it is unverified.
 */
export const spawnExecutor: ProcessExecutor = (file, args, options) =>
  new Promise<ProcessResult>((resolvePromise, reject) => {
    const child = spawn(file, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: minimalEnv(),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const collect = (chunks: Buffer[], size: number, chunk: Buffer): number => {
      const room = options.maxOutputBytes - size;
      if (room <= 0) {
        truncated = true;
        return size;
      }
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        truncated = true;
        return size + room;
      }
      chunks.push(chunk);
      return size + chunk.length;
    };
    child.stdout?.on("data", (c: Buffer) => { outBytes = collect(out, outBytes, c); });
    child.stderr?.on("data", (c: Buffer) => { errBytes = collect(err, errBytes, c); });

    const kill = (): void => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs);
    const onAbort = (): void => { aborted = true; kill(); };
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const done = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      done();
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      done();
      resolvePromise({
        exitCode: code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        aborted,
        truncated,
      });
    });
  });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
  tmpfsMb: number;
  /** Default and maximum run time of the fixture command. */
  timeoutMs: number;
  /** Per-stream cap on captured output. */
  maxOutputBytes: number;
  /** Timeout for each docker control command (version, create, inspect, rm, ps). */
  controlTimeoutMs: number;
}

export const DEFAULT_LIMITS: Readonly<SandboxLimits> = Object.freeze({
  memoryMb: 128,
  cpus: 0.5,
  pids: 64,
  tmpfsMb: 16,
  timeoutMs: 30_000,
  maxOutputBytes: 64 * 1024,
  controlTimeoutMs: 15_000,
});

const LIMIT_RANGES: Record<keyof SandboxLimits, [number, number]> = {
  memoryMb: [16, 512],
  cpus: [0.1, 2],
  pids: [8, 256],
  tmpfsMb: [1, 64],
  timeoutMs: [1_000, 120_000],
  maxOutputBytes: [1_024, 256 * 1024],
  controlTimeoutMs: [1_000, 60_000],
};

export const SANDBOX_UID_GID = "65532:65532";
export const FIXTURE_MOUNT_TARGET = "/fixture";
export const LABEL_MANAGED = "graveyard.managed";
export const LABEL_EXECUTION = "graveyard.execution-id";
export const LABEL_FIXTURE = "graveyard.fixture";
export const LOG_DRIVER = "json-file";
export const LOG_MAX_SIZE = "64k";
export const LOG_MAX_FILE = "1";
const NAME_PREFIX = "graveyard-";
const CONTROL_OUTPUT_BYTES = 256 * 1024;

const EXECUTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,100}:[0-9]{1,6}$/;
const FIXTURE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMAND_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const IMAGE_RE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;
const FORBIDDEN_PATH_CHARS = /[,"\0\r\n]/;
const MAX_REASON = 300;

const clip = (s: string): string => (s.length > MAX_REASON ? `${s.slice(0, MAX_REASON)}…` : s);

/** Operator-fixed read-only bind mount (for example an offline package cache). Never chosen by a request. */
export interface ReadonlyBind {
  /** Absolute host directory. Resolved with realpath at construction. */
  source: string;
  /** Absolute container path, for example /npm-cache. */
  target: string;
}

/** Operator-fixed extra tmpfs mount (rw, noexec, nosuid, nodev). Never chosen by a request. */
export interface ExtraTmpfs {
  target: string;
  sizeMb: number;
}

const EXTRA_TARGET_RE = /^\/[A-Za-z0-9][A-Za-z0-9._-]{0,31}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,31}){0,2}$/;
const RESERVED_TARGETS: readonly string[] = ["/tmp", FIXTURE_MOUNT_TARGET];

export interface SandboxOptions {
  executor: ProcessExecutor;
  /** Optional fixed read-only bind mounts. Default none. */
  readonlyBinds?: readonly ReadonlyBind[];
  /** Optional fixed extra tmpfs mounts. Default none. */
  extraTmpfs?: readonly ExtraTmpfs[];
  /** Exact image references that may be used. Never pulled. */
  allowedImages: readonly string[];
  /** Fixed commands by ID. Each is an argv array run directly (entrypoint is cleared). */
  commands: Readonly<Record<string, readonly string[]>>;
  /** Absolute directory whose direct subdirectories are the only mountable fixtures. */
  fixturesRoot?: string;
  limits?: Partial<SandboxLimits>;
  /** Default "docker". Must contain no whitespace or path-control characters. */
  dockerBinary?: string;
  /** Injectable for tests. Default fs.realpathSync. */
  realpath?: (path: string) => string;
}

export interface SandboxRequest {
  /** `<job id>:<attempt>`, as produced by leases.executionIdFor. */
  executionId: string;
  commandId: string;
  image: string;
  /** Name of one directory under fixturesRoot, mounted read-only at /fixture. */
  fixture?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface OutputFields {
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export type SandboxOutcome =
  | ({ kind: "exited"; exitCode: number } & OutputFields)
  | ({ kind: "timed-out" } & OutputFields)
  | ({ kind: "aborted" } & OutputFields)
  /** Container configuration read back from Docker differs from the intent; it was not started. */
  | { kind: "isolation-violation"; reason: string }
  /** Docker could not be used. Fail closed. */
  | { kind: "unavailable"; reason: string }
  /** Request failed validation; Docker was not contacted. */
  | { kind: "rejected"; reason: string };

/** `cleanup` is null only when no container could have been created. */
export type SandboxResult = SandboxOutcome & { cleanup: CleanupProof | null };

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function checkLimits(partial: Partial<SandboxLimits> | undefined): SandboxLimits {
  const limits: SandboxLimits = { ...DEFAULT_LIMITS, ...(partial ?? {}) };
  for (const key of Object.keys(LIMIT_RANGES) as Array<keyof SandboxLimits>) {
    const [lo, hi] = LIMIT_RANGES[key];
    const v = limits[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) {
      throw new Error(`limit ${key} must be a number between ${lo} and ${hi}`);
    }
  }
  if (!Number.isInteger(limits.memoryMb) || !Number.isInteger(limits.pids) || !Number.isInteger(limits.tmpfsMb)) {
    throw new Error("memoryMb, pids and tmpfsMb must be integers");
  }
  return limits;
}

function checkCommands(commands: Readonly<Record<string, readonly string[]>>): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const [id, argv] of Object.entries(commands)) {
    if (!COMMAND_ID_RE.test(id)) throw new Error(`invalid command id: ${id}`);
    if (!Array.isArray(argv) || argv.length < 1 || argv.length > 16) {
      throw new Error(`command ${id} must have 1 to 16 arguments`);
    }
    for (const a of argv) {
      if (typeof a !== "string" || a.length < 1 || a.length > 256 || a.includes("\0")) {
        throw new Error(`command ${id} has an invalid argument`);
      }
    }
    map.set(id, Object.freeze([...argv]));
  }
  if (map.size === 0) throw new Error("at least one fixed command is required");
  return map;
}

function checkImage(image: unknown): image is string {
  return typeof image === "string" && image.length <= 255 && IMAGE_RE.test(image);
}

/** Container name derived from a validated execution id. "_" cannot occur in the id, so this is injective. */
export function containerNameFor(executionId: string): string {
  if (!EXECUTION_ID_RE.test(executionId)) throw new Error("invalid execution id");
  return `${NAME_PREFIX}${executionId.replace(":", "_")}`;
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

interface Plan {
  name: string;
  executionId: string;
  image: string;
  argv: readonly string[];
  fixtureName: string | null;
  fixtureSource: string | null;
  timeoutMs: number;
}

type InspectState =
  | { state: "absent" }
  | { state: "present"; info: Record<string, unknown> }
  | { state: "error"; reason: string };

export class DockerFixtureSandbox {
  private readonly exec: ProcessExecutor;
  private readonly images: ReadonlySet<string>;
  private readonly commands: Map<string, readonly string[]>;
  private readonly fixturesRoot: string | null;
  private readonly limits: SandboxLimits;
  private readonly docker: string;
  private readonly realpath: (p: string) => string;
  private readonly binds: ReadonlyBind[] = [];
  private readonly extraTmpfs: ExtraTmpfs[] = [];

  constructor(opts: SandboxOptions) {
    if (typeof opts.executor !== "function") throw new Error("executor is required");
    this.exec = opts.executor;
    const images = new Set<string>();
    for (const img of opts.allowedImages) {
      if (!checkImage(img)) throw new Error(`invalid image reference: ${String(img)}`);
      images.add(img);
    }
    if (images.size === 0) throw new Error("at least one allowed image is required");
    this.images = images;
    this.commands = checkCommands(opts.commands);
    this.limits = checkLimits(opts.limits);
    this.docker = opts.dockerBinary ?? "docker";
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(this.docker)) throw new Error("invalid dockerBinary");
    this.realpath = opts.realpath ?? ((p: string): string => realpathSync(p));
    if (opts.fixturesRoot === undefined) {
      this.fixturesRoot = null;
    } else {
      if (!isAbsolute(opts.fixturesRoot)) throw new Error("fixturesRoot must be an absolute path");
      this.fixturesRoot = this.realpath(resolve(opts.fixturesRoot));
      if (FORBIDDEN_PATH_CHARS.test(this.fixturesRoot)) throw new Error("fixturesRoot contains forbidden characters");
    }

    const targets = new Set<string>(RESERVED_TARGETS);
    for (const b of opts.readonlyBinds ?? []) {
      if (typeof b?.source !== "string" || !isAbsolute(b.source)) throw new Error("readonly bind source must be absolute");
      if (typeof b.target !== "string" || !EXTRA_TARGET_RE.test(b.target) || targets.has(b.target)) {
        throw new Error("invalid or duplicate readonly bind target");
      }
      const source = this.realpath(resolve(b.source));
      if (FORBIDDEN_PATH_CHARS.test(source)) throw new Error("readonly bind source contains forbidden characters");
      targets.add(b.target);
      this.binds.push({ source, target: b.target });
    }
    for (const t of opts.extraTmpfs ?? []) {
      if (typeof t?.target !== "string" || !EXTRA_TARGET_RE.test(t.target) || targets.has(t.target)) {
        throw new Error("invalid or duplicate extra tmpfs target");
      }
      if (!Number.isInteger(t.sizeMb) || t.sizeMb < 1 || t.sizeMb > 256) throw new Error("extra tmpfs sizeMb must be 1 to 256");
      targets.add(t.target);
      this.extraTmpfs.push({ target: t.target, sizeMb: t.sizeMb });
    }
  }

  /**
   * Runs one fixed command in a fresh isolated container, then always
   * attempts explicit cleanup and reports its proof in `cleanup`.
   */
  async execute(req: SandboxRequest): Promise<SandboxResult> {
    const planned = this.plan(req);
    if ("reason" in planned) return { kind: "rejected", reason: planned.reason, cleanup: null };
    const plan = planned;

    const started = Date.now();
    const elapsed = (): number => Date.now() - started;

    // Availability gate: nothing is created unless the daemon answers.
    try {
      const v = await this.control(["version", "--format", "{{.Server.Version}}"]);
      if (v.exitCode !== 0 || v.timedOut || v.stdout.trim() === "") {
        return { kind: "unavailable", reason: "docker daemon is not available", cleanup: null };
      }
    } catch {
      return { kind: "unavailable", reason: "docker CLI could not be started", cleanup: null };
    }

    let outcome: SandboxOutcome;
    try {
      outcome = await this.createVerifyStart(plan, req.signal, elapsed);
    } catch {
      outcome = { kind: "unavailable", reason: "docker command could not be run" };
    }
    // From here a container may exist, so cleanup is always attempted.
    const cleanup = await this.cleanup({ executionId: plan.executionId });
    return { ...outcome, cleanup };
  }

  /**
   * Idempotent. Removes the container named for this execution (only if it
   * carries this adapter's labels for exactly this id), then proves absence by
   * `docker inspect` and a label query. Never throws.
   */
  async cleanup(req: { executionId: string }): Promise<CleanupProof> {
    const executionId = req.executionId;
    const fail = (reason: string): CleanupProof => ({ confirmed: false, reason: clip(reason) });
    if (typeof executionId !== "string" || !EXECUTION_ID_RE.test(executionId)) {
      return fail("invalid execution id; cleanup not attempted");
    }
    const name = containerNameFor(executionId);
    try {
      const before = await this.inspect(name);
      if (before.state === "error") return fail(`inspect failed: ${before.reason}`);
      if (before.state === "present") {
        if (!this.ownedBy(before.info, executionId)) {
          return fail("container with this name lacks this adapter's labels; refusing to remove it");
        }
        // The result of rm is not trusted; the inspect below is the proof.
        await this.control(["rm", "--force", "--volumes", name]);
        const after = await this.inspect(name);
        if (after.state === "error") return fail(`inspect after removal failed: ${after.reason}`);
        if (after.state === "present") return fail("container still present after removal");
      }
      const ps = await this.control([
        "ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${LABEL_EXECUTION}=${executionId}`,
      ]);
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

  private plan(req: SandboxRequest): Plan | { reason: string } {
    if (typeof req !== "object" || req === null) return { reason: "request must be an object" };
    if (typeof req.executionId !== "string" || !EXECUTION_ID_RE.test(req.executionId)) {
      return { reason: "invalid execution id" };
    }
    if (typeof req.commandId !== "string") return { reason: "unknown command" };
    const argv = this.commands.get(req.commandId);
    if (argv === undefined) return { reason: "unknown command" };
    if (typeof req.image !== "string" || !this.images.has(req.image)) {
      return { reason: "image is not in the allowlist" };
    }
    let timeoutMs = this.limits.timeoutMs;
    if (req.timeoutMs !== undefined) {
      if (!Number.isFinite(req.timeoutMs) || req.timeoutMs < 1_000 || req.timeoutMs > this.limits.timeoutMs) {
        return { reason: `timeoutMs must be between 1000 and ${this.limits.timeoutMs}` };
      }
      timeoutMs = req.timeoutMs;
    }

    let fixtureName: string | null = null;
    let fixtureSource: string | null = null;
    if (req.fixture !== undefined) {
      if (this.fixturesRoot === null) return { reason: "no fixturesRoot is configured" };
      if (typeof req.fixture !== "string" || !FIXTURE_NAME_RE.test(req.fixture)) {
        return { reason: "invalid fixture name" };
      }
      let real: string;
      try {
        real = this.realpath(resolve(this.fixturesRoot, req.fixture));
      } catch {
        return { reason: "fixture directory does not exist" };
      }
      const rel = relative(this.fixturesRoot, real);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { reason: "fixture escapes fixturesRoot" };
      if (FORBIDDEN_PATH_CHARS.test(real)) return { reason: "fixture path contains forbidden characters" };
      fixtureName = req.fixture;
      fixtureSource = real;
    }

    return {
      name: containerNameFor(req.executionId),
      executionId: req.executionId,
      image: req.image,
      argv,
      fixtureName,
      fixtureSource,
      timeoutMs,
    };
  }

  /** Docker CLI arguments for `docker create`. Every element is a separate argv entry. */
  private createArgs(plan: Plan): string[] {
    const l = this.limits;
    const args = [
      "create",
      "--name", plan.name,
      "--pull", "never",
      "--network", "none",
      "--user", SANDBOX_UID_GID,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${l.tmpfsMb}m`,
      "--shm-size", "4m",
      "--memory", `${l.memoryMb}m`,
      "--memory-swap", `${l.memoryMb}m`,
      "--cpus", String(l.cpus),
      "--pids-limit", String(l.pids),
      "--restart", "no",
      // Explicit driver: Docker 29 defaults to "local", which rejects max-file=1 (compression).
      "--log-driver", LOG_DRIVER,
      "--log-opt", `max-size=${LOG_MAX_SIZE}`,
      "--log-opt", `max-file=${LOG_MAX_FILE}`,
      "--label", `${LABEL_MANAGED}=true`,
      "--label", `${LABEL_EXECUTION}=${plan.executionId}`,
      "--label", `${LABEL_FIXTURE}=${plan.fixtureName ?? "none"}`,
      "--workdir", plan.fixtureSource === null ? "/tmp" : FIXTURE_MOUNT_TARGET,
      "--entrypoint", "",
    ];
    for (const t of this.extraTmpfs) {
      args.push("--tmpfs", `${t.target}:rw,noexec,nosuid,nodev,size=${t.sizeMb}m`);
    }
    if (plan.fixtureSource !== null) {
      args.push("--mount", `type=bind,source=${plan.fixtureSource},target=${FIXTURE_MOUNT_TARGET},readonly`);
    }
    for (const b of this.binds) {
      args.push("--mount", `type=bind,source=${b.source},target=${b.target},readonly`);
    }
    args.push(plan.image, ...plan.argv);
    return args;
  }

  private async createVerifyStart(
    plan: Plan,
    signal: AbortSignal | undefined,
    elapsed: () => number,
  ): Promise<SandboxOutcome> {
    const created = await this.control(this.createArgs(plan));
    if (created.exitCode !== 0 || created.timedOut) {
      return { kind: "unavailable", reason: `docker create failed: ${clip(created.stderr.trim())}` };
    }

    const info = await this.inspect(plan.name);
    if (info.state !== "present") {
      return { kind: "unavailable", reason: "created container could not be inspected" };
    }
    const violations = this.verifyIsolation(info.info, plan);
    if (violations.length > 0) {
      return { kind: "isolation-violation", reason: clip(violations.join("; ")) };
    }

    const empty = { stdout: "", stderr: "", truncated: false };
    if (signal?.aborted === true) return { kind: "aborted", ...empty, durationMs: elapsed() };

    const run = await this.exec(this.docker, ["start", "--attach", plan.name], {
      timeoutMs: plan.timeoutMs,
      maxOutputBytes: this.limits.maxOutputBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    const fields: OutputFields = {
      stdout: run.stdout, stderr: run.stderr, truncated: run.truncated, durationMs: elapsed(),
    };
    if (run.timedOut) return { kind: "timed-out", ...fields };
    if (run.aborted) return { kind: "aborted", ...fields };
    if (run.exitCode === null) {
      return { kind: "unavailable", reason: "docker start ended without an exit code" };
    }
    if (run.exitCode !== 0) {
      // A nonzero code may come from the daemon failing to start the container
      // rather than from the fixture command. Only report "exited" if inspect
      // proves the container ran and exited with this code; otherwise fail closed.
      const after = await this.inspect(plan.name);
      if (after.state !== "present") {
        return { kind: "unavailable", reason: "docker start failed and container state could not be read" };
      }
      const st = obj(after.info["State"]);
      const err = typeof st["Error"] === "string" ? st["Error"] : "";
      const startedAt = st["StartedAt"];
      const neverStarted =
        typeof startedAt !== "string" || startedAt === "" || startedAt.startsWith("0001-01-01") ||
        st["Status"] === "created";
      if (err !== "" || neverStarted || st["Running"] !== false || st["ExitCode"] !== run.exitCode) {
        const detail = err !== "" ? err : clip(run.stderr.trim());
        return {
          kind: "unavailable",
          reason: clip(`docker start failed; container did not run to completion (report unavailable): ${detail}`),
        };
      }
    }
    return { kind: "exited", exitCode: run.exitCode, ...fields };
  }

  /** Compares `docker inspect` output with the isolation this adapter asked for. */
  private verifyIsolation(info: Record<string, unknown>, plan: Plan): string[] {
    const v: string[] = [];
    const l = this.limits;
    const cfg = obj(info["Config"]);
    const host = obj(info["HostConfig"]);
    const labels = obj(cfg["Labels"]);

    if (cfg["User"] !== SANDBOX_UID_GID) v.push("user is not the fixed non-root uid:gid");
    if (cfg["Image"] !== plan.image) v.push("image differs");
    if (!sameArray(cfg["Cmd"], plan.argv)) v.push("command differs");
    const ep = cfg["Entrypoint"];
    if (!(ep === null || ep === undefined || (Array.isArray(ep) && ep.every((e) => e === "")))) {
      v.push("entrypoint was not cleared");
    }
    if (labels[LABEL_MANAGED] !== "true" || labels[LABEL_EXECUTION] !== plan.executionId) {
      v.push("identifying labels missing");
    }
    if (host["NetworkMode"] !== "none") v.push("network is not none");
    if (host["Privileged"] !== false) v.push("privileged");
    if (host["ReadonlyRootfs"] !== true) v.push("root filesystem is writable");
    if (!sameArray(host["CapDrop"], ["ALL"])) v.push("capabilities not dropped");
    if (!isEmpty(host["CapAdd"])) v.push("capabilities added");
    const sec = host["SecurityOpt"];
    if (!Array.isArray(sec) || !sec.some((s) => s === "no-new-privileges" || s === "no-new-privileges=true")) {
      v.push("no-new-privileges missing");
    }
    const mem = l.memoryMb * 1024 * 1024;
    if (host["Memory"] !== mem || host["MemorySwap"] !== mem) v.push("memory limit differs");
    if (host["PidsLimit"] !== l.pids) v.push("pids limit differs");
    if (host["NanoCpus"] !== Math.round(l.cpus * 1e9)) v.push("cpu limit differs");
    if (host["PidMode"] === "host" || host["IpcMode"] === "host" || host["UTSMode"] === "host") {
      v.push("host namespace shared");
    }
    if (!isEmpty(host["Binds"])) v.push("unexpected binds");
    if (!isEmpty(host["Devices"])) v.push("devices attached");
    if (!isEmpty(host["VolumesFrom"])) v.push("volumes-from set");
    const tmpfs = obj(host["Tmpfs"]);
    const tmpfsKeys = Object.keys(tmpfs);
    const wantTmpfs = new Map<string, number>([["/tmp", l.tmpfsMb]]);
    for (const t of this.extraTmpfs) wantTmpfs.set(t.target, t.sizeMb);
    if (tmpfsKeys.length !== wantTmpfs.size || !tmpfsKeys.every((k) => wantTmpfs.has(k))) {
      v.push("unexpected tmpfs mounts");
    } else {
      for (const [key, sizeMb] of wantTmpfs) {
        const optStr = tmpfs[key];
        const opts = typeof optStr === "string" ? optStr.split(",").map((o) => o.trim()) : [];
        for (const need of ["noexec", "nosuid", "nodev", `size=${sizeMb}m`]) {
          if (!opts.includes(need)) v.push(`tmpfs ${key} option ${need} missing`);
        }
        if (opts.includes("exec") || opts.includes("suid") || opts.includes("dev") || opts.includes("ro")) {
          v.push(`tmpfs ${key} has a conflicting option`);
        }
      }
    }

    const log = obj(host["LogConfig"]);
    const logCfg = obj(log["Config"]);
    const logKeys = Object.keys(logCfg).sort();
    if (
      log["Type"] !== LOG_DRIVER ||
      logKeys.length !== 2 || logKeys[0] !== "max-file" || logKeys[1] !== "max-size" ||
      logCfg["max-size"] !== LOG_MAX_SIZE || logCfg["max-file"] !== LOG_MAX_FILE
    ) {
      v.push("log config is not json-file with max-size=64k and max-file=1");
    }

    const mounts = Array.isArray(info["Mounts"]) ? (info["Mounts"] as unknown[]) : [];
    const wanted = (plan.fixtureSource === null ? 0 : 1) + this.binds.length;
    if (mounts.length !== wanted) {
      v.push("unexpected mount count");
    } else {
      if (plan.fixtureSource !== null) {
        const m = obj(mounts.find((x) => obj(x)["Destination"] === FIXTURE_MOUNT_TARGET) ?? mounts[0]);
        if (m["Type"] !== "bind" || m["Destination"] !== FIXTURE_MOUNT_TARGET || m["RW"] !== false) {
          v.push("fixture mount is not a read-only bind at /fixture");
        }
        if (typeof m["Source"] !== "string" || m["Source"] !== plan.fixtureSource) {
          v.push("fixture mount source differs from the resolved fixture path");
        }
      }
      for (const b of this.binds) {
        const m = obj(mounts.find((x) => obj(x)["Destination"] === b.target));
        if (m["Type"] !== "bind" || m["RW"] !== false) v.push(`mount at ${b.target} is not a read-only bind`);
        if (typeof m["Source"] !== "string" || m["Source"] !== b.source) {
          v.push(`mount source at ${b.target} differs from the configured path`);
        }
      }
    }
    return v;
  }

  private ownedBy(info: Record<string, unknown>, executionId: string): boolean {
    const labels = obj(obj(info["Config"])["Labels"]);
    return labels[LABEL_MANAGED] === "true" && labels[LABEL_EXECUTION] === executionId;
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
    return { state: "error", reason: clip(r.stderr.trim() || "inspect failed") };
  }

  private control(args: readonly string[]): Promise<ProcessResult> {
    return this.exec(this.docker, args, {
      timeoutMs: this.limits.controlTimeoutMs,
      maxOutputBytes: CONTROL_OUTPUT_BYTES,
    });
  }
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (Array.isArray(v) && v.length === 0);
}

function sameArray(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((x, i) => x === expected[i]);
}
