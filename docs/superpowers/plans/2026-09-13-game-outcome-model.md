# Game-Outcome Model (v0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and backtest a game-outcome model that projects each team's runs as a negative-binomial PMF, answering one question — is it calibrated?

**Architecture:** Team outcomes are derived from `player_game_batting` (no new ingestion). Expected runs come from shrunk team offense/defense rates, the opponent's probable starter, and a measured home-field term. Runs are distributed negative-binomially (the data's variance/mean of 2.365 rules out Poisson) and the two teams' PMFs are convolved to yield totals, run line, and moneyline. Everything lands in new `team_*` tables under a separate `TEAM_MODEL_VERSION`, keeping the boundary `CLAUDE.md` requires.

**Tech Stack:** TypeScript, npm workspaces, `tsx` (pipeline runs from source), Postgres 16 via `docker compose`.

**Spec:** `docs/superpowers/specs/2026-09-13-game-outcome-model-design.md`

## Global Constraints

- **NO ODDS API CALLS.** This sub-project spends zero credits — there is no pricing here. Never run `lines pull` or `lines capture`. Quota is 60 of 500 and must be identical before and after.
- **Never run `npm run lines -- reprice`** — it deletes picks, and `2026-09-11` holds the project's only intact CLV data.
- **`@mlb-edge/db` compiles to `dist/` and runs from there.** Task 5 edits that package; without `npm run build:db` the change is invisible at runtime.
- **`npm run db:migrate` is not automated** — it mutates data. Task 1 runs it explicitly.
- **Do not change `MODEL_VERSION`, `K_PA`, `K_BF`, the edge threshold, the de-vig method, or any prop projector.** This is a separate model; the prop model must be untouched.
- **`TEAM_MODEL_VERSION = 'game-v0.1'`**, in its own module, never mixed into a column with `MODEL_VERSION`.
- **No UI, no pricing, no picks.** Those are sub-projects 2 and 3.
- **Excluded games must be reported, never silent** — the 6 derived ties and any game missing a side.

## A note on testing

This repo has **no test runner, no test files, and no lint script** — verified across every `package.json`. Standing one up is not in scope. Verification is `npm run typecheck`, arithmetic checks via `npx tsx -e`, and database checks with exact expected values. The distribution math in Task 2 is verified against hand-computable figures, which is stronger than a unit test asserting an implementation back to itself.

## Constants measured before this work

Every figure below came from the live database before any code was written.

| constant | value |
|---|---|
| runs per team-game (mean) | **4.523** |
| variance | **10.697** |
| variance / mean | **2.365** (Poisson requires 1.0) |
| fitted NB dispersion `r` | **3.313** = 4.523² / (10.697 − 4.523) |
| home runs/game | **4.592** |
| away runs/game | **4.453** |
| home win rate | **0.5353** |
| league ER per BF | **0.10991** |
| starter share of team outs | **0.5680** |
| games / team-games | **2367** / **4734** |
| derived ties (must exclude) | **6** |

## Environment prerequisite

```bash
docker compose up -d
```

---

### Task 1: Schema and the derived outcome layer

**Files:**
- Create: `packages/pipeline/migrations/009_team_model.sql`
- Create: `packages/pipeline/src/game/outcomes.ts`

**Interfaces:**
- Produces: tables `team_projections` and `team_model_evals`; and
  `export interface TeamGameOutcome { gameId: number; teamId: number; oppTeamId: number; isHome: boolean; runsFor: number; runsAgainst: number; won: boolean }`
  plus `export async function teamOutcomes(before?: string): Promise<TeamGameOutcome[]>` and
  `export async function outcomeExclusions(): Promise<{ ties: number; missingSide: number }>`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the migration**

Create `packages/pipeline/migrations/009_team_model.sql`:

```sql
-- Game-outcome model (v0). Deliberately SEPARATE from projections/model_evals:
-- both of those have player_id NOT NULL, and a game outcome has no player.
-- CLAUDE.md requires team win/margin to be "a separate game-outcome model, not
-- a prop-model extension" -- separate tables are what enforces that, and they
-- also keep TEAM_MODEL_VERSION out of any column shared with MODEL_VERSION
-- (max(model_version) is a lexicographic comparison and mixing the two would
-- silently strand rows).
CREATE TABLE IF NOT EXISTS team_projections (
  id            BIGSERIAL PRIMARY KEY,
  game_id       INTEGER NOT NULL REFERENCES games(id),
  team_id       INTEGER NOT NULL REFERENCES teams(id),
  market        TEXT    NOT NULL,           -- 'runs' (per-team run distribution)
  proj_mean     NUMERIC NOT NULL,
  proj_stdev    NUMERIC,
  dist          JSONB,                      -- exact PMF, index = runs
  model_version TEXT    NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, team_id, market, model_version)
);

CREATE TABLE IF NOT EXISTS team_model_evals (
  id            BIGSERIAL PRIMARY KEY,
  game_id       INTEGER NOT NULL REFERENCES games(id),
  team_id       INTEGER NOT NULL REFERENCES teams(id),
  market        TEXT    NOT NULL,           -- 'moneyline' | 'run_line' | 'total'
  line          NUMERIC NOT NULL,
  model_prob    NUMERIC NOT NULL,
  actual        NUMERIC NOT NULL,
  hit           BOOLEAN NOT NULL,
  model_version TEXT    NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, team_id, market, line, model_version)
);

CREATE INDEX IF NOT EXISTS team_model_evals_version_market_idx
  ON team_model_evals (model_version, market);
```

- [ ] **Step 2: Apply the migration**

```bash
npm run db:migrate
```

Expected: `+ applied 009_team_model.sql` then `migrations up to date`.

- [ ] **Step 3: Write the derived outcome layer**

Create `packages/pipeline/src/game/outcomes.ts`:

