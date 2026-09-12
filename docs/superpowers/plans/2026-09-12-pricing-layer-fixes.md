# Pricing Layer Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three defects that produced 436 picks on a 708-prop slate, and add a zero-cost re-pricing command.

**Architecture:** `deVig` switches from proportional to the power method so longshot fair probabilities stop being inflated. `expBf` derives a starter's workload from starts only, using `probable_pitchers` history. `runProjections` deletes before inserting so re-projection leaves no orphans. The pricing half of `pullLines` is extracted so it can run against stored lines with no API call.

**Tech Stack:** TypeScript, npm workspaces, `tsx` (pipeline runs from source), Postgres 16 via `docker compose`.

**Spec:** `docs/superpowers/specs/2026-09-12-pricing-layer-fixes-design.md`

## Global Constraints

- **`@mlb-edge/db` compiles to `dist/` and runs from there.** After ANY edit under `packages/db/src`, run `npm run build:db` or the change is invisible at runtime — the code reads correctly and behaves as if unpatched. This is the most common false-pass in this repo.
- **`MODEL_VERSION` becomes `'tb-so-v0.3'`** (from `'tb-so-v0.2'`). The `tb-so-` prefix is mandatory: `max(model_version)` is a *lexicographic string* comparison, and a prefix sorting below `tb-so` would leave every new row invisible to pricing, backtest, and the player card with no error.
- **Do not sweep `K_BF` or `K_PA`.** Tyler Glasnow's 6.06-vs-7.5 gap is caused by `K_BF = 300` over-shrinking an elite K-rate. It is deliberately out of scope — `CLAUDE.md` requires proving a `K` sweep on a different date range, and changing it alongside two bug fixes makes attribution impossible.
- **The K-rate keeps using all appearances.** Only the *workload* (`expBf`) becomes start-conditional. A reliever's strikeout ability transfers to starting; his innings do not.
- **No schema change, no migration.**
- **Do not add a recency bound to `getBatterHistory`.** Out of scope.
- **Odds API quota is finite: 322 of 500 credits remain.** No task may call the odds API. Task 4 exists precisely so re-pricing costs nothing, and the user runs `lines capture` themselves near gametime.

## A note on testing

This repo has **no test runner, no test files, and no lint script** — verified (no `test` script in any `package.json`, no `*.test.*`/`*.spec.*`, and `eslint-config-next` is not installed despite `eslint.config.mjs` importing it). Standing one up is not in scope.

Verification is `npm run typecheck` plus arithmetic and database checks with exact expected values. Task 1 in particular is verified against a hand-computed figure, which is stronger than a unit test asserting the implementation back to itself.

## Baseline measured before this work (v0.2)

Every comparison below is against these recorded figures:

| measure | v0.2 baseline |
|---|---|
| total picks, 2026-09-12 | **436** of 708 priced props |
| strikeout picks | 20 — avg edge 13–16%, max 43% |
| home-run picks | 82 — **79 under / 3 over** |
| total_bases picks | 171 — 122 under / 49 over |
| hits picks | 163 — 98 under / 65 over |
| ECE total_bases | 0.0124 |
| ECE hits | 0.0203 |
| ECE home_runs | 0.0021 |
| ECE strikeouts | **0.0402** |
| projections stored for season range | 209,697 (vs 199,307 written → 10,390 orphans) |

## Environment prerequisite

```bash
docker compose up -d
```

---

### Task 1: Power de-vig

**Files:**
- Modify: `packages/db/src/prob.ts:30-36` (the `deVig` body)

**Interfaces:**
- Consumes: `americanToImplied(odds: number): number`, already in the same file.
- Produces: `deVig(overOdds: number, underOdds: number): { fairOver: number; fairUnder: number }` — signature unchanged, so every existing call site (pricing, backfill, player card) is unaffected.

- [ ] **Step 1: Replace the `deVig` body**

In `packages/db/src/prob.ts`, replace:

```ts
export function deVig(overOdds: number, underOdds: number): { fairOver: number; fairUnder: number } {
  const io = americanToImplied(overOdds);
  const iu = americanToImplied(underOdds);
  const s = io + iu;
  if (s <= 0) return { fairOver: 0.5, fairUnder: 0.5 };
  return { fairOver: io / s, fairUnder: iu / s };
}
```

with:

