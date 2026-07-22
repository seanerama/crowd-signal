/**
 * "Closed since last brief" detection (stage 3): markets that were in the
 * prior resolution set but are now closed/settled — surfaced once with their
 * settlement, then dropped from resolution by the caller.
 */
import type { Snapshot } from "../kalshi/types.js";
import type { SnapshotStore } from "./store.js";

function isClosed(snapshot: Snapshot): boolean {
  return snapshot.status === "closed" || snapshot.status === "settled";
}

/**
 * For each previously-tracked ticker, find its freshest view — today's fetch
 * when present, otherwise the latest stored snapshot — and report it when the
 * market is now closed/settled (settlement comes along on the snapshot).
 * Tickers with no snapshot anywhere (never seen) are ignored.
 */
export function detectClosed(
  previousTickers: readonly string[],
  currentSnapshots: readonly Snapshot[],
  store: SnapshotStore
): Snapshot[] {
  const currentByTicker = new Map(currentSnapshots.map((s) => [s.ticker, s]));
  const out: Snapshot[] = [];
  for (const ticker of previousTickers) {
    const latest = currentByTicker.get(ticker) ?? store.latestKnown(ticker);
    if (latest && isClosed(latest)) out.push(latest);
  }
  return out;
}
