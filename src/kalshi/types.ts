/**
 * KalshiSource types (stage 2).
 *
 * `Snapshot` mirrors the FROZEN field shapes in contracts/snapshot.md v1 —
 * the raw-to-contract mapping lives in normalize.ts and only there.
 * Every public method is fail-open: it returns a typed `Result`, never throws
 * through to callers.
 */

/** Fail-open result surface. */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; retriable: boolean };

export function fail(reason: string, retriable: boolean): {
  ok: false;
  reason: string;
  retriable: boolean;
} {
  return { ok: false, reason, retriable };
}

/** contracts/snapshot.md v1 (frozen) — normalization TARGET shape. */
export interface Snapshot {
  ticker: string;
  eventTicker: string;
  seriesTicker: string | null;
  title: string;
  eventTitle: string;
  marketUrl: string;
  yesPriceCents: number;
  volume: number;
  openInterest: number | null;
  closeTime: string;
  status: "open" | "closed" | "settled";
  settlement: "yes" | "no" | null;
  fetchedAt: string;
  stale: boolean;
}

/** A subscription reference — the churn-absorbing lookup key (project-des §2). */
export interface SubscriptionRef {
  kind: "series" | "event";
  ticker: string;
}

/** Normalized candlestick (weekly-delta column). NOT a frozen contract. */
export interface Candle {
  /** End of period, ISO-8601. */
  endPeriod: string;
  /** Closing yes price in cents, null when the period had no trades. */
  yesPriceCloseCents: number | null;
  volume: number;
  openInterest: number | null;
}

export interface CandlestickParams {
  /** Period length in minutes (Kalshi accepts 1, 60, 1440). */
  periodIntervalMinutes: number;
  /** Unix seconds, inclusive range. */
  startTs: number;
  endTs: number;
}

/** Catalog entry from GET /series. Raw-ish but typed; not a frozen contract. */
export interface SeriesInfo {
  seriesTicker: string;
  title: string;
  category: string | null;
  frequency: string | null;
}

export interface KalshiMetrics {
  requestsTotal: number;
  rateLimited429: number;
  backoffRetries: number;
}

/** Minimal structural logger — Fastify's pino logger satisfies this. */
export interface KalshiLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * The KalshiSource interface consumed by stages 3/5/6/7:
 * fetch snapshots, resolve subscriptions, fetch catalog, candlesticks.
 */
export interface KalshiSource {
  /** Resolve a series/event subscription to its CURRENT open markets. */
  resolveSubscription(ref: SubscriptionRef): Promise<Result<Snapshot[]>>;
  /**
   * Fetch current snapshots for specific market tickers. Tickers that fail
   * individually are omitted (fail-open); ok:false only when nothing succeeded.
   */
  fetchSnapshots(tickers: readonly string[]): Promise<Result<Snapshot[]>>;
  /** Catalog: list series, optionally by category. */
  listSeries(params?: { category?: string }): Promise<Result<SeriesInfo[]>>;
  /** Candlesticks for one market (weekly delta; cached upstream, stage 6). */
  fetchCandlesticks(
    seriesTicker: string,
    marketTicker: string,
    params: CandlestickParams
  ): Promise<Result<Candle[]>>;
  getMetrics(): KalshiMetrics;
}

// ---------------------------------------------------------------------------
// Raw wire shapes (documented public-API response shapes). Fields we do not
// consume are omitted; extra fields on the wire are ignored by design.
// ---------------------------------------------------------------------------

export interface RawMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  status: string;
  yes_bid?: number;
  yes_ask?: number;
  last_price?: number;
  volume?: number;
  open_interest?: number | null;
  close_time: string;
  result?: string;
}

export interface RawEvent {
  event_ticker: string;
  series_ticker?: string | null;
  title: string;
}

export interface RawSeries {
  ticker: string;
  title: string;
  category?: string | null;
  frequency?: string | null;
}

export interface RawCandlestick {
  end_period_ts: number;
  price?: { close?: number | null };
  volume?: number;
  open_interest?: number | null;
}

export interface MarketsResponse {
  markets: RawMarket[];
  cursor?: string;
}

export interface EventsResponse {
  events: RawEvent[];
  cursor?: string;
}

export interface EventResponse {
  event: RawEvent;
  markets?: RawMarket[];
}

export interface MarketResponse {
  market: RawMarket;
}

export interface SeriesListResponse {
  series: RawSeries[];
}

export interface CandlesticksResponse {
  candlesticks: RawCandlestick[];
}
