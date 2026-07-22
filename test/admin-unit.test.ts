import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { escapeHtml } from "../src/admin/html.js";
import { LoginRateLimiter } from "../src/admin/rate-limit.js";
import {
  createSession,
  csrfTokenFor,
  destroySession,
  hashToken,
  signToken,
  verifyCsrf,
  verifySessionCookie
} from "../src/admin/session.js";
import { migrate, type Db } from "../src/db.js";

describe("escapeHtml", () => {
  it("escapes all HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert("x&y").o'clock</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&amp;y&quot;).o&#39;clock&lt;/script&gt;"
    );
  });

  it("leaves plain text alone", () => {
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
  });

  it("escapes & first (no double escaping)", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("session cookie signing", () => {
  const dir = mkdtempSync(join(tmpdir(), "crowd-signal-session-"));
  const db: Db = new Database(join(dir, "test.db"));
  migrate(db);
  const secret = "unit-test-session-secret";

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips: createSession -> verifySessionCookie returns the token", () => {
    const cookie = createSession(db, secret);
    const token = verifySessionCookie(db, secret, cookie);
    expect(token).not.toBeNull();
    expect(cookie.startsWith(`${token}.`)).toBe(true);
    // only the hash is stored
    const row = db
      .prepare("SELECT token_hash FROM admin_sessions WHERE token_hash = ?")
      .get(hashToken(token!));
    expect(row).toBeDefined();
    expect(cookie).not.toContain(hashToken(token!));
  });

  it("rejects a tampered token and a tampered signature", () => {
    const cookie = createSession(db, secret);
    const [token, sig] = [
      cookie.slice(0, cookie.lastIndexOf(".")),
      cookie.slice(cookie.lastIndexOf(".") + 1)
    ];
    expect(verifySessionCookie(db, secret, `X${token.slice(1)}.${sig}`)).toBeNull();
    expect(verifySessionCookie(db, secret, `${token}.${sig.slice(0, -1)}A`)).toBeNull();
    expect(verifySessionCookie(db, secret, token)).toBeNull(); // no signature
    expect(verifySessionCookie(db, secret, undefined)).toBeNull();
    expect(verifySessionCookie(db, secret, "")).toBeNull();
  });

  it("rejects a cookie signed with a different secret", () => {
    const cookie = createSession(db, secret);
    expect(verifySessionCookie(db, "other-secret", cookie)).toBeNull();
  });

  it("rejects a well-signed token with no session row (logged out)", () => {
    const cookie = createSession(db, secret);
    const token = verifySessionCookie(db, secret, cookie)!;
    destroySession(db, token);
    expect(verifySessionCookie(db, secret, cookie)).toBeNull();
  });

  it("rejects and deletes an expired session", () => {
    const token = "expired-token-for-test";
    db.prepare(
      "INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)"
    ).run(
      hashToken(token),
      "2020-01-01T00:00:00.000Z",
      "2020-01-08T00:00:00.000Z"
    );
    const cookie = `${token}.${signToken(token, secret)}`;
    expect(verifySessionCookie(db, secret, cookie)).toBeNull();
    expect(
      db
        .prepare("SELECT * FROM admin_sessions WHERE token_hash = ?")
        .get(hashToken(token))
    ).toBeUndefined();
  });

  it("CSRF token verifies for its session and rejects tampering", () => {
    const csrf = csrfTokenFor("some-token", secret);
    expect(verifyCsrf("some-token", secret, csrf)).toBe(true);
    expect(verifyCsrf("some-token", secret, `${csrf}x`)).toBe(false);
    expect(verifyCsrf("other-token", secret, csrf)).toBe(false);
    expect(verifyCsrf("some-token", secret, undefined)).toBe(false);
    expect(verifyCsrf("some-token", secret, "")).toBe(false);
  });
});

describe("login rate limiter", () => {
  it("limits after max failures inside the window and recovers after it", () => {
    const rl = new LoginRateLimiter(5, 15 * 60 * 1000);
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(rl.isLimited("1.2.3.4", t0 + i)).toBe(false);
      rl.recordFailure("1.2.3.4", t0 + i);
    }
    expect(rl.isLimited("1.2.3.4", t0 + 10)).toBe(true);
    // other IPs unaffected
    expect(rl.isLimited("5.6.7.8", t0 + 10)).toBe(false);
    // window expiry frees the IP
    expect(rl.isLimited("1.2.3.4", t0 + 15 * 60 * 1000 + 10)).toBe(false);
  });

  it("reset clears the counter (successful login)", () => {
    const rl = new LoginRateLimiter(2, 1000);
    rl.recordFailure("ip", 0);
    rl.recordFailure("ip", 1);
    expect(rl.isLimited("ip", 2)).toBe(true);
    rl.reset("ip");
    expect(rl.isLimited("ip", 3)).toBe(false);
  });
});
