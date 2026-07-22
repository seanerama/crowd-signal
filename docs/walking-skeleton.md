# Stage 0 — Walking Skeleton

> The thinnest end-to-end slice that compiles, runs, passes one real test, goes
> green in CI, and deploys. **Blocks all feature stages** — it proves the spine
> before anything rides it. (stack-and-topology guide; ADRs 0001–0003.)

## The slice

A Fastify app in one ARM64 Docker container that:

1. **Boots** with config validation: any kill-switch flag ON with its secret
   missing → refuse to boot (project-des §8.7). All flags default OFF.
2. **Serves `GET /healthz`** per the frozen trigger-api contract
   (`{ ok, version, db }`), with `db` proving a real `better-sqlite3` open +
   migration table check against `/data/pulse.db`.
3. **Serves `POST /trigger/daily`** with Bearer-token auth that runs a **stub
   pipeline**: create a run record in SQLite, write a minimal self-contained HTML
   artifact to `/data/artifacts/<runId>/`, return `202 { runId }`. No Kalshi, no
   Resend, no rendering logic yet — the seams exist, the pipeline is real, the
   content is placeholder.
4. **Passes one real test in CI**: an integration test that boots the app against
   a temp DB, calls `/trigger/daily` with the token, and asserts the run record
   and artifact exist. Plus the hygiene CI (lint, typecheck, build) already in
   `.github/workflows/ci.yml`.
5. **Builds an arm64 image** and **deploys via Coolify to ec2-primary**, `/data`
   volume mounted, `/healthz` verified from outside the box (through the tunnel
   hostname once DNS exists; via SSH curl until then).

## Definition of done

- CI green on main (lint + typecheck + build + the integration test).
- Image runs on ec2-primary under Coolify with the `/data` volume; survives a
  redeploy with state intact (run records persist).
- `curl -H "Authorization: Bearer $TRIGGER_API_TOKEN" -X POST .../trigger/daily`
  from outside produces a run record and artifact on the volume.
- `STATUS.md` updated with version, image digest, flag states, secret locations.

## Explicitly OUT of Stage 0

Kalshi fetch, snapshot deltas, real newsletter rendering, Resend sends, the
watcher/alert engine, admin UI, suggestion engine. Each arrives as a later stage
against the frozen contracts.

## Feature-stage inputs for /verity:plan

Design surface (each maps to one or more thin stages, all behind the frozen
contracts in `contracts/`):

1. KalshiSource: public-API client + token-bucket rate limiter + backoff (§7).
2. SnapshotStore + delta computation (contract: `snapshot`).
3. Profiles + series/event subscriptions + admin UI (session auth).
4. Newsletter renderer + Mailer(Resend) + artifact store (contract:
   `newsletter-artifact`; ADR 0004).
5. Alert watcher + hygiene rules + alert log (contract: `alert-record`; ADR 0005).
6. SuggestionEngine: onboarding + weekly discovery (contract: `suggestion`;
   ADR 0006).

## Drop-in feature decisions (Architect, 2026-07-22)

- **helper-bot (In-App Help Agent): DECLINED for v1.** v1 has no chat loop, one
  operator, and a deterministic daily path; prerequisites unmet by design.
  Revisit at v2 alongside narrative summarization (retrofit recipe).

## Version staging (the honesty table)

v1 scope, exclusions, and the v1.5/v2/v3 ladder are defined in
`project-des.md` §9 and bind planning: v1 claims nothing it doesn't do.
