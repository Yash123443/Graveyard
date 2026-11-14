/**
 * worker.test.ts — execution worker foundation.
 *
 * Uses a controlled fake runner, a manual clock and manual timers. No
 * repository code is executed, no process is spawned, no network is used.
 * Exclusivity tests use two connections to one file database.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import { createJob } from "../jobs.js";
import { generateRawToken } from "../token.js";
import { claimNextJob, finishLeasedJob, fenceOwnLease } from "../leases.js";
import { JobWorker, type Cancel, type WorkerTimers } from "../worker.js";
import {
  UnavailableRunner,
  SANDBOX_UNAVAILABLE_REASON,
  type CleanupProof,
  type CleanupRequest,
  type JobRunner,
  type RunContext,
  type RunOutcome,
} from "../runner.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;

let dir: string;
let a: DatabaseSync;
let b: DatabaseSync;
let nowMs: number;
const clock = (): Date => new Date(nowMs);

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class ManualTimers implements WorkerTimers {
  readonly entries: Array<{ label: string; ms: number; fn: () => void; cancelled: boolean }> = [];
  every(ms: number, fn: () => void, label: string): Cancel {
    return this.add(ms, fn, label);
  }
  after(ms: number, fn: () => void, label: string): Cancel {
    return this.add(ms, fn, label);
  }
  private add(ms: number, fn: () => void, label: string): Cancel {
    const entry = { label, ms, fn, cancelled: false };
    this.entries.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }
  /** Fires the most recent live timer with this label. */
  fire(label: string): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e !== undefined && e.label === label && !e.cancelled) {
        e.fn();
        return;
      }
    }
    throw new Error(`no live timer labelled ${label}`);
  }
}

const goodProof = (req: CleanupRequest): CleanupProof => ({
  confirmed: true,
  executionId: req.executionId,
  evidence: "fake: container removed",
});

class FakeRunner implements JobRunner {
  readonly runs: RunContext[] = [];
  readonly cleanups: CleanupRequest[] = [];
  /** When true, run() resolves "aborted" as soon as its signal aborts. */
  autoAbort = true;
  runImpl: ((ctx: RunContext) => Promise<RunOutcome>) | null = null;
  cleanupImpl: (req: CleanupRequest) => Promise<CleanupProof> = (req) => Promise.resolve(goodProof(req));
  private resolvers: Array<(o: RunOutcome) => void> = [];

  run(ctx: RunContext): Promise<RunOutcome> {
    this.runs.push(ctx);
    if (this.runImpl !== null) return this.runImpl(ctx);
    return new Promise<RunOutcome>((resolve) => {
      this.resolvers.push(resolve);
      if (this.autoAbort) {
        ctx.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
      }
    });
  }

  cleanup(req: CleanupRequest): Promise<CleanupProof> {
    this.cleanups.push(req);
    return this.cleanupImpl(req);
  }

  finish(outcome: RunOutcome): void {
    const r = this.resolvers.shift();
    assert.ok(r, "no pending run to finish");
    r(outcome);
  }
}

function makeWorker(
  db: DatabaseSync,
  id: string,
  runner: JobRunner,
  timers: ManualTimers = new ManualTimers(),
): JobWorker {
  return new JobWorker({
    db, workerId: id, runner, timers, now: clock,
    leaseMs: MIN, heartbeatMs: 20 * SEC, abortGraceMs: 5 * SEC, cleanupTimeoutMs: 30 * SEC,
  });
}

function newJob(db: DatabaseSync): string {
  return createJob(db, { repoUrl: "https://github.com/o/r", rawToken: generateRawToken() }).jobId;
}

function row(db: DatabaseSync, id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown>;
}

