# Stage 5: Daily newsletter: renderer, Mailer (Resend), artifact store, trigger pipeline

- **Type:** feature
- **Depends on:** 3,4

## Objectives

Replace the Stage 1 stub with the real daily path — the product's core loop:
resolve subscriptions → fetch snapshots → compute deltas → render the
self-contained newsletter → send via Mailer → persist snapshot + run record +
artifact (project-des §3.1). Deterministic: zero inference, template-rendered
data only. Every external call fails open.

## What to build

- `src/pipeline/daily.ts`: the real run behind `POST /trigger/daily` for each
  active profile, per the flow in §3.1; honest degradation (Kalshi unreachable →
  last-known data stamped "as of", source-health note; mailer down → artifact
  still persisted, run marked degraded).
- `src/render/`: newsletter template per `contracts/newsletter-artifact.md` —
  exact section order, inline CSS, zero external requests; cryptic-title rule
  (event/series title always beside market title, §4.1); standing disclaimer and
  per-run cost line (≈ $0, printed anyway) in the footer.
- `src/mailer/`: `Mailer` interface + Resend implementation (ADR 0004) + dry-run
  implementation for tests/`dryRun: true`. Subject:
  `[Crowd-Signal] <profile> daily — <date>`.
- Artifact store: `artifacts/<runId>/<profileId>.html` + `manifest.json`
  (RunManifest, exact contract shape). The mailer sends the persisted HTML.
- Admin: run history page gains artifact preview links (view sent HTML).

## Interface contracts

- **Exposes:** the complete daily pipeline; `Mailer` consumed by Stage 6;
  renderer sections extended (additively) by Stages 6/7.
- **Consumes:** `contracts/trigger-api.md`, `contracts/snapshot.md`,
  `contracts/newsletter-artifact.md` (all frozen — implement exactly);
  KalshiSource (2), SnapshotStore (3), profiles (4).

## Testing requirements

- Integration (the pipeline test): temp DB + mock Kalshi + dry-run mailer →
  trigger → assert snapshot rows, RunManifest, artifact HTML (self-contained: no
  `http` refs), correct sections and deltas; degraded path (Kalshi 500s) →
  run completes with health note and stale stamps.
- Unit: renderer section ordering/omission, movers sort by |Δ|, closed-section
  content.
- Contract test: manifest validates against `contracts/newsletter-artifact.md`.
- UI-smoke `docs/ui-smoke/stage-5.md`: operator triggers a run, opens the
  artifact from admin, receives the email in their inbox.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature —
      `MAILER_ENABLED` (OFF → pipeline runs, artifacts persist, no send; boot
      refuses ON-with-missing `RESEND_API_KEY`).
- [ ] UI-smoke "observably-works" check authored for any user-facing surface —
      `docs/ui-smoke/stage-5.md`.
- [ ] Additive migration only (no destructive schema change)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: YES
