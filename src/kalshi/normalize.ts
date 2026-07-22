/**
 * Raw-to-contract normalization: Kalshi market JSON -> Snapshot field shapes
 * per contracts/snapshot.md v1 (frozen). This mapping lives HERE and only
 * here.
 */
import type { RawMarket, Snapshot } from "./types.js";

const MARKET_URL_BASE = "https://kalshi.com/markets/";

/** Kalshi statuses (documented: unopened/initialized, open/active, closed, settled). */
function mapStatus(raw: string): Snapshot["status"] {
  const s = raw.toLowerCase();
  if (s === "open" || s === "active") return "open";
  if (s === "settled" || s === "finalized") return "settled";
  // unopened/initialized/closed/determined/anything unknown: not tradable now.
  return "closed";
}

function mapSettlement(result: string | undefined): Snapshot["settlement"] {
  if (result === "yes" || result === "no") return result;
  return null;
}

function clampCents(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Parse a decimal-dollar string ("0.0100" = 1 cent) to cents, or null when
 * absent/unparseable. The live API (observed 2026-07-22) serves prices this
 * way; the legacy integer-cent fields now come back null.
 */
export function dollarsToCents(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Parse a fixed-point string ("1390.00") to a rounded integer, or null. */
export function fpToInt(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/**
 * Yes price in cents (0-100, the implied probability of YES).
 * Order: current *_dollars fields first (last trade, then bid/ask midpoint),
 * then the legacy integer-cent fields as fallback, then 0.
 */
function yesPriceCents(raw: RawMarket): number {
  const lastDollars = dollarsToCents(raw.last_price_dollars);
  if (lastDollars !== null && lastDollars > 0) return clampCents(lastDollars);
  const bidDollars = dollarsToCents(raw.yes_bid_dollars);
  const askDollars = dollarsToCents(raw.yes_ask_dollars);
  if (bidDollars !== null && askDollars !== null && bidDollars + askDollars > 0) {
    return clampCents((bidDollars + askDollars) / 2);
  }
  if (typeof raw.last_price === "number" && raw.last_price > 0) {
    return clampCents(raw.last_price);
  }
  if (typeof raw.yes_bid === "number" && typeof raw.yes_ask === "number") {
    return clampCents((raw.yes_bid + raw.yes_ask) / 2);
  }
  return 0;
}

function marketVolume(raw: RawMarket): number {
  return fpToInt(raw.volume_fp) ?? raw.volume ?? 0;
}

function marketOpenInterest(raw: RawMarket): number | null {
  return fpToInt(raw.open_interest_fp) ?? raw.open_interest ?? null;
}

export interface NormalizeContext {
  /** Parent event/series title — ALWAYS stored with the market title (§4.1). */
  eventTitle: string;
  /** Parent series ticker; null for one-off events. */
  seriesTicker: string | null;
  /** The honest "as of" timestamp, ISO-8601. */
  fetchedAt: string;
}

export function normalizeMarket(raw: RawMarket, ctx: NormalizeContext): Snapshot {
  return {
    ticker: raw.ticker,
    eventTicker: raw.event_ticker,
    seriesTicker: ctx.seriesTicker,
    title: raw.title,
    eventTitle: ctx.eventTitle,
    marketUrl: `${MARKET_URL_BASE}${raw.ticker}`,
    yesPriceCents: yesPriceCents(raw),
    volume: marketVolume(raw),
    openInterest: marketOpenInterest(raw),
    closeTime: new Date(raw.close_time).toISOString(),
    status: mapStatus(raw.status),
    settlement: mapSettlement(raw.result),
    fetchedAt: ctx.fetchedAt,
    stale: false
  };
}
