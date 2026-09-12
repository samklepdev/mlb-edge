# Measurement Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop synthetic demo data from reaching result aggregates, make bulk historical ingest one resumable command, and surface whether there is enough history for projections to mean anything.

**Architecture:** A `games.is_synthetic` flag lets the three result aggregates exclude demo rows while the demo keeps populating slate and player views. The dashboard explains an empty scorecard instead of hiding it. `--from`/`--to` on the two ingest commands replaces a hand-written shell loop. A new `health` command reports date coverage, PA-vs-shrinkage own-weight, and a plain-language verdict.

**Tech Stack:** TypeScript, npm workspaces, `tsx` (pipeline runs from source), Postgres 16 via `docker compose`, Next.js 16 App Router.

**Spec:** `docs/superpowers/specs/2026-09-11-measurement-integrity-design.md`

## Global Constraints

- **`@mlb-edge/db` runs from compiled `dist/`.** After ANY edit under `packages/db/src`, run `npm run build:db` or the change is invisible at runtime. Verify with `grep <symbol> packages/db/dist/*.js`.
- **Schema changes need `npm run db:migrate`** — it is not automatic.
- **Do not change model math.** `K_PA`, `K_BF`, the factor functions, shrinkage, projectors, and `MODEL_VERSION` (`'tb-so-v0.2'`) are all off limits. The health verdict is presentation only and must never feed back into the model.
- **Do not add a recency bound to `getBatterHistory`.** Explicitly out of scope; it needs its own spec.
- **Demo data must keep populating** the slate, top-edges, roster, and player-card queries. Only *result* aggregates exclude it: `getScorecard`, `clvByProp`, `calibrationBuckets`.
- **Health verdict thresholds**, on median own-weight `n / (n + K_PA)`: `< 0.33` → "mostly league prior"; `0.33`–`0.50` → "partially player-specific"; `>= 0.50` → "player-specific".
- Demo sentinel values, exact: `DEMO_GAME = 999999`, `DEMO_TEAM = 99999`, date `2099-01-01`.

## A note on testing

This repo has **no test runner, no test files, and no lint script** — no `test` script in any `package.json`, no `*.test.*` or `*.spec.*`, and `eslint-config-next` is not installed despite `eslint.config.mjs` referencing it. Standing one up is not in scope.

Verification is `npm run typecheck` plus database-level checks with exact expected values. Several steps below check a *specific number* measured before this work began — those are the real gates, and they are stronger than a unit test would be here because they run against the actual data.

## Environment prerequisite

```bash
docker compose up -d
```

**Baseline values measured before this work** (steps below assert against them):

| measurement | value |
|---|---|
| settled picks, all synthetic, on `2099-01-01` | 160 |
| unsettled real picks on `2026-09-11` | 157 |
| median batter PA (batters with >= 20 PA) | 60 |
| max batter PA | 121 |
| distinct final-game date islands | 3 |

---

### Task 1: Isolate synthetic data from result aggregates

**Files:**
- Create: `packages/pipeline/migrations/007_synthetic_flag.sql`
- Modify: `packages/pipeline/src/seed/demo.ts:32-37` (the games upsert)
- Modify: `packages/db/src/types.ts:17-22` (`Scorecard`)
- Modify: `packages/db/src/queries/scorecard.ts:6-14` (the aggregate query)
- Modify: `packages/db/src/queries/clv.ts:12-20` (the CLV query)
- Modify: `packages/db/src/queries/calibration.ts:7-9` (the bucket query)
- Modify: `apps/web/src/app/page.tsx:145` (the scorecard gate)

**Interfaces:**
- Produces: `Scorecard` gains `syntheticSettled: number` — the count of settled picks that ARE synthetic. The dashboard uses it to distinguish "no picks yet" from "your only settled picks are demo data". No later task consumes it.

This is one task, not two. Filtering without the dashboard explanation converts the scorecard from confidently wrong to silently absent, which is not an improvement — `page.tsx:145` gates the entire section on `settledPicks > 0`, so after the filter it would vanish with no explanation.

