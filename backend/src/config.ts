/**
 * config.ts — configuration validation for GRAVEYARD backend.
 *
 * Reads from process.env (populated via `node --env-file=.env`).
 * Fails fast before the server listens if any value is invalid.
 * Never prints secret values in error messages.
 */

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  PORT: number;
  HOST: string;
  LOG_LEVEL: LogLevel;
  /** Filesystem path for the SQLite database, or ":memory:" for tests. */
  DATABASE_PATH: string;
}

function parsePort(raw: string | undefined): number {
  const value = raw ?? "3002";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid PORT: expected an integer between 1 and 65535 (received type ${typeof raw === "undefined" ? "undefined" : "string"})`,
    );
  }
  return port;
}

function parseHost(raw: string | undefined): string {
  const value = raw ?? "127.0.0.1";
  if (value.trim().length === 0) {
    throw new Error("Invalid HOST: must be a non-empty string");
  }
  return value;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw ?? "info";
  if (!(LOG_LEVELS as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid LOG_LEVEL: must be one of ${LOG_LEVELS.join(", ")}`,
    );
  }
  return value as LogLevel;
}

function parseDatabasePath(raw: string | undefined): string {
  const value = raw ?? "./data/graveyard.sqlite";
  if (value.trim().length === 0) {
    throw new Error("Invalid DATABASE_PATH: must be a non-empty string");
  }
  return value;
}

/**
 * Validates all required environment variables and returns a typed Config.
 * Throws a descriptive Error (without printing secret values) if any value is invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const errors: string[] = [];

  let PORT = 3002;
  let HOST = "127.0.0.1";
  let LOG_LEVEL: LogLevel = "info";
  let DATABASE_PATH = "./data/graveyard.sqlite";

  try {
    PORT = parsePort(env["PORT"]);
  } catch (e) {
    errors.push((e as Error).message);
  }

  try {
    HOST = parseHost(env["HOST"]);
  } catch (e) {
    errors.push((e as Error).message);
  }

  try {
    LOG_LEVEL = parseLogLevel(env["LOG_LEVEL"]);
  } catch (e) {
    errors.push((e as Error).message);
  }

  try {
    DATABASE_PATH = parseDatabasePath(env["DATABASE_PATH"]);
  } catch (e) {
    errors.push((e as Error).message);
  }

  if (errors.length > 0) {
    throw new Error(`Configuration error(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  return { PORT, HOST, LOG_LEVEL, DATABASE_PATH };
}
