# Advantage significance threshold for the team-backtest resolution check

**Date:** 2026-09-13
**Status:** design, approved
**Touches:** `packages/db/src/queries/teamBacktest.ts`, `packages/db/src/types.ts`,
`packages/db/src/resolution.ts`, `packages/db/src/index.ts`,
`packages/pipeline/src/backtest/teamReport.ts`,
`packages/pipeline/src/backtest/verifyResolution.ts`

**Amended in final review:** the baseline is per `(market, line)`, not per
market. The pooled version credited the model for knowing which line it was
pricing; every number below is the corrected, per-line estimand. See *Baseline
must be given the line*.

## Problem

Commit `7d6b0d3` added a resolution check to `team-backtest`: each market's
base-rate Brier (`r(1-r)`, the score of always predicting the market's own hit
rate) and the model's advantage over it. It flags a negative advantage with
`<<< WORSE THAN GUESSING THE BASE RATE`.

That flag is a **sign test on a noisy quantity**, and it is wrong in both
directions. Measured on the current eval population:

Under the **per-(market, line)** baseline this spec settles on (see *Baseline must
be given the line* below), measured on the current eval population:

| market | n | games | lines | advantage | naive SE | clustered SE | z (naive) | z (clustered) |
|---|---|---|---|---|---|---|---|---|
| total | 9,420 | 2,355 | 4 | -0.00581 | 0.00110 | 0.00199 | -5.29 | -2.92 |
| run_line | 4,710 | 2,355 | 2 | +0.00036 | 0.00139 | 0.00171 | +0.26 | +0.21 |
| moneyline | 2,355 | 2,355 | 1 | -0.00213 | 0.00220 | 0.00220 | -0.97 | -0.97 |

- **moneyline** fires the loud flag on `z = -0.97` — indistinguishable from zero.
  The report currently asserts the model is worse than guessing when the data
  does not support that. This is the same "looks meaningful but isn't" failure
  the resolution check was added to prevent, pointing the other way.
- **total** is significantly **worse** than the baseline (`z = -2.92`) and must
  earn the loud flag, which it does not get from a sign test on a pooled
  baseline (where it read `+0.00192`, a silent pass).
- **run_line** is indistinguishable. No market here demonstrates resolution.

### Baseline must be given the line

The original version of this spec used one pooled base rate `r = mean(y)` per
market. That is the wrong estimand. A market's evals span several candidate
lines with very different hit rates — `run_line −1.5` hits 64.2%, `+1.5` hits
36.6% — and **the model is told which line it is pricing**. The baseline was not.

For a pooled rate `r` over per-line rates `r_k` with weights `n_k`:

```
r(1-r) = E[r_k(1-r_k)] + Var(r_k)        (verified to 5 dp on the real data)
```

So a pooled baseline hands the model `Var(r_k)` for free, and that term is *line
identity*, not skill. For `run_line`, `Var(r_k) = 0.01905` against a pooled-baseline
advantage of `+0.01940` — essentially the entire apparent "skill". Correcting the
baseline is what moves `run_line` from `+0.01940` to `+0.00036`.

The estimand is therefore

```
d_i = (r_k(i) - y_i)^2 - (p_i - y_i)^2
```

with `r_k(i)` the hit rate of eval `i`'s own `(market, line)`. `baseRateBrier`
becomes the `n`-weighted mean of `r_k(1-r_k)`, computed in SQL and carried
through `ResolutionStats` rather than derived from `baseRate` in the pure
function. Since `mean((r_k - y_i)^2)` equals that weighted mean identically,
`advantage = baseRateBrier - modelBrier` still holds exactly.

Everything else is unchanged: the clustering algebra, the `G/(G-1)` factor, the
t-table, `MIN_GAMES`, and the `n_g = 1` identity. Only the estimand moved.

The evals are also **clustered by game**: `team_model_evals` is unique on
`(game_id, team_id, market, line, model_version)`, so one game yields 4 `total`
evals (four candidate lines against one realized game total), 2 `run_line`, and
1 `moneyline`. A naive SE treats these as independent. Under the per-line
baseline the correction inflates `total`'s SE 1.81x and `run_line`'s 1.23x, and
leaves `moneyline`'s untouched (one eval per game). It has to be computed, not
assumed: under the old *pooled* baseline the same correction *shrank*
`run_line`'s SE to 0.88x, because the two sides' `d_i` offset within a game once
both are measured against the same pooled rate. Changing the estimand changes
the sign of the clustering correction, which is why neither ratio is a constant
to be remembered.

## Decisions