- [ ] **Step 1: Confirm the baseline before changing anything**

```bash
docker compose up -d
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT g.game_date::text, pk.result IS NOT NULL AS settled, count(*)
   FROM picks pk JOIN games g ON g.id = pk.game_id GROUP BY 1,2 ORDER BY 1;"
```

Expected, exactly:
```
2026-09-11|f|157
2099-01-01|t|160
```

This is the bug in one line: every settled pick is synthetic. Record it; Step 8 asserts it has changed.

- [ ] **Step 2: Add the migration**

Create `packages/pipeline/migrations/007_synthetic_flag.sql`:

```sql
-- Synthetic fixtures (the demo seed) must never reach RESULT aggregates --
-- the scorecard, CLV, or pick calibration. Before this flag, every settled
-- pick in the database was demo data with deliberately positive edges, and
-- the dashboard reported it as though the model beat the market.
--
-- A flag rather than filtering on the magic id or the 2099 sentinel date:
-- it is greppable, self-documenting, and survives either of those changing.
ALTER TABLE games ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT false;
UPDATE games SET is_synthetic = true WHERE id = 999999;
```

- [ ] **Step 3: Apply the migration and confirm the column**

```bash
npm run db:migrate
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT id, game_date::text, is_synthetic FROM games WHERE is_synthetic;"
```

Expected: exactly one row — `999999|2099-01-01|t`.

- [ ] **Step 4: Make the seeder set the flag itself**

In `packages/pipeline/src/seed/demo.ts`, replace the games upsert:

```ts
    await c.query(
      `INSERT INTO games(id, game_date, home_team_id, away_team_id, status)
       VALUES ($1, DATE '2099-01-01', $2, $2, 'Final')
       ON CONFLICT (id) DO UPDATE SET game_date = DATE '2099-01-01'`,
      [DEMO_GAME, DEMO_TEAM],
    );
```

with:

```ts
    // is_synthetic is set here, not only by the migration, so a reseed can
    // never reintroduce unflagged demo rows into the result aggregates.
    await c.query(
      `INSERT INTO games(id, game_date, home_team_id, away_team_id, status, is_synthetic)
       VALUES ($1, DATE '2099-01-01', $2, $2, 'Final', true)
       ON CONFLICT (id) DO UPDATE SET game_date = DATE '2099-01-01', is_synthetic = true`,
      [DEMO_GAME, DEMO_TEAM],
    );
```

- [ ] **Step 5: Add `syntheticSettled` to the Scorecard type**

In `packages/db/src/types.ts`, replace the `Scorecard` interface:

```ts
export interface Scorecard {
  settledPicks: number;    // picks with a settled result
  picksWithClose: number;  // picks that also have a captured closing line
  avgClv: number | null;   // mean CLV across picksWithClose
  ece: number | null;      // expected calibration error over settledPicks
}
```

with:

```ts
export interface Scorecard {
  settledPicks: number;      // REAL picks with a settled result (excludes synthetic)
  picksWithClose: number;    // real picks that also have a captured closing line
  avgClv: number | null;     // mean CLV across picksWithClose
  ece: number | null;        // expected calibration error over settledPicks
  syntheticSettled: number;  // settled DEMO picks, excluded from every figure above
}
```

- [ ] **Step 6: Exclude synthetic rows from all three result aggregates**

In `packages/db/src/queries/scorecard.ts`, replace the query block:

```ts
    await query<{ settled: string; with_close: string; avg_clv: number | string | null }>(`
      SELECT
        count(*) FILTER (WHERE result IS NOT NULL)                          AS settled,
        count(*) FILTER (WHERE close_line IS NOT NULL)                      AS with_close,
        (avg(clv_pct) FILTER (WHERE close_line IS NOT NULL))::float8        AS avg_clv
      FROM picks
    `)
```

with:

