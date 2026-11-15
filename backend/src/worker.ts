/**
 * worker.ts — single-job execution coordinator (foundation only).
 *
 * Drives an injected JobRunner for one job at a time. It never executes
 * repository code itself and starts no process or network listener; nothing
 * in the running server instantiates it yet.
 *
 * Guarantees:
 *  - Exclusivity: one active job per coordinator (in-process guard) and one
 *    holder per job across coordinators (atomic claim in leases.ts).
 *  - Fenced writes: every terminal write requires the current lease token, an
 *    unexpired lease and an unpassed deadline (leases.ts finishLeasedJob). A
 *    stale worker's writes are rejected with no side effects.
 *  - Cleanup before consequence: completion, failure, requeue and timeout are
 *    recorded only after the runner returns valid cleanup proof for that
 *    exact execution id. Missing, malformed, mismatched, thrown or timed-out
 *    proof leaves the job fenced (recovery_required) and blocked, with a
 *    single "cleanup-unconfirmed" infrastructure record.
 *  - State and event for each transition commit in one transaction.
 *  - Heartbeat extends the lease; a rejected heartbeat aborts the run. The
 *    deadline and shutdown abort the run through the same AbortSignal. After
 *    any abort the runner's result is discarded, even "completed".
 *
 * Time and timers are injected so behaviour is testable without real waiting.
 *
 * @module worker
 */

import type { DatabaseSync } from "node:sqlite";
import {
  claimNextJob,
  heartbeat,
  fenceExpiredLeases,
  fenceOwnLease,
  confirmRecoveryCleanup,
  finishLeasedJob,
  recordCleanupUnconfirmed,
  listRecoveryTargets,
  expireQueuedDeadlines,
  executionIdFor,
  recordLeasedStage,
  recordLeasedResult,
  DEFAULT_LEASE_MS,
  type ClaimedJob,
} from "./leases.js";
import type { CleanupRequest, JobProgress, JobRunner, RunOutcome } from "./runner.js";

export type Cancel = () => void;

/** Injectable timers. `label` is diagnostic only. */
export interface WorkerTimers {
  every(ms: number, fn: () => void, label: string): Cancel;
  after(ms: number, fn: () => void, label: string): Cancel;
}

/** Real timers; unref'd so they never keep the process alive. */
export const systemTimers: WorkerTimers = {
  every(ms, fn) {
    const h = setInterval(fn, ms);
    h.unref();
    return () => clearInterval(h);
  },
  after(ms, fn) {
    const h = setTimeout(fn, ms);
    h.unref();
    return () => clearTimeout(h);
  },
};

export interface WorkerOptions {
  db: DatabaseSync;
  workerId: string;
  runner: JobRunner;
  timers?: WorkerTimers;
  now?: () => Date;
  leaseMs?: number;
  /** Must be smaller than leaseMs. Default leaseMs / 3. */
  heartbeatMs?: number;
  /** How long to wait for run() to settle after abort before demanding cleanup. */
  abortGraceMs?: number;
  /** Upper bound for one runner.cleanup() call; exceeding it counts as unproven. */
  cleanupTimeoutMs?: number;
}

export type FinishedOutcome =
  | "completed"
  | "failed"
  | "requeued"
  | "timed-out"
  /** Cleanup unproven: job fenced and blocked from re-execution. */
  | "blocked"
  /** Lease no longer held; nothing was written. Recovery owns the job. */
  | "lease-lost";

export type WorkerRunResult =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "finished"; jobId: string; outcome: FinishedOutcome };

export interface RecoveryResult {
  jobId: string;
  outcome: "requeued" | "failed" | "timed-out" | "blocked" | "rejected";
}

type AbortReason = "shutdown" | "deadline" | "lease-lost";
type Cleanup = { ok: true; evidence: string } | { ok: false; reason: string };
type Settled<T> = { timedOut: false; value: T } | { timedOut: true };

const MAX_EVIDENCE = 200;
const clip = (s: string): string => (s.length > MAX_EVIDENCE ? `${s.slice(0, MAX_EVIDENCE)}…` : s);

export class JobWorker {
  private readonly db: DatabaseSync;
  private readonly workerId: string;
  private readonly runner: JobRunner;
  private readonly timers: WorkerTimers;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly abortGraceMs: number;
  private readonly cleanupTimeoutMs: number;

  private active = false;
  private activeJobId: string | null = null;
  private shuttingDown = false;
  private abortActive: ((reason: AbortReason) => void) | null = null;
  private activeDone: Promise<void> | null = null;

