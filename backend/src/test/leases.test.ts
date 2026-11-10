/**
 * leases.test.ts — worker lease primitives, schema v2 migration.
 * Exclusivity tests use two separate connections to one file database.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import { createJob, cancelJob, findJobById } from "../jobs.js";
import { generateRawToken } from "../token.js";
import {
  claimNextJob,
  heartbeat,
  fenceExpiredLeases,
  confirmRecoveryCleanup,
  listRecoveryRequired,
  expireQueuedDeadlines,
  DEFAULT_DEADLINE_MS,
} from "../leases.js";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const MIN = 60_000;

let dir: string;
let a: DatabaseSync;
let b: DatabaseSync;

function newJob(db: DatabaseSync): string {
  return createJob(db, { repoUrl: "https://github.com/o/r", rawToken: generateRawToken() }).jobId;
}

function row(db: DatabaseSync, id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown>;
}

function eventTypes(db: DatabaseSync, id: string): string[] {
  const rows = db.prepare("SELECT event_type FROM job_events WHERE job_id = ? ORDER BY seq").all(id) as Array<{ event_type: string }>;
  return rows.map((r) => r.event_type);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "graveyard-lease-"));
  const path = join(dir, "t.sqlite");
  a = openDatabase(path);
  b = openDatabase(path);
});

afterEach(() => {
  try { a.close(); } catch { /* ignore */ }
  try { b.close(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("schema v2 migration", () => {
  it("adds lease columns with safe defaults and preserves v1 jobs/events", () => {
    const path = join(dir, "v1.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE jobs (id TEXT NOT NULL PRIMARY KEY, repo_url TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'queued', status TEXT NOT NULL DEFAULT 'queued',
        token_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE job_events (seq INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id), event_type TEXT NOT NULL,
        payload TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      INSERT INTO jobs VALUES ('j1','https://github.com/o/r','queued','queued','h','t','t');
      INSERT INTO job_events (job_id, event_type, payload, created_at) VALUES ('j1','created','{}','t');
      PRAGMA user_version = 1;
    `);
    raw.close();

    const db = openDatabase(path);
    try {
      assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
      const j = row(db, "j1");
      assert.equal(j["status"], "queued");
      assert.equal(j["attempt_count"], 0);
      assert.equal(j["max_attempts"], 2);
      assert.equal(j["recovery_required"], 0);
      for (const c of ["worker_id", "lease_token", "lease_expires_at", "started_at", "deadline_at"]) {
        assert.equal(j[c], null, c);
      }
      assert.deepEqual(eventTypes(db, "j1"), ["created"]);
    } finally {
      db.close();
    }
  });

  it("re-opening a v2 database is a no-op", () => {
    const id = newJob(a);
    a.close();
    const again = openDatabase(join(dir, "t.sqlite"));
    try {
      assert.equal(findJobById(again, id)?.status, "queued");
    } finally {
      again.close();
    }
  });
});

describe("claimNextJob", () => {
  it("claims once with a running status, deadline and same-transaction event", () => {
    const id = newJob(a);
    const c = claimNextJob(a, { workerId: "w1", now: T0 });
    assert.ok(c);
    assert.equal(c.jobId, id);
    assert.equal(c.attemptCount, 1);
    assert.equal(c.deadlineAt, at(DEFAULT_DEADLINE_MS).toISOString());
    assert.match(c.leaseToken, /^[0-9a-f]{64}$/);
    const j = row(a, id);
    assert.equal(j["status"], "running");
    assert.equal(j["worker_id"], "w1");
    assert.equal(j["started_at"], T0.toISOString());
    assert.deepEqual(eventTypes(a, id), ["created", "claimed"]);
  });

  it("two connections cannot claim the same job", () => {
    newJob(a);
    const first = claimNextJob(a, { workerId: "w1", now: T0 });
    const second = claimNextJob(b, { workerId: "w2", now: T0 });
    assert.ok(first);
    assert.equal(second, null);
  });

  it("two jobs, two connections get distinct jobs and distinct tokens", () => {
    newJob(a);
    newJob(a);
    const x = claimNextJob(a, { workerId: "w1", now: T0 });
    const y = claimNextJob(b, { workerId: "w2", now: T0 });
    assert.ok(x && y);
    assert.notEqual(x.jobId, y.jobId);
    assert.notEqual(x.leaseToken, y.leaseToken);
  });

  it("never exposes lease tokens in events", () => {
    const id = newJob(a);
    const c = claimNextJob(a, { workerId: "w1", now: T0 });
    assert.ok(c);
    const payloads = (a.prepare("SELECT payload FROM job_events WHERE job_id = ?").all(id) as Array<{ payload: string }>)
      .map((r) => r.payload).join("");
    assert.ok(!payloads.includes(c.leaseToken));
  });

  it("rolls back the claim when the event insert fails", () => {
    const id = newJob(a);
    a.exec(`CREATE TRIGGER fail_claim BEFORE INSERT ON job_events
            WHEN NEW.event_type = 'claimed' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    assert.throws(() => claimNextJob(a, { workerId: "w1", now: T0 }), /boom/);
    const j = row(a, id);
    assert.equal(j["status"], "queued");
    assert.equal(j["attempt_count"], 0);
    assert.equal(j["lease_token"], null);
    assert.equal(j["deadline_at"], null);
    assert.deepEqual(eventTypes(a, id), ["created"]);
    // Connection is usable afterwards (transaction was closed).
    a.exec("DROP TRIGGER fail_claim");
    assert.ok(claimNextJob(a, { workerId: "w1", now: T0 }));
  });

  it("does not claim cancelled jobs; cancelled queued jobs stay cancelled", () => {
    const id = newJob(a);
    assert.equal(cancelJob(a, id).outcome, "cancelled");
    assert.equal(claimNextJob(b, { workerId: "w1", now: T0 }), null);
  });

  it("running jobs cannot be cancelled (conflict)", () => {
    const id = newJob(a);
    claimNextJob(a, { workerId: "w1", now: T0 });
    assert.equal(cancelJob(b, id).outcome, "conflict");
  });
});

describe("heartbeat", () => {
  it("extends only with the matching unexpired token", () => {
    const id = newJob(a);
    const c = claimNextJob(a, { workerId: "w1", leaseMs: MIN, now: T0 });
    assert.ok(c);
    assert.deepEqual(heartbeat(b, { jobId: id, leaseToken: "0".repeat(64), now: at(10_000) }), { accepted: false });
    const ok = heartbeat(b, { jobId: id, leaseToken: c.leaseToken, leaseMs: MIN, now: at(30_000) });
    assert.deepEqual(ok, { accepted: true, leaseExpiresAt: at(30_000 + MIN).toISOString() });
  });

  it("rejects an expired lease even if never fenced", () => {
    const id = newJob(a);
    const c = claimNextJob(a, { workerId: "w1", leaseMs: MIN, now: T0 });
    assert.ok(c);
    assert.equal(heartbeat(a, { jobId: id, leaseToken: c.leaseToken, now: at(MIN) }).accepted, false);
  });

  it("never extends the lease beyond the deadline", () => {
    const id = newJob(a);
    // Initial lease spans the whole deadline window so it is still live
    // when the late heartbeat arrives (expired leases stay rejected).
    const c = claimNextJob(a, { workerId: "w1", leaseMs: DEFAULT_DEADLINE_MS, now: T0 });
    assert.ok(c);
    const now = at(DEFAULT_DEADLINE_MS - 10_000);
    const r = heartbeat(a, { jobId: id, leaseToken: c.leaseToken, leaseMs: MIN, now });
    assert.deepEqual(r, { accepted: true, leaseExpiresAt: c.deadlineAt });
    assert.equal(heartbeat(a, { jobId: id, leaseToken: c.leaseToken, now: at(DEFAULT_DEADLINE_MS) }).accepted, false);
  });
});

describe("fencing and recovery", () => {
  function expire(): { id: string; stale: string; recoveryToken: string } {
    const id = newJob(a);
    const c = claimNextJob(a, { workerId: "w1", leaseMs: MIN, now: T0 });
    assert.ok(c);
    const fenced = fenceExpiredLeases(b, { now: at(2 * MIN) });
    assert.equal(fenced.length, 1);
    return { id, stale: c.leaseToken, recoveryToken: fenced[0]!.recoveryToken };
  }

  it("does not fence unexpired leases", () => {
    newJob(a);
    claimNextJob(a, { workerId: "w1", leaseMs: MIN, now: T0 });
    assert.deepEqual(fenceExpiredLeases(b, { now: at(MIN - 1) }), []);
  });

  it("fences expired leases, rejects stale heartbeats, and does not requeue", () => {
    const { id, stale } = expire();
    const j = row(a, id);
    assert.equal(j["status"], "running");
    assert.equal(j["recovery_required"], 1);
    assert.equal(j["lease_token"], null);
    assert.equal(heartbeat(a, { jobId: id, leaseToken: stale, now: at(2 * MIN) }).accepted, false);
    assert.equal(claimNextJob(b, { workerId: "w2", now: at(3 * MIN) }), null);
    assert.deepEqual(fenceExpiredLeases(a, { now: at(4 * MIN) }), []);
    assert.deepEqual(eventTypes(a, id), ["created", "claimed", "recovery-required"]);
  });

  it("rejects cleanup with a wrong or stale-lease token and a blank confirmation", () => {
    const { id, stale } = expire();
    assert.deepEqual(
      confirmRecoveryCleanup(a, { jobId: id, recoveryToken: stale, confirmedBy: "ops", now: at(3 * MIN) }),
      { outcome: "rejected" },
    );
    assert.throws(() => confirmRecoveryCleanup(a, { jobId: id, recoveryToken: stale, confirmedBy: " " }));
    assert.equal(row(a, id)["recovery_required"], 1);
  });

  it("requeues after confirmed cleanup preserving deadline and attempts; recovery token is single-use", () => {
    const { id, recoveryToken } = expire();
    const before = row(a, id);
    const r = confirmRecoveryCleanup(b, { jobId: id, recoveryToken, confirmedBy: "ops", now: at(3 * MIN) });
    assert.deepEqual(r, { outcome: "requeued" });
    const j = row(a, id);
    assert.equal(j["status"], "queued");
    assert.equal(j["deadline_at"], before["deadline_at"]);
    assert.equal(j["started_at"], before["started_at"]);
    assert.equal(j["attempt_count"], 1);
    assert.equal(j["recovery_required"], 0);
    assert.equal(j["infra_error"], null);
    assert.deepEqual(
      confirmRecoveryCleanup(a, { jobId: id, recoveryToken, confirmedBy: "ops", now: at(3 * MIN) }),
      { outcome: "rejected" },
    );

    const second = claimNextJob(a, { workerId: "w2", leaseMs: MIN, now: at(4 * MIN) });
    assert.ok(second);
    assert.equal(second.attemptCount, 2);
    assert.equal(second.deadlineAt, before["deadline_at"]);
    assert.equal(second.startedAt, before["started_at"]);
  });

  it("queued-after-recovery jobs remain cancellable", () => {
    const { id, recoveryToken } = expire();
    confirmRecoveryCleanup(a, { jobId: id, recoveryToken, confirmedBy: "ops", now: at(3 * MIN) });
    assert.equal(cancelJob(b, id).outcome, "cancelled");
  });

  it("exhausted attempts end failed with infrastructure metadata", () => {
    const { id, recoveryToken } = expire();
    confirmRecoveryCleanup(a, { jobId: id, recoveryToken, confirmedBy: "ops", now: at(3 * MIN) });
    claimNextJob(a, { workerId: "w2", leaseMs: MIN, now: at(4 * MIN) });
    const [f] = fenceExpiredLeases(b, { now: at(6 * MIN) });
    assert.ok(f);
    const r = confirmRecoveryCleanup(a, { jobId: id, recoveryToken: f.recoveryToken, confirmedBy: "ops", now: at(7 * MIN) });
    assert.deepEqual(r, { outcome: "failed" });
    const j = row(a, id);
    assert.equal(j["status"], "failed");
    const infra = JSON.parse(j["infra_error"] as string) as { kind: string; attemptCount: number };
    assert.equal(infra.kind, "attempts-exhausted");
    assert.equal(infra.attemptCount, 2);
    assert.equal(claimNextJob(a, { workerId: "w3", now: at(8 * MIN) }), null);
    assert.equal(eventTypes(a, id).at(-1), "failed");
    assert.equal(cancelJob(a, id).outcome, "conflict");
  });

  it("deadline passed at cleanup ends timed-out with infrastructure metadata, no rootCause", () => {
    const { id, recoveryToken } = expire();
    const r = confirmRecoveryCleanup(a, {
      jobId: id, recoveryToken, confirmedBy: "ops", now: at(DEFAULT_DEADLINE_MS + 1),
    });
    assert.deepEqual(r, { outcome: "timed-out" });
    const j = row(a, id);
    assert.equal(j["status"], "timed-out");
    assert.equal((JSON.parse(j["infra_error"] as string) as { kind: string }).kind, "deadline-exceeded");
    const last = a.prepare("SELECT payload FROM job_events WHERE job_id = ? ORDER BY seq DESC LIMIT 1").get(id) as { payload: string };
    assert.ok(!last.payload.includes("rootCause"));
    assert.ok(last.payload.includes("infrastructure"));
  });

  it("past-deadline queued jobs are not claimable", () => {
    const { id, recoveryToken } = expire();
    // Simulate a requeue that predates the deadline check, then try to claim late.
    confirmRecoveryCleanup(a, { jobId: id, recoveryToken, confirmedBy: "ops", now: at(3 * MIN) });
    assert.equal(claimNextJob(b, { workerId: "w2", now: at(DEFAULT_DEADLINE_MS + 1) }), null);
  });

  it("rolls back cleanup when its event insert fails", () => {
    const { id, recoveryToken } = expire();
    a.exec(`CREATE TRIGGER fail_requeue BEFORE INSERT ON job_events
            WHEN NEW.event_type = 'requeued' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    assert.throws(() => confirmRecoveryCleanup(a, { jobId: id, recoveryToken, confirmedBy: "ops", now: at(3 * MIN) }), /boom/);
    const j = row(a, id);
    assert.equal(j["status"], "running");
    assert.equal(j["recovery_required"], 1);
    assert.equal(j["recovery_token"], recoveryToken);
  });
});


describe("listRecoveryRequired", () => {
  it("returns persisted fenced jobs with tokens and worker ids across a new connection", () => {
    const id = newJob(a);
    claimNextJob(a, { workerId: "w1", leaseMs: MIN, now: T0 });
    assert.deepEqual(listRecoveryRequired(a), []);
    const [f] = fenceExpiredLeases(a, { now: at(2 * MIN) });
    assert.ok(f);
    a.close();

    // Simulates a coordinator restart: fresh connection, no in-memory state.
    const fresh = openDatabase(join(dir, "t.sqlite"));
    try {
      assert.deepEqual(listRecoveryRequired(fresh), [
        { jobId: id, recoveryToken: f.recoveryToken, workerId: "w1" },
      ]);
      const r = confirmRecoveryCleanup(fresh, {
        jobId: id, recoveryToken: f.recoveryToken, confirmedBy: "ops", now: at(3 * MIN),
      });
      assert.deepEqual(r, { outcome: "requeued" });
      assert.deepEqual(listRecoveryRequired(fresh), []);
      const events = fresh.prepare("SELECT payload FROM job_events WHERE job_id = ?").all(id) as Array<{ payload: string }>;
      for (const e of events) assert.ok(!e.payload.includes(f.recoveryToken));
    } finally {
      fresh.close();
    }
  });
});

describe("expireQueuedDeadlines", () => {
  it("times out recovered queued jobs past their preserved deadline with an event", () => {
    const id = newJob(a);
    claimNextJob(a, { workerId: "w1", leaseMs: MIN, now: T0 });
    const [f] = fenceExpiredLeases(a, { now: at(2 * MIN) });
    assert.ok(f);
    confirmRecoveryCleanup(a, { jobId: id, recoveryToken: f.recoveryToken, confirmedBy: "ops", now: at(3 * MIN) });
    assert.equal(row(a, id)["status"], "queued");

    assert.deepEqual(expireQueuedDeadlines(b, { now: at(DEFAULT_DEADLINE_MS - 1) }), []);
    assert.equal(row(a, id)["status"], "queued");

    assert.deepEqual(expireQueuedDeadlines(b, { now: at(DEFAULT_DEADLINE_MS + 1) }), [id]);
    const j = row(a, id);
    assert.equal(j["status"], "timed-out");
    assert.equal((JSON.parse(j["infra_error"] as string) as { kind: string }).kind, "deadline-exceeded");
    assert.equal(eventTypes(a, id).at(-1), "timed-out");
    assert.deepEqual(expireQueuedDeadlines(a, { now: at(DEFAULT_DEADLINE_MS + 2) }), []);
  });

  it("does not change running, fenced, or deadline-less queued jobs", () => {
    const running = newJob(a);
    claimNextJob(a, { workerId: "w1", leaseMs: 60 * MIN, now: T0 });
    const fencedId = newJob(a);
    claimNextJob(a, { workerId: "w2", leaseMs: MIN, now: at(MIN) });
    fenceExpiredLeases(a, { now: at(3 * MIN) });
    const fresh = newJob(a); // never claimed: deadline_at is NULL
    const late = at(DEFAULT_DEADLINE_MS + 1);
    assert.deepEqual(expireQueuedDeadlines(a, { now: late }), []);
    assert.equal(row(a, running)["status"], "running");
    assert.equal(row(a, fresh)["status"], "queued");
    assert.equal(row(a, fencedId)["status"], "running");
    assert.equal(row(a, fencedId)["recovery_required"], 1);
  });
});
