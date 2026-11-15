/**
 * registry-pipeline.test.ts — ordering and fail-closed gating of the two controlled stages, with
 * both stages INJECTED. No Docker, no npm, no network, no filesystem.
 *
 * These tests show the offline stage is never constructed unless the acquisition reports a fully
 * proven `acquired`, and that only acquired + pipeline success is an overall success. They show
 * nothing about either real stage.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ControlledPipelineResult, PipelineRequest } from "../controlled-pipeline.js";
import type { RegistryAcquisitionRequest, RegistryAcquisitionResult } from "../npm-registry-acquisition.js";
import { runRegistryThenOffline, type RegistryPipelineDeps } from "../registry-pipeline.js";

const ACQ_REQ: RegistryAcquisitionRequest = { executionId: "regacq-1:1", fixture: "is-number-7.0.0", image: "node:22-alpine", runDir: "/run" };
const PIPE_REQ: PipelineRequest = { executionId: "regpipe-1:1", fixture: "pass" };

const proof = { confirmed: true as const, executionId: "regacq-1:1", evidence: "test" };
const acquired = (over: Partial<RegistryAcquisitionResult> = {}): RegistryAcquisitionResult =>
  ({
    kind: "acquired", cacheDir: "/run/cache", packagesAdded: 1, durationMs: 5,
    summary: { files: 2, contentFiles: 1, indexFiles: 1, totalBytes: 3, directories: 6, tarballs: [] },
    cleanup: proof, stagingRemoved: true, driverSha256: "0".repeat(64), executionId: "regacq-1:1", ...over,
  }) as RegistryAcquisitionResult;

const pipelineResult = (status: ControlledPipelineResult["status"], reason: ControlledPipelineResult["reason"]): ControlledPipelineResult => ({
  status, reason, detail: "x", failedStage: null, stages: null, exitCode: 0, durationMs: 1, truncated: false, stderrTail: "",
  packagesAdded: 1, expectedPackages: 1, violations: [], cleanup: proof, stagingRemoved: true, driverSha256: null, executionId: "regpipe-1:1",
});

function deps(a: RegistryAcquisitionResult, p: ControlledPipelineResult | Error = pipelineResult("success", "ok")) {
  const log = { acquire: 0, make: [] as string[], run: 0 };
  const d: RegistryPipelineDeps = {
    acquire: () => {
      log.acquire += 1;
      return Promise.resolve(a);
    },
    makePipeline: (cacheDir) => {
      log.make.push(cacheDir);
      return {
        run: () => {
          log.run += 1;
          return p instanceof Error ? Promise.reject(p) : Promise.resolve(p);
        },
      };
    },
  };
  return { d, log };
}

describe("runRegistryThenOffline", () => {
  it("success needs an acquired cache AND an offline success, and mounts exactly the handed-over cache", async () => {
    const { d, log } = deps(acquired());
    const r = await runRegistryThenOffline(d, { acquisition: ACQ_REQ, pipeline: PIPE_REQ });
    assert.equal(r.status, "success");
    assert.equal(r.decidedBy, "pipeline");
    assert.deepEqual(log.make, ["/run/cache"]);
    assert.equal(log.run, 1);
    assert.ok(r.pipeline !== null);
  });

  it("every acquisition refusal is not-run and never constructs the offline stage", async () => {
    const kinds: RegistryAcquisitionResult[] = [
      { kind: "rejected", reason: "x", cleanup: null, stagingRemoved: null, driverSha256: null, executionId: null },
      { kind: "network-unavailable", reason: "x", cleanup: null, stagingRemoved: null, driverSha256: null, executionId: null },
      { kind: "unavailable", reason: "x", cleanup: null, stagingRemoved: null, driverSha256: null, executionId: null },
      { kind: "isolation-violation", reason: "x", cleanup: proof, stagingRemoved: true, driverSha256: null, executionId: null },
      { kind: "install-failed", phase: "install", reason: "exit-code", detail: "", diagnostic: "", cleanup: proof, stagingRemoved: true, driverSha256: null, executionId: null },
      { kind: "protocol-error", reason: "x", cleanup: proof, stagingRemoved: true, driverSha256: null, executionId: null },
      { kind: "summary-mismatch", reason: "x", cleanup: proof, stagingRemoved: true, driverSha256: null, executionId: null },
      { kind: "handoff-rejected", reason: "x", dir: null, cleanup: proof, stagingRemoved: true, driverSha256: null, executionId: null },
      { kind: "cleanup-unconfirmed", reason: "x", cleanup: { confirmed: false, reason: "x" }, stagingRemoved: true, driverSha256: null, executionId: null },
      { kind: "staging-cleanup-failed", reason: "x", cleanup: proof, stagingRemoved: false, driverSha256: null, executionId: null },
      { kind: "timed-out", cleanup: proof, stagingRemoved: true, driverSha256: null, executionId: null },
      { kind: "aborted", cleanup: proof, stagingRemoved: true, driverSha256: null, executionId: null },
    ];
    for (const a of kinds) {
      const { d, log } = deps(a);
      const r = await runRegistryThenOffline(d, { acquisition: ACQ_REQ, pipeline: PIPE_REQ });
      assert.equal(r.status, "not-run", a.kind);
      assert.equal(r.decidedBy, "acquisition");
      assert.equal(r.pipeline, null);
      assert.deepEqual(log.make, [], a.kind);
      assert.equal(log.run, 0);
    }
  });

  it("does not trust an acquired result that lacks cleanup proof or staging removal", async () => {
    for (const over of [
      { cleanup: null }, { cleanup: { confirmed: false as const, reason: "x" } }, { stagingRemoved: false }, { stagingRemoved: null },
    ] as Array<Partial<RegistryAcquisitionResult>>) {
      const { d, log } = deps(acquired(over));
      const r = await runRegistryThenOffline(d, { acquisition: ACQ_REQ, pipeline: PIPE_REQ });
      assert.equal(r.status, "not-run");
      assert.deepEqual(log.make, []);
    }
  });

  it("refuses to reuse the acquisition's execution id for the offline stage", async () => {
    const { d, log } = deps(acquired());
    const r = await runRegistryThenOffline(d, { acquisition: ACQ_REQ, pipeline: { ...PIPE_REQ, executionId: ACQ_REQ.executionId } });
    assert.equal(r.status, "not-run");
    assert.deepEqual(log.make, []);
  });

  it("passes the offline stage's own failure and not-run through unchanged", async () => {
    for (const [status, reason] of [["failure", "build-failed"], ["failure", "install-failed"], ["not-run", "tests-not-run"], ["not-run", "cleanup-unconfirmed"]] as const) {
      const { d } = deps(acquired(), pipelineResult(status, reason));
      const r = await runRegistryThenOffline(d, { acquisition: ACQ_REQ, pipeline: PIPE_REQ });
      assert.equal(r.status, status);
      assert.equal(r.decidedBy, "pipeline");
      assert.equal(r.pipeline?.reason, reason);
    }
  });

  it("passes an operator-fixture acquisition request through unchanged and gates the offline stage the same way", async () => {
    const seen: RegistryAcquisitionRequest[] = [];
    const op: RegistryAcquisitionRequest = {
      ...ACQ_REQ,
      fixture: "operator-lockfile-v3",
      operatorFixture: { packageJson: "{}", packageLock: "{}" },
    };
    const make = (a: RegistryAcquisitionResult): { d: RegistryPipelineDeps; made: string[] } => {
      const made: string[] = [];
      return {
        made,
        d: {
          acquire: (req) => {
            seen.push(req);
            return Promise.resolve(a);
          },
          makePipeline: (cacheDir) => {
            made.push(cacheDir);
            return { run: () => Promise.resolve(pipelineResult("success", "ok")) };
          },
        },
      };
    };
    const ok = make(acquired({ packagesAdded: 3 }));
    const r = await runRegistryThenOffline(ok.d, { acquisition: op, pipeline: PIPE_REQ });
    assert.equal(r.status, "success");
    assert.deepEqual(ok.made, ["/run/cache"]);
    assert.equal(seen[0], op);
    assert.match(r.detail, /acquired 3 package/);

    const refused = make({ kind: "rejected", reason: "x", cleanup: null, stagingRemoved: null, driverSha256: null, executionId: null });
    const n = await runRegistryThenOffline(refused.d, { acquisition: op, pipeline: PIPE_REQ });
    assert.equal(n.status, "not-run");
    assert.deepEqual(refused.made, []);
  });

  it("reports not-run, never a throw, when the offline stage cannot be built or raises", async () => {
    const raising = deps(acquired(), new Error("boom"));
    assert.equal((await runRegistryThenOffline(raising.d, { acquisition: ACQ_REQ, pipeline: PIPE_REQ })).status, "not-run");

    const { d } = deps(acquired());
    const broken: RegistryPipelineDeps = { ...d, makePipeline: () => { throw new Error("cannot build"); } };
    assert.equal((await runRegistryThenOffline(broken, { acquisition: ACQ_REQ, pipeline: PIPE_REQ })).status, "not-run");
  });
});
