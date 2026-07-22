/**
 * Renderer unit tests: section ordering/omission, movers sort + top-5 cap,
 * delta formatting, HTML escaping of data-derived strings, and the
 * always-present footer (disclaimer + cost line).
 */
import { describe, expect, it } from "vitest";
import {
  DISCLAIMER,
  formatDelta,
  newsletterSubject,
  renderNewsletter,
  selectMovers,
  type NewsletterInput,
  type WatchlistEntry
} from "../src/render/newsletter.js";
import { makeSnapshot } from "./snapshots/helpers.js";

function entry(
  ticker: string,
  d24: number | null,
  d7: number | null = null,
  overrides: Parameters<typeof makeSnapshot>[0] = {}
): WatchlistEntry {
  return { snapshot: makeSnapshot({ ticker, ...overrides }), d24, d7 };
}

function baseInput(overrides: Partial<NewsletterInput> = {}): NewsletterInput {
  return {
    profileName: "Macro Watch",
    date: "2026-07-22",
    asOf: "2026-07-22T12:00:00.000Z",
    stale: false,
    entries: [],
    closed: [],
    healthNotes: [],
    costUsd: 0,
    ...overrides
  };
}

describe("formatDelta", () => {
  it("renders signed points and the null dot", () => {
    expect(formatDelta(7)).toBe("+7");
    expect(formatDelta(-3)).toBe("−3");
    expect(formatDelta(0)).toBe("0");
    expect(formatDelta(null)).toBe("·");
  });
});

describe("selectMovers", () => {
  it("sorts by |Δ| descending, drops nulls and zero-moves, caps at 5", () => {
    const entries = [
      entry("A", 2),
      entry("B", -9),
      entry("C", null),
      entry("D", 0),
      entry("E", 5),
      entry("F", -3),
      entry("G", 4),
      entry("H", 1)
    ];
    const movers = selectMovers(entries);
    expect(movers.map((m) => m.snapshot.ticker)).toEqual([
      "B",
      "E",
      "G",
      "F",
      "A"
    ]);
    expect(movers).toHaveLength(5);
  });
});

describe("renderNewsletter sections", () => {
  it("empty newsletter renders header + footer only", () => {
    const out = renderNewsletter(baseInput());
    expect(out.sections).toEqual(["header", "footer"]);
    expect(out.moversCount).toBe(0);
    expect(out.html).not.toContain("Watchlist");
    expect(out.html).not.toContain("Closed since last brief");
    expect(out.html).not.toContain("New markets you might want");
    expect(out.html).not.toContain("Alerts summary");
  });

  it("no closed markets -> closed section absent; with closed -> present with outcome", () => {
    const without = renderNewsletter(
      baseInput({ entries: [entry("T1", 3)] })
    );
    expect(without.sections).toEqual(["header", "movers", "watchlist", "footer"]);

    const withClosed = renderNewsletter(
      baseInput({
        entries: [entry("T1", 3)],
        closed: [
          makeSnapshot({
            ticker: "GONE",
            title: "Settled market?",
            status: "settled",
            settlement: "no"
          })
        ]
      })
    );
    expect(withClosed.sections).toEqual([
      "header",
      "movers",
      "watchlist",
      "closed",
      "footer"
    ]);
    expect(withClosed.html).toContain("Settled NO");
  });

  it("discovery and alerts render only when provided, in contract order", () => {
    const out = renderNewsletter(
      baseInput({
        entries: [entry("T1", null)],
        discovery: [
          { ticker: "KXNEW", title: "A new market?", reason: "matches profile" }
        ],
        alerts: { lines: ["T1 moved +6 overnight"], suppressedCount: 2 }
      })
    );
    expect(out.sections).toEqual([
      "header",
      "watchlist",
      "discovery",
      "alerts",
      "footer"
    ]);
    const discovery = out.html.indexOf("New markets you might want");
    const alerts = out.html.indexOf("Alerts summary");
    expect(discovery).toBeGreaterThan(out.html.indexOf("Watchlist"));
    expect(alerts).toBeGreaterThan(discovery);
    expect(out.html).toContain("2 further alerts suppressed");
    expect(out.html).toContain("never auto-added");
  });

  it("watchlist always shows event/series context beside the market title (§4.1)", () => {
    const out = renderNewsletter(
      baseInput({
        entries: [
          entry("T1", 1, null, {
            title: "Will the ceiling be raised before March 15?",
            eventTitle: "US debt ceiling, 2026"
          })
        ]
      })
    );
    const title = out.html.indexOf("Will the ceiling be raised");
    const context = out.html.indexOf("US debt ceiling, 2026");
    expect(title).toBeGreaterThan(-1);
    expect(context).toBeGreaterThan(title);
  });

  it("stale input stamps the header honestly", () => {
    const out = renderNewsletter(
      baseInput({
        stale: true,
        healthNotes: ["kalshi unreachable; serving last-known data"],
        entries: [entry("T1", null, null, { stale: true })]
      })
    );
    expect(out.html).toContain("Some prices are last-known values");
    expect(out.html).toContain(">stale</span>");
    expect(out.html).toContain("kalshi unreachable; serving last-known data");
  });
});

describe("escaping (every data-derived string)", () => {
  it("neutralizes a malicious market title, event title, and health note", () => {
    const out = renderNewsletter(
      baseInput({
        profileName: `<img onerror=x>`,
        entries: [
          entry("EVIL", 2, null, {
            title: `<script>alert("pwn")</script>`,
            eventTitle: `"><style>*{display:none}</style>`
          })
        ],
        healthNotes: [`<script>steal()</script>`]
      })
    );
    expect(out.html).not.toContain(`<script>alert`);
    expect(out.html).not.toContain(`<script>steal`);
    expect(out.html).not.toContain(`<img onerror`);
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).toContain("&quot;&gt;&lt;style&gt;");
  });
});

describe("footer invariants", () => {
  it("disclaimer and $0.0000 cost line are ALWAYS present", () => {
    for (const input of [
      baseInput(),
      baseInput({ entries: [entry("T1", 5)], healthNotes: ["degraded"] })
    ]) {
      const html = renderNewsletter(input).html;
      expect(html).toContain(DISCLAIMER);
      expect(html).toContain("Run cost: $0.0000");
    }
  });

  it("subject follows the stage-5 pattern", () => {
    expect(newsletterSubject("Macro Watch", "2026-07-22")).toBe(
      "[Crowd-Signal] Macro Watch daily — 2026-07-22"
    );
  });
});
