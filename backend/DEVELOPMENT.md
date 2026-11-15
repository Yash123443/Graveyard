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

## 2026-11-15 — archive handoff into node fixture build/test (combined test PENDING external verification)

Written by Kiro without running any tool. Not compiled, not run.

- `src/archive-handoff.ts`: `extractArchiveIntoFixture(archive, runDir, name, limits, expect)` requires a real (non-symlink) `run-<12 hex>` directory and a strict fixture name, creates `<runDir>/<name>` non-recursively (an existing directory is refused), extracts with `extractTar` through `ConfinedDirSink` (relative-path re-check, resolve prefix check, parent must be a real directory, exclusive create, modes 0644/0755), then compares the archive commit comment, file count and byte total with the expectation and audits the tree with `lstat` (`auditTree`: no symlinks or special files, bounded depth and entries). It never throws; on failure after creation it returns the directory so the caller can run `removeRunDir`. `buildGitArchiveTar` builds a tar in `git archive` layout (pax global header with `comment=<sha>`, directory entries, files). It is not produced by git.
- `src/test/archive-handoff.test.ts`: real filesystem under `os.tmpdir()`, no Docker. Covers all four fixture kinds, exact manifest/commit/audit, existing-target refusal, commit/count/byte mismatches, bad run directories and names, symlink run directory (skipped if symlinks are not permitted), traversal archive, byte limit, and `removeRunDir` removing the exact tree.
- `src/test/manual-archive-build-check.ts`: opt-in (`GRAVEYARD_MANUAL_ARCHIVE_BUILD=1`, local `node:22-alpine`, never pulled). For each of pass / fail-test / fail-build / no-tests it extracts the generated archive into a fresh directory, runs `NodeFixtureRunner.verify` (network `none`, read-only `/fixture` mount, isolation read back from `docker inspect` before start; `isolation-violation` is reported as a problem), and expects passed/passed, passed/failed, failed/not-run, passed/not-run. A tampered archive (wrong commit) must be refused with no container. It requires confirmed cleanup for every stage, queries `docker ps -a` by each exact `graveyard.execution-id` label and by name prefix `graveyard-archfix-<run id>`, and removes the run directory with `removeRunDir`.

Scope limits: archives are generated locally, not by `git archive`, and no network clone is tested in this combined test. The real-clone handoff is covered only by the separate narrow result below. No untrusted repository, no `npm install`, no live job, no worker wiring. The read-only mount and network `none` are enforced and checked by the existing sandbox inspect step; this harness does not re-inspect the container independently.

Run (outside the restricted sandbox):

```powershell
pnpm run build:test
$env:GRAVEYARD_MANUAL_ARCHIVE_BUILD = "1"
node --test dist-test/test/manual-archive-build-check.js
```

Pending external: `tsc -p tsconfig.json`, `tsc -p tsconfig.test.json`, the full suite, and the opt-in run. Record results here and in `.kiro/PROJECT.md`.

### Real clone handoff into NodeFixtureRunner (manual-clone-check.ts) — PENDING

Written by Kiro without running any tool. Previously measured externally (not by Kiro): the real-clone harness on octocat/Hello-World at `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`, 1 file / 13 bytes, cleanup confirmed. Current change, unverified: `manual-clone-check.ts` now extracts the real `git archive` via `extractArchiveIntoFixture` (validation before writes; commit, file and byte expectations from the ls-tree manifest) into `backend/.tmp-fixtures/run-<hex>/clone`, then for that known URL and SHA only (and only if 1 file / 13 bytes and no `build.mjs`) calls `NodeFixtureRunner.verify` on the original files. Expected: build `not-run`/`no-build-script`, test `not-run`, overall `not-run`, no container, no leftover by `graveyard.execution-id` label; `removeRunDir` removes the exact run directory. This is not a build success; a real pass is demonstrated only by `manual-archive-build-check.ts` with controlled generated fixtures. The harness's narrow attestation (internal network, proxy attachments, example.com refusal probe) is not proof of isolation. The audit in `extractArchiveIntoFixture` caps at 1000 entries and depth 8, so larger repositories fail closed.

Run (outside the restricted sandbox; images must exist locally, nothing is pulled):

```powershell
pnpm run build:test
$env:GRAVEYARD_MANUAL_CLONE = "1"
$env:GRAVEYARD_CLONE_REPO_URL = "https://github.com/octocat/Hello-World"
$env:GRAVEYARD_CLONE_COMMIT = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d"
$env:GRAVEYARD_CLONE_IMAGE = "graveyard-git-fixture:local"
node --test dist-test/test/manual-clone-check.js
```

---

## 2026-11-15 — controlled real-clone harness and safe handoff (externally verified, narrow)

Status update (external, 2026-11-15; supersedes the "UNVERIFIED" text below, kept as history): the opt-in real-clone harness cloned `octocat/Hello-World` at SHA `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`, extracted 1 file / 13 bytes via the tar handoff, and cleanup was confirmed. The full suite and 60 focused tests passed. This is narrow: one tiny public repository, not production proof. Kiro ran no commands for this update.

Original status: written by Kiro without running any tool. Acquisition stays disabled in production (`UnavailableEgressGuard`); nothing is wired into the server or worker.

Added or changed:
- `src/tar-extract.ts`: validate-first tar extractor for `git archive` output. Accepts only regular files, directories and one pax global header. Rejects symlinks, hard links, devices, per-entry pax, GNU long names, unsafe or case-colliding paths, file/dir conflicts, base-256 sizes, bad checksums, trailing data. Bounds archive bytes, file count and content bytes. Nothing is written unless the whole archive validates. Modes are reduced to 0644/0755.
- `src/git-acquisition.ts`: new optional `afterCheckout` hook (`HandoffInfo`), run after the final HEAD check and before cleanup. A throw becomes `failed` at step `handoff`; cleanup still runs. Production code never sets it.
- `src/test/manual-clone-check.ts`: opt-in harness (`GRAVEYARD_MANUAL_CLONE=1`). Needs `GRAVEYARD_CLONE_REPO_URL` and `GRAVEYARD_CLONE_COMMIT` (exact 40-hex SHA of a known public fixture); image from `GRAVEYARD_CLONE_IMAGE`, default `alpine/git:2.47.2`, never pulled. Builds the internal network and proxy container like `manual-egress-check.ts` (topology code is copied, not shared). Its guard exists only in that file and attests only after the harness saw the network Internal, the proxy attached to exactly bridge + internal, and a 403 for `example.com:443`. The acquisition container has no mounts. Handoff runs `docker exec ... git archive` with argument arrays, a byte cap and timeout, extracts into a fresh `mkdtemp` directory with exclusive-create, requires file count and bytes to equal the `ls-tree` manifest and the archive commit comment to equal the requested SHA, audits the output with `lstat`, then deletes it. The proxy container bind-mounts one temp directory (four compiled files, read-only).
- Tests (mocked, in-memory): `src/test/tar-extract.test.ts`, plus two hook tests appended to `git-acquisition.test.ts`.

Run (outside the restricted sandbox):

```powershell
pnpm run build:test
$env:GRAVEYARD_MANUAL_CLONE = "1"
$env:GRAVEYARD_CLONE_REPO_URL = "https://github.com/<owner>/<repo>"
$env:GRAVEYARD_CLONE_COMMIT = "<full 40-hex sha>"
node --test dist-test/test/manual-clone-check.js
```

Not established: that any of this compiles or passes; real `git archive` output compatibility (fixtures with `export-ignore`/`export-subst` or paths over 100 bytes fail closed by design); proxy allowlist enforcement beyond one probe; isolation beyond `--internal`; a production export path. There is still no handoff to a runner. Record external results here and in `.kiro/PROJECT.md`.



---

## 2026-11-15 — controlled Node fixture build/test runner and opt-in harness (externally verified)

### External verification result (2026-11-15)

Recorded from the user's external checks. Kiro ran no commands for this update (docs-only, no source edits, no shell). This supersedes the earlier "written, NOT executed / unverified" status below, which is kept as history.

