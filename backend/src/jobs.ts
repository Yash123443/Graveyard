/**
 * jobs.ts — Jobs repository for GRAVEYARD backend.
 *
 * All SQL interactions with the `jobs` and `job_events` tables go through
 * this module.  Uses prepared statements throughout; no string interpolation
 * of user-supplied values.
 *
 * createJob and its initial event are committed in a single transaction so
 * the database is never left in a state where a job exists without a "created"
 * event, or an event exists without its parent job.
 *
 * @module jobs
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { hashToken } from "./token.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The only job stage this milestone creates. */
export type JobStage = "queued";

/** Matches the full set defined in requirements.md; only "queued" is used now. */
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed-out";

/** Row shape returned by findJobById — excludes the token_hash column. */
export interface JobRow {
  id: string;
  repo_url: string;
  stage: JobStage;
  status: JobStatus;
  created_at: string;
  updated_at: string;
}

/** Arguments to createJob. */
export interface CreateJobParams {
  repoUrl: string;
  /** The raw capability token; only its SHA-256 hash will be stored. */
  rawToken: string;
}

/** What createJob returns to the caller. */
export interface CreateJobResult {
  jobId: string;
  /** The raw token (hex), returned to the caller once for inclusion in the response. */
  rawToken: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Inserts a new job row and a corresponding "created" event in a single
 * transaction.  Only the SHA-256 hash of `rawToken` is stored.
 *
 * @param db    Open DatabaseSync instance.
 * @param params  `{ repoUrl, rawToken }`
 * @returns       `{ jobId, rawToken }` — rawToken is the same value passed in;
 *                the caller includes it in the HTTP response body once.
 */
export function createJob(db: DatabaseSync, params: CreateJobParams): CreateJobResult {
  const { repoUrl, rawToken } = params;
  const jobId = randomUUID();
  const tokenHash = hashToken(rawToken);
  const now = new Date().toISOString();

  // Use an explicit transaction so job + initial event are always atomic.
  const insertJob = db.prepare(`
    INSERT INTO jobs (id, repo_url, stage, status, token_hash, created_at, updated_at)
    VALUES (?, ?, 'queued', 'queued', ?, ?, ?)
  `);

  const insertEvent = db.prepare(`
    INSERT INTO job_events (job_id, event_type, payload, created_at)
    VALUES (?, 'created', ?, ?)
  `);

  const payload = JSON.stringify({
    jobId,
    repoUrl,
    stage: "queued",
    status: "queued",
  });

  const txn = db.prepare("BEGIN");
  const commit = db.prepare("COMMIT");
  const rollback = db.prepare("ROLLBACK");

  try {
    txn.run();
    insertJob.run(jobId, repoUrl, tokenHash, now, now);
    insertEvent.run(jobId, payload, now);
    commit.run();
  } catch (err) {
    try {
      rollback.run();
    } catch {
      // Rollback failure is non-recoverable; re-throw the original error.
    }
    throw err;
  }

  return { jobId, rawToken };
}

/**
 * Looks up a job by ID.  Returns the row (without token_hash) or `null` if
 * no matching job is found.
 *
 * NOTE: The token_hash column is deliberately excluded from the SELECT to
 * ensure it cannot accidentally appear in HTTP response serialisation.
 *
 * @param db    Open DatabaseSync instance.
 * @param jobId The UUID job identifier.
 */
export function findJobById(db: DatabaseSync, jobId: string): JobRow | null {
  const stmt = db.prepare(`
    SELECT id, repo_url, stage, status, created_at, updated_at
    FROM jobs
    WHERE id = ?
  `);

  const row = stmt.get(jobId) as JobRow | undefined;
  return row ?? null;
}

/**
 * Looks up the token_hash for a job.  Used internally by the auth middleware
 * to validate the capability token.  Returns `null` if the job does not exist.
 *
 * This function is kept separate from `findJobById` so that token material
 * is never bundled into the general-purpose row shape.
 *
 * @param db    Open DatabaseSync instance.
 * @param jobId The UUID job identifier.
 */
export function getTokenHash(db: DatabaseSync, jobId: string): string | null {
  const stmt = db.prepare(`
    SELECT token_hash FROM jobs WHERE id = ?
  `);

  const row = stmt.get(jobId) as { token_hash: string } | undefined;
  return row?.token_hash ?? null;
}

// ---------------------------------------------------------------------------
// Cancel result types
// ---------------------------------------------------------------------------

/**
 * Outcomes from cancelJob:
 *   - `cancelled`  — job was queued; now cancelled and event inserted.
 *   - `conflict`   — job is not in a cancellable state (already terminal or running).
 */
export type CancelOutcome = "cancelled" | "conflict";

export interface CancelJobResult {
  outcome: CancelOutcome;
  /** The updated job row, present for both outcomes. */
  job: JobRow;
}

// ---------------------------------------------------------------------------
// cancelJob
// ---------------------------------------------------------------------------

/**
 * Attempts to cancel a job that is currently in `status = 'queued'`.
 *
 * Both the UPDATE and the event INSERT are committed atomically; if the event
 * INSERT fails the UPDATE is rolled back.
 *
 * Returns `{ outcome: "cancelled", job }` when the transition succeeds.
 * Returns `{ outcome: "conflict", job }` when the job already has a terminal
 * or non-queued status (including `running`, `cancelled`, `completed`, `failed`,
 * `timed-out`).
 *
 * The caller is responsible for verifying that the job exists and the token
 * matches before calling this function.
 *
 * @param db    Open DatabaseSync instance.
 * @param jobId The UUID job identifier (already auth-verified by the caller).
 */
export function cancelJob(db: DatabaseSync, jobId: string): CancelJobResult {
  const now = new Date().toISOString();

  const updateStatus = db.prepare(`
    UPDATE jobs
    SET status = 'cancelled', updated_at = ?
    WHERE id = ? AND status = 'queued'
  `);

  const insertEvent = db.prepare(`
    INSERT INTO job_events (job_id, event_type, payload, created_at)
    VALUES (?, 'cancelled', ?, ?)
  `);

  const txn = db.prepare("BEGIN");
  const commit = db.prepare("COMMIT");
  const rollback = db.prepare("ROLLBACK");

  try {
    txn.run();

    const result = updateStatus.run(now, jobId);
    const changed = (result as { changes: number }).changes;

    if (changed === 0) {
      // Job exists but status is not 'queued' — or (unreachably) missing.
      // Roll back the no-op transaction and return conflict with current state.
      rollback.run();
      const row = findJobById(db, jobId);
      if (row === null) {
        throw new Error(`cancelJob: job ${jobId} not found after conflict`);
      }
      return { outcome: "conflict", job: row };
    }

    // Build the canonical payload from post-update state.
    const updatedRow = findJobById(db, jobId);
    if (updatedRow === null) {
      throw new Error(`cancelJob: job ${jobId} not found after update`);
    }
    const payload = JSON.stringify({
      jobId,
      repoUrl: updatedRow.repo_url,
      stage: updatedRow.stage,
      status: "cancelled",
    });

    insertEvent.run(jobId, payload, now);

    commit.run();

    return { outcome: "cancelled", job: updatedRow };
  } catch (err) {
    try {
      rollback.run();
    } catch {
      // Rollback failure is non-recoverable; re-throw the original error.
    }
    throw err;
  }
}


// ---------------------------------------------------------------------------
// Event reads (SSE replay / polling)
// ---------------------------------------------------------------------------

/** Statuses after which a job never produces further events. */
export const TERMINAL_STATUSES: readonly JobStatus[] = ["completed", "failed", "cancelled", "timed-out"];

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** A persisted event row. `payload` is the stored JSON string, unmodified. */
export interface JobEventRow {
  seq: number;
  event_type: string;
  payload: string;
}

/** Highest event seq for the job, or 0 when it has none. */
export function getLatestEventSeq(db: DatabaseSync, jobId: string): number {
  const row = db.prepare("SELECT MAX(seq) AS m FROM job_events WHERE job_id = ?").get(jobId) as
    | { m: number | null }
    | undefined;
  return Number(row?.m ?? 0);
}

/** Events with seq strictly greater than `afterSeq`, ascending, at most `limit`. */
export function listEventsAfter(
  db: DatabaseSync,
  jobId: string,
  afterSeq: number,
  limit: number,
): JobEventRow[] {
  const rows = db
    .prepare(
      "SELECT seq, event_type, payload FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    )
    .all(jobId, afterSeq, limit) as unknown as JobEventRow[];
  return rows.map((r) => ({ seq: Number(r.seq), event_type: r.event_type, payload: r.payload }));
}
