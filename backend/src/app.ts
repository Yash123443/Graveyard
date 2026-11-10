/**
 * app.ts — Fastify application factory for GRAVEYARD backend.
 *
 * Exports `buildApp` so tests can inject requests without binding a port.
 * Pass `databasePath: ":memory:"` in tests for full isolation.
 *
 * node:sqlite (DatabaseSync) is experimental on Node.js 22.x; it is used
 * on the local development runtime (Node.js 26.7.0).  No native add-on
 * installation is required regardless of Node.js version.
 */

import Fastify, { type FastifyInstance } from "fastify";
import type { LogLevel } from "./config.js";
import { openDatabase, closeDatabase } from "./db.js";
import { jobRoutes } from "./routes/jobs.js";
import { eventRoutes } from "./routes/events.js";

export interface AppOptions {
  logLevel?: LogLevel;
  /**
   * Filesystem path for the SQLite database.
   * Defaults to `:memory:` so that calling `buildApp()` without this option
   * (as tests do) never touches the filesystem.
   *
   * Production: pass `config.DATABASE_PATH` from `loadConfig()`.
   */
  databasePath?: string;
  /** Max concurrent SSE streams for this process (default 32); excess gets 429. */
  maxEventStreams?: number;
  /** SSE SQLite poll interval in ms (default 250). */
  eventPollMs?: number;
  /** SSE heartbeat comment interval in ms (default 15000). */
  eventHeartbeatMs?: number;
}

const VERSION = "0.2.0";

/**
 * Builds and returns a Fastify instance with all routes and plugins registered.
 * Does NOT call `listen`; that is the responsibility of server.ts.
 */
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const { logLevel = "info", databasePath = ":memory:", maxEventStreams, eventPollMs, eventHeartbeatMs } = options;

  const fastify = Fastify({
    logger: {
      level: logLevel,
      // Redact the Authorization header so raw tokens never appear in logs.
      redact: ["req.headers.authorization"],
    },
    ajv: {
      customOptions: {
        // Disable AJV type coercion: "true" must not pass a boolean schema.
        coerceTypes: false,
        // Disable AJV additional-property removal: extra fields must be rejected.
        removeAdditional: false,
      },
    },
    // Reject request bodies larger than 8 KiB with 413.
    bodyLimit: 8192,
  });

  // -------------------------------------------------------------------------
  // Database lifecycle
  // -------------------------------------------------------------------------

  const db = openDatabase(databasePath);

  fastify.addHook("onClose", (_instance, done) => {
    try {
      closeDatabase(db);
    } catch {
      // Best-effort close — do not prevent shutdown on error.
    }
    done();
  });

  // -------------------------------------------------------------------------
  // Shared schemas
  // -------------------------------------------------------------------------

  fastify.addSchema({
    $id: "HealthResponse",
    type: "object",
    required: ["status", "version"],
    properties: {
      status: { type: "string" },
      version: { type: "string" },
    },
    additionalProperties: false,
  });

  fastify.addSchema({
    $id: "ErrorResponse",
    type: "object",
    required: ["statusCode", "error", "message"],
    properties: {
      statusCode: { type: "integer" },
      error: { type: "string" },
      message: { type: "string" },
    },
    additionalProperties: false,
  });

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  fastify.get(
    "/health",
    {
      schema: {
        response: {
          200: { $ref: "HealthResponse#" },
        },
      },
    },
    async (_request, _reply) => {
      return { status: "ok", version: VERSION };
    },
  );

  // Job routes plugin — receives the open db instance via options.
  await fastify.register(jobRoutes, { db });
  await fastify.register(eventRoutes, {
    db,
    ...(maxEventStreams !== undefined ? { maxStreams: maxEventStreams } : {}),
    ...(eventPollMs !== undefined ? { pollMs: eventPollMs } : {}),
    ...(eventHeartbeatMs !== undefined ? { heartbeatMs: eventHeartbeatMs } : {}),
  });

  // -------------------------------------------------------------------------
  // Error handlers — sanitized; no stack disclosure
  // -------------------------------------------------------------------------

  // 404 — route not found
  fastify.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({
      statusCode: 404,
      error: "Not Found",
      message: "Route not found",
    });
  });

  // 500 — unhandled errors
  fastify.setErrorHandler((error, _request, reply) => {
    // Narrow to an object first so `in` and property accesses below are valid
    // under `unknown` (the default TError for setErrorHandler).
    const errorObj: object | null = error instanceof Error ? error : null;

    const candidate = errorObj !== null && "statusCode" in errorObj ? (errorObj as { statusCode: unknown }).statusCode : undefined;
    const statusCode = typeof candidate === "number" && Number.isInteger(candidate)
      && candidate >= 400 && candidate <= 599 ? candidate : 500;

    // AJV schema validation errors arrive with statusCode 400 and a
    // `validation` array on the error object.  Map these to 422 so callers
    // can distinguish "the request body failed schema validation" from other
    // 400-class problems.  Body-size errors (413) have their own statusCode
    // and are passed through unchanged.
    const isValidationError =
      statusCode === 400 &&
      errorObj !== null &&
      "validation" in errorObj &&
      Array.isArray((errorObj as Record<string, unknown>)["validation"]);
    const effectiveStatus = isValidationError ? 422 : statusCode;

    const isClientError = effectiveStatus >= 400 && effectiveStatus < 500;

    // Log the real error server-side (no leaking to client)
    if (!isClientError) {
      reply.log.error({ err: error }, "Unhandled error");
    }

    reply.status(effectiveStatus).send({
      statusCode: effectiveStatus,
      error: isClientError ? "Client Error" : "Internal Server Error",
      message: isClientError ? "Invalid request" : "An unexpected error occurred",
    });
  });

  return fastify;
}
