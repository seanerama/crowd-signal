/**
 * SQLite layer (ADR 0002): better-sqlite3 against <DATA_DIR>/pulse.db with an
 * additive-only migration runner. Rollback to an older image must always be
 * safe against a newer schema, so migrations only ever ADD things.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type Db = Database.Database;

interface Migration {
  id: string;
  sql: string;
}

/** Additive-only. Never edit an applied migration — append a new one. */
const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001-create-runs",
    sql: `
      CREATE TABLE IF NOT EXISTS runs (
        run_id      TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        day         TEXT NOT NULL,
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        status      TEXT NOT NULL DEFAULT 'running'
      );
      CREATE INDEX IF NOT EXISTS idx_runs_kind_day ON runs (kind, day);
    `
  },
  {
    id: "0002-profiles-subscriptions-admin-sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS profiles (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        description    TEXT NOT NULL DEFAULT '',
        recipients     TEXT NOT NULL DEFAULT '[]',
        hygiene_config TEXT NOT NULL DEFAULT '{}',
        active         INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id         TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles (id),
        ticker     TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('series', 'event')),
        added_at   TEXT NOT NULL,
        UNIQUE (profile_id, ticker, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_subscriptions_profile
        ON subscriptions (profile_id);
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `
  },
  {
    id: "0003-snapshots-candlestick-cache",
    sql: `
      CREATE TABLE IF NOT EXISTS snapshots (
        ticker          TEXT    NOT NULL,
        event_ticker    TEXT    NOT NULL,
        series_ticker   TEXT,
        title           TEXT    NOT NULL,
        event_title     TEXT    NOT NULL,
        market_url      TEXT    NOT NULL,
        yes_price_cents INTEGER NOT NULL,
        volume          INTEGER NOT NULL,
        open_interest   INTEGER,
        close_time      TEXT    NOT NULL,
        status          TEXT    NOT NULL,
        settlement      TEXT,
        fetched_at      TEXT    NOT NULL,
        stale           INTEGER NOT NULL DEFAULT 0,
        run_id          TEXT,
        UNIQUE (ticker, fetched_at)
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_ticker_fetched_at
        ON snapshots (ticker, fetched_at DESC);
      CREATE TABLE IF NOT EXISTS candlestick_cache (
        series_ticker         TEXT,
        market_ticker         TEXT    NOT NULL,
        end_period            TEXT    NOT NULL,
        yes_price_close_cents INTEGER,
        volume                INTEGER NOT NULL DEFAULT 0,
        fetched_at            TEXT    NOT NULL,
        UNIQUE (market_ticker, end_period)
      );
    `
  },
  {
    id: "0004-profile-resolutions",
    sql: `
      CREATE TABLE IF NOT EXISTS profile_resolutions (
        profile_id  TEXT NOT NULL,
        run_id      TEXT NOT NULL,
        ticker      TEXT NOT NULL,
        resolved_at TEXT NOT NULL,
        UNIQUE (profile_id, run_id, ticker)
      );
      CREATE INDEX IF NOT EXISTS idx_profile_resolutions_profile
        ON profile_resolutions (profile_id, resolved_at DESC);
    `
  }
];

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "pulse.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    (db.prepare("SELECT id FROM migrations").all() as { id: string }[]).map(
      (r) => r.id
    )
  );
  const record = db.prepare(
    "INSERT INTO migrations (id, applied_at) VALUES (?, ?)"
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.id, new Date().toISOString());
    })();
  }
}

/** Real DB health: the connection answers and the migration table exists. */
export function checkDb(db: Db): boolean {
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'migrations'"
      )
      .get() as { n: number };
    return row.n === 1;
  } catch {
    return false;
  }
}
