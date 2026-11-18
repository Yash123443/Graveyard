/**
 * github-runner.ts — JobRunner for operator-PINNED public GitHub repositories. This is what the
 * opt-in worker (worker-compose.ts) runs when GRAVEYARD_GITHUB_CATALOG is configured. Written
 * without a shell by Kiro; later compiled and unit-tested (fakes only) in an external run. Not yet
 * run against real Docker or GitHub (see backend/DEVELOPMENT.md, "GitHub repository flow").
 *
 * Which jobs it takes. Only a job whose canonical repository URL is a key of the operator's pin
 * catalog (URL -> full 40-hex commit). The commit is never resolved from a branch or taken from a
 * request. URLs of the fixture catalog, and every URL in neither catalog, go to the fallback
 * runner (PipelineJobRunner), which refuses unknown repositories with infrastructure-unavailable.
 *
 * Flow (every step fails closed; stage events are fenced writes through ctx.report):
 *   cloning    GitAcquisition fetches exactly the pinned commit inside a disposable container on the
 *              attested github.com-only network, checks the tree policy, and the afterCheckout hook
 *              reads four root files as raw blobs (github-source.ts). The host never gets the repo.
 *   analyzing  analyzeRootFiles (pure) decides whether the files are in the supported class.
 *              Unsupported -> the job COMPLETES with verdict "unsupported-repository" and the exact
 *              findings. Nothing is built or run. (Not a verdict that the repository is broken.)
 *   building   Supported and registry egress configured -> runRegistryThenOffline: a network-
 *              acquiring `npm ci --ignore-scripts` through the registry.npmjs.org-only proxy with a
 *              host-verified cache handoff, then the existing network-none offline install, build
 *              and test in one disposable container. Repository code (build.mjs, test.mjs) runs
 *              ONLY in that container; never on the host. Then PipelineJobRunner does the Tester
 *              verdict and the optional advisory agents exactly as for fixtures.
 *   Not-run or inconclusive anywhere -> infrastructure-unavailable (the job fails, no result).
 *
 * Host files. One run directory under the operator's GRAVEYARD_GITHUB_RUNS_ROOT per job holds the
 * four root files and the npm cache. It is removed (removeRunDir, exact path, no recursive delete)
 * before the runner returns; if it cannot be removed the job is failed instead of completed.
 *
 * cleanup(): proves that the sandbox, the git acquisition and the registry acquisition containers
 * of the execution are all absent (three independent proofs); any unconfirmed proof is unconfirmed.
 *
 * Not done: branch/default-branch resolution, repositories outside the narrow class, patch
 * application, repair verification, real-Docker verification of any step here.
 *
 * Static site profile (`readStaticSite`; written without a shell, NOT compiled or run). A PINNED
 * repository with no package.json and a regular root index.html is audited read-only inside the same
 * acquisition container (static-site-audit.ts): the tree listing plus capped HTML and CSS blobs are
 * read as text, nothing is copied to the host, run, built or requested over the network, and no agent
 * is used. The job completes with verdict "static-site-audited": missing local page and asset
 * references as diagnostics with a stated partial scope, never a repair and never a pass claim.
 * Repositories with a package.json (npm and build.mjs dispatch) are unaffected.
 *
 * Unpinned intake (opt-in, `allowUnpinned`; written without a shell, NOT compiled or run). A URL in
 * neither the fixture catalog nor the pin catalog is, only when enabled, fetched at its literal
 * remote HEAD in the same guarded git container, resolved to an immutable SHA, tree-checked, and its
 * four root files read as data. The job completes with verdict "source-inspected" (sourceKind
 * "github-unpinned-head"), the resolved SHA and the manifest findings. No run directory, no
 * dependency acquisition, no sandbox, no repository script and no agent is used, so no source goes
 * to Kiro. The operator must pin the reported SHA before anything executes. Precedence is fixture,
 * then pin, then unpinned; pinned behaviour is unchanged. When npm-scripts mode is also configured
 * and the root package.json declares `scripts`, the same pure planNpmScripts policy a pinned run uses
 * decides the findings (result `analysis.profile: "npm-scripts"` and `analysis.rootChecks`). A pass is
 * preliminary (two root files only; snapshot limits, install, build and tests unchecked), never a
 * build result. Still no snapshot, registry, sandbox or agent.
 *
 * npm-scripts mode (opt-in, `npmScripts`; written without a shell, NOT compiled or run). Only for a
 * PINNED repository whose package.json declares `scripts`, and only when configured. If it fits the
 * profile (npm-scripts-policy.ts) a bounded snapshot of the pinned tree is exported through the same
 * git container (npm-scripts-snapshot.ts), dependencies are acquired from a manifest with `scripts`
 * removed, and `npm run build` / `npm run test` run offline in the network-none container
 * (npm-scripts-pipeline.ts). The result keeps the existing verdicts ("verified",
 * "repository-failing", "unsupported-repository") and adds `runMode: "npm-scripts"`. Without the
 * explicit agent setup no agent and no repair verifier is used in this mode and no repair is ever
 * claimed. With agents configured (GRAVEYARD_WORKER_AGENTS) AND a baseline that failed at the build
 * stage of a `node FILE` build script, the opt-in verified repair (npm-scripts-repair.ts) runs the
 * Analyst and Fixer on bounded redacted evidence plus the complete build entry, and verifies a
 * validated single-file proposal on an audited disposable copy with the same cache and a distinct
 * execution id (`deriveRepairExecutionId`, also proven by cleanup()). Written without a shell, NOT
 * compiled or run. The root build.mjs flow above is unchanged and is taken whenever package.json has
 * no `scripts`.
 *
 * @module github-runner
 */

