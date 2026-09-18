# Arsenal Matchup Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Versus pitch types — Not built" stub in the prop explorer with a table crossing the probable starter's arsenal against the selected batter's swing decisions on those same pitch types.

**Architecture:** One new read query over the existing `game_pitches` table (no migration), one new Wilson-interval helper in the shared `prob.ts`, and one new server-rendered React component. The panel is capped at the selected game's date and deliberately ignores the page's Window/Venue/Hand filters, because a 15-game window leaves ~12 swings per secondary pitch.

**Tech Stack:** TypeScript, Postgres (`pg`), Next.js 16 App Router (server components only), vitest (introduced by Task 1).

**Spec:** `docs/superpowers/specs/2026-09-18-arsenal-matchup-panel-design.md`

## Global Constraints

Every task's requirements implicitly include these.

- **`@mlb-edge/db` runs from compiled `dist/`, not source.** After ANY edit under `packages/db/`, run `npm run build:db` or the change is invisible at runtime. Verify with `grep <symbol> packages/db/dist/*.js`.
- **No migration in this plan.** `game_pitches` already has every column needed. Do not write one.
- **No colour on any figure in this panel.** CLAUDE.md permits `--good`/`--bad` only on settled facts where colour is redundant against another visual channel. A table has no such channel. Chrome only (`--navy`/`--red` are chrome; edge/CLV/residual figures get no colour at all).
- **Never import `@mlb-edge/db` from a `"use client"` file.** `pg` is server-only. Every component in this plan is a server component with no `"use client"` directive.
- **All pitch data is capped at the selected game's date** (`g.game_date < $asOf`), never at today. The explorer browses past slates.
- **`MODEL_VERSION` is not bumped.** Nothing in this plan touches the model; the panel is display-only and no projector reads it.
- Comment style: this codebase explains *why*, not *what*, and documents rejected alternatives inline. Match it.

---

### Task 1: Wilson intervals in `prob.ts`, with vitest

Introduces the repo's first test framework, scoped deliberately to one pure function. No DB, no fixtures, no async.

**Files:**
- Modify: `packages/db/package.json`
- Create: `packages/db/vitest.config.ts`
- Create: `packages/db/src/prob.test.ts`
- Modify: `packages/db/src/prob.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `package.json` (root)

**Interfaces:**
- Consumes: nothing.
- Produces: `wilson(x: number, n: number, z?: number): { lo: number; hi: number }`, exported from `@mlb-edge/db`. Returns proportions in `0..1`, not percentages. Tasks 3 and 4 depend on it.

- [ ] **Step 1: Add vitest to the db package**

In `packages/db/package.json`, add to `devDependencies`:

```json
"vitest": "^2.1.0"
```

and add to `scripts`:

```json
"test": "vitest run"
```

Then in the **root** `package.json`, add to `scripts`:

```json
"test": "npm run -w @mlb-edge/db test"
```

Install:

```bash
npm install
```

Note: root `postinstall` runs `npm run build:db`, so this also rebuilds `dist/`.

- [ ] **Step 2: Add the vitest config**

Create `packages/db/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

// Scoped to src/. The package compiles to dist/ and vitest would otherwise
// collect the emitted copy of every test as well, running each one twice.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Write the failing test**

Create `packages/db/src/prob.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { wilson } from './prob.js';

// Reference values are the standard published Wilson score intervals at 95%,
// not values read back off this implementation. A test that asserts whatever
// the code already returns proves only that the code is deterministic.
describe('wilson', () => {
  it('matches published 95% intervals at n=10', () => {
    // 0/10 -> (0.0000, 0.2775)
    const zero = wilson(0, 10);
    expect(zero.lo).toBeCloseTo(0, 4);
    expect(zero.hi).toBeCloseTo(0.2775, 3);

    // 5/10 -> (0.2366, 0.7634)
    const half = wilson(5, 10);
    expect(half.lo).toBeCloseTo(0.2366, 3);
    expect(half.hi).toBeCloseTo(0.7634, 3);

    // 10/10 -> (0.7225, 1.0000)
    const all = wilson(10, 10);
    expect(all.lo).toBeCloseTo(0.7225, 3);
    expect(all.hi).toBeCloseTo(1, 4);
  });

  it('clamps to [0, 1]', () => {
    // The raw score interval can exceed the unit interval at extreme p; a
    // displayed "hi = 1.03" would be nonsense in a percentage column.
    for (const [x, n] of [[0, 3], [3, 3], [1, 200], [199, 200]] as const) {
      const ci = wilson(x, n);
      expect(ci.lo).toBeGreaterThanOrEqual(0);
      expect(ci.hi).toBeLessThanOrEqual(1);
    }
  });

  it('is asymmetric about the point estimate at small n', () => {
    // This is the whole reason the panel renders explicit bounds rather than
    // "p +/- h". At n=44, p=0.227 the two sides differ by ~4.4 points.
    const n = 44, x = 10;
    const p = x / n;
    const ci = wilson(x, n);
    const down = p - ci.lo;
    const up = ci.hi - p;
    expect(up - down).toBeGreaterThan(0.03);
  });

  it('returns the full interval for an empty sample', () => {
    // n=0 must not produce NaN: the panel renders a row for a pitch the batter
    // has never swung at, and NaN would reach the DOM.
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });

  it('narrows as n grows', () => {
    const small = wilson(25, 50);
    const large = wilson(250, 500);
    expect(large.hi - large.lo).toBeLessThan(small.hi - small.lo);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
npm run -w @mlb-edge/db test
```

