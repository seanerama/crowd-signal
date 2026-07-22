/**
 * Delta computation (stage 3): 24h/7d movement for one market, against OUR
 * OWN stored snapshots (system of record, ADR 0002).
 *
 * - d24: current price minus the latest snapshot at/before fetchedAt - 24h.
 *   "At/before" naturally absorbs gaps (a missed daily run falls back to the
 *   next-older row). Null when no history exists (market newly tracked).
 * - d7: same lookup at fetchedAt - 7d. When local history is younger than 7
 *   days, fall back to ONE candlestick close: first the long-TTL
 *   candlestick_cache table, then the optional async `candleLookup` (stage 5
 *   wires this to KalshiSource.fetchCandlesticks), whose result — including
 *   a null "no trades" answer — is cached so the lookup fires at most once
 *   per (market, period). Null when every source comes up empty.
 */
import type { Snapshot } from "../kalshi/types.js";
import type { SnapshotStore } from "./store.js";

const HOUR_MS = 3_600_000;
const H24_MS = 24 * HOUR_MS;
const D7_MS = 7 * 24 * HOUR_MS;

/**
 * One-shot candlestick fallback: resolve a ~7d-ago closing yes price (cents)
 * for a market ticker, or null when unavailable. Async so stage 5 can back it
 * with KalshiSource.fetchCandlesticks.
 */
export type CandleLookup = (ticker: string) => Promise<number | null>;

export interface Deltas {
  /** current - reference(24h ago), in cents; null when no reference exists. */
  d24: number | null;
  /** current - reference(7d ago), in cents; null when no reference exists. */
  d7: number | null;
}

export interface ComputeDeltasOptions {
  /** Optional 7d candlestick fallback (used only when local history < 7d). */
  candleLookup?: CandleLookup;
}

function minusMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) - ms).toISOString();
}

export async function computeDeltas(
  current: Snapshot,
  store: SnapshotStore,
  opts: ComputeDeltasOptions = {}
): Promise<Deltas> {
  const ref24 = store.latestBefore(current.ticker, minusMs(current.fetchedAt, H24_MS));
  const d24 = ref24 ? current.yesPriceCents - ref24.yesPriceCents : null;

  const target7 = minusMs(current.fetchedAt, D7_MS);
  const ref7 = store.latestBefore(current.ticker, target7);
  if (ref7) return { d24, d7: current.yesPriceCents - ref7.yesPriceCents };

  // Local history younger than 7d — candlestick fallback (cache first).
  const cached = store.cachedCandleClose(current.ticker, target7);
  if (cached !== undefined) {
    return { d24, d7: cached === null ? null : current.yesPriceCents - cached };
  }

  if (!opts.candleLookup) return { d24, d7: null };
  const close = await opts.candleLookup(current.ticker);
  store.cacheCandleClose({
    seriesTicker: current.seriesTicker,
    marketTicker: current.ticker,
    endPeriodIso: target7,
    yesPriceCloseCents: close,
    fetchedAtIso: current.fetchedAt
  });
  return { d24, d7: close === null ? null : current.yesPriceCents - close };
}