- `tsc -p tsconfig.json` and `tsc -p tsconfig.test.json` both pass.
- 66 focused mock tests pass.
- The full backend test suite passed (count not supplied to Kiro).
- Real Docker 29.9.2 with local `node:22-alpine` passed four controlled cases via the opt-in harness:
  - `pass`: build passed, then 2 tests passed.
  - `fail-test`: build passed, failing test detected as failed.
  - `fail-build`: build failed, test stage skipped (not-run).
  - `no-tests`: build passed, missing tests reported as not-run.
- Container cleanup was confirmed for every stage, and the temporary fixtures were removed.
- The real Docker test was initially paused, then the user unpaused it.
- Authorship: runner, fixtures and tests by Kiro; review and test execution external.

Not established by this result: any `npm install` or dependency acquisition, untrusted or arbitrary repositories (hostile fixture code can still forge its own output), acquisition handoff into a build, `JobWorker`/`JobRunner` wiring, or a production result. Nothing is wired to the server, worker or jobs. The real-clone harness and tar handoff and the egress proxy IPv4-only edits remain separately recorded and are not covered by this entry.

Next steps (supersede the list at the end of this section): integrate the acquisition handoff into a controlled build, then secure dependency acquisition, then the worker.

### Original record (written before the external run)

One Kiro request, edits only (no shell, no dependencies, no frontend). At the time of writing nothing had been compiled or run.

Scope: controlled generated fixtures only. Not wired to the server, worker, `JobRunner` or any job. It does not make arbitrary repositories safe to run.

### Added

- `src/node-fixture-runner.ts`: `NodeFixtureRunner` over `DockerFixtureSandbox` (unchanged). Fixed registry, selected by stage name only:
  - build: `node /fixture/build.mjs /tmp/out`
  - test: `node --test --test-reporter=tap` (cwd `/fixture`)
  No shell, no npm, no install. Image `node:22-alpine`, allowlisted, never pulled. Network `none`, non-root, caps dropped, read-only root, fixture mounted read-only at `/fixture`, writable bounded noexec tmpfs `/tmp` (16 MB), limits 256 MB / 1 cpu / 64 pids / 60 s / 64 KB output per stream.
  - Each stage runs in its own fresh container, so `/tmp` output does not survive. The fixture's tests rebuild into `/tmp/graveyard-test-out` themselves (deterministic build+test in one container).
  - `runStage(stage, {executionId, fixture, timeoutMs?, signal?})` and `verify({idPrefix, fixture, ...})` (build as `<prefix>:1`, test as `<prefix>:2`; test is skipped unless the build passed or if the signal aborted between stages).
- Status rules (pure functions `classifyBuild`, `classifyTest`, `parseBuildMarker`, `parseTapCounts`):
  - `passed` needs exit 0, untruncated output, machine-checked evidence and confirmed container cleanup. Build: a `GRAVEYARD_BUILD_OK files=<n> bytes=<n>` line (n >= 1) at line start. Test: TAP summary with `tests`, `pass`, `fail`, `cancelled`; `fail` and `cancelled` zero, `pass >= 1`, `pass <= tests`.
  - `failed`: nonzero exit, or any failed/cancelled count (even with exit 0).
  - `not-run`: no `build.mjs` (checked host-side, nothing started); zero tests (missing tests); all tests skipped/todo; missing or inconsistent summary; missing build marker; truncated output with exit 0; timeout; cancellation; Docker unavailable; isolation mismatch (container not started); rejected request; a would-be pass whose cleanup was not confirmed (`cleanup-unconfirmed`). A nonzero exit with truncated output is still `failed`.
  - Overall run: `failed` if any stage failed, `passed` only if both passed, else `not-run`.
  - Result carries sanitised (printable ASCII) 2000-character stdout/stderr tails, counts, exit code, truncation flag and the sandbox `CleanupProof`.
- `src/fixture-workspace.ts`: `ensureOwnedParent` (`backend/.tmp-fixtures`, gitignored; refuses a symlink), `createRunDir` (`run-<12 hex>`, non-recursive mkdir), `writeFixture` (strict name and path segment patterns, bounded file count and size, exclusive create), `removeRunDir` (target must be a real directory named `run-<12 hex>` directly under the owned parent; lstat walk unlinks files and symlinks themselves, bounded depth and entries; no recursive `rm`; never throws).
- `src/node-fixture-files.ts`: four generated fixtures (`pass`, `fail-test`, `fail-build`, `no-tests`). Node built-ins only, no `package.json` dependencies or scripts, no network or child-process use.
- `src/test/node-fixture-runner.test.ts` (mocked docker CLI): registry and create arguments, build/test status mapping, truncated output, timeout, cancellation (signal reaches `docker start`, pre-aborted creates nothing), Docker unavailable, isolation mismatch, rejected inputs, cleanup proof (unconfirmed downgrades a pass, failure stays failure, thrown start still cleans up), `verify` sequencing.
- `src/test/fixture-workspace.test.ts`: real filesystem under `os.tmpdir()` only: path validation, exclusive create, removal refusals (wrong name/location, symlink), fixture content sanity. Symlink tests skip if symlinks cannot be created.
- `src/test/manual-node-fixture-check.ts`: opt-in harness, skipped unless `GRAVEYARD_MANUAL_NODE_FIXTURE=1`. Requires a reachable daemon and a local `node:22-alpine`. Generates the four fixtures under `backend/.tmp-fixtures/run-<hex>`, runs `verify` on each, compares with the expected statuses (pass: passed/passed; fail-test: passed/failed; fail-build: failed/not-run; no-tests: passed/not-run), requires confirmed cleanup for every stage, checks `docker ps -a` for leftovers, removes the directory with `removeRunDir`. Any mismatch fails the test.
- `backend/.gitignore`: added `.tmp-fixtures/`.

Run (outside the restricted sandbox):

```powershell
pnpm run build:test
$env:GRAVEYARD_MANUAL_NODE_FIXTURE = "1"
node --test dist-test/test/manual-node-fixture-check.js
```

### Assumptions that real runs may contradict (all fail closed as not-run or isolation-violation)

- `node --test --test-reporter=tap` on `node:22-alpine` prints `# tests/pass/fail/cancelled` summary lines at line start, and exits 0 with `# tests 0` when no test files exist.
- `node --test` runs and `import()` from `/tmp` work under the noexec tmpfs, read-only root, uid 65532 and the 64-pid, 256 MB limits.
- Docker Desktop reports the bind-mount `Source` in the same form as the host path passed to `--mount` (otherwise the adapter reports an isolation violation), and file sharing covers `backend/.tmp-fixtures`.

### Not established

- (Historical, superseded by the external verification result at the top of this section for the four controlled fixtures.) Mocked tests prove the mapping logic only; real Docker and Node behaviour is now evidenced only for those four fixtures.
- Fixture code controls its own output, so a hostile fixture could forge the marker or TAP summary. This is acceptable only for controlled fixtures and is a reason arbitrary repositories remain out of scope.
- No dependency installation, no network phase, no acquisition handoff, no `JobRunner` integration, no agent runtime. Cleanup proof is only as good as `docker inspect` and the label query.

### Next steps

Superseded: steps 1 and 2 are done (see the external verification result above). Remaining: integrate the acquisition handoff into a controlled build, then secure dependency acquisition, then the worker.

## 2026-11-15: external verification of real GitHub acquisition (docs only)

Kiro ran no commands and changed no source. Results are reported by the user from external runs. This supersedes earlier "pending" and "unverified" statements for the egress proxy IPv4 fix, acquisition and controlled runner; those entries are left as history.

- `octocat/Hello-World` at exact SHA `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d` was acquired via the proxy. The validated handoff held one file of 13 bytes.
- The controlled `NodeFixtureRunner` reported no build script and tests not run (no failure). No runner container was created.
- Acquisition cleanup was confirmed and the temp directory removed.
- Full test suite passed. Test TypeScript compilation passed.
- Earlier controlled generated archive to Docker build/test suites passed for success, fail, missing and tampered cases.

