# Requirements Document

## Introduction

GRAVEYARD is an interactive 3D memorial for abandoned software repositories. The backend is a Node.js/TypeScript/Fastify API that accepts a public GitHub repository URL, orchestrates an automated repair workflow (clone → analyze → diagnose → repair → build → test → verify), and streams structured progress and results to the frontend.

This document specifies the backend requirements. Implementation is incremental: Milestone 1 (health endpoint, configuration, structured errors) is complete. Remaining milestones cover job persistence, SSE streaming, sandboxed execution, AI agent adapters, and frontend integration.

Project owner: Yash. Development provenance: Kiro CLI generated the initial draft and, in a separate request, implemented the foundation package. Kiro IDE subsequently expanded this requirements document into EARS format. The draft and expansion were reviewed and revised during development; design.md records review decisions. This document is not a verbatim session transcript. Review revisions are not attributed to Kiro.

## Glossary

- **API**: The Fastify HTTP server defined in `backend/src/app.ts` and started by `backend/src/server.ts`.
- **Worker**: A separate Node.js process that claims one job at a time and executes it.
- **Sandbox**: A disposable, restricted Docker container in which repository code is executed.
- **Job**: A unit of work representing one repository repair attempt, persisted in SQLite.
- **Owner**: The authenticated principal (browser session or capability token) who created a job.
- **RepairResult**: The frontend-compatible result object with fields defined in Requirement 9.
- **SSE**: Server-Sent Events — the streaming protocol used for job progress delivery.
- **EARS**: Easy Approach to Requirements Syntax — the pattern system used throughout this document.

## Requirements

### Requirement 1: Health Endpoint

**User Story:** As an operator, I want a health endpoint, so that I can verify the service is running without exposing configuration or secrets.

**Status: Implemented** — `GET /health` is live in `backend/src/app.ts` v0.1.0. Tests pass in `backend/src/test/app.test.ts`.

#### Acceptance Criteria

1. WHEN a `GET /health` request is received, THE API SHALL respond with HTTP 200.
2. WHEN a `GET /health` request is received, THE API SHALL return a JSON body containing exactly the fields `status` (string) and `version` (string), with no additional properties.
3. WHEN a `GET /health` request is received, THE API SHALL set `Content-Type` to `application/json`.
4. THE API SHALL NOT include `PORT`, `HOST`, `LOG_LEVEL`, or any other configuration key in the `/health` response body.
5. THE API SHALL NOT include stack traces, internal error messages, or secret values in any response body sent to clients.

### Requirement 2: Configuration Validation

**User Story:** As a developer, I want all environment variables validated at startup, so that misconfigured deployments fail immediately with a clear error rather than silently misbehaving.

**Status: Implemented** — `loadConfig` in `backend/src/config.ts` validates `PORT`, `HOST`, and `LOG_LEVEL` before the server binds. Tests pass in `backend/src/test/app.test.ts`.

#### Acceptance Criteria

