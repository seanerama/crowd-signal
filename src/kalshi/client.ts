/**
 * Typed fetch wrapper for Kalshi's PUBLIC, unauthenticated API
 * (https://external-api.kalshi.com/trade-api/v2). No API key exists anywhere —
 * that is a security property to preserve, not an omission (project-des §7).
 *
 * Production manners built in: token-bucket rate limiting, request coalescing
 * (identical in-flight GETs share one promise), exponential backoff + full
 * jitter on 429/5xx/network errors with Retry-After precedence, and a
 * fail-open Result surface — nothing here ever throws through to callers.
 */
import type { KalshiConfig } from "../config.js";
import { DEFAULT_BACKOFF, retryDelayMs, type BackoffOptions } from "./backoff.js";
import { TokenBucket } from "./rateLimiter.js";
import {
  fail,
  type CandlestickParams,
  type CandlesticksResponse,
  type EventResponse,
  type EventsResponse,
  type KalshiLogger,
  type KalshiMetrics,
  type MarketResponse,
  type MarketsResponse,
  type Result,
  type SeriesListResponse
} from "./types.js";

// ---------------------------------------------------------------------------
// Module-level metrics: the 429 counter is a standing watch item (STATUS.md).
// ---------------------------------------------------------------------------

const metrics: KalshiMetrics = {
  requestsTotal: 0,
  rateLimited429: 0,
  backoffRetries: 0
};

export function getKalshiMetrics(): KalshiMetrics {
  return { ...metrics };
}

/** Test hook — resets the module-level counters. */
export function resetKalshiMetrics(): void {
  metrics.requestsTotal = 0;
  metrics.rateLimited429 = 0;
  metrics.backoffRetries = 0;
}

// ---------------------------------------------------------------------------

/** Test/injection knobs; production callers pass none of these. */
export interface KalshiClientOverrides {
  backoff?: Partial<BackoffOptions>;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Query = Record<string, string | number | boolean | undefined>;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class KalshiClient {
  private readonly config: KalshiConfig;
  private readonly logger: KalshiLogger;
  private readonly bucket: TokenBucket;
  private readonly backoff: BackoffOptions;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Identical in-flight GETs coalesce onto one upstream request. */
  private readonly inflight = new Map<string, Promise<Result<unknown>>>();

  constructor(
    config: KalshiConfig,
    logger: KalshiLogger,
    overrides: KalshiClientOverrides = {}
  ) {
    this.config = config;
    this.logger = logger;
    this.bucket = new TokenBucket({
      capacity: config.burst,
      refillPerSecond: config.rps,
      now: overrides.now
    });
    this.backoff = { ...DEFAULT_BACKOFF, ...overrides.backoff };
    this.fetchFn = overrides.fetchFn ?? fetch;
    this.sleep = overrides.sleep ?? defaultSleep;
    this.now = overrides.now ?? Date.now;
  }

  // ---- typed endpoints ----------------------------------------------------

  listSeries(params: { category?: string } = {}): Promise<Result<SeriesListResponse>> {
    return this.getJson<SeriesListResponse>("/series", {
      category: params.category
    });
  }

  listEvents(
    params: { seriesTicker?: string; status?: string; cursor?: string; limit?: number } = {}
  ): Promise<Result<EventsResponse>> {
    return this.getJson<EventsResponse>("/events", {
      series_ticker: params.seriesTicker,
      status: params.status,
      cursor: params.cursor,
      limit: params.limit
    });
  }

  getEvent(eventTicker: string): Promise<Result<EventResponse>> {
    return this.getJson<EventResponse>(
      `/events/${encodeURIComponent(eventTicker)}`,
      { with_nested_markets: true }
    );
  }

  listMarkets(
    params: {
      seriesTicker?: string;
      eventTicker?: string;
      status?: string;
      cursor?: string;
      limit?: number;
    } = {}
  ): Promise<Result<MarketsResponse>> {
    return this.getJson<MarketsResponse>("/markets", {
      series_ticker: params.seriesTicker,
      event_ticker: params.eventTicker,
      status: params.status,
      cursor: params.cursor,
      limit: params.limit
    });
  }

  getMarket(ticker: string): Promise<Result<MarketResponse>> {
    return this.getJson<MarketResponse>(
      `/markets/${encodeURIComponent(ticker)}`
    );
  }

  getCandlesticks(
    seriesTicker: string,
    marketTicker: string,
    params: CandlestickParams
  ): Promise<Result<CandlesticksResponse>> {
    return this.getJson<CandlesticksResponse>(
      `/series/${encodeURIComponent(seriesTicker)}/markets/${encodeURIComponent(marketTicker)}/candlesticks`,
      {
        period_interval: params.periodIntervalMinutes,
        start_ts: params.startTs,
        end_ts: params.endTs
      }
    );
  }

  // ---- transport ----------------------------------------------------------

  /** Coalescing entry point: identical concurrent GETs share one promise. */
  getJson<T>(path: string, query: Query = {}): Promise<Result<T>> {
    const url = this.buildUrl(path, query);
    const existing = this.inflight.get(url);
    if (existing) return existing as Promise<Result<T>>;

    const promise = this.requestWithRetries<T>(url).finally(() => {
      this.inflight.delete(url);
    });
    this.inflight.set(url, promise as Promise<Result<unknown>>);
    return promise;
  }

  private buildUrl(path: string, query: Query): string {
    const url = new URL(this.config.apiBase.replace(/\/$/, "") + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async requestWithRetries<T>(url: string): Promise<Result<T>> {
    const { maxAttempts } = this.config;
    let lastFailure: Result<T> = fail("no attempt made", true);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.bucket.acquire();
      metrics.requestsTotal += 1;

      let res: Response;
      try {
        res = await this.fetchFn(url, {
          headers: { accept: "application/json" }
        });
      } catch (err) {
        lastFailure = fail(
          `network error: ${err instanceof Error ? err.message : String(err)}`,
          true
        );
        if (attempt + 1 < maxAttempts) await this.retryPause(attempt, null);
        continue;
      }

      if (res.ok) {
        try {
          return { ok: true, value: (await res.json()) as T };
        } catch {
          return fail("invalid JSON in response body", false);
        }
      }

      const retryAfter = res.headers.get("retry-after");
      if (res.status === 429) {
        metrics.rateLimited429 += 1;
        this.logger.warn(
          { url, status: 429, rateLimited429: metrics.rateLimited429 },
          "kalshi rate limited (429)"
        );
        lastFailure = fail("rate limited (429)", true);
      } else if (res.status >= 500) {
        lastFailure = fail(`upstream error (${res.status})`, true);
      } else {
        // Other 4xx: not transient — do not retry.
        return fail(`http ${res.status}`, false);
      }

      if (attempt + 1 < maxAttempts) await this.retryPause(attempt, retryAfter);
    }

    return lastFailure;
  }

  private async retryPause(
    attempt: number,
    retryAfterHeader: string | null
  ): Promise<void> {
    metrics.backoffRetries += 1;
    const delay = retryDelayMs(attempt, retryAfterHeader, this.backoff, this.now);
    if (delay > 0) await this.sleep(delay);
  }
}