Not verified: real GitHub build success, live jobs, dependency installation, a deployed egress guard. Acquisition stays disabled by default because the default `EgressGuard` never attests.

Authorship: Kiro wrote the code; an external assistant reviewed and tested it.



---

## 2026-11-15 — controlled offline `npm ci` foundation for test fixtures (written, NOT executed)

One Kiro request, edits only. No shell was used: no `tsc`, no tests, no Docker, no npm, no network. **Nothing here is verified.** Pending external: `tsc -p tsconfig.json`, `tsc -p tsconfig.test.json`, the full suite (existing sandbox and node-fixture tests must still pass after the additive sandbox change), then the opt-in harness. Expect to fix compile or test errors. No dependency, frontend, server, worker, job or `JobRunner` changes; no live repository is touched and nothing is claimed about arbitrary repositories.

### Added

- `src/npm-lock-policy.ts` (pure, no I/O): `checkNpmFixture(packageJsonText, lockText)`. A preliminary allowlist, not production security. Accepts only lockfileVersion 2 or 3 with at most 200 `packages` entries, each a plain `node_modules/...` key with a strict semver version, `resolved` exactly `https://registry.npmjs.org/<name>/-/<file>-<version>.tgz` and one 64-byte `sha512-` integrity. Rejects git/http/file/link/tarball/alias specs, workspaces, `overrides`/`resolutions`/`packageManager`/`pnpm`, bundled dependencies, install-time scripts (root `preinstall`/`install`/`postinstall`/`prepare`, entry `hasInstallScript`), `link`, `inBundle`, aliases, `os`/`cpu`/`libc` filters (they make the expected package count unknowable), size overruns (16 KiB / 512 KiB) and malformed JSON. A bounded walk applies the same rules to a legacy v2 `dependencies` tree.
- `src/npm-install-runner.ts`: `NpmInstallRunner.install({executionId, fixture, timeoutMs?, signal?})`, never throws. Host-side steps run before any process exists: request validation, fixture resolved inside `fixturesRoot`, `package.json` and `package-lock.json` read as regular files (symlinks refused, size capped), policy check. Only those two validated byte strings plus an empty `node_modules` mount point are copied into a fresh directory under `stagingRoot`; nothing else from the source directory is copied, so a stray `.npmrc` or `.git` never reaches the container.
  - Fixed argv, no shell, nothing from the request: `npm ci --offline --ignore-scripts --no-audit --no-fund --no-update-notifier --logs-max=0 --cache /npm-cache --userconfig /fixture/.npm-user-config --globalconfig /fixture/.npm-global-config`. The two config files are distinct, empty, runner-created files in the read-only staged directory (the earlier `/dev/null` for both made npm exit 1 with `double-loading config`). Neither is `.npmrc`, no host config is copied, and `removeStaged` refuses to delete them if non-empty. UNVERIFIED until rerun externally: `tsc` builds, `node --test`, and the real Docker fixture.
  - Container (through `DockerFixtureSandbox`): network `none`, non-root `65532:65532`, caps dropped, read-only root, `--pull never`, no environment variables, memory 512 MB, 128 pids, 90 s, 64 KB output per stream, isolation read back from `docker inspect` before start. The staged directory is the read-only `/fixture`; `/fixture/node_modules` and `/tmp` are 64 MB `noexec` tmpfs mounts (the install lives in memory and disappears with the container); the operator's cache is a read-only bind at `/npm-cache`.
  - Status is independent of build/test status: `success` needs exit 0, untruncated output, npm's own `added N packages` line with N equal to the lock's package count, confirmed container cleanup and removed staging. `failure` is a nonzero npm exit (for example an offline cache miss). `not-run` covers no `package.json`, no lockfile, policy rejection, missing or invalid cache or roots, timeout, cancel (before or during), Docker unavailable, isolation mismatch, truncated or missing or mismatched summary, unconfirmed container cleanup and unremoved staging. Timeout and cancel are never failures or successes.
- `src/docker-sandbox.ts` (additive, defaults unchanged): optional construction-time `readonlyBinds` and `extraTmpfs` (validated targets, no duplicates or reserved `/tmp` and `/fixture`, tmpfs size 1 to 256 MB). The inspect read-back now requires exactly the expected tmpfs set with `noexec,nosuid,nodev,size=` and exactly the expected bind mounts (read-only, exact source). Without extras the behaviour is the same as before; the tmpfs violation messages are now phrased per mount.
- `src/test/npm-lock-policy.test.ts`: accepted inputs and about 70 rejection cases (pure).
- `src/test/npm-install-runner.test.ts`: mocked docker CLI with real temporary directories. Covers the fixed argv and create arguments (no env, ports, volumes, source directory never mounted), staged contents, success, failure, each not-run reason, isolation tampering of the new tmpfs and cache mounts, cleanup and staging-removal downgrades, host-side rejections that must not contact Docker, collision refusal, and sandbox extra validation.
- `src/test/manual-npm-install-check.ts`: opt-in (`GRAVEYARD_MANUAL_NPM_INSTALL=1`).

### Why the real test needs operator input

A passing install needs a lockfile with real registry `resolved` URLs and real sha512 integrity values, and a cache holding exactly those tarballs. Kiro cannot produce these without the registry and did not invent them. A locally built tarball would not have a registry `resolved` URL and would be rejected by the policy. So the opt-in harness fails closed unless the operator supplies `GRAVEYARD_NPM_FIXTURE_DIR` (a small `package.json` + `package-lock.json`) and `GRAVEYARD_NPM_CACHE_DIR` (a cache prepopulated for exactly that lockfile, prepared outside this harness). The harness mounts the cache read-only, generates its own negative fixtures (an uncached registry-form package, a git-resolved lock, a missing lockfile, a pre-aborted request), and checks confirmed cleanup, an empty staging directory and an independent `docker ps -a`. Run (outside the restricted sandbox):

```powershell
pnpm run build:test
$env:GRAVEYARD_MANUAL_NPM_INSTALL = "1"
$env:GRAVEYARD_NPM_FIXTURE_DIR = "C:\path\to\fixture"
$env:GRAVEYARD_NPM_CACHE_DIR = "C:\path\to\npm-cache"
node --test dist-test/test/manual-npm-install-check.js
```

### Assumptions that real runs may contradict (all fail closed as failure or not-run, never success)

- npm prints `added N package(s) in <time>` at the start of a line with `--no-audit --no-fund`.
- `npm ci` empties a tmpfs mounted at `node_modules` instead of trying to remove the mount point.
- A read-only cache is enough for an offline install with `--logs-max=0` (npm may still try to write inside the cache).
- Docker can mount a tmpfs inside a read-only bind mount when the mount point exists in the source; Docker Desktop reports bind sources in the host form.
- The image `node:22-alpine` provides `npm` on `PATH` for uid 65532.

### Not established

- That any of this compiles or passes. The mock tests prove mapping logic only.
- That the policy is complete or secure: it does not check what the packages contain, that an integrity hash matches a registry, or how npm resolves edge cases. It is preliminary and not production security.
- Success rests on npm's own stdout. The installed tree is not inspected (it lives in a tmpfs that is destroyed with the container), and a hostile package cannot be ruled out of printing at line start, so this is for controlled fixtures only.
- No build or test runs against the installed modules, no `JobRunner` or worker integration, no acquisition handoff into an install, no network phase, no dependency acquisition from a registry. Nothing uses `NpmInstallRunner` outside the tests.
- Pending: record external results here and in `.kiro/PROJECT.md`.


---

## 2026-11-15 — offline `npm ci` for a controlled fixture: external verification (docs only)

Kiro ran no commands and changed no source. Results are reported by the user from external runs. This supersedes the "written, NOT executed" status of the offline `npm ci` entry above (including its "UNVERIFIED until rerun externally" note on the config fix); that entry is left as history.

### Verified

