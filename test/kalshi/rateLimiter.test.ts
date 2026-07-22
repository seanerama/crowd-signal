import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBucket } from "../../src/kalshi/rateLimiter.js";

describe("token bucket (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows a burst up to capacity, then makes callers wait", () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 });
    expect(bucket.tryTake()).toBe(0);
    expect(bucket.tryTake()).toBe(0);
    expect(bucket.tryTake()).toBe(0);
    const wait = bucket.tryTake();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(1000);
  });

  it("refills at the configured rate", () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 2 });
    bucket.tryTake();
    bucket.tryTake();
    expect(bucket.available()).toBe(0);
    vi.advanceTimersByTime(500); // 0.5s * 2/s = 1 token
    expect(bucket.available()).toBeCloseTo(1, 5);
    expect(bucket.tryTake()).toBe(0);
  });

  it("never refills beyond capacity", () => {
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 10 });
    vi.advanceTimersByTime(60_000);
    expect(bucket.available()).toBe(5);
  });

  it("acquire() waits for a token, then consumes it", async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
    expect(bucket.tryTake()).toBe(0); // drain

    let resolved = false;
    const pending = bucket.acquire().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(900);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    await pending;
    expect(resolved).toBe(true);
    expect(bucket.available()).toBeLessThan(1);
  });

  it("rejects non-positive configuration (config should refuse first)", () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow(
      RangeError
    );
    expect(() => new TokenBucket({ capacity: 1, refillPerSecond: 0 })).toThrow(
      RangeError
    );
  });
});
