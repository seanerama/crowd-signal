# 0006. Suggestion engine: the only v1 inference surface, behind an Engine seam

- **Status:** Accepted
- **Date:** 2026-07-22

## Context

v1 is **deterministic on the daily path**: everything a subscriber receives is
template-rendered data — no model calls, no hallucination surface, no per-send
inference cost. The one place AI earns its keep in v1 is mapping an operator's
plain-language profile description onto Kalshi's large series/event catalog.

## Decision

Market suggestion is the **only** model-backed capability in v1, behind the same
`Engine` seam pattern as Daily-Brief (provider/model env-configurable, fails open,
kill-switched). It is two functions, one frozen contract (`contracts/suggestion`):

1. **Onboarding suggestion** — at profile creation: profile description + live
   catalog (open series) → ranked suggested series tickers, each with a one-line
   rationale and confidence. Operator confirms a subset; **nothing is subscribed
   without confirmation**.
2. **Recurring discovery** — weekly: profile description + catalog **diff** (new
   since last pass) → candidate additions, delivered as a newsletter section with
   confirm links into the admin UI. Suggest, never auto-add.

Failure posture: Engine off or erroring → profile creation proceeds with an empty
suggestion list and a health note; the operator curates manually. Degrade, never
block. Suggestion history is logged so quality (acceptance rate) is measurable.
Cost is printed wherever inference money is spent.

## Alternatives considered

- **No AI at all (manual curation only):** viable — the system works without it —
  but the catalog is large and the suggestion pass is cheap, confirm-gated, and
  cleanly severable. Kept.
- **AI in the daily render path (narrative summaries, title clean-up):** rejected
  for v1, explicitly staged at v2 behind the same Engine seam. The cryptic-title
  problem gets the no-AI fix (always render parent event/series title + URL).
- **Embedding/vector search over the catalog instead of an LLM pass:** rejected
  for v1 — a second inference-adjacent system for a weekly batch job; a single
  ranked-list prompt is simpler and its quality is measured before more is built.

## Consequences

- `ANTHROPIC_API_KEY` exists only for this engine, behind a kill-switch defaulting
  OFF; the app boots and runs fully with the engine dark.
- The `suggest(profileDescription, catalog[, sinceCatalog])` contract freezes now;
  v2 narrative work will be a **new** contract, not an edit.
- Suggestion acceptance rate becomes a STATUS.md watch item from day one.
