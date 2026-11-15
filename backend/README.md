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
| GET    | `/api/jobs/:id/result`  | Bearer token    | Durable result view (see "Local worker") |

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
- Without the opt-in worker process running, only `created` and `cancelled` events occur. With it, `claimed`, `stage`, `result` and terminal events also appear.

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

## Execution worker foundation (library only, not wired, unverified)

`src/worker.ts` (`JobWorker`) and `src/runner.ts` (runner contract,
`UnavailableRunner`) add a single-job coordinator. Nothing in the server, no
process entry point and no polling loop instantiates it. It executes no
repository code, spawns nothing and uses no network.

- **Runner interface.** `JobRunner.run(ctx)` and `JobRunner.cleanup(req)` are
  injected. Cleanup must return `{ confirmed: true, executionId, evidence }`
  for that exact execution id; anything else (false, thrown, timed out,
  wrong id, empty evidence) counts as unproven.
- **Fenced writes.** `finishLeasedJob` (in `leases.ts`) requires the current
  lease token, an unexpired lease and an unpassed deadline. `fenceOwnLease`
  lets a holder void its own lease. Stale, fenced, expired or past-deadline
  writers are rejected with no side effects.
- **Heartbeat, deadline, shutdown.** Heartbeats run on an injected timer; a
  rejected heartbeat, the deadline or `shutdown()` aborts the runner's
  `AbortSignal`. After an abort the runner's result is discarded, even
  `completed`. A runner that ignores the abort is given a grace period, then
  cleanup is demanded anyway.
- **Cleanup before consequence.** Completion, failure, requeue and timeout are
  recorded only after valid cleanup proof. Without proof the job is fenced
  (`recovery_required`), blocked from claims, and gets one `cleanup-unconfirmed`
  event plus `infra_error`. `recoverOnce()` asks the runner for proof for every
  fenced job and calls `confirmRecoveryCleanup` only when proof is valid.
- **Atomic state and events.** Each transition commits job state and its event
  in one `BEGIN IMMEDIATE` transaction.
- **Production runner fails closed.** `UnavailableRunner.run` never starts
  anything and reports `infrastructure-unavailable`; the job ends `failed` with
  that infrastructure metadata and is never `completed`. Its `cleanup` proves
  "nothing started" only for execution ids it refused itself in the same
  process. For any other job (a crashed worker, an earlier process) it cannot
  prove cleanup, so such jobs stay blocked until a real sandbox runner exists.

Limitations:

- No sandbox exists. The `completed` path is exercised only with a fake runner
  in tests; no real analysis, result object or patch is produced, and a
  `completed` job has no result data.
- `completed` jobs get `stage = done`; no result endpoint exists yet.
- Running-job cancellation is not implemented.
- No poll loop, no periodic `recoverOnce`, no process signal handling.
- With the unavailable runner a job fails on its first attempt instead of
  being retried.
- `src/test/worker.test.ts` was written without running `tsc` or the tests
  (no shell was available). Pending external verification.

## GitHub repository flow (opt-in extension of the local worker)

On 2026-11-16 the live harness fetched the pinned `octocat/Hello-World` commit on Docker Desktop with
`alpine/git:2.47.2`, returned `unsupported-repository` to the authorized job owner, and confirmed cleanup.
See `DEVELOPMENT.md` for the mount fix and verification scope.

With the extra variables below the worker also accepts jobs for **operator-pinned public GitHub commits**. It
is off by default. Without the variables the worker is fixtures-only and no egress guard ever attests.

What a pinned job does:

1. `cloning`: fetches exactly the pinned commit (a full 40-hex SHA, never a branch) inside a disposable
   container on an operator-provisioned `--internal` network whose only exit is a `github.com`-only proxy.
   The tree policy (no symlinks, no unsafe or case-colliding paths, size and file limits) is checked before
   checkout. The host never receives the repository; it reads four root files (`package.json`,
   `package-lock.json`, `build.mjs`, `test.mjs`, each at most 64 KiB) as raw git blobs.
2. `analyzing`: a pure check against the supported class. Unsupported repositories **complete** with verdict
   `unsupported-repository` (outcome `unsupported-repository`) and the exact findings. Nothing is built or run.
3. `building`/`testing`: only for the supported class, and only if registry egress is configured. Dependencies
   are fetched with `npm ci --ignore-scripts` through a `registry.npmjs.org`-only proxy into a host-verified
   cache, then the existing network-`none` offline install, build and test run in one disposable container.
   Repository code (`build.mjs`, `test.mjs`) runs only there, never on the host. The Tester, and optionally the
   agents, then act exactly as for fixtures. A diagnosis or patch proposal is never applied.

