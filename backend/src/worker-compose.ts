/**
 * worker-compose.ts — builds the real worker from a validated WorkerConfig.
 *
 * Composition only. It refuses to start (throws) unless every operator-supplied path is what the
 * config says it is, BEFORE the database is opened:
 *   - fixtures root, staging root and npm cache are existing directories (real paths);
 *   - every catalog entry names a fixture directory with package.json, package-lock.json and
 *     build.mjs as regular files (the same readers the runner uses at job time);
 *   - the compiled pipeline driver exists next to this module.
 * A misconfigured worker therefore fails at startup, not by silently failing every job.
 *
 * What it wires (all existing, tested components; nothing new executes code):
 *   ControlledPipeline (network none, disposable container, offline npm ci / build / test)
 *   + PipelineJobRunner (operator catalog; unknown repositories refused, nothing cloned or run)
 *   + JobWorker (leases, fencing, cleanup proof) + WorkerService (bounded polling, graceful stop).
 * Nothing runs on the host: the only child processes are `docker` (argument arrays, no shell) and,
 * only if agents are enabled, `kiro-cli` (no tools trusted).
 *
 * GitHub flow (only when config.github is set; github-runner.ts): additionally wires an
 * OperatorEgressGuard per target host, GitAcquisition, NpmRegistryAcquisition (only if registry
 * egress is configured) and a per-run ControlledPipeline, and wraps the fixture runner in
 * GithubJobRunner. Startup also refuses when the runs root or the registry driver is missing.
 * The GitHub flow part was written without a shell and later compiled and unit-tested (fakes) in an
 * external run; it has not run against real Docker or GitHub.
 *
 * npm-scripts mode (only when config.github.npmScripts is true, GRAVEYARD_GITHUB_NPM_SCRIPTS=1; written
 * without a shell, NOT compiled or run): additionally wires the bounded snapshot export
 * (npm-scripts-snapshot.ts) and NpmScriptsPipeline (npm-scripts-pipeline.ts) into GithubJobRunner.
 * Startup also refuses when the compiled npm-scripts-driver.js is missing. Off by default.
 *
 * Static site audit (always wired with the GitHub flow; read-only, no new egress or container):
 * readStaticSite (static-site-audit.ts) lists the tree and reads capped HTML/CSS blobs in the git
 * acquisition container for a pinned repository with no package.json and a root index.html.
 *
 * Test seams (`pipeline`, `cleanupExecution`, `agents`, `executor`, `agentExecutor`, `workerOptions`)
 * exist so the loop, authorization and result flow can be tested with fakes. The real entry point
 * (worker-main.ts) passes none of them except `log`.
 *
 * @module worker-compose
 */

import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.js";
import { PIPELINE_ARGV, PIPELINE_COMMAND_ID, ControlledPipeline } from "./controlled-pipeline.js";
import { DockerFixtureSandbox, spawnExecutor, type ProcessExecutor } from "./docker-sandbox.js";
import { NODE_FIXTURE_IMAGE } from "./node-fixture-runner.js";
import { KiroAgentAdapter, spawnAgentProcess, type AgentProcessExecutor } from "./kiro-agent.js";
import { GitAcquisition } from "./git-acquisition.js";
import { OperatorEgressGuard } from "./egress-guard.js";
import { NpmRegistryAcquisition } from "./npm-registry-acquisition.js";
import { GithubJobRunner, type GithubRunnerOptions, type NpmScriptsOptions } from "./github-runner.js";
import { readRootFiles } from "./github-source.js";
import { readStaticSite } from "./static-site-audit.js";
import { NpmScriptsPipeline } from "./npm-scripts-pipeline.js";
import { exportSnapshot, spawnBytesExecutor } from "./npm-scripts-snapshot.js";
import {
  PipelineJobRunner,
  createCatalogResolver,
  readFixtureEvidence,
  type AgentsLike,
  type PipelineLike,
} from "./pipeline-runner.js";
import type { CleanupProof, JobRunner } from "./runner.js";
import { JobWorker, type WorkerOptions } from "./worker.js";
import { WorkerService, type ServiceLog } from "./worker-service.js";
import type { WorkerConfig } from "./worker-config.js";

export interface ComposeDeps {
  /** docker CLI executor. Default: spawnExecutor (shell:false, minimal environment). */
  executor?: ProcessExecutor;
  /** kiro-cli executor, used only when agents are enabled. Default: spawnAgentProcess. */
  agentExecutor?: AgentProcessExecutor;
  openDb?: (path: string) => DatabaseSync;
  driverPath?: string;
  log?: ServiceLog;
  /** Test seams. */
  pipeline?: PipelineLike;
  cleanupExecution?: (executionId: string) => Promise<CleanupProof>;
  agents?: AgentsLike;
  /** Test seam: the pipeline used to verify a repair on a disposable copy (see repair-verifier.ts). */
  repairPipeline?: (cloneRoot: string) => PipelineLike | null;
  /** Test seams for the GitHub flow (only used when config.github is set). */
  githubSeams?: Partial<Pick<GithubRunnerOptions, "makeGit" | "readRootFiles" | "readStaticSite" | "registry" | "makePipeline" | "npmScripts">>;
  workerOptions?: Partial<Pick<WorkerOptions, "timers" | "now" | "leaseMs" | "heartbeatMs" | "abortGraceMs" | "cleanupTimeoutMs">>;
  maxBackoffMs?: number;
}

