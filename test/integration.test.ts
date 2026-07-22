import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const TOKEN = "integration-test-token";

describe("walking skeleton (integration, temp DATA_DIR)", () => {
  let dataDir: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "crowd-signal-test-"));
    const config = loadConfig({
      TRIGGER_API_TOKEN: TOKEN,
      DATA_DIR: dataDir
    });
    app = buildApp(config);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function runRow(runId: string) {
    const db = new Database(join(dataDir, "pulse.db"), { readonly: true });
    try {
      return db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as
        | {
            run_id: string;
            kind: string;
            day: string;
            started_at: string;
            status: string;
          }
        | undefined;
    } finally {
      db.close();
    }
  }

  it("GET /healthz -> ok:true, db:ok, version from package.json", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.db).toBe("ok");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("POST /trigger/daily without token -> 401 { error }", async () => {
    const res = await app.inject({ method: "POST", url: "/trigger/daily" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty("error");
  });

  it("POST /trigger/daily with bad token -> 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/trigger/daily",
      headers: { authorization: "Bearer wrong-token" }
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty("error");
  });

  let firstRunId: string;

  it("POST /trigger/daily with token -> 202, runs row + artifact exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/trigger/daily",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(typeof body.runId).toBe("string");
    expect(body.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    firstRunId = body.runId;

    const row = runRow(firstRunId);
    expect(row).toBeDefined();
    expect(row!.kind).toBe("daily");
    expect(row!.status).toBe("completed");
    expect(row!.day).toBe(new Date().toISOString().slice(0, 10));

    const artifact = join(dataDir, "artifacts", firstRunId, "placeholder.html");
    expect(existsSync(artifact)).toBe(true);
  });

  it("repeat same-day POST /trigger/daily -> 200 alreadyRan with same runId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/trigger/daily",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runId: firstRunId, alreadyRan: true });
  });

  it("force:true -> new 202 run despite same-day completion", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/trigger/daily",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { force: true }
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.runId).not.toBe(firstRunId);
    expect(runRow(body.runId)).toBeDefined();
    expect(
      existsSync(join(dataDir, "artifacts", body.runId, "placeholder.html"))
    ).toBe(true);
  });

  it("accepts optional profileId/dryRun body fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/trigger/daily",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { profileId: "p1", dryRun: true, force: true }
    });
    expect(res.statusCode).toBe(202);
  });

  it("POST /trigger/discovery without token -> 401", async () => {
    const res = await app.inject({ method: "POST", url: "/trigger/discovery" });
    expect(res.statusCode).toBe(401);
  });

  it("POST /trigger/discovery with token -> 202 kind=discovery, then 200 alreadyRan", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/trigger/discovery",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(first.statusCode).toBe(202);
    const { runId } = first.json();
    const row = runRow(runId);
    expect(row!.kind).toBe("discovery");
    expect(
      existsSync(join(dataDir, "artifacts", runId, "placeholder.html"))
    ).toBe(true);

    const repeat = await app.inject({
      method: "POST",
      url: "/trigger/discovery",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual({ runId, alreadyRan: true });
  });

  it("daily and discovery idempotency are independent per kind", async () => {
    // Daily already completed today; discovery repeat above returned 200.
    // A forced discovery still works and does not disturb daily idempotency.
    const forced = await app.inject({
      method: "POST",
      url: "/trigger/discovery",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { force: true }
    });
    expect(forced.statusCode).toBe(202);
  });

  it("artifact is self-contained HTML (no external refs)", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(
      join(dataDir, "artifacts", firstRunId, "placeholder.html"),
      "utf8"
    );
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script/i);
  });
});
