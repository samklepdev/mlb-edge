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
}
