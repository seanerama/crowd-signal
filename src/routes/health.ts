/**
 * GET /healthz per contracts/trigger-api.md (frozen v1).
 * Unauthenticated. `db` reflects a real connection + migration-table check.
 */
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { checkDb, type Db } from "../db.js";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as { version: string };

export function healthRoutes(app: FastifyInstance, db: Db): void {
  app.get("/healthz", async () => ({
    ok: true,
    version: pkg.version,
    db: checkDb(db) ? "ok" : "error"
  }));
}
