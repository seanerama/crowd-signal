# 0001. Stack & topology: TypeScript Node 22 modular monolith (Fastify)

- **Status:** Accepted
- **Date:** 2026-07-22

## Context

Crowd-Signal is a single-operator service: a cron-triggered daily newsletter run, an
in-app watcher loop for movement alerts, and a small server-rendered admin UI. It is
the deliberate sibling of Daily-Brief — shared architectural DNA and deployment
patterns, zero shared runtime systems. The operator already runs and maintains a
TypeScript/Node/Fastify system of the same shape, and the host (ec2-primary,
t4g.medium, ~3.7 GB RAM) rewards lean single-container deployments.

## Decision

- **Language/runtime:** TypeScript on Node 22, dependencies pinned, lockfile
  committed from day one.
- **Framework:** Fastify — HTTP API (trigger endpoints, healthz) plus
  server-rendered admin pages behind session auth. No SPA, no separate frontend
  build; newsletter artifacts are self-contained HTML (inline CSS, zero external
  requests).
- **Topology:** modular monolith in one Docker container. Internal module seams
  (KalshiSource, SnapshotStore, AlertEngine, Mailer, SuggestionEngine, AdminUI) are
  enforced by frozen contracts (see `contracts/`), not process boundaries.
- **Background work:** the daily run is externally cron-triggered
  (`POST /trigger/daily`, token-authenticated); the alert watcher is an in-process
  interval loop. No queue, no worker fleet.

## Alternatives considered

The stack-and-topology guide recommends exactly this lean (boring stack,
server-rendered first, modular monolith) — guide and project agree, so this ADR
records concurrence rather than deviation.

- **Multi-service (separate watcher/API containers):** rejected. Each service
  multiplies the CI matrix, image set (`ghcr.io/seanerama/crowd-signal-<service>`),
  and deploy surface; v1 volume (one daily run + a 15-minute watcher over tens of
  markets) fits comfortably in one process on a 3.7 GB host.
- **SPA admin UI (React/Vite):** rejected. Operator-only UI with tables and forms;
  server-rendered pages have fewer moving parts and no blank-page build failures.
- **Python (shared with data-science tooling):** rejected. The operator's proven
  ops patterns (Dockerfile, deploy.sh, better-sqlite3 pinning) are Node-shaped;
  reuse beats novelty.

## Consequences

- One image, one CI job, one deploy — the whole Verity pipeline stays simple.
- A future split (e.g. the watcher as its own service) is a real migration, but the
  contract seams are drawn now so a split would follow existing boundaries.
- `better-sqlite3` is a native module: the Dockerfile base must pin the Node major
  and build ARM-native on the box (see ADR 0003).