Expected: FAIL — `"wilson" is not exported by "src/prob.ts"`.

- [ ] **Step 5: Implement `wilson`**

Append to `packages/db/src/prob.ts`:

```ts
// Wilson score interval for a binomial proportion.
//
// Not the normal (Wald) interval, which is the one everybody reaches for and
// is wrong exactly where this project needs it: at small n and at p near 0
// or 1 it produces bounds outside [0, 1] and a zero-width interval for x=0.
// The pitch-type panel's whole purpose is to be honest about thin samples --
// a splitter row with 11 swings -- so the interval has to behave there.
//
// Deliberately asymmetric about x/n. Callers render explicit bounds rather
// than "p +/- h"; at n=44, p=0.23 the sides differ by ~4 points, which is too
// much to paper over with a single number.
export function wilson(x: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  // Clamped: the score interval can still cross 0 or 1 at extreme p, and a
  // percentage column showing 103% is worse than a slightly conservative bound.
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}
```

- [ ] **Step 6: Export it**

In `packages/db/src/index.ts`, extend the existing `prob.js` export block:

```ts
export {
  normalCdf, pOver, pOverFromPmf, americanToImplied, deVig,
  americanToProfit, evPerUnit, wilson,
} from './prob.js';
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm run -w @mlb-edge/db test
```

Expected: PASS, 5 tests.

- [ ] **Step 8: Build and verify the symbol reached `dist/`**

```bash
npm run build:db
grep -c 'function wilson' packages/db/dist/prob.js
```

Expected: `1`. If `0`, the build did not run — nothing downstream will work.

- [ ] **Step 9: Commit**

```bash
git add packages/db/package.json packages/db/vitest.config.ts \
        packages/db/src/prob.test.ts packages/db/src/prob.ts \
        packages/db/src/index.ts package.json package-lock.json
git commit -m "Add Wilson score interval to prob.ts, with vitest

First tests in the repo, scoped to one pure function. Wilson rather than Wald
because the pitch-type panel exists to be honest about thin samples, and Wald
returns bounds outside [0,1] and a zero-width interval at x=0."
```

---

### Task 2: Fix the platoon lookahead leak

Standalone and independently reviewable: it changes an existing rendered figure and nothing else. Doing it before the new panel means parity in Task 6 sees one data-moving change, not two tangled ones.

**Files:**
- Modify: `packages/db/src/queries/explorer.ts:525–536` (the `games` lookup inside `getMatchupContext`)
- Modify: `packages/db/src/queries/explorer.ts:575–581` (the platoon query)

**Interfaces:**
- Consumes: nothing.
- Produces: no signature change. `getMatchupContext(gameId, playerId)` keeps its shape; `MatchupContext.vsHand` values change on past slates.

- [ ] **Step 1: Select the game date alongside the rest of the game row**

In `getMatchupContext`, the first query already reads `games`. Extend it — the date is free here, and threading a new parameter through the function signature would be a worse fix for the same result.

Replace:

```ts
  const g = (
    await query<{
      home_team_id: number | null; away_team_id: number | null;
      venue_name: string | null;
      condition: string | null; temp_f: string | null; wind: string | null;
    }>(
      `SELECT g.home_team_id, g.away_team_id, g.venue_name, c.condition, c.temp_f, c.wind
       FROM games g LEFT JOIN game_conditions c ON c.game_id = g.id
       WHERE g.id = $1`,
      [gameId],
    )
  ).rows[0];
```

with:

```ts
  const g = (
    await query<{
      home_team_id: number | null; away_team_id: number | null;
      venue_name: string | null; game_date: string;
      condition: string | null; temp_f: string | null; wind: string | null;
    }>(
      // game_date is read here purely to cap the platoon split below. It is
      // free on a row already being fetched, and taking it this way keeps
      // getMatchupContext's signature at (gameId, playerId) -- every caller
      // already has the game id, and none of them should have to know that
      // one sub-query needs a lookahead guard.
      `SELECT g.home_team_id, g.away_team_id, g.venue_name, g.game_date,
              c.condition, c.temp_f, c.wind
       FROM games g LEFT JOIN game_conditions c ON c.game_id = g.id
       WHERE g.id = $1`,
      [gameId],
    )
  ).rows[0];
```

- [ ] **Step 2: Cap the platoon split at that date**

Replace:

```ts
      `SELECT sum(pa) AS pa,
              sum(singles + doubles + triples + hr) AS hits,
              sum(hr) AS hr,
              sum(so) AS so,
              sum(singles + 2*doubles + 3*triples + 4*hr) AS tb
       FROM player_game_platoon
       WHERE player_id = $1 AND pitch_hand = $2`,
      [playerId, hand],
```

with:

