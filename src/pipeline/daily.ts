/**
 * The real daily pipeline (project-des §3.1), replacing the stage-1 stub:
 *
 *   for each active profile:
 *     resolve subscriptions → fetch snapshots → compute deltas (24h/7d)
 *     → detect closed-since-last-brief → render newsletter → send via Mailer
 *     → persist snapshots + artifact (<runId>/<profileId>.html + manifest.json)
 *     → persist the profile's new resolution set
 *
 * Failure posture: every external call FAILS OPEN. Kalshi degraded → serve
 * last-known snapshots marked stale with an honest health note; mailer down →
 * artifact still persisted, run recorded degraded. A run NEVER throws — the
 * catch-all marks the run degraded and the trigger route logs the error.
 *
 * Artifact layout per contracts/newsletter-artifact.md: one profile per run
 * directory in the v1 operator model — `manifest.json` holds that profile's
 * RunManifest. Multi-profile runs additionally write
 * `<profileId>.manifest.json` per profile (additive; manifest.json then holds
 * the last-completed profile's manifest so the contract file always exists).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type {
  KalshiLogger,
  KalshiSource,
  Snapshot
} from "../kalshi/types.js";
import type { Mailer } from "../mailer/index.js";
import { activeProfiles, getProfile, listSubscriptions, type Profile } from "../profiles/store.js";
import {
  computeDeltas,
  detectClosed,
  markStale,
  SnapshotStore,
  type CandleLookup
} from "../snapshots/index.js";
import {
  newsletterSubject,
  renderNewsletter,
  type WatchlistEntry
} from "../render/newsletter.js";
import { previousResolvedTickers, saveResolution } from "./resolutions.js";

/** contracts/newsletter-artifact.md v1 (frozen) — EXACT shape and keys. */
export interface RunManifest {
  runId: string;
  kind: "daily" | "discovery";
  profileId: string;
  date: string;
  asOf: string;
  sections: string[];
  marketCount: number;
  moversCount: number;
  closedCount: number;
  suppressedCount: number;
  healthNotes: string[];
  costUsd: number;
  emailedTo: string[];
  emailedAt: string | null;
}

export interface PipelineDeps {
  db: Db;
  config: Config;
  logger: KalshiLogger;
  source: KalshiSource;
  mailer: Mailer;
}

