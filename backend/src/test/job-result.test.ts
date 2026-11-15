/**
 * job-result.test.ts — GET /api/jobs/:id/result: authorization, durability, and the rule that a
 * diagnosis or patch proposal is never presented as a verified repair.
 *
 * A real Fastify app and the real lease functions run against a temporary SQLite file shared by two
 * connections (as the API and the worker share it). No Docker, no network, no worker loop.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { buildApp } from "../app.js";
import { openDatabase } from "../db.js";
import {
  claimNextJob,
  confirmRecoveryCleanup,
  expireQueuedDeadlines,
  fenceOwnLease,
  finishLeasedJob,
  recordCleanupUnconfirmed,
  recordLeasedResult,
} from "../leases.js";
import { presentResult, type ResultView } from "../result-view.js";
import type { JobResultRecord } from "../jobs.js";

const REPO = "https://github.com/o/r";

const analystOk = { status: "ok", modelAuthored: true, category: "build-failure", summary: "build.mjs throws" };
const fixerOk = { status: "ok", modelAuthored: true, proposalOnly: true, applied: false, diff: "--- a/build.mjs\n+++ b/build.mjs\n" };
const verifiedResult = { verdict: "verified", sourceKind: "controlled-fixture", fixture: "fx1" };
const failing = (analyst: Record<string, unknown>, fixer: Record<string, unknown>): Record<string, unknown> => ({
  verdict: "repository-failing",
  sourceKind: "controlled-fixture",
  fixture: "fx1",
  analyst,
  fixer,
});

let dir: string;
let app: FastifyInstance;
let db: DatabaseSync;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "graveyard-job-result-"));
  const path = join(dir, "t.sqlite");
  app = await buildApp({ logLevel: "silent", databasePath: path });
  db = openDatabase(path);
});

afterEach(async () => {
  db.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function newJob(): Promise<{ jobId: string; token: string }> {
  const res = await app.inject({ method: "POST", url: "/api/jobs", payload: { repoUrl: REPO, consent: true } });
  assert.equal(res.statusCode, 202);
  return res.json<{ jobId: string; token: string }>();
}

const getResult = (jobId: string, token?: string): Promise<LightMyRequestResponse> =>
  app.inject({
    method: "GET",
    url: `/api/jobs/${jobId}/result`,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

async function view(jobId: string, token: string): Promise<ResultView> {
  const res = await getResult(jobId, token);
  assert.equal(res.statusCode, 200);
  return res.json<ResultView>();
}

function claim(jobId: string): string {
  const c = claimNextJob(db, { workerId: "w1" });
  assert.ok(c !== null && c.jobId === jobId, "expected to claim the job under test");
  return c.leaseToken;
}

/** Claim, optionally record a result, then finish as completed with cleanup evidence. */
function complete(jobId: string, result?: Record<string, unknown>): void {
  const leaseToken = claim(jobId);
  if (result !== undefined) assert.deepEqual(recordLeasedResult(db, { jobId, leaseToken, result }), { accepted: true });
  assert.deepEqual(finishLeasedJob(db, { jobId, leaseToken, outcome: "completed", cleanupEvidence: "container gone" }), { accepted: true });
}

