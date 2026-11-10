/**
 * routes/events.ts — GET /api/jobs/:id/events (Server-Sent Events).
 *
 * Auth: same bearer contract as the other job routes (401 malformed,
 * 403 wrong/unknown). Tokens are NEVER accepted via query string. Auth,
 * Last-Event-ID validation and the concurrency cap all run BEFORE the
 * response is hijacked, so failures are ordinary JSON errors.
 *
 * Delivery: persisted job_events rows are polled from SQLite in pages of
 * PAGE_SIZE with `seq > cursor`. Replay and live delivery use the same
 * cursor, so there is no replay/live race. Frames carry stored id/event/data
 * only. Terminal jobs close after every persisted event has been delivered.
 *
 * Last-Event-ID: absent = 0; otherwise must be a non-negative safe integer
 * (422 if malformed) and not greater than the job's latest seq (422).
 */

import type { EventEmitter } from "node:events";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { verifyToken } from "../token.js";
import {
  findJobById,
  getTokenHash,
  getLatestEventSeq,
  listEventsAfter,
  isTerminalStatus,
} from "../jobs.js";

export const PAGE_SIZE = 100;
export const DEFAULT_MAX_EVENT_STREAMS = 32;
export const DEFAULT_POLL_MS = 250;
export const DEFAULT_HEARTBEAT_MS = 15_000;

const DUMMY_HASH = "0".repeat(64);
const BEARER_RE = /^Bearer [0-9a-f]{64}$/;
const CURSOR_RE = /^(0|[1-9][0-9]*)$/;

/** Minimal writable surface (satisfied by http.ServerResponse). */
export interface SseSink extends EventEmitter {
  write(chunk: string): boolean;
  end(): unknown;
}

export interface EventStreamOptions {
  db: DatabaseSync;
  jobId: string;
  /** Last delivered seq; only seq > cursor is sent. */
  cursor: number;
  sink: SseSink;
  pollMs?: number;
  heartbeatMs?: number;
  /** Called exactly once when the stream has fully stopped. */
  onDone?: () => void;
}

/** Formats one stored row as an SSE frame. */
export function formatFrame(seq: number, eventType: string, payload: string): string {
  const type = eventType.replace(/[\r\n]/g, " ");
  const data = payload.split(/\r\n|\r|\n/).map((l) => `data: ${l}`).join("\n");
  return `id: ${seq}\nevent: ${type}\n${data}\n\n`;
}

/** Polls stored events for one job and writes them to a sink. */
export class EventStream {
  private cursor: number;
  private closed = false;
  private waitingDrain = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private beatTimer: NodeJS.Timeout | undefined;
  private readonly pollMs: number;
  private readonly onSinkClose = (): void => this.stop(false);
  private readonly onDrain = (): void => {
    this.waitingDrain = false;
    this.schedule(0);
  };

  constructor(private readonly o: EventStreamOptions) {
    this.cursor = o.cursor;
    this.pollMs = o.pollMs ?? DEFAULT_POLL_MS;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  start(): void {
    const { sink } = this.o;
    sink.on("close", this.onSinkClose);
    sink.on("error", this.onSinkClose);
    const beat = this.o.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.beatTimer = setInterval(() => {
      // Never queue extra bytes while the client is not draining.
      if (this.closed || this.waitingDrain) return;
      const ok = this.safeWrite(": heartbeat\n\n");
      if (!ok && !this.closed) {
        // Backpressure: pause polling and heartbeats until the sink drains.
        this.waitingDrain = true;
        if (this.pollTimer !== undefined) {
          clearTimeout(this.pollTimer);
          this.pollTimer = undefined;
        }
        this.o.sink.once("drain", this.onDrain);
      }
    }, beat);
    this.beatTimer.unref();
    this.schedule(0);
  }

  /** Stops polling and ends the response. Idempotent. */
  stop(endSink = true): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    if (this.beatTimer !== undefined) clearInterval(this.beatTimer);
    const { sink } = this.o;
    sink.off("close", this.onSinkClose);
    sink.off("error", this.onSinkClose);
    sink.off("drain", this.onDrain);
    if (endSink) {
      try { sink.end(); } catch { /* already gone */ }
    }
    this.o.onDone?.();
  }

