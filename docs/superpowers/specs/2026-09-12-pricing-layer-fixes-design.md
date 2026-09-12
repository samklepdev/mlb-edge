# Pricing layer fixes: starter workload, longshot de-vig, projection hygiene

**Date:** 2026-09-12
**Status:** approved, not yet implemented

## Goal

Fix three defects that together produced 436 picks on a 708-prop slate — 62% of
the market flagged as mispriced, overwhelmingly on one side.

1. `expBf` estimates a starter's workload from all appearances, including relief
   outings.
2. `deVig` is proportional, which leaves longshot probabilities too high.
3. `runProjections` upserts but never deletes, leaving stale projections that
   still feed the backtest.

Plus one enabling addition: a `lines reprice` command so iterating on the model
costs no odds-API quota.

**None of this is model tuning.** Items 1-3 are defects. No constant is swept.

## Evidence

### The pick explosion

Today's slate (2026-09-12), 708 priced player-props, edge threshold 3%:

| prop | over | under |
|---|---|---|
| home_runs | 3 | **79** |
| total_bases | 49 | **122** |
| hits | 65 | **98** |
| strikeouts | 10 | 10 |

436 picks total. Filtered to the most trustworthy subset — `total_bases`/`hits`
with odds inside ±160, where de-vigging is most reliable — the top 12 by edge
are 12 unders out of 12. That is a systematic lean, not 436 opportunities.

A control rules out a broken projection: across today's 254 priced batters the
model projects **0.814** hits against the **0.846** those same players actually
average — 4% low. The projections are close to right; the *pricing* is not.

### Defect 1: `expBf` conflates relief with starting

`project/index.ts` projects strikeouts only for probable starters, but
`getPitcherHistory` (`project/data.ts`) aggregates every appearance, and
`expBf = clamp(bf / appearances, 8, 30)`.

| pitcher | all appearances | starts only | SO/start | market line | model projected |
|---|---|---|---|---|---|
| Ian Seymour | 45 apps, 11.1 BF | **13 starts, 19.8 BF** | 6.38 | 5.5 | 3.08 |
| Tyler Phillips | 36 apps, 13.9 BF | **17 starts, 19.4 BF** | 3.53 | 3.5 | 2.73 |
| Tyler Glasnow | 12 apps, 21.3 BF | 12 starts, 21.3 BF | 7.25 | 7.5 | 6.06 |

Seymour's 11.1 BF/appearance is a reliever's workload; he is starting today. At
19.8 BF his projection lands near 5.7 against the market's 5.5, and the 43%
"edge" disappears.

**Glasnow is a different problem and is out of scope.** All twelve of his
appearances are starts, so his `expBf` is already correct. His gap comes from
`K_BF = 300` shrinking a genuine 0.341 K-rate to 0.284, which reproduces the
6.06 projection exactly. That is the shrinkage constant, and `CLAUDE.md`
requires proving any `K` sweep on a different date range. Fixing it in the same
pass as two bug fixes would make it impossible to attribute the result.

### Defect 2: proportional de-vig inflates longshots

`deVig` (`packages/db/src/prob.ts:30-36`) returns `io/s`, `iu/s`. Books apply
more vig to longshots than proportional de-vigging removes, so the longshot's
fair probability comes out too high — and the model's lower number reads as an
under edge.

On a representative home-run market (`π_over ≈ 0.20`, `π_under ≈ 0.90`):

| method | fair P(over) |
|---|---|
| proportional (current) | 0.182 |
| power | **~0.127** |

That gap is the mechanism behind the 79-to-3 home-run skew.

### Defect 3: orphaned projections

The season re-backfill wrote 199,307 projections, but 209,697 are stored for
that range — **10,390 orphans (5%)** left from an earlier pass, for players who
no longer clear `MIN_PA`. They still feed the backtest.

`MODEL_VERSION` filtering prevents mixing *across* versions but not *within*
one, so any re-backfill after a model change silently blends old and new output
under a single label. Today the effect is immaterial (calibration moved ≤0.001),
but it is invisible unless you compare written count against stored count, which
nothing does.

## Design

### 1. Starts-only workload

`getPitcherHistory` gains starts-only aggregates. A past appearance is a start
iff that pitcher was the probable starter for that game:

```sql
LEFT JOIN probable_pitchers pp
  ON pp.game_id = p.game_id AND pp.pitcher_id = p.player_id
```

`PitcherHistory` gains `startBf: number` and `starts: number`. In
`project/index.ts`, `expBf` becomes `clamp(startBf / starts, ...)` using the
existing `BF_CLAMP`.

**The K-rate keeps using all appearances.** A reliever's strikeout ability
transfers to starting; his workload does not. Only the opportunity count is
start-conditional.

**Fallback:** a pitcher with `starts === 0` has no basis for a starter workload
estimate, so skip him rather than guessing — consistent with how `MIN_BF`
already declines to project thin samples. This will reduce the strikeout
projection count, which is correct: those projections were never justified.

`MODEL_VERSION` bumps `tb-so-v0.2` → **`tb-so-v0.3`**.