```ts
// Remove bookmaker vig from a two-way market.
//
// Proportional de-vig (io/s, iu/s) is the obvious approach and it is wrong for
// longshots: a book shades a +450 home-run "over" far harder than the matching
// "under", so scaling both by the same factor leaves the longshot's fair
// probability too high. That inflated baseline made the model's roughly-correct
// lower number look like a large "under" edge -- it produced 79 under picks
// against 3 overs on home runs alone.
//
// The power method finds the exponent k where io^k + iu^k = 1. Raising a
// probability below 1 to a higher power shrinks the smaller one proportionally
// more, so it removes more vig from the longshot -- which is where the vig
// actually sits.
export function deVig(overOdds: number, underOdds: number): { fairOver: number; fairUnder: number } {
  const io = americanToImplied(overOdds);
  const iu = americanToImplied(underOdds);
  const s = io + iu;
  if (s <= 0) return { fairOver: 0.5, fairUnder: 0.5 };
  if (s <= 1) return { fairOver: io, fairUnder: iu };   // no vig to remove
  if (io <= 0 || iu <= 0) return { fairOver: io / s, fairUnder: iu / s };

  // io^k + iu^k is monotonically decreasing in k (both are < 1), so bisect.
  // A fixed 60 iterations halve a bracket of width 99 to far below double
  // precision: the loop cannot fail to converge, cannot spin, and needs no
  // tolerance that would have to be justified.
  let lo = 1;
  let hi = 100;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (Math.pow(io, mid) + Math.pow(iu, mid) > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  const fo = Math.pow(io, k);
  const fu = Math.pow(iu, k);
  const t = fo + fu;
  if (t <= 0) return { fairOver: io / s, fairUnder: iu / s };
  // Renormalise against residual float error so the pair sums to exactly 1.
  return { fairOver: fo / t, fairUnder: fu / t };
}
```

- [ ] **Step 2: Build the db package**

`@mlb-edge/db` runs from `dist/`, so this is mandatory:

```bash
npm run build:db
grep -c "Math.pow" packages/db/dist/prob.js
```

Expected: a non-zero count. If it is 0, the build did not pick up the edit and every check below would be meaningless.

- [ ] **Step 3: Verify against a hand-computed longshot**

The spec's worked example: a home-run market with implied probabilities 0.20 / 0.90 (`s = 1.10`). Solving `0.2^k + 0.9^k = 1` by hand gives `k ≈ 1.281`, so fair P(over) ≈ **0.127** — against **0.182** under proportional de-vig.

```bash
npx tsx -e "
import { deVig, americanToImplied } from './packages/db/dist/index.js';
// American odds whose implied probabilities are ~0.20 and ~0.90.
const over = 400, under = -900;
console.log('implied', americanToImplied(over).toFixed(4), americanToImplied(under).toFixed(4));
const d = deVig(over, under);
console.log('power  fairOver', d.fairOver.toFixed(4), 'fairUnder', d.fairUnder.toFixed(4));
const io = americanToImplied(over), iu = americanToImplied(under), s = io + iu;
console.log('proportional fairOver', (io/s).toFixed(4));
console.log('sums to 1:', (d.fairOver + d.fairUnder).toFixed(10));
"
```

Expected: `fairOver` materially **below** the proportional figure (roughly 0.13 vs 0.18 for these odds), and the pair summing to `1.0000000000`. Report the actual numbers.

- [ ] **Step 4: Verify a near-even market is barely changed**

The power method must only bite on longshots. A balanced market should come out close to proportional:

```bash
npx tsx -e "
import { deVig, americanToImplied } from './packages/db/dist/index.js';
const d = deVig(-110, -110);
const io = americanToImplied(-110), iu = americanToImplied(-110), s = io + iu;
console.log('power', d.fairOver.toFixed(4), 'proportional', (io/s).toFixed(4));
const d2 = deVig(-150, 130);
const io2 = americanToImplied(-150), iu2 = americanToImplied(130), s2 = io2 + iu2;
console.log('power', d2.fairOver.toFixed(4), 'proportional', (io2/s2).toFixed(4));
"
```

Expected: for `-110/-110` both methods give `0.5000` exactly (symmetry). For `-150/+130` the two should differ by less than about 0.01. If a near-even market shifts a lot, the bisection bracket or the monotonicity direction is wrong.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/prob.ts
git commit -m "De-vig with the power method instead of proportionally