import { randomBytes } from "node:crypto";
import { GIT_SHA_RE, sanitize, type TreeManifest } from "./acquisition-policy.js";
import type { ControlledPipelineResult } from "./controlled-pipeline.js";
import { createRunDir, removeRunDir, writeFixture } from "./fixture-workspace.js";
import type { AcquisitionRequest, AcquisitionResult, HandoffInfo } from "./git-acquisition.js";
import { analyzeRootFiles, emptyFacts, projectAnalysis, type Analysis, type RootFiles } from "./github-analysis.js";
import { NODE_FIXTURE_IMAGE } from "./node-fixture-runner.js";
import { OPERATOR_FIXTURE_ID, type RegistryAcquisitionRequest, type RegistryAcquisitionResult } from "./npm-registry-acquisition.js";
import {
  NO_REPORTER_REASON,
  PipelineJobRunner,
  type AgentsLike,
  type ControlledSource,
  type PipelineLike,
  type SourceFile,
} from "./pipeline-runner.js";
import { runRegistryThenOffline } from "./registry-pipeline.js";
import type { CleanupProof, CleanupRequest, JobProgress, JobRunner, RunContext, RunOutcome } from "./runner.js";
import { judgeScriptsRun, scriptsUnsupportedPayload } from "./npm-scripts-flow.js";
import { declaresScripts, planNpmScripts, NPM_SCRIPTS_RUN_MODE, type ScriptsFinding, type ScriptsPlan } from "./npm-scripts-policy.js";
import { parseBuildEntryScript, parseRepairTestScript } from "./build-entry.js";
import { applyRepairStep, deriveRepairExecutionId, runNpmScriptsRepairStep } from "./npm-scripts-repair.js";
import type { SnapshotOutcome } from "./npm-scripts-snapshot.js";
import { staticSiteResultPayload, type StaticSiteAudit, type StaticSiteRead } from "./static-site-audit.js";

const EVIDENCE_TEXT_BYTES = 3500;

/**
 * Opt-in npm-scripts mode (npm-scripts-policy.ts, npm-scripts-snapshot.ts, npm-scripts-pipeline.ts).
 * Absent (the default): a pinned repository whose package.json declares `scripts` is reported as
 * unsupported exactly as before. Present: such a repository that fits the profile has a bounded
 * snapshot of its files exported through the git container and its `npm run build` / `npm run test`
 * run offline in the network-none container. No agent is used and nothing is ever patched.
 */
export interface NpmScriptsOptions {
  /** Exports the checked-out commit as a bounded, audited snapshot below `runDir` (npm-scripts-snapshot.exportSnapshot). */
  exportSnapshot: (
    info: HandoffInfo,
    runDir: string,
    expect: { packageJson: string; packageLock: string },
  ) => Promise<SnapshotOutcome>;
  /** Builds the offline pipeline for one snapshot with the host-verified cache. */
  makePipeline: (a: {
    runDir: string;
    snapshot: string;
    cacheDir: string;
    installManifest: string;
    expectedPackages: number;
    /** Present (true) only for a plan made with the shared dev-dependency option; absent: legacy. */
    allowDevDependencies?: true;
  }) => PipelineLike;
  /**
   * The ONE shared dev-dependency policy option for this mode (npm-lock-policy.ts NpmDependencyPolicy).
   * Absent or false (the default): production-only profile, unchanged. True: ordinary single-package
   * projects with flat unscoped devDependencies (for example `typescript`) are planned, acquired with
   * `npm ci --include=dev --ignore-scripts`, and installed offline the same way. The runner passes it
   * to planNpmScripts, then the plan's value to the acquisition request and to makePipeline.
   */
  allowDevDependencies?: boolean;
}

/** GitAcquisition satisfies this. */
export interface GitLike {
  acquire(req: AcquisitionRequest): Promise<AcquisitionResult>;
  cleanup(req: { executionId: string }): Promise<CleanupProof>;
}

/** NpmRegistryAcquisition satisfies this. */
export interface RegistryLike {
  acquire(req: RegistryAcquisitionRequest): Promise<RegistryAcquisitionResult>;
  cleanup(req: { executionId: string }): Promise<CleanupProof>;
}