The `tb-so-` prefix is retained deliberately. `max(model_version)` is a
lexicographic string comparison, and a prefix sorting below `tb-so` would leave
every new row invisible to pricing, the backtest, and the player card with no
error. The name is already inaccurate (it describes four props); correcting it
requires replacing the `max()` selection mechanism, which is its own change.

The bump forces a full-season re-backfill and a re-project of today. Both are
in scope.

### 2. Power de-vig

Replace the body of `deVig` with the power method: find `k` such that
`π_over^k + π_under^k = 1`, by bisection.

`π^k` is monotonically decreasing in `k` for `π < 1`, so bisection on
`k ∈ [1, 10]` converges reliably. Roughly 12 lines, no closed form to derive.

Termination: a **fixed 60 iterations**, no tolerance check. Bisection halves
the bracket each step, so 60 iterations drive a starting width of 9 below
double precision — the loop cannot fail to converge, cannot spin, and needs no
epsilon that would have to be justified. A fixed count also makes the function
deterministic in cost, which matters because it runs once per priced prop.

Shin's method was considered and rejected: it is more principled, but the
two-outcome closed form is easy to get subtly wrong, and an error there would
silently corrupt every edge in the system for a comparable result. Additive
de-vig was rejected because it shades the favorite too hard and can produce
negative probabilities on extreme longshots.

Guard the degenerate cases the current code already guards (`s <= 0`), plus
`s <= 1` (no vig to remove — return the implied probabilities unchanged).

`deVig` is in `@mlb-edge/db/prob.ts`, shared by pricing, backfill, and the
player card, so one change fixes all three. **Requires `npm run build:db`.**

No `MODEL_VERSION` implication: de-vigging affects pricing, not projections.

### 3. Delete stale projections before inserting

In `runProjections`, before upserting, delete projections for the games being
projected, scoped to **both** the model version and the requested props:

```sql
DELETE FROM projections
WHERE game_id = ANY($1) AND model_version = $2 AND prop_type = ANY($3)
```

Scoping to the requested props is load-bearing: deleting every prop for a date
would wipe `strikeouts` when re-projecting `hits` alone. This mirrors the
idempotency pattern `lines pull` already uses for picks ("replace this slate's
model picks").

### 4. `lines reprice`

The pricing half of `pullLines` (`market/lines.ts:160-217`) is welded to the API
fetch. Extract it:

```
priceAndWritePicks(date: string, rows: LineRow[], edgeThreshold: number): Promise<number>
loadStoredLines(date: string): Promise<LineRow[]>
```

`pullLines` becomes fetch → store → price. `repriceLines` becomes load → price.
`loadStoredLines` reads `market_lines` with the same sharp-preference ordering
`getPlayerCard` uses (`DISTINCT ON (game_id, prop_type, player_id)` ordered by
`is_sharp DESC, fetched_at DESC`).

Zero API calls. Reusable on every future model iteration, which is the point —
the pricing layer needs several more passes and quota is finite (322 of 500
credits remain).

## Execution sequence

1. `npm run build:db` (after the `prob.ts` change)
2. `npm run backfill -- --from 2026-03-15 --to 2026-09-11` (full season, v0.3)
3. `npm run backtest` — record per-prop ECE
4. `npm run project -- --date 2026-09-12 --prop all`
5. `npm run lines -- reprice --date 2026-09-12`
6. Compare pick counts and edge distribution against the v0.2 baseline

No migration: no schema change.

## Falsifiable expectations

Stated in advance so the result cannot be rationalised afterward:

| measure | v0.2 baseline | expectation |
|---|---|---|
| total picks | 436 of 708 priced | drops to dozens |
| strikeout picks | 20, avg edge 13-16%, max 43% | a handful, edges under ~10% |
| home-run picks | 82 (79 under / 3 over) | far fewer, less one-sided |
| strikeouts ECE | 0.0402 | improves |
| total_bases ECE | 0.0124 | roughly unchanged |
| hits ECE | 0.0203 | roughly unchanged |

`total_bases` and `hits` should be near-unchanged: neither fix touches batter
projections, and the de-vig change affects pricing rather than calibration.

**If pick counts do not fall, one of the two fixes did not work.** That is the
primary signal to check, ahead of any ECE movement.

### On validating with the same date range

The expBf fix tunes no parameter — it corrects which rows an aggregate reads —
so the overfitting risk `CLAUDE.md` warns about is low, and comparing before and
after on the same season is legitimate here. This would **not** hold for a
`K_BF` sweep, which is why that is excluded.

## Out of scope

- `K_BF` / `K_PA` sweeps, including Glasnow's over-shrunk K-rate.
- Replacing the `max(model_version)` selection mechanism.
- The residual batter under-lean. The model is 4% low in aggregate against
  realised averages, yet leans under on low-projection part-time players.
  Whether the market shades those overs or the model is too harsh on part-timers
  is unresolved, and the power de-vig may absorb some of it — worth re-measuring
  after this lands rather than guessing now.
- Adding a recency bound to `getBatterHistory`.
- Tonight's `lines capture`, which the user runs near gametime.
