/**
 * Fastify app factory (ADR 0001). buildApp() owns the DB handle so tests can
 * boot the whole spine against a temp DATA_DIR. The optional `overrides`
 * parameter is a TEST-ONLY injection surface (mock Kalshi transport, captured
 * mailer); production callers pass nothing.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { adminRoutes } from "./admin/routes.js";
import type { Config } from "./config.js";
import { openDb } from "./db.js";
import { createKalshiSource } from "./kalshi/index.js";
import type { KalshiClientOverrides } from "./kalshi/client.js";
import { createMailer, DryRunMailer, type Mailer } from "./mailer/index.js";
import { seedProfilesIfEmpty } from "./profiles/store.js";
import { healthRoutes } from "./routes/health.js";
import { drainRuns, triggerRoutes } from "./routes/trigger.js";

export interface AppOverrides {
  kalshi?: KalshiClientOverrides;
  /** Replaces BOTH the default and the dryRun mailer (test capture). */
  mailer?: Mailer;
}

export function buildApp(
  config: Config,
  overrides: AppOverrides = {}
): FastifyInstance {
  const db = openDb(config.dataDir);
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  // First-boot seeding (ADR 0002): repo profiles/ → DB when it has none.
  const seeded = seedProfilesIfEmpty(db);
  if (seeded.seeded > 0) {
    app.log.info({ seeded: seeded.seeded }, "seeded profiles from repo");
  }
  if (seeded.skipped.length > 0) {
    app.log.warn({ skipped: seeded.skipped }, "invalid profile seed files skipped");
  }

  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err instanceof Error ? (err as Error & { statusCode?: number }) : undefined;
    const status = e?.statusCode && e.statusCode < 500 ? e.statusCode : 500;
    if (status >= 500) app.log.error(err);
    void reply
      .code(status)
      .send({ error: status >= 500 ? "internal error" : e?.message ?? "error" });
  });

  const source = createKalshiSource(config, app.log, overrides.kalshi ?? {});
  const mailer = overrides.mailer ?? createMailer(config, app.log);
  const dryRunMailer = overrides.mailer ?? new DryRunMailer(app.log);

  healthRoutes(app, db);
  triggerRoutes(app, db, config, { source, mailer, dryRunMailer });
  // Kill-switch (spec stage 4): flag OFF → admin routes are never registered,
  // so /admin* is a plain 404.
  if (config.flags.ADMIN_UI_ENABLED) {
    adminRoutes(app, db, config);
  }

  app.addHook("onClose", async () => {
    // Let any in-flight async runs settle before the DB handle goes away.
    await drainRuns();
    db.close();
  });

  return app;
}
