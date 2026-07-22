# Stage 7: SuggestionEngine: onboarding suggestions + weekly discovery

- **Type:** feature
- **Depends on:** 5

## Objectives

The only model-backed capability in v1 (ADR 0006), behind the `Engine` seam:
onboarding suggestions at profile creation and weekly discovery over the catalog
diff, both **confirm-gated** — nothing is ever subscribed without the operator.
Fails open: engine dark/erroring → empty list + health note, never a block.

## What to build

- Additive migrations: `suggestion_history` (profileId, mode, catalog size,
  suggestions offered, accepted subset, costUsd, timestamp — acceptance rate is a
  STATUS.md watch item), `catalog_seen` (series tickers seen per profile, for the
  discovery diff).
- `src/engine/`: provider/model env-configurable client (Anthropic first),
  `suggest(profileDescription, catalog[, sinceCatalog]) -> SuggestionResult`
  per `contracts/suggestion.md` exactly; cost computed and returned
  (printed wherever money is spent).
- Onboarding flow (admin, Stage 4 pages extended): profile create/edit gains
  "suggest markets" → ranked list with rationale + confidence → operator checks a
  subset → subscriptions created. Engine dark → manual curation with health note.
- Discovery flow: `POST /trigger/discovery` (contract already frozen) computes
  the catalog diff per profile, calls the engine, stores results; the next daily
  newsletter renders the "New markets you might want" section with confirm links
  into the admin UI (session-authed confirm, additive renderer section).
- Catalog fetch (open series) via KalshiSource.

## Interface contracts

- **Exposes:** `SuggestionEngine` (the Engine seam v2 narrative work will sit
  beside — not modify).
- **Consumes:** `contracts/suggestion.md`, `contracts/trigger-api.md`
  (`/trigger/discovery`), `contracts/newsletter-artifact.md` (discovery section)
  — all frozen; KalshiSource (2), profiles/admin (4), renderer (5).

## Testing requirements

- Unit: catalog-diff computation; prompt-input assembly; cost calculation;
  fail-open (client throws → `suggestions: []` + healthNote; kill-switch OFF →
  same, no network).
- Integration: mock engine → onboarding confirm flow creates exactly the checked
  subscriptions; discovery run → history row + newsletter section with working
  confirm links; profile creation with engine down proceeds cleanly.
- Contract test: SuggestionResult shape per `contracts/suggestion.md`.
- UI-smoke `docs/ui-smoke/stage-7.md`: operator creates a profile with the real
  engine ON, sees ranked suggestions with rationales, confirms two, cost line
  visible; flips engine OFF, creates another profile, sees the health note.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature —
      `SUGGEST_ENABLED` (boot refuses ON-with-missing `ANTHROPIC_API_KEY`).
- [ ] UI-smoke "observably-works" check authored for any user-facing surface —
      `docs/ui-smoke/stage-7.md`.
- [ ] Additive migration only (no destructive schema change)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
