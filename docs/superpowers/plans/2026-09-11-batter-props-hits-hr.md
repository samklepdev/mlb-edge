# Hits and Home Runs Props Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project two new batter props, `hits` and `home_runs`, and carry them through projection, backfill/eval, market pricing, and settlement.

**Architecture:** Both props are marginals of the per-PA outcome distribution that `projectTotalBases` already computes. A shared `batterPerPaRates()` helper is extracted from it, and three projectors consume that helper. Downstream, a single `actualFor()` lookup replaces two copies of a `prop === 'total_bases' ? tb : so` ternary that would otherwise grade batter props against a pitcher's strikeout count.

**Tech Stack:** TypeScript, npm workspaces, `tsx` (pipeline runs from source), Postgres 16 via `docker compose`.

**Spec:** `docs/superpowers/specs/2026-09-11-batter-props-hits-hr-design.md`

## Global Constraints

- **`MODEL_VERSION` stays `'tb-so-v0.2'`.** Do not bump it. Pricing, backtest, and the player card all filter on `(SELECT max(model_version) FROM projections)`, so a new version would make every existing TB/SO projection invisible and force a full re-backfill.
- **Byte-identical gate (hard requirement).** `total_bases` projections must be *identical* before and after the `projectors.ts` extraction — same `proj_mean`, same `proj_stdev`, same `dist`. Because the version string is unchanged, any drift means v0.2 rows in the database came from two different models. A difference is a defect, never an improvement.
- **No database migration.** `prop_type` is free-text `TEXT` with no `CHECK` constraint (`migrations/002_market_and_edges.sql:8`), and `h` / `hr` already exist in `player_game_batting`.
- **No changes to `@mlb-edge/db`.** This plan touches `packages/pipeline` only, so `npm run build:db` is never required. (The root `typecheck` script runs it anyway; that is incidental.)
- **RBI is out of scope.** Do not add it, and do not add `runs_scored` or any pitcher prop.
- **Do not tune shrinkage constants** (`K_PA`, `K_BF`) or the factor functions. Adding props must not change existing numbers.
- **Prop identifier strings, exact:** `total_bases`, `hits`, `home_runs`, `strikeouts`.
- **Odds API market keys, exact:** `batter_total_bases`, `batter_hits`, `batter_home_runs`, `pitcher_strikeouts`.

## A note on testing

This repo has **no test runner and no test files** — no `test` script in any `package.json`, no `*.test.*` or `*.spec.*` anywhere, and no `lint` script. Standing up a framework is not in scope.

Verification is therefore: `npm run typecheck`, plus **database-level differential checks** that are stronger than a unit test would be here. In particular the byte-identical gate compares real projection output across a refactor, which no unit test on its own would establish.

Every verification step below gives an exact command and an exact expected result. If a step's expected result does not appear, stop and report — do not proceed to the next task.

## Environment prerequisite

Postgres must be running for any step that touches the database:

```bash
docker compose up -d
```

The date `2026-09-11` has `tb-so-v0.2` projection data and is used throughout as the sample slate. If a step returns zero rows for that date, find one that has data:

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -c \
  "SELECT g.game_date, count(*) FROM projections p JOIN games g ON g.id=p.game_id
   WHERE p.model_version='tb-so-v0.2' AND p.prop_type='total_bases'
   GROUP BY 1 ORDER BY 2 DESC LIMIT 5;"