```ts
import { query } from '@mlb-edge/db';

// Team outcomes are DERIVED, not ingested: player_game_batting carries r and
// team_id, and every non-synthetic game has exactly two teams with batting
// rows. This is the ground truth the model is graded against.
export interface TeamGameOutcome {
  gameId: number;
  teamId: number;
  oppTeamId: number;
  isHome: boolean;
  runsFor: number;
  runsAgainst: number;
  won: boolean;
}

// One row per (game, team). `before` restricts to games strictly before a date
// -- the lookahead guard every history query in this repo uses.
export async function teamOutcomes(before?: string): Promise<TeamGameOutcome[]> {
  const params: string[] = [];
  let dateFilter = '';
  if (before) {
    params.push(before);
    dateFilter = `AND g.game_date < $${params.length}`;
  }
  const res = await query<{
    game_id: number; team_id: number; opp_team_id: number;
    is_home: boolean; runs_for: number; runs_against: number;
  }>(
    `WITH s AS (
       SELECT b.game_id, b.team_id, sum(b.r)::int AS runs
       FROM player_game_batting b
       JOIN games g ON g.id = b.game_id
       WHERE NOT g.is_synthetic ${dateFilter}
       GROUP BY b.game_id, b.team_id
     )
     SELECT s.game_id, s.team_id,
            o.team_id AS opp_team_id,
            (s.team_id = g.home_team_id) AS is_home,
            s.runs AS runs_for,
            o.runs AS runs_against
     FROM s
     JOIN s o ON o.game_id = s.game_id AND o.team_id <> s.team_id
     JOIN games g ON g.id = s.game_id
     -- A completed MLB game cannot end tied. Equal derived runs means an
     -- incomplete or suspended box score; scoring it as a draw would inject an
     -- impossible outcome into calibration, so it is excluded here and counted
     -- by outcomeExclusions().
     WHERE s.runs <> o.runs`,
    params,
  );
  return res.rows.map((r) => ({
    gameId: r.game_id,
    teamId: r.team_id,
    oppTeamId: r.opp_team_id,
    isHome: r.is_home,
    runsFor: Number(r.runs_for),
    runsAgainst: Number(r.runs_against),
    won: Number(r.runs_for) > Number(r.runs_against),
  }));
}

// What the outcome layer refused to score, so it is reported rather than silent.
export async function outcomeExclusions(): Promise<{ ties: number; missingSide: number }> {
  const res = await query<{ ties: string; missing_side: string }>(
    `WITH s AS (
       SELECT b.game_id, b.team_id, sum(b.r)::int AS runs
       FROM player_game_batting b JOIN games g ON g.id = b.game_id
       WHERE NOT g.is_synthetic
       GROUP BY b.game_id, b.team_id
     ),
     per_game AS (
       SELECT game_id, count(*) AS sides, min(runs) AS lo, max(runs) AS hi
       FROM s GROUP BY game_id
     )
     SELECT count(*) FILTER (WHERE sides = 2 AND lo = hi) AS ties,
            count(*) FILTER (WHERE sides <> 2)            AS missing_side
     FROM per_game`,
  );
  return { ties: Number(res.rows[0].ties), missingSide: Number(res.rows[0].missing_side) };
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 5: Verify the outcome layer reproduces the measured baseline**

```bash
npx tsx -e "
import { teamOutcomes, outcomeExclusions } from './packages/pipeline/src/game/outcomes.ts';
const rows = await teamOutcomes();
const ex = await outcomeExclusions();
const games = new Set(rows.map(r => r.gameId)).size;
const mean = rows.reduce((a, r) => a + r.runsFor, 0) / rows.length;
const home = rows.filter(r => r.isHome);
const homeWin = home.filter(r => r.won).length / home.length;
const homeMean = home.reduce((a, r) => a + r.runsFor, 0) / home.length;
const awayMean = rows.filter(r => !r.isHome).reduce((a, r) => a + r.runsFor, 0) / (rows.length - home.length);
console.log('team-games', rows.length, 'games', games);
console.log('mean runs ', mean.toFixed(3));
console.log('home/away ', homeMean.toFixed(3), awayMean.toFixed(3));
console.log('home win  ', homeWin.toFixed(4));
console.log('excluded  ', JSON.stringify(ex));
process.exit(0);
"
```

Expected, matching the measured baseline:
- `team-games 4722 games 2361` — that is **4734 − 12** and **2367 − 6**: the 6 tied games remove 2 team-rows each.
- `mean runs` ≈ **4.52**
- `home/away` ≈ **4.59 / 4.45**
- `home win` ≈ **0.535**
- `excluded {"ties":6,"missingSide":0}`

The exclusion count must be exactly **6**. If it differs, the derived-score assumption has changed and the rest of this plan rests on it — stop and report.

- [ ] **Step 6: Commit**

```bash
git add packages/pipeline/migrations/009_team_model.sql packages/pipeline/src/game/outcomes.ts
git commit -m "Add team outcome tables and the derived outcome layer

Team outcomes need no new ingestion: player_game_batting carries runs and
team_id, and all 2367 non-synthetic games have both sides. Separate
team_* tables rather than widening projections/model_evals, which have
player_id NOT NULL -- CLAUDE.md requires a separate game-outcome model.

Excludes the 6 games with equal derived runs: an MLB game cannot end
tied, so those are incomplete box scores, and scoring them as draws would
inject impossible outcomes into calibration."
```

---

### Task 2: Negative-binomial distribution and market derivation

**Files:**
- Create: `packages/pipeline/src/game/distribution.ts`

**Interfaces:**
- Produces:
  - `export function runsPmf(mean: number, dispersion: number, maxRuns?: number): number[]`
  - `export function convolve(a: number[], b: number[]): number[]`
  - `export function pTotalOver(home: number[], away: number[], line: number): number`
  - `export function pMarginOver(home: number[], away: number[], line: number): number`
  - `export function pHomeWin(home: number[], away: number[]): number`
- Consumes: nothing. Pure functions, no database.

- [ ] **Step 1: Write the module**

Create `packages/pipeline/src/game/distribution.ts`:

```ts
// Runs per team-game are OVERDISPERSED relative to Poisson: measured variance
// 10.697 against mean 4.523, a variance/mean of 2.365 where Poisson requires
// exactly 1.0. So the family is negative binomial, whose variance is
// mean + mean^2/r.
//
// Built by recurrence rather than the closed form, which avoids needing a
// gamma function for non-integer r entirely:
//   P(0) = p^r
//   P(k) = P(k-1) * ((k + r - 1) / k) * (1 - p)      where p = r / (r + mean)
export function runsPmf(mean: number, dispersion: number, maxRuns = 40): number[] {
  if (!(mean > 0) || !(dispersion > 0)) return [1];
  const p = dispersion / (dispersion + mean);
  const pmf: number[] = [Math.pow(p, dispersion)];
  for (let k = 1; k <= maxRuns; k++) {
    pmf.push(pmf[k - 1] * ((k + dispersion - 1) / k) * (1 - p));
  }
  // Renormalise against the truncated tail beyond maxRuns.
  const total = pmf.reduce((s, x) => s + x, 0);
  return total > 0 ? pmf.map((x) => x / total) : pmf;
}

