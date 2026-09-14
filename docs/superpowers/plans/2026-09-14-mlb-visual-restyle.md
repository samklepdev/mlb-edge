# MLB Visual Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle `apps/web` in the MLB.com / Gameday visual idiom — navy masthead, Barlow Condensed, team logos, card layout — and replace the slate's run-on matchup sentence with a row of game cards, without changing a single rendered figure.

**Architecture:** Almost entirely presentational. `globals.css` is rewritten around a new token set; `layout.tsx` loads one Google font; two new web-only files (`teams.ts`, `GameCard.tsx`) supply abbreviations, logo URLs, and the game card. The only data change is adding `startTime` to `SlateGame`, which touches `@mlb-edge/db` and therefore requires a rebuild. `ReliabilityPlot.tsx` is untouched because it already reads CSS custom properties.

**Tech Stack:** Next.js 16 App Router (React 19 server components), `next/font/google`, hand-written CSS with custom properties, Postgres via `@mlb-edge/db`.

## Global Constraints

- **`@mlb-edge/db` runs from compiled `dist/`.** Any edit to `packages/db` requires `npm run build:db` or the change is invisible at runtime. Verify with `grep`, never by assumption.
- **No `db:migrate` in this plan.** No schema changes. If a step seems to need one, stop — the design explicitly rejected a team-abbreviation column.
- **No new npm dependencies.** `next/font/google` ships inside `next`; `package.json` must not gain a dependency.
- **Brand colors never encode data.** `--navy` and `--red` are chrome only. `--good` / `--bad` are reserved for calibration. Edge and CLV figures get no color.
- **Copy is frozen.** Every explanatory string in `page.tsx` and `player/page.tsx` stays byte-identical: both masthead purpose sentences, all three calibration captions, the CLV "not colored" caption, every scorecard verdict string, the demo-seed notice, and the database-unreachable notice with its command block. Restyling them is in scope; rewording them is not.
- **Figure parity is the acceptance test.** Every number rendered before the change must render identically after. This is checked mechanically (Task 1), not by eye.
- **Consult `node_modules/next/dist/docs/` before writing Next-specific APIs.** `apps/web/AGENTS.md` warns this Next version differs from training data. `next/font` is the only such API here; its docs are at `node_modules/next/dist/docs/01-app/03-api-reference/02-components/font.md`.
- **Environment:** Postgres must be running (`docker compose up -d`). Latest slate with projections is **2026-09-13** (15 games).
- **Correction (found during execution):** an earlier draft of this plan claimed
  one game on the current slate has a null `start_time`. That was wrong — the
  table's single null is on `2099-01-01`, the demo-seed date, which has no
  projections and therefore never reaches `getSlateGames`. All 15 games on the
  live slate have a start time, so the `—` fallback is correct code that the
  live render does not exercise. Do not treat a missing `—` as a defect.

## Testing approach — read this before Task 1

**This repo has no test harness for the web app, and this plan does not add one.** A component-test framework would be a larger change than the restyle itself, and it would not catch the failure this plan actually cares about: a figure silently changing.

So the red/green cycle is inverted from normal TDD. Instead of writing a failing test per feature, Task 1 captures a **baseline of every number the dashboard renders**, and every subsequent task must leave that baseline unchanged. The "test" fails loudly if a restyle step disturbs data, and passes silently when the change is genuinely cosmetic.

Per task, the cycle is:
1. `npm run typecheck` — must pass
2. `node apps/web/scripts/figure-parity.mjs > after.txt && diff baseline.txt after.txt` — must be empty
3. Visual confirmation in the browser
4. Commit

Two tasks legitimately change the baseline: **Task 2** (adds first-pitch times) and **Task 5** (adds the game strip). Each says so explicitly and re-baselines. No other task may.

**Caveat:** parity compares live renders, so do not run any pipeline command (`ingest`, `project`, `lines`, `settle`) between a baseline and its comparison — new data would show up as a spurious diff.

## Deviation from the spec (approved rationale)

The spec's game card shows `N edges` per game, sourced from the already-loaded `d.edges`. While planning, I confirmed that `getTopEdges(date, 25)` in `packages/db/src/queries/slate.ts:34` is **truncated to 25 rows**. A card reading "4 edges" would therefore mean "4 of the 25 highest-edge picks", not "4 edges on this game" — a false statement of exactly the kind this project exists to avoid.

