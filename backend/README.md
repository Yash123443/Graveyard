# GRAVEYARD backend

Node.js / TypeScript / Fastify API for the GRAVEYARD automated dependency-repair service.

Recommended Node.js: **22 LTS** (minimum 22.13.0; tested locally on 26.7.0).  
Package manager: **pnpm 10.12.1** (declared in `packageManager` field).

> **Note on node:sqlite:** this package uses the built-in `node:sqlite` module
> (`DatabaseSync`), which is compiled into the Node.js binary.  No native add-on
> installation is required.  The API is **experimental on Node.js 22.x**; the
> declared engine minimum (22.13.0) is the first release that includes it.
> The project was developed and tested on Node.js 26.7.0.

---

## Quick start (PowerShell)

### 1. Install dependencies

```powershell
cd backend
pnpm install --ignore-workspace
```

### 2. Configure environment

```powershell
Copy-Item .env.example .env
# Edit .env if you need non-default values
```

No `dotenv` package is needed. Node.js 20.6+ supports `--env-file` natively.

### 3. Build

```powershell
pnpm build
# Compiles src/ → dist/ using tsc (NodeNext modules, strict mode)
```

### 4. Start

```powershell
pnpm start
# Equivalent: node --env-file=.env dist/server.js
```

The server prints its bound address via structured JSON logging (pino).  
Default: `http://127.0.0.1:3002`

The `data/` directory (containing the SQLite database) is created automatically
on first startup.  It is git-ignored; do not commit it.

### 5. Test

```powershell
pnpm test
# Compiles src/ (including src/test/) → dist-test/, then:
# node --test dist-test/test/*.js
```

Tests use `node:test` (built-in) and `fastify.inject`; the SSE suite also binds
ephemeral `127.0.0.1` ports for real HTTP streaming tests.
All tests run against an in-memory SQLite database; no files are created except
in the `persisted reopening` test group, which cleans up its own temp directory.

---

## Available endpoints (this milestone)

| Method | Path                    | Auth            | Description                              |
| ------ | ----------------------- | --------------- | ---------------------------------------- |
| GET    | `/health`               | None            | Returns `{"status":"ok","version":"0.2.0"}` |
| POST   | `/api/jobs`             | None            | Create a job; returns jobId and a one-time token |
| GET    | `/api/jobs/:id`         | Bearer token    | Fetch job metadata (token required)      |
| POST   | `/api/jobs/:id/cancel`  | Bearer token    | Cancel a queued job (409 if not queued)  |
| GET    | `/api/jobs/:id/events`  | Bearer token    | SSE stream of persisted job events       |

### GET /api/jobs/:id/events (SSE)

Header: `Authorization: Bearer <token>` — **never** a query-string token.
Native `EventSource` cannot send headers, so use `fetch` streaming:

```js
const res = await fetch(`/api/jobs/${jobId}/events`, {
  headers: { Authorization: `Bearer ${token}`, "Last-Event-ID": String(lastId) }, // omit to start at 0
});
const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
// parse "id:", "event:", "data:" lines; lines starting with ":" are heartbeats
```

- Frames are stored rows: `id` (seq), `event` (type), `data` (stored JSON). No tokens.
- `Last-Event-ID` must be a non-negative safe integer no greater than the job's latest event; otherwise 422.
- 401 malformed/missing header, 403 wrong token or unknown job (checked before the stream starts), 429 when the per-process stream cap (32) is reached.
- Events are polled from SQLite in pages of 100 with `seq > cursor`; heartbeat comments every 15 s; polling pauses under backpressure.
- The stream closes after the final `completed`/`failed`/`cancelled`/`timed-out` event is delivered, or immediately if the job is terminal and the cursor is already at the last event. Timers are cleaned up on disconnect and on app close.
- No worker exists yet, so only `created` and `cancelled` events occur in practice.

### POST /api/jobs

Request body (JSON, `Content-Type: application/json`):

```json
{
  "repoUrl": "https://github.com/owner/repo",
  "consent": true
}
```

- `repoUrl` must be a literal HTTPS GitHub URL: `https://github.com/owner/repo`
  (optional `.git` suffix is accepted and stripped on storage).  No query
  strings, fragments, credentials, ports, percent-encoding, backslashes, dot
  segments, or extra path segments are accepted.
- `consent` must be the literal boolean `true` (not the string `"true"`, not `1`).
- Additional properties are rejected.

Success response — **202 Accepted**:

```json
{
  "jobId": "uuid-v4",
  "token": "64-char-hex",
  "status": "queued"
}
```

**The `token` is returned exactly once.  Store it immediately; it cannot be
recovered and is never logged or stored.**

### GET /api/jobs/:id

Header: `Authorization: Bearer <token>`

Success response — **200 OK**:

```json
{
  "jobId": "uuid-v4",
  "repoUrl": "https://github.com/owner/repo",
  "stage": "queued",
  "status": "queued",
  "createdAt": "2026-11-07T17:00:00.000Z",
  "updatedAt": "2026-11-07T17:00:00.000Z"
}
```

Error codes:

| Code | Condition |
| ---- | --------- |
| 401  | Authorization header missing or does not match `/^Bearer [0-9a-f]{64}$/` |
| 403  | Token is structurally valid but does not match the job, OR the job ID does not exist — both cases return an identical 403 response |

> The 403 response is intentionally identical for "wrong token on a real job"
> and "unknown job ID": callers cannot probe job existence via status codes or
> timing.

---

### POST /api/jobs/:id/cancel

Header: `Authorization: Bearer <token>`

Cancels a job that is in `queued` status.  Running jobs return 409 (worker
not yet implemented).

Success response — **200 OK** (same shape as GET /api/jobs/:id, with `status: "cancelled"`):

