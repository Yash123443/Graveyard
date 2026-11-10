# Backend foundation design

Status: proposed. Based on the Kiro-generated draft described in requirements.md, reviewed and revised during development.

## Components

- backend/: independent Node/TypeScript package, Fastify with JSON Schema validation.
- SQLite: jobs, events, logs and artifact metadata; atomic job claims and WAL mode. Select driver after checking installed Node and deployment compatibility.
- Worker: separate process, single active job, durable claim/lease and bounded retries.
- Sandbox: disposable restricted Docker execution; dedicated worker VM, non-root, dropped capabilities, resource limits, timeouts and cleanup.
- Agent adapter: Analyst consumes evidence; Fixer proposes bounded patches; Tester records actual runner results. Kiro runtime feasibility remains outstanding.

## API contract

POST /api/jobs: repository URL and consent -> job ID and owner authorization mechanism.
GET /api/jobs/:id: current state.
GET /api/jobs/:id/events: authorized SSE stream and replay.
GET /api/jobs/:id/result: completed result compatible with frontend RepairResult.
GET /api/jobs/:id/patch: complete unified diff.
POST /api/jobs/:id/cancel: cancellation request.

Stages: queued, cloning, analyzing, diagnosing, repairing, building, testing, verifying, done. Separate lifecycle status tracks queued, running, completed, failed, cancelled and timed-out states. The full event/ownership schema will be fixed before implementing job creation.

## Review decisions following the Kiro-generated draft

1. Kiro proposed truncating patches at 500 lines. Reject oversized repair proposals instead: truncated diffs can be unusable.
2. Kiro proposed no network throughout execution. Dependency acquisition needs a controlled registry-only phase/cache; builds and tests use no network by default. Block private-network and metadata endpoints. Do not enable unrestricted egress to make installation work.
3. Kiro proposed failing every nonterminal job on startup. Preserve queued jobs and recover only expired worker claims after ensuring stale containers are terminated. API restart must not invalidate a live worker.
4. Kiro placed timeout/restart messages in rootCause. Keep infrastructure errors in job metadata; repository cause remains unknown unless supported by evidence.
5. Kiro did not specify owner authorization in its draft. It is required before exposing job routes. Browser SSE authentication must not leak bearer tokens into URLs.
6. Kiro described WAL as eliminating contention. SQLite still needs busy handling and atomic claims; API and worker share a local database on the same host, not a network filesystem.
7. Kiro suggested both Zod and Fastify schemas. Use Fastify JSON Schema initially to avoid duplicated validation dependencies.
8. The original planning request did not implement code. A subsequent Kiro CLI request implemented the foundation; backend/DEVELOPMENT.md records its verification and review changes. Runtime repair integration remains unproven.

## Review of the subsequent Kiro IDE requirements expansion

Preserve the EARS structure. Corrected defaults to apply only to missing configuration; qualified error-handler verification; added queued lifecycle status; separated terminal status from stage; required fenced worker writes and confirmed cleanup before bounded recovery; made execution deadlines survive restarts; handled queued cancellation; defined SSE reconnect deduplication; and kept inconclusive checks as not-run instead of reporting false failures. No additional Kiro request was used for this review.

## Lease primitives (schema v2, unverified)

Claims use BEGIN IMMEDIATE with per-claim random lease tokens; the deadline (15 min) is set on first claim only and attempts are bounded (default 2). Expired leases are fenced (token voided, `recovery_required` set, recovery token issued) and never auto-requeued; `confirmRecoveryCleanup` requeues, fails (attempts exhausted) or times out the job with infrastructure metadata only. The module cannot itself prove containers stopped; that remains the job of the future recovery coordinator/sandbox. Pending external verification.

## First implementation milestone

Create the independent backend package with a health endpoint, configuration validation, structured errors and compile/run instructions. Confirm runtime/tool versions before choosing package versions. Do not accept or execute repository jobs in this milestone.