export interface GithubRunnerOptions {
  /** Takes every job this runner does not handle (fixture URLs and unknown URLs). */
  fallback: JobRunner;
  /** Fixture catalog URLs. They always go to the fallback, even if they also appear in `pins`. */
  fixtureUrls: ReadonlySet<string>;
  /** Canonical repository URL -> full lowercase 40-hex commit. May be empty only when `allowUnpinned` is true. */
  pins: ReadonlyMap<string, string>;
  /**
   * Opt-in unpinned intake. A URL in neither catalog is then inspected (HEAD resolved to a SHA, root
   * files read as data) instead of refused, and completes as "source-inspected". Nothing is run.
   * Default false. Fixture and pin entries always take precedence.
   */
  allowUnpinned?: boolean;
  /**
   * Opt-in npm-scripts mode for PINNED repositories only (never for unpinned intake, never for
   * fixtures). Absent: off, behaviour unchanged. Requires `registry` to be non-null to do anything.
   */
  npmScripts?: NpmScriptsOptions;
  /** Existing real directory owned by the worker; each job gets one `run-<12 hex>` directory in it. */
  runsRoot: string;
  /** Local image with `git` and `sleep` (never pulled). */
  gitImage: string;
  /** Builds an acquisition adapter whose afterCheckout hook is `hook`. */
  makeGit: (hook: (info: HandoffInfo) => Promise<void>) => GitLike;
  /** Reads the four root files inside the acquisition container (github-source.readRootFiles). */
  readRootFiles: (info: HandoffInfo) => Promise<RootFiles>;
  /**
   * Opt-in STATIC SITE audit (static-site-audit.ts) for a pinned repository with no package.json.
   * Called in the acquisition container, only when the root files show no package.json; it answers
   * "not-static-site" unless a regular root index.html exists. Absent: behaviour unchanged.
   */
  readStaticSite?: (info: HandoffInfo) => Promise<StaticSiteRead>;
  /** Null when registry egress is not configured: supported repositories are then reported as not runnable. */
  registry: RegistryLike | null;
  /** Offline pipeline for one run: fixtures under `runDir`, cache mounted read-only from `cacheDir`. */
  makePipeline: (runDir: string, cacheDir: string) => PipelineLike;
  /** Proves the pipeline sandbox container of an execution is absent. */
  cleanupExecution: (executionId: string) => Promise<CleanupProof>;
  agents?: AgentsLike;
}

const infra = (reason: string): RunOutcome => ({ kind: "infrastructure-unavailable", reason });
const ABORTED: RunOutcome = { kind: "aborted" };

/** The registry acquisition needs an id different from the pipeline's. `<uuid>-npm:<n>`. */
export function deriveRegistryExecutionId(executionId: string): string | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,90}):([0-9]{1,6})$/.exec(executionId);
  if (m === null) return null;
  return `${m[1] as string}-npm:${m[2] as string}`;
}

function notRunPipeline(executionId: string, detail: string): ControlledPipelineResult {
  return {
    status: "not-run",
    reason: "cache-unavailable",
    detail,
    failedStage: null,
    stages: null,
    exitCode: null,
    durationMs: null,
    truncated: false,
    stderrTail: "",
    packagesAdded: null,
    expectedPackages: null,
    violations: [],
    cleanup: null,
    stagingRemoved: null,
    driverSha256: null,
    executionId,
  };
}

function describeAcquisition(a: AcquisitionResult): string {
  switch (a.kind) {
    case "failed":
      return `failed at git step ${a.step}: ${sanitize(a.reason, 160)}`;
    case "timed-out":
      return `timed-out at git step ${a.step}`;
    case "aborted":
      return `aborted at git step ${a.step}`;
    case "acquired":
      return "acquired";
    default:
      return `${a.kind}: ${sanitize(a.reason, 160)}`;
  }
}

/** The analysis shape an unpinned inspection stores (root build.mjs class or npm-scripts profile findings). */
interface InspectedAnalysis {
  supported: boolean;
  findings: ReadonlyArray<{ code: string; detail: string }>;
  facts: Analysis["facts"];
}

/**
 * Preliminary npm-scripts profile result of an unpinned inspection, from the two root files only.
 * `passed` never means the repository builds or passes its tests: nothing was installed or run, and
 * the snapshot limits (file count and size) are checked only when a pinned run exports the tree.
 */
export interface NpmScriptsRootChecks {
  passed: boolean;
  preliminary: true;
  /** Present when passed: the validated printable one-line scripts and the locked package count. */
  buildScript?: string;
  testScript?: string;
  expectedPackages?: number;
  /** Root build entry named by a `node FILE` build script, or null (the verified repair needs one). */
  repairBuildEntry?: string | null;
  /** True when scripts.test is exactly `node --test` or `node --test FILE` (the verified repair needs it). */
  repairTestScript?: boolean;
}

export function npmScriptsRootChecks(plan: ScriptsPlan): NpmScriptsRootChecks {
  if (!plan.ok) return { passed: false, preliminary: true };
  return {
    passed: true,
    preliminary: true,
    buildScript: plan.buildScript,
    testScript: plan.testScript,
    expectedPackages: plan.expectedPackages,
    repairBuildEntry: parseBuildEntryScript(plan.buildScript),
    repairTestScript: parseRepairTestScript(plan.testScript) !== null,
  };
}

