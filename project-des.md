# Market-Pulse — Project Description (v1)

> **Status:** draft for dev handoff. Name **Market-Pulse** is a placeholder — swap freely.
> **Relationship to Daily-Brief:** sibling project, deliberately separate. Shares
> architectural DNA and deployment patterns (see §8), shares **no runtime systems**.
> Overlapping capabilities are expected; extraction into shared *libraries* (not
> shared systems) is a future, evidence-driven decision.

---

## 1. What this is

A single-operator service that turns **prediction-market data (Kalshi, v1)** into
subscriber-facing insight, delivered two ways:

1. **A daily newsletter email** — a snapshot of the markets a profile follows:
   current implied probability, movement since yesterday/last week, volume, and
   close dates. Raw data, cleanly rendered. No narrative.
2. **Alert emails** — sent when a followed market moves past a notable-movement
   threshold, subject to strict hygiene rules (§6).

The product thesis: prediction-market prices are a live, quantified read on "what
the crowd believes." A price of 63¢ on a YES contract ≈ 63% crowd-assigned
probability. Most people never see this signal; Market-Pulse delivers it on a
schedule, filtered through an audience lens.

**v1 is deterministic on the daily path.** The only AI inference in v1 is market
*suggestion* (§5). Everything a subscriber receives is template-rendered data —
no model calls, no hallucination surface, no per-send inference cost.

---

## 2. Operating model

The same operator-centric model as Daily-Brief, adapted from editorial to data:

- The **operator** creates **audience profiles** (e.g. *Farmer*, *AI DevOps*,
  *Macro Watcher*). A profile is the unit of curation and the unit of delivery.
- At profile creation, an **AI suggestion pass** proposes a default market list
  from the profile's description (§5). The operator confirms/edits — suggestions
  are never auto-subscribed.
- The operator can **add or remove markets** on any profile at any time via the
  admin UI. Subscriptions are by **series/event ticker wherever possible** (e.g.
  the series "Daily high temperature in Chicago"), not individual expiring
  markets — this absorbs Kalshi's daily market churn without any intelligence.
- Each profile has one or more **subscriber email addresses**. In v1 this is the
  operator's own inbox (see the Resend constraint, §8.4). Multi-subscriber
  delivery is staged (§9), not assumed.
- A **cron-driven trigger API** starts the daily run; a **watcher loop** inside
  the app evaluates alert conditions on an interval. Same trigger-API pattern,
  token-authenticated, as Daily-Brief.

---

## 3. The two request types

### 3.1 Daily status (pull, scheduled)

```
cron ──▶ POST /trigger/daily (token)
           │
           ▼
   for each active profile:
     1. resolve series/event subscriptions ──▶ current open markets
     2. fetch snapshots from Kalshi public API   (no auth required)
     3. load yesterday's snapshot from SQLite ──▶ compute deltas (24h, 7d)
     4. render newsletter HTML from template     (no inference)
     5. send via Mailer (Resend)                 
     6. persist today's snapshot + run record + artifact copy of the email
```

Failure posture is inherited from Daily-Brief: **every external call fails
open**. Kalshi unreachable → send the newsletter with last-known data clearly
stamped "as of <timestamp>" and an honest source-health note. A missing market
(expired/settled) → rendered in a "closed since last brief" section with its
settlement, then dropped from the resolution set. Nothing fatal.

### 3.2 Movement alerts (push, continuous)

```
watcher (in-app interval, e.g. every 15 min during market hours)
   │
   ▼
 for each profile's watched markets:
   1. fetch current price (batched; client-side rate limiter, §7)
   2. compare to reference price (see hygiene rules, §6)
   3. if |Δ| ≥ profile threshold AND hygiene rules pass:
        render alert email (template, raw data) ──▶ send ──▶ log alert
```

Alerts are **feed-shaped internally**: every alert is persisted as a structured
record (ticker, profile, prices, delta, timestamp) before it is an email. This
keeps the door open for other consumers of the alert stream later (including,
someday, Daily-Brief) without redesign.

