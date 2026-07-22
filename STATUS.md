# Status & Handoff

> Runtime/ops truth (framework-spec §4.6). Generated from `.verity/runtime.json`
> by the Release/Deploy Operator. Secret LOCATIONS only — never values.

**Live version:** 0.2.0
**Deployed at:** 2026-07-22T (v0.2.0 + flag flip redeploy; login round-trip verified)
**Rollback from:** sha256:3f5e8ba9daecc2a3e987f8bd511b81f7629c261016aeed092fbb7d9063c727ae

## Environments
- **prod:** {"digest":"sha256:9a574dad1fd8247b8458d0f30b6b9a0c3ffde9a62c8b253667af1a062ccd4caf","url":"http://ue1khehsjcb77de7ulzbyl1u.34.207.137.224.sslip.io"}

## Secret locations (names + on-disk locations only, never values)
- TRIGGER_API_TOKEN @ Coolify env store (app ue1khehsjcb77de7ulzbyl1u); local copy .verity/deploy.env
- COOLIFY_API_TOKEN @ .verity/deploy.env (copied from dev-server ~/nsaf/.env)
- RESEND_API_KEY @ not yet provisioned (needed when MAILER_ENABLED flips)
- ANTHROPIC_API_KEY @ not yet provisioned (needed when SUGGEST_ENABLED flips)
- ADMIN_PASSWORD @ Coolify env store (app ue1khehsjcb77de7ulzbyl1u); local copy .verity/deploy.env
- ADMIN_SESSION_SECRET @ Coolify env store; local copy .verity/deploy.env

## Coordination notes
- Smoke gate passed (healthz flow, verified:true) + behavior checks: 401 unauth, 202 runId, idempotent alreadyRan across redeploy (volume persistence proven)
