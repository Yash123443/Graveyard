/**
 * worker-service.test.ts — bounded polling, availability gate, backoff and graceful stop of the
 * worker loop. A fake worker, a fake clock and a controllable sleep stand in for everything real:
 * no database, no Docker, no real waiting.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkerService, systemSleep, type ServiceLogLevel, type ServiceWorker, type Sleep, type WorkerServiceOptions } from "../worker-service.js";
import type { RecoveryResult, WorkerRunResult } from "../worker.js";

type RunStep = WorkerRunResult | Error | (() => Promise<WorkerRunResult>);

class FakeWorker implements ServiceWorker {
  runs = 0;
  recoveries = 0;
  shutdowns = 0;
  steps: RunStep[] = [];
  fallback: WorkerRunResult = { kind: "idle" };
  recoverImpl: () => Promise<RecoveryResult[]> = () => Promise.resolve([]);
  shutdownImpl: () => Promise<void> = () => Promise.resolve();
  private down = false;

  async runOnce(): Promise<WorkerRunResult> {
    // Like JobWorker: after shutdown() nothing new is claimed.
    if (this.down) return { kind: "idle" };
    this.runs += 1;
    const next = this.steps.shift();
    if (next === undefined) return this.fallback;
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    return next;
  }
  recoverOnce(): Promise<RecoveryResult[]> {
    this.recoveries += 1;
    return this.recoverImpl();
  }
  shutdown(): Promise<void> {
    this.shutdowns += 1;
    this.down = true;
    return this.shutdownImpl();
  }
}

/** Records every requested delay and parks the loop until release() or the signal aborts. */
class Sleeper {
  delays: number[] = [];
  private waiter: (() => void) | null = null;
  readonly sleep: Sleep = (ms, signal) => {
    this.delays.push(ms);
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = (): void => {
        this.waiter = null;
        resolve();
      };
      this.waiter = done;
      signal.addEventListener("abort", done, { once: true });
    });
  };
  release(): void {
    this.waiter?.();
  }
}