```

Use the top date in place of `2026-09-11` for every step, and say so in your report.

---

### Task 1: Extract `batterPerPaRates`, add hits and home-run projectors

**Files:**
- Modify: `packages/pipeline/src/project/projectors.ts:39-59`

**Interfaces:**
- Consumes: `shrinkRate(successes, n, priorMean, k)` from `./shrink.js`; `clamp`, `K_PA` from `./model.js`; the existing module-local `compound(perTrial, expN)` and `statsFromPmf(pmf)`; the existing `BatterHistory`, `LeagueBatting`, and `Projection` interfaces.
- Produces, all exported from `projectors.ts`:
  - `interface BatterPerPaRates { q0: number; q1: number; q2: number; q3: number; q4: number }`
  - `batterPerPaRates(hist: BatterHistory, league: LeagueBatting, adj: number): BatterPerPaRates`
  - `projectHits(args: { hist: BatterHistory; league: LeagueBatting; expPa: number; adj: number }): Projection`
  - `projectHomeRuns(args: { hist: BatterHistory; league: LeagueBatting; expPa: number; adj: number }): Projection`
  - `projectTotalBases` keeps its existing exported signature unchanged.

This task changes only pure functions. `project/index.ts` still calls `projectTotalBases` with the same arguments, so `npm run project` works throughout — which is what makes the byte-identical gate checkable within this task.

- [ ] **Step 1: Capture the TB baseline BEFORE touching any code**

This must happen first. Once the refactor lands there is no way to reconstruct it.

```bash
docker compose up -d
npm run project -- --date 2026-09-11 --prop total_bases
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT p.player_id, p.game_id, p.proj_mean, p.proj_stdev, md5(p.dist::text)
   FROM projections p JOIN games g ON g.id = p.game_id
   WHERE g.game_date='2026-09-11' AND p.prop_type='total_bases'
     AND p.model_version='tb-so-v0.2'
   ORDER BY p.player_id, p.game_id;" > /tmp/tb-before.txt
wc -l /tmp/tb-before.txt
```

Expected: a non-zero line count. Record the number — you will compare against it. If it is 0, use the fallback date query from "Environment prerequisite" above.

- [ ] **Step 2: Extract the shared rate helper**

In `packages/pipeline/src/project/projectors.ts`, replace the whole of the existing `projectTotalBases` function (the block starting with the `// Total bases:` comment and ending at its closing brace) with the following. The arithmetic must stay in exactly this order — same operations, same sequence — or the byte-identical gate will fail on floating-point rounding.

```ts
export interface BatterPerPaRates { q0: number; q1: number; q2: number; q3: number; q4: number }

// Shrunk, matchup-adjusted per-PA outcome probabilities for one batter:
// q0 = no hit, q1..q4 = single/double/triple/home run. This is the single
// source of the shrinkage and the 0.95 cap, so every batter prop is a marginal
// of the SAME distribution and they cannot drift apart.
export function batterPerPaRates(
  hist: BatterHistory,
  league: LeagueBatting,
  adj: number,
): BatterPerPaRates {
  const p1 = shrinkRate(hist.singles, hist.pa, league.p1, K_PA);
  const p2 = shrinkRate(hist.doubles, hist.pa, league.p2, K_PA);
  const p3 = shrinkRate(hist.triples, hist.pa, league.p3, K_PA);
  const p4 = shrinkRate(hist.hr, hist.pa, league.p4, K_PA);

  const a = clamp(adj, 0.7, 1.4);
  let q1 = p1 * a, q2 = p2 * a, q3 = p3 * a, q4 = p4 * a;
  const hitSum = q1 + q2 + q3 + q4;
  if (hitSum > 0.95) { const s = 0.95 / hitSum; q1 *= s; q2 *= s; q3 *= s; q4 *= s; }
  const q0 = Math.max(0, 1 - (q1 + q2 + q3 + q4));
  return { q0, q1, q2, q3, q4 };
}

// Total bases: the per-PA {0,1,2,3,4} outcome distribution convolved over
// expected PAs into the exact game PMF.
export function projectTotalBases(args: {
  hist: BatterHistory; league: LeagueBatting; expPa: number; adj: number;
}): Projection {
  const { q0, q1, q2, q3, q4 } = batterPerPaRates(args.hist, args.league, args.adj);
  const pmf = compound([q0, q1, q2, q3, q4], args.expPa);
  return { ...statsFromPmf(pmf), pmf };
}

// Hits: did the batter get a hit this PA, yes or no -- the same distribution
// total bases uses, collapsed to a Bernoulli, then compounded over expected PAs.
export function projectHits(args: {
  hist: BatterHistory; league: LeagueBatting; expPa: number; adj: number;
}): Projection {
  const { q1, q2, q3, q4 } = batterPerPaRates(args.hist, args.league, args.adj);
  const pHit = q1 + q2 + q3 + q4;
  const pmf = compound([1 - pHit, pHit], args.expPa);
  return { ...statsFromPmf(pmf), pmf };
}

// Home runs: Bernoulli(q4) per PA, compounded over expected PAs.
// Caveat worth knowing: the matchup adjustment folded into q4 comes from
// pitcherTbFactor, a hits-allowed-per-BF proxy. That is a weak signal for home
// runs specifically, and park HR factors differ from park run factors. See
// "Documented limitations" in the spec -- expect home_runs to calibrate worse
// than hits, and do NOT tune the factor to fix it.
export function projectHomeRuns(args: {
  hist: BatterHistory; league: LeagueBatting; expPa: number; adj: number;
}): Projection {
  const { q4 } = batterPerPaRates(args.hist, args.league, args.adj);
  const pmf = compound([1 - q4, q4], args.expPa);
  return { ...statsFromPmf(pmf), pmf };
}
```

