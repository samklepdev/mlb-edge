# Advantage Significance Threshold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the team-backtest resolution check's bare sign test with a
three-state verdict backed by a game-clustered confidence interval, so neither a
noisy negative advantage nor a near-zero positive one reads as a finding.

**Architecture:** All statistics move into a new pure module
(`packages/db/src/resolution.ts`) that turns sufficient statistics into a
`ResolutionCheck`. A new query (`teamResolution()`) does nothing but aggregate
those sufficient statistics in SQL, clustered by `game_id`. The report layer only
formats. This is forced, not cosmetic: the current code computes the base rate in
the presentation layer from reliability buckets, and buckets carry no `game_id`,
so clustering is impossible where the code sits today.

**Tech Stack:** TypeScript, npm workspaces, Postgres (`pg`), `tsx`, `commander`.

**Spec:** `docs/superpowers/specs/2026-09-13-advantage-significance-design.md`

## Global Constraints

- **`packages/db` runs from compiled `dist/`, not source.** After ANY edit to
  that package run `npm run build:db` or the change is invisible at runtime.
- **Do NOT bump `TEAM_MODEL_VERSION`.** This changes no model output, and
  `max(model_version)` is a lexicographic comparison — bumping would strand all
  16,485 existing eval rows.
- **No re-backfill and no migration.** This is a read-path change only.
- **No new dependencies.** The repo has no test runner (no vitest/jest, zero
  `*.test.ts`), and adding one is explicitly out of scope per the spec. Red/green
  verification uses `node:assert` scripts run under `tsx`.
- **`MIN_GAMES = 30`** — the cluster-count floor below which the verdict is
  `insufficient`.
- **t-table bottoms out at `1.980`, never `1.960`.** A `1.960` row would be
  anti-conservative (`t(0.975, 200) = 1.972 > 1.960`). Holding `1.980` for all
  `df >= 120` stays conservative everywhere.
- **Verdict strings are exact:** `BEATS THE BASE RATE`,
  `WORSE THAN THE BASE RATE`, `INDISTINGUISHABLE FROM THE BASE RATE`,
  `INSUFFICIENT DATA`.
- **Verification checks are COMMITTED**, at
  `packages/pipeline/src/backtest/verifyResolution.ts`, exposed as the CLI
  command `verify-resolution` and the root npm script `verify:resolution`. They
  use `node:assert` and the `tsx` already in the repo, so no dependency is
  added. This **supersedes the spec's "throwaway tsx script" wording** (decided
  before execution): once the scripts are deleted nothing executable checks the
  clustering algebra or the t-table's conservatism, and the oracle numbers would
  survive only in prose. Run with `npm run verify:resolution`.
- **An assertion failure must exit non-zero.** `node:assert` throws, and the CLI
  action must not swallow it.

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/resolution.ts` (create) | Pure math: t lookup, sufficient stats → `ResolutionCheck`. No DB, no I/O. |
| `packages/db/src/types.ts` (modify) | Add `ResolutionVerdict`, `ResolutionStats`, `ResolutionCheck`. Auto-exported via `export * from './types.js'`. |
| `packages/db/src/queries/teamBacktest.ts` (modify) | Add `teamResolution()`: one SQL aggregate → `resolutionFromStats()`. |
| `packages/db/src/index.ts` (modify) | Export `teamResolution`, `resolutionFromStats`, `tCritical`, `MIN_GAMES`. |
| `packages/pipeline/src/backtest/teamReport.ts` (modify) | Formatting only. Replace `printResolutionLine`, add game count to headers, extend the "How to read this" bullet. |
| `packages/pipeline/src/backtest/verifyResolution.ts` (create) | Committed executable checks: pure invariants (Task 1) and DB oracles (Task 2). Exports `verifyResolution()`. |
| `packages/pipeline/src/cli.ts` (modify) | Register the `verify-resolution` command (pattern: the `team-backtest` block at lines 336-341). |
| `package.json` (modify) | Add the `verify:resolution` root script next to `team-backtest`. |

`BacktestSummary` is deliberately **not** touched — it is shared with the prop
model (`queries/backtest.ts:40`, `backtest/report.ts:14`), so team-only fields
would leak there and be `null` forever.

---

### Task 1: Pure resolution statistics

**Files:**
- Create: `packages/db/src/resolution.ts`
- Modify: `packages/db/src/types.ts` (append after `BacktestSummary`, currently ends line 80)
- Modify: `packages/db/src/index.ts` (append a new export line)
- Test: `packages/pipeline/src/backtest/verifyResolution.ts` (create, committed)
- Modify: `packages/pipeline/src/cli.ts` (register `verify-resolution`)
- Modify: `package.json` (add the `verify:resolution` script)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `MIN_GAMES: number` (= 30)
  - `tCritical(df: number): number`
  - `resolutionFromStats(s: ResolutionStats): ResolutionCheck`
  - types `ResolutionVerdict`, `ResolutionStats`, `ResolutionCheck` (shapes below)

- [ ] **Step 1: Add the types**

Append to `packages/db/src/types.ts`:

```ts
export type ResolutionVerdict = 'beats' | 'worse' | 'indistinguishable' | 'insufficient';

