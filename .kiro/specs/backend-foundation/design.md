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

## Execution worker foundation (unverified, unwired)

`worker.ts` coordinates one job at a time against an injected `JobRunner` (`run`, `cleanup`). Terminal and recovery writes are fenced by lease token, unexpired lease and deadline (`finishLeasedJob`); voluntary release goes through `fenceOwnLease` then `confirmRecoveryCleanup`. Completion, failure, requeue and timeout need runner cleanup proof for the exact execution id (`jobId:attempt`); without it the job stays fenced and blocked with a single `cleanup-unconfirmed` record. The production runner (`UnavailableRunner`) fails closed: jobs end `failed` with `infrastructure-unavailable`, never `completed`, and recovery of executions it did not create stays blocked. Not yet built: sandbox runner, poll loop/process entry, periodic recovery, running-job cancellation, result data. Code was written without running the compiler or tests.

## Docker fixture sandbox adapter (unverified, unwired)

`docker-sandbox.ts` runs fixed commands from a construction-time registry in a disposable container, through an injectable subprocess executor with argument arrays and no shell. It creates the container, reads back `docker inspect` and refuses to start on any isolation mismatch, then proves cleanup by inspect and label query, returning the `CleanupProof` shape the worker expects. Docker unavailability fails closed. It is limited to controlled local fixtures, does not implement `JobRunner`, and is not production safe. Written without running the compiler, tests or Docker; see backend/DEVELOPMENT.md for limitations.

## Acquisition foundations (unverified, unwired, disabled)

`acquisition-policy.ts` holds pure policy; `git-acquisition.ts` is the clone adapter over the same injectable `ProcessExecutor` as the Docker sandbox (argument arrays, no shell). Source identity is the canonical `https://github.com/owner/repo` URL plus a full lowercase 40-hex SHA. Git runs inside a disposable container with hooks, prompts, credential helpers, non-HTTPS protocols, submodule recursion, LFS smudge, redirects and real symlink creation disabled, and bounded depth, output, time and disk (a size-limited tmpfs `/work`). The commit's tree is listed and checked (symlinks, path escape, `.git` components, case collisions, file count, size) before checkout; the HEAD identity is verified again after.

Network: this follows review decision 2 (no unrestricted egress). The adapter runs only when an injected `EgressGuard` attests a dedicated network and an HTTP proxy allowing exactly `github.com`, and `docker network inspect` shows that network as `Internal`. The default guard never attests, so acquisition fails closed. The proxy and its allowlist are not implemented and cannot be verified by this code; the default bridge is never used and never described as secured. Successful acquisition currently ends in a tmpfs that disappears with the container; an export step and `JobRunner` integration are not built. Written without running the compiler, tests, Docker or git.

## First implementation milestone

Create the independent backend package with a health endpoint, configuration validation, structured errors and compile/run instructions. Confirm runtime/tool versions before choosing package versions. Do not accept or execute repository jobs in this milestone.