Proportional de-vig leaves longshot fair probabilities too high, because
books shade longshots harder than favourites. On a representative home-run
market that put fair P(over) at 0.182 where the power method gives 0.127 --
the mechanism behind 79 under picks against 3 overs."
```

---

### Task 2: Starter workload from starts only

**Files:**
- Modify: `packages/pipeline/src/project/projectors.ts` (the `PitcherHistory` interface)
- Modify: `packages/pipeline/src/project/data.ts` (`getPitcherHistory`)
- Modify: `packages/pipeline/src/project/index.ts` (the `expBf` line in the strikeouts block)
- Modify: `packages/pipeline/src/project/model.ts:3` (`MODEL_VERSION`)

**Interfaces:**
- Produces: `PitcherHistory` gains `startBf: number` and `starts: number`. `getPitcherHistory` populates them. No later task consumes them directly.

The defect: `project/index.ts` projects strikeouts **only for probable starters**, but `getPitcherHistory` aggregates every appearance and `expBf = clamp(bf / appearances, ...)`. Ian Seymour has 500 batters faced across 45 appearances (11.1/app — a reliever's workload) but 19.8 across his 13 starts. He starts today; the model projected 3.08 K against a 5.5 line.

- [ ] **Step 1: Extend the `PitcherHistory` interface**

In `packages/pipeline/src/project/projectors.ts`, replace:

```ts
export interface PitcherHistory {
  bf: number; so: number; h: number; appearances: number;
}
```

with:

```ts
export interface PitcherHistory {
  bf: number; so: number; h: number; appearances: number;
  // Starts only. Workload must be conditioned on starting: a reliever's
  // bf/appearance is a third of a starter's, and we only ever project
  // strikeouts for probable starters. The K RATE deliberately still uses all
  // appearances -- strikeout ability transfers to a starting role, innings don't.
  startBf: number; starts: number;
}
```

- [ ] **Step 2: Aggregate starts separately**

In `packages/pipeline/src/project/data.ts`, replace the whole of `getPitcherHistory`:

```ts
export async function getPitcherHistory(before: string): Promise<Map<number, PitcherHistory>> {
  const res = await query<{ player_id: number; bf: number; so: number; h: number; appearances: number }>(
    `SELECT player_id, sum(bf)::float8 bf, sum(so)::float8 so, sum(h)::float8 h, count(*)::int appearances
     FROM player_game_pitching p JOIN games g ON g.id = p.game_id
     WHERE g.game_date < $1
     GROUP BY player_id`,
    [before],
  );
  const map = new Map<number, PitcherHistory>();
  for (const r of res.rows) {
    map.set(r.player_id, { bf: n(r.bf), so: n(r.so), h: n(r.h), appearances: n(r.appearances) });
  }
  return map;
}
```

with:

```ts
export async function getPitcherHistory(before: string): Promise<Map<number, PitcherHistory>> {
  // A past appearance was a START iff this pitcher was the probable starter for
  // that game -- which `probable_pitchers` records for every ingested date.
  const res = await query<{
    player_id: number; bf: number; so: number; h: number; appearances: number;
    start_bf: number | null; starts: number;
  }>(
    `SELECT p.player_id,
            sum(p.bf)::float8 bf,
            sum(p.so)::float8 so,
            sum(p.h)::float8 h,
            count(*)::int appearances,
            (sum(p.bf) FILTER (WHERE pp.pitcher_id IS NOT NULL))::float8 start_bf,
            (count(*) FILTER (WHERE pp.pitcher_id IS NOT NULL))::int starts
     FROM player_game_pitching p
     JOIN games g ON g.id = p.game_id
     LEFT JOIN probable_pitchers pp
       ON pp.game_id = p.game_id AND pp.pitcher_id = p.player_id
     WHERE g.game_date < $1
     GROUP BY p.player_id`,
    [before],
  );
  const map = new Map<number, PitcherHistory>();
  for (const r of res.rows) {
    map.set(r.player_id, {
      bf: n(r.bf), so: n(r.so), h: n(r.h), appearances: n(r.appearances),
      startBf: n(r.start_bf ?? 0), starts: n(r.starts),
    });
  }
  return map;
}
```

`n()` is the existing numeric coercion helper already used in this file — do not reimplement it.

- [ ] **Step 3: Use starter workload in the projection loop**

In `packages/pipeline/src/project/index.ts`, inside the strikeouts block, replace:

```ts
        const hist = pitchers.get(pid);
        if (!hist || hist.bf < MIN_BF) continue;
        const expBf = clamp(hist.bf / Math.max(1, hist.appearances), BF_CLAMP[0], BF_CLAMP[1]);
```

with:

```ts
        const hist = pitchers.get(pid);
        if (!hist || hist.bf < MIN_BF) continue;
        // No prior starts means no basis for a starter's workload -- this
        // pitcher's bf/appearance reflects relief usage only. Skip rather than
        // guess, the same way MIN_BF declines to project a thin sample.
        if (hist.starts === 0) continue;
        const expBf = clamp(hist.startBf / hist.starts, BF_CLAMP[0], BF_CLAMP[1]);
