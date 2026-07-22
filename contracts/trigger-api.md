# Contract: trigger-api

- **Status:** frozen v1
- **Owner:** HTTP module (Fastify app) — consumed by external cron and operators

## Exposes

- `GET /healthz` — unauthenticated liveness/readiness.
- `POST /trigger/daily` — starts the daily newsletter run for all active profiles.
- `POST /trigger/discovery` — starts the weekly suggestion-discovery pass
  (results delivered as a section in that day's newsletter, per ADR 0006).

Trigger endpoints are idempotent-per-day by default: a repeat call on a day that
already has a completed run returns the existing run instead of re-sending, unless
`force: true`.

## Consumes

- `TRIGGER_API_TOKEN` from the environment (Coolify env store).
- The run pipeline (snapshot fetch → delta → render → mail → persist).

## Schema / wire

Auth: `Authorization: Bearer <TRIGGER_API_TOKEN>` on all `/trigger/*` routes.
401 on missing/bad token. No cookies, no CSRF surface on this path.

```
GET /healthz -> 200
{ "ok": true, "version": "<semver>", "db": "ok" | "error" }

POST /trigger/daily
  body (optional): { "profileId"?: string, "force"?: boolean, "dryRun"?: boolean }
-> 202 { "runId": string, "startedAt": string(ISO-8601) }
-> 200 { "runId": string, "alreadyRan": true }        // idempotent repeat
-> 401 | 500 { "error": string }

POST /trigger/discovery
  body (optional): { "profileId"?: string, "force"?: boolean }
-> 202 { "runId": string, "startedAt": string(ISO-8601) }
-> 200 { "runId": string, "alreadyRan": true }
-> 401 | 500 { "error": string }
```

Runs execute async after the 202; outcome is recorded in the `runs` table and
visible in the admin UI. A run that degrades (Kalshi unreachable, mailer down)
still completes with health notes — fail open, never fatal (project-des §3.1).

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
