# 0002. Storage: SQLite + file artifacts on a single /data volume

- **Status:** Accepted
- **Date:** 2026-07-22

## Context

Crowd-Signal's state is small and single-writer: audience profiles, series/event
subscriptions, daily market snapshots, the alert log (fired *and* suppressed, with
reasons), run records, suggestion history, and admin sessions. The daily newsletter's
deltas are computed against **our own stored snapshots** — the snapshot cache is the
system of record for movement, which makes every newsletter reproducible from local
state without re-fetching history. Sent emails are also archived as self-contained
HTML artifacts.

## Decision

- **SQLite via `better-sqlite3`** in `/data/pulse.db` — profiles, subscriptions,
  snapshots, alert log, runs, suggestion history, admin sessions.
- **Files under the same `/data` volume:** `artifacts/<runId>/` (sent-email copies,
  self-contained HTML) and `profiles/` (seeded from repo on first boot, runtime-owned
  thereafter).
- **Backup = copy the volume.** One directory captures the entire system state.
- **Migrations are additive-only** so a rollback to a previous image is always safe
  against a newer schema.

## Alternatives considered

- **Postgres (managed or containerized):** rejected for v1. A second container/
  service on a 3.7 GB host, a credential to manage, and network-attached state — all
  for a single-writer workload SQLite handles trivially. Revisit only if
  multi-instance writes ever become real.
- **Snapshot deltas from Kalshi candlestick history instead of a local store:**
  rejected. More API calls per run, newsletter no longer reproducible offline, and
  the fail-open posture ("send with last-known data") requires a local store anyway.
- **Artifacts in object storage (R2/S3):** rejected for v1. The volume-copy backup
  story is the simplicity win; artifacts are small HTML files.

## Consequences

- Single-writer constraint is real: the app is one process by design (ADR 0001);
  the watcher and daily run share the DB through one connection layer.
- Additive-only migrations require occasional tolerated cruft (unused columns)
  in exchange for always-safe rollback.
- If the Coolify API misbehaves creating the volume, the known workaround is to
  prefer the UI (inherited Daily-Brief lesson, recorded in project-des §8.3).
