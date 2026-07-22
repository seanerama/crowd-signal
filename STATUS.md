# Status & Handoff

> Runtime/ops truth (framework-spec §4.6). Generated from `.verity/runtime.json`
> by the Release/Deploy Operator. Secret LOCATIONS only — never values.

**Live version:** 0.1.2
**Deployed at:** 2026-07-22T15:46Z (first deploy; redeploy-verified 15:50Z)
**Rollback from:** sha256:feb6ff72d8da20721fa6f4dc9dc77a97194db1d44383cacb9d77d91c901110d0

## Environments
- **prod:** {"digest":"sha256:1f394d738f6cd2007326af670f92aa5f84f8200c1a65ed1c554ef9d0a28f3495","url":"http://ue1khehsjcb77de7ulzbyl1u.34.207.137.224.sslip.io"}

## Secret locations (names + on-disk locations only, never values)
- TRIGGER_API_TOKEN @ Coolify env store (app ue1khehsjcb77de7ulzbyl1u); local copy .verity/deploy.env
- COOLIFY_API_TOKEN @ .verity/deploy.env (copied from dev-server ~/nsaf/.env)
- RESEND_API_KEY @ not yet provisioned (needed when MAILER_ENABLED flips)
- ANTHROPIC_API_KEY @ not yet provisioned (needed when SUGGEST_ENABLED flips)

## Coordination notes
- Smoke gate passed (healthz flow, verified:true) + behavior checks: 401 unauth, 202 runId, idempotent alreadyRan across redeploy (volume persistence proven)
