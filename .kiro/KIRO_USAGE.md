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

### External verification of the frontend workspace (2026-11-14)

Docs-only request; Kiro ran no commands and edited no source or dependencies. Recorded from the user's external checks:

- Frontend TypeScript + Vite production build passed.
- `scripts/verify-workspace.mjs` passed parser and error-classification checks.
- Local Vite proxy real smoke passed: health, create, metadata read, cancel, SSE replay; no token in the event response.
- Backend `tsc` production and test configurations pass; full suite 162 tests, 0 failures, run outside the sandbox because of its ephemeral localhost restriction.
- Workspace and API launched locally on ports 3000 and 3002.
- Not verified: browser visual interaction (local browser automation was disabled).
- Still outstanding: execution worker, sandbox runner, result and patch endpoints, frontend visual test.

This supersedes the "NOT executed" note in the frontend workspace entry (2026-11-11), which is left unedited as history.

### Docker fixture sandbox and external verification (2026-11-14)

Kiro wrote `src/docker-sandbox.ts` and its mock tests, and later the `json-file` log driver fix, in bounded requests without a shell. This docs-only update records the user's external results: Docker Desktop 29.9.2, local `alpine:3.21`, echo fixture exit 0 with `fixture-ok` under network `none`, read-only bind mount listing of `backend/src/test`, cleanup confirmed in both, test compile passed, 91 mock sandbox tests passed. The earlier real failure was fixed by the explicit `json-file` driver. This is not evidence of production safety for arbitrary repositories; there is no worker integration, clone or agent runtime. Kiro ran no commands for this update.

### Steering documents (2026-11-14)

One bounded, docs-only request. Kiro read `.kiro/PROJECT.md` and `.kiro/specs/backend-foundation/design.md` and created `.kiro/steering/product.md`, `tech.md` and `structure.md`. No shell commands were run, and `backend/`, `src/` and `scripts/` were not touched. Nothing was built or tested.

### Controlled Node fixture runner and external verification (2026-11-15)

Kiro wrote `src/node-fixture-runner.ts`, `fixture-workspace.ts`, `node-fixture-files.ts`, their mocked tests and the opt-in harness `src/test/manual-node-fixture-check.ts` in one bounded request without a shell. This docs-only update records the user's external results; Kiro ran no commands and edited no source. Both `tsc` configurations compile, 66 focused mock tests pass, the full backend suite passed, and real Docker 29.9.2 with `node:22-alpine` passed four controlled cases (success with build and 2 tests, failed test detected, failed build skips tests, no tests reported not-run). Container cleanup was confirmed and temp fixtures were removed. The real Docker test was initially paused, then unpaused by the user. This supersedes the "not compiled or run" status of that request. Scope: controlled fixtures only; no `npm install`, no untrusted repositories, no worker wiring, no production result. Review and test execution were external.

### Archive handoff to node fixture build/test (2026-11-15)

Kiro wrote `backend/src/archive-handoff.ts`, `src/test/archive-handoff.test.ts` and the opt-in `src/test/manual-archive-build-check.ts` without a shell; nothing was compiled or run, so the combined test is pending external verification. The same request corrected stale docs: the real-clone harness was externally verified (octocat/Hello-World at 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d, 1 file / 13 bytes extracted, cleanup confirmed; full suite and 60 focused tests passed), which is narrow and not production proof. The combined test uses locally generated archives, not git output, and tests no network clone. Frontend untouched, no new dependencies.

### Real clone handoff into the controlled build runner (2026-11-15)

Kiro edited only `backend/src/test/manual-clone-check.ts` (opt-in harness) and these records, without a shell; nothing was compiled or run, so the change is pending external verification. Previously measured (externally, not by Kiro): the real-clone harness extracted octocat/Hello-World at 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d (1 file / 13 bytes) with cleanup confirmed, and the archive-handoff combined harness was pending. The harness now hands the real `git archive` bytes to `extractArchiveIntoFixture` (validation before any write) in a managed `run-<hex>` directory and, for that one known SHA only, calls `NodeFixtureRunner.verify` on the original files. Expected: build not-run (`no-build-script`), test not-run, no container. This is not a build or test success; passing runs come only from the controlled generated fixtures in `manual-archive-build-check.ts`. No source outside the harness changed, so no new unit tests were added. The narrow attestation warning is unchanged.

## Prompting guidelines

- Provide a single, bounded implementation request per session.
- Include only the files directly relevant to the task as context.
- State explicitly what Kiro must not touch (e.g. frontend, shell commands).
- After each request, review output locally and record results in `backend/DEVELOPMENT.md` before requesting the next milestone.
- Mark documentation as factual summaries; do not ask Kiro to reproduce transcripts or invent prompts.

## 2026-11-15: docs-only update, external verification of real acquisition

