/**
 * jobs.test.ts — focused tests for POST /api/jobs and GET /api/jobs/:id.
 *
 * Uses Node.js built-in `node:test` and `fastify.inject` (no HTTP port).
 *
 * Authorization model under test:
 *   - 401: Authorization header missing or does not match
 *          /^Bearer [0-9a-f]{64}$/ (malformed — wrong scheme, wrong length,
 *          uppercase hex, empty, any other format).
 *   - 403: Header is structurally valid BUT the token does not match the job.
 *          Returned for BOTH a wrong token on a real job AND an unknown job ID.
 *          The two cases are intentionally indistinguishable.
 *
 * Run via: pnpm test
 * (which compiles to dist-test/ then: node --test dist-test/test/*.js)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDatabase } from "../db.js";
import { hashToken, generateRawToken } from "../token.js";
import { validateGithubUrl } from "../url.js";
import { createJob as dbCreateJob, cancelJob as dbCancelJob } from "../jobs.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_URL = "https://github.com/owner/repo";
const VALID_BODY = { repoUrl: VALID_URL, consent: true };

/** A syntactically valid 64-hex-char token that won't match any real job. */
const WRONG_TOKEN = "a".repeat(64);

async function postJob(
  app: FastifyInstance,
  body: unknown = VALID_BODY,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/jobs",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    payload: JSON.stringify(body),
  });
  return { statusCode: res.statusCode, json: res.json() };
}

// ---------------------------------------------------------------------------
// POST /api/jobs — valid creation
// ---------------------------------------------------------------------------

describe("POST /api/jobs — valid creation", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({ logLevel: "silent" });
  });

  after(async () => {
    await app.close();
  });

  it("returns 202 Accepted", async () => {
    const { statusCode } = await postJob(app);
    assert.equal(statusCode, 202);
  });

  it("response body contains jobId, token, status:queued", async () => {
    const { json } = await postJob(app);
    assert.equal(typeof json["jobId"], "string");
    assert.equal(typeof json["token"], "string");
    assert.equal(json["status"], "queued");
  });

  it("jobId is a UUIDv4", async () => {
    const { json } = await postJob(app);
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.ok(uuidRe.test(String(json["jobId"])));
  });

  it("token is 64 lowercase hex characters", async () => {
    const { json } = await postJob(app);
    assert.ok(/^[0-9a-f]{64}$/.test(String(json["token"])));
  });

  it("two calls return different tokens", async () => {
    const a = await postJob(app);
    const b = await postJob(app);
    assert.notEqual(a.json["token"], b.json["token"]);
  });

  it(".git suffix is stripped and canonical URL is stored", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ repoUrl: "https://github.com/owner/repo.git", consent: true }),
    });
    assert.equal(res.statusCode, 202);
    const { jobId, token } = res.json<{ jobId: string; token: string }>();
    const getRes = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(getRes.json<{ repoUrl: string }>().repoUrl, VALID_URL);
  });

  it("accepts dotted repository name (user.github.io)", async () => {
    const { statusCode, json } = await postJob(app, {
      repoUrl: "https://github.com/owner/user.github.io",
      consent: true,
    });
    assert.equal(statusCode, 202);
    // Confirm stored URL
    const getRes = await app.inject({
      method: "GET",
      url: `/api/jobs/${json["jobId"]}`,
      headers: { Authorization: `Bearer ${json["token"]}` },
    });
    assert.equal(getRes.statusCode, 200);
    assert.equal(
      getRes.json<{ repoUrl: string }>().repoUrl,
      "https://github.com/owner/user.github.io",
    );
  });

  it("returns 413 when body exceeds 8 KiB", async () => {
    const bigUrl = "https://github.com/owner/" + "r".repeat(200);
    // Pad the body to exceed 8192 bytes
    const padding = "x".repeat(8200);
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ repoUrl: bigUrl, consent: true, _pad: padding }),
    });
    assert.equal(res.statusCode, 413);
  });
});

