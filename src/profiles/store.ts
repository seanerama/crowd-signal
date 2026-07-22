/**
 * Profile + subscription read/write model (ADR 0002). The admin UI writes
 * through here; later stages (daily run, watcher, suggestions) import the same
 * typed functions. Recipients and hygiene config are stored as JSON text
 * columns; this module is the only place that (de)serializes them.
 *
 * Seeding: on boot, if the DB has zero profiles and the repo `profiles/`
 * directory contains *.json seed files, they are inserted once. Runtime owns
 * the rows afterwards.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db.js";
import {
  DEFAULT_HYGIENE,
  validateHygiene,
  type HygieneConfig
} from "./hygiene.js";

export type SubscriptionKind = "series" | "event";

export interface Profile {
  id: string;
  name: string;
  description: string;
  recipients: string[];
  hygiene: HygieneConfig;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Subscription {
  id: string;
  profileId: string;
  ticker: string;
  kind: SubscriptionKind;
  addedAt: string;
}

export class StoreError extends Error {
  override name = "StoreError";
}

interface ProfileRow {
  id: string;
  name: string;
  description: string;
  recipients: string;
  hygiene_config: string;
  active: number;
  created_at: string;
  updated_at: string;
}

interface SubscriptionRow {
  id: string;
  profile_id: string;
  ticker: string;
  kind: SubscriptionKind;
  added_at: string;
}

function rowToProfile(row: ProfileRow): Profile {
  let recipients: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.recipients);
    if (Array.isArray(parsed)) {
      recipients = parsed.filter((r): r is string => typeof r === "string");
    }
  } catch {
    // tolerate cruft; recipients default to empty
  }
  let hygiene: HygieneConfig = { ...DEFAULT_HYGIENE };
  try {
    hygiene = validateHygiene(JSON.parse(row.hygiene_config));
  } catch {
    // stored config unreadable → fall back to defaults rather than crash reads
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    recipients,
    hygiene,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    profileId: row.profile_id,
    ticker: row.ticker,
    kind: row.kind,
    addedAt: row.added_at
  };
}

export function listProfiles(db: Db): Profile[] {
  const rows = db
    .prepare("SELECT * FROM profiles ORDER BY created_at, id")
    .all() as ProfileRow[];
  return rows.map(rowToProfile);
}

export function activeProfiles(db: Db): Profile[] {
  const rows = db
    .prepare("SELECT * FROM profiles WHERE active = 1 ORDER BY created_at, id")
    .all() as ProfileRow[];
  return rows.map(rowToProfile);
}

export function getProfile(db: Db, id: string): Profile | undefined {
  const row = db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as
    | ProfileRow
    | undefined;
  return row ? rowToProfile(row) : undefined;
}

export interface CreateProfileInput {
  id?: string;
  name: string;
  description?: string;
  recipients?: string[];
  /** Partial hygiene config; validated with ADR 0005 defaults applied. */
  hygiene?: unknown;
  active?: boolean;
}

export function createProfile(db: Db, input: CreateProfileInput): Profile {
  const name = input.name.trim();
  if (name === "") throw new StoreError("profile name is required");
  const hygiene = validateHygiene(input.hygiene);
  const now = new Date().toISOString();
  const id = input.id?.trim() || randomUUID();
  db.prepare(
    `INSERT INTO profiles
       (id, name, description, recipients, hygiene_config, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name,
    input.description?.trim() ?? "",
    JSON.stringify(input.recipients ?? []),
    JSON.stringify(hygiene),
    input.active === false ? 0 : 1,
    now,
    now
  );
  return getProfile(db, id)!;
}

export interface UpdateProfileInput {
  name?: string;
  description?: string;
  recipients?: string[];
  hygiene?: unknown;
  active?: boolean;
}

export function updateProfile(
  db: Db,
  id: string,
  patch: UpdateProfileInput
): Profile | undefined {
  const existing = getProfile(db, id);
  if (!existing) return undefined;
  const name = patch.name !== undefined ? patch.name.trim() : existing.name;
  if (name === "") throw new StoreError("profile name is required");
  const hygiene =
    patch.hygiene !== undefined ? validateHygiene(patch.hygiene) : existing.hygiene;
  db.prepare(
    `UPDATE profiles
       SET name = ?, description = ?, recipients = ?, hygiene_config = ?,
           active = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    name,
    patch.description !== undefined ? patch.description.trim() : existing.description,
    JSON.stringify(patch.recipients ?? existing.recipients),
    JSON.stringify(hygiene),
    (patch.active ?? existing.active) ? 1 : 0,
    new Date().toISOString(),
    id
  );
  return getProfile(db, id);
}