**Supported class (narrow on purpose):** root `package.json` that passes the strict operator policy
(`npm-operator-fixture.ts`: allowlisted fields, **no `scripts`**, no workspaces or overrides, production
dependencies only), a lockfileVersion 3 `package-lock.json` with at most 8 flat unscoped registry packages
(sha512, registry.npmjs.org URLs), and a root `build.mjs`. Because `scripts` are not allowed, ordinary npm
projects are reported as unsupported with the specific reason. That is a limit of this slice, not a statement
about the repository.

Everything else is explicit: an unpinned URL fails as `infrastructure-unavailable` (nothing fetched); a refused
or unverifiable egress, missing Docker, a failed git step, unconfirmed cleanup or an inconclusive pipeline fails
the job with no result; a tree rejected by the acquisition policy is reported as `unsupported-repository`.

### Variables

| Variable | Meaning |
|---|---|
| `GRAVEYARD_GITHUB_CATALOG` | Absolute path of a JSON file `{ "<canonical repo URL>": "<40-hex commit>" }` (at most 50 entries, 16 KiB). A URL may not also be in the fixture catalog. Setting any variable below requires this one. |
| `GRAVEYARD_GITHUB_RUNS_ROOT` | Existing worker-owned directory, separate from the fixtures, staging and cache roots. One `run-<hex>` directory per job, removed before the job ends. |
| `GRAVEYARD_GITHUB_GIT_IMAGE` | Set this to a locally provisioned image with `git` and `sleep` and no declared Docker volumes. The worker never pulls it. The current fallback, `alpine/git:2.47.2`, declares `/git` and fails the acquisition mount check. |
| `GRAVEYARD_GITHUB_EGRESS_NETWORK`, `_PROXY_CONTAINER`, `_PROXY_URL` | Required. Internal network, proxy container name and `http://<private IPv4>:<port>` of the github.com-only proxy. |
| `GRAVEYARD_REGISTRY_EGRESS_NETWORK`, `_PROXY_CONTAINER`, `_PROXY_URL` | Optional, all three or none. The registry.npmjs.org-only counterpart; must use a different network and container. Without it a supported repository is reported as not runnable. |

### Operator-provisioned egress (the worker builds none of this)

Per target host, outside the worker (see `src/test/manual-clone-check.ts` for a working shape of the first two steps):

1. `docker network create --driver bridge --internal --subnet 10.201.5.0/24 graveyard-gh-net`
2. Run a proxy container (image with `node`, compiled `egress-proxy.js`, `acquisition-policy.js`, `url.js` and a
   small runner calling `new EgressProxy({ bindHost, port, target })`; `target` is `github.com` by default or
   `registry.npmjs.org`) created on that network with a fixed address (`--ip 10.201.5.10`), then also attached
   to a network with upstream access (`docker network connect bridge ...`), with the label
   `graveyard.egress-proxy=<host>`.
3. Repeat with another network and subnet for `registry.npmjs.org`.

On every acquisition the guard (`egress-guard.ts`) re-checks with `docker inspect` that the network is Internal and
IPv4, the proxy container is running with the right label and address, and asks the proxy from inside its
container for `CONNECT example.com:443` and for the other supported host; both must answer `403`. That is a
narrow spot-check of an operator-provisioned topology. It does not prove isolation, that the allowed host is
reachable, that the proxy is the expected code, or that nothing else sits on the network.

### Manual end-to-end check (opt-in)

```powershell
$env:GRAVEYARD_GITHUB_E2E_GIT_IMAGE = "graveyard-git-fixture:local"
pnpm run test:github-e2e
```

Use the example tag if that fixture image is already installed, or set the variable to your own locally
provisioned Git image with no declared volumes. The live check passed with the example tag on Docker Desktop 29.9.2.

Skipped by `pnpm test`. It creates its own temporary internal network and github.com-only proxy, starts the real API
and worker with one pin (octocat/Hello-World at `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`), expects the job to
complete as `unsupported-repository` (the repository has no package files), checks the authenticated
`GET /api/jobs/:id/result`, and verifies that no container, network or temporary directory remains. It needs a
running Docker daemon, local `node:22-alpine` and git images (nothing is pulled) and outbound access to
`github.com:443`; it fails closed otherwise. No registry, no agents, no repository code is executed. See
`DEVELOPMENT.md` ("GitHub flow end-to-end harness").

