/**
 * git-acquisition.ts — isolated clone adapter for public GitHub repositories.
 * Foundation only: NOT wired into the server, worker or any JobRunner, and it
 * has never been run against real Docker or a real proxy.
 *
 * What it does, in order, and where it stops:
 *  1. Validates the request (url.ts canonical URL + full 40-hex SHA). Docker
 *     and the egress guard are not contacted for invalid input.
 *  2. Asks the injected EgressGuard for an attestation. No attestation, or a
 *     malformed one, or one naming a default Docker network: FAIL CLOSED,
 *     nothing is created. The default guard (UnavailableEgressGuard) always
 *     fails, so acquisition is disabled until real proxy infrastructure exists.
 *  3. Requires `docker network inspect` to report the network as `Internal`.
 *     That is the only network property this adapter can verify itself. It does
 *     NOT verify the proxy's allowlist; that is the guard's claim and external.
 *  4. Creates a container (argument array, no shell, injected executor only):
 *     attested network, non-root, all capabilities dropped, read-only root,
 *     no bind mounts, no Docker socket, no host environment, tmpfs-only
 *     /work (disk bound) and /tmp, memory/cpu/pids limits, `--pull never`.
 *     The configuration is read back with `docker inspect` and compared with
 *     the intent before the container is started.
 *  5. Runs git inside it via `docker exec`: init, shallow fetch of the exact
 *     SHA, identity check, tree listing and policy check BEFORE checkout, then
 *     checkout and a final identity check.
 *  6. Always removes the container and proves absence (inspect + label query).
 *
 * Handoff: production has no export step, so a successful result proves
 * acquisition only. The optional `afterCheckout` hook exists solely for the
 * manual harness (test/manual-clone-check.ts, tar-extract.ts); it is unverified
 * against real Docker.
 *
 * Not covered: production export of the tree out of the tmpfs, proxy
 * enforcement, DNS behaviour inside the network, image provenance (the image
 * must provide `git` and `sleep`, is operator-prepared and allowlisted, and is
 * never pulled), seccomp/AppArmor beyond Docker defaults, and a trusted daemon.
 * `docker exec` timeout or abort kills the CLI client only; the process inside
 * stops when the container is force-removed in step 6.
 *
 * @module git-acquisition
 */

import type { ProcessExecutor, ProcessResult } from "./docker-sandbox.js";
import type { CleanupProof } from "./runner.js";
import {
  ACQ_UID_GID,
  GIT_ENV,
  TMP_MB,
  WORK_DIR,
  checkAcquisitionLimits,
  checkTreeListing,
  gitHardeningArgs,
  gitSteps,
  parseResolvedSha,
  sanitize,
  validateEgressAttestation,
  validateRepoOnly,
  validateSource,
  type AcquisitionLimits,
  type EgressGuard,
  type TreeManifest,
} from "./acquisition-policy.js";

export const ACQ_LABEL_MANAGED = "graveyard.managed";
export const ACQ_LABEL_ID = "graveyard.acquisition-id";
export const ACQ_LOG_DRIVER = "json-file";
export const ACQ_LOG_MAX_SIZE = "64k";
export const ACQ_LOG_MAX_FILE = "1";
/** Image-declared VOLUME path (alpine/git). Mounted as a bounded tmpfs so no anonymous volume is created. */
export const GIT_VOLUME_DIR = "/git";
export const GIT_VOLUME_TMPFS_OPTIONS: readonly string[] = ["rw", "noexec", "nosuid", "nodev", "size=16m"];
const NAME_PREFIX = "graveyard-acq-";
const CONTROL_OUTPUT_BYTES = 256 * 1024;

const EXECUTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,100}:[0-9]{1,6}$/;
const IMAGE_RE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;

