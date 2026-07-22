/**
 * Admin session auth primitives.
 *
 * - Session token: 32 random bytes. Only its SHA-256 hash is stored
 *   (admin_sessions.token_hash) — a DB copy can't be replayed as a cookie.
 * - Cookie value: `<token>.<hmac>` where the HMAC-SHA256 is keyed with
 *   ADMIN_SESSION_SECRET, so a forged/tampered cookie fails before any DB hit.
 * - Sessions expire after 7 days; expired rows are deleted on verification.
 * - CSRF token: HMAC("csrf:" + token) — derivable server-side from a valid
 *   session cookie, unguessable without the secret, no extra storage.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import type { Db } from "../db.js";

export const SESSION_COOKIE = "crowd_signal_admin";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** HMAC signature over a session token. Exported for tests. */
export function signToken(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Create a session row and return the signed cookie value. */
export function createSession(
  db: Db,
  secret: string,
  now: Date = new Date()
): string {
  const token = randomBytes(32).toString("base64url");
  db.prepare(
    "INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)"
  ).run(
    hashToken(token),
    now.toISOString(),
    new Date(now.getTime() + SESSION_TTL_MS).toISOString()
  );
  return `${token}.${signToken(token, secret)}`;
}

/**
 * Verify a cookie value: signature first (timing-safe), then session row,
 * then expiry. Returns the session token when valid, null otherwise.
 * Expired rows are deleted as a side effect.
 */
export function verifySessionCookie(
  db: Db,
  secret: string,
  cookieValue: string | undefined,
  now: Date = new Date()
): string | null {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0 || dot === cookieValue.length - 1) return null;
  const token = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  if (!safeEqual(sig, signToken(token, secret))) return null;
  const row = db
    .prepare("SELECT expires_at FROM admin_sessions WHERE token_hash = ?")
    .get(hashToken(token)) as { expires_at: string } | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(
      hashToken(token)
    );
    return null;
  }
  return token;
}

export function destroySession(db: Db, token: string): void {
  db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(
    hashToken(token)
  );
}

/** Per-session CSRF token, derived — no storage, unguessable without secret. */
export function csrfTokenFor(token: string, secret: string): string {
  return createHmac("sha256", secret).update(`csrf:${token}`).digest("base64url");
}

export function verifyCsrf(
  token: string,
  secret: string,
  presented: unknown
): boolean {
  return (
    typeof presented === "string" &&
    presented.length > 0 &&
    safeEqual(presented, csrfTokenFor(token, secret))
  );
}