Leave `projectStrikeouts`, `compound`, `convolve`, `statsFromPmf`, and all interfaces above them exactly as they are.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 4: Run the byte-identical gate**

```bash
npm run project -- --date 2026-09-11 --prop total_bases
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT p.player_id, p.game_id, p.proj_mean, p.proj_stdev, md5(p.dist::text)
   FROM projections p JOIN games g ON g.id = p.game_id
   WHERE g.game_date='2026-09-11' AND p.prop_type='total_bases'
     AND p.model_version='tb-so-v0.2'
   ORDER BY p.player_id, p.game_id;" > /tmp/tb-after.txt
diff /tmp/tb-before.txt /tmp/tb-after.txt && echo "BYTE-IDENTICAL OK"
```

Expected: `BYTE-IDENTICAL OK`, with `diff` producing no output.

**If diff shows any difference, STOP.** Do not "fix" it by accepting the new numbers. It means the extraction changed the arithmetic — most likely the order of operations in `batterPerPaRates` differs from the original. Re-read the original block in git (`git show HEAD:packages/pipeline/src/project/projectors.ts`) and match it operation for operation. Report the diff if you cannot resolve it.

- [ ] **Step 5: Sanity-check the two new projectors produce valid PMFs**

The new functions are not yet wired into anything, so exercise them directly:

```bash
npx tsx -e "
import { projectHits, projectHomeRuns, projectTotalBases } from './packages/pipeline/src/project/projectors.ts';
const hist = { pa: 500, singles: 80, doubles: 25, triples: 2, hr: 20, games: 130 };
const league = { p1: 0.152, p2: 0.046, p3: 0.004, p4: 0.033, soPerPa: 0.225 };
const args = { hist, league, expPa: 4.1, adj: 1.0 };
for (const [name, fn] of [['hits', projectHits], ['home_runs', projectHomeRuns], ['total_bases', projectTotalBases]]) {
  const p = fn(args);
  const sum = p.pmf.reduce((a, b) => a + b, 0);
  console.log(name, 'mean', p.mean.toFixed(4), 'stdev', p.stdev.toFixed(4), 'pmfSum', sum.toFixed(6), 'len', p.pmf.length);
}
"
```

Expected, all three lines: `pmfSum` is `1.000000`. `hits` mean is below `total_bases` mean (a hit is worth 1+ bases, so TB ≥ H always). `home_runs` mean is the smallest of the three, well under 1. Report the actual numbers.

- [ ] **Step 6: Commit**

```bash
git add packages/pipeline/src/project/projectors.ts
git commit -m "Extract batterPerPaRates; add hits and home-run projectors

Both new props are marginals of the per-PA distribution total bases
already used, so they share one shrinkage and one 0.95 cap. Verified
total_bases output is byte-identical across the extraction."
```

---

### Task 2: Wire the new props into projection and the CLI

**Files:**
- Modify: `packages/pipeline/src/project/index.ts:10` (the `PropKind` type), `:38-65` (the batter block)
- Modify: `packages/pipeline/src/cli.ts:65-72` and `:148-155` (two duplicated prop whitelists)