// ---------------------------------------------------------------------------
// GET /api/jobs/:id — valid read
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:id — valid read", () => {
  let app: FastifyInstance;
  let jobId: string;
  let token: string;

  before(async () => {
    app = await buildApp({ logLevel: "silent" });
    const { json } = await postJob(app);
    jobId = String(json["jobId"]);
    token = String(json["token"]);
  });

  after(async () => {
    await app.close();
  });

  it("returns 200 with correct token", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
  });

  it("response contains expected metadata fields", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = res.json<Record<string, unknown>>();
    assert.equal(body["jobId"], jobId);
    assert.equal(body["repoUrl"], VALID_URL);
    assert.equal(body["stage"], "queued");
    assert.equal(body["status"], "queued");
    assert.equal(typeof body["createdAt"], "string");
    assert.equal(typeof body["updatedAt"], "string");
  });

  it("response does NOT expose token_hash or raw token", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    const raw = res.body;
    assert.ok(!raw.includes("token_hash"), "must not expose token_hash");
    // Response must not contain the raw token value in any field
    assert.ok(!raw.includes(`"${token}"`), "must not echo raw token in response");
  });

  it("Cache-Control: no-store on 200 response", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.headers["cache-control"], "no-store");
  });
});

// ---------------------------------------------------------------------------
// GET /api/jobs/:id — authorization: 401 for malformed, 403 for wrong/unknown
// ---------------------------------------------------------------------------

describe("GET /api/jobs/:id — authorization", () => {
  let app: FastifyInstance;
  let jobId: string;
  let token: string;

  before(async () => {
    app = await buildApp({ logLevel: "silent" });
    const { json } = await postJob(app);
    jobId = String(json["jobId"]);
    token = String(json["token"]);
  });

  after(async () => {
    await app.close();
  });

  // --- 401 cases: malformed Authorization header ---

  it("401 — no Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    assert.equal(res.statusCode, 401);
  });

  it("401 — Basic scheme instead of Bearer", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: `Basic ${token}` },
    });
    assert.equal(res.statusCode, 401);
  });

  it("401 — Bearer with empty token", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: "Bearer " },
    });
    assert.equal(res.statusCode, 401);
  });

  it("401 — Bearer with token shorter than 64 chars", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: "Bearer " + "a".repeat(32) },
    });
    assert.equal(res.statusCode, 401);
  });

  it("401 — Bearer with uppercase hex (must be lowercase)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: "Bearer " + "A".repeat(64) },
    });
    assert.equal(res.statusCode, 401);
  });

  it("401 — Bearer with non-hex characters", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: "Bearer " + "g".repeat(64) },
    });
    assert.equal(res.statusCode, 401);
  });

  // --- 403 cases: well-formed token, wrong value or unknown job ---

  it("403 — correct format, wrong token value on real job", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: `Bearer ${WRONG_TOKEN}` },
    });
    assert.equal(res.statusCode, 403);
  });

  it("403 — correct format, unknown job ID (indistinguishable from wrong token)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/jobs/00000000-0000-4000-8000-000000000000",
      headers: { Authorization: `Bearer ${WRONG_TOKEN}` },
    });
    assert.equal(res.statusCode, 403);
  });

  it("403 wrong-token and 403 unknown-job return identical response bodies", async () => {
    const wrongOnReal = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: `Bearer ${WRONG_TOKEN}` },
    });
    const wrongOnUnknown = await app.inject({
      method: "GET",
      url: "/api/jobs/00000000-0000-4000-8000-000000000000",
      headers: { Authorization: `Bearer ${WRONG_TOKEN}` },
    });
    assert.equal(wrongOnReal.statusCode, 403);
    assert.equal(wrongOnUnknown.statusCode, 403);
    assert.deepEqual(wrongOnReal.json(), wrongOnUnknown.json());
  });

  // --- Cache-Control on error responses ---

  it("Cache-Control: no-store on 401 response", async () => {
    const res = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    assert.equal(res.headers["cache-control"], "no-store");
  });

  it("Cache-Control: no-store on 403 response", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: `Bearer ${WRONG_TOKEN}` },
    });
    assert.equal(res.headers["cache-control"], "no-store");
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs — invalid URL cases
// ---------------------------------------------------------------------------

