# 0005. Alert hygiene: threshold, hysteresis, cooldown, caps, quiet hours, liquidity floor

- **Status:** Accepted
- **Date:** 2026-07-22

## Context

Detecting movement is trivial; **not spamming is the feature**. A naive
threshold-crossing alerter machine-guns emails on oscillating prices, fires on
meaningless thin-market jumps, and wakes the operator at 3am. The hygiene rules are
the real design work of the alert path, and every knob must be tunable from
evidence, not vibes.

## Decision

All rules per-profile configurable with these defaults, evaluated in the watcher
loop (~15 min interval during market hours):

- **Threshold:** minimum move vs. the reference price — default **5 pts**. One
  threshold per profile in v1 (no per-market-class thresholds yet).
- **Reference + hysteresis:** reference = price at last alert (or last daily brief
  if none). After an alert fires, the market **re-arms** only when price has stayed
  within a **2 pt** dead band of the new reference for one full watcher cycle.
- **Cooldown:** minimum **4 h** between alerts on the same market, regardless of
  movement.
- **Daily cap:** max **5** alert emails per profile per day. Overflow is summarized
  in the next daily newsletter ("N further alerts suppressed"), never silently
  dropped.
- **Quiet hours:** no alert *emails* **22:00–07:00** operator-local; quiet-hour
  detections are logged and folded into the morning newsletter.
- **Liquidity floor:** markets under **$1k** volume never alert; they still appear
  in the daily table flagged low-liquidity.
- **Every suppressed alert is logged with its suppression reason** — the
  suppression log is the tuning dataset (measure-before-investing).

## Alternatives considered

- **Simple threshold-only alerting:** rejected — the oscillation/machine-gun
  failure mode is certain, not hypothetical.
- **Statistical anomaly detection (z-scores over volatility):** rejected for v1 —
  needs history we don't have yet and adds an unexplainable knob; the suppression
  log will tell us if fixed thresholds are inadequate.
- **Per-market-class thresholds (weather vs. macro):** deliberately deferred; the
  open question is recorded in project-des §11 and will be answered by suppression
  data.
- **Batching multiple alerts into digest emails:** rejected for v1 — one market per
  email keeps the subject line meaningful; the daily cap bounds total volume.

## Consequences

- The alert path needs per-market watcher state (reference price, armed flag, last
  alert time, per-day count) — part of the frozen alert-record contract.
- Alerts are persisted **feed-shaped** (structured record before email), keeping
  the door open for other consumers (someday Daily-Brief) without redesign.
- Tuning is expected: defaults are starting points, and the suppression log is the
  standing evidence base for changing them.