describe("GET /api/jobs/:id/result: authorization", () => {
  it("returns 401 without a well-formed bearer token", async () => {
    const { jobId } = await newJob();
    for (const authorization of [undefined, "", "Bearer", "Bearer abc", `Bearer ${"A".repeat(64)}`, `Basic ${"a".repeat(64)}`, `bearer ${"a".repeat(64)}`]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}/result`,
        headers: authorization === undefined ? {} : { authorization },
      });
      assert.equal(res.statusCode, 401, String(authorization));
      assert.equal(res.headers["cache-control"], "no-store");
    }
  });

  it("returns an identical 403 for a wrong token and for an unknown job", async () => {
    const { jobId } = await newJob();
    const wrong = await getResult(jobId, "a".repeat(64));
    const unknown = await getResult("00000000-0000-4000-8000-000000000000", "a".repeat(64));
    assert.equal(wrong.statusCode, 403);
    assert.equal(unknown.statusCode, 403);
    assert.equal(wrong.body, unknown.body);
    assert.equal(wrong.headers["cache-control"], "no-store");
  });

  it("does not let one job's token read another job's result", async () => {
    const a = await newJob();
    const b = await newJob();
    assert.equal((await getResult(a.jobId, b.token)).statusCode, 403);
    assert.equal((await getResult(b.jobId, a.token)).statusCode, 403);
    assert.equal((await getResult(a.jobId, a.token)).statusCode, 200);
  });

  it("marks every response no-store", async () => {
    const { jobId, token } = await newJob();
    assert.equal((await getResult(jobId, token)).headers["cache-control"], "no-store");
  });
});

describe("GET /api/jobs/:id/result: unfinished jobs expose no result", () => {
  it("queued: pending, not terminal, no result", async () => {
    const { jobId, token } = await newJob();
    const v = await view(jobId, token);
    assert.equal(v.jobId, jobId);
    assert.equal(v.status, "queued");
    assert.equal(v.terminal, false);
    assert.equal(v.outcome, "pending");
    assert.equal(v.result, null);
    assert.equal(v.infrastructure, null);
    assert.deepEqual(v.repair, { verified: false, patchApplied: false, patchProposed: false, diagnosed: false });
  });

  it("running: pending", async () => {
    const { jobId, token } = await newJob();
    claim(jobId);
    const v = await view(jobId, token);
    assert.equal(v.status, "running");
    assert.equal(v.terminal, false);
    assert.equal(v.outcome, "pending");
  });

  it("blocked after a recorded result: the result is NOT exposed because the job never completed", async () => {
    const { jobId, token } = await newJob();
    const leaseToken = claim(jobId);
    assert.deepEqual(recordLeasedResult(db, { jobId, leaseToken, result: verifiedResult }), { accepted: true });
    const fenced = fenceOwnLease(db, { jobId, leaseToken, reason: "cleanup-unconfirmed" });
    assert.ok(fenced !== null);
    assert.equal(recordCleanupUnconfirmed(db, { jobId, recoveryToken: fenced.recoveryToken, message: "docker unreachable" }), true);

    const v = await view(jobId, token);
    assert.equal(v.status, "running");
    assert.equal(v.terminal, false);
    assert.equal(v.outcome, "pending");
    assert.equal(v.result, null);
  });
});

describe("GET /api/jobs/:id/result: completed jobs", () => {
  it("passing: reports the unmodified fixture passed and that no repair was performed", async () => {
    const { jobId, token } = await newJob();
    complete(jobId, verifiedResult);
    const v = await view(jobId, token);
    assert.equal(v.status, "completed");
    assert.equal(v.stage, "done");
    assert.equal(v.terminal, true);
    assert.equal(v.outcome, "passing");
    assert.deepEqual(v.result, verifiedResult);
    assert.deepEqual(v.repair, { verified: false, patchApplied: false, patchProposed: false, diagnosed: false });
    assert.match(v.summary, /No repair was performed/);
  });

  it("failing with a patch proposal: a proposal is reported as a proposal, never as a verified repair", async () => {
    const { jobId, token } = await newJob();
    complete(jobId, failing(analystOk, fixerOk));
    const v = await view(jobId, token);
    assert.equal(v.outcome, "failing-with-patch-proposal");
    assert.equal(v.repair.patchProposed, true);
    assert.equal(v.repair.diagnosed, true);
    assert.equal(v.repair.verified, false);
    assert.equal(v.repair.patchApplied, false);
    assert.match(v.summary, /not applied and not verified/);
    assert.deepEqual(v.result, failing(analystOk, fixerOk));
  });

  it("failing with a diagnosis only", async () => {
    const { jobId, token } = await newJob();
    complete(jobId, failing(analystOk, { status: "no-result", code: "unknown-diagnosis" }));
    const v = await view(jobId, token);
    assert.equal(v.outcome, "failing-with-diagnosis");
    assert.deepEqual(v.repair, { verified: false, patchApplied: false, patchProposed: false, diagnosed: true });
  });

  it("failing without any diagnosis (agents off or failed)", async () => {
    const { jobId, token } = await newJob();
    complete(jobId, failing({ status: "not-configured" }, { status: "not-configured" }));
    const v = await view(jobId, token);
    assert.equal(v.outcome, "failing-undiagnosed");
    assert.deepEqual(v.repair, { verified: false, patchApplied: false, patchProposed: false, diagnosed: false });
  });

  it("a fixer entry that claims applied:true is not accepted as a proposal", async () => {
    const { jobId, token } = await newJob();
    complete(jobId, failing(analystOk, { ...fixerOk, applied: true }));
    const v = await view(jobId, token);
    assert.equal(v.outcome, "failing-with-diagnosis");
    assert.equal(v.repair.patchProposed, false);
    assert.equal(v.repair.patchApplied, false);
    assert.equal(v.repair.verified, false);
  });

  it("an analyst or fixer entry that is not marked model-authored is not trusted as a diagnosis or proposal", async () => {
    const { jobId, token } = await newJob();
    complete(jobId, failing({ status: "ok", category: "x" }, { status: "ok", proposalOnly: true, applied: false }));
    const v = await view(jobId, token);
    assert.equal(v.outcome, "failing-undiagnosed");
  });

  it("tests-not-run is not a verification", async () => {
    const { jobId, token } = await newJob();
    complete(jobId, { verdict: "tests-not-run", sourceKind: "controlled-fixture", fixture: "fx1" });
    const v = await view(jobId, token);
    assert.equal(v.outcome, "tests-not-run");
    assert.match(v.summary, /not a verified result/);
  });

  it("completed without a result event, or with an unknown verdict, is reported as no result", async () => {
    const a = await newJob();
    complete(a.jobId);
    const va = await view(a.jobId, a.token);
    assert.equal(va.outcome, "completed-without-result");
    assert.equal(va.result, null);

    const b = await newJob();
    complete(b.jobId, { verdict: "repaired", fixture: "fx1" });
    const vb = await view(b.jobId, b.token);
    assert.equal(vb.outcome, "completed-without-result");
    assert.equal(vb.result, null);
  });

  it("shows only the final attempt's result, never an earlier attempt's", async () => {
    const { jobId, token } = await newJob();
    const first = claim(jobId);
    assert.deepEqual(recordLeasedResult(db, { jobId, leaseToken: first, result: verifiedResult }), { accepted: true });
    const fenced = fenceOwnLease(db, { jobId, leaseToken: first, reason: "worker-shutdown" });
    assert.ok(fenced !== null);
    assert.deepEqual(confirmRecoveryCleanup(db, { jobId, recoveryToken: fenced.recoveryToken, confirmedBy: "test" }), { outcome: "requeued" });

    const second = claim(jobId);
    assert.deepEqual(finishLeasedJob(db, { jobId, leaseToken: second, outcome: "completed", cleanupEvidence: "gone" }), { accepted: true });

    const v = await view(jobId, token);
    assert.equal(v.status, "completed");
    assert.equal(v.outcome, "completed-without-result");
    assert.equal(v.result, null);
  });

  it("the result survives reopening the database (durable)", async () => {
    const { jobId, token } = await newJob();
    complete(jobId, failing(analystOk, fixerOk));
    await app.close();
    db.close();
    const path = join(dir, "t.sqlite");
    app = await buildApp({ logLevel: "silent", databasePath: path });
    db = openDatabase(path);
    const v = await view(jobId, token);
    assert.equal(v.outcome, "failing-with-patch-proposal");
  });
});

describe("GET /api/jobs/:id/result: failed, timed-out and cancelled jobs", () => {
  it("failed: infrastructure metadata, no result, not a repository diagnosis", async () => {
    const { jobId, token } = await newJob();
    const leaseToken = claim(jobId);
    assert.deepEqual(recordLeasedResult(db, { jobId, leaseToken, result: verifiedResult }), { accepted: true });
    assert.deepEqual(
      finishLeasedJob(db, {
        jobId,
        leaseToken,
        outcome: "failed",
        failure: { kind: "infrastructure-unavailable", message: "docker daemon is not available" },
        cleanupEvidence: "container gone",
      }),
      { accepted: true },
    );
    const v = await view(jobId, token);
    assert.equal(v.status, "failed");
    assert.equal(v.terminal, true);
    assert.equal(v.outcome, "infrastructure-failed");
    assert.equal(v.result, null, "a stray result event of a failed job is never exposed");
    assert.ok(v.infrastructure !== null);
    assert.equal(v.infrastructure.kind, "infrastructure-unavailable");
    assert.equal(v.infrastructure.message, "docker daemon is not available");
    assert.equal(v.infrastructure.attemptCount, 1);
    assert.deepEqual(v.repair, { verified: false, patchApplied: false, patchProposed: false, diagnosed: false });
  });

  it("timed-out after a queued deadline", async () => {
    const { jobId, token } = await newJob();
    const leaseToken = claim(jobId);
    const fenced = fenceOwnLease(db, { jobId, leaseToken, reason: "worker-shutdown" });
    assert.ok(fenced !== null);
    assert.deepEqual(confirmRecoveryCleanup(db, { jobId, recoveryToken: fenced.recoveryToken, confirmedBy: "test" }), { outcome: "requeued" });
    assert.deepEqual(expireQueuedDeadlines(db, { now: new Date(Date.now() + 60 * 60 * 1000) }), [jobId]);

    const v = await view(jobId, token);
    assert.equal(v.status, "timed-out");
    assert.equal(v.terminal, true);
    assert.equal(v.outcome, "timed-out");
    assert.equal(v.infrastructure?.kind, "deadline-exceeded");
    assert.equal(v.result, null);
  });

  it("cancelled while queued: nothing ran", async () => {
    const { jobId, token } = await newJob();
    const cancel = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/cancel`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(cancel.statusCode, 200);
    const v = await view(jobId, token);
    assert.equal(v.status, "cancelled");
    assert.equal(v.terminal, true);
    assert.equal(v.outcome, "cancelled");
    assert.equal(v.result, null);
    assert.equal(v.infrastructure, null);
  });
});

