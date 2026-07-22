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
