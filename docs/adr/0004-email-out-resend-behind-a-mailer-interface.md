# 0004. Email out: Resend behind a Mailer interface

- **Status:** Accepted
- **Date:** 2026-07-22

## Context

Everything a subscriber receives is email: the daily newsletter and the movement
alerts. v1 recipients are the operator's own inbox only; multi-subscriber delivery
is explicitly staged at v1.5. The sibling project Daily-Brief already sends via
Resend behind a `Mailer` interface, and its known constraint is inherited: the
shared `onboarding@resend.dev` sender delivers **only to the Resend account owner**.

## Decision

- **Provider:** Resend, called through the app's own **`Mailer` interface** — no
  Resend types or calls outside the mailer module. The seam is where a future
  provider swap or a test double lives.
- **v1 sender:** `onboarding@resend.dev`, which exactly covers v1's
  operator-as-subscriber model. This constraint is a feature for v1: it makes
  accidentally emailing a stranger impossible.
- **v1.5 gate:** verifying a sending domain (SPF/DKIM/DMARC in Cloudflare DNS) is
  the explicit, non-negotiable gate for any non-operator recipient. Staged, not
  deferred indefinitely.
- **Every send is persisted first:** the newsletter as a run artifact, the alert as
  a structured alert record — email is a delivery of state, never the only copy.

## Alternatives considered

- **AWS SES:** viable and cheap at scale, rejected for v1 — new credentials and a
  sandbox-exit process for a volume of a few emails a day; the Resend account and
  its pattern already exist.
- **SMTP relay (e.g. via the EC2 box):** rejected. Deliverability from a bare EC2
  IP is a losing battle; not worth it for any volume.
- **Direct provider calls without a Mailer seam:** rejected — the seam costs one
  interface and buys provider portability, dry-run/test modes, and a single choke
  point for the send log.

## Consequences

- v1 cannot email anyone but the operator — by design; the staging table keeps the
  claim honest.
- v1.5's domain verification is DNS work in Cloudflare plus a sender switch behind
  the same interface; no application redesign.
- `RESEND_API_KEY` joins the short secret list (Coolify env store), behind a
  kill-switch that defaults OFF and refuses to boot ON-but-missing.
