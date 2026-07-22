/**
 * Integration: KalshiClient / KalshiSource against a local HTTP mock server
 * (port 0, no live network). Asserts limiter + backoff + 429 counter behavior
 * on 429/500 sequences and the happy-path series resolution.
 */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import {
  createKalshiSource,
  resetKalshiMetrics,
  getKalshiMetrics,
  KalshiClient
} from "../../src/kalshi/index.js";
import type { KalshiLogger } from "../../src/kalshi/types.js";

interface PlannedResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/kalshi/${name}`, import.meta.url), "utf8")
  );
}

let server: Server;
let baseUrl: string;
let route: (url: URL) => PlannedResponse;
let hits: URL[];

const warns: unknown[][] = [];
const logger: KalshiLogger = {
  info() {},
  warn(...args: unknown[]) {
    warns.push(args);
  },
  error() {}
};

/** Tiny jittered backoff so retries are near-instant in tests. */
const FAST_BACKOFF = { backoff: { baseMs: 1, capMs: 5 } };

function testConfig(apiBase: string, extra: Record<string, string> = {}): Config {
  return loadConfig({
    TRIGGER_API_TOKEN: "t",
    KALSHI_ENABLED: "true",
    KALSHI_API_BASE: apiBase,
    KALSHI_RPS: "1000",
    KALSHI_BURST: "1000",
    ...extra
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", baseUrl);
    hits.push(url);
    const planned = route(url);
    res.writeHead(planned.status, {
      "content-type": "application/json",
      ...planned.headers
    });
    res.end(JSON.stringify(planned.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

beforeEach(() => {
  resetKalshiMetrics();
  hits = [];
  warns.length = 0;
  route = () => ({ status: 404, body: { error: "no route planned" } });
});

describe("429 handling: limiter + backoff + counter", () => {
  it("429 then success -> ok:true, counters increment, warn logged", async () => {
    route = (url) => {
      if (!url.pathname.endsWith("/markets/KXHIGHNY-26JUL22-B87")) {
        return { status: 404 };
      }
      return hits.length === 1
        ? { status: 429, headers: { "retry-after": "0" }, body: { error: "rate limited" } }
        : { status: 200, body: fixture("market-open.json") };
    };

    const client = new KalshiClient(
      testConfig(baseUrl).kalshi,
      logger,
      FAST_BACKOFF
    );
    const res = await client.getMarket("KXHIGHNY-26JUL22-B87");
    expect(res.ok).toBe(true);
    expect(hits).toHaveLength(2);
    expect(getKalshiMetrics()).toEqual({
      requestsTotal: 2,
      rateLimited429: 1,
      backoffRetries: 1
    });
    expect(warns.some((w) => w[1] === "kalshi rate limited (429)")).toBe(true);
  });

  it("500 then success -> ok:true after one backoff retry", async () => {
    route = () =>
      hits.length === 1
        ? { status: 500, body: { error: "boom" } }
        : { status: 200, body: fixture("market-open.json") };

    const client = new KalshiClient(
      testConfig(baseUrl).kalshi,
      logger,
      FAST_BACKOFF
    );
    const res = await client.getMarket("KXHIGHNY-26JUL22-B87");
    expect(res.ok).toBe(true);
    expect(hits).toHaveLength(2);
    expect(getKalshiMetrics()).toEqual({
      requestsTotal: 2,
      rateLimited429: 0,
      backoffRetries: 1
    });
  });

  it("persistent 429 -> ok:false retriable after max attempts", async () => {
    route = () => ({
      status: 429,
      headers: { "retry-after": "0" },
      body: { error: "rate limited" }
    });
    const client = new KalshiClient(
      testConfig(baseUrl, { KALSHI_MAX_ATTEMPTS: "3" }).kalshi,
      logger,
      FAST_BACKOFF
    );
    const res = await client.getMarket("X");
    expect(res).toEqual({ ok: false, reason: "rate limited (429)", retriable: true });
    expect(hits).toHaveLength(3);
    expect(getKalshiMetrics().rateLimited429).toBe(3);
  });

  it("token bucket spaces requests once the burst is drained", async () => {
    route = () => ({ status: 200, body: fixture("market-open.json") });
    // burst 2, then 50 rps -> 3rd request must wait ~20ms for a token.
    const config = testConfig(baseUrl, { KALSHI_RPS: "50", KALSHI_BURST: "2" });
    const client = new KalshiClient(config.kalshi, logger, FAST_BACKOFF);

    const started = Date.now();
    await Promise.all([
      client.getMarket("A"),
      client.getMarket("B"),
      client.getMarket("C")
    ]);
    const elapsed = Date.now() - started;
    expect(hits).toHaveLength(3);
    expect(elapsed).toBeGreaterThanOrEqual(15);
  });
});

describe("network failure", () => {
  it("connection refused -> ok:false retriable:true after max attempts", async () => {
    // A server we open then close: the port is real but nothing listens.
    const dead = createServer(() => {});
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const { port } = dead.address() as AddressInfo;
    await new Promise<void>((r, j) => dead.close((e) => (e ? j(e) : r())));

    const client = new KalshiClient(
      testConfig(`http://127.0.0.1:${port}`, { KALSHI_MAX_ATTEMPTS: "2" }).kalshi,
      logger,
      FAST_BACKOFF
    );
    const res = await client.getMarket("X");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.retriable).toBe(true);
      expect(res.reason).toMatch(/network error/);
    }
    expect(getKalshiMetrics().requestsTotal).toBe(2);
    expect(getKalshiMetrics().backoffRetries).toBe(1);
  });
});

