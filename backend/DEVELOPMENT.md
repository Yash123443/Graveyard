# Backend development record

Project owner: Yash. Branch: backend.

## 2026-11-06 — foundation milestone

One bounded Kiro CLI implementation request read the backend requirements/design and created the package, TypeScript configuration, Fastify app, environment validation, server startup/shutdown, 16 tests, environment example and README. Kiro was instructed to write only under backend/ and not run shell commands or modify the frontend.

Review revisions: upgraded Kiro's Fastify 5.4.0 pin to 5.12.8 after the dependency audit reported vulnerabilities; adapted the error handler for unknown error types and generic client messages; removed deprecated logging configuration; ignored compiled test artifacts; clarified isolated installation and simplified the test command. Dependency installation generated backend/pnpm-lock.yaml with pnpm 10.12.1.

Verification: backend TypeScript build passed; 16 tests passed on Node 26.7.0; production dependency audit reported no known vulnerabilities. A temporary localhost server returned HTTP 200 with the expected health JSON. These checks establish only the foundation, not repository diagnosis or repair.

---

## 2026-11-07 — job persistence milestone (initial)

One bounded Kiro CLI request implemented: node:sqlite db module, token utilities, URL validator, jobs repository, POST/GET route handlers, DATABASE_PATH config, app wiring, and tests. See files listed in the correction entry below.

---

## 2026-11-07 — job persistence milestone corrections

A second bounded Kiro CLI request applied corrections following external review of the initial implementation. The test suite had not yet been executed; failures were identified by review, not by a run.

### Corrections applied by Kiro

**app.ts**
- Added `ajv.customOptions: { coerceTypes: false, removeAdditional: false }`.  Without this, Fastify's default AJV instance coerces `"true"` to `true` (passing the boolean consent schema) and silently strips extra properties.
- Added `bodyLimit: 8192` (8 KiB).  Requests exceeding this limit receive 413.
- Added `logger.redact: ["req.headers.authorization"]` so the raw Bearer token never appears in logs.
- Removed incorrect claim that node:sqlite was stabilised on Node.js 22.13.0; the API is experimental on Node.js 22.x.

**db.ts**
- `openDatabase` now closes the handle and re-throws if any pragma or migration step fails, so callers never receive a partially-initialised database.
- `migrate_v1` now uses explicit `BEGIN` / `COMMIT` / `ROLLBACK` statements (not `db.exec` multi-statement) so a migration failure rolls back cleanly.
- `runMigrations` now throws if the on-disk `user_version` exceeds `CURRENT_SCHEMA_VERSION`, preventing a newer-build database from being silently opened by an older build.

**routes/jobs.ts**
- Added an `onRequest` hook that sets `Cache-Control: no-store` on every `/api/jobs*` response, including error replies produced by Fastify before the handler runs (schema validation failures, body-limit errors).
- Replaced the previous ad-hoc Authorization checks with a strict regex `/^Bearer [0-9a-f]{64}$/`.  Any header that does not match (missing, wrong scheme, wrong length, uppercase hex, non-hex) returns 401.
- Both "wrong token on a real job" and "unknown job ID with a well-formed token" now return 403 with an identical body.  When the job is not found, a constant-time comparison against a static dummy hash is performed, so timing cannot distinguish the two cases.  Removed previous false claim that a 404 is safe because the caller "proved" something.

**url.ts**
- Repository segment now uses `/^[A-Za-z0-9_.-]+$/` to permit dots (e.g. `user.github.io`, `my.project`).  The exact strings `.` and `..` are rejected explicitly.  The `./` and `..` substring guards still reject dot-segment traversal sequences.
- Owner segment retains `/^[A-Za-z0-9][A-Za-z0-9_-]*$/` (no dots; GitHub enforces this for org/user names).  Must also start with alphanumeric to reject leading-hyphen names.

**.env.example**
- Added `DATABASE_PATH` entry with default value and comment.

**jobs.test.ts** (full rewrite to remove `require()` calls in ESM and add missing cases)
- All imports are top-level ESM; removed inline `require()` closures that were incorrect in an ESM module.
- Uses production `createJob` (imported from `../jobs.js`) for all direct-DB tests; no duplicate SQL implementation.
- Auth tests reflect corrected model: 401 for malformed header; 403 for both wrong-token on real job and well-formed token on unknown job; test verifies identical response bodies for both 403 cases.
- Added: oversized body → 413; dotted repo name accepted; close/reopen app with original token → 200; future schema version rejection; atomic rollback test using a trigger on `job_events`.

