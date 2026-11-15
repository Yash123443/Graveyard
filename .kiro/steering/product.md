# Product

## Purpose
GRAVEYARD turns abandoned GitHub repositories into gravestones in an immersive 3D cemetery. The planned workflow is: clone a repository, analyse it, diagnose problems, repair code, build, test, and verify.

## 3D cemetery intro
- React / Three.js scene (gate, camera, stories, audio, characters).
- It is an intro and demonstration only. It does not run real repairs.
- The finale links to the repair workspace. No OAuth exists.

## Repair workspace (`#/workspace`)
- Separate, non-3D UI, lazy-loaded from `src/AppRouter.tsx`.
- Connected to the backend for: health badge, job creation (with explicit consent), job metadata, queued-job cancel, and an SSE event feed.
- The job token is held in `sessionStorage` only.
- The UI must state plainly that no worker, result, or patch endpoint exists yet.

## Agent pipeline
- **Analyst**: investigates the repository and gathers evidence.
- **Fixer**: proposes bounded patches. Oversized proposals are rejected, not truncated.
- **Tester**: records actual runner results. Inconclusive checks are "not run", not failures.

Stages: queued, cloning, analyzing, diagnosing, repairing, building, testing, verifying, done. Lifecycle status (queued, running, completed, failed, cancelled, timed-out) is tracked separately from stage.

## Current status
Not implemented: arbitrary-repository acquisition inside jobs (secure acquisition stays disabled), real-Docker end-to-end worker verification, applying a patch to a real repository, a patch endpoint, API-managed worker supervision. Browser visual interaction of the workspace is unverified.

Written but not yet compiled or run (2026-11-16): a verified local repair slice. After a baseline failure and one validated Fixer proposal, the worker (`src/repair-verifier.ts`) applies a patch of only the complete root `build.mjs` in memory to a disposable copy and verifies it by an actual offline install/build/test with the original `test.mjs`. The owner-authenticated `GET /api/jobs/:id/result` distinguishes a passing original, an unverified proposal, a tested failure (`patch-failed-verification`) and a verified repair (`repair-verified`, with `verifiedDiff`). The workspace now calls `/result`, shows stages, diagnosis and diff, and saves a verified diff as plain text. The original is never modified; `repair.patchApplied` stays false. Opt-in harness: `pnpm run test:worker-e2e:repair` (scripted Analyst/Fixer, not live Kiro), not run. Note: the next paragraph's statement that the workspace does not call `/result` is superseded.

Written but not yet compiled or run (2026-11-15): an opt-in local worker process (`GRAVEYARD_WORKER_ENABLED=1`, separate from the API) that runs only operator-catalogued fixtures through the offline network-`none` pipeline, and `GET /api/jobs/:id/result`, which separates a diagnosis or patch proposal from a verified repair (`repair.verified` is always false). The frontend workspace was not changed: its text that no worker or result endpoint exists is now stale and it does not call `/result`.

Compiled and unit-tested externally (reported by the user; Kiro ran nothing), NOT run against real Docker or GitHub: an opt-in GitHub flow in the worker (`GRAVEYARD_GITHUB_CATALOG` and related variables). It fetches only operator-pinned full-SHA commits of public repositories through an operator-provisioned, attested github.com-only network, reads four root files, and reports repositories outside a narrow supported class as `unsupported-repository` without building them. Supported repositories (no npm `scripts`, small lockfile v3, root `build.mjs`) go through registry acquisition and the offline sandbox pipeline. Arbitrary repositories, branch resolution, scripts-based projects, patch apply and repair verification remain unimplemented. No real-GitHub run has occurred. A first-run harness (`pnpm run test:github-e2e`, octocat/Hello-World pinned, expected `unsupported-repository`) is written and has not been compiled or run.