function events(db: DatabaseSync, id: string): Array<{ type: string; payload: Record<string, unknown> }> {
  const rows = db
    .prepare("SELECT event_type, payload FROM job_events WHERE job_id = ? ORDER BY seq")
    .all(id) as Array<{ event_type: string; payload: string }>;
  return rows.map((r) => ({ type: r.event_type, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}

const types = (db: DatabaseSync, id: string): string[] => events(db, id).map((e) => e.type);

function infraKind(db: DatabaseSync, id: string): string | null {
  const raw = row(db, id)["infra_error"] as string | null;
  return raw === null ? null : (JSON.parse(raw) as { kind: string }).kind;
}

beforeEach(() => {
  nowMs = T0;
  dir = mkdtempSync(join(tmpdir(), "graveyard-worker-"));
  const path = join(dir, "t.sqlite");
  a = openDatabase(path);
  b = openDatabase(path);
});

afterEach(() => {
  try { a.close(); } catch { /* ignore */ }
  try { b.close(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("construction", () => {
  it("rejects heartbeat interval not smaller than the lease, and bad worker ids", () => {
    const r = new FakeRunner();
    assert.throws(() => new JobWorker({ db: a, workerId: "w", runner: r, leaseMs: 1000, heartbeatMs: 1000 }));
    assert.throws(() => new JobWorker({ db: a, workerId: "", runner: r }));
    assert.throws(() => new JobWorker({ db: a, workerId: "w", runner: r, leaseMs: -1 }));
  });
});

describe("exclusivity", () => {
  it("one job runs once; a busy worker and a second worker do not run it again", async () => {
    const jobId = newJob(a);
    const r1 = new FakeRunner();
    const r2 = new FakeRunner();
    const w1 = makeWorker(a, "w1", r1);
    const w2 = makeWorker(b, "w2", r2);

    const p1 = w1.runOnce();
    await flush();
    assert.equal(r1.runs.length, 1);
    assert.equal(r1.runs[0]!.executionId, `${jobId}:1`);
    assert.deepEqual(await w1.runOnce(), { kind: "busy" });
    assert.deepEqual(await w2.runOnce(), { kind: "idle" });
    assert.equal(r2.runs.length, 0);

    r1.finish({ kind: "completed" });
    assert.deepEqual(await p1, { kind: "finished", jobId, outcome: "completed" });

    const j = row(a, jobId);
    assert.equal(j["status"], "completed");
    assert.equal(j["stage"], "done");
    assert.equal(j["lease_token"], null);
    assert.deepEqual(types(a, jobId), ["created", "claimed", "completed"]);
  });

  it("processes queued jobs one at a time, oldest first", async () => {
    const j1 = newJob(a);
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct created_at
    const j2 = newJob(a);
    const r = new FakeRunner();
    const w = makeWorker(a, "w", r);

    const p1 = w.runOnce();
    await flush();
    assert.equal(r.runs[0]!.jobId, j1);
    assert.equal(row(a, j2)["status"], "queued");
    r.finish({ kind: "completed" });
    await p1;

    const p2 = w.runOnce();
    await flush();
    assert.equal(r.runs[1]!.jobId, j2);
    r.finish({ kind: "completed" });
    await p2;
    assert.equal(row(a, j2)["status"], "completed");
  });
});

describe("fenced writes and stale workers", () => {
  it("a stale worker cannot write after recovery requeued and another worker re-claimed", async () => {
    const jobId = newJob(a);
    const rA = new FakeRunner();
    const rB = new FakeRunner();
    const wA = makeWorker(a, "A", rA);
    const wB = makeWorker(b, "B", rB);

    const pA = wA.runOnce();
    await flush();

    nowMs = T0 + 2 * MIN; // A's 60 s lease expired without heartbeat
    assert.deepEqual(await wB.recoverOnce(), [{ jobId, outcome: "requeued" }]);
    assert.equal(rB.cleanups.length, 1);
    assert.equal(rB.cleanups[0]!.executionId, `${jobId}:1`);
    assert.equal(rB.cleanups[0]!.workerId, "A");
    assert.equal(row(b, jobId)["status"], "queued");

    const pB = wB.runOnce();
    await flush();
    const tokenB = row(b, jobId)["lease_token"];
    assert.equal(row(b, jobId)["attempt_count"], 2);

    rA.finish({ kind: "completed" }); // stale worker finishes late
    const resA = await pA;
    assert.deepEqual(resA, { kind: "finished", jobId, outcome: "lease-lost" });

    const j = row(b, jobId);
    assert.equal(j["status"], "running");
    assert.equal(j["worker_id"], "B");
    assert.equal(j["lease_token"], tokenB);
    assert.ok(!types(b, jobId).includes("completed"));

    rB.finish({ kind: "completed" });
    assert.equal(((await pB) as { outcome: string }).outcome, "completed");
    assert.deepEqual(types(b, jobId), [
      "created", "claimed", "recovery-required", "requeued", "claimed", "completed",
    ]);
  });

  it("a worker whose lease expired (not yet fenced) cannot record a result", async () => {
    const jobId = newJob(a);
    const r = new FakeRunner();
    const w = makeWorker(a, "A", r);
    const p = w.runOnce();
    await flush();

    nowMs = T0 + 61 * SEC;
    r.finish({ kind: "completed" });
    assert.deepEqual(await p, { kind: "finished", jobId, outcome: "lease-lost" });
    assert.equal(row(a, jobId)["status"], "running");
    assert.ok(!types(a, jobId).includes("completed"));
  });

  it("heartbeat extends the lease; a rejected heartbeat aborts the run and writes nothing", async () => {
    const jobId = newJob(a);
    const rA = new FakeRunner();
    const rB = new FakeRunner();
    const tA = new ManualTimers();
    const wA = makeWorker(a, "A", rA, tA);
    const wB = makeWorker(b, "B", rB);
    const pA = wA.runOnce();
    await flush();

    nowMs = T0 + 30 * SEC;
    tA.fire("heartbeat");
    assert.equal(row(a, jobId)["lease_expires_at"], new Date(T0 + 90 * SEC).toISOString());
    assert.equal(rA.runs[0]!.signal.aborted, false);

    nowMs = T0 + 3 * MIN; // missed heartbeats; B fences and requeues
    assert.deepEqual(await wB.recoverOnce(), [{ jobId, outcome: "requeued" }]);

    tA.fire("heartbeat"); // token voided -> rejected
    assert.equal(rA.runs[0]!.signal.aborted, true);
    assert.deepEqual(await pA, { kind: "finished", jobId, outcome: "lease-lost" });
    assert.equal(rA.cleanups.length, 1); // local hygiene only
    assert.equal(row(a, jobId)["status"], "queued");
    assert.ok(!types(a, jobId).includes("completed"));
  });

  it("finishLeasedJob rejects wrong token, fenced lease and past-deadline writes", () => {
    const jobId = newJob(a);
    const claim = claimNextJob(a, { workerId: "w", now: new Date(T0) });
    assert.ok(claim);
    const base = { jobId, outcome: "completed" as const, cleanupEvidence: "ev" };

    assert.deepEqual(finishLeasedJob(a, { ...base, leaseToken: "wrong", now: new Date(T0) }), { accepted: false });
    assert.deepEqual(
      finishLeasedJob(a, { ...base, leaseToken: claim.leaseToken, now: new Date(T0 + 15 * MIN) }),
      { accepted: false },
    );
    assert.equal(row(a, jobId)["status"], "running");

    const fenced = fenceOwnLease(a, { jobId, leaseToken: claim.leaseToken, reason: "test", now: new Date(T0 + SEC) });
    assert.ok(fenced);
    assert.equal(fenceOwnLease(a, { jobId, leaseToken: claim.leaseToken, reason: "again" }), null);
    assert.deepEqual(
      finishLeasedJob(a, { ...base, leaseToken: claim.leaseToken, now: new Date(T0 + 2 * SEC) }),
      { accepted: false },
    );
    assert.equal(row(a, jobId)["status"], "running");
    assert.ok(!types(a, jobId).includes("completed"));
  });
});

describe("deadline", () => {
  it("aborts the run, requires cleanup, and records timed-out with infrastructure metadata", async () => {
    const jobId = newJob(a);
    const r = new FakeRunner();
    const t = new ManualTimers();
    const w = makeWorker(a, "w", r, t);
    const p = w.runOnce();
    await flush();

    assert.equal(t.entries.find((e) => e.label === "deadline")!.ms, 15 * MIN);
    nowMs = T0 + 15 * MIN;
    t.fire("deadline");
    assert.deepEqual(await p, { kind: "finished", jobId, outcome: "timed-out" });

    assert.equal(r.runs[0]!.signal.aborted, true);
    assert.equal(r.cleanups.length, 1);
    assert.equal(r.cleanups[0]!.executionId, `${jobId}:1`);
    assert.equal(row(a, jobId)["status"], "timed-out");
    assert.equal(infraKind(a, jobId), "deadline-exceeded");
    assert.deepEqual(types(a, jobId), ["created", "claimed", "recovery-required", "timed-out"]);
  });

  it("does not wait forever for a runner that ignores abort, and discards its late 'completed'", async () => {
    const jobId = newJob(a);
    const r = new FakeRunner();
    r.autoAbort = false;
    const t = new ManualTimers();
    const w = makeWorker(a, "w", r, t);
    const p = w.runOnce();
    await flush();

    nowMs = T0 + 15 * MIN;
    t.fire("deadline");
    await flush();
    t.fire("abort-grace");
    await flush();
    r.finish({ kind: "completed" }); // too late, must not become success
    assert.deepEqual(await p, { kind: "finished", jobId, outcome: "timed-out" });
    assert.equal(row(a, jobId)["status"], "timed-out");
    assert.ok(!types(a, jobId).includes("completed"));
  });

  it("heartbeat tick after the deadline aborts with deadline, not lease-lost", async () => {
    const jobId = newJob(a);
    const r = new FakeRunner();
    const t = new ManualTimers();
    const w = makeWorker(a, "w", r, t);
    const p = w.runOnce();
    await flush();
    nowMs = T0 + 15 * MIN + SEC;
    t.fire("heartbeat");
    assert.deepEqual(await p, { kind: "finished", jobId, outcome: "timed-out" });
  });
});

describe("safe shutdown", () => {
  it("aborts the run and requeues only after cleanup proof", async () => {
    const jobId = newJob(a);
    const r = new FakeRunner();
    const w = makeWorker(a, "w", r);
    const p = w.runOnce();
    await flush();

    await w.shutdown();
    assert.deepEqual(await p, { kind: "finished", jobId, outcome: "requeued" });
    assert.equal(r.runs[0]!.signal.aborted, true);
    assert.equal(r.cleanups.length, 1);

    const j = row(a, jobId);
    assert.equal(j["status"], "queued");
    assert.equal(j["attempt_count"], 1);
    assert.equal(j["lease_token"], null);
    assert.deepEqual(types(a, jobId), ["created", "claimed", "recovery-required", "requeued"]);
    const requeued = events(a, jobId)[3]!;
    assert.match(String(requeued.payload["cleanupConfirmedBy"]), /fake: container removed/);

    assert.deepEqual(await w.runOnce(), { kind: "idle" }); // no new claims after shutdown
    assert.equal(row(a, jobId)["status"], "queued");
  });

  it("with unproven cleanup the job stays fenced and is not requeued", async () => {
    const jobId = newJob(a);
    const r = new FakeRunner();
    r.cleanupImpl = () => Promise.resolve({ confirmed: false, reason: "docker unreachable" });
    const w = makeWorker(a, "w", r);
    const p = w.runOnce();
    await flush();
    await w.shutdown();

    assert.deepEqual(await p, { kind: "finished", jobId, outcome: "blocked" });
    const j = row(a, jobId);
    assert.equal(j["status"], "running");
    assert.equal(j["recovery_required"], 1);
    assert.equal(infraKind(a, jobId), "cleanup-unconfirmed");
    assert.equal(claimNextJob(b, { workerId: "x", now: clock() }), null);
  });

  it("discards a late 'completed' from a runner that ignored the abort", async () => {
    const jobId = newJob(a);
    const r = new FakeRunner();
    r.autoAbort = false;
    const t = new ManualTimers();
    const w = makeWorker(a, "w", r, t);
    const p = w.runOnce();
    await flush();

    const down = w.shutdown();
    await flush();
    t.fire("abort-grace");
    await flush();
    r.finish({ kind: "completed" });
    await down;
    assert.deepEqual(await p, { kind: "finished", jobId, outcome: "requeued" });
    assert.equal(row(a, jobId)["status"], "queued");
  });

  it("resolves immediately when idle and is repeatable", async () => {
    const w = makeWorker(a, "w", new FakeRunner());
    await w.shutdown();
    await w.shutdown();
    assert.deepEqual(await w.recoverOnce(), []);
  });
});

describe("cleanup failure blocks every consequence", () => {
  const bad: Array<[string, (req: CleanupRequest) => Promise<CleanupProof>]> = [
    ["confirmed:false", () => Promise.resolve({ confirmed: false, reason: "container still present" })],
    ["proof for another execution", () => Promise.resolve({ confirmed: true, executionId: "other:1", evidence: "x" })],
    ["empty evidence", (req) => Promise.resolve({ confirmed: true, executionId: req.executionId, evidence: "  " })],
    ["cleanup throws", () => Promise.reject(new Error("boom"))],
    ["no proof object", () => Promise.resolve(undefined as unknown as CleanupProof)],
  ];

  for (const [name, impl] of bad) {
    it(`${name}: job is not completed, stays blocked, recovery refuses until real proof`, async () => {
      const jobId = newJob(a);
      const r = new FakeRunner();
      r.cleanupImpl = impl;
      const w = makeWorker(a, "w", r);
      const p = w.runOnce();
      await flush();
      r.finish({ kind: "completed" });
      assert.deepEqual(await p, { kind: "finished", jobId, outcome: "blocked" });

      let j = row(a, jobId);
      assert.equal(j["status"], "running");
      assert.equal(j["recovery_required"], 1);
      assert.equal(infraKind(a, jobId), "cleanup-unconfirmed");
      assert.ok(!types(a, jobId).includes("completed"));
      assert.equal(claimNextJob(b, { workerId: "x", now: clock() }), null);

      // Repeated recovery with unproven cleanup: still blocked, no duplicate records.
      assert.deepEqual(await w.recoverOnce(), [{ jobId, outcome: "blocked" }]);
      assert.deepEqual(await w.recoverOnce(), [{ jobId, outcome: "blocked" }]);
      assert.equal(types(a, jobId).filter((x) => x === "cleanup-unconfirmed").length, 1);
      assert.equal(row(a, jobId)["status"], "running");

      // Real proof unblocks it: requeued (attempt 1 of 2).
      r.cleanupImpl = (req) => Promise.resolve(goodProof(req));
      assert.deepEqual(await w.recoverOnce(), [{ jobId, outcome: "requeued" }]);
      j = row(a, jobId);
      assert.equal(j["status"], "queued");
      assert.equal(j["infra_error"], null);
      assert.ok(!types(a, jobId).includes("completed"));
    });
  }

  it("cleanup that never answers is treated as unproven after the timeout", async () => {
    const jobId = newJob(a);
    const r = new FakeRunner();
    r.cleanupImpl = () => new Promise<CleanupProof>(() => undefined);
    const t = new ManualTimers();
    const w = makeWorker(a, "w", r, t);
    const p = w.runOnce();
    await flush();
    r.finish({ kind: "completed" });
    await flush();
    t.fire("cleanup-timeout");
    assert.deepEqual(await p, { kind: "finished", jobId, outcome: "blocked" });
    assert.equal(row(a, jobId)["status"], "running");
    assert.equal(infraKind(a, jobId), "cleanup-unconfirmed");
  });

  it("recovery of a crashed worker's expired job never confirms without proof", async () => {
    const jobId = newJob(a);
    const claim = claimNextJob(a, { workerId: "crashed", now: new Date(T0) });
    assert.ok(claim);
    nowMs = T0 + 5 * MIN;

    const r = new FakeRunner();
    r.cleanupImpl = () => Promise.resolve({ confirmed: false, reason: "cannot inspect docker" });
    const w = makeWorker(b, "rec", r);
    assert.deepEqual(await w.recoverOnce(), [{ jobId, outcome: "blocked" }]);
    assert.equal(row(b, jobId)["status"], "running");
    assert.equal(row(b, jobId)["recovery_required"], 1);
    assert.equal(r.cleanups[0]!.workerId, "crashed");
    assert.equal(r.cleanups[0]!.attempt, 1);

    r.cleanupImpl = (req) => Promise.resolve(goodProof(req));
    assert.deepEqual(await w.recoverOnce(), [{ jobId, outcome: "requeued" }]);
  });

  it("recovery fails the job when attempts are exhausted, still gated on proof", async () => {
    const jobId = newJob(a);
    a.prepare("UPDATE jobs SET max_attempts = 1 WHERE id = ?").run(jobId);
    claimNextJob(a, { workerId: "crashed", now: new Date(T0) });
    nowMs = T0 + 2 * MIN;
    const r = new FakeRunner();
    const w = makeWorker(b, "rec", r);
    assert.deepEqual(await w.recoverOnce(), [{ jobId, outcome: "failed" }]);
    assert.equal(infraKind(a, jobId), "attempts-exhausted");
  });
});

describe("production runner fails closed", () => {
  it("never produces success: job fails with explicit infrastructure-unavailable", async () => {
    const jobId = newJob(a);
    const w = makeWorker(a, "prod", new UnavailableRunner());
    assert.deepEqual(await w.runOnce(), { kind: "finished", jobId, outcome: "failed" });

    const j = row(a, jobId);
    assert.equal(j["status"], "failed");
    assert.notEqual(j["stage"], "done");
    assert.equal(infraKind(a, jobId), "infrastructure-unavailable");
    assert.deepEqual(types(a, jobId), ["created", "claimed", "failed"]);
    const failed = events(a, jobId)[2]!;
    const infra = failed.payload["infrastructure"] as { message: string };
    assert.equal(infra.message, SANDBOX_UNAVAILABLE_REASON);
    assert.equal(
      (a.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'completed'").get() as { n: number }).n,
      0,
    );
  });

  it("cannot prove cleanup for executions it did not create, so recovery stays blocked", async () => {
    const jobId = newJob(a);
    claimNextJob(a, { workerId: "other-process", now: new Date(T0) });
    nowMs = T0 + 2 * MIN;
    const w = makeWorker(b, "prod", new UnavailableRunner());
    assert.deepEqual(await w.recoverOnce(), [{ jobId, outcome: "blocked" }]);
    assert.equal(row(b, jobId)["status"], "running");
    assert.equal(infraKind(b, jobId), "cleanup-unconfirmed");
  });

  it("run() itself starts nothing and reports unavailable", async () => {
    const runner = new UnavailableRunner();
    const ac = new AbortController();
    const out = await runner.run({
      jobId: "j", repoUrl: "https://github.com/o/r", executionId: "j:1", attempt: 1,
      deadlineAt: new Date(T0).toISOString(), signal: ac.signal,
    });
    assert.deepEqual(out, { kind: "infrastructure-unavailable", reason: SANDBOX_UNAVAILABLE_REASON });
    const unknown = await runner.cleanup({ jobId: "j", executionId: "j:2", attempt: 2, workerId: null });
    assert.equal(unknown.confirmed, false);
  });

  it("a runner that throws or stops unprompted yields failed, never completed", async () => {
    const j1 = newJob(a);
    const thrower = new FakeRunner();
    thrower.runImpl = () => Promise.reject(new Error("secret-ish detail"));
    assert.deepEqual(await makeWorker(a, "w", thrower).runOnce(), { kind: "finished", jobId: j1, outcome: "failed" });
    assert.ok(!JSON.stringify(events(a, j1)).includes("secret-ish"));

    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct created_at
    const j2 = newJob(a);
    const quitter = new FakeRunner();
    quitter.runImpl = () => Promise.resolve({ kind: "aborted" });
    assert.deepEqual(await makeWorker(a, "w", quitter).runOnce(), { kind: "finished", jobId: j2, outcome: "failed" });
    for (const id of [j1, j2]) {
      assert.equal(row(a, id)["status"], "failed");
      assert.equal(infraKind(a, id), "infrastructure-unavailable");
    }
  });
});

describe("transactional state and events", () => {
  it("if the event cannot be written the state change rolls back", async () => {
    const jobId = newJob(a);
    a.exec(`
      CREATE TRIGGER no_completed_event BEFORE INSERT ON job_events
      WHEN NEW.event_type = 'completed'
      BEGIN SELECT RAISE(ABORT, 'event blocked'); END
    `);
    const r = new FakeRunner();
    const w = makeWorker(a, "w", r);
    const p = w.runOnce();
    await flush();
    r.finish({ kind: "completed" });
    await assert.rejects(p);

    const j = row(a, jobId);
    assert.equal(j["status"], "running");
    assert.notEqual(j["stage"], "done");
    assert.ok(!types(a, jobId).includes("completed"));
    assert.deepEqual(await w.runOnce(), { kind: "idle" }); // coordinator is usable again
  });

  it("lease and recovery tokens never appear in events", async () => {
    const jobId = newJob(a);
    const r = new FakeRunner();
    const w = makeWorker(a, "w", r);
    const p = w.runOnce();
    await flush();
    const token = row(a, jobId)["lease_token"] as string;
    await w.shutdown();
    await p;
    const recoveryToken = (row(a, jobId)["recovery_token"] as string | null) ?? "";
    const dump = JSON.stringify(events(a, jobId));
    assert.ok(!dump.includes(token));
    if (recoveryToken !== "") assert.ok(!dump.includes(recoveryToken));
  });
});
