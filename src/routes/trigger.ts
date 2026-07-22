/**
 * POST /trigger/daily and /trigger/discovery per contracts/trigger-api.md
 * (frozen v1). Wire shapes and auth are unchanged from stage 1; the pipeline
 * behind them is now real AND async: the route inserts the runs row, replies
 * 202 { runId, startedAt } IMMEDIATELY, and executes the pipeline after the
 * reply (setImmediate). Outcome lands in the runs table (completed/degraded)
 * — never an unhandled rejection.
 *
 * Idempotent-per-day per kind: a repeat call on a day that already has a
 * finished run (completed OR degraded — a degraded run still completed, per
 * the contract's fail-open posture) returns 200 { runId, alreadyRan: true }
 * unless force:true.
 *
 * dryRun:true routes that run's sends through a DryRunMailer (render +
 * persist, no real send).
 *
 * Test hook: `awaitRun(runId)` resolves when the async pipeline for that run
 * has settled (immediately for unknown/already-finished runs). `drainRuns()`
 * awaits everything in flight — app.ts calls it on close before the DB shuts.
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from "fastify";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { KalshiSource } from "../kalshi/types.js";
import type { Mailer } from "../mailer/index.js";
import { executeDailyRun, executeDiscoveryStub } from "../pipeline/daily.js";

interface TriggerBody {
  profileId?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface TriggerDeps {
  source: KalshiSource;
  /** Default mailer (already a DryRunMailer when MAILER_ENABLED is off). */
  mailer: Mailer;
  /** Mailer used when a trigger body carries dryRun:true. */
  dryRunMailer: Mailer;
}

/** In-flight pipeline promises by runId (never-rejecting). */
const activeRuns = new Map<string, Promise<void>>();

/** Test hook: resolves once the run's async pipeline has settled. */
export function awaitRun(runId: string): Promise<void> {
  return activeRuns.get(runId) ?? Promise.resolve();
}

/** Await every in-flight run (called on app close, before the DB closes). */
export async function drainRuns(): Promise<void> {
  while (activeRuns.size > 0) {
    await Promise.allSettled([...activeRuns.values()]);
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

export function triggerRoutes(
  app: FastifyInstance,
  db: Db,
  config: Config,
  deps: TriggerDeps
): void {
  const findFinishedToday = db.prepare(
    "SELECT run_id FROM runs WHERE kind = ? AND day = ? AND status IN ('completed', 'degraded') ORDER BY started_at DESC LIMIT 1"
  );
  const insertRun = db.prepare(
    "INSERT INTO runs (run_id, kind, day, started_at, status) VALUES (?, ?, ?, ?, 'running')"
  );
  const markDegraded = db.prepare(
    "UPDATE runs SET status = 'degraded', finished_at = ? WHERE run_id = ? AND status = 'running'"
  );

  const requireToken = async (
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    if (!tokenMatches(req.headers.authorization, config.triggerApiToken)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };

  /** Schedule the pipeline after the 202 flushes; track for awaitRun/drain. */
  function schedule(runId: string, pipeline: () => Promise<void>): void {
    const task = (async () => {
      // Yield a macrotask so the 202 reply is dispatched before any work.
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        await pipeline();
      } catch (err) {
        // The pipeline is fail-open and should never throw; belt & braces.
        app.log.error({ err, runId }, "run pipeline crashed");
        try {
          markDegraded.run(new Date().toISOString(), runId);
        } catch (dbErr) {
          app.log.error({ err: dbErr, runId }, "failed to mark run degraded");
        }
      }
    })();
    activeRuns.set(runId, task);
    void task.finally(() => activeRuns.delete(runId));
  }

  const handler =
    (kind: "daily" | "discovery") =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as TriggerBody;
      const now = new Date();
      const day = now.toISOString().slice(0, 10); // UTC day
      if (body.force !== true) {
        const existing = findFinishedToday.get(kind, day) as
          | { run_id: string }
          | undefined;
        if (existing) {
          return reply
            .code(200)
            .send({ runId: existing.run_id, alreadyRan: true });
        }
      }
      const runId = randomUUID();
      const startedAt = now.toISOString();
      insertRun.run(runId, kind, day, startedAt);

      if (kind === "daily") {
        const mailer = body.dryRun === true ? deps.dryRunMailer : deps.mailer;
        const profileId =
          typeof body.profileId === "string" && body.profileId !== ""
            ? body.profileId
            : undefined;
        schedule(runId, () =>
          executeDailyRun(
            { db, config, logger: app.log, source: deps.source, mailer },
            { runId, day, profileId }
          )
        );
      } else {
        schedule(runId, () => {
          executeDiscoveryStub({ db, config, logger: app.log }, { runId, day });
          return Promise.resolve();
        });
      }

      return reply.code(202).send({ runId, startedAt });
    };

  // Body is optional per the contract ({ profileId?, force?, dryRun? }); no
  // strict schema so a body-less POST is accepted.
  const opts = { preHandler: requireToken };
  app.post("/trigger/daily", opts, handler("daily"));
  app.post("/trigger/discovery", opts, handler("discovery"));
}
