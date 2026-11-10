/**
 * server.ts — entry point for the GRAVEYARD backend.
 *
 * Loads config, builds the Fastify app, binds the TCP port, and handles
 * graceful shutdown on SIGINT / SIGTERM.
 *
 * Usage:
 *   node --env-file=.env dist/server.js
 */

import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let exitCode = 0;

async function main(): Promise<void> {
  // Validate configuration before doing anything else.
  // Throws with a descriptive message (no secret values) if invalid.
  const config = loadConfig();

  const app = await buildApp({
    logLevel: config.LOG_LEVEL,
    databasePath: config.DATABASE_PATH,
  });

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "Shutting down…");
    try {
      await app.close();
      app.log.info("Server closed cleanly");
    } catch (err) {
      app.log.error({ err }, "Error during shutdown");
      exitCode = 1;
    } finally {
      process.exit(exitCode);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // -------------------------------------------------------------------------
  // Listen
  // -------------------------------------------------------------------------

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    // Fastify logs the bound address automatically via its built-in logger.
  } catch (err) {
    app.log.error({ err }, "Failed to start server");
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // Config validation errors and other boot failures reach here.
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
