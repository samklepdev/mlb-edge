# Add `hits` and `home_runs` props

**Date:** 2026-09-11
**Status:** approved, not yet implemented

## Goal

Project two new batter props — `hits` and `home_runs` — reusing the existing
per-PA machinery, and carry them through the full pipeline: projection,
backfill/eval, market pricing, pick logging, and settlement.

RBI is explicitly **out of scope**; see "Why RBI is excluded" below.

## Why hits and HR are nearly free

`projectTotalBases` (`packages/pipeline/src/project/projectors.ts:41-59`)
already computes shrunk, matchup-adjusted per-PA probabilities `q1..q4` for
single / double / triple / home run. Both new props are marginals of that same
distribution:

- **hits** — per-PA Bernoulli with `pHit = q1 + q2 + q3 + q4`
- **home_runs** — per-PA Bernoulli with `q4`

Each is compounded over expected PAs by the existing `compound()` helper,
producing an exact game PMF through the same path as total bases. No new
ingest, no new statistics, no distributional assumptions beyond the per-PA
independence the model already makes.

## Why RBI is excluded

Two independent reasons, either sufficient:

1. **No per-PA event data.** `player_game_batting` stores a game-total `rbi`
   column but no per-PA breakdown, unlike singles/doubles/triples/HR. Building a
   per-PA RBI distribution would require *imposing* a shape (Poisson or a crude
   categorical) rather than deriving one, which is a different kind of modeling
   claim than the current props make.
2. **RBIs are not a property of the batter alone.** They depend on teammates
   reaching base ahead of them — lineup position, the on-base skill of the
   hitters in front, and baserunner state. The existing machinery models a
   batter in isolation. A per-PA RBI rate would silently encode the batter's
   *past* lineup context as if it were their own skill.

RBI gets its own brainstorm and its own spec, most likely alongside a
baserunner/lineup model.

## Versioning decision

**`MODEL_VERSION` stays `tb-so-v0.2`.** It is not bumped.

Rationale: this change adds new `prop_type` rows but does not alter a single
`total_bases` or `strikeouts` number. Bumping the version would be actively
harmful — pricing, backtest, and `getPlayerCard` all filter on
`(SELECT max(model_version) FROM projections)`, so the moment a `v0.3` row
existed, every `v0.2` TB/SO projection would become invisible to pricing and a
full re-backfill would be mandatory just to restore current behavior.

Accepted cost: the string `tb-so-v0.2` no longer describes its contents, and
version alone cannot distinguish rows written before this change from rows
written after. `created_at` remains available for that.

This makes **behavior preservation a hard requirement**, not a nicety — see
"Byte-identical gate".

### A trap to preserve knowledge of

`max(model_version)` is a *lexicographic* string comparison, not semantic
version ordering. `tb-so-v0.3` sorts above `tb-so-v0.2` correctly, but a
rename to a prefix sorting below `tb-so` (e.g. `props-v0.3`) would strand every
new projection with no error. Any future version bump must preserve
lexicographic ordering, or replace `max()` with an explicit constant.

## Architecture

### Extraction in `projectors.ts`

Pull the shrink → adjust → cap-renormalize sequence currently inline in
`projectTotalBases` into one shared helper:

```
batterPerPaRates(hist: BatterHistory, league: LeagueBatting, adj: number)
  -> { q0: number; q1: number; q2: number; q3: number; q4: number }
```

It performs exactly what `projectTotalBases` does today, in the same order:
`shrinkRate` each of `p1..p4` with `K_PA`; multiply by `clamp(adj, 0.7, 1.4)`;
if the hit sum exceeds 0.95, rescale all four by `0.95 / hitSum`; derive
`q0 = max(0, 1 - (q1+q2+q3+q4))`.

Three projectors then consume it:

| Projector | per-trial PMF |
|---|---|
| `projectTotalBases` | `[q0, q1, q2, q3, q4]` |
| `projectHits` | `[1 - pHit, pHit]`, `pHit = q1+q2+q3+q4` |
| `projectHomeRuns` | `[1 - q4, q4]` |

All three then call the existing `compound(perTrial, expPa)` and
`statsFromPmf`. Single source for the shrinkage and the 0.95 cap, so the props
cannot drift apart.

### Byte-identical gate

The extraction touches code that produced the calibrated v0.2 numbers, under an
unchanged version string. Therefore: **`total_bases` projections must be
identical before and after the refactor**, verified by capturing
`proj_mean`, `proj_stdev`, and `dist` for a date, refactoring, re-projecting,
and diffing. Any difference is a defect, not an improvement — it would mean
v0.2 rows in the database came from two different models.