1. **Three-state verdict, burden of proof on the model.** `INDISTINGUISHABLE` is
   the default. Both `BEATS` and `WORSE` require a significant result.
2. **Analytic cluster-robust SE**, clustered by `game_id`. Deterministic: the
   same rows always produce the same interval, which matters for a report whose
   numbers are compared over time. A block bootstrap would handle the
   `r`-estimation exactly but needs a pinned seed and more code.
3. **Statistical bar only.** No materiality gate. The Brier skill score prints
   alongside as a normalized effect size so a reader can judge materiality
   without the report hard-coding a threshold — one knob instead of two, and no
   constant that could later be tuned to flatter a result.

## Design

### Placement

A new `teamResolution()` in the query layer plus a pure verdict function.

The current `printResolutionLine` computes statistics in the presentation layer
from reliability buckets, and **buckets carry no `game_id`** — clustering is
impossible where the code sits today. Moving it is forced, not gold-plating.

`BacktestSummary` is deliberately left alone: it is shared with the prop
model (`queries/backtest.ts`, `backtest/report.ts`), so team-only resolution
fields would leak into the prop path and be `null` there forever.

### Statistic

For each eval `i` with model probability `p_i` and outcome `y_i ∈ {0,1}`, and
`r_k = mean(y)` over eval `i`'s own `(market, line)` cell `k`:

```
d_i = (r_k - y_i)^2 - (p_i - y_i)^2
A   = mean(d_i)                      # the advantage, aggregated within market
```

SQL computes `r_k` in a `GROUP BY market, line` CTE and joins it back per row.
(The earlier pooled version expanded `d_i` using `y^2 = y` to avoid the join;
with a per-cell `r_k` the join is needed anyway, so the literal
`power(r_k - y, 2) - power(p - y, 2)` form is used — it is also the form the
oracle SQL uses.)

Note `mean((r_k - y_i)^2)` equals the `n`-weighted mean of `r_k(1-r_k)` exactly
when each `r_k` is its cell's sample mean, so `A` is still identically
`baseRateBrier - modelBrier` — with `baseRateBrier` now supplied by SQL instead
of derived from the pooled `baseRate`.

### Clustered standard error

With `D_g = Σ_{i∈g} d_i`, `n_g` = evals in game `g`, `G` games, `n` evals, and
`S_g = D_g - n_g * A`:

```
Σ_g S_g^2 = Σ_g D_g^2 - 2*A*Σ_g n_g*D_g + A^2*Σ_g n_g^2
SE        = sqrt( G/(G-1) * Σ_g S_g^2 ) / n
CI        = A ± t(0.975, G-1) * SE
```

The expansion means one grouped query yields the sufficient statistics
(`n`, `G`, `Σ D_g`, `Σ D_g^2`, `Σ n_g D_g`, `Σ n_g^2`) — no second pass.

`r` is treated as fixed though it is estimated from the same rows. This is an
`O(1/n)` approximation and it **leans against the model**: `r(1-r)` is the
in-sample *optimal* constant forecast, so the bar it sets is slightly too high.
Erring conservative is the right direction here and is preferred to correcting
it.

`t(0.975, G-1)` comes from a conservative lookup table:

| df breakpoint | t |
|---|---|
| 29 | 2.045 |
| 40 | 2.021 |
| 60 | 2.000 |
| 120 and above | 1.980 |

**Selection rule:** take the row with the largest breakpoint that does not
exceed `G-1`. Since `t` decreases with df, this always returns a `t` at least as
large as the true `t(0.975, G-1)`, so the interval errs wide. (Example: `df = 50`
selects the `40` row, `t = 2.021`, against a true `t(50) ≈ 2.009`.) This avoids
an inverse-t implementation for what is at most a 4% effect above the `G ≥ 30`
floor.

**The table deliberately bottoms out at 1.980 rather than the asymptotic 1.960.**
A `1.960` row for large df would be *anti*-conservative: the true
`t(0.975, 200) = 1.972 > 1.960`, so such a row narrows the interval below truth
and breaks the guarantee above. Holding 1.980 for all `df ≥ 120` stays
conservative everywhere, overstating the half-width by at most 1% as
`df → ∞`. Given `G = 2355` today, the live reports use `t = 1.980`.

### Verdict

```
INSUFFICIENT DATA                       if G < 30, n = 0, SE = 0, or r ∈ {0,1}
BEATS THE BASE RATE                     if CI.lo > 0
WORSE THAN THE BASE RATE                if CI.hi < 0     # keeps the loud <<< marker
INDISTINGUISHABLE FROM THE BASE RATE    otherwise        # the default
```

