/**
 * THE pipeline test (stage 5): temp DATA_DIR + mock Kalshi + mock Resend +
 * dry-run mailer → trigger → assert async 202 semantics, snapshot rows,
 * artifact HTML (self-contained, contract section order), RunManifest exact
 * contract shape, closed detection, degraded paths (Kalshi 500s, mailer
 * down), dryRun flag, and idempotency. No live network anywhere.
 */
import Database from "better-sqlite3";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { openDb } from "../src/db.js";
import { DryRunMailer } from "../src/mailer/index.js";
import { addSubscription, createProfile } from "../src/profiles/store.js";
import { awaitRun } from "../src/routes/trigger.js";
import { SnapshotStore } from "../src/snapshots/index.js";
import { makeSnapshot } from "./snapshots/helpers.js";

const TOKEN = "pipeline-test-token";
const RECIPIENT = "operator@example.com";
const PROFILE_ID = "p-test";
const PROFILE_NAME = "Ops Test";
const TODAY = new Date().toISOString().slice(0, 10);

const T_B87 = "KXHIGHNY-26JUL22-B87";
const T_B89 = "KXHIGHNY-26JUL22-B89";
const T_B85 = "KXHIGHNY-26JUL23-B85";

interface PlannedResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/kalshi/${name}`, import.meta.url), "utf8")
  );
}

interface MockServer {
  server: Server;
  baseUrl: string;
  hits: { url: URL; headers: IncomingHttpHeaders }[];
  route: (url: URL) => PlannedResponse;
  close: () => Promise<void>;
}

async function startMockServer(): Promise<MockServer> {
  const mock: MockServer = {
    server: undefined as unknown as Server,
    baseUrl: "",
    hits: [],
    route: () => ({ status: 404, body: { error: "no route planned" } }),
    close: () => Promise.resolve()
  };
  mock.server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", mock.baseUrl);
    mock.hits.push({ url, headers: req.headers });
    const planned = mock.route(url);
    const respond = () => {
      res.writeHead(planned.status, {
        "content-type": "application/json",
        ...planned.headers
      });
      res.end(JSON.stringify(planned.body ?? {}));
    };
    if (planned.delayMs) setTimeout(respond, planned.delayMs);
    else respond();
  });
  await new Promise<void>((r) => mock.server.listen(0, "127.0.0.1", r));
  const { port } = mock.server.address() as AddressInfo;
  mock.baseUrl = `http://127.0.0.1:${port}`;
  mock.close = () =>
    new Promise<void>((r, j) => mock.server.close((e) => (e ? j(e) : r())));
  return mock;
}

/** Kalshi mock routing for the happy path (series fixture + candlesticks). */
function happyKalshiRoute(url: URL): PlannedResponse {
  if (url.pathname.endsWith("/candlesticks")) {
    return { status: 200, body: fixture("candlesticks.json") };
  }
  if (url.pathname.endsWith("/markets")) {
    return { status: 200, body: fixture("markets-series.json") };
  }
  if (url.pathname.endsWith("/events")) {
    return { status: 200, body: fixture("events-series.json") };
  }
  return { status: 404 };
}

/**
 * Seed a DB (before buildApp opens it): the test profile, its series
 * subscription, and prior snapshots ~25h old so 24h deltas exist.
 * Prior prices: B87 40 (Δ +4), B89 25 (Δ −5), B85 32 (Δ 0).
 */
function seedDataDir(dataDir: string): void {
  const db = openDb(dataDir);
  try {
    createProfile(db, {
      id: PROFILE_ID,
      name: PROFILE_NAME,
      recipients: [RECIPIENT]
    });
    addSubscription(db, PROFILE_ID, "KXHIGHNY", "series");
    const store = new SnapshotStore(db);
    const fetchedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    store.saveSnapshots("seed-run", [
      makeSnapshot({
        ticker: T_B87,
        eventTicker: "KXHIGHNY-26JUL22",
        seriesTicker: "KXHIGHNY",
        yesPriceCents: 40,
        fetchedAt
      }),
      makeSnapshot({
        ticker: T_B89,
        eventTicker: "KXHIGHNY-26JUL22",
        seriesTicker: "KXHIGHNY",
        yesPriceCents: 25,
        fetchedAt
      }),
      makeSnapshot({
        ticker: T_B85,
        eventTicker: "KXHIGHNY-26JUL23",
        seriesTicker: "KXHIGHNY",
        yesPriceCents: 32,
        fetchedAt
      })
    ]);
  } finally {
    db.close();
  }
}

