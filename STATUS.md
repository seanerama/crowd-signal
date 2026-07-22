# Crowd-Signal — Status & Handoff

> Runtime/ops truth (framework-spec §4.6). Owned by the **Release/Deploy Operator**,
> updated on every deploy. Records secret **locations** only — never values.

**As of:** 2026-07-22 — stage 1 built on branch, **not yet deployed**

## TL;DR

Version **0.1.0**. Stage 1 (walking skeleton) is built and green locally:
Fastify app on Node 22, config validation at boot, `GET /healthz` against a real
SQLite DB + migration check, stub `POST /trigger/daily` / `POST /trigger/discovery`
pipelines (runs row + self-contained HTML artifact, idempotent-per-day), CI gates
(lint/typecheck/build/test + fixed full-history secret scan), arm64-compatible
Dockerfile verified with a local container smoke test. **Deployment happens in a
later role — nothing is live.**

## Live deployment

- (none — first deploy pending)

## Images

- prefix: `ghcr.io/seanerama/crowd-signal`
- (no releases yet)

## Flags (kill-switches — all default OFF, all currently OFF)

| Flag | State | Required secret when ON |
| --- | --- | --- |
| `KALSHI_ENABLED` | OFF | — |
| `ADMIN_UI_ENABLED` | OFF | — |
| `MAILER_ENABLED` | OFF | `RESEND_API_KEY` |
| `WATCHER_ENABLED` | OFF | — |
| `SUGGEST_ENABLED` | OFF | `ANTHROPIC_API_KEY` |

Boot refuses (clear error, exit 1) if any flag is ON with its required secret
missing, or if `TRIGGER_API_TOKEN` is absent.

## Secrets

Names + LOCATIONS only, never values. All runtime secrets live in the **Coolify
env store** on the deploy target (see the committed pointer
`.verity/deploy-access.README.md`; access details are gitignored in
`.verity/deploy-access.md`).

- `TRIGGER_API_TOKEN` — required always — Coolify env store (not yet configured)
- `RESEND_API_KEY` — required when `MAILER_ENABLED=true` — Coolify env store (not yet configured)
- `ANTHROPIC_API_KEY` — required when `SUGGEST_ENABLED=true` — Coolify env store (not yet configured)

## Watch items

- (placeholder) first deploy: `/data` volume mount + redeploy persistence check
- (placeholder) better-sqlite3 native build on arm64 under Coolify build
- (placeholder) CI secret-scan runtime as history grows

## Coordination notes

- Stage 1 built on `feat/stage-1-walking-skeleton-boot-healthz-stub-trigger-pipeline-ci-gates-fi`; review + merge + deploy are later roles.
