/**
 * worker-main.ts — entry point of the opt-in local worker process.
 *
 * Usage (from backend/, after `pnpm run build`):
 *   $env:GRAVEYARD_WORKER_ENABLED = "1"   # plus the other GRAVEYARD_* variables, see worker-config.ts
 *   node --env-file=.env dist/worker-main.js
 *
 * This is a separate process from the API server (server.ts), which never starts it. It exits with
 *   0  after a graceful stop (SIGINT / SIGTERM / SIGBREAK),
 *   1  on invalid configuration, a refused startup, a second stop signal or the shutdown watchdog,
 *   2  when the opt-in switch is not set (nothing was opened or run).
 * Logs are JSON lines on stderr. No job token, lease token or Authorization header is ever in scope here.
 */

import { LOG_LEVELS, type LogLevel } from "./config.js";
import type { ServiceLog, ServiceLogLevel } from "./worker-service.js";
import { startWorker } from "./worker-process.js";

const RANK: Record<ServiceLogLevel, number> = { info: 3, warn: 2, error: 1 };
const LEVEL_RANK: Record<LogLevel, number> = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5, silent: -1 };

function makeLogger(env: NodeJS.ProcessEnv): ServiceLog {
  const raw = env["LOG_LEVEL"] ?? "info";
  const level: LogLevel = (LOG_LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : "info";
  return (lvl, message, fields) => {
    if (RANK[lvl] > LEVEL_RANK[level]) return;
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: lvl, msg: message, ...(fields ?? {}) })}\n`);
  };
}

const log = makeLogger(process.env);
const result = startWorker(process.env, { log });

if (!result.started) {
  process.stderr.write(`${result.message}\n`);
  process.exit(result.exitCode);
} else {
  const { shutdownMs } = result.composed.config;
  let signalled = false;

  const onSignal = (signal: string): void => {
    if (signalled) {
      log("error", "second stop signal; exiting immediately", { signal });
      process.exit(1);
    }
    signalled = true;
    log("info", "stop requested; settling the active job", { signal });
    const watchdog = setTimeout(() => {
      log("error", "graceful shutdown did not finish in time; exiting", { shutdownMs });
      process.exit(1);
    }, shutdownMs);
    watchdog.unref();
    result.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };

  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  if (process.platform === "win32") process.on("SIGBREAK", () => onSignal("SIGBREAK"));

  log("info", "worker started", {
    workerId: result.composed.config.workerId,
    catalogEntries: Object.keys(result.composed.config.catalog).length,
    agents: result.composed.config.agents,
    githubPins: Object.keys(result.composed.config.github?.pins ?? {}).length,
    githubRegistryEgress: result.composed.config.github?.registryEgress != null,
  });
  await result.done;
}