## Local worker (opt-in, separate process; tested with mocked Docker, and verified end to end once on real Docker for one controlled fixture, 2026-11-15)

The API server never starts a worker. Jobs stay `queued` until an operator
starts the worker process on the same host and database file. It is **disabled
unless `GRAVEYARD_WORKER_ENABLED` is exactly `1`**; otherwise it prints why and
exits with code 2 without opening anything.

It runs only operator-prepared fixtures. Arbitrary and untrusted repositories
stay disabled: a job whose repository URL is not in the operator catalog fails
as `infrastructure-unavailable`, and nothing is cloned, fetched or run. Fixture
code runs only inside the existing disposable Docker container (network `none`,
non-root, read-only root, offline `npm ci`, build and test). Nothing runs on
the host.

### Operator setup (PowerShell, from `backend/`)

1. Prepare one directory per fixture under a fixtures root. Each needs
   `package.json`, `package-lock.json` (must pass the lock policy: registry
   tarballs, sha512 integrity, no install scripts), `build.mjs` and optionally
   `test.mjs`. Prepare an offline npm cache that holds exactly the lockfile's
   tarballs. Have `node:22-alpine` available locally (it is never pulled).
2. Write the catalog, a JSON file mapping canonical repository URLs to fixture
   directory names (at most 50 entries, 16 KiB):
   ```json
   { "https://github.com/octocat/Hello-World": "hello-fixture" }
   ```
3. Build and start (Docker must be running):
   ```powershell
   pnpm run build
   $env:GRAVEYARD_WORKER_ENABLED = "1"
   $env:GRAVEYARD_FIXTURES_ROOT = "C:\abs\fixtures"
   $env:GRAVEYARD_STAGING_ROOT = "C:\abs\staging"      # existing, worker-owned
   $env:GRAVEYARD_NPM_CACHE_DIR = "C:\abs\npm-cache"
   $env:GRAVEYARD_FIXTURE_CATALOG = "C:\abs\catalog.json"
   node dist/worker-main.js      # or `pnpm run worker` with the variables in .env
   ```
   Use the same `DATABASE_PATH` as the API (run both from `backend/` or give an
   absolute path). The database must be a local file, never a network share.