```ts
    await query<{ settled: string; with_close: string; avg_clv: number | string | null; synthetic_settled: string }>(`
      SELECT
        count(*) FILTER (WHERE pk.result IS NOT NULL AND NOT g.is_synthetic)     AS settled,
        count(*) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic) AS with_close,
        (avg(pk.clv_pct) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic))::float8 AS avg_clv,
        count(*) FILTER (WHERE pk.result IS NOT NULL AND g.is_synthetic)         AS synthetic_settled
      FROM picks pk JOIN games g ON g.id = pk.game_id
    `)
```

and add the new field to the returned object, so it reads:

```ts
  return {
    settledPicks: Number(row.settled),
    picksWithClose: Number(row.with_close),
    avgClv: row.avg_clv == null ? null : Number(row.avg_clv),
    ece,
    syntheticSettled: Number(row.synthetic_settled),
  };
```

In `packages/db/src/queries/clv.ts`, replace:

```ts
    FROM picks
    WHERE close_line IS NOT NULL
    GROUP BY prop_type
    ORDER BY prop_type
```

with:

```ts
    FROM picks pk JOIN games g ON g.id = pk.game_id
    WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic
    GROUP BY prop_type
    ORDER BY prop_type
```

In `packages/db/src/queries/calibration.ts`, replace:

```ts
    'SELECT pick_prob, won FROM picks WHERE result IS NOT NULL AND won IS NOT NULL',
```

with:

```ts
    `SELECT pk.pick_prob, pk.won
     FROM picks pk JOIN games g ON g.id = pk.game_id
     WHERE pk.result IS NOT NULL AND pk.won IS NOT NULL AND NOT g.is_synthetic`,
```

- [ ] **Step 7: Rebuild the db package**

`@mlb-edge/db` runs from `dist/`, so this is mandatory:

```bash
npm run build:db
grep -c is_synthetic packages/db/dist/queries/*.js
```

Expected: non-zero counts for `scorecard.js`, `clv.js`, and `calibration.js`. If all are 0, the build did not pick up your edits.

- [ ] **Step 8: Verify the fabricated numbers are gone**

```bash
npx tsx -e "
import { getScorecard, clvByProp } from './packages/db/dist/index.js';
const s = await getScorecard();
console.log('settledPicks', s.settledPicks, 'syntheticSettled', s.syntheticSettled, 'avgClv', s.avgClv);
console.log('clvByProp rows', (await clvByProp()).length);
process.exit(0);
"
```

Expected: `settledPicks 0`, `syntheticSettled 160`, `avgClv null`, `clvByProp rows 0`.

`settledPicks 0` is the fix working — you have no *real* settled picks, which is the truth. If `settledPicks` is still 160, the filter is not applied or `build:db` was skipped.

- [ ] **Step 9: Explain the empty scorecard on the dashboard**

`apps/web/src/app/page.tsx:145` currently gates the whole section on `d.scorecard.settledPicks > 0`, so after Step 6 it renders nothing at all. Add an explanatory branch. Replace:

```tsx
          {d.scorecard.settledPicks > 0 && (
```

with:

```tsx
          {d.scorecard.settledPicks === 0 && d.scorecard.syntheticSettled > 0 && (
            <section className="notice">
              <h2>No real settled picks yet</h2>
              <p>
                The {d.scorecard.syntheticSettled} settled picks in this database are demo
                seed data, and are deliberately excluded from CLV and calibration — they
                carry invented results and would report an edge that does not exist. Real
                numbers here need the forward loop: pull lines, capture closing lines, then
                settle once the games are final.
              </p>
            </section>
          )}
          {d.scorecard.settledPicks > 0 && (
```

Leave the existing section body unchanged.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 11: Verify the flag survives a reseed**

```bash
npm run seed:demo
docker compose exec -T db psql -U mlb -d mlb_edge -At -c \
  "SELECT is_synthetic FROM games WHERE id = 999999;"
```

Expected: `t`. This proves Step 4 works independently of the migration — a reseed cannot reintroduce unflagged demo rows.