- Test TypeScript compilation passed.
- The full backend test suite passed (count not supplied to Kiro).
- Real Docker 29.9.2 with local `node:22-alpine`, via the opt-in harness `manual-npm-install-check.ts`:
  - Controlled `is-number@7.0.0` fixture: offline `npm ci` succeeded, 1 of 1 packages.
  - Uncached package: failed correctly with `ENOTCACHED`.
  - Git-dependency lockfile: rejected by the lock policy.
  - No lockfile: not-run.
  - Pre-aborted request: not-run.
  - Cleanup was confirmed for every container and every staging directory.
- The first real run failed with a duplicate npm config error because `/dev/null` was used for both the user and global config. The fix uses distinct, empty, runner-created config files; the passing run includes it.

### Limits

- The npm cache was prepopulated outside the sandbox for the test. Real registry acquisition remains unimplemented; there is no controlled registry-only network phase.
- The installed `node_modules` lived in a tmpfs and was discarded with the container. It cannot be handed to a build yet.
- One small controlled fixture. The lock policy is preliminary. Not production safe, not evidence for arbitrary or untrusted repositories.
- Nothing is wired to the server, `JobWorker`, `JobRunner` or jobs. No live worker, no real agents.

Authorship: Kiro wrote the code and tests; an external assistant reviewed and ran them.

### Next steps

1. Design controlled registry-only dependency acquisition (no unrestricted egress).
2. Hand an installed dependency tree to the build/test runner.
3. Worker integration.


---

## 2026-11-15 — integrated controlled fixture pipeline: host orchestration (written, NOT executed)

Kiro made file edits only. No shell command, `tsc`, test, Docker or npm was run, and no frontend or dependency file was touched. Everything below is **unverified** until an operator runs it and logs the result here and in `.kiro/PROJECT.md`.

### What was added

- `src/controlled-pipeline.ts`: `ControlledPipeline`, a host class for CONTROLLED fixtures only (not a `JobRunner`, not wired to the server, worker or jobs, not for user projects or live jobs).
  - Host checks before any container: fixture name and path inside `fixturesRoot`; `package.json`, `package-lock.json` and `build.mjs` read as capped regular files (symlinks refused), optional `test.mjs`; `checkNpmFixture` (the existing lock policy) on package.json + lockfile; the compiled driver read from `fixture-pipeline-driver.js` (optionally pinned with `expectedDriverSha256`).
  - Staging: exactly those files plus the driver (staged as `fixture-pipeline-driver.mjs`) into a fresh directory. A stray `.npmrc` or `.git` never reaches the container. The directory is removed afterwards, and only if it holds exactly the expected files.
  - Container (existing `DockerFixtureSandbox`): network none, uid 65532, caps dropped, no-new-privileges, read-only root, `--pull never`. Staged dir read-only at `/fixture`, operator npm cache read-only at `/npm-cache`, `/work` and `/tmp` bounded noexec tmpfs (64 MiB each). 512 MiB memory, 128 pids, 120 s, 128 KiB output. Isolation is read back with `docker inspect` before start; cleanup is proven by inspect and a label query.
  - Fixed command: `node /fixture/fixture-pipeline-driver.mjs`. No request input reaches the argv.
- `src/fixture-pipeline-driver.ts` (changed): added the container entry point. When the file itself is run it executes the pipeline and writes exactly one JSON line `{"protocol","status","stages"}` to stdout, nothing to stderr. Exit 0 passed, 1 failed or cancelled, 70 internal error. Importing the module does not run anything. Stage timeouts were set to 60/20/20 s so the sum stays under the container limit. Tails on the wire are 1024 characters.
- `src/fixture-pipeline-driver.ts` (bug fix found while reading): the driver passed the same empty file as `--userconfig` and `--globalconfig`. The earlier `npm ci` runner verification showed npm rejects that ("double-loading config"). The driver now creates two distinct empty files (`.empty-npmrc`, `.empty-npmrc-global`) and `fixture-pipeline-driver.test.ts` was updated. Without this the integrated install stage would have failed on a real run.
- `src/controlled-pipeline-fixtures.ts`: generated trusted `build.mjs` / `test.mjs` for kinds `pass`, `fail-build`, `fail-test`, `no-tests`. They need only `is-number`; no network, child process or install script.
- `src/test/controlled-pipeline.test.ts`: mock-Docker tests.
- `src/test/manual-controlled-pipeline-check.ts`: opt-in real Docker harness.

### Verdict rules

- **success**: container exit 0, untruncated output, empty stderr, strictly valid protocol line (exact keys, four stages in fixed order, consistent statuses, exit code consistent with status), all stages passed (test may be `not-run` only if the host staged no `test.mjs`), npm's `added N packages` in the install tail equal to the lock package count, confirmed container cleanup, staging removed.
- **failure**: valid protocol, first failing stage is install, build or test with reason `exit-code`, cleanup confirmed, staging removed.
- **not-run**: everything else. This includes policy rejection, missing inputs or driver, Docker unavailable, isolation mismatch, timeout, cancel, truncated or malformed output, any stage timeout, output limit, spawn error or prepare refusal inside the container, summary mismatch, and unconfirmed cleanup (which also downgrades a failure).

### Opt-in harness

`GRAVEYARD_MANUAL_CONTROLLED_PIPELINE=1`, plus operator-supplied `GRAVEYARD_NPM_FIXTURE_DIR` (is-number@7.0.0 `package.json` + `package-lock.json`) and `GRAVEYARD_NPM_CACHE_DIR` (prepopulated cache). It fails closed without them and needs `pnpm run build:test` first so the compiled driver exists in `dist-test/`. Cases: pass, no-tests, fail-build, fail-test, cache-miss (expect `install-failed`), git-dep (policy rejected, no container), pre-aborted. It checks confirmed cleanup, an empty staging directory and an independent `docker ps -a`.

### Run

```
pnpm run build:test
node --test dist-test/test/controlled-pipeline.test.js dist-test/test/fixture-pipeline-driver.test.js
$env:GRAVEYARD_MANUAL_CONTROLLED_PIPELINE = "1"
$env:GRAVEYARD_NPM_FIXTURE_DIR = "C:\path\to\is-number7-fixture"
$env:GRAVEYARD_NPM_CACHE_DIR = "C:\path\to\npm-cache"
node --test dist-test/test/manual-controlled-pipeline-check.js
```

### Unverified assumptions (each fails closed if wrong)

- Code compiles under `tsc -p tsconfig.json` and `tsc -p tsconfig.test.json` (never compiled).
- The mock tests pass, including one test that runs the compiled driver as a subprocess and expects one valid failed report when `/fixture` is absent.
- Inside the container: npm and `node --test` work on noexec tmpfs as uid 65532 with a read-only root; `npm ci --offline` succeeds with a read-only cache; npm prints `added N packages in <time>`; 64 MiB for `/work` is enough; a single protocol line fits the output cap.
- Strict protocol checks (empty stderr, exact line) may turn a harmless Docker or Node warning into `not-run`. That is the intended direction.

### Limits

- Controlled fixtures only. The installed tree and build output live in a tmpfs and vanish with the container. The lock policy is preliminary. Success rests on the driver's own report from inside the container; the host does not inspect the installed tree.
- Not production safe, not evidence for arbitrary or untrusted repositories. Not wired to the server, `JobWorker`, `JobRunner` or any job. No registry acquisition, no real agents.

### Next steps

1. External `tsc` (both configs), full suite, then the opt-in harness; record results here and in `.kiro/PROJECT.md`.
2. Only after that, consider controlled registry-only acquisition and worker integration.



---

## 2026-11-15 — integrated controlled fixture pipeline: external verification (docs only)

Kiro ran no commands and changed no source (no shell). Results are reported by the user from external runs. This supersedes the "written, NOT executed" and "unverified" status of the integrated controlled fixture pipeline entry above, including its pending `tsc`, full suite and opt-in run; that entry is left as history.

### Verified

