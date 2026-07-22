/**
 * Daily newsletter renderer — implements contracts/newsletter-artifact.md v1
 * (frozen) EXACTLY: section order, inline CSS only, zero external requests
 * (no scripts, no images, no fonts, no stylesheet links — market links are
 * plain anchors, which fetch nothing until clicked), sections with no content
 * omitted, header/footer always present.
 *
 * Deterministic: template-rendered data only, zero inference. EVERY
 * data-derived string goes through escapeHtml (§4.1 cryptic-title rule: the
 * event/series title is always rendered beside the market title).
 */
import { escapeHtml } from "../admin/html.js";
import type { Snapshot } from "../kalshi/types.js";

export interface WatchlistEntry {
  snapshot: Snapshot;
  /** 24h move in points (cents); null when no reference exists. */
  d24: number | null;
  /** 7d move in points (cents); null when no reference exists. */
  d7: number | null;
}

/** Placeholder shape for the stage-7 discovery section (rendered only when provided). */
export interface DiscoveryItem {
  ticker: string;
  title: string;
  reason: string;
}

/** Placeholder shape for the stage-6 alerts summary (rendered only when provided). */
export interface AlertsSummary {
  lines: string[];
  suppressedCount: number;
}

export interface NewsletterInput {
  profileName: string;
  /** Run day, YYYY-MM-DD. */
  date: string;
  /** Honest "as of" timestamp (oldest fetchedAt when serving stale data). */
  asOf: string;
  /** True when any rendered row is last-known data (fetch degraded). */
  stale: boolean;
  /** Every followed (open) market — the watchlist. */
  entries: WatchlistEntry[];
  /** Markets closed/settled since the last brief. */
  closed: Snapshot[];
  discovery?: DiscoveryItem[];
  alerts?: AlertsSummary;
  healthNotes: string[];
  costUsd: number;
}

export interface RenderedNewsletter {
  html: string;
  /** Section ids actually rendered, in contract order (for RunManifest). */
  sections: string[];
  moversCount: number;
}

export const MOVERS_LIMIT = 5;

export const DISCLAIMER = "Prices are crowd estimates, not predictions or advice.";

export function newsletterSubject(profileName: string, date: string): string {
  return `[Crowd-Signal] ${profileName} daily — ${date}`;
}