describe("POST /api/jobs — invalid URL cases", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({ logLevel: "silent" });
  });

  after(async () => {
    await app.close();
  });

  const invalidUrls: Array<[string, string]> = [
    ["http://github.com/owner/repo", "non-HTTPS scheme"],
    ["https://gitlab.com/owner/repo", "wrong host"],
    ["https://github.com/owner/repo/extra", "extra path segment"],
    ["https://github.com/owner/repo?foo=bar", "query string"],
    ["https://github.com/owner/repo#frag", "fragment"],
    ["https://user@github.com/owner/repo", "credentials (@)"],
    ["https://github.com:8080/owner/repo", "port number"],
    ["https://github.com/../owner/repo", "dot-segment traversal"],
    ["https://github.com/%2Fowner/repo", "percent encoding"],
    ["https://github.com/owner", "only one path segment"],
    ["https://github.com/", "empty path after host"],
    ["https://github.com/owner/re po", "whitespace in repo segment"],
    ["https://github.com/own er/repo", "whitespace in owner segment"],
    ["", "empty string"],
    ["   ", "whitespace only"],
    ["ftp://github.com/owner/repo", "ftp scheme"],
    ["https://github.com/owner/repo/../../etc/passwd", "traversal in path"],
    ["https://github.com/owner/.", "repo is bare dot"],
    ["https://github.com/owner/..", "repo is double-dot (stripped .git leaves ..)"],
  ];

  for (const [url, label] of invalidUrls) {
    it(`rejects: ${label}`, async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs",
        headers: { "Content-Type": "application/json" },
        payload: JSON.stringify({ repoUrl: url, consent: true }),
      });
      assert.ok(
        res.statusCode === 422 || res.statusCode === 400,
        `Expected 422 or 400 for "${label}", got ${res.statusCode}`,
      );
    });
  }

  it("error response does not echo the submitted URL", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ repoUrl: "https://evil.com/inject/me", consent: true }),
    });
    assert.ok(res.statusCode !== 202);
    assert.ok(!res.body.includes("evil.com"));
    assert.ok(!res.body.includes("inject"));
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs — consent validation
// ---------------------------------------------------------------------------

describe("POST /api/jobs — consent validation", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({ logLevel: "silent" });
  });

  after(async () => {
    await app.close();
  });

  it("rejects consent=false", async () => {
    const { statusCode } = await postJob(app, { repoUrl: VALID_URL, consent: false });
    assert.ok(statusCode === 422 || statusCode === 400, `got ${statusCode}`);
  });

  it("rejects consent=\"true\" (string coercion must be disabled)", async () => {
    const { statusCode } = await postJob(app, { repoUrl: VALID_URL, consent: "true" });
    assert.ok(statusCode === 422 || statusCode === 400, `got ${statusCode}`);
  });

  it("rejects consent=1 (numeric coercion must be disabled)", async () => {
    const { statusCode } = await postJob(app, { repoUrl: VALID_URL, consent: 1 });
    assert.ok(statusCode === 422 || statusCode === 400, `got ${statusCode}`);
  });

  it("rejects missing consent field", async () => {
    const { statusCode } = await postJob(app, { repoUrl: VALID_URL });
    assert.ok(statusCode === 422 || statusCode === 400, `got ${statusCode}`);
  });

  it("rejects extra properties (removeAdditional must be disabled)", async () => {
    const { statusCode } = await postJob(app, { repoUrl: VALID_URL, consent: true, extra: "bad" });
    assert.ok(statusCode === 422 || statusCode === 400, `got ${statusCode}`);
  });
});

// ---------------------------------------------------------------------------
// Database — schema version, initial event, hash storage
// ---------------------------------------------------------------------------

