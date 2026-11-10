/**
 * leases.ts — durable, atomic worker lease primitives.
 *
 * Library only: nothing here executes repositories or polls. Every state
 * change and its job_event commit in one BEGIN IMMEDIATE transaction.
 *
 * Lifecycle:
 *   queued --claim--> running(lease) --heartbeat--> running(lease)
 *   running(lease expired) --fence--> running(recovery_required, lease voided)
 *   recovery_required --confirmRecoveryCleanup--> queued | failed | timed-out
 *
 * Expired leases are NEVER requeued automatically. The caller of
 * confirmRecoveryCleanup asserts that the old execution was really terminated;
 * this module cannot verify that and records the assertion as-is.
 * Lease and recovery tokens are never written to events.
 *
 * @module leases
 */

import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_DEADLINE_MS = 15 * 60 * 1000;
export const DEFAULT_LEASE_MS = 60 * 1000;

/** Time source override for deterministic tests. */
export interface ClockOption {
  now?: Date;
}

export interface ClaimParams extends ClockOption {
  workerId: string;
  leaseMs?: number;
}

export interface ClaimedJob {
  jobId: string;
  repoUrl: string;
  leaseToken: string;
  leaseExpiresAt: string;
  attemptCount: number;
  maxAttempts: number;
  startedAt: string;
  deadlineAt: string;
}

export interface HeartbeatParams extends ClockOption {
  jobId: string;
  leaseToken: string;
  leaseMs?: number;
}

export type HeartbeatResult =
  | { accepted: true; leaseExpiresAt: string }
  | { accepted: false };

export interface FencedJob {
  jobId: string;
  /** Required by confirmRecoveryCleanup. Hold it in the recovery coordinator only. */
  recoveryToken: string;
}

export interface ConfirmCleanupParams extends ClockOption {
  jobId: string;
  recoveryToken: string;
  /** Non-empty statement of who/what confirmed termination (stored in the event). */
  confirmedBy: string;
}

export type ConfirmCleanupResult =
  | { outcome: "requeued" | "failed" | "timed-out" }
  | { outcome: "rejected" };

/** Infrastructure metadata for terminal failures — not a repository diagnosis. */
export interface InfraError {
  kind: "deadline-exceeded" | "attempts-exhausted";
  message: string;
  attemptCount: number;
  maxAttempts: number;
  deadlineAt: string | null;
  at: string;
}

type Row = Record<string, unknown>;

function newToken(): string {
  return randomBytes(32).toString("hex");
}

function requireWorkerId(workerId: string): void {
  if (typeof workerId !== "string" || workerId.length === 0 || workerId.length > 128) {
    throw new Error("workerId must be a non-empty string of at most 128 characters");
  }
}

function requirePositiveMs(ms: number, name: string): void {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`${name} must be a positive number`);
}

/** Runs fn inside BEGIN IMMEDIATE; commits on success, rolls back on throw. */
function immediate<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback error */ }
    throw err;
  }
}

function insertEvent(
  db: DatabaseSync,
  jobId: string,
  eventType: string,
  payload: Record<string, unknown>,
  at: string,
): void {
  db.prepare(
    "INSERT INTO job_events (job_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)",
  ).run(jobId, eventType, JSON.stringify(payload), at);
}

/**
 * Atomically claims the oldest claimable queued job. Returns null if none.
 * First claim sets started_at and deadline_at (+15 min); later claims never
 * reset them. Jobs already past their deadline are not claimable.
 */
