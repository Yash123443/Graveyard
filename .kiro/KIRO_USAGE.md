# Kiro CLI Usage Record

Factual summary. Not a verbatim log or transcript.

## Account snapshot (observed 2026-11-07)

| Field | Value |
|---|---|
| Used | 15.51 of 50 (estimated) |
| Remaining | ~34.49 |
| Reset | 2026-12-01 |

This is a historical account snapshot, not a current balance or per-project billing figure. Subsequent calls may be service-throttled. No eligibility or scoring guarantee.

## Credit policy

One bounded Kiro CLI request per small milestone. Supply focused context. Review locally before requesting another generation. Do not spend credits to increase usage. Exact remaining balance is not known to this workflow at request time.

## Contributions to this project

### Foundation milestone (2026-11-06)

One bounded request. Kiro read the backend requirements and design, then created: `backend/package.json`, TypeScript configuration, Fastify app, environment validation, server startup/shutdown, 16 tests, `.env.example`, and `README.md`. Kiro was instructed to write only under `backend/` and not run shell commands or modify the frontend.

External review applied corrections (Fastify version pin, error handler adaptation, logging config, lock file, test command simplification). Those revisions are not attributed to Kiro.

Verified externally: build passed, 16 tests passed on Node 26.7.0, health endpoint returned HTTP 200.

### Job persistence milestone — initial (2026-11-07)

One bounded request. Kiro implemented: `node:sqlite` db module, token utilities, URL validator, jobs repository, `POST /GET /api/jobs` route handlers, `DATABASE_PATH` config, app wiring, and tests. The test suite had not been executed before external review.

### Job persistence milestone — corrections (2026-11-07)

One bounded request. Kiro applied corrections identified by external review: AJV coercion options, body limit, log redaction, migration rollback safety, future-schema rejection, `Cache-Control` hook, strict Bearer regex, constant-time 403 for wrong/unknown token, URL dot-segment handling, and full ESM test rewrite. See `backend/DEVELOPMENT.md` for the detailed correction list.

### Cancel endpoint and cleanup (2026-11-07)

One bounded request. Kiro authored: `cancelJob` in `src/jobs.ts`, `POST /api/jobs/:id/cancel` route, `setErrorHandler` fix (AJV → 422), URL dot-segment guard removal, cancel test suites, and documentation updates. Last externally verified baseline before this request: 101 tests passed.

### Type error fixes (2026-11-07, verified externally)

One bounded request. Kiro resolved two TypeScript build blockers identified from the previous session:

**`src/app.ts` — `setErrorHandler` unknown narrowing:**
Fastify 5's `setErrorHandler` types `error` as `unknown` by default (`TError = unknown`). The existing handler used `"validation" in error` and `error instanceof Error && "statusCode" in error` directly on `unknown`, which `tsc` rejects. Fix: introduced an `errorObj: object | null` narrowing via `error instanceof Error ? error : null`, then rewrote all `in` checks and property accesses to operate on `errorObj` (with null guards).

**`src/jobs.ts` — `cancelJob` SQLite cast errors (TS2352):**
`DatabaseSync.prepare().get()` returns `StatementResultingRows`, not `JobRow`. Both `selectJob.get(jobId) as JobRow` casts were TS2352. Fix: removed the local `selectJob` prepared statement entirely and replaced both call sites with `findJobById(db, jobId)` (the existing helper that already handles the cast via `unknown`). Added explicit null-guard throws after each call. Transaction rollback logic and auth are unchanged.

Externally verified on 2026-11-07, Node 26.7: `tsc -p tsconfig.json` exit 0; `tsc -p tsconfig.test.json` exit 0; `node --test dist-test/test/*.js` 121 passed, 0 failed.

### Worker lease primitives milestone (2026-11-11)

One bounded request. Kiro wrote only under `backend/` and `.kiro/`: schema v2 additive migration in `src/db.ts`, `src/leases.ts` (claim, heartbeat, fencing, cleanup-confirmed recovery), `src/test/leases.test.ts` (two file-DB connections, stale tokens, preserved deadlines, migration, event rollback), the schema-version assertion update in `jobs.test.ts`, and README/.kiro documentation. No shell commands were run, so the build and tests have NOT been executed; results pending external verification. No worker loop or repository execution was added.

