# Game-outcome model (v0) — design

**Date:** 2026-09-13
**Status:** approved, ready for implementation plan
**Scope:** sub-project 1 of 3. Model and backtest only — no pricing, no UI, no API calls.

## Why this exists, and what it is not

`CLAUDE.md` lists team win/margin as open work item 4, with an explicit
constraint:

> Team win/margin — a **separate game-outcome model**, not a prop-model
> extension.
> Don't dress up prop numbers as team/game predictions.

The ask behind this work is "correct data to bet on a team." That needs three
things the repo does not have: a game-outcome model, prices for team markets,
and a UI. They are being built in that order, because a teams UI built first
would have nothing truthful to display — and the only way to fill it would be to
derive team numbers from player props, which is the forbidden move and would
look convincing while meaning nothing.

**This sub-project answers exactly one question: is a game-outcome model
calibrated?** It deliberately produces no picks and spends no odds credits.

## What already exists

Team outcomes are **derivable today** — no new ingestion required.
`player_game_batting` carries `r` and `team_id`, and all **2367** non-synthetic
games have exactly two teams with batting rows.

Measured against the live database before this design was written:

| measure | value | n |
|---|---|---|
| runs per team-game (mean) | **4.523** | 4734 team-games |
| variance | **10.697** | |
| **variance / mean** | **2.365** | |
| home runs/game | **4.592** | 2367 games |
| away runs/game | **4.453** | |
| **home win rate** | **0.5353** | |
| league ER per BF | **0.10991** | |
| **probable starter's share of team outs** | **0.5680** | 4718 team-games |
| games with equal derived runs | **6** (0.25%) | |

## Design

### 1. Derived outcome layer

A query layer — not a new table — computes per-game, per-team: runs for, runs
against, margin, total, and won. This is the ground truth the model is graded
against.

It **must exclude** two cases rather than scoring them:

- Games where either side has no batting rows (incomplete ingest).
- The **6 games with equal derived runs**. An MLB game cannot end tied; these
  are suspended or incomplete box scores. Scoring them as draws would inject
  impossible outcomes into calibration. Excluding them is a 0.25% sample loss
  and must be reported, not silent.

### 2. Expected runs

For team T facing opponent O:

```
μ(T) = leagueRunsPerGame
     × teamOffense(T)
     × oppDefense(O)
     × starterAdj(O's probable starter)
     × homeField(T)
```

- **`teamOffense(T)`** — T's runs-scored per game, shrunk toward the league mean
  by `K_G` pseudo-games, then divided by the league mean. Mirrors the existing
  `K_PA`/`K_BF` shrinkage pattern in `project/model.ts`.

  **`K_G = 50`**, derived rather than picked: the prop model uses `K_PA = 200`
  against roughly 600 PA in a full season, giving a player ~75% own weight at
  season's end. A team plays ~160 games, so the matching constant is
  `160 / 3 ≈ 53`, rounded to 50 — which puts a full-season team at
  `160 / (160 + 50) = 76%` own weight. It sits in the model-constants module
  with the others so it can be swept during calibration, and like any `K`, a
  sweep must be proven on a different date range than the one that motivated it.
- **`oppDefense(O)`** — O's runs-allowed per game (the runs its opponents
  scored, from the same derived outcome layer), shrunk by the same `K_G`.
- **`starterAdj`** — O's probable starter's ER/BF, shrunk toward the league
  **0.10991** by the existing `K_BF`, expressed as a ratio to league, then
  **weighted by 0.5680** (the measured starter share of outs) with the
  remaining 0.4320 held at league-average bullpen:

  ```
  starterAdj = 0.5680 × (starterErPerBf / 0.10991) + 0.4320 × 1.0
  ```

  Uses the **starts-only** sample, matching the fix already landed for
  strikeout workload: a reliever's rate does not describe his behaviour as a
  starter. A pitcher with no qualifying start sample falls back to 1.0
  (league-average), which must be counted and reported rather than hidden.
- **`homeField`** — derived from the measured split, not assumed: home teams
  score 4.592 and away 4.453 against an overall 4.523.

### 3. Distribution

**Negative binomial**, not Poisson. The data's variance/mean of **2.365** rules
Poisson out — it requires 1.0. Fitting NB to the observed moments
(`var = μ + μ²/r`):

```
r = μ² / (var − μ) = 4.523² / (10.697 − 4.523) = 20.457 / 6.174 ≈ 3.313
```

`r` is a single global dispersion constant fitted from the data, exposed
alongside the other tunables so it can be swept during calibration. The PMF is
stored exactly, in the same style as `projections.dist`, so downstream pricing
can sum it directly rather than re-approximating.

### 4. Deriving the three markets

Convolve the two teams' run PMFs:

- **Total runs** — distribution of `home + away`; `P(total > line)`.
- **Run line** — distribution of `home − away`; `P(margin > line)`, for the
  standard ±1.5.