export class GithubJobRunner implements JobRunner {
  private readonly o: GithubRunnerOptions;

  constructor(opts: GithubRunnerOptions) {
    if (
      typeof opts?.fallback?.run !== "function" ||
      !(opts.pins instanceof Map) ||
      !(opts.fixtureUrls instanceof Set) ||
      typeof opts.makeGit !== "function" ||
      typeof opts.readRootFiles !== "function" ||
      (opts.readStaticSite !== undefined && typeof opts.readStaticSite !== "function") ||
      typeof opts.makePipeline !== "function" ||
      typeof opts.cleanupExecution !== "function" ||
      typeof opts.runsRoot !== "string" ||
      typeof opts.gitImage !== "string" ||
      (opts.allowUnpinned !== undefined && typeof opts.allowUnpinned !== "boolean") ||
      (opts.npmScripts !== undefined &&
        (typeof opts.npmScripts.exportSnapshot !== "function" || typeof opts.npmScripts.makePipeline !== "function"))
    ) {
      throw new Error("fallback, pins, fixtureUrls, runsRoot, gitImage, makeGit, readRootFiles, makePipeline and cleanupExecution are required");
    }
    this.o = opts;
  }

  async run(ctx: RunContext): Promise<RunOutcome> {
    // Precedence: fixture catalog first, then an operator pin, then (only if enabled) unpinned
    // intake. Anything else goes to the fallback, which refuses unknown repositories.
    if (this.o.fixtureUrls.has(ctx.repoUrl)) return this.o.fallback.run(ctx);
    const commit = this.o.pins.get(ctx.repoUrl);
    if (commit === undefined) {
      if (this.o.allowUnpinned !== true) return this.o.fallback.run(ctx);
      return this.runUnpinned(ctx);
    }

    const report = ctx.report;
    if (report === undefined) return infra(NO_REPORTER_REASON);
    if (ctx.signal.aborted) return ABORTED;
    const registryId = deriveRegistryExecutionId(ctx.executionId);
    if (registryId === null) return infra("The execution id has an unexpected form; nothing was fetched.");

    let runDir: string;
    try {
      runDir = createRunDir(this.o.runsRoot);
    } catch {
      return infra("A run directory could not be created; nothing was fetched.");
    }

    let outcome: RunOutcome;
    try {
      outcome = await this.runInRunDir(ctx, report, commit, runDir, registryId);
    } catch {
      outcome = infra("The GitHub flow raised an unexpected error; no result was produced.");
    }

    const removal = removeRunDir(this.o.runsRoot, runDir);
    if (!removal.removed && outcome.kind === "completed") {
      return infra("The run directory could not be removed, so the job is failed rather than completed.");
    }
    return outcome;
  }