- [ ] **Step 12: Commit**

```bash
git add packages/pipeline/migrations/007_synthetic_flag.sql \
        packages/pipeline/src/seed/demo.ts \
        packages/db/src/types.ts \
        packages/db/src/queries/scorecard.ts \
        packages/db/src/queries/clv.ts \
        packages/db/src/queries/calibration.ts \
        apps/web/src/app/page.tsx
git commit -m "Exclude synthetic demo data from result aggregates

Every settled pick in the database was demo seed data with invented
positive CLV, and the scorecard, clvByProp, and calibrationBuckets had
no filter -- so the dashboard answered 'does it beat the closing line'
with fabricated data. Adds games.is_synthetic, excludes it from those
three aggregates only, and explains the now-empty scorecard rather
than hiding it."
```

---

### Task 2: Date ranges for bulk ingest

**Files:**
- Create: `packages/pipeline/src/dates.ts`
- Modify: `packages/pipeline/src/project/backfill.ts:11-20` (remove the local `dateRange`)
- Modify: `packages/pipeline/src/cli.ts:42-58` (the `schedule` and `games` commands)

**Interfaces:**
- Produces: `dateRange(from: string, to: string): string[]` exported from `packages/pipeline/src/dates.ts`, returning inclusive `YYYY-MM-DD` strings. `backfill.ts` imports it instead of defining its own.

A working `dateRange` already exists as a module-private function in `backfill.ts`. Move it rather than writing a second copy.

- [ ] **Step 1: Extract the date helper**

Create `packages/pipeline/src/dates.ts`:

```ts
// Inclusive list of YYYY-MM-DD strings from `from` to `to`.
// UTC throughout: slate dates are calendar dates, not instants, and using
// local time would shift the range by a day west of Greenwich.
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
```

In `packages/pipeline/src/project/backfill.ts`, delete the local `dateRange` function (lines 11-20) and add to the imports at the top:

```ts
import { dateRange } from '../dates.js';
```

- [ ] **Step 2: Add `--from`/`--to` to both ingest commands**

In `packages/pipeline/src/cli.ts`, add this helper just below the existing `parseProps` helper:

```ts
// Ingest commands accept either a single --date or a --from/--to range.
// Returns [] when nothing usable was given, so callers can error uniformly.
function parseDates(o: { date?: string; from?: string; to?: string }): string[] {
  if (o.from && o.to) return dateRange(o.from, o.to);
  return o.date ? [o.date] : [];
}

// Run `fn` per date, continuing past failures: one bad date must not abort a
// 120-day pull. Returns the totals so the caller can report honestly.
async function forEachDate(
  dates: string[],
  fn: (date: string) => Promise<number>,
): Promise<{ ok: number; failed: number; total: number }> {
  let ok = 0, failed = 0, total = 0;
  for (const [i, date] of dates.entries()) {
    try {
      const n = await fn(date);
      total += n;
      ok++;
      console.log(`[${i + 1}/${dates.length}] ${date}: ${n}`);
    } catch (err) {
      failed++;
      console.error(`[${i + 1}/${dates.length}] ${date}: FAILED -- ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok, failed, total };
}
```

Add `dateRange` to the imports at the top of `cli.ts`:

```ts
import { dateRange } from './dates.js';
```

Then replace the `schedule` and `games` command definitions:

```ts
ingest
  .command('schedule')
  .description("pull a day's schedule, teams, and probable pitchers")
  .requiredOption('--date <YYYY-MM-DD>', 'date to pull')
  .action(async (o: { date: string }) => {
    const n = await ingestSchedule(o.date);
    console.log(`ingested ${n} games for ${o.date}`);
  });
ingest
  .command('games')
  .description('pull boxscores for FINAL games already stored for a date')
  .requiredOption('--date <YYYY-MM-DD>', 'date to pull finals for')
  .action(async (o: { date: string }) => {
    const n = await ingestFinalGames(o.date);
    console.log(`ingested boxscores for ${n} final game(s)`);
  });