function testConfig(
  dataDir: string,
  kalshiBase: string,
  extra: Record<string, string> = {}
): Config {
  return loadConfig({
    TRIGGER_API_TOKEN: TOKEN,
    DATA_DIR: dataDir,
    KALSHI_ENABLED: "true",
    KALSHI_API_BASE: kalshiBase,
    KALSHI_RPS: "1000",
    KALSHI_BURST: "1000",
    KALSHI_MAX_ATTEMPTS: "1",
    ...extra
  });
}

function readOnlyDb(dataDir: string): Database.Database {
  return new Database(join(dataDir, "pulse.db"), { readonly: true });
}

function runRow(dataDir: string, runId: string) {
  const db = readOnlyDb(dataDir);
  try {
    return db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as
      | { run_id: string; kind: string; status: string; finished_at: string | null }
      | undefined;
  } finally {
    db.close();
  }
}

async function trigger(
  app: FastifyInstance,
  payload?: Record<string, unknown>
) {
  return app.inject({
    method: "POST",
    url: "/trigger/daily",
    headers: { authorization: `Bearer ${TOKEN}` },
    ...(payload ? { payload } : {})
  });
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** contracts/newsletter-artifact.md v1: RunManifest keys, in contract order. */
const MANIFEST_KEYS = [
  "runId",
  "kind",
  "profileId",
  "date",
  "asOf",
  "sections",
  "marketCount",
  "moversCount",
  "closedCount",
  "suppressedCount",
  "healthNotes",
  "costUsd",
  "emailedTo",
  "emailedAt"
];

describe("daily pipeline: happy path + closed detection (dry-run mailer)", () => {
  let dataDir: string;
  let kalshi: MockServer;
  let app: FastifyInstance;
  const dryMailer = new DryRunMailer();

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "crowd-signal-pipe-"));
    seedDataDir(dataDir);
    kalshi = await startMockServer();
    app = buildApp(testConfig(dataDir, kalshi.baseUrl), { mailer: dryMailer });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await kalshi.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  let runId: string;
  let artifactHtml: string;

  it("202 arrives immediately; the run executes and completes async", async () => {
    // Delay the first Kalshi response so the run CANNOT have finished by the
    // time the 202 is asserted — proving the reply precedes the pipeline.
    let delayed = false;
    kalshi.route = (url) => {
      const planned = happyKalshiRoute(url);
      if (!delayed) {
        delayed = true;
        return { ...planned, delayMs: 30 };
      }
      return planned;
    };

    const res = await trigger(app, { dryRun: true });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(typeof body.runId).toBe("string");
    expect(body.startedAt).toMatch(ISO);
    runId = body.runId;

    // Async proof: the run is still in flight right after the 202.
    expect(runRow(dataDir, runId)!.status).toBe("running");

    await awaitRun(runId);
    const row = runRow(dataDir, runId)!;
    expect(row.status).toBe("completed");
    expect(row.finished_at).toMatch(ISO);
  });

  it("snapshot rows persisted for every resolved market, tagged with the run", () => {
    const db = readOnlyDb(dataDir);
    try {
      const rows = db
        .prepare(
          "SELECT ticker FROM snapshots WHERE run_id = ? ORDER BY ticker"
        )
        .all(runId) as { ticker: string }[];
      expect(rows.map((r) => r.ticker)).toEqual([T_B87, T_B89, T_B85].sort());
    } finally {
      db.close();
    }
  });

  it("artifact HTML is persisted, self-contained, sections in contract order", () => {
    const path = join(dataDir, "artifacts", runId, `${PROFILE_ID}.html`);
    expect(existsSync(path)).toBe(true);
    artifactHtml = readFileSync(path, "utf8");

    // Self-contained: zero external REQUESTS. (Market links are required by
    // the frozen contract — anchors fetch nothing until clicked.)
    expect(artifactHtml).not.toMatch(/<script/i);
    expect(artifactHtml).not.toMatch(/\ssrc=/i);
    expect(artifactHtml).not.toMatch(/<link/i);
    expect(artifactHtml).not.toMatch(/@import/i);
    expect(artifactHtml).not.toMatch(/url\(/i);
    expect(artifactHtml).toContain("<style>");

    // Section order per the contract.
    const header = artifactHtml.indexOf(`${PROFILE_NAME} — daily brief`);
    const movers = artifactHtml.indexOf("Movers (24h)");
    const watchlist = artifactHtml.indexOf("<h2>Watchlist</h2>");
    const footer = artifactHtml.indexOf("Run cost: $0.0000");
    expect(header).toBeGreaterThan(-1);
    expect(movers).toBeGreaterThan(header);
    expect(watchlist).toBeGreaterThan(movers);
    expect(footer).toBeGreaterThan(watchlist);
    expect(artifactHtml).toContain(
      "Prices are crowd estimates, not predictions or advice."
    );
  });

  it("watchlist renders event title beside market title (§4.1) and signed deltas", () => {
    expect(artifactHtml).toContain(
      "Will the high temp in NYC be 87-88°F on Jul 22, 2026?"
    );
    expect(artifactHtml).toContain("Highest temperature in NYC on Jul 22, 2026?");
    // 24h deltas from the seeded 25h-old snapshots: B87 +4, B89 −5, B85 0.
    expect(artifactHtml).toContain(">+4<");
    expect(artifactHtml).toContain(">−5<");
    // 7d deltas via the candlestick fallback (close 44): B89 20−44 = −24.
    expect(artifactHtml).toContain(">−24<");
  });

  it("movers are sorted by |Δ| (|−5| before |+4|), zero-move markets excluded", () => {
    const moversBlock = artifactHtml.slice(
      artifactHtml.indexOf("Movers (24h)"),
      artifactHtml.indexOf("<h2>Watchlist</h2>")
    );
    const posB89 = moversBlock.indexOf("89-90°F");
    const posB87 = moversBlock.indexOf("87-88°F");
    expect(posB89).toBeGreaterThan(-1);
    expect(posB87).toBeGreaterThan(posB89);
    // B85 moved 0 points — not a mover.
    expect(moversBlock).not.toContain("85-86°F");
  });

  it("manifest.json matches the frozen RunManifest shape, field for field", () => {
    const manifest = JSON.parse(
      readFileSync(join(dataDir, "artifacts", runId, "manifest.json"), "utf8")
    );
    expect(manifest).toEqual({
      runId,
      kind: "daily",
      profileId: PROFILE_ID,
      date: TODAY,
      asOf: expect.stringMatching(ISO),
      sections: ["header", "movers", "watchlist", "footer"],
      marketCount: 3,
      moversCount: 2,
      closedCount: 0,
      suppressedCount: 0,
      healthNotes: [],
      costUsd: 0,
      emailedTo: [RECIPIENT],
      emailedAt: expect.stringMatching(ISO)
    });
    expect(Object.keys(manifest)).toEqual(MANIFEST_KEYS);
  });

  it("dry-run mailer captured EXACTLY the persisted HTML (the artifact IS what was sent)", () => {
    expect(dryMailer.sent).toHaveLength(1);
    const msg = dryMailer.sent[0]!;
    expect(msg.to).toEqual([RECIPIENT]);
    expect(msg.subject).toBe(`[Crowd-Signal] ${PROFILE_NAME} daily — ${TODAY}`);
    expect(msg.html).toBe(artifactHtml);
  });

  it("no Kalshi request ever carried auth material", () => {
    // At least the run's requests were recorded (markets/events/candlesticks).
    const priorHits = kalshi.hits;
    expect(priorHits.length).toBeGreaterThan(0);
    for (const hit of priorHits) {
      expect(hit.headers.authorization).toBeUndefined();
      expect(hit.headers.cookie).toBeUndefined();
    }
  });

  it("idempotency: repeat same-day trigger -> 200 alreadyRan; force -> new run", async () => {
    const repeat = await trigger(app);
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual({ runId, alreadyRan: true });
  });

  it("closed since last brief: a market gone from resolution is fetched, settled, surfaced once", async () => {
    // Run 2 (forced): B87 disappears from the open-market resolution; the
    // pipeline fetches it directly and finds it settled YES.
    const series = fixture("markets-series.json") as {
      markets: { ticker: string }[];
      cursor: string;
    };
    const withoutB87 = {
      markets: series.markets.filter((m) => m.ticker !== T_B87),
      cursor: ""
    };
    const settled = fixture("market-open.json") as {
      market: Record<string, unknown>;
    };
    const settledB87 = {
      market: { ...settled.market, status: "settled", result: "yes" }
    };
    kalshi.route = (url) => {
      if (url.pathname.endsWith(`/markets/${T_B87}`)) {
        return { status: 200, body: settledB87 };
      }
      if (url.pathname.endsWith("/events/KXHIGHNY-26JUL22")) {
        return { status: 200, body: fixture("event-nested.json") };
      }
      if (url.pathname.endsWith("/markets")) {
        return { status: 200, body: withoutB87 };
      }
      return happyKalshiRoute(url);
    };

    const res = await trigger(app, { force: true, dryRun: true });
    expect(res.statusCode).toBe(202);
    const secondRunId = res.json().runId as string;
    expect(secondRunId).not.toBe(runId);
    await awaitRun(secondRunId);
    expect(runRow(dataDir, secondRunId)!.status).toBe("completed");

    const manifest = JSON.parse(
      readFileSync(
        join(dataDir, "artifacts", secondRunId, "manifest.json"),
        "utf8"
      )
    );
    expect(manifest.sections).toEqual([
      "header",
      "movers",
      "watchlist",
      "closed",
      "footer"
    ]);
    expect(manifest.marketCount).toBe(2);
    expect(manifest.closedCount).toBe(1);

    const html = readFileSync(
      join(dataDir, "artifacts", secondRunId, `${PROFILE_ID}.html`),
      "utf8"
    );
    expect(html).toContain("Closed since last brief");
    expect(html).toContain("Settled YES");
    expect(html).toContain("87-88°F");
  });
});