```

Leave `oppKFactor`, the `projectStrikeouts` call, and everything else in the block untouched. In particular do **not** change how the K-rate is computed.

- [ ] **Step 4: Bump the model version**

In `packages/pipeline/src/project/model.ts`, replace line 3:

```ts
export const MODEL_VERSION = 'tb-so-v0.2';
```

with:

```ts
export const MODEL_VERSION = 'tb-so-v0.3';
```

The `tb-so-` prefix must stay. `max(model_version)` is a lexicographic string comparison, so a prefix sorting below `tb-so` would strand every new row silently.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: exits 0. A type error on `startBf`/`starts` means Step 1 was skipped.

- [ ] **Step 6: Verify the workload figures the query now produces**

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT pl.full_name,
          count(*) AS apps,
          round(avg(ps.bf),1) AS bf_per_app,
          count(*) FILTER (WHERE pp.pitcher_id IS NOT NULL) AS starts,
          round((sum(ps.bf) FILTER (WHERE pp.pitcher_id IS NOT NULL))::numeric
                / NULLIF(count(*) FILTER (WHERE pp.pitcher_id IS NOT NULL),0),1) AS bf_per_start
   FROM player_game_pitching ps
   JOIN players pl ON pl.id = ps.player_id
   JOIN games g ON g.id = ps.game_id
   LEFT JOIN probable_pitchers pp ON pp.game_id = ps.game_id AND pp.pitcher_id = ps.player_id
   WHERE g.game_date < '2026-09-12'
     AND pl.full_name IN ('Ian Seymour','Tyler Phillips','Tyler Glasnow')
   GROUP BY 1 ORDER BY 1;"
```

Expected, matching figures measured before this work:
- Ian Seymour — 45 apps, 11.1 bf_per_app, **13 starts, 19.8 bf_per_start**
- Tyler Phillips — 36 apps, 13.9, **17 starts, 19.4**
- Tyler Glasnow — 12 apps, 21.3, 12 starts, 21.3 (all his appearances are starts, so he is unchanged — a useful control)

- [ ] **Step 7: Project today and confirm the strikeout projections moved**

```bash
npm run project -- --date 2026-09-12 --prop strikeouts
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT pl.full_name, round(p.proj_mean::numeric,2) AS proj_v03
   FROM projections p JOIN players pl ON pl.id = p.player_id JOIN games g ON g.id = p.game_id
   WHERE g.game_date='2026-09-12' AND p.prop_type='strikeouts' AND p.model_version='tb-so-v0.3'
     AND pl.full_name IN ('Ian Seymour','Tyler Phillips','Tyler Glasnow')
   ORDER BY 1;"
```

Expected: Ian Seymour rises from 3.08 (v0.2) to roughly **5.5–6.0**, near the market's 5.5 line. Tyler Phillips rises from 2.73 toward roughly 3.5. Tyler Glasnow stays near 6.06 — his workload was already correct, and his remaining gap is the `K_BF` shrinkage that is deliberately out of scope.

Report the actual numbers. Note the row count may be lower than v0.2's 28, because pitchers with no prior starts are now skipped — that is the intended behaviour, not a regression.

- [ ] **Step 8: Commit**

```bash
git add packages/pipeline/src/project/projectors.ts \
        packages/pipeline/src/project/data.ts \
        packages/pipeline/src/project/index.ts \
        packages/pipeline/src/project/model.ts
git commit -m "Estimate starter workload from starts, not all appearances

Strikeouts are only projected for probable starters, but expBf averaged
in relief outings: Ian Seymour showed 11.1 BF/appearance against 19.8
across his 13 starts, projecting 3.08 K versus a 5.5 market line. The
K-rate still uses all appearances -- strikeout ability transfers to a
starting role, innings don't. Bumps MODEL_VERSION to tb-so-v0.3."
```

---

### Task 3: Delete stale projections before inserting

**Files:**
- Modify: `packages/pipeline/src/project/index.ts` (`upsertProjections` and its one call site)

**Interfaces:**
- Produces: `upsertProjections(rows: ProjectionRow[], gameIds: number[], props: PropKind[]): Promise<void>` — signature gains two parameters. Called once, at the end of `runProjections`.

The defect: `upsertProjections` upserts but never deletes. Re-projecting a date with different history leaves rows for players who no longer qualify, and those orphans still feed the backtest. The season re-backfill wrote 199,307 projections while 209,697 are stored — **10,390 orphans**.

- [ ] **Step 1: Delete before inserting**

In `packages/pipeline/src/project/index.ts`, replace the whole of `upsertProjections`:

```ts
async function upsertProjections(rows: ProjectionRow[]): Promise<void> {
  if (rows.length === 0) return;
  await withTx(async (c) => {
    for (const r of rows) {
      await c.query(
        `INSERT INTO projections (player_id, game_id, prop_type, proj_mean, proj_stdev, model_version, dist)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (player_id, game_id, prop_type, model_version)
         DO UPDATE SET proj_mean = EXCLUDED.proj_mean, proj_stdev = EXCLUDED.proj_stdev, dist = EXCLUDED.dist, created_at = now()`,
        [r.playerId, r.gameId, r.propType, r.mean.toFixed(4), r.stdev.toFixed(4), MODEL_VERSION, JSON.stringify(r.pmf)],
      );
    }
  });
}
```

