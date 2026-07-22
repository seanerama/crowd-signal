# Changelog

## 0.2.0

### Chores
- sync package version to 0.2.0 ahead of release (healthz self-report drift — STATUS watch item)

### Other
- Stage 5: daily newsletter — renderer, Mailer (Resend), artifact store, async trigger pipeline (#12)
- Stage 3: SnapshotStore persistence + 24h/7d delta computation (#11)
- Stage 4: profiles, series/event subscriptions, admin UI with session auth (#10)
- Stage 2: KalshiSource — public API client, token-bucket limiter, backoff (#9)
- Ship v0.1.2: first prod deploy recorded — STATUS runtime truth, playwright smoke dep

## 0.1.2

### Fixes
- upgrade fastify to 5.10 (CVE-2026-25223, CVE-2026-33806) + error-handler typing

## 0.1.1

### Fixes
- pin trivy-action to resolvable tag v0.36.0

## 0.1.0

### Other
- Ship tooling: release.yml (verify+trivy+release), ops/deploy.sh, smoke flow
- Stage 1: walking skeleton — boot validation, healthz, stub trigger pipeline, CI gates (#8)
- Plan: initial v1 backlog — stages 1-7 specs + decomposition assessment
- Architect: ADRs 0001-0006, frozen v1 contracts, walking-skeleton definition
- Initial commit — scaffolded by Verity