describe("KalshiSource end-to-end against the mock server", () => {
  it("happy-path series resolution -> normalized open markets with event titles", async () => {
    route = (url) => {
      if (url.pathname.endsWith("/markets")) {
        expect(url.searchParams.get("series_ticker")).toBe("KXHIGHNY");
        expect(url.searchParams.get("status")).toBe("open");
        return { status: 200, body: fixture("markets-series.json") };
      }
      if (url.pathname.endsWith("/events")) {
        expect(url.searchParams.get("series_ticker")).toBe("KXHIGHNY");
        return { status: 200, body: fixture("events-series.json") };
      }
      return { status: 404 };
    };

    const source = createKalshiSource(testConfig(baseUrl), logger, FAST_BACKOFF);
    const res = await source.resolveSubscription({
      kind: "series",
      ticker: "KXHIGHNY"
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value).toHaveLength(3);
    const first = res.value[0]!;
    expect(first).toEqual({
      ticker: "KXHIGHNY-26JUL22-B87",
      eventTicker: "KXHIGHNY-26JUL22",
      seriesTicker: "KXHIGHNY",
      title: "Will the high temp in NYC be 87-88°F on Jul 22, 2026?",
      eventTitle: "Highest temperature in NYC on Jul 22, 2026?",
      marketUrl: "https://kalshi.com/markets/KXHIGHNY-26JUL22-B87",
      yesPriceCents: 44,
      volume: 12873,
      openInterest: 5321,
      closeTime: "2026-07-23T02:00:00.000Z",
      status: "open",
      settlement: null,
      fetchedAt: first.fetchedAt,
      stale: false
    });
    // Midpoint pricing where last_price is 0; per-event titles joined.
    expect(res.value[1]!.yesPriceCents).toBe(20);
    expect(res.value[2]!.eventTitle).toBe(
      "Highest temperature in NYC on Jul 23, 2026?"
    );
    expect(res.value.every((s) => s.stale === false)).toBe(true);
  });

  it("event resolution uses nested markets and filters non-open ones", async () => {
    route = (url) => {
      if (url.pathname.endsWith("/events/KXHIGHNY-26JUL22")) {
        return { status: 200, body: fixture("event-nested.json") };
      }
      return { status: 404 };
    };
    const source = createKalshiSource(testConfig(baseUrl), logger, FAST_BACKOFF);
    const res = await source.resolveSubscription({
      kind: "event",
      ticker: "KXHIGHNY-26JUL22"
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1); // the closed sibling is filtered out
    expect(res.value[0]!.ticker).toBe("KXHIGHNY-26JUL22-B87");
    expect(res.value[0]!.seriesTicker).toBe("KXHIGHNY");
    expect(res.value[0]!.eventTitle).toBe(
      "Highest temperature in NYC on Jul 22, 2026?"
    );
  });

  it("fetchSnapshots joins parent event titles; coalesces duplicate tickers", async () => {
    route = (url) => {
      if (url.pathname.endsWith("/markets/KXHIGHNY-26JUL22-B87")) {
        return { status: 200, body: fixture("market-open.json") };
      }
      if (url.pathname.endsWith("/events/KXHIGHNY-26JUL22")) {
        return { status: 200, body: fixture("event-nested.json") };
      }
      return { status: 404 };
    };
    const source = createKalshiSource(testConfig(baseUrl), logger, FAST_BACKOFF);
    const res = await source.fetchSnapshots([
      "KXHIGHNY-26JUL22-B87",
      "KXHIGHNY-26JUL22-B87"
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
    expect(res.value[0]!.eventTitle).toBe(
      "Highest temperature in NYC on Jul 22, 2026?"
    );
    expect(res.value[0]!.seriesTicker).toBe("KXHIGHNY");
    // one market GET + one event GET
    expect(hits).toHaveLength(2);
  });

  it("listSeries returns the typed catalog", async () => {
    route = (url) =>
      url.pathname.endsWith("/series")
        ? { status: 200, body: fixture("series-list.json") }
        : { status: 404 };
    const source = createKalshiSource(testConfig(baseUrl), logger, FAST_BACKOFF);
    const res = await source.listSeries();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value[0]).toEqual({
      seriesTicker: "KXHIGHNY",
      title: "Highest temperature in NYC",
      category: "Climate and Weather",
      frequency: "daily"
    });
  });

  it("fetchCandlesticks normalizes periods incl. empty (null close)", async () => {
    route = (url) =>
      url.pathname.endsWith("/candlesticks")
        ? { status: 200, body: fixture("candlesticks.json") }
        : { status: 404 };
    const source = createKalshiSource(testConfig(baseUrl), logger, FAST_BACKOFF);
    const res = await source.fetchCandlesticks("KXHIGHNY", "KXHIGHNY-26JUL22-B87", {
      periodIntervalMinutes: 1440,
      startTs: 1784592000,
      endTs: 1784764800
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(2);
    expect(res.value[0]).toEqual({
      endPeriod: new Date(1784678400 * 1000).toISOString(),
      yesPriceCloseCents: 44,
      volume: 812,
      openInterest: 5100
    });
    expect(res.value[1]!.yesPriceCloseCents).toBeNull();
    const sent = hits[0]!;
    expect(sent.searchParams.get("period_interval")).toBe("1440");
    expect(sent.searchParams.get("start_ts")).toBe("1784592000");
    expect(sent.searchParams.get("end_ts")).toBe("1784764800");
  });

  it("no request ever carries an API key or auth header", async () => {
    // Security property: the client has no credential to send. Assert the
    // request headers seen by the server contain no authorization material.
    const seenHeaders: Record<string, string | string[] | undefined>[] = [];
    const spy = vi.fn();
    const authProbe = createServer((req, res) => {
      seenHeaders.push(req.headers);
      spy();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(fixture("market-open.json")));
    });
    await new Promise<void>((r) => authProbe.listen(0, "127.0.0.1", r));
    const { port } = authProbe.address() as AddressInfo;
    try {
      const client = new KalshiClient(
        testConfig(`http://127.0.0.1:${port}`).kalshi,
        logger,
        FAST_BACKOFF
      );
      const res = await client.getMarket("X");
      expect(res.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      for (const headers of seenHeaders) {
        expect(headers.authorization).toBeUndefined();
        expect(headers["kalshi-access-key"]).toBeUndefined();
        expect(headers.cookie).toBeUndefined();
      }
    } finally {
      await new Promise<void>((r, j) => authProbe.close((e) => (e ? j(e) : r())));
    }
  });
});
