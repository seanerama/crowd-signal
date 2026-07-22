# Stage 3: SnapshotStore: persistence + 24h/7d delta computation

- **Type:** feature
- **Depends on:** 2

## Objectives

Implement the frozen `contracts/snapshot.md`: the snapshot table as **the system
of record for deltas**. Daily runs persist per-market snapshots; 24h/7d movement is
computed against our own stored rows (candlesticks only backfill the 7d column,
long-TTL cached) so every newsletter is reproducible from local state (ADR 0002).

## What to build

- Additive migration: `snapshots` table per the contract (unique
  `(ticker, fetchedAt)`), plus a `candlestick_cache` table (long TTL).
- `src/snapshots/store.ts`: `saveSnapshots(runId, Snapshot[])`,
  `latestBefore(ticker, ts)`, `latestForMarkets(tickers[])`.
- `src/snapshots/deltas.ts`: `computeDeltas(current, store) -> { d24, d7 }` —
  24h from the prior daily snapshot; 7d from stored history, falling back to one
  candlestick fetch (via KalshiSource) when local history is younger than 7 days.
- Stale handling: when a fetch fails, the last-known snapshot is served with
  `stale: true` downstream and the original `fetchedAt` preserved — the honest
  "as of" stamp (§3.1 fail-open).
- "Closed since last brief" detection: markets present in prior resolution set but
  now `closed`/`settled` → surfaced with settlement, then dropped from resolution.

## Interface contracts

- **Exposes:** `SnapshotStore` + delta computation consumed by Stage 5 (newsletter)
  and Stage 6 (watcher reference prices).
- **Consumes:** `contracts/snapshot.md` (frozen — implement exactly);
  `KalshiSource` from Stage 2 (candlestick backfill).

## Testing requirements

- Unit: delta math against fixture histories (including gaps: missed daily run,
  market newly added, market settled); stale-path preservation of `fetchedAt`;
  closed-since-last-brief detection.
- Integration: save → query round-trip on a temp DB; idempotent re-save of the
  same `(ticker, fetchedAt)`.
- Contract test: stored row shape matches `contracts/snapshot.md` field-for-field.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature —
      store is internal; gated by `KALSHI_ENABLED` upstream (note in PR).
- [ ] UI-smoke "observably-works" check authored for any user-facing surface
      (N/A — internal; note in PR).
- [ ] Additive migration only (no destructive schema change)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
