# Stage 2: KalshiSource: public API client, token-bucket rate limiter, backoff

- **Type:** feature
- **Depends on:** 1

## Objectives

A typed client for Kalshi's **public, unauthenticated** endpoints
(`https://external-api.kalshi.com/trade-api/v2` — markets, events, series,
candlesticks) with production manners built in from day one: client-side
token-bucket rate limiting, request coalescing, exponential backoff + jitter on
429/5xx, `Retry-After` honored (project-des §7). **No API key exists anywhere** —
that is a security property to preserve, not an omission.

## What to build

- `src/kalshi/` module: `client.ts` (fetch wrapper + typed endpoints: list series,
  list events, list markets by series/event, get market, candlesticks),
  `rateLimiter.ts` (token bucket, conservative fraction of published limits,
  limits **configured** via env not hardcoded), `backoff.ts`.
- Normalization to the `Snapshot` field shapes (ticker, eventTicker, seriesTicker,
  title, eventTitle, marketUrl, yesPriceCents, volume, closeTime, status,
  settlement) — the raw-to-contract mapping lives here and only here.
- Series/event **resolution**: given a subscription (series or event ticker),
  return current open markets — the churn-absorbing lookup (§2).
- 429 counter exposed as a metric/log line (standing watch item, STATUS.md).
- Fail-open error surface: every failure returns a typed degraded result
  (`{ ok: false, reason }`), never throws through the pipeline.

## Interface contracts

- **Exposes:** `KalshiSource` interface consumed by Stages 3/5/6/7 (fetch
  snapshots, resolve subscriptions, fetch catalog, candlesticks).
- **Consumes:** `contracts/snapshot.md` field shapes (normalization target).

## Testing requirements

- Unit: rate limiter (bucket drains/refills, coalescing), backoff schedule
  (jitter bounds, Retry-After precedence), normalization fixtures from recorded
  real API responses (committed JSON fixtures — no live network in CI).
- Integration: client against a local mock server asserting limiter + backoff
  behavior on 429/500 sequences.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature —
      `KALSHI_ENABLED`; OFF → resolution/fetch return typed degraded results.
- [ ] UI-smoke "observably-works" check authored for any user-facing surface
      (N/A — no user-facing surface; note in PR).
- [ ] Additive migration only (no destructive schema change)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