Options were: a new per-game count query (violates the design's "no new query"), raising the limit (changes what the Top Edges table shows), or relabelling. **This plan relabels**: the card line reads `N listed` and the strip carries a caption tying it to the table below. Truthful, no new query, no change to existing output.

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/scripts/figure-parity.mjs` | **New.** Extracts every rendered number from both pages. The verification tool for this plan and future web changes. |
| `packages/db/src/types.ts` | `SlateGame` gains `startTime` |
| `packages/db/src/queries/slate.ts` | `getSlateGames` selects `g.start_time` |
| `apps/web/src/app/_components/teams.ts` | **New.** Team id → abbreviation, and logo URL. Pure data + two functions, no JSX. |
| `apps/web/src/app/_components/GameCard.tsx` | **New.** One game card. Owns first-pitch formatting. |
| `apps/web/src/app/layout.tsx` | Loads Barlow Condensed, exposes it as a CSS variable |
| `apps/web/src/app/globals.css` | All styling. Grown in four append-only blocks, one per visual task. |
| `apps/web/src/app/page.tsx` | Markup/classNames; game strip; removes one `good` class |
| `apps/web/src/app/player/page.tsx` | Markup/classNames; removes one conditional `good` |
| `apps/web/src/app/_components/Headshot.tsx` | Gains `loading="lazy"` |
| `apps/web/src/app/_components/RosterSearch.tsx` | Headshot per row, navy pick dot |
| `apps/web/src/app/_components/ReliabilityPlot.tsx` | **Untouched** — already reads CSS vars |

`teams.ts` and `GameCard.tsx` are split deliberately: the abbreviation map is inert data that other surfaces (roster rows, player page) will want, while the card is one composition of it. Keeping the map JSX-free means it can be imported anywhere without pulling in a component.

---

### Task 1: Figure-parity harness and baseline

**Files:**
- Create: `apps/web/scripts/figure-parity.mjs`
- Modify: `apps/web/package.json` (add `parity` script)

**Interfaces:**
- Consumes: nothing
- Produces: `node apps/web/scripts/figure-parity.mjs` → prints `<path>\t<figure>` lines to stdout, one per number rendered. Exit 1 on fetch failure. Every later task depends on this command.

- [ ] **Step 1: Write the harness**

Create `apps/web/scripts/figure-parity.mjs`:

```js
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
```

- [ ] **Step 2: Add the npm script**

In `apps/web/package.json`, add to `"scripts"`:

```json
    "parity": "node scripts/figure-parity.mjs"
```

- [ ] **Step 3: Start the dev server**

```bash
docker compose up -d
npm run web:dev
```

Leave it running in a second terminal. Wait for `Ready in ...`.

- [ ] **Step 4: Capture the baseline**

```bash
mkdir -p /tmp/parity
node apps/web/scripts/figure-parity.mjs > /tmp/parity/baseline.txt
wc -l /tmp/parity/baseline.txt
head -20 /tmp/parity/baseline.txt
```

Expected: a non-trivial line count (hundreds — the roster and edges tables are long), and `head` showing lines like `/	2026` and `/	1,463`. If it errors with `no player link found`, the slate has no projections — check `npm run -w @mlb-edge/pipeline cli -- project --date 2026-09-13` has been run.

- [ ] **Step 5: Verify the harness detects a change**

Prove the test can fail before trusting it. Temporarily edit `apps/web/src/app/page.tsx:13`:

```ts
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;   // 1 -> 2 decimals
```

Then:

```bash
node apps/web/scripts/figure-parity.mjs > /tmp/parity/probe.txt
diff /tmp/parity/baseline.txt /tmp/parity/probe.txt | head
```

Expected: a non-empty diff showing `62.0%` → `62.00%` style changes. **Revert the edit** (`git checkout apps/web/src/app/page.tsx`) and re-run to confirm the diff is empty again.

- [ ] **Step 6: Commit**

```bash
git add apps/web/scripts/figure-parity.mjs apps/web/package.json
git commit -m "Add a figure-parity harness for web changes

The web app has no test harness, and the failure that matters during a
restyle is a rendered number silently shifting. This extracts every figure
from both pages so that change shows up as a diff instead of going
unnoticed. It follows the first player link rather than hardcoding an id,
so it keeps working across slates.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `startTime` on `SlateGame`

**Files:**
- Modify: `packages/db/src/types.ts:29-36`
- Modify: `packages/db/src/queries/slate.ts:15-31`

**Interfaces:**
- Consumes: nothing
- Produces: `SlateGame.startTime: Date | null`. Task 5's `GameCard` reads it.

**Parity must stay clean in this task.** Nothing renders `startTime` until Task 5, so adding the field must not move a single figure. Separating the data change from its first use is what makes that assertion checkable.

- [ ] **Step 1: Add the field to the type**

In `packages/db/src/types.ts`, in `interface SlateGame`, after `away: string;`:

```ts
  startTime: Date | null;
```

Full interface after the edit:

```ts
export interface SlateGame {
  gameId: number;
  date: string;
  home: string;
  away: string;
  startTime: Date | null;
  homeId: number | null;
  awayId: number | null;
}
```

- [ ] **Step 2: Select and map it**

In `packages/db/src/queries/slate.ts`, replace the body of `getSlateGames` (lines 15-31) with:

```ts
export async function getSlateGames(date: string): Promise<SlateGame[]> {
  const res = await query<{
    id: number; home: string; away: string; start_time: Date | null;
    home_id: number | null; away_id: number | null;
  }>(
    `SELECT g.id,
            th.name AS home, ta.name AS away,
            g.start_time,
            g.home_team_id AS home_id, g.away_team_id AS away_id
     FROM games g
     LEFT JOIN teams th ON th.id = g.home_team_id
     LEFT JOIN teams ta ON ta.id = g.away_team_id
     WHERE g.game_date = $1
       AND EXISTS (SELECT 1 FROM projections p WHERE p.game_id = g.id)
     ORDER BY g.start_time NULLS LAST, g.id`,
    [date],
  );
  return res.rows.map((r) => ({
    gameId: r.id, date, home: r.home, away: r.away, startTime: r.start_time,
    homeId: r.home_id, awayId: r.away_id,
  }));
}
```

Note the `ORDER BY` also changes, from `g.id` to first-pitch order. A scoreboard ordered by game id is arbitrary; ordered by start time it reads like a slate. `NULLS LAST` keeps the one real game with a null `start_time` from leading the strip.

- [ ] **Step 3: Rebuild the db package**

```bash
npm run build:db
```

- [ ] **Step 4: Verify the rebuild actually took**

This is the plan's most likely silent failure. Do not skip.

```bash
grep -n "start_time" packages/db/dist/queries/slate.js
```

Expected: at least two hits — the `SELECT g.start_time` line and the `startTime: r.start_time` mapping. **If this prints nothing, the build did not take and every later task will show blank times with no error.**

- [ ] **Step 5: Verify the data end to end**

```bash
node -e "
const { getSlateGames, latestSlateDate } = require('./packages/db/dist/index.js');
(async () => {
  const d = await latestSlateDate();
  const games = await getSlateGames(d);
  console.log('slate', d, 'games', games.length);
  console.log(games.slice(0, 3).map(g => [g.away, g.home, g.startTime, g.awayId, g.homeId]));
  console.log('null start_time:', games.filter(g => g.startTime == null).length);
  process.exit(0);
})();
"
```

Expected: `slate 2026-09-13 games 15`, three rows each with a real `Date`, and a null count of `0` or `1`. Team ids must be numbers, not null.

- [ ] **Step 6: Typecheck and confirm parity is untouched**

```bash
npm run typecheck
node apps/web/scripts/figure-parity.mjs > /tmp/parity/after.txt
diff /tmp/parity/baseline.txt /tmp/parity/after.txt && echo "PARITY OK"
```

Expected: typecheck passes, `PARITY OK`. Nothing renders `startTime` yet, so any diff here means something else broke.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/types.ts packages/db/src/queries/slate.ts
git commit -m "Carry first-pitch time on SlateGame

The scoreboard strip needs a start time, and games.start_time already
exists -- it was simply never selected. Also orders the slate by first
pitch rather than game id, which is arbitrary, with NULLS LAST so the one
game missing a start time does not lead the strip.

Requires npm run build:db; without it startTime is undefined at runtime
and every card renders a dash with no error.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Team abbreviations and logo URLs

**Files:**
- Create: `apps/web/src/app/_components/teams.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `abbrev(id: number | null, name: string): string`
  - `logoUrl(id: number | null): string | null`

  Task 5's `GameCard` uses both.

- [ ] **Step 1: Confirm the ids against the live table**

Never trust a hardcoded id map without checking it. Run:

```bash
docker compose exec db psql -U mlb -d mlb_edge -c "SELECT id, name FROM teams ORDER BY id"
```

Expected: **37 rows**, not 30. Besides the 30 MLB clubs the table holds minor-league and exhibition opponents (`105 Sacramento River Cats`, `440 Springfield Cardinals`, `562 Sultanes de Monterrey`, `5434 Sugar Land Space Cowboys`), All-Star squads (`159`, `160`), and the demo sentinel `99999 DEMO Synthetic`. The fallback path in Step 2 is what serves those seven — it is load-bearing, not defensive padding.

Confirm every id in the Step 2 map appears in this output with the expected club name. `133` must read `Athletics` (the franchise dropped its city name); if it reads otherwise, correct the map.

- [ ] **Step 2: Write the module**

Create `apps/web/src/app/_components/teams.ts`:

```ts
// MLB team ids, verified against the `teams` table on 2026-09-14.
//
// Deliberately a frozen map rather than a `teams.abbrev` column: adding one
// would mean a migration, an ingest change, and a re-ingest to backfill 30 rows
// that have not changed in decades. If anything outside the web app ever needs
// abbreviations, promote it then.
//
// The table also holds minor-league, exhibition, All-Star, and demo-sentinel
// clubs (37 rows total), which is why `abbrev` must degrade rather than throw.
const TEAM_ABBREV: Record<number, string> = {
  108: 'LAA', 109: 'ARI', 110: 'BAL', 111: 'BOS', 112: 'CHC',
  113: 'CIN', 114: 'CLE', 115: 'COL', 116: 'DET', 117: 'HOU',
  118: 'KC',  119: 'LAD', 120: 'WSH', 121: 'NYM', 133: 'ATH',
  134: 'PIT', 135: 'SD',  136: 'SEA', 137: 'SF',  138: 'STL',
  139: 'TB',  140: 'TEX', 141: 'TOR', 142: 'MIN', 143: 'PHI',
  144: 'ATL', 145: 'CWS', 146: 'MIA', 147: 'NYY', 158: 'MIL',
};

// Falls back to the first three letters of the stored name, so an unmapped id
// still renders something truthful instead of a blank or a throw.
export function abbrev(id: number | null, name: string): string {
  if (id != null && TEAM_ABBREV[id]) return TEAM_ABBREV[id];
  return (name ?? '').trim().slice(0, 3).toUpperCase() || '???';
}

// Keyed by the same team id we already store, exactly as the image CDN in
// Headshot.tsx is keyed by person id. No ingest, no schema, no API key.
//
// Unlike the headshot CDN there is no default-image transform here, so an
// unknown id 404s. Callers render this as a CSS background-image, where a 404
// degrades to blank space rather than a broken-image icon.
export function logoUrl(id: number | null): string | null {
  return id == null ? null : `https://www.mlbstatic.com/team-logos/${id}.svg`;
}
```

- [ ] **Step 3: Verify the mapping against every team on the slate**

```bash
node -e "
const { getSlateGames, latestSlateDate } = require('./packages/db/dist/index.js');
const TEAM_ABBREV = {108:'LAA',109:'ARI',110:'BAL',111:'BOS',112:'CHC',113:'CIN',114:'CLE',115:'COL',116:'DET',117:'HOU',118:'KC',119:'LAD',120:'WSH',121:'NYM',133:'ATH',134:'PIT',135:'SD',136:'SEA',137:'SF',138:'STL',139:'TB',140:'TEX',141:'TOR',142:'MIN',143:'PHI',144:'ATL',145:'CWS',146:'MIA',147:'NYY',158:'MIL'};
const ab = (id, name) => (id != null && TEAM_ABBREV[id]) || (name||'').trim().slice(0,3).toUpperCase() || '???';
(async () => {
  const games = await getSlateGames(await latestSlateDate());
  for (const g of games) console.log(ab(g.awayId, g.away), '@', ab(g.homeId, g.home));
  const missed = games.flatMap(g => [[g.awayId,g.away],[g.homeId,g.home]]).filter(([id]) => id != null && !TEAM_ABBREV[id]);
  console.log('unmapped ids on this slate:', missed.length ? missed : 'none');
  process.exit(0);
})();
"
```

Expected: 15 lines of real matchups (`HOU @ TEX` etc.) and `unmapped ids on this slate: none`. If any id is unmapped, add it before continuing.

- [ ] **Step 4: Confirm a logo actually resolves**

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" https://www.mlbstatic.com/team-logos/117.svg
curl -s -o /dev/null -w "%{http_code}\n" https://www.mlbstatic.com/team-logos/99999.svg
```

Expected: `200 image/svg+xml` for the Astros, and a non-200 for the demo sentinel. The second result is the case the background-image approach absorbs.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add apps/web/src/app/_components/teams.ts
git commit -m "Add team abbreviations and logo URLs

A frozen 30-entry map rather than a teams.abbrev column: the ids have not
changed in decades and a column would cost a migration, an ingest change,
and a re-ingest. Verified against the live teams table, which holds 37
rows -- minor-league, All-Star, and demo-sentinel clubs included -- so the
name-prefix fallback is load-bearing rather than defensive.

Logos reuse the same id against MLB's logo CDN, the same trick Headshot.tsx
uses for person ids.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Palette and condensed font

**Files:**
- Modify: `apps/web/src/app/layout.tsx`
- Modify: `apps/web/src/app/globals.css:1-12` (the `:root` block) and the `body` rule

**Interfaces:**
- Consumes: nothing
- Produces: CSS custom properties `--navy`, `--navy-ink`, `--red`, `--paper`, `--panel`, `--stripe`, `--ink`, `--muted`, `--faint`, `--hair`, `--grid`, `--good`, `--bad`, `--ref`, and `--font-condensed`. Every later task uses these names.

- [ ] **Step 1: Read the Next font docs**

Required by `apps/web/AGENTS.md` — this Next version may differ from training data:

```bash
sed -n '1,140p' node_modules/next/dist/docs/01-app/03-api-reference/02-components/font.md
grep -n -A12 '### `variable`' node_modules/next/dist/docs/01-app/03-api-reference/02-components/font.md
```

Confirm `variable` declares a CSS custom property and that applying `.variable` to `<html>` is the documented pattern.

- [ ] **Step 2: Load the font**

Replace `apps/web/src/app/layout.tsx` entirely:

```tsx
import type { Metadata } from 'next';
import { Barlow_Condensed } from 'next/font/google';
import './globals.css';

// Barlow Condensed has no variable axis, so weights are enumerated. Only the
// three actually used are requested: 500 for table headers and eyebrows, 600
// for section headings, 700 for the wordmark and team abbreviations.
const condensed = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-condensed',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'mlb-edge — model readout',
  description: 'Calibration and closing-line value for the prop model.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={condensed.variable}>
      <body>{children}</body>
    </html>
  );
}
```

Note `condensed.variable` (not `.className`) is applied — that declares the custom property without imposing the font on body text, which must stay in the system stack for numeral legibility.

- [ ] **Step 3: Replace the token block**

In `apps/web/src/app/globals.css`, replace lines 1-12 (the whole `:root` block) with:

```css
:root {
  /* --- chrome. Never used to encode a data value. --- */
  --navy: #041E42;
  --navy-ink: #0a2d5e;
  --red: #BF0D3E;

  /* --- surfaces --- */
  --paper: #f4f6f8;
  --panel: #ffffff;
  --stripe: #f7f9fa;

  /* --- text ramp --- */
  --ink: #10161d;
  --muted: #5c6773;
  --faint: #8a95a1;

  /* --- rules --- */
  --hair: #dce2e8;
  --grid: #e8edf1;

  /* --- semantic. Calibration only: these make a claim the backtest earned.
         Deliberately NOT unified with --red, which is decoration. --- */
  --good: #0f766e;
  --bad:  #b23a48;
  --ref:  #aab4bf;
}

/* Applied with text-transform, never by uppercasing source strings, so
   assistive tech still reads the original casing. */
.cnd {
  font-family: var(--font-condensed), ui-sans-serif, system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
}
```

`--good`, `--bad`, `--ref`, `--grid`, `--faint`, `--muted` keep their exact previous values so `ReliabilityPlot.tsx` renders identically with no change to it.

- [ ] **Step 4: Verify the font loads and the page still renders**

With `npm run web:dev` running, load `http://localhost:3000` and check:
- The page background is very slightly cooler/lighter than before (`#f4f6f8` vs `#f3f5f7`) — a near-invisible change at this stage. Nothing else should look different yet.
- DevTools → Network → filter `font`: a Barlow Condensed `woff2` is served **from localhost**, not from `fonts.gstatic.com`. `next/font` self-hosts; a request to Google means the setup is wrong.
- DevTools → Elements → `<html>`: carries a generated class, and `getComputedStyle(document.documentElement).getPropertyValue('--font-condensed')` in the console returns a font name.

- [ ] **Step 5: Typecheck, build, and confirm parity**

```bash
npm run typecheck
npm run web:build
node apps/web/scripts/figure-parity.mjs > /tmp/parity/after.txt
diff /tmp/parity/baseline.txt /tmp/parity/after.txt && echo "PARITY OK"
```

Expected: all three pass, `PARITY OK`. `web:build` is run here specifically because this is the task that introduces the build-time font fetch — if the environment is offline it fails here, not three tasks later.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/layout.tsx apps/web/src/app/globals.css
git commit -m "Add the MLB palette and condensed font

Navy and red enter as chrome tokens only. The calibration colors keep
their exact previous values, both so ReliabilityPlot renders identically
without touching it and so --bad stays distinct from --red: one is a claim
about miscalibration, the other is decoration, and collapsing them would
let chrome read as data.

The font is applied via .variable rather than .className so body text and
figures stay in the system stack, where the numerals are more legible.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The scoreboard strip

**Files:**
- Create: `apps/web/src/app/_components/GameCard.tsx`
- Modify: `apps/web/src/app/page.tsx` (Slate section, lines 102-109)
- Modify: `apps/web/src/app/globals.css` (append)

**Interfaces:**
- Consumes: `SlateGame.startTime` (Task 2), `abbrev` / `logoUrl` (Task 3), `--navy` / `--hair` / `--faint` / `--panel` (Task 4)
- Produces: `<GameCard game={SlateGame} listedEdges={number} />`

**This task changes the baseline** — it adds first-pitch times, which are new numbers on the page. Step 6 re-baselines.

- [ ] **Step 1: Write the card**

Create `apps/web/src/app/_components/GameCard.tsx`:

```tsx
import type { SlateGame } from '@mlb-edge/db';
import { abbrev, logoUrl } from './teams';

// Pinned to ET rather than rendered "local". These pages are force-dynamic
// server renders, so an unpinned local time would silently mean the *server's*
// zone, and a client-side conversion would trade a cosmetic detail for a
// hydration mismatch. ET is also how MLB.com labels start times.
const TIME = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/New_York',
});

function firstPitch(startTime: Date | null): string {
  return startTime ? `${TIME.format(startTime)} ET` : '—';
}

function TeamLine({ id, name }: { id: number | null; name: string }) {
  const logo = logoUrl(id);
  return (
    <div className="gc-team">
      {/* A background-image, not an <img>: the logo CDN has no default-image
          transform, so an unknown id 404s. This degrades to blank space
          instead of a broken-image icon, and the abbreviation beside it
          carries the identity regardless. */}
      <span
        className="gc-logo"
        style={logo ? { backgroundImage: `url(${logo})` } : undefined}
        aria-hidden="true"
      />
      <span className="gc-abbr cnd">{abbrev(id, name)}</span>
    </div>
  );
}

export function GameCard({ game, listedEdges }: { game: SlateGame; listedEdges: number }) {
  return (
    <article className="gamecard">
      <TeamLine id={game.awayId} name={game.away} />
      <TeamLine id={game.homeId} name={game.home} />
      <div className="gc-meta num">{firstPitch(game.startTime)}</div>
      <div className="gc-edges">{listedEdges > 0 ? `${listedEdges} listed` : '—'}</div>
    </article>
  );
}
```

`listedEdges` is named for what it counts. See "Deviation from the spec" above: `getTopEdges` is capped at 25, so this is a count of listed picks, not of all edges on the game.

- [ ] **Step 2: Render the strip**

In `apps/web/src/app/page.tsx`, add to the imports:

```tsx
import { GameCard } from './_components/GameCard';
```

Then replace the Slate section's game listing (lines 105-109) — the ternary rendering `No projected games` / the `{d.games.length} game(s): …` paragraph — with:

```tsx
              {d.games.length === 0 ? (
                <p className="cap">No projected games. Run <code style={{ display: 'inline' }}>project --date {d.slateDate}</code>.</p>
              ) : (
                <>
                  <div className="slate-strip">
                    {d.games.map((g) => (
                      <GameCard key={g.gameId} game={g} listedEdges={listedByGame.get(g.gameId) ?? 0} />
                    ))}
                  </div>
                  <p className="cap">
                    {d.games.length} game(s). &ldquo;Listed&rdquo; counts this
                    game&apos;s picks in the table below, which shows only the
                    highest-edge {d.edges.length} of the slate — not every edge
                    on the game.
                  </p>
                </>
              )}
```

Directly above the `return` in the `Page` component's `d.ok` branch — or immediately before the Slate `<section>` — add the grouping, which reuses already-loaded data rather than adding a query:

```tsx
  const listedByGame = new Map<number, number>();
  if (d.ok) for (const e of d.edges) listedByGame.set(e.gameId, (listedByGame.get(e.gameId) ?? 0) + 1);
```

Place this after `const d = await load();` and before the `return`.

- [ ] **Step 3: Style the strip**

Append to `apps/web/src/app/globals.css`:

```css
/* ---- scoreboard strip ---- */
.slate-strip {
  display: flex;
  gap: 0.75rem;
  overflow-x: auto;
  padding: 0.25rem 0 1rem;
  /* The strip scrolls in its own container; the page body must never scroll
     sideways. */
  scrollbar-width: thin;
}
.gamecard {
  flex: 0 0 auto;
  min-width: 8.5rem;
  background: var(--panel);
  border: 1px solid var(--hair);
  border-top: 3px solid var(--navy);
  border-radius: 3px;
  padding: 0.7rem 0.85rem;
}
.gc-team { display: flex; align-items: center; gap: 0.5rem; padding: 0.15rem 0; }
.gc-logo {
  flex: none;
  width: 22px;
  height: 22px;
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
}
.gc-abbr { font-size: 1.05rem; font-weight: 700; color: var(--ink); letter-spacing: 0.04em; }
.gc-meta {
  margin-top: 0.45rem;
  padding-top: 0.4rem;
  border-top: 1px solid var(--grid);
  color: var(--muted);
  font-size: 0.8rem;
}
.gc-edges { color: var(--faint); font-size: 0.78rem; }
```

- [ ] **Step 4: Verify visually**

Load `http://localhost:3000` and confirm:
- 15 cards in a horizontal strip, **ordered by first pitch**, not game id.
- Logos render for every card.
- Times read like `7:05 PM ET`. The one game with a null `start_time` (confirmed to exist in Task 2, Step 5) shows `—`.
- The page body does not scroll horizontally at 375px width (DevTools device toolbar). The strip scrolls; the page does not.

- [ ] **Step 5: Typecheck and review the parity diff**

```bash
npm run typecheck
node apps/web/scripts/figure-parity.mjs > /tmp/parity/after.txt
diff /tmp/parity/baseline.txt /tmp/parity/after.txt
```

Expected: a diff containing **only added lines** — the new first-pitch times and listed-edge counts. **Inspect it line by line.** Any *removed* or *modified* line is a real regression: it means an existing figure moved, which this task has no business doing.

- [ ] **Step 6: Re-baseline and commit**

```bash
cp /tmp/parity/after.txt /tmp/parity/baseline.txt
git add apps/web/src/app/_components/GameCard.tsx apps/web/src/app/page.tsx apps/web/src/app/globals.css
git commit -m "Replace the matchup sentence with a scoreboard strip

Team logos come from MLB's CDN keyed by the team id already on SlateGame,
so this needs no ingest and no schema change. They are background images
rather than <img> because that CDN has no default-image transform: an
unknown id 404s, and a background degrades to blank space while the
abbreviation beside it still carries the identity.

The per-game count is labelled 'listed', not 'edges'. getTopEdges is
capped at 25, so a game showing '4' has four picks in the table below --
not four edges. Calling it 'edges' would have been false.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Masthead and section chrome

**Files:**
- Modify: `apps/web/src/app/page.tsx` (masthead + section headings)
- Modify: `apps/web/src/app/player/page.tsx` (masthead)
- Modify: `apps/web/src/app/globals.css` (append)

**Interfaces:**
- Consumes: `--navy`, `--red`, `--panel`, `--stripe`, `.cnd` (Task 4)
- Produces: `.masthead` (navy bar), `.eyebrow` (section heading treatment), restyled `table`, `.notice`, `.scorecard`

- [ ] **Step 1: Style the chrome**

Append to `apps/web/src/app/globals.css`:

```css
/* ---- masthead: full-bleed navy bar ---- */
.masthead {
  background: var(--navy);
  border-bottom: 3px solid var(--red);
  padding: 1.5rem 0 1.35rem;
  margin: -3.5rem 0 2rem;   /* cancels .wrap's top padding to reach the edges */
  padding-left: 1.5rem;
  padding-right: 1.5rem;
  margin-left: calc(50% - 50vw);
  margin-right: calc(50% - 50vw);
}
.masthead > * { max-width: 60rem; margin-inline: auto; }
.wordmark {
  font-family: var(--font-condensed), ui-sans-serif, system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 700;
  font-size: 1.6rem;
  color: #fff;
  margin: 0;
}
.wordmark span { color: #8fa6c4; font-weight: 500; }
.wordmark a { color: inherit; }
.purpose { margin: 0.4rem 0 0; color: #c3d0e0; font-size: 0.95rem; max-width: 46ch; }

/* ---- section eyebrows ---- */
.plot h2, .clv h2 {
  font-family: var(--font-condensed), ui-sans-serif, system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  font-weight: 600;
  font-size: 1.15rem;
  color: var(--navy);
  margin: 0 0 0.75rem;
  padding-bottom: 0.4rem;
  border-bottom: 2px solid var(--red);
}

/* ---- tables ---- */
table { background: var(--panel); border: 1px solid var(--hair); }
thead th {
  font-family: var(--font-condensed), ui-sans-serif, system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 500;   /* 500 is the table-header weight layout.tsx documents */
  font-size: 0.85rem;
  color: var(--muted);
  background: var(--stripe);
  position: sticky;
  top: 0;
}
tbody tr:nth-child(even) { background: var(--stripe); }

/* ---- cards ---- */
.plot-frame, .notice { border-radius: 3px; box-shadow: 0 1px 2px rgb(4 30 66 / 0.06); }
.scorecard { border-radius: 3px; overflow: hidden; box-shadow: 0 1px 2px rgb(4 30 66 / 0.06); }
.readout .label {
  font-family: var(--font-condensed), ui-sans-serif, system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
  font-size: 0.82rem;
}
.notice h2 {
  font-family: var(--font-condensed), ui-sans-serif, system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;   /* without this it falls back to browser bold, heavier
                         than the sibling .plot/.clv eyebrows it matches */
  color: var(--navy);
}
```

- [ ] **Step 2: Confirm the masthead copy is untouched**

Both mastheads keep their existing markup and text exactly. Verify no string changed:

```bash
git diff apps/web/src/app/page.tsx apps/web/src/app/player/page.tsx | grep '^[-+].*purpose' 
git diff apps/web/src/app/page.tsx | grep -c '^[-+]'
```

If either masthead's `<p className="purpose">` text appears as a changed line, revert that edit — the copy is frozen by the Global Constraints.

- [ ] **Step 3: Verify visually**

Load both `/` and `/player?id=500743&date=2026-09-13` (a real player on the current slate):
- Navy bar spans the full viewport width with no horizontal scrollbar at any width from 320px to 1600px.
- Section headings are navy condensed caps over a red rule.
- Table headers stick when a long table (the roster) scrolls.
- The reliability plot looks exactly as it did — same colors, same layout.

- [ ] **Step 4: Typecheck, build, parity**

```bash
npm run typecheck
npm run web:build
node apps/web/scripts/figure-parity.mjs > /tmp/parity/after.txt
diff /tmp/parity/baseline.txt /tmp/parity/after.txt && echo "PARITY OK"
```

Expected: `PARITY OK`. This task is pure CSS plus the full-bleed markup wrapper; any diff is a regression.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/globals.css apps/web/src/app/page.tsx apps/web/src/app/player/page.tsx
git commit -m "Style the masthead and section chrome

Navy full-bleed bar, condensed caps headings over a red rule, zebra tables
with sticky headers. Every explanatory string is unchanged: the copy
carries the project's epistemic position, and restyling it is in scope
while rewording it is not.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Player rows, and removing the green edge

**Files:**
- Modify: `apps/web/src/app/page.tsx:110-128` (edges table) and the `good` class at line 123
- Modify: `apps/web/src/app/_components/Headshot.tsx`
- Modify: `apps/web/src/app/_components/RosterSearch.tsx`
- Modify: `apps/web/src/app/globals.css` (append)

**Interfaces:**
- Consumes: `Headshot` (existing), `--navy`, `.cnd` (Task 4)
- Produces: `.prow` player row styling; `Headshot` gains lazy loading

This is the task that carries the design's central rule. Review it on that basis.

- [ ] **Step 1: Lazy-load headshots**

In `apps/web/src/app/_components/Headshot.tsx`, add to the `<img>`:

```tsx
      loading="lazy"
```

The existing `size` prop already drives the 2x request width, so 28px list use needs no other change. The roster renders hundreds of rows; without this, every headshot is fetched on load.

- [ ] **Step 2: Remove the green edge on the home page**

In `apps/web/src/app/page.tsx`, in the edges table, change line 123 from:

```tsx
                        <td className="num good">{signed(e.edgePct)}</td>
```

to:

```tsx
                        <td className="num">{signed(e.edgePct)}</td>
```

This is not cosmetic housekeeping. `--good` is reserved for calibration, where the backtest has earned a good/bad claim. An edge is a hypothesis the market has not yet been tested against, and green on it inside a broadcast-styled shell reads as an endorsement the model has not earned.

- [ ] **Step 3: Add headshots to the edges table**

In the same table body, replace the player cell:

```tsx
                        <td><Link href={`/player?id=${e.playerId}&date=${d.slateDate}`}>{e.playerName}</Link></td>
```

with:

```tsx
                        <td>
                          <Link className="prow" href={`/player?id=${e.playerId}&date=${d.slateDate}`}>
                            <Headshot playerId={e.playerId} size={28} />
                            <span>{e.playerName}</span>
                          </Link>
                        </td>
```

Add to the file's imports:

```tsx
import { Headshot } from './_components/Headshot';
```

- [ ] **Step 4: Add headshots and the navy dot to the roster**

In `apps/web/src/app/_components/RosterSearch.tsx`, replace the mapped `<Link>` body:

```tsx
            <Link key={r.playerId} href={`/player?id=${r.playerId}&date=${date}`} className="roster-row">
              <span className="rname">{r.playerName}{r.hasPick ? ' ●' : ''}</span>
              <span className="rmeta">{[r.matchup, r.props].filter(Boolean).join(' · ')}</span>
            </Link>
```

with:

```tsx
            <Link key={r.playerId} href={`/player?id=${r.playerId}&date=${date}`} className="roster-row">
              <span className="rname">
                <Headshot playerId={r.playerId} size={28} />
                {r.playerName}
                {r.hasPick ? <span className="pickdot" aria-label="flagged edge" /> : null}
              </span>
              <span className="rmeta">{[r.matchup, r.props].filter(Boolean).join(' · ')}</span>
            </Link>
```

Add to that file's imports:

```tsx
import { Headshot } from './Headshot';
```

Note the `●` character becomes a styled span with an `aria-label`, which is an accessibility improvement: the bare bullet previously read as punctuation.

`RosterSearch.tsx` is a `"use client"` file. `Headshot` is a plain component rendering an `<img>` with no server imports, so this is safe — but confirm it does not import `@mlb-edge/db`, which is server-only and in `serverExternalPackages`:

```bash
grep -n "import" apps/web/src/app/_components/Headshot.tsx
```

Expected: no `@mlb-edge/db` import. (The file has no imports at all.)

- [ ] **Step 5: Style the rows**

Append to `apps/web/src/app/globals.css`:

```css
/* ---- player rows ---- */
.prow { display: inline-flex; align-items: center; gap: 0.55rem; color: var(--ink); }
.prow:hover { text-decoration: none; color: var(--navy-ink); }
.prow .headshot { flex: none; }
.rname { display: flex; align-items: center; gap: 0.55rem; }
.pickdot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--navy);
  flex: none;
}
.roster-row { align-items: center; }
```

- [ ] **Step 6: Verify visually**

- Edges table rows show a 28px circular headshot beside each name.
- **No green anywhere in the Edge column**, on either page.
- Roster rows show headshots; flagged players show a small navy dot.
- DevTools → Network: headshot requests fire progressively as the roster scrolls, not all at once on load.

Count them from the server render with `grep -o … | wc -l`, never `grep -c`:
the SSR HTML is a single line, so `grep -c` reports `1` no matter how many
matches there are.

```bash
curl -s http://localhost:3000 | grep -o 'loading="lazy"' | wc -l
```

Expected: one per roster row plus one per edges row (532 on the 2026-09-13 slate).

- [ ] **Step 7: Typecheck and parity**

```bash
npm run typecheck
node apps/web/scripts/figure-parity.mjs > /tmp/parity/after.txt
diff /tmp/parity/baseline.txt /tmp/parity/after.txt && echo "PARITY OK"
```

Expected: `PARITY OK`. Headshot URLs contain digits but live in `src` attributes, which the harness strips with the tags — confirm the diff really is empty rather than assuming it.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/page.tsx apps/web/src/app/_components/Headshot.tsx apps/web/src/app/_components/RosterSearch.tsx apps/web/src/app/globals.css
git commit -m "Add headshots to player rows and drop the green edge

The green on edge_pct comes off. --good is reserved for calibration, where
the backtest earned the claim; an edge is a hypothesis the market has not
been tested against, and green on it inside a broadcast-styled shell reads
as an endorsement the model has not earned.

Headshots are lazy-loaded because the roster runs to hundreds of rows. The
pick bullet becomes a labelled span, so it no longer reads to a screen
reader as stray punctuation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The player page

**Files:**
- Modify: `apps/web/src/app/player/page.tsx` (player identity block; `good` class at line 71)
- Modify: `apps/web/src/app/globals.css` (append)

**Interfaces:**
- Consumes: `--navy`, `.cnd` (Task 4); `Headshot` (Task 7)
- Produces: nothing consumed downstream

- [ ] **Step 1: Remove the conditional green**

In `apps/web/src/app/player/page.tsx`, change line 71 from:

```tsx
                    <td className={`num ${r.edgePct != null && r.edgePct > 0 ? 'good' : ''}`}>{r.edgePct == null ? '—' : signed(r.edgePct)}</td>
```

to:

```tsx
                    <td className="num">{r.edgePct == null ? '—' : signed(r.edgePct)}</td>
```

Same reasoning as Task 7, Step 2.

- [ ] **Step 2: Enlarge the identity block**

Change:

```tsx
            <Headshot playerId={card.playerId} />
```

to:

```tsx
            <Headshot playerId={card.playerId} size={72} />
```

- [ ] **Step 3: Style it**

Append to `apps/web/src/app/globals.css`:

```css
/* ---- player identity ---- */
.player-id { gap: 1rem; padding-bottom: 1rem; border-bottom: 1px solid var(--hair); }
.player-id .headshot { box-shadow: 0 0 0 2px var(--navy); }
.player-id h2 {
  font-family: var(--font-condensed), ui-sans-serif, system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 700;
  font-size: 1.5rem;
  color: var(--navy);
  /* .clv h2 (section eyebrows) matches this heading too, at equal
     specificity. Source order is not enough: the cascade resolves
     per-property, so the eyebrow's border-bottom/padding-bottom would still
     apply to a rule that simply omits them, leaving the identity heading
     with both a red eyebrow rule AND .player-id's own hairline. */
  border-bottom: none;
  padding-bottom: 0;
}
```

The two explicit overrides above are load-bearing — dropping them reintroduces
the double rule. Source order decides only which value wins for a property
*both* rules set; it does nothing for a property only the earlier rule sets.

- [ ] **Step 4: Verify visually**

Load `/player?id=500743&date=2026-09-13`:
- 72px headshot with a navy ring, name in navy condensed caps, hairline beneath.
- Nine-column table has condensed caps headers and zebra rows.
- **No green in the Edge column.**
- The caption below the table is unchanged, word for word.

- [ ] **Step 5: Typecheck, build, parity**

```bash
npm run typecheck
npm run web:build
node apps/web/scripts/figure-parity.mjs > /tmp/parity/after.txt
diff /tmp/parity/baseline.txt /tmp/parity/after.txt && echo "PARITY OK"
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/player/page.tsx apps/web/src/app/globals.css
git commit -m "Style the player page to match

Larger ringed headshot, condensed navy identity, zebra table. The
conditional green on a positive edge comes off here for the same reason it
did on the home page.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Final verification

**Files:** none modified unless a check fails

- [ ] **Step 1: Full clean verification**

```bash
npm run build:db
npm run typecheck
npm run web:build
```

All three must pass.

- [ ] **Step 2: Final figure parity against the original baseline**

The per-task baselines drifted twice by design (Tasks 2 and 5). Prove the *only* differences across the whole branch are those intended additions:

```bash
node apps/web/scripts/figure-parity.mjs > /tmp/parity/final.txt
diff /tmp/parity/baseline.txt /tmp/parity/final.txt && echo "PARITY OK"
```

Expected: `PARITY OK` against the Task 5 re-baseline. Then sanity-check the whole-branch delta: every line in `final.txt` that is not a first-pitch time or a listed count must also appear in the Task 1 original.

- [ ] **Step 3: Confirm no green survives on any edge**

```bash
grep -n "good" apps/web/src/app/page.tsx apps/web/src/app/player/page.tsx
```

Expected: **no hits on any `edgePct` cell.** Hits on the scorecard's `ece` tone logic are correct and must remain — that one is calibration, where the color is earned.

- [ ] **Step 4: Contrast check**

```bash
node -e "
const lum = (h) => { const c = [1,3,5].map(i => parseInt(h.slice(i,i+2),16)/255).map(v => v<=0.03928 ? v/12.92 : ((v+0.055)/1.055)**2.4); return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]; };
const ratio = (a,b) => { const [x,y] = [lum(a),lum(b)].sort((m,n)=>n-m); return ((x+0.05)/(y+0.05)).toFixed(2); };
const pairs = [['#ffffff','#041E42','wordmark on navy'],['#c3d0e0','#041E42','purpose on navy'],['#8fa6c4','#041E42','wordmark span on navy'],['#10161d','#ffffff','ink on panel'],['#5c6773','#f7f9fa','muted on stripe'],['#041E42','#f4f6f8','navy heading on paper'],['#8a95a1','#ffffff','faint on panel']];
for (const [fg,bg,label] of pairs) console.log(ratio(fg,bg).padStart(6), label);
"
```

Expected: every pair at or above **4.5** for body text, **3.0** for large text (the wordmark at 1.6rem/700 and headings at 1.15rem/600 qualify as large). `--faint` on panel is used only for 11-12px axis labels and metadata — if it lands below 4.5, either darken `--faint` or confirm every use is non-essential decoration. Fix anything that fails before proceeding; do not wave it through.

- [ ] **Step 5: Responsive check**

In DevTools device toolbar at 320px, 375px, and 768px, on both pages:
- The page body never scrolls horizontally.
- The slate strip scrolls within itself.
- The navy masthead still reaches both edges with no gap.
- The scorecard collapses to one column (the existing `@media (max-width: 640px)` rule).

- [ ] **Step 6: Degradation checks**

The demo seed (2099-01-01) has **no projections**, so there is no demo player page to load — check the degradation paths directly instead.

Missing player, at `/player?id=1&date=2026-09-13`: the "Player not found" notice renders with its frozen copy, styled as a card, and the masthead above it is intact.

Generic headshot fallback:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  "https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_56,q_auto:best/v1/people/1/headshot/67/current"
```

Expected: `200` and an image content type — the CDN's default-image transform serving a silhouette for an id with no photo, rather than a 404. This is the behavior `Headshot.tsx` documents and depends on.

Database-unreachable notice:

```bash
docker compose stop db
# reload http://localhost:3000 -- the notice and its command block must render
docker compose start db
```

Confirm the notice copy and its `docker compose up -d / npm run db:migrate` block are byte-identical to before, now styled as a card.

- [ ] **Step 7: Final commit**

Never `git add -A` here. The working tree may hold unrelated uncommitted edits
that belong to the user, not to this branch — one such edit (an IDE-generated
JSDoc rewrite of `packages/pipeline/src/cli.ts`) was present during this plan's
execution. Stage only files this plan touched, by explicit path.

```bash
git status --porcelain   # confirm nothing unrelated is about to be staged
git commit -m "Verify the restyle changed no figures

Full typecheck, web build, figure parity, contrast, and responsive passes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" --allow-empty
```

---

## Out of scope

Carried from the spec, restated so no task quietly absorbs them:

- Persistent top nav and route splitting (`/model`, `/clv`, `/players`)
- Per-team color theming
- Dark mode
- Live scores or game status in the cards
- A team-abbreviation migration
