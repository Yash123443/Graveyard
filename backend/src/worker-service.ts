/**
 * worker-service.ts — bounded polling loop around JobWorker.
 *
 * The loop never runs more than one job at a time (JobWorker guarantees that), never drains more
 * than `batch` jobs between polls, always sleeps `pollMs` when the queue is idle, and backs off
 * exponentially (capped) after errors instead of spinning. Recovery (expired leases, queued
 * deadlines, cleanup-proof confirmation) runs at start and then every `recoverMs`.
 *
 * Availability gate. Before claiming work the loop asks an injected `preflight` whether the
 * isolation runtime answers. While it does not, nothing is claimed: queued jobs stay queued
 * instead of being consumed and failed by a transient outage. (A runtime that disappears DURING a
 * run still fails that job closed with infrastructure-unavailable, by the runner.)
 *
 * Shutdown. `stop()` is idempotent. It wakes the sleeping loop, asks JobWorker.shutdown() to abort
 * the active job and settle it (requeued only with cleanup proof, otherwise fenced and blocked),
 * and resolves once the loop has ended. Timers, the clock and the logger are injected so the
 * behaviour is testable without real waiting.
 *
 * @module worker-service
 */

import { drainQueue, type RecoveryResult, type WorkerRunResult } from "./worker.js";

export type ServiceLogLevel = "info" | "warn" | "error";
export type ServiceLog = (level: ServiceLogLevel, message: string, fields?: Record<string, unknown>) => void;

/** What the service needs from JobWorker. JobWorker satisfies it. */
export interface ServiceWorker {
  runOnce(): Promise<WorkerRunResult>;
  recoverOnce(): Promise<RecoveryResult[]>;
  shutdown(): Promise<void>;
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Real sleep. Resolves early when the signal aborts. Not unref'd: it keeps the process alive. */
export const systemSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });

export interface WorkerServiceOptions {
  worker: ServiceWorker;
  /** Idle sleep between polls. */
  pollMs: number;
  /** Minimum time between recovery passes. */
  recoverMs: number;
  /** Jobs processed per drain, 1..100. */
  batch: number;
  /** Resolves true when the isolation runtime answers. Default: always true. Must not throw (a throw counts as false). */
  preflight?: () => Promise<boolean>;
  /** Upper bound of the error backoff. Default 60 000 ms. */
  maxBackoffMs?: number;
  now?: () => number;
  sleep?: Sleep;
  log?: ServiceLog;
}

export type ServiceState = "created" | "running" | "stopping" | "stopped";

export interface ServiceSnapshot {
  state: ServiceState;
  /** null until the first preflight. */
  runtimeAvailable: boolean | null;
  jobsFinished: number;
  consecutiveFailures: number;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : "unknown error");

export class WorkerService {
  private readonly o: Required<Omit<WorkerServiceOptions, "preflight">> & { preflight: () => Promise<boolean> };
  private readonly abort = new AbortController();
  private state: ServiceState = "created";
  private loopDone: Promise<void> | null = null;
  private stopDone: Promise<void> | null = null;
  private runtimeAvailable: boolean | null = null;
  private jobsFinished = 0;
  private failures = 0;

  constructor(opts: WorkerServiceOptions) {
    const bad = (name: string): never => {
      throw new Error(`${name} is invalid`);
    };
    if (typeof opts.worker?.runOnce !== "function" || typeof opts.worker.recoverOnce !== "function" || typeof opts.worker.shutdown !== "function") {
      bad("worker");
    }
    if (!Number.isInteger(opts.pollMs) || opts.pollMs < 1) bad("pollMs");
    if (!Number.isInteger(opts.recoverMs) || opts.recoverMs < 1) bad("recoverMs");
    if (!Number.isInteger(opts.batch) || opts.batch < 1 || opts.batch > 100) bad("batch");
    const maxBackoffMs = opts.maxBackoffMs ?? 60_000;
    if (!Number.isInteger(maxBackoffMs) || maxBackoffMs < opts.pollMs) bad("maxBackoffMs");
    this.o = {
      worker: opts.worker,
      pollMs: opts.pollMs,
      recoverMs: opts.recoverMs,
      batch: opts.batch,
      maxBackoffMs,
      preflight: opts.preflight ?? ((): Promise<boolean> => Promise.resolve(true)),
      now: opts.now ?? ((): number => Date.now()),
      sleep: opts.sleep ?? systemSleep,
      log: opts.log ?? ((): void => undefined),
    };
  }

