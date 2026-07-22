# Assessment: initial v1 decomposition (Mode A)

- **Date:** 2026-07-22
- **Input:** `project-des.md` (vision), ADRs 0001–0006, `docs/walking-skeleton.md`,
  five frozen contracts
- **Decision:** ACCEPT as seven stages (below). Nothing rejected; the deferred set
  is the version-staging table itself (project-des §9), which binds this backlog.

## Claim/reality verification (against the live repo, 2026-07-22)

| Claim | Reality |
|---|---|
| Scaffold + ADRs + contracts committed and pushed | Confirmed (`seanerama/crowd-signal`, commit 6e37049) |
| No application code exists yet | Confirmed — no `src/`, no `package.json` |
| Hygiene CI green | **False.** Run 29927557602 failed: gitleaks scanned range `<root>^..HEAD` on the initial push; the root commit has no parent → git "unknown revision". Not a leak ("no leaks found in partial scan"). Fix assigned to Stage 1. |
| Five contracts frozen and buildable-against | Confirmed |

## The backlog (dependency-ordered)

| Stage | Type | Depends | Rationale for the cut |
|---|---|---|---|
| 1 Walking skeleton | chore | — | Proves spine (boot, healthz, stub trigger, CI gates incl. gitleaks fix, first deploy). Blocks everything — kills "9 stages before CI ran" at the root. |
| 2 KalshiSource | feature | 1 | The only external read dependency; isolated so its manners (limiter, backoff, normalization) are testable without any product logic. |
| 3 SnapshotStore + deltas | feature | 2 | The delta system-of-record; separated from rendering so delta math gets its own tests. |
| 4 Profiles + admin UI | feature | 1 | Parallel-safe with 2/3 (only needs the spine). Manual curation must work with zero AI. |
| 5 Daily newsletter | feature | 3,4 | The core loop; converges the two branches; carries the pipeline test. |
| 6 Alert watcher | feature | 5 | Needs Mailer (5); hygiene decision function is the stage's heart, pure + fake-clocked. |
| 7 SuggestionEngine | feature | 5 | Needs admin (4, transitively) and the newsletter's discovery section (5). Last because v1 works fully without it — severability proven by ordering. |

## Contract safety

- No frozen contract is threatened; every stage implements or additively extends
  the five existing contracts. No new seams introduced by this decomposition —
  internal interfaces (KalshiSource, Mailer, Engine) live in code and ADRs; they
  become contracts only if a second consumer outside the monolith appears.
- Split rationale (5 vs 6 vs 7): each is independently shippable behind its own
  kill-switch (`MAILER_ENABLED`, `WATCHER_ENABLED`, `SUGGEST_ENABLED`) and each
  rides a different frozen contract.

## Deferred (bound by project-des §9 — not stages, by design)

Multi-subscriber delivery + domain verification (v1.5); narrative prose + AI title
clean-up (v2); non-Kalshi sources (v3); trading (vX, own design doc first).
Helper-bot catalog feature: declined for v1 (Architect, 2026-07-22).