with:

```ts
async function upsertProjections(
  rows: ProjectionRow[],
  gameIds: number[],
  props: PropKind[],
): Promise<void> {
  if (gameIds.length === 0) return;
  await withTx(async (c) => {
    // Idempotent: replace this slate's projections for the requested props.
    // Upserting alone leaves orphans -- rows for players who no longer qualify
    // (say, MIN_PA against less history) survive under the same model_version
    // and still feed the backtest. Version filtering catches drift ACROSS
    // versions, never within one.
    //
    // Scoping the delete to `props` is load-bearing: re-projecting `hits` alone
    // must not wipe this slate's `strikeouts`.
    await c.query(
      'DELETE FROM projections WHERE game_id = ANY($1) AND model_version = $2 AND prop_type = ANY($3)',
      [gameIds, MODEL_VERSION, props],
    );
    for (const r of rows) {
      await c.query(
        `INSERT INTO projections (player_id, game_id, prop_type, proj_mean, proj_stdev, model_version, dist)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (player_id, game_id, prop_type, model_version)
         DO UPDATE SET proj_mean = EXCLUDED.proj_mean, proj_stdev = EXCLUDED.proj_stdev, dist = EXCLUDED.dist, created_at = now()`,
        [r.playerId, r.gameId, r.propType, r.mean.toFixed(4), r.stdev.toFixed(4), MODEL_VERSION, JSON.stringify(r.pmf)],
      );
    }
  });
}
```

Note the guard changed from `rows.length === 0` to `gameIds.length === 0`: a run that legitimately produces **zero** rows for a slate must still clear the stale ones.

The `ON CONFLICT` clause is kept as insurance even though the delete precedes it — cheap, and it prevents a crash on any unexpected duplicate within a batch.

- [ ] **Step 2: Pass the scope at the call site**

In the same file, at the end of `runProjections`, replace:

```ts
  await upsertProjections(rows);
```

with:

```ts
  await upsertProjections(rows, gameIds, props);
```

`gameIds` and `props` are both already in scope in `runProjections` — `gameIds` from `games.map((g) => g.id)`, `props` from the function parameter.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 4: Verify re-projection is now exact**

Project one date twice and confirm the stored count equals the written count:

```bash
npm run project -- --date 2026-09-12 --prop all
docker compose exec -T db psql -U mlb -d mlb_edge -At -c \
  "SELECT count(*) FROM projections p JOIN games g ON g.id=p.game_id
   WHERE g.game_date='2026-09-12' AND p.model_version='tb-so-v0.3';"
npm run project -- --date 2026-09-12 --prop all
docker compose exec -T db psql -U mlb -d mlb_edge -At -c \
  "SELECT count(*) FROM projections p JOIN games g ON g.id=p.game_id
   WHERE g.game_date='2026-09-12' AND p.model_version='tb-so-v0.3';"
```

Expected: the `wrote N projection(s)` figure from the command and both stored counts are all the **same number**. Before this fix a second run could only ever grow the stored count.

- [ ] **Step 5: Verify per-prop scoping does not wipe siblings**

This is the one way the delete could be actively harmful:

```bash
npm run project -- --date 2026-09-12 --prop hits
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT p.prop_type, count(*) FROM projections p JOIN games g ON g.id=p.game_id
   WHERE g.game_date='2026-09-12' AND p.model_version='tb-so-v0.3' GROUP BY 1 ORDER BY 1;"
```

Expected: all four prop types still present with their counts intact. Re-projecting `hits` alone must not have removed `home_runs`, `strikeouts`, or `total_bases`. If any sibling prop is missing, the delete is not scoped to `props`.

- [ ] **Step 6: Commit**

```bash
git add packages/pipeline/src/project/index.ts
git commit -m "Delete stale projections before re-inserting

runProjections upserted but never deleted, so re-projecting with
different history left rows for players who no longer qualify -- 10,390
orphans across the season, still feeding the backtest. Scoped to the
requested props so re-projecting one prop can't wipe the others."
```

---

### Task 4: `lines reprice`

**Files:**
- Modify: `packages/pipeline/src/market/lines.ts` (extract pricing from `pullLines`; add `loadStoredLines` and `repriceLines`)
- Modify: `packages/pipeline/src/cli.ts` (add a `reprice` subcommand under `lines`)

**Interfaces:**
- Produces:
  - `repriceLines(date: string, edgeThreshold: number): Promise<{ linesRead: number; picksWritten: number }>` — exported from `market/lines.ts`, imported by `cli.ts`.
  - Module-private `priceAndWritePicks(date, rows, edgeThreshold): Promise<number>` and `loadStoredLines(date): Promise<LineRow[]>`.
- Consumes: the existing module-private `LineRow` interface, `referenceLines`, `loadProjections`, `key`, and `query`/`withTx` (all already in this file).

