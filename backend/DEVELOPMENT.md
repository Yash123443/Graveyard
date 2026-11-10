# Backend development record

Project owner: Yash. Branch: backend.

## 2026-11-06 — foundation milestone

One bounded Kiro CLI implementation request read the backend requirements/design and created the package, TypeScript configuration, Fastify app, environment validation, server startup/shutdown, 16 tests, environment example and README. Kiro was instructed to write only under backend/ and not run shell commands or modify the frontend.

Review revisions: upgraded Kiro's Fastify 5.4.0 pin to 5.12.8 after the dependency audit reported vulnerabilities; adapted the error handler for unknown error types and generic client messages; removed deprecated logging configuration; ignored compiled test artifacts; clarified isolated installation and simplified the test command. Dependency installation generated backend/pnpm-lock.yaml with pnpm 10.12.1.

Verification: backend TypeScript build passed; 16 tests passed on Node 26.7.0; production dependency audit reported no known vulnerabilities. A temporary localhost server returned HTTP 200 with the expected health JSON. These checks establish only the foundation, not repository diagnosis or repair.

---

## 2026-11-07 — job persistence milestone (initial)

One bounded Kiro CLI request implemented: node:sqlite db module, token utilities, URL validator, jobs repository, POST/GET route handlers, DATABASE_PATH config, app wiring, and tests. See files listed in the correction entry below.

---

## 2026-11-07 — job persistence milestone corrections

A second bounded Kiro CLI request applied corrections following external review of the initial implementation. The test suite had not yet been executed; failures were identified by review, not by a run.

### Corrections applied by Kiro

**app.ts**
- Added `ajv.customOptions: { coerceTypes: false, removeAdditional: false }`.  Without this, Fastify's default AJV instance coerces `"true"` to `true` (passing the boolean consent schema) and silently strips extra properties.
- Added `bodyLimit: 8192` (8 KiB).  Requests exceeding this limit receive 413.
- Added `logger.redact: ["req.headers.authorization"]` so the raw Bearer token never appears in logs.
- Removed incorrect claim that node:sqlite was stabilised on Node.js 22.13.0; the API is experimental on Node.js 22.x.

**db.ts**
- `openDatabase` now closes the handle and re-throws if any pragma or migration step fails, so callers never receive a partially-initialised database.
- `migrate_v1` now uses explicit `BEGIN` / `COMMIT` / `ROLLBACK` statements (not `db.exec` multi-statement) so a migration failure rolls back cleanly.
- `runMigrations` now throws if the on-disk `user_version` exceeds `CURRENT_SCHEMA_VERSION`, preventing a newer-build database from being silently opened by an older build.

**routes/jobs.ts**
- Added an `onRequest` hook that sets `Cache-Control: no-store` on every `/api/jobs*` response, including error replies produced by Fastify before the handler runs (schema validation failures, body-limit errors).
- Replaced the previous ad-hoc Authorization checks with a strict regex `/^Bearer [0-9a-f]{64}$/`.  Any header that does not match (missing, wrong scheme, wrong length, uppercase hex, non-hex) returns 401.
- Both "wrong token on a real job" and "unknown job ID with a well-formed token" now return 403 with an identical body.  When the job is not found, a constant-time comparison against a static dummy hash is performed, so timing cannot distinguish the two cases.  Removed previous false claim that a 404 is safe because the caller "proved" something.

**url.ts**
- Repository segment now uses `/^[A-Za-z0-9_.-]+$/` to permit dots (e.g. `user.github.io`, `my.project`).  The exact strings `.` and `..` are rejected explicitly.  The `./` and `..` substring guards still reject dot-segment traversal sequences.
- Owner segment retains `/^[A-Za-z0-9][A-Za-z0-9_-]*$/` (no dots; GitHub enforces this for org/user names).  Must also start with alphanumeric to reject leading-hyphen names.

**.env.example**
- Added `DATABASE_PATH` entry with default value and comment.

