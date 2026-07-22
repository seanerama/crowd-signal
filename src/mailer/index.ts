/**
 * Mailer seam (ADR 0004): Resend is called ONLY through this module — the
 * seam is where a provider swap, the dry-run mode, and the send log live.
 *
 * Fail-open: `send` NEVER throws. Any failure (HTTP error, network refused,
 * bad JSON) comes back as { ok:false, reason } so the daily pipeline can
 * persist the artifact, note the degradation, and finish the run.
 */
export { DryRunMailer } from "./dry-run.js";
export { ResendMailer } from "./resend.js";
import type { Config } from "../config.js";
import { DryRunMailer } from "./dry-run.js";
import { ResendMailer } from "./resend.js";

export interface MailMessage {
  to: string[];
  subject: string;
  html: string;
}

export type SendResult =
  | { ok: true; id: string | null }
  | { ok: false; reason: string };

export interface Mailer {
  send(msg: MailMessage): Promise<SendResult>;
}

/** Minimal structural logger — Fastify's pino logger satisfies this. */
export interface MailerLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Kill-switch factory: MAILER_ENABLED ON (with its required RESEND_API_KEY,
 * enforced at boot) → real Resend sends; otherwise the dry-run mailer — the
 * pipeline still renders and persists artifacts, it just never sends.
 */
export function createMailer(config: Config, logger: MailerLogger): Mailer {
  if (config.flags.MAILER_ENABLED && config.resendApiKey !== "") {
    return new ResendMailer(
      {
        apiKey: config.resendApiKey,
        from: config.mailerFrom,
        apiBase: config.resendApiBase
      },
      logger
    );
  }
  logger.info(
    {},
    "MAILER_ENABLED is off — dry-run mailer active (render + persist only, no sends)"
  );
  return new DryRunMailer(logger);
}
