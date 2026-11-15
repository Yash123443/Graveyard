# GRAVEYARD — Project Record

Factual summary. Not a verbatim log.

## Overview

GRAVEYARD is an immersive 3D cemetery UI (React / Three.js) where each gravestone represents an abandoned GitHub repository. The planned real workflow: clone a repository, analyse it, diagnose problems, repair code, build, test, and verify. Three agent roles drive the workflow — Analyst (investigates), Fixer (repairs), Tester (verifies).

The 3D intro is a demonstration. The separate repair workspace (`#/workspace`) is connected to the backend for job creation, metadata, queued-job cancel and the SSE event feed. Job processing (worker, acquisition, agents, results) is not connected.

**Project owner:** Yash (backend). Teammate handles frontend.

## Repository structure

| Path | Purpose |
|---|---|
| `/` | Frontend — React 19 / Three.js / Vite / TypeScript |
| `backend/` | Backend API — Node.js ≥ 22.13.0 / Fastify 5 / TypeScript / SQLite |
| `.kiro/specs/backend-foundation/` | Backend requirements, design, and task list |

Package manager: pnpm 10.12.1 (both workspaces).

## Branches

- `backend` — active development branch, branched from the UI. The 3D environment (gate, camera, stories, audio, characters) must be preserved; do not modify frontend assets.

## Backend — implemented

- Health endpoint (`GET /health`)
- Environment config validation
- Error handling (AJV → 422, body-limit → 413, generic 500)
- SQLite database with versioned migrations, atomic rollback on failure, future-schema rejection
- Token utilities — owner bearer token, constant-time comparison, hashed storage
- URL validator — GitHub-compatible owner and repo segments, dot-segment rejection
- Jobs repository — `createJob`, `cancelJob` (atomic status transition + event)
- `POST /api/jobs` — queued job creation
- `GET /api/jobs/:id` — job metadata (token-gated, 401/403)
- `POST /api/jobs/:id/cancel` — queued → cancelled (token-gated, 409 on conflict)
- `GET /api/jobs/:id/events` — SSE stream of persisted events (bearer-gated, Last-Event-ID replay, 429 stream cap). Externally verified 2026-11-11, including real-HTTP tests (replay, live, cancel, cap, shutdown, heartbeat, backpressure).
- Cache-Control: no-store on all `/api/jobs*` responses
- `GET /api/jobs/:id/result` — durable result view (bearer-gated, same 401/403 contract). **Written 2026-11-15, NOT compiled or run** (see "Local worker process" at the end of this file).
- Authorization header redaction from logs
- Schema v2 migration and lease/recovery **library primitives** (`src/leases.ts`: claim, heartbeat, fencing, cleanup-confirmed requeue, `listRecoveryRequired`, `expireQueuedDeadlines`). These are library functions only; nothing in the running server invokes them.

## Backend — not yet implemented

- Worker started by the API server (`server.ts` never starts one; the worker is a separate opt-in process, see "Local worker process" at the end of this file)
- Arbitrary-repository acquisition (git/registry acquisition modules exist but are not connected to jobs; no production `EgressGuard`)
- Patch apply and repair verification (nothing applies a patch; `repair.verified` is always `false`)
- Patch endpoint (a model-authored proposal is readable only inside the result payload)
- Automatic restart-recovery coordinator beyond the worker's periodic `recoverOnce`

## Backend — integrated worker path (written 2026-11-15; later compiled and tested externally, see DEVELOPMENT.md "external verification of build, tests and a real Analyst call")

`src/pipeline-runner.ts` (`PipelineJobRunner`) connects `JobWorker` to the controlled network-none pipeline, the Tester (`buildPipelineTesterReport`) and optional Analyst/Fixer, with fenced `stage` and `result` events (`recordLeasedStage`, `recordLeasedResult` in `leases.ts`) and a bounded `drainQueue`. Supported source: operator-prepared controlled fixtures in an exact-match catalog only. Unknown repositories fail closed as `infrastructure-unavailable`. Fixer output is a proposal and is never applied. Tests (`src/test/pipeline-runner.test.ts`) use injected fakes. Details and gaps: `backend/DEVELOPMENT.md`, entry "integrated worker execution path". Compilation and the suite were later verified externally (see `backend/DEVELOPMENT.md`); it was later run end to end once with real Docker for one controlled fixture (2026-11-15, see the final section of this file).

## Frontend — repair workspace (authored 2026-11-11, pending external verification)

