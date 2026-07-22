# 0003. Deployment target: Coolify app on ec2-primary (ARM64)

- **Status:** Accepted
- **Date:** 2026-07-22

## Context

The operator's global deployment catalog (`~/.verity/deployment-methods.md`) offers
four configured methods: Cloudflare Pages, the NSAF dev server over SSH, Coolify
PaaS, and the AWS EC2 web server `ec2-primary`. Crowd-Signal is a long-running
stateful container (SQLite volume, in-process watcher loop) that needs cron-reachable
HTTP endpoints and outbound email — and its sibling Daily-Brief already runs the
identical pattern successfully.

## Decision

Deploy as a **new Coolify-managed app on ec2-primary** (Coolify itself runs on that
box). Specifics, inherited deliberately from Daily-Brief's deployment doc:

- **Image:** single Docker container, **ARM64-native** build on the Graviton box
  (t4g.medium), `better-sqlite3` pinned to the Node major in the Dockerfile base.
- **Deploys:** `ops/deploy.sh` — capture rollback digest → Coolify API **redeploy
  (never restart for env changes)** → poll → verify `/healthz` → record digest.
- **Edge:** Cloudflare Tunnel public hostname (planned: `crowd-signal.seanmahoney.ai`)
  → `https://localhost:443` with **No TLS Verify ON** (traefik self-signed cert).
  DNS/tunnel creation is a manual dashboard step unless a scoped Cloudflare token is
  provisioned first.
- **State:** one Coolify volume mounted at `/data` (ADR 0002).
- **Secrets:** Coolify env store only; locations documented in the gitignored
  `.verity/deploy-access.md`.

## Alternatives considered

- **Cloudflare Pages / Workers:** rejected. Static/edge platform — no persistent
  SQLite volume, no long-running in-process watcher loop. Wrong shape despite the
  tooling being installed locally.
- **NSAF dev server over SSH:** rejected. The catalog itself marks Coolify as the
  home for *promoted* apps; the dev box is not a production home, and Coolify
  explicitly does not depend on it being up.
- **Raw docker compose on ec2-primary (no Coolify):** viable — other sites on the
  box run this way — but rejected: Coolify gives the redeploy API, env store, and
  rollback flow that `deploy.sh` and the Verity ship stage build on.
- **A new dedicated VM / managed PaaS (Fly, Render):** rejected for v1. New spend
  and a new ops surface for a service sized in tens of MB of RAM; ec2-primary has
  headroom if the app stays lean (which the host's ~3.7 GB RAM enforces as a
  design constraint anyway).

## Consequences

- CI must produce (or the box must build) **arm64** images — an amd64-only image is
  a hard failure on this host.
- Memory frugality is a standing constraint on dependency choices.
- The app shares a host with other sites: resource limits and lean images are
  expected, and a host outage takes multiple properties down together (accepted for
  a single-operator service).
- `/verity:ship` consumes this target via `.verity/deploy-access.md`.
