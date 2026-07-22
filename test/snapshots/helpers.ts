import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../../src/db.js";
import type { Snapshot } from "../../src/kalshi/types.js";

export interface TempDb {
  db: Db;
  cleanup: () => void;
}

export function openTempDb(): TempDb {
  const dataDir = mkdtempSync(join(tmpdir(), "crowd-signal-snap-test-"));
  const db = openDb(dataDir);
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

/** Full-literal contract fixture; override per test. */
export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    ticker: "KXFED-26JUL-CUT",
    eventTicker: "KXFED-26JUL",
    seriesTicker: "KXFED",
    title: "Rate cut in July?",
    eventTitle: "Fed decision, July 2026",
    marketUrl: "https://kalshi.com/markets/kxfed/KXFED-26JUL",
    yesPriceCents: 62,
    volume: 123456,
    openInterest: 7890,
    closeTime: "2026-07-29T18:00:00.000Z",
    status: "open",
    settlement: null,
    fetchedAt: "2026-07-22T12:00:00.000Z",
    stale: false,
    ...overrides
  };
}