- Test TypeScript build passed.
- Focused tests passed and the full backend suite passed (counts not supplied to Kiro).
- Real Docker 29.9.2 with local `node:22-alpine`, offline cached `is-number@7.0.0` fixture, via `manual-controlled-pipeline-check.ts`:
  - success: install, build and test succeeded;
  - no-tests: correctly not-run (`tests-not-run`), not a success;
  - failed build and failed test: reported as failures;
  - cache miss: reported as a failure;
  - git dependency: rejected by the lock policy;
  - pre-aborted request: not-run.
- Cleanup was proven.
- The original no-tests success bug was corrected before the final verification; the passing results include that correction.

### Limits

- Controlled generated fixtures only. The npm cache was prepopulated outside the sandbox; no registry download exists.
- No live jobs, no repository acquisition integration, no runtime agents. Not wired to the server, `JobWorker`, `JobRunner` or jobs.
- The lock policy is preliminary. Not production safe, not evidence for arbitrary or untrusted repositories.

Authorship: Kiro wrote the source; an external assistant reviewed and tested it.

### Next steps

1. Controlled registry-only dependency acquisition design (no unrestricted egress).
2. Integrate acquisition handoff with the pipeline.
3. Worker integration.




## 2026-11-15: controlled npm registry acquisition (written by Kiro, NOT compiled or run)

Kiro made file edits only: no shell, no dependency or frontend changes, nothing wired to the server, worker or any job. Goal: a real-Docker, opt-in path for the single fixed public fixture `is-number@7.0.0` (not arbitrary repositories), from registry download to the existing network-none build/test.

Written:
- `backend/src/egress-proxy.ts`: new optional `target` (closed set `github.com` default, `registry.npmjs.org`). The registry proxy applies exactly the GitHub proxy's rules to its one host: CONNECT only, exact `registry.npmjs.org:443`, exact request line and Host header, no credentials, IPv4-only resolution with every answer required public (private, link-local, metadata, loopback and mixed v4/v6 sets are refused), one pinned IP. GitHub behaviour and its tests are unchanged; the two now share one implementation.
- `backend/src/acquisition-policy.ts`: `validateEgressAttestation` takes an expected host list (default still `github.com`).
- `backend/src/npm-acquire-driver.ts`, `npm-registry-cache.ts`, `npm-registry-acquisition.ts`, `registry-pipeline.ts`: the acquisition container, the verified cache handoff, the host class and the composition with `ControlledPipeline`.
- Tests: `npm-registry-cache.test.ts`, `npm-acquire-driver.test.ts`, `npm-registry-acquisition.test.ts`, `registry-pipeline.test.ts`, and registry-target cases appended to `egress-proxy.test.ts`; opt-in harness `src/test/manual-registry-acquisition-check.ts`.

Design, in order:
1. The acquisition class never attests. It needs an injected `EgressGuard`; the default `UnavailableEgressGuard` never attests, so by default no container is created. The attestation must list exactly `registry.npmjs.org`, a dedicated network, and an `http://<private IPv4>:<port>` proxy.
2. `docker network inspect` must show that network as `Internal`, a bridge, IPv4-only, with the proxy address inside its subnet and not the gateway.
3. The container is on that network only (never the default bridge), non-root, all capabilities dropped, read-only root, bounded tmpfs/memory/pids/time/output, `--pull never`, no published ports, no extra mount besides the read-only staged directory, no credential or host environment variable. Isolation is read back from `docker inspect` before start (network, attachments, env, mounts, tmpfs, limits, labels).
4. The only command is the compiled driver: `npm ci --ignore-scripts --no-audit --no-fund` with the registry pinned to `https://registry.npmjs.org/`, the proxy on the command line, `strict-ssl=true`, two distinct empty npm configs, and the cache on a tmpfs.
5. Handoff: the container prints the cache files (base64, one JSON line). It never writes to a host mount. After container cleanup and staging removal are proven, the host parses strictly, requires npm's `added 1 package`, and verifies the cache: exact cacache paths only, SHA-512 of each content file equals its path, the tarball is present under exactly the hash the lockfile names, index lines carry their SHA-1 and bucket path equals SHA-256 of the key, keys limited to the expected registry URLs, no unreferenced or dangling entries, bounded counts and bytes. The host writes the files itself into a new directory (confined sink, exclusive create), audits it with lstat (no symlinks) and re-reads every file. A link cannot be handed over because the format cannot express one.
6. The existing `ControlledPipeline` (network `none`) then mounts that directory read-only and runs `npm ci --offline`, build and test. Overall success needs acquisition `acquired` and pipeline `success`.

If any step cannot be satisfied the result is a refusal (`network-unavailable`, `isolation-violation`, `install-failed`, `protocol-error`, `summary-mismatch`, `handoff-rejected`, `cleanup-unconfirmed`, ...). None of them is a verdict on the package.

Status: UNVERIFIED. Nothing was compiled or run. Unobserved assumptions that fail closed if wrong: npm's `--proxy/--https-proxy` behaviour and the `CONNECT` headers it sends (the strict proxy requires `Host: registry.npmjs.org:443`); npm's `added N packages in T` line; the cacache layout and index-line format assumed by the verifier; `npm ci` working with a tmpfs cache; node and npm on a noexec tmpfs as uid 65532; Docker Desktop reporting bind sources in host form. The `integrity` constant for `is-number@7.0.0` in `npm-registry-acquisition.ts` was written from memory (web access was unavailable); confirm it with `npm view is-number@7.0.0 dist.integrity`. A wrong value cannot make a run succeed.

What a future pass would and would not show: it would show that this fixed fixture was fetched through a registry-only proxy on an internal network during that run and built offline from a host-verified cache. It would not show that `--internal` blocks every escape path, that the proxy is safe on other hosts, anything about other packages or repositories, or that install scripts are sandbox-proof (they are disabled by flag and absent from the fixed lock).

Pending external: `pnpm exec tsc -p tsconfig.json`, `pnpm exec tsc -p tsconfig.test.json`, the full suite (existing GitHub proxy tests must still pass), then the opt-in run:
```
pnpm run build:test
$env:GRAVEYARD_MANUAL_REGISTRY_ACQUISITION = "1"
node --test dist-test/test/manual-registry-acquisition-check.js
```
It needs local `node:22-alpine` only. Record the output here and in `.kiro/PROJECT.md`.

What remains after this milestone, even if everything passes: acquisition of arbitrary repositories (git source plus lockfile resolution plus install in one flow), a real production `EgressGuard` (the harness issues a per-run attestation only for its own test), worker and job wiring, results and patch endpoints, real agents.




## 2026-11-15: controlled npm registry acquisition: external verification (docs only)

Kiro ran no commands and changed no source (no shell). Recorded from the user's external checks. This supersedes the "written by Kiro, NOT compiled or run" section above, which is left as history. Its pending items are resolved as below, including the pinned integrity, which was written from memory and is now confirmed.

Results:
- Test `tsc` passed.
- Focused registry and GitHub proxy tests passed.
- The full backend suite passed (counts not supplied to Kiro).
- `npm view is-number@7.0.0` confirmed the pinned sha512 integrity.
- Real Docker 29.9.2 with `node:22-alpine`, opt-in registry integration:
  - the default guard refused (never attests);
  - the isolated client could not reach 1.1.1.1 or 8.8.8.8 directly;
  - the proxy rejected github.com, example.com, private addresses, the metadata endpoint and a wrong port;
  - the proxy permitted registry.npmjs.org on port 443;
  - the fixed `is-number@7` fetch passed its integrity check;
  - 2 cache files (4404 bytes) were handed off;
  - offline install, build and test passed on the handed-off cache;
  - all labelled containers, the network and temp directories were confirmed cleaned up.

This resolves the earlier assumptions about npm's proxy flags, CONNECT headers and cache layout for this one fixture on this machine.

Authorship: Kiro wrote the source; an external assistant reviewed and ran the tests.

Limits:
- Controlled fixture only, on this machine. Not evidence for arbitrary repositories or general production isolation.
- No production `EgressGuard`. The default guard never attests, so acquisition stays disabled in the product.
- No worker integration. Nothing is wired to the server, `JobWorker`, `JobRunner` or any job. No real agents.