```ts
      // Capped at the selected game's date. Without this the explorer shows a
      // batter's FULL-SEASON platoon line while displaying a game from April --
      // the panel would be reporting PAs that had not happened yet. Same guard
      // the projection history queries carry (game_date < target), and the
      // arsenal panel directly below this one is capped the same way; two
      // adjacent panels disagreeing about what "to date" means is the bug.
      `SELECT sum(pl.pa) AS pa,
              sum(pl.singles + pl.doubles + pl.triples + pl.hr) AS hits,
              sum(pl.hr) AS hr,
              sum(pl.so) AS so,
              sum(pl.singles + 2*pl.doubles + 3*pl.triples + 4*pl.hr) AS tb
       FROM player_game_platoon pl
       JOIN games g2 ON g2.id = pl.game_id
       WHERE pl.player_id = $1 AND pl.pitch_hand = $2 AND g2.game_date < $3`,
      [playerId, hand, g.game_date],
```

Note every column is now qualified (`pl.`) — the join makes bare `hr` ambiguous otherwise.

- [ ] **Step 3: Build**

```bash
npm run build:db
```

- [ ] **Step 4: Verify the guard actually bites**

Pick a batter and an early-season game, and confirm the capped sum is strictly smaller than the uncapped one:

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -c "
WITH pick AS (
  SELECT pl.player_id, pl.pitch_hand, min(g.game_date) AS early
  FROM player_game_platoon pl JOIN games g ON g.id = pl.game_id
  GROUP BY 1,2 HAVING sum(pl.pa) > 200 LIMIT 1
)
SELECT (SELECT sum(pa) FROM player_game_platoon pl, pick
        WHERE pl.player_id = pick.player_id AND pl.pitch_hand = pick.pitch_hand) AS uncapped,
       (SELECT sum(pl.pa) FROM player_game_platoon pl
          JOIN games g ON g.id = pl.game_id, pick
        WHERE pl.player_id = pick.player_id AND pl.pitch_hand = pick.pitch_hand
          AND g.game_date < pick.early + 30) AS capped_30d;"
```

Expected: `capped_30d` is non-null and strictly less than `uncapped`. If they are equal, the join or the predicate is wrong.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/queries/explorer.ts
git commit -m "Cap the matchup platoon split at the selected game's date

getMatchupContext summed player_game_platoon career-to-date with no date
filter, so browsing a past slate showed a batter's full-season vs-hand line
including games that had not been played yet. Same lookahead guard the
projection history queries already carry.

Changes rendered figures on past slates -- intentional, see parity notes in
docs/superpowers/plans/2026-09-18-arsenal-matchup-panel.md."
```

---

### Task 3: The `getArsenalMatchup` query

**Files:**
- Modify: `packages/db/src/queries/explorer.ts` (append after `getMatchupContext`)
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: `wilson` from Task 1.
- Produces:

```ts
export interface ArsenalRow {
  pitchType: string;
  usage: number;
  velo: number | null;
  pWhiffPct: number | null;
  pSwings: number;
  bSwings: number;
  bWhiffPct: number | null;
  bWhiffLo: number | null;
  bWhiffHi: number | null;
  bOutZone: number;
  bChasePct: number | null;
  bChaseLo: number | null;
  bChaseHi: number | null;
}

export interface ArsenalMatchup {
  rows: ArsenalRow[];
  /** Pitch types this starter throws below the 5% cut, over the same window.
   *  Counted here rather than re-queried by the caller: it comes free from the
   *  rows already fetched, and a second round trip for one integer would be
   *  able to disagree with the table it annotates. */
  hiddenTypes: number;
}

export async function getArsenalMatchup(
  batterId: number | null,
  pitcherId: number,
  asOf: string,
): Promise<ArsenalMatchup>
```

Task 4 renders `ArsenalRow[]`; Task 5 calls the function and reads both fields.

- [ ] **Step 1: Sanity-check the SQL against real data first**

Before writing TypeScript, confirm the shape returns sensible rows. Pick the most-used pitcher and run the query body directly:

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -c "
WITH pk AS (SELECT pitcher_id FROM game_pitches GROUP BY 1 ORDER BY count(*) DESC LIMIT 1),
pitcher AS (
  SELECT p.pitch_type, count(*) AS n, avg(p.start_speed) AS velo,
         count(*) FILTER (WHERE p.is_swing) AS swings,
         count(*) FILTER (WHERE p.is_whiff) AS whiffs
  FROM game_pitches p JOIN games g ON g.id = p.game_id, pk
  WHERE p.pitcher_id = pk.pitcher_id AND p.pitch_type IS NOT NULL
    AND g.game_date < '2026-09-18'
  GROUP BY 1),
ptot AS (SELECT sum(n) AS n FROM pitcher)
SELECT pi.pitch_type,
       round(100.0 * pi.n / pt.n, 1) AS use_pct,
       round(pi.velo, 1) AS velo,
       pi.swings,
       round(100.0 * pi.whiffs / NULLIF(pi.swings, 0), 1) AS whiff_pct
