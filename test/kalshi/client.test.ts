/**
 * Client unit tests with a stubbed fetch: request coalescing and the fail-open
 * result surface (no throw paths).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  KalshiClient,
  resetKalshiMetrics,
  getKalshiMetrics
} from "../../src/kalshi/client.js";
import type { KalshiConfig } from "../../src/config.js";
import type { KalshiLogger } from "../../src/kalshi/types.js";

const silentLogger: KalshiLogger = { info() {}, warn() {}, error() {} };

const config: KalshiConfig = {
  apiBase: "http://kalshi.test/trade-api/v2",
  rps: 1000,
  burst: 1000,
  maxAttempts: 4
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("request coalescing", () => {
  beforeEach(() => resetKalshiMetrics());

  it("two identical concurrent GETs share one upstream call", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return jsonResponse({ market: { ticker: "T" } });
    });
    const client = new KalshiClient(config, silentLogger, {
      fetchFn: fetchFn as unknown as typeof fetch
    });

    const [a, b] = await Promise.all([
      client.getMarket("KXTEST-1"),
      client.getMarket("KXTEST-1")
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    expect(getKalshiMetrics().requestsTotal).toBe(1);
  });

  it("different URLs do NOT coalesce", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ market: {} }));
    const client = new KalshiClient(config, silentLogger, {
      fetchFn: fetchFn as unknown as typeof fetch
    });
    await Promise.all([client.getMarket("A"), client.getMarket("B")]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("sequential identical GETs each hit upstream (no stale caching)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ market: {} }));
    const client = new KalshiClient(config, silentLogger, {
      fetchFn: fetchFn as unknown as typeof fetch
    });
    await client.getMarket("A");
    await client.getMarket("A");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("fail-open result surface", () => {
  beforeEach(() => resetKalshiMetrics());

  it("non-retriable 4xx returns ok:false without retrying", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "nope" }, 404));
    const client = new KalshiClient(config, silentLogger, {
      fetchFn: fetchFn as unknown as typeof fetch
    });
    const res = await client.getMarket("MISSING");
    expect(res).toEqual({ ok: false, reason: "http 404", retriable: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("invalid JSON body returns ok:false instead of throwing", async () => {
    const fetchFn = vi.fn(
      async () => new Response("<html>not json</html>", { status: 200 })
    );
    const client = new KalshiClient(config, silentLogger, {
      fetchFn: fetchFn as unknown as typeof fetch
    });
    const res = await client.getMarket("T");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.retriable).toBe(false);
  });

  it("thrown fetch errors surface as retriable ok:false after max attempts", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = new KalshiClient(config, silentLogger, {
      fetchFn: fetchFn as unknown as typeof fetch,
      backoff: { baseMs: 1, capMs: 2 }
    });
    const res = await client.getMarket("T");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.retriable).toBe(true);
      expect(res.reason).toMatch(/network error/);
    }
    expect(fetchFn).toHaveBeenCalledTimes(4); // maxAttempts
    expect(getKalshiMetrics().backoffRetries).toBe(3);
  });
});
