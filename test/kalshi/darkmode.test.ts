/**
 * Kill-switch: KALSHI_ENABLED defaults OFF -> the factory returns a dark
 * implementation. Typed degraded results, zero network, zero metrics.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createKalshiSource } from "../../src/kalshi/index.js";
import type { KalshiLogger } from "../../src/kalshi/types.js";

const logger: KalshiLogger = { info() {}, warn() {}, error() {} };

describe("KalshiSource dark mode (KALSHI_ENABLED off)", () => {
  const config = loadConfig({ TRIGGER_API_TOKEN: "t" });

  it("flag defaults OFF", () => {
    expect(config.flags.KALSHI_ENABLED).toBe(false);
  });

  it("every method returns { ok:false, reason:'kalshi disabled', retriable:false }", async () => {
    const source = createKalshiSource(config, logger);
    const expected = {
      ok: false,
      reason: "kalshi disabled",
      retriable: false
    };
    await expect(
      source.resolveSubscription({ kind: "series", ticker: "KXHIGHNY" })
    ).resolves.toEqual(expected);
    await expect(
      source.resolveSubscription({ kind: "event", ticker: "KXHIGHNY-26JUL22" })
    ).resolves.toEqual(expected);
    await expect(source.fetchSnapshots(["A", "B"])).resolves.toEqual(expected);
    await expect(source.listSeries()).resolves.toEqual(expected);
    await expect(
      source.fetchCandlesticks("KXHIGHNY", "KXHIGHNY-26JUL22-B87", {
        periodIntervalMinutes: 1440,
        startTs: 0,
        endTs: 1
      })
    ).resolves.toEqual(expected);
  });

  it("dark metrics are all zero", () => {
    const source = createKalshiSource(config, logger);
    expect(source.getMetrics()).toEqual({
      requestsTotal: 0,
      rateLimited429: 0,
      backoffRetries: 0
    });
  });
});