// Distribution of the SUM of two independent counts.
export function convolve(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  }
  return out;
}

// P(home + away > line). Lines are half-integers, so no tie case arises.
export function pTotalOver(home: number[], away: number[], line: number): number {
  const total = convolve(home, away);
  let s = 0;
  for (let k = 0; k < total.length; k++) if (k > line) s += total[k];
  return s;
}

// P(home - away > line), for the run line. Half-integer lines again, so no tie.
export function pMarginOver(home: number[], away: number[], line: number): number {
  let s = 0;
  for (let h = 0; h < home.length; h++) {
    for (let a = 0; a < away.length; a++) {
      if (h - a > line) s += home[h] * away[a];
    }
  }
  return s;
}

// P(home team wins).
//
// Convolution puts real mass on home == away, an outcome that cannot occur --
// MLB has no ties. That mass is split 50/50, and the 50/50 is deliberate:
// home advantage is ALREADY in the run means (4.592 vs 4.453 measured), so
// biasing the tie-split toward the home team would count the same effect
// twice. Real extra-innings outcomes do lean home (~52-54%), but there is no
// inning-level data here to fit that, so this is an honest approximation and
// not a result.
export function pHomeWin(home: number[], away: number[]): number {
  let win = 0;
  let tie = 0;
  for (let h = 0; h < home.length; h++) {
    for (let a = 0; a < away.length; a++) {
      const m = home[h] * away[a];
      if (h > a) win += m;
      else if (h === a) tie += m;
    }
  }
  return win + 0.5 * tie;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 3: Verify the PMF against hand-computable values**

The league fit is mean **4.523**, dispersion **3.313**, so `p = 3.313 / 7.836 = 0.422792` and `P(0) = p^r`. These were computed independently of the implementation:

```bash
npx tsx -e "
import { runsPmf } from './packages/pipeline/src/game/distribution.ts';
const pmf = runsPmf(4.523, 3.313);
const sum = pmf.reduce((a,b)=>a+b,0);
const mean = pmf.reduce((a,b,i)=>a+b*i,0);
const varr = pmf.reduce((a,b,i)=>a+b*i*i,0) - mean*mean;
console.log('P(0..3)', pmf.slice(0,4).map(x=>x.toFixed(4)).join(' '));
console.log('sum', sum.toFixed(6), 'mean', mean.toFixed(4), 'var', varr.toFixed(4));
"
```

Expected exactly:
```
P(0..3) 0.0577 0.1104 0.1374 0.1405
sum 1.000000 mean 4.5230 var 10.6979
```

`mean` must reproduce **4.5230** and `var` **10.6979** — the measured moments. Those are what the dispersion was fitted to, so a mismatch means the recurrence or `p` is wrong.

For reference, the observed empirical frequencies are `0.0636 0.1129 0.1410 0.1390`. The model under-predicts shutouts by ~0.6pt — a known negative-binomial limitation on baseball scores. **Report this, do not tune it.**

- [ ] **Step 4: Verify the market derivations**

```bash
npx tsx -e "
import { runsPmf, pTotalOver, pMarginOver, pHomeWin, convolve } from './packages/pipeline/src/game/distribution.ts';
const h = runsPmf(4.592, 3.313), a = runsPmf(4.453, 3.313);
console.log('total sums to 1 :', convolve(h,a).reduce((x,y)=>x+y,0).toFixed(6));
console.log('P(total > 8.5)  :', pTotalOver(h,a,8.5).toFixed(4));
console.log('P(margin > -1.5):', pMarginOver(h,a,-1.5).toFixed(4));
console.log('P(margin > 1.5) :', pMarginOver(h,a,1.5).toFixed(4));
console.log('P(home win)     :', pHomeWin(h,a).toFixed(4));
// Symmetry control: identical teams must give exactly 0.5 after tie-splitting.
const e = runsPmf(4.523, 3.313);
console.log('P(home win) even:', pHomeWin(e,e).toFixed(6));
"
```

Expected:
- `total sums to 1` = `1.000000`
- `P(margin > -1.5)` must exceed `P(margin > 1.5)` (a −1.5 line is easier to clear than +1.5).
- `P(home win)` ≈ **0.51–0.54**, in the neighbourhood of the measured 0.5353. It will land somewhat below, because 0.5353 also reflects effects this model does not have (park, roster quality beyond run rates) — note the actual figure.
- **`P(home win) even` must be exactly `0.500000`.** This is the strongest check in the task: two identical distributions must produce a coin flip once ties are split evenly. Any other value means the tie-splitting is wrong.

- [ ] **Step 5: Commit**

```bash
git add packages/pipeline/src/game/distribution.ts
git commit -m "Add negative-binomial run distribution and market derivation

Runs are overdispersed: measured variance 10.697 on mean 4.523, a
variance/mean of 2.365 where Poisson requires 1.0. Fitted dispersion
r = 3.313 reproduces both moments exactly.

Built by recurrence, which avoids needing a gamma function for
non-integer r. Ties from convolution are split 50/50 because home
advantage already sits in the run means -- biasing the split would count
it twice. Identical teams give exactly 0.500000, which is the control."
```

---

### Task 3: Model constants and team projections

**Files:**
- Create: `packages/pipeline/src/game/model.ts`
- Create: `packages/pipeline/src/game/project.ts`

**Interfaces:**
- Consumes: `teamOutcomes()` from Task 1; `runsPmf()` from Task 2.
- Produces:
  - `export const TEAM_MODEL_VERSION = 'game-v0.1'`, `K_G`, `RUNS_DISPERSION`, `LEAGUE_RUNS`, `LEAGUE_ER_PER_BF`, `STARTER_OUT_SHARE`
  - `export async function runTeamProjections(date: string): Promise<number>` — writes `team_projections`, returns rows written.

- [ ] **Step 1: Write the constants module**

Create `packages/pipeline/src/game/model.ts`:

```ts
// Tunable constants for the v0 GAME-OUTCOME model. Separate from the prop
// model's model.ts on purpose: CLAUDE.md requires team win/margin to be a
// separate model, and mixing the two version strings into one column would
// break max(model_version), which is a lexicographic comparison.
export const TEAM_MODEL_VERSION = 'game-v0.1';

// Shrinkage for team rates, in pseudo-GAMES. Derived, not picked: the prop
// model uses K_PA = 200 against ~600 PA a season, giving a player ~75% own
// weight by season's end. A team plays ~160 games, so the matching constant is
// 160 / 3 ~= 53, rounded to 50 -- a full season lands at 160/(160+50) = 76%.
export const K_G = 50;

// Negative-binomial dispersion, fitted from the measured moments:
// r = mean^2 / (var - mean) = 4.523^2 / (10.697 - 4.523) = 3.313.
// Runs are overdispersed (var/mean = 2.365), so Poisson is not an option.
export const RUNS_DISPERSION = 3.313;

// League baselines, measured over 4734 team-games.
export const LEAGUE_RUNS = 4.523;
export const LEAGUE_RUNS_HOME = 4.592;
export const LEAGUE_RUNS_AWAY = 4.453;
export const LEAGUE_ER_PER_BF = 0.10991;

// Share of a team's outs thrown by the probable starter, measured over 4718
// team-games. The remainder is held at league-average bullpen -- there is no
// reliable way to know relievers in advance, and this constant makes the size
// of that assumption explicit rather than hidden.
export const STARTER_OUT_SHARE = 0.5680;

// Park factors are NEUTRAL in v0: game_conditions holds weather only, and
// deriving a factor from ~30 venues at ~80 games each would overfit.
export const PARK_FACTOR = 1.0;
```

- [ ] **Step 2: Write the projector**

Create `packages/pipeline/src/game/project.ts`:

```ts
import { query, withTx } from '@mlb-edge/db';
import { teamOutcomes } from './outcomes.js';
import { runsPmf } from './distribution.js';
import {
  TEAM_MODEL_VERSION, K_G, RUNS_DISPERSION, LEAGUE_RUNS,
  LEAGUE_RUNS_HOME, LEAGUE_RUNS_AWAY, LEAGUE_ER_PER_BF, STARTER_OUT_SHARE, PARK_FACTOR,
} from './model.js';
import { K_BF, MIN_BF } from '../project/model.js';

interface TeamRates { scoredPerGame: number; allowedPerGame: number; games: number }

// Shrink a team's own rate toward the league mean by K_G pseudo-games.
function shrink(own: number, games: number, league: number): number {
  return (own * games + league * K_G) / (games + K_G);
}

// Starter's run-suppression multiplier, weighted by the share of a game a
// starter actually covers, with the rest at league-average bullpen. Uses the
// STARTS-ONLY sample: a reliever's rate does not describe him as a starter --
// the same reasoning behind the strikeout workload fix.
function starterAdj(erPerBf: number | null): number {
  if (erPerBf == null) return 1.0;
  return STARTER_OUT_SHARE * (erPerBf / LEAGUE_ER_PER_BF) + (1 - STARTER_OUT_SHARE);
}

export interface TeamProjectionResult { rows: number; starterFallbacks: number }

export async function runTeamProjections(date: string): Promise<TeamProjectionResult> {
  const games = (
    await query<{ id: number; home_team_id: number; away_team_id: number }>(
      `SELECT id, home_team_id, away_team_id FROM games
       WHERE game_date = $1 AND NOT is_synthetic
         AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL`,
      [date],
    )
  ).rows;
  if (games.length === 0) return { rows: 0, starterFallbacks: 0 };

  // History strictly before the slate -- the lookahead guard.
  const hist = await teamOutcomes(date);
  const agg = new Map<number, TeamRates>();
  for (const o of hist) {
    const t = agg.get(o.teamId) ?? { scoredPerGame: 0, allowedPerGame: 0, games: 0 };
    t.scoredPerGame += o.runsFor;
    t.allowedPerGame += o.runsAgainst;
    t.games += 1;
    agg.set(o.teamId, t);
  }

  // Probable starters and their starts-only ER/BF, before this date.
  const starters = (
    await query<{ game_id: number; team_id: number; er_per_bf: number | null }>(
      `SELECT pp.game_id, pp.team_id,
              (SELECT sum(p.er)::float8 / NULLIF(sum(p.bf), 0)
               FROM player_game_pitching p
               JOIN games g2 ON g2.id = p.game_id
               WHERE p.player_id = pp.pitcher_id AND g2.game_date < $1
                 AND EXISTS (SELECT 1 FROM probable_pitchers pp2
                             WHERE pp2.game_id = p.game_id AND pp2.pitcher_id = p.player_id)
               HAVING sum(p.bf) >= $2) AS er_per_bf
       FROM probable_pitchers pp
       JOIN games g ON g.id = pp.game_id
       WHERE g.game_date = $1`,
      [date, MIN_BF],
    )
  ).rows;
  const starterBy = new Map<string, number | null>();
  for (const s of starters) starterBy.set(`${s.game_id}:${s.team_id}`, s.er_per_bf);

  const league = LEAGUE_RUNS;
  let starterFallbacks = 0;
  const rows: { gameId: number; teamId: number; mean: number; pmf: number[] }[] = [];

  for (const g of games) {
    for (const [teamId, oppId, isHome] of [
      [g.home_team_id, g.away_team_id, true] as const,
      [g.away_team_id, g.home_team_id, false] as const,
    ]) {
      const own = agg.get(teamId);
      const opp = agg.get(oppId);
      const offense = own && own.games > 0
        ? shrink(own.scoredPerGame / own.games, own.games, league) / league : 1;
      const defense = opp && opp.games > 0
        ? shrink(opp.allowedPerGame / opp.games, opp.games, league) / league : 1;

      // The OPPONENT's starter suppresses THIS team's runs.
      const oppStarter = starterBy.get(`${g.id}:${oppId}`) ?? null;
      if (oppStarter == null) starterFallbacks++;
      const adj = starterAdj(oppStarter);

      const homeField = (isHome ? LEAGUE_RUNS_HOME : LEAGUE_RUNS_AWAY) / league;
      const mean = league * offense * defense * adj * homeField * PARK_FACTOR;
      rows.push({ gameId: g.id, teamId, mean, pmf: runsPmf(mean, RUNS_DISPERSION) });
    }
  }

  await withTx(async (c) => {
    // Idempotent: replace this slate's team projections for this version.
    await c.query(
      'DELETE FROM team_projections WHERE game_id = ANY($1) AND model_version = $2',
      [games.map((g) => g.id), TEAM_MODEL_VERSION],
    );
    for (const r of rows) {
      const stdev = Math.sqrt(r.mean + (r.mean * r.mean) / RUNS_DISPERSION);
      await c.query(
        `INSERT INTO team_projections (game_id, team_id, market, proj_mean, proj_stdev, dist, model_version)
         VALUES ($1, $2, 'runs', $3, $4, $5, $6)`,
        [r.gameId, r.teamId, r.mean.toFixed(4), stdev.toFixed(4), JSON.stringify(r.pmf), TEAM_MODEL_VERSION],
      );
    }
  });

  return { rows: rows.length, starterFallbacks };
}
```

`K_BF` and `MIN_BF` are imported from the prop model's constants and **read only** — do not modify that file.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 4: Project a slate and verify the distributions**

```bash
npx tsx -e "
import { runTeamProjections } from './packages/pipeline/src/game/project.ts';
console.log(JSON.stringify(await runTeamProjections('2026-09-12')));
process.exit(0);
"
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT count(*) AS rows,
          round(avg(proj_mean)::numeric,3) AS avg_mean,
          round(min(proj_mean)::numeric,2) AS min_mean,
          round(max(proj_mean)::numeric,2) AS max_mean
   FROM team_projections tp JOIN games g ON g.id = tp.game_id
   WHERE g.game_date = '2026-09-12' AND tp.model_version = 'game-v0.1';"
```

Expected: **30 rows** (15 games × 2 teams). `avg_mean` in the **4.0–5.2** band — it should sit near the 4.523 league baseline, not far from it. `min_mean` above 2 and `max_mean` below 9; a mean outside that range means a factor is compounding wrongly. Record `starterFallbacks`.

- [ ] **Step 5: Verify every stored PMF is a valid distribution**

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT count(*) AS pmfs,
          count(*) FILTER (WHERE abs((SELECT sum(x::float8) FROM jsonb_array_elements_text(tp.dist) x) - 1) > 1e-9) AS not_summing_to_one
   FROM team_projections tp JOIN games g ON g.id = tp.game_id
   WHERE g.game_date = '2026-09-12' AND tp.model_version = 'game-v0.1';"
```

Expected: `30|0`. Any PMF not summing to 1 is a broken distribution.

- [ ] **Step 6: Verify re-projection is idempotent**

```bash
npx tsx -e "
import { runTeamProjections } from './packages/pipeline/src/game/project.ts';
await runTeamProjections('2026-09-12'); process.exit(0);
"
docker compose exec -T db psql -U mlb -d mlb_edge -At -c \
  "SELECT count(*) FROM team_projections tp JOIN games g ON g.id = tp.game_id
   WHERE g.game_date = '2026-09-12' AND tp.model_version = 'game-v0.1';"
```

Expected: still **30**. The delete-before-insert must prevent growth on re-run.

- [ ] **Step 7: Commit**

```bash
git add packages/pipeline/src/game/model.ts packages/pipeline/src/game/project.ts
git commit -m "Project team runs as a negative-binomial distribution

Expected runs = league x team offense x opponent defense x opponent
starter x home field, each shrunk toward the league mean by K_G = 50
pseudo-games (derived to match the prop model's ~75% own weight at a full
season).

The starter term is weighted by 0.5680, the measured share of a team's
outs thrown by the probable starter, with the remainder at league-average
bullpen -- which makes the size of that assumption explicit. Park factors
are neutral: game_conditions has weather only."
```

---

### Task 4: Backfill team evaluations

**Files:**
- Create: `packages/pipeline/src/game/backfill.ts`
- Modify: `packages/pipeline/src/cli.ts` (add a `team-backfill` command)

**Interfaces:**
- Consumes: `runTeamProjections()` from Task 3; `pTotalOver`, `pMarginOver`, `pHomeWin` from Task 2.
- Produces: `export async function backfillTeams(from: string, to: string): Promise<{ dates: number; projected: number; evals: number }>`.

- [ ] **Step 1: Write the backfill**

Create `packages/pipeline/src/game/backfill.ts`:

```ts
import { query, withTx } from '@mlb-edge/db';
import { runTeamProjections } from './project.js';
import { pTotalOver, pMarginOver, pHomeWin } from './distribution.js';
import { TEAM_MODEL_VERSION } from './model.js';
import { dateRange } from '../dates.js';

// Standard lines, sampling each market across its realistic range.
const TOTAL_LINES = [7.5, 8.5, 9.5, 10.5];
const RUN_LINES = [-1.5, 1.5];

export async function backfillTeams(
  from: string,
  to: string,
): Promise<{ dates: number; projected: number; evals: number }> {
  const dates = dateRange(from, to);
  let projected = 0;
  let evals = 0;

  for (const date of dates) {
    projected += (await runTeamProjections(date)).rows;

    // Finished games with both teams projected and a real (non-tied) outcome.
    const rows = (
      await query<{
        game_id: number; home_team_id: number; away_team_id: number;
        home_dist: number[]; away_dist: number[]; home_runs: number; away_runs: number;
      }>(
        `WITH s AS (
           SELECT b.game_id, b.team_id, sum(b.r)::int AS runs
           FROM player_game_batting b GROUP BY b.game_id, b.team_id
         )
         SELECT g.id AS game_id, g.home_team_id, g.away_team_id,
                hp.dist AS home_dist, ap.dist AS away_dist,
                hs.runs AS home_runs, as_.runs AS away_runs
         FROM games g
         JOIN team_projections hp ON hp.game_id = g.id AND hp.team_id = g.home_team_id
                                 AND hp.model_version = $2 AND hp.market = 'runs'
         JOIN team_projections ap ON ap.game_id = g.id AND ap.team_id = g.away_team_id
                                 AND ap.model_version = $2 AND ap.market = 'runs'
         JOIN s hs  ON hs.game_id  = g.id AND hs.team_id  = g.home_team_id
         JOIN s as_ ON as_.game_id = g.id AND as_.team_id = g.away_team_id
         WHERE g.game_date = $1 AND NOT g.is_synthetic
           AND g.status ILIKE '%final%'
           AND hs.runs <> as_.runs`,
        [date, TEAM_MODEL_VERSION],
      )
    ).rows;

    await withTx(async (c) => {
      for (const r of rows) {
        const home = r.home_dist;
        const away = r.away_dist;
        const totalRuns = r.home_runs + r.away_runs;
        const margin = r.home_runs - r.away_runs;

        const write = async (market: string, line: number, prob: number, actual: number, hit: boolean) => {
          await c.query(
            `INSERT INTO team_model_evals
               (game_id, team_id, market, line, model_prob, actual, hit, model_version)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (game_id, team_id, market, line, model_version)
             DO UPDATE SET model_prob = EXCLUDED.model_prob, actual = EXCLUDED.actual, hit = EXCLUDED.hit`,
            [r.game_id, r.home_team_id, market, line, prob.toFixed(6), actual, hit, TEAM_MODEL_VERSION],
          );
          evals++;
        };

        // All three markets are recorded from the HOME team's perspective, so
        // one row per game per line -- not two mirrored rows, which would
        // double-count the same event in calibration.
        await write('moneyline', 0.5, pHomeWin(home, away), margin, margin > 0);
        for (const line of TOTAL_LINES) {
          await write('total', line, pTotalOver(home, away, line), totalRuns, totalRuns > line);
        }
        for (const line of RUN_LINES) {
          await write('run_line', line, pMarginOver(home, away, line), margin, margin > line);
        }
      }
    });
  }

  return { dates: dates.length, projected, evals };
}
```

- [ ] **Step 2: Wire the CLI**

In `packages/pipeline/src/cli.ts`, add the import alongside the existing ones:

```ts
import { backfillTeams } from './game/backfill.js';
```

Then add this command (place it immediately after the existing `backfill` command block):

```ts
program
  .command('team-backfill')
  .description('project team run distributions over a date range and evaluate them vs actual outcomes')
  .requiredOption('--from <YYYY-MM-DD>', 'start date')
  .requiredOption('--to <YYYY-MM-DD>', 'end date')
  .action(async (o: { from: string; to: string }) => {
    const r = await backfillTeams(o.from, o.to);
    console.log(`team-backfilled ${r.dates} date(s): ${r.projected} projection(s), ${r.evals} eval(s)`);
  });
```

Add a root script in `package.json` next to the existing `backfill` entry:

```json
"team-backfill": "npm run -w @mlb-edge/pipeline cli -- team-backfill",
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 4: Backfill a short range first**

Prove the shape on one week before committing to the season:

```bash
npm run team-backfill -- --from 2026-09-01 --to 2026-09-07
```

Expected: `team-backfilled 7 date(s)` with non-zero projections and evals. Each finished game yields **7 evals** (1 moneyline + 4 totals + 2 run lines), so evals should be close to `7 × games_that_week`. Record the actual figures.

- [ ] **Step 5: Backfill the season**

```bash
npm run team-backfill -- --from 2026-03-15 --to 2026-09-12
```

This takes several minutes. Record the printed figures.

- [ ] **Step 6: Verify the eval population**

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT market, count(*) AS n, round(avg(model_prob)::numeric,4) AS avg_prob,
          round(avg(hit::int)::numeric,4) AS actual_rate
   FROM team_model_evals WHERE model_version = 'game-v0.1'
   GROUP BY 1 ORDER BY 1;"
```

Expected, and this is the first real signal:
- Three markets present: `moneyline`, `run_line`, `total`.
- For `moneyline`, `actual_rate` must be close to the measured home win rate of **0.5353**, and `avg_prob` should be near it too. **A large gap between `avg_prob` and `actual_rate` on moneyline means the home-field term or the tie-split is wrong** — report it rather than adjusting constants.
- `run_line` has twice the rows of `moneyline` (2 lines), `total` four times (4 lines).

- [ ] **Step 7: Commit**

```bash
git add packages/pipeline/src/game/backfill.ts packages/pipeline/src/cli.ts package.json
git commit -m "Backfill team projections and evaluate against actual outcomes

Each finished game yields 7 evals: moneyline, four totals, two run lines,
all recorded from the home team's perspective so one event never produces
two mirrored rows that would double-count in calibration.

Games with equal derived runs are excluded here as they are in the
outcome layer -- an MLB game cannot end tied."
```

---

### Task 5: Per-market backtest report

**Files:**
- Create: `packages/db/src/queries/teamBacktest.ts`
- Modify: `packages/db/src/index.ts` (export the new queries)
- Create: `packages/pipeline/src/backtest/teamReport.ts`
- Modify: `packages/pipeline/src/cli.ts` (add a `team-backtest` command)

**Interfaces:**
- Consumes: `team_model_evals` rows written by Task 4.
- Produces: `teamReliability(buckets, market)`, `teamBacktestSummary(market)`, `teamEvalMarkets()`, and `teamBacktestReport()`.

- [ ] **Step 1: Write the query layer**

Create `packages/db/src/queries/teamBacktest.ts`:

```ts
import { query } from '../pool.js';
import type { ReliabilityBucket, BacktestSummary } from '../types.js';

// Reliability of the game-outcome model's probabilities vs realized outcomes.
// Scoped to team_model_evals and TEAM_MODEL_VERSION -- deliberately separate
// from the prop model's backtest, which reads model_evals.
export async function teamReliability(buckets = 10, market?: string): Promise<ReliabilityBucket[]> {
  const params: string[] = [];
  let where = "me.model_version = (SELECT max(model_version) FROM team_model_evals)";
  if (market) {
    params.push(market);
    where += ` AND me.market = $${params.length}`;
  }
  const res = await query<{ model_prob: string; hit: boolean }>(
    `SELECT me.model_prob, me.hit FROM team_model_evals me WHERE ${where}`,
    params,
  );
  const bins = Array.from({ length: buckets }, () => ({ n: 0, predSum: 0, hits: 0 }));
  for (const r of res.rows) {
    const p = Number(r.model_prob);
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor(p * buckets)));
    bins[idx].n++;
    bins[idx].predSum += p;
    if (r.hit) bins[idx].hits++;
  }
  const out: ReliabilityBucket[] = [];
  bins.forEach((b, i) => {
    if (b.n === 0) return;
    const predicted = b.predSum / b.n;
    const actual = b.hits / b.n;
    out.push({ lo: i / buckets, hi: (i + 1) / buckets, n: b.n, predicted, actual, gap: actual - predicted });
  });
  return out;
}

