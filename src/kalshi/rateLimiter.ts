/**
 * Client-side token-bucket rate limiter (project-des §7).
 *
 * Capacity (burst) and refill rate come from config (KALSHI_BURST /
 * KALSHI_RPS) — a conservative fraction of published limits, configured, not
 * hardcoded. Belt-and-suspenders at v1 volume; built before volume makes it
 * urgent.
 */

export interface TokenBucketOptions {
  /** Bucket capacity — the burst size. */
  capacity: number;
  /** Refill rate in tokens per second. */
  refillPerSecond: number;
  /** Clock, injectable for tests (vitest fake timers patch Date.now). */
  now?: () => number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(opts: TokenBucketOptions) {
    if (opts.capacity <= 0 || opts.refillPerSecond <= 0) {
      // Defensive: config validation should have refused these already.
      throw new RangeError("TokenBucket requires positive capacity and rate");
    }
    this.capacity = opts.capacity;
    this.refillPerSecond = opts.refillPerSecond;
    this.now = opts.now ?? Date.now;
    this.tokens = opts.capacity;
    this.lastRefillMs = this.now();
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedMs = Math.max(0, nowMs - this.lastRefillMs);
    this.lastRefillMs = nowMs;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsedMs / 1000) * this.refillPerSecond
    );
  }

  /** Tokens currently available (after refill accrual). Exposed for tests. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Try to take one token. Returns 0 when taken, otherwise the milliseconds
   * until a token will be available (no token is consumed in that case).
   */
  tryTake(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
  }

  /** Wait until a token is available, then consume it. */
  async acquire(): Promise<void> {
    for (;;) {
      const waitMs = this.tryTake();
      if (waitMs === 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