export interface ComposedWorker {
  config: WorkerConfig;
  db: DatabaseSync;
  worker: JobWorker;
  service: WorkerService;
  /** Closes the database. Call after service.stop() has resolved. Idempotent. */
  close(): void;
}

function realDirectory(label: string, path: string, problems: string[]): string | null {
  try {
    const real = realpathSync(path);
    if (!lstatSync(real).isDirectory()) throw new Error("not a directory");
    return real;
  } catch {
    problems.push(`${label} is not an existing directory`);
    return null;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolves true when `docker version` answers with a server version. Never throws. */
export function makeDockerPreflight(executor: ProcessExecutor): () => Promise<boolean> {
  return async () => {
    try {
      const r = await executor("docker", ["version", "--format", "{{.Server.Version}}"], {
        timeoutMs: 10_000,
        maxOutputBytes: 4_096,
      });
      return r.exitCode === 0 && !r.timedOut && !r.aborted && r.stdout.trim() !== "";
    } catch {
      return false;
    }
  };
}

export function composeWorker(config: WorkerConfig, deps: ComposeDeps = {}): ComposedWorker {
  const problems: string[] = [];
  const fixturesRoot = realDirectory("GRAVEYARD_FIXTURES_ROOT", config.fixturesRoot, problems);
  realDirectory("GRAVEYARD_STAGING_ROOT", config.stagingRoot, problems);
  realDirectory("GRAVEYARD_NPM_CACHE_DIR", config.cacheDir, problems);

  if (fixturesRoot !== null) {
    for (const [url, fixture] of Object.entries(config.catalog)) {
      const evidence = readFixtureEvidence(fixturesRoot, fixture);
      const lock = isRegularFile(join(fixturesRoot, fixture, "package-lock.json"));
      if (evidence === null || !lock) {
        problems.push(
          `catalog entry for ${url} names fixture "${fixture}", which lacks package.json, package-lock.json or build.mjs as plain files`,
        );
      }
    }
  }

  const driverPath = deps.driverPath ?? join(dirname(fileURLToPath(import.meta.url)), "fixture-pipeline-driver.js");
  if (deps.pipeline === undefined && !isRegularFile(driverPath)) {
    problems.push("the compiled pipeline driver (fixture-pipeline-driver.js) was not found; run the build first");
  }
  const github = config.github ?? null;
  const seams = deps.githubSeams ?? {};
  const scriptsDriverPath = join(dirname(fileURLToPath(import.meta.url)), "npm-scripts-driver.js");
  if (github !== null) {
    realDirectory("GRAVEYARD_GITHUB_RUNS_ROOT", github.runsRoot, problems);
    const registryDriver = join(dirname(fileURLToPath(import.meta.url)), "npm-acquire-driver.js");
    if (github.registryEgress !== null && seams.registry === undefined && !isRegularFile(registryDriver)) {
      problems.push("the compiled registry driver (npm-acquire-driver.js) was not found; run the build first");
    }
    if (github.npmScripts === true && seams.npmScripts === undefined && !isRegularFile(scriptsDriverPath)) {
      problems.push("the compiled npm-scripts driver (npm-scripts-driver.js) was not found; run the build first");
    }
  }
  if (problems.length > 0) throw new Error(`worker startup refused:\n${problems.map((p) => `  - ${p}`).join("\n")}`);

  const executor = deps.executor ?? spawnExecutor;
  const log: ServiceLog = deps.log ?? ((): void => undefined);

  const db = (deps.openDb ?? openDatabase)(config.databasePath);
  try {
    const pipeline: PipelineLike =
      deps.pipeline ??
      new ControlledPipeline({
        executor,
        fixturesRoot: config.fixturesRoot,
        stagingRoot: config.stagingRoot,
        cacheDir: config.cacheDir,
        driverPath,
      });

    // The cleanup proof comes from a sandbox object used only for cleanup(): the same label and
    // inspect checks the pipeline's own sandbox uses.
    let cleanupExecution = deps.cleanupExecution;
    if (cleanupExecution === undefined) {
      const sandbox = new DockerFixtureSandbox({
        executor,
        allowedImages: [NODE_FIXTURE_IMAGE],
        commands: { [PIPELINE_COMMAND_ID]: PIPELINE_ARGV },
      });
      cleanupExecution = (executionId: string): Promise<CleanupProof> => sandbox.cleanup({ executionId });
    }

    let agents: AgentsLike | undefined = deps.agents;
    if (agents === undefined && config.agents !== "off") {
      agents = new KiroAgentAdapter({
        executor: deps.agentExecutor ?? spawnAgentProcess,
        cliGeneration: config.agents === "kiro-v2" ? "v2" : "v3",
      });
    }

    const fixtureRunner = new PipelineJobRunner({
      resolve: createCatalogResolver(config.catalog, config.fixturesRoot),
      pipeline,
      cleanupExecution,
      ...(agents === undefined ? {} : { agents }),
      // Repair verification (repair-verifier.ts): applies the single Fixer proposal in memory to a
      // disposable copy under the staging root and re-runs the offline pipeline on that copy, with
      // the same read-only npm cache. A test that injects its own `pipeline` gets no verification
      // unless it also injects `repairPipeline`, so fakes never reach the real Docker pipeline.
      ...(deps.pipeline !== undefined && deps.repairPipeline === undefined
        ? {}
        : {
            repair: {
              workRoot: config.stagingRoot,
              makePipeline: (cloneRoot: string): PipelineLike | null =>
                deps.repairPipeline !== undefined
                  ? deps.repairPipeline(cloneRoot)
                  : new ControlledPipeline({
                      executor,
                      fixturesRoot: cloneRoot,
                      stagingRoot: config.stagingRoot,
                      cacheDir: config.cacheDir,
                      driverPath,
                    }),
            },
          }),
    });

    let runner: JobRunner = fixtureRunner;
    if (github !== null) {
      // The GitHub flow exists only when the operator configured it. Guards attest only after the
      // operator-provisioned topology passes their checks; the default guard is not used here.
      const makeGit =
        seams.makeGit ??
        ((() => {
          const guard = new OperatorEgressGuard({ executor, host: "github.com", ...github.gitEgress });
          return (hook: Parameters<GithubRunnerOptions["makeGit"]>[0]): ReturnType<GithubRunnerOptions["makeGit"]> =>
            new GitAcquisition({ executor, egress: guard, allowedImages: [github.gitImage], afterCheckout: hook });
        })());
      const registry =
        seams.registry !== undefined
          ? seams.registry
          : github.registryEgress === null
            ? null
            : new NpmRegistryAcquisition({
                executor,
                egress: new OperatorEgressGuard({ executor, host: "registry.npmjs.org", ...github.registryEgress }),
                stagingRoot: config.stagingRoot,
              });
      // Opt-in npm-scripts mode: off unless the operator set GRAVEYARD_GITHUB_NPM_SCRIPTS=1 (or a test seam is injected with it).
      const scriptsOptions: NpmScriptsOptions | undefined =
        github.npmScripts !== true
          ? undefined
          : (seams.npmScripts ?? {
              exportSnapshot: (info, runDir, expect) => exportSnapshot(spawnBytesExecutor, info, runDir, expect),
              makePipeline: (a) =>
                new NpmScriptsPipeline({
                  executor,
                  runDir: a.runDir,
                  snapshot: a.snapshot,
                  cacheDir: a.cacheDir,
                  installManifest: a.installManifest,
                  expectedPackages: a.expectedPackages,
                  driverPath: scriptsDriverPath,
                }),
            });
      runner = new GithubJobRunner({
        fallback: fixtureRunner,
        fixtureUrls: new Set(Object.keys(config.catalog)),
        pins: new Map(Object.entries(github.pins)),
        allowUnpinned: github.allowUnpinned === true,
        runsRoot: github.runsRoot,
        gitImage: github.gitImage,
        makeGit,
        readRootFiles: seams.readRootFiles ?? ((info) => readRootFiles(executor, info)),
        // Read-only static site audit (static-site-audit.ts), used only for a pin with no package.json.
        readStaticSite: seams.readStaticSite ?? ((info) => readStaticSite(executor, info)),
        registry,
        makePipeline:
          seams.makePipeline ??
          ((runDir, cacheDir) =>
            new ControlledPipeline({ executor, fixturesRoot: runDir, stagingRoot: config.stagingRoot, cacheDir, driverPath })),
        cleanupExecution,
        ...(agents === undefined ? {} : { agents }),
        // Opt-in npm-scripts mode (see scriptsOptions above); absent unless explicitly enabled.
        ...(scriptsOptions === undefined ? {} : { npmScripts: scriptsOptions }),
      });
    }
    const worker = new JobWorker({ db, workerId: config.workerId, runner, ...(deps.workerOptions ?? {}) });
    const service = new WorkerService({
      worker,
      pollMs: config.pollMs,
      recoverMs: config.recoverMs,
      batch: config.batch,
      preflight: makeDockerPreflight(executor),
      log,
      ...(deps.maxBackoffMs === undefined ? {} : { maxBackoffMs: deps.maxBackoffMs }),
    });

    let closed = false;
    return {
      config,
      db,
      worker,
      service,
      close(): void {
        if (closed) return;
        closed = true;
        try {
          db.close();
        } catch {
          // Already closed.
        }
      },
    };
  } catch (e) {
    try {
      db.close();
    } catch {
      // ignore
    }
    throw e;
  }
}
