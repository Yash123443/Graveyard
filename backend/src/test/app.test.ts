/**
 * app.test.ts — focused tests for the GRAVEYARD backend foundation.
 *
 * Uses Node.js built-in `node:test` and `fastify.inject` (no HTTP port needed).
 *
 * Run via: pnpm test
 * (which compiles to dist-test/ then: node --test dist-test/test/app.test.js)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({ logLevel: "silent" });
  });

  after(async () => {
    await app.close();
  });

  it("returns 200 with status and version", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ status: string; version: string }>();
    assert.equal(body.status, "ok");
    assert.equal(body.version, "0.2.0");
  });

  it("response content-type is application/json", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.ok(
      res.headers["content-type"]?.includes("application/json"),
      `Expected application/json, got: ${res.headers["content-type"]}`,
    );
  });

  it("response does not contain credentials or config secrets", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const raw = res.body;
    // No PORT, HOST, LOG_LEVEL keys in response
    assert.ok(!raw.includes("PORT"), "Response must not include PORT");
    assert.ok(!raw.includes("HOST"), "Response must not include HOST");
    assert.ok(!raw.includes("LOG_LEVEL"), "Response must not include LOG_LEVEL");
  });
});

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

describe("404 handler", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({ logLevel: "silent" });
  });

  after(async () => {
    await app.close();
  });

  it("returns 404 for unknown GET route", async () => {
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    assert.equal(res.statusCode, 404);
  });

  it("404 body contains statusCode, error, message", async () => {
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    const body = res.json<{ statusCode: number; error: string; message: string }>();
    assert.equal(body.statusCode, 404);
    assert.equal(typeof body.error, "string");
    assert.equal(typeof body.message, "string");
  });

  it("404 body does not disclose stack trace", async () => {
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    const raw = res.body;
    assert.ok(!raw.includes("at "), "Response must not include stack frames");
    assert.ok(!raw.includes("Error:"), "Response must not include Error: prefix");
  });

  it("returns 404 for unknown POST route", async () => {
    const res = await app.inject({ method: "POST", url: "/unknown" });
    assert.equal(res.statusCode, 404);
  });
});

// ---------------------------------------------------------------------------
// config validation
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  it("accepts valid default environment", () => {
    const config = loadConfig({});
    assert.equal(config.PORT, 3002);
    assert.equal(config.HOST, "127.0.0.1");
    assert.equal(config.LOG_LEVEL, "info");
    assert.equal(config.DATABASE_PATH, "./data/graveyard.sqlite");
  });

  it("accepts valid explicit values", () => {
    const config = loadConfig({ PORT: "8080", HOST: "0.0.0.0", LOG_LEVEL: "debug", DATABASE_PATH: "/tmp/test.sqlite" });
    assert.equal(config.PORT, 8080);
    assert.equal(config.HOST, "0.0.0.0");
    assert.equal(config.LOG_LEVEL, "debug");
    assert.equal(config.DATABASE_PATH, "/tmp/test.sqlite");
  });

  it("throws on invalid PORT (string)", () => {
    assert.throws(
      () => loadConfig({ PORT: "not-a-number" }),
      /Invalid PORT/,
    );
  });

  it("throws on PORT out of range (0)", () => {
    assert.throws(
      () => loadConfig({ PORT: "0" }),
      /Invalid PORT/,
    );
  });

  it("throws on PORT out of range (65536)", () => {
    assert.throws(
      () => loadConfig({ PORT: "65536" }),
      /Invalid PORT/,
    );
  });

  it("throws on empty HOST", () => {
    assert.throws(
      () => loadConfig({ HOST: "   " }),
      /Invalid HOST/,
    );
  });

  it("throws on invalid LOG_LEVEL", () => {
    assert.throws(
      () => loadConfig({ LOG_LEVEL: "verbose" }),
      /Invalid LOG_LEVEL/,
    );
  });

  it("accepts :memory: as DATABASE_PATH", () => {
    const config = loadConfig({ DATABASE_PATH: ":memory:" });
    assert.equal(config.DATABASE_PATH, ":memory:");
  });

  it("throws on empty DATABASE_PATH", () => {
    assert.throws(
      () => loadConfig({ DATABASE_PATH: "   " }),
      /Invalid DATABASE_PATH/,
    );
  });

  it("collects multiple validation errors in one throw", () => {
    let message = "";
    try {
      loadConfig({ PORT: "bad", LOG_LEVEL: "bad" });
    } catch (e) {
      message = (e as Error).message;
    }
    assert.ok(message.includes("Invalid PORT"), "Should mention PORT");
    assert.ok(message.includes("Invalid LOG_LEVEL"), "Should mention LOG_LEVEL");
  });

  it("error message does not include the invalid value", () => {
    const secret = "super_secret_value_12345";
    let message = "";
    try {
      loadConfig({ HOST: "" , LOG_LEVEL: secret });
    } catch (e) {
      message = (e as Error).message;
    }
    // The exact value must not appear in the error
    assert.ok(!message.includes(secret), "Error must not echo back the invalid value");
  });
});
