/**
 * KalshiSource factory (stage 2) — consumed by stages 3/5/6/7.
 *
 * Kill-switch: when KALSHI_ENABLED is OFF (the default), the factory returns a
 * dark implementation whose methods return
 * { ok:false, reason:"kalshi disabled", retriable:false }. Nothing is wired
 * into routes in this stage.
 */
import type { Config } from "../config.js";
import {
  getKalshiMetrics,
  KalshiClient,
  type KalshiClientOverrides
} from "./client.js";
import { dollarsToCents, fpToInt, normalizeMarket } from "./normalize.js";
import {
  fail,
  type Candle,
  type CandlestickParams,
  type KalshiLogger,
  type KalshiMetrics,
  type KalshiSource,
  type RawEvent,
  type RawMarket,
  type Result,
  type SeriesInfo,
  type Snapshot,
  type SubscriptionRef
} from "./types.js";

export { getKalshiMetrics, resetKalshiMetrics, KalshiClient } from "./client.js";
export { normalizeMarket } from "./normalize.js";
export * from "./types.js";

/** Cursor-pagination guard: absorb churn without unbounded crawling. */
const MAX_PAGES = 10;

/**
 * Candlestick close in cents: current-shape trade close (price.close_dollars),
 * else bid/ask close midpoint (*_dollars), else legacy integer price.close,
 * else null ("no trades that period").
 */
function candleCloseCents(c: import("./types.js").RawCandlestick): number | null {
  const trade = dollarsToCents(c.price?.close_dollars);
  if (trade !== null && trade > 0) return trade;
  const bid = dollarsToCents(c.yes_bid?.close_dollars);
  const ask = dollarsToCents(c.yes_ask?.close_dollars);
  if (bid !== null && ask !== null && bid + ask > 0) {
    return Math.round((bid + ask) / 2);
  }
  return c.price?.close ?? null;
}
const PAGE_LIMIT = 200;

const DISABLED = "kalshi disabled";

function darkSource(): KalshiSource {
  const dark = <T>(): Promise<Result<T>> =>
    Promise.resolve(fail(DISABLED, false));
  return {
    resolveSubscription: () => dark<Snapshot[]>(),
    fetchSnapshots: () => dark<Snapshot[]>(),
    listSeries: () => dark<SeriesInfo[]>(),
    fetchCandlesticks: () => dark<Candle[]>(),
    getMetrics: (): KalshiMetrics => ({
      requestsTotal: 0,
      rateLimited429: 0,
      backoffRetries: 0
    })
  };
}

class LiveKalshiSource implements KalshiSource {
  constructor(
    private readonly client: KalshiClient,
    private readonly now: () => number
  ) {}

  private fetchedAt(): string {
    return new Date(this.now()).toISOString();
  }

  // ---- subscription resolution: the churn-absorbing lookup (§2) -----------

  async resolveSubscription(ref: SubscriptionRef): Promise<Result<Snapshot[]>> {
    if (ref.kind === "series") return this.resolveSeries(ref.ticker);
    return this.resolveEvent(ref.ticker);
  }

  private async resolveSeries(seriesTicker: string): Promise<Result<Snapshot[]>> {
    const markets = await this.pagedMarkets({ seriesTicker, status: "open" });
    if (!markets.ok) return markets;

    // Titles come from the series' events; on failure fall back to the event
    // ticker rather than failing the whole resolution (fail-open).
    const titles = new Map<string, string>();
    const events = await this.pagedEvents(seriesTicker);
    if (events.ok) {
      for (const ev of events.value) titles.set(ev.event_ticker, ev.title);
    }

    const fetchedAt = this.fetchedAt();
    const snapshots = markets.value.map((m) =>
      normalizeMarket(m, {
        eventTitle: titles.get(m.event_ticker) ?? m.event_ticker,
        seriesTicker,
        fetchedAt
      })
    );
    return { ok: true, value: snapshots };
  }

  private async resolveEvent(eventTicker: string): Promise<Result<Snapshot[]>> {
    const res = await this.client.getEvent(eventTicker);
    if (!res.ok) return res;
    const { event } = res.value;
    let markets = res.value.markets;
    if (!markets) {
      const listed = await this.pagedMarkets({ eventTicker, status: "open" });
      if (!listed.ok) return listed;
      markets = listed.value;
    }

    const fetchedAt = this.fetchedAt();
    const snapshots = markets
      .filter((m) => {
        const s = m.status.toLowerCase();
        return s === "open" || s === "active";
      })
      .map((m) =>
        normalizeMarket(m, {
          eventTitle: event.title,
          seriesTicker: event.series_ticker || null,
          fetchedAt
        })
      );
    return { ok: true, value: snapshots };
  }

