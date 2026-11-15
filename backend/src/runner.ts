/**
 * runner.ts — execution runner contract and the fail-closed production runner.
 *
 * The coordinator (worker.ts) never executes repository code itself; it only
 * drives a JobRunner. No secure sandbox exists yet, so the only runner shipped
 * here, UnavailableRunner, refuses to run anything and reports
 * infrastructure-unavailable. It never reports success.
 *
 * @module runner
 */

import type { ProgressStage } from "./leases.js";

/**
 * Fenced progress channel the coordinator hands to a runner. Both calls return false when the write
 * was not recorded (lease lost, deadline passed, coordinator abort, duplicate or oversize result);
 * the runner must then stop and report nothing further. Never throws.
 */
export interface JobProgress {
  /** Records a stage transition with a short fixed-text note. */
  stage(stage: ProgressStage, note?: string): boolean;
  /** Records the single result of this attempt (plain JSON object, at most 64 KiB serialized). */
  result(result: Record<string, unknown>): boolean;
}

/** Everything a runner may know about one execution attempt. */
export interface RunContext {
  jobId: string;
  repoUrl: string;
  /** Unique per (job, attempt). Cleanup is requested by this id. */
  executionId: string;
  attempt: number;
  /** ISO-8601 job deadline. The coordinator aborts `signal` when it passes. */
  deadlineAt: string;
  /** Aborted on shutdown, deadline or lost lease. The runner must stop promptly. */
  signal: AbortSignal;
  /** Present when run by JobWorker. A runner that needs to record results must refuse to run without it. */
  report?: JobProgress;
}

/**
 * What a run attempt reports. "completed" is a claim by the runner that all
 * work it was asked to do finished; the coordinator still requires cleanup
 * proof before recording it. Anything else leads to a failed/recovery path.
 */
export type RunOutcome =
  | { kind: "completed" }
  | { kind: "infrastructure-unavailable"; reason: string }
  | { kind: "aborted" };

export interface CleanupRequest {
  jobId: string;
  executionId: string;
  attempt: number;
  /** Worker that owned the attempt, when known (recovery of another process). */
  workerId: string | null;
}

/**
 * Proof that nothing from the execution is still running or holding resources.
 * `confirmed: true` must only be returned after the runner verified it (for
 * example, the container is observed gone). Absence of an error is not proof.
 */
export type CleanupProof =
  | { confirmed: true; executionId: string; evidence: string }
  | { confirmed: false; reason: string };

export interface JobRunner {
  run(ctx: RunContext): Promise<RunOutcome>;
  /** Idempotent. Must actively terminate and then verify, or return confirmed:false. */
  cleanup(req: CleanupRequest): Promise<CleanupProof>;
}

export const SANDBOX_UNAVAILABLE_REASON =
  "Secure sandbox is not implemented; repository code was not executed.";

/**
 * Production runner until the sandbox milestone. Fails closed:
 *  - run() never starts anything and always reports infrastructure-unavailable.
 *  - cleanup() can prove "nothing was started" only for execution ids that
 *    this instance itself refused in run(). For any other id (for example a
 *    job left by a different or earlier process) it cannot know, so it
 *    returns confirmed:false and recovery stays blocked.
 */
export class UnavailableRunner implements JobRunner {
  private readonly refused = new Set<string>();

  run(ctx: RunContext): Promise<RunOutcome> {
    this.refused.add(ctx.executionId);
    return Promise.resolve({ kind: "infrastructure-unavailable", reason: SANDBOX_UNAVAILABLE_REASON });
  }

  cleanup(req: CleanupRequest): Promise<CleanupProof> {
    if (this.refused.has(req.executionId)) {
      return Promise.resolve({
        confirmed: true,
        executionId: req.executionId,
        evidence: "unavailable-runner refused this execution in this process; nothing was ever started",
      });
    }
    return Promise.resolve({
      confirmed: false,
      reason: "cleanup cannot be proven: this runner did not create that execution and no sandbox exists",
    });
  }
}
