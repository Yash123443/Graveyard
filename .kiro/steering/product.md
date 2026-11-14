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
Not implemented: execution worker loop, sandbox runner integration, secure acquisition (disabled), real agents, result and patch endpoints. Browser visual interaction of the workspace is unverified.
