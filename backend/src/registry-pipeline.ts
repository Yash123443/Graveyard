/**
 * registry-pipeline.ts — composition of the two controlled stages for the fixed is-number@7.0.0
 * fixture: (1) network-acquiring `npm ci` through the registry-only proxy with a verified cache
 * handoff (npm-registry-acquisition.ts), then (2) the existing network-`none` offline install,
 * build and test (controlled-pipeline.ts) with that handed-over cache mounted read-only.
 *
 * Foundation only. NOT a JobRunner and not wired to the server, worker or any job. Written without
 * running anything. The only guarantee this function adds is ordering and fail-closed gating:
 *  - the pipeline is never constructed or run unless the acquisition reports `acquired`
 *    (cleanup confirmed, staging removed, cache verified and written by the host);
 *  - overall `success` requires acquisition `acquired` AND pipeline `success`;
 *  - everything else is `not-run` (acquisition refusal) or the pipeline's own `failure`/`not-run`.
 *    An inconclusive acquisition is never reported as a failure of the package.
 *
 * The caller owns every directory: the run directory that receives `<runDir>/cache`, the fixtures
 * and staging roots of the pipeline, and their removal (fixture-workspace.removeRunDir).
 * The pipeline fixture directory must contain the SAME package.json and package-lock.json that were
 * acquired (FIXED_PACKAGE_JSON and FIXED_LOCKFILE for the fixed fixture, or the exact
 * `operatorFixture` texts for an operator fixture; this function cannot check that, it has no file
 * access); if it does not, the offline install fails with a cache miss and that is reported as the
 * pipeline's failure. Operator fixtures add no code here: the request is passed to `acquire`
 * unchanged and the gate above is identical. The offline stage applies the base checkNpmFixture
 * (controlled-pipeline.ts, step 3 of its header) to the same bytes, which the operator gate has
 * already passed. Unverified: that the offline `npm ci --offline` accepts the handed-over cache for
 * a multi-package lock; any refusal there is reported as the pipeline's failure or not-run.
 *
 * @module registry-pipeline
 */

import type { ControlledPipelineResult, PipelineRequest, PipelineVerdict } from "./controlled-pipeline.js";
import type { RegistryAcquisitionRequest, RegistryAcquisitionResult } from "./npm-registry-acquisition.js";

export interface RegistryPipelineDeps {
  acquire: (req: RegistryAcquisitionRequest) => Promise<RegistryAcquisitionResult>;
  /** Builds the offline pipeline for a verified cache directory. May throw; that is reported as not-run. */
  makePipeline: (cacheDir: string) => { run(req: PipelineRequest): Promise<ControlledPipelineResult> };
}

export interface RegistryPipelineRequest {
  acquisition: RegistryAcquisitionRequest;
  /** Request for the offline stage. Its executionId must differ from the acquisition's. */
  pipeline: PipelineRequest;
}

export type RegistryPipelineResult = {
  status: PipelineVerdict;
  /** Which stage decided the status. */
  decidedBy: "acquisition" | "pipeline";
  detail: string;
  acquisition: RegistryAcquisitionResult;
  /** null when the offline stage was never started. */
  pipeline: ControlledPipelineResult | null;
};

export async function runRegistryThenOffline(
  deps: RegistryPipelineDeps,
  req: RegistryPipelineRequest,
): Promise<RegistryPipelineResult> {
  const acquisition = await deps.acquire(req.acquisition);
  if (acquisition.kind !== "acquired") {
    return {
      status: "not-run",
      decidedBy: "acquisition",
      detail: `acquisition did not complete (${acquisition.kind}); the offline stage was not started`,
      acquisition,
      pipeline: null,
    };
  }
  if (acquisition.cleanup === null || !acquisition.cleanup.confirmed || acquisition.stagingRemoved !== true) {
    // acquire() already downgrades these; checked again so a faulty injected acquirer cannot open the gate.
    return {
      status: "not-run",
      decidedBy: "acquisition",
      detail: "acquisition reported success without confirmed cleanup; the offline stage was not started",
      acquisition,
      pipeline: null,
    };
  }
  if (req.pipeline.executionId === req.acquisition.executionId) {
    return {
      status: "not-run",
      decidedBy: "acquisition",
      detail: "the offline stage must use a different execution id; it was not started",
      acquisition,
      pipeline: null,
    };
  }

  let pipeline: ControlledPipelineResult;
  try {
    pipeline = await deps.makePipeline(acquisition.cacheDir).run(req.pipeline);
  } catch {
    return {
      status: "not-run",
      decidedBy: "pipeline",
      detail: "the offline stage could not be constructed or raised an error",
      acquisition,
      pipeline: null,
    };
  }
  return {
    status: pipeline.status,
    decidedBy: "pipeline",
    detail: `acquired ${acquisition.packagesAdded} package(s) through the registry proxy; offline stage: ${pipeline.reason}`,
    acquisition,
    pipeline,
  };
}