export async function teamBacktestSummary(market?: string): Promise<BacktestSummary> {
  const params: string[] = [];
  let where = "me.model_version = (SELECT max(model_version) FROM team_model_evals)";
  if (market) {
    params.push(market);
    where += ` AND me.market = $${params.length}`;
  }
  const r = (
    await query<{ n: string; brier: string | null }>(
      `SELECT count(*) AS n, avg(power(me.model_prob - (me.hit)::int, 2))::float8 AS brier
       FROM team_model_evals me WHERE ${where}`,
      params,
    )
  ).rows[0];
  const buckets = await teamReliability(10, market);
  const totalN = buckets.reduce((s, b) => s + b.n, 0);
  const ece = totalN === 0 ? null : buckets.reduce((s, b) => s + b.n * Math.abs(b.gap), 0) / totalN;
  return { n: Number(r?.n ?? 0), ece, brier: r?.brier == null ? null : Number(r.brier) };
}

export async function teamEvalMarkets(): Promise<string[]> {
  const res = await query<{ market: string }>(
    `SELECT me.market FROM team_model_evals me
     WHERE me.model_version = (SELECT max(model_version) FROM team_model_evals)
     GROUP BY me.market ORDER BY count(*) DESC`,
  );
  return res.rows.map((r) => r.market);
}
```

- [ ] **Step 2: Export from the db package**

In `packages/db/src/index.ts`, add alongside the existing query exports:

```ts
export { teamReliability, teamBacktestSummary, teamEvalMarkets } from './queries/teamBacktest.js';
```

- [ ] **Step 3: Write the report**

Create `packages/pipeline/src/backtest/teamReport.ts`:

```ts
import { teamReliability, teamBacktestSummary, teamEvalMarkets } from '@mlb-edge/db';
import type { ReliabilityBucket, BacktestSummary } from '@mlb-edge/db';

