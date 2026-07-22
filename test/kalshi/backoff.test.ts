import { describe, expect, it } from "vitest";
import {
  computeBackoffMs,
  parseRetryAfterMs,
  retryDelayMs
} from "../../src/kalshi/backoff.js";

const OPTS = { baseMs: 100, capMs: 10_000 };

describe("exponential backoff with full jitter", () => {
  it("stays within [0, base * 2^attempt] for each attempt", () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const ceiling = 100 * 2 ** attempt;
      for (const r of [0, 0.25, 0.5, 0.999999]) {
        const delay = computeBackoffMs(attempt, { ...OPTS, random: () => r });
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(ceiling);
        expect(delay).toBe(Math.floor(r * ceiling));
      }
    }
  });

  it("caps the pre-jitter ceiling at capMs", () => {
    const delay = computeBackoffMs(20, {
      baseMs: 100,
      capMs: 3000,
      random: () => 0.999999
    });
    expect(delay).toBeLessThan(3000);
    expect(delay).toBe(Math.floor(0.999999 * 3000));
  });
});

describe("Retry-After parsing", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("parses HTTP-dates relative to now", () => {
    const now = Date.parse("2026-07-22T10:00:00Z");
    expect(
      parseRetryAfterMs("Wed, 22 Jul 2026 10:00:05 GMT", () => now)
    ).toBe(5000);
  });

  it("clamps past HTTP-dates to zero", () => {
    const now = Date.parse("2026-07-22T10:00:00Z");
    expect(
      parseRetryAfterMs("Wed, 22 Jul 2026 09:59:00 GMT", () => now)
    ).toBe(0);
  });

  it("returns null for absent or garbage values", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
  });
});

describe("Retry-After precedence over computed backoff", () => {
  it("uses Retry-After seconds when present", () => {
    const delay = retryDelayMs(5, "2", { ...OPTS, random: () => 0.5 });
    expect(delay).toBe(2000);
  });

  it("uses Retry-After HTTP-date when present", () => {
    const now = Date.parse("2026-07-22T10:00:00Z");
    const delay = retryDelayMs(
      5,
      "Wed, 22 Jul 2026 10:00:07 GMT",
      { ...OPTS, random: () => 0.5 },
      () => now
    );
    expect(delay).toBe(7000);
  });

  it("falls back to jittered backoff when header is absent or invalid", () => {
    expect(retryDelayMs(2, null, { ...OPTS, random: () => 0.5 })).toBe(
      Math.floor(0.5 * 400)
    );
    expect(retryDelayMs(2, "whenever", { ...OPTS, random: () => 0.5 })).toBe(
      Math.floor(0.5 * 400)
    );
  });
});