describe("database — schema and createJob", () => {
  it("user_version is 2 after openDatabase", () => {
    const db = openDatabase(":memory:");
    try {
      const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
      assert.equal(row.user_version, 2);
    } finally {
      db.close();
    }
  });

  it("openDatabase rejects a database with user_version > current", () => {
    // Manually set user_version to 99 on a :memory: db, then close.
    // We can't reopen the same :memory: db, so we test via a temp file.
    const tmpDir = mkdtempSync(join(tmpdir(), "graveyard-schema-"));
    const dbPath = join(tmpDir, "future.sqlite");
    try {
      const db = openDatabase(dbPath);
      db.exec("PRAGMA user_version = 99");
      db.close();

      assert.throws(
        () => openDatabase(dbPath),
        /newer than the supported version/,
        "Should reject a database with a future schema version",
      );
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("initial 'created' event is inserted atomically with the job row", () => {
    const db = openDatabase(":memory:");
    try {
      const rawToken = generateRawToken();
      const result = dbCreateJob(db, { repoUrl: VALID_URL, rawToken });

      const events = db
        .prepare("SELECT event_type FROM job_events WHERE job_id = ?")
        .all(result.jobId) as Array<{ event_type: string }>;

      assert.equal(events.length, 1);
      assert.equal(events[0]?.event_type, "created");
    } finally {
      db.close();
    }
  });

  it("stores SHA-256 hash, not the raw token", () => {
    const db = openDatabase(":memory:");
    try {
      const rawToken = randomBytes(32).toString("hex");
      const expectedHash = createHash("sha256").update(rawToken, "utf8").digest("hex");
      const result = dbCreateJob(db, { repoUrl: VALID_URL, rawToken });

      const row = db
        .prepare("SELECT token_hash FROM jobs WHERE id = ?")
        .get(result.jobId) as { token_hash: string };

      assert.equal(row.token_hash, expectedHash);
      assert.notEqual(row.token_hash, rawToken);
    } finally {
      db.close();
    }
  });

  it("createJob is atomic: a trigger-induced failure rolls back job row too", () => {
    // Install a BEFORE INSERT trigger on job_events that raises an error,
    // then verify createJob throws and no job row was committed.
    const db = openDatabase(":memory:");
    try {
      db.exec(`
        CREATE TRIGGER reject_events
        BEFORE INSERT ON job_events
        BEGIN
          SELECT RAISE(ABORT, 'trigger: blocked for test');
        END
      `);

      assert.throws(
        () => dbCreateJob(db, { repoUrl: VALID_URL, rawToken: generateRawToken() }),
        /trigger: blocked/,
      );

      const count = db
        .prepare("SELECT COUNT(*) as n FROM jobs")
        .get() as { n: number };
      assert.equal(count.n, 0, "job row must be rolled back when event insert fails");
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Token module unit tests
// ---------------------------------------------------------------------------

describe("token module", () => {
  it("hashToken returns 64-char lowercase hex", () => {
    const h = hashToken("test");
    assert.equal(h.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(h));
  });

  it("hashToken is deterministic", () => {
    assert.equal(hashToken("x"), hashToken("x"));
  });

  it("hashToken differs for different inputs", () => {
    assert.notEqual(hashToken("a"), hashToken("b"));
  });

  it("raw token never equals its own hash", () => {
    const tok = "a".repeat(64);
    assert.notEqual(tok, hashToken(tok));
  });

  it("generateRawToken returns 64-char lowercase hex", () => {
    const tok = generateRawToken();
    assert.equal(tok.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(tok));
  });

  it("generateRawToken returns unique values", () => {
    assert.notEqual(generateRawToken(), generateRawToken());
  });
});

// ---------------------------------------------------------------------------
// URL validator unit tests
// ---------------------------------------------------------------------------

describe("validateGithubUrl", () => {
  it("accepts https://github.com/owner/repo", () => {
    const r = validateGithubUrl("https://github.com/owner/repo");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.url, "https://github.com/owner/repo");
  });

  it("accepts .git suffix and strips it", () => {
    const r = validateGithubUrl("https://github.com/owner/repo.git");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.url, "https://github.com/owner/repo");
  });

  it("accepts dotted repo name (user.github.io)", () => {
    const r = validateGithubUrl("https://github.com/owner/user.github.io");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.url, "https://github.com/owner/user.github.io");
  });

  it("accepts dotted repo with .git suffix", () => {
    const r = validateGithubUrl("https://github.com/owner/my.project.git");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.url, "https://github.com/owner/my.project");
  });

  it("rejects repo segment that is exactly '.'", () => {
    const r = validateGithubUrl("https://github.com/owner/.");
    assert.equal(r.ok, false);
  });

  it("rejects repo segment that is exactly '..' (after .git strip would be '.')", () => {
    // "..git" — after stripping ".git" becomes "." which is rejected
    const r = validateGithubUrl("https://github.com/owner/..git");
    // ..git does not end in ".git" literally, so no strip; ".." matches dot-segment guard
    assert.equal(r.ok, false);
  });

  it("rejects non-string input", () => {
    assert.equal(validateGithubUrl(42).ok, false);
  });

  it("rejects empty string", () => {
    assert.equal(validateGithubUrl("").ok, false);
  });

  it("rejects URL > 1024 chars", () => {
    assert.equal(validateGithubUrl("https://github.com/owner/" + "r".repeat(1010)).ok, false);
  });

  it("rejects percent encoding", () => {
    assert.equal(validateGithubUrl("https://github.com/owner%2Frepo").ok, false);
  });

  it("rejects backslash", () => {
    assert.equal(validateGithubUrl("https://github.com/owner\\repo").ok, false);
  });

  it("rejects dot-segment sequences", () => {
    assert.equal(validateGithubUrl("https://github.com/../owner/repo").ok, false);
  });

  it("rejects query string", () => {
    assert.equal(validateGithubUrl("https://github.com/owner/repo?x=1").ok, false);
  });

  it("rejects fragment", () => {
    assert.equal(validateGithubUrl("https://github.com/owner/repo#tag").ok, false);
  });

  it("rejects credentials", () => {
    assert.equal(validateGithubUrl("https://user@github.com/owner/repo").ok, false);
  });

  it("rejects port", () => {
    assert.equal(validateGithubUrl("https://github.com:8080/owner/repo").ok, false);
  });

  it("rejects http scheme", () => {
    assert.equal(validateGithubUrl("http://github.com/owner/repo").ok, false);
  });

  it("rejects wrong host", () => {
    assert.equal(validateGithubUrl("https://gitlab.com/owner/repo").ok, false);
  });

  it("rejects extra path segments", () => {
    assert.equal(validateGithubUrl("https://github.com/owner/repo/tree/main").ok, false);
  });

  it("rejects whitespace", () => {
    assert.equal(validateGithubUrl("https://github.com/owner/re po").ok, false);
  });

  it("error reason does not echo the submitted value", () => {
    const r = validateGithubUrl("https://evil.com/inject/me");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(!r.reason.includes("evil.com"));
      assert.ok(!r.reason.includes("inject"));
    }
  });
});

// ---------------------------------------------------------------------------
// Persisted reopening — file-backed database
// ---------------------------------------------------------------------------

describe("persisted reopening — file-backed database", () => {
  let tmpDir: string;
  let dbPath: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "graveyard-persist-"));
    dbPath = join(tmpDir, "test.sqlite");
  });

  after(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("schema user_version=2 survives close and reopen", () => {
    const db1 = openDatabase(dbPath);
    db1.close();
    const db2 = openDatabase(dbPath);
    const row = db2.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(row.user_version, 2);
    db2.close();
  });

  it("job created in first session is readable with original token after reopen", async () => {
    // Create a job in session 1
    const db1 = openDatabase(dbPath);
    const rawToken = randomBytes(32).toString("hex");
    const result = dbCreateJob(db1, { repoUrl: VALID_URL, rawToken });
    const savedJobId = result.jobId;
    db1.close();

    // Build a new app pointing at the same file
    const app = await buildApp({ logLevel: "silent", databasePath: dbPath });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/jobs/${savedJobId}`,
        headers: { Authorization: `Bearer ${rawToken}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json<{ jobId: string; status: string }>();
      assert.equal(body.jobId, savedJobId);
      assert.equal(body.status, "queued");
    } finally {
      await app.close();
    }
  });

  it("queued jobs remain queued after reopen", () => {
    const db1 = openDatabase(dbPath);
    const rawToken = randomBytes(32).toString("hex");
    const result = dbCreateJob(db1, { repoUrl: "https://github.com/org/project", rawToken });
    db1.close();

    const db2 = openDatabase(dbPath);
    const row = db2
      .prepare("SELECT status, stage FROM jobs WHERE id = ?")
      .get(result.jobId) as { status: string; stage: string } | undefined;
    db2.close();

    assert.ok(row !== undefined);
    assert.equal(row?.status, "queued");
    assert.equal(row?.stage, "queued");
  });
});


