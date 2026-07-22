/**
 * POST /trigger/daily and /trigger/discovery per contracts/trigger-api.md
 * (frozen v1). Stage-1 stub pipeline: insert a runs row, write a minimal
 * self-contained HTML artifact under <DATA_DIR>/artifacts/<runId>/, return 202.
 * Idempotent-per-day: a completed run of the same kind for today (UTC) returns
 * 200 { runId, alreadyRan: true } unless force === true.
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from "fastify";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { Db } from "../db.js";

interface TriggerBody {
  profileId?: string;
  force?: boolean;
  dryRun?: boolean;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

function placeholderHtml(runId: string, kind: string, startedAt: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Crowd-Signal — ${kind} run (stub)</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; background: #fafafa; }
  .card { max-width: 40rem; border: 1px solid #ddd; border-radius: 8px; padding: 1.5rem; background: #fff; }
  h1 { font-size: 1.2rem; margin: 0 0 .75rem; }
  dt { font-weight: 600; } dd { margin: 0 0 .5rem; font-family: monospace; }
</style>
</head>
<body>
<div class="card">
<h1>Crowd-Signal — stub ${kind} run</h1>
<p>Walking-skeleton placeholder artifact. Real rendering arrives in a later stage.</p>
<dl>
<dt>runId</dt><dd>${runId}</dd>
<dt>kind</dt><dd>${kind}</dd>
<dt>startedAt</dt><dd>${startedAt}</dd>
</dl>
</div>
</body>
</html>
`;
}

export function triggerRoutes(
  app: FastifyInstance,
  db: Db,
  config: Config
): void {
  const findCompletedToday = db.prepare(
    "SELECT run_id FROM runs WHERE kind = ? AND day = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 1"
  );
  const insertRun = db.prepare(
    "INSERT INTO runs (run_id, kind, day, started_at, status) VALUES (?, ?, ?, ?, 'running')"
  );
  const completeRun = db.prepare(
    "UPDATE runs SET status = 'completed', finished_at = ? WHERE run_id = ?"
  );

  const requireToken = async (
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    if (!tokenMatches(req.headers.authorization, config.triggerApiToken)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };

  const runStubPipeline = (kind: "daily" | "discovery", force: boolean) => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10); // UTC day
    if (!force) {
      const existing = findCompletedToday.get(kind, day) as
        | { run_id: string }
        | undefined;
      if (existing) {
        return { alreadyRan: true as const, runId: existing.run_id };
      }
    }
    const runId = randomUUID();
    const startedAt = now.toISOString();
    insertRun.run(runId, kind, day, startedAt);
    // Stub pipeline: write the placeholder artifact (self-contained HTML,
    // inline CSS, zero external requests — ADR 0001).
    const artifactDir = join(config.dataDir, "artifacts", runId);
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "placeholder.html"),
      placeholderHtml(runId, kind, startedAt),
      "utf8"
    );
    completeRun.run(new Date().toISOString(), runId);
    return { alreadyRan: false as const, runId, startedAt };
  };

  const handler =
    (kind: "daily" | "discovery") =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      // profileId / dryRun are accepted per contract; the stub ignores them.
      const body = (req.body ?? {}) as TriggerBody;
      const result = runStubPipeline(kind, body.force === true);
      if (result.alreadyRan) {
        return reply.code(200).send({ runId: result.runId, alreadyRan: true });
      }
      return reply
        .code(202)
        .send({ runId: result.runId, startedAt: result.startedAt });
    };

  // Body is optional per the contract ({ profileId?, force?, dryRun? }); no
  // strict schema so a body-less POST is accepted.
  const opts = { preHandler: requireToken };
  app.post("/trigger/daily", opts, handler("daily"));
  app.post("/trigger/discovery", opts, handler("discovery"));
}
