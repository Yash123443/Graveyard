/**
 * pipeline-runner.ts — JobRunner that connects a claimed job to the existing safe capabilities:
 * the offline controlled pipeline (network `none`, one disposable container), the deterministic
 * Tester, and the advisory Analyst and Fixer.
 *
 * Written without running the compiler or tests (see backend/DEVELOPMENT.md). Not wired into
 * server.ts: nothing starts a worker loop in the running server.
 *
 * What a job can do here. The job's repository URL is looked up in an operator-supplied catalog
 * (a `SourceResolver`). A URL that is not in the catalog is refused (`infrastructure-unavailable`)
 * before anything runs: this module never clones, never fetches, and never runs code from a
 * repository it has not been told about. A catalog entry names a CONTROLLED fixture directory that
 * the operator prepared under the pipeline's fixturesRoot (package.json, package-lock.json,
 * build.mjs, optional test.mjs) plus an offline npm cache. So this is an integrated path for
 * operator-prepared fixtures that stand in for a repository, not support for arbitrary GitHub
 * repositories.
 *
 * Flow for a supported job (stage events are fenced writes through `ctx.report`):
 *   building    the pipeline runs install, build and test in one container (network none)
 *   testing     the Tester judges the observed stage results (pure, no process)
 *   diagnosing  failure only: the Analyst receives bounded, redacted evidence (optional)
 *   repairing   failure only: the Fixer proposes a patch (optional; proposal only, NEVER applied)
 *   done        written by the worker when the job is marked completed
 * Exactly one `result` event is recorded per attempt.
 *
 * Outcome mapping (the job is never reported as success on inconclusive evidence):
 *   pipeline success                       -> completed, result verdict "verified"
 *   pipeline failure (install/build/test)  -> completed, result verdict "repository-failing",
 *                                             with the Tester report and, if agents are configured,
 *                                             the Analyst diagnosis and Fixer proposal. "completed"
 *                                             means the work finished and a result exists; it does not
 *                                             mean the repository was repaired.
 *   build passed, no tests                 -> completed, result verdict "tests-not-run"
 *   any other not-run                      -> infrastructure-unavailable (job fails; no result)
 *   unknown repository, missing reporter,
 *   bad evidence, abort, errors            -> infrastructure-unavailable or aborted; no result
 *
 * Cleanup: `cleanup()` always asks the injected Docker cleanup to prove that no container carries
 * this execution id, whether or not this process ran it. It does not prove removal of the staging
 * directory of another process; a leftover staging directory makes later runs of that fixture refuse
 * (`staging-failed`, fail closed).
 *
 * Not done here (honest limits): no patch is applied, so there is no repair verification and the
 * `repairing` stage only means "a proposal was requested"; no acquisition of arbitrary repositories
 * (the git and registry acquisition modules are not connected here); the Analyst and Fixer are
 * advisory text, validated for form only, and their output is labelled `modelAuthored`.
 *
 * @module pipeline-runner
 */

import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ControlledPipelineResult, PipelineRequest } from "./controlled-pipeline.js";
import type { CleanupProof, CleanupRequest, JobProgress, JobRunner, RunContext, RunOutcome } from "./runner.js";
import { buildPipelineTesterReport, type PipelineTesterReport } from "./tester.js";
import {
  isSafeRelativePath,
  truncateUtf8,
  type Diagnosis,
  type EvidenceItem,
  type PatchProposal,
} from "./agent-contract.js";
import type { AgentOutcome, AnalystRequest, FixerRequest } from "./kiro-agent.js";

export const REPOSITORY_UNSUPPORTED_REASON =
  "This repository has no controlled execution path: acquisition of arbitrary repositories is not available. Nothing was cloned or run.";
export const NO_REPORTER_REASON = "The runner was not given a progress channel; nothing was run.";
export const SOURCE_INVALID_REASON = "The source catalog entry is invalid; nothing was run.";

const MAX_EVIDENCE_FILES = 6;
const EVIDENCE_TEXT_BYTES = 3500;
const MAX_SOURCE_FILE_BYTES = 64 * 1024;
export const FIXTURE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/** A file of the controlled fixture, shown to the agents as evidence. */
export interface SourceFile {
  /** Relative, safe path (isSafeRelativePath). */
  path: string;
  text: string;
  /** True only if `text` is the whole file. */
  complete: boolean;
}

/** Set only by the GitHub runner (github-runner.ts): the files came from this pinned public commit. */
export interface SourceOrigin {
  kind: "github-pinned";
  /** Canonical https://github.com/owner/repo URL. */
  repoUrl: string;
  /** Full lowercase 40-hex commit id. */
  commit: string;
}

export interface ControlledSource {
  /** Directory name under the pipeline's fixturesRoot. */
  fixture: string;
  files: readonly SourceFile[];
  /** Absent for operator-prepared fixtures. */
  origin?: SourceOrigin;
}