**Interfaces:**
- Consumes from Task 1: `projectHits(args)`, `projectHomeRuns(args)`, `projectTotalBases(args)` — all take `{ hist, league, expPa, adj }` and return `{ mean, stdev, pmf }`.
- Produces:
  - `ALL_PROPS: readonly ['total_bases', 'hits', 'home_runs', 'strikeouts']`, exported from `project/index.ts`
  - `type PropKind = (typeof ALL_PROPS)[number]` — derived, so the runtime whitelist and the type cannot diverge
  - Task 3 imports both.

Why the whitelist matters: `cli.ts` currently hardcodes `['total_bases','strikeouts']` in **two** places, one for `project` and one for `backfill`. Adding a prop to only one makes `project` accept a prop that `backfill` silently rejects.

- [ ] **Step 1: Replace the `PropKind` type with a derived one**

In `packages/pipeline/src/project/index.ts`, replace line 10:

```ts
export type PropKind = 'total_bases' | 'strikeouts';
```

with:

```ts
// Single source of truth for prop identifiers: the CLI whitelist and the type
// are both derived from this, so they cannot drift apart.
export const ALL_PROPS = ['total_bases', 'hits', 'home_runs', 'strikeouts'] as const;
export type PropKind = (typeof ALL_PROPS)[number];

// Props driven by the batter loop (they share rosters, matchup adj, and expPa).
const BATTER_PROPS = ['total_bases', 'hits', 'home_runs'] as const;
```

- [ ] **Step 2: Update the import of the projectors**

In the same file, change line 4 from:

```ts
import { projectTotalBases, projectStrikeouts } from './projectors.js';
```

to:

```ts
import { projectTotalBases, projectHits, projectHomeRuns, projectStrikeouts } from './projectors.js';
```

- [ ] **Step 3: Make the batter block serve all three batter props**

In `packages/pipeline/src/project/index.ts`, change the batter block's guard (currently `if (props.includes('total_bases')) {` at line 38) to:

```ts
  const batterProps = BATTER_PROPS.filter((p) => props.includes(p));
  if (batterProps.length > 0) {
```

Then, inside that block, replace the innermost per-player loop (currently lines 56-62, `for (const pid of roster) { ... }`) with:

```ts
        for (const pid of roster) {
          const hist = batters.get(pid);
          if (!hist || hist.pa < MIN_PA) continue;
          const expPa = clamp(hist.pa / Math.max(1, hist.games), PA_CLAMP[0], PA_CLAMP[1]);
          const a = { hist, league, expPa, adj };
          for (const prop of batterProps) {
            const { mean, stdev, pmf } =
              prop === 'total_bases' ? projectTotalBases(a)
              : prop === 'hits' ? projectHits(a)
              : projectHomeRuns(a);
            rows.push({ playerId: pid, gameId: g.id, propType: prop, mean, stdev, pmf });
          }
        }
```

Everything else in the block — the `sides` array, the roster lookup, `pFactor`, `adj` — stays exactly as it is. The strikeouts block below is untouched.

Note: this recomputes `batterPerPaRates` once per prop rather than once per player. That is a few floating-point multiplications per row and is not worth optimizing; keeping the projector signatures uniform is worth more than the saved arithmetic.

- [ ] **Step 4: Collapse the two duplicated CLI whitelists**

In `packages/pipeline/src/cli.ts`, change the import on line 7 from:

```ts
import { runProjections, type PropKind } from './project/index.js';
```

to:

```ts
import { runProjections, ALL_PROPS, type PropKind } from './project/index.js';
```

Then add these two helpers near the top of the file, after the imports:

```ts
// Shared by `project` and `backfill` so the two commands can never accept
// different prop sets.
const PROP_HELP = `${ALL_PROPS.join(' | ')} | all`;

function parseProps(arg: string): PropKind[] {
  if (arg === 'all') return [...ALL_PROPS];
  return (ALL_PROPS as readonly string[]).includes(arg) ? [arg as PropKind] : [];
}
```

