/**
 * In-memory login rate limiter: max N failed attempts per IP per window
 * (default 5 / 15 min) → 429. Process-local by design — single-process app
 * (ADR 0001), and a restart clearing the counters is acceptable for v1.
 */
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 15 * 60 * 1000
  ) {}

  private prune(ip: string, now: number): number[] {
    const kept = (this.failures.get(ip) ?? []).filter(
      (t) => now - t < this.windowMs
    );
    if (kept.length > 0) this.failures.set(ip, kept);
    else this.failures.delete(ip);
    return kept;
  }

  /** True when this IP has exhausted its attempts for the current window. */
  isLimited(ip: string, now: number = Date.now()): boolean {
    return this.prune(ip, now).length >= this.maxAttempts;
  }

  recordFailure(ip: string, now: number = Date.now()): void {
    const kept = this.prune(ip, now);
    kept.push(now);
    this.failures.set(ip, kept);
  }

  /** Successful login clears the counter. */
  reset(ip: string): void {
    this.failures.delete(ip);
  }
}