FROM pitcher pi CROSS JOIN ptot pt
WHERE pi.n::numeric / pt.n >= 0.05
ORDER BY pi.n DESC;"
```

Expected: 3–7 rows, `use_pct` summing to somewhat under 100 (sub-5% types excluded), velocities in a plausible 70–100 mph band, whiff rates roughly 5–40%. This is also the spot-check the spec asks for — note which pitch sorts first.

- [ ] **Step 2: Add the interface and query**

Append to `packages/db/src/queries/explorer.ts`. Add `wilson` to the file's existing imports from `../prob.js` (create the import if the file has none).

```ts
/** One pitch type in a starter's arsenal, crossed with how the selected batter
 *  has handled that pitch. Percentages are proportions in 0..1, not points. */
export interface ArsenalRow {
  pitchType: string;
  /** Share of this pitcher's pitches, over non-null pitch_type only. */
  usage: number;
  velo: number | null;
  /** His whiffs over swings he induced, against ALL batters. */
  pWhiffPct: number | null;
  /** Denominator behind pWhiffPct. Not rendered as a column, but a starter
   *  with too few induced swings needs his cell suppressed like the batter's. */
  pSwings: number;
  bSwings: number;
  bWhiffPct: number | null;
  bWhiffLo: number | null;
  bWhiffHi: number | null;
  /** Pitches seen outside the zone -- the chase denominator. */
  bOutZone: number;
  bChasePct: number | null;
  bChaseLo: number | null;
  bChaseHi: number | null;
}

/** The rows at or above the 5% usage cut, plus a count of those below it. */
export interface ArsenalMatchup {
  rows: ArsenalRow[];
  hiddenTypes: number;
}

// The probable starter's arsenal, crossed with the batter's swing decisions
// against those same pitch types.
//
// Three things this deliberately does NOT do, each measured rather than
// assumed (see the spec for the numbers):
//   - It does not split the batter's half by pitcher hand. That halves n --
//     157 slider swings become 82/75 for the busiest batter in the database --
//     and the PA-level vs-hand table directly above the panel already carries
//     handedness.
//   - It does not report batted-ball quality per pitch type. 46 balls in play
//     is the SECOND-BEST pitch for the most-pitched-to hitter in the league;
//     exit velocity split this way is noise for everyone.
//   - It does not honour the page's Window filter. At `last 15` the same
//     batter has 12 slider swings.
//
// `batterId` may be null, for a selected player who is himself the pitcher.
// `p.batter_id = NULL` matches no rows, so the batter half comes back empty
// and every batter column is a zero -- the caller decides how to present that.
export async function getArsenalMatchup(
  batterId: number | null,
  pitcherId: number,
  asOf: string,
): Promise<ArsenalMatchup> {
  const res = await query<{
    pitch_type: string; usage: string; velo: string | null;
    p_swings: string; p_whiffs: string;
    b_swings: string; b_whiffs: string; b_out_zone: string; b_chases: string;
  }>(
    // `pitch_type IS NOT NULL` also disposes of every null `in_zone` and
    // `start_speed` in the table -- all 689 such rows are the same rows.
    // `in_zone IS FALSE` rather than `NOT in_zone`: the column is nullable,
    // and `NOT NULL` is NULL, which a FILTER clause drops silently.
    `WITH pitcher AS (
       SELECT p.pitch_type,
              count(*)                           AS n,
              avg(p.start_speed)                 AS velo,
              count(*) FILTER (WHERE p.is_swing) AS swings,
              count(*) FILTER (WHERE p.is_whiff) AS whiffs
       FROM game_pitches p
       JOIN games g ON g.id = p.game_id
       WHERE p.pitcher_id = $2 AND p.pitch_type IS NOT NULL AND g.game_date < $3
       GROUP BY p.pitch_type
     ),
     ptot AS (SELECT sum(n) AS n FROM pitcher),
     batter AS (
       SELECT p.pitch_type,
              count(*) FILTER (WHERE p.is_swing)                        AS swings,
              count(*) FILTER (WHERE p.is_whiff)                        AS whiffs,
              count(*) FILTER (WHERE p.in_zone IS FALSE)                AS out_zone,
              count(*) FILTER (WHERE p.in_zone IS FALSE AND p.is_swing) AS chases
       FROM game_pitches p
       JOIN games g ON g.id = p.game_id
       WHERE p.batter_id = $1 AND p.pitch_type IS NOT NULL AND g.game_date < $3
       GROUP BY p.pitch_type
     )
     SELECT pi.pitch_type,
            pi.n::numeric / NULLIF(pt.n, 0) AS usage,
            pi.velo,
            pi.swings                  AS p_swings,
            pi.whiffs                  AS p_whiffs,
            COALESCE(b.swings, 0)      AS b_swings,
            COALESCE(b.whiffs, 0)      AS b_whiffs,
            COALESCE(b.out_zone, 0)    AS b_out_zone,
            COALESCE(b.chases, 0)      AS b_chases
     FROM pitcher pi
     CROSS JOIN ptot pt
     LEFT JOIN batter b ON b.pitch_type = pi.pitch_type
     ORDER BY pi.n DESC`,
    [batterId, pitcherId, asOf],
  );

  // Every type comes back and the 5% cut is applied here, not in SQL, so the
  // "not shown" count and the rows above it are derived from one result set
  // and cannot drift apart. The cut is over this same asOf-capped season
  // rather than his career: an arsenal that changed mid-season should read as
  // it stands on the day.
  const all = res.rows.map((r) => {
    const pSwings = Number(r.p_swings);
    const bSwings = Number(r.b_swings);
    const bWhiffs = Number(r.b_whiffs);
    const bOutZone = Number(r.b_out_zone);
    const bChases = Number(r.b_chases);
    const whiffCi = bSwings > 0 ? wilson(bWhiffs, bSwings) : null;
    const chaseCi = bOutZone > 0 ? wilson(bChases, bOutZone) : null;
    return {
      pitchType: r.pitch_type,
      usage: Number(r.usage),
      velo: r.velo == null ? null : Number(r.velo),
      pWhiffPct: pSwings > 0 ? Number(r.p_whiffs) / pSwings : null,
      pSwings,
      bSwings,
      bWhiffPct: bSwings > 0 ? bWhiffs / bSwings : null,
      bWhiffLo: whiffCi?.lo ?? null,
      bWhiffHi: whiffCi?.hi ?? null,
      bOutZone,
      bChasePct: bOutZone > 0 ? bChases / bOutZone : null,
      bChaseLo: chaseCi?.lo ?? null,
      bChaseHi: chaseCi?.hi ?? null,
    };
  });

  const rows = all.filter((r) => r.usage >= 0.05);
  return { rows, hiddenTypes: all.length - rows.length };
}
```

- [ ] **Step 3: Export it**

In `packages/db/src/index.ts`, extend the existing `queries/explorer.js` export block:

```ts
export {
  getGamePlayers, getPropHistory, getPropReference, getMatchupContext, totalsFrom,
  PITCHER_PROPS, getPlayerRoles, getSlatePlayerIndex, getOppPitcherProfile, getGameLines,
  getArsenalMatchup,
  type OppPitcherProfile, type GameLines, type ArsenalRow, type ArsenalMatchup,
  type SlateSearchHit,
  type PlayerTotals,
  type PropHistoryFilters,
} from './queries/explorer.js';
```

- [ ] **Step 4: Build and verify**

```bash
npm run build:db
grep -c 'getArsenalMatchup' packages/db/dist/queries/explorer.js
```

Expected: at least `1`.

- [ ] **Step 5: Exercise it end to end**

Create `/private/tmp/claude-501/-Users-sam-Projects-mlb-edge/a3f25d61-599b-4546-8274-fdd530db6e81/scratchpad/arsenal-check.ts`:

```ts
import { getArsenalMatchup, pool, query } from '@mlb-edge/db';