  private async runInRunDir(
    ctx: RunContext,
    report: JobProgress,
    commit: string,
    runDir: string,
    registryId: string,
  ): Promise<RunOutcome> {
    if (!report.stage("cloning", "fetching the pinned commit through the controlled github.com proxy")) return ABORTED;

    const box: { files: RootFiles | null; snapshot: SnapshotOutcome | null; site: StaticSiteRead | null } = {
      files: null,
      snapshot: null,
      site: null,
    };
    const scripts = this.o.npmScripts;
    const git = this.o.makeGit(async (info) => {
      const read = await this.o.readRootFiles(info);
      box.files = read;
      // Static site profile: only when there is no package.json at all (an unusable one is not "none").
      // Read-only listing plus capped HTML and CSS blobs inside this container; nothing is copied to the host.
      if (this.o.readStaticSite !== undefined && read.packageJson === null && !read.unusable.includes("package.json")) {
        box.site = await this.o.readStaticSite(info);
      }
      // Opt-in npm-scripts mode: export the bounded snapshot only when the two root files already
      // pass the profile policy, so an unsupported repository never has any tree copied to the host.
      if (scripts !== undefined && this.o.registry !== null && declaresScripts(read.packageJson)) {
        const plan = planNpmScripts(read, { dependencyAcquisition: true, allowDevDependencies: scripts.allowDevDependencies === true });
        if (plan.ok && read.packageJson !== null && read.packageLock !== null) {
          box.snapshot = await scripts.exportSnapshot(info, runDir, { packageJson: read.packageJson, packageLock: read.packageLock });
        }
      }
    });
    const acq = await git.acquire({
      executionId: ctx.executionId,
      repoUrl: ctx.repoUrl,
      commit,
      image: this.o.gitImage,
      signal: ctx.signal,
    });
    if (ctx.signal.aborted || acq.kind === "aborted") return ABORTED;
    if (acq.cleanup !== null && acq.cleanup.confirmed !== true) {
      return infra("The acquisition container could not be proven removed; nothing was used.");
    }

    if (acq.kind === "source-rejected") {
      const analysis: Analysis = {
        supported: false,
        findings: [{ code: "source-policy-rejected", detail: sanitize(acq.reason, 200) }],
        facts: emptyFacts(),
      };
      return this.finishUnsupported(report, ctx.repoUrl, commit, analysis);
    }
    if (acq.kind !== "acquired") return infra(`The pinned commit was not acquired (${describeAcquisition(acq)}).`);
    if (acq.cleanup === null) return infra("The acquisition reported no cleanup proof; nothing was used.");
    if (acq.commit !== commit) return infra("The acquired commit differs from the pin; nothing was used.");
    const files = box.files;
    if (files === null) return infra("The root files were not read from the acquired commit.");

    if (!report.stage("analyzing", "reading the repository root files and checking the supported class")) return ABORTED;
    if (box.site !== null && box.site.kind === "audited") {
      return this.finishStaticSite(report, ctx.repoUrl, commit, box.site.audit);
    }
    if (scripts !== undefined && declaresScripts(files.packageJson)) {
      return this.runNpmScripts(ctx, report, commit, runDir, registryId, files, box.snapshot, scripts);
    }
    const analysis = analyzeRootFiles(files, { dependencyAcquisition: this.o.registry !== null });
    if (!analysis.supported) return this.finishUnsupported(report, ctx.repoUrl, commit, analysis);

    const registry = this.o.registry;
    if (registry === null || files.packageJson === null || files.packageLock === null || files.buildMjs === null) {
      return infra("The supported-class check and the inputs disagree; nothing was run.");
    }

    // Write exactly the four inspected files for the offline pipeline. The directory is under the run directory.
    const fixture = `gh-${randomBytes(6).toString("hex")}`;
    const fixtureFiles: Record<string, string> = {
      "package.json": files.packageJson,
      "package-lock.json": files.packageLock,
      "build.mjs": files.buildMjs,
    };
    if (files.testMjs !== null) fixtureFiles["test.mjs"] = files.testMjs;
    try {
      writeFixture(runDir, fixture, fixtureFiles);
    } catch {
      return infra("The inspected files could not be written to the run directory; nothing was run.");
    }

    const evidenceFile = (path: string, text: string): SourceFile => ({
      path,
      text,
      complete: Buffer.byteLength(text, "utf8") <= EVIDENCE_TEXT_BYTES,
    });
    const evidence: SourceFile[] = [evidenceFile("package.json", files.packageJson), evidenceFile("build.mjs", files.buildMjs)];
    if (files.testMjs !== null) evidence.push(evidenceFile("test.mjs", files.testMjs));
    const source: ControlledSource = {
      fixture,
      files: evidence,
      origin: { kind: "github-pinned", repoUrl: ctx.repoUrl, commit },
    };

    const packageJson = files.packageJson;
    const packageLock = files.packageLock;
    const buildMjs = files.buildMjs;
    const testMjs = files.testMjs;
    const notRunDetail: { text: string | null } = { text: null };
    // The verified offline cache of the baseline run, reused read-only (never re-acquired) when a
    // repair proposal is verified. Set only after the baseline acquisition reported `acquired`.
    const cacheBox: { dir: string | null } = { dir: null };
    source.originals = () => ({ packageJson, packageLock, buildMjs, testMjs });
    const pipeline: PipelineLike = {
      run: async (req) => {
        const res = await runRegistryThenOffline(
          {
            acquire: (r) => registry.acquire(r),
            makePipeline: (cacheDir) => this.o.makePipeline(runDir, cacheDir),
          },
          {
            acquisition: {
              executionId: registryId,
              fixture: OPERATOR_FIXTURE_ID,
              operatorFixture: { packageJson, packageLock },
              image: NODE_FIXTURE_IMAGE,
              runDir,
              ...(req.signal === undefined ? {} : { signal: req.signal }),
            },
            pipeline: req,
          },
        );
        if (res.pipeline !== null) {
          if (res.acquisition.kind === "acquired") cacheBox.dir = res.acquisition.cacheDir;
          return res.pipeline;
        }
        notRunDetail.text = res.detail;
        return notRunPipeline(req.executionId, res.detail);
      },
    };

    const inner = new PipelineJobRunner({
      resolve: () => source,
      pipeline,
      cleanupExecution: this.o.cleanupExecution,
      buildNote: "dependencies are fetched through the registry-only proxy, then install, build and test run offline in disposable containers",
      repair: {
        workRoot: runDir,
        makePipeline: (cloneRoot) => (cacheBox.dir === null ? null : this.o.makePipeline(cloneRoot, cacheBox.dir)),
      },
      ...(this.o.agents === undefined ? {} : { agents: this.o.agents }),
    });
    const outcome = await inner.run(ctx);
    if (outcome.kind === "infrastructure-unavailable" && notRunDetail.text !== null) {
      return infra(`${outcome.reason} ${sanitize(notRunDetail.text, 200)}`);
    }
    return outcome;
  }

