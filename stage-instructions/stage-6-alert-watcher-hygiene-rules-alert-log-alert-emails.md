# Stage 6: Alert watcher: hygiene rules, alert log, alert emails

- **Type:** feature
- **Depends on:** 5

## Objectives

The push half of the product: an in-process watcher loop (~15 min interval) that
detects notable movement and emails alerts — where **not spamming is the feature**.
Implements the full ADR 0005 hygiene rule set with every suppressed alert logged
with its reason (the tuning dataset). Alerts are feed-shaped: structured record
first, email second (`contracts/alert-record.md`).

## What to build

- Additive migrations: `alerts` (AlertRecord per contract) and `watcher_state`
  (per profile+market: referencePriceCents, armed, lastAlertAt, alertsToday).
- `src/watcher/loop.ts`: interval scheduler (env-configured cadence; batched
  coalesced fetches via KalshiSource).
- `src/watcher/hygiene.ts` — pure decision function
  `(detection, state, config, clock) -> { outcome, suppressionReason }`
  implementing, in order: liquidity floor ($1k), threshold (5 pts vs reference),
  re-arm hysteresis (2 pt dead band, one full cycle), cooldown (4 h), daily cap
  (5/day → overflow summarized in next newsletter), quiet hours (22:00–07:00
  operator-local → `deferred_quiet_hours`, folded into morning brief).
- Alert email rendering (template, one market per email, subject per contract) via
  the Stage 5 `Mailer`.
- Newsletter additions (additive sections, contract order): alerts summary —
  quiet-hour folds + "N further alerts suppressed".
- Admin: alert log page (sent + suppressed with reasons); suppression counts
  surfaced for STATUS.md watch items.

## Interface contracts

- **Exposes:** the alert feed (structured records) — future consumers read the
  table, not the emails.
- **Consumes:** `contracts/alert-record.md` (frozen — implement exactly);
  KalshiSource (2), SnapshotStore (3, reference prices), profiles/hygiene config
  (4), Mailer (5).

## Testing requirements

- Unit (the heart of the stage): hygiene decision table — oscillation across
  threshold fires once then re-arms only after dead-band dwell; cooldown windows;
  cap overflow → suppressed records; quiet-hours deferral; liquidity floor;
  fake clock throughout.
- Integration: watcher tick against mock Kalshi + temp DB → records persisted
  before send; dry-run mailer captures rendered alert.
- UI-smoke `docs/ui-smoke/stage-6.md`: operator lowers a threshold to force an
  alert on a live market, receives the email, sees the record + a suppressed
  record in the admin log.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature —
      `WATCHER_ENABLED` (OFF → no loop scheduled).
- [ ] UI-smoke "observably-works" check authored for any user-facing surface —
      `docs/ui-smoke/stage-6.md`.
- [ ] Additive migration only (no destructive schema change)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
