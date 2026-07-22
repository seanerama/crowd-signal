# Kalshi fixtures

Hand-authored JSON fixtures matching the documented response SHAPES of
Kalshi's public, unauthenticated API
(`https://external-api.kalshi.com/trade-api/v2` — see the Kalshi API docs for
GetMarkets / GetEvents / GetEvent / GetMarket / GetSeriesList /
GetMarketCandlesticks). They are NOT recorded live captures — no live network
calls happen in CI — but field names, nesting, and value formats follow the
documented wire shapes, with realistic values.

- `markets-series.json` — GET /markets?series_ticker=...&status=open
- `events-series.json` — GET /events?series_ticker=...
- `event-nested.json` — GET /events/{event_ticker}?with_nested_markets=true
- `market-open.json` — GET /markets/{ticker} (an active market)
- `market-settled.json` — GET /markets/{ticker} (a settled market, result=yes)
- `series-list.json` — GET /series
- `candlesticks.json` — GET /series/{series_ticker}/markets/{ticker}/candlesticks
