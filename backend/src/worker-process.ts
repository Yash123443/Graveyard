/**
 * worker-process.ts — start-up logic of the opt-in worker process, separated from the process
 * entry point (worker-main.ts) so it can be tested without signals or process.exit.
 *
 * Order, and what each refusal means:
 *   1. GRAVEYARD_WORKER_ENABLED is not "1"   -> not started, exit code 2, nothing opened or read.
 *   2. configuration invalid                 -> not started, exit code 1, every problem listed.
 *   3. directories / catalog fixtures / driver missing -> not started, exit code 1, database NOT opened.
 *   4. otherwise the database is opened and the polling loop starts.
 *
 * @module worker-process
 */

import { WorkerDisabledError, loadWorkerConfig, type ConfigDeps, type WorkerConfig } from "./worker-config.js";
import { composeWorker, type ComposeDeps, type ComposedWorker } from "./worker-compose.js";

export type StartResult =
  | { started: false; exitCode: 1 | 2; message: string }
  | {
      started: true;
      composed: ComposedWorker;
      /** Resolves when the loop has ended. Never rejects. */
      done: Promise<void>;
      /** Graceful: settles the active job, ends the loop, then closes the database. Idempotent. */
      stop: () => Promise<void>;
    };

export function startWorker(env: NodeJS.ProcessEnv, deps: ComposeDeps & ConfigDeps = {}): StartResult {
  let config: WorkerConfig;
  try {
    config = loadWorkerConfig(env, deps);
  } catch (e) {
    if (e instanceof WorkerDisabledError) return { started: false, exitCode: 2, message: e.message };
    return { started: false, exitCode: 1, message: e instanceof Error ? e.message : "invalid worker configuration" };
  }

  let composed: ComposedWorker;
  try {
    composed = composeWorker(config, deps);
  } catch (e) {
    return { started: false, exitCode: 1, message: e instanceof Error ? e.message : "worker startup refused" };
  }

  const done = composed.service.start();
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      try {
        await composed.service.stop();
      } finally {
        composed.close();
      }
    })();
    return stopping;
  };
  return { started: true, composed, done, stop };
}
