# UI smoke — Stage 4: admin UI (profiles, subscriptions, session auth)

Manual operator flow proving the admin surface observably works on a live
deployment. Prereqs: `ADMIN_UI_ENABLED=true`, `ADMIN_PASSWORD` and
`ADMIN_SESSION_SECRET` set. Replace `https://HOST` with the deployment URL.

## 1. Log in

- Open `https://HOST/admin` while logged out.
  - **Observably works:** you are redirected to `https://HOST/admin/login`
    showing the "Crowd-Signal admin — log in" password form.
- Submit a wrong password once.
  - **Observably works:** the form re-renders with "Wrong password." (HTTP 401);
    you are not let in. (After 5 failures in 15 minutes the same form returns
    HTTP 429 "too many login attempts".)
- Submit the correct `ADMIN_PASSWORD`.
  - **Observably works:** you land on `https://HOST/admin` showing "Audience
    profiles" and a "Run history (latest 20)" table. The browser now holds an
    httpOnly `crowd_signal_admin` cookie scoped to `/admin`.

## 2. Create a profile

- Click **New profile** (`https://HOST/admin/profiles/new`).
  - **Observably works:** the create form shows name/description/recipients
    fields and the blue ADR 0004 notice that v1 delivers only to the
    operator's own Resend-account inbox.
- Enter name `Smoke Test`, any description, your email as recipient; submit.
  - **Observably works:** you are redirected to
    `https://HOST/admin/profiles/<id>` — the edit page titled
    "Profile: Smoke Test", with the hygiene editor pre-filled with ADR 0005
    defaults (threshold 5, dead band 2, cooldown 4, cap 5, quiet 22:00–07:00,
    floor 1000).

## 3. Add a series subscription

- On the profile page, in **Subscriptions**, enter ticker `KXHIGHCHI`, kind
  `series`, and click **Add subscription**.
  - **Observably works:** the page reloads and the subscriptions table lists
    `KXHIGHCHI` / `series` with an added-at timestamp and a Remove button.
  - Re-submitting the same ticker+kind is a documented no-op (idempotent): the
    table still shows exactly one `KXHIGHCHI` row.

## 4. Edit hygiene config

- Change **Threshold** to `7` and **Daily cap** to `3`; click **Save profile**.
  - **Observably works:** after the redirect the hygiene fields show 7 and 3
    (values persisted, not just echoed).
- Try an out-of-bounds value (e.g. threshold `99`).
  - **Observably works:** a "400 — invalid input" page names the offending
    field and bound; going back shows the previous saved values intact.

## 5. Log out

- Click **Log out** in the nav.
  - **Observably works:** you land on `https://HOST/admin/login`; visiting
    `https://HOST/admin` again redirects back to the login page.

## Kill-switch check

- With `ADMIN_UI_ENABLED` unset/false, `https://HOST/admin` and
  `https://HOST/admin/login` return **404** — the routes do not exist.
