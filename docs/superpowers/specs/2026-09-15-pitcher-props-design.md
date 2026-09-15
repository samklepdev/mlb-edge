# Pitcher props: outs, hits allowed, earned runs, walks

**Date:** 2026-09-15
**Status:** draft, not yet approved

## Goal

Add four pitcher props — `pitcher_outs`, `hits_allowed`, `earned_runs`,
`pitcher_walks` — through the existing machinery: projector, backfill/eval,
market pricing, pick logging, settlement.

## Why these, and why now

Open work item #3 is "add props". These are the cheapest available, because
**the data is already ingested**: `player_game_pitching` has stored `outs`,
`h`, `er`, `bb`, `bf` since `001_core.sql`. No new ingest, no migration, no
new API surface.

They also fix a real gap. At `tb-so-v0.3`, `strikeouts` has **3,894 evaluated
player-games against 44,613 for each batter prop** — the pitcher side is
under-sampled by more than a factor of ten, and it is the one prop whose
residual (+0.063, ~1.7 SE) can be neither confirmed nor dismissed. Four more
pitcher props on the same per-BF machinery multiply that sample.

Measured over starts (`bf >= 15`, n = 4,687):

| stat | mean per start |
|---|---|
| outs | 15.77 |
| hits allowed | 4.96 |
| earned runs | 2.47 |
| walks | 1.82 |
| batters faced | 22.31 |

## Three of the four are easy. One is not.

`projectStrikeouts` is `Binomial(expBf, shrunk per-BF K rate)` compounded into
an exact PMF. **Hits allowed and walks are the same shape** — a per-BF
Bernoulli, shrunk toward league, compounded over expected batters faced. They
drop straight into the existing helper with a different numerator.

**Earned runs and outs do not**, and shipping them as if they did would be the
mistake this project exists to avoid:

- **Earned runs are not per-BF independent.** Runs score in clusters — a walk
  then a home run is three earned runs from two batters. A Bernoulli-per-BF
  model would produce roughly the right mean and a badly understated variance,
  which is precisely the overconfidence that `pOverFromPmf` was introduced to
  fix for total bases (v0.1 ECE 0.091 → v0.2 0.028). It would look calibrated
  in the mean and fail in the tails.
- **Outs are censored by the manager, not by the pitcher.** A starter is pulled
  on pitch count, leverage, and matchup. The distribution has a hard ceiling
  around 21 outs, a fat cluster at 15–18, and a left tail driven by getting
  shelled. That is not a binomial over batters faced; it is a duration model
  with a hazard that depends on how the start is going.

### Proposed handling

- **`hits_allowed`, `pitcher_walks`** — per-BF Bernoulli, exactly as
  `strikeouts`. Ship in phase 1.
- **`earned_runs`** — needs an over-dispersed count (negative binomial fit to
  the per-start distribution, or an empirical PMF conditioned on shrunk
  quality). Phase 2, with its calibration reported separately and the
  expectation that it starts worse.
- **`pitcher_outs`** — an empirical PMF over the pitcher's own start lengths,
  shrunk toward a league start-length distribution. Not a per-BF model at all.
  Phase 3, and arguably should be deferred: the market for pitcher outs is
  mostly a bet on managerial behaviour, which this model has no information
  about.

**Do not ship all four at once.** Each needs its own `MODEL_VERSION` bump so a
calibration change can be attributed.

## Required changes, in order

1. **`props.ts` — `actualFor()`.** Add `hits_allowed → pitching h`,
   `pitcher_walks → pitching bb`, `earned_runs → er`, `pitcher_outs → outs`.
   This is the single prop→column mapping and it fails closed, so an unmapped
   prop produces no grade rather than a wrong one.
2. **`projectors.ts`** — new projectors reusing `compound()` and
   `shrinkRate()`. `PitcherHistory` already carries `bf`, `so`, `h`; it needs
   `bb`, `er`, `outs` added.
3. **`project/index.ts`** — `ALL_PROPS`, `PropKind`.
4. **`market/lines.ts`** — market keys. The Odds API names are
   `pitcher_outs`, `pitcher_hits_allowed`, `pitcher_earned_runs`,
   `pitcher_walks`. **Verify each against a live response before relying on
   it**; a wrong key silently returns nothing rather than erroring.
5. **`backfill.ts` — `CANDIDATE_LINES`.** Centred on the measured means above:
   `hits_allowed: [3.5, 4.5, 5.5, 6.5]`, `pitcher_walks: [1.5, 2.5, 3.5]`,
   `earned_runs: [1.5, 2.5, 3.5]`, `pitcher_outs: [14.5, 15.5, 16.5, 17.5, 18.5]`.
6. **`packages/db/src/queries/residuals.ts:58`** — the participation `CASE`
   routes prop → box-score *table* and hardcodes `strikeouts` as the only
   pitcher prop:

   ```sql
   CASE WHEN e.prop_type = 'strikeouts'
        THEN coalesce(pp.bf, 0) > 0
        ELSE coalesce(b.pa,  0) > 0 END AS played
   ```

   **Every new pitcher prop must be added there**, or it routes through
   `player_game_batting` and marks every start as DNP — silently, since a
   pitcher has no batting row. This is the second place that knows which props
   are pitcher props; the residual spec already flagged that a third one is the
   signal to move `props.ts` into `@mlb-edge/db` and have both packages import
   one mapping. **Four new pitcher props is that signal.** Do the move as part
   of this work rather than patching the `CASE` again.
7. **`PropLabel.tsx`** — abbreviations. Suggested: `Outs`, `H allowed`, `ER`,
   `BB`. Note `H` and `BB` already mean the *batter* versions on the box score,
   so these need distinct labels, not reused ones.

## Population: starters only

Strikeout props are quoted on probable starters, and `PitcherHistory` already
conditions workload on starts (`startBf`, `starts`) while deliberately taking
the K *rate* from all appearances — "strikeout ability transfers to a starting
role, innings don't." **The same split applies to the new rate props**: hits
and walks per BF transfer; the number of batters faced does not.

`bf >= 15` is the working definition of a start used above. It is a proxy —
there is no start flag in the schema — and it will misclassify an opener.

## What would falsify this

> **Hypothesis.** `hits_allowed` and `pitcher_walks`, built on the same per-BF
> machinery as `strikeouts`, calibrate comparably to it (per-prop ECE within
> the same range) on a date range not used to choose any constant.

If they calibrate materially worse, the per-BF independence assumption is
weaker for those events than for strikeouts, and that is a finding about the
model — report it, do not sweep `K_BF` to close the gap. That is the error
already on record from v0.3.

For `earned_runs` specifically, expect the tails to fail first. Check the
high-probability buckets at large n, which is where the existing mild
overconfidence already lives.

## Non-goals

- **No `hits_allowed + walks` combined prop.** Same objection as `H+R+RBI`:
  correlated components, and the independence assumption breaks hardest there.
- **No pitcher fantasy-score props.** Those are DFS pick'em markets with fixed
  payout multipliers and no two-sided vig, so `deVig` does not apply. A
  separate question.
- **No change to the four batter props**, and no `MODEL_VERSION` bump for them.