### Tests pending re-execution

The corrected test suite compiles to `dist-test/test/*.js`.  Tests must be run locally via `pnpm test` on Node.js ≥ 22.13.0.  Results are not available in this record; Kiro was instructed not to run shell commands.  Human review and a local test run are required before merging.

---

## 2026-11-07 — cancel endpoint and cleanup (Kiro authored)

A bounded Kiro CLI request applied the following changes.  All edits are Kiro-authored; external review and a local test run are required before merging.  Last externally verified baseline: 101 tests passed.

### Changes

**src/jobs.ts**
- Added `cancelJob(db, jobId)`: conditional UPDATE `status = 'queued' → 'cancelled'` and INSERT of a `cancelled` event in a single atomic transaction.  Returns `{ outcome: "cancelled" | "conflict", job }`.  The `stage` column is deliberately unchanged.  Rollback covers both the UPDATE and the event INSERT; trigger-induced event failures leave status as `queued`.

**src/routes/jobs.ts**
- Added `POST /api/jobs/:id/cancel` route with identical Bearer auth to GET (401 malformed, 403 wrong/unknown token).  200 returns updated metadata; 409 when `cancelJob` returns conflict (already cancelled, terminal, or running).  Covered by the shared `Cache-Control: no-store` hook.

**src/app.ts**
- Fixed `setErrorHandler`: AJV schema validation errors (statusCode 400 with a `validation` array) are now mapped to 422.  Body-size errors (413 from Fastify's `bodyLimit`) pass through unchanged.

**src/url.ts**
- Removed the raw substring dot-segment guard (`raw.includes('./') || raw.includes('..')`).  Exact dot-segment rejection (`.` and `..` as repo names) is handled at the segment-validation step.  Traversal sequences like `/../` or `/owner/..` are caught by the segment count check or the exact-name check without a raw scan, allowing normal dotted names such as `user.github.io`.

**src/test/jobs.test.ts**
- Added cancel test suites: owner cancellation (200, stage unchanged, updatedAt updated, GET reflects cancelled, no token_hash exposure), auth cases (401/403 no mutation, Cache-Control), 409 conflict cases (repeat cancel, no duplicate event, response shape, Cache-Control), and DB-level persistence / trigger-rollback tests for `cancelJob`.
- Added import for `cancelJob as dbCancelJob` from `../jobs.js`.

**README.md / DEVELOPMENT.md**
- Endpoint table and docs updated to include `POST /api/jobs/:id/cancel`.
- Cancel moved out of the "not yet implemented" section.
- DEVELOPMENT.md updated with this entry.



---

## 2026-11-11 — lease primitives and SSE events: final status

Docs-only update; no source edits.

### Implemented (Kiro-authored; externally reviewed and tested)

- Schema v2 additive migration and lease/recovery library primitives in `src/leases.ts` (atomic claim, heartbeat, fencing, cleanup-confirmed requeue, `listRecoveryRequired`, `expireQueuedDeadlines`), with tests in `src/test/leases.test.ts`.
- `GET /api/jobs/:id/events` SSE endpoint (`src/routes/events.ts`, event helpers in `src/jobs.ts`, options in `src/app.ts`) with tests in `src/test/events.test.ts`.

### External verification (2026-11-11)

- Frontend production build passed after merge `8996b9f` (`origin/UI` at `b426aef`).
- Backend: both `tsc` builds pass; 162 tests, 0 failures, including real HTTP SSE tests: replay, live, cancel, stream cap, shutdown, heartbeat, backpressure.
- Docker 29.9.2 running. UI on 127.0.0.1:3000; backend starting on 3002.
- Earlier entries stating tests were not executed are historical and unchanged.

### Not implemented

Execution worker/loop, automatic cleanup and restart-recovery coordinator, sandbox runner, real agents, result/patch endpoints, frontend–backend connection. Nothing in the running server calls the lease primitives yet.



---

## 2026-11-14 — external verification: frontend workspace and backend

Docs-only update; no source or dependency edits. Results recorded from the user's external checks.

### Verified

- Frontend TypeScript + Vite production build passed.
- `scripts/verify-workspace.mjs` passed parser and error-classification checks.
- Local Vite proxy real smoke passed: health, job create, metadata read, cancel, SSE replay. The event response contained no token.
- Backend `tsc` production and test configurations pass.
- Full backend suite: 162 tests, 0 failures. Run outside the sandbox because the sandbox restricts ephemeral localhost ports.
- Workspace and API launched locally on ports 3000 and 3002.

### Not verified

Browser visual interaction. Local browser automation was disabled, so the workspace UI has not been checked visually or interactively.

### Still outstanding

Execution worker, sandbox runner, result endpoint, patch endpoint, frontend visual test. Earlier entries stating that checks were not executed are historical and unchanged.




---

## 2026-11-14 — execution worker foundation (written, NOT executed)

One Kiro CLI request. No shell was available, so `tsc` and the tests were **not run**. Everything below is unverified until built and tested externally.

### Added

- `src/runner.ts`: `JobRunner` interface (`run`, `cleanup`) and `UnavailableRunner`, which fails closed with `infrastructure-unavailable` and can prove cleanup only for executions it refused itself in the same process.
- `src/worker.ts`: `JobWorker` with `runOnce`, `recoverOnce`, `shutdown`; injected clock and timers; heartbeat, deadline and shutdown abort via `AbortSignal`; all outcomes gated on valid cleanup proof.
- `src/leases.ts` (additive): `finishLeasedJob`, `fenceOwnLease`, `recordCleanupUnconfirmed`, `listRecoveryTargets`, `executionIdFor`; two new `InfraError` kinds. Existing functions and schema (v2) unchanged.
- `src/test/worker.test.ts`: fake runner, manual clock and timers. Covers exclusivity, stale-worker fencing, heartbeat, lease expiry, deadline, shutdown, cleanup failures (false, wrong id, empty evidence, throw, no object, timeout), recovery without proof, fail-closed production runner, no fake success, transactional rollback, tokens absent from events.

### Not done

No sandbox, no process entry point or poll loop, no running-job cancellation, no result/patch data. The server does not use the worker. Pending: run `pnpm test` and fix any compile or test failures.




---

## 2026-11-14 — Docker fixture sandbox adapter (written, NOT executed)

One Kiro CLI request. Kiro wrote the files below. No shell commands were run: no `tsc`, no tests, no Docker. Nothing in this entry is verified. Pending: `pnpm test`, then fix any compile or test failures.

### Added

- `src/docker-sandbox.ts`: `DockerFixtureSandbox` (`execute`, `cleanup`), injectable `ProcessExecutor`, and `spawnExecutor` (child_process, `shell: false`, stdin closed, minimal environment without `DOCKER_HOST`, bounded output, timeout and abort kill).
- `src/test/docker-sandbox.test.ts`: tests against a mocked docker CLI.

No dependency, frontend, server, worker or runner changes. The adapter does not implement `JobRunner` and is not instantiated anywhere.

### Behaviour (by design, per the code)

- Command IDs map to argv arrays fixed at construction; images come from an allowlist and use `--pull never`; fixtures are single directories under a configured root, validated by name and `realpath`, mounted read-only at `/fixture`.
- Flow: `docker version` (fail closed) → `create` with `--network none`, `--user 65532:65532`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only`, bounded `/tmp` tmpfs, memory/swap/cpu/pids limits, identifying labels → `inspect` and compare with the intent (not started on mismatch) → `start --attach` with timeout, abort and output cap → explicit `rm`, then `inspect` and a label query as cleanup proof (`CleanupProof` shape from `runner.ts`).
- Cleanup refuses to remove a container whose labels do not match the execution id.

### Tested (mock only, once run)

Argument arrays, absence of shell/privileged/volume/socket/env arguments, isolation violations from tampered inspect output, timeout, abort, Docker unavailable, cleanup failures, and request/config validation. The mock reproduces what a correct `docker inspect` should return; it does not prove Docker enforces these settings.

### Limitations

- Not production safe and not a security review. Controlled local fixtures only; not for arbitrary GitHub repositories.
- Not run against a real Docker daemon. Actual `docker inspect` field formats (for example `Entrypoint`, `SecurityOpt`, mount `Source` on Docker Desktop/Windows) are assumed and may need adjustment; a mismatch makes the adapter refuse to start, not run unsafely.
- Docker defaults for seccomp/AppArmor, no user-namespace remapping, no rootless check, daemon trusted, host kernel shared.
- The exit code comes from `docker start --attach`; a Docker-level failure can be indistinguishable from a container exit code.
- Disk use beyond the tmpfs and log options, and image contents, are not limited or scanned. Images must be prepared locally by the operator; the adapter never pulls.
- `execute` and `cleanup` for one execution id are not serialised against each other.
- `spawnExecutor` is not covered by the tests.
- No network phase, no dependency installation, no result artifacts, no wiring to `JobWorker`.

---

## 2026-11-14 — Docker sandbox: fix after real Docker fixture failure (rerun pending)

### Observed (real Docker 29.9.2, as reported by the operator)

The real fixture test failed at `docker start`: with Docker's default local logging driver, `--log-opt max-file=1` is rejected ("compression cannot be enabled when max file count is 1"). Cleanup was confirmed in that run (container removed, label query empty).

### Changed (`src/docker-sandbox.ts`, `src/test/docker-sandbox.test.ts` only)

- `create` now passes `--log-driver json-file --log-opt max-size=64k --log-opt max-file=1`. The inspect check requires `HostConfig.LogConfig.Type === "json-file"` and `Config` to be exactly `max-size=64k`, `max-file=1`; anything else is an `isolation-violation` and the container is not started.
- A nonzero `docker start` exit code is re-checked with `docker inspect`. It is reported as `exited` only if `State.Running` is false, `State.Error` is empty, `StartedAt` is set, and `State.ExitCode` equals the exit code. Otherwise (never started, daemon error, state unreadable) the result is `unavailable`, not a fixture failure. Cleanup runs in every case.
- Fixture mount `Source` from inspect must equal the realpath-resolved fixture directory exactly (strict string comparison; a Docker Desktop/Windows path format difference will fail closed).
- `/tmp` tmpfs options must include `noexec`, `nosuid`, `nodev` and `size=<tmpfsMb>m`, and must not include `exec`, `suid`, `dev` or `ro`.
- Mock tests added or extended for each of these. Mock tests were not run in this change.

### Status

Nothing was executed in this change: no `tsc`, no tests, no Docker. Superseded by the external verification entry below.

---

## 2026-11-14 — Docker sandbox: external real-Docker verification

Docs-only update; no source edits. Recorded from the user's external checks; Kiro ran no commands.

### Verified

- Docker Desktop 29.9.2; official `alpine:3.21` pulled locally.
- Controlled echo fixture: exit code 0, output `fixture-ok`, network `none`, cleanup confirmed.
- Controlled read-only bind mount of `backend/src/test`: listing succeeded, cleanup confirmed.
- Test compile passed; 91 mock sandbox tests passed.
- The earlier real failure (log options rejected by the default logging driver) was fixed by passing `--log-driver json-file` explicitly.

### Not established

- This is not proof the sandbox is production-safe or safe for arbitrary repositories. Only two controlled local fixtures ran.
- No worker integration, no clone or acquisition, no agent runtime. The adapter is not a `JobRunner` and is not used by the server.
- Timeout and cancel behaviour, and resource limits, have not been tested against real Docker.

### Next steps

1. Controlled build/test fixture.
2. Real Docker tests for timeout and cancel.
3. Secure acquisition design.

The "written, NOT executed" notes in the two preceding Docker entries are historical and left unedited.


---

## 2026-11-14 — real Docker timeout/cancel fixtures (reported, docs only)

Recorded from the user's external run; Kiro ran no commands and changed no source for this fact.

- Real Docker timeout fixture: the container was stopped and container cleanup was confirmed.
- Real Docker cancel fixture: the container was stopped and container cleanup was confirmed.

Limits: two controlled local fixtures only, against `DockerFixtureSandbox` (network `none`). This does not cover acquisition, a network, resource-limit enforcement under load, or arbitrary repositories. The exact commands and output were not supplied to Kiro.

---

## 2026-11-14 — safe public GitHub acquisition foundations (written, NOT executed)

One Kiro request. No shell was used: no `tsc`, no tests, no Docker, no git, no network. **Nothing here is verified.** Tests pending external run (`pnpm test`); expect to fix compile or test errors.

### Result

Safe acquisition **cannot be enabled yet** because no controlled egress proxy exists and none was invented. The code provides the policy, the adapter and an always-failing default guard, so acquisition is disabled and fails closed until real infrastructure is attested.

### Added (no dependencies, no server/worker/frontend changes, no live jobs)

- `src/acquisition-policy.ts` (pure, no I/O):
  - Source identity: canonical URL from `url.ts` plus a full lowercase 40-hex SHA. Branches, tags, short SHAs and option-like strings are rejected.
  - `EgressGuard` interface and `UnavailableEgressGuard` (always `verified:false`). Attestation validation: dedicated network name (not `bridge`/`host`/`none`/`default`/etc.), `http://host:port` proxy without credentials, allowlist exactly `["github.com"]`, non-empty evidence.
  - Bounded limits with range and consistency checks: depth, memory, cpu, pids, disk (tmpfs size), file count, total bytes, tree-listing bytes, output bytes, step/total/control timeouts.
  - Git hardening as `-c` arguments and environment: no hooks, prompts, credential helpers, system/global config; only HTTPS; no submodule recursion; LFS smudge/process disabled; no redirects; `core.symlinks=false`; `transfer.fsckObjects`.
  - Tree policy applied to `git ls-tree -r -l -z` output before checkout: rejects symlinks, unknown modes, absolute/`..`/backslash/control-character paths, `.git` components, case-colliding paths, too many files, oversize; gitlinks (submodules) are counted and skipped.
- `src/git-acquisition.ts`: `GitAcquisition.acquire` / `cleanup`, using only the injected `ProcessExecutor` (argument arrays, no shell). Flow: validate → egress attestation (fail closed) → `docker version` → `docker network inspect` must show `Internal: true` → create (attested network, non-root, `--cap-drop ALL`, read-only root, no binds/ports/devices/Docker socket, no host env, tmpfs-only `/work` and `/tmp`, memory/swap/cpu/pids limits, `--pull never`) → read back with `docker inspect` and compare, no start on mismatch → start → `docker exec git` steps (init, shallow fetch of the SHA, identity check, tree listing and policy check, checkout, final HEAD check) → force-remove and prove absence by inspect and label query. Honours `AbortSignal` between and during steps, and a total deadline.
- `src/test/acquisition-policy.test.ts`, `src/test/git-acquisition.test.ts`: mocked docker CLI only.

### What is and is not verifiable

- The only network property this code checks itself is that the Docker network is `Internal`. It does **not** and cannot check that the proxy restricts traffic to github.com, blocks private/metadata addresses, or is the only reachable endpoint. That is the `EgressGuard`'s claim, made by infrastructure that does not exist yet. Nothing here claims a secured network, and the default bridge is refused by name and by the inspect read-back.
- A successful result proves a verified commit and tree manifest inside a tmpfs that is destroyed with the container. There is no export step, so nothing yet hands source to a build runner.
- `docker exec` timeout/abort kills the CLI client only; the git process stops when the container is force-removed in cleanup.
- Requirements on the operator image: it must contain `git` and `sleep`, is allowlisted and never pulled. Not built or tested.
- Not covered: DNS inside the network, proxy TLS behaviour, Docker/Windows inspect field differences for the new tmpfs and network checks (a mismatch fails closed), seccomp/AppArmor beyond defaults, daemon trust, concurrent `acquire`/`cleanup` for one id.

### Next steps

1. Run `pnpm test`; fix any compile or test failures.
2. Build the egress proxy infrastructure outside this repo's code path: an `Internal` Docker network, a dual-homed proxy permitting CONNECT to `github.com:443` only and denying private, link-local, metadata and loopback destinations; implement an `EgressGuard` that actively tests those properties and attests them.
3. Prepare a minimal git image (`git`, `sleep`, no other tooling) and run real fixtures against a local test repository first, then one known public repository, with the guard in place.
4. Design the export step (tar from the container with path/size verification) feeding a build/test fixture.
5. Only then implement `JobRunner` integration and enable jobs.


---

## 2026-11-14 — controlled egress proxy core (written, NOT executed)

One Kiro request. No shell was used: no `tsc`, no tests, no Docker, no real network or DNS. **Nothing here is verified.** Pending: `pnpm test`; expect to fix compile or test errors. The tests open 127.0.0.1 ephemeral ports, so they must run outside the sandbox that restricts them.

### Added (no dependencies, no frontend, no server/worker/acquisition wiring)

- `src/egress-proxy.ts`: `EgressProxy` (Node `http` server using the `connect` event), pure helpers `classifyIp`, `validateBindHost`, `validateConnectAuthority`, `validateConnectRequest`, `checkEgressProxyLimits`, and default `systemResolver` / `directConnector`.
- `src/test/egress-proxy.test.ts`: adversarial tests with injected resolver and connector against a local echo upstream.

### Behaviour (by design, per the code)

- Binds only to a configured private or loopback IP literal. There is no default; `0.0.0.0`, `::`, public addresses and host names throw at construction.
- Accepts only `CONNECT github.com:443` (HTTP/1.1) with the authority equal to that exact string. Other methods get 405. Absolute-form targets, paths, credentials, other ports or hosts, IP literals, case variants and malformed authorities are rejected before any DNS or connect. Rejections never echo client text.
- Rejects `Proxy-Authorization`, `Authorization`, `Content-Length`, `Transfer-Encoding`, `Upgrade`, `Expect`, duplicate or mismatched `Host`, control, DEL or non-ASCII bytes in headers, oversized or too many headers, and bytes sent before the 200 reply.
- Resolves only the fixed name `github.com`. If any answer is not public unicast the request is refused (loopback, private, CGNAT, link-local and 169.254.169.254 metadata, multicast, reserved, documentation, and IPv6 outside 2000::/3 including mapped, compatible, NAT64, 6to4, Teredo). The connector receives one validated IP literal and never a name, which pins the address against DNS rebinding. Each CONNECT resolves again.
- After a bare `200 Connection Established` the bytes are relayed untouched (TLS passthrough). No redirect handling, no header or credential forwarding.
- Bounds: concurrent connections, bytes per tunnel (both directions), header size and count, header-read, DNS, connect and idle time, tunnel duration. `close()` aborts pending DNS/connects, ends tunnels and destroys sockets.

### Not done, not claimed

- No Docker network, no attestation, no `EgressGuard` that uses this proxy. `UnavailableEgressGuard` is still the only guard, so default egress stays unavailable and acquisition stays disabled. Nothing instantiates `EgressProxy`.
- Nothing proves a container can reach only this proxy. Client authentication is the network binding only; there is no per-client rate limit.
- The system resolver is trusted for which public IP `github.com` maps to. A poisoned resolver that returns an attacker's public address is not detected here; the client's TLS verification is the control.
- Not run against real github.com, real DNS or real git. Not production ready; not a security review.

### Next steps

1. Run `pnpm test`; fix any compile or test failures.
2. Run the proxy against real github.com on a host, with real `git` through `http.proxy`.
3. Build the Internal Docker network and dual-homed proxy deployment, and an `EgressGuard` that actively tests isolation before attesting.



---

## 2026-11-14 — opt-in Docker egress topology harness (written, NOT executed)

One Kiro request. No shell was used: no `tsc`, no tests, no Docker. **Nothing here is verified.** Pending: build, then one external run. No production code, dependency, frontend, server, worker or guard changes. `UnavailableEgressGuard` is still the only guard.

### Added

- `src/test/manual-egress-check.ts`. It is skipped unless `GRAVEYARD_MANUAL_EGRESS=1`, so `pnpm test` (which globs `dist-test/test/*.js`) reports it as skipped and never touches Docker.

### What it builds (names carry a random per-run id and a `graveyard.manual-egress=<id>` label)

- An `--internal` bridge network with a random `10.200-239.x.0/24` subnet. A subnet collision makes `network create` fail, which stops the run.
- Proxy container from the existing `node:22-alpine` (`--pull never`): internal network at a fixed `.2` address plus the default `bridge` for upstream. It runs the compiled `EgressProxy`, bound to its internal address on port 3128. The app files (`egress-proxy.js`, `acquisition-policy.js`, `url.js`, a `package.json` with `"type":"module"`, a small `run.mjs`) are copied to a fresh temp directory and mounted read-only.
- Client container from `alpine:3.21`: internal network only, `sleep`.
- Both containers: non-root, `--cap-drop ALL`, `no-new-privileges`, read-only root, tmpfs `/tmp`, memory, cpu and pids limits.

### Checks (from inside the client, via `docker exec`, argument arrays, no shell)

1. Positive control: client opens TCP to the proxy.
2. Direct TCP/443 to `1.1.1.1` and `8.8.8.8` fails.
3. `CONNECT example.com:443`, `169.254.169.254:80` and `10.0.0.1:443` each return 403.
4. `CONNECT github.com:443` returns 200. This needs the proxy container to resolve and reach github.com over the default bridge, so it depends on the host's real network.

### Fail-closed conditions

Docker unreachable; `node:22-alpine` or `alpine:3.21` not present locally (never pulled); compiled files missing; network not reported `Internal`; client or proxy attached to networks other than intended (checked before start); proxy not running (logs are printed); client cannot reach the proxy; overall 90 s deadline; per-command timeouts. On any of these the run prints `FAIL-CLOSED` and states that no claim is made.

### Node in the proxy container

The proxy container uses the official `node:22-alpine` image, which includes Node, and runs `node /app/run.mjs` directly. No host Node is mounted and `GRAVEYARD_EGRESS_NODE_DIR` is no longer used. The client uses `alpine:3.21`. Both images must already exist locally (both containers use `--pull never`); the harness checks for them first and fails closed if either is missing.

Both containers set `--log-driver json-file --log-opt max-size=64k --log-opt max-file=1`, to avoid problems with Docker's `local` default log driver.

### Cleanup

Only resources the run attempted to create are touched. Each is removed (`rm -f`, `network rm`) only after its label equals the run id, then checked for absence. Remaining resources are listed with the run id. The temp directory is deleted. SIGINT triggers the same cleanup. A cleanup problem fails the test.

### Run (outside the restricted sandbox)

```powershell
pnpm run build:test
$env:GRAVEYARD_MANUAL_EGRESS = "1"
node --test dist-test/test/manual-egress-check.js
```

### What a pass does not establish

- That `--internal` blocks every escape path (IPv6, DNS, host gateway, other published services, Docker Desktop VM routes). Only two public IPs on port 443 are probed.
- That the proxy is the only reachable endpoint, or that proxy/client attachments stay fixed after the check.
- That the proxy is safe against a hostile client, or that the topology is safe on another host.
- An `EgressGuard` or attestation. The harness does not produce one. Turning its checks into a guard is a later, separate step.

Record the external result (pass, fail, or fail-closed message) in this file and in `.kiro/PROJECT.md`.

## 2026-11-14 — egress proxy: real Docker finding and IPv4-only resolution

External real Docker integration result (Kiro ran no commands): direct egress from the container was blocked, disallowed targets were blocked, the GitHub request through the proxy failed, and container cleanup was confirmed. Failure cause: `github.com` resolved to public IPv4 `135.235.149.144` and NAT64-synthesized IPv6 `64:ff9b::4ba:9dc0`; the proxy rejected the mixed set with `blocked-address`. Fail-closed behaviour was correct.

Edits by Kiro (unverified, not compiled, not run):
- `systemResolver` uses `dns.promises.lookup(host, { all: true, family: 4 })`.
- The proxy rejects any non-IPv4 answer with 403 `non-ipv4-address` and still validates every address with `classifyIp`. The first validated IPv4 is pinned and given to the connector as an IP literal. No IP validation was relaxed; NAT64 addresses are never accepted.
- `EgressResolver` interface unchanged.
- Tests in `egress-proxy.test.ts`: removed the IPv6 fallback test and the v6+v4 happy path; added rejection of v4+v6, the observed NAT64 pair, v6-only, public v4 mixed with private/loopback/metadata v4 in both orders, and IPv4 pinning with multiple answers.

Pending: external `tsc -p tsconfig.json`, `tsc -p tsconfig.test.json`, `node --test dist-test/test/*.js`, and a Docker re-run to see whether the GitHub request now succeeds. The proxy is still unwired and acquisition stays disabled. No network permissions were added.
