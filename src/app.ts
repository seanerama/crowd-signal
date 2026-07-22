/**
 * Fastify app factory (ADR 0001). buildApp() owns the DB handle so tests can
 * boot the whole spine against a temp DATA_DIR.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { adminRoutes } from "./admin/routes.js";
import type { Config } from "./config.js";
import { openDb } from "./db.js";
import { seedProfilesIfEmpty } from "./profiles/store.js";
import { healthRoutes } from "./routes/health.js";
import { triggerRoutes } from "./routes/trigger.js";

export function buildApp(config: Config): FastifyInstance {
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

  healthRoutes(app, db);
  triggerRoutes(app, db, config);
  // Kill-switch (spec stage 4): flag OFF → admin routes are never registered,
  // so /admin* is a plain 404.
  if (config.flags.ADMIN_UI_ENABLED) {
    adminRoutes(app, db, config);
  }

  app.addHook("onClose", async () => {
    db.close();
  });

  return app;
}