The 3D cemetery is the intro only. A separate, non-3D workspace lives at `#/workspace` (`src/AppRouter.tsx`, lazy-loaded `src/IntroRoute.tsx` and `src/workspace/*`). It is connected to the backend through the Vite same-origin `/api` proxy (to `127.0.0.1:3002`; only `/api/health` is rewritten to `/health`). It provides health badge, job submission with explicit consent, metadata, queued-job cancel, and a fetch-based SSE feed (Authorization and Last-Event-ID headers only). The job token is kept in `sessionStorage` only. The workspace states plainly that no worker, result, or patch endpoint exists. The intro finale now links to the workspace instead of the former dead GitHub button; no OAuth exists.

Verification: Kiro ran no build or test itself (no shell); external results are recorded under "External verification (2026-11-14)" below. Browser visual interaction is still unverified.

## Current verification status (as of 2026-11-11)

Externally verified on 2026-11-11:

- Frontend production build passed after merge `8996b9f` (`origin/UI` at `b426aef`).
- Backend: both `tsc` builds pass; 162 tests, 0 failures, including real HTTP SSE tests (replay, live, cancel, stream cap, shutdown, heartbeat, backpressure).
- Docker 29.9.2 running. UI observed running on 127.0.0.1:3000; backend was starting on 3002 (not confirmed up at time of writing).

Earlier baseline (2026-11-07, Node 26.7): both `tsc` builds exit 0; 121 tests passed, 0 failed. Kept as history.

All source changes for the lease and SSE milestones were authored by Kiro; the external assistant reviewed and ran tests. Next milestone: execution worker/runner (not started).

## External verification (2026-11-14)

Recorded from the user's external checks; Kiro ran no commands for this update (docs-only, no source or dependency edits). This supersedes the "Not executed" note in the frontend workspace section above.

- Frontend TypeScript + Vite production build passed.
- `scripts/verify-workspace.mjs` passed its parser and error-classification checks.
- Local Vite proxy real smoke test passed: health, job create, metadata read, cancel, and SSE replay. The event response did not contain the job token.
- Backend `tsc` production and test configurations both pass.
- Full backend suite: 162 tests, 0 failures. It was run outside the sandbox because the sandbox restricts ephemeral localhost ports.
- Workspace and API were launched locally on ports 3000 and 3002.

Not verified: browser visual interaction. Local browser automation was disabled, so the workspace UI has not been checked visually or interactively in a browser.

Still outstanding: execution worker, sandbox runner, result endpoint, patch endpoint, and frontend visual testing.

## Docker sandbox fixture verification (2026-11-14)

Docs-only update; Kiro ran no commands and changed no source. Recorded from the user's external checks:

- Docker Desktop 29.9.2 with the official `alpine:3.21` image pulled locally.
- A controlled echo fixture ran through `DockerFixtureSandbox` with network `none`: exit code 0, output `fixture-ok`, cleanup confirmed.
- A controlled read-only bind mount of `backend/src/test` listed successfully; cleanup confirmed.
- Test compile passed and 91 mock sandbox tests passed.
- An earlier real run failed at `docker start` because of the log options. The fix was to set the `json-file` log driver explicitly; this is now verified by the real runs above.

Limits of this evidence: it covers two controlled local fixtures only. It does not show the sandbox is safe for arbitrary repositories. There is no worker integration, no clone or acquisition, and no agent runtime. The adapter is still not wired to `JobWorker`.

Next steps: controlled build/test fixture; real Docker tests for timeout and cancel; secure acquisition design.

## Egress proxy: real Docker integration finding and IPv4-only fix (2026-11-14)

Reported externally (Kiro ran no commands). A real Docker integration run showed: direct egress from the container was blocked; disallowed targets were blocked; the GitHub request through the proxy **failed** (no 200); container cleanup was confirmed. Cause: `github.com` resolved to public IPv4 `135.235.149.144` plus IPv6 `64:ff9b::4ba:9dc0` (NAT64 synthesized). The proxy rejected the set as `blocked-address` because `64:ff9b::/96` is not public. That rejection was correct fail-closed behaviour, not a bug in classification.

Change written by Kiro, **NOT compiled or tested**:
- `systemResolver` now calls `dns.promises.lookup(host, { all: true, family: 4 })`. This avoids asking for synthesized AAAA answers; it does not trust them.
- The proxy now rejects any non-IPv4 answer (403 `non-ipv4-address`), so a mixed or IPv6-only injected resolver result fails the whole set. Every address is still run through `classifyIp`; private, loopback, link-local and metadata rejection is unchanged. The first validated IPv4 is pinned and passed to the connector as an IP literal.
- Resolver interface unchanged. Tests: the IPv6-fallback and mixed-happy-path tests were replaced with rejection tests (v4+v6, observed NAT64 pair, v6-only, public+private/loopback/metadata v4 in both orders) and an IPv4 pinning test.