export interface DailyRunOptions {
  runId: string;
  /** UTC day, YYYY-MM-DD (idempotency key; also the newsletter date). */
  day: string;
  /** Restrict the run to one profile (trigger body profileId). */
  profileId?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function finishRun(db: Db, runId: string, degraded: boolean): void {
  db.prepare(
    "UPDATE runs SET status = ?, finished_at = ? WHERE run_id = ?"
  ).run(degraded ? "degraded" : "completed", new Date().toISOString(), runId);
}

function artifactDir(config: Config, runId: string): string {
  const dir = join(config.dataDir, "artifacts", runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifest(dir: string, manifest: RunManifest): void {
  const json = JSON.stringify(manifest, null, 2);
  writeFileSync(join(dir, `${manifest.profileId}.manifest.json`), json, "utf8");
  writeFileSync(join(dir, "manifest.json"), json, "utf8");
}

/**
 * 7d candlestick fallback for computeDeltas, wired to
 * KalshiSource.fetchCandlesticks (period 1440m, one day ending ~7d before the
 * snapshot). Fail-open: any error → null ("no reference").
 */
function makeCandleLookup(
  source: KalshiSource,
  snapshots: ReadonlyMap<string, Snapshot>
): CandleLookup {
  return async (ticker) => {
    const snap = snapshots.get(ticker);
    if (!snap || snap.seriesTicker === null) return null;
    const endTs = Math.floor((Date.parse(snap.fetchedAt) - 7 * DAY_MS) / 1000);
    const res = await source.fetchCandlesticks(snap.seriesTicker, ticker, {
      periodIntervalMinutes: 1440,
      startTs: endTs - DAY_MS / 1000,
      endTs
    });
    if (!res.ok) return null;
    for (let i = res.value.length - 1; i >= 0; i--) {
      const close = res.value[i]!.yesPriceCloseCents;
      if (close !== null) return close;
    }
    return null;
  };
}

/** Run the daily pipeline for one profile. Returns the manifest health notes. */
async function runProfile(
  deps: PipelineDeps,
  opts: DailyRunOptions,
  store: SnapshotStore,
  profile: Profile
): Promise<string[]> {
  const { db, config, logger, source, mailer } = deps;
  const healthNotes: string[] = [];
  const subs = listSubscriptions(db, profile.id);
  const previous = previousResolvedTickers(db, profile.id);
  const byTicker = new Map<string, Snapshot>();
  let fetchDegraded = false;

  // 1. Resolve subscriptions to current open markets (dedupe by ticker).
  for (const sub of subs) {
    const res = await source.resolveSubscription({
      kind: sub.kind,
      ticker: sub.ticker
    });
    if (res.ok) {
      for (const s of res.value) {
        if (!byTicker.has(s.ticker)) byTicker.set(s.ticker, s);
      }
    } else {
      fetchDegraded = true;
      logger.warn(
        { profileId: profile.id, ticker: sub.ticker, reason: res.reason },
        "subscription resolution failed"
      );
    }
  }

  // 2. Previously-tracked tickers missing from the resolution: fetch them
  // directly so expired/settled markets surface with their settlement.
  const missing = previous.filter((t) => !byTicker.has(t));
  if (missing.length > 0) {
    const res = await source.fetchSnapshots(missing);
    if (res.ok) {
      for (const s of res.value) {
        if (!byTicker.has(s.ticker)) byTicker.set(s.ticker, s);
      }
    } else {
      fetchDegraded = true;
      logger.warn(
        { profileId: profile.id, missing, reason: res.reason },
        "fetch of previously-tracked tickers failed"
      );
    }
  }

  // 3. Fail open on fetch degradation: serve last-known snapshots, marked
  // stale, KEEPING their original fetchedAt (the honest "as of" stamp).
  if (fetchDegraded) {
    healthNotes.push("kalshi unreachable; serving last-known data");
    for (const ticker of previous) {
      if (byTicker.has(ticker)) continue;
      const last = store.latestKnown(ticker);
      if (last) byTicker.set(ticker, markStale(last));
    }
  }

  const current = [...byTicker.values()];

  // 4. Deltas against OUR OWN history (24h/7d), candlestick fallback for 7d.
  const candleLookup = makeCandleLookup(source, byTicker);
  const open = current.filter((s) => s.status === "open");
  const entries: WatchlistEntry[] = [];
  for (const snapshot of open) {
    const deltas = await computeDeltas(snapshot, store, { candleLookup });
    entries.push({ snapshot, d24: deltas.d24, d7: deltas.d7 });
  }

  // 5. Closed since last brief (settlements ride along on the snapshots).
  const closed = detectClosed(previous, current, store);

  // 6. Render (deterministic, self-contained, escaped).
  const stale = fetchDegraded || open.some((s) => s.stale);
  const asOf =
    open.map((s) => s.fetchedAt).sort()[0] ?? new Date().toISOString();
  const rendered = renderNewsletter({
    profileName: profile.name,
    date: opts.day,
    asOf,
    stale,
    entries,
    closed,
    healthNotes: [...healthNotes],
    costUsd: 0
  });

  // 7. Persist state BEFORE sending (ADR 0004: email is a delivery of state,
  // never the only copy): snapshots, then the artifact HTML.
  store.saveSnapshots(opts.runId, current);
  const dir = artifactDir(config, opts.runId);
  writeFileSync(join(dir, `${profile.id}.html`), rendered.html, "utf8");

  // 8. Send. Mailer failure degrades the run but never blocks persistence.
  let emailedTo: string[] = [];
  let emailedAt: string | null = null;
  if (profile.recipients.length === 0) {
    logger.info(
      { profileId: profile.id },
      "no recipients configured; skipping send"
    );
  } else {
    const sent = await mailer.send({
      to: profile.recipients,
      subject: newsletterSubject(profile.name, opts.day),
      html: rendered.html
    });
    if (sent.ok) {
      emailedTo = [...profile.recipients];
      emailedAt = new Date().toISOString();
    } else {
      healthNotes.push(`mailer failed: ${sent.reason}`);
      logger.warn(
        { profileId: profile.id, reason: sent.reason },
        "newsletter send failed; artifact persisted"
      );
    }
  }

  // 9. Manifest (exact contract shape) + the new resolution set. Closed
  // markets are dropped from resolution here — surfaced once, then gone. On
  // total fetch failure keep the previous set instead of wiping it.
  const manifest: RunManifest = {
    runId: opts.runId,
    kind: "daily",
    profileId: profile.id,
    date: opts.day,
    asOf,
    sections: rendered.sections,
    marketCount: entries.length,
    moversCount: rendered.moversCount,
    closedCount: closed.length,
    suppressedCount: 0,
    healthNotes,
    costUsd: 0,
    emailedTo,
    emailedAt
  };
  writeManifest(dir, manifest);

  const openTickers = open.map((s) => s.ticker);
  if (openTickers.length > 0 || !fetchDegraded) {
    saveResolution(
      db,
      profile.id,
      opts.runId,
      openTickers,
      new Date().toISOString()
    );
  }

  return healthNotes;
}

/**
 * Execute the daily run. Never throws; always finishes the runs row
 * (running → completed | degraded).
 */
export async function executeDailyRun(
  deps: PipelineDeps,
  opts: DailyRunOptions
): Promise<void> {
  const { db, logger } = deps;
  let degraded = false;
  try {
    const store = new SnapshotStore(db);
    const profiles = opts.profileId
      ? [getProfile(db, opts.profileId)].filter((p): p is Profile => !!p)
      : activeProfiles(db);
    if (opts.profileId && profiles.length === 0) {
      logger.warn(
        { runId: opts.runId, profileId: opts.profileId },
        "trigger named an unknown profile; nothing to run"
      );
      degraded = true;
    }
    for (const profile of profiles) {
      try {
        const notes = await runProfile(deps, opts, store, profile);
        if (notes.length > 0) degraded = true;
      } catch (err) {
        // Fail open per profile: one broken profile never kills the run.
        degraded = true;
        logger.error(
          { err, runId: opts.runId, profileId: profile.id },
          "daily pipeline failed for profile"
        );
      }
    }
  } catch (err) {
    degraded = true;
    logger.error({ err, runId: opts.runId }, "daily pipeline failed");
  }
  try {
    finishRun(db, opts.runId, degraded);
  } catch (err) {
    logger.error({ err, runId: opts.runId }, "failed to finish runs row");
  }
}

/**
 * Discovery stub (real logic arrives with stage 7): persist a placeholder
 * artifact + a contract-shaped manifest, then complete the run. Same async
 * posture as the daily path.
 */
export function executeDiscoveryStub(
  deps: Pick<PipelineDeps, "db" | "config" | "logger">,
  opts: { runId: string; day: string }
): void {
  const { db, config, logger } = deps;
  try {
    const dir = artifactDir(config, opts.runId);
    writeFileSync(
      join(dir, "placeholder.html"),
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Crowd-Signal — discovery run (stub)</title>
<style>body { font-family: system-ui, sans-serif; margin: 2rem; }</style>
</head>
<body>
<p>Discovery placeholder — suggestion logic arrives with stage 7.</p>
<p>runId: ${opts.runId}</p>
</body>
</html>
`,
      "utf8"
    );
    const manifest: RunManifest = {
      runId: opts.runId,
      kind: "discovery",
      profileId: "",
      date: opts.day,
      asOf: new Date().toISOString(),
      sections: [],
      marketCount: 0,
      moversCount: 0,
      closedCount: 0,
      suppressedCount: 0,
      healthNotes: [],
      costUsd: 0,
      emailedTo: [],
      emailedAt: null
    };
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );
    finishRun(db, opts.runId, false);
  } catch (err) {
    logger.error({ err, runId: opts.runId }, "discovery stub failed");
    try {
      finishRun(db, opts.runId, true);
    } catch {
      /* runs row update failed too — logged above */
    }
  }
}
