/**
 * npm-scripts-pipeline.ts — host side of the opt-in npm-scripts mode: runs the trusted in-container
 * driver (npm-scripts-driver.ts) over ONE extracted source snapshot in a disposable network-`none`
 * container and classifies the single protocol line. Written without a shell or a test run
 * (UNVERIFIED until the operator runs the suite and the real-Docker harness).
 *
 * It reuses the existing, tested pieces unchanged: DockerFixtureSandbox (network none, uid 65532,
 * all capabilities dropped, no-new-privileges, read-only root, `--pull never`, bounded memory, pids,
 * time and output, isolation read back from `docker inspect` before start, label-based cleanup proof),
 * the strict protocol parser and classifyPipeline of controlled-pipeline.ts (success needs every
 * stage passed, npm's `added N packages` equal to the lock's count, confirmed container cleanup and
 * removed staging).
 *
 * What is mounted. The snapshot directory `<runDir>/<snapshot>` READ-ONLY at /fixture, and the
 * host-verified offline npm cache READ-ONLY at /npm-cache. /work and /tmp are bounded noexec tmpfs.
 * Before the container starts the host re-audits the snapshot with lstat (no symlinks, no special
 * files) and writes exactly two files into it: the trusted compiled driver (as `.mjs`, optionally
 * pinned by sha256) and the SANITIZED install manifest. Both are removed again after the run
 * ("staging removed"); the run directory itself is removed by the runner.
 *
 * The single command is `node /fixture/.graveyard-npm-scripts-driver.mjs`: fixed argv, no shell, no
 * request input. The only repository-authored commands that ever run are `npm run build` and
 * `npm run test`, inside that container (see the driver header).
 *
 * @module npm-scripts-pipeline
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditTree } from "./archive-handoff.js";
import {
  DEFAULT_PIPELINE_LIMITS,
  MAX_DRIVER_BYTES,
  PIPELINE_CACHE_MOUNT,
  PIPELINE_WORK_MOUNT,
  PIPELINE_WORK_TMPFS_MB,
  classifyPipeline,
  type ControlledPipelineResult,
  type PipelineReason,
  type PipelineRequest,
} from "./controlled-pipeline.js";
import { DockerFixtureSandbox, containerNameFor, type ProcessExecutor, type SandboxLimits, type SandboxResult } from "./docker-sandbox.js";
import { NODE_FIXTURE_IMAGE, tailOf } from "./node-fixture-runner.js";
import { SCRIPTS_DRIVER_NAME, SCRIPTS_INSTALL_MANIFEST_NAME } from "./npm-scripts-driver.js";
import type { CleanupProof } from "./runner.js";

export const SCRIPTS_COMMAND_ID = "npm-scripts-pipeline";
export const SCRIPTS_ARGV: readonly string[] = Object.freeze(["node", `/fixture/${SCRIPTS_DRIVER_NAME}`]);
const MAX_INSTALL_MANIFEST_BYTES = 8 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SNAPSHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface NpmScriptsPipelineOptions {
  executor: ProcessExecutor;
  /** Absolute run directory that contains the snapshot directory. It becomes the sandbox fixturesRoot. */
  runDir: string;
  /** Name of the snapshot directory under `runDir`. */
  snapshot: string;
  /** Absolute host-verified offline npm cache. Mounted read-only. */
  cacheDir: string;
  /** The SANITIZED package.json text (the original without `scripts`). */
  installManifest: string;
  /** Packages `npm ci` must report as added (the lock's own count). */
  expectedPackages: number;
  /**
   * The shared dev-dependency policy option (npm-lock-policy.ts NpmDependencyPolicy). Default (absent or
   * false): an install manifest that has any `devDependencies` key makes the pipeline refuse to run
   * (`unconfigured`), so a dev install can never happen by accident. True: the in-container driver
   * installs with `--include=dev` when the manifest lists them. The caller passes the plan's value.
   */
  allowDevDependencies?: boolean;
  image?: string;
  /** Absolute path of the compiled driver. Default: npm-scripts-driver.js next to this module. */
  driverPath?: string;
  expectedDriverSha256?: string;
  limits?: Partial<SandboxLimits>;
  dockerBinary?: string;
  realpath?: (path: string) => string;
}

function defaultDriverPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "npm-scripts-driver.js");
}

function readCappedFile(path: string, max: number): Buffer | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** True when the manifest text parses to an object with an own `devDependencies` key. Unparsable text is false (the driver refuses it). */
function manifestHasDevDependenciesKey(text: string): boolean {
  try {
    const doc: unknown = JSON.parse(text);
    return typeof doc === "object" && doc !== null && !Array.isArray(doc) && Object.prototype.hasOwnProperty.call(doc, "devDependencies");
  } catch {
    return false;
  }
}