```

with:

```ts
ingest
  .command('schedule')
  .description("pull a day's schedule, teams, and probable pitchers")
  .option('--date <YYYY-MM-DD>', 'single date to pull')
  .option('--from <YYYY-MM-DD>', 'start of a date range (inclusive; needs --to)')
  .option('--to <YYYY-MM-DD>', 'end of a date range (inclusive; needs --from)')
  .action(async (o: { date?: string; from?: string; to?: string }) => {
    const dates = parseDates(o);
    if (dates.length === 0) {
      console.error('give either --date, or both --from and --to');
      process.exitCode = 1;
      return;
    }
    const r = await forEachDate(dates, ingestSchedule);
    console.log(`ingested ${r.total} game(s) across ${r.ok} date(s); ${r.failed} failed`);
  });
ingest
  .command('games')
  .description('pull boxscores for FINAL games already stored for a date')
  .option('--date <YYYY-MM-DD>', 'single date to pull finals for')
  .option('--from <YYYY-MM-DD>', 'start of a date range (inclusive; needs --to)')
  .option('--to <YYYY-MM-DD>', 'end of a date range (inclusive; needs --from)')
  .action(async (o: { date?: string; from?: string; to?: string }) => {
    const dates = parseDates(o);
    if (dates.length === 0) {
      console.error('give either --date, or both --from and --to');
      process.exitCode = 1;
      return;
    }
    const r = await forEachDate(dates, ingestFinalGames);
    console.log(`ingested boxscores across ${r.ok} date(s) (${r.total} final game(s)); ${r.failed} failed`);
  });
```

Note the `requiredOption` → `option` change: `--date` is now optional because a range is the alternative, and `parseDates` enforces that one of the two forms was supplied.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 4: Verify a single date still works**

```bash
npm run ingest -- schedule --date 2026-09-10
```

Expected: one `[1/1] 2026-09-10: <n>` progress line, then a summary reporting 1 date and 0 failed. Backward compatibility matters — existing habits and any scripts must not break.

- [ ] **Step 5: Verify a range works**

```bash
npm run ingest -- schedule --from 2026-09-08 --to 2026-09-10
```

Expected: three progress lines (`[1/3]`, `[2/3]`, `[3/3]`), then a summary reporting 3 dates.

- [ ] **Step 6: Verify neither form given is rejected**

```bash
npm run ingest -- schedule --from 2026-09-08
```

Expected: prints `give either --date, or both --from and --to` and exits non-zero. A half-specified range must not silently ingest nothing and report success.

- [ ] **Step 7: Commit**

```bash
git add packages/pipeline/src/dates.ts \
        packages/pipeline/src/project/backfill.ts \
        packages/pipeline/src/cli.ts
git commit -m "Accept date ranges for bulk ingest

Closing an 11-month history gap previously meant a hand-written shell
loop whose failures scrolled past unnoticed. Ranges run sequentially,
report per-date progress, and continue past a failed date so one bad
day cannot abort a long pull."
```

---

### Task 3: The `health` command

**Files:**
- Create: `packages/pipeline/src/health/report.ts`
- Modify: `packages/pipeline/src/cli.ts` (add a `health` command near `backtest`)
- Modify: `packages/pipeline/package.json:18` area (add a `health` script)
- Modify: `package.json:24` area (add a root `health` script)

**Interfaces:**
- Consumes: `K_PA` from `packages/pipeline/src/project/model.js`; `dateRange` is NOT needed here.
- Produces: `healthReport(): Promise<void>` exported from `packages/pipeline/src/health/report.ts`, printing to stdout. Mirrors `backtestReport()` in `packages/pipeline/src/backtest/report.ts`.

Deliberately separate from `backtest`: that command answers "are the probabilities calibrated", this one answers "is there enough data for that answer to mean anything". Conflating them is what let the shrinkage problem stay invisible.

- [ ] **Step 1: Write the report module**

Create `packages/pipeline/src/health/report.ts`:

```ts
import { query } from '@mlb-edge/db';
import { K_PA } from '../project/model.js';

