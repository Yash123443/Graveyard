# GRAVEYARD — Project Record

Factual summary. Not a verbatim log.

## Overview

GRAVEYARD is an immersive 3D cemetery UI (React / Three.js) where each gravestone represents an abandoned GitHub repository. The planned real workflow: clone a repository, analyse it, diagnose problems, repair code, build, test, and verify. Three agent roles drive the workflow — Analyst (investigates), Fixer (repairs), Tester (verifies).

The UI is currently a demonstration. Real backend integration is pending.

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

Not executed: no build, type-check, or browser test was run by Kiro (no shell). `node scripts/verify-workspace.mjs` (parser and error-classification checks) has not been run. Results are pending external verification.
- Frontend–backend connection (the UI does not yet call the backend)

## Current verification status (as of 2026-11-11)

Externally verified on 2026-11-11:

- Frontend production build passed after merge `8996b9f` (`origin/UI` at `b426aef`).
- Backend: both `tsc` builds pass; 162 tests, 0 failures, including real HTTP SSE tests (replay, live, cancel, stream cap, shutdown, heartbeat, backpressure).
- Docker 29.9.2 running. UI observed running on 127.0.0.1:3000; backend was starting on 3002 (not confirmed up at time of writing).

Earlier baseline (2026-11-07, Node 26.7): both `tsc` builds exit 0; 121 tests passed, 0 failed. Kept as history.

All source changes for the lease and SSE milestones were authored by Kiro; the external assistant reviewed and ran tests. Next milestone: execution worker/runner (not started).

## Task list

See [specs/backend-foundation/tasks.md](specs/backend-foundation/tasks.md) for the full numbered task list and completion status.

## Development log

See [../backend/DEVELOPMENT.md](../backend/DEVELOPMENT.md) for the milestone-by-milestone record of changes, corrections, and verification results.