In the `project` command, replace these lines:

```ts
    .option('--prop <kind>', 'total_bases | strikeouts | all', 'all')
```

with:

```ts
    .option('--prop <kind>', PROP_HELP, 'all')
```

and replace:

```ts
    const valid: PropKind[] = ['total_bases', 'strikeouts'];
    const props: PropKind[] =
      o.prop === 'all' ? valid : valid.includes(o.prop as PropKind) ? [o.prop as PropKind] : [];
    if (props.length === 0) {
      console.error(`unknown --prop "${o.prop}". Use: total_bases | strikeouts | all`);
```

with:

```ts
    const props = parseProps(o.prop);
    if (props.length === 0) {
      console.error(`unknown --prop "${o.prop}". Use: ${PROP_HELP}`);
```

Make the identical two replacements in the `backfill` command lower in the same file (the `.option('--prop <kind>', ...)` line and the same five-line block). After this, the strings `'total_bases', 'strikeouts'` must not appear in `cli.ts` at all.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: exits 0.

- [ ] **Step 6: Verify the new props are written**

```bash
npm run project -- --date 2026-09-11 --prop all
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT p.prop_type, count(*), round(avg(p.proj_mean)::numeric, 3)
   FROM projections p JOIN games g ON g.id = p.game_id
   WHERE g.game_date='2026-09-11' AND p.model_version='tb-so-v0.2'
   GROUP BY 1 ORDER BY 1;"
```

Expected: four rows — `home_runs`, `hits`, `strikeouts`, `total_bases`. The `hits` and `total_bases` counts must be **equal** (same batters, same loop). Average `hits` mean should land roughly 0.8–1.2, average `home_runs` roughly 0.1–0.2, and average `total_bases` must be greater than average `hits`. Report the actual table.

- [ ] **Step 7: Re-confirm the byte-identical gate still holds**

Wiring the loop must not have perturbed total bases:

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT p.player_id, p.game_id, p.proj_mean, p.proj_stdev, md5(p.dist::text)
   FROM projections p JOIN games g ON g.id = p.game_id
   WHERE g.game_date='2026-09-11' AND p.prop_type='total_bases'
     AND p.model_version='tb-so-v0.2'
   ORDER BY p.player_id, p.game_id;" > /tmp/tb-after2.txt
diff /tmp/tb-before.txt /tmp/tb-after2.txt && echo "BYTE-IDENTICAL STILL OK"
```

Expected: `BYTE-IDENTICAL STILL OK`. If `/tmp/tb-before.txt` is gone, regenerate it by stashing your changes — do not skip this check.

- [ ] **Step 8: Verify an invalid prop is still rejected**

```bash
npm run project -- --date 2026-09-11 --prop rbi
```

Expected: prints `unknown --prop "rbi". Use: total_bases | hits | home_runs | strikeouts | all` and exits non-zero. This confirms `parseProps` rejects rather than silently projecting nothing.

- [ ] **Step 9: Commit**

```bash
git add packages/pipeline/src/project/index.ts packages/pipeline/src/cli.ts
git commit -m "Project hits and home_runs from the existing batter loop