/** Maps a job's canonical repository URL to a controlled source, or null when there is none. May throw (treated as null). */
export type SourceResolver = (repoUrl: string) => ControlledSource | null | Promise<ControlledSource | null>;

/** ControlledPipeline satisfies this. */
export interface PipelineLike {
  run(req: PipelineRequest): Promise<ControlledPipelineResult>;
}

/** KiroAgentAdapter satisfies this. */
export interface AgentsLike {
  analyze(req: AnalystRequest): Promise<AgentOutcome<Diagnosis>>;
  propose(req: FixerRequest): Promise<AgentOutcome<PatchProposal>>;
}

export interface PipelineJobRunnerOptions {
  resolve: SourceResolver;
  pipeline: PipelineLike;
  /** Must actively remove and then verify (DockerFixtureSandbox.cleanup does). Idempotent. */
  cleanupExecution: (executionId: string) => Promise<CleanupProof>;
  /** Optional. Without it a failing repository gets the Tester report and no diagnosis. */
  agents?: AgentsLike;
  /** Optional text for the `building` stage event (the GitHub runner also fetches dependencies there). */
  buildNote?: string;
}

// ---------------------------------------------------------------------------
// Catalog resolver (operator-controlled; reads only fixed file names)
// ---------------------------------------------------------------------------

const CATALOG_EVIDENCE_FILES: ReadonlyArray<{ name: string; required: boolean }> = [
  { name: "package.json", required: true },
  { name: "build.mjs", required: true },
  { name: "test.mjs", required: false },
];

/**
 * Reads package.json, build.mjs and (optionally) test.mjs of `<fixturesRoot>/<fixture>` as plain
 * regular files, no symlinks, at most 64 KiB each. Returns null when anything is wrong. The
 * directory must resolve inside fixturesRoot. Never throws.
 */