export function listSubscriptions(db: Db, profileId: string): Subscription[] {
  const rows = db
    .prepare(
      "SELECT * FROM subscriptions WHERE profile_id = ? ORDER BY added_at, id"
    )
    .all(profileId) as SubscriptionRow[];
  return rows.map(rowToSubscription);
}

/**
 * Add a subscription. Idempotent by design (documented choice): re-adding the
 * same (profile, ticker, kind) returns the existing row with created=false
 * instead of erroring — a double-submitted admin form is a no-op.
 */
export function addSubscription(
  db: Db,
  profileId: string,
  ticker: string,
  kind: SubscriptionKind
): { subscription: Subscription; created: boolean } {
  if (kind !== "series" && kind !== "event") {
    throw new StoreError(`invalid subscription kind: ${String(kind)}`);
  }
  const normalized = ticker.trim().toUpperCase();
  if (normalized === "") throw new StoreError("ticker is required");
  if (!getProfile(db, profileId)) {
    throw new StoreError(`no such profile: ${profileId}`);
  }
  const find = db.prepare(
    "SELECT * FROM subscriptions WHERE profile_id = ? AND ticker = ? AND kind = ?"
  );
  const existing = find.get(profileId, normalized, kind) as
    | SubscriptionRow
    | undefined;
  if (existing) {
    return { subscription: rowToSubscription(existing), created: false };
  }
  db.prepare(
    "INSERT INTO subscriptions (id, profile_id, ticker, kind, added_at) VALUES (?, ?, ?, ?, ?)"
  ).run(randomUUID(), profileId, normalized, kind, new Date().toISOString());
  const row = find.get(profileId, normalized, kind) as SubscriptionRow;
  return { subscription: rowToSubscription(row), created: true };
}

export function removeSubscription(db: Db, id: string): boolean {
  const info = db.prepare("DELETE FROM subscriptions WHERE id = ?").run(id);
  return info.changes > 0;
}

/** Shape of a `profiles/*.json` seed file. Everything but `name` is optional. */
interface SeedFile {
  id?: string;
  name?: string;
  description?: string;
  recipients?: string[];
  hygiene?: unknown;
  active?: boolean;
  subscriptions?: { ticker?: string; kind?: string }[];
}

/** Repo-root profiles/ directory (works from both src/ and dist/). */
export const DEFAULT_SEED_DIR = new URL("../../profiles", import.meta.url)
  .pathname;

/**
 * First-boot seeding (ADR 0002): if the DB has zero profiles and seedDir
 * contains *.json files, insert them. Runtime owns the rows afterwards —
 * this never overwrites or re-seeds a non-empty DB. Invalid seed files are
 * skipped (reported in the returned `skipped` list) rather than blocking boot.
 */
export function seedProfilesIfEmpty(
  db: Db,
  seedDir: string = DEFAULT_SEED_DIR
): { seeded: number; skipped: string[] } {
  const skipped: string[] = [];
  const count = (
    db.prepare("SELECT COUNT(*) AS n FROM profiles").get() as { n: number }
  ).n;
  if (count > 0 || !existsSync(seedDir)) return { seeded: 0, skipped };

  const files = readdirSync(seedDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  let seeded = 0;
  for (const file of files) {
    try {
      const raw = JSON.parse(
        readFileSync(join(seedDir, file), "utf8")
      ) as SeedFile;
      if (typeof raw.name !== "string" || raw.name.trim() === "") {
        throw new StoreError("seed file needs a non-empty name");
      }
      const profile = createProfile(db, {
        id: raw.id,
        name: raw.name,
        description: raw.description,
        recipients: raw.recipients,
        hygiene: raw.hygiene,
        active: raw.active
      });
      for (const sub of raw.subscriptions ?? []) {
        if (
          typeof sub.ticker === "string" &&
          (sub.kind === "series" || sub.kind === "event")
        ) {
          addSubscription(db, profile.id, sub.ticker, sub.kind);
        }
      }
      seeded += 1;
    } catch {
      skipped.push(file);
    }
  }
  return { seeded, skipped };
}
