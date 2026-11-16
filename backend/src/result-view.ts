/**
 * result-view.ts — what GET /api/jobs/:id/result tells an authorized client.
 *
 * Pure presentation of durable job state. Nothing here executes anything or reads the database.
 *
 * The central rule: the view says what was OBSERVED and never implies a repair that did not
 * happen. A model-authored diagnosis or patch proposal is reported as exactly that (`diagnosed`,
 * `patchProposed`), never as a fix. `repair.verified` is true ONLY for outcome `repair-verified`,
 * which requires a stored verification record that this module re-checks (observed pipeline and
 * Tester statuses of a patched DISPOSABLE COPY, confirmed cleanup, patch class and the sha256 of the
 * exact diff). `repair.patchApplied` stays the constant `false`: the original is never modified.
 * Results stored before repair verification existed, and results without a valid verification
 * record, keep their earlier outcomes unchanged.
 *
 * Outcomes:
 *   pending                    queued or running (also: blocked awaiting cleanup proof). No result.
 *   passing                    the unmodified controlled fixture built and passed its tests.
 *   repair-verified            the fixture fails; a model-authored patch to the root build.mjs, applied to a
 *                              disposable copy, installed, built and passed the original tests offline.
 *   patch-failed-verification  the same, but the patched copy was tested and still failed (tested failure).
 *   failing-with-patch-proposal  the fixture fails; a model-authored patch was proposed, NOT verified
 *                              (not attempted, refused, or no verification record).
 *   failing-with-diagnosis     the fixture fails; a model-authored diagnosis exists, no proposal.
 *   failing-undiagnosed        the fixture fails; no diagnosis (agents off, unavailable or no result).
 *   tests-not-run              the build passed but no tests ran. Not a verification.
 *   unsupported-repository     a pinned GitHub commit was fetched and inspected but is outside the supported class
 *                              (or dependency acquisition is not configured). Nothing was built or run.
 *   source-inspected           an opt-in UNPINNED public GitHub HEAD was resolved to an immutable commit and its root
 *                              files read as data. Nothing was installed, built, run or sent to a model; an operator pin
 *                              is required before execution. Distinct from unsupported-repository. Not a health claim.
 *   static-site-audited        a pinned GitHub commit with a root index.html and no package.json was read-only audited
 *                              (HTML and CSS text only): `result.analysis.findings` lists missing local references with
 *                              a stated partial scope. Diagnostics only: nothing was executed, no repair, no pass claim.
 *   infrastructure-failed      the job could not be evaluated. Says nothing about the repository.
 *   timed-out                  the deadline passed. Says nothing about the repository.
 *   cancelled                  cancelled while queued. Nothing ran.
 *   completed-without-result   marked completed but no valid result record exists. Treat as no result.
 *
 * @module result-view
 */

import { createHash } from "node:crypto";
import type { JobResultRecord } from "./jobs.js";
import { isTerminalStatus } from "./jobs.js";

export type ResultOutcome =
  | "pending"
  | "passing"
  | "repair-verified"
  | "patch-failed-verification"
  | "failing-with-patch-proposal"
  | "failing-with-diagnosis"
  | "failing-undiagnosed"
  | "tests-not-run"
  | "unsupported-repository"
  | "source-inspected"
  | "static-site-audited"
  | "infrastructure-failed"
  | "timed-out"
  | "cancelled"
  | "completed-without-result";

export interface ResultInfrastructure {
  kind: string;
  message: string;
  attemptCount: number;
  maxAttempts: number;
  at: string;
}

export interface ResultView {
  jobId: string;
  status: string;
  stage: string;
  /** True once the job can no longer change (completed, failed, cancelled, timed-out). */
  terminal: boolean;
  outcome: ResultOutcome;
  /** Fixed explanatory text chosen by this module. Never repository or model output. */
  summary: string;
  repair: {
    /**
     * True only for outcome `repair-verified`: a patched DISPOSABLE COPY installed, built and passed
     * its original tests offline, with confirmed cleanup. It never means the original was changed.
     */
    verified: boolean;
    /** Always false: no patch is ever applied to the original source. */
    patchApplied: false;
    /** A model-authored patch proposal is present in `result.fixer`. */
    patchProposed: boolean;
    /** A model-authored diagnosis is present in `result.analyst`. */
    diagnosed: boolean;
  };
  /** The exact verified diff (outcome `repair-verified` only, after re-checking its sha256), otherwise null. */
  verifiedDiff: string | null;
  /** The stored result payload of the final attempt (completed jobs only), otherwise null. */
  result: Record<string, unknown> | null;
  /** Infrastructure metadata for failed or timed-out jobs. Never a repository diagnosis. */
  infrastructure: ResultInfrastructure | null;
}

