# Backend implementation tasks

Planning source: a Kiro-generated draft, condensed, reviewed and revised during development; see requirements.md and design.md. Project owner: Yash. Foundation package is implemented; job processing remains pending.

- [ ] 1. Inspect Node/pnpm/Docker availability and choose compatible pinned backend dependencies.
- [x] 2. Use Kiro to implement backend package, configuration and GET /health. Verify compilation and health response.
- [ ] 3. Fix request/result/event contracts and owner authorization; check invalid URLs, unauthorized access and unsupported inputs.
- [ ] 4. Add SQLite migrations, durable jobs, atomic claims and restart recovery. Verify concurrent claims cannot duplicate a job.
  - Task 4 PARTIAL (not complete): schema v2 and lease/recovery **library primitives** (`backend/src/leases.ts`: atomic claim, heartbeat, fencing, cleanup-confirmed requeue, `listRecoveryRequired`, `expireQueuedDeadlines`) written by Kiro with tests in `leases.test.ts`; externally verified 2026-11-11 (both `tsc` builds pass, 162 tests, 0 failures). Still unimplemented: restart-recovery coordinator, automatic cleanup, and any execution worker/runner.
- [ ] 5. Add SSE persistence/replay and bounded logs. Verify reconnect order and access control.
  - Task 5 PARTIAL: SSE (`GET /api/jobs/:id/events`: persisted replay, Last-Event-ID, access control, live cancel, stream cap, shutdown, heartbeat, backpressure) verified externally 2026-11-11, including real-HTTP tests. Bounded logs remain pending (no log capture exists without a runner).
- [ ] 6. Build isolated acquisition and baseline runner. Verify resource limits, cancellation, timeout and cleanup with controlled fixtures.
- [ ] 7. Prove Kiro runtime adapter feasibility before adopting it for automated diagnosis/repair.
- [ ] 8. Implement evidence-based Analyst and bounded Fixer proposals. Preserve complete patch artifacts.
- [ ] 9. Implement independent build/test verification. Missing tests and partial results cannot produce resurrection.
- [ ] 10. Connect real frontend job stages and completion events with the teammate; replace timer-based result assumptions.
- [ ] 11. Verify end-to-end success, failure and unverified cases, then document deployment and actual Kiro contributions.

Credit policy: one bounded Kiro request per small milestone, supplied with focused context. Review locally before requesting another generation. Do not spend credits merely to increase usage. Exact remaining balance is not known to this workflow.