Still not proven: that the fix makes the GitHub request succeed in Docker. A new external `tsc` run, test run and Docker re-run are pending. The proxy remains unwired; acquisition stays disabled; no network permissions were added.


## Docker timeout/cancel and acquisition foundations (2026-11-14)

Reported externally (Kiro ran no commands): real Docker timeout and cancel fixtures both stopped the container and container cleanup was confirmed. Controlled local fixtures only.

Written by Kiro, NOT compiled or tested: `backend/src/acquisition-policy.ts`, `backend/src/git-acquisition.ts` and their mock tests. They define exact-SHA public GitHub acquisition policy and an isolated clone adapter, but acquisition stays **disabled**: it needs an attested controlled egress proxy (`EgressGuard`), which does not exist and was not invented. Nothing is wired to the server or worker, and no live jobs run. Tests pending external run. See `backend/DEVELOPMENT.md` for limits and next steps.

Egress proxy core (`backend/src/egress-proxy.ts`, tests in `backend/src/test/egress-proxy.test.ts`): first external run compiled and passed 194 of 197. Kiro then edited the code and tests for the three failures (double-space request line accepted, pending DNS not cancelled by early data, `close()` returning before sockets closed). **These edits are unverified.** No command was run by Kiro; a new external `tsc` and test run is pending. Details in `backend/DEVELOPMENT.md`. The proxy is still not wired to anything and acquisition stays disabled.


## Task list

See [specs/backend-foundation/tasks.md](specs/backend-foundation/tasks.md) for the full numbered task list and completion status.

## Development log

See [../backend/DEVELOPMENT.md](../backend/DEVELOPMENT.md) for the milestone-by-milestone record of changes, corrections, and verification results.

## 2026-11-15 — real-clone harness and tar handoff (externally verified, narrow)

Kiro added `backend/src/tar-extract.ts`, an optional `afterCheckout` hook in `git-acquisition.ts`, the opt-in `src/test/manual-clone-check.ts` harness, and mocked tests. **Externally verified on 2026-11-15** (supersedes the earlier "nothing was run" status): the opt-in harness cloned `octocat/Hello-World` at SHA `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`, extracted 1 file / 13 bytes through the tar handoff, and cleanup was confirmed. The full backend suite and 60 focused tests passed. This is a narrow result: one tiny public fixture, not production proof. Production acquisition stays disabled and nothing is wired. Details in `backend/DEVELOPMENT.md`.

## 2026-11-15 — archive handoff to node fixture build/test (combined test PENDING external verification)

Kiro added `backend/src/archive-handoff.ts` (confined extraction of a validated tar into a fresh `run-<hex>/<name>` directory, lstat audit, commit/count/byte checks, and `buildGitArchiveTar`), `src/test/archive-handoff.test.ts` (real filesystem under `os.tmpdir()`, no Docker), and the opt-in `src/test/manual-archive-build-check.ts` (`GRAVEYARD_MANUAL_ARCHIVE_BUILD=1`). Nothing was compiled or run by Kiro. The combined test uses locally generated archives in `git archive` layout, not produced by git; no network clone is tested in it. Pending external: both `tsc` configs, full suite, and the opt-in run.

Kiro then edited only the opt-in `backend/src/test/manual-clone-check.ts` (no shell; nothing compiled or run, **pending external verification**). Previously measured externally, not by Kiro: the real-clone harness on octocat/Hello-World at `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d` (1 file / 13 bytes, cleanup confirmed). The harness now passes the real `git archive` bytes to `extractArchiveIntoFixture` (whole-archive validation before any write) into a managed `backend/.tmp-fixtures/run-<hex>/clone` directory, then, for that single known SHA only, runs `NodeFixtureRunner.verify` on the original extracted files with no injected scripts. Expected: build not-run (`no-build-script`), test not-run, overall not-run, no container created, no leftover by execution-id label; the run directory is removed by exact path. Hello-World has no build script, so this is not a build or test success. A passing build/test is shown only by the controlled generated fixtures in `manual-archive-build-check.ts`. The narrow attestation caveat is unchanged. Works with `GRAVEYARD_CLONE_IMAGE=graveyard-git-fixture:local` plus local `node:22-alpine`. Pending external: both `tsc` configs, full suite, and the opt-in run.




## 2026-11-15 — controlled Node fixture build/test runner (externally verified)

