import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markStale, SnapshotStore } from "../../src/snapshots/index.js";
import type { Snapshot } from "../../src/kalshi/types.js";
import { makeSnapshot, openTempDb, type TempDb } from "./helpers.js";

describe("SnapshotStore (temp DB)", () => {
  let tmp: TempDb;
  let store: SnapshotStore;

  beforeEach(() => {
    tmp = openTempDb();
    store = new SnapshotStore(tmp.db);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("contract round-trip: every contracts/snapshot.md field survives exactly", () => {
    const snapshot: Snapshot = {
      ticker: "KXCPI-26JUL-T3.0",
      eventTicker: "KXCPI-26JUL",
      seriesTicker: "KXCPI",
      title: "CPI above 3.0%?",
      eventTitle: "July 2026 CPI print",
      marketUrl: "https://kalshi.com/markets/kxcpi/KXCPI-26JUL",
      yesPriceCents: 37,
      volume: 98765,
      openInterest: 4321,
      closeTime: "2026-08-12T12:30:00.000Z",
      status: "open",
      settlement: null,
      fetchedAt: "2026-07-22T12:00:00.000Z",
      stale: false
    };
    store.saveSnapshots("run-1", [snapshot]);

    expect(store.latestKnown(snapshot.ticker)).toEqual({
      ticker: "KXCPI-26JUL-T3.0",
      eventTicker: "KXCPI-26JUL",
      seriesTicker: "KXCPI",
      title: "CPI above 3.0%?",
      eventTitle: "July 2026 CPI print",
      marketUrl: "https://kalshi.com/markets/kxcpi/KXCPI-26JUL",
      yesPriceCents: 37,
      volume: 98765,
      openInterest: 4321,
      closeTime: "2026-08-12T12:30:00.000Z",
      status: "open",
      settlement: null,
      fetchedAt: "2026-07-22T12:00:00.000Z",
      stale: false
    });
  });

  it("round-trips nullable fields and non-open statuses", () => {
    const settled = makeSnapshot({
      ticker: "T-SETTLED",
      seriesTicker: null,
      openInterest: null,
      status: "settled",
      settlement: "no",
      stale: true
    });
    store.saveSnapshots("run-1", [settled]);
    expect(store.latestKnown("T-SETTLED")).toEqual(settled);
  });

  it("idempotent re-save of same (ticker, fetchedAt): no duplicate, no error", () => {
    const snapshot = makeSnapshot();
    store.saveSnapshots("run-1", [snapshot]);
    // Same key again (even with a different price — first write wins).
    store.saveSnapshots("run-2", [{ ...snapshot, yesPriceCents: 99 }]);

    const rows = tmp.db
      .prepare(
        "SELECT COUNT(*) AS n FROM snapshots WHERE ticker = ? AND fetched_at = ?"
      )
      .get(snapshot.ticker, snapshot.fetchedAt) as { n: number };
    expect(rows.n).toBe(1);
    expect(store.latestKnown(snapshot.ticker)?.yesPriceCents).toBe(62);
  });

  it("records run_id provenance on inserted rows", () => {
    store.saveSnapshots("run-xyz", [makeSnapshot()]);
    const row = tmp.db
      .prepare("SELECT run_id FROM snapshots WHERE ticker = ?")
      .get(makeSnapshot().ticker) as { run_id: string };
    expect(row.run_id).toBe("run-xyz");
  });

  it("latestBefore returns the newest row at/before the timestamp, else null", () => {
    const t = "T-HIST";
    store.saveSnapshots("run-1", [
      makeSnapshot({ ticker: t, fetchedAt: "2026-07-19T12:00:00.000Z", yesPriceCents: 40 }),
      makeSnapshot({ ticker: t, fetchedAt: "2026-07-20T12:00:00.000Z", yesPriceCents: 45 }),
      makeSnapshot({ ticker: t, fetchedAt: "2026-07-21T12:00:00.000Z", yesPriceCents: 50 })
    ]);

    expect(store.latestBefore(t, "2026-07-20T12:00:00.000Z")?.yesPriceCents).toBe(45);
    expect(store.latestBefore(t, "2026-07-20T18:00:00.000Z")?.yesPriceCents).toBe(45);
    expect(store.latestBefore(t, "2026-07-19T00:00:00.000Z")).toBeNull();
    expect(store.latestBefore("T-NEVER-SEEN", "2026-07-22T00:00:00.000Z")).toBeNull();
  });

  it("latestForMarkets returns newest-per-ticker with mixed history", () => {
    store.saveSnapshots("run-1", [
      makeSnapshot({ ticker: "A", fetchedAt: "2026-07-20T12:00:00.000Z", yesPriceCents: 10 }),
      makeSnapshot({ ticker: "B", fetchedAt: "2026-07-20T12:00:00.000Z", yesPriceCents: 55 })
    ]);
    store.saveSnapshots("run-2", [
      makeSnapshot({ ticker: "A", fetchedAt: "2026-07-22T12:00:00.000Z", yesPriceCents: 30 })
    ]);

    const result = store.latestForMarkets(["A", "B", "MISSING"]);
    expect(result).toHaveLength(2);
    expect(result.map((s) => [s.ticker, s.yesPriceCents, s.fetchedAt])).toEqual([
      ["A", 30, "2026-07-22T12:00:00.000Z"],
      ["B", 55, "2026-07-20T12:00:00.000Z"]
    ]);
  });

  it("markStale sets stale true and preserves the original fetchedAt", () => {
    const original = makeSnapshot({ fetchedAt: "2026-07-21T12:00:00.000Z" });
    const stale = markStale(original);
    expect(stale.stale).toBe(true);
    expect(stale.fetchedAt).toBe("2026-07-21T12:00:00.000Z");
    expect(stale).toEqual({ ...original, stale: true });
    // Input is not mutated.
    expect(original.stale).toBe(false);
  });
});