describe("degraded path: Kalshi unreachable -> stale last-known data + health notes", () => {
  let dataDir: string;
  let kalshi: MockServer;
  let app: FastifyInstance;
  const dryMailer = new DryRunMailer();

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "crowd-signal-degr-"));
    seedDataDir(dataDir);
    kalshi = await startMockServer();
    app = buildApp(testConfig(dataDir, kalshi.baseUrl), { mailer: dryMailer });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await kalshi.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("healthy run first (establishes the resolution set), then 500s -> degraded", async () => {
    kalshi.route = happyKalshiRoute;
    const first = await trigger(app, { dryRun: true });
    expect(first.statusCode).toBe(202);
    await awaitRun(first.json().runId);
    expect(runRow(dataDir, first.json().runId)!.status).toBe("completed");

    // Now Kalshi is down hard.
    kalshi.route = () => ({ status: 500, body: { error: "boom" } });
    const res = await trigger(app, { force: true, dryRun: true });
    expect(res.statusCode).toBe(202);
    const runId = res.json().runId as string;
    await awaitRun(runId);

    expect(runRow(dataDir, runId)!.status).toBe("degraded");

    const manifest = JSON.parse(
      readFileSync(join(dataDir, "artifacts", runId, "manifest.json"), "utf8")
    );
    expect(manifest.healthNotes.length).toBeGreaterThan(0);
    expect(manifest.healthNotes[0]).toMatch(/kalshi unreachable/);
    // Still a full newsletter from last-known data.
    expect(manifest.marketCount).toBe(3);
    expect(manifest.emailedAt).toMatch(ISO);

    const html = readFileSync(
      join(dataDir, "artifacts", runId, `${PROFILE_ID}.html`),
      "utf8"
    );
    // Honest stale stamping in the header and per-row badges + health note.
    expect(html).toContain("Some prices are last-known values");
    expect(html).toContain(">stale</span>");
    expect(html).toContain("kalshi unreachable; serving last-known data");
  });
});

