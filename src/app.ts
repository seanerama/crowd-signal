/**
 * Fastify app factory (ADR 0001). buildApp() owns the DB handle so tests can
 * boot the whole spine against a temp DATA_DIR.
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { openDb } from "./db.js";
import { healthRoutes } from "./routes/health.js";
import { triggerRoutes } from "./routes/trigger.js";

export function buildApp(config: Config): FastifyInstance {
  const db = openDb(config.dataDir);
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

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

  app.addHook("onClose", async () => {
    db.close();
  });

  return app;
}