  /**
   * Opt-in npm-scripts mode for a pinned repository whose package.json declares `scripts`. Reached
   * only when `npmScripts` is configured. The unsupported-repository answer is returned for anything
   * outside the profile, including a refused snapshot; nothing is then installed or run. Otherwise:
   * dependencies are acquired from the SANITIZED manifest (scripts removed) and the unchanged lock
   * through the registry-only proxy, and the offline container runs the repository's `npm run build`
   * and `npm run test`. No agent is used, no patch exists, and the result never claims a repair.
   */
  private async runNpmScripts(
    ctx: RunContext,
    report: JobProgress,
    commit: string,
    runDir: string,
    registryId: string,
    files: RootFiles,
    snapshot: SnapshotOutcome | null,
    scripts: NpmScriptsOptions,
  ): Promise<RunOutcome> {
    const plan = planNpmScripts(files, {
      dependencyAcquisition: this.o.registry !== null,
      allowDevDependencies: scripts.allowDevDependencies === true,
    });
    if (!plan.ok) return this.finishScriptsUnsupported(report, ctx.repoUrl, commit, plan.findings);
    const registry = this.o.registry;
    const packageLock = files.packageLock;
    if (registry === null || packageLock === null) return infra("The npm-scripts check and the inputs disagree; nothing was run.");
    if (snapshot === null) return infra("The source snapshot was not exported although the profile check passed; nothing was run.");
    if (snapshot.kind === "refused") {
      return this.finishScriptsUnsupported(report, ctx.repoUrl, commit, [
        { code: "source-snapshot-refused", detail: sanitize(snapshot.reason, 200) },
      ]);
    }
    if (ctx.signal.aborted) return ABORTED;

    if (!report.stage("building", "dependencies are fetched through the registry-only proxy, then install, npm run build and npm run test run offline in a disposable container")) {
      return ABORTED;
    }
    // The verified offline cache of the baseline run, reused (never re-acquired) for a repair verification.
    const cacheBox: { dir: string | null } = { dir: null };
    const res = await runRegistryThenOffline(
      {
        acquire: (r) => registry.acquire(r),
        makePipeline: (cacheDir) => {
          cacheBox.dir = cacheDir;
          return scripts.makePipeline({
            runDir,
            snapshot: snapshot.name,
            cacheDir,
            installManifest: plan.sanitizedPackageJson,
            expectedPackages: plan.expectedPackages,
            ...(plan.allowDevDependencies === true ? { allowDevDependencies: true as const } : {}),
          });
        },
      },
      {
        acquisition: {
          executionId: registryId,
          fixture: OPERATOR_FIXTURE_ID,
          // The sanitized manifest only: the original scripts never reach dependency acquisition.
          operatorFixture: { packageJson: plan.sanitizedPackageJson, packageLock },
          ...(plan.lockRootEngines === true ? { allowLockRootEngines: true } : {}),
          ...(plan.allowDevDependencies === true ? { allowDevDependencies: true } : {}),
          image: NODE_FIXTURE_IMAGE,
          runDir,
          signal: ctx.signal,
        },
        pipeline: { executionId: ctx.executionId, fixture: snapshot.name, signal: ctx.signal },
      },
    );
    if (ctx.signal.aborted) return ABORTED;
    if (res.pipeline === null) {
      return infra(`The npm scripts run did not start. ${sanitize(res.detail, 200)}`);
    }

    if (!report.stage("testing", "the Tester judges the observed stage results")) return ABORTED;
    const judged = judgeScriptsRun({
      pipeline: res.pipeline,
      executionId: ctx.executionId,
      repoUrl: ctx.repoUrl,
      commit,
      plan,
      snapshot: {
        name: snapshot.name,
        files: snapshot.files,
        directories: snapshot.directories,
        totalBytes: snapshot.totalBytes,
        archiveSha256: snapshot.archiveSha256,
      },
    });
    if (judged.kind === "infrastructure") return infra(judged.reason);
    let payload = judged.payload;
    // Opt-in verified repair: only with the explicit agent setup AND a baseline that failed at the build
    // stage of a simple `node FILE` build script (npm-scripts-repair.ts). Agents off: nothing changes.
    const agents = this.o.agents;
    if (agents !== undefined && payload["verdict"] === "repository-failing") {
      const step = await runNpmScriptsRepairStep({
        agents,
        report,
        signal: ctx.signal,
        executionId: ctx.executionId,
        baseline: res.pipeline,
        plan,
        runDir,
        snapshotName: snapshot.name,
        cacheDir: cacheBox.dir,
        makePipeline: (a) =>
          cacheBox.dir === null || a.cacheDir !== cacheBox.dir
            ? null
            : scripts.makePipeline({
                runDir,
                snapshot: a.snapshot,
                cacheDir: a.cacheDir,
                installManifest: plan.sanitizedPackageJson,
                expectedPackages: plan.expectedPackages,
                ...(plan.allowDevDependencies === true ? { allowDevDependencies: true as const } : {}),
              }),
      });
      if (step.kind === "aborted" || ctx.signal.aborted) return ABORTED;
      if (step.kind === "infrastructure") return infra(step.reason);
      payload = applyRepairStep(payload, step);
    }
    return report.result(payload) ? { kind: "completed" } : ABORTED;
  }

