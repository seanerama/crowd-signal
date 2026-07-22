# Contract: alert-record

- **Status:** frozen v1
- **Owner:** AlertEngine (watcher loop) — consumed by the mailer, the daily
  newsletter ("N further alerts suppressed"), the admin UI, and any future feed
  consumer (someday Daily-Brief)

## Exposes

Every detected notable movement is persisted as a structured record **before** it
is an email — alerts are feed-shaped internally (project-des §3.2). Suppressed
alerts are records too, with their suppression reason: the suppression log is the
tuning dataset for the hygiene knobs (ADR 0005).

## Consumes

- Snapshot contract (reference + current prices).
- Profile hygiene config (threshold, dead band, cooldown, cap, quiet hours,
  liquidity floor).
- Mailer (for `outcome: "sent"` records only).

## Schema / wire

```
AlertRecord {
  id:            string        // ulid
  profileId:     string
  ticker:        string
  seriesTicker:  string | null
  title:         string
  eventTitle:    string        // rendered with title, always (§4.1)
  marketUrl:     string
  refPriceCents:     integer   // reference price (last alert, else last brief)
  currentPriceCents: integer
  deltaPts:      integer       // signed, current - ref
  volume:        integer
  detectedAt:    string(ISO-8601)
  outcome:       "sent" | "suppressed" | "deferred_quiet_hours"
  suppressionReason: null
    | "cooldown" | "daily_cap" | "quiet_hours" | "liquidity_floor"
    | "not_rearmed"            // hysteresis dead-band not yet satisfied
  emailedAt:     string(ISO-8601) | null
}
```

Alert email (rendered from the record, template only, no inference):
one market per email; subject
`[Crowd-Signal] <profile>: <market short title> moved <±N> pts`.

Watcher arming state (per profile+market, internal to AlertEngine but stored):
`{ referencePriceCents, armed: boolean, lastAlertAt, alertsToday }`.

Semantics guaranteed to consumers:
- `outcome: "suppressed"` records are never emailed, but are counted into the next
  daily newsletter's suppression summary — never silently dropped.
- `deferred_quiet_hours` records fold into the morning newsletter.
- One record per detection event; re-detections during cooldown create new
  suppressed records (that's the tuning signal).

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