Kiro added `backend/src/node-fixture-runner.ts`, `fixture-workspace.ts`, `node-fixture-files.ts`, mocked tests (`node-fixture-runner.test.ts`, `fixture-workspace.test.ts`) and the opt-in harness `src/test/manual-node-fixture-check.ts` (`GRAVEYARD_MANUAL_NODE_FIXTURE=1`, local `node:22-alpine`, generated fixtures under gitignored `backend/.tmp-fixtures`). Fixed build and test commands, network `none`, read-only source mount, bounded `/tmp`, cleanup proof required for any pass; passed/failed/not-run kept distinct (missing tests, timeout, cancel, truncation and unconfirmed cleanup are not-run).

**Externally verified (2026-11-15).** This supersedes the earlier "written, not compiled or run" status for this runner. Kiro ran no commands for this update (docs-only, no source edits, no shell). Recorded from the user's external checks:

- `tsc` production and test configurations both compile.
- 66 focused mock tests pass.
- The full backend test suite passed (no count supplied to Kiro).
- Real Docker 29.9.2 with local `node:22-alpine` passed four controlled cases through the opt-in harness:
  1. success: build passed, then 2 tests passed;
  2. failed test: detected as failed;
  3. failed build: reported failed, tests skipped (not-run);
  4. no tests: reported not-run, not passed.
- Container cleanup was confirmed for every stage, and the temporary fixtures were removed.
- The real Docker test was initially paused, then the user unpaused it.

Authorship: runner and tests written by Kiro; external review and test execution by the user and external assistant.

Limits of this evidence: controlled generated fixtures only. No `npm install`, no untrusted repositories, no worker wiring, no production result. Fixture code controls its own output, so this does not make arbitrary repositories safe. Not wired to the server, worker or jobs.

Next: integrate the acquisition handoff into a controlled build, then secure dependency acquisition, then the worker.

Not covered by this entry and still unverified unless recorded elsewhere: the real-clone harness and tar handoff (section above), and the egress proxy IPv4-only edits.

## External verification: real GitHub acquisition and controlled runner (2026-11-15)

Docs-only update; Kiro ran no commands and changed no source. Recorded from the user's external checks. This supersedes earlier "not compiled or tested" and "pending external verification" notes for the egress proxy IPv4 fix and acquisition work.

- Real GitHub repository `octocat/Hello-World` at exact SHA `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d` was acquired through the proxy. The validated handoff contained one file of 13 bytes.
- The controlled `NodeFixtureRunner` correctly reported no build script and tests as not run. No runner container was created.
- Acquisition cleanup was confirmed and the temp directory was removed.
- The full test suite passed and the test TypeScript compilation passed.
- Earlier, controlled generated archive to Docker build/test suites passed for the success, fail, missing and tampered cases.

Limits of this evidence: no real GitHub build success, no live jobs, no dependency installation, and no deployed egress guard. The default guard still never attests, so acquisition stays disabled in the product.

Authorship: Kiro wrote the changes; an external assistant reviewed and tested them. No provenance is claimed beyond that.



## 2026-11-15: controlled offline npm install foundation (written by Kiro, NOT executed)

Kiro wrote, without running any tool, a preliminary lockfile policy (`backend/src/npm-lock-policy.ts`), an offline `npm ci` runner for controlled test fixtures (`backend/src/npm-install-runner.ts`, fixed argv `--offline --ignore-scripts --no-audit --no-fund`, Docker network `none`, non-root, bounded resources, tmpfs `node_modules`, read-only operator-supplied cache, explicit cleanup, success/failure/not-run), an additive sandbox change for fixed read-only binds and extra tmpfs, mock tests, and an opt-in harness (`GRAVEYARD_MANUAL_NPM_INSTALL=1`) that needs an operator-supplied fixture and cache and fails closed without them. Details and assumptions are in `backend/DEVELOPMENT.md`.

Status: unverified. Pending external `tsc` (both configs), the full suite, and the opt-in run. Not wired to the server, worker or any job; no live repository execution; policy is preliminary and not production security. Record external results here when available.



## 2026-11-15: offline npm install, controlled fixture (externally verified, narrow)

Docs-only update; Kiro ran no commands and changed no source. Recorded from the user's external checks. This supersedes the "written by Kiro, NOT executed" and "unverified" status of the offline `npm ci` foundation section above, which is left as history.

- Test TypeScript compilation passed.
- The full backend test suite passed (count not supplied to Kiro).
- Real Docker 29.9.2 with local `node:22-alpine` ran the opt-in harness against a controlled `is-number@7.0.0` fixture:
  - Offline `npm ci` succeeded, 1 of 1 packages.
  - An uncached package failed correctly with `ENOTCACHED`.
  - A git-dependency lockfile was rejected by the policy.
  - A missing lockfile reported not-run.
  - A pre-aborted request reported not-run.
