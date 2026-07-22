# Stage 8: Kalshi normalization reads legacy fields — live API returns *_dollars/*_fp (all prices 0%)

- **Type:** bug
- **Depends on:** none

## Objectives

First live run (2026-07-22, run 7379b53c) rendered every market at 0% probability
and 0 volume. Root cause: the live Kalshi API has migrated field names — market
responses carry `last_price_dollars` / `yes_bid_dollars` / `yes_ask_dollars`
(decimal-dollar strings, "0.0100" = 1¢), `volume_fp` / `open_interest_fp`
(fixed-point strings) — and the legacy integer fields (`last_price`, `volume`,
`open_interest`, `yes_bid`, `yes_ask`) now return null. Candlesticks likewise:
`price.close` is gone; OHLC lives in `yes_bid`/`yes_ask` objects with
`*_dollars` strings. Stage-2 fixtures were hand-authored to the older documented
shapes, so tests passed while production normalized nulls to zeros.

## What to build

- `src/kalshi/normalize.ts` + `src/kalshi/types.ts`: read the new fields FIRST,
  falling back to legacy names (both shapes supported — resilience if Kalshi
  serves either): price = last_price_dollars (>0) → bid/ask-dollars midpoint →
  legacy last_price → legacy midpoint → 0; volume = volume_fp → volume → 0;
  openInterest = open_interest_fp → open_interest → null. Parse decimal-dollar
  strings × 100 → clamped integer cents; parse fp strings → rounded integers.
- `src/kalshi/index.ts` fetchCandlesticks mapping: close = price.close_dollars →
  bid/ask close_dollars midpoint → legacy price.close → null.
- Replace/extend `test/fixtures/kalshi/*.json` with REAL captured response
  shapes (recorded from the live public API 2026-07-22).

## Interface contracts

- **Exposes:** unchanged `Snapshot` per frozen `contracts/snapshot.md` — this is
  an internal normalization fix; the contract shape is untouched.
- **Consumes:** live Kalshi public API (new field names).

## Testing requirements

- Regression test with REAL captured fixtures: a market with
  `last_price_dollars: "0.0100"`, `volume_fp: "1390.00"` and all legacy fields
  null must normalize to yesPriceCents=1, volume=1390 (this fails before the
  fix — everything normalized to 0).
- Legacy-shape fixtures keep passing (fallback path).
- Candlestick regression: new-shape candle → close cents from
  yes_bid/yes_ask close_dollars midpoint; missing everything → null.

## Acceptance conditions

- [ ] Reproduction captured + a regression test (fails before, passes after)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
