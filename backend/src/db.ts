/**
 * db.ts — SQLite database lifecycle for GRAVEYARD backend.
 *
 * Uses the built-in `node:sqlite` module (DatabaseSync).  The API is
 * experimental on Node.js 22.x and is used on the local development runtime
 * (Node.js 26.7.0).  No native add-on installation is required.
 *
 * WAL mode is enabled for concurrent read performance (API + future worker
 * share the same local file). busy_timeout prevents SQLITE_BUSY errors when
 * the writer holds the WAL lock briefly.
 *
 * Schema versioning via PRAGMA user_version lets future milestones add
 * columns/tables with incremental ALTER TABLE migrations rather than
 * destructive drops.
 *
 * @module db
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** The schema version implemented by this module. Increment on any DDL change. */
const CURRENT_SCHEMA_VERSION = 2;

/**
 * Opens (or creates) the SQLite database at `path`, enables WAL + busy_timeout,
 * and runs incremental migrations up to CURRENT_SCHEMA_VERSION.
 *
 * Pass `:memory:` for an in-process database (used by tests).
 *
 * Closes and re-throws if any setup step fails so the caller never receives a
 * partially-initialised database handle.
 *
 * @param path  Filesystem path or `:memory:`.
 * @returns     An open DatabaseSync instance ready for use.
 */
export function openDatabase(path: string): DatabaseSync {
  // Ensure parent directory exists for file-backed databases.
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);

  try {
    // Reliability pragmas — must be executed before any DDL/DML.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    // Foreign keys are off by default in SQLite; enable for referential integrity.
    db.exec("PRAGMA foreign_keys = ON");

    runMigrations(db);
  } catch (err) {
    // Close so the caller is not left with an unusable handle.
    try { db.close(); } catch { /* ignore close error */ }
    throw err;
  }

  return db;
}

/**
 * Applies schema migrations in order from the current user_version up to
 * CURRENT_SCHEMA_VERSION.
 *
 * Throws if the on-disk user_version is HIGHER than CURRENT_SCHEMA_VERSION —
 * this database was created by a newer build and must not be silently
 * downgraded.
 */
function runMigrations(db: DatabaseSync): void {
  const versionRow = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const version = versionRow?.user_version ?? 0;

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${version} is newer than the supported version ${CURRENT_SCHEMA_VERSION}. ` +
      "Deploy a matching build or migrate down manually.",
    );
  }

  let current = version;
  while (current < CURRENT_SCHEMA_VERSION) {
    current += 1;

    switch (current) {
      case 1:
        migrate_v1(db);
        break;
      case 2:
        migrate_v2(db);
        break;
      default:
        throw new Error(`No migration defined for schema version ${current}`);
    }
  }
}

/**
 * Migration v1 — initial schema.
 *
 * jobs table columns:
 *   id          TEXT  PK   — UUIDv4
 *   repo_url    TEXT  NOT NULL — validated canonical URL (no trailing .git)
 *   stage       TEXT  NOT NULL — current lifecycle stage
 *   status      TEXT  NOT NULL — lifecycle status
 *   token_hash  TEXT  NOT NULL — SHA-256 hex of the raw capability token
 *   created_at  TEXT  NOT NULL — ISO-8601 UTC timestamp
 *   updated_at  TEXT  NOT NULL — ISO-8601 UTC timestamp
 *
 * job_events table columns:
 *   seq         INTEGER PK AUTOINCREMENT — monotonic sequence for SSE replay
 *   job_id      TEXT NOT NULL — FK → jobs.id
 *   event_type  TEXT NOT NULL — e.g. "created"
 *   payload     TEXT NOT NULL — JSON string
 *   created_at  TEXT NOT NULL — ISO-8601 UTC timestamp
 */
function migrate_v1(db: DatabaseSync): void {
  // Wrap DDL + user_version bump in an explicit transaction for atomicity.
  // If any statement fails the transaction is rolled back so user_version
  // stays at 0 and the migration can be retried cleanly.
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id          TEXT NOT NULL PRIMARY KEY,
        repo_url    TEXT NOT NULL,
        stage       TEXT NOT NULL DEFAULT 'queued',
        status      TEXT NOT NULL DEFAULT 'queued',
        token_hash  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      ) STRICT
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS job_events (
        seq         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        job_id      TEXT    NOT NULL REFERENCES jobs(id),
        event_type  TEXT    NOT NULL,
        payload     TEXT    NOT NULL,
        created_at  TEXT    NOT NULL
      ) STRICT
    `);

    db.exec("PRAGMA user_version = 1");

    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback error */ }
    throw err;
  }
}

/**
 * Migration v2 — additive worker lease columns on `jobs`.
 *
 * Existing rows and events are untouched; defaults mean "never claimed".
 *   worker_id          TEXT    — last worker to claim (kept as evidence)
 *   lease_token        TEXT    — current fencing token; NULL when unleased/fenced
 *   lease_expires_at   TEXT    — ISO-8601 UTC lease expiry
 *   attempt_count      INTEGER — claims so far (never reset)
 *   max_attempts       INTEGER — claim budget (default 2)
 *   started_at         TEXT    — first claim time (never reset)
 *   deadline_at        TEXT    — first claim + 15 min (never reset)
 *   recovery_required  INTEGER — 1 after lease expiry until cleanup is confirmed
 *   recovery_token     TEXT    — fencing token required to confirm cleanup
 *   infra_error        TEXT    — JSON infrastructure metadata for terminal
 *                                failures (never a repository diagnosis)
 */
function migrate_v2(db: DatabaseSync): void {
  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE jobs ADD COLUMN worker_id TEXT");
    db.exec("ALTER TABLE jobs ADD COLUMN lease_token TEXT");
    db.exec("ALTER TABLE jobs ADD COLUMN lease_expires_at TEXT");
    db.exec("ALTER TABLE jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)");
    db.exec("ALTER TABLE jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts >= 1)");
    db.exec("ALTER TABLE jobs ADD COLUMN started_at TEXT");
    db.exec("ALTER TABLE jobs ADD COLUMN deadline_at TEXT");
    db.exec("ALTER TABLE jobs ADD COLUMN recovery_required INTEGER NOT NULL DEFAULT 0 CHECK (recovery_required IN (0, 1))");
    db.exec("ALTER TABLE jobs ADD COLUMN recovery_token TEXT");
    db.exec("ALTER TABLE jobs ADD COLUMN infra_error TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at)");

    db.exec("PRAGMA user_version = 2");
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback error */ }
    throw err;
  }
}

/**
 * Closes the database. Should be called in Fastify's onClose hook so that
 * test isolation is preserved (each test suite opens its own :memory: db).
 */
export function closeDatabase(db: DatabaseSync): void {
  db.close();
}