// Sufficient statistics for the game-clustered advantage test. One row per
// market, aggregated in SQL; everything else is derived purely from these.
// D_g = sum of per-eval differences d_i within game g; n_g = evals in game g.
export interface ResolutionStats {
  n: number;                  // evals
  games: number;              // clusters (distinct game_id)
  baseRate: number | null;    // mean(hit)
  modelBrier: number | null;  // mean((p - y)^2)
  sumDg: number;              // sum of D_g
  sumDg2: number;             // sum of D_g^2
  sumNgDg: number;            // sum of n_g * D_g
  sumNg2: number;             // sum of n_g^2
}

export interface ResolutionCheck {
  n: number;
  games: number;
  baseRate: number | null;
  baseRateBrier: number | null;  // r*(1-r)
  modelBrier: number | null;
  advantage: number | null;      // baseRateBrier - modelBrier
  se: number | null;             // clustered by game
  ciLo: number | null;
  ciHi: number | null;
  skillScore: number | null;     // advantage / baseRateBrier
  verdict: ResolutionVerdict;
}
```

- [ ] **Step 2: Write the failing verification script**

Create `packages/pipeline/src/backtest/verifyResolution.ts`. Task 2 appends a
`verifyQuery()` to this same file, so keep `verifyResolution()` as the single
entry point that calls each check group in turn:

```ts
import assert from 'node:assert/strict';
import { resolutionFromStats, tCritical, MIN_GAMES } from '@mlb-edge/db';
import type { ResolutionStats } from '@mlb-edge/db';

// Executable checks for the resolution statistics. Committed rather than
// throwaway: these are the only thing that verifies the game-clustering
// algebra and the t-table's conservatism, and the expected values below are
// an independent SQL derivation (see the plan/spec), not a snapshot of
// whatever the code happens to produce.
//
// Run: npm run verify:resolution

// --- helpers -------------------------------------------------------------
// Build sufficient statistics from raw (game, d) pairs, the way SQL will.
function statsFrom(evals: { game: number; d: number }[], baseRate = 0.5, modelBrier = 0.24): ResolutionStats {
  const byGame = new Map<number, { dg: number; ng: number }>();
  for (const e of evals) {
    const cur = byGame.get(e.game) ?? { dg: 0, ng: 0 };
    byGame.set(e.game, { dg: cur.dg + e.d, ng: cur.ng + 1 });
  }
  let sumDg = 0, sumDg2 = 0, sumNgDg = 0, sumNg2 = 0;
  for (const { dg, ng } of byGame.values()) {
    sumDg += dg; sumDg2 += dg * dg; sumNgDg += ng * dg; sumNg2 += ng * ng;
  }
  return { n: evals.length, games: byGame.size, baseRate, modelBrier, sumDg, sumDg2, sumNgDg, sumNg2 };
}

// Two-pass reference implementation, straight from the definition.
function referenceSe(evals: { game: number; d: number }[]): { a: number; se: number } {
  const n = evals.length;
  const a = evals.reduce((s, e) => s + e.d, 0) / n;
  const centered = new Map<number, number>();
  for (const e of evals) centered.set(e.game, (centered.get(e.game) ?? 0) + (e.d - a));
  let ssq = 0;
  for (const s of centered.values()) ssq += s * s;
  const g = centered.size;
  return { a, se: Math.sqrt((g / (g - 1)) * ssq) / n };
}

// Deterministic pseudo-random so runs are reproducible. MINSTD: the multiplier
// is small enough that seed * 48271 stays under 2^53, so no precision is lost.
let seed = 12345;
function rnd(): number {
  seed = (seed * 48271) % 2147483647;
  return seed / 2147483647;
}