// Own-weight: how much of a projected rate comes from the player's own record
// rather than the league prior. shrinkRate weights own data at n/(n+K), so this
// hits 0.5 exactly at n = K_PA -- the point where a batter's own sample finally
// carries as much weight as the prior.
function ownWeight(pa: number): number {
  return pa / (pa + K_PA);
}

// Collapse a sorted date list into contiguous runs, so gaps are visible as
// separate ranges instead of hiding inside a single min..max span.
function islands(dates: string[]): Array<{ from: string; to: string; days: number }> {
  const out: Array<{ from: string; to: string; days: number }> = [];
  for (const d of dates) {
    const last = out[out.length - 1];
    if (last) {
      const next = new Date(`${last.to}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      if (next.toISOString().slice(0, 10) === d) {
        last.to = d;
        last.days++;
        continue;
      }
    }
    out.push({ from: d, to: d, days: 1 });
  }
  return out;
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime();
  return Math.round(ms / 86400000);
}

export async function healthReport(): Promise<void> {
  const dateRows = (
    await query<{ game_date: string }>(
      `SELECT DISTINCT game_date::text AS game_date FROM games
       WHERE status ILIKE '%final%' AND NOT is_synthetic
       ORDER BY game_date`,
    )
  ).rows;

  console.log('data health\n===========\n');

  if (dateRows.length === 0) {
    console.log('No final games ingested yet. Run:');
    console.log('  npm run ingest -- schedule --from <d> --to <d>');
    console.log('  npm run ingest -- games    --from <d> --to <d>');
    return;
  }

  const runs = islands(dateRows.map((r) => r.game_date));
  console.log(`date coverage: ${dateRows.length} date(s) in ${runs.length} block(s)`);
  runs.forEach((r, i) => {
    console.log(`  ${r.from} -> ${r.to}  (${r.days} day${r.days === 1 ? '' : 's'})`);
    const next = runs[i + 1];
    if (next) console.log(`     ... gap of ${daysBetween(r.to, next.from) - 1} days ...`);
  });
  if (runs.length > 1) {
    console.log('\n  Gaps matter: getBatterHistory pools every prior game with no recency');
    console.log('  bound, so history from across a gap is weighted like last week\'s.');
  }

  const pa = (
    await query<{ median: string | null; max: string | null; batters: string }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pa) AS median,
              max(pa) AS max,
              count(*) AS batters
       FROM (SELECT b.player_id, sum(b.pa) AS pa
             FROM player_game_batting b JOIN games g ON g.id = b.game_id
             WHERE NOT g.is_synthetic
             GROUP BY b.player_id HAVING sum(b.pa) >= 20) t`,
    )
  ).rows[0];

  const medianPa = pa?.median == null ? 0 : Number(pa.median);
  const maxPa = pa?.max == null ? 0 : Number(pa.max);
  const w = ownWeight(medianPa);

  console.log(`\nbatter sample vs shrinkage (K_PA = ${K_PA})`);
  console.log(`  batters with >= 20 PA : ${Number(pa?.batters ?? 0)}`);
  console.log(`  median PA             : ${medianPa.toFixed(0)}`);
  console.log(`  max PA                : ${maxPa.toFixed(0)}`);
  console.log(`  own-weight at median  : ${(w * 100).toFixed(0)}%  (league prior supplies the other ${((1 - w) * 100).toFixed(0)}%)`);

  const evals = (
    await query<{ prop_type: string; n: string }>(
      `SELECT prop_type, count(*) AS n FROM model_evals
       WHERE model_version = (SELECT max(model_version) FROM model_evals)
       GROUP BY 1 ORDER BY 2 DESC`,
    )
  ).rows;
  console.log('\nmodel evaluations by prop');
  if (evals.length === 0) console.log('  none yet -- run: npm run backfill -- --from <d> --to <d>');
  for (const e of evals) console.log(`  ${e.prop_type.padEnd(14)} ${Number(e.n).toLocaleString()}`);

  console.log('\nverdict');
  if (w < 0.33) {
    console.log('  MOSTLY LEAGUE PRIOR. Projections are largely the league average, not');
    console.log('  this player. Good calibration here is expected by construction -- it is');
    console.log('  not yet evidence the model knows anything player-specific.');
    console.log(`  Ingest more history: own-weight reaches 50% at ${K_PA} PA per batter.`);
  } else if (w < 0.5) {
    console.log('  PARTIALLY PLAYER-SPECIFIC. The prior still outweighs a typical');
    console.log('  batter\'s own record. Read calibration results with caution.');
  } else {
    console.log('  PLAYER-SPECIFIC. A typical batter\'s own sample now outweighs the');
    console.log('  league prior, so calibration results reflect the model, not the prior.');
  }
}
```

- [ ] **Step 2: Wire the CLI command**

In `packages/pipeline/src/cli.ts`, add the import alongside the other report imports near the top:

```ts
import { healthReport } from './health/report.js';
```

Then add the command immediately after the existing `backtest` command block:

```ts
program
  .command('health')
  .description('data sufficiency: date coverage, sample vs shrinkage, eval counts')
  .action(async () => {
    await healthReport();
  });
```

- [ ] **Step 3: Add the npm scripts**

In `packages/pipeline/package.json`, add alongside the existing `backtest` script:

```json
    "health": "tsx src/cli.ts health",
```

In the root `package.json`, add alongside the existing `backtest` script:

```json
    "health": "npm run -w @mlb-edge/pipeline health",
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 5: Run it and check against known values**

```bash
npm run health
```

Expected, matching values measured before this work:
- **3 date blocks**, not one span: roughly `2025-09-04 -> 2025-09-11`, `2026-08-10 -> 2026-08-23`, `2026-09-04 -> 2026-09-10`, with gap lines between them.
- median PA **60**, max PA **121**.
- own-weight at median **23%**.
- verdict: **MOSTLY LEAGUE PRIOR**.
- eval counts per prop, four props.

Report the full output verbatim. If the median PA is not 60 or the own-weight is not 23%, the query is wrong — those are measured facts about this database, not estimates.

- [ ] **Step 6: Commit**

```bash
git add packages/pipeline/src/health/report.ts \
        packages/pipeline/src/cli.ts \
        packages/pipeline/package.json \
        package.json
git commit -m "Add health command for data sufficiency

backtest answers whether probabilities are calibrated; nothing answered
whether there is enough data for that to mean anything. At a median 60
PA against K_PA 200, projections are 77% league prior -- so good
calibration is expected by construction. This surfaces that."
```

---

### Task 4: Verify the odds-api market keys

**Files:**
- Modify (only if the keys are wrong): `packages/pipeline/src/market/lines.ts:9-14` (`MARKET_TO_PROP`)

`batter_hits` and `batter_home_runs` were added to `MARKET_TO_PROP` from expectation, never confirmed against the live API. If they are wrong, `lines pull` silently returns no lines for the new props and it looks like a name-matching bug.

**Free-tier quota is limited. This is one verification, not exploratory polling.**

- [ ] **Step 1: Check the documented market keys**

Fetch the-odds-api's MLB player-props market list and confirm the exact spellings of the four keys currently in `MARKET_TO_PROP`: `batter_total_bases`, `batter_hits`, `batter_home_runs`, `pitcher_strikeouts`.

The `/v4/sports/{sport}/events` endpoint does not consume quota; a `/odds` request does. Prefer the documentation or the free events endpoint. Make at most **one** quota-consuming request, and only if the documentation is unavailable.

- [ ] **Step 2: Correct the mapping if needed**

If a key differs, update it in `packages/pipeline/src/market/lines.ts`:

```ts
const MARKET_TO_PROP: Record<string, PropKind> = {
  batter_total_bases: 'total_bases',
  batter_hits: 'hits',
  batter_home_runs: 'home_runs',
  pitcher_strikeouts: 'strikeouts',
};
```

If every key is already correct, change nothing — record the confirmation in your report and skip to Step 4. A no-op is a valid outcome here.

- [ ] **Step 3: Typecheck (only if you changed the file)**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 4: Record the finding**

Whether or not anything changed, state in your report: which keys were confirmed, against what source, and how many quota-consuming requests you made. `batter_total_bases` and `pitcher_strikeouts` are known-good (they return lines today), so they double as a control — if the source disagrees about those two, the source is wrong, not the code.

- [ ] **Step 5: Commit (only if you changed something)**

```bash
git add packages/pipeline/src/market/lines.ts
git commit -m "Correct odds-api market keys for hits and home runs"
```

---

## Verification summary (after all four tasks)

```bash
npm run typecheck        # exits 0
npm run build:db         # required: @mlb-edge/db runs from dist/
npm run health           # 3 date blocks, median 60 PA, 23% own-weight
npm run backtest         # per-prop blocks, unchanged by this work
```

Scorecard must report `settledPicks 0` / `syntheticSettled 160`, and the dashboard must explain why rather than render nothing.

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| `007_synthetic_flag.sql` migration | Task 1, Step 2 |
| Seeder sets flag itself (survives reseed) | Task 1, Steps 4 and 11 |
| Exclude from `getScorecard`/`clvByProp`/`calibrationBuckets` | Task 1, Step 6 |
| Slate/edges/roster/player-card untouched | Task 1 (no step modifies them) |
| Dashboard explains empty scorecard | Task 1, Step 9 |
| `ingest --from`/`--to`, `--date` still works | Task 2, Steps 2, 4, 5 |
| Continue past a failed date | Task 2, Step 2 (`forEachDate`) |
| `health`: date coverage with gaps | Task 3, Step 1 (`islands`) |
| `health`: PA vs `K_PA`, own-weight | Task 3, Step 1 (`ownWeight`) |
| `health`: eval counts per prop | Task 3, Step 1 |
| `health`: verdict at 0.33 / 0.50 thresholds | Task 3, Step 1 |
| Odds key verification | Task 4 |
| `build:db` after db edits | Global Constraints; Task 1, Step 7 |
| `db:migrate` not automatic | Global Constraints; Task 1, Step 3 |
| No model math changes | Global Constraints |
| No recency bound on `getBatterHistory` | Global Constraints (no task touches `data.ts`) |

No spec requirement is without a task.

**Placeholder scan:** no TBDs, no "handle edge cases", no "similar to Task N". Every code step carries complete code; every command step carries an exact command and an expected result, including the specific measured numbers (160, 157, 60, 121, 23%, 3 blocks) that make the checks falsifiable.

**Type consistency:**
- `syntheticSettled: number` — added to `Scorecard` (Task 1 Step 5), populated in `scorecard.ts` (Step 6), consumed in `page.tsx` (Step 9). The SQL alias `synthetic_settled` matches the row type declared in Step 6.
- `dateRange(from, to): string[]` — created in Task 2 Step 1, imported by `backfill.ts` (same step) and by `cli.ts` via `parseDates` (Step 2). The body is moved verbatim, so `backfill`'s behavior is unchanged.
- `healthReport(): Promise<void>` — defined Task 3 Step 1, imported and called Step 2, mirroring `backtestReport()`.
- `K_PA` is imported in Task 3 from `../project/model.js`, where it already exists as `export const K_PA = 200`. The 0.5 threshold and the "reaches 50% at K_PA" message both derive from that same constant rather than hardcoding 200.
- `is_synthetic` is `NOT NULL DEFAULT false`, so `NOT g.is_synthetic` is safe without a null guard at all four query sites.

**One ordering note:** Task 1 must run before Task 3. `healthReport` filters on `NOT g.is_synthetic`, a column Task 1's migration creates — running Task 3 first would fail at the database, not at typecheck.