export function readFixtureEvidence(fixturesRoot: string, fixture: string): SourceFile[] | null {
  try {
    if (!isAbsolute(fixturesRoot) || !FIXTURE_NAME_RE.test(fixture)) return null;
    const root = realpathSync(resolve(fixturesRoot));
    const dir = realpathSync(resolve(root, fixture));
    const rel = relative(root, dir);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    const out: SourceFile[] = [];
    for (const f of CATALOG_EVIDENCE_FILES) {
      const p = join(dir, f.name);
      let st: Stats;
      try {
        st = lstatSync(p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT" && !f.required) continue;
        return null;
      }
      if (!st.isFile() || st.size > MAX_SOURCE_FILE_BYTES) return null;
      const text = readFileSync(p, "utf8");
      out.push({ path: f.name, text, complete: Buffer.byteLength(text, "utf8") <= EVIDENCE_TEXT_BYTES });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Exact-match catalog: canonical repository URL -> fixture directory name. Unlisted URLs resolve to
 * null. Evidence files are read from disk at resolve time.
 */
export function createCatalogResolver(
  entries: Readonly<Record<string, string>>,
  fixturesRoot: string,
  readEvidence: (root: string, fixture: string) => SourceFile[] | null = readFixtureEvidence,
): SourceResolver {
  const map = new Map<string, string>(Object.entries(entries));
  return (repoUrl) => {
    const fixture = map.get(repoUrl);
    if (fixture === undefined) return null;
    const files = readEvidence(fixturesRoot, fixture);
    return files === null ? null : { fixture, files };
  };
}

// ---------------------------------------------------------------------------
// Result building (pure, exported for tests)
// ---------------------------------------------------------------------------

export type JobVerdict = "verified" | "repository-failing" | "tests-not-run";

/** Text the Analyst may see about the observed stages. Container output is untrusted and bounded. */
export function buildStageEvidenceText(r: ControlledPipelineResult): string {
  const lines: string[] = [`pipeline verdict: ${r.status} (${r.reason})`];
  for (const s of r.stages ?? []) {
    const exit = typeof s.exitCode === "number" ? ` exit=${s.exitCode}` : "";
    lines.push(`stage ${s.stage}: ${s.status}${s.reason === undefined ? "" : ` (${s.reason})`}${exit}`);
  }
  for (const s of r.stages ?? []) {
    if (s.status !== "failed") continue;
    if (s.stdoutTail !== undefined && s.stdoutTail !== "") lines.push(`--- ${s.stage} stdout tail ---`, s.stdoutTail);
    if (s.stderrTail !== undefined && s.stderrTail !== "") lines.push(`--- ${s.stage} stderr tail ---`, s.stderrTail);
  }
  return truncateUtf8(lines.join("\n"), EVIDENCE_TEXT_BYTES).text;
}

/** Bounded evidence for the agents, or null when the source files are not acceptable. */
export function buildEvidence(r: ControlledPipelineResult, files: readonly SourceFile[]): EvidenceItem[] | null {
  if (files.length > MAX_EVIDENCE_FILES) return null;
  const items: EvidenceItem[] = [{ id: "stage-result", kind: "stage-result", text: buildStageEvidenceText(r) }];
  const seen = new Set<string>();
  files.forEach((f, i) => {
    seen.add(f.path);
    const cut = truncateUtf8(f.text, EVIDENCE_TEXT_BYTES);
    items.push({ id: `file-${i + 1}`, kind: "file", path: f.path, complete: f.complete && !cut.truncated, text: cut.text });
  });
  if (seen.size !== files.length) return null; // duplicate paths
  return items;
}

function validSource(s: ControlledSource | null): s is ControlledSource {
  if (s === null || typeof s !== "object") return false;
  if (typeof s.fixture !== "string" || !FIXTURE_NAME_RE.test(s.fixture)) return false;
  if (!Array.isArray(s.files) || s.files.length > MAX_EVIDENCE_FILES) return false;
  const paths = new Set<string>();
  for (const f of s.files) {
    if (typeof f !== "object" || f === null) return false;
    if (!isSafeRelativePath(f.path) || typeof f.text !== "string" || typeof f.complete !== "boolean") return false;
    if (paths.has(f.path)) return false;
    paths.add(f.path);
  }
  return true;
}

function projectPipeline(r: ControlledPipelineResult): Record<string, unknown> {
  return {
    status: r.status,
    reason: r.reason,
    failedStage: r.failedStage,
    packagesAdded: r.packagesAdded,
    expectedPackages: r.expectedPackages,
    stages: (r.stages ?? []).map((s) => ({
      stage: s.stage,
      status: s.status,
      reason: s.reason ?? null,
      exitCode: s.exitCode ?? null,
      durationMs: s.durationMs,
    })),
  };
}

function projectAnalyst(o: AgentOutcome<Diagnosis> | null): Record<string, unknown> {
  if (o === null) return { status: "not-configured" };
  if (o.status !== "ok") return { status: o.status, code: o.code };
  const d = o.value;
  return {
    status: "ok",
    modelAuthored: true,
    category: d.category,
    summary: d.summary,
    rootCause: d.rootCause,
    confidence: d.confidence,
    evidenceRefs: d.evidenceRefs,
    affectedFiles: d.affectedFiles,
  };
}

function projectFixer(o: AgentOutcome<PatchProposal> | null, reason: "not-configured" | "no-diagnosis"): Record<string, unknown> {
  if (o === null) return { status: reason };
  if (o.status !== "ok") return { status: o.status, code: o.code };
  const p = o.value;
  return {
    status: "ok",
    modelAuthored: true,
    proposalOnly: true,
    applied: false,
    summary: p.summary,
    diff: p.diff,
    files: p.files,
    hunks: p.hunks,
    added: p.added,
    removed: p.removed,
    contextVerified: p.contextVerified,
  };
}

export function buildResultPayload(args: {
  verdict: JobVerdict;
  fixture: string;
  pipeline: ControlledPipelineResult;
  tester: PipelineTesterReport;
  analyst: AgentOutcome<Diagnosis> | null;
  fixer: AgentOutcome<PatchProposal> | null;
  fixerSkipped: "not-configured" | "no-diagnosis";
  origin?: SourceOrigin;
}): Record<string, unknown> {
  const origin = args.origin;
  return {
    verdict: args.verdict,
    sourceKind: origin === undefined ? "controlled-fixture" : "github-pinned",
    ...(origin === undefined ? {} : { source: { repoUrl: origin.repoUrl, commit: origin.commit } }),
    fixture: args.fixture,
    pipeline: projectPipeline(args.pipeline),
    tester: args.tester,
    analyst: projectAnalyst(args.analyst),
    fixer: projectFixer(args.fixer, args.fixerSkipped),
    notes: [
      origin === undefined
        ? "The source is an operator-prepared controlled fixture, not a fetched repository."
        : "The source is a public GitHub repository fetched at the pinned commit; only its root package.json, package-lock.json, build.mjs and test.mjs were used.",
      "A patch proposal is never applied; no repair was verified.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const infra = (reason: string): RunOutcome => ({ kind: "infrastructure-unavailable", reason });

export class PipelineJobRunner implements JobRunner {
  private readonly o: PipelineJobRunnerOptions;

  constructor(opts: PipelineJobRunnerOptions) {
    if (typeof opts?.resolve !== "function" || typeof opts.cleanupExecution !== "function" || typeof opts.pipeline?.run !== "function") {
      throw new Error("resolve, pipeline and cleanupExecution are required");
    }
    this.o = opts;
  }

  async run(ctx: RunContext): Promise<RunOutcome> {
    const report: JobProgress | undefined = ctx.report;
    if (report === undefined) return infra(NO_REPORTER_REASON);
    if (ctx.signal.aborted) return { kind: "aborted" };

    let source: ControlledSource | null;
    try {
      source = await this.o.resolve(ctx.repoUrl);
    } catch {
      source = null;
    }
    if (source === null) return infra(REPOSITORY_UNSUPPORTED_REASON);
    if (!validSource(source)) return infra(SOURCE_INVALID_REASON);
    if (ctx.signal.aborted) return { kind: "aborted" };

    const buildNote = this.o.buildNote ?? "install, build and test run offline in one disposable container";
    if (!report.stage("building", buildNote)) return { kind: "aborted" };

    let result: ControlledPipelineResult;
    try {
      result = await this.o.pipeline.run({ executionId: ctx.executionId, fixture: source.fixture, signal: ctx.signal });
    } catch {
      return infra("The pipeline raised an error; no result was produced.");
    }
    if (ctx.signal.aborted) return { kind: "aborted" };

    // Defence in depth: a verdict needs proof for exactly this execution, whatever the pipeline said.
    let effective = result;
    if (
      result.status !== "not-run" &&
      (result.executionId !== ctx.executionId || result.cleanup === null || result.cleanup.confirmed !== true || result.stagingRemoved !== true)
    ) {
      effective = { ...result, status: "not-run", reason: "cleanup-unconfirmed", stages: result.stages };
    }

    if (!report.stage("testing", "the Tester judges the observed stage results")) return { kind: "aborted" };
    const tester = buildPipelineTesterReport(effective);

    const inconclusive = effective.status === "not-run" && effective.reason !== "tests-not-run";
    if (inconclusive || (tester.status === "not-run" && tester.reason !== "tests-not-run")) {
      return infra(`The pipeline did not produce a verdict (${effective.reason}); no result was recorded.`);
    }

    let verdict: JobVerdict;
    let analyst: AgentOutcome<Diagnosis> | null = null;
    let fixer: AgentOutcome<PatchProposal> | null = null;
    let fixerSkipped: "not-configured" | "no-diagnosis" = "not-configured";

    if (effective.status === "success" && tester.status === "passed") {
      verdict = "verified";
    } else if (effective.status === "not-run" && tester.reason === "tests-not-run") {
      verdict = "tests-not-run";
    } else if (effective.status === "failure" && tester.status === "failed") {
      verdict = "repository-failing";
      const agents = this.o.agents;
      if (agents !== undefined) {
        const evidence = buildEvidence(effective, source.files);
        if (evidence === null) return infra(SOURCE_INVALID_REASON);

        if (!report.stage("diagnosing", "the Analyst reads bounded, redacted evidence")) return { kind: "aborted" };
        analyst = await this.callAgent("analyst", () => agents.analyze({ evidence, signal: ctx.signal }));
        if (ctx.signal.aborted) return { kind: "aborted" };

        if (analyst.status === "ok") {
          const diagnosis = analyst.value;
          if (!report.stage("repairing", "the Fixer proposes a patch; it is not applied")) return { kind: "aborted" };
          fixer = await this.callAgent("fixer", () => agents.propose({ diagnosis, evidence, signal: ctx.signal }));
          if (ctx.signal.aborted) return { kind: "aborted" };
        } else {
          fixerSkipped = "no-diagnosis";
        }
      }
    } else {
      return infra("The pipeline verdict and the Tester report disagree; no result was recorded.");
    }

    const payload = buildResultPayload({
      verdict, fixture: source.fixture, pipeline: effective, tester, analyst, fixer, fixerSkipped,
      ...(source.origin === undefined ? {} : { origin: source.origin }),
    });
    if (!report.result(payload)) return { kind: "aborted" };
    return { kind: "completed" };
  }

  async cleanup(req: CleanupRequest): Promise<CleanupProof> {
    let proof: CleanupProof;
    try {
      proof = await this.o.cleanupExecution(req.executionId);
    } catch {
      return { confirmed: false, reason: "the cleanup check raised an error" };
    }
    if (typeof proof !== "object" || proof === null) return { confirmed: false, reason: "no cleanup proof was returned" };
    if (proof.confirmed !== true) return proof;
    if (proof.executionId !== req.executionId) return { confirmed: false, reason: "cleanup proof is for a different execution" };
    return proof;
  }

  /** Agent failures are data in the result, never job failures. A thrown error becomes status "failed". */
  private async callAgent<T>(role: "analyst" | "fixer", call: () => Promise<AgentOutcome<T>>): Promise<AgentOutcome<T>> {
    try {
      return await call();
    } catch {
      return { status: "failed", role, code: "agent-raised", detail: "the agent adapter raised an error" };
    }
  }
}
