/**
 * DryRunMailer: records messages in memory instead of sending. Used when
 * MAILER_ENABLED is OFF (kill-switch) or a trigger arrives with dryRun:true.
 * The pipeline behaves identically — render, persist, "send" — except no
 * email leaves the machine; the log line says dry-run.
 */
import type { MailMessage, MailerLogger, SendResult } from "./index.js";

export class DryRunMailer {
  /** Every message "sent", in order — the test/inspection surface. */
  readonly sent: MailMessage[] = [];

  constructor(private readonly logger?: MailerLogger) {}

  send(msg: MailMessage): Promise<SendResult> {
    this.sent.push(msg);
    this.logger?.info(
      { to: msg.to, subject: msg.subject, bytes: msg.html.length },
      "mailer dry-run: message recorded, nothing sent"
    );
    return Promise.resolve({ ok: true, id: null });
  }
}
