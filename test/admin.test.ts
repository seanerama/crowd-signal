import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashToken, SESSION_COOKIE, signToken } from "../src/admin/session.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { DEFAULT_HYGIENE } from "../src/profiles/hygiene.js";

const PASSWORD = "correct-horse-battery";
const SECRET = "admin-integration-secret";

function adminEnv(dataDir: string) {
  return {
    TRIGGER_API_TOKEN: "t",
    DATA_DIR: dataDir,
    ADMIN_UI_ENABLED: "true",
    ADMIN_PASSWORD: PASSWORD,
    ADMIN_SESSION_SECRET: SECRET
  };
}

function form(fields: Record<string, string>): {
  payload: string;
  headers: Record<string, string>;
} {
  return {
    payload: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" }
  };
}

function cookieFrom(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(raw, "set-cookie header expected").toBeDefined();
  return raw!.split(";")[0]!;
}

describe("admin UI kill-switch (flag OFF)", () => {
  it("/admin and /admin/login are 404 when ADMIN_UI_ENABLED is off", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crowd-signal-adminoff-"));
    const app = buildApp(
      loadConfig({ TRIGGER_API_TOKEN: "t", DATA_DIR: dataDir })
    );
    await app.ready();
    try {
      expect((await app.inject({ url: "/admin" })).statusCode).toBe(404);
      expect((await app.inject({ url: "/admin/login" })).statusCode).toBe(404);
      expect(
        (await app.inject({ method: "POST", url: "/admin/login" })).statusCode
      ).toBe(404);
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("admin login rate limiting (fresh app, in-memory limiter)", () => {
  it("5 wrong passwords -> 401 each, 6th attempt -> 429", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "crowd-signal-adminrl-"));
    const app = buildApp(loadConfig(adminEnv(dataDir)));
    await app.ready();
    try {
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/admin/login",
          ...form({ password: "wrong" })
        });
        expect(res.statusCode).toBe(401);
        expect(res.body).toContain("Wrong password");
      }
      const blocked = await app.inject({
        method: "POST",
        url: "/admin/login",
        ...form({ password: PASSWORD }) // even the right password is blocked
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.body).toContain("too many login attempts");
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("admin UI (integration, temp DATA_DIR)", () => {
  let dataDir: string;
  let app: FastifyInstance;
  let cookie: string;
  let csrf: string;
  let profileId: string;
  let profileUrl: string;

  function db() {
    return new Database(join(dataDir, "pulse.db"));
  }

  async function getCsrf(url: string): Promise<string> {
    const res = await app.inject({ url, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const m = res.body.match(/name="_csrf" value="([^"]+)"/);
    expect(m, `csrf token on ${url}`).not.toBeNull();
    return m![1]!;
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "crowd-signal-admin-"));
    app = buildApp(loadConfig(adminEnv(dataDir)));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("unauthenticated GET /admin -> 302 to /admin/login", async () => {
    const res = await app.inject({ url: "/admin" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/admin/login");
  });

  it("GET /admin/login renders the password form", async () => {
    const res = await app.inject({ url: "/admin/login" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("log in");
    expect(res.body).toContain('type="password"');
  });

  it("wrong password -> 401, no cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      ...form({ password: "nope" })
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("right password -> 302 with httpOnly session cookie scoped to /admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      ...form({ password: PASSWORD })
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/admin");
    const raw = res.headers["set-cookie"] as string;
    expect(raw).toContain(`${SESSION_COOKIE}=`);
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
    expect(raw).toContain("Path=/admin");
    expect(raw).not.toContain("Secure"); // http request
    cookie = cookieFrom(res.headers["set-cookie"]);
  });

  it("x-forwarded-proto https -> Secure cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      ...form({ password: PASSWORD }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-proto": "https"
      }
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers["set-cookie"]).toContain("Secure");
  });

  it("authenticated GET /admin shows dashboard with seeded example profile + run history", async () => {
    const res = await app.inject({ url: "/admin", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Audience profiles");
    expect(res.body).toContain("Run history");
    // repo profiles/example.json seeded on first boot (zero-profile DB)
    expect(res.body).toContain("Example profile");
    expect(res.body).toContain("inactive");
  });

  it("POST without CSRF token -> 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/profiles",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ name: "No CSRF" }).toString()
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("CSRF");
  });

  it("create profile -> 302 to edit page; row persisted with hygiene defaults", async () => {
    csrf = await getCsrf("/admin/profiles/new");
    const res = await app.inject({
      method: "POST",
      url: "/admin/profiles",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        _csrf: csrf,
        name: "Farmer <script>alert(1)</script>",
        description: "Weather & crops",
        recipients: "op@example.com\nsecond@example.com"
      }).toString()
    });
    expect(res.statusCode).toBe(302);
    profileUrl = res.headers.location as string;
    expect(profileUrl).toMatch(/^\/admin\/profiles\/.+/);
    profileId = decodeURIComponent(profileUrl.split("/").pop()!);

    const d = db();
    try {
      const row = d
        .prepare("SELECT * FROM profiles WHERE id = ?")
        .get(profileId) as {
        name: string;
        recipients: string;
        hygiene_config: string;
        active: number;
      };
      expect(row).toBeDefined();
      expect(row.name).toBe("Farmer <script>alert(1)</script>");
      expect(JSON.parse(row.recipients)).toEqual([
        "op@example.com",
        "second@example.com"
      ]);
      expect(JSON.parse(row.hygiene_config)).toEqual(DEFAULT_HYGIENE);
      expect(row.active).toBe(1);
    } finally {
      d.close();
    }
  });

  it("profile page escapes user-supplied strings and shows the ADR 0004 recipient notice", async () => {
    const res = await app.inject({ url: profileUrl, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(res.body).toContain("Weather &amp; crops");
    expect(res.body).toContain("Resend-account inbox");
  });

  it("add series + event subscriptions -> both listed", async () => {
    csrf = await getCsrf(profileUrl);
    for (const [ticker, kind] of [
      ["kxhighchi", "series"],
      ["KXCPI-26", "event"]
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: `${profileUrl}/subscriptions`,
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ _csrf: csrf, ticker, kind }).toString()
      });
      expect(res.statusCode).toBe(302);
    }
    const page = await app.inject({ url: profileUrl, headers: { cookie } });
    expect(page.body).toContain("<td>KXHIGHCHI</td>"); // normalized upper-case
    expect(page.body).toContain("<td>KXCPI-26</td>");
    expect(page.body).toContain("<td>series</td>");
    expect(page.body).toContain("<td>event</td>");
  });

  it("duplicate subscription add is idempotent (documented choice): 302, still one row", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${profileUrl}/subscriptions`,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        _csrf: csrf,
        ticker: "KXHIGHCHI",
        kind: "series"
      }).toString()
    });
    expect(res.statusCode).toBe(302);
    const d = db();
    try {
      const n = (
        d
          .prepare(
            "SELECT COUNT(*) AS n FROM subscriptions WHERE profile_id = ? AND ticker = 'KXHIGHCHI' AND kind = 'series'"
          )
          .get(profileId) as { n: number }
      ).n;
      expect(n).toBe(1);
    } finally {
      d.close();
    }
  });

  it("remove subscription -> gone from page and DB", async () => {
    const d = db();
    let subId: string;
    try {
      subId = (
        d
          .prepare(
            "SELECT id FROM subscriptions WHERE profile_id = ? AND ticker = 'KXHIGHCHI'"
          )
          .get(profileId) as { id: string }
      ).id;
    } finally {
      d.close();
    }
    const res = await app.inject({
      method: "POST",
      url: `${profileUrl}/subscriptions/remove`,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ _csrf: csrf, subscriptionId: subId }).toString()
    });
    expect(res.statusCode).toBe(302);
    const page = await app.inject({ url: profileUrl, headers: { cookie } });
    // table cell gone (the form's "e.g. KXHIGHCHI" hint still mentions it)
    expect(page.body).not.toContain("<td>KXHIGHCHI</td>");
    expect(page.body).toContain("<td>KXCPI-26</td>"); // the other one survives
  });

  it("edit hygiene config -> persisted; out-of-bounds -> 400", async () => {
    const save = await app.inject({
      method: "POST",
      url: profileUrl,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        _csrf: csrf,
        name: "Farmer",
        description: "Weather & crops",
        recipients: "op@example.com",
        active: "1",
        thresholdPts: "7",
        deadBandPts: "3",
        cooldownHours: "6",
        dailyCap: "3",
        quietStart: "21:30",
        quietEnd: "06:30",
        liquidityFloorUsd: "2000"
      }).toString()
    });
    expect(save.statusCode).toBe(302);
    const d = db();
    try {
      const row = d
        .prepare("SELECT hygiene_config FROM profiles WHERE id = ?")
        .get(profileId) as { hygiene_config: string };
      expect(JSON.parse(row.hygiene_config)).toEqual({
        thresholdPts: 7,
        deadBandPts: 3,
        cooldownHours: 6,
        dailyCap: 3,
        quietHours: { start: "21:30", end: "06:30" },
        liquidityFloorUsd: 2000
      });
    } finally {
      d.close();
    }

    const bad = await app.inject({
      method: "POST",
      url: profileUrl,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        _csrf: csrf,
        name: "Farmer",
        thresholdPts: "99"
      }).toString()
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("thresholdPts");
  });

  it("expired session -> redirect to login and row cleaned up", async () => {
    const token = "expired-integration-token";
    const d = db();
    try {
      d.prepare(
        "INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)"
      ).run(
        hashToken(token),
        "2020-01-01T00:00:00.000Z",
        "2020-01-08T00:00:00.000Z"
      );
    } finally {
      d.close();
    }
    const expiredCookie = `${SESSION_COOKIE}=${token}.${signToken(token, SECRET)}`;
    const res = await app.inject({
      url: "/admin",
      headers: { cookie: expiredCookie }
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/admin/login");
  });

  it("tampered cookie -> redirect to login", async () => {
    const res = await app.inject({
      url: "/admin",
      headers: { cookie: `${cookie}tampered` }
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/admin/login");
  });

  it("logout destroys the session; old cookie no longer works", async () => {
    csrf = await getCsrf("/admin");
    const res = await app.inject({
      method: "POST",
      url: "/admin/logout",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ _csrf: csrf }).toString()
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/admin/login");
    expect(res.headers["set-cookie"]).toContain("Max-Age=0");

    const after = await app.inject({ url: "/admin", headers: { cookie } });
    expect(after.statusCode).toBe(302);
    expect(after.headers.location).toBe("/admin/login");
  });
});
