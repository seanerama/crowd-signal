/**
 * Per-profile alert-hygiene configuration (ADR 0005; project-des §6).
 * Defaults are the ADR's starting points; every knob is per-profile tunable.
 * Validation is bounds-checked and applies defaults for missing fields —
 * a profile never persists a half-formed hygiene config.
 */

export interface QuietHours {
  /** "HH:MM" operator-local, e.g. "22:00". */
  start: string;
  /** "HH:MM" operator-local, e.g. "07:00". */
  end: string;
}

export interface HygieneConfig {
  /** Minimum move (probability points) vs. reference price. */
  thresholdPts: number;
  /** Re-arm dead band (points) around the new reference. */
  deadBandPts: number;
  /** Minimum hours between alerts on the same market. */
  cooldownHours: number;
  /** Max alert emails per profile per day. */
  dailyCap: number;
  /** No alert emails inside this window; detections fold into the newsletter. */
  quietHours: QuietHours;
  /** Markets under this volume never alert. */
  liquidityFloorUsd: number;
}

/** ADR 0005 defaults. */
export const DEFAULT_HYGIENE: HygieneConfig = {
  thresholdPts: 5,
  deadBandPts: 2,
  cooldownHours: 4,
  dailyCap: 5,
  quietHours: { start: "22:00", end: "07:00" },
  liquidityFloorUsd: 1000
};

export class HygieneError extends Error {
  override name = "HygieneError";
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function num(
  raw: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[]
): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    problems.push(`${field} must be a number`);
    return fallback;
  }
  if (n < min || n > max) {
    problems.push(`${field} must be between ${min} and ${max} (got ${n})`);
    return fallback;
  }
  return n;
}

function hhmm(
  raw: unknown,
  field: string,
  fallback: string,
  problems: string[]
): string {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string" || !HHMM.test(raw.trim())) {
    problems.push(`${field} must be "HH:MM" 24h time`);
    return fallback;
  }
  return raw.trim();
}

/**
 * Validate a (possibly partial, possibly untrusted) hygiene config.
 * Missing fields get ADR 0005 defaults; out-of-bounds or malformed fields are
 * a HygieneError listing every problem. Bounds: threshold 1–50, dead band
 * 0–threshold, cooldown 0–48 h, cap 1–20, liquidity floor >= 0.
 */
export function validateHygiene(input: unknown): HygieneConfig {
  if (input === undefined || input === null) return { ...DEFAULT_HYGIENE };
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new HygieneError("hygiene config must be an object");
  }
  const raw = input as Record<string, unknown>;
  const problems: string[] = [];

  const thresholdPts = num(
    raw.thresholdPts, "thresholdPts", DEFAULT_HYGIENE.thresholdPts, 1, 50, problems
  );
  const deadBandPts = num(
    raw.deadBandPts, "deadBandPts", DEFAULT_HYGIENE.deadBandPts, 0, thresholdPts, problems
  );
  const cooldownHours = num(
    raw.cooldownHours, "cooldownHours", DEFAULT_HYGIENE.cooldownHours, 0, 48, problems
  );
  const dailyCap = num(
    raw.dailyCap, "dailyCap", DEFAULT_HYGIENE.dailyCap, 1, 20, problems
  );
  const liquidityFloorUsd = num(
    raw.liquidityFloorUsd,
    "liquidityFloorUsd",
    DEFAULT_HYGIENE.liquidityFloorUsd,
    0,
    Number.MAX_SAFE_INTEGER,
    problems
  );

  let quietHours: QuietHours = { ...DEFAULT_HYGIENE.quietHours };
  if (raw.quietHours !== undefined && raw.quietHours !== null) {
    if (typeof raw.quietHours !== "object" || Array.isArray(raw.quietHours)) {
      problems.push("quietHours must be an object { start, end }");
    } else {
      const qh = raw.quietHours as Record<string, unknown>;
      quietHours = {
        start: hhmm(qh.start, "quietHours.start", DEFAULT_HYGIENE.quietHours.start, problems),
        end: hhmm(qh.end, "quietHours.end", DEFAULT_HYGIENE.quietHours.end, problems)
      };
    }
  }

  if (problems.length > 0) {
    throw new HygieneError(
      `Invalid hygiene config: ${problems.join("; ")}`
    );
  }

  return {
    thresholdPts,
    deadBandPts,
    cooldownHours,
    dailyCap,
    quietHours,
    liquidityFloorUsd
  };
}