// Pure invariants: no database, no I/O.
function verifyPure(): void {
  // --- 1. t lookup -------------------------------------------------------
  assert.equal(tCritical(29), 2.045, 't(29)');
  assert.equal(tCritical(39), 2.045, 'df below the 40 breakpoint keeps the 29 row');
  assert.equal(tCritical(40), 2.021, 't(40)');
  assert.equal(tCritical(50), 2.021, 'df=50 rounds down to the 40 row');
  assert.equal(tCritical(60), 2.0, 't(60)');
  assert.equal(tCritical(120), 1.98, 't(120)');
  assert.equal(tCritical(100000), 1.98, 'never drops to the anti-conservative 1.960');
  for (const df of [29, 40, 50, 60, 120, 500, 100000]) {
    assert.ok(tCritical(df) >= 1.98, `t must stay conservative at df=${df}`);
  }

  // --- 2. one-pass SE equals the two-pass reference ----------------------
  // Multi-eval games (the `total` shape: 4 evals per game).
  const clustered = Array.from({ length: 200 * 4 }, (_, i) => ({ game: Math.floor(i / 4), d: rnd() - 0.5 }));
  {
    const ref = referenceSe(clustered);
    const got = resolutionFromStats(statsFrom(clustered));
    assert.ok(Math.abs(got.advantage! - ref.a) < 1e-12, `advantage ${got.advantage} vs ${ref.a}`);
    assert.ok(Math.abs(got.se! - ref.se) < 1e-12, `clustered se ${got.se} vs ${ref.se}`);
  }

  // --- 3. with one eval per game, clustered SE == naive SE exactly -------
  const unclustered = Array.from({ length: 400 }, (_, i) => ({ game: i, d: rnd() - 0.5 }));
  {
    const n = unclustered.length;
    const a = unclustered.reduce((s, e) => s + e.d, 0) / n;
    const ss = unclustered.reduce((s, e) => s + (e.d - a) ** 2, 0);
    const naiveSe = Math.sqrt(ss / (n - 1)) / Math.sqrt(n);
    const got = resolutionFromStats(statsFrom(unclustered));
    assert.ok(Math.abs(got.se! - naiveSe) < 1e-12, `n_g=1 must reduce to naive se: ${got.se} vs ${naiveSe}`);
  }

  // --- 4. verdicts -------------------------------------------------------
  // Advantage far above zero -> beats.
  const strong = Array.from({ length: 100 }, (_, i) => ({ game: i, d: 0.05 + (rnd() - 0.5) * 0.01 }));
  assert.equal(resolutionFromStats(statsFrom(strong)).verdict, 'beats', 'large positive advantage');

  // Mirror image -> worse.
  const weak = strong.map((e) => ({ game: e.game, d: -e.d }));
  assert.equal(resolutionFromStats(statsFrom(weak)).verdict, 'worse', 'large negative advantage');

  // Noise centred on zero -> indistinguishable (the default).
  // Built as mirrored +/- pairs so the mean is EXACTLY zero. Do not replace
  // this with unpaired random draws: the advantage would then be a random
  // variable and the assertion would fire on roughly 5% of seeds.
  const mags = Array.from({ length: 50 }, () => 0.05 + (rnd() - 0.5) * 0.02);
  const noise = mags.flatMap((m, i) => [
    { game: 2 * i, d: m },
    { game: 2 * i + 1, d: -m },
  ]);
  assert.equal(resolutionFromStats(statsFrom(noise)).verdict, 'indistinguishable', 'noise must not read as a finding');

  // --- 5. guards ---------------------------------------------------------
  const zero: ResolutionStats = {
    n: 0, games: 0, baseRate: null, modelBrier: null,
    sumDg: 0, sumDg2: 0, sumNgDg: 0, sumNg2: 0,
  };
  assert.equal(resolutionFromStats(zero).verdict, 'insufficient', 'no evaluations');
  assert.equal(resolutionFromStats(zero).advantage, null, 'no advantage without evaluations');

  // G below the floor, with an otherwise screamingly significant advantage.
  // The jitter is load-bearing: with every d identical the SE would be 0 and
  // this would pass via the zero-variance guard instead of the cluster-count one.
  const tooFew = Array.from({ length: MIN_GAMES - 1 }, (_, i) => ({ game: i, d: 0.05 + (rnd() - 0.5) * 0.01 }));
  assert.ok(resolutionFromStats(statsFrom(tooFew)).se! > 0, 'tooFew must have non-zero spread to isolate the G guard');
  assert.equal(resolutionFromStats(statsFrom(tooFew)).verdict, 'insufficient', `G < ${MIN_GAMES}`);
  const atFloor = Array.from({ length: MIN_GAMES }, (_, i) => ({ game: i, d: 0.05 + (rnd() - 0.5) * 0.01 }));
  assert.equal(resolutionFromStats(statsFrom(atFloor)).verdict, 'beats', `G == ${MIN_GAMES} is allowed`);

  // SE == 0: every d identical, so there is no spread to test.
  const flat = Array.from({ length: 100 }, (_, i) => ({ game: i, d: 0.02 }));
  assert.equal(resolutionFromStats(statsFrom(flat)).verdict, 'insufficient', 'zero variance');

  // Degenerate base rates: baseRateBrier == 0, so the comparison is vacuous.
  for (const r of [0, 1]) {
    const got = resolutionFromStats(statsFrom(noise, r, 0.1));
    assert.equal(got.verdict, 'insufficient', `base rate ${r} is vacuous`);
    assert.equal(got.skillScore, null, `no skill score at base rate ${r}`);
  }

  // --- 6. derived fields -------------------------------------------------
  {
    const got = resolutionFromStats(statsFrom(strong, 0.5, 0.2));
    assert.equal(got.baseRateBrier, 0.25, 'r=0.5 -> r(1-r)=0.25');
    assert.ok(Math.abs(got.skillScore! - got.advantage! / 0.25) < 1e-12, 'skill score is advantage / baseRateBrier');
    assert.ok(got.ciLo! < got.advantage! && got.advantage! < got.ciHi!, 'advantage sits inside its interval');
  }

  console.log('PURE CHECKS PASSED');
}

// Entry point for the `verify-resolution` CLI command. Task 2 adds a
// verifyQuery() call here; keep this the single place that sequences the
// check groups.
export async function verifyResolution(): Promise<void> {
  verifyPure();
}
```

Note the `rnd()` state is module-level, so `verifyPure()` is deterministic only
on a fresh process — which is how the CLI runs it. Do not call it twice in one
process and expect identical draws.

- [ ] **Step 3: Wire the CLI command and npm script**

In `packages/pipeline/src/cli.ts`, add to the imports at the top:

```ts
import { verifyResolution } from './backtest/verifyResolution.js';
```

and register the command immediately after the existing `team-backtest` block
(lines 336-341), following that same shape:

```ts
program
  .command('verify-resolution')
  .description('run the resolution-statistics checks (pure invariants + DB oracles)')
  .action(async () => {
    await verifyResolution();
  });