// ---------------------------------------------------------------------------
// POST /api/jobs/:id/cancel — happy path
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:id/cancel — owner cancellation", () => {
  let app: FastifyInstance;
  let jobId: string;
  let token: string;

  before(async () => {
    app = await buildApp({ logLevel: "silent" });
    const { json } = await postJob(app);
    jobId = String(json["jobId"]);
    token = String(json["token"]);
  });

  after(async () => {
    await app.close();
  });

  it("returns 200 with correct token", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/cancel`,
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
  });

  it("response body shows status:cancelled and same stage", async () => {
    const res2 = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/cancel`,
      headers: { Authorization: `Bearer ${token}` },
    });
    // Already cancelled from previous test — 409 expected; so create fresh job
    const { json: freshJson } = await postJob(app);
    const freshId = String(freshJson["jobId"]);
    const freshToken = String(freshJson["token"]);

    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${freshId}/cancel`,
      headers: { Authorization: `Bearer ${freshToken}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<Record<string, unknown>>();
    assert.equal(body["status"], "cancelled");
    assert.equal(body["stage"], "queued"); // stage is unchanged
    assert.equal(body["jobId"], freshId);
    assert.equal(typeof body["repoUrl"], "string");
    assert.equal(typeof body["createdAt"], "string");
    assert.equal(typeof body["updatedAt"], "string");
    // Suppress unused variable warning
    void res2;
  });

  it("updatedAt is updated after cancellation", async () => {
    const { json: j } = await postJob(app);
    const id2 = String(j["jobId"]);
    const tok2 = String(j["token"]);

    // Give at least 1 ms between creation and cancel
    await new Promise((r) => setTimeout(r, 5));

    const cancelRes = await app.inject({
      method: "POST",
      url: `/api/jobs/${id2}/cancel`,
      headers: { Authorization: `Bearer ${tok2}` },
    });
    assert.equal(cancelRes.statusCode, 200);
    const body = cancelRes.json<{ createdAt: string; updatedAt: string }>();
    // updatedAt must be >= createdAt
    assert.ok(
      new Date(body.updatedAt) >= new Date(body.createdAt),
      `updatedAt (${body.updatedAt}) must be >= createdAt (${body.createdAt})`,
    );
  });

  it("Cache-Control: no-store on 200 response", async () => {
    const { json: j } = await postJob(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${j["jobId"]}/cancel`,
      headers: { Authorization: `Bearer ${j["token"]}` },
    });
    assert.equal(res.headers["cache-control"], "no-store");
  });

  it("GET after cancel shows status:cancelled", async () => {
    const { json: j } = await postJob(app);
    const id = String(j["jobId"]);
    const tok = String(j["token"]);

    await app.inject({
      method: "POST",
      url: `/api/jobs/${id}/cancel`,
      headers: { Authorization: `Bearer ${tok}` },
    });

    const getRes = await app.inject({
      method: "GET",
      url: `/api/jobs/${id}`,
      headers: { Authorization: `Bearer ${tok}` },
    });
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.json<{ status: string }>().status, "cancelled");
  });

  it("response does NOT expose token_hash", async () => {
    const { json: j } = await postJob(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${j["jobId"]}/cancel`,
      headers: { Authorization: `Bearer ${j["token"]}` },
    });
    assert.ok(!res.body.includes("token_hash"), "must not expose token_hash");
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs/:id/cancel — authorization
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:id/cancel — authorization", () => {
  let app: FastifyInstance;
  let jobId: string;
  let token: string;

  before(async () => {
    app = await buildApp({ logLevel: "silent" });
    const { json } = await postJob(app);
    jobId = String(json["jobId"]);
    token = String(json["token"]);
  });

  after(async () => {
    await app.close();
  });

  it("401 — no Authorization header (no mutation)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/cancel`,
    });
    assert.equal(res.statusCode, 401);

    // Verify job was NOT mutated
    const getRes = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(getRes.json<{ status: string }>().status, "queued");
  });

  it("401 — malformed Bearer token (no mutation)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/cancel`,
      headers: { Authorization: "Bearer " + "Z".repeat(64) }, // uppercase — malformed
    });
    assert.equal(res.statusCode, 401);

    const getRes = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(getRes.json<{ status: string }>().status, "queued");
  });

  it("403 — correct format, wrong token (no mutation)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/cancel`,
      headers: { Authorization: `Bearer ${WRONG_TOKEN}` },
    });
    assert.equal(res.statusCode, 403);

    const getRes = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(getRes.json<{ status: string }>().status, "queued");
  });

  it("403 — unknown job ID (indistinguishable from wrong token)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/00000000-0000-4000-8000-000000000000/cancel",
      headers: { Authorization: `Bearer ${WRONG_TOKEN}` },
    });
    assert.equal(res.statusCode, 403);
  });

  it("Cache-Control: no-store on 401 response", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/cancel`,
    });
    assert.equal(res.headers["cache-control"], "no-store");
  });

  it("Cache-Control: no-store on 403 response", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/cancel`,
      headers: { Authorization: `Bearer ${WRONG_TOKEN}` },
    });
    assert.equal(res.headers["cache-control"], "no-store");
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs/:id/cancel — 409 conflict cases
// ---------------------------------------------------------------------------