  snapshot(): ServiceSnapshot {
    return {
      state: this.state,
      runtimeAvailable: this.runtimeAvailable,
      jobsFinished: this.jobsFinished,
      consecutiveFailures: this.failures,
    };
  }

  /** Starts the loop. Resolves when the loop has ended (after stop()). Never rejects. Idempotent. */
  start(): Promise<void> {
    if (this.loopDone !== null) return this.loopDone;
    if (this.state === "stopping" || this.state === "stopped") {
      this.loopDone = Promise.resolve();
      return this.loopDone;
    }
    this.state = "running";
    this.loopDone = this.loop().finally(() => {
      this.state = "stopped";
    });
    return this.loopDone;
  }

  /** Idempotent graceful stop. Resolves after the active job (if any) has been settled and the loop has ended. */
  stop(): Promise<void> {
    if (this.stopDone !== null) return this.stopDone;
    this.state = this.state === "created" ? "stopped" : "stopping";
    this.abort.abort();
    this.stopDone = (async () => {
      try {
        await this.o.worker.shutdown();
      } catch (e) {
        this.o.log("error", "worker shutdown raised an error", { error: msg(e) });
      }
      if (this.loopDone !== null) await this.loopDone;
      this.state = "stopped";
    })();
    return this.stopDone;
  }

  private get stopping(): boolean {
    return this.abort.signal.aborted;
  }

  private async loop(): Promise<void> {
    let lastRecover: number | null = null;
    this.o.log("info", "worker loop started", { pollMs: this.o.pollMs, recoverMs: this.o.recoverMs, batch: this.o.batch });
    while (!this.stopping) {
      let failed = false;
      let more = false;

      const t = this.o.now();
      if (lastRecover === null || t - lastRecover >= this.o.recoverMs) {
        lastRecover = t;
        try {
          const rec = await this.o.worker.recoverOnce();
          for (const r of rec) {
            this.o.log(r.outcome === "blocked" || r.outcome === "rejected" ? "warn" : "info", "recovery result", {
              jobId: r.jobId,
              outcome: r.outcome,
            });
          }
        } catch (e) {
          failed = true;
          this.o.log("error", "recovery pass failed", { error: msg(e) });
        }
      }

      if (!this.stopping) {
        try {
          more = await this.drain();
        } catch (e) {
          failed = true;
          this.o.log("error", "queue drain failed", { error: msg(e) });
        }
      }

      if (this.stopping) break;
      this.failures = failed ? this.failures + 1 : 0;
      if (more && !failed) continue; // a full batch ran: more work may be waiting, poll again at once

      const delay = failed
        ? Math.min(this.o.maxBackoffMs, this.o.pollMs * 2 ** Math.min(this.failures, 16))
        : this.o.pollMs;
      await this.o.sleep(delay, this.abort.signal);
    }
    this.o.log("info", "worker loop ended", { jobsFinished: this.jobsFinished });
  }

  /** Returns true when a full batch was processed. */
  private async drain(): Promise<boolean> {
    let up = false;
    try {
      up = await this.o.preflight();
    } catch {
      up = false;
    }
    if (up !== this.runtimeAvailable) {
      this.o.log(up ? "info" : "warn", up ? "isolation runtime is available" : "isolation runtime is unavailable; claiming no jobs");
      this.runtimeAvailable = up;
    }
    if (!up || this.stopping) return false;

    const r = await drainQueue(this.o.worker, { maxJobs: this.o.batch });
    for (const f of r.finished) {
      this.jobsFinished += 1;
      const bad = f.outcome === "blocked" || f.outcome === "lease-lost";
      this.o.log(bad ? "warn" : "info", "job finished", { jobId: f.jobId, outcome: f.outcome });
    }
    if (r.stoppedBecause === "stopped") {
      this.o.log("warn", "draining stopped at a blocked or lease-lost job; an operator should inspect it");
    }
    return r.stoppedBecause === "limit";
  }
}
