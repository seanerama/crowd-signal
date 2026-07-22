/**
 * Server-rendered HTML helpers for the admin UI. House style: self-contained
 * pages, inline CSS, zero external requests, no client build, no template lib.
 * EVERY user-supplied string interpolated into markup goes through escapeHtml.
 */

/** Minimal HTML escaper — the only sanctioned way to put user text in a page. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; background: #fafafa; }
  main { max-width: 52rem; margin: 0 auto; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 1.5rem; background: #fff; margin-bottom: 1.5rem; }
  h1 { font-size: 1.3rem; margin: 0 0 1rem; }
  h2 { font-size: 1.05rem; margin: 0 0 .75rem; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #eee; }
  th { font-weight: 600; color: #555; }
  label { display: block; font-weight: 600; margin: .75rem 0 .25rem; font-size: .9rem; }
  input[type=text], input[type=password], input[type=number], input[type=time], textarea, select {
    width: 100%; max-width: 28rem; padding: .45rem .6rem; border: 1px solid #ccc; border-radius: 6px;
    font: inherit; background: #fff;
  }
  textarea { min-height: 4.5rem; }
  button { font: inherit; padding: .45rem 1rem; border-radius: 6px; border: 1px solid #2563eb;
    background: #2563eb; color: #fff; cursor: pointer; margin-top: .75rem; }
  button.secondary { background: #fff; color: #2563eb; }
  button.danger { background: #fff; color: #b91c1c; border-color: #b91c1c; margin-top: 0; padding: .2rem .6rem; font-size: .85rem; }
  a { color: #2563eb; }
  nav { margin-bottom: 1.5rem; display: flex; gap: 1rem; align-items: center; }
  nav form { margin-left: auto; }
  nav button { margin-top: 0; padding: .3rem .8rem; }
  .error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; padding: .6rem .9rem; border-radius: 6px; margin-bottom: 1rem; }
  .notice { background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; padding: .6rem .9rem; border-radius: 6px; margin: .75rem 0; font-size: .9rem; }
  .muted { color: #777; font-size: .85rem; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .75rem; border: 1px solid #ccc; color: #555; }
  .badge.on { border-color: #16a34a; color: #16a34a; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 0 1rem; }
  .inline-form { display: inline; }
`;

/**
 * Wrap page body in the shared shell. `title` and `body` are HTML — callers
 * must have escaped any user-supplied strings already.
 */
export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Crowd-Signal admin</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