The batter block already computes rosters, matchup adj, and expPa, so
the new props are extra rows from the same loop rather than new passes.
Collapses the two duplicated CLI prop whitelists into ALL_PROPS."
```

---

### Task 3: Make grading, candidate lines, and market keys prop-aware

**Files:**
- Create: `packages/pipeline/src/props.ts`
- Modify: `packages/pipeline/src/project/backfill.ts:6-9` (candidate lines), `:38-56` (eval query and grading)
- Modify: `packages/pipeline/src/market/lines.ts:7-11` (prop type and market keys), `:253-267` (settlement query and grading)

**Interfaces:**
- Consumes from Task 2: `ALL_PROPS`, `PropKind` from `./project/index.js`.
- Produces, exported from `packages/pipeline/src/props.ts`:
  - `interface BoxScore { tb: number | null; h: number | null; hr: number | null; so: number | null }`
  - `actualFor(prop: string, box: BoxScore): number | null`

**This is the task that prevents a silent data-corruption bug.** Both `backfill.ts:55` and `lines.ts:266` currently read:

```ts
const actual = r.prop_type === 'total_bases' ? r.tb : r.so;
```

Every prop that is not `total_bases` falls to `: so`. With Task 2 landed, a batter's **hits** would be graded against a **pitcher's strikeout count** — producing confident, entirely wrong calibration and settlement rows. Task 2 must not be considered shippable without this task.

- [ ] **Step 1: Create the shared outcome lookup**

Create `packages/pipeline/src/props.ts`:

```ts
// Which box-score column a prop is graded against.
//
// Both the backfill evaluator and pick settlement read actual outcomes through
// this one function, so a prop can never be graded against the wrong stat.
// This replaced a `prop === 'total_bases' ? tb : so` ternary that was
// duplicated in both places and would have graded a batter's hits against a
// pitcher's strikeouts.
//
// Unknown props return null -- fail CLOSED. A prop added without updating this
// map produces no grade at all, which is visible as missing rows, rather than a
// wrong grade, which looks like real data.
export interface BoxScore {
  tb: number | null;
  h: number | null;
  hr: number | null;
  so: number | null;
}