- Cleanup was confirmed for every container and every staging directory.
- The first real run failed with a duplicate npm config error because `/dev/null` was used for both config paths. This was fixed by giving the user and global configs distinct empty files; the passing run above includes that fix.

Limits of this evidence:
- The npm cache was prepopulated outside the sandbox for this test. Real registry acquisition is not implemented.
- The installed `node_modules` lived in a tmpfs and was discarded with the container. It cannot yet be handed to a build.
- One tiny controlled fixture only. Not production safe. No live worker, no real agents, no wiring to the server or jobs, no untrusted repositories.

Authorship: Kiro wrote the code; an external assistant reviewed and tested it.




## 2026-11-15: integrated controlled fixture pipeline (written by Kiro, NOT executed)

Kiro made file edits only, ran nothing, and touched no frontend or dependency file. Added `backend/src/controlled-pipeline.ts` (host class `ControlledPipeline`: existing lock policy, staging of allowlisted fixture files plus the trusted compiled driver, one container with network none, non-root, caps dropped, read-only operator npm cache, bounded tmpfs `/work` and `/tmp`, `docker inspect` isolation check, proven cleanup, strict one-line JSON protocol, success/failure/not-run), `backend/src/controlled-pipeline-fixtures.ts` (generated trusted build/test scripts), a container entry point in `fixture-pipeline-driver.ts`, mock tests (`controlled-pipeline.test.ts`) and an opt-in harness (`manual-controlled-pipeline-check.ts`, `GRAVEYARD_MANUAL_CONTROLLED_PIPELINE=1`, operator-supplied is-number@7.0.0 fixture and cache, fails closed without them).

Also fixed in `fixture-pipeline-driver.ts`: it used one empty file for both npm user and global config, which the earlier real run showed npm rejects. It now uses two distinct empty files.

Status: unverified. Pending external `tsc` (both configs), the full suite, and the opt-in real Docker run (success, fail build, fail test, cache miss, cleanup). Not wired to the server, worker or any job; controlled fixtures only; no user projects; not production security. Record external results here when available. Details: `backend/DEVELOPMENT.md`.



## 2026-11-15: integrated controlled fixture pipeline (externally verified, narrow)

Docs-only update; Kiro ran no commands and changed no source (no shell). Recorded from the user's external checks. This supersedes the "written by Kiro, NOT executed" and "unverified" status of the integrated controlled fixture pipeline section above, which is left as history. Earlier "pending" notes for it are superseded.

- Test TypeScript build passed.
- Focused tests and the full backend suite passed (counts not supplied to Kiro).
- Real Docker 29.9.2 with local `node:22-alpine`, offline cached `is-number@7.0.0` fixture, through the opt-in harness:
  - success case: install, build and test all succeeded;
  - no-tests case: correctly reported not-run (`tests-not-run`), not a success;
  - failed build and failed test cases: reported as failures;
  - cache miss: reported as an install failure;
  - git-dependency lockfile: rejected by the policy;
  - pre-aborted request: not-run.
- Cleanup was proven.
- An original bug where the no-tests case reported success was corrected before the final verification; the passing results above include the correction.

Authorship: Kiro wrote the source; an external assistant reviewed and ran the tests.

Limits: controlled generated fixtures only. No live jobs, no repository acquisition integration, no registry download (the cache was prepopulated outside the sandbox), no runtime agents. Not wired to the server, worker or jobs. Not production safe and not evidence for arbitrary repositories.




## 2026-11-15: controlled npm registry acquisition (written by Kiro, NOT compiled or run)

Kiro made file edits only (no shell, no dependency or frontend changes). Nothing is wired to the server, worker or any job, and default egress stays unavailable (`UnavailableEgressGuard` never attests).

Added a registry-only variant of the CONNECT proxy (`egress-proxy.ts` option `target: "registry.npmjs.org"`, same rules as the GitHub proxy; GitHub behaviour unchanged), an acquisition class for the single fixed fixture `is-number@7.0.0` (`npm-registry-acquisition.ts`: requires an injected attestation, an `Internal` Docker network whose subnet holds the proxy, isolation read back from `docker inspect` before start, proven cleanup before the output is trusted), an in-container driver (`npm-acquire-driver.ts`: `npm ci --ignore-scripts --no-audit --no-fund` through the proxy), a verified cache handoff (`npm-registry-cache.ts`: no mount, no tar; exact cacache paths, content hashes equal to their paths and to the lockfile integrity, bounded, host-written, lstat-audited, re-read), a composition with the existing network-none pipeline (`registry-pipeline.ts`), mock tests and the opt-in harness `manual-registry-acquisition-check.ts` (`GRAVEYARD_MANUAL_REGISTRY_ACQUISITION=1`).