1. WHEN the API process starts, THE API SHALL call `loadConfig` and validate `PORT`, `HOST`, and `LOG_LEVEL` before binding to any TCP port.
2. WHEN one or more environment variables are invalid, THE API SHALL throw an error listing all invalid variables in a single message and exit before accepting connections.
3. IF `PORT` is not an integer in the range 1–65535, THEN THE API SHALL include an `Invalid PORT` message in the startup error.
4. IF `HOST` is an empty or whitespace-only string, THEN THE API SHALL include an `Invalid HOST` message in the startup error.
5. IF `LOG_LEVEL` is not one of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`, THEN THE API SHALL include an `Invalid LOG_LEVEL` message in the startup error.
6. THE API SHALL NOT echo the invalid value back in any error message.
7. WHEN a configuration variable is absent, THE API SHALL use its default: `PORT=3002`, `HOST=127.0.0.1`, `LOG_LEVEL=info`. Explicit valid values SHALL be preserved.

### Requirement 3: Structured Error Responses

**User Story:** As a frontend developer, I want consistent error response shapes, so that I can handle all error cases with a single parser.

**Status: Implemented; partially verified** — 404 and 500 handlers are registered in `backend/src/app.ts`. Existing tests cover 404 responses; dedicated 500 and logging-severity checks remain pending.

#### Acceptance Criteria

1. WHEN a request is received for a route that does not exist, THE API SHALL respond with HTTP 404 and a JSON body containing `statusCode` (integer), `error` (string), and `message` (string).
2. WHEN an unhandled error occurs during request processing, THE API SHALL respond with HTTP 500 and a JSON body containing `statusCode`, `error`, and `message`.
3. THE API SHALL NOT include stack trace frames or `Error:` prefixes in any response body.
4. WHEN a client error occurs (4xx), THE API SHALL log it at a lower severity than server errors (5xx).

### Requirement 4: Input Validation — Repository URLs

**User Story:** As a security engineer, I want all repository URL inputs validated strictly, so that malicious inputs cannot reach the clone or execution layer.

**Status: Pending** — no job routes exist yet.

#### Acceptance Criteria

1. WHEN a job creation request is received, THE API SHALL validate the repository URL before performing any business logic.
2. THE API SHALL accept only HTTPS URLs whose host is exactly `github.com`.
3. THE API SHALL accept only URLs whose path consists of exactly two non-empty segments matching `owner/repository`.
4. IF a URL contains credentials, query parameters, fragment identifiers, dot segments (`./`, `../`), or path segments beyond `owner/repository`, THEN THE API SHALL reject the request with HTTP 422 and a descriptive error message that does not echo the submitted URL verbatim.
5. THE API SHALL use argument arrays — not shell string interpolation — when passing repository paths to `git` or any subprocess.

### Requirement 5: Job Lifecycle and Persistence

**User Story:** As a user, I want my repair job to survive API restarts and worker crashes, so that my result is not lost due to infrastructure failures.

**Status: Pending.**

#### Acceptance Criteria

1. WHEN a job creation request passes validation, THE API SHALL persist the job in SQLite with a unique ID, owner reference, repository URL, and `queued` stage before returning a response.
2. WHEN the API restarts, THE API SHALL preserve all `queued` jobs without modification.
3. WHEN a worker lease expires, THE recovery coordinator SHALL fence the old worker's writes and confirm termination of its execution container before allowing re-claim. An API restart alone SHALL NOT invalidate a live worker lease.
4. THE Worker SHALL claim a job atomically so that no two Worker processes can hold the same job simultaneously.
5. IF a Worker process exits unexpectedly while holding a job, THEN recovery SHALL follow criterion 3, retain execution evidence and enforce a bounded recovery count. If cleanup cannot be confirmed, the job SHALL remain blocked from re-execution and record an infrastructure error. Recovery SHALL NOT reset the repair-attempt budget or job deadline.
6. THE API SHALL support the following job stages in order: `queued`, `cloning`, `analyzing`, `diagnosing`, `repairing`, `building`, `testing`, `verifying`, `done`.
7. THE API SHALL track a lifecycle status separately from the stage: `queued`, `running`, `completed`, `failed`, `cancelled`, `timed-out`. Stage records the current or last attempted operation; only completed jobs reach the `done` stage.

### Requirement 6: Owner Authorization

**User Story:** As a user, I want only authorized parties to read my job results, so that repair output and logs are not accessible to strangers with a job ID.

**Status: Pending.**

#### Acceptance Criteria

1. WHEN a job is created, THE API SHALL associate it with an owner identity using a session token or job-scoped capability token.
2. WHEN a request is received for `GET /api/jobs/:id`, `GET /api/jobs/:id/events`, `GET /api/jobs/:id/result`, `GET /api/jobs/:id/patch`, or `POST /api/jobs/:id/cancel`, THE API SHALL verify the caller holds the owner credential for that job.
3. IF the credential is absent or invalid, THEN THE API SHALL respond with HTTP 401 before returning any job data.
4. IF the credential is valid but belongs to a different job, THEN THE API SHALL respond with HTTP 403.
5. THE API SHALL NOT transmit bearer tokens or session secrets as URL query parameters (to prevent leakage in logs and browser history).

### Requirement 7: SSE Job Event Stream

**User Story:** As a frontend developer, I want a real-time event stream with replay support, so that the UI stays consistent across reconnects without polling.

**Status: Pending.**

#### Acceptance Criteria

1. WHEN an authorized `GET /api/jobs/:id/events` request is received, THE API SHALL respond with `Content-Type: text/event-stream` and begin streaming job events.
2. THE API SHALL persist every job event to SQLite in insertion order with a monotonically increasing sequence number.
3. WHEN a reconnecting client sends a `Last-Event-ID` header, THE API SHALL replay all events with a sequence number greater than the provided ID before streaming new events.
4. THE API SHALL transition from replay to live delivery without gaps and emit each sequence number once per connection. Across reconnects delivery is at-least-once; THE client SHALL deduplicate using event IDs. State changes and their events SHALL be committed atomically.
5. WHEN a job reaches a terminal lifecycle status (`completed`, `failed`, `cancelled`, `timed-out`), THE API SHALL send a persisted final event and close the SSE connection cleanly. THE client SHALL stop automatic reconnection after receiving that event.

### Requirement 8: Cancellation and Timeout

**User Story:** As a user, I want to cancel a running job and trust that the system enforces timeouts, so that runaway executions do not consume resources indefinitely.

**Status: Pending.**

#### Acceptance Criteria

1. WHEN an authorized `POST /api/jobs/:id/cancel` request is received for a running job, THE Worker SHALL stop the active container or process and record a `cancelled` terminal status after cleanup completes.
2. THE Worker SHALL enforce a persisted execution deadline with a default of 15 minutes from first claim, independently of API availability. Queue waiting SHALL have a separate expiry policy.
3. WHEN a job exceeds its execution deadline, THE Worker or recovery coordinator SHALL terminate its active execution and confirm cleanup before recording a `timed-out` terminal status.
4. IF a job has already reached a terminal status, THEN THE API SHALL respond to a cancel request with HTTP 409 (Conflict) and the current terminal status.
5. THE API SHALL record cancellation and timeout as job metadata, not as repository root-cause evidence.
6. WHEN cancellation is requested for a queued job, THE API SHALL atomically cancel it so a worker cannot subsequently claim it. Running-job cancellation SHALL be persisted and remain effective across restarts.

### Requirement 9: RepairResult Contract

**User Story:** As a frontend developer, I want the job result to match the RepairResult interface, so that I can display repair outcomes without format conversion.

**Status: Pending.**

#### Acceptance Criteria

1. WHEN a completed job result is requested via `GET /api/jobs/:id/result`, THE API SHALL return a JSON body with the following fields: `repositoryName` (string), `rootCause` (string), `breakingDependency` (string), `breakingVersion` (string), `repairsAttempted` (array), `changesMade` (array), `buildResult` (`passed` | `failed` | `not-run`), `testResult` (`passed` | `failed` | `not-run`), `verificationResult` (`passed` | `failed` | `not-run`), `finalStatus` (`success` | `failed` | `partial`).
2. THE API SHALL set `finalStatus` to `success` only when `buildResult`, `testResult`, and `verificationResult` are all `passed`.
3. WHEN a repository has no test suite, THE API SHALL set `testResult` to `not-run` and SHALL NOT set `finalStatus` to `success`.
4. IF a job ends due to infrastructure error, cancellation, or timeout, THEN THE API SHALL preserve completed check outcomes, map unstarted or inconclusive checks to `not-run`, and record interruption details in job metadata. Only a completed check with evidence of failure SHALL be `failed`. THE API SHALL NOT invent a repository root cause or report success.
5. THE repairsAttempted and changesMade fields SHALL contain only strings. THE API SHALL distinguish an unavailable final report from a completed report and never fabricate a result while the job is still running.

### Requirement 10: Sandboxed Execution

**User Story:** As an operator, I want repository code to run in isolated containers, so that untrusted scripts cannot affect the host or access credentials.

**Status: Pending.**

#### Acceptance Criteria

1. THE Worker SHALL execute all repository scripts (dependency acquisition, build, test) exclusively inside disposable Docker containers.
2. THE Sandbox SHALL run as a non-root user with dropped Linux capabilities.
3. THE Sandbox SHALL enforce CPU, memory, and wall-clock resource limits.
4. THE Sandbox SHALL have no access to Docker socket, host credential files, or broad host mounts.
5. WHEN a Sandbox container exits — whether normally or via timeout or cancellation — THE Worker SHALL remove the container before recording the terminal job status.
6. WHERE a controlled dependency registry cache is configured, THE Sandbox SHALL permit outbound connections to that registry only during the acquisition phase; build and test phases SHALL have no outbound network access.
7. THE Sandbox SHALL block connections to private-network ranges and cloud metadata endpoints at all times.

### Requirement 11: Bounded Logging

**User Story:** As an operator, I want log output bounded in size, so that a misbehaving repository cannot exhaust storage or leak secrets.

**Status: Pending.**

#### Acceptance Criteria

1. THE API SHALL bound captured log output per job by a configurable maximum byte count.
2. THE API SHALL bound captured log output per job by a configurable maximum line count.
3. THE API SHALL bound the length of any single captured log line.
4. WHEN any bound is reached, THE API SHALL record a truncation indicator in the stored log rather than silently discarding output.
5. THE API SHALL NOT write credentials, session tokens, or secret environment variable values to any log output.

### Requirement 12: Patch Artifact Integrity

**User Story:** As a developer, I want downloadable patches to be complete and valid, so that I can apply them with confidence.

**Status: Pending.**

#### Acceptance Criteria

1. WHEN a patch is available and requested via `GET /api/jobs/:id/patch`, THE API SHALL return a complete unified diff applicable to the source commit identified in the job report.
2. IF the generated patch exceeds the configured size limit, THEN THE API SHALL reject the repair proposal entirely and return an explicit `artifact-unavailable` error; THE API SHALL NOT return a silently truncated patch.
3. THE API SHALL identify the exact source commit (full SHA) in the job report alongside reproduction evidence, commands run, files changed, and unresolved uncertainty.

### Requirement 13: Untrusted Data Handling

**User Story:** As a security engineer, I want repository content treated as untrusted, so that adversarial repositories cannot subvert the worker or agent.

**Status: Pending.**

#### Acceptance Criteria

1. THE Worker SHALL treat all repository file contents and subprocess output as untrusted data.
2. THE Worker SHALL NOT execute arbitrary instructions found in repository files outside the defined acquisition, build, and test commands.
3. THE Worker SHALL NOT allow repository-supplied content to override worker security restrictions or container configuration.
4. THE API SHALL limit repair attempts to a configurable maximum, initially two attempts per job.

### Requirement 14: Kiro Runtime Integration Feasibility

**User Story:** As the project team, I want runtime Kiro integration validated before adoption, so that we do not build on an unproven dependency.

**Status: Pending — feasibility check not yet performed.**

#### Acceptance Criteria

1. BEFORE THE API relies on Kiro runtime for automated diagnosis or repair, THE project team SHALL verify feasibility covering: authentication mechanism, structured output format, deployment model, cancellation support, and per-job cost.
2. IF any feasibility criterion cannot be satisfied, THEN THE project team SHALL document the gap and adopt an alternative agent adapter.
