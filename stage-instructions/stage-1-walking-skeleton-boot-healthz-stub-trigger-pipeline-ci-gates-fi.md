# Stage 1: Walking skeleton: boot, healthz, stub trigger pipeline, CI gates, first deploy

- **Type:** chore
- **Depends on:** none

## Objectives

Prove the spine end-to-end per `docs/walking-skeleton.md`: a TypeScript/Node 22
Fastify app (ADR 0001) in one ARM64 container that boots with config validation,
answers `/healthz` against a real SQLite database, runs a stub daily-trigger
pipeline, passes one real integration test in CI, and deploys via Coolify to
ec2-primary with the `/data` volume. Blocks all feature stages.

## What to build

- `package.json` (Node 22, pinned deps, committed lockfile), `tsconfig.json`,
  ESLint config; `src/` skeleton: `src/app.ts` (Fastify), `src/config.ts`,
  `src/db.ts` (better-sqlite3 + additive migration runner), `src/routes/health.ts`,
  `src/routes/trigger.ts`.
- Config validation at boot: every kill-switch flag defaults OFF; any flag ON with
  its secret missing → refuse to boot (project-des §8.7).
- `GET /healthz` → `{ ok, version, db }` per `contracts/trigger-api.md`; `db`
  proves a real DB open + migration-table check.
- `POST /trigger/daily` (Bearer `TRIGGER_API_TOKEN`, 401 otherwise): stub pipeline —
  create a `runs` row, write a minimal self-contained HTML artifact to
  `/data/artifacts/<runId>/`, return `202 { runId, startedAt }`; idempotent-per-day
  (200 `alreadyRan`) per contract. No Kalshi, no Resend, no real rendering.
- `Dockerfile` (arm64-compatible base pinned to the Node major — better-sqlite3
  native build), `.dockerignore`.
- CI: extend `.github/workflows/ci.yml` with lint + typecheck + build + test jobs
  (the progressive gate the scaffold comments promise). **Fix the gitleaks
  root-commit failure** (run 29927557602): the push range `<root>^..HEAD` is
  invalid on initial pushes — scan full history on push (`gitleaks detect` over
  the checkout) or otherwise make the secret-scan honest AND green.
- First deploy: Coolify app on ec2-primary per `.verity/deploy-access.md`
  (gitignored) + ADR 0003; `/data` volume mounted.

## Interface contracts

- **Exposes:** the running app spine + DB/migration layer + artifact directory
  layout that every later stage extends; CI gates all later PRs ride.
- **Consumes:** `contracts/trigger-api.md` (healthz + trigger shapes — implement
  exactly; stub is behind the contract, not beside it).

## Testing requirements

- Integration test (real, in CI): boot app against a temp DB, `POST /trigger/daily`
  with the token → assert 202 + runs row + artifact file exist; repeat call →
  200 `alreadyRan`; missing/bad token → 401.
- Unit: config validation (flag ON + secret missing → boot refusal).

## Acceptance conditions

- [ ] Clear exit-state defined (what "done" means here): CI green on main (lint,
      typecheck, build, integration test, honest secret-scan); arm64 image deployed
      on ec2-primary under Coolify; `/healthz` verified from outside; a triggered
      run survives a redeploy (run row + artifact persist on the volume);
      STATUS.md updated with version/digest/flags/secret locations.
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
