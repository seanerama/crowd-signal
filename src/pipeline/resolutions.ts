/**
 * Per-profile resolution persistence (migration 0004-profile-resolutions):
 * each daily run records which market tickers a profile's subscriptions
 * resolved to. The NEXT run reads the latest resolution to (a) detect markets
 * that closed/settled since the last brief and (b) serve last-known data when
 * Kalshi is unreachable. Closed markets are surfaced once, then dropped —
 * they are simply absent from the new resolution set.
 */
import type { Db } from "../db.js";

/**
 * Sentinel ticker recording an EMPTY resolution (all markets closed): the
 * resolution event must still be persisted, or yesterday's closed markets
 * would re-surface every day. Real tickers are never empty strings.
 */
const EMPTY_RESOLUTION = "";

/** Tickers from the profile's most recent persisted resolution. */
export function previousResolvedTickers(db: Db, profileId: string): string[] {
  const rows = db
    .prepare(
      `SELECT ticker FROM profile_resolutions
       WHERE profile_id = ?
         AND run_id = (
           SELECT run_id FROM profile_resolutions
           WHERE profile_id = ? ORDER BY resolved_at DESC LIMIT 1
         )
       ORDER BY ticker`
    )
    .all(profileId, profileId) as { ticker: string }[];
  return rows.map((r) => r.ticker).filter((t) => t !== EMPTY_RESOLUTION);
}

/** Persist this run's resolved ticker set for the profile. */
export function saveResolution(
  db: Db,
  profileId: string,
  runId: string,
  tickers: readonly string[],
  resolvedAt: string
): void {
  const insert = db.prepare(
    `INSERT INTO profile_resolutions (profile_id, run_id, ticker, resolved_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (profile_id, run_id, ticker) DO NOTHING`
  );
  const insertAll = db.transaction(() => {
    const rows = tickers.length > 0 ? tickers : [EMPTY_RESOLUTION];
    for (const ticker of rows) {
      insert.run(profileId, runId, ticker, resolvedAt);
    }
  });
  insertAll();
}