/** Signed points: "+7", "−3" (minus sign), "0", or "·" when unknown. */
export function formatDelta(d: number | null): string {
  if (d === null) return "·";
  if (d > 0) return `+${d}`;
  if (d < 0) return `−${Math.abs(d)}`;
  return "0";
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Pick the movers: largest 24h moves (non-null, non-zero), sorted by |Δ|. */
export function selectMovers(entries: readonly WatchlistEntry[]): WatchlistEntry[] {
  return entries
    .filter((e) => e.d24 !== null && e.d24 !== 0)
    .sort((a, b) => Math.abs(b.d24 ?? 0) - Math.abs(a.d24 ?? 0))
    .slice(0, MOVERS_LIMIT);
}

const STYLE = `
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 1.25rem;
    color: #1a1a1a; background: #fafafa; }
  .wrap { max-width: 42rem; margin: 0 auto; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 1.1rem 1.25rem;
    background: #fff; margin-bottom: 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  h2 { font-size: 1rem; margin: 0 0 .6rem; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #eee;
    vertical-align: top; }
  th { font-weight: 600; color: #555; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  a { color: #2563eb; }
  .muted { color: #777; font-size: .8rem; }
  .context { color: #666; font-size: .78rem; }
  .stale { background: #fef9c3; border: 1px solid #fde047; color: #854d0e;
    padding: .5rem .75rem; border-radius: 6px; margin: .6rem 0 0; font-size: .85rem; }
  .health { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c;
    padding: .5rem .75rem; border-radius: 6px; margin: 0 0 .6rem; font-size: .85rem; }
  .up { color: #15803d; } .down { color: #b91c1c; }
  .badge { display: inline-block; padding: 0 .4rem; border-radius: 999px;
    font-size: .7rem; border: 1px solid #d97706; color: #92400e; margin-left: .3rem; }
  .footer { font-size: .8rem; color: #666; }
  .footer p { margin: .3rem 0; }
`;

function deltaCell(d: number | null): string {
  const cls = d !== null && d > 0 ? "up" : d !== null && d < 0 ? "down" : "";
  return `<td class="num${cls ? ` ${cls}` : ""}">${formatDelta(d)}</td>`;
}

/** Market title with its event/series context — the §4.1 cryptic-title rule. */
function titleCell(s: Snapshot, withLink: boolean): string {
  const title = withLink
    ? `<a href="${escapeHtml(s.marketUrl)}">${escapeHtml(s.title)}</a>`
    : escapeHtml(s.title);
  const staleBadge = s.stale ? `<span class="badge">stale</span>` : "";
  return `<td>${title}${staleBadge}<br><span class="context">${escapeHtml(s.eventTitle)}</span></td>`;
}

function moversSection(movers: readonly WatchlistEntry[]): string {
  const rows = movers
    .map(
      (e) => `<tr>
${titleCell(e.snapshot, false)}
<td class="num">${e.snapshot.yesPriceCents}%</td>
${deltaCell(e.d24)}
</tr>`
    )
    .join("\n");
  return `<div class="card">
<h2>Movers (24h)</h2>
<table>
<thead><tr><th>Market</th><th class="num">Prob</th><th class="num">24h Δ</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;
}

function watchlistSection(entries: readonly WatchlistEntry[]): string {
  const rows = entries
    .map(
      (e) => `<tr>
${titleCell(e.snapshot, true)}
<td class="num">${e.snapshot.yesPriceCents}%</td>
${deltaCell(e.d24)}
${deltaCell(e.d7)}
<td class="num">${e.snapshot.volume.toLocaleString("en-US")}</td>
<td class="num">${escapeHtml(formatDate(e.snapshot.closeTime))}</td>
</tr>`
    )
    .join("\n");
  return `<div class="card">
<h2>Watchlist</h2>
<table>
<thead><tr><th>Market</th><th class="num">Prob</th><th class="num">24h Δ</th><th class="num">7d Δ</th><th class="num">Volume</th><th class="num">Closes</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;
}

function closedSection(closed: readonly Snapshot[]): string {
  const rows = closed
    .map((s) => {
      const outcome =
        s.settlement === "yes"
          ? "Settled YES"
          : s.settlement === "no"
            ? "Settled NO"
            : "Closed (settlement pending)";
      return `<tr>
${titleCell(s, true)}
<td>${outcome}</td>
</tr>`;
    })
    .join("\n");
  return `<div class="card">
<h2>Closed since last brief</h2>
<table>
<thead><tr><th>Market</th><th>Outcome</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;
}

function discoverySection(items: readonly DiscoveryItem[]): string {
  const rows = items
    .map(
      (i) => `<tr>
<td>${escapeHtml(i.title)}<br><span class="context">${escapeHtml(i.ticker)}</span></td>
<td>${escapeHtml(i.reason)}</td>
</tr>`
    )
    .join("\n");
  return `<div class="card">
<h2>New markets you might want</h2>
<table>
<thead><tr><th>Market</th><th>Why</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p class="muted">Confirm additions in the Crowd-Signal admin UI — suggestions are never auto-added.</p>
</div>`;
}

function alertsSection(alerts: AlertsSummary): string {
  const lines = alerts.lines
    .map((l) => `<li>${escapeHtml(l)}</li>`)
    .join("\n");
  const suppressed =
    alerts.suppressedCount > 0
      ? `<p class="muted">${alerts.suppressedCount} further alert${alerts.suppressedCount === 1 ? "" : "s"} suppressed.</p>`
      : "";
  return `<div class="card">
<h2>Alerts summary</h2>
${lines ? `<ul>${lines}</ul>` : ""}
${suppressed}
</div>`;
}

export function renderNewsletter(input: NewsletterInput): RenderedNewsletter {
  const sections: string[] = [];
  const parts: string[] = [];

  // 1. Header — always present. Stale data stamped honestly.
  sections.push("header");
  parts.push(`<div class="card">
<h1>${escapeHtml(input.profileName)} — daily brief</h1>
<p class="muted">${escapeHtml(input.date)} &middot; as of ${escapeHtml(input.asOf)}</p>
${
  input.stale
    ? `<p class="stale">Some prices are last-known values — the source could not be reached. See source health in the footer.</p>`
    : ""
}
</div>`);

  // 2. Movers — largest 24h moves, sorted by |Δ|.
  const movers = selectMovers(input.entries);
  if (movers.length > 0) {
    sections.push("movers");
    parts.push(moversSection(movers));
  }

  // 3. Watchlist — every followed market.
  if (input.entries.length > 0) {
    sections.push("watchlist");
    parts.push(watchlistSection(input.entries));
  }

  // 4. Closed since last brief.
  if (input.closed.length > 0) {
    sections.push("closed");
    parts.push(closedSection(input.closed));
  }

  // 5. New markets you might want (stage 7 supplies items).
  if (input.discovery && input.discovery.length > 0) {
    sections.push("discovery");
    parts.push(discoverySection(input.discovery));
  }

  // 6. Alerts summary (stage 6 supplies it).
  if (input.alerts) {
    sections.push("alerts");
    parts.push(alertsSection(input.alerts));
  }

  // 7. Footer — always present: source health, config pointer, disclaimer,
  // per-run cost line (≈ $0 in v1; printed anyway).
  sections.push("footer");
  const health =
    input.healthNotes.length > 0
      ? `<p class="health">Source health: ${input.healthNotes.map((n) => escapeHtml(n)).join(" &middot; ")}</p>`
      : `<p>Source health: all sources OK.</p>`;
  parts.push(`<div class="card footer">
${health}
<p>Manage subscriptions and recipients in the Crowd-Signal admin UI (/admin on your deployment).</p>
<p>${DISCLAIMER}</p>
<p>Run cost: $${input.costUsd.toFixed(4)}</p>
</div>`);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(newsletterSubject(input.profileName, input.date))}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${parts.join("\n")}
</div>
</body>
</html>
`;

  return { html, sections, moversCount: movers.length };
}
