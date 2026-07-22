/**
 * Config loading + boot validation (project-des §8.7).
 *
 * Every kill-switch flag defaults OFF. A flag turned ON while its required
 * secret is missing is a boot refusal — the process must not come up half-armed.
 * TRIGGER_API_TOKEN is required unconditionally: without it the trigger
 * endpoints cannot authenticate anyone.
 */

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface FlagSpec {
  /** Env var holding the boolean flag. */
  flag: string;
  /** Env var holding the secret this flag requires when ON (if any). */
  requiredSecret?: string;
  /**
   * Env vars this flag requires when ON — for flags that need more than one
   * secret. All listed vars must be non-empty. Additive to `requiredSecret`.
   */
  requiredSecrets?: readonly string[];
}

/** Kill-switch flags modeled in stage 1. All default OFF. */
export const FLAG_SPECS: readonly FlagSpec[] = [
  { flag: "KALSHI_ENABLED" },
  {
    flag: "ADMIN_UI_ENABLED",
    requiredSecrets: ["ADMIN_PASSWORD", "ADMIN_SESSION_SECRET"]
  },
  { flag: "MAILER_ENABLED", requiredSecret: "RESEND_API_KEY" },
  { flag: "WATCHER_ENABLED" },
  { flag: "SUGGEST_ENABLED", requiredSecret: "ANTHROPIC_API_KEY" }
];

/** Kalshi public-API client knobs (project-des §7). No credential exists. */
export interface KalshiConfig {
  /** Base URL of the public unauthenticated API. Overridable for tests. */
  apiBase: string;
  /** Token-bucket refill rate, requests per second. */
  rps: number;
  /** Token-bucket capacity (burst size). */
  burst: number;
  /** Max fetch attempts per request (1 initial + retries). */
  maxAttempts: number;
}

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  triggerApiToken: string;
  flags: Record<string, boolean>;
  /** Empty unless set; guaranteed non-empty when ADMIN_UI_ENABLED is ON. */
  adminPassword: string;
  /** Empty unless set; guaranteed non-empty when ADMIN_UI_ENABLED is ON. */
  adminSessionSecret: string;
  kalshi: KalshiConfig;
}

type Env = Record<string, string | undefined>;

export const KALSHI_PUBLIC_API_BASE =
  "https://external-api.kalshi.com/trade-api/v2";

function parsePositiveNumber(
  name: string,
  raw: string | undefined,
  fallback: number,
  problems: string[],
  { integer = false }: { integer?: boolean } = {}
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  const valid = integer ? Number.isInteger(n) && n > 0 : Number.isFinite(n) && n > 0;
  if (!valid) {
    problems.push(`Invalid ${name}: "${raw}" (expected a positive ${integer ? "integer" : "number"})`);
    return fallback;
  }
  return n;
}

function parseFlag(name: string, raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return false; // default OFF
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw new ConfigError(
    `Invalid boolean for ${name}: "${raw}" (use true/false)`
  );
}

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const triggerApiToken = env.TRIGGER_API_TOKEN?.trim() ?? "";
  if (triggerApiToken === "") {
    problems.push(
      "TRIGGER_API_TOKEN is required (trigger endpoints cannot authenticate without it)"
    );
  }

  const flags: Record<string, boolean> = {};
  for (const spec of FLAG_SPECS) {
    const on = parseFlag(spec.flag, env[spec.flag]);
    flags[spec.flag] = on;
    if (on) {
      const required = [
        ...(spec.requiredSecret ? [spec.requiredSecret] : []),
        ...(spec.requiredSecrets ?? [])
      ];
      for (const name of required) {
        const secret = env[name]?.trim() ?? "";
        if (secret === "") {
          problems.push(
            `${spec.flag} is ON but its required secret ${name} is missing — refusing to boot`
          );
        }
      }
    }
  }

  const kalshi: KalshiConfig = {
    apiBase: env.KALSHI_API_BASE?.trim() || KALSHI_PUBLIC_API_BASE,
    // Conservative fraction of published public limits — configured, not hardcoded.
    rps: parsePositiveNumber("KALSHI_RPS", env.KALSHI_RPS, 5, problems),
    burst: parsePositiveNumber("KALSHI_BURST", env.KALSHI_BURST, 10, problems, {
      integer: true
    }),
    maxAttempts: parsePositiveNumber(
      "KALSHI_MAX_ATTEMPTS",
      env.KALSHI_MAX_ATTEMPTS,
      4,
      problems,
      { integer: true }
    )
  };

  if (problems.length > 0) {
    throw new ConfigError(
      `Config validation failed:\n  - ${problems.join("\n  - ")}`
    );
  }

  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`Invalid PORT: "${env.PORT}"`);
  }

  return {
    dataDir: env.DATA_DIR?.trim() || "/data",
    host: env.HOST?.trim() || "0.0.0.0",
    port,
    triggerApiToken,
    flags,
    adminPassword: env.ADMIN_PASSWORD?.trim() ?? "",
    adminSessionSecret: env.ADMIN_SESSION_SECRET?.trim() ?? "",
    kalshi
  };
}