Next: a production `EgressGuard` design, then worker integration.




## 2026-11-15: operator multi-package lockfile v3 fixtures (written by Kiro, NOT compiled or run)

Kiro made file edits only: no shell, no dependency or frontend changes, nothing wired to the server, worker or any job. Default egress is unchanged (`UnavailableEgressGuard` never attests, so by default nothing is created). The fixed `is-number@7.0.0` path and its external verification above are unchanged and apply to the fixed path only.

What changed:
- `src/npm-operator-fixture.ts` (pure): `checkOperatorFixture(packageJsonText, lockText)`. Gate 1 is the existing `checkNpmFixture`, unmodified. Gate 2 accepts only: package.json <= 8 KiB with fields `name, version, private: true, description, license, dependencies` (so no scripts, workspaces, overrides, dev/optional/peer maps); lockfile <= 64 KiB (the driver's `MAX_INPUT_FILE_BYTES`, which the base policy's 512 KiB would exceed), `lockfileVersion` exactly 3, no legacy tree, keys limited to `name, version, lockfileVersion, requires, packages`; 1 to 8 packages (`MAX_OPERATOR_PACKAGES`, the cache verifier's cap), each `node_modules/<unscoped lowercase name>` with a plain x.y.z version and entry fields limited to `version, resolved, integrity, dependencies, license, engines, bin, funding, deprecated`; unique integrity values; at most 16 dependencies per map; the lock root equal to package.json; every listed dependency present and every entry reachable from the root. Dev, devOptional, optional and peer flags are rejected because the driver runs npm with `NODE_ENV=production` and such entries would not be installed, which would make the expected package count unknowable. Scoped, nested and prerelease packages are rejected because the cache verifier only supports unscoped names and plain versions. It returns the exact accepted texts, their sha256, and one `{ name, version, integrity }` per package sorted by name.
- `src/npm-registry-acquisition.ts`: `OPERATOR_FIXTURE_ID = "operator-lockfile-v3"` and `RegistryAcquisitionRequest.operatorFixture`. Rules: `FIXED_FIXTURE_ID` must not carry `operatorFixture`; `OPERATOR_FIXTURE_ID` requires exactly `{ packageJson, packageLock }` strings that pass `checkOperatorFixture`; otherwise `rejected`, decided before the attestation is requested and before any Docker call. The fixed path still compares the bytes with the constants. Staging, container creation arguments, isolation read-back, cleanup proof and staging removal are the same code for both modes (a test compares the `docker create` arguments). The handoff expectation is the full package list and `summary-mismatch` is raised unless npm's `added N packages` equals the lockfile's package count. Requests come from operator code; no HTTP route or job accepts a lockfile.
- `src/registry-pipeline.ts`: documentation only. The offline stage is not given the files; the caller must place the same two texts in the pipeline fixture directory.
- Harness `src/test/manual-registry-acquisition-check.ts`: with `GRAVEYARD_MANUAL_REGISTRY_FIXTURE_DIR` set to an absolute real directory holding `package.json` and `package-lock.json` (plain files, no symlinks, <= 64 KiB), the harness runs `checkOperatorFixture` before touching Docker (a rejection fails closed), then runs the same topology, probes and attestation as before, checks that a copy with a foreign `resolved` host is `rejected` with no container, and expects `packagesAdded` to equal the lockfile's package count. Without the variable the behaviour is exactly the fixed one.

Tests (all synthetic, mocked Docker, no network; the package names, versions and tarball bytes are invented and the helper computes integrity from those bytes): `src/test/npm-operator-fixture.test.ts` (acceptance of a three-package chain and of the fixed fixture, size and count bounds including exactly 8 versus 9, lockfile version 1/2/"3", legacy tree, unknown fields, dev/optional/peer, nested/scoped/traversal/workspace/alias keys, prerelease and build versions, foreign hosts, git/file/http specs, sha1 and multi-hash integrity, shared integrity, orphan and dangling entries, scripts, package.json overrides/workspaces/packageManager, root mismatch, BOM, `__proto__` keys, Object.prototype-named packages, control characters in messages, duplicate JSON keys); the `acquire: operator fixture` block in `npm-registry-acquisition.test.ts` (default guard never contacts Docker, nine policy mutations rejected without asking the guard, selector mismatches, exact staged bytes, count mismatch, same create arguments as the fixed fixture, isolation tampering, cleanup gates, real handoff accepts a consistent three-package cache and rejects swapped, missing and unlisted tarballs); one case in `registry-pipeline.test.ts`. Helper: `src/test/operator-fixture-helpers.ts`.

Status: UNVERIFIED. Nothing was compiled or run, so type errors or wrong expectations in the new tests are possible. Pending external:
```
pnpm exec tsc -p tsconfig.json
pnpm exec tsc -p tsconfig.test.json
pnpm run build:test
node --test dist-test/test/npm-operator-fixture.test.js dist-test/test/npm-registry-acquisition.test.js dist-test/test/registry-pipeline.test.js
node --test dist-test/test/*.js
$env:GRAVEYARD_MANUAL_REGISTRY_ACQUISITION = "1"
$env:GRAVEYARD_MANUAL_REGISTRY_FIXTURE_DIR = "C:\absolute\path\to\fixture"
node --test dist-test/test/manual-registry-acquisition-check.js
```
The last command needs local `node:22-alpine`, runs outside the restricted sandbox, and needs a small real lockfile (a few tiny unscoped packages) that the operator generates with `npm install --package-lock-only --ignore-scripts` and checks with `npm view <name>@<version> dist.integrity`. Record the outcome here and in `.kiro/PROJECT.md`.

Known limits and unobserved assumptions (all fail closed):
- The driver exports at most 64 files, 64 KiB per file and 128 KiB in total. Real tarballs larger than that are refused at export, so operator fixtures must use tiny packages.
- npm's cache for several packages must match the verifier's layout (one index entry per tarball URL, optional packument entries), and the offline `npm ci --offline` must accept it. Unobserved.
- The gate does not check that a version satisfies its range (npm ci does) or what a package contains, and it does not detect duplicate JSON keys (JSON.parse, npm and this module all keep the last value).
- Not covered: scoped or nested packages, arbitrary repositories, a production `EgressGuard`, worker or job wiring, real agents.




## 2026-11-15: operator multi-package lockfile v3 fixtures: external verification (docs only)

Kiro ran no commands and changed no source (no shell). Recorded from the user's external checks. This supersedes the "written by Kiro, NOT compiled or run" and "UNVERIFIED" status of the operator multi-package lockfile v3 entry above, including its pending `tsc`, full suite and opt-in run; that entry is left as history.

### Verified

- Test TypeScript compile passed.
- The full backend suite passed (count not supplied to Kiro).
- Real Docker 29.9.2, controlled operator lockfile v3 with two packages, `is-number@7.0.0` and `is-buffer@2.0.5`:
  - both packages were acquired through the registry-only proxy and their integrity was verified;
  - 4 cache files (7170 bytes) were handed off;
  - offline install, build and tests passed on that cache;
  - a hostile `resolved` URL was rejected before any container was created;
  - the default guard refused;
  - direct public IP probes and forbidden hosts were blocked;
  - cleanup was confirmed.

This resolves, for this two-package fixture, the earlier unobserved assumptions about multi-package cache layout, offline `npm ci --offline` acceptance and the export bounds.

Authorship: Kiro wrote the changes; an external assistant reviewed and tested them.

### Limits

- Limited controlled fixtures: flat unscoped packages, at most 8, lockfile v3 only.
- No arbitrary user repository, no production `EgressGuard`, no live worker. Nothing is wired to the server, `JobWorker`, `JobRunner` or jobs. The default guard still never attests, so acquisition stays disabled in the product.
- No claim about package contents, scoped or nested packages, or general production isolation.




---

## 2026-11-15: agent foundation (Analyst, Fixer, Tester): compile fix and focused tests (written by Kiro, NOT compiled or run)

Kiro had no working shell for this request (the shell tool was refused), so `tsc` and the tests were **not run**. Everything below is unverified until an operator runs it and logs the result here and in `.kiro/PROJECT.md`. Edits are under `backend/` and `.kiro/` only. No live wiring, no shell or dependency changes, no frontend.

Modules (existing, read again this session): `src/agent-contract.ts` (evidence bounding, marker extraction, closed-schema diagnosis and strict unified-diff validation), `src/kiro-agent.ts` (injectable adapter around `kiro-cli chat --no-interactive --trust-tools=`), `src/tester.ts` (verdict derived only from runner `StageResult`s). Nothing instantiates them outside tests; no job, worker or route uses them.

### Compile fix (`src/kiro-agent.ts`, TS2367)

The error was reported at line 503, which does not exist in the file as read (about 480 lines), so the exact line was not confirmed by a compiler. Cause by inspection: `invoke` returns early on `signal?.aborted === true`; after that TypeScript narrows `signal.aborted` to `false`, so the later post-`await` comparison `signal?.aborted === true` is a no-overlap comparison (TS2367). Fix: a helper `isAborted(signal)` reads the state through a function, and both checks use it (before start, and after the executor returns). The behaviour is unchanged. Unverified until `tsc` runs.

### Tests added

- `src/test/kiro-agent.test.ts` (fake executor and fake working directories; kiro-cli is never started):
  - Analyst: valid diagnosis; `unknown` becomes `no-result`; malformed outputs (not JSON, extra key, bad category, wrong role, unsupplied evidence id, unsupplied or unsafe file, overlong summary); missing, wrong-nonce and duplicate markers; output over 64 KiB; executor-reported truncation; invalid or too many evidence items and nonce collision without calling the executor.
  - Fixer: valid bounded patch (`proposalOnly`, context verified); `unknown` is `no-result`; malformed JSON and extra keys; an invalid input diagnosis and missing file evidence are rejected before the executor runs.
  - Dangerous patches, all rejected with a specific code and the working directory still removed: `.git`, `.github`, traversal, absolute path, unsupplied file, new, deleted and renamed files, git extended headers, context mismatch, hunk-count mismatch, control characters, oversize.
  - Invocation: argv carries `--no-interactive` and `--trust-tools=`, never a trust-all flag, and no evidence text (evidence is on stdin only); no `shell` option is passed; cwd is a fresh controlled directory (not `process.cwd()`), removed afterwards; files left in that directory cause `workspace-modified`; an unsafe directory (ancestor with `.kiro`/`.git`) fails closed without running; unstartable binary is `unavailable`; nonzero exit is `failed`. A source scan asserts the non-comment code contains no `trust-all-tools`, `shell: true` or `exec*`/`spawnSync` call.
  - Timeout and abort: executor timeout becomes `timed-out`; a pre-aborted signal never starts the executor; a signal that aborts during the call discards an otherwise valid result (the path the compile fix touches); executor `aborted` and signal forwarding; timeout configuration bounds.
  - Credentials: host `KIRO_API_KEY`, GitHub and `GRAVEYARD_*` variables are not forwarded; an explicit key reaches only the child environment, never argv or stdin; the key and token shapes are redacted from evidence before stdin; the key does not appear in any returned outcome even when the child's stderr and stdout contain it.
  - `spawnAgentProcess` with real `node` children (no kiro-cli): shell metacharacters arrive as literal arguments (shell:false), only the explicit environment is passed and stdin is delivered, timeout and abort kill the child, an output cap stops and flags the child, a missing binary rejects. This group starts real processes and is the most environment-sensitive part.
- `src/test/tester.test.ts` (pure): passed only with both stages observed passing; missing stages and missing tests (`no-tests-found`, `no-tests-executed`) are `not-run` with `tests-not-run`; a "passed" label with zero passing tests, no counts, unconfirmed or missing cleanup, truncation or a bad exit code is `not-run`; observed nonzero exit or failing counts are `failed`; timeout, abort, isolation and Docker problems are `not-run`; wrong-slot results are `stage-mismatch`; a failed stage outranks a not-run stage; free text and output tails never reach the report.

### Verification answers (by reading code and tests, not by running anything)

- No trust-all-tools: the argv builder emits `--trust-tools=` (empty list) and no other trust flag; a test asserts it and a source scan checks it.
- No execution by the agent modules: the adapter only spawns the injected executor with `kiro-cli`; patches are `proposalOnly` data; nothing applies a patch or runs repository code. The Tester has no process or I/O.
- No credentials in logs: the modules do not log. The key is passed only through the child environment, is redacted from evidence and from failure detail, and failure details are fixed strings.

### Not established

- That anything compiles or passes. The real `kiro-cli` headless behaviour (stdin handling, `--trust-tools=` semantics, the output format, whether the global Kiro configuration or hooks are read from the home directory) has not been observed. The v2 and v3 profiles use the same flags and any difference is unverified.
- The process is not sandboxed. It reads the operator's global Kiro configuration and sends evidence to Kiro's service, which is a data-egress decision for the operator.
- Validation shows output is well formed and consistent with supplied evidence. It does not show a diagnosis is true or a patch is correct; only independent build and test results do.
- Not wired to the server, worker, runner or any job. No patch-apply step exists.

### Pending external

```
pnpm exec tsc -p tsconfig.json
pnpm exec tsc -p tsconfig.test.json
pnpm run build:test
node --test dist-test/test/kiro-agent.test.js dist-test/test/tester.test.js
node --test dist-test/test/*.js
```
Fix any compile or test failures, then record the results here, in `.kiro/PROJECT.md` and in `.kiro/KIRO_USAGE.md`. An opt-in manual check of the real `kiro-cli` has not been written or run.





---

## 2026-11-15: integrated worker execution path: PipelineJobRunner (written by Kiro, NOT compiled or run)

Kiro had no working shell (the shell tool was refused), so `tsc` and the tests were **not run**. Everything below is unverified until an operator runs it and logs the result here and in `.kiro/PROJECT.md`. Edits are under `backend/` and `.kiro/` only. No frontend, dependency, git or `server.ts` changes.

### What was connected

Before this entry the pieces were separate: `JobWorker` drove a `JobRunner` that only had `UnavailableRunner`; the controlled pipeline, Tester and agents were not reachable from a job. Now a queued job can travel through all of them:

```
queued job -> JobWorker.runOnce (claim, lease, heartbeat, deadline)
  -> PipelineJobRunner.run
       resolve repoUrl in an operator catalog        (unknown URL: refused, nothing runs)
       stage "building"   ControlledPipeline.run     (network none, one container: npm ci --offline, build, test)
       stage "testing"    buildPipelineTesterReport  (pure; re-checks the observed evidence)
       on repository failure only, agents configured:
       stage "diagnosing" Analyst (bounded, redacted evidence)
       stage "repairing"  Fixer   (proposal only)
       one "result" event
  -> PipelineJobRunner.cleanup (Docker cleanup proof for the exact execution id)
  -> worker writes completed / failed / blocked
```

### Changes

- `src/leases.ts`: `JOB_STAGES`, `ProgressStage`, `recordLeasedStage` (updates `jobs.stage`, appends a `stage` event) and `recordLeasedResult` (appends one `result` event per attempt, at most `MAX_RESULT_BYTES` = 64 KiB serialized; larger payloads throw, they are never truncated). Both are fenced like `finishLeasedJob`: matching lease token, unexpired lease, deadline not passed, not in recovery; otherwise `accepted:false` with no side effects. No schema change: the result is persisted as an event only (readable through the existing SSE route; there is still no result endpoint).
- `src/runner.ts`: optional `RunContext.report` (`JobProgress`: `stage()`, `result()`). Optional so existing runners and tests are unaffected.
- `src/worker.ts`: builds `report` from the lease token, never throws, and returns `false` after any coordinator abort (shutdown, deadline, lease loss), so a runner cannot record anything once aborted. New `drainQueue(worker, { maxJobs })`: sequential, at most 1 to 100 jobs, stops at idle, busy, limit, or the first `blocked` / `lease-lost` job.
- `src/tester.ts`: `buildPipelineTesterReport(ControlledPipelineResult)`. `passed` or `failed` needs the pipeline's own matching `success` / `failure`, a parsed stage list, confirmed container cleanup, confirmed staging removal and untruncated output; otherwise `not-run` / `evidence-unconfirmed`. A failure needs an observed `exit-code` failure with a nonzero exit code; timeouts and other reasons are `inconclusive`. Missing tests are `no-tests` / `tests-not-run`. No container text enters the report.
- `src/pipeline-runner.ts` (new): `PipelineJobRunner`, `createCatalogResolver`, `readFixtureEvidence`, `buildEvidence`, `buildResultPayload`. Dependencies are injected: `resolve`, `pipeline` (`ControlledPipeline` satisfies it), `cleanupExecution` (`DockerFixtureSandbox.cleanup` shape), optional `agents` (`KiroAgentAdapter` satisfies it).
- `src/test/pipeline-runner.test.ts` (new): see below.

### Exact supported behaviour

Outcome mapping:

| Situation | Job status | Result event |
|---|---|---|
| Pipeline `success` and Tester `passed` | completed | verdict `verified` |
| Pipeline `failure` in install, build or test and Tester `failed` | completed | verdict `repository-failing`, Tester report, Analyst diagnosis and Fixer proposal if agents are configured |
| Build passed, fixture has no tests | completed | verdict `tests-not-run` (never `verified`) |
| Any other `not-run` (timeout, Docker unavailable, truncated, protocol error, unconfirmed cleanup or staging, ...) | failed, `infrastructure-unavailable`, reason code in metadata | none |
| URL not in the catalog, catalog entry invalid, resolver throws | failed, `infrastructure-unavailable` | none |
| No progress channel, pipeline throws, verdict and Tester disagree | failed, `infrastructure-unavailable` | none |
| Abort, lost lease, rejected write | worker rules apply (discarded, requeue only with cleanup proof) | none |
| Container cleanup not proven | blocked (fenced, `recovery_required`) | a `result` event may already exist, but the job never reaches `completed` |

"completed" means the worker finished its work and a result exists. It does not mean the repository was repaired. Infrastructure errors stay in job metadata and never in a repository diagnosis. Agent failures (no-result, rejected, timed-out, unavailable, raised) are recorded inside the result as data and do not fail the job. Analyst and Fixer fields are labelled `modelAuthored: true`; the Fixer proposal carries `proposalOnly: true` and `applied: false`.

The stage events report only what actually happened: `building` covers install, build and test together because they run in one container and cannot be separated live; `testing` is the Tester judging the observed stage list. `cloning`, `analyzing` and `verifying` are never emitted (nothing is cloned, and no patch is applied and re-verified). The stage on a requeued job is not reset between attempts.

Security properties kept: no repository code runs on the host (only the existing network-`none` container); the catalog is exact-match on the canonical URL and fixture names pass `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; catalog files must be plain regular files at most 64 KiB, with `package.json` and `build.mjs` required, `test.mjs` optional, and nothing else read; evidence for agents is at most 6 files and 3500 bytes each, and the container's output tails are redacted by `prepareEvidence`; a pipeline verdict is accepted only with confirmed cleanup, staging removal and the same execution id; the worker's cleanup gate still applies after the runner returns; result events contain no lease or recovery token; the `ctx.report` writes are fenced.

### Tests (all injected: fake pipeline, fake cleanup, fake agents, real in-memory SQLite and real `JobWorker`)

`src/test/pipeline-runner.test.ts`:
- successful: pass verdict, stage events `building, testing`, job `completed` and stage `done`, one result event, execution id `<job>:1` passed to the pipeline and cleanup; agents not called on a pass; failing build with Analyst and Fixer (stage events add `diagnosing, repairing`, `proposalOnly`, `applied:false`); evidence content and bounds; failing build without agents; Analyst no-result skips the Fixer; agent raising and Fixer rejection recorded without failing the job; no-tests fixture is `tests-not-run`; no tokens in events.
- failed or refused: uncatalogued URL, throwing resolver, four invalid catalog entries, timed-out pipeline (no result, no agent call), claimed success with unconfirmed cleanup, with staging not removed, with another execution id, with truncated output, pipeline that throws (cleanup still requested, message does not leak the error), unconfirmed cleanup after a good result gives `blocked`, cleanup proof for another execution id, throwing cleanup, cleanup for an execution this process never ran.
- direct runner: no reporter, pre-aborted signal, abort during the pipeline discards the result, signal handed to the pipeline, rejected stage write and rejected result write.
- `recordLeasedStage` / `recordLeasedResult`: holder accepted, wrong token, expired lease, fenced lease, invalid stage names, one result per attempt, oversize refused, non-object refused.
- `drainQueue`: idle, limit, stops at blocked, invalid bounds.
- `buildPipelineTesterReport`: pass, failure, install failure, no tests, seven downgrade cases, non-success verdict, timeout inconclusive, no container text.
- `buildEvidence`, `readFixtureEvidence`, `createCatalogResolver` (real temp directory).

### Remaining gaps (not claimed)

- No arbitrary repository support. Only operator-prepared controlled fixtures in a catalog. The git acquisition and registry acquisition modules are not connected to the runner; the production `EgressGuard` does not exist, so acquisition stays disabled. A real repository would also need a lockfile, an offline cache and `build.mjs`, which the pipeline requires.
- Nothing starts a worker loop in `server.ts`; the production runner is still `UnavailableRunner`. An operator script must construct `ControlledPipeline`, `DockerFixtureSandbox` (for cleanup), the catalog and optionally `KiroAgentAdapter`, then call `drainQueue`. No such composition script or configuration exists.
- No patch apply and no repair verification. `repairing` means a proposal was requested. The `verifying` stage is unused.
- No result or patch endpoint; the result is readable only from the SSE `result` event.
- Staging is keyed by fixture name, so a leftover staging directory makes later runs of that fixture refuse (`staging-failed`, fail closed). Recovery cleanup proves containers only, not staging directories.
- The Tester judges stage results observed in one container; it has no test counts for the pipeline (they are not in the driver protocol).
- Real `kiro-cli` behaviour is still unobserved (see the agent foundation entry).

### Pending external

```
pnpm exec tsc -p tsconfig.json
pnpm exec tsc -p tsconfig.test.json
pnpm run build:test
node --test dist-test/test/pipeline-runner.test.js dist-test/test/worker.test.js dist-test/test/leases.test.js dist-test/test/tester.test.js
node --test dist-test/test/*.js
```
Likely trouble spots if the compile fails: `Promise.resolve` inference in the new test, `Array.isArray` narrowing on a readonly array in `validSource`, and the `report` closure in `worker.ts`. Record the results here, in `.kiro/PROJECT.md` and in `.kiro/KIRO_USAGE.md`.




---

## 2026-11-15: external verification of build, tests and a real Analyst call (docs only)

Kiro ran no commands and changed no source. Results are reported by the user from external runs. This supersedes the "NOT compiled or run" status of the agent foundation and integrated worker execution path entries above; those entries are left as history.

### Verified

- Production TypeScript compilation (`tsconfig.json`) passed.
- Test TypeScript compilation (`tsconfig.test.json`) passed.
- The full `node --test` suite passed on 2026-11-15. One isolated temporary-directory test may skip when the environment is empty.
- A real synthetic Analyst call using the logged-in Kiro CLI returned no-result (unknown diagnosis). This demonstrates that the invocation works. It is not evidence that the diagnosis is correct.

### Limits

- Tests use injected fakes (runner, pipeline, cleanup, agents). No end-to-end live worker run was performed.
- The pipeline remains limited to controlled fixtures. It is not wired to the server, and it does not apply repairs.
- Not shown: a real diagnosis or patch from the agents, arbitrary repositories, a production `EgressGuard`, result or patch endpoints.