  constructor(opts: WorkerOptions) {
    if (typeof opts.workerId !== "string" || opts.workerId.length === 0 || opts.workerId.length > 128) {
      throw new Error("workerId must be a non-empty string of at most 128 characters");
    }
    this.db = opts.db;
    this.workerId = opts.workerId;
    this.runner = opts.runner;
    this.timers = opts.timers ?? systemTimers;
    this.now = opts.now ?? ((): Date => new Date());
    this.leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatMs = opts.heartbeatMs ?? Math.floor(this.leaseMs / 3);
    this.abortGraceMs = opts.abortGraceMs ?? 5_000;
    this.cleanupTimeoutMs = opts.cleanupTimeoutMs ?? 30_000;
    const checks: Array<[string, number]> = [
      ["leaseMs", this.leaseMs],
      ["heartbeatMs", this.heartbeatMs],
      ["abortGraceMs", this.abortGraceMs],
      ["cleanupTimeoutMs", this.cleanupTimeoutMs],
    ];
    for (const [name, v] of checks) {
      if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number`);
    }
    if (this.heartbeatMs >= this.leaseMs) throw new Error("heartbeatMs must be smaller than leaseMs");
  }

  /** Claims and fully processes at most one job. Never runs two jobs at once. */
  async runOnce(): Promise<WorkerRunResult> {
    if (this.shuttingDown) return { kind: "idle" };
    if (this.active) return { kind: "busy" };
    this.active = true;
    try {
      const job = claimNextJob(this.db, { workerId: this.workerId, leaseMs: this.leaseMs, now: this.now() });
      if (job === null) return { kind: "idle" };
      this.activeJobId = job.jobId;
      const p = this.execute(job);
      this.activeDone = p.then(() => undefined, () => undefined);
      const outcome = await p;
      return { kind: "finished", jobId: job.jobId, outcome };
    } finally {
      this.active = false;
      this.activeJobId = null;
      this.activeDone = null;
      this.abortActive = null;
    }
  }

  /**
   * Stops accepting work, aborts the active run, and resolves after the job
   * has been settled: requeued only with cleanup proof, otherwise fenced and
   * blocked. Safe to call repeatedly.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.abortActive?.("shutdown");
    if (this.activeDone !== null) await this.activeDone;
  }

  /**
   * Recovery pass: fences expired leases, times out expired queued jobs, then
   * for every fenced job asks the runner for cleanup proof. Only valid proof
   * lets confirmRecoveryCleanup run. The job this worker is actively running
   * is left to its own flow.
   */
  async recoverOnce(): Promise<RecoveryResult[]> {
    if (this.shuttingDown) return [];
    const now = this.now();
    fenceExpiredLeases(this.db, { now });
    expireQueuedDeadlines(this.db, { now });

    const results: RecoveryResult[] = [];
    for (const target of listRecoveryTargets(this.db)) {
      if (target.jobId === this.activeJobId) continue;
      const cleanup = await this.requestCleanup({
        jobId: target.jobId,
        executionId: target.executionId,
        attempt: target.attemptCount,
        workerId: target.workerId,
      });
      if (!cleanup.ok) {
        recordCleanupUnconfirmed(this.db, {
          jobId: target.jobId,
          recoveryToken: target.recoveryToken,
          message: cleanup.reason,
          now: this.now(),
        });
        results.push({ jobId: target.jobId, outcome: "blocked" });
        continue;
      }
      const res = confirmRecoveryCleanup(this.db, {
        jobId: target.jobId,
        recoveryToken: target.recoveryToken,
        confirmedBy: `runner-cleanup-proof: ${clip(cleanup.evidence)}`,
        now: this.now(),
      });
      results.push({ jobId: target.jobId, outcome: res.outcome });
    }
    return results;
  }

  // -------------------------------------------------------------------------

  private async execute(job: ClaimedJob): Promise<FinishedOutcome> {
    const executionId = executionIdFor(job.jobId, job.attemptCount);
    const controller = new AbortController();
    const state: { reason: AbortReason | null } = { reason: null };
    const abort = (reason: AbortReason): void => {
      if (state.reason !== null) return;
      state.reason = reason;
      controller.abort();
    };
    this.abortActive = abort;

    const deadlineMs = Date.parse(job.deadlineAt);
    let leaseExpiresMs = Date.parse(job.leaseExpiresAt);

    const cancelHeartbeat = this.timers.every(this.heartbeatMs, () => {
      const now = this.now();
      if (now.getTime() >= deadlineMs) {
        abort("deadline");
        return;
      }
      try {
        const res = heartbeat(this.db, {
          jobId: job.jobId, leaseToken: job.leaseToken, leaseMs: this.leaseMs, now,
        });
        if (res.accepted) leaseExpiresMs = Date.parse(res.leaseExpiresAt);
        else abort("lease-lost");
      } catch {
        // Transient DB error: keep running until the lease we last saw expires.
        if (now.getTime() >= leaseExpiresMs) abort("lease-lost");
      }
    }, "heartbeat");
    const cancelDeadline = this.timers.after(
      Math.max(0, deadlineMs - this.now().getTime()),
      () => abort("deadline"),
      "deadline",
    );

    try {
      const aborted = new Promise<"aborted">((resolve) => {
        controller.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      const report: JobProgress = {
        // Fenced by lease token, lease expiry and deadline in leases.ts. After any coordinator abort
        // nothing more is recorded, matching "the runner's result is discarded after an abort".
        stage: (stage, note) => {
          if (state.reason !== null) return false;
          try {
            return recordLeasedStage(this.db, {
              jobId: job.jobId, leaseToken: job.leaseToken, stage, now: this.now(),
              ...(note === undefined ? {} : { note }),
            }).accepted;
          } catch {
            return false;
          }
        },
        result: (result) => {
          if (state.reason !== null) return false;
          try {
            return recordLeasedResult(this.db, {
              jobId: job.jobId, leaseToken: job.leaseToken, result, now: this.now(),
            }).accepted;
          } catch {
            return false;
          }
        },
      };
      const runP: Promise<RunOutcome | { kind: "error" }> = (async () => {
        try {
          return await this.runner.run({
            jobId: job.jobId,
            repoUrl: job.repoUrl,
            executionId,
            attempt: job.attemptCount,
            deadlineAt: job.deadlineAt,
            signal: controller.signal,
            report,
          });
        } catch {
          return { kind: "error" } as const;
        }
      })();

      const first = await Promise.race([runP, aborted]);
      if (first === "aborted") await this.settleWithin(runP, this.abortGraceMs, "abort-grace");

      // Snapshot: any abort before this point discards the runner's result.
      const reason = state.reason;
      const outcome = reason === null && first !== "aborted" ? first : null;

      const cleanup = await this.requestCleanup({
        jobId: job.jobId,
        executionId,
        attempt: job.attemptCount,
        workerId: this.workerId,
      });

      if (reason === "lease-lost") return "lease-lost";
      if (reason !== null) return this.settleAborted(job, reason, cleanup);
      return this.settleFinished(job, outcome, cleanup);
    } finally {
      cancelHeartbeat();
      cancelDeadline();
    }
  }

  /** Shutdown or deadline: recover through fence + proof-gated confirm. */
  private settleAborted(job: ClaimedJob, reason: AbortReason, cleanup: Cleanup): FinishedOutcome {
    const fenced = fenceOwnLease(this.db, {
      jobId: job.jobId, leaseToken: job.leaseToken, reason: `worker-${reason}`, now: this.now(),
    });
    if (fenced === null) return "lease-lost";
    if (!cleanup.ok) {
      recordCleanupUnconfirmed(this.db, {
        jobId: job.jobId, recoveryToken: fenced.recoveryToken, message: cleanup.reason, now: this.now(),
      });
      return "blocked";
    }
    const res = confirmRecoveryCleanup(this.db, {
      jobId: job.jobId,
      recoveryToken: fenced.recoveryToken,
      confirmedBy: `runner-cleanup-proof: ${clip(cleanup.evidence)}`,
      now: this.now(),
    });
    return res.outcome === "rejected" ? "lease-lost" : res.outcome;
  }

  /** No abort happened: record the runner's outcome, gated on cleanup proof. */
  private settleFinished(
    job: ClaimedJob,
    outcome: RunOutcome | { kind: "error" } | null,
    cleanup: Cleanup,
  ): FinishedOutcome {
    if (!cleanup.ok) {
      const fenced = fenceOwnLease(this.db, {
        jobId: job.jobId, leaseToken: job.leaseToken, reason: "cleanup-unconfirmed", now: this.now(),
      });
      if (fenced === null) return "lease-lost";
      recordCleanupUnconfirmed(this.db, {
        jobId: job.jobId, recoveryToken: fenced.recoveryToken, message: cleanup.reason, now: this.now(),
      });
      return "blocked";
    }

    const evidence = clip(cleanup.evidence);
    if (outcome !== null && outcome.kind === "completed") {
      const res = finishLeasedJob(this.db, {
        jobId: job.jobId, leaseToken: job.leaseToken, outcome: "completed",
        cleanupEvidence: evidence, now: this.now(),
      });
      return res.accepted ? "completed" : "lease-lost";
    }

    let message: string;
    if (outcome !== null && outcome.kind === "infrastructure-unavailable") {
      message = outcome.reason;
    } else if (outcome !== null && outcome.kind === "error") {
      message = "Runner raised an error; no result was produced.";
    } else {
      message = "Runner stopped without a result and without a coordinator abort request.";
    }
    const res = finishLeasedJob(this.db, {
      jobId: job.jobId, leaseToken: job.leaseToken, outcome: "failed",
      failure: { kind: "infrastructure-unavailable", message },
      cleanupEvidence: evidence, now: this.now(),
    });
    return res.accepted ? "failed" : "lease-lost";
  }

  /**
   * Asks the runner for cleanup proof and validates it. Anything other than a
   * well-formed confirmed proof for this exact execution id is "not ok".
   */
  private async requestCleanup(req: CleanupRequest): Promise<Cleanup> {
    const call = (async () => this.runner.cleanup(req))();
    let settled: Settled<unknown>;
    try {
      settled = await this.settleWithin<unknown>(call, this.cleanupTimeoutMs, "cleanup-timeout");
    } catch {
      return { ok: false, reason: "runner cleanup raised an error" };
    }
    if (settled.timedOut) return { ok: false, reason: "runner cleanup timed out" };

    const proof = settled.value;
    if (typeof proof !== "object" || proof === null) return { ok: false, reason: "runner returned no cleanup proof" };
    const p = proof as Record<string, unknown>;
    if (p["confirmed"] !== true) {
      const raw = p["reason"];
      const why = typeof raw === "string" && raw.trim() !== "" ? raw : "runner did not confirm cleanup";
      return { ok: false, reason: clip(why) };
    }
    if (p["executionId"] !== req.executionId) {
      return { ok: false, reason: "cleanup proof is for a different execution" };
    }
    const evidence = p["evidence"];
    if (typeof evidence !== "string" || evidence.trim() === "") {
      return { ok: false, reason: "cleanup proof carries no evidence" };
    }
    return { ok: true, evidence: evidence.trim() };
  }

  private async settleWithin<T>(p: Promise<T>, ms: number, label: string): Promise<Settled<T>> {
    let cancel: Cancel = () => undefined;
    const timeout = new Promise<{ timedOut: true }>((resolve) => {
      cancel = this.timers.after(ms, () => resolve({ timedOut: true }), label);
    });
    try {
      return await Promise.race([p.then((value) => ({ timedOut: false as const, value })), timeout]);
    } finally {
      cancel();
    }
  }
}



export interface DrainOptions {
  /** Upper bound on jobs processed in this call. Integer 1..100. */
  maxJobs: number;
}

export interface DrainResult {
  finished: Array<{ jobId: string; outcome: FinishedOutcome }>;
  /**
   *  idle         the queue had no claimable job
   *  limit        maxJobs reached
   *  busy         the worker was already processing a job
   *  stopped      a job ended "blocked" or "lease-lost"; draining stops so an operator can look
   */
  stoppedBecause: "idle" | "limit" | "busy" | "stopped";
}

/**
 * Bounded queue drain: calls worker.runOnce() sequentially, at most `maxJobs` times. It never loops
 * unbounded and never starts a second job while one is active. Stops at the first blocked or
 * lease-lost job (cleanup unproven or ownership lost) instead of pressing on.
 */
export async function drainQueue(worker: JobWorker, opts: DrainOptions): Promise<DrainResult> {
  if (!Number.isInteger(opts.maxJobs) || opts.maxJobs < 1 || opts.maxJobs > 100) {
    throw new Error("maxJobs must be an integer between 1 and 100");
  }
  const finished: DrainResult["finished"] = [];
  for (let i = 0; i < opts.maxJobs; i += 1) {
    const r = await worker.runOnce();
    if (r.kind === "idle") return { finished, stoppedBecause: "idle" };
    if (r.kind === "busy") return { finished, stoppedBecause: "busy" };
    finished.push({ jobId: r.jobId, outcome: r.outcome });
    if (r.outcome === "blocked" || r.outcome === "lease-lost") return { finished, stoppedBecause: "stopped" };
  }
  return { finished, stoppedBecause: "limit" };
}