const VERDICTS = ["verified", "repository-failing", "tests-not-run", "unsupported-repository", "source-inspected", "static-site-audited"] as const;
const INFRA_KINDS = ["deadline-exceeded", "attempts-exhausted", "infrastructure-unavailable", "cleanup-unconfirmed"];
const MAX_INFRA_MESSAGE = 300;

const SUMMARIES: Readonly<Record<ResultOutcome, string>> = {
  pending: "The job has not finished. No result exists yet.",
  passing:
    "The unmodified operator-prepared fixture built and passed its tests. No repair was performed or needed.",
  "failing-with-patch-proposal":
    "The fixture fails. A model-authored patch was proposed. It was not applied and not verified.",
  "repair-verified":
    "The fixture fails. A model-authored patch was applied to a disposable copy only, and that copy installed its locked dependencies, built and passed the original tests offline in the sandbox. The original was not modified. The verified diff can be saved.",
  "patch-failed-verification":
    "The fixture fails. A model-authored patch was applied to a disposable copy and tested offline in the sandbox. The copy still failed, so this is not a repair. The original was not modified.",
  "failing-with-diagnosis":
    "The fixture fails. A model-authored diagnosis exists. No patch was proposed, applied or verified.",
  "failing-undiagnosed":
    "The fixture fails. No diagnosis or patch was produced. Nothing was repaired.",
  "tests-not-run":
    "The build passed but no tests ran. This is not a verified result.",
  "unsupported-repository":
    "The repository was fetched at the pinned commit and inspected, but it is outside the supported class (or this deployment cannot run its dependencies). Nothing was built or tested. This is not a verdict that the repository is broken.",
  "infrastructure-failed":
    "The job could not be evaluated because of an infrastructure condition. This is not a diagnosis of the repository.",
  "source-inspected":
    "The repository's current HEAD was fetched in a disposable container and its root files were read as data. Nothing was installed, built, tested or repaired, and no source was sent to a model. This is not a verdict that the repository works or is broken. An operator must pin the reported commit before anything is executed.",
  "static-site-audited":
    "The pinned commit is a static HTML/CSS/JS site. Its HTML and CSS text was read in a disposable container and local page and asset references were checked against the committed files. The audit is partial (see the findings and notes), nothing was built, run or requested over the network, and no repair was attempted. The findings are diagnostics. No findings does not mean the site works.",
  "timed-out":
    "The job exceeded its deadline. This is an infrastructure outcome, not a verdict on the repository.",
  cancelled: "The job was cancelled while queued. Nothing was executed.",
  "completed-without-result":
    "The job is marked completed but no valid result record was found. Treat this as no result.",
};

/** Used for an unpinned inspection that source policy stopped before any root file was read. */
const SOURCE_REJECTED_SUMMARY =
  "The repository's HEAD was fetched in a disposable container, but source policy stopped the inspection before any root files were read. Nothing was installed, built, tested or repaired, and no source was sent to a model. This is not a verdict that the repository works or is broken. Pinning the commit would not bypass the source-policy block.";

/** Used instead of SUMMARIES when the stored result says the source was a pinned GitHub commit. */
const GITHUB_SUMMARIES: Readonly<Partial<Record<ResultOutcome, string>>> = {
  passing:
    "The public GitHub repository, unmodified at the pinned commit, installed its locked dependencies, built and passed its tests in the sandbox. No repair was performed or needed.",
  "failing-with-patch-proposal":
    "The GitHub repository fails at the pinned commit. A model-authored patch was proposed. It was not applied and not verified.",
  "repair-verified":
    "The GitHub repository fails at the pinned commit. A model-authored patch was applied to a disposable copy only, and that copy installed its locked dependencies, built and passed the original tests offline in the sandbox. The repository was not modified. The verified diff can be saved.",
  "patch-failed-verification":
    "The GitHub repository fails at the pinned commit. A model-authored patch was applied to a disposable copy and tested offline in the sandbox. The copy still failed, so this is not a repair. The repository was not modified.",
  "failing-with-diagnosis":
    "The GitHub repository fails at the pinned commit. A model-authored diagnosis exists. No patch was proposed, applied or verified.",
  "failing-undiagnosed":
    "The GitHub repository fails at the pinned commit. No diagnosis or patch was produced. Nothing was repaired.",
};