describe("GET /api/jobs/:id/result: no secrets in the response", () => {
  it("never contains the bearer token, the stored hash, or lease and recovery tokens", async () => {
    const { jobId, token } = await newJob();
    const leaseToken = claim(jobId);
    recordLeasedResult(db, { jobId, leaseToken, result: verifiedResult });
    finishLeasedJob(db, { jobId, leaseToken, outcome: "completed", cleanupEvidence: "gone" });

    const row = db.prepare("SELECT token_hash, lease_token, recovery_token FROM jobs WHERE id = ?").get(jobId) as {
      token_hash: string;
      lease_token: string | null;
      recovery_token: string | null;
    };
    const res = await getResult(jobId, token);
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes(token));
    assert.ok(!res.body.includes(row.token_hash));
    assert.ok(!res.body.includes(leaseToken));
    for (const key of Object.keys(res.json<Record<string, unknown>>())) {
      assert.ok(!/token|hash|lease/i.test(key), `unexpected key ${key}`);
    }
  });
});

describe("presentResult (pure)", () => {
  const rec = (over: Partial<JobResultRecord>): JobResultRecord => ({
    jobId: "j",
    stage: "queued",
    status: "queued",
    attemptCount: 0,
    maxAttempts: 2,
    infraError: null,
    result: null,
    ...over,
  });

  it("treats an unknown status as pending and not terminal", () => {
    const v = presentResult(rec({ status: "weird" }));
    assert.equal(v.outcome, "pending");
    assert.equal(v.terminal, false);
  });

  it("ignores unparsable, wrongly typed or unknown-kind infrastructure metadata", () => {
    for (const infraError of [
      "{not json",
      "null",
      "[]",
      JSON.stringify({ kind: "made-up", message: "m", at: "t", attemptCount: 1, maxAttempts: 2 }),
      JSON.stringify({ kind: "deadline-exceeded", message: 5, at: "t", attemptCount: 1, maxAttempts: 2 }),
      JSON.stringify({ kind: "deadline-exceeded", message: "m", at: "t", attemptCount: "1", maxAttempts: 2 }),
    ]) {
      const v = presentResult(rec({ status: "failed", infraError }));
      assert.equal(v.outcome, "infrastructure-failed");
      assert.equal(v.infrastructure, null, infraError);
    }
  });

  it("bounds an overlong infrastructure message and copies only known fields", () => {
    const v = presentResult(
      rec({
        status: "failed",
        infraError: JSON.stringify({
          kind: "attempts-exhausted",
          message: "m".repeat(1000),
          at: "2026-01-01T00:00:00.000Z",
          attemptCount: 2,
          maxAttempts: 2,
          deadlineAt: "x",
          extra: "must not be copied",
        }),
      }),
    );
    assert.ok(v.infrastructure !== null);
    assert.ok(v.infrastructure.message.length <= 301);
    assert.deepEqual(Object.keys(v.infrastructure).sort(), ["at", "attemptCount", "kind", "maxAttempts", "message"]);
  });

  it("repair.verified and repair.patchApplied are false for every outcome", () => {
    const records: JobResultRecord[] = [
      rec({ status: "queued" }),
      rec({ status: "completed", result: verifiedResult }),
      rec({ status: "completed", result: failing(analystOk, fixerOk) }),
      rec({ status: "completed", result: { verdict: "tests-not-run" } }),
      rec({ status: "completed", result: { verdict: "verified", repair: { verified: true, patchApplied: true } } }),
      rec({ status: "failed" }),
      rec({ status: "timed-out" }),
      rec({ status: "cancelled" }),
    ];
    for (const r of records) {
      const v = presentResult(r);
      assert.equal(v.repair.verified, false);
      assert.equal(v.repair.patchApplied, false);
    }
  });
});