```

In the root `package.json`, add this script directly after `"team-backtest"`:

```json
    "verify:resolution": "npm run -w @mlb-edge/pipeline cli -- verify-resolution",
```

Do not wrap the action in a try/catch — an assertion failure must propagate and
exit non-zero.

- [ ] **Step 4: Run it to confirm it fails**

```bash
npm run build:db && npm run verify:resolution
```

Expected: failure. `resolutionFromStats` does not exist yet, so this dies with
`SyntaxError: The requested module '@mlb-edge/db' does not provide an export
named 'resolutionFromStats'` (or a TS resolution error), and a non-zero exit
code. It must NOT print `PURE CHECKS PASSED`.

- [ ] **Step 5: Implement the pure module**

Create `packages/db/src/resolution.ts`:

```ts
import type { ResolutionStats, ResolutionCheck } from './types.js';

// Cluster-count floor. Cluster-robust standard errors are sharply
// downward-biased with few clusters, so below this the interval would be
// fake-narrow exactly where the data is thinnest. A pre-registered floor, not a
// tunable knob.
export const MIN_GAMES = 30;

// t(0.975, df), as [df breakpoint, t] ascending by df.
//
// Selection rule: take the row with the largest breakpoint not exceeding df.
// t decreases with df, so this always returns a t at least as large as the true
// value -- the interval errs wide.
//
// The table bottoms out at 1.980 and deliberately has no 1.960 row: the true
// t(0.975, 200) is 1.972, so a 1.960 row would narrow the interval BELOW truth
// and break that guarantee. Holding 1.980 overstates the half-width by at most
// 1% as df -> infinity, which is the right direction to be wrong in.
const T_TABLE: ReadonlyArray<readonly [number, number]> = [
  [29, 2.045],
  [40, 2.021],
  [60, 2.0],
  [120, 1.98],
];

export function tCritical(df: number): number {
  let t = T_TABLE[0][1];
  for (const [breakpoint, value] of T_TABLE) {
    if (df >= breakpoint) t = value;
  }
  return t;
}