Guards, each with a reason rather than a preference:

- **`G < 30`** — cluster-robust SEs are sharply downward-biased with few
  clusters, so the interval would be fake-narrow exactly when the data is
  thinnest. A pre-registered floor, not a tunable knob.
- **`baseRateBrier = 0`** — equivalently every `r_k ∈ {0,1}`, so
  `A = -modelBrier ≤ 0` *by construction*; the baseline is a perfect in-sample
  predictor and the comparison is vacuous. Without this guard a degenerate market
  prints a confident `WORSE`.
- **`SE = 0`** — all `d_i` identical; divide-by-zero.

**Skill score** = `A / baseRateBrier`, printed as a percentage. Undefined when
`baseRateBrier = 0`, already covered by the guard above.

**Multiplicity is documented, not corrected.** Three markets are tested;
Bonferroni at `α = 0.05/3` moves the bar to `t ≈ 2.39`. `total` (`z = -2.92`)
survives that and neither other market is close (`|z| ≤ 0.97`), so a correction
changes no verdict today. CLAUDE.md already requires each market be compared
against itself over time rather than against its siblings, which is the
pre-registration that makes per-market `α` defensible. Correcting would add a
knob that buys nothing.

### Types

```ts
export interface ResolutionCheck {
  n: number;
  games: number;
  baseRate: number | null;        // pooled mean(hit); display only
  baseRateBrier: number | null;   // n-weighted mean of r_k(1-r_k)
  lines: number;                  // distinct (market, line) baseline cells
  baseRateLo: number | null;      // lowest per-line hit rate
  baseRateHi: number | null;      // highest per-line hit rate
  modelBrier: number | null;
  advantage: number | null;
  se: number | null;              // clustered by game
  ciLo: number | null;
  ciHi: number | null;
  skillScore: number | null;      // advantage / baseRateBrier
  verdict: 'beats' | 'worse' | 'indistinguishable' | 'insufficient';
}
```

`baseRateBrier`, `lines`, `baseRateLo` and `baseRateHi` are also on
`ResolutionStats`: they come from SQL. `baseRateBrier` must **not** be recomputed
as `baseRate*(1-baseRate)` in the pure function — that is the pooled estimand,
and the difference is exactly `Var(r_k)`.

The `(advantage, se, games, baseRateBrier)` → `(ciLo, ciHi, skillScore, verdict)`
step is a **pure exported function**, so the math is exercisable without a
database.

**Degeneracy guard.** The vacuous case is `baseRateBrier === 0`, which holds
exactly when *every* line's `r_k` is 0 or 1 (then `advantage = -modelBrier ≤ 0`
by construction). The pooled test `baseRate === 0 || baseRate === 1` no longer
identifies it: two lines at `r_k = 0` and `r_k = 1` pool to an ordinary 0.5 while
every cell is degenerate. All other guards (`n === 0`, `games < MIN_GAMES`,
`se === 0`) are unchanged.

### Output

The base-rate-Brier parenthetical is line-count aware: with one line it names
that line's rate; with several it names the count and the spread, because no
single percentage describes the baseline.

```
-- total (9420 evaluations, 2355 games) --
  ECE   = 0.0461  (lower is better)
  Brier = 0.2457  (lower is better)
  base-rate Brier = 0.2399  (predicting each line's own hit rate; 4 lines, 33.8%-57.1%)
  model advantage = -0.0058  95% CI [-0.0098, -0.0019]  (clustered by game)
  skill score     = -2.4%  (advantage / base-rate Brier)
  verdict         = WORSE THAN THE BASE RATE  <<<

-- run_line (4710 evaluations, 2355 games) --
  base-rate Brier = 0.2309  (predicting each line's own hit rate; 2 lines, 36.6%-64.2%)
  model advantage = +0.0004  95% CI [-0.0030, +0.0037]  (clustered by game)
  skill score     = +0.2%  (advantage / base-rate Brier)
  verdict         = INDISTINGUISHABLE FROM THE BASE RATE
                    (no evidence this market carries information)

-- moneyline (2355 evaluations, 2355 games) --
  base-rate Brier = 0.2487  (predicting the 53.6% base rate for every game)
  model advantage = -0.0021  95% CI [-0.0065, +0.0022]  (clustered by game)
  skill score     = -0.9%  (advantage / base-rate Brier)
  verdict         = INDISTINGUISHABLE FROM THE BASE RATE
                    (no evidence this market carries information)
```