Kiro ran no commands and changed no source; it edited only `.kiro/PROJECT.md`, `.kiro/KIRO_USAGE.md` and `backend/DEVELOPMENT.md`. Kiro authored the earlier code changes; an external assistant reviewed and tested them. No other provenance is claimed.

Reported externally: `octocat/Hello-World` at SHA `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d` was acquired via the proxy and produced a validated handoff of one file (13 bytes). The controlled `NodeFixtureRunner` reported no build script and tests not run, with no runner container. Acquisition cleanup was confirmed and the temp directory removed. The full test suite and test TypeScript compilation passed. Earlier controlled archive to Docker build/test suites passed for success, fail, missing and tampered cases.

Not shown: real GitHub build success, live jobs, dependency installation, a deployed egress guard. This supersedes the earlier "NOT executed / pending external verification" notes for the acquisition and proxy work, which are left unedited as history.


## 2026-11-15: controlled offline npm install foundation (written, not executed)

One bounded request, edits only, no shell. Kiro wrote `backend/src/npm-lock-policy.ts`, `backend/src/npm-install-runner.ts`, an additive change to `backend/src/docker-sandbox.ts` (optional fixed read-only binds and extra tmpfs mounts), `backend/src/test/npm-lock-policy.test.ts`, `backend/src/test/npm-install-runner.test.ts`, the opt-in `backend/src/test/manual-npm-install-check.ts`, and updated `backend/DEVELOPMENT.md`, `.kiro/PROJECT.md` and `.kiro/specs/backend-foundation/tasks.md`. Nothing was compiled or run (no `tsc`, tests, Docker or npm), so all of it is pending external verification. The real-Docker harness needs an operator-supplied fixture and prepopulated cache and fails closed without them; no registry values were invented. No frontend, server, worker, dependency or live-job changes. Controlled test fixtures only; no claim is made about arbitrary repositories.



## 2026-11-15: docs-only update, external verification of offline npm install

Kiro ran no commands and changed no source; it edited only `.kiro/PROJECT.md`, `.kiro/KIRO_USAGE.md`, `.kiro/specs/backend-foundation/tasks.md` and `backend/DEVELOPMENT.md`. Kiro authored the offline `npm ci` code; an external assistant reviewed and tested it. No other provenance is claimed. This supersedes the "written, not executed" entry for that request, which is left as history.

Reported externally: test TypeScript compilation passed and the full backend suite passed. On real Docker 29.9.2 with `node:22-alpine`, a controlled offline `npm ci` of `is-number@7.0.0` succeeded 1 of 1. An uncached package failed correctly with `ENOTCACHED`, a git-dependency lockfile was rejected by the policy, and a missing lockfile and a pre-aborted request both reported not-run. All container and staging cleanup was confirmed. An initial duplicate npm config failure (`/dev/null` used for both configs) was fixed with distinct empty config files.

Not shown: registry acquisition (the cache was prepopulated outside the sandbox), handing installed modules to a build (`node_modules` is discarded), production safety, a live worker or agents.



## 2026-11-15: docs-only update, external verification of the integrated controlled fixture pipeline

Kiro ran no commands and changed no source; it edited only `.kiro/PROJECT.md`, `.kiro/KIRO_USAGE.md`, `.kiro/specs/backend-foundation/tasks.md` and `backend/DEVELOPMENT.md`. Kiro authored the pipeline source (`controlled-pipeline.ts`, driver, fixtures, tests, harness); an external assistant reviewed and tested it. No other provenance is claimed. This supersedes the earlier "written, not executed" entry for that request, which is left as history.

Reported externally: test TypeScript build passed, focused tests and the full backend suite passed. On real Docker 29.9.2 with `node:22-alpine` and an offline cached `is-number@7.0.0` fixture: install/build/test succeeded; no-tests was correctly not-run (`tests-not-run`); failed build and failed test were reported as failures; a cache miss failed; a git dependency was rejected; a pre-aborted request was not-run; cleanup was proven. An original bug that reported success for no-tests was corrected before the final verification.

Not shown: live jobs, repository acquisition integration, registry download, runtime agents, production safety.




## 2026-11-15: docs-only update, external verification of controlled npm registry acquisition

Kiro ran no commands and changed no source; it edited only `.kiro/PROJECT.md`, `.kiro/KIRO_USAGE.md`, `.kiro/specs/backend-foundation/tasks.md` and `backend/DEVELOPMENT.md`. Kiro authored the registry acquisition source; an external assistant reviewed and tested it. No other provenance is claimed. This supersedes the earlier "written, not compiled or run" notes for it.

