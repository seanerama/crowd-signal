# UI smoke — Stage 5: daily newsletter (renderer, Mailer/Resend, artifacts, trigger)

Manual operator flow proving the core daily loop observably works on a live
deployment. Prereqs: `TRIGGER_API_TOKEN` set; `KALSHI_ENABLED=true`;
`ADMIN_UI_ENABLED=true` with its secrets; at least one **active** profile with
a subscription (e.g. series `KXHIGHCHI`) and your own email as recipient
(ADR 0004: v1 delivers only to the Resend account owner's inbox). Replace
`https://HOST` with the deployment URL.

## 1. Arm the mailer (kill-switch)

- Set `MAILER_ENABLED=true` **and** `RESEND_API_KEY` in the env store; redeploy.
  - **Observably works:** the app boots. (Sanity: with `MAILER_ENABLED=true`
    but no `RESEND_API_KEY`, the app must REFUSE to boot with a config error —
    check once, then restore the key.)

## 2. Trigger a run

```sh
curl -i -X POST https://HOST/trigger/daily \
  -H "Authorization: Bearer $TRIGGER_API_TOKEN"
```

- **Observably works:** an immediate `202` with `{ "runId": ..., "startedAt":
  ... }` — the reply does NOT wait for the pipeline (async per
  contracts/trigger-api.md).
- Repeat the same curl.
  - **Observably works:** `200` with `{ "runId": <same id>, "alreadyRan": true }`
    — idempotent-per-day. Add `-d '{"force":true}' -H 'content-type:
    application/json'` to force a fresh run.

## 3. Watch run history

- Open `https://HOST/admin` (log in if needed) and find the run in
  **Run history**.
  - **Observably works:** the new run appears, status moves from `running` to
    `completed` (refresh), and the **Artifacts** column shows a link named
    after your profile id.

## 4. Open the artifact

- Click the artifact link (`/admin/artifacts/<runId>/<profileId>`).
  - **Observably works:** the sent newsletter renders — header with profile
    name/date/"as of", Movers (when any market moved), the Watchlist table
    with every followed market showing its event/series context next to the
    title, and the footer with the disclaimer ("Prices are crowd estimates,
    not predictions or advice.") and the `Run cost: $0.0000` line. No images,
    no scripts — the page is fully self-contained.

## 5. Receive the email

- Check the Resend account owner's inbox.
  - **Observably works:** an email with subject
    `[Crowd-Signal] <profile> daily — <YYYY-MM-DD>` whose body is the same
    newsletter you saw in step 4.

## Degraded-path check (Kalshi unreachable)

- Simulate an outage: temporarily set `KALSHI_API_BASE` to an unreachable URL
  (e.g. `https://127.0.0.1:9`), redeploy, and force a run.
  - **Observably works:** the trigger still returns `202`; the run finishes as
    `degraded` (not stuck `running`, no crash); the artifact still exists and
    shows the yellow "Some prices are last-known values" note in the header,
    `stale` badges on rows, and `kalshi unreachable; serving last-known data`
    in the footer's source-health line, with the "as of" timestamp honestly
    showing the OLD fetch time. The email (if any recipients) carries the same
    stale-stamped HTML. Restore `KALSHI_API_BASE` afterwards.

## Dry-run + kill-switch checks

- `curl ... -d '{"force":true,"dryRun":true}' -H 'content-type:
  application/json'`.
  - **Observably works:** run completes, artifact appears in admin, but NO
    email arrives (logs show "mailer dry-run").
- With `MAILER_ENABLED` unset/false (and any `RESEND_API_KEY` ignored), force
  a run.
  - **Observably works:** same — pipeline runs, artifact persists, nothing is
    sent.