function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export class NpmScriptsPipeline {
  private readonly sandbox: DockerFixtureSandbox | null;
  private readonly image: string;
  private readonly snapshot: string;
  private readonly snapshotDir: string | null;
  private readonly installManifest: string;
  private readonly expectedPackages: number;
  private readonly driverPath: string;
  private readonly expectedSha: string | null;
  private readonly unavailable: { reason: PipelineReason; detail: string } | null;

  constructor(opts: NpmScriptsPipelineOptions) {
    this.image = opts.image ?? NODE_FIXTURE_IMAGE;
    this.snapshot = opts.snapshot;
    this.installManifest = opts.installManifest;
    this.expectedPackages = opts.expectedPackages;
    this.driverPath = opts.driverPath ?? defaultDriverPath();
    this.expectedSha = opts.expectedDriverSha256 ?? null;
    const realpath = opts.realpath ?? ((p: string): string => realpathSync(p));
    let sandbox: DockerFixtureSandbox | null = null;
    let snapshotDir: string | null = null;
    let unavailable: { reason: PipelineReason; detail: string } | null = null;
    try {
      if (![opts.runDir, opts.cacheDir, this.driverPath].every((p) => typeof p === "string" && isAbsolute(p))) {
        throw new Error("runDir, cacheDir and driverPath must be absolute paths");
      }
      if (this.expectedSha !== null && !SHA256_RE.test(this.expectedSha)) throw new Error("expectedDriverSha256 must be 64 lowercase hex characters");
      if (typeof this.snapshot !== "string" || !SNAPSHOT_NAME_RE.test(this.snapshot)) throw new Error("invalid snapshot name");
      if (typeof this.installManifest !== "string" || Buffer.byteLength(this.installManifest, "utf8") > MAX_INSTALL_MANIFEST_BYTES) {
        throw new Error("the install manifest is missing or too large");
      }
      if (!Number.isInteger(this.expectedPackages) || this.expectedPackages < 1) throw new Error("expectedPackages must be a positive integer");
      if (opts.allowDevDependencies !== true && manifestHasDevDependenciesKey(this.installManifest)) {
        throw new Error("the install manifest has devDependencies but the dev dependency policy option is not enabled");
      }
      const root = realpath(resolve(opts.runDir));
      snapshotDir = realpath(resolve(root, this.snapshot));
      const rel = relative(root, snapshotDir);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("the snapshot escapes the run directory");
      let cache: string | null = null;
      try {
        cache = realpath(resolve(opts.cacheDir));
        if (!lstatSync(cache).isDirectory()) cache = null;
      } catch {
        cache = null;
      }
      if (cache === null) {
        unavailable = { reason: "cache-unavailable", detail: "the offline npm cache directory does not exist; nothing was run" };
      } else {
        sandbox = new DockerFixtureSandbox({
          executor: opts.executor,
          allowedImages: [this.image],
          commands: { [SCRIPTS_COMMAND_ID]: SCRIPTS_ARGV },
          fixturesRoot: root,
          readonlyBinds: [{ source: cache, target: PIPELINE_CACHE_MOUNT }],
          extraTmpfs: [{ target: PIPELINE_WORK_MOUNT, sizeMb: PIPELINE_WORK_TMPFS_MB }],
          limits: { ...DEFAULT_PIPELINE_LIMITS, ...(opts.limits ?? {}) },
          realpath,
          ...(opts.dockerBinary === undefined ? {} : { dockerBinary: opts.dockerBinary }),
        });
      }
    } catch (e) {
      unavailable = { reason: "unconfigured", detail: e instanceof Error ? e.message : "invalid configuration" };
      sandbox = null;
    }
    this.sandbox = sandbox;
    this.snapshotDir = snapshotDir;
    this.unavailable = unavailable;
  }

  /** Never throws. Reports container cleanup evidence whenever a container could exist. */
  async run(req: PipelineRequest): Promise<ControlledPipelineResult> {
    const executionId = typeof req?.executionId === "string" ? req.executionId : null;
    const expectedPackages = this.expectedPackages;
    const notRun = (reason: PipelineReason, detail: string, extra: Partial<ControlledPipelineResult> = {}): ControlledPipelineResult => ({
      status: "not-run", reason, detail, failedStage: null, stages: null, exitCode: null, durationMs: null,
      truncated: false, stderrTail: "", packagesAdded: null, expectedPackages, violations: [],
      cleanup: null, stagingRemoved: null, driverSha256: null, executionId, ...extra,
    });

    if (req?.signal?.aborted === true) return notRun("aborted", "cancelled before start; nothing was created");
    if (this.unavailable !== null || this.sandbox === null || this.snapshotDir === null) {
      const u = this.unavailable ?? { reason: "unconfigured" as const, detail: "pipeline is not configured" };
      return notRun(u.reason, u.detail);
    }
    try {
      containerNameFor(req.executionId);
    } catch {
      return notRun("rejected", "invalid execution id");
    }
    if (req.fixture !== this.snapshot) return notRun("rejected", "the request names a different snapshot than this pipeline was built for");

    // Host-side audit immediately before mounting: nothing but regular files and directories.
    try {
      auditTree(this.snapshotDir);
    } catch {
      return notRun("unreadable-input", "the snapshot failed the lstat audit; nothing was run");
    }
    const driverPath = join(this.snapshotDir, SCRIPTS_DRIVER_NAME);
    const manifestPath = join(this.snapshotDir, SCRIPTS_INSTALL_MANIFEST_NAME);
    if (!absent(driverPath) || !absent(manifestPath)) return notRun("staging-failed", "the snapshot already contains a reserved name; nothing was run");

    // The trusted compiled driver.
    const driver = readCappedFile(this.driverPath, MAX_DRIVER_BYTES);
    if (driver === null) return notRun("driver-unavailable", "the compiled driver is missing or unreadable; run the build first");
    const driverSha256 = createHash("sha256").update(driver).digest("hex");
    if (this.expectedSha !== null && this.expectedSha !== driverSha256) {
      return notRun("driver-unavailable", "the compiled driver does not match the pinned sha256; nothing was run", { driverSha256 });
    }

    // Stage exactly two files into the snapshot directory (exclusive create).
    const written: string[] = [];
    const removeStaged = (): { removed: boolean; problem: string | null } => {
      let problem: string | null = null;
      for (const p of written) {
        try {
          if (!lstatSync(p).isFile()) throw new Error("not a regular file");
          unlinkSync(p);
        } catch (e) {
          problem = e instanceof Error ? e.message : String(e);
        }
      }
      return { removed: problem === null, problem };
    };
    try {
      writeFileSync(driverPath, driver, { flag: "wx", mode: 0o644 });
      written.push(driverPath);
      writeFileSync(manifestPath, this.installManifest, { flag: "wx", mode: 0o644 });
      written.push(manifestPath);
    } catch {
      const removal = removeStaged();
      return notRun("staging-failed", "could not write the staged files; nothing was run", { driverSha256, stagingRemoved: removal.removed });
    }

    // One fixed command in a disposable container.
    let res: SandboxResult | null = null;
    let cleanup: CleanupProof | null = null;
    try {
      res = await this.sandbox.execute({
        executionId: req.executionId,
        commandId: SCRIPTS_COMMAND_ID,
        image: this.image,
        fixture: this.snapshot,
        ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
        ...(req.signal === undefined ? {} : { signal: req.signal }),
      });
      cleanup = res.cleanup;
    } catch {
      cleanup = await this.sandbox.cleanup({ executionId: req.executionId });
    }

    const removal = removeStaged();
    if (res === null) {
      return notRun("docker-unavailable", "sandbox call failed unexpectedly", { driverSha256, cleanup, stagingRemoved: removal.removed });
    }

    // testPresent is always true: this mode requires a test script, so a skipped test stage is a protocol error.
    let v = classifyPipeline(res, expectedPackages, true);
    if (v.status !== "not-run" && cleanup?.confirmed !== true) {
      const why = cleanup === null ? "no cleanup proof" : cleanup.confirmed ? "" : cleanup.reason;
      v = { ...v, status: "not-run", reason: "cleanup-unconfirmed", detail: `container cleanup was not confirmed (${why}); no verdict can be reported` };
    } else if (v.status !== "not-run" && !removal.removed) {
      v = { ...v, status: "not-run", reason: "staging-cleanup-failed", detail: `staged files were not removed (${removal.problem ?? "unknown"}); no verdict can be reported` };
    }

    const out =
      res.kind === "exited" || res.kind === "timed-out" || res.kind === "aborted"
        ? { exitCode: res.kind === "exited" ? res.exitCode : null, durationMs: res.durationMs, truncated: res.truncated, stderr: res.stderr }
        : { exitCode: null, durationMs: null, truncated: false, stderr: "" };
    return {
      status: v.status,
      reason: v.reason,
      detail: v.detail,
      failedStage: v.failedStage,
      stages: v.stages,
      exitCode: out.exitCode,
      durationMs: out.durationMs,
      truncated: out.truncated,
      stderrTail: tailOf(out.stderr),
      packagesAdded: v.packagesAdded,
      expectedPackages,
      violations: [],
      cleanup,
      stagingRemoved: removal.removed,
      driverSha256,
      executionId,
    };
  }
}
