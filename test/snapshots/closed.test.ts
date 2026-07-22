import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectClosed, SnapshotStore } from "../../src/snapshots/index.js";
import { makeSnapshot, openTempDb, type TempDb } from "./helpers.js";

describe("detectClosed (closed since last brief)", () => {
  let tmp: TempDb;
  let store: SnapshotStore;

  beforeEach(() => {
    tmp = openTempDb();
    store = new SnapshotStore(tmp.db);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("previously-tracked market now settled shows with settlement; open one does not", () => {
    const settled = makeSnapshot({
      ticker: "T-SETTLED",
      status: "settled",
      settlement: "yes",
      fetchedAt: "2026-07-22T12:00:00.000Z"
    });
    const stillOpen = makeSnapshot({
      ticker: "T-OPEN",
      status: "open",
      fetchedAt: "2026-07-22T12:00:00.000Z"
    });

    const result = detectClosed(["T-SETTLED", "T-OPEN"], [settled, stillOpen], store);
    expect(result).toEqual([settled]);
    expect(result[0]?.settlement).toBe("yes");
  });

  it("closed (not yet settled) market is listed with null settlement", () => {
    const closed = makeSnapshot({ ticker: "T-CLOSED", status: "closed", settlement: null });
    expect(detectClosed(["T-CLOSED"], [closed], store)).toEqual([closed]);
  });

  it("falls back to the store's latest snapshot when absent from the current fetch", () => {
    const settled = makeSnapshot({
      ticker: "T-DROPPED",
      status: "settled",
      settlement: "no",
      fetchedAt: "2026-07-21T12:00:00.000Z"
    });
    store.saveSnapshots("run-1", [settled]);

    // Settled markets drop out of resolution, so the current fetch is empty.
    expect(detectClosed(["T-DROPPED"], [], store)).toEqual([settled]);
  });

  it("never-seen ticker is ignored", () => {
    expect(detectClosed(["T-GHOST"], [], store)).toEqual([]);
  });

  it("current fetch wins over an older stored open row", () => {
    store.saveSnapshots("run-1", [
      makeSnapshot({ ticker: "T", status: "open", fetchedAt: "2026-07-21T12:00:00.000Z" })
    ]);
    const nowSettled = makeSnapshot({
      ticker: "T",
      status: "settled",
      settlement: "yes",
      fetchedAt: "2026-07-22T12:00:00.000Z"
    });
    expect(detectClosed(["T"], [nowSettled], store)).toEqual([nowSettled]);
  });
});