  /**
   * Static site profile result. Reached only when the acquisition container was proven removed and the
   * commit equals the pin. Diagnostics only: nothing was executed, no repair is claimed, and the
   * verdict is distinct from "unsupported-repository" and from any pass.
   */
  private finishStaticSite(report: JobProgress, repoUrl: string, commit: string, audit: StaticSiteAudit): RunOutcome {
    return report.result(staticSiteResultPayload(repoUrl, commit, audit)) ? { kind: "completed" } : ABORTED;
  }

  private finishScriptsUnsupported(report: JobProgress, repoUrl: string, commit: string, findings: readonly ScriptsFinding[]): RunOutcome {
    return report.result(scriptsUnsupportedPayload(repoUrl, commit, findings)) ? { kind: "completed" } : ABORTED;
  }

  /**
   * Unpinned intake (opt-in, allowUnpinned). Source inspection only: resolve HEAD to an immutable
   * SHA in the guarded git container, check the tree policy, read four root files as raw blobs,
   * analyse the manifest as data, and complete with verdict "source-inspected". No run directory,
   * no registry acquisition, no sandbox, no repository script, and no agent (so no source reaches
   * Kiro). Execution requires the operator to pin the reported SHA.
   */
  private async runUnpinned(ctx: RunContext): Promise<RunOutcome> {
    const report = ctx.report;
    if (report === undefined) return infra(NO_REPORTER_REASON);
    if (ctx.signal.aborted) return ABORTED;
    try {
      return await this.inspectUnpinned(ctx, report);
    } catch {
      return infra("The unpinned source inspection raised an unexpected error; no result was produced.");
    }
  }

  private async inspectUnpinned(ctx: RunContext, report: JobProgress): Promise<RunOutcome> {
    if (!report.stage("cloning", "resolving the repository HEAD to an immutable commit through the controlled github.com proxy")) {
      return ABORTED;
    }
    const box: { files: RootFiles | null } = { files: null };
    const git = this.o.makeGit(async (info) => {
      box.files = await this.o.readRootFiles(info);
    });
    const acq = await git.acquire({
      executionId: ctx.executionId,
      repoUrl: ctx.repoUrl,
      resolveHead: true,
      image: this.o.gitImage,
      signal: ctx.signal,
    });
    if (ctx.signal.aborted || acq.kind === "aborted") return ABORTED;
    if (acq.cleanup !== null && acq.cleanup.confirmed !== true) {
      return infra("The acquisition container could not be proven removed; nothing was used.");
    }

    if (
      (acq.kind === "source-rejected" || acq.kind === "acquired") &&
      (acq.cleanup === null || acq.cleanup.confirmed !== true || acq.cleanup.executionId !== ctx.executionId)
    ) {
      return infra("The acquisition cleanup proof is missing or is for a different execution; nothing was used.");
    }

    if (acq.kind === "source-rejected") {
      const known = acq.commit !== undefined && GIT_SHA_RE.test(acq.commit) ? acq.commit : null;
      const analysis: Analysis = {
        supported: false,
        findings: [{ code: "source-policy-rejected", detail: sanitize(acq.reason, 200) }],
        facts: emptyFacts(),
      };
      return this.finishInspected(report, ctx.repoUrl, known, null, analysis);
    }
    if (acq.kind !== "acquired") return infra(`The repository HEAD was not acquired (${describeAcquisition(acq)}).`);
    if (acq.cleanup === null) return infra("The acquisition reported no cleanup proof; nothing was used.");
    if (acq.resolvedFromHead !== true || !GIT_SHA_RE.test(acq.commit)) {
      return infra("The acquisition did not report a resolved immutable commit; nothing was used.");
    }
    const files = box.files;
    if (files === null) return infra("The root files were not read from the acquired commit.");

    if (!report.stage("analyzing", "reading the repository root files as data; nothing is built or run")) return ABORTED;
    const dependencyAcquisition = this.o.registry !== null;
    const analysis = analyzeRootFiles(files, { dependencyAcquisition });
    // With npm-scripts mode configured, a manifest that declares `scripts` is judged by the same
    // pure profile policy a pinned run would use. Still data only: no snapshot, install or run.
    if (this.o.npmScripts !== undefined && declaresScripts(files.packageJson)) {
      const plan = planNpmScripts(files, {
        dependencyAcquisition,
        allowDevDependencies: this.o.npmScripts.allowDevDependencies === true,
      });
      return this.finishInspected(
        report,
        ctx.repoUrl,
        acq.commit,
        acq.manifest,
        { supported: plan.ok, findings: plan.ok ? [] : plan.findings, facts: analysis.facts },
        npmScriptsRootChecks(plan),
      );
    }
    return this.finishInspected(report, ctx.repoUrl, acq.commit, acq.manifest, analysis);
  }