Reported externally: test `tsc`, focused registry and GitHub proxy tests, and the full backend suite passed. `npm view is-number@7.0.0` confirmed the pinned sha512. On real Docker 29.9.2 with `node:22-alpine`: the default guard refused; the isolated client could not reach 1.1.1.1 or 8.8.8.8; the proxy rejected github, example, private, metadata and wrong-port targets and permitted registry port 443; the fixed `is-number@7` fetch passed its integrity check; 2 cache files (4404 bytes) were handed off; offline install, build and test passed; all labelled containers, the network and temp directories were confirmed cleaned up.

Not shown: arbitrary repositories, general production isolation, a production `EgressGuard`, worker or job wiring.




## 2026-11-15: operator multi-package lockfile v3 fixtures (written by Kiro, NOT compiled or run)

Kiro used file read, search and edit tools only; no shell, no dependency, no frontend change. It edited under `backend/` and `.kiro/` only: added `backend/src/npm-operator-fixture.ts`, `backend/src/test/npm-operator-fixture.test.ts` and `backend/src/test/operator-fixture-helpers.ts`; edited `npm-registry-acquisition.ts`, `registry-pipeline.ts` (comment), `npm-registry-acquisition.test.ts`, `registry-pipeline.test.ts`, `manual-registry-acquisition-check.ts`, and the docs `.kiro/PROJECT.md`, `.kiro/specs/backend-foundation/tasks.md`, `backend/DEVELOPMENT.md`. Kiro read `npm-registry-acquisition.ts`, `npm-registry-cache.ts`, `npm-lock-policy.ts`, `registry-pipeline.ts`, `npm-acquire-driver.ts`, their tests and the existing harness before changing anything. Nothing was compiled or run, so no test result exists for this work. No external verification of it is claimed.




## 2026-11-15: docs-only update, external verification of operator multi-package lockfile v3 fixtures

Kiro ran no commands and changed no source; it edited only `.kiro/PROJECT.md`, `.kiro/KIRO_USAGE.md`, `.kiro/specs/backend-foundation/tasks.md` and `backend/DEVELOPMENT.md`. Kiro authored the operator-fixture changes; an external assistant reviewed and tested them. No other provenance is claimed. This supersedes the earlier "written, NOT compiled or run" entry for that request, which is left as history.

Reported externally: test TypeScript compile and the full backend suite passed. On real Docker 29.9.2 with a controlled operator lockfile v3 of two packages (`is-number@7.0.0`, `is-buffer@2.0.5`), both were acquired through the registry-only proxy with integrity verified, 4 cache files (7170 bytes) were handed off, and offline install, build and tests passed. A hostile resolved URL was rejected before any container was created, the default guard refused, direct public IP probes and forbidden hosts were blocked, and cleanup was confirmed.

Not shown: arbitrary user repositories, a production egress guard, a live worker. Scope is limited controlled fixtures: flat unscoped packages, at most 8.




## 2026-11-15: agent foundation compile fix and focused tests (written, not compiled or run)

One bounded request, edits only. The shell tool was refused, so Kiro ran no `tsc`, tests or commands. Kiro read `backend/src/agent-contract.ts`, `kiro-agent.ts` and `tester.ts` (plus the `StageResult` types in `node-fixture-runner.ts`), fixed the TS2367 abort check in `kiro-agent.ts` with an `isAborted` helper, and added `backend/src/test/kiro-agent.test.ts` and `backend/src/test/tester.test.ts`. It updated `.kiro/PROJECT.md`, this file and `backend/DEVELOPMENT.md`. No frontend, dependency, live-wiring or shell changes. No test result exists for this work; no external verification is claimed. The reported error line (503) did not match the file as read, so the fix rests on inspection.



## 2026-11-15: integrated worker path (source only, no shell)

Kiro read the worker, leases, controlled pipeline, registry pipeline, Tester and agent modules, then wrote `src/pipeline-runner.ts`, fenced stage/result writes in `src/leases.ts`, the `report` channel in `src/runner.ts` and `src/worker.ts` (plus `drainQueue`), `buildPipelineTesterReport` in `src/tester.ts`, and `src/test/pipeline-runner.test.ts`. The shell tool was refused, so nothing was compiled or run. Results must be logged after an external `tsc` and test run. See `backend/DEVELOPMENT.md` for supported behaviour and gaps.




## 2026-11-15: docs-only update, external verification of build, tests and a real Analyst call

Kiro ran no commands and changed no source; it edited only `.kiro/KIRO_USAGE.md` and `backend/DEVELOPMENT.md`. Results are reported by the user from external runs. This supersedes the "NOT compiled or run" status of the agent foundation and integrated worker path entries above, which are left as history.

Reported externally:
- Production and test TypeScript compilation passed.
- The full `node --test` suite passed on 2026-11-15. One isolated temporary-directory test may skip when the environment is empty.
- A real synthetic Analyst call through the logged-in Kiro CLI returned no-result (unknown diagnosis). This shows the invocation works. It does not show the diagnosis is correct.