function summaryFor(outcome: ResultOutcome, result: Record<string, unknown> | undefined): string {
  if (outcome === "source-inspected" && result !== undefined && result["inspection"] === null) {
    return SOURCE_REJECTED_SUMMARY;
  }
  if (result !== undefined && result["sourceKind"] === "github-pinned") {
    const specific = GITHUB_SUMMARIES[outcome];
    if (specific !== undefined) return specific;
  }
  return SUMMARIES[outcome];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseInfrastructure(text: string | null): ResultInfrastructure | null {
  if (text === null) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (!isObj(raw)) return null;
    const kind = raw["kind"];
    const message = raw["message"];
    const at = raw["at"];
    const attemptCount = raw["attemptCount"];
    const maxAttempts = raw["maxAttempts"];
    if (typeof kind !== "string" || !INFRA_KINDS.includes(kind)) return null;
    if (typeof message !== "string" || typeof at !== "string") return null;
    if (typeof attemptCount !== "number" || typeof maxAttempts !== "number") return null;
    return {
      kind,
      message: message.length > MAX_INFRA_MESSAGE ? `${message.slice(0, MAX_INFRA_MESSAGE)}…` : message,
      attemptCount,
      maxAttempts,
      at,
    };
  } catch {
    return null;
  }
}

function sameStrings(v: unknown, expected: readonly string[]): boolean {
  return Array.isArray(v) && v.length === expected.length && v.every((x, i) => x === expected[i]);
}

/**
 * Re-checks a stored verification record before a repair is claimed. The stored payload comes from
 * the worker, but this view never trusts a bare "verified" flag: the observed pipeline statuses,
 * the Tester statuses, the cleanup confirmations, the patch class and the sha256 of the exact diff
 * must all agree.
 */
function verificationHolds(
  result: Record<string, unknown>,
  fixer: Record<string, unknown>,
  v: Record<string, unknown>,
  expected: "verified" | "tested-failing",
): boolean {
  if (v["status"] !== expected || v["patchClass"] !== "root-build-mjs-only" || v["originalModified"] !== false) return false;
  const diff = fixer["diff"];
  if (typeof diff !== "string" || diff === "" || v["diffSha256"] !== createHash("sha256").update(diff, "utf8").digest("hex")) return false;
  if (!sameStrings(v["patchedFiles"], ["build.mjs"]) || !sameStrings(fixer["files"], ["build.mjs"])) return false;
  const pre = result["pipeline"];
  const preTester = result["tester"];
  const baseline = v["baseline"];
  if (!isObj(pre) || pre["status"] !== "failure" || !isObj(preTester) || preTester["status"] !== "failed") return false;
  if (!isObj(baseline) || baseline["status"] !== "failure") return false;
  const patched = v["patched"];
  const tester = v["tester"];
  const cleanup = v["cleanup"];
  if (!isObj(patched) || !isObj(tester) || !isObj(cleanup)) return false;
  if (cleanup["confirmed"] !== true || cleanup["stagingRemoved"] !== true || cleanup["cloneRemoved"] !== true) return false;
  if (typeof v["measuredMs"] !== "number" || !Number.isFinite(v["measuredMs"])) return false;
  return expected === "verified"
    ? patched["status"] === "success" && tester["status"] === "passed"
    : patched["status"] === "failure" && tester["status"] === "failed";
}

interface Classified {
  outcome: ResultOutcome;
  diagnosed: boolean;
  patchProposed: boolean;
  verified?: boolean;
  verifiedDiff?: string;
}