const [{ pitcher_id }] = (await query<{ pitcher_id: number }>(
  `SELECT pitcher_id FROM game_pitches GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
)).rows;
const [{ batter_id }] = (await query<{ batter_id: number }>(
  `SELECT batter_id FROM game_pitches GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
)).rows;

const cross = await getArsenalMatchup(batter_id, pitcher_id, '2026-09-18');
console.log('--- cross --- hidden:', cross.hiddenTypes);
console.table(cross.rows);

const own = await getArsenalMatchup(null, pitcher_id, '2026-09-18');
console.log('--- pitcher-only (batterId null) --- hidden:', own.hiddenTypes);
console.table(own.rows);

console.log('--- before pitch data starts ---');
console.log(await getArsenalMatchup(batter_id, pitcher_id, '2026-03-01'));
await pool.end();
```

Run it:

```bash
npm run -w @mlb-edge/pipeline exec -- tsx /private/tmp/claude-501/-Users-sam-Projects-mlb-edge/a3f25d61-599b-4546-8274-fdd530db6e81/scratchpad/arsenal-check.ts
```

(If that script alias does not exist, run `npx tsx <path>` from `packages/pipeline/`.)

Expected:
- **cross**: 3–7 rows, `usage` descending and each ≥ 0.05, `bWhiffLo < bWhiffPct < bWhiffHi` on every row with `bSwings > 0`, no `NaN` anywhere. `hiddenTypes` non-negative and plausible (a starter typically has 1–3 sub-5% types).
- **pitcher-only**: same rows and same `hiddenTypes`, every `b*` field `0` or `null`, no `NaN`.
- **before pitch data starts**: `{ rows: [], hiddenTypes: 0 }`.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/queries/explorer.ts packages/db/src/index.ts
git commit -m "Add getArsenalMatchup: starter's arsenal crossed with batter swing decisions

Reads game_pitches, capped at the selected game's date. Pitch types under 5%
usage are excluded rather than folded into an 'Other' row -- averaging a
knuckle-curve with an eephus produces a number about nothing.

Whiff and chase carry Wilson bounds. Batted-ball quality is deliberately
absent: 46 balls in play is the second-best pitch for the most-pitched-to
hitter in the league."
```

---

### Task 4: The `ArsenalTable` component

**Files:**
- Create: `apps/web/src/app/_components/ArsenalTable.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: `ArsenalRow` from Task 3.
- Produces:

```tsx
export function ArsenalTable(props: {
  rows: ArsenalRow[];
  pitcherName: string;
  throws: string | null;
  mode: 'cross' | 'own';
  batterName: string | null;
  hiddenTypes: number;
}): JSX.Element
```

Task 5 renders it.

- [ ] **Step 1: Write the component**

Create `apps/web/src/app/_components/ArsenalTable.tsx`. No `"use client"` — this is a server component, and `ArsenalRow` arrives from a `@mlb-edge/db` call made in the page.

```tsx
import type { ArsenalRow } from '@mlb-edge/db';