The `How to read this` resolution bullet is extended to state that the verdict is
a significance test, that `INDISTINGUISHABLE` is the default rather than a soft
pass, to carry the multiplicity note, and to explain that a market spans several
candidate lines so the baseline is each line's own hit rate — a pooled baseline
would credit the model for merely knowing which line it is pricing.

## Verification

No test runner exists in this repo (no vitest/jest, zero `*.test.ts`), so the
spec pins oracles rather than asserting tests.

**Amended before implementation:** the checks below are **committed**, as
`packages/pipeline/src/backtest/verifyResolution.ts` behind the
`verify-resolution` CLI command and the `npm run verify:resolution` script,
rather than run as throwaway scripts. They use `node:assert` and the `tsx`
already present, so no dependency is added and the "no test framework"
constraint holds. The reason: once throwaway scripts are deleted, nothing
executable verifies the clustering algebra or the t-table's conservatism, and
the oracle values below would survive only as prose.

1. **Independent-implementation oracle.** The table above was computed in SQL by
   a different route (two-pass, literal `(r_k - y)^2 - (p - y)^2`, with `r_k`
   grouped by `(market, line)`). The implementation must reproduce every value,
   **matching advantage and SE when rounded to 5 decimal places** and the
   baseline figures to 4:
   - `total` → 4 lines, baseRateBrier `0.2399`, rates `33.8%`–`57.1%`,
     advantage `-0.00581`, clustered SE `0.00199` → **WORSE**
   - `run_line` → 2 lines, baseRateBrier `0.2309`, rates `36.6%`–`64.2%`,
     advantage `+0.00036`, clustered SE `0.00171` → INDISTINGUISHABLE
   - `moneyline` → 1 line, baseRateBrier `0.2487`, rate `53.6%`,
     advantage `-0.00213`, clustered SE `0.00220` → INDISTINGUISHABLE

   `advantage = baseRateBrier - modelBrier` is asserted to hold to `1e-12` per
   market, which is the check that the weighted-mean baseline and the per-row
   `r_k` join describe the same quantity.
2. **A free unit test the data supplies.** `moneyline` has exactly 1 eval per
   game *and* exactly 1 line, so clustering is a no-op and its clustered SE must
   equal its naive SE (both measured `0.00220`). The pure checks carry the
   matching single-line case: one line, all `n_g = 1`, SE must reduce to naive.

   This is an **exact** identity, not an approximation. With every `n_g = 1` we
   have `G = n` and `Σ_g S_g^2 = Σ_i (d_i - A)^2`, so

   ```
   SE_clustered = sqrt( n/(n-1) * Σ(d_i - A)^2 ) / n
                = sqrt( Σ(d_i - A)^2 ) / sqrt( n*(n-1) )
                = stddev_samp(d) / sqrt(n)
                = SE_naive
   ```

   Any implementation whose clustering or finite-sample correction is wrong
   breaks this exactly, which makes it the sharpest check in this list.
3. **Algebraic identity.** The one-pass `Σ_g S_g^2` must equal a direct two-pass
   computation on the real data; check once via a throwaway tsx script.
4. **Degenerate inputs** through the pure function: `G=0`, `G=29`, `SE=0`,
   `baseRateBrier=0` at one line with `r ∈ {0,1}`, `baseRateBrier=0` at two lines
   pooling to `0.5` (the case the old pooled guard missed), and CIs straddling /
   strictly above / strictly below zero. Also pinned: `baseRateBrier` passes
   through unmodified and is not recomputed from `baseRate`.
5. **Expected verdicts after the change:** `total` → **WORSE** (the loud `<<<`
   marker is earned here, and only here); `run_line` → INDISTINGUISHABLE;
   `moneyline` → INDISTINGUISHABLE. **No market demonstrates resolution.** That
   is the honest finding, not a regression to be tuned away.

## Operational notes

- **Do not bump `TEAM_MODEL_VERSION`.** This changes no model output. Because
  `max(model_version)` is a lexicographic comparison, bumping would strand every
  existing eval row.
- **No re-backfill needed** — this is a read-path change only.
- **`npm run build:db` is required**, since the change touches `packages/db`,
  which runs from compiled `dist/`.

## Out of scope

- Introducing a test framework (vitest/jest). The committed
  `verify-resolution` command above covers this change's math without one.
- Any change to the model, the convolution, or calibration. This spec only
  changes how the existing numbers are *reported*. The known next lever for
  moneyline remains correlated/innings-aware convolution, not calibration
  tuning.
- The prop model's `backtest` report. It draws the calibration-vs-resolution
  distinction only in prose for `home_runs`; applying this treatment there is a
  separate spec.