  private async pagedMarkets(params: {
    seriesTicker?: string;
    eventTicker?: string;
    status?: string;
  }): Promise<Result<RawMarket[]>> {
    const all: RawMarket[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.client.listMarkets({
        ...params,
        cursor,
        limit: PAGE_LIMIT
      });
      if (!res.ok) return res;
      all.push(...res.value.markets);
      cursor = res.value.cursor || undefined;
      if (!cursor) break;
    }
    return { ok: true, value: all };
  }

  private async pagedEvents(seriesTicker: string): Promise<Result<RawEvent[]>> {
    const all: RawEvent[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.client.listEvents({
        seriesTicker,
        cursor,
        limit: PAGE_LIMIT
      });
      if (!res.ok) return res;
      all.push(...res.value.events);
      cursor = res.value.cursor || undefined;
      if (!cursor) break;
    }
    return { ok: true, value: all };
  }

  // ---- per-ticker snapshots ----------------------------------------------

  async fetchSnapshots(tickers: readonly string[]): Promise<Result<Snapshot[]>> {
    if (tickers.length === 0) return { ok: true, value: [] };

    const results = await Promise.all(
      [...new Set(tickers)].map((t) => this.client.getMarket(t))
    );
    const raws: RawMarket[] = [];
    let firstFailure: Result<Snapshot[]> | null = null;
    for (const res of results) {
      if (res.ok) raws.push(res.value.market);
      else firstFailure ??= res;
    }
    if (raws.length === 0 && firstFailure) return firstFailure;

    // Parent event titles/series, deduped and coalesced; fail-open per event.
    const parents = new Map<string, { title: string; seriesTicker: string | null }>();
    await Promise.all(
      [...new Set(raws.map((m) => m.event_ticker))].map(async (eventTicker) => {
        const res = await this.client.getEvent(eventTicker);
        parents.set(
          eventTicker,
          res.ok
            ? {
                title: res.value.event.title,
                seriesTicker: res.value.event.series_ticker || null
              }
            : { title: eventTicker, seriesTicker: null }
        );
      })
    );

    const fetchedAt = this.fetchedAt();
    const snapshots = raws.map((m) => {
      const parent = parents.get(m.event_ticker);
      return normalizeMarket(m, {
        eventTitle: parent?.title ?? m.event_ticker,
        seriesTicker: parent?.seriesTicker ?? null,
        fetchedAt
      });
    });
    return { ok: true, value: snapshots };
  }

  // ---- catalog & candlesticks --------------------------------------------

  async listSeries(params: { category?: string } = {}): Promise<Result<SeriesInfo[]>> {
    const res = await this.client.listSeries(params);
    if (!res.ok) return res;
    return {
      ok: true,
      value: res.value.series.map((s) => ({
        seriesTicker: s.ticker,
        title: s.title,
        category: s.category ?? null,
        frequency: s.frequency ?? null
      }))
    };
  }

  async fetchCandlesticks(
    seriesTicker: string,
    marketTicker: string,
    params: CandlestickParams
  ): Promise<Result<Candle[]>> {
    const res = await this.client.getCandlesticks(seriesTicker, marketTicker, params);
    if (!res.ok) return res;
    return {
      ok: true,
      value: res.value.candlesticks.map((c) => ({
        endPeriod: new Date(c.end_period_ts * 1000).toISOString(),
        yesPriceCloseCents: candleCloseCents(c),
        volume: fpToInt(c.volume_fp) ?? c.volume ?? 0,
        openInterest: fpToInt(c.open_interest_fp) ?? c.open_interest ?? null
      }))
    };
  }

  getMetrics(): KalshiMetrics {
    return getKalshiMetrics();
  }
}

/**
 * Build the KalshiSource. `overrides` is a test-only injection surface
 * (mock clocks, tiny backoff, stub fetch); production callers omit it.
 */
export function createKalshiSource(
  config: Config,
  logger: KalshiLogger,
  overrides: KalshiClientOverrides = {}
): KalshiSource {
  if (!config.flags.KALSHI_ENABLED) return darkSource();
  const client = new KalshiClient(config.kalshi, logger, overrides);
  return new LiveKalshiSource(client, overrides.now ?? Date.now);
}
