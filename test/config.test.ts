import { describe, expect, it } from "vitest";
import { ConfigError, FLAG_SPECS, loadConfig } from "../src/config.js";

const baseEnv = { TRIGGER_API_TOKEN: "test-token" };

describe("config validation at boot", () => {
  it("all kill-switch flags default OFF", () => {
    const config = loadConfig({ ...baseEnv });
    for (const spec of FLAG_SPECS) {
      expect(config.flags[spec.flag], spec.flag).toBe(false);
    }
  });

  it("refuses to boot when TRIGGER_API_TOKEN is missing", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/TRIGGER_API_TOKEN/);
  });

  it("refuses to boot when TRIGGER_API_TOKEN is empty", () => {
    expect(() => loadConfig({ TRIGGER_API_TOKEN: "  " })).toThrow(ConfigError);
  });

  it("MAILER_ENABLED=true without RESEND_API_KEY refuses to boot", () => {
    expect(() =>
      loadConfig({ ...baseEnv, MAILER_ENABLED: "true" })
    ).toThrow(/RESEND_API_KEY/);
  });

  it("MAILER_ENABLED=true with RESEND_API_KEY boots", () => {
    const config = loadConfig({
      ...baseEnv,
      MAILER_ENABLED: "true",
      RESEND_API_KEY: "re_test"
    });
    expect(config.flags.MAILER_ENABLED).toBe(true);
  });

  it("SUGGEST_ENABLED=true without ANTHROPIC_API_KEY refuses to boot", () => {
    expect(() =>
      loadConfig({ ...baseEnv, SUGGEST_ENABLED: "true" })
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("SUGGEST_ENABLED=true with ANTHROPIC_API_KEY boots", () => {
    const config = loadConfig({
      ...baseEnv,
      SUGGEST_ENABLED: "true",
      ANTHROPIC_API_KEY: "sk-ant-test"
    });
    expect(config.flags.SUGGEST_ENABLED).toBe(true);
  });

  it("flags without a required secret can be ON without extra env", () => {
    const config = loadConfig({
      ...baseEnv,
      KALSHI_ENABLED: "true",
      WATCHER_ENABLED: "true"
    });
    expect(config.flags.KALSHI_ENABLED).toBe(true);
    expect(config.flags.WATCHER_ENABLED).toBe(true);
  });

  it("ADMIN_UI_ENABLED=true with no admin secrets refuses to boot naming both", () => {
    expect(() =>
      loadConfig({ ...baseEnv, ADMIN_UI_ENABLED: "true" })
    ).toThrow(/ADMIN_PASSWORD[\s\S]*ADMIN_SESSION_SECRET/);
  });

  it("ADMIN_UI_ENABLED=true missing only ADMIN_SESSION_SECRET refuses to boot", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        ADMIN_UI_ENABLED: "true",
        ADMIN_PASSWORD: "hunter2"
      })
    ).toThrow(/ADMIN_SESSION_SECRET/);
  });

  it("ADMIN_UI_ENABLED=true missing only ADMIN_PASSWORD refuses to boot", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        ADMIN_UI_ENABLED: "true",
        ADMIN_SESSION_SECRET: "s3cret-session-key"
      })
    ).toThrow(/ADMIN_PASSWORD/);
  });

  it("ADMIN_UI_ENABLED=true with both admin secrets boots and exposes them", () => {
    const config = loadConfig({
      ...baseEnv,
      ADMIN_UI_ENABLED: "true",
      ADMIN_PASSWORD: "hunter2",
      ADMIN_SESSION_SECRET: "s3cret-session-key"
    });
    expect(config.flags.ADMIN_UI_ENABLED).toBe(true);
    expect(config.adminPassword).toBe("hunter2");
    expect(config.adminSessionSecret).toBe("s3cret-session-key");
  });

  it("rejects garbage flag values instead of guessing", () => {
    expect(() =>
      loadConfig({ ...baseEnv, KALSHI_ENABLED: "maybe" })
    ).toThrow(ConfigError);
  });

  it("reports every problem in one refusal message", () => {
    expect(() =>
      loadConfig({
        MAILER_ENABLED: "true",
        SUGGEST_ENABLED: "true"
      })
    ).toThrow(/TRIGGER_API_TOKEN[\s\S]*RESEND_API_KEY[\s\S]*ANTHROPIC_API_KEY/);
  });

  it("kalshi knobs default to the public API base and conservative limits", () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.kalshi).toEqual({
      apiBase: "https://external-api.kalshi.com/trade-api/v2",
      rps: 5,
      burst: 10,
      maxAttempts: 4
    });
  });

  it("kalshi knobs are env-overridable (base URL for tests, limits for tuning)", () => {
    const config = loadConfig({
      ...baseEnv,
      KALSHI_API_BASE: "http://127.0.0.1:9999",
      KALSHI_RPS: "2.5",
      KALSHI_BURST: "4",
      KALSHI_MAX_ATTEMPTS: "6"
    });
    expect(config.kalshi).toEqual({
      apiBase: "http://127.0.0.1:9999",
      rps: 2.5,
      burst: 4,
      maxAttempts: 6
    });
  });

  it("refuses to boot on invalid kalshi numeric knobs", () => {
    expect(() => loadConfig({ ...baseEnv, KALSHI_RPS: "-1" })).toThrow(
      /KALSHI_RPS/
    );
    expect(() => loadConfig({ ...baseEnv, KALSHI_BURST: "2.5" })).toThrow(
      /KALSHI_BURST/
    );
    expect(() =>
      loadConfig({ ...baseEnv, KALSHI_MAX_ATTEMPTS: "zero" })
    ).toThrow(/KALSHI_MAX_ATTEMPTS/);
  });

  it("DATA_DIR defaults to /data and is overridable", () => {
    expect(loadConfig({ ...baseEnv }).dataDir).toBe("/data");
    expect(loadConfig({ ...baseEnv, DATA_DIR: "/tmp/x" }).dataDir).toBe(
      "/tmp/x"
    );
  });
});
