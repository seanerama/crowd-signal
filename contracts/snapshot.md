# Contract: snapshot

- **Status:** frozen v1
- **Owner:** SnapshotStore — consumed by the daily renderer, the alert watcher, and
  delta computation

## Exposes

The stored per-market snapshot record. **The snapshot store is the system of record
for deltas**: 24h/7d movement is computed against our own prior snapshots, never
re-fetched history, so every newsletter is reproducible from local state (ADR 0002).

- `saveSnapshots(runId, Snapshot[])`
- `latestBefore(ticker, timestamp) -> Snapshot | null` (delta lookup)
- `latestForMarkets(tickers[]) -> Snapshot[]`

## Consumes

- KalshiSource fetch results (public API, normalized).
- SQLite `/data/pulse.db`, table `snapshots`.

## Schema / wire

```
Snapshot {
  ticker:        string        // market ticker (unique per market)
  eventTicker:   string        // parent event
  seriesTicker:  string | null // parent series (null for one-off events)
  title:         string        // market title
  eventTitle:    string        // parent event/series title — the cryptic-title
                               // fix (§4.1): ALWAYS stored and rendered together
  marketUrl:     string
  yesPriceCents: integer       // 0-100; implied probability of YES
  volume:        integer       // lifetime contracts/dollars per Kalshi field
  openInterest:  integer | null
  closeTime:     string(ISO-8601)
  status:        "open" | "closed" | "settled"
  settlement:    "yes" | "no" | null   // set when settled
  fetchedAt:     string(ISO-8601)      // the honest "as of" timestamp
  stale:         boolean       // true when serving last-known data (fetch failed)
}
```

Uniqueness: `(ticker, fetchedAt)`. A daily run writes one snapshot row per resolved
market; the watcher MAY also write intra-day snapshots (same shape). Stale rows keep
their original `fetchedAt` and set `stale: true` downstream in rendering.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
