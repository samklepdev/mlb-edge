// WCAG contrast gate for the dashboard's palette.
//
// The branch that introduced this palette carried its contrast check as an
// inline `node -e` script in a plan document, with the hex values pasted in by
// hand. That drifted: --faint was darkened from #8a95a1 to #666f7a to clear AA,
// and the pasted list went on testing #8a95a1 -- a colour the codebase no
// longer contained. So this script READS the colours out of globals.css and
// never restates them.
//
// Usage:  npm run contrast          (from the repo root)
//         node apps/web/scripts/contrast.mjs
// Exits non-zero if any pair is below its threshold, so it works as a gate.
//
// Thresholds are WCAG 2.x AA: 4.5:1 for normal text, 3.0:1 for large text.
// Large here means the wordmark (1.6rem / 700) and the section eyebrows
// (1.15rem / 600, and .player-id h2 at 1.5rem / 700).
//
// What this does NOT check: whether a colour is legible in situ. It compares
// declared foregrounds against declared surfaces. If a future rule puts --faint
// on a surface that is not listed below, this gate will not notice -- the pair
// list has to be extended by hand. That is the one piece of hand-maintenance
// left, and it is deliberate: the alternative is rendering the pages and
// walking the computed styles, which needs a running server and would make a
// static check depend on a live one.

import { readFileSync } from 'node:fs';

const CSS_URL = new URL('../src/app/globals.css', import.meta.url);
const css = readFileSync(CSS_URL, 'utf8');

// Strip comments first. The :root block documents its own contrast ratios in a
// comment that mentions both token names and hex values, and parsing that would
// pick up colours the stylesheet does not actually use.
const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');

const die = (msg) => {
  console.error(`contrast: ${msg}`);
  process.exit(2);
};

// --- tokens out of :root -----------------------------------------------------
const rootBlock = clean.match(/:root\s*\{([^}]*)\}/);
if (!rootBlock) die('no :root block found in globals.css');

const tokens = new Map();
for (const m of rootBlock[1].matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;/g)) {
  tokens.set(m[1], m[2]);
}
if (tokens.size === 0) die('found :root but no --name: #hex declarations in it');

// --- literal colours declared on specific rules ------------------------------
// The masthead sits on --navy and its three foregrounds are literals rather
// than tokens, because they exist only on that one surface.
const ruleColors = new Map();
for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = m[1].trim().replace(/\s+/g, ' ');
  const col = [...m[2].matchAll(/(?:^|;)\s*color\s*:\s*(#[0-9a-fA-F]{3,6})\s*(?:;|$)/g)].pop();
  if (col) ruleColors.set(sel, col[1]); // last declaration for a selector wins
}

const expand = (hex) => {
  const h = hex.slice(1);
  if (h.length === 3) return '#' + [...h].map((c) => c + c).join('');
  if (h.length === 6) return '#' + h;
  return die(`cannot handle the colour ${hex}`);
};

const tok = (name) => {
  if (!tokens.has(name)) die(`globals.css :root no longer declares --${name}`);
  return expand(tokens.get(name));
};
const lit = (sel) => {
  if (!ruleColors.has(sel)) die(`globals.css no longer declares a literal color on \`${sel}\``);
  return expand(ruleColors.get(sel));
};

// --- WCAG relative luminance and contrast ratio ------------------------------
const lum = (hex) => {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
};

// --- the pairs ---------------------------------------------------------------
// `note` is printed only where the foreground is a rule literal rather than a
// token, so the output says where an unfamiliar hex came from.
const NORMAL = 4.5;
const LARGE = 3.0;

const pairs = [
  // masthead: literal foregrounds on --navy
  ['wordmark on navy',            lit('.wordmark'),      tok('navy'),   LARGE,  'on --navy'],
  ['nav link on navy',            lit('.mnav-link'),     tok('navy'),   NORMAL, 'on --navy'],
  ['wordmark span on navy',       lit('.wordmark span'), tok('navy'),   LARGE,  'on --navy'],
  // the text ramp against the surfaces it is actually used on
  ['ink on panel',                tok('ink'),            tok('panel'),  NORMAL, null],
  ['muted on stripe',             tok('muted'),          tok('stripe'), NORMAL, null],
  ['navy heading on paper',       tok('navy'),           tok('paper'),  LARGE,  null],
  ['faint on panel',              tok('faint'),          tok('panel'),  NORMAL, null],
  ['faint on stripe',             tok('faint'),          tok('stripe'), NORMAL, null],
  ['faint on paper (roster hover)', tok('faint'),        tok('paper'),  NORMAL, null],
  ['muted on panel',              tok('muted'),          tok('panel'),  NORMAL, null],
  // calibration colours. These live only on --panel: .value.good/.bad sit in a
  // .readout, and the td.good/td.bad rules have no call site since the edge
  // columns lost their colour.
  ['good on panel',               tok('good'),           tok('panel'),  NORMAL, null],
  ['bad on panel',                tok('bad'),            tok('panel'),  NORMAL, null],
  // the remaining ramp-on-surface combinations, so no actual use is untested
  ['ink on stripe',               tok('ink'),            tok('stripe'), NORMAL, null],
  ['ink on paper',                tok('ink'),            tok('paper'),  NORMAL, null],
  ['muted on paper',              tok('muted'),          tok('paper'),  NORMAL, null],
  ['navy heading on panel',       tok('navy'),           tok('panel'),  LARGE,  null],
  // The draggable line's casing, which is what actually makes it visible --
  // --line itself is deliberately below 3:1 on white (see the token comment)
  // and is legible only because this sits around it.
  ['line edge on panel',          tok('line-edge'),      tok('panel'),  LARGE,  null],
];

let failed = 0;
for (const [label, fg, bg, min, note] of pairs) {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) failed++;
  const annot = note ? `(${fg} ${note})` : '';
  const line = `${r.toFixed(2).padStart(6)}  min ${min.toFixed(1)}   ${label.padEnd(30)}${annot}${ok ? '' : '   FAIL'}`;
  console.log(line.trimEnd());
}

if (failed > 0) {
  console.error(`\ncontrast: ${failed} of ${pairs.length} pairs below threshold`);
  process.exit(1);
}
console.log(`\ncontrast: ${pairs.length} pairs pass (4.5 normal text, 3.0 large text)`);
