import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeDeltas, SnapshotStore } from "../../src/snapshots/index.js";
import { makeSnapshot, openTempDb, type TempDb } from "./helpers.js";

const NOW = "2026-07-22T12:00:00.000Z";

describe("computeDeltas", () => {
  let tmp: TempDb;
  let store: SnapshotStore;

  beforeEach(() => {
    tmp = openTempDb();
    store = new SnapshotStore(tmp.db);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  function seed(ticker: string, rows: Array<{ at: string; price: number }>): void {
    store.saveSnapshots(
      "seed",
      rows.map((r) => makeSnapshot({ ticker, fetchedAt: r.at, yesPriceCents: r.price }))
    );
  }

  it("normal 24h + 7d deltas from local history", async () => {
    seed("T", [
      { at: "2026-07-15T12:00:00.000Z", price: 30 }, // exactly 7d ago
      { at: "2026-07-21T12:00:00.000Z", price: 50 } // exactly 24h ago
    ]);
    const current = makeSnapshot({ ticker: "T", fetchedAt: NOW, yesPriceCents: 62 });
    expect(await computeDeltas(current, store)).toEqual({ d24: 12, d7: 32 });
  });

  it("gap (missed daily run) falls back to the older at/before row", async () => {
    seed("T", [
      { at: "2026-07-15T12:00:00.000Z", price: 30 },
      { at: "2026-07-19T12:00:00.000Z", price: 40 } // 20th/21st runs missed
    ]);
    const current = makeSnapshot({ ticker: "T", fetchedAt: NOW, yesPriceCents: 62 });
    expect(await computeDeltas(current, store)).toEqual({ d24: 22, d7: 32 });
  });

  it("newly-tracked market with no history: both null", async () => {
    const current = makeSnapshot({ ticker: "T-NEW", fetchedAt: NOW, yesPriceCents: 62 });
    expect(await computeDeltas(current, store)).toEqual({ d24: null, d7: null });
  });

  it("negative deltas when the price fell", async () => {
    seed("T", [
      { at: "2026-07-15T11:00:00.000Z", price: 80 },
      { at: "2026-07-21T11:00:00.000Z", price: 70 }
    ]);
    const current = makeSnapshot({ ticker: "T", fetchedAt: NOW, yesPriceCents: 62 });
    expect(await computeDeltas(current, store)).toEqual({ d24: -8, d7: -18 });
  });

  it("7d via candlestick fallback, cached: second call does NOT invoke the lookup", async () => {
    // Local history only 2 days deep — younger than 7d.
    seed("T", [{ at: "2026-07-20T12:00:00.000Z", price: 50 }]);
    const current = makeSnapshot({ ticker: "T", fetchedAt: NOW, yesPriceCents: 62 });
    const lookup = vi.fn().mockResolvedValue(41);

    expect(await computeDeltas(current, store, { candleLookup: lookup })).toEqual({
      d24: 12,
      d7: 21
    });
    expect(lookup).toHaveBeenCalledExactlyOnceWith("T");

    // Result landed in candlestick_cache...
    const row = tmp.db
      .prepare(
        "SELECT series_ticker, end_period, yes_price_close_cents FROM candlestick_cache WHERE market_ticker = ?"
      )
      .get("T") as { series_ticker: string; end_period: string; yes_price_close_cents: number };
    expect(row.yes_price_close_cents).toBe(41);
    expect(row.series_ticker).toBe("KXFED");
    expect(row.end_period).toBe("2026-07-15T12:00:00.000Z");

    // ...so the second call is served from cache without touching the lookup.
    expect(await computeDeltas(current, store, { candleLookup: lookup })).toEqual({
      d24: 12,
      d7: 21
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("candlestick fallback returning null is negative-cached (d7 null, lookup once)", async () => {
    const current = makeSnapshot({ ticker: "T-THIN", fetchedAt: NOW, yesPriceCents: 62 });
    const lookup = vi.fn().mockResolvedValue(null);

    expect(await computeDeltas(current, store, { candleLookup: lookup })).toEqual({
      d24: null,
      d7: null
    });
    expect(await computeDeltas(current, store, { candleLookup: lookup })).toEqual({
      d24: null,
      d7: null
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("no local 7d history and no lookup provided: d7 null", async () => {
    seed("T", [{ at: "2026-07-21T12:00:00.000Z", price: 50 }]);
    const current = makeSnapshot({ ticker: "T", fetchedAt: NOW, yesPriceCents: 62 });
    expect(await computeDeltas(current, store)).toEqual({ d24: 12, d7: null });
  });

  it("local row at/before 7d wins over the candlestick fallback", async () => {
    seed("T", [
      { at: "2026-07-14T12:00:00.000Z", price: 20 },
      { at: "2026-07-21T12:00:00.000Z", price: 50 }
    ]);
    const current = makeSnapshot({ ticker: "T", fetchedAt: NOW, yesPriceCents: 62 });
    const lookup = vi.fn().mockResolvedValue(99);
    expect(await computeDeltas(current, store, { candleLookup: lookup })).toEqual({
      d24: 12,
      d7: 42
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});