**jobs.test.ts** (full rewrite to remove `require()` calls in ESM and add missing cases)
- All imports are top-level ESM; removed inline `require()` closures that were incorrect in an ESM module.
- Uses production `createJob` (imported from `../jobs.js`) for all direct-DB tests; no duplicate SQL implementation.
- Auth tests reflect corrected model: 401 for malformed header; 403 for both wrong-token on real job and well-formed token on unknown job; test verifies identical response bodies for both 403 cases.
- Added: oversized body → 413; dotted repo name accepted; close/reopen app with original token → 200; future schema version rejection; atomic rollback test using a trigger on `job_events`.

### Tests pending re-execution

The corrected test suite compiles to `dist-test/test/*.js`.  Tests must be run locally via `pnpm test` on Node.js ≥ 22.13.0.  Results are not available in this record; Kiro was instructed not to run shell commands.  Human review and a local test run are required before merging.

---

## 2026-11-07 — cancel endpoint and cleanup (Kiro authored)

A bounded Kiro CLI request applied the following changes.  All edits are Kiro-authored; external review and a local test run are required before merging.  Last externally verified baseline: 101 tests passed.

### Changes

**src/jobs.ts**
- Added `cancelJob(db, jobId)`: conditional UPDATE `status = 'queued' → 'cancelled'` and INSERT of a `cancelled` event in a single atomic transaction.  Returns `{ outcome: "cancelled" | "conflict", job }`.  The `stage` column is deliberately unchanged.  Rollback covers both the UPDATE and the event INSERT; trigger-induced event failures leave status as `queued`.

**src/routes/jobs.ts**
- Added `POST /api/jobs/:id/cancel` route with identical Bearer auth to GET (401 malformed, 403 wrong/unknown token).  200 returns updated metadata; 409 when `cancelJob` returns conflict (already cancelled, terminal, or running).  Covered by the shared `Cache-Control: no-store` hook.

**src/app.ts**
- Fixed `setErrorHandler`: AJV schema validation errors (statusCode 400 with a `validation` array) are now mapped to 422.  Body-size errors (413 from Fastify's `bodyLimit`) pass through unchanged.

**src/url.ts**
- Removed the raw substring dot-segment guard (`raw.includes('./') || raw.includes('..')`).  Exact dot-segment rejection (`.` and `..` as repo names) is handled at the segment-validation step.  Traversal sequences like `/../` or `/owner/..` are caught by the segment count check or the exact-name check without a raw scan, allowing normal dotted names such as `user.github.io`.

**src/test/jobs.test.ts**
- Added cancel test suites: owner cancellation (200, stage unchanged, updatedAt updated, GET reflects cancelled, no token_hash exposure), auth cases (401/403 no mutation, Cache-Control), 409 conflict cases (repeat cancel, no duplicate event, response shape, Cache-Control), and DB-level persistence / trigger-rollback tests for `cancelJob`.
- Added import for `cancelJob as dbCancelJob` from `../jobs.js`.

**README.md / DEVELOPMENT.md**
- Endpoint table and docs updated to include `POST /api/jobs/:id/cancel`.
- Cancel moved out of the "not yet implemented" section.
- DEVELOPMENT.md updated with this entry.



---

## 2026-11-11 — lease primitives and SSE events: final status

Docs-only update; no source edits.

### Implemented (Kiro-authored; externally reviewed and tested)

- Schema v2 additive migration and lease/recovery library primitives in `src/leases.ts` (atomic claim, heartbeat, fencing, cleanup-confirmed requeue, `listRecoveryRequired`, `expireQueuedDeadlines`), with tests in `src/test/leases.test.ts`.
- `GET /api/jobs/:id/events` SSE endpoint (`src/routes/events.ts`, event helpers in `src/jobs.ts`, options in `src/app.ts`) with tests in `src/test/events.test.ts`.

### External verification (2026-11-11)

- Frontend production build passed after merge `8996b9f` (`origin/UI` at `b426aef`).
- Backend: both `tsc` builds pass; 162 tests, 0 failures, including real HTTP SSE tests: replay, live, cancel, stream cap, shutdown, heartbeat, backpressure.
- Docker 29.9.2 running. UI on 127.0.0.1:3000; backend starting on 3002.
- Earlier entries stating tests were not executed are historical and unchanged.

### Not implemented

Execution worker/loop, automatic cleanup and restart-recovery coordinator, sandbox runner, real agents, result/patch endpoints, frontend–backend connection. Nothing in the running server calls the lease primitives yet.
