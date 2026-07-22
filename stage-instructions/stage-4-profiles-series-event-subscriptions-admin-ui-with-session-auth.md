# Stage 4: Profiles, series/event subscriptions, admin UI with session auth

- **Type:** feature
- **Depends on:** 1

## Objectives

The operator's control surface: audience profiles (the unit of curation and
delivery), series/event subscriptions, and a server-rendered Fastify admin UI
behind session auth (ADR 0001; project-des §2). Suggestion hooks arrive in
Stage 7 — this stage is manual curation, fully usable without any AI.

## What to build

- Additive migrations: `profiles` (name, description, recipient emails, hygiene
  config with ADR 0005 defaults, active flag), `subscriptions` (profileId,
  ticker, kind: series|event, addedAt), `admin_sessions`.
- `src/admin/` server-rendered pages (inline CSS, no client build): login
  (`ADMIN_PASSWORD`, session cookie signed with `ADMIN_SESSION_SECRET`, httpOnly,
  secure, sameSite=lax; rate-limited login attempts), profile list/create/edit,
  subscription add/remove (ticker + kind entry; live catalog search can come with
  Stage 7 — manual ticker entry is enough here), hygiene-config editor with
  defaults, run history list (reads `runs` from Stage 1).
- `profiles/` seed directory: seeded from repo on first boot, runtime-owned after
  (ADR 0002).
- Recipient constraint noted in UI: v1 delivers only to the operator's Resend
  account inbox (ADR 0004) — the form says so instead of silently failing later.

## Interface contracts

- **Exposes:** profile + subscription read model consumed by Stages 5/6/7;
  admin session auth other admin surfaces reuse.
- **Consumes:** app spine + `runs` table (Stage 1). No frozen-contract changes.

## Testing requirements

- Integration: login (wrong password rejected, rate limit), authenticated CRUD on
  profiles/subscriptions, unauthenticated request → redirect to login.
- Unit: hygiene-config validation (defaults applied, bounds enforced).
- UI-smoke asset `docs/ui-smoke/stage-4.md`: operator logs in, creates a profile,
  adds a series subscription, sees it listed.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature —
      `ADMIN_UI_ENABLED`; OFF → admin routes 404; boot refuses ON-with-missing
      `ADMIN_PASSWORD`/`ADMIN_SESSION_SECRET`.
- [ ] UI-smoke "observably-works" check authored for any user-facing surface —
      `docs/ui-smoke/stage-4.md`.
- [ ] Additive migration only (no destructive schema change)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