describe("mailer paths: dryRun flag, Resend auth, mailer-down degradation", () => {
  let dataDir: string;
  let kalshi: MockServer;
  let resend: MockServer;
  let app: FastifyInstance;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "crowd-signal-mail-"));
    seedDataDir(dataDir);
    kalshi = await startMockServer();
    resend = await startMockServer();
    kalshi.route = happyKalshiRoute;
    resend.route = () => ({ status: 200, body: { id: "em_test_1" } });
    // Real ResendMailer against the mock: MAILER_ENABLED with a fake key.
    app = buildApp(
      testConfig(dataDir, kalshi.baseUrl, {
        MAILER_ENABLED: "true",
        RESEND_API_KEY: "test-resend-key",
        RESEND_API_BASE: resend.baseUrl
      })
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await kalshi.close();
    await resend.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("dryRun:true never touches Resend; run still completes with artifact", async () => {
    const res = await trigger(app, { dryRun: true });
    expect(res.statusCode).toBe(202);
    const runId = res.json().runId as string;
    await awaitRun(runId);
    expect(runRow(dataDir, runId)!.status).toBe("completed");
    expect(resend.hits).toHaveLength(0);
    expect(
      existsSync(join(dataDir, "artifacts", runId, `${PROFILE_ID}.html`))
    ).toBe(true);
  });

  it("real send POSTs Bearer-authed /emails to the RESEND base only", async () => {
    const res = await trigger(app, { force: true });
    const runId = res.json().runId as string;
    await awaitRun(runId);
    expect(runRow(dataDir, runId)!.status).toBe("completed");

    expect(resend.hits).toHaveLength(1);
    const hit = resend.hits[0]!;
    expect(hit.url.pathname).toBe("/emails");
    expect(hit.headers.authorization).toBe("Bearer test-resend-key");
    // Kalshi never sees auth material.
    for (const k of kalshi.hits) {
      expect(k.headers.authorization).toBeUndefined();
    }

    const manifest = JSON.parse(
      readFileSync(join(dataDir, "artifacts", runId, "manifest.json"), "utf8")
    );
    expect(manifest.emailedTo).toEqual([RECIPIENT]);
    expect(manifest.emailedAt).toMatch(ISO);
  });

  it("mailer down -> artifact still persisted, emailedAt null, run degraded", async () => {
    resend.hits.length = 0;
    resend.route = () => ({ status: 500, body: { error: "resend down" } });
    const res = await trigger(app, { force: true });
    const runId = res.json().runId as string;
    await awaitRun(runId);

    expect(runRow(dataDir, runId)!.status).toBe("degraded");
    const artifact = join(dataDir, "artifacts", runId, `${PROFILE_ID}.html`);
    expect(existsSync(artifact)).toBe(true);

    const manifest = JSON.parse(
      readFileSync(join(dataDir, "artifacts", runId, "manifest.json"), "utf8")
    );
    expect(manifest.emailedAt).toBeNull();
    expect(manifest.emailedTo).toEqual([]);
    expect(
      manifest.healthNotes.some((n: string) => n.startsWith("mailer failed"))
    ).toBe(true);
    // The mailer failure happened AFTER rendering: the persisted HTML is the
    // sendable newsletter, not an error page.
    expect(readFileSync(artifact, "utf8")).toContain("Watchlist");
  });
});