function printBuckets(buckets: ReliabilityBucket[]): void {
  console.log('  bucket       n    predicted  actual   gap');
  for (const b of buckets) {
    console.log(
      `  ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  ${String(b.n).padStart(5)}    ` +
        `${b.predicted.toFixed(3)}    ${b.actual.toFixed(3)}   ${b.gap >= 0 ? '+' : ''}${b.gap.toFixed(3)}`,
    );
  }
}

function printSummaryLine(s: BacktestSummary): void {
  console.log(`  ECE   = ${s.ece == null ? 'n/a' : s.ece.toFixed(4)}  (lower is better)`);
  console.log(`  Brier = ${s.brier == null ? 'n/a' : s.brier.toFixed(4)}  (lower is better)`);
}

export async function teamBacktestReport(): Promise<void> {
  const markets = await teamEvalMarkets();
  if (markets.length === 0) {
    console.log('No team evaluations yet. Run: npm run team-backfill -- --from <d> --to <d>');
    return;
  }

  console.log('GAME-OUTCOME model calibration, BY MARKET');
  console.log('=========================================');
  console.log(
    'Each market has its own base rate and difficulty. Compare a market only against\n' +
      'itself over time -- never against another market, and never against the prop\n' +
      "model's figures, which measure a different model on a different population.\n",
  );

  for (const market of markets) {
    const [summary, buckets] = await Promise.all([teamBacktestSummary(market), teamReliability(10, market)]);
    console.log(`-- ${market} (${summary.n} evaluations) --`);
    printSummaryLine(summary);
    printBuckets(buckets);
    console.log('');
  }

  console.log('How to read this:');
  console.log(
    '  * ~160 games per team-season is an order of magnitude less signal than per-PA\n' +
      '    props, which have thousands of events. A worse ECE than the prop model is\n' +
      '    EXPECTED and is not a failure. The bar here is calibrated, not sharp.',
  );
  console.log(
    '  * The two run distributions are convolved as INDEPENDENT, which they are not --\n' +
      '    a home team leading after 8.5 innings does not bat again. This biases the\n' +
      '    model in a known direction and is the largest v0 approximation.',
  );
  console.log(
    '  * Park factors are neutral and bullpens are league-average. Systematic gaps in\n' +
      '    the totals market are the place those two assumptions would show up first.',
  );
}
```

- [ ] **Step 4: Wire the CLI**

In `packages/pipeline/src/cli.ts`, add the import:

```ts
import { teamBacktestReport } from './backtest/teamReport.js';
```

and the command, immediately after the existing `backtest` command block:

```ts
program
  .command('team-backtest')
  .description('calibration report for the game-outcome model, by market')
  .action(async () => {
    await teamBacktestReport();
  });
