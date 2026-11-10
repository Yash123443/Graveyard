/**
 * routes/jobs.ts — Fastify plugin for job routes.
 *
 * Routes implemented in this milestone:
 *
 *   POST /api/jobs
 *     Body: { repoUrl: string, consent: true }
 *     Response 202: { jobId, token, status: "queued" }
 *     Response 413: body exceeds 8 KiB (enforced by Fastify bodyLimit)
 *     Response 422: invalid repoUrl or consent (Fastify AJV with
 *                   coerceTypes:false, removeAdditional:false)
 *     - token is the raw 64-char hex capability token, returned ONCE.
 *     - Only the SHA-256 hash is stored; the token is never logged.
 *
 *   GET /api/jobs/:id
 *     Header: Authorization: Bearer <64-hex-chars>
 *     Response 200: job metadata (no token_hash)
 *     Response 401: Authorization header missing or does not match
 *                   /^Bearer [0-9a-f]{64}$/
 *     Response 403: token is structurally valid but does not match
 *                   the job — returned for BOTH wrong-token AND
 *                   unknown-job-id cases (identical response, constant-time
 *                   dummy comparison for missing jobs).
 *     - Cache-Control: no-store on every /api/jobs response via onRequest hook.
 *
 * Authorization design:
 *   A syntactically well-formed Bearer token (64 lowercase hex chars) that
 *   does not match ANY job is indistinguishable from a token that matches a
 *   different job.  Both return 403 with the same body.  The constant-time
 *   comparison is performed against a static dummy hash when the job is not
 *   found, so timing cannot distinguish the two cases.
 *
 * @module routes/jobs
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { validateGithubUrl } from "../url.js";
import { generateRawToken, verifyToken } from "../token.js";
import { createJob, findJobById, getTokenHash, cancelJob } from "../jobs.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * A well-formed but never-matching dummy hash used for constant-time
 * comparison when a job is not found.  This prevents timing attacks from
 * distinguishing "job exists, wrong token" from "job does not exist".
 * The value is a fixed SHA-256 hex digest; it does not correspond to any
 * real token.
 */
const DUMMY_HASH = "0".repeat(64);