// Turn one market's sufficient statistics into the advantage, its
// game-clustered interval, and a three-state verdict.
//
// The advantage is baseRateBrier - modelBrier, where baseRateBrier = r(1-r) is
// the Brier score of always predicting the market's own hit rate. Positive means
// the model beats that no-information baseline.
//
// INDISTINGUISHABLE is the default: both BEATS and WORSE must earn significance.
// A bare sign test on this quantity reports noise as a finding in both
// directions.
export function resolutionFromStats(s: ResolutionStats): ResolutionCheck {
  const { n, games, baseRate, modelBrier, sumDg, sumDg2, sumNgDg, sumNg2 } = s;

  const baseRateBrier = baseRate == null ? null : baseRate * (1 - baseRate);
  const advantage = n === 0 ? null : sumDg / n;

  let se: number | null = null;
  if (advantage != null && games >= 2) {
    // With S_g = D_g - n_g*A, the clustered variance needs sum(S_g^2). Expanding
    // lets SQL supply the four sums and skips a second pass over the rows:
    //   sum(S_g^2) = sum(D_g^2) - 2A*sum(n_g*D_g) + A^2*sum(n_g^2)
    const ssq = sumDg2 - 2 * advantage * sumNgDg + advantage * advantage * sumNg2;
    // That expansion is a difference of large similar terms, so cancellation can
    // land a hair below zero when the true value is ~0. Clamp rather than NaN.
    se = Math.sqrt((games / (games - 1)) * Math.max(0, ssq)) / n;
  }

  const out: ResolutionCheck = {
    n,
    games,
    baseRate,
    baseRateBrier,
    modelBrier,
    advantage,
    se,
    ciLo: null,
    ciHi: null,
    skillScore: null,
    verdict: 'insufficient',
  };

  if (n === 0 || games < MIN_GAMES) return out;
  if (advantage == null || se == null || se === 0) return out;
  // r of exactly 0 or 1 makes baseRateBrier 0, so advantage = -modelBrier <= 0
  // by construction: the baseline is a perfect in-sample predictor and the
  // comparison is vacuous. Without this guard such a market prints a confident
  // WORSE.
  if (baseRate == null || baseRate === 0 || baseRate === 1) return out;
  if (baseRateBrier == null || baseRateBrier === 0) return out;

  const t = tCritical(games - 1);
  out.ciLo = advantage - t * se;
  out.ciHi = advantage + t * se;
  out.skillScore = advantage / baseRateBrier;
  out.verdict = out.ciLo > 0 ? 'beats' : out.ciHi < 0 ? 'worse' : 'indistinguishable';
  return out;
}
```

- [ ] **Step 6: Export it**

In `packages/db/src/index.ts`, add after the `prob.js` export line:

```ts
export { MIN_GAMES, tCritical, resolutionFromStats } from './resolution.js';
```

- [ ] **Step 7: Run the verification script to green**

```bash
npm run build:db && npm run verify:resolution
```

Expected: `PURE CHECKS PASSED` and exit code 0. If an assertion fires, the
message names the specific invariant — fix the implementation, not the assertion.

- [ ] **Step 8: Typecheck**

```bash
npm run typecheck
```

Expected: no output past the tsc invocations (clean).

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/resolution.ts packages/db/src/types.ts packages/db/src/index.ts \
  packages/pipeline/src/backtest/verifyResolution.ts packages/pipeline/src/cli.ts package.json
git commit -m "Add pure game-clustered resolution statistics

The advantage over a base-rate forecast needs a standard error clustered by
game, because team_model_evals holds up to 4 evals per game (one per candidate
line) scored against a single realized outcome. Add the pure math: a
conservative t lookup and sufficient-statistics -> ResolutionCheck, with
INDISTINGUISHABLE as the default verdict so neither direction can report noise
as a finding.

Ship the checks as a committed 'verify-resolution' command rather than
throwaway scaffolding: they are the only executable verification of the
clustering algebra and of the t table's deliberate refusal to drop to 1.960.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Run `git status --short` first and confirm only the six intended files are
staged.

---

### Task 2: The clustered query

**Files:**
- Modify: `packages/db/src/queries/teamBacktest.ts` (append after `teamEvalMarkets`, currently ends line 63)
- Modify: `packages/db/src/index.ts:11` (extend the existing `teamBacktest.js` export)
- Test: `packages/pipeline/src/backtest/verifyResolution.ts` (extend — created in Task 1)

**Interfaces:**
- Consumes: `resolutionFromStats(s: ResolutionStats): ResolutionCheck` and types
  `ResolutionStats` / `ResolutionCheck` from Task 1.
- Produces: `teamResolution(market?: string): Promise<ResolutionCheck>`

- [ ] **Step 1: Write the failing oracle script**

These expected values were computed independently in SQL during the design
session, by a different route (two-pass, using the literal
`(r-y)^2 - (p-y)^2`). The implementation uses the one-pass algebraic expansion,
so agreement is a genuine two-implementation cross-check.

Extend `packages/pipeline/src/backtest/verifyResolution.ts` (created in Task 1).
Add `teamResolution` and `pool` to its `@mlb-edge/db` import, add the
`verifyQuery` function below `verifyPure`, and add the call to
`verifyResolution()` so it reads:

```ts
export async function verifyResolution(): Promise<void> {
  verifyPure();
  await verifyQuery();
}
```

The new function — note it is NOT top-level code, and it does not call
`pool.end()`; the existing CLI commands (`team-backtest`) leave the pool alone
and the process exits cleanly:

```ts
// Oracle values from the design session's independent SQL, matched to 5 dp.
const EXPECTED = [
  { market: 'total', n: 9420, games: 2355, advantage: 0.00192, se: 0.00206, verdict: 'indistinguishable' },
  { market: 'run_line', n: 4710, games: 2355, advantage: 0.0194, se: 0.00207, verdict: 'beats' },
  { market: 'moneyline', n: 2355, games: 2355, advantage: -0.00213, se: 0.0022, verdict: 'indistinguishable' },
] as const;

const r5 = (x: number) => Number(x.toFixed(5));