function classify(result: Record<string, unknown>): Classified | null {
  const verdict = result["verdict"];
  if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) return null;
  if (verdict === "verified") return { outcome: "passing", diagnosed: false, patchProposed: false };
  if (verdict === "tests-not-run") return { outcome: "tests-not-run", diagnosed: false, patchProposed: false };
  if (verdict === "unsupported-repository") return { outcome: "unsupported-repository", diagnosed: false, patchProposed: false };
  if (verdict === "static-site-audited") {
    // Only a well-formed audit record counts: pinned source with a 40-hex commit, nothing executed,
    // no repair attempted, and a findings list. Anything else is "no valid result".
    const src = result["source"];
    const analysis = result["analysis"];
    const wellFormed =
      result["sourceKind"] === "github-pinned" &&
      result["profile"] === "static-site" &&
      result["executed"] === false &&
      result["repairAttempted"] === false &&
      isObj(src) &&
      typeof src["commit"] === "string" &&
      /^[0-9a-f]{40}$/.test(src["commit"]) &&
      isObj(result["audit"]) &&
      isObj(analysis) &&
      Array.isArray(analysis["findings"]);
    return wellFormed ? { outcome: "static-site-audited", diagnosed: false, patchProposed: false } : null;
  }
  if (verdict === "source-inspected") {
    // Only a well-formed unpinned inspection record counts. It must say nothing was executed, name
    // the unpinned source kind, and carry either a lowercase 40-hex commit or an explicit null.
    const src = result["source"];
    const commit = isObj(src) ? src["commit"] : undefined;
    const wellFormed =
      result["sourceKind"] === "github-unpinned-head" &&
      result["executed"] === false &&
      isObj(src) &&
      src["pinned"] === false &&
      (commit === null || (typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit))) &&
      // A rejected inspection (no manifest) must not offer a pin, since a pin cannot bypass source policy.
      (result["inspection"] !== null || result["operatorPin"] === null);
    return wellFormed ? { outcome: "source-inspected", diagnosed: false, patchProposed: false } : null;
  }

  const analyst = result["analyst"];
  const fixer = result["fixer"];
  const diagnosed = isObj(analyst) && analyst["status"] === "ok" && analyst["modelAuthored"] === true;
  const patchProposed =
    isObj(fixer) &&
    fixer["status"] === "ok" &&
    fixer["modelAuthored"] === true &&
    fixer["proposalOnly"] === true &&
    fixer["applied"] === false;
  if (patchProposed && isObj(fixer)) {
    const v = result["verification"];
    if (isObj(v)) {
      if (verificationHolds(result, fixer, v, "verified")) {
        return {
          outcome: "repair-verified", diagnosed, patchProposed, verified: true,
          verifiedDiff: fixer["diff"] as string,
        };
      }
      if (verificationHolds(result, fixer, v, "tested-failing")) {
        return { outcome: "patch-failed-verification", diagnosed, patchProposed };
      }
    }
    return { outcome: "failing-with-patch-proposal", diagnosed, patchProposed };
  }
  if (diagnosed) return { outcome: "failing-with-diagnosis", diagnosed, patchProposed: false };
  return { outcome: "failing-undiagnosed", diagnosed: false, patchProposed: false };
}

/** Builds the client-facing view of a job. Total: never throws. */
export function presentResult(rec: JobResultRecord): ResultView {
  const terminal = isTerminalStatus(rec.status);
  const base = { jobId: rec.jobId, status: rec.status, stage: rec.stage, terminal };
  const make = (
    outcome: ResultOutcome,
    extra: {
      result?: Record<string, unknown>;
      infrastructure?: ResultInfrastructure | null;
      diagnosed?: boolean;
      patchProposed?: boolean;
      verified?: boolean;
      verifiedDiff?: string;
    } = {},
  ): ResultView => ({
    ...base,
    outcome,
    summary: summaryFor(outcome, extra.result),
    repair: {
      verified: extra.verified ?? false,
      patchApplied: false,
      patchProposed: extra.patchProposed ?? false,
      diagnosed: extra.diagnosed ?? false,
    },
    verifiedDiff: extra.verifiedDiff ?? null,
    result: extra.result ?? null,
    infrastructure: extra.infrastructure ?? null,
  });

  switch (rec.status) {
    case "completed": {
      if (rec.result === null) return make("completed-without-result");
      const c = classify(rec.result);
      if (c === null) return make("completed-without-result");
      return make(c.outcome, {
        result: rec.result,
        diagnosed: c.diagnosed,
        patchProposed: c.patchProposed,
        ...(c.verified === undefined ? {} : { verified: c.verified }),
        ...(c.verifiedDiff === undefined ? {} : { verifiedDiff: c.verifiedDiff }),
      });
    }
    case "failed":
      return make("infrastructure-failed", { infrastructure: parseInfrastructure(rec.infraError) });
    case "timed-out":
      return make("timed-out", { infrastructure: parseInfrastructure(rec.infraError) });
    case "cancelled":
      return make("cancelled");
    default:
      // queued, running (including a fenced job waiting for cleanup proof): no result is exposed.
      return make("pending");
  }
}
