/**
 * Contract test: normalization must produce EXACTLY the Snapshot field shapes
 * frozen in contracts/snapshot.md v1.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeMarket } from "../../src/kalshi/normalize.js";
import type {
  MarketResponse,
  MarketsResponse
} from "../../src/kalshi/types.js";

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/kalshi/${name}`, import.meta.url), "utf8")
  ) as T;
}

const FETCHED_AT = "2026-07-22T12:00:00.000Z";

describe("normalization: raw Kalshi market -> Snapshot (contracts/snapshot.md v1)", () => {
  it("maps an open market to the exact frozen shape, every field", () => {
    const raw = fixture<MarketResponse>("market-open.json").market;
    const snap = normalizeMarket(raw, {
      eventTitle: "Highest temperature in NYC on Jul 22, 2026?",
      seriesTicker: "KXHIGHNY",
      fetchedAt: FETCHED_AT
    });

    // toEqual on a full literal = no extra fields, no missing fields.
    expect(snap).toEqual({
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
      fetchedAt: FETCHED_AT,
      stale: false
    });

    // Type-level shape checks per contract.
    expect(Number.isInteger(snap.yesPriceCents)).toBe(true);
    expect(snap.yesPriceCents).toBeGreaterThanOrEqual(0);
    expect(snap.yesPriceCents).toBeLessThanOrEqual(100);
    expect(Number.isInteger(snap.volume)).toBe(true);
    expect(new Date(snap.closeTime).toISOString()).toBe(snap.closeTime);
    expect(new Date(snap.fetchedAt).toISOString()).toBe(snap.fetchedAt);
  });

  it("maps a settled market: status settled, settlement yes, openInterest null", () => {
    const raw = fixture<MarketResponse>("market-settled.json").market;
    const snap = normalizeMarket(raw, {
      eventTitle: "Highest temperature in NYC on Jul 15, 2026?",
      seriesTicker: "KXHIGHNY",
      fetchedAt: FETCHED_AT
    });
    expect(snap.status).toBe("settled");
    expect(snap.settlement).toBe("yes");
    expect(snap.openInterest).toBeNull();
    expect(snap.yesPriceCents).toBe(97);
    expect(snap.stale).toBe(false);
  });

  it("uses the bid/ask midpoint when there is no last trade price", () => {
    const raw = fixture<MarketsResponse>("markets-series.json").markets[1]!;
    expect(raw.last_price).toBe(0);
    const snap = normalizeMarket(raw, {
      eventTitle: "e",
      seriesTicker: null,
      fetchedAt: FETCHED_AT
    });
    expect(snap.yesPriceCents).toBe(20); // (18 + 22) / 2
  });

  it("seriesTicker null passes through (one-off events)", () => {
    const raw = fixture<MarketResponse>("market-open.json").market;
    const snap = normalizeMarket(raw, {
      eventTitle: "t",
      seriesTicker: null,
      fetchedAt: FETCHED_AT
    });
    expect(snap.seriesTicker).toBeNull();
  });

  it("maps unknown/interim statuses to closed, no-result to null settlement", () => {
    const raw = {
      ...fixture<MarketResponse>("market-open.json").market,
      status: "determined",
      result: ""
    };
    const snap = normalizeMarket(raw, {
      eventTitle: "t",
      seriesTicker: null,
      fetchedAt: FETCHED_AT
    });
    expect(snap.status).toBe("closed");
    expect(snap.settlement).toBeNull();
  });
});