async function verifyQuery(): Promise<void> {
  for (const e of EXPECTED) {
    const got = await teamResolution(e.market);
    assert.equal(got.n, e.n, `${e.market} n`);
    assert.equal(got.games, e.games, `${e.market} games`);
    assert.equal(r5(got.advantage!), r5(e.advantage), `${e.market} advantage: got ${got.advantage}`);
    assert.equal(r5(got.se!), r5(e.se), `${e.market} clustered se: got ${got.se}`);
    assert.equal(got.verdict, e.verdict, `${e.market} verdict: got ${got.verdict}`);
    assert.ok(got.ciLo! < got.ciHi!, `${e.market} interval ordering`);
    console.log(`${e.market}: advantage ${got.advantage!.toFixed(5)} se ${got.se!.toFixed(5)} -> ${got.verdict}`);
  }

  // moneyline has exactly one eval per game, so clustering is a no-op and the
  // clustered SE must reduce EXACTLY to the naive SE. This is an algebraic
  // identity, not an approximation -- see the spec. Recompute the naive SE from
  // raw rows here so the check does not depend on the query's own clustering.
  {
    const ml = await teamResolution('moneyline');
    assert.equal(ml.n, ml.games, 'moneyline must be one eval per game for this check to mean anything');
    const rows = (
      await pool.query<{ p: number; y: number; r: number }>(
        `WITH e AS (
           SELECT model_prob::float8 AS p, (hit)::int AS y
           FROM team_model_evals
           WHERE model_version = (SELECT max(model_version) FROM team_model_evals)
             AND market = 'moneyline'
         )
         SELECT p, y, (SELECT avg(y)::float8 FROM e) AS r FROM e`,
      )
    ).rows;
    const r = Number(rows[0].r);
    const d = rows.map((row) => (r - row.y) ** 2 - (Number(row.p) - row.y) ** 2);
    const n = d.length;
    const a = d.reduce((s, x) => s + x, 0) / n;
    const naiveSe = Math.sqrt(d.reduce((s, x) => s + (x - a) ** 2, 0) / (n - 1)) / Math.sqrt(n);
    assert.ok(Math.abs(ml.se! - naiveSe) < 1e-12, `n_g=1 identity: clustered ${ml.se} vs naive ${naiveSe}`);
    assert.ok(Math.abs(ml.advantage! - a) < 1e-12, `advantage from raw rows: ${ml.advantage} vs ${a}`);
    console.log('n_g=1 identity holds exactly');
  }

  // The unfiltered call pools every market; it must at least aggregate cleanly.
  {
    const all = await teamResolution();
    assert.equal(all.n, 9420 + 4710 + 2355, 'pooled n');
    assert.equal(all.games, 2355, 'pooled games');
    console.log(`pooled: n=${all.n} games=${all.games}`);
  }

  console.log('QUERY CHECKS PASSED');
}
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
docker compose up -d && npm run build:db && npm run verify:resolution
```

Expected: failure — no export named `teamResolution`, and a non-zero exit code.
`PURE CHECKS PASSED` may still print (Task 1's checks are intact); it must NOT
print `QUERY CHECKS PASSED`.

- [ ] **Step 3: Implement the query**

First fix the imports at the top of `packages/db/src/queries/teamBacktest.ts`.
Line 2 currently reads:

```ts
import type { ReliabilityBucket, BacktestSummary } from '../types.js';
```

Extend that existing line rather than adding a second type import from the same
module, and add the value import below it:

```ts
import type { ReliabilityBucket, BacktestSummary, ResolutionCheck } from '../types.js';
import { resolutionFromStats } from '../resolution.js';
```

Then append the function to the end of the file:

```ts
// Does this market's model beat simply predicting the market's own base rate?
//
// Clustered by game_id, which is not optional here: team_model_evals is unique
// on (game_id, team_id, market, line, model_version), so one game contributes 4
// `total` evals (four candidate lines), 2 `run_line`, and 1 `moneyline` -- all
// scored against a single realized outcome. Treating those as independent
// misstates the standard error, and not in a predictable direction: clustering
// inflates `total`'s SE 1.46x but shrinks `run_line`'s to 0.88x, because the two
// sides' errors offset within a game.
//
// Returns sufficient statistics only; all arithmetic lives in resolution.ts so
// it is exercisable without a database.
export async function teamResolution(market?: string): Promise<ResolutionCheck> {
  const params: string[] = [];
  let where = "me.model_version = (SELECT max(model_version) FROM team_model_evals)";
  if (market) {
    params.push(market);
    where += ` AND me.market = $${params.length}`;
  }
  const res = await query<{
    n: string;
    games: string;
    base_rate: number | null;
    model_brier: number | null;
    sum_dg: number;
    sum_dg2: number;
    sum_ng_dg: number;
    sum_ng2: number;
  }>(
    `WITH e AS (
       SELECT me.game_id, me.model_prob::float8 AS p, (me.hit)::int AS y
       FROM team_model_evals me WHERE ${where}
     ),
     agg AS (
       SELECT count(*)::int8               AS n,
              count(DISTINCT game_id)::int8 AS games,
              avg(y)::float8                AS base_rate,
              avg(power(p - y, 2))::float8  AS model_brier
       FROM e
     ),
     -- d_i = (r - y_i)^2 - (p_i - y_i)^2, expanded using y^2 = y for y in {0,1}
     -- so it is a single arithmetic expression over the joined base rate.
     d AS (
       SELECT e.game_id,
              (agg.base_rate * agg.base_rate
                 - 2 * agg.base_rate * e.y
                 - e.p * e.p
                 + 2 * e.p * e.y)::float8 AS di
       FROM e CROSS JOIN agg
     ),
     per_game AS (
       SELECT game_id, sum(di)::float8 AS dg, count(*)::float8 AS ng
       FROM d GROUP BY game_id
     )
     SELECT agg.n::text AS n,
            agg.games::text AS games,
            agg.base_rate,
            agg.model_brier,
            coalesce(sum(pg.dg), 0)::float8         AS sum_dg,
            coalesce(sum(pg.dg * pg.dg), 0)::float8 AS sum_dg2,
            coalesce(sum(pg.ng * pg.dg), 0)::float8 AS sum_ng_dg,
            coalesce(sum(pg.ng * pg.ng), 0)::float8 AS sum_ng2
     FROM agg LEFT JOIN per_game pg ON true
     GROUP BY agg.n, agg.games, agg.base_rate, agg.model_brier`,
    params,
  );
  const row = res.rows[0];
  if (!row) {
    return resolutionFromStats({
      n: 0, games: 0, baseRate: null, modelBrier: null,
      sumDg: 0, sumDg2: 0, sumNgDg: 0, sumNg2: 0,
    });
  }
  return resolutionFromStats({
    n: Number(row.n),
    games: Number(row.games),
    baseRate: row.base_rate == null ? null : Number(row.base_rate),
    modelBrier: row.model_brier == null ? null : Number(row.model_brier),
    sumDg: Number(row.sum_dg),
    sumDg2: Number(row.sum_dg2),
    sumNgDg: Number(row.sum_ng_dg),
    sumNg2: Number(row.sum_ng2),
  });
}
```

The `LEFT JOIN per_game ON true` matters: with no matching evals, `agg` still
yields one all-null row while `per_game` is empty, so the join keeps that row and
the `coalesce`s make the sums 0 — giving `n = 0` and an `insufficient` verdict
rather than an empty result set.

- [ ] **Step 4: Export it**

Change `packages/db/src/index.ts:11` to:

```ts
export { teamReliability, teamBacktestSummary, teamEvalMarkets, teamResolution } from './queries/teamBacktest.js';
```

- [ ] **Step 5: Run the verification script to green**

```bash
npm run build:db && npm run verify:resolution
```

Expected, exactly (after the `PURE CHECKS PASSED` line from Task 1):

```
total: advantage 0.00192 se 0.00206 -> indistinguishable
run_line: advantage 0.01940 se 0.00207 -> beats
moneyline: advantage -0.00213 se 0.00220 -> indistinguishable
n_g=1 identity holds exactly
pooled: n=16485 games=2355
QUERY CHECKS PASSED
```

If the advantage matches but the SE does not, the bug is in the `sum(S_g^2)`
expansion or the `G/(G-1)` factor — not in `d_i`.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/queries/teamBacktest.ts packages/db/src/index.ts \
  packages/pipeline/src/backtest/verifyResolution.ts
git commit -m "Add teamResolution(): game-clustered advantage over the base rate

One SQL aggregate yields the sufficient statistics (n, games, base rate, model
Brier, and the four per-game sums); resolution.ts does the arithmetic. Clustering
by game_id is required because one game contributes up to 4 evals scored against
a single realized outcome, and the correction does not move in one direction --
it inflates total's SE 1.46x and shrinks run_line's to 0.88x.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Report the verdict

**Files:**
- Modify: `packages/pipeline/src/backtest/teamReport.ts` (replace
  `printResolutionLine` at lines 19-39; update the loop at 56-63; extend the
  final bullet at 80-87)

**Interfaces:**
- Consumes: `teamResolution(market?: string): Promise<ResolutionCheck>` and
  `MIN_GAMES` from Tasks 1-2.
- Produces: terminal output only. No exported API changes.

- [ ] **Step 1: Replace the imports**

`packages/pipeline/src/backtest/teamReport.ts` lines 1-2 become:

```ts
import { teamReliability, teamBacktestSummary, teamEvalMarkets, teamResolution, MIN_GAMES } from '@mlb-edge/db';
import type { ReliabilityBucket, BacktestSummary, ResolutionCheck, ResolutionVerdict } from '@mlb-edge/db';
```

- [ ] **Step 2: Replace `printResolutionLine`**

Delete the whole existing `printResolutionLine` function (lines 19-39, including
its comment block) and put this in its place:

```ts
const VERDICT_TEXT: Record<ResolutionVerdict, string> = {
  beats: 'BEATS THE BASE RATE',
  worse: 'WORSE THAN THE BASE RATE',
  indistinguishable: 'INDISTINGUISHABLE FROM THE BASE RATE',
  insufficient: 'INSUFFICIENT DATA',
};

