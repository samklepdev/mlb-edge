# Advantage significance threshold for the team-backtest resolution check

**Date:** 2026-09-13
**Status:** design, approved
**Touches:** `packages/db/src/queries/teamBacktest.ts`, `packages/db/src/types.ts`,
`packages/db/src/index.ts`, `packages/pipeline/src/backtest/teamReport.ts`

## Problem

Commit `7d6b0d3` added a resolution check to `team-backtest`: each market's
base-rate Brier (`r(1-r)`, the score of always predicting the market's own hit
rate) and the model's advantage over it. It flags a negative advantage with
`<<< WORSE THAN GUESSING THE BASE RATE`.

That flag is a **sign test on a noisy quantity**, and it is wrong in both
directions. Measured on the current eval population:

| market | n | games | advantage | naive SE | clustered SE | z (naive) | z (clustered) |
|---|---|---|---|---|---|---|---|
| total | 9,420 | 2,355 | +0.00192 | 0.00141 | 0.00206 | 1.36 | 0.93 |
| run_line | 4,710 | 2,355 | +0.01940 | 0.00236 | 0.00207 | 8.20 | 9.37 |
| moneyline | 2,355 | 2,355 | -0.00213 | 0.00220 | 0.00220 | -0.97 | -0.97 |

- **moneyline** fires the loud flag on `z = -0.97` — indistinguishable from zero.
  The report currently asserts the model is worse than guessing when the data
  does not support that. This is the same "looks meaningful but isn't" failure
  the resolution check was added to prevent, pointing the other way.
- **total** passes silently at `+0.00192` (`z = 0.93`), reading as a pass when it
  is no better than guessing.
- **run_line** is the only market that genuinely discriminates.

The evals are also **clustered by game**: `team_model_evals` is unique on
`(game_id, team_id, market, line, model_version)`, so one game yields 4 `total`
evals (four candidate lines against one realized game total), 2 `run_line`, and
1 `moneyline`. A naive SE treats these as independent. The correction does not
move in one direction — it inflates `total`'s SE 1.46x and *shrinks*
`run_line`'s to 0.88x (the two sides' errors offset within a game) — so it has
to be computed, not assumed.

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
market base rate `r = mean(y)`:

```
d_i = (r - y_i)^2 - (p_i - y_i)^2
A   = mean(d_i)                      # the advantage
```

Because `y ∈ {0,1}` implies `y^2 = y`, this expands to a form computable in one
pass:

```
d_i = r^2 - 2*r*y_i - p_i^2 + 2*p_i*y_i
```

Note `mean((r - y_i)^2) = r(1-r)` exactly when `r` is the sample mean, so `A` is
identically `baseRateBrier - modelBrier`.

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
- **`r ∈ {0,1}`** — `baseRateBrier = 0`, so `A = -modelBrier ≤ 0` *by
  construction*; the baseline is a perfect in-sample predictor and the
  comparison is vacuous. Without this guard a degenerate market prints a
  confident `WORSE`.
- **`SE = 0`** — all `d_i` identical; divide-by-zero.

**Skill score** = `A / baseRateBrier`, printed as a percentage. Undefined when
`baseRateBrier = 0`, already covered by the `r ∈ {0,1}` guard.

**Multiplicity is documented, not corrected.** Three markets are tested;
Bonferroni at `α = 0.05/3` moves the bar to `t ≈ 2.39`. `run_line` (`z = 9.4`)
survives that trivially and neither other market is close, so a correction
changes no verdict today. CLAUDE.md already requires each market be compared
against itself over time rather than against its siblings, which is the
pre-registration that makes per-market `α` defensible. Correcting would add a
knob that buys nothing.

### Types

```ts
export interface ResolutionCheck {
  n: number;
  games: number;
  baseRate: number | null;
  baseRateBrier: number | null;
  modelBrier: number | null;
  advantage: number | null;
  se: number | null;              // clustered by game
  ciLo: number | null;
  ciHi: number | null;
  skillScore: number | null;      // advantage / baseRateBrier
  verdict: 'beats' | 'worse' | 'indistinguishable' | 'insufficient';
}
```

The `(advantage, se, games, baseRateBrier)` → `(ciLo, ciHi, skillScore, verdict)`
step is a **pure exported function**, so the math is exercisable without a
database.

### Output

```
-- run_line (4710 evaluations, 2355 games) --
  ECE   = 0.0312  (lower is better)
  Brier = 0.2306  (lower is better)
  base-rate Brier = 0.2500  (predicting the 50.4% base rate for every game)
  model advantage = +0.0194  95% CI [+0.0153, +0.0235]  (clustered by game)
  skill score     = +7.8%  (advantage / base-rate Brier)
  verdict         = BEATS THE BASE RATE

-- moneyline (2355 evaluations, 2355 games) --
  model advantage = -0.0021  95% CI [-0.0065, +0.0022]  (clustered by game)
  skill score     = -0.9%
  verdict         = INDISTINGUISHABLE FROM THE BASE RATE
                    (no evidence this market carries information)
```

The `How to read this` resolution bullet is extended to state that the verdict is
a significance test, that `INDISTINGUISHABLE` is the default rather than a soft
pass, and to carry the multiplicity note.

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
   a different route (two-pass, literal `(r-y)^2 - (p-y)^2`). The one-pass
   algebraic implementation must reproduce all three pairs, **matching each
   value when rounded to 5 decimal places**:
   - `total` → advantage `+0.00192`, clustered SE `0.00206`
   - `run_line` → advantage `+0.01940`, clustered SE `0.00207`
   - `moneyline` → advantage `-0.00213`, clustered SE `0.00220`
2. **A free unit test the data supplies.** `moneyline` has exactly 1 eval per
   game, so clustering is a no-op and its clustered SE must equal its naive SE
   (both measured `0.00220`).

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
   `r=0`, `r=1`, and CIs straddling / strictly above / strictly below zero.
5. **Expected verdicts after the change:** `run_line` → BEATS;
   `total` → INDISTINGUISHABLE; `moneyline` → INDISTINGUISHABLE (no longer the
   loud `WORSE` flag).

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