### Lease milestone focused fixes (2026-11-11)

One bounded request, backend and `.kiro/` only; no shell commands, frontend untouched. Changes:

- `src/leases.ts`: fixed the compile error where `ConfirmCleanupResult` expects `requeued` but `confirmRecoveryCleanup` returned `queued`; it now returns `status === "queued" ? "requeued" : status`.
- Added `listRecoveryRequired` (internal-only read of persisted jobId, recoveryToken, workerId for coordinator restart; never exposed via API or events).
- Added `expireQueuedDeadlines` (atomically moves queued jobs past their preserved deadline to `timed-out` with an event and infra metadata; running and fenced jobs unchanged).
- Tests added in `src/test/leases.test.ts` for both primitives.

Build and tests have NOT been executed; results pending external verification.

Notes recorded from the user:

- UI merge `8996b9f` is the latest `origin/UI` at `b426aef`; frontend build passed (as reported by the user).
- Historical Kiro balance snapshot, Nov 11: 23.65 of 50 used; bonus credits 1.85 of 4000 used, expires in 51 days. The bonus is a one-time grant, not monthly renewable. Snapshot only, not a current balance.

### Test fixes and SSE events endpoint (2026-11-11)

One bounded request, backend and `.kiro/` only; no shell commands, frontend untouched. Changes:

- `jobs.test.ts`: the reopen test now asserts schema `user_version` 2 (title and expectation).
- `leases.test.ts`: the deadline-cap heartbeat test now claims with `leaseMs = DEFAULT_DEADLINE_MS` so the lease is live at the late heartbeat; expired-lease rejection logic is unchanged.
- `GET /api/jobs/:id/events` (SSE): `src/routes/events.ts`, event read helpers in `src/jobs.ts`, wiring and test-tunable options in `src/app.ts`, `src/test/events.test.ts` (auth, Last-Event-ID, replay, cancellation, terminal close, paging, backpressure, cleanup, and real-HTTP tests on an ephemeral port). No worker execution was added.

The new code and tests were authored, NOT compiled or executed; results pending external verification (the real-HTTP tests may need an external run). Last externally reported baseline: compile passes, 143/145 tests, before the two fixes above.

### External verification and final status (2026-11-11)

Recorded from the user's external checks; Kiro ran no commands for this update (docs-only, no source edits).

- Frontend production build passed after merge `8996b9f` (`origin/UI` at `b426aef`).
- Backend: both `tsc` builds pass; 162 tests, 0 failures, including real HTTP SSE tests (replay, live cancel, stream cap, shutdown, heartbeat, backpressure).
- Docker 29.9.2 running; UI on 127.0.0.1:3000; backend was starting on 3002.
- The "NOT executed / pending external verification" notes in the lease and SSE entries above are historical; they are superseded by these results and left unedited.
- All source changes for the lease and SSE milestones were authored by Kiro; the external assistant provided review and test runs.
- Scope: lease/recovery library primitives and SSE only. No execution worker, automatic cleanup, sandbox runner, real agents, result/patch endpoints, or frontend–backend connection exists yet.

### Frontend repair workspace (2026-11-11)

One bounded request, frontend and `.kiro/` only; no shell commands, no backend edits, no lockfile or dependency changes. Kiro authored: hash router (`src/AppRouter.tsx`, `src/IntroRoute.tsx`) with a lazy-loaded intro, intro teardown (pointer lock, gate/ambient audio via the existing public API, held keys), an accessible skip-intro link, the finale link "OPEN REPAIR WORKSPACE" replacing the dead GitHub button, and `src/workspace/` (API client, session-only credential store, incremental SSE parser, job hook with abortable backoff reconnect, UI, scoped CSS). Also the Vite `/api` proxy (only `/api/health` rewritten) and `scripts/verify-workspace.mjs`.

The code, type-check, build and the verification script were NOT executed by Kiro; results pending external verification.

## Prompting guidelines

- Provide a single, bounded implementation request per session.
- Include only the files directly relevant to the task as context.
- State explicitly what Kiro must not touch (e.g. frontend, shell commands).
- After each request, review output locally and record results in `backend/DEVELOPMENT.md` before requesting the next milestone.
- Mark documentation as factual summaries; do not ask Kiro to reproduce transcripts or invent prompts.
