# Tech

## Stack
- Frontend (repo root): React 19, Three.js, Vite, TypeScript.
- Backend (`backend/`): Node.js >= 22.13.0, Fastify 5, TypeScript, SQLite via `node:sqlite`.
- Package manager: pnpm 10.12.1 (both workspaces).
- Validation: Fastify JSON Schema (AJV). Do not add Zod alongside it.
- Dev proxy: Vite forwards same-origin `/api` to `127.0.0.1:3002`; only `/api/health` is rewritten to `/health`.

## Data
- SQLite with versioned migrations, atomic rollback on failure, and rejection of future schemas.
- WAL mode plus busy handling and atomic claims (`BEGIN IMMEDIATE`). API and worker share a local database on one host, never a network filesystem.

## Sandbox isolation
- Disposable Docker containers: non-root, dropped capabilities, resource limits, timeouts, confirmed cleanup.
- Commands run via argument arrays and an injectable executor. No shell.
- Network is `none` by default. Dependency acquisition needs a controlled registry-only phase. Block private-network and metadata endpoints. Never enable unrestricted egress to make installs work.
- Git acquisition runs only when an injected `EgressGuard` attests an internal network with an allowlist proxy for `github.com`. The default guard never attests, so acquisition stays disabled.
- GitHub flow (opt-in, 2026-11-15; compiled and unit-tested externally per the user, NOT run against real Docker or GitHub): only when the operator sets `GRAVEYARD_GITHUB_CATALOG` and the `GRAVEYARD_GITHUB_*` variables does the worker wire `OperatorEgressGuard` (checks an operator-provisioned internal network and single-host proxy; a spot check, not proof of isolation). Jobs are only for operator-pinned full SHAs; the host reads four root files as git blobs, never the repository. Unsupported repositories complete as `unsupported-repository`; nothing unsupported is built. Repository code runs only in the network-`none` container. Never present this path as verified until external results are logged.

## Fail-closed security rules
- Docker unavailable, isolation mismatch after `docker inspect`, or unconfirmed cleanup: refuse or block. Never report success.
- The production runner (`UnavailableRunner`) fails jobs with `infrastructure-unavailable`, never `completed`.
- Worker writes are fenced by lease token, unexpired lease, and deadline. Expired leases are never auto-requeued. Requeue needs cleanup proof for the exact execution id.
- Owner bearer token: hashed storage, constant-time comparison, 401/403 gating on all job routes.
- Bearer tokens must never appear in URLs, logs, or events. The Authorization header is redacted from logs.
- `Cache-Control: no-store` on all `/api/jobs*` responses.
- Infrastructure errors go in job metadata, not `rootCause`.
- Worker (opt-in, separate process `dist/worker-main.js`): disabled unless `GRAVEYARD_WORKER_ENABLED` is exactly `1`. Runs operator-catalogued fixtures and, only if configured, operator-pinned GitHub commits (see above); any other repository URL fails as `infrastructure-unavailable` and nothing is cloned or run. Claims no job while `docker version` fails. A job ends only after cleanup proof. The API server never starts it.
- `GET /api/jobs/:id/result`: owner bearer gated, `no-store`. A result is exposed only for `completed` jobs. A diagnosis or patch proposal is never presented as a repair. `repair.patchApplied` is always false (the original is never modified). `repair.verified` is true only for outcome `repair-verified` (2026-11-16, NOT compiled or run): the stored `verification` record is independently re-checked (observed pipeline and Tester statuses of a patched disposable copy, confirmed cleanup, sha256 of the exact diff) and `verifiedDiff` is then exposed.
- Repair verification (`src/repair-verifier.ts`, 2026-11-16, NOT compiled or run): one patch class (complete root `build.mjs` only; original `test.mjs` required and unchanged), pure in-memory application with exact position re-checks, no subprocess to apply, a disposable `run-<hex>` copy removed on every path, the offline network-`none` pipeline reused with the baseline's execution id only after confirmed baseline cleanup and strictly serially. Inconclusive verification fails the job as infrastructure; abort records nothing. Never weaken the Docker, proxy or egress policy for it.
- Do not claim an unverified control is secure.
