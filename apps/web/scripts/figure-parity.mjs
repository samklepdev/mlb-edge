// Extracts every number the dashboard renders, so a visual restyle can prove
// it changed nothing but presentation.
//
// This repo has no component test harness. The failure mode that actually
// matters here is a figure silently shifting during a CSS/markup change, and
// that is exactly what a diff of this output catches.
//
// Usage: start `npm run web:dev`, then
//   node apps/web/scripts/figure-parity.mjs > baseline.txt
//
// Caveat: this reads a live render. Do NOT run any pipeline command between a
// baseline and its comparison -- new data reads as a spurious diff.

const BASE = process.env.PARITY_BASE ?? 'http://localhost:3000';

// Next inlines the RSC flight payload into <script> tags; dropping script and
// style wholesale is what keeps this to *visible* text.
const strip = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:[a-z]+|#\d+);/gi, ' ');

const figures = (text) => text.match(/-?\d[\d,]*\.?\d*%?/g) ?? [];

// SVG elements encode chart data purely as geometry attributes. We must
// extract these before the tag stripper removes all attributes.
const svgFigures = (html) => {
  const results = [];

  // Extract numeric attribute values from SVG elements
  const getAttr = (element, attrName) => {
    const match = element.match(new RegExp(`${attrName}\\s*=\\s*["\']?(-?[\\d.]+)`));
    return match ? match[1] : null;
  };

  // Circles: cx, cy, r
  for (const circle of html.matchAll(/<circle[^>]*>/gi)) {
    const cx = getAttr(circle[0], 'cx');
    const cy = getAttr(circle[0], 'cy');
    const r = getAttr(circle[0], 'r');
    if (cx) results.push(`svg:circle:cx:${cx}`);
    if (cy) results.push(`svg:circle:cy:${cy}`);
    if (r) results.push(`svg:circle:r:${r}`);
  }

  // Lines: x1, y1, x2, y2
  for (const line of html.matchAll(/<line[^>]*>/gi)) {
    const x1 = getAttr(line[0], 'x1');
    const y1 = getAttr(line[0], 'y1');
    const x2 = getAttr(line[0], 'x2');
    const y2 = getAttr(line[0], 'y2');
    if (x1) results.push(`svg:line:x1:${x1}`);
    if (y1) results.push(`svg:line:y1:${y1}`);
    if (x2) results.push(`svg:line:x2:${x2}`);
    if (y2) results.push(`svg:line:y2:${y2}`);
  }

  return results;
};

async function fetchPage(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.text();
}

const home = await fetchPage('/');

// Follow the first player link rather than hardcoding an id, so the harness
// keeps working across slates.
const link = home.match(/\/player\?id=(\d+)&(?:amp;)?date=([\d-]+)/);
if (!link) throw new Error('no player link found on home page');
const playerPath = `/player?id=${link[1]}&date=${link[2]}`;
const player = await fetchPage(playerPath);

for (const [label, html] of [['/', home], [playerPath, player]]) {
  for (const f of figures(strip(html))) console.log(`${label}\t${f}`);
  for (const f of svgFigures(html)) console.log(`${label}\t${f}`);
}