```json
{
  "jobId": "uuid-v4",
  "repoUrl": "https://github.com/owner/repo",
  "stage": "queued",
  "status": "cancelled",
  "createdAt": "2026-11-07T17:00:00.000Z",
  "updatedAt": "2026-11-07T17:30:00.000Z"
}
```

Error codes:

| Code | Condition |
| ---- | --------- |
| 401  | Authorization header missing or malformed (same rule as GET) |
| 403  | Token does not match the job, or job ID is unknown (same rule as GET) |
| 409  | Job is not in a cancellable state: already cancelled, terminal, or running |

The `stage` column is not changed by cancellation — it reflects the lifecycle
phase, not the execution state.  The status UPDATE and event INSERT are
committed atomically; a failure in the event INSERT rolls back the status
change.

---

## Configuration reference

Set via environment variables (or `.env` loaded with `--env-file`).

| Variable        | Default                      | Valid values                                          |
| --------------- | ---------------------------- | ----------------------------------------------------- |
| `PORT`          | `3002`                       | Integer 1–65535                                       |
| `HOST`          | `127.0.0.1`                  | Non-empty string; use `0.0.0.0` for all interfaces   |
| `LOG_LEVEL`     | `info`                       | `fatal` `error` `warn` `info` `debug` `trace` `silent` |
| `DATABASE_PATH` | `./data/graveyard.sqlite`    | Non-empty filesystem path, or `:memory:` for testing |

Invalid configuration causes the process to exit before binding the port,
printing a descriptive message without echoing secret values.

---

## Worker lease primitives (schema v2, library only)

`src/leases.ts` provides durable lease functions; no HTTP route or process
calls them yet, and no repository is executed. Schema v2 is an additive
migration of `jobs` (existing jobs and events are preserved): `worker_id`,
`lease_token`, `lease_expires_at`, `attempt_count` (default 0), `max_attempts`
(default 2), `started_at`, `deadline_at`, `recovery_required`, `recovery_token`,
`infra_error`.

- `claimNextJob` — `BEGIN IMMEDIATE`; queued → running with a random lease
  token; the first claim sets `deadline_at` (15 min) and later claims never
  reset it or the attempt count. The `claimed` event commits in the same transaction.
- `heartbeat` — accepted only for the matching, unexpired token on a running,
  non-fenced job before its deadline; leases never extend past the deadline.
- `fenceExpiredLeases` — voids expired lease tokens and sets `recovery_required`
  (job stays `running`; it is never requeued automatically).
- `confirmRecoveryCleanup` — requires the matching recovery token and a
  `confirmedBy` statement. Then: deadline passed → `timed-out`; attempts
  exhausted → `failed`; otherwise → `queued` (deadline and attempts preserved).
  Terminal outcomes store infrastructure metadata in `infra_error` and the event,
  never a repository diagnosis.

Limitations:

- This module cannot verify that a worker process or container was actually
  stopped; `confirmRecoveryCleanup` trusts the caller. No cleanup/sandbox
  component exists yet, so fenced jobs stay blocked until one is built.
- Nothing fences expired leases periodically; a coordinator must call
  `fenceExpiredLeases`. A job whose deadline passes stays `running` until fenced and confirmed.
- Lease/recovery tokens live in SQLite in plaintext (local single-host file only).
- `stage` is not advanced by claims; `running` jobs are not cancellable via the API (409).
- Tests were written but not yet executed by this workflow; pending external verification.

## Not yet implemented

The following features from `requirements.md` / `design.md` are **deferred to
future milestones** and are intentionally absent:

- `GET /api/jobs/:id/result` — RepairResult compatible with frontend
- `GET /api/jobs/:id/patch` — downloadable unified diff
- Worker process — no polling loop or execution exists; only lease primitives (see below)
- Sandbox — disposable Docker execution, resource limits, timeout (15 min default)
- Agent adapter — Analyst / Fixer / Tester phases; Kiro runtime feasibility outstanding
- Bounded log storage and truncation indicators
- Jobs are accepted and persisted but never executed — they remain in `queued` status
  indefinitely until a worker is implemented.  Cancellation is supported for queued jobs;
  running jobs return 409 until the worker exists.

---

## Project layout

```
backend/
├── src/
│   ├── config.ts           # Environment validation; fails fast before listen
│   ├── app.ts              # Fastify factory (buildApp); all routes and error handlers
│   ├── server.ts           # Entry point: loadConfig → buildApp → listen
│   ├── db.ts               # node:sqlite DatabaseSync lifecycle, WAL, migrations
│   ├── leases.ts           # Worker lease primitives (claim, heartbeat, fence, recovery)
│   ├── token.ts            # Cryptographic token utilities (generate, hash, verify)
│   ├── url.ts              # Strict GitHub HTTPS URL validator
│   ├── jobs.ts             # Jobs repository (prepared statements, transactions)
│   ├── routes/
│   │   ├── jobs.ts         # POST /api/jobs, GET /api/jobs/:id, cancel
│   │   └── events.ts       # GET /api/jobs/:id/events (SSE)
│   └── test/
│       ├── app.test.ts     # node:test suite for health, 404, config
│       └── jobs.test.ts    # node:test suite for job routes, DB, tokens, URL validator
├── data/                   # SQLite database (git-ignored; created on first start)
├── dist/                   # Compiled output (git-ignored; run pnpm build)
├── dist-test/              # Compiled test output (git-ignored; created by pnpm test)
├── .env.example            # Template — copy to .env
├── package.json
├── tsconfig.json           # Production build (src/ → dist/)
└── tsconfig.test.json      # Test build (src/ + src/test/ → dist-test/)
```