Optional variables and ranges: `GRAVEYARD_WORKER_ID`, `GRAVEYARD_WORKER_POLL_MS`
(250 to 60000, default 2000), `GRAVEYARD_WORKER_RECOVER_MS` (5000 to 600000,
default 30000), `GRAVEYARD_WORKER_BATCH` (1 to 20, default 5),
`GRAVEYARD_WORKER_SHUTDOWN_MS` (1000 to 120000, default 45000),
`GRAVEYARD_WORKER_AGENTS` (`off` default, `kiro-v2`, `kiro-v3`; anything other
than `off` sends bounded, redacted evidence to Kiro's service), `LOG_LEVEL`.
Invalid values, missing directories, a catalog fixture without its files, or a
missing compiled driver stop the start with exit code 1 before the database is
opened.

### Behaviour

- One job at a time; at most `GRAVEYARD_WORKER_BATCH` jobs per pass; sleeps the
  poll interval when idle; exponential backoff (capped at 60 s) after errors.
- If `docker version` does not answer, no job is claimed and queued jobs stay
  queued. A daemon that disappears mid-run fails that job closed.
- Every job ends only after cleanup of its container is proven. Unproven cleanup
  leaves the job blocked (still `running`, never `completed`) for an operator.
- SIGINT or SIGTERM: the active job is aborted and settled (requeued only with
  cleanup proof), the loop ends, the database closes, exit code 0. A second
  signal or the watchdog exits with code 1.
- Logs are JSON lines on stderr and never contain job tokens.

### GET /api/jobs/:id/result

Header: `Authorization: Bearer <token>` (401 malformed, 403 wrong or unknown,
identical 403 bodies, `Cache-Control: no-store`). Always 200 for an authorized
caller:

```json
{
  "jobId": "uuid", "status": "completed", "stage": "done", "terminal": true,
  "outcome": "failing-with-patch-proposal",
  "summary": "The fixture fails. A model-authored patch was proposed. It was not applied and not verified.",
  "repair": { "verified": false, "patchApplied": false, "patchProposed": true, "diagnosed": true },
  "result": { "verdict": "repository-failing", "...": "stored payload of the final attempt" },
  "infrastructure": null
}
```

`outcome` is one of `pending`, `passing`, `failing-with-patch-proposal`,
`failing-with-diagnosis`, `failing-undiagnosed`, `tests-not-run`,
`infrastructure-failed`, `timed-out`, `cancelled`, `completed-without-result`.

- `result` is present only for a `completed` job and is the final attempt's
  stored payload. It is durable (a `job_events` row). A blocked, running,
  failed or timed-out job never exposes one.
- `passing` means the **unmodified** fixture built and passed its tests. It is
  not a repair. `tests-not-run` is not a verification.
- A diagnosis or patch proposal is model-authored text. `repair.verified` and
  `repair.patchApplied` are always `false`: nothing applies a patch or re-verifies.
- `infrastructure` (failed and timed-out jobs) is never a repository diagnosis.

### Real-Docker end-to-end harness (opt-in; run and passed once on 2026-11-15)

Verified result (reported externally, 2026-11-15): Docker Desktop server
29.9.2, local `node:22-alpine`, one controlled offline `is-number@7.0.0`
fixture, real localhost API, real separate worker composition, real Docker,
agents off. The job reached `completed` / stage `done` / outcome `passing`,
the result was read with the owner token, cleanup was confirmed, and 1 test
passed. This does **not** verify real GitHub cloning, agents on this job,
repair, or arbitrary repositories.

`pnpm run test:worker-e2e` runs `src/test/manual-worker-e2e-check.ts`: the real
API on an ephemeral `127.0.0.1` port plus the real worker composition and real
Docker, for one controlled fixture. It uses a temporary database, catalog,
fixtures and staging directories under `backend/.tmp-fixtures` and removes them
afterwards; existing data is never opened. It never fakes Docker: if the
daemon, `node:22-alpine`, the compiled driver or the operator inputs are
missing it fails with a `FAIL-CLOSED` message. `pnpm test` skips it.

```powershell
$env:GRAVEYARD_NPM_FIXTURE_DIR = "C:\path\to\is-number7-fixture"  # package.json + package-lock.json
$env:GRAVEYARD_NPM_CACHE_DIR = "C:\path\to\npm-cache"            # prepopulated offline cache
pnpm run test:worker-e2e
```

It expects a `completed` job with outcome `passing` and `repair.verified` /
`repair.patchApplied` both `false`, then checks that no container remains. No
network beyond localhost is used. See `DEVELOPMENT.md` for details and limits.

### Not live

Arbitrary repositories, git or registry acquisition inside a job, patch
application, repair verification, a patch endpoint, worker supervision or health
endpoint, and any frontend use of `/result` (the frontend is unchanged). The
code and its tests (`worker-config`, `worker-service`, `worker-process`,
`job-result`) compile and pass (87 focused tests plus the full suite, reported externally) with
mocked Docker; the opt-in real-Docker harness above passed once for one controlled
fixture. See `DEVELOPMENT.md`.

## Not yet implemented

The following features from `requirements.md` / `design.md` are **deferred to
future milestones** and are intentionally absent:

- `GET /api/jobs/:id/patch` — downloadable unified diff (a model-authored proposal is readable inside the `/result` payload only)
- Worker started or supervised by the API server (the worker is a separate opt-in process, see above)
- Arbitrary-repository acquisition inside jobs and a production `EgressGuard`
- Patch application and repair verification
- Bounded log storage and truncation indicators
- Without a running worker, jobs are accepted and persisted but stay `queued`.
  Cancellation is supported for queued jobs; running jobs return 409.

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
│   ├── worker.ts           # JobWorker coordinator (unwired; injected runner)
│   ├── runner.ts           # Runner contract + fail-closed UnavailableRunner
│   ├── pipeline-runner.ts  # PipelineJobRunner: operator catalog -> controlled pipeline -> Tester -> agents
│   ├── worker-config.ts    # Opt-in switch, worker env and catalog validation
│   ├── worker-service.ts   # Bounded polling loop, availability gate, graceful stop
│   ├── worker-compose.ts   # Builds the real worker from a validated config
│   ├── worker-process.ts   # Testable start-up sequence
│   ├── worker-main.ts      # Worker process entry point (opt-in; not started by the API)
│   ├── result-view.ts      # Client-facing result presentation
│   ├── (other modules: sandbox, pipeline, acquisition, agents; see DEVELOPMENT.md)
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
