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
}

/** Kill-switch flags modeled in stage 1. All default OFF. */
export const FLAG_SPECS: readonly FlagSpec[] = [
  { flag: "KALSHI_ENABLED" },
  { flag: "ADMIN_UI_ENABLED" },
  { flag: "MAILER_ENABLED", requiredSecret: "RESEND_API_KEY" },
  { flag: "WATCHER_ENABLED" },
  { flag: "SUGGEST_ENABLED", requiredSecret: "ANTHROPIC_API_KEY" }
];

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  triggerApiToken: string;
  flags: Record<string, boolean>;
}

type Env = Record<string, string | undefined>;

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
    if (on && spec.requiredSecret) {
      const secret = env[spec.requiredSecret]?.trim() ?? "";
      if (secret === "") {
        problems.push(
          `${spec.flag} is ON but its required secret ${spec.requiredSecret} is missing — refusing to boot`
        );
      }
    }
  }

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
    flags
  };
}