```

Add a root script in `package.json` next to `backtest`:

```json
"team-backtest": "npm run -w @mlb-edge/pipeline cli -- team-backtest",
```

- [ ] **Step 5: Build and typecheck**

Run: `npm run typecheck`

Expected: exits 0. This also runs `build:db`, which is mandatory — `teamBacktest.ts` lives in `@mlb-edge/db`, which runs from `dist/`.

- [ ] **Step 6: Confirm the compiled output carries the new queries**

```bash
grep -c "team_model_evals" packages/db/dist/queries/teamBacktest.js
```

Expected: non-zero. A `0` means the build did not pick up the new file and the report below would read stale code.

- [ ] **Step 7: Run the backtest — this is the deliverable**

```bash
npm run team-backtest
```

Expected: three per-market sections (`moneyline`, `run_line`, `total`), each with n, ECE, Brier, and a reliability table.

**Record every figure.** Do not tune any constant to improve them — `K_G`, `RUNS_DISPERSION`, the starter weight, and the home-field term are all fixed for v0, and `CLAUDE.md` requires any `K` sweep to be proven on a different date range than the one that motivated it. A disappointing number reported accurately is the deliverable.

- [ ] **Step 8: Confirm the prop model was not disturbed**

The two models must be fully independent:

```bash
npm run backtest 2>&1 | grep -E "^-- |ECE"
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT model_version, count(*) FROM model_evals GROUP BY 1 ORDER BY 1;"
```

Expected: the prop backtest still reports `total_bases`, `hits`, `home_runs`, `strikeouts` with their existing ECEs, and `model_evals` still contains only `tb-so-v0.1/0.2/0.3` rows — **no `game-v0.1` row may appear in `model_evals`**. If one does, the team evals were written to the wrong table.

- [ ] **Step 9: Confirm zero credits were spent**

```bash
set -a; . ./.env; set +a
curl -s -D - -o /dev/null "https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}" | grep -i x-requests-remaining
```

Expected: **60**, unchanged. Nothing in this plan touches the odds API. Do not print the API key.

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/queries/teamBacktest.ts packages/db/src/index.ts \
        packages/pipeline/src/backtest/teamReport.ts packages/pipeline/src/cli.ts package.json
git commit -m "Add per-market backtest for the game-outcome model

Reports moneyline, run line, and total separately for the same reason the
prop backtest reports per prop: markets with different base rates pooled
into one figure produce a number that looks meaningful and is not.

Reads team_model_evals only, so the prop model's backtest population is
untouched."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| Derived outcome layer, no new ingestion | Task 1, Step 3 |
| Exclude the 6 derived ties, report them | Task 1, Steps 3 and 5 |
| Exclude games missing a side | Task 1, Step 3 (`outcomeExclusions`) |
| Expected runs formula | Task 3, Step 2 |
| `K_G = 50`, derived | Task 3, Step 1 |
| `starterAdj` weighted 0.5680, league 0.10991 | Task 3, Steps 1-2 |
| Starts-only starter sample | Task 3, Step 2 (EXISTS on `probable_pitchers`) |
| Starter fallback counted and reported | Task 3, Steps 2 and 4 |
| Home field from measured 4.592/4.453 | Task 3, Steps 1-2 |
| Negative binomial, `r` = 3.313 | Task 2, Step 1; Task 3, Step 1 |
| Poisson explicitly ruled out (var/mean 2.365) | Task 2, Step 1 (comment); Constants table |
| PMF stored exactly | Task 3, Step 2 (`dist`) |
| Totals / run line / moneyline derivation | Task 2, Step 1 |
| Tie-splitting 50/50, with reasoning | Task 2, Step 1 (comment) and Step 4 (0.500000 control) |
| Separate `team_projections` / `team_model_evals` | Task 1, Step 1 |
| `TEAM_MODEL_VERSION = 'game-v0.1'`, independent | Task 3, Step 1; Task 5, Step 8 (proves separation) |
| Per-market backtest, not pooled | Task 5, Step 3 |
| Park neutral, bullpen league-average | Task 3, Step 1; Task 5, Step 3 (report text) |
| Independence approximation named | Task 5, Step 3 (report text) |
| No pricing, no UI, no API calls | Global Constraints; Task 5, Step 9 |
| Prop model untouched | Global Constraints; Task 5, Step 8 |
| `npm run typecheck` exits 0 | Tasks 1-5 |
| `build:db` + compiled-output check | Task 5, Steps 5-6 |

No spec requirement is without a task.

**Placeholder scan:** no TBDs, no "handle edge cases", no "similar to Task N". Every code step carries complete code; every command step carries an exact command and expected result, including the measured constants (4.523, 10.697, 2.365, 3.313, 4.592, 4.453, 0.5353, 0.10991, 0.5680, 2367, 4734, 6) and the hand-computed PMF values (0.0577, 0.1104, 0.1374, 0.1405) that make the checks falsifiable.

**Type consistency:**
- `TeamGameOutcome` — declared Task 1 Step 3, consumed Task 3 Step 2 (`teamOutcomes(date)` → `.teamId`, `.runsFor`, `.runsAgainst`).
- `teamOutcomes(before?: string)` — the optional arg is used bare in Task 1 Step 5 and with a date in Task 3 Step 2.
- `runsPmf(mean, dispersion, maxRuns?)` — Task 2 Step 1, called in Task 3 Step 2 with two args.
- `pTotalOver` / `pMarginOver` / `pHomeWin` — Task 2 Step 1, all three consumed in Task 4 Step 1 with `(home, away, line)` / `(home, away)`.
- `runTeamProjections` returns `TeamProjectionResult { rows, starterFallbacks }` — Task 3 Step 2; Task 4 Step 1 reads `.rows`, Task 3 Step 4 reads `starterFallbacks`.
- `backfillTeams(from, to)` returns `{ dates, projected, evals }` — Task 4 Step 1, all three consumed by the CLI in the same step.
- `teamReliability` / `teamBacktestSummary` / `teamEvalMarkets` — Task 5 Step 1, exported Step 2, consumed Step 3. They reuse the existing `ReliabilityBucket` and `BacktestSummary` types from `@mlb-edge/db`, so no new types are introduced.

**Ordering dependencies:** Task 1 → Task 3 (outcome layer feeds the projector). Task 2 → Task 3 and Task 4 (distribution math). Task 3 → Task 4 (projections must exist before evals). Task 4 → Task 5 (evals must exist before the report). The chain is strictly sequential; no task can be reordered.