/** Strict pattern: "Bearer " followed by exactly 64 lowercase hex chars. */
const BEARER_RE = /^Bearer [0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreateJobBody {
  repoUrl: string;
  consent: boolean;
}

interface CreateJobReply {
  jobId: string;
  token: string;
  status: "queued";
}

interface JobMetaReply {
  jobId: string;
  repoUrl: string;
  stage: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface GetJobParams {
  id: string;
}

interface CancelJobParams {
  id: string;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const jobRoutes: FastifyPluginAsync<{ db: DatabaseSync }> = async (
  fastify: FastifyInstance,
  options,
): Promise<void> => {
  const { db } = options;

  // -------------------------------------------------------------------------
  // onRequest hook — Cache-Control: no-store on every /api/jobs* response.
  // Registered on this scoped plugin so it covers all routes defined here,
  // including error replies produced by Fastify before the handler runs.
  // -------------------------------------------------------------------------

  fastify.addHook("onRequest", (_req: FastifyRequest, reply: FastifyReply, done) => {
    void reply.header("Cache-Control", "no-store");
    done();
  });

  // -------------------------------------------------------------------------
  // Schemas
  // -------------------------------------------------------------------------

  fastify.addSchema({
    $id: "CreateJobBody",
    type: "object",
    required: ["repoUrl", "consent"],
    additionalProperties: false,
    properties: {
      repoUrl: { type: "string" },
      // Must be the literal boolean true — AJV coerceTypes:false ensures
      // "true" (string) and 1 (number) are rejected.
      consent: { type: "boolean", enum: [true] },
    },
  });

  fastify.addSchema({
    $id: "CreateJobReply",
    type: "object",
    required: ["jobId", "token", "status"],
    additionalProperties: false,
    properties: {
      jobId: { type: "string" },
      token: { type: "string" },
      status: { type: "string", enum: ["queued"] },
    },
  });

  fastify.addSchema({
    $id: "JobMetaReply",
    type: "object",
    required: ["jobId", "repoUrl", "stage", "status", "createdAt", "updatedAt"],
    additionalProperties: false,
    properties: {
      jobId: { type: "string" },
      repoUrl: { type: "string" },
      stage: { type: "string" },
      status: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
  });

  // -------------------------------------------------------------------------
  // POST /api/jobs
  // -------------------------------------------------------------------------

  fastify.post<{ Body: CreateJobBody; Reply: CreateJobReply }>(
    "/api/jobs",
    {
      schema: {
        body: { $ref: "CreateJobBody#" },
        response: {
          202: { $ref: "CreateJobReply#" },
        },
      },
    },
    async (request, reply) => {
      const { repoUrl, consent } = request.body;

      // Belt-and-suspenders: AJV enum:[true] + coerceTypes:false covers this,
      // but an explicit guard here ensures the route handler is self-describing.
      if (consent !== true) {
        return reply.status(422).send({
          statusCode: 422,
          error: "Unprocessable Entity",
          message: "consent must be the literal boolean true",
        } as unknown as CreateJobReply);
      }

      const urlResult = validateGithubUrl(repoUrl);
      if (!urlResult.ok) {
        return reply.status(422).send({
          statusCode: 422,
          error: "Unprocessable Entity",
          message: urlResult.reason,
        } as unknown as CreateJobReply);
      }

      const rawToken = generateRawToken();
      const { jobId } = createJob(db, { repoUrl: urlResult.url, rawToken });

      return reply.status(202).send({
        jobId,
        token: rawToken,
        status: "queued",
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/jobs/:id
  // -------------------------------------------------------------------------

  fastify.get<{ Params: GetJobParams; Reply: JobMetaReply }>(
    "/api/jobs/:id",
    {
      schema: {
        response: {
          200: { $ref: "JobMetaReply#" },
        },
      },
    },
    async (request, reply) => {
      // --- Step 1: Validate Authorization header format ---
      //
      // The header must match /^Bearer [0-9a-f]{64}$/ exactly.
      // Anything else — missing, wrong scheme, wrong length, uppercase hex,
      // empty token — returns 401.  No job lookup is performed at this stage.
      const authHeader = request.headers["authorization"];
      if (typeof authHeader !== "string" || !BEARER_RE.test(authHeader)) {
        return reply.status(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Authorization header must be: Bearer <64 lowercase hex chars>",
        } as unknown as JobMetaReply);
      }

      // "Bearer " is 7 chars; the remaining 64 chars are the token.
      const submittedToken = authHeader.slice(7);

      // --- Step 2: Look up stored hash; use dummy for missing jobs ---
      //
      // Whether the job exists or not, a constant-time comparison is always
      // performed.  Both "wrong token" and "job not found" return 403 with
      // an identical response body, preventing callers from probing job
      // existence via timing or status-code differences.
      const { id: jobId } = request.params;
      const storedHash = getTokenHash(db, jobId) ?? DUMMY_HASH;

      // --- Step 3: Constant-time token verification ---
      const tokenOk = verifyToken(submittedToken, storedHash);
      if (!tokenOk) {
        return reply.status(403).send({
          statusCode: 403,
          error: "Forbidden",
          message: "Invalid token for this resource",
        } as unknown as JobMetaReply);
      }

      // --- Step 4: Return metadata (token_hash excluded by findJobById) ---
      const job = findJobById(db, jobId);
      if (!job) {
        // The dummy hash happened to match the submitted token (astronomically
        // unlikely with a 256-bit hash).  Return 403 rather than 404 to remain
        // consistent with the documented contract.
        return reply.status(403).send({
          statusCode: 403,
          error: "Forbidden",
          message: "Invalid token for this resource",
        } as unknown as JobMetaReply);
      }

      return reply.status(200).send({
        jobId: job.id,
        repoUrl: job.repo_url,
        stage: job.stage,
        status: job.status,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/jobs/:id/cancel
  // -------------------------------------------------------------------------
  //
  // Cancels a job that is currently queued.  Uses the same strict Bearer
  // authorization as GET /api/jobs/:id: 401 for malformed header, 403 for
  // wrong/unknown token.
  //
  // 200 — job was queued and is now cancelled (returns updated metadata).
  // 409 — job is not in a cancellable state: already cancelled, terminal,
  //        or running (running is unsupported until a worker exists).
  //
  // The status UPDATE and event INSERT are committed atomically; if the event
  // INSERT fails the UPDATE is rolled back and the error propagates as 500.
  //
  // The `stage` column is intentionally NOT changed — stage tracks the
  // lifecycle phase (e.g. "queued"), not the current execution state.

  fastify.post<{ Params: CancelJobParams; Reply: JobMetaReply }>(
    "/api/jobs/:id/cancel",
    {
      schema: {
        response: {
          200: { $ref: "JobMetaReply#" },
        },
      },
    },
    async (request, reply) => {
      // --- Step 1: Validate Authorization header format ---
      const authHeader = request.headers["authorization"];
      if (typeof authHeader !== "string" || !BEARER_RE.test(authHeader)) {
        return reply.status(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Authorization header must be: Bearer <64 lowercase hex chars>",
        } as unknown as JobMetaReply);
      }

      const submittedToken = authHeader.slice(7);

      // --- Step 2: Look up stored hash; use dummy for missing jobs ---
      const { id: jobId } = request.params;
      const storedHash = getTokenHash(db, jobId) ?? DUMMY_HASH;

      // --- Step 3: Constant-time token verification ---
      const tokenOk = verifyToken(submittedToken, storedHash);
      if (!tokenOk) {
        return reply.status(403).send({
          statusCode: 403,
          error: "Forbidden",
          message: "Invalid token for this resource",
        } as unknown as JobMetaReply);
      }

      // --- Step 4: Attempt cancellation ---
      //
      // cancelJob returns "conflict" when status is not 'queued' (already
      // terminal, running, etc.).  The job row is returned in both cases.
      const { outcome, job } = cancelJob(db, jobId);

      if (outcome === "conflict") {
        return reply.status(409).send({
          statusCode: 409,
          error: "Conflict",
          message: `Job cannot be cancelled in its current state (status: ${job.status})`,
        } as unknown as JobMetaReply);
      }

      return reply.status(200).send({
        jobId: job.id,
        repoUrl: job.repo_url,
        stage: job.stage,
        status: job.status,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      });
    },
  );
};
