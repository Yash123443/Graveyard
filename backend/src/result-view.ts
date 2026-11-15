/**
 * result-view.ts — what GET /api/jobs/:id/result tells an authorized client.
 *
 * Pure presentation of durable job state. Nothing here executes anything or reads the database.
 *
 * The central rule: the view says what was OBSERVED and never implies a repair that did not
 * happen. No code path in this backend applies a patch or re-runs the build against patched code,
 * so `repair.verified` and `repair.patchApplied` are the constant `false`. A model-authored
 * diagnosis or patch proposal is reported as exactly that (`diagnosed`, `patchProposed`), never as
 * a fix.
 *
 * Outcomes:
 *   pending                    queued or running (also: blocked awaiting cleanup proof). No result.
 *   passing                    the unmodified controlled fixture built and passed its tests.
 *   failing-with-patch-proposal  the fixture fails; a model-authored patch was proposed, NOT applied.
 *   failing-with-diagnosis     the fixture fails; a model-authored diagnosis exists, no proposal.
 *   failing-undiagnosed        the fixture fails; no diagnosis (agents off, unavailable or no result).
 *   tests-not-run              the build passed but no tests ran. Not a verification.
 *   infrastructure-failed      the job could not be evaluated. Says nothing about the repository.
 *   timed-out                  the deadline passed. Says nothing about the repository.
 *   cancelled                  cancelled while queued. Nothing ran.
 *   completed-without-result   marked completed but no valid result record exists. Treat as no result.
 *
 * @module result-view
 */

import type { JobResultRecord } from "./jobs.js";
import { isTerminalStatus } from "./jobs.js";

export type ResultOutcome =
  | "pending"
  | "passing"
  | "failing-with-patch-proposal"
  | "failing-with-diagnosis"
  | "failing-undiagnosed"
  | "tests-not-run"
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
    /** Always false: nothing re-verifies a patched repository. */
    verified: false;
    /** Always false: no patch is ever applied. */
    patchApplied: false;
    /** A model-authored, unapplied patch proposal is present in `result.fixer`. */
    patchProposed: boolean;
    /** A model-authored diagnosis is present in `result.analyst`. */
    diagnosed: boolean;
  };
  /** The stored result payload of the final attempt (completed jobs only), otherwise null. */
  result: Record<string, unknown> | null;
  /** Infrastructure metadata for failed or timed-out jobs. Never a repository diagnosis. */
  infrastructure: ResultInfrastructure | null;
}

const VERDICTS = ["verified", "repository-failing", "tests-not-run"] as const;
const INFRA_KINDS = ["deadline-exceeded", "attempts-exhausted", "infrastructure-unavailable", "cleanup-unconfirmed"];
const MAX_INFRA_MESSAGE = 300;

const SUMMARIES: Readonly<Record<ResultOutcome, string>> = {
  pending: "The job has not finished. No result exists yet.",
  passing:
    "The unmodified operator-prepared fixture built and passed its tests. No repair was performed or needed.",
  "failing-with-patch-proposal":
    "The fixture fails. A model-authored patch was proposed. It was not applied and not verified.",
  "failing-with-diagnosis":
    "The fixture fails. A model-authored diagnosis exists. No patch was proposed, applied or verified.",
  "failing-undiagnosed":
    "The fixture fails. No diagnosis or patch was produced. Nothing was repaired.",
  "tests-not-run":
    "The build passed but no tests ran. This is not a verified result.",
  "infrastructure-failed":
    "The job could not be evaluated because of an infrastructure condition. This is not a diagnosis of the repository.",
  "timed-out":
    "The job exceeded its deadline. This is an infrastructure outcome, not a verdict on the repository.",
  cancelled: "The job was cancelled while queued. Nothing was executed.",
  "completed-without-result":
    "The job is marked completed but no valid result record was found. Treat this as no result.",
};

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

function classify(result: Record<string, unknown>): { outcome: ResultOutcome; diagnosed: boolean; patchProposed: boolean } | null {
  const verdict = result["verdict"];
  if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) return null;
  if (verdict === "verified") return { outcome: "passing", diagnosed: false, patchProposed: false };
  if (verdict === "tests-not-run") return { outcome: "tests-not-run", diagnosed: false, patchProposed: false };

  const analyst = result["analyst"];
  const fixer = result["fixer"];
  const diagnosed = isObj(analyst) && analyst["status"] === "ok" && analyst["modelAuthored"] === true;
  const patchProposed =
    isObj(fixer) &&
    fixer["status"] === "ok" &&
    fixer["modelAuthored"] === true &&
    fixer["proposalOnly"] === true &&
    fixer["applied"] === false;
  if (patchProposed) return { outcome: "failing-with-patch-proposal", diagnosed, patchProposed };
  if (diagnosed) return { outcome: "failing-with-diagnosis", diagnosed, patchProposed: false };
  return { outcome: "failing-undiagnosed", diagnosed: false, patchProposed: false };
}

/** Builds the client-facing view of a job. Total: never throws. */
export function presentResult(rec: JobResultRecord): ResultView {
  const terminal = isTerminalStatus(rec.status);
  const base = { jobId: rec.jobId, status: rec.status, stage: rec.stage, terminal };
  const make = (
    outcome: ResultOutcome,
    extra: { result?: Record<string, unknown>; infrastructure?: ResultInfrastructure | null; diagnosed?: boolean; patchProposed?: boolean } = {},
  ): ResultView => ({
    ...base,
    outcome,
    summary: SUMMARIES[outcome],
    repair: {
      verified: false,
      patchApplied: false,
      patchProposed: extra.patchProposed ?? false,
      diagnosed: extra.diagnosed ?? false,
    },
    result: extra.result ?? null,
    infrastructure: extra.infrastructure ?? null,
  });

  switch (rec.status) {
    case "completed": {
      if (rec.result === null) return make("completed-without-result");
      const c = classify(rec.result);
      if (c === null) return make("completed-without-result");
      return make(c.outcome, { result: rec.result, diagnosed: c.diagnosed, patchProposed: c.patchProposed });
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