export function claimNextJob(db: DatabaseSync, params: ClaimParams): ClaimedJob | null {
  requireWorkerId(params.workerId);
  const leaseMs = params.leaseMs ?? DEFAULT_LEASE_MS;
  requirePositiveMs(leaseMs, "leaseMs");
  const nowDate = params.now ?? new Date();
  const now = nowDate.toISOString();

  return immediate(db, () => {
    const row = db.prepare(`
      SELECT id, repo_url, stage, attempt_count, max_attempts, started_at, deadline_at
      FROM jobs
      WHERE status = 'queued' AND recovery_required = 0
        AND attempt_count < max_attempts
        AND (deadline_at IS NULL OR deadline_at > ?)
      ORDER BY created_at, id
      LIMIT 1
    `).get(now) as Row | undefined;
    if (row === undefined) return null;

    const jobId = row["id"] as string;
    const startedAt = (row["started_at"] as string | null) ?? now;
    const deadlineAt =
      (row["deadline_at"] as string | null) ?? new Date(nowDate.getTime() + DEFAULT_DEADLINE_MS).toISOString();
    const attemptCount = (row["attempt_count"] as number) + 1;
    const leaseExpiresAt = cappedLease(nowDate, leaseMs, deadlineAt);
    const leaseToken = newToken();

    const res = db.prepare(`
      UPDATE jobs
      SET status = 'running', worker_id = ?, lease_token = ?, lease_expires_at = ?,
          attempt_count = ?, started_at = ?, deadline_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(params.workerId, leaseToken, leaseExpiresAt, attemptCount, startedAt, deadlineAt, now, jobId);
    if (Number(res.changes) !== 1) throw new Error("claimNextJob: lost race for job");

    insertEvent(db, jobId, "claimed", {
      jobId,
      stage: row["stage"],
      status: "running",
      attemptCount,
      maxAttempts: row["max_attempts"],
      deadlineAt,
    }, now);

    return {
      jobId,
      repoUrl: row["repo_url"] as string,
      leaseToken,
      leaseExpiresAt,
      attemptCount,
      maxAttempts: row["max_attempts"] as number,
      startedAt,
      deadlineAt,
    };
  });
}

/** Lease expiry is never allowed to extend past the job deadline. */
function cappedLease(now: Date, leaseMs: number, deadlineAt: string): string {
  const wanted = now.getTime() + leaseMs;
  const cap = Date.parse(deadlineAt);
  return new Date(Math.min(wanted, cap)).toISOString();
}

/**
 * Extends a lease only if the token matches, the lease is unexpired, the job
 * is running and not in recovery, and the deadline has not passed. Anything
 * else (stale, fenced, expired, unknown) is rejected without side effects.
 */
export function heartbeat(db: DatabaseSync, params: HeartbeatParams): HeartbeatResult {
  const leaseMs = params.leaseMs ?? DEFAULT_LEASE_MS;
  requirePositiveMs(leaseMs, "leaseMs");
  const nowDate = params.now ?? new Date();
  const now = nowDate.toISOString();

  return immediate(db, () => {
    const row = db.prepare(`
      SELECT deadline_at FROM jobs
      WHERE id = ? AND status = 'running' AND recovery_required = 0
        AND lease_token = ? AND lease_expires_at > ? AND deadline_at > ?
    `).get(params.jobId, params.leaseToken, now, now) as Row | undefined;
    if (row === undefined) return { accepted: false } as const;

    const leaseExpiresAt = cappedLease(nowDate, leaseMs, row["deadline_at"] as string);
    const res = db.prepare(`
      UPDATE jobs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_token = ? AND status = 'running' AND recovery_required = 0
    `).run(leaseExpiresAt, now, params.jobId, params.leaseToken);
    if (Number(res.changes) !== 1) return { accepted: false } as const;
    return { accepted: true, leaseExpiresAt } as const;
  });
}

/**
 * Fences every running job whose lease has expired: voids the lease token (so
 * the old worker's heartbeats fail), sets recovery_required, and issues a
 * recovery token. The job stays `running` and is NOT requeued.
 */
export function fenceExpiredLeases(db: DatabaseSync, params: ClockOption = {}): FencedJob[] {
  const now = (params.now ?? new Date()).toISOString();

  return immediate(db, () => {
    const rows = db.prepare(`
      SELECT id, stage, attempt_count FROM jobs
      WHERE status = 'running' AND recovery_required = 0
        AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      ORDER BY created_at, id
    `).all(now) as Row[];

    const fenced: FencedJob[] = [];
    for (const row of rows) {
      const jobId = row["id"] as string;
      const recoveryToken = newToken();
      db.prepare(`
        UPDATE jobs SET lease_token = NULL, recovery_required = 1, recovery_token = ?, updated_at = ?
        WHERE id = ?
      `).run(recoveryToken, now, jobId);
      insertEvent(db, jobId, "recovery-required", {
        jobId,
        stage: row["stage"],
        status: "running",
        recoveryRequired: true,
        reason: "lease-expired",
        attemptCount: row["attempt_count"],
      }, now);
      fenced.push({ jobId, recoveryToken });
    }
    return fenced;
  });
}

/**
 * Resolves a fenced job after the caller has confirmed the old execution is
 * terminated. Requires the matching recovery token. Outcomes, in order:
 *   deadline passed     -> timed-out (terminal, infra metadata)
 *   attempts exhausted  -> failed    (terminal, infra metadata)
 *   otherwise           -> queued    (deadline and attempt_count preserved)
 */
export function confirmRecoveryCleanup(
  db: DatabaseSync,
  params: ConfirmCleanupParams,
): ConfirmCleanupResult {
  if (typeof params.confirmedBy !== "string" || params.confirmedBy.trim() === "") {
    throw new Error("confirmedBy must describe who confirmed cleanup");
  }
  const now = (params.now ?? new Date()).toISOString();

  return immediate(db, () => {
    const row = db.prepare(`
      SELECT stage, attempt_count, max_attempts, deadline_at FROM jobs
      WHERE id = ? AND status = 'running' AND recovery_required = 1 AND recovery_token = ?
    `).get(params.jobId, params.recoveryToken) as Row | undefined;
    if (row === undefined) return { outcome: "rejected" } as const;

    const attemptCount = row["attempt_count"] as number;
    const maxAttempts = row["max_attempts"] as number;
    const deadlineAt = row["deadline_at"] as string | null;
    const clear = "lease_token = NULL, lease_expires_at = NULL, recovery_required = 0, recovery_token = NULL";

    let status: "queued" | "failed" | "timed-out";
    let infra: InfraError | null = null;
    if (deadlineAt !== null && deadlineAt <= now) {
      status = "timed-out";
      infra = {
        kind: "deadline-exceeded",
        message: "Execution deadline passed before the job finished (infrastructure, not a repository diagnosis).",
        attemptCount, maxAttempts, deadlineAt, at: now,
      };
    } else if (attemptCount >= maxAttempts) {
      status = "failed";
      infra = {
        kind: "attempts-exhausted",
        message: "Worker attempts exhausted after lease expiry (infrastructure, not a repository diagnosis).",
        attemptCount, maxAttempts, deadlineAt, at: now,
      };
    } else {
      status = "queued";
    }

    db.prepare(
      `UPDATE jobs SET status = ?, infra_error = ?, ${clear}, updated_at = ? WHERE id = ?`,
    ).run(status, infra === null ? null : JSON.stringify(infra), now, params.jobId);

    insertEvent(db, params.jobId, status === "queued" ? "requeued" : status, {
      jobId: params.jobId,
      stage: row["stage"],
      status,
      attemptCount,
      cleanupConfirmedBy: params.confirmedBy.trim(),
      ...(infra === null ? {} : { infrastructure: infra }),
    }, now);

    return { outcome: status === "queued" ? "requeued" : status } as const;
  });
}

/** Internal recovery-coordinator view of a fenced job. Never expose via API or events. */
export interface RecoveryRequiredJob {
  jobId: string;
  recoveryToken: string;
  workerId: string | null;
}

/**
 * Lists persisted fenced jobs so a restarted coordinator can still resolve
 * them. Read-only. Contains recovery tokens: internal use only, never return
 * from an API route or write to job_events.
 */
export function listRecoveryRequired(db: DatabaseSync): RecoveryRequiredJob[] {
  const rows = db.prepare(`
    SELECT id, recovery_token, worker_id FROM jobs
    WHERE status = 'running' AND recovery_required = 1 AND recovery_token IS NOT NULL
    ORDER BY created_at, id
  `).all() as Row[];
  return rows.map((r) => ({
    jobId: r["id"] as string,
    recoveryToken: r["recovery_token"] as string,
    workerId: (r["worker_id"] as string | null) ?? null,
  }));
}

/**
 * Atomically times out `queued` jobs whose preserved deadline has passed
 * (e.g. requeued after recovery, then never claimable). Running and fenced
 * jobs are untouched. Returns the ids that were timed out.
 */
export function expireQueuedDeadlines(db: DatabaseSync, params: ClockOption = {}): string[] {
  const now = (params.now ?? new Date()).toISOString();

  return immediate(db, () => {
    const rows = db.prepare(`
      SELECT id, stage, attempt_count, max_attempts, deadline_at FROM jobs
      WHERE status = 'queued' AND recovery_required = 0
        AND deadline_at IS NOT NULL AND deadline_at <= ?
      ORDER BY created_at, id
    `).all(now) as Row[];

    const expired: string[] = [];
    for (const row of rows) {
      const jobId = row["id"] as string;
      const attemptCount = row["attempt_count"] as number;
      const maxAttempts = row["max_attempts"] as number;
      const deadlineAt = row["deadline_at"] as string;
      const infra: InfraError = {
        kind: "deadline-exceeded",
        message: "Execution deadline passed while the job was queued (infrastructure, not a repository diagnosis).",
        attemptCount, maxAttempts, deadlineAt, at: now,
      };
      const res = db.prepare(`
        UPDATE jobs SET status = 'timed-out', infra_error = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(JSON.stringify(infra), now, jobId);
      if (Number(res.changes) !== 1) continue;
      insertEvent(db, jobId, "timed-out", {
        jobId,
        stage: row["stage"],
        status: "timed-out",
        attemptCount,
        infrastructure: infra,
      }, now);
      expired.push(jobId);
    }
    return expired;
  });
}
