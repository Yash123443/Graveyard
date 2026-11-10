/**
 * events.test.ts — GET /api/jobs/:id/events (SSE).
 * inject-based tests cover auth/replay/terminal behaviour; the real HTTP
 * tests use an ephemeral 127.0.0.1 port and may need an external run.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { buildApp } from "../app.js";
import { openDatabase } from "../db.js";
import { EventStream, formatFrame, PAGE_SIZE, type SseSink } from "../routes/events.js";
import { createJob } from "../jobs.js";
import { generateRawToken } from "../token.js";

const URL_OK = "https://github.com/o/r";
const WRONG = "a".repeat(64);

interface Frame { id?: string; event?: string; data?: string }

function parseFrames(body: string): Frame[] {
  const out: Frame[] = [];
  for (const block of body.split("\n\n")) {
    if (block.trim() === "" || block.startsWith(":")) continue;
    const f: Frame = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) f.id = line.slice(4);
      else if (line.startsWith("event: ")) f.event = line.slice(7);
      else if (line.startsWith("data: ")) f.data = (f.data === undefined ? "" : f.data + "\n") + line.slice(6);
    }
    out.push(f);
  }
  return out;
}

async function newJob(app: FastifyInstance): Promise<{ id: string; token: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/jobs",
    headers: { "Content-Type": "application/json" },
    payload: JSON.stringify({ repoUrl: URL_OK, consent: true }),
  });
  const j = res.json<{ jobId: string; token: string }>();
  return { id: j.jobId, token: j.token };
}

const cancel = (app: FastifyInstance, id: string, token: string) =>
  app.inject({ method: "POST", url: `/api/jobs/${id}/cancel`, headers: { Authorization: `Bearer ${token}` } });

const sse = (app: FastifyInstance, id: string, token: string, extra: Record<string, string> = {}) =>
  app.inject({
    method: "GET",
    url: `/api/jobs/${id}/events`,
    headers: { Authorization: `Bearer ${token}`, ...extra },
  });

// ---------------------------------------------------------------------------

describe("SSE — authorization and Last-Event-ID", () => {
  let app: FastifyInstance;
  let id: string;
  let token: string;

  before(async () => {
    app = await buildApp({ logLevel: "silent" });
    ({ id, token } = await newJob(app));
  });
  after(async () => { await app.close(); });

  it("401 without header, with malformed header, and when token is only in the query", async () => {
    for (const r of [
      await app.inject({ method: "GET", url: `/api/jobs/${id}/events` }),
      await app.inject({ method: "GET", url: `/api/jobs/${id}/events`, headers: { Authorization: "Bearer " + "A".repeat(64) } }),
      await app.inject({ method: "GET", url: `/api/jobs/${id}/events?token=${token}` }),
      await app.inject({ method: "GET", url: `/api/jobs/${id}/events?access_token=${token}` }),
    ]) {
      assert.equal(r.statusCode, 401);
      assert.equal(r.headers["cache-control"], "no-store");
    }
  });

  it("403 for wrong token and unknown job, with identical bodies", async () => {
    const a = await sse(app, id, WRONG);
    const b = await sse(app, "00000000-0000-4000-8000-000000000000", WRONG);
    assert.equal(a.statusCode, 403);
    assert.equal(b.statusCode, 403);
    assert.deepEqual(a.json(), b.json());
  });

  it("422 for malformed Last-Event-ID", async () => {
    for (const v of ["abc", "-1", "1.5", "01", "1e3", "", "9007199254740993", "0x1"]) {
      const r = await sse(app, id, token, { "Last-Event-ID": v });
      assert.equal(r.statusCode, 422, `value ${JSON.stringify(v)}`);
    }
  });

  it("422 when Last-Event-ID is ahead of the latest event", async () => {
    const r = await sse(app, id, token, { "Last-Event-ID": "999999" });
    assert.equal(r.statusCode, 422);
    const ok = await app.inject({ method: "POST", url: `/api/jobs/${id}/cancel`, headers: { Authorization: `Bearer ${token}` } });
    assert.equal(ok.statusCode, 200);
  });
});

describe("SSE — replay, cancellation and terminal close", () => {
  let app: FastifyInstance;
  before(async () => { app = await buildApp({ logLevel: "silent", eventPollMs: 10 }); });
  after(async () => { await app.close(); });

  it("replays stored rows for a cancelled job and closes", async () => {
    const { id, token } = await newJob(app);
    await cancel(app, id, token);
    const r = await sse(app, id, token);
    assert.equal(r.statusCode, 200);
    assert.match(String(r.headers["content-type"]), /^text\/event-stream/);
    assert.equal(r.headers["cache-control"], "no-store");
    const frames = parseFrames(r.body);
    assert.deepEqual(frames.map((f) => f.event), ["created", "cancelled"]);
    assert.ok(Number(frames[0]?.id) < Number(frames[1]?.id));
    assert.ok(!r.body.includes(token), "token must never appear in the stream");
    assert.equal((JSON.parse(frames[1]?.data ?? "{}") as { status: string }).status, "cancelled");
  });

  it("resumes after Last-Event-ID and does not replay earlier rows", async () => {
    const { id, token } = await newJob(app);
    await cancel(app, id, token);
    const all = parseFrames((await sse(app, id, token)).body);
    const r = await sse(app, id, token, { "Last-Event-ID": all[0]?.id ?? "0" });
    assert.deepEqual(parseFrames(r.body).map((f) => f.event), ["cancelled"]);
  });

  it("terminal job with cursor already at the last event closes immediately with no frames", async () => {
    const { id, token } = await newJob(app);
    await cancel(app, id, token);
    const all = parseFrames((await sse(app, id, token)).body);
    const r = await sse(app, id, token, { "Last-Event-ID": all[1]?.id ?? "0" });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(parseFrames(r.body), []);
  });
});

describe("SSE — paging and terminal ordering (file database)", () => {
  let dir: string;
  let side: DatabaseSync;
  let app: FastifyInstance;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "graveyard-sse-"));
    const p = join(dir, "t.sqlite");
    app = await buildApp({ logLevel: "silent", databasePath: p, eventPollMs: 10 });
    side = openDatabase(p);
  });
  after(async () => {
    await app.close();
    try { side.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("delivers every persisted event across pages, in order, before closing on completed", async () => {
    const token = generateRawToken();
    const { jobId } = createJob(side, { repoUrl: URL_OK, rawToken: token });
    const extra = PAGE_SIZE * 2 + 37;
    side.exec("BEGIN");
    const ins = side.prepare("INSERT INTO job_events (job_id, event_type, payload, created_at) VALUES (?, 'progress', ?, ?)");
    for (let i = 0; i < extra; i++) ins.run(jobId, JSON.stringify({ i }), new Date().toISOString());
    side.prepare("UPDATE jobs SET status = 'completed' WHERE id = ?").run(jobId);
    ins.run(jobId, JSON.stringify({ status: "completed" }), new Date().toISOString());
    side.exec("COMMIT");

    const r = await sse(app, jobId, token);
    const frames = parseFrames(r.body);
    assert.equal(frames.length, 1 + extra + 1);
    const ids = frames.map((f) => Number(f.id));
    for (let i = 1; i < ids.length; i++) assert.ok((ids[i] as number) > (ids[i - 1] as number));
    assert.equal(JSON.parse(frames[frames.length - 1]?.data ?? "{}").status, "completed");
  });

  it("each terminal status closes only after its events are delivered", async () => {
    for (const status of ["failed", "timed-out"]) {
      const token = generateRawToken();
      const { jobId } = createJob(side, { repoUrl: URL_OK, rawToken: token });
      side.exec("BEGIN");
      side.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, jobId);
      side.prepare("INSERT INTO job_events (job_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)")
        .run(jobId, status, JSON.stringify({ status }), new Date().toISOString());
      side.exec("COMMIT");
      const frames = parseFrames((await sse(app, jobId, token)).body);
      assert.deepEqual(frames.map((f) => f.event), ["created", status]);
    }
  });
});

describe("EventStream — backpressure, cleanup", () => {
  class FakeSink extends EventEmitter implements SseSink {
    chunks: string[] = [];
    ended = false;
    accept = true;
    write(c: string): boolean { this.chunks.push(c); return this.accept; }
    end(): void { this.ended = true; }
  }

  it("pauses polling while the sink is blocked and resumes after drain", async () => {
    const db = openDatabase(":memory:");
    try {
      const { jobId } = createJob(db, { repoUrl: URL_OK, rawToken: generateRawToken() });
      const sink = new FakeSink();
      sink.accept = false;
      const s = new EventStream({ db, jobId, cursor: 0, sink, pollMs: 5, heartbeatMs: 5 });
      s.start();
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(sink.chunks.length, 1, "no further writes (events or heartbeats) while blocked");

      db.prepare("INSERT INTO job_events (job_id, event_type, payload, created_at) VALUES (?, 'progress', '{}', 't')").run(jobId);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(sink.chunks.length, 1, "polling stays paused until drain");

      sink.accept = true;
      sink.emit("drain");
      await new Promise((r) => setTimeout(r, 40));
      assert.ok(sink.chunks.some((c) => c.startsWith("id: 2\nevent: progress")));
      s.stop();
    } finally {
      db.close();
    }
  });

  it("a heartbeat write returning false stops all writes and polling until drain, then resumes without duplicates", async () => {
    const db = openDatabase(":memory:");
    try {
      const { jobId } = createJob(db, { repoUrl: URL_OK, rawToken: generateRawToken() });
      const sink = new FakeSink();
      let blockHeartbeat = true;
      sink.write = (c: string): boolean => {
        sink.chunks.push(c);
        return !(blockHeartbeat && c.startsWith(": heartbeat"));
      };
      const s = new EventStream({ db, jobId, cursor: 0, sink, pollMs: 10, heartbeatMs: 40 });
      s.start();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sink.chunks.length, 1, "initial event delivered before first heartbeat");

      await new Promise((r) => setTimeout(r, 50));
      assert.equal(sink.chunks.length, 2, "one heartbeat, which returned false");
      assert.equal(sink.listenerCount("drain"), 1);

      db.prepare("INSERT INTO job_events (job_id, event_type, payload, created_at) VALUES (?, 'progress', '{}', 't')").run(jobId);
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(sink.chunks.length, 2, "no events or heartbeats while waiting for drain");
      assert.equal(sink.listenerCount("drain"), 1, "drain listener attached once");

      blockHeartbeat = false;
      sink.emit("drain");
      await new Promise((r) => setTimeout(r, 60));
      s.stop();
      const frames = sink.chunks.filter((c) => c.startsWith("id: "));
      assert.deepEqual(frames.map((c) => c.split("\n")[0]), ["id: 1", "id: 2"], "no duplicate frames");
      assert.equal(sink.listenerCount("drain"), 0);
    } finally {
      db.close();
    }
  });

  it("stop() is idempotent, ends the sink, calls onDone once and removes listeners", () => {
    const db = openDatabase(":memory:");
    try {
      const { jobId } = createJob(db, { repoUrl: URL_OK, rawToken: generateRawToken() });
      const sink = new FakeSink();
      let done = 0;
      const s = new EventStream({ db, jobId, cursor: 0, sink, onDone: () => { done++; } });
      s.start();
      s.stop();
      s.stop();
      assert.equal(done, 1);
      assert.equal(sink.ended, true);
      assert.equal(sink.listenerCount("close"), 0);
      assert.equal(sink.listenerCount("drain"), 0);
    } finally {
      db.close();
    }
  });

  it("sink 'close' (client disconnect) stops the stream without ending it again", () => {
    const db = openDatabase(":memory:");
    try {
      const { jobId } = createJob(db, { repoUrl: URL_OK, rawToken: generateRawToken() });
      const sink = new FakeSink();
      const s = new EventStream({ db, jobId, cursor: 0, sink });
      s.start();
      sink.emit("close");
      assert.equal(s.isClosed, true);
      assert.equal(sink.ended, false);
    } finally {
      db.close();
    }
  });

  it("formatFrame emits id/event/data and splits multi-line data", () => {
    assert.equal(formatFrame(7, "x", "{}"), "id: 7\nevent: x\ndata: {}\n\n");
    assert.equal(formatFrame(1, "a\nb", "l1\nl2"), "id: 1\nevent: a b\ndata: l1\ndata: l2\n\n");
  });
});

// ---------------------------------------------------------------------------
// Real HTTP (ephemeral port)
// ---------------------------------------------------------------------------

interface Live {
  req: http.ClientRequest;
  status: number;
  text(): string;
  ended: Promise<void>;
  waitFor(pred: (t: string) => boolean, ms?: number): Promise<void>;
}

function openLive(port: number, id: string, token: string): Promise<Live> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const waiters: Array<() => void> = [];
    const req = http.get(
      { host: "127.0.0.1", port, path: `/api/jobs/${id}/events`, headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        res.setEncoding("utf8");
        const ended = new Promise<void>((r) => { res.on("end", r); res.on("close", r); });
        res.on("data", (c: string) => { buf += c; waiters.forEach((w) => w()); });
        resolve({
          req,
          status: res.statusCode ?? 0,
          text: () => buf,
          ended,
          waitFor: (pred, ms = 3000) =>
            new Promise<void>((ok, bad) => {
              const t = setTimeout(() => bad(new Error("timeout waiting for stream content")), ms);
              const check = (): void => { if (pred(buf)) { clearTimeout(t); ok(); } };
              waiters.push(check);
              check();
            }),
        });
      },
    );
    req.on("error", reject);
  });
}

async function eventually(fn: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
}

describe("SSE — real HTTP streaming (ephemeral server)", () => {
  let app: FastifyInstance;
  let port: number;

  before(async () => {
    app = await buildApp({ logLevel: "silent", eventPollMs: 20, eventHeartbeatMs: 40, maxEventStreams: 2 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });
  after(async () => { await app.close(); });

  it("streams replay, heartbeat comments and a live cancellation, then closes", async () => {
    const { id, token } = await newJob(app);
    const live = await openLive(port, id, token);
    assert.equal(live.status, 200);
    await live.waitFor((t) => t.includes("event: created"));
    await live.waitFor((t) => t.includes(": heartbeat"));
    assert.equal((await cancel(app, id, token)).statusCode, 200);
    await live.waitFor((t) => t.includes("event: cancelled"));
    await live.ended;
    assert.deepEqual(parseFrames(live.text()).map((f) => f.event), ["created", "cancelled"]);
    assert.ok(!live.text().includes(token));
  });

  it("enforces the stream cap with 429 and frees slots on client disconnect", async () => {
    const a = await newJob(app);
    const b = await newJob(app);
    const c = await newJob(app);
    const s1 = await openLive(port, a.id, a.token);
    const s2 = await openLive(port, b.id, b.token);
    await s1.waitFor((t) => t.includes("event: created"));
    await s2.waitFor((t) => t.includes("event: created"));

    const denied = await sse(app, c.id, c.token);
    assert.equal(denied.statusCode, 429);
    assert.equal(denied.headers["retry-after"], "5");

    s1.req.destroy();
    // Slot freed once the server notices the disconnect.
    const held: Live[] = [];
    await eventually(async () => {
      const s3 = await openLive(port, c.id, c.token);
      if (s3.status === 200) { held.push(s3); return true; }
      s3.req.destroy();
      return false;
    });
    held.forEach((h) => h.req.destroy());
    s2.req.destroy();
  });

  it("app.close() ends open streams and resolves", async () => {
    const app2 = await buildApp({ logLevel: "silent", eventPollMs: 20 });
    await app2.listen({ host: "127.0.0.1", port: 0 });
    const p = (app2.server.address() as AddressInfo).port;
    const { id, token } = await newJob(app2);
    const live = await openLive(p, id, token);
    await live.waitFor((t) => t.includes("event: created"));
    await app2.close();
    await live.ended;
  });
});