/** Container name for an acquisition. "_" cannot occur in an id, so this is injective. */
export function acquisitionContainerName(executionId: string): string {
  if (!EXECUTION_ID_RE.test(executionId)) throw new Error("invalid execution id");
  return `${NAME_PREFIX}${executionId.replace(":", "_")}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AcquisitionOptions {
  executor: ProcessExecutor;
  /** Controlled egress. Use UnavailableEgressGuard until a real proxy exists. */
  egress: EgressGuard;
  /** Exact image references that may be used. Never pulled. Must contain `git` and `sleep`. */
  allowedImages: readonly string[];
  limits?: Partial<AcquisitionLimits>;
  /** Default "docker". */
  dockerBinary?: string;
  /** Injectable clock (epoch ms) for deadline tests. */
  now?: () => number;
  /**
   * Optional handoff hook, called after the final identity check and before cleanup.
   * Used only by the manual integration harness. Not set by any production code path.
   */
  afterCheckout?: (info: HandoffInfo) => Promise<void>;
}

export interface HandoffInfo {
  containerName: string;
  commit: string;
  manifest: TreeManifest;
  dockerBinary: string;
  remainingMs: number;
  signal?: AbortSignal;
}

export interface AcquisitionRequest {
  /** `<job id>:<attempt>`, as produced by leases.executionIdFor. */
  executionId: string;
  repoUrl: string;
  /** Pinned mode: full lowercase 40-hex commit SHA. Must be absent when `resolveHead` is true. */
  commit?: string;
  /**
   * Explicit unpinned mode. Fetches the remote's literal `HEAD` (depth-limited, same guarded
   * container, no credentials, no redirects) and resolves it to an immutable SHA. There is no ref
   * field: a branch, tag or any caller-chosen ref cannot be requested. Mutually exclusive with `commit`.
   */
  resolveHead?: true;
  image: string;
  signal?: AbortSignal;
}

export type AcquisitionOutcome =
  | { kind: "acquired"; commit: string; manifest: TreeManifest; durationMs: number; resolvedFromHead?: true }
  /** Request failed validation; nothing was contacted. */
  | { kind: "rejected"; reason: string }
  /** No verified controlled egress. Nothing was created. */
  | { kind: "network-unavailable"; reason: string }
  /** Docker could not be used. */
  | { kind: "unavailable"; reason: string }
  /** Container configuration read back from Docker differs from the intent; git never ran. */
  | { kind: "isolation-violation"; reason: string }
  /**
   * The fetched commit or tree violates source policy; nothing was checked out (or the check failed).
   * `commit` is set only in unpinned mode, when the resolved id was already known.
   */
  | { kind: "source-rejected"; reason: string; commit?: string }
  /** A git step exited nonzero (for example the commit does not exist). */
  | { kind: "failed"; step: string; reason: string }
  | { kind: "timed-out"; step: string }
  | { kind: "aborted"; step: string };

/** `cleanup` is null only when no container could have been created. */
export type AcquisitionResult = AcquisitionOutcome & { cleanup: CleanupProof | null };

interface Plan {
  name: string;
  executionId: string;
  repoUrl: string;
  /** Null: unpinned mode (literal HEAD, resolved inside the container). */
  commit: string | null;
  image: string;
}

interface Egress {
  network: string;
  proxyUrl: string;
}

interface RunCtx {
  plan: Plan;
  egress: Egress;
  hard: string[];
  deadline: number;
  signal: AbortSignal | undefined;
  startedAt: number;
}

type StepResult = { ok: true; result: ProcessResult } | { ok: false; outcome: AcquisitionOutcome };

type InspectState =
  | { state: "absent" }
  | { state: "present"; info: Record<string, unknown> }
  | { state: "error"; reason: string };

// ---------------------------------------------------------------------------

export class GitAcquisition {
  private readonly exec: ProcessExecutor;
  private readonly egress: EgressGuard;
  private readonly images: ReadonlySet<string>;
  private readonly limits: AcquisitionLimits;
  private readonly docker: string;
  private readonly now: () => number;
  private readonly afterCheckout: AcquisitionOptions["afterCheckout"];

  constructor(opts: AcquisitionOptions) {
    this.afterCheckout = opts.afterCheckout;
    if (typeof opts.executor !== "function") throw new Error("executor is required");
    if (typeof opts.egress !== "object" || opts.egress === null || typeof opts.egress.attest !== "function") {
      throw new Error("egress guard is required");
    }
    this.exec = opts.executor;
    this.egress = opts.egress;
    const images = new Set<string>();
    for (const img of opts.allowedImages) {
      if (typeof img !== "string" || img.length > 255 || !IMAGE_RE.test(img)) {
        throw new Error(`invalid image reference: ${String(img)}`);
      }
      images.add(img);
    }
    if (images.size === 0) throw new Error("at least one allowed image is required");
    this.images = images;
    this.limits = checkAcquisitionLimits(opts.limits);
    this.docker = opts.dockerBinary ?? "docker";
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(this.docker)) throw new Error("invalid dockerBinary");
    this.now = opts.now ?? ((): number => Date.now());
  }

  /** Acquires one commit, then always attempts cleanup and reports its proof. */
  async acquire(req: AcquisitionRequest): Promise<AcquisitionResult> {
    const planned = this.plan(req);
    if ("reason" in planned) return { kind: "rejected", reason: planned.reason, cleanup: null };
    const plan = planned;
    const signal = req.signal;
    const startedAt = this.now();

    // Fail closed unless controlled egress is attested and structurally valid.
    let attestation: unknown;
    try {
      attestation = await this.egress.attest(signal);
    } catch {
      attestation = { verified: false, reason: "egress guard raised an error" };
    }
    const egress = validateEgressAttestation(attestation);
    if (!egress.ok) return { kind: "network-unavailable", reason: egress.reason, cleanup: null };
    if (signal?.aborted === true) return { kind: "aborted", step: "egress", cleanup: null };

    // Availability and network gates: nothing is created unless both pass.
    try {
      const v = await this.control(["version", "--format", "{{.Server.Version}}"]);
      if (v.exitCode !== 0 || v.timedOut || v.stdout.trim() === "") {
        return { kind: "unavailable", reason: "docker daemon is not available", cleanup: null };
      }
      const net = await this.control(["network", "inspect", egress.value.network]);
      if (!isInternalNetwork(net, egress.value.network)) {
        return {
          kind: "network-unavailable",
          reason: "egress network is missing or not an Internal docker network",
          cleanup: null,
        };
      }
    } catch {
      return { kind: "unavailable", reason: "docker CLI could not be started", cleanup: null };
    }

    const ctx: RunCtx = {
      plan,
      egress: { network: egress.value.network, proxyUrl: egress.value.proxyUrl },
      hard: gitHardeningArgs(egress.value.proxyUrl),
      deadline: startedAt + this.limits.totalTimeoutMs,
      signal,
      startedAt,
    };

    let outcome: AcquisitionOutcome;
    try {
      outcome = await this.createVerifyRun(ctx);
    } catch {
      outcome = { kind: "unavailable", reason: "docker command could not be run" };
    }
    // From here a container may exist, so cleanup is always attempted.
    const cleanup = await this.cleanup({ executionId: plan.executionId });
    return { ...outcome, cleanup };
  }

  /**
   * Idempotent. Removes this execution's container only if it carries this
   * adapter's labels for exactly this id, then proves absence by inspect and a
   * label query. Never throws.
   */
  async cleanup(req: { executionId: string }): Promise<CleanupProof> {
    const executionId = req.executionId;
    const fail = (reason: string): CleanupProof => ({ confirmed: false, reason: sanitize(reason) });
    if (typeof executionId !== "string" || !EXECUTION_ID_RE.test(executionId)) {
      return fail("invalid execution id; cleanup not attempted");
    }
    const name = acquisitionContainerName(executionId);
    try {
      const before = await this.inspect(name);
      if (before.state === "error") return fail(`inspect failed: ${before.reason}`);
      if (before.state === "present") {
        const labels = obj(obj(before.info["Config"])["Labels"]);
        if (labels[ACQ_LABEL_MANAGED] !== "true" || labels[ACQ_LABEL_ID] !== executionId) {
          return fail("container with this name lacks this adapter's labels; refusing to remove it");
        }
        // The result of rm is not trusted; the inspect below is the proof.
        await this.control(["rm", "--force", "--volumes", name]);
        const after = await this.inspect(name);
        if (after.state === "error") return fail(`inspect after removal failed: ${after.reason}`);
        if (after.state === "present") return fail("container still present after removal");
      }
      const ps = await this.control([
        "ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${ACQ_LABEL_ID}=${executionId}`,
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

  private plan(req: AcquisitionRequest): Plan | { reason: string } {
    if (typeof req !== "object" || req === null) return { reason: "request must be an object" };
    if (typeof req.executionId !== "string" || !EXECUTION_ID_RE.test(req.executionId)) {
      return { reason: "invalid execution id" };
    }
    if (typeof req.image !== "string" || !this.images.has(req.image)) {
      return { reason: "image is not in the allowlist" };
    }
    const unpinned = (req as { resolveHead?: unknown }).resolveHead;
    if (unpinned !== undefined && unpinned !== true) return { reason: "resolveHead must be true when present" };
    if (unpinned === true) {
      if (req.commit !== undefined) return { reason: "commit and resolveHead are mutually exclusive" };
      const repo = validateRepoOnly(req.repoUrl);
      if (!repo.ok) return { reason: repo.reason };
      return {
        name: acquisitionContainerName(req.executionId),
        executionId: req.executionId,
        repoUrl: repo.value,
        commit: null,
        image: req.image,
      };
    }
    const src = validateSource(req.repoUrl, req.commit);
    if (!src.ok) return { reason: src.reason };
    return {
      name: acquisitionContainerName(req.executionId),
      executionId: req.executionId,
      repoUrl: src.value.repoUrl,
      commit: src.value.commit,
      image: req.image,
    };
  }

  private createArgs(ctx: RunCtx): string[] {
    const l = this.limits;
    const { plan, egress } = ctx;
    const args = [
      "create",
      "--name", plan.name,
      "--pull", "never",
      "--network", egress.network,
      "--user", ACQ_UID_GID,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${TMP_MB}m`,
      "--tmpfs", `${WORK_DIR}:rw,noexec,nosuid,nodev,size=${l.diskMb}m,uid=65532,gid=65532,mode=0700`,
      // alpine/git declares VOLUME /git; an explicit bounded tmpfs there replaces the anonymous volume.
      "--tmpfs", `${GIT_VOLUME_DIR}:${GIT_VOLUME_TMPFS_OPTIONS.join(",")}`,
      "--shm-size", "4m",
      "--memory", `${l.memoryMb}m`,
      "--memory-swap", `${l.memoryMb}m`,
      "--cpus", String(l.cpus),
      "--pids-limit", String(l.pids),
      "--restart", "no",
      "--log-driver", ACQ_LOG_DRIVER,
      "--log-opt", `max-size=${ACQ_LOG_MAX_SIZE}`,
      "--log-opt", `max-file=${ACQ_LOG_MAX_FILE}`,
      "--label", `${ACQ_LABEL_MANAGED}=true`,
      "--label", `${ACQ_LABEL_ID}=${plan.executionId}`,
      "--workdir", WORK_DIR,
      "--entrypoint", "",
    ];
    for (const e of GIT_ENV) args.push("--env", e);
    // The container ends itself after the total time bound even if nothing removes it.
    const lifetimeSeconds = Math.ceil(l.totalTimeoutMs / 1000) + 30;
    args.push(plan.image, "sleep", String(lifetimeSeconds));
    return args;
  }

  private async createVerifyRun(ctx: RunCtx): Promise<AcquisitionOutcome> {
    const { plan, signal } = ctx;
    const created = await this.control(this.createArgs(ctx));
    if (created.exitCode !== 0 || created.timedOut) {
      return { kind: "unavailable", reason: `docker create failed: ${sanitize(created.stderr.trim())}` };
    }
    const info = await this.inspect(plan.name);
    if (info.state !== "present") {
      return { kind: "unavailable", reason: "created container could not be inspected" };
    }
    const violations = this.verifyIsolation(info.info, ctx);
    if (violations.length > 0) {
      return { kind: "isolation-violation", reason: sanitize(violations.join("; ")) };
    }
    if (signal?.aborted === true) return { kind: "aborted", step: "start" };

    const started = await this.control(["start", plan.name]);
    if (started.exitCode !== 0 || started.timedOut) {
      return { kind: "unavailable", reason: `docker start failed: ${sanitize(started.stderr.trim())}` };
    }

    const init = await this.step(ctx, "init", gitSteps.init());
    if (!init.ok) return init.outcome;

    let commit: string;
    if (plan.commit === null) {
      // Unpinned intake: the literal remote HEAD, shallow, in this same guarded container. The
      // immutable id is whatever FETCH_HEAD resolves to; it must be exactly one lowercase 40-hex id.
      const fetchedHead = await this.step(ctx, "fetch", gitSteps.fetchHead(plan.repoUrl, this.limits.depth));
      if (!fetchedHead.ok) return fetchedHead.outcome;
      const resolved = await this.step(ctx, "verify-commit", gitSteps.resolveFetchHead());
      if (!resolved.ok) return resolved.outcome;
      if (resolved.result.truncated) {
        return { kind: "source-rejected", reason: "HEAD resolution output was truncated" };
      }
      const sha = parseResolvedSha(resolved.result.stdout);
      if (sha === null) {
        return { kind: "source-rejected", reason: "fetched HEAD did not resolve to a lowercase 40-hex commit id" };
      }
      commit = sha;
    } else {
      commit = plan.commit;
      const fetched = await this.step(ctx, "fetch", gitSteps.fetch(plan.repoUrl, commit, this.limits.depth));
      if (!fetched.ok) return fetched.outcome;

      const verified = await this.step(ctx, "verify-commit", gitSteps.verifyCommit(commit));
      if (!verified.ok) return verified.outcome;
      if (verified.result.stdout.trim() !== commit) {
        return { kind: "source-rejected", reason: "fetched commit does not match the requested SHA" };
      }
    }
    // Rejections after resolution carry the resolved id (unpinned mode only, so pinned outcomes are unchanged).
    const rejected = (reason: string): AcquisitionOutcome =>
      plan.commit === null ? { kind: "source-rejected", reason, commit } : { kind: "source-rejected", reason };

    const listing = await this.step(ctx, "list-tree", gitSteps.listTree(commit), this.limits.maxTreeListBytes);
    if (!listing.ok) return listing.outcome;
    if (listing.result.truncated) return rejected("tree listing exceeds the size limit");
    const manifest = checkTreeListing(listing.result.stdout, this.limits);
    if (!manifest.ok) return rejected(manifest.reason);

    const checkout = await this.step(ctx, "checkout", gitSteps.checkout(commit));
    if (!checkout.ok) return checkout.outcome;

    const head = await this.step(ctx, "verify-head", gitSteps.head());
    if (!head.ok) return head.outcome;
    if (head.result.stdout.trim() !== commit) {
      return rejected(
        plan.commit === null
          ? "checked-out HEAD does not match the resolved SHA"
          : "checked-out HEAD does not match the requested SHA",
      );
    }

    // Optional handoff hook (test harness only; never set in production). It runs while the
    // container still exists and before cleanup. Any throw fails the acquisition closed.
    if (this.afterCheckout !== undefined) {
      try {
        await this.afterCheckout({
          containerName: plan.name,
          commit,
          manifest: manifest.value,
          dockerBinary: this.docker,
          remainingMs: Math.max(0, ctx.deadline - this.now()),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (e) {
        return { kind: "failed", step: "handoff", reason: sanitize(e instanceof Error ? e.message : "handoff failed") };
      }
    }

    return {
      kind: "acquired",
      commit,
      manifest: manifest.value,
      durationMs: this.now() - ctx.startedAt,
      ...(plan.commit === null ? { resolvedFromHead: true as const } : {}),
    };
  }

  /** One `docker exec ... git ...` bounded by the step timeout and the remaining total time. */
  private async step(ctx: RunCtx, name: string, gitArgs: readonly string[], outputCap?: number): Promise<StepResult> {
    if (ctx.signal?.aborted === true) return { ok: false, outcome: { kind: "aborted", step: name } };
    const remaining = ctx.deadline - this.now();
    if (remaining <= 0) return { ok: false, outcome: { kind: "timed-out", step: name } };
    const timeoutMs = Math.min(this.limits.stepTimeoutMs, remaining);

    const r = await this.exec(
      this.docker,
      ["exec", "--user", ACQ_UID_GID, "--workdir", WORK_DIR, ctx.plan.name, "git", ...ctx.hard, ...gitArgs],
      {
        timeoutMs,
        maxOutputBytes: outputCap ?? this.limits.maxOutputBytes,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
    );
    if (r.timedOut) return { ok: false, outcome: { kind: "timed-out", step: name } };
    if (r.aborted) return { ok: false, outcome: { kind: "aborted", step: name } };
    if (r.exitCode !== 0) {
      const detail = r.exitCode === null ? "no exit code" : sanitize(r.stderr.trim());
      return { ok: false, outcome: { kind: "failed", step: name, reason: detail } };
    }
    return { ok: true, result: r };
  }

  /** Compares `docker inspect` output with the isolation this adapter asked for. */
  private verifyIsolation(info: Record<string, unknown>, ctx: RunCtx): string[] {
    const v: string[] = [];
    const l = this.limits;
    const { plan, egress } = ctx;
    const cfg = obj(info["Config"]);
    const host = obj(info["HostConfig"]);
    const labels = obj(cfg["Labels"]);

    if (cfg["User"] !== ACQ_UID_GID) v.push("user is not the fixed non-root uid:gid");
    if (cfg["Image"] !== plan.image) v.push("image differs");
    const env = Array.isArray(cfg["Env"]) ? (cfg["Env"] as unknown[]) : [];
    for (const e of GIT_ENV) if (!env.includes(e)) v.push("git hardening environment missing");
    const ep = cfg["Entrypoint"];
    if (!(ep === null || ep === undefined || (Array.isArray(ep) && ep.every((e) => e === "")))) {
      v.push("entrypoint was not cleared");
    }
    if (labels[ACQ_LABEL_MANAGED] !== "true" || labels[ACQ_LABEL_ID] !== plan.executionId) {
      v.push("identifying labels missing");
    }
    // The network must be exactly the attested one: never the default bridge, host or none.
    if (host["NetworkMode"] !== egress.network) v.push("container network is not the attested network");
    const nets = Object.keys(obj(obj(info["NetworkSettings"])["Networks"]));
    if (nets.length > 0 && (nets.length !== 1 || nets[0] !== egress.network)) v.push("container is attached to other networks");
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
    if (!isEmpty(info["Mounts"])) v.push("unexpected mounts");

    const tmpfs = obj(host["Tmpfs"]);
    const keys = Object.keys(tmpfs).sort();
    const wantKeys = ["/tmp", WORK_DIR, GIT_VOLUME_DIR].sort();
    if (keys.length !== wantKeys.length || !keys.every((k, i) => k === wantKeys[i])) {
      v.push("unexpected tmpfs mounts");
    } else {
      // /git must carry exactly the requested option set (order-insensitive).
      const gitRaw = tmpfs[GIT_VOLUME_DIR];
      const gitOpts = typeof gitRaw === "string" ? gitRaw.split(",").map((o) => o.trim()).sort() : [];
      const gitWant = [...GIT_VOLUME_TMPFS_OPTIONS].sort();
      if (gitOpts.length !== gitWant.length || !gitOpts.every((o, i) => o === gitWant[i])) {
        v.push(`tmpfs ${GIT_VOLUME_DIR} options differ from the required set`);
      }
      const want: Array<[string, number]> = [["/tmp", TMP_MB], [WORK_DIR, l.diskMb]];
      for (const [path, mb] of want) {
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
      log["Type"] !== ACQ_LOG_DRIVER ||
      logKeys.length !== 2 || logKeys[0] !== "max-file" || logKeys[1] !== "max-size" ||
      logCfg["max-size"] !== ACQ_LOG_MAX_SIZE || logCfg["max-file"] !== ACQ_LOG_MAX_FILE
    ) {
      v.push("log config is not json-file with max-size=64k and max-file=1");
    }
    return v;
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
    return this.exec(this.docker, args, {
      timeoutMs: this.limits.controlTimeoutMs,
      maxOutputBytes: CONTROL_OUTPUT_BYTES,
    });
  }
}

// ---------------------------------------------------------------------------

/** True only if `docker network inspect` shows exactly this network with Internal: true. */
function isInternalNetwork(r: ProcessResult, name: string): boolean {
  if (r.exitCode !== 0 || r.timedOut || r.truncated) return false;
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1) return false;
    const n = obj(parsed[0]);
    return n["Name"] === name && n["Internal"] === true;
  } catch {
    return false;
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