Scope: tests use injected fakes. No end-to-end live worker run was performed. The pipeline remains limited to controlled fixtures, is not wired to the server, and does not apply repairs.




## 2026-11-15: opt-in local worker process and durable result endpoint (source only, no shell)

Kiro read `DEVELOPMENT.md`, `server.ts`, `config.ts`, `app.ts`, `worker.ts`, `runner.ts`, `pipeline-runner.ts`, the lease, job and event modules, `routes/jobs.ts`, `routes/events.ts`, the controlled pipeline and sandbox constructors and the existing worker and pipeline-runner tests, then wrote `src/worker-config.ts`, `worker-service.ts`, `worker-compose.ts`, `worker-process.ts`, `worker-main.ts`, `result-view.ts`, `getJobResultRecord` in `src/jobs.ts`, `GET /api/jobs/:id/result` in `src/routes/jobs.ts`, four test files (`worker-config`, `worker-service`, `worker-process`, `job-result`), and the documentation and steering updates. It also changed `drainQueue`'s parameter type, exported `FIXTURE_NAME_RE`, added the `worker` script to `package.json` and commented worker variables to `.env.example`. As instructed, no shell or git command was run, so nothing was compiled or tested and no result exists for this work. No external verification is claimed. No frontend or dependency change.




## 2026-11-15: docs-only update, external verification of the real-Docker worker end-to-end run

Kiro ran no commands and changed no source; it edited only `backend/DEVELOPMENT.md`, `backend/README.md`, `.kiro/PROJECT.md` and `.kiro/KIRO_USAGE.md`. Kiro authored the worker, result endpoint and end-to-end harness source; an external assistant reviewed and ran them. No other provenance is claimed. This supersedes the earlier "written, not compiled or run" entries for the harness, which are left as history.

Reported externally (2026-11-15): Docker Desktop server 29.9.2 and local `node:22-alpine`. Both TypeScript builds, 87 focused tests and the full suite passed before the harness; the harness compiled and passed (1 test). With a controlled single `is-number@7.0.0` offline fixture, the real localhost API, the real separate worker composition and real Docker (agents off), the job completed at stage `done` with outcome `passing`, the result was read with the owner token, and cleanup was confirmed.

Not shown: real GitHub cloning, agents on this job, repair or patch application, arbitrary repositories.




## 2026-11-15: GitHub repository flow in the opt-in worker (source only, no shell)

Kiro read the worker composition and config, `pipeline-runner.ts`, `git-acquisition.ts`, `acquisition-policy.ts`, `archive-handoff.ts`, the registry acquisition, cache, operator-fixture and `registry-pipeline.ts` modules, the egress proxy header, `controlled-pipeline.ts`, `result-view.ts`, the manual clone harness and the existing worker and pipeline-runner tests. It then wrote `src/github-runner.ts`, `src/github-source.ts`, `src/github-analysis.ts`, `src/egress-guard.ts` and `src/test/github-runner.test.ts`, and made additive edits to `src/worker-config.ts`, `src/worker-compose.ts`, `src/pipeline-runner.ts`, `src/result-view.ts`, `src/worker-main.ts`, `.env.example`, `README.md`, `DEVELOPMENT.md`, `.kiro/PROJECT.md`, this file and the steering files. The shell tool was refused (and the instruction was no shell, no git), so Kiro compiled and ran nothing. The user later reported an external run in which both `tsc` configs compiled and the tests passed (no counts supplied); no real Docker or GitHub run is claimed. The design choice that shaped the work: the host reads only four small root files of the pinned commit (as raw git blobs inside the acquisition container) instead of extracting the repository, so the tar-extract handoff was not used. A detached adapter was deliberately not added; every new module is reached from `composeWorker`.


## 2026-11-15: GitHub flow end-to-end harness and stale-status fix (source and docs only, no shell)

Kiro read `manual-clone-check.ts` (topology and cleanup pattern), `manual-worker-e2e-check.ts` (API plus worker plus result polling), `worker-config.ts`, `worker-compose.ts`, `egress-guard.ts`, `github-runner.ts`, `github-source.ts`, `github-analysis.ts`, `result-view.ts`, `fixture-workspace.ts` and the proxy options. It then wrote `backend/src/test/manual-github-e2e-check.ts`, `backend/github-e2e.env` and the `test:github-e2e` script, corrected the stale "not compiled or run" wording of the GitHub flow in `backend/DEVELOPMENT.md`, `backend/README.md`, `.kiro/PROJECT.md`, this file, the steering files and the header comments of five GitHub-flow modules, and added the harness record to `backend/DEVELOPMENT.md` and `.kiro/PROJECT.md`. The shell was unavailable and the harness was told not to be run: **the harness was not compiled and not run, and no result exists.** The corrected status (compiled and unit-tested, no real run) rests on the user's report of an external run, not on anything Kiro observed.