---

## 4. What a subscriber receives

### Daily newsletter (per profile)

- **Header:** profile name, date, "as of" timestamp.
- **Movers:** markets with the largest 24h moves, sorted by |Δ|.
- **Watchlist table:** every followed market — title (with series/event context,
  §4.1), implied probability, 24h Δ, 7d Δ, volume, close date, link to the
  market page.
- **Closed since last brief:** settled markets and their outcomes.
- **Footer:** source-health note (any fetch degradation), unsubscribe/config
  pointer, and — matching Daily-Brief house style — a per-run cost line
  (≈ $0 in v1: the daily path spends no inference money; printed anyway so the
  discipline exists before the number is interesting).

### Alert email

One market per email. Title + context, previous → current probability, the move,
volume behind the move, link. Subject line pattern:
`[Market-Pulse] <profile>: <market short title> moved <±N> pts`.

### 4.1 The cryptic-title rule (no-AI fix)

Raw Kalshi market titles can be ambiguous out of context ("Will the ceiling be
raised before March 15?"). v1 solves this **without a model**: always store and
render the parent event/series title alongside the market title, plus the market
URL. AI title clean-up is explicitly out of scope for v1.

---

## 5. The v1 inference surface: market suggestion

The only model-backed capability in v1, behind the same `Engine` seam pattern as
Daily-Brief (provider/model env-configurable, fails open, kill-switched).

**Suggestion is two functions, not one:**

1. **Onboarding suggestion** — at profile creation: input = the operator's
   profile description + the current Kalshi series/event catalog (fetched live,
   filtered to open series). Output = a ranked list of suggested series tickers,
   each with a one-line "why this fits" rationale. The operator confirms a
   subset. Nothing is subscribed without confirmation.
2. **Recurring discovery** — weekly: input = profile description + series
   catalog *diff* (new since last pass). Output = candidate additions, delivered
   as a short section in that day's newsletter ("New markets you might want:
   …") with one-click-style confirm links into the admin UI. Again: suggest,
   never auto-add. (Series-based subscription already handles routine market
   churn without AI; discovery only covers genuinely *new* series.)

**Contract sketch** (frozen in `contracts/` like Daily-Brief's wire contracts):

```
suggest(profileDescription, catalog[, sinceCatalog]) ->
  [{ seriesTicker, title, rationale, confidence }]
```

Engine off or erroring → profile creation proceeds with an empty suggestion list
and a health note; the operator curates manually. Degrade, never block.

---

## 6. Alert hygiene (the real design work)

Detecting movement is trivial; not spamming is the feature. Rules, all
per-profile configurable with sane defaults:

- **Threshold:** minimum move, in probability points, vs. the reference price
  (default: 5 pts). Configurable per market-class if needed later (weather vs.
  macro), but v1 keeps one threshold per profile.
- **Reference price + hysteresis:** the reference is the price at last alert (or
  last daily brief if no alert yet). After an alert fires, the market **re-arms**
  only when price has stayed within a dead band (default: 2 pts) of the new
  reference for one full watcher cycle — so a market oscillating across the
  threshold doesn't machine-gun alerts.
- **Cooldown:** minimum time between alerts on the same market (default: 4 h),
  regardless of movement.
- **Daily cap:** max alert emails per profile per day (default: 5). Overflow is
  summarized in the next daily newsletter ("3 further alerts suppressed"),
  never silently dropped.
- **Quiet hours:** no alert *emails* between configurable hours (default
  22:00–07:00 operator-local); alerts detected during quiet hours are logged
  and folded into the morning newsletter.
- **Liquidity floor:** markets under a volume floor (default: $1k) never alert —
  thin markets jump around meaninglessly. They still appear in the daily table,
  flagged low-liquidity.

Every suppressed alert is still **logged** with its suppression reason, so
tuning these knobs is data-driven, not vibes-driven — the same
measure-before-investing discipline as Daily-Brief's YouTube fix.

---

## 7. Kalshi integration notes

- **Public, unauthenticated endpoints only** in v1:
  `https://external-api.kalshi.com/trade-api/v2` — markets, events, series,
  candlesticks. **No API key exists anywhere in v1.** This is a real security
  property: there is no credential whose leak enables trading.
- **Client-side rate limiting anyway:** token-bucket at a conservative fraction
  of published limits, request coalescing per watcher cycle, exponential backoff
  + jitter on 429/5xx, honor `Retry-After`. At v1 volume (one daily run + a
  15-min watcher over tens of markets) this is belt-and-suspenders — build it
  now, before volume makes it urgent.
- **Snapshot cache is the system of record for deltas.** Deltas are computed
  against *our own stored snapshots*, not re-fetched history — cheaper, and it
  makes the newsletter reproducible from local state.
- **Candlesticks** are fetched only for the weekly-delta column and cached with
  a long TTL.

---

## 8. Deployment architecture: lifted from Daily-Brief

This project adopts the Daily-Brief deployment doc's **reuse checklist**
wholesale. Stated here as decisions, not options:

1. **Compute:** one Docker container — TypeScript/Node 22 modular monolith
   (Fastify) — as a new Coolify app on **ec2-primary**. ARM-native build on the
   box; `better-sqlite3` pinned to the Node major in the Dockerfile base.
   Deploys via a copied `ops/deploy.sh`: capture rollback digest → Coolify API
   **redeploy (never restart for env changes)** → poll → verify `/healthz` →
   record digest.
2. **Edge:** new Cloudflare Tunnel public hostname (e.g.
   `market-pulse.seanmahoney.ai`) → `https://localhost:443` with **No TLS
   Verify ON** (the known traefik self-signed-cert requirement). DNS/tunnel
   creation is a manual dashboard step unless a scoped Cloudflare token is
   provisioned first — Daily-Brief's lesson, accepted as-is.
3. **State:** SQLite + files under one `/data` volume: `pulse.db` (profiles,
   subscriptions, snapshots, alert log, runs, suggestion history, admin
   sessions), `artifacts/<runId>/` (sent-email copies, self-contained HTML),
   `profiles/` seeded from repo on boot then runtime-owned. **Backup = copy the
   volume. Migrations are additive-only** so rollback is always safe. If volume
   creation via the Coolify API misbehaves, the known DB-row workaround applies
   — prefer the UI.
4. **Email out:** Resend behind the same `Mailer` interface. **Known constraint
   inherited:** the shared `onboarding@resend.dev` sender delivers only to the
   Resend account owner — which exactly covers v1's operator-as-subscriber.
   **Verifying a sending domain (SPF/DKIM/DMARC in Cloudflare DNS) is the
   explicit gate for any non-operator subscriber** and is staged as v1.5 (§9),
   not deferred indefinitely.
5. **Email in:** none. Market-Pulse has no inbound-mail surface — one less
   credential, one less poller.
6. **HTML:** all served from the app container — admin UI as server-rendered
   Fastify pages behind session auth; newsletter artifacts as self-contained
   HTML (inline CSS, zero external requests) that work from disk or inbox. No
   separate web host, no CDN.
7. **Secrets & flags:** Coolify env store only; gitignored
   `.verity/deploy-access.md` records credential *locations*; every capability
   ships behind a kill-switch defaulting OFF and the app refuses to boot with a
   flag ON but its secret missing. Ship dark, flip deliberately, smoke-test.
   v1 secret list is short: `TRIGGER_API_TOKEN`, `RESEND_API_KEY`,
   `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `ANTHROPIC_API_KEY` (suggestion
   engine only), Coolify API token, GitHub deploy key. **No Kalshi credential
   exists.**
8. **Fail-open everywhere:** engine or exchange unavailable → degraded output +
   honest health note, never a failed run. Cost printed wherever money is spent.
9. **No residential-egress need is anticipated** (Kalshi's API is built for
   programmatic access, unlike YouTube) — but if a future source proves
   datacenter-hostile, the Tailscale + CONNECT-proxy pattern is on the shelf,
   measured-before-built.

---

## 9. Version staging

| Version | Ships | Explicitly excluded |
|---|---|---|
| **v1** | Profiles + AI-suggested market lists (confirm-gated); series-based subscriptions; daily raw-data newsletter; movement alerts with full hygiene rules; admin UI; snapshot store; operator-only recipients | Narrative prose, any per-send inference, multi-subscriber delivery, trading, non-Kalshi sources |
| **v1.5** | Verified sending domain (SPF/DKIM/DMARC); multiple subscriber addresses per profile; unsubscribe handling | Public signup — subscribers are still operator-added |
| **v2** | Narrative summarization behind the Engine seam: per-profile prose ("traders moved 9 pts toward a September cut this week"), profile-framed like Daily-Brief's "why it matters" line; AI title clean-up | Cross-source analysis |
| **v3** | Additional exchanges (Polymarket, etc.) behind a `MarketSource` interface; cross-market comparison ("Kalshi says 63%, Polymarket 58%") | Trading |
| **vX (gated)** | Trading: separate authenticated layer, demo-env first, confirm-gated orders, server-side spend caps, human-in-the-loop always. Its own design doc before any code. | Autonomous trading — never a default |

The staging table is the honesty mechanism, same as Daily-Brief's: v1 claims
nothing it doesn't do.

---

## 10. Known risks

- **Thin-market noise.** Low-volume markets produce large meaningless swings.
  Mitigated by the liquidity floor and low-liquidity flags; residual risk is a
  subscriber over-reading a flagged number.
- **Series churn edge cases.** Series-based subscription absorbs most market
  turnover, but some Kalshi events are one-offs with no series. These subscribe
  as event tickers and simply age out via the "closed since last brief" path.
- **Suggestion quality.** The catalog is large; a weak suggestion pass produces
  irrelevant defaults. Confirm-gating bounds the blast radius to operator
  annoyance; suggestion history is logged so quality is measurable.
- **Interpretation risk.** Even raw numbers carry an implicit "the market knows
  something" framing. The newsletter includes a standing one-line footer
  disclaimer that prices are crowd estimates, not predictions or advice.
- **Rate-limit posture drift.** Kalshi's tiers/budgets can change; the
  client-side limiter is configured, not hardcoded, and 429 counts are a
  standing watch metric from day one.

---

## 11. Deliberately open questions

Design-time, not description-time — marked open on purpose:

1. **Watcher cadence vs. market hours.** Fixed 15-min interval always, or
   denser near market close / known event times? (Start fixed; let the alert
   log argue for more.)
2. **Per-market-class thresholds.** One threshold per profile is v1; whether
   weather vs. macro deserve different defaults is a tuning question the
   suppression log will answer.
3. **Alert delivery channel.** Email-only in v1; whether alerts eventually
   deserve a faster channel (push, SMS) is a v1.5+ question tied to real
   subscriber demand.
4. **The Daily-Brief bridge.** Alerts and daily statuses are persisted
   feed-shaped (§3.2) precisely so Daily-Brief *could* consume them as a source
   someday. Whether it ever does is a decision for after both systems have
   proven their own shape — per the siblings-not-a-merger principle.

---

## 12. Pointers (to create at repo init)

- `docs/adr/` — 0001 stack (inherit Daily-Brief rationale by reference), 0002
  storage, 0003 deploy target, 0004 email-out, 0005 alert hygiene, 0006
  suggestion engine.
- `contracts/` — trigger-api, snapshot, alert-record, newsletter-artifact,
  suggestion.
- `STATUS.md` — runtime truth: version, digest, flags, secret locations, watch
  items (429 count, suppression counts, suggestion acceptance rate).
- `.verity/deploy-access.md` — gitignored credential locations + committed
  pointer README.
- `docs/ui-smoke/stage-*.md` — per-stage operator smoke checklists, same
  ship-dark cadence.