function signed(x: number, dp = 4): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(dp)}`;
}

// Resolution check: does the model separate likely games from unlikely ones, or
// does it just track the market's overall base rate? A model can be
// well-calibrated (good ECE) and still carry zero information. The base-rate
// Brier is what a model that always predicts the market's own hit rate scores;
// beating it -- significantly, clustered by game -- is the bar for "this model
// knows something."
function printResolution(r: ResolutionCheck): void {
  if (r.baseRateBrier == null || r.advantage == null || r.baseRate == null) {
    console.log('  base-rate Brier = n/a (no evaluations)');
    return;
  }
  console.log(
    `  base-rate Brier = ${r.baseRateBrier.toFixed(4)}  ` +
      `(predicting the ${(r.baseRate * 100).toFixed(1)}% base rate for every game)`,
  );

  if (r.ciLo == null || r.ciHi == null || r.skillScore == null) {
    console.log(`  model advantage = ${signed(r.advantage)}  (no interval)`);
    console.log(`  verdict         = ${VERDICT_TEXT.insufficient}`);
    console.log(`                    (needs ${MIN_GAMES}+ games and a non-degenerate base rate)`);
    return;
  }

  console.log(
    `  model advantage = ${signed(r.advantage)}  ` +
      `95% CI [${signed(r.ciLo)}, ${signed(r.ciHi)}]  (clustered by game)`,
  );
  console.log(`  skill score     = ${signed(r.skillScore * 100, 1)}%  (advantage / base-rate Brier)`);
  console.log(`  verdict         = ${VERDICT_TEXT[r.verdict]}${r.verdict === 'worse' ? '  <<<' : ''}`);
  if (r.verdict === 'indistinguishable') {
    console.log('                    (no evidence this market carries information)');
  }
}
```

- [ ] **Step 3: Rewire the per-market loop**

Replace the loop body (lines 56-63) with:

```ts
  for (const market of markets) {
    const [summary, buckets, resolution] = await Promise.all([
      teamBacktestSummary(market),
      teamReliability(10, market),
      teamResolution(market),
    ]);
    console.log(`-- ${market} (${summary.n} evaluations, ${resolution.games} games) --`);
    printSummaryLine(summary);
    printResolution(resolution);
    printBuckets(buckets);
    console.log('');
  }
```