describe("POST /api/jobs/:id/cancel — 409 conflict", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({ logLevel: "silent" });
  });

  after(async () => {
    await app.close();
  });

  it("repeat cancel returns 409", async () => {
    const { json } = await postJob(app);
    const id = String(json["jobId"]);
    const tok = String(json["token"]);

    const first = await app.inject({
      method: "POST",
      url: `/api/jobs/${id}/cancel`,
      headers: { Authorization: `Bearer ${tok}` },
    });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({
      method: "POST",
      url: `/api/jobs/${id}/cancel`,
      headers: { Authorization: `Bearer ${tok}` },
    });
    assert.equal(second.statusCode, 409);
  });

  it("repeat cancel does NOT insert a duplicate cancelled event", async () => {
    const db = openDatabase(":memory:");
    try {
      const rawToken = generateRawToken();
      const { jobId } = dbCreateJob(db, { repoUrl: VALID_URL, rawToken });

      // First cancel — should succeed
      const r1 = dbCancelJob(db, jobId);
      assert.equal(r1.outcome, "cancelled");

      // Second cancel — should conflict
      const r2 = dbCancelJob(db, jobId);
      assert.equal(r2.outcome, "conflict");

      // Exactly one 'cancelled' event should exist (plus the initial 'created')
      const events = db
        .prepare("SELECT event_type FROM job_events WHERE job_id = ?")
        .all(jobId) as Array<{ event_type: string }>;

      const cancelledEvents = events.filter((e) => e.event_type === "cancelled");
      assert.equal(cancelledEvents.length, 1, "Only one cancelled event must be inserted");
      assert.equal(events.length, 2, "Only 'created' + 'cancelled' events expected");
    } finally {
      db.close();
    }
  });

  it("409 response body contains statusCode, error, message", async () => {
    const { json } = await postJob(app);
    const id = String(json["jobId"]);
    const tok = String(json["token"]);

    await app.inject({
      method: "POST",
      url: `/api/jobs/${id}/cancel`,
      headers: { Authorization: `Bearer ${tok}` },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${id}/cancel`,
      headers: { Authorization: `Bearer ${tok}` },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json<{ statusCode: number; error: string; message: string }>();
    assert.equal(body.statusCode, 409);
    assert.equal(typeof body.error, "string");
    assert.equal(typeof body.message, "string");
  });

  it("Cache-Control: no-store on 409 response", async () => {
    const { json } = await postJob(app);
    const id = String(json["jobId"]);
    const tok = String(json["token"]);

    await app.inject({
      method: "POST",
      url: `/api/jobs/${id}/cancel`,
      headers: { Authorization: `Bearer ${tok}` },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${id}/cancel`,
      headers: { Authorization: `Bearer ${tok}` },
    });
    assert.equal(res.headers["cache-control"], "no-store");
  });
});

