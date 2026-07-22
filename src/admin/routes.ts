/**
 * Server-rendered admin UI (spec stage 4; ADR 0001). Session-cookie auth,
 * per-session CSRF tokens on every POST, inline CSS, no client build.
 * Registered ONLY when ADMIN_UI_ENABLED is ON — flag OFF means these routes
 * do not exist (404), the kill-switch posture.
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from "fastify";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { HygieneError } from "../profiles/hygiene.js";
import {
  addSubscription,
  createProfile,
  getProfile,
  listProfiles,
  listSubscriptions,
  removeSubscription,
  StoreError,
  updateProfile,
  type Profile
} from "../profiles/store.js";
import { escapeHtml, layout } from "./html.js";
import { LoginRateLimiter } from "./rate-limit.js";
import {
  createSession,
  csrfTokenFor,
  destroySession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifyCsrf,
  verifySessionCookie
} from "./session.js";

interface RunRow {
  run_id: string;
  kind: string;
  day: string;
  started_at: string;
  finished_at: string | null;
  status: string;
}

/** ADR 0004: shown wherever recipients are edited. */
const RECIPIENT_NOTICE = `<p class="notice">v1 delivery constraint (ADR 0004):
emails are sent from the shared Resend sender and deliver <strong>only to the
operator&#39;s own Resend-account inbox</strong>. Other addresses listed here will
not receive mail until a sending domain is verified (v1.5).</p>`;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function passwordMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isHttps(req: FastifyRequest): boolean {
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (proto) return proto.split(",")[0]?.trim() === "https";
  return req.protocol === "https";
}

function sessionCookie(
  value: string,
  secure: boolean,
  maxAgeSeconds: number
): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function html(reply: FastifyReply, page: string, code = 200): FastifyReply {
  return reply.code(code).type("text/html; charset=utf-8").send(page);
}