Status: UNVERIFIED. Pending external `tsc` (both configs), the full suite and the opt-in run. The pinned is-number integrity was written from memory and must be confirmed with `npm view is-number@7.0.0 dist.integrity`. Assumptions about npm's proxy flags, the CONNECT headers it sends, its `added N packages` line and its cache layout are unobserved and fail closed. Details, limits and the run command are in `backend/DEVELOPMENT.md`. Not covered even if it passes: arbitrary repositories, a production egress guard, worker or job wiring.




## 2026-11-15: controlled npm registry acquisition (externally verified, narrow)

Docs-only update; Kiro ran no commands and changed no source (no shell). Recorded from the user's external checks. This supersedes the "written by Kiro, NOT compiled or run" and "UNVERIFIED" status of the registry acquisition section above, which is left as history. Earlier "pending" notes for it are superseded, including the unconfirmed pinned-integrity note.

- Test `tsc` passed. Focused registry and GitHub proxy tests passed, and the full backend suite passed (counts not supplied to Kiro).
- `npm view is-number@7.0.0` confirmed the pinned sha512 integrity.
- Real Docker 29.9.2 with `node:22-alpine`, through the opt-in registry integration:
  - the default guard refused (never attests);
  - the isolated client could not reach 1.1.1.1 or 8.8.8.8 directly;
  - the proxy rejected github.com, example.com, private addresses, the metadata endpoint and a wrong port;
  - the proxy permitted registry.npmjs.org on port 443;
  - the fixed `is-number@7` fetch passed its integrity check;
  - 2 cache files (4404 bytes) were handed off;
  - offline install, build and test then passed on that cache;
  - all labelled containers, the network and temp directories were confirmed cleaned up.

Authorship: Kiro wrote the source; an external assistant reviewed and ran the tests.

Limits: one controlled fixture (`is-number@7.0.0`) on this machine. It does not show behavior for arbitrary repositories or general production isolation. No production `EgressGuard` exists, and nothing is wired to the server, worker or jobs. The default guard still never attests, so acquisition stays disabled in the product.




## 2026-11-15: operator multi-package lockfile v3 fixtures for registry acquisition (written by Kiro, NOT compiled or run)

Kiro made file edits only (no shell, no dependency or frontend changes, only `backend/` and `.kiro/`). Nothing is wired to the server, worker or any job, and default egress stays unavailable (`UnavailableEgressGuard` never attests). This does not change the verification status of the fixed `is-number@7.0.0` path recorded above, which stays as recorded.

Changed:
- New `backend/src/npm-operator-fixture.ts`: `checkOperatorFixture(packageJson, lock)`. Runs the unchanged `checkNpmFixture` first (registry.npmjs.org tarball URLs, one canonical sha512 per entry, no git/url/file/alias/link, no install-script flags). Then narrows: at most 8 packages, lockfileVersion exactly 3, flat unscoped `node_modules/<name>` keys, plain x.y.z versions, unique integrities, production dependencies only (the driver runs npm with NODE_ENV=production, so dev/optional/peer entries would not install), allowlisted package.json fields (so no scripts) that agree with the lock root, every dependency listed and every entry reachable, package.json <= 8 KiB, lockfile <= 64 KiB.
- `npm-registry-acquisition.ts`: new `OPERATOR_FIXTURE_ID` and `operatorFixture` on the request. The fixed fixture rejects operator files; the operator id requires exactly `{ packageJson, packageLock }`. A failing fixture returns `rejected` before the guard is asked or Docker is contacted. Everything after that is the same code: attested Internal network, isolation read back before start, `--ignore-scripts`, proven cleanup, then the host-verified handoff with one expected tarball per lockfile package and npm's `added N` equal to N.
- `registry-pipeline.ts`: comment only. The offline stage must be given the same two files.
- `src/test/manual-registry-acquisition-check.ts`: with `GRAVEYARD_MANUAL_REGISTRY_FIXTURE_DIR` set it loads and policy-checks the operator's two files before Docker, runs the same topology and probes, expects a policy-violating copy to be `rejected` with no container, and expects npm's count to equal the lockfile's. Without the variable the fixed behaviour is unchanged.

Tests added (synthetic data, mocked Docker, no network): `npm-operator-fixture.test.ts` (acceptance, bounds, lockfile shape, package.json, hostile text), operator cases in `npm-registry-acquisition.test.ts` (default guard, reject-before-contact, selector mismatches, exact staged bytes, count mismatch, identical create arguments to the fixed mode, isolation tampering, cleanup gates, real handoff with swapped, missing and unlisted tarballs) and one in `registry-pipeline.test.ts`. Helper: `src/test/operator-fixture-helpers.ts`.

