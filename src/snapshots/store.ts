/**
 * SnapshotStore (stage 3) — implements the FROZEN contracts/snapshot.md v1.
 *
 * The snapshot table is the system of record for deltas (ADR 0002): 24h/7d
 * movement is computed against our own prior rows, never re-fetched history,
 * so every newsletter is reproducible from local state.
 *
 * Persistence choices (documented per spec):
 * - Idempotency: `INSERT ... ON CONFLICT (ticker, fetched_at) DO NOTHING` —
 *   a re-save of the same (ticker, fetchedAt) is a silent no-op. A snapshot
 *   for a given instant never changes, so first-write-wins is the honest
 *   semantics and re-running a partial daily run is always safe.
 * - `run_id` column: additive provenance extra beyond the contract fields
 *   (the contract allows additive change). It records which run wrote the
 *   row; it is NOT part of the Snapshot shape and is never read back into it.
 */
import type { Db } from "../db.js";
import type { Snapshot } from "../kalshi/types.js";

/** snapshots row, snake_case as stored (run_id omitted from reads). */
interface SnapshotRow {
  ticker: string;
  event_ticker: string;
  series_ticker: string | null;
  title: string;
  event_title: string;
  market_url: string;
  yes_price_cents: number;
  volume: number;
  open_interest: number | null;
  close_time: string;
  status: string;
  settlement: string | null;
  fetched_at: string;
  stale: number;
}

interface CandleCacheRow {
  yes_price_close_cents: number | null;
}

const SNAPSHOT_COLUMNS = `
  ticker, event_ticker, series_ticker, title, event_title, market_url,
  yes_price_cents, volume, open_interest, close_time, status, settlement,
  fetched_at, stale
`;

/** Row -> contract Snapshot (snake_case -> camelCase, stale 0/1 -> boolean). */
export function rowToSnapshot(row: SnapshotRow): Snapshot {
  return {
    ticker: row.ticker,
    eventTicker: row.event_ticker,
    seriesTicker: row.series_ticker,
    title: row.title,
    eventTitle: row.event_title,
    marketUrl: row.market_url,
    yesPriceCents: row.yes_price_cents,
    volume: row.volume,
    openInterest: row.open_interest,
    closeTime: row.close_time,
    status: row.status as Snapshot["status"],
    settlement: row.settlement as Snapshot["settlement"],
    fetchedAt: row.fetched_at,
    stale: row.stale !== 0
  };
}

/**
 * Stale handling (§3.1 fail-open): serve the last-known snapshot flagged
 * stale, PRESERVING its original `fetchedAt` — the honest "as of" stamp.
 */
export function markStale(snapshot: Snapshot): Snapshot {
  return { ...snapshot, stale: true };
}

export class SnapshotStore {
  private readonly insert;
  private readonly selectLatestBefore;
  private readonly selectLatest;
  private readonly selectCachedCandle;
  private readonly insertCachedCandle;
  private readonly saveMany;

  constructor(db: Db) {
    this.insert = db.prepare(`
      INSERT INTO snapshots (${SNAPSHOT_COLUMNS}, run_id)
      VALUES (
        @ticker, @event_ticker, @series_ticker, @title, @event_title,
        @market_url, @yes_price_cents, @volume, @open_interest, @close_time,
        @status, @settlement, @fetched_at, @stale, @run_id
      )
      ON CONFLICT (ticker, fetched_at) DO NOTHING
    `);
    this.selectLatestBefore = db.prepare(`
      SELECT ${SNAPSHOT_COLUMNS} FROM snapshots
      WHERE ticker = ? AND fetched_at <= ?
      ORDER BY fetched_at DESC LIMIT 1
    `);
    this.selectLatest = db.prepare(`
      SELECT ${SNAPSHOT_COLUMNS} FROM snapshots
      WHERE ticker = ?
      ORDER BY fetched_at DESC LIMIT 1
    `);
    this.selectCachedCandle = db.prepare(`
      SELECT yes_price_close_cents FROM candlestick_cache
      WHERE market_ticker = ? AND end_period <= ?
      ORDER BY end_period DESC LIMIT 1
    `);
    this.insertCachedCandle = db.prepare(`
      INSERT INTO candlestick_cache
        (series_ticker, market_ticker, end_period, yes_price_close_cents,
         volume, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (market_ticker, end_period) DO NOTHING
    `);
    this.saveMany = db.transaction(
      (runId: string, snapshots: readonly Snapshot[]) => {
        for (const s of snapshots) {
          this.insert.run({
            ticker: s.ticker,
            event_ticker: s.eventTicker,
            series_ticker: s.seriesTicker,
            title: s.title,
            event_title: s.eventTitle,
            market_url: s.marketUrl,
            yes_price_cents: s.yesPriceCents,
            volume: s.volume,
            open_interest: s.openInterest,
            close_time: s.closeTime,
            status: s.status,
            settlement: s.settlement,
            fetched_at: s.fetchedAt,
            stale: s.stale ? 1 : 0,
            run_id: runId
          });
        }
      }
    );
  }

  /** Persist one run's snapshots. Idempotent on (ticker, fetchedAt). */
  saveSnapshots(runId: string, snapshots: readonly Snapshot[]): void {
    this.saveMany(runId, snapshots);
  }

  /** Latest snapshot at or before `timestampIso` (delta reference lookup). */
  latestBefore(ticker: string, timestampIso: string): Snapshot | null {
    const row = this.selectLatestBefore.get(ticker, timestampIso) as
      | SnapshotRow
      | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  /** Newest-per-ticker snapshots for the given markets (misses omitted). */
  latestForMarkets(tickers: readonly string[]): Snapshot[] {
    const out: Snapshot[] = [];
    for (const ticker of tickers) {
      const snapshot = this.latestKnown(ticker);
      if (snapshot) out.push(snapshot);
    }
    return out;
  }

  /** Newest row regardless of timestamp (stale-serving convenience). */
  latestKnown(ticker: string): Snapshot | null {
    const row = this.selectLatest.get(ticker) as SnapshotRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  // ---- candlestick cache (long-TTL 7d-backfill; NOT contract shape) --------

  /**
   * Cached candlestick close at/before `endPeriodIso`. Distinguishes a cache
   * MISS (undefined) from a cached "no trades that period" (null close).
   */
  cachedCandleClose(
    marketTicker: string,
    endPeriodIso: string
  ): number | null | undefined {
    const row = this.selectCachedCandle.get(marketTicker, endPeriodIso) as
      | CandleCacheRow
      | undefined;
    return row ? row.yes_price_close_cents : undefined;
  }

  /** Cache a candlestick close (null close = negative-cached "no trades"). */
  cacheCandleClose(params: {
    seriesTicker: string | null;
    marketTicker: string;
    endPeriodIso: string;
    yesPriceCloseCents: number | null;
    volume?: number;
    fetchedAtIso?: string;
  }): void {
    this.insertCachedCandle.run(
      params.seriesTicker,
      params.marketTicker,
      params.endPeriodIso,
      params.yesPriceCloseCents,
      params.volume ?? 0,
      params.fetchedAtIso ?? new Date().toISOString()
    );
  }
}