export function actualFor(prop: string, box: BoxScore): number | null {
  switch (prop) {
    case 'total_bases': return box.tb;
    case 'hits':        return box.h;
    case 'home_runs':   return box.hr;
    case 'strikeouts':  return box.so;
    default:            return null;
  }
}
```

- [ ] **Step 2: Add candidate lines for the new props**

In `packages/pipeline/src/project/backfill.ts`, replace the `CANDIDATE_LINES` block at lines 6-9:

```ts
const CANDIDATE_LINES: Record<PropKind, number[]> = {
  total_bases: [0.5, 1.5, 2.5, 3.5],
  strikeouts: [3.5, 4.5, 5.5, 6.5, 7.5, 8.5],
};
```

with:

```ts
const CANDIDATE_LINES: Record<PropKind, number[]> = {
  total_bases: [0.5, 1.5, 2.5, 3.5],
  hits: [0.5, 1.5, 2.5],
  home_runs: [0.5],   // HR props realistically trade only at 0.5
  strikeouts: [3.5, 4.5, 5.5, 6.5, 7.5, 8.5],
};
```

The `Record<PropKind, number[]>` type makes this exhaustive: if a prop is missing, `npm run typecheck` fails rather than the prop silently getting no evals.

- [ ] **Step 3: Grade backfill evals against the right column**

In `packages/pipeline/src/project/backfill.ts`, add the import at the top of the file, after the existing imports:

```ts
import { actualFor } from '../props.js';
```

Change the eval query's row type (currently lines 39-42) to add `h` and `hr`:

```ts
      await query<{
        player_id: number; game_id: number; prop_type: PropKind;
        proj_mean: string; proj_stdev: string | null; dist: number[] | null;
        tb: number | null; h: number | null; hr: number | null; so: number | null;
      }>(
```

Change the SELECT list (line 43) from:

```ts
        `SELECT p.player_id, p.game_id, p.prop_type, p.proj_mean, p.proj_stdev, p.dist, b.tb, ps.so
```

to:

```ts
        `SELECT p.player_id, p.game_id, p.prop_type, p.proj_mean, p.proj_stdev, p.dist,
                b.tb, b.h, b.hr, ps.so
```

Then replace the grading line (line 55):

```ts
        const actual = r.prop_type === 'total_bases' ? r.tb : r.so;
```

with:

```ts
        const actual = actualFor(r.prop_type, r);
```

- [ ] **Step 4: Add the new market keys**

In `packages/pipeline/src/market/lines.ts`, replace lines 7-11:

```ts
type Prop = 'total_bases' | 'strikeouts';
const MARKET_TO_PROP: Record<string, Prop> = {
  batter_total_bases: 'total_bases',
  pitcher_strikeouts: 'strikeouts',
};
```

with:

```ts
import type { PropKind } from '../project/index.js';

const MARKET_TO_PROP: Record<string, PropKind> = {
  batter_total_bases: 'total_bases',
  batter_hits: 'hits',
  batter_home_runs: 'home_runs',
  pitcher_strikeouts: 'strikeouts',
};
```

Move that `import type` line up with the other imports at the top of the file rather than leaving it mid-file. Then replace every remaining use of the now-deleted local type name `Prop` in this file with `PropKind` — find them with:

```bash
grep -n '\bProp\b' packages/pipeline/src/market/lines.ts
```

- [ ] **Step 5: Grade settlement against the right column**

In `packages/pipeline/src/market/lines.ts`, add `actualFor` to the imports at the top:

```ts
import { actualFor } from '../props.js';
```

In `settleResults`, change the row type (line 253) to add `h` and `hr`:

```ts
    await query<{ id: number; prop_type: string; side: 'over' | 'under'; pick_line: string; tb: number | null; h: number | null; hr: number | null; so: number | null }>(
```

Change the SELECT list (line 254) from:

```ts
      `SELECT pk.id, pk.prop_type, pk.side, pk.pick_line, b.tb, ps.so
```

to:

```ts
      `SELECT pk.id, pk.prop_type, pk.side, pk.pick_line, b.tb, b.h, b.hr, ps.so
```

Then replace the grading line (line 266):

```ts
      const actual = r.prop_type === 'total_bases' ? r.tb : r.so;
```

with:

```ts
      const actual = actualFor(r.prop_type, r);
```

- [ ] **Step 6: Confirm the ternary is gone everywhere**

```bash
grep -rn "prop_type === 'total_bases'" packages/pipeline/src/
```

Expected: **no output.** Any remaining hit is an ungraded copy of the bug.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`

Expected: exits 0. If `CANDIDATE_LINES` errors with a missing property, Step 2 was skipped.

- [ ] **Step 8: Verify grading reads the correct column**

This is the critical check of the whole task. Run a backfill over a date with finished games, then confirm each eval's stored `actual` matches the real box score for that prop:

```bash
npm run backfill -- --from 2026-09-11 --to 2026-09-11
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT e.prop_type,
          count(*) AS evals,
          count(*) FILTER (WHERE e.prop_type='total_bases' AND e.actual IS DISTINCT FROM b.tb) AS bad_tb,
          count(*) FILTER (WHERE e.prop_type='hits'        AND e.actual IS DISTINCT FROM b.h)  AS bad_h,
          count(*) FILTER (WHERE e.prop_type='home_runs'   AND e.actual IS DISTINCT FROM b.hr) AS bad_hr,
          count(*) FILTER (WHERE e.prop_type='strikeouts'  AND e.actual IS DISTINCT FROM ps.so) AS bad_so
   FROM model_evals e
   JOIN games g ON g.id = e.game_id
   LEFT JOIN player_game_batting  b  ON b.game_id  = e.game_id AND b.player_id  = e.player_id
   LEFT JOIN player_game_pitching ps ON ps.game_id = e.game_id AND ps.player_id = e.player_id
   WHERE g.game_date='2026-09-11' AND e.model_version='tb-so-v0.2'
   GROUP BY 1 ORDER BY 1;"
```

Expected: every `bad_*` column is **0** on every row, with non-zero `evals`. A non-zero `bad_h` would mean hits are still being graded against strikeouts.

If `evals` is 0 for all props, that date has no games with `status ILIKE '%final%'` — find one that does and rerun:

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -c \
  "SELECT game_date, count(*) FROM games WHERE status ILIKE '%final%' GROUP BY 1 ORDER BY 1 DESC LIMIT 5;"
```

- [ ] **Step 9: Read the calibration for the new props**

```bash
npm run backtest
```

Expected: the report now includes `hits` and `home_runs` alongside `total_bases` and `strikeouts`. Record the reliability/ECE figures for the two new props in your report.

**This is the actual deliverable of the whole plan** — whether these props are calibrated, not whether they compute. Report the numbers as they are. Per the spec, `home_runs` is expected to calibrate worse than `hits`; if it does, that is an honest finding to report, **not** a signal to tune anything. Do not adjust factors, shrinkage, or candidate lines in response to what you see.

- [ ] **Step 10: Commit**

```bash
git add packages/pipeline/src/props.ts \
        packages/pipeline/src/project/backfill.ts \
        packages/pipeline/src/market/lines.ts
git commit -m "Grade props against their own box-score column

Replaces two copies of a 'total_bases ? tb : so' ternary that would
have graded batter hits against a pitcher's strikeouts. Unknown props
now fail closed. Adds hits/home_runs market keys and candidate lines."
```

---

## Verification summary (run after all three tasks)

```bash
npm run typecheck                                    # exits 0
grep -rn "prop_type === 'total_bases'" packages/pipeline/src/   # no output
diff /tmp/tb-before.txt /tmp/tb-after2.txt           # no output
```

**Deferred to implementation time:** the odds-api market keys `batter_hits` and `batter_home_runs` are unverified against the live API, because confirming costs free-tier quota. Before concluding that a zero-line `lines pull` is a name-matching bug, check the keys against the-odds-api MLB player-props documentation.

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| `hits` = Bernoulli(q1+q2+q3+q4) | Task 1, Step 2 |
| `home_runs` = Bernoulli(q4) | Task 1, Step 2 |
| `batterPerPaRates` extraction | Task 1, Step 2 |
| Byte-identical gate | Task 1 Steps 1/4, Task 2 Step 7 |
| `MODEL_VERSION` unchanged | Global Constraints (no step modifies it) |
| Batter block serves all batter props, no duplicate passes | Task 2, Step 3 |
| `ALL_PROPS` / derived `PropKind` | Task 2, Step 1 |
| Duplicated CLI whitelist collapsed | Task 2, Step 4 |
| Grading ternary replaced, fails closed | Task 3, Steps 1/3/5/6 |
| `MARKET_TO_PROP` new keys | Task 3, Step 4 |
| `CANDIDATE_LINES` new entries | Task 3, Step 2 |
| No migration | Global Constraints |
| HR limitation documented, not tuned | Task 1 Step 2 comment; Task 3 Step 9 |
| Backtest is the real deliverable | Task 3, Step 9 |
| Odds-api keys unverified | Verification summary |
| RBI excluded | Global Constraints |

No spec requirement is without a task.

**Placeholder scan:** no TBDs, no "handle edge cases", no "similar to Task N". Every code step carries complete code; every command step carries an exact command and an exact expected result, including what to do when a check fails.

**Type consistency:**
- `batterPerPaRates(hist, league, adj)` — defined Task 1 Step 2, called three times in that same step. Returns `{q0,q1,q2,q3,q4}`; `projectHits` destructures `q1..q4`, `projectHomeRuns` destructures `q4`, `projectTotalBases` destructures all five. Consistent.
- `ALL_PROPS` / `PropKind` — defined Task 2 Step 1; consumed by `parseProps` (Task 2 Step 4), `CANDIDATE_LINES`'s `Record<PropKind, number[]>` (Task 3 Step 2), and `MARKET_TO_PROP`'s `Record<string, PropKind>` (Task 3 Step 4).
- `actualFor(prop, box)` / `BoxScore` — defined Task 3 Step 1; called in Task 3 Steps 3 and 5. Both call sites pass a row carrying `tb`, `h`, `hr`, `so`, which structurally satisfies `BoxScore` — and Steps 3 and 5 each add `h`/`hr` to their row type and SELECT list so this holds.
- The three projectors share one argument shape `{ hist, league, expPa, adj }`, which is what lets Task 2 Step 3 build `a` once and pass it to whichever projector the prop selects.

One ordering dependency worth stating plainly: **Task 3 must land before anything runs `settle` or `backfill` against real data with Task 2 in place.** Between Task 2 and Task 3 the repo is in a state where `hits` and `home_runs` projections exist but would be graded against strikeouts. The commits are sequenced so this window is never pushed.
