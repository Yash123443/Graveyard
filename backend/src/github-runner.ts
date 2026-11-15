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
 * @module github-runner
 */

import { randomBytes } from "node:crypto";
import { sanitize } from "./acquisition-policy.js";
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

const EVIDENCE_TEXT_BYTES = 3500;

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
  /** Canonical repository URL -> full lowercase 40-hex commit. */
  pins: ReadonlyMap<string, string>;
  /** Existing real directory owned by the worker; each job gets one `run-<12 hex>` directory in it. */
  runsRoot: string;
  /** Local image with `git` and `sleep` (never pulled). */
  gitImage: string;
  /** Builds an acquisition adapter whose afterCheckout hook is `hook`. */
  makeGit: (hook: (info: HandoffInfo) => Promise<void>) => GitLike;
  /** Reads the four root files inside the acquisition container (github-source.readRootFiles). */
  readRootFiles: (info: HandoffInfo) => Promise<RootFiles>;
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

export class GithubJobRunner implements JobRunner {
  private readonly o: GithubRunnerOptions;

  constructor(opts: GithubRunnerOptions) {
    if (
      typeof opts?.fallback?.run !== "function" ||
      !(opts.pins instanceof Map) ||
      !(opts.fixtureUrls instanceof Set) ||
      typeof opts.makeGit !== "function" ||
      typeof opts.readRootFiles !== "function" ||
      typeof opts.makePipeline !== "function" ||
      typeof opts.cleanupExecution !== "function" ||
      typeof opts.runsRoot !== "string" ||
      typeof opts.gitImage !== "string"
    ) {
      throw new Error("fallback, pins, fixtureUrls, runsRoot, gitImage, makeGit, readRootFiles, makePipeline and cleanupExecution are required");
    }
    this.o = opts;
  }

  async run(ctx: RunContext): Promise<RunOutcome> {
    const commit = this.o.pins.get(ctx.repoUrl);
    if (commit === undefined || this.o.fixtureUrls.has(ctx.repoUrl)) return this.o.fallback.run(ctx);

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

    const box: { files: RootFiles | null } = { files: null };
    const git = this.o.makeGit(async (info) => {
      box.files = await this.o.readRootFiles(info);
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

    return {
      confirmed: true,
      executionId: req.executionId,
      evidence: "sandbox, git acquisition and registry acquisition containers are absent for this execution",
    };
  }
}
