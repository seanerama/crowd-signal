/**
 * Exponential backoff + full jitter for 429/5xx/network errors, honoring
 * Retry-After (seconds or HTTP-date) with precedence over the computed
 * backoff (project-des §7).
 */

export interface BackoffOptions {
  /** Base delay in ms for attempt 0. */
  baseMs: number;
  /** Ceiling on the computed (pre-jitter) delay. */
  capMs: number;
  /** RNG in [0,1), injectable for deterministic tests. */
  random?: () => number;
}

export const DEFAULT_BACKOFF: Pick<BackoffOptions, "baseMs" | "capMs"> = {
  baseMs: 250,
  capMs: 10_000
};

/**
 * Full-jitter backoff: uniform in [0, min(capMs, baseMs * 2^attempt)].
 * `attempt` is 0-based (the first retry uses attempt 0).
 */
export function computeBackoffMs(attempt: number, opts: BackoffOptions): number {
  const ceiling = Math.min(opts.capMs, opts.baseMs * 2 ** Math.max(0, attempt));
  const random = opts.random ?? Math.random;
  return Math.floor(random() * ceiling);
}

/**
 * Parse a Retry-After header value into a delay in ms, or null when absent /
 * unparseable. Accepts delta-seconds ("3") and HTTP-dates
 * ("Wed, 22 Jul 2026 10:00:05 GMT"). Never returns a negative delay.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  now: () => number = Date.now
): number | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - now());
}

/**
 * Delay before the next retry: Retry-After wins over computed backoff when the
 * server provided one.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterHeader: string | null | undefined,
  opts: BackoffOptions,
  now: () => number = Date.now
): number {
  const retryAfter = parseRetryAfterMs(retryAfterHeader, now);
  if (retryAfter !== null) return retryAfter;
  return computeBackoffMs(attempt, opts);
}
