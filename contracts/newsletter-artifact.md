# Contract: newsletter-artifact

- **Status:** frozen v1
- **Owner:** Renderer — consumed by the Mailer, the artifact store, and the admin
  UI (run history browsing)

## Exposes

The daily newsletter as a **self-contained HTML document** plus a machine-readable
run manifest. The artifact IS what was sent: the mailer sends the same HTML that is
persisted, so `artifacts/<runId>/` is a faithful archive.

## Consumes

- Snapshot contract (current + prior rows for 24h/7d deltas).
- Alert-record contract (suppression summary, quiet-hour folds).
- Suggestion contract (weekly discovery section, when present).

## Schema / wire

Filesystem layout (on the `/data` volume, ADR 0002):

```
artifacts/<runId>/
  <profileId>.html        # the sent newsletter, self-contained
  manifest.json           # RunManifest
```

HTML hard requirements: inline CSS only, zero external requests (no remote images,
fonts, scripts); renders correctly from disk or inbox.

Section order (sections with no content are omitted, header/footer always present):

1. **Header** — profile name, date, "as of" timestamp (stale data stamped honestly).
2. **Movers** — largest 24h moves, sorted by |Δ|.
3. **Watchlist table** — every followed market: title *with* event/series context
   (§4.1), implied probability, 24h Δ, 7d Δ, volume, close date, market link.
4. **Closed since last brief** — settled markets + outcomes.
5. **New markets you might want** — weekly discovery suggestions, confirm links
   into the admin UI (never auto-added).
6. **Alerts summary** — quiet-hour alerts folded in; "N further alerts suppressed".
7. **Footer** — source-health note, config pointer, standing disclaimer (prices
   are crowd estimates, not predictions or advice), and the per-run cost line
   (≈ $0 in v1; printed anyway — the discipline precedes the number).

```
RunManifest {
  runId:      string
  kind:       "daily" | "discovery"
  profileId:  string
  date:       string(YYYY-MM-DD)
  asOf:       string(ISO-8601)
  sections:   string[]          // which of the above rendered
  marketCount:     integer
  moversCount:     integer
  closedCount:     integer
  suppressedCount: integer
  healthNotes:     string[]     // e.g. "kalshi unreachable; last-known data"
  costUsd:         number       // inference spend for this run (0 on daily path)
  emailedTo:  string[]          // recipient addresses
  emailedAt:  string(ISO-8601) | null
}
```

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