Status: UNVERIFIED. Pending external: `pnpm exec tsc -p tsconfig.json`, `pnpm exec tsc -p tsconfig.test.json`, the full backend suite, then an opt-in run with a real operator lockfile:
```
pnpm run build:test
$env:GRAVEYARD_MANUAL_REGISTRY_ACQUISITION = "1"
$env:GRAVEYARD_MANUAL_REGISTRY_FIXTURE_DIR = "C:\absolute\path\to\fixture"
node --test dist-test/test/manual-registry-acquisition-check.js
```
Kiro supplied no real multi-package lockfile: it has no registry access and would have had to invent integrity values. Unobserved assumptions that fail closed: npm's cache for several packages matches the verifier's layout, the offline `npm ci --offline` accepts it, and the real tarballs fit the driver's export bounds (64 files, 64 KiB per file, 128 KiB total; small packages only). Not covered: that a version satisfies its range (npm ci checks), package contents, scoped or nested packages, arbitrary repositories, a production `EgressGuard`, worker or job wiring.




## 2026-11-15: operator multi-package lockfile v3 fixtures (externally verified, narrow)

Docs-only update; Kiro ran no commands and changed no source (no shell). Recorded from the user's external checks. This supersedes the "written by Kiro, NOT compiled or run" and "UNVERIFIED" status of the operator multi-package lockfile v3 section above, which is left as history. Earlier pending notes for it are superseded.

- Test TypeScript compile passed and the full backend suite passed (counts not supplied to Kiro).
- Real Docker 29.9.2, controlled operator lockfile v3 with two packages, `is-number@7.0.0` and `is-buffer@2.0.5`:
  - both were acquired through the registry-only proxy and passed integrity verification;
  - 4 cache files (7170 bytes) were handed off;
  - offline install, build and tests passed on that cache;
  - a hostile `resolved` URL was rejected before any container was created;
  - the default guard refused (never attests);
  - direct public IP probes and forbidden hosts were blocked;
  - cleanup was confirmed.

Authorship: Kiro wrote the changes; an external assistant reviewed and tested them.

Limits: controlled fixtures only, flat unscoped packages, at most 8 per lockfile. No arbitrary user repository, no production `EgressGuard`, no live worker. Nothing is wired to the server, worker or jobs, and the default guard still never attests, so acquisition stays disabled in the product.




## 2026-11-15: agent foundation compile fix and focused tests (written by Kiro, NOT compiled or run)

Kiro's shell was unavailable, so nothing was compiled or run. Edits only under `backend/` and `.kiro/`; no frontend, dependency or shell changes; nothing wired to the server, worker, runner or any job.

- Fixed the reported TS2367 in `backend/src/kiro-agent.ts`: the post-`await` abort check compared `signal?.aborted === true` after an earlier early return had narrowed it to `false`. Both abort checks now go through an `isAborted(signal)` helper. The reported line (503) does not exist in the file as read, so the cause was found by inspection, not from the compiler. Unverified until `tsc` runs.
- Added `backend/src/test/kiro-agent.test.ts` (fake executor; Analyst and Fixer valid, malformed and bounded output; timeout and abort; argv without shell and without trusted tools; empty controlled cwd; dangerous patches rejected; credential handling; a few real `node` child-process checks of `spawnAgentProcess`) and `backend/src/test/tester.test.ts` (measured passed/failed/not-run, including missing tests as not-run).
- Checked by reading the code and tests: no `--trust-all-tools` (the argv uses `--trust-tools=`), no execution or patch application by the agent modules (patches are proposal-only), no credential in argv, stdin, logs or results.

Status: UNVERIFIED. Pending external `tsc` (both configs), the new tests, and the full suite. Real `kiro-cli` headless behaviour has not been observed. Limits and the command list are in `backend/DEVELOPMENT.md`.



## 2026-11-15: opt-in local worker process and durable result endpoint (written by Kiro, NOT compiled or run)

Kiro used file read, search and edit tools only (no shell, no git, as instructed), and edited only under `backend/` and `.kiro/`. No frontend file, no dependency, no `server.ts`, no schema change.

