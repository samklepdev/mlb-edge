// Extracts every number the dashboard renders, so a visual restyle can prove
// it changed nothing but presentation.
//
// This repo has no component test harness. The failure mode that actually
// matters here is a figure silently shifting during a CSS/markup change, and
// that is exactly what a diff of this output catches.
//
// Usage: build, start a PRODUCTION server, then point this at it:
//   npm run web:build
//   (cd apps/web && npx next start -p 3100)
//   PARITY_BASE=http://localhost:3100 npm run parity > baseline.txt
//
// PARITY_BASE has no default, and the build the server is serving is checked
// against .next/BUILD_ID before anything is read. Both guards exist because
// this harness used to default to http://localhost:3000 -- the `next dev`
// server -- and running `next build` while `next dev` is up leaves dev serving
// a STALE compile. This branch hit exactly that: /player came back without the
// .tscroll wrappers the source plainly had. A stale read produces a clean diff,
// and a clean diff reads as "PARITY OK". A gate that reports success when it is
// reading the wrong thing is worse than no gate.
//
// Three caveats on what a green run does and does not prove:
//
// 1. It reads a live render, so do NOT run any pipeline command (ingest,
//    project, lines, settle) between a baseline and its comparison -- new data
//    reads as a spurious diff.
// 2. It reads HTML TEXT. A figure that is present in the markup but visually
//    unreachable -- clipped, hidden, zero-size, behind an overflow -- passes.
//    That is not hypothetical: `body { overflow-x: hidden }` clipped the Edge
//    column off the right of every table for four consecutive tasks, all of
//    them green here. Position, spacing and colour need a browser.
// 3. It is colour-blind by construction, which is the point for figure parity
//    but means a change like "the plot's axis labels got darker" is invisible
//    to it. Contrast is the other script in this directory.

import { readFileSync } from 'node:fs';

const BASE = process.env.PARITY_BASE;
if (!BASE) {
  console.error(
    'figure-parity: set PARITY_BASE to a production server, e.g.\n' +
      '  PARITY_BASE=http://localhost:3100 node apps/web/scripts/figure-parity.mjs\n' +
      'There is deliberately no default: the old default was the next dev\n' +
      'server, which serves a stale compile after any next build.'
  );
  process.exit(2);
}

// Next inlines the RSC flight payload into <script> tags; dropping script and
// style wholesale is what keeps this to *visible* text.
const strip = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    // Hex entities are the reason for `#x[0-9a-f]+`. React escapes apostrophes
    // as `&#x27;`, which `#\d+` does not match -- so every apostrophe in page
    // copy survived stripping and the number regex below harvested `27` from
    // it as though it were data. The home page alone carried eight phantom
    // `27`s, and a copy edit that added or removed an apostrophe produced a
    // spurious diff in the one gate meant to rule those out.
    .replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, ' ');

const figures = (text) => text.match(/-?\d[\d,]*\.?\d*%?/g) ?? [];

// Circles in SVG charts encode all bucket data as geometry: cx = predicted
// probability, cy = actual rate, r = sample size. Lines (grid, diagonal, and
// per-bucket connectors) are pure layout derived from hardcoded constants and
// duplicates of values circles already carry. Extract circles only.
const svgFigures = (html) => {
  const results = [];

  // Extract numeric attribute values from SVG elements
  const getAttr = (element, attrName) => {
    // \b anchors the attribute name. Without it, `r` would also match the tail
    // of any attribute ending in r -- safe today only because React emits none
    // such on <circle>, which is not a property worth depending on.
    const match = element.match(new RegExp(`\\b${attrName}\\s*=\\s*["\']?(-?[\\d.]+)`));
    return match ? match[1] : null;
  };

  // Circles: cx (predicted), cy (actual), r (sample size)
  for (const circle of html.matchAll(/<circle[^>]*>/gi)) {
    const cx = getAttr(circle[0], 'cx');
    const cy = getAttr(circle[0], 'cy');
    const r = getAttr(circle[0], 'r');
    if (cx) results.push(`svg:circle:cx:${cx}`);
    if (cy) results.push(`svg:circle:cy:${cy}`);
    if (r) results.push(`svg:circle:r:${r}`);
  }

  return results;
};

async function fetchPage(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.text();
}

const home = await fetchPage('/');
// The slate moved off `/` when the prop explorer became the landing page. It is
// still the page with the most figures on it, and it is where the player links
// live, so it has to be fetched explicitly rather than reached from home.
const slate = await fetchPage('/slate');

// Freshness gate. `next build` writes .next/BUILD_ID, and an App Router
// production render inlines that id into its flight payload. A `next dev`
// server emits no build id at all, so this catches both "you pointed at dev"
// and "you rebuilt but never restarted the server you are reading".
const buildIdPath = new URL('../.next/BUILD_ID', import.meta.url);
let buildId;
try {
  buildId = readFileSync(buildIdPath, 'utf8').trim();
} catch {
  console.error(
    'figure-parity: no apps/web/.next/BUILD_ID -- run `npm run web:build` first.'
  );
  process.exit(2);
}
if (!home.includes(buildId)) {
  console.error(
    `figure-parity: ${BASE} is not serving the current build.\n` +
      `  .next/BUILD_ID on disk: ${buildId}\n` +
      '  That id does not appear in the HTML it returned. Either this is a\n' +
      '  `next dev` server (dev emits no build id) or it is a production\n' +
      '  server started before the last build -- restart it, then re-run.'
  );
  process.exit(3);
}

// Follow the first player link rather than hardcoding an id, so the harness
// keeps working across slates. Read off /slate, not /: the landing page is the
// prop explorer now and links to itself, not to player cards.
const link = slate.match(/\/player\?id=(\d+)&(?:amp;)?date=([\d-]+)/);
if (!link) throw new Error('no player link found on /slate');
const playerPath = `/player?id=${link[1]}&date=${link[2]}`;
const player = await fetchPage(playerPath);

// /model carries the calibration table, the reliability plot and the CLV
// figures. They used to live on `/` and were covered here by accident; when
// they moved to their own page this harness had to follow, or the only
// automated check the web app has would have silently stopped watching the
// numbers that decide whether the model is worth anything.
const model = await fetchPage('/model');

for (const [label, html] of [
  ['/', home], ['/slate', slate], [playerPath, player], ['/model', model],
]) {
  for (const f of figures(strip(html))) console.log(`${label}\t${f}`);
  for (const f of svgFigures(html)) console.log(`${label}\t${f}`);
}