  private schedule(ms: number): void {
    if (this.closed || this.waitingDrain) return;
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.tick(), ms);
  }

  private safeWrite(chunk: string): boolean {
    try {
      return this.o.sink.write(chunk);
    } catch {
      this.stop(false);
      return true;
    }
  }

  private tick(): void {
    if (this.closed || this.waitingDrain) return;
    try {
      // Read status BEFORE events: status and its final event commit in one
      // transaction, so a terminal status guarantees its events are visible.
      const job = findJobById(this.o.db, this.o.jobId);
      if (job === null) {
        this.stop();
        return;
      }
      const rows = listEventsAfter(this.o.db, this.o.jobId, this.cursor, PAGE_SIZE);

      for (const row of rows) {
        const ok = this.safeWrite(formatFrame(row.seq, row.event_type, row.payload));
        if (this.closed) return;
        this.cursor = row.seq;
        if (!ok) {
          // Backpressure: pause polling until the sink drains.
          this.waitingDrain = true;
          this.o.sink.once("drain", this.onDrain);
          return;
        }
      }

      if (rows.length === 0 && isTerminalStatus(job.status)) {
        this.stop();
        return;
      }
      this.schedule(rows.length === PAGE_SIZE || isTerminalStatus(job.status) ? 0 : this.pollMs);
    } catch {
      // DB closed or failing: end the stream rather than crash the process.
      this.stop();
    }
  }
}

export interface EventRoutesOptions {
  db: DatabaseSync;
  maxStreams?: number;
  pollMs?: number;
  heartbeatMs?: number;
}

export const eventRoutes: FastifyPluginAsync<EventRoutesOptions> = async (
  fastify: FastifyInstance,
  options,
): Promise<void> => {
  const { db } = options;
  const maxStreams = options.maxStreams ?? DEFAULT_MAX_EVENT_STREAMS;
  const active = new Set<EventStream>();

  const closeAll = (): void => {
    for (const s of [...active]) s.stop();
  };
  fastify.addHook("preClose", (done) => { closeAll(); done(); });
  fastify.addHook("onClose", (_i, done) => { closeAll(); done(); });

  fastify.addHook("onRequest", (_req, reply, done) => {
    void reply.header("Cache-Control", "no-store");
    done();
  });

  fastify.get<{ Params: { id: string } }>("/api/jobs/:id/events", async (request, reply) => {
    const authHeader = request.headers["authorization"];
    if (typeof authHeader !== "string" || !BEARER_RE.test(authHeader)) {
      return reply.status(401).send({
        statusCode: 401,
        error: "Unauthorized",
        message: "Authorization header must be: Bearer <64 lowercase hex chars>",
      });
    }
    const { id: jobId } = request.params;
    const storedHash = getTokenHash(db, jobId) ?? DUMMY_HASH;
    if (!verifyToken(authHeader.slice(7), storedHash) || findJobById(db, jobId) === null) {
      return reply.status(403).send({
        statusCode: 403,
        error: "Forbidden",
        message: "Invalid token for this resource",
      });
    }

    // --- Last-Event-ID ---
    let cursor = 0;
    const lei = request.headers["last-event-id"];
    if (lei !== undefined) {
      const n = typeof lei === "string" && CURSOR_RE.test(lei) ? Number(lei) : NaN;
      if (!Number.isSafeInteger(n) || n < 0) {
        return reply.status(422).send({
          statusCode: 422,
          error: "Unprocessable Entity",
          message: "Last-Event-ID must be a non-negative safe integer",
        });
      }
      if (n > getLatestEventSeq(db, jobId)) {
        return reply.status(422).send({
          statusCode: 422,
          error: "Unprocessable Entity",
          message: "Last-Event-ID is ahead of the latest event",
        });
      }
      cursor = n;
    }

    if (active.size >= maxStreams) {
      return reply.status(429).header("Retry-After", "5").send({
        statusCode: 429,
        error: "Too Many Requests",
        message: "Too many concurrent event streams",
      });
    }

    // --- Authorized and valid: hijack and stream ---
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.flushHeaders?.();

    const stream = new EventStream({
      db,
      jobId,
      cursor,
      sink: raw,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
      onDone: () => { active.delete(stream); },
    });
    active.add(stream);
    stream.start();
    return reply;
  });
};