Added: a separate worker process (`backend/src/worker-main.ts`, `worker-process.ts`, `worker-compose.ts`, `worker-config.ts`, `worker-service.ts`) and `GET /api/jobs/:id/result` (`result-view.ts`, `getJobResultRecord` in `jobs.ts`, route in `routes/jobs.ts`). It is opt-in (`GRAVEYARD_WORKER_ENABLED=1`), runs only fixtures from an operator catalog through the existing network-`none` pipeline, claims nothing while `docker version` fails, and stops gracefully on SIGINT/SIGTERM (an active job is requeued only with cleanup proof). The result view exposes a durable result only for `completed` jobs and keeps diagnosis and patch proposals separate from repair: `repair.verified` and `repair.patchApplied` are always `false`. Tests: `worker-config.test.ts`, `worker-service.test.ts`, `worker-process.test.ts`, `job-result.test.ts`. Docs updated: `backend/DEVELOPMENT.md`, `backend/README.md`, `backend/.env.example` (commented variables), `package.json` (script `worker` only), this file, `KIRO_USAGE.md` and the steering files.

Status: **UNVERIFIED.** Nothing was compiled or run, including the new tests. Real Docker was not used. The earlier external verification (both `tsc` configs, full suite, one real Analyst call) does not cover this change.

Live in code only once an operator builds and starts the worker with the opt-in variables: a worker process that processes catalogued fixtures and a result endpoint that authorized owners can read. Not live: arbitrary repositories (a job for an uncatalogued URL fails as `infrastructure-unavailable`; nothing is cloned or run), acquisition inside jobs, a production `EgressGuard`, patch application, repair verification, a patch endpoint, API-managed worker supervision, and any frontend use of `/result` (the frontend workspace text that says no worker or result endpoint exists is now stale; it was deliberately not changed).

Pending external: both `tsc` configs, the four new test files, the full suite, then a manual real-Docker run of the worker (catalogued fixture with a prepopulated cache; Docker stopped and started; stop signal during a job). Record the results here and in `backend/DEVELOPMENT.md`.



## 2026-11-15: worker process and result endpoint, external verification (docs only)

Kiro ran no commands and changed no source for this record. Reported by the user from external runs; supersedes the "written, not compiled or run" status of the worker process and result endpoint.

- Production `tsc` passed. Test `tsc` passed.
- 87 new focused tests passed (`worker-config`, `worker-service`, `worker-process`, `job-result`).
- The full backend suite passed.
- These tests use mocked Docker (fake docker CLI, fake pipeline, fake cleanup, fake agents). No real-Docker worker run has been performed, and none is claimed.

## 2026-11-15: opt-in real-Docker worker end-to-end harness (written by Kiro, NOT compiled or run)

Kiro added `backend/src/test/manual-worker-e2e-check.ts`, `backend/worker-e2e.env` (only the opt-in switch) and the script `test:worker-e2e` in `backend/package.json`. No shell was used; nothing was compiled or run, **so no real-Docker worker run has occurred**. Single command: `pnpm run test:worker-e2e` (needs `GRAVEYARD_NPM_FIXTURE_DIR`, `GRAVEYARD_NPM_CACHE_DIR`, a running Docker daemon and local `node:22-alpine`). It starts the real API on an ephemeral 127.0.0.1 port and the real worker composition (real Docker executor, agents off) on a temporary database under `backend/.tmp-fixtures`, creates an authorized job for one controlled fixture, polls `GET /result` for at most 240 s, expects `completed` / `passing` with `repair.verified` and `repair.patchApplied` false, then stops the worker, checks for leftover containers and removes the temporary directories. It fails closed when Docker or inputs are missing; it never fakes Docker. Pending: an operator run, recorded in `backend/DEVELOPMENT.md`.


## 2026-11-15: real-Docker worker end-to-end run (externally verified, narrow)

Docs-only update; Kiro ran no commands and changed no source (no shell). Recorded from the user's external checks. This supersedes the "written by Kiro, NOT compiled or run" status of the worker end-to-end harness entry and the "no real-Docker worker run" statements above, which are left as history.

- Docker Desktop server 29.9.2, local `node:22-alpine`, 2026-11-15.
- Both TypeScript builds, 87 focused tests and the full suite passed before the harness; the harness compiled and passed (1 test).
- Controlled single `is-number@7.0.0` offline fixture, real localhost API, real separate worker composition, real Docker, agents off: job `completed`, stage `done`, outcome `passing`, result read with the owner token, cleanup confirmed.

Authorship: Kiro wrote the source; an external assistant reviewed and ran the tests.

Limits: one controlled fixture on this machine. Not verified: real GitHub cloning, agents on this job, repair or patch application (`repair.verified` stays `false`), arbitrary repositories, failing-fixture, uncatalogued-URL, timeout, cancel, stop and Docker-outage cases on real Docker. The frontend workspace text saying no worker or result endpoint exists is still stale and unchanged. Browser visual interaction is still unverified.