export function adminRoutes(
  app: FastifyInstance,
  db: Db,
  config: Config
): void {
  const secret = config.adminSessionSecret;
  const limiter = new LoginRateLimiter();

  // Admin forms POST as application/x-www-form-urlencoded; the spine has no
  // parser for it (JSON-only API elsewhere), so register one here.
  if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) {
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    );
  }

  /** Valid session token, or null (after sending the redirect to login). */
  function requireSession(
    req: FastifyRequest,
    reply: FastifyReply
  ): string | null {
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const token = verifySessionCookie(db, secret, cookie);
    if (!token) {
      void reply.redirect("/admin/login", 302);
      return null;
    }
    return token;
  }

  /** True when the POST body carries the session's CSRF token; 403 otherwise. */
  function requireCsrf(
    token: string,
    req: FastifyRequest,
    reply: FastifyReply
  ): boolean {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!verifyCsrf(token, secret, body._csrf)) {
      void html(
        reply,
        layout("Forbidden", `<div class="card"><h1>403 — invalid CSRF token</h1>
<p><a href="/admin">Back to admin</a></p></div>`),
        403
      );
      return false;
    }
    return true;
  }

  function nav(csrf: string): string {
    return `<nav>
<a href="/admin">Profiles</a>
<a href="/admin/profiles/new">New profile</a>
<form method="post" action="/admin/logout">
<input type="hidden" name="_csrf" value="${csrf}">
<button class="secondary" type="submit">Log out</button>
</form>
</nav>`;
  }

  // ---------- login / logout ----------

  function loginPage(error?: string): string {
    return layout(
      "Log in",
      `<div class="card">
<h1>Crowd-Signal admin — log in</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/admin/login">
<label for="password">Password</label>
<input type="password" id="password" name="password" autocomplete="current-password" autofocus>
<br><button type="submit">Log in</button>
</form>
</div>`
    );
  }

  app.get("/admin/login", async (req, reply) => {
    // Already signed in? Straight to the dashboard.
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (verifySessionCookie(db, secret, cookie)) {
      return reply.redirect("/admin", 302);
    }
    return html(reply, loginPage());
  });

  app.post("/admin/login", async (req, reply) => {
    const ip = req.ip;
    if (limiter.isLimited(ip)) {
      return html(
        reply,
        layout("Too many attempts", `<div class="card"><h1>429 — too many login attempts</h1>
<p>Wait 15 minutes and try again.</p></div>`),
        429
      );
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const password = typeof body.password === "string" ? body.password : "";
    if (!passwordMatches(password, config.adminPassword)) {
      limiter.recordFailure(ip);
      return html(reply, loginPage("Wrong password."), 401);
    }
    limiter.reset(ip);
    const cookieValue = createSession(db, secret);
    return reply
      .header(
        "set-cookie",
        sessionCookie(cookieValue, isHttps(req), SESSION_TTL_MS / 1000)
      )
      .redirect("/admin", 302);
  });

  app.post("/admin/logout", async (req, reply) => {
    const token = requireSession(req, reply);
    if (!token) return reply;
    if (!requireCsrf(token, req, reply)) return reply;
    destroySession(db, token);
    return reply
      .header("set-cookie", sessionCookie("", isHttps(req), 0))
      .redirect("/admin/login", 302);
  });

  // ---------- dashboard: profile list + run history ----------

  app.get("/admin", async (req, reply) => {
    const token = requireSession(req, reply);
    if (!token) return reply;
    const csrf = csrfTokenFor(token, secret);

    const profiles = listProfiles(db);
    const profileRows = profiles
      .map((p) => {
        const subs = listSubscriptions(db, p.id).length;
        return `<tr>
<td><a href="/admin/profiles/${encodeURIComponent(p.id)}">${escapeHtml(p.name)}</a></td>
<td><span class="badge${p.active ? " on" : ""}">${p.active ? "active" : "inactive"}</span></td>
<td>${p.recipients.length}</td>
<td>${subs}</td>
<td class="muted">${escapeHtml(p.updatedAt)}</td>
</tr>`;
      })
      .join("\n");

    /** Links to persisted artifact HTML files for a run (from disk). */
    function artifactLinks(runId: string): string {
      let files: string[];
      try {
        files = readdirSync(join(config.dataDir, "artifacts", runId)).filter(
          (f) => f.endsWith(".html")
        );
      } catch {
        files = [];
      }
      if (files.length === 0) return `<span class="muted">—</span>`;
      return files
        .map((f) => {
          const profileId = f.slice(0, -".html".length);
          return `<a href="/admin/artifacts/${encodeURIComponent(runId)}/${encodeURIComponent(profileId)}">${escapeHtml(profileId)}</a>`;
        })
        .join(" ");
    }

    const runs = db
      .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 20")
      .all() as RunRow[];
    const runRows = runs
      .map(
        (r) => `<tr>
<td class="muted">${escapeHtml(r.run_id.slice(0, 8))}</td>
<td>${escapeHtml(r.kind)}</td>
<td>${escapeHtml(r.day)}</td>
<td class="muted">${escapeHtml(r.started_at)}</td>
<td>${escapeHtml(r.status)}</td>
<td>${artifactLinks(r.run_id)}</td>
</tr>`
      )
      .join("\n");

    return html(
      reply,
      layout(
        "Profiles",
        `${nav(csrf)}
<div class="card">
<h1>Audience profiles</h1>
${
  profiles.length === 0
    ? `<p class="muted">No profiles yet. <a href="/admin/profiles/new">Create one</a>.</p>`
    : `<table>
<thead><tr><th>Name</th><th>Status</th><th>Recipients</th><th>Subscriptions</th><th>Updated</th></tr></thead>
<tbody>${profileRows}</tbody>
</table>`
}
</div>
<div class="card">
<h2>Run history (latest 20)</h2>
${
  runs.length === 0
    ? `<p class="muted">No runs recorded yet.</p>`
    : `<table>
<thead><tr><th>Run</th><th>Kind</th><th>Day</th><th>Started</th><th>Status</th><th>Artifacts</th></tr></thead>
<tbody>${runRows}</tbody>
</table>`
}
</div>`
      )
    );
  });

  // ---------- run artifacts (view sent HTML) ----------

  // Path-traversal safety: both ids are validated against a strict allowlist
  // BEFORE any filesystem access; nothing outside artifacts/<runId>/ is ever
  // touched. (Run ids are UUIDs; profile ids from seeds/admin fit this too.)
  const SAFE_ID = /^[A-Za-z0-9-]+$/;

  app.get("/admin/artifacts/:runId/:profileId", async (req, reply) => {
    const token = requireSession(req, reply);
    if (!token) return reply;
    const { runId, profileId } = req.params as {
      runId: string;
      profileId: string;
    };
    if (!SAFE_ID.test(runId) || !SAFE_ID.test(profileId)) {
      return html(
        reply,
        layout("Bad request", `<div class="card"><h1>400 — invalid artifact id</h1>
<p><a href="/admin">Back to admin</a></p></div>`),
        400
      );
    }
    const path = join(config.dataDir, "artifacts", runId, `${profileId}.html`);
    if (!existsSync(path)) {
      return html(
        reply,
        layout("Not found", `<div class="card"><h1>404 — no such artifact</h1>
<p><a href="/admin">Back to admin</a></p></div>`),
        404
      );
    }
    // The artifact IS the sent newsletter — serve it verbatim.
    return html(reply, readFileSync(path, "utf8"));
  });

  // ---------- profile create ----------

  app.get("/admin/profiles/new", async (req, reply) => {
    const token = requireSession(req, reply);
    if (!token) return reply;
    const csrf = csrfTokenFor(token, secret);
    return html(
      reply,
      layout(
        "New profile",
        `${nav(csrf)}
<div class="card">
<h1>New profile</h1>
<form method="post" action="/admin/profiles">
<input type="hidden" name="_csrf" value="${csrf}">
<label for="name">Name</label>
<input type="text" id="name" name="name" required>
<label for="description">Description</label>
<textarea id="description" name="description"></textarea>
<label for="recipients">Recipient emails (one per line)</label>
<textarea id="recipients" name="recipients"></textarea>
${RECIPIENT_NOTICE}
<p class="muted">Hygiene config starts with ADR 0005 defaults; edit it on the profile page after creating.</p>
<button type="submit">Create profile</button>
</form>
</div>`
      )
    );
  });

  function parseRecipients(raw: unknown): string[] {
    if (typeof raw !== "string") return [];
    return raw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }

  app.post("/admin/profiles", async (req, reply) => {
    const token = requireSession(req, reply);
    if (!token) return reply;
    if (!requireCsrf(token, req, reply)) return reply;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const profile = createProfile(db, {
        name: typeof body.name === "string" ? body.name : "",
        description:
          typeof body.description === "string" ? body.description : "",
        recipients: parseRecipients(body.recipients)
      });
      return reply.redirect(
        `/admin/profiles/${encodeURIComponent(profile.id)}`,
        302
      );
    } catch (err) {
      return badRequest(reply, err, "/admin/profiles/new");
    }
  });

  // ---------- profile edit + hygiene + subscriptions ----------

  function hygieneFields(p: Profile): string {
    const h = p.hygiene;
    return `<div class="grid">
<div><label for="thresholdPts">Threshold (pts, 1–50)</label>
<input type="number" id="thresholdPts" name="thresholdPts" min="1" max="50" step="0.5" value="${h.thresholdPts}"></div>
<div><label for="deadBandPts">Dead band (pts, 0–threshold)</label>
<input type="number" id="deadBandPts" name="deadBandPts" min="0" step="0.5" value="${h.deadBandPts}"></div>
<div><label for="cooldownHours">Cooldown (h, 0–48)</label>
<input type="number" id="cooldownHours" name="cooldownHours" min="0" max="48" step="0.5" value="${h.cooldownHours}"></div>
<div><label for="dailyCap">Daily cap (1–20)</label>
<input type="number" id="dailyCap" name="dailyCap" min="1" max="20" step="1" value="${h.dailyCap}"></div>
<div><label for="quietStart">Quiet hours start</label>
<input type="time" id="quietStart" name="quietStart" value="${escapeHtml(h.quietHours.start)}"></div>
<div><label for="quietEnd">Quiet hours end</label>
<input type="time" id="quietEnd" name="quietEnd" value="${escapeHtml(h.quietHours.end)}"></div>
<div><label for="liquidityFloorUsd">Liquidity floor (USD, ≥ 0)</label>
<input type="number" id="liquidityFloorUsd" name="liquidityFloorUsd" min="0" step="100" value="${h.liquidityFloorUsd}"></div>
</div>`;
  }

  app.get("/admin/profiles/:id", async (req, reply) => {
    const token = requireSession(req, reply);
    if (!token) return reply;
    const csrf = csrfTokenFor(token, secret);
    const { id } = req.params as { id: string };
    const profile = getProfile(db, id);
    if (!profile) {
      return html(
        reply,
        layout("Not found", `<div class="card"><h1>404 — no such profile</h1>
<p><a href="/admin">Back to admin</a></p></div>`),
        404
      );
    }
    const subs = listSubscriptions(db, profile.id);
    const subRows = subs
      .map(
        (s) => `<tr>
<td>${escapeHtml(s.ticker)}</td>
<td>${escapeHtml(s.kind)}</td>
<td class="muted">${escapeHtml(s.addedAt)}</td>
<td>
<form class="inline-form" method="post" action="/admin/profiles/${encodeURIComponent(profile.id)}/subscriptions/remove">
<input type="hidden" name="_csrf" value="${csrf}">
<input type="hidden" name="subscriptionId" value="${escapeHtml(s.id)}">
<button class="danger" type="submit">Remove</button>
</form>
</td>
</tr>`
      )
      .join("\n");

    return html(
      reply,
      layout(
        escapeHtml(profile.name),
        `${nav(csrf)}
<div class="card">
<h1>Profile: ${escapeHtml(profile.name)}</h1>
<form method="post" action="/admin/profiles/${encodeURIComponent(profile.id)}">
<input type="hidden" name="_csrf" value="${csrf}">
<label for="name">Name</label>
<input type="text" id="name" name="name" value="${escapeHtml(profile.name)}" required>
<label for="description">Description</label>
<textarea id="description" name="description">${escapeHtml(profile.description)}</textarea>
<label for="recipients">Recipient emails (one per line)</label>
<textarea id="recipients" name="recipients">${escapeHtml(profile.recipients.join("\n"))}</textarea>
${RECIPIENT_NOTICE}
<label><input type="checkbox" name="active" value="1"${profile.active ? " checked" : ""}> Active (included in daily runs and watching)</label>
<h2 style="margin-top:1.25rem">Alert hygiene (ADR 0005)</h2>
${hygieneFields(profile)}
<button type="submit">Save profile</button>
</form>
</div>
<div class="card">
<h2>Subscriptions</h2>
${
  subs.length === 0
    ? `<p class="muted">No subscriptions yet.</p>`
    : `<table>
<thead><tr><th>Ticker</th><th>Kind</th><th>Added</th><th></th></tr></thead>
<tbody>${subRows}</tbody>
</table>`
}
<form method="post" action="/admin/profiles/${encodeURIComponent(profile.id)}/subscriptions">
<input type="hidden" name="_csrf" value="${csrf}">
<label for="ticker">Ticker (series or event, e.g. KXHIGHCHI)</label>
<input type="text" id="ticker" name="ticker" required>
<label for="kind">Kind</label>
<select id="kind" name="kind">
<option value="series">series</option>
<option value="event">event</option>
</select>
<br><button type="submit">Add subscription</button>
<p class="muted">Re-adding an existing ticker+kind is a no-op (idempotent). Live catalog search arrives with Stage 7 — manual entry for now.</p>
</form>
</div>`
      )
    );
  });

  app.post("/admin/profiles/:id", async (req, reply) => {
    const token = requireSession(req, reply);
    if (!token) return reply;
    if (!requireCsrf(token, req, reply)) return reply;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const updated = updateProfile(db, id, {
        name: typeof body.name === "string" ? body.name : undefined,
        description:
          typeof body.description === "string" ? body.description : "",
        recipients: parseRecipients(body.recipients),
        active: body.active === "1",
        hygiene: {
          thresholdPts: body.thresholdPts,
          deadBandPts: body.deadBandPts,
          cooldownHours: body.cooldownHours,
          dailyCap: body.dailyCap,
          quietHours: { start: body.quietStart, end: body.quietEnd },
          liquidityFloorUsd: body.liquidityFloorUsd
        }
      });
      if (!updated) {
        return html(
          reply,
          layout("Not found", `<div class="card"><h1>404 — no such profile</h1>
<p><a href="/admin">Back to admin</a></p></div>`),
          404
        );
      }
      return reply.redirect(`/admin/profiles/${encodeURIComponent(id)}`, 302);
    } catch (err) {
      return badRequest(reply, err, `/admin/profiles/${encodeURIComponent(id)}`);
    }
  });

  app.post("/admin/profiles/:id/subscriptions", async (req, reply) => {
    const token = requireSession(req, reply);
    if (!token) return reply;
    if (!requireCsrf(token, req, reply)) return reply;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = body.kind === "event" ? "event" : "series";
    try {
      // Duplicate add is idempotent by store contract — redirect either way.
      addSubscription(
        db,
        id,
        typeof body.ticker === "string" ? body.ticker : "",
        kind
      );
      return reply.redirect(`/admin/profiles/${encodeURIComponent(id)}`, 302);
    } catch (err) {
      return badRequest(reply, err, `/admin/profiles/${encodeURIComponent(id)}`);
    }
  });

  app.post("/admin/profiles/:id/subscriptions/remove", async (req, reply) => {
    const token = requireSession(req, reply);
    if (!token) return reply;
    if (!requireCsrf(token, req, reply)) return reply;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.subscriptionId === "string") {
      removeSubscription(db, body.subscriptionId);
    }
    return reply.redirect(`/admin/profiles/${encodeURIComponent(id)}`, 302);
  });

  function badRequest(
    reply: FastifyReply,
    err: unknown,
    backHref: string
  ): FastifyReply {
    if (err instanceof HygieneError || err instanceof StoreError) {
      return html(
        reply,
        layout("Invalid input", `<div class="card"><h1>400 — invalid input</h1>
<p class="error">${escapeHtml(err.message)}</p>
<p><a href="${backHref}">Go back</a></p></div>`),
        400
      );
    }
    throw err;
  }
}
