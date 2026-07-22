import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { migrate, type Db } from "../src/db.js";
import { DEFAULT_HYGIENE } from "../src/profiles/hygiene.js";
import {
  activeProfiles,
  addSubscription,
  createProfile,
  getProfile,
  listProfiles,
  listSubscriptions,
  removeSubscription,
  seedProfilesIfEmpty,
  StoreError,
  updateProfile
} from "../src/profiles/store.js";

describe("profiles store", () => {
  const dir = mkdtempSync(join(tmpdir(), "crowd-signal-store-"));
  const db: Db = new Database(join(dir, "test.db"));
  migrate(db);

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("createProfile applies hygiene defaults and getProfile round-trips", () => {
    const p = createProfile(db, {
      name: "  Macro Watcher  ",
      description: "rates & elections",
      recipients: ["op@example.com"]
    });
    expect(p.name).toBe("Macro Watcher");
    expect(p.hygiene).toEqual(DEFAULT_HYGIENE);
    expect(p.active).toBe(true);
    expect(getProfile(db, p.id)).toEqual(p);
  });

  it("rejects empty names", () => {
    expect(() => createProfile(db, { name: "   " })).toThrow(StoreError);
  });

  it("activeProfiles excludes inactive; updateProfile can flip the flag", () => {
    const p = createProfile(db, { name: "Sleeper", active: false });
    expect(activeProfiles(db).some((x) => x.id === p.id)).toBe(false);
    expect(listProfiles(db).some((x) => x.id === p.id)).toBe(true);
    const updated = updateProfile(db, p.id, { active: true })!;
    expect(updated.active).toBe(true);
    expect(activeProfiles(db).some((x) => x.id === p.id)).toBe(true);
  });

  it("updateProfile validates hygiene and returns undefined for unknown ids", () => {
    const p = createProfile(db, { name: "H" });
    expect(() =>
      updateProfile(db, p.id, { hygiene: { dailyCap: 0 } })
    ).toThrow(/dailyCap/);
    expect(updateProfile(db, "nope", { name: "X" })).toBeUndefined();
  });

  it("subscriptions: normalized tickers, idempotent add, kind isolation, remove", () => {
    const p = createProfile(db, { name: "Subs" });
    const a = addSubscription(db, p.id, " kxhighchi ", "series");
    expect(a.created).toBe(true);
    expect(a.subscription.ticker).toBe("KXHIGHCHI");
    // same ticker+kind → idempotent
    const dup = addSubscription(db, p.id, "KXHIGHCHI", "series");
    expect(dup.created).toBe(false);
    expect(dup.subscription.id).toBe(a.subscription.id);
    // same ticker, different kind → distinct row
    const ev = addSubscription(db, p.id, "KXHIGHCHI", "event");
    expect(ev.created).toBe(true);
    expect(listSubscriptions(db, p.id)).toHaveLength(2);
    expect(removeSubscription(db, a.subscription.id)).toBe(true);
    expect(removeSubscription(db, a.subscription.id)).toBe(false);
    expect(listSubscriptions(db, p.id)).toHaveLength(1);
  });

  it("addSubscription rejects unknown profiles and empty tickers", () => {
    const p = createProfile(db, { name: "Guard" });
    expect(() => addSubscription(db, "missing", "T", "series")).toThrow(
      StoreError
    );
    expect(() => addSubscription(db, p.id, "  ", "series")).toThrow(StoreError);
  });
});

describe("first-boot seeding", () => {
  it("seeds *.json into an empty DB once, skips invalid files, never re-seeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "crowd-signal-seed-"));
    const seedDir = join(dir, "profiles");
    mkdirSync(seedDir);
    writeFileSync(
      join(seedDir, "good.json"),
      JSON.stringify({
        id: "seeded",
        name: "Seeded",
        active: false,
        subscriptions: [{ ticker: "kxhighchi", kind: "series" }]
      })
    );
    writeFileSync(join(seedDir, "bad.json"), "{not json");
    writeFileSync(join(seedDir, "ignored.txt"), "not a seed");

    const db: Db = new Database(join(dir, "test.db"));
    try {
      migrate(db);
      const first = seedProfilesIfEmpty(db, seedDir);
      expect(first).toEqual({ seeded: 1, skipped: ["bad.json"] });
      const p = getProfile(db, "seeded")!;
      expect(p.name).toBe("Seeded");
      expect(p.active).toBe(false);
      expect(p.hygiene).toEqual(DEFAULT_HYGIENE);
      expect(listSubscriptions(db, "seeded").map((s) => s.ticker)).toEqual([
        "KXHIGHCHI"
      ]);
      // non-empty DB → no re-seed
      expect(seedProfilesIfEmpty(db, seedDir).seeded).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing seed dir is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "crowd-signal-noseed-"));
    const db: Db = new Database(join(dir, "test.db"));
    try {
      migrate(db);
      expect(seedProfilesIfEmpty(db, join(dir, "absent"))).toEqual({
        seeded: 0,
        skipped: []
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