**Why:** `pullLines` welds pricing to the API fetch, so iterating on the model costs 120 credits a time and only 322 of 500 remain. The pricing logic is unchanged — it moves.

- [ ] **Step 1: Extract the pricing half**

In `packages/pipeline/src/market/lines.ts`, add this function immediately **above** `pullLines`:

```ts
// Price lines against current projections and replace this slate's picks.
// Shared by `lines pull` (lines fresh from the API) and `lines reprice`
// (lines already stored, no API call). The pricing rule is identical either
// way -- only where the lines come from differs.
async function priceAndWritePicks(date: string, rows: LineRow[], edgeThreshold: number): Promise<number> {
  const projections = await loadProjections(date);
  const ref = referenceLines(rows);
  const gameIds = [...new Set(rows.map((r) => r.gameId))];

  interface PickRow {
    playerId: number; gameId: number; prop: PropKind; side: 'over' | 'under';
    prob: number; line: number; odds: number; fair: number; edge: number;
  }
  const picks: PickRow[] = [];

  for (const [k, r] of ref) {
    const proj = projections.get(k);
    if (!proj) continue;
    const modelOver = proj.pmf ? pOverFromPmf(proj.pmf, r.line) : pOver(proj.mean, proj.stdev, r.line);
    const { fairOver } = deVig(r.overOdds, r.underOdds);
    const edgeOver = modelOver - fairOver;
    const side: 'over' | 'under' = edgeOver >= 0 ? 'over' : 'under';
    const edge = Math.abs(edgeOver);
    if (edge < edgeThreshold) continue;
    picks.push({
      playerId: r.playerId, gameId: r.gameId, prop: r.prop, side,
      prob: side === 'over' ? modelOver : 1 - modelOver,
      line: r.line, odds: side === 'over' ? r.overOdds : r.underOdds,
      fair: side === 'over' ? fairOver : 1 - fairOver,
      edge,
    });
  }

  await withTx(async (c) => {
    if (gameIds.length > 0) {
      // idempotent: replace this slate's model picks (leaves demo/other games alone)
      await c.query('DELETE FROM picks WHERE game_id = ANY($1)', [gameIds]);
    }
    for (const p of picks) {
      await c.query(
        `INSERT INTO picks
           (player_id, game_id, prop_type, side, pick_prob, pick_line, pick_odds, edge_pct, pick_fair_prob)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [p.playerId, p.gameId, p.prop, p.side, p.prob.toFixed(4), p.line, p.odds, p.edge.toFixed(4), p.fair.toFixed(4)],
      );
    }
  });

  return picks.length;
}
```

- [ ] **Step 2: Make `pullLines` use it**

Replace the body of `pullLines` (everything between its signature line and its closing brace) with:

```ts
export async function pullLines(date: string, opts: PullOptions): Promise<PullResult> {
  const { rows, gameIds, unmatchedPlayers, oddsEvents, dbGames, matchedEvents } = await fetchLines(date, opts);
  await storeLines(rows);
  const picksWritten = await priceAndWritePicks(date, rows, opts.edgeThreshold);

  return {
    linesStored: rows.length,
    picksWritten,
    matchedGames: gameIds.length,
    unmatchedPlayers,
    oddsEvents,
    dbGames,
    matchedEvents,
  };
}
```

The behaviour is identical — the pricing block moved into `priceAndWritePicks`. `gameIds` from `fetchLines` is still used for `matchedGames` in the result.

- [ ] **Step 3: Add `loadStoredLines` and `repriceLines`**

Add both immediately **after** `pullLines`:

```ts
// Re-read the lines already stored for a slate: one row per player/game/prop,
// preferring the sharp book and then the most recent fetch -- the same
// preference order getPlayerCard uses.
async function loadStoredLines(date: string): Promise<LineRow[]> {
  const res = await query<{
    player_id: number; game_id: number; prop_type: string; line: string;
    over_odds: number | null; under_odds: number | null; source: string; is_sharp: boolean;
  }>(
    `SELECT DISTINCT ON (ml.player_id, ml.game_id, ml.prop_type)
            ml.player_id, ml.game_id, ml.prop_type, ml.line,
            ml.over_odds, ml.under_odds, ml.source, ml.is_sharp
     FROM market_lines ml JOIN games g ON g.id = ml.game_id
     WHERE g.game_date = $1
     ORDER BY ml.player_id, ml.game_id, ml.prop_type, ml.is_sharp DESC, ml.fetched_at DESC`,
    [date],
  );
  const out: LineRow[] = [];
  for (const r of res.rows) {
    // Both sides are required to de-vig; a one-sided row carries no fair price.
    if (r.over_odds == null || r.under_odds == null) continue;
    out.push({
      playerId: r.player_id, gameId: r.game_id, prop: r.prop_type as PropKind,
      line: Number(r.line), overOdds: r.over_odds, underOdds: r.under_odds,
      source: r.source, isSharp: r.is_sharp,
    });
  }
  return out;
}

