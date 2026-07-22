/**
 * Mailer unit tests: ResendMailer against a local mock HTTP server (success,
 * API error, connection refused — never throws), DryRunMailer capture, and
 * the createMailer kill-switch factory.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  createMailer,
  DryRunMailer,
  ResendMailer,
  type MailerLogger
} from "../src/mailer/index.js";

const silent: MailerLogger = { info() {}, warn() {}, error() {} };

interface SeenRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let seen: SeenRequest[];
let respond: () => { status: number; body: unknown };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined
      });
      const planned = respond();
      res.writeHead(planned.status, { "content-type": "application/json" });
      res.end(JSON.stringify(planned.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});

beforeEach(() => {
  seen = [];
  respond = () => ({ status: 200, body: { id: "em_123" } });
});

const MSG = {
  to: ["operator@example.com"],
  subject: "[Crowd-Signal] Test daily — 2026-07-22",
  html: "<!doctype html><html><body>hi</body></html>"
};

function mailer(apiBase: string): ResendMailer {
  return new ResendMailer(
    { apiKey: "key-1", from: "onboarding@resend.dev", apiBase },
    silent
  );
}

describe("ResendMailer", () => {
  it("success: POST /emails with Bearer auth and the full payload -> ok + id", async () => {
    const res = await mailer(baseUrl).send(MSG);
    expect(res).toEqual({ ok: true, id: "em_123" });

    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/emails");
    expect(req.headers.authorization).toBe("Bearer key-1");
    expect(req.body).toEqual({
      from: "onboarding@resend.dev",
      to: MSG.to,
      subject: MSG.subject,
      html: MSG.html
    });
  });

  it("API error (500) -> ok:false with reason, no throw", async () => {
    respond = () => ({ status: 500, body: { message: "kaput" } });
    const res = await mailer(baseUrl).send(MSG);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/resend http 500/);
  });

  it("API rejection (422) -> ok:false, no throw", async () => {
    respond = () => ({ status: 422, body: { message: "bad recipient" } });
    const res = await mailer(baseUrl).send(MSG);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/resend http 422/);
  });

  it("connection refused -> ok:false network reason, no throw", async () => {
    // A port that was real but no longer listens.
    const dead = createServer(() => {});
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const { port } = dead.address() as AddressInfo;
    await new Promise<void>((r, j) => dead.close((e) => (e ? j(e) : r())));

    const res = await mailer(`http://127.0.0.1:${port}`).send(MSG);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/resend network error/);
  });
});

describe("DryRunMailer", () => {
  it("records messages in memory and reports ok with a null id", async () => {
    const dry = new DryRunMailer(silent);
    const res = await dry.send(MSG);
    expect(res).toEqual({ ok: true, id: null });
    expect(dry.sent).toEqual([MSG]);
  });
});

describe("createMailer (kill-switch factory)", () => {
  it("MAILER_ENABLED off (default) -> DryRunMailer", () => {
    const config = loadConfig({ TRIGGER_API_TOKEN: "t", DATA_DIR: "/tmp/x" });
    expect(createMailer(config, silent)).toBeInstanceOf(DryRunMailer);
  });

  it("MAILER_ENABLED on with key -> ResendMailer honoring RESEND_API_BASE + MAILER_FROM", async () => {
    const config = loadConfig({
      TRIGGER_API_TOKEN: "t",
      DATA_DIR: "/tmp/x",
      MAILER_ENABLED: "true",
      RESEND_API_KEY: "boot-key",
      RESEND_API_BASE: baseUrl,
      MAILER_FROM: "custom@example.com"
    });
    const m = createMailer(config, silent);
    expect(m).toBeInstanceOf(ResendMailer);
    const res = await m.send(MSG);
    expect(res.ok).toBe(true);
    expect(seen[0]!.headers.authorization).toBe("Bearer boot-key");
    expect((seen[0]!.body as { from: string }).from).toBe("custom@example.com");
  });

  it("MAILER_ENABLED on without RESEND_API_KEY refuses to boot (config validation)", () => {
    expect(() =>
      loadConfig({
        TRIGGER_API_TOKEN: "t",
        MAILER_ENABLED: "true"
      })
    ).toThrow(/RESEND_API_KEY/);
  });
});
