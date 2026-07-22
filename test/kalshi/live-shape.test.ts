/**
 * Regression for stage 8: the live Kalshi API (captured 2026-07-22) serves
 * decimal-dollar strings (last_price_dollars "0.0100" = 1 cent) and
 * fixed-point strings (volume_fp "1390.00") with ALL legacy integer fields
 * null. Before the fix, normalization read only the legacy fields and every
 * market rendered as 0% / 0 volume (prod run 7379b53c).
 *
 * Fixtures under test/fixtures/kalshi/*live-shape-2026-07-22.json are REAL
 * captured responses, not hand-authored.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dollarsToCents,
  fpToInt,
  normalizeMarket
} from "../../src/kalshi/normalize.js";
import { createKalshiSource } from "../../src/kalshi/index.js";
import { loadConfig } from "../../src/config.js";
import type {
  CandlesticksResponse,
  MarketResponse,
  RawMarket
} from "../../src/kalshi/types.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "kalshi");

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

const CTX = {
  eventTitle: "US gas prices tomorrow?",
  seriesTicker: "KXAAAGASD",
  fetchedAt: "2026-07-22T19:00:00.000Z"
};

describe("live-shape normalization (stage 8 regression)", () => {
  it("captured live market: *_dollars/*_fp fields normalize to real values", () => {
    const raw = fixture<MarketResponse>(
      "market-live-shape-2026-07-22.json"
    ).market;
    // The capture itself proves the reproduction: the live API no longer
    // serves the legacy integer fields (absent or null).
    expect(raw.last_price ?? null).toBeNull();
    expect(raw.volume ?? null).toBeNull();

    const snap = normalizeMarket(raw, CTX);
    expect(snap.yesPriceCents).toBe(1); // "0.0100" dollars = 1 cent = 1%
    expect(snap.volume).toBe(1390); // volume_fp "1390.00"
    expect(snap.openInterest).toBe(1316); // open_interest_fp "1316.00"
  });

  it("dollars-midpoint fallback when no last trade", () => {
    const raw: RawMarket = {
      ticker: "T",
      event_ticker: "E",
      title: "t",
      status: "active",
      close_time: "2026-07-23T02:00:00Z",
      last_price_dollars: "0.0000",
      yes_bid_dollars: "0.4000",
      yes_ask_dollars: "0.5000"
    };
    expect(normalizeMarket(raw, CTX).yesPriceCents).toBe(45);
  });

  it("legacy integer fields still work (fallback path)", () => {
    const raw: RawMarket = {
      ticker: "T",
      event_ticker: "E",
      title: "t",
      status: "active",
      close_time: "2026-07-23T02:00:00Z",
      last_price: 63,
      volume: 500,
      open_interest: 42
    };
    const snap = normalizeMarket(raw, CTX);
    expect(snap.yesPriceCents).toBe(63);
    expect(snap.volume).toBe(500);
    expect(snap.openInterest).toBe(42);
  });

  it("dollarsToCents / fpToInt parse and reject garbage", () => {
    expect(dollarsToCents("0.0100")).toBe(1);
    expect(dollarsToCents("0.6350")).toBe(64);
    expect(dollarsToCents("")).toBeNull();
    expect(dollarsToCents("abc")).toBeNull();
    expect(dollarsToCents(null)).toBeNull();
    expect(fpToInt("1390.00")).toBe(1390);
    expect(fpToInt("303.15")).toBe(303);
    expect(fpToInt(undefined)).toBeNull();
  });

  it("captured live candlestick: close cents from bid/ask *_dollars midpoint", async () => {
    const candles = fixture<CandlesticksResponse>(
      "candlesticks-live-shape-2026-07-22.json"
    );
    const config = loadConfig({
      TRIGGER_API_TOKEN: "t",
      KALSHI_ENABLED: "true",
      KALSHI_API_BASE: "http://kalshi.test"
    });
    const source = createKalshiSource(
      config,
      { info() {}, warn() {}, error() {} },
      {
        fetchFn: async () =>
          new Response(JSON.stringify(candles), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      }
    );
    const res = await source.fetchCandlesticks("KXFEDDECISION", "X", {
      periodIntervalMinutes: 1440,
      startTs: 0,
      endTs: 1
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // yes_bid.close_dollars "0.0300" + yes_ask.close_dollars "0.2200" → 13¢
    expect(res.value[0]!.yesPriceCloseCents).toBe(13);
    expect(res.value[0]!.openInterest).toBe(854);
  });

  it("candlestick with nothing usable → null close", async () => {
    const config = loadConfig({
      TRIGGER_API_TOKEN: "t",
      KALSHI_ENABLED: "true",
      KALSHI_API_BASE: "http://kalshi.test"
    });
    const source = createKalshiSource(
      config,
      { info() {}, warn() {}, error() {} },
      {
        fetchFn: async () =>
          new Response(
            JSON.stringify({ candlesticks: [{ end_period_ts: 1 }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      }
    );
    const res = await source.fetchCandlesticks("S", "X", {
      periodIntervalMinutes: 1440,
      startTs: 0,
      endTs: 1
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value[0]!.yesPriceCloseCents).toBeNull();
  });
});