// Re-price a slate from lines already in the database. Zero API calls, so
// iterating on the model costs no odds quota.
export async function repriceLines(
  date: string,
  edgeThreshold: number,
): Promise<{ linesRead: number; picksWritten: number }> {
  const rows = await loadStoredLines(date);
  const picksWritten = await priceAndWritePicks(date, rows, edgeThreshold);
  return { linesRead: rows.length, picksWritten };
}
```

- [ ] **Step 4: Wire the CLI subcommand**

In `packages/pipeline/src/cli.ts`, add `repriceLines` to the existing import from `./market/lines.js`:

```ts
import { pullLines, captureClosing, settleResults, repriceLines, type PullOptions } from './market/lines.js';
```

Then add this subcommand immediately after the `lines capture` command block:

```ts
lines
  .command('reprice')
  .description('re-price stored lines against current projections (no API calls)')
  .requiredOption('--date <YYYY-MM-DD>', 'slate date to re-price')
  .option('--edge <pct>', 'minimum |model - fair| to log a pick', '0.03')
  .action(async (o: { date: string; edge: string }) => {
    const r = await repriceLines(o.date, Number(o.edge));
    console.log(`re-priced ${r.linesRead} stored line(s); wrote ${r.picksWritten} pick(s) — 0 API credits`);
  });
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 6: Verify it reads stored lines and makes no network call**

```bash
npm run lines -- reprice --date 2026-09-12
```

Expected: reports a non-zero `linesRead` (there are 853 stored lines for this slate, deduping to one row per player/game/prop) and writes some number of picks. It must complete in well under a second — an API round trip per event would take far longer, which is itself evidence no call was made.

To confirm no credit was spent, check the quota before and after:

```bash
set -a; . ./.env; set +a
curl -s -D - -o /dev/null "https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}" | grep -i x-requests-remaining
npm run lines -- reprice --date 2026-09-12
curl -s -D - -o /dev/null "https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}" | grep -i x-requests-remaining
```

Expected: the remaining count is **identical** before and after. (The `/sports` endpoint itself is free.) Do not print the API key.

- [ ] **Step 7: Commit**

```bash
git add packages/pipeline/src/market/lines.ts packages/pipeline/src/cli.ts
git commit -m "Add lines reprice: price stored lines with no API calls

pullLines welded pricing to the API fetch, so every model iteration cost
120 odds credits against a 500/month free tier. The pricing rule is
unchanged -- extracted into priceAndWritePicks, shared by pull and
reprice."
```

---

### Task 5: Run the sequence and compare against the baseline

**Files:** none — this task runs commands and reports numbers.

**Interfaces:**
- Consumes: everything from Tasks 1-4.

This is the deliverable of the plan. The expectations below were written **before** any code was changed, so they cannot be rationalised after the fact.

- [ ] **Step 1: Re-backfill the full season under v0.3**

```bash
npm run backfill -- --from 2026-03-15 --to 2026-09-11
```

Expected: completes with `backfilled 181 date(s)` and a non-zero projection and eval count. This takes several minutes. Record the numbers.

- [ ] **Step 2: Confirm no orphans remain**

Task 3's fix should make written and stored counts agree:

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -c \
  "SELECT count(*) FROM projections p JOIN games g ON g.id=p.game_id
   WHERE g.game_date BETWEEN '2026-03-15' AND '2026-09-11' AND p.model_version='tb-so-v0.3';"
```

Expected: equal to the `projection(s)` figure printed by Step 1. Under v0.2 these differed by 10,390.

- [ ] **Step 3: Re-backtest and compare per-prop ECE**

```bash
npm run backtest
```

Compare against the v0.2 baseline and report every figure:

| prop | v0.2 | expectation |
|---|---|---|
| total_bases | 0.0124 | roughly unchanged — no fix touches batter projections |
| hits | 0.0203 | roughly unchanged |
| home_runs | 0.0021 | roughly unchanged |
| strikeouts | **0.0402** | **improves** |

De-vigging affects pricing, not calibration, so only the strikeout figure should move materially. If `total_bases` or `hits` shifts a lot, something changed that should not have.

- [ ] **Step 4: Re-project today and re-price**

```bash
npm run project -- --date 2026-09-12 --prop all
npm run lines -- reprice --date 2026-09-12
```

- [ ] **Step 5: Compare the pick distribution — the primary signal**

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT pk.prop_type, pk.side, count(*),
          round(avg(pk.edge_pct)::numeric,4) AS avg_edge,
          round(max(pk.edge_pct)::numeric,4) AS max_edge
   FROM picks pk JOIN games g ON g.id=pk.game_id
   WHERE g.game_date='2026-09-12' GROUP BY 1,2 ORDER BY 1,2;"
docker compose exec -T db psql -U mlb -d mlb_edge -At -c \
  "SELECT count(*) FROM picks pk JOIN games g ON g.id=pk.game_id WHERE g.game_date='2026-09-12';"
```