- [ ] **Step 4: Extend the "How to read this" bullet**

Replace the final `console.log(...)` block (lines 80-87) with:

```ts
  console.log(
    '  * ECE measures CALIBRATION (do predicted probabilities match observed frequencies)\n' +
      '    -- it does not measure RESOLUTION (does the model separate likely games from\n' +
      "    unlikely ones). A model that always predicts a market's own base rate can score\n" +
      '    a fine ECE while carrying zero information. The base-rate Brier above is that\n' +
      '    no-information baseline.',
  );
  console.log(
    '  * The verdict is a SIGNIFICANCE TEST, not a sign test, and the interval is\n' +
      '    clustered by game -- one game contributes up to 4 evaluations (one per candidate\n' +
      '    line) scored against a single realized outcome, so treating them as independent\n' +
      '    would overstate precision. INDISTINGUISHABLE is the DEFAULT, not a soft pass: it\n' +
      '    means the data cannot tell this market apart from guessing the base rate. Both\n' +
      '    BEATS and WORSE have to be earned.',
  );
  console.log(
    '  * Three markets are tested here, which is a multiple-comparisons setting. No\n' +
      '    correction is applied: each market is pre-registered to be compared against\n' +
      '    ITSELF over time (see CLAUDE.md), and a Bonferroni bar of t ~ 2.39 would change\n' +
      '    no verdict at present. If a market ever lands just past the threshold, treat\n' +
      '    that as a hypothesis to re-test on a different date range, not a finding.',
  );
```

- [ ] **Step 5: Run the report**

```bash
npm run build:db && npm run team-backtest
```

Expected — `run_line` earns BEATS while the other two are downgraded from the
old silent-pass / loud-flag behaviour. These are **excerpts**: the `ECE` /
`Brier` lines and the reliability buckets still print as before and are elided
here. Match the lines shown.

```
-- total (9420 evaluations, 2355 games) --
  base-rate Brier = 0.2476  (predicting the 45.1% base rate for every game)
  model advantage = +0.0019  95% CI [-0.0022, +0.0060]  (clustered by game)
  skill score     = +0.8%  (advantage / base-rate Brier)
  verdict         = INDISTINGUISHABLE FROM THE BASE RATE
                    (no evidence this market carries information)

-- run_line (4710 evaluations, 2355 games) --
  model advantage = +0.0194  95% CI [+0.0153, +0.0235]  (clustered by game)
  skill score     = +7.8%  (advantage / base-rate Brier)
  verdict         = BEATS THE BASE RATE

-- moneyline (2355 evaluations, 2355 games) --
  model advantage = -0.0021  95% CI [-0.0065, +0.0022]  (clustered by game)
  skill score     = -0.9%
  verdict         = INDISTINGUISHABLE FROM THE BASE RATE
                    (no evidence this market carries information)
```

Confirm specifically that the string `WORSE THAN GUESSING THE BASE RATE` no
longer appears anywhere:

```bash
npm run team-backtest 2>&1 | grep -c "WORSE THAN GUESSING"
```

Expected: `0`.

- [ ] **Step 6: Typecheck and re-run the committed checks**

```bash
npm run typecheck && npm run verify:resolution
```

Expected: typecheck clean, then `PURE CHECKS PASSED` and `QUERY CHECKS PASSED`.
This task only changes formatting, so the checks must still pass untouched — if
they fail, the report change reached further than it should have.

- [ ] **Step 7: Commit**

```bash
git add packages/pipeline/src/backtest/teamReport.ts
git commit -m "Report a clustered significance verdict, not a sign test

The old flag fired '<<< WORSE THAN GUESSING THE BASE RATE' on moneyline at
z = -0.97 and let total pass silently at z = 0.93 -- overclaiming in both
directions on the same report. Print each market's advantage with a 95% interval
clustered by game, a skill score as effect size, and a three-state verdict whose
default is INDISTINGUISHABLE. run_line beats the baseline; total and moneyline
are downgraded to no-evidence, which is the honest reading.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Confirm the tree is clean**

```bash
git status --short
```

Expected: empty. Every file this plan touches is committed by the end of Task 3;
nothing should be left untracked or modified.

---

## Notes for the implementer

- **`npm run verify:resolution` is the gate for this change.** It is committed
  on purpose (see Global Constraints) — do not convert it back to a throwaway
  script, and do not relax an assertion to make it pass.
- **`ResolutionCheck.games` is the cluster count**, not a row count. It drives
  both the `MIN_GAMES` guard and the t lookup. Do not substitute `n`.
- **Don't "fix" the conservative t table** by adding a 1.960 row for large df.
  That is a deliberate choice documented in both the spec and the source
  comment; see the Global Constraints.
- **Don't add resolution fields to `BacktestSummary`.** It is shared with the
  prop model.
- The three expected-value blocks (Task 2 Step 5, Task 3 Step 5) are the real
  regression oracle for this change. If they disagree with the implementation,
  the implementation is wrong until proven otherwise — the numbers came from an
  independent SQL derivation.
- If the DB has been re-backfilled since 2026-09-13, `n`/`games` will have moved
  and the oracle values will no longer apply. In that case, stop and report it
  rather than editing the expected numbers to match — silently relaxing the
  oracle destroys the only check on this math.