### Projection loop (`project/index.ts`)

The batter block (currently `index.ts:38-65`) already computes rosters, `adj`,
`expPa`, and `hist` — all shared by the three batter props. It must not be
duplicated per prop.

- The block's guard becomes "any batter prop was requested" rather than
  `props.includes('total_bases')`.
- Inside the existing per-player loop, push one `ProjectionRow` per *requested*
  batter prop, calling `batterPerPaRates` once and reusing its result.

The strikeouts block is untouched.

## Two existing seams this change forces open

These are not opportunistic refactors; each is a latent bug that this change
would otherwise trigger.

### 1. The grading ternary (two copies)

`project/backfill.ts:55` and `market/lines.ts:266` both read:

```ts
const actual = r.prop_type === 'total_bases' ? r.tb : r.so;
```

Any prop that is not `total_bases` falls to the `: so` branch. Adding `hits`
would silently grade a batter's hit total against a *pitcher's* strikeout
count, producing confident, wrong calibration and settlement data.

Replace with an explicit per-prop lookup: `total_bases → b.tb`, `hits → b.h`,
`home_runs → b.hr`, `strikeouts → ps.so`, and **`null` for anything unknown**,
so a future prop added without touching this code produces no eval rather than
a wrong one. Both SELECT statements gain `b.h` and `b.hr`.

### 2. The duplicated prop whitelist

`cli.ts:65` and `cli.ts:148` each hardcode `['total_bases', 'strikeouts']` —
one for `project`, one for `backfill`. Adding a prop to only one makes
`project` accept a prop that `backfill` silently rejects.

Replace with a single exported `ALL_PROPS` constant, with `PropKind` derived
from it so the type and the runtime whitelist cannot diverge.

## Configuration changes

- `PropKind` gains `'hits' | 'home_runs'` (via `ALL_PROPS`).
- `MARKET_TO_PROP` (`market/lines.ts:8`) gains `batter_hits: 'hits'` and
  `batter_home_runs: 'home_runs'`.
- `CANDIDATE_LINES` (`project/backfill.ts:6`) gains `hits: [0.5, 1.5, 2.5]` and
  `home_runs: [0.5]`. Home run props realistically trade only at 0.5.

**No migration.** `prop_type` is free-text `TEXT` with no `CHECK` constraint
(`migrations/002_market_and_edges.sql:8`), and `h` / `hr` already exist in
`player_game_batting`.

## Documented limitations

The matchup adjustment `adj` is `pitcherTbFactor × parkFactor × tempFactor`,
where `pitcherTbFactor` is a hits-allowed-per-batter-faced proxy
(`factors.ts:33-36`).

Applied to `hits`, this is reasonable — it is literally a hits-allowed rate.

Applied to `home_runs`, it is crude: a pitcher's hits-allowed rate says little
about home-run suppression, and park HR factors differ substantially from park
run factors. The repo has no HR-specific factor data, and inventing one without
a source would be worse than using a documented-crude one. This is recorded as
a known weakness; the backtest reliability curve for `home_runs` is the
evidence for how much it costs. Expect `home_runs` to calibrate worse than
`hits`, and do not tune the factor to fix a single date window.

## Verification

No test runner exists in this repo. Verification is:

1. **Byte-identical gate** — capture `total_bases` `proj_mean`/`proj_stdev`/
   `dist` for a date before the refactor, re-project after, diff. Must be empty.
2. `npm run typecheck` — exits 0.
3. `npm run project -- --date <d> --prop all` — writes `hits` and `home_runs`
   rows; confirm counts and spot-check a PMF sums to ~1.
4. `npm run backfill -- --from <d> --to <d>` then `npm run backtest` — read the
   reliability and ECE for the new props. **This is the real deliverable:**
   whether these props are calibrated, not whether they compute.
5. Confirm grading reads the right column — a `hits` eval row's `actual` must
   match `player_game_batting.h`, never `player_game_pitching.so`.
6. `lines pull` maps the two new market keys and reports its unmatched count.

**Odds API keys are unverified.** `batter_hits` and `batter_home_runs` are the
expected the-odds-api market keys but have not been confirmed against the live
API, because a verification request consumes free-tier quota. Confirm at
implementation time before assuming a zero-line pull is a matching bug.

## Out of scope

- RBI (see above), runs scored, and any pitcher prop beyond strikeouts.
- An HR-specific park or pitcher factor.
- Any change to `MODEL_VERSION`, shrinkage constants, or the `max(model_version)`
  selection mechanism.
- Dashboard changes. The player card renders whatever props exist, so the new
  props appear without UI work.