Against the v0.2 baseline:

| measure | v0.2 | expectation |
|---|---|---|
| total picks | **436** of 708 priced | drops to dozens |
| strikeout picks | 20, avg edge 13-16%, max 43% | a handful, edges under ~10% |
| home-run picks | 82 (79 under / 3 over) | far fewer, much less one-sided |
| total_bases | 171 (122 under / 49 over) | fewer, less one-sided |
| hits | 163 (98 under / 65 over) | fewer, less one-sided |

**If total picks do not fall substantially, a fix did not work.** Check that before looking at anything else. Report the actual table either way — a disappointing result reported accurately is the point of writing the expectation down first.

- [ ] **Step 6: Report, do not tune**

Write the full comparison into the report. If a number disappoints, **do not** adjust `K_BF`, `K_PA`, the edge threshold, the de-vig method, or the candidate lines to improve it. Those are all explicitly out of scope, and tuning to a single slate is the exact failure `CLAUDE.md` warns against. Report it and stop.

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| Power de-vig, bisection, 60 fixed iterations | Task 1, Step 1 |
| `s <= 0` / `s <= 1` guards | Task 1, Step 1 |
| Hand-computed longshot check (~0.127 vs 0.182) | Task 1, Step 3 |
| Near-even market barely changed | Task 1, Step 4 |
| Starts-only aggregates via `probable_pitchers` | Task 2, Step 2 |
| `expBf = startBf / starts` | Task 2, Step 3 |
| K-rate keeps all appearances | Task 2, Steps 1 and 3 (explicit) |
| `starts === 0` → skip | Task 2, Step 3 |
| `MODEL_VERSION` → `tb-so-v0.3`, prefix retained | Task 2, Step 4; Global Constraints |
| Glasnow as unchanged control | Task 2, Steps 6 and 7 |
| Delete-before-insert, scoped to props | Task 3, Step 1 |
| Per-prop scoping does not wipe siblings | Task 3, Step 5 |
| `priceAndWritePicks` / `loadStoredLines` / `repriceLines` | Task 4, Steps 1-3 |
| Zero API calls proven | Task 4, Step 6 |
| Full-season re-backfill under v0.3 | Task 5, Step 1 |
| Orphan count now zero | Task 5, Step 2 |
| Falsifiable ECE expectations | Task 5, Step 3 |
| Falsifiable pick-count expectations | Task 5, Step 5 |
| No `K` sweep; no tuning to the result | Global Constraints; Task 5, Step 6 |
| No migration | Global Constraints |

No spec requirement is without a task.

**Placeholder scan:** no TBDs, no "handle edge cases", no "similar to Task N". Every code step carries complete code; every command step carries an exact command and an expected result, including the specific recorded numbers (436, 20, 82, 0.0402, 10,390, 11.1, 19.8, 3.08) that make the checks falsifiable.

**Type consistency:**
- `PitcherHistory.startBf` / `.starts` — declared Task 2 Step 1, populated Task 2 Step 2 (SQL aliases `start_bf`/`starts` match the declared row type), consumed Task 2 Step 3. `start_bf` is nullable in SQL (a pitcher with no starts yields `NULL` from `sum(...) FILTER`), handled by `?? 0`; `count(*) FILTER` returns `0` not null, so `starts` is non-nullable — which is why the `starts === 0` guard, not a null check, is the right test.
- `upsertProjections(rows, gameIds, props)` — signature changed Task 3 Step 1, call site updated Task 3 Step 2. Both `gameIds` and `props` already exist in `runProjections` scope.
- `priceAndWritePicks(date, rows, edgeThreshold)` — defined Task 4 Step 1, called in Task 4 Step 2 (`pullLines`, passing `opts.edgeThreshold`) and Step 3 (`repriceLines`, passing its parameter).
- `repriceLines(date, edgeThreshold)` returns `{ linesRead, picksWritten }` — both fields consumed by the CLI in Task 4 Step 4.
- `deVig` keeps its exact signature, so pricing, backfill, and the player card need no changes.

**One ordering dependency:** Task 2 bumps `MODEL_VERSION`, and Task 5 Step 1's re-backfill must run after it — otherwise the season is backfilled under v0.2 and the new projections are never evaluated. Task 3 must also precede Task 5, or the v0.3 re-backfill can itself leave orphans. Tasks 1 and 4 are order-independent relative to those.