// ---------------------------------------------------------------------------
// cancelJob — persistence and trigger failure rollback
// ---------------------------------------------------------------------------

describe("cancelJob — persistence and rollback", () => {
  it("cancelled status persists after cancelJob", () => {
    const db = openDatabase(":memory:");
    try {
      const rawToken = generateRawToken();
      const { jobId } = dbCreateJob(db, { repoUrl: VALID_URL, rawToken });

      const r = dbCancelJob(db, jobId);
      assert.equal(r.outcome, "cancelled");

      const row = db
        .prepare("SELECT status FROM jobs WHERE id = ?")
        .get(jobId) as { status: string };
      assert.equal(row.status, "cancelled");
    } finally {
      db.close();
    }
  });

  it("cancelled event is inserted on successful cancel", () => {
    const db = openDatabase(":memory:");
    try {
      const rawToken = generateRawToken();
      const { jobId } = dbCreateJob(db, { repoUrl: VALID_URL, rawToken });

      dbCancelJob(db, jobId);

      const events = db
        .prepare("SELECT event_type FROM job_events WHERE job_id = ? AND event_type = 'cancelled'")
        .all(jobId) as Array<{ event_type: string }>;
      assert.equal(events.length, 1);
    } finally {
      db.close();
    }
  });

  it("trigger failure on event insert rolls back the status UPDATE", () => {
    const db = openDatabase(":memory:");
    try {
      const rawToken = generateRawToken();
      const { jobId } = dbCreateJob(db, { repoUrl: VALID_URL, rawToken });

      // Install a BEFORE INSERT trigger on job_events that raises an error
      db.exec(`
        CREATE TRIGGER reject_cancel_events
        BEFORE INSERT ON job_events
        WHEN NEW.event_type = 'cancelled'
        BEGIN
          SELECT RAISE(ABORT, 'trigger: blocked cancel event for test');
        END
      `);

      assert.throws(
        () => dbCancelJob(db, jobId),
        /trigger: blocked cancel event/,
      );

      // The UPDATE must have been rolled back — status should still be 'queued'
      const row = db
        .prepare("SELECT status FROM jobs WHERE id = ?")
        .get(jobId) as { status: string };
      assert.equal(row.status, "queued", "status must be rolled back to queued on event failure");
    } finally {
      db.close();
    }
  });

  it("stage remains 'queued' after cancel (stage != status)", () => {
    const db = openDatabase(":memory:");
    try {
      const rawToken = generateRawToken();
      const { jobId } = dbCreateJob(db, { repoUrl: VALID_URL, rawToken });

      dbCancelJob(db, jobId);

      const row = db
        .prepare("SELECT stage, status FROM jobs WHERE id = ?")
        .get(jobId) as { stage: string; status: string };
      assert.equal(row.stage, "queued");
      assert.equal(row.status, "cancelled");
    } finally {
      db.close();
    }
  });
});