// Pitch codes as MLB's feed emits them. Presentation only -- nothing
// downstream reads these names, and an unmapped code falls through to the raw
// code rather than an invented one. Same reasoning as PropLabel: a raw code
// sitting among words is obviously wrong and asks to be fixed here, where a
// guessed name just looks settled.
const PITCH: Record<string, string> = {
  FF: 'Four-seam', SI: 'Sinker', FC: 'Cutter', FA: 'Fastball',
  SL: 'Slider', ST: 'Sweeper', SV: 'Slurve', CU: 'Curve',
  KC: 'Knuckle-curve', CS: 'Slow curve',
  CH: 'Changeup', FS: 'Splitter', FO: 'Forkball',
  KN: 'Knuckleball', EP: 'Eephus', SC: 'Screwball', UN: 'Unknown',
};

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const band = (lo: number | null, hi: number | null) =>
  lo == null || hi == null ? null : `${Math.round(lo * 100)}–${Math.round(hi * 100)}`;

export function ArsenalTable({
  rows, pitcherName, throws, mode, batterName, hiddenTypes,
}: {
  rows: ArsenalRow[];
  pitcherName: string;
  throws: string | null;
  mode: 'cross' | 'own';
  batterName: string | null;
  hiddenTypes: number;
}) {
  const heading = mode === 'own' ? 'Arsenal' : 'Versus pitch types';

  if (rows.length === 0) {
    return (
      <section className="ex-arsenal">
        <h2 className="ex-h">{heading}</h2>
        <p className="cap">
          No pitch data for {pitcherName} on or before this game — either a first
          start, or a start that predates the pitch-level ingest (which begins
          2026-03-15).
        </p>
      </section>
    );
  }

  const cross = mode === 'cross';
  // Distinguishes "we have no pitch history for this batter at all" from "he
  // has simply never offered at this one pitch", which the per-row dashes
  // cannot say on their own.
  const batterBlank = cross && rows.every((r) => r.bSwings === 0);

  return (
    <section className="ex-arsenal">
      <h2 className="ex-h">{heading}</h2>
      <p className="cap">
        {pitcherName}{throws ? ` (${throws}HP)` : ''}, season to date.
      </p>

      <div className="tscroll" tabIndex={0} role="region"
        aria-label={cross
          ? `${pitcherName} arsenal versus ${batterName} by pitch type, scrollable`
          : `${pitcherName} arsenal by pitch type, scrollable`}>
        <table>
          <thead>
            {cross && (
              <tr>
                <td />
                {/* A spanning band rather than repeating "pitcher"/"batter" in
                    six headers. aria-hidden because the scope'd headers below
                    already name each column for a screen reader, and announcing
                    the band again turns every cell into a sentence. */}
                <th colSpan={3} className="ars-band" aria-hidden="true">pitcher</th>
                <th colSpan={3} className="ars-band" aria-hidden="true">
                  {batterName ?? 'batter'}, season
                </th>
              </tr>
            )}
            <tr>
              <th scope="col">Pitch</th>
              <th scope="col">Use%</th>
              <th scope="col">Velo</th>
              <th scope="col">Whiff%</th>
              {cross && <th scope="col">Swings</th>}
              {cross && <th scope="col">Whiff%</th>}
              {cross && <th scope="col">Chase%</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const whiffBand = band(r.bWhiffLo, r.bWhiffHi);
              const chaseBand = band(r.bChaseLo, r.bChaseHi);
              return (
                <tr key={r.pitchType}>
                  <th scope="row">{PITCH[r.pitchType] ?? r.pitchType}</th>
                  <td className="num">{pct(r.usage)}</td>
                  <td className="num">{r.velo == null ? '—' : r.velo.toFixed(1)}</td>
                  <td className="num">{pct(r.pWhiffPct)}</td>
                  {cross && <td className="num">{r.bSwings}</td>}
                  {cross && (
                    <td className="num">
                      {pct(r.bWhiffPct)}
                      {whiffBand && <span className="ars-ci"> ({whiffBand})</span>}
                    </td>
                  )}
                  {cross && (
                    <td className="num">
                      {pct(r.bChasePct)}
                      {chaseBand && <span className="ars-ci"> ({chaseBand})</span>}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hiddenTypes > 0 && (
        <p className="cap">
          {hiddenTypes} pitch type{hiddenTypes === 1 ? '' : 's'} under 5% usage not
          shown. Not folded into an &ldquo;other&rdquo; row: averaging a
          knuckle-curve with an eephus produces a number about nothing.
        </p>
      )}

      {batterBlank && (
        <p className="cap">
          No pitch-level history for {batterName} before this game, so the batter
          columns are empty. What the starter throws still stands on its own.
        </p>
      )}

      {cross ? (
        <p className="cap">
          Season to date, capped at this game&apos;s date. <strong>The Window,
          Venue and Pitcher-hand filters do not apply here</strong> — narrowed to
          the last 15 games, a typical batter has around a dozen swings against a
          secondary pitch, which supports no statement at all. Both pitcher hands
          are pooled; the vs-hand table above splits by hand at plate-appearance
          level. Parenthesised figures are 95% intervals — a wide one means the
          row is noise, not a small effect. Nothing in the model reads any of
          this; it is context, not input.
        </p>
      ) : (
        <p className="cap">
          Season to date, capped at this game&apos;s date, against all batters.
          The Window, Venue and Pitcher-hand filters do not apply. Nothing in the
          model reads these figures; they are context, not input.
        </p>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Add the two styles**

Append to `apps/web/src/app/globals.css`. Nothing here sets a colour on a figure — `--faint` and `--muted` are the existing chrome tokens used by `.cap` and `.ex-note`.

```css
.ex-arsenal { margin-top: 1.6rem; }
/* The spanning "pitcher"/"batter" band. Deliberately quiet: it groups columns,
   it is not a heading anyone reads first. */
.ars-band {
  font-size: 0.68rem; font-weight: 400; text-transform: lowercase;
  letter-spacing: 0.04em; color: var(--faint);
}
/* Wilson bounds ride alongside the point estimate at reduced weight -- the
   estimate is the figure, the interval is how much to trust it. */
.ars-ci { color: var(--faint); font-size: 0.8em; white-space: nowrap; }
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors. A failure naming `ArsenalRow` means Task 3's `npm run build:db` did not run.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/_components/ArsenalTable.tsx apps/web/src/app/globals.css
git commit -m "Add ArsenalTable component

Server-rendered, no colour on any figure: a table has no redundant visual
channel, so colour would be the sole carrier and would fail a greyscale or
colour-blind reader. Renders explicit Wilson bounds rather than 'p +/- h',
which would assert a symmetry the interval does not have."
```

---

### Task 5: Wire the panel into the explorer

**Files:**
- Modify: `apps/web/src/app/page.tsx` (imports; data fetch after `matchup`; replace the `.ex-todo` block at lines 408–417)

**Interfaces:**
- Consumes: `getArsenalMatchup` / `ArsenalMatchup` (Task 3), `ArsenalTable` (Task 4).
- Produces: nothing downstream.

- [ ] **Step 1: Extend the imports**

Add `getArsenalMatchup` and `type ArsenalMatchup` to the existing `@mlb-edge/db` import list in `page.tsx`, and add the component import beside the others:

```tsx
import { ArsenalTable } from './_components/ArsenalTable';
```

- [ ] **Step 2: Fetch the arsenal data**

Insert directly after the `matchup` assignment (currently `page.tsx:136–138`):

```tsx
  // Who the arsenal table is about, and from which side.
  //
  // When the selected player is himself the pitcher, the cross inverts:
  // getMatchupContext returns the OPPOSING starter, which says nothing about
  // the prop on screen. Show the selected player's own arsenal instead.
  const ownArsenal = player != null && PITCHER_PROPS.includes(shownProp);
  const arsenalPitcherId = ownArsenal ? player!.playerId : matchup?.pitcher?.playerId ?? null;
  const arsenal: ArsenalMatchup = arsenalPitcherId != null && openGame
    ? await getArsenalMatchup(
        ownArsenal ? null : player!.playerId,
        arsenalPitcherId,
        openGame.date,
      )
    : { rows: [], hiddenTypes: 0 };
```

- [ ] **Step 3: Replace the stub**

Delete the `.ex-todo` block at `page.tsx:408–417` in full:

```tsx
                        <div className="notice ex-todo">
                          <h2>Versus pitch types</h2>
                          <p>
                            Not built. Per-pitch data (type, speed, zone) is present in the
                            live feed this project already downloads for every game, but
                            nothing stores it — adding it means a new table and another pass
                            over history. Deliberately absent rather than approximated from
                            something else.
                          </p>
                        </div>
```

and put in its place:

```tsx
                        {arsenalPitcherId == null ? (
                          <p className="cap">
                            No probable starter listed, so there is no arsenal to show.
                          </p>
                        ) : (
                          <ArsenalTable
                            rows={arsenal.rows}
                            hiddenTypes={arsenal.hiddenTypes}
                            pitcherName={
                              ownArsenal ? player!.playerName : matchup!.pitcher!.playerName
                            }
                            throws={
                              ownArsenal ? null : matchup!.pitcher!.throws
                            }
                            mode={ownArsenal ? 'own' : 'cross'}
                            batterName={ownArsenal ? null : player!.playerName}
                          />
                        )}
```

- [ ] **Step 4: Drop the now-dead style**

`.ex-todo` was used only by the block just deleted. Confirm and remove it:

```bash
grep -rn 'ex-todo' apps/web/src/
```

Expected: only the `globals.css` rule. Delete that rule.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: See it in the browser**

```bash
npm run web:dev
```

Open the explorer, pick a game with a probable starter, pick a batter. Check by eye:

1. The table appears under the vs-hand table, 3–7 rows, sorted by Use% descending.
2. Every velocity is plausible (70–100), no `NaN`, no `undefined`, no `%` on an em-dash.
3. Switch to a pitcher prop and select the probable starter — heading becomes "Arsenal", batter columns disappear.
4. Change the Window filter to `last 5`: the arsenal table **does not change**, and the caption explains why.
5. Navigate to a past slate: figures shrink (the date cap is working) rather than staying identical.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/page.tsx apps/web/src/app/globals.css
git commit -m "Replace the versus-pitch-types stub with the arsenal panel

The stub promised the data was unstored; migration 014 has held it since, and
game_pitches now covers the full season at 710k pitches over 2,416 games.

When the selected player is himself the pitcher the cross inverts, so the
panel shows his own arsenal rather than the opposing starter's."
```

---

### Task 6: Full verification sweep

The only task that gates the branch as a whole. Parity in particular cannot be run per-task — it diffs a built server against a baseline.

**Files:** none modified unless a check fails.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Tests and typecheck**

```bash
npm run test
npm run typecheck
```

Expected: 5 tests pass; no type errors.

- [ ] **Step 2: Confirm `dist/` is current**

```bash
npm run build:db
grep -c 'function wilson' packages/db/dist/prob.js
grep -c 'getArsenalMatchup' packages/db/dist/queries/explorer.js
```

Expected: both non-zero. A stale `dist/` is the single most common failure mode in this repo.

- [ ] **Step 3: Contrast gate**

```bash
npm run contrast
```

Expected: pass. No new colour tokens were introduced, so a failure means something in Task 4's CSS reached for one.

- [ ] **Step 4: Build, then parity**

Parity refuses a server whose build does not match `.next/BUILD_ID` — `next dev` serves a stale compile after any `next build`, and a stale read looks like a pass. Build first, then serve that build:

```bash
npm run web:build
npm run -w @mlb-edge/web start &
PARITY_BASE=http://localhost:3000 npm run parity
```

- [ ] **Step 5: Adjudicate the parity diff — do not wave it through**

Two diff classes are expected, and they are not equivalent:

1. **New figures from the arsenal panel.** Additions. Accept and regenerate the baseline.
2. **Changed vs-hand figures on past slates**, from Task 2's lookahead fix. These are *modifications to existing numbers*. This is a true positive and the reason parity exists. Before accepting, confirm each changed figure moved in the expected direction — a capped sum must be **smaller than or equal to** the uncapped one it replaces, never larger. A figure that grew means the join in Task 2 duplicated rows.

Record the adjudication in the commit message. Parity's whole contract is that presentation changes prove they moved no data; this branch moves data on purpose, and that has to be stated rather than absorbed.

- [ ] **Step 6: Spot-check the arsenal against reality**

From Task 3 Step 1 you noted which pitch sorts first for the most-used pitcher. Confirm the rendered panel agrees, and that a known sinkerballer shows the sinker on top with a plausible share. A table that is internally consistent but describes the wrong pitcher passes every automated check here.

- [ ] **Step 7: Stop the server and commit the baseline**

```bash
kill %1
git add -A
git commit -m "Regenerate parity baseline for the arsenal panel

Two diff classes, adjudicated separately:
  - additions from the new panel;
  - changed vs-hand figures on past slates, from the platoon lookahead fix.
    Every changed figure was confirmed to have shrunk or held, never grown --
    a grown figure would mean the added join duplicated rows.

Data moved on purpose here, which is exactly what parity is meant to make
somebody say out loud."
```

- [ ] **Step 8: Update `CLAUDE.md`**

The "Known seams" section states pitch data is unstored and the panel deliberately absent. That is now false. Replace that claim with the panel's real limits: season-only (no multi-year history), both hands pooled, no batted-ball quality per pitch type, and display-only — no projector reads it.

```bash
git add CLAUDE.md
git commit -m "CLAUDE.md: the versus-pitch-types seam is now the arsenal panel's limits"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: measured sample-size constraints → Task 3's comments and Task 4's caption; data layer → Task 3; Wilson in `prob.ts` → Task 1; bounds-not-`±` → Tasks 1 and 4; presentation and no-colour → Task 4; caption's four required statements → Task 4 Step 1; all eight edge cases → Tasks 3 (null `pitch_type`, empty result, `batterId` null, doubleheader via the date predicate) and 4 (no data, blank batter, hidden types) and 5 (no probable starter, pitcher inverts); the platoon bug → Task 2; verification → Task 6. Out-of-scope items are in no task, correctly.

**Type consistency.** `getArsenalMatchup` returns `ArsenalMatchup { rows, hiddenTypes }` in Task 3's interface block, its implementation, its export, its verification script, and its call site in Task 5 — one shape throughout, no mid-plan revision. The 5% cut is applied in TypeScript rather than SQL precisely so `rows` and `hiddenTypes` come from one result set and cannot drift. `ArsenalTable`'s props (`rows`, `hiddenTypes`, `pitcherName`, `throws`, `mode`, `batterName`) match its call site in Task 5 Step 3 exactly. `wilson` returns `{ lo, hi }` in every reference.

**Placeholder scan.** No TBD/TODO, no "handle edge cases", no "similar to Task N". Every code step carries the code. Every command carries its expected output. No task references a symbol another task does not define.