async function until(cond: () => boolean, label: string, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${label}`);
    await new Promise<void>((r) => setImmediate(r));
  }
}

interface LogLine {
  level: ServiceLogLevel;
  message: string;
  fields: Record<string, unknown> | undefined;
}

function make(over: Partial<WorkerServiceOptions> = {}): {
  worker: FakeWorker;
  sleeper: Sleeper;
  clock: { t: number };
  logs: LogLine[];
  svc: WorkerService;
} {
  const worker = new FakeWorker();
  const sleeper = new Sleeper();
  const clock = { t: 1_000 };
  const logs: LogLine[] = [];
  const svc = new WorkerService({
    worker,
    pollMs: 100,
    recoverMs: 1_000,
    batch: 3,
    maxBackoffMs: 1_000,
    now: () => clock.t,
    sleep: sleeper.sleep,
    log: (level, message, fields) => logs.push({ level, message, fields }),
    ...over,
  });
  return { worker, sleeper, clock, logs, svc };
}

const finished = (jobId: string, outcome: "completed" | "failed" | "blocked" | "requeued" = "completed"): WorkerRunResult => ({
  kind: "finished",
  jobId,
  outcome,
});

describe("WorkerService: bounded polling", () => {
  it("recovers at start, polls, sleeps pollMs when idle and recovers again only after recoverMs", async () => {
    const { worker, sleeper, clock, svc } = make();
    const done = svc.start();
    await until(() => sleeper.delays.length === 1, "first idle sleep");
    assert.equal(worker.recoveries, 1);
    assert.equal(worker.runs, 1);
    assert.deepEqual(sleeper.delays, [100]);

    sleeper.release();
    await until(() => sleeper.delays.length === 2, "second idle sleep");
    assert.equal(worker.recoveries, 1, "no recovery before recoverMs has passed");
    assert.equal(worker.runs, 2);

    clock.t += 1_000;
    sleeper.release();
    await until(() => sleeper.delays.length === 3, "third idle sleep");
    assert.equal(worker.recoveries, 2);

    await svc.stop();
    await done;
  });

  it("drains at most `batch` jobs per pass, polls again at once after a full batch and sleeps only when idle", async () => {
    const { worker, sleeper, svc } = make({ batch: 3 });
    worker.steps = [1, 2, 3, 4, 5, 6].map((n) => finished(`j${n}`));
    const done = svc.start();
    await until(() => sleeper.delays.length === 1, "idle sleep after the queue emptied");
    assert.equal(worker.runs, 7, "six jobs plus one idle probe");
    assert.deepEqual(sleeper.delays, [100]);
    assert.equal(svc.snapshot().jobsFinished, 6);
    await svc.stop();
    await done;
  });

  it("stops a drain at a blocked job, logs a warning and still sleeps pollMs", async () => {
    const { worker, sleeper, logs, svc } = make();
    worker.steps = [finished("j1", "blocked"), finished("j2")];
    const done = svc.start();
    await until(() => sleeper.delays.length === 1, "sleep after blocked job");
    assert.equal(worker.runs, 1, "the second job is not claimed in the same pass");
    assert.deepEqual(sleeper.delays, [100]);
    assert.ok(logs.some((l) => l.level === "warn" && l.message.includes("blocked or lease-lost")));
    assert.ok(logs.some((l) => l.level === "warn" && l.fields?.["jobId"] === "j1" && l.fields["outcome"] === "blocked"));
    await svc.stop();
    await done;
  });
});

describe("WorkerService: availability gate", () => {
  it("claims nothing while the runtime is unavailable, warns once, and resumes when it returns", async () => {
    let up = false;
    const { worker, sleeper, logs, svc } = make({ preflight: () => Promise.resolve(up) });
    const done = svc.start();
    await until(() => sleeper.delays.length === 1, "first gated sleep");
    sleeper.release();
    await until(() => sleeper.delays.length === 2, "second gated sleep");
    assert.equal(worker.runs, 0, "no job may be claimed while the runtime is unavailable");
    assert.equal(logs.filter((l) => l.message.includes("unavailable")).length, 1, "the outage is logged once, not per poll");
    assert.equal(svc.snapshot().runtimeAvailable, false);

    up = true;
    sleeper.release();
    await until(() => worker.runs === 1, "first claim after recovery");
    assert.ok(logs.some((l) => l.level === "info" && l.message.includes("is available")));
    assert.equal(svc.snapshot().runtimeAvailable, true);
    await svc.stop();
    await done;
  });

  it("treats a throwing preflight as unavailable", async () => {
    const { worker, sleeper, svc } = make({ preflight: () => Promise.reject(new Error("boom")) });
    const done = svc.start();
    await until(() => sleeper.delays.length === 1, "gated sleep");
    assert.equal(worker.runs, 0);
    assert.equal(svc.snapshot().runtimeAvailable, false);
    await svc.stop();
    await done;
  });

  it("still runs recovery while the runtime is unavailable", async () => {
    const { worker, sleeper, svc } = make({ preflight: () => Promise.resolve(false) });
    const done = svc.start();
    await until(() => sleeper.delays.length === 1, "gated sleep");
    assert.equal(worker.recoveries, 1);
    await svc.stop();
    await done;
  });
});

describe("WorkerService: errors and backoff", () => {
  it("backs off exponentially up to the cap, never spins, and resets after a success", async () => {
    const { worker, sleeper, svc } = make({ pollMs: 100, maxBackoffMs: 1_000 });
    worker.steps = [new Error("db busy"), new Error("db busy"), new Error("db busy"), new Error("db busy")];
    const done = svc.start();
    for (let n = 1; n <= 4; n += 1) {
      await until(() => sleeper.delays.length === n, `sleep ${n}`);
      sleeper.release();
    }
    await until(() => sleeper.delays.length === 5, "sleep after recovery from errors");
    assert.deepEqual(sleeper.delays, [200, 400, 800, 1_000, 100]);
    assert.equal(svc.snapshot().consecutiveFailures, 0);
    await svc.stop();
    await done;
  });

  it("logs a drain failure without leaking beyond the message", async () => {
    const { worker, sleeper, logs, svc } = make();
    worker.steps = [new Error("disk I/O error")];
    const done = svc.start();
    await until(() => sleeper.delays.length === 1, "sleep after failure");
    const line = logs.find((l) => l.level === "error");
    assert.ok(line);
    assert.equal(line.message, "queue drain failed");
    assert.equal(line.fields?.["error"], "disk I/O error");
    await svc.stop();
    await done;
  });

  it("a failing recovery pass does not prevent claiming jobs, and counts as a failure", async () => {
    const { worker, sleeper, svc } = make();
    worker.recoverImpl = () => Promise.reject(new Error("recovery broke"));
    const done = svc.start();
    await until(() => sleeper.delays.length === 1, "sleep");
    assert.equal(worker.runs, 1, "the queue is still drained");
    assert.deepEqual(sleeper.delays, [200]);
    await svc.stop();
    await done;
  });

  it("logs recovery results, warning for blocked ones", async () => {
    const { worker, sleeper, logs, svc } = make();
    worker.recoverImpl = () =>
      Promise.resolve<RecoveryResult[]>([
        { jobId: "a", outcome: "requeued" },
        { jobId: "b", outcome: "blocked" },
      ]);
    const done = svc.start();
    await until(() => sleeper.delays.length === 1, "sleep");
    assert.ok(logs.some((l) => l.level === "info" && l.fields?.["jobId"] === "a"));
    assert.ok(logs.some((l) => l.level === "warn" && l.fields?.["jobId"] === "b"));
    await svc.stop();
    await done;
  });
});

describe("WorkerService: graceful stop", () => {
  it("wakes the sleeping loop, shuts the worker down once and resolves start()", async () => {
    const { worker, sleeper, svc } = make();
    const done = svc.start();
    await until(() => sleeper.delays.length === 1, "sleep");
    await svc.stop();
    await done;
    assert.equal(worker.shutdowns, 1);
    assert.equal(worker.runs, 1, "no job is claimed after stop");
    assert.equal(svc.snapshot().state, "stopped");
    await svc.stop();
    assert.equal(worker.shutdowns, 1, "stop is idempotent");
  });

  it("waits for the active job to settle before stop() resolves", async () => {
    const { worker, sleeper, svc } = make();
    const order: string[] = [];
    let release!: (r: WorkerRunResult) => void;
    const running = new Promise<WorkerRunResult>((resolve) => {
      release = resolve;
    });
    worker.steps = [
      async () => {
        const r = await running;
        order.push("job settled");
        return r;
      },
    ];
    worker.shutdownImpl = () => {
      order.push("shutdown requested");
      release(finished("j1", "requeued"));
      return Promise.resolve();
    };
    const done = svc.start();
    await until(() => worker.runs === 1, "job started");
    await svc.stop();
    await done;
    assert.deepEqual(order, ["shutdown requested", "job settled"]);
    assert.equal(worker.runs, 1, "the loop does not claim another job after stop");
    assert.equal(sleeper.delays.length, 0, "the loop ended without sleeping");
  });

  it("survives a shutdown that raises", async () => {
    const { worker, sleeper, logs, svc } = make();
    worker.shutdownImpl = () => Promise.reject(new Error("shutdown broke"));
    const done = svc.start();
    await until(() => sleeper.delays.length === 1, "sleep");
    await svc.stop();
    await done;
    assert.ok(logs.some((l) => l.level === "error" && l.message.includes("shutdown raised")));
  });

  it("start() is idempotent and a stopped service never starts", async () => {
    const a = make();
    const p1 = a.svc.start();
    const p2 = a.svc.start();
    assert.equal(p1, p2);
    await until(() => a.sleeper.delays.length === 1, "sleep");
    await a.svc.stop();
    await p1;

    const b = make();
    await b.svc.stop();
    await b.svc.start();
    assert.equal(b.worker.runs, 0);
    assert.equal(b.worker.recoveries, 0);
  });
});

describe("WorkerService: construction and real sleep", () => {
  it("refuses invalid options", () => {
    const w = new FakeWorker();
    const base = { worker: w, pollMs: 100, recoverMs: 1_000, batch: 3 };
    assert.throws(() => new WorkerService({ ...base, pollMs: 0 }), /pollMs is invalid/);
    assert.throws(() => new WorkerService({ ...base, pollMs: 1.5 }), /pollMs is invalid/);
    assert.throws(() => new WorkerService({ ...base, recoverMs: 0 }), /recoverMs is invalid/);
    assert.throws(() => new WorkerService({ ...base, batch: 0 }), /batch is invalid/);
    assert.throws(() => new WorkerService({ ...base, batch: 101 }), /batch is invalid/);
    assert.throws(() => new WorkerService({ ...base, maxBackoffMs: 99 }), /maxBackoffMs is invalid/);
    assert.throws(() => new WorkerService({ ...base, worker: {} as unknown as ServiceWorker }), /worker is invalid/);
  });

  it("systemSleep resolves after the delay, and at once when already aborted or aborted later", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    await systemSleep(20, ac.signal);
    assert.ok(Date.now() - t0 >= 15);

    const pre = new AbortController();
    pre.abort();
    const t1 = Date.now();
    await systemSleep(10_000, pre.signal);
    assert.ok(Date.now() - t1 < 1_000);

    const later = new AbortController();
    const p = systemSleep(10_000, later.signal);
    setImmediate(() => later.abort());
    const t2 = Date.now();
    await p;
    assert.ok(Date.now() - t2 < 1_000);
  });
});
