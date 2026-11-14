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
- Authorization header redaction from logs
- Schema v2 migration and lease/recovery **library primitives** (`src/leases.ts`: claim, heartbeat, fencing, cleanup-confirmed requeue, `listRecoveryRequired`, `expireQueuedDeadlines`). These are library functions only; nothing in the running server invokes them.

## Backend — not yet implemented

- Execution worker / worker loop / sandbox runner
- Automatic cleanup and restart-recovery coordinator
- Real agents (Analyst / Fixer / Tester) and repair pipeline
- Result and patch endpoints

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
