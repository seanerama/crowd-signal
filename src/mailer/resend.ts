/**
 * ResendMailer (ADR 0004): POST {apiBase}/emails with the API key as a
 * Bearer token. v1 sends from the shared onboarding@resend.dev sender, which
 * delivers only to the Resend account owner — the operator-as-subscriber
 * constraint is a feature here, not a bug.
 *
 * Never throws: every failure path returns { ok:false, reason }.
 */
import type { MailMessage, Mailer, MailerLogger, SendResult } from "./index.js";

export interface ResendMailerOptions {
  apiKey: string;
  from: string;
  /** e.g. https://api.resend.com — env-overridable for tests. */
  apiBase: string;
  /** Test injection; production omits it. */
  fetchFn?: typeof fetch;
}

export class ResendMailer implements Mailer {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly opts: ResendMailerOptions,
    private readonly logger?: MailerLogger
  ) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async send(msg: MailMessage): Promise<SendResult> {
    const url = `${this.opts.apiBase.replace(/\/$/, "")}/emails`;
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          from: this.opts.from,
          to: msg.to,
          subject: msg.subject,
          html: msg.html
        })
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const reason = `resend http ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
        this.logger?.warn({ status: res.status, to: msg.to }, "resend send failed");
        return { ok: false, reason };
      }
      const body = (await res.json().catch(() => ({}))) as { id?: unknown };
      const id = typeof body.id === "string" ? body.id : null;
      this.logger?.info({ id, to: msg.to }, "resend send ok");
      return { ok: true, id };
    } catch (err) {
      const reason = `resend network error: ${err instanceof Error ? err.message : String(err)}`;
      this.logger?.warn({ err, to: msg.to }, "resend send failed");
      return { ok: false, reason };
    }
  }
}