- **Moneyline** — `P(home > away)`.

**Tie-splitting.** Convolution assigns real probability mass to
`P(home = away)`, an outcome that cannot occur. v0 splits it **50/50**:

```
P(home wins) = P(home > away) + 0.5 × P(home = away)
```

The 50/50 is deliberate, not lazy. Home advantage is **already** captured in the
run means (4.592 vs 4.453), so biasing the tie-split toward the home team would
count the same effect twice. Real extra-innings outcomes do lean home
(~52–54% league-wide), but there is no inning-level data here to fit that, so
50/50 is the honest approximation. **It is an approximation, not a result, and
the spec says so.**

### 5. Storage

New tables, keyed `(game_id, team_id, market, model_version)`:

- **`team_projections`** — `proj_mean`, `proj_stdev`, `dist` (the exact PMF).
- **`team_model_evals`** — `line`, `model_prob`, `actual`, `hit`, for backtest.

Deliberately **not** a widened `projections`/`model_evals`. Both of those have
`player_id NOT NULL`, and a game outcome has no player. Making it nullable would
blur precisely the boundary `CLAUDE.md` asks to keep, and would put team rows
into the prop model's backtest population.

New **`TEAM_MODEL_VERSION = 'game-v0.1'`**, independent of `MODEL_VERSION`.
Separate tables also sidestep the `max(model_version)` lexicographic trap that
the prop model has to be careful about — the two version strings never share a
column.

### 6. Backtest

A reliability/ECE/Brier report **per market** (moneyline, run line, total),
using the same bucketing method as the prop backtest. Reported per market
rather than pooled, for the same reason the prop backtest reports per prop:
markets with different base rates pooled into one figure produce a number that
looks meaningful and is not.

## Out of scope

- **No pricing, no picks, no `lines` changes, no API calls.** Team market keys
  (`h2h`, `spreads`, `totals`) are sub-project 2.
- **No UI.** That is sub-project 3, and it should not be built until this model
  has a calibration result.
- No change to `MODEL_VERSION`, `K_PA`, `K_BF`, the edge threshold, the de-vig
  method, or any prop projector.

## Named seams

These are known limitations, recorded now so they are not later mistaken for
discoveries:

- **Park factors are neutral (1.0).** `game_conditions` holds weather only —
  no park factor — and deriving one from ~30 venues at ~80 games each would
  overfit. A real park factor is future work.
- **Bullpens are league-average.** Only the probable starter is modelled;
  innings 6–9 are assumed league-average because there is no reliable way to
  know the relievers in advance. The measured 0.5680 starter share makes the
  size of this assumption explicit rather than hidden.
- **The two teams' run distributions are convolved as independent.** They are
  not: a home team leading after 8½ does not bat again, which truncates its own
  scoring conditional on the away score. This biases the model in a known
  direction and is the most significant modelling approximation in v0.
- **~160 games per team-season is an order of magnitude less signal than
  per-PA props**, which have thousands of events. The honest bar here is
  "calibrated," not "sharp." A worse ECE than the prop model's would not be a
  failure.
- **6 excluded games** (0.25%) — derived ties from incomplete box scores.

## Verification

This repo has **no test runner, no test files, and no lint script**.
Verification is `npm run typecheck` plus database checks with exact expected
values, matching the convention of previous plans here.

1. The derived outcome layer reproduces **2367** games, **4734** team-games,
   mean **4.523**, home win rate **0.5353** — and reports exactly **6**
   exclusions.
2. The fitted dispersion reproduces **r ≈ 3.313** from the data's moments.
3. `starterAdj` reproduces **0.5680** as its starter weight and **0.10991** as
   its league ER/BF baseline; the count of starters falling back to
   league-average is reported.
4. Projected run PMFs sum to 1.0 within float tolerance, and their means track
   the 4.523 league baseline in aggregate.
5. Moneyline probabilities across a backfilled season average close to the
   measured **0.5353** home win rate. A large divergence means the home-field
   term or the tie-split is wrong.
6. The backtest produces per-market reliability, ECE, and Brier figures.
7. `npm run typecheck` exits 0.
8. **Zero odds-API credits spent** — quota identical before and after.

## Accepted risks

- **The 0.5353 aggregate check is a calibration sanity test, not a validation.**
  A model can match the aggregate home win rate while being badly wrong
  game-to-game. The per-market reliability curves are the real evidence.
- **Deriving outcomes from summed player runs is one step removed from an
  authoritative score.** It agrees with league averages (4.523 mean, 0.5353
  home win rate, both realistic), but a box-score ingestion gap shows up as a
  wrong score rather than a missing one. The 6 detected ties are evidence this
  failure mode is real, if rare.
- **The dispersion `r` is fitted on the same data the model will be backtested
  against.** That is mild in-sample optimism on the distribution's shape. It is
  one global constant rather than a per-team parameter, so the exposure is
  small, but it is not zero.