  private finishInspected(
    report: JobProgress,
    repoUrl: string,
    commit: string | null,
    manifest: TreeManifest | null,
    analysis: InspectedAnalysis,
    scriptsProfile?: NpmScriptsRootChecks,
  ): RunOutcome {
    const payload: Record<string, unknown> = {
      verdict: "source-inspected",
      sourceKind: "github-unpinned-head",
      source: { repoUrl, commit, resolvedFrom: "HEAD", pinned: false },
      inspection:
        manifest === null
          ? null
          : { files: manifest.files, totalBytes: manifest.totalBytes, submodulesSkipped: manifest.submodulesSkipped },
      analysis: {
        pinnedFlowCompatible: analysis.supported,
        findings: analysis.findings.map((f) => ({ code: f.code, detail: f.detail })),
        facts: analysis.facts,
        ...(scriptsProfile === undefined ? {} : { profile: NPM_SCRIPTS_RUN_MODE, rootChecks: scriptsProfile }),
      },
      executed: false,
      requiresOperatorPin: manifest !== null,
      // A pin does not bypass a source-policy block, so no pin is offered when the inspection was rejected.
      operatorPin: commit === null || manifest === null ? null : { repoUrl, commit },
      notes: [
        manifest === null
          ? commit === null
            ? "The repository HEAD was fetched in a disposable container but source policy rejected it before an immutable commit was recorded. The root files were not read. Nothing was built, installed or run."
            : "The repository HEAD was resolved to the immutable commit above, but source policy stopped the inspection before any root files were read. Pinning this commit would not bypass the source-policy block. Nothing was built, installed or run."
          : "The repository HEAD was resolved to the immutable commit above and fetched in a disposable container. Only the tree policy was checked and four root files were read as data. Nothing was built, installed or run.",
        "No dependencies were fetched and no source was sent to any model. The findings describe whether the root manifest fits this worker's narrow supported class. They are not a statement about whether the repository builds, passes its tests or is broken.",
        manifest === null
          ? "This repository HEAD cannot be built, tested or repaired by this worker while source policy rejects it, and pinning it would not change that."
          : "To build, test or repair this repository, the operator must pin this exact commit in the GitHub catalog. HEAD may move, so the commit above is the only revision that was inspected.",
        ...(scriptsProfile === undefined
          ? []
          : [
              scriptsProfile.passed
                ? "package.json declares npm scripts, and the root package.json and package-lock.json passed the npm-scripts profile checks. This is a preliminary check of two root files only: the snapshot size limits, dependency download, install, build and tests were not checked, so it is not a build or test result."
                : "package.json declares npm scripts, so the root files were checked against the npm-scripts profile. The findings above say why this commit does not fit it. Nothing was built, installed or run.",
            ]),
      ],
    };
    return report.result(payload) ? { kind: "completed" } : ABORTED;
  }

  private finishUnsupported(report: JobProgress, repoUrl: string, commit: string, analysis: Analysis): RunOutcome {
    const payload: Record<string, unknown> = {
      verdict: "unsupported-repository",
      sourceKind: "github-pinned",
      source: { repoUrl, commit },
      analysis: projectAnalysis(analysis),
      notes: [
        "The commit was fetched in a disposable container and only four root files were read. Nothing was built or run.",
        "Unsupported means outside this worker's narrow supported class. It is not a verdict that the repository is broken or fixable.",
      ],
    };
    return report.result(payload) ? { kind: "completed" } : ABORTED;
  }

  async cleanup(req: CleanupRequest): Promise<CleanupProof> {
    const sandbox = await this.o.fallback.cleanup(req);
    if (sandbox.confirmed !== true) return sandbox;
    const registryId = deriveRegistryExecutionId(req.executionId);
    if (registryId === null) return { confirmed: false, reason: "the execution id has an unexpected form; cleanup cannot be proven" };

    let git: CleanupProof;
    try {
      git = await this.o.makeGit(() => Promise.resolve()).cleanup({ executionId: req.executionId });
    } catch {
      return { confirmed: false, reason: "the git acquisition cleanup check raised an error" };
    }
    if (git.confirmed !== true) return git;
    if (git.executionId !== req.executionId) return { confirmed: false, reason: "git cleanup proof is for a different execution" };

    if (this.o.registry !== null) {
      let reg: CleanupProof;
      try {
        reg = await this.o.registry.cleanup({ executionId: registryId });
      } catch {
        return { confirmed: false, reason: "the registry acquisition cleanup check raised an error" };
      }
      if (reg.confirmed !== true) return reg;
      if (reg.executionId !== registryId) return { confirmed: false, reason: "registry cleanup proof is for a different execution" };
    }

    // A previous attempt may have run a verified repair (npm-scripts mode with agents) before a restart or
    // a configuration change. The patched copy has its own deterministic execution id, so it is proven
    // absent regardless of the current feature flags.
    const repairId = deriveRepairExecutionId(req.executionId);
    if (repairId === null) return { confirmed: false, reason: "the execution id has an unexpected form; cleanup cannot be proven" };
    let fix: CleanupProof;
    try {
      fix = await this.o.cleanupExecution(repairId);
    } catch {
      return { confirmed: false, reason: "the repair verification cleanup check raised an error" };
    }
    if (fix.confirmed !== true) return fix;
    if (fix.executionId !== repairId) return { confirmed: false, reason: "repair verification cleanup proof is for a different execution" };

    return {
      confirmed: true,
      executionId: req.executionId,
      evidence: "sandbox, git acquisition, registry acquisition and repair verification containers are absent for this execution",
    };
  }
}
