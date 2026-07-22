/**
 * Admin artifact viewing (stage 5): session-authed GET
 * /admin/artifacts/:runId/:profileId serves the persisted newsletter HTML;
 * unauthenticated requests redirect to login; traversal-shaped ids are
 * rejected by allowlist validation BEFORE any filesystem access.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const PASSWORD = "correct-horse-battery";
const SECRET = "artifact-test-secret";
const RUN_ID = "11111111-2222-3333-4444-555555555555";
const PROFILE_ID = "p-test";
const ARTIFACT_HTML = "<!doctype html>\n<html><body><p>the sent brief</p></body></html>\n";

describe("GET /admin/artifacts/:runId/:profileId", () => {
  let dataDir: string;
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "crowd-signal-artifacts-"));
    // A persisted artifact and a "secret" file OUTSIDE the artifacts tree
    // that traversal must never reach.
    mkdirSync(join(dataDir, "artifacts", RUN_ID), { recursive: true });
    writeFileSync(
      join(dataDir, "artifacts", RUN_ID, `${PROFILE_ID}.html`),
      ARTIFACT_HTML,
      "utf8"
    );
    writeFileSync(join(dataDir, "secret.html"), "TOP SECRET", "utf8");

    app = buildApp(
      loadConfig({
        TRIGGER_API_TOKEN: "t",
        DATA_DIR: dataDir,
        ADMIN_UI_ENABLED: "true",
        ADMIN_PASSWORD: PASSWORD,
        ADMIN_SESSION_SECRET: SECRET
      })
    );
    await app.ready();

    const login = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: new URLSearchParams({ password: PASSWORD }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" }
    });
    expect(login.statusCode).toBe(302);
    const setCookie = login.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    cookie = raw!.split(";")[0]!;
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("unauthenticated -> 302 redirect to login, artifact not served", async () => {
    const res = await app.inject({
      url: `/admin/artifacts/${RUN_ID}/${PROFILE_ID}`
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/admin/login");
    expect(res.body).not.toContain("the sent brief");
  });

  it("authed -> 200 text/html with the persisted artifact verbatim", async () => {
    const res = await app.inject({
      url: `/admin/artifacts/${RUN_ID}/${PROFILE_ID}`,
      headers: { cookie }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toBe(ARTIFACT_HTML);
  });

  it("unknown run/profile -> 404", async () => {
    const res = await app.inject({
      url: `/admin/artifacts/${RUN_ID}/nope`,
      headers: { cookie }
    });
    expect(res.statusCode).toBe(404);
  });

  it("traversal-shaped ids -> 400, filesystem untouched", async () => {
    const attempts = [
      `/admin/artifacts/..%2F..%2Fsecret/${PROFILE_ID}`,
      `/admin/artifacts/${RUN_ID}/..%2F..%2Fsecret`,
      `/admin/artifacts/${RUN_ID}/%2e%2e%2fsecret`,
      `/admin/artifacts/a.b/${PROFILE_ID}`
    ];
    for (const url of attempts) {
      const res = await app.inject({ url, headers: { cookie } });
      expect(res.statusCode, url).toBe(400);
      expect(res.body).not.toContain("TOP SECRET");
    }
  });

  it("run history page links to the artifact", async () => {
    // Insert a runs row so the dashboard lists it with its artifact link.
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(join(dataDir, "pulse.db"));
    try {
      db.prepare(
        "INSERT INTO runs (run_id, kind, day, started_at, finished_at, status) VALUES (?, 'daily', ?, ?, ?, 'completed')"
      ).run(
        RUN_ID,
        new Date().toISOString().slice(0, 10),
        new Date().toISOString(),
        new Date().toISOString()
      );
    } finally {
      db.close();
    }
    const res = await app.inject({ url: "/admin", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`/admin/artifacts/${RUN_ID}/${PROFILE_ID}`);
  });
});
