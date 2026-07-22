# Contract: suggestion

- **Status:** frozen v1
- **Owner:** SuggestionEngine (the v1 `Engine` seam, ADR 0006) — consumed by the
  admin UI (onboarding) and the discovery run (weekly newsletter section)

## Exposes

The only model-backed capability in v1. One function, two call modes:

```
suggest(profileDescription, catalog[, sinceCatalog]) -> Suggestion[]
```

- **Onboarding** (no `sinceCatalog`): rank the live open-series catalog against
  the profile description.
- **Discovery** (`sinceCatalog` present): rank only the catalog **diff** — series
  new since the last pass.

Suggestions are proposals only. **Nothing is ever subscribed without operator
confirmation** — the consumer (admin UI / newsletter confirm links) enforces the
confirm gate.

## Consumes

- Kalshi series/event catalog (public API, filtered to open series).
- Engine config from env: provider/model configurable, `ANTHROPIC_API_KEY`,
  kill-switch (default OFF).

## Schema / wire

```
Suggestion {
  seriesTicker: string
  title:        string
  rationale:    string     // one line: "why this fits <profile>"
  confidence:   number     // 0..1
}

SuggestionResult {
  suggestions: Suggestion[]   // ranked, best first; [] on engine-off/error
  engineUsed:  string | null  // provider/model id, null when dark/failed
  costUsd:     number         // printed wherever money is spent
  healthNote:  string | null  // e.g. "suggestion engine unavailable"
}
```

Failure posture (guaranteed): engine off, misconfigured, or erroring →
`suggestions: []` with a `healthNote`; the caller proceeds (profile creation never
blocks on the engine). Degrade, never block.

Persistence: every call logs a `suggestion_history` row (profileId, mode, input
catalog size, suggestions offered, which were accepted, costUsd, timestamp) so
acceptance rate is measurable — a STATUS.md watch item.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
v2 narrative summarization will be a NEW contract, not an extension of this one.
