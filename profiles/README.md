# profiles/ — seed directory

Audience-profile seed files (ADR 0002: "seeded from repo on first boot,
runtime-owned thereafter").

## How seeding works

On boot, **if and only if** the database contains zero profiles, every `*.json`
file in this directory is inserted as a profile (plus its listed
subscriptions). After that first boot the database owns the rows — editing or
deleting files here never touches an existing database, and a non-empty
database is never re-seeded. Invalid seed files are skipped with a warning at
boot, not a crash.

## File format

One profile per `*.json` file:

```json
{
  "id": "optional-stable-id",
  "name": "Required display name",
  "description": "Optional free text",
  "recipients": ["operator@example.com"],
  "active": false,
  "hygiene": { "thresholdPts": 5 },
  "subscriptions": [{ "ticker": "KXHIGHCHI", "kind": "series" }]
}
```

- `name` is the only required field.
- `hygiene` is a partial alert-hygiene config; missing fields get the ADR 0005
  defaults (threshold 5 pts, dead band 2 pts, cooldown 4 h, daily cap 5, quiet
  hours 22:00–07:00, liquidity floor $1000).
- `subscriptions[].kind` must be `series` or `event`.
- Recipient constraint (ADR 0004): v1 delivers only to the operator's own
  Resend-account inbox, regardless of what `recipients` lists.

`example.json` ships `"active": false` so a freshly seeded install never runs
or alerts on the example — it exists to show the shape and give the admin UI
something to display on first login.
