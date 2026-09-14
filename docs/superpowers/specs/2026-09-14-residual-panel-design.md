# Per-game residual panel on the player card

**Date:** 2026-09-14
**Status:** implemented

## Amendment: the limit is in games, not rows

As specced, `getPlayerResiduals(playerId, limit = 40)` limited *rows*. A batter
contributes three rows per game (TB, H, HR), so a row limit truncates
mid-game — and the first build produced a summary where `hits` was averaged
over 14 games while `home_runs` and `total_bases` got 13. Per-prop means that
cover different game sets cannot be read against each other, which is the one
thing the summary table is for.

The signature is now `getPlayerResiduals(playerId, games = 15)`: a `recent`
CTE picks the N most recent evaluated games, then every prop for those games
is returned. Verified after the change — all three props report the same
4 played / 11 DNP over the same 15 games.

## Goal

Add a panel to `/player` listing, per game, what the model projected against
what actually happened: `residual = actual − proj_mean`, with a per-prop mean
residual and standard error as the summary.

## Why this, when calibration already exists

The backtest answers "are the model's *probabilities* honest?" (ECE, Brier, the
reliability curve). It cannot answer "is the *projection* biased, and where?"
Those come apart: `pOverFromPmf` turns a distribution into P(X > line), and a
pooled ECE across ~45k evaluations averages over every player, park, and
opponent at once. A projector that is 0.3 TB high at Coors and 0.3 low at
Petco has no pooled signature at all.

Measured today at `tb-so-v0.3`, excluding synthetic games:

| prop | n | mean proj | mean actual | mean residual | SE |
|---|---|---|---|---|---|
| hits | 44,613 | 0.7830 | 0.7826 | −0.0004 | 0.0040 |
| home_runs | 44,613 | 0.1101 | 0.1096 | −0.0005 | 0.0016 |
| strikeouts | 3,894 | 4.8511 | 4.9132 | +0.0621 | 0.0366 |
| total_bases | 44,613 | 1.2920 | 1.2851 | −0.0069 | 0.0079 |

Read alone, that table says the projector is mean-unbiased, which is roughly
what you would expect from shrunk per-PA rates times expected PAs. **It is
misleading, and finding out why is the argument for building this panel.**

### The pooled ~0 is a cancellation

3.5% of batter evaluations (1,566 of 44,613) are games where the player
appeared in the box score but had **zero plate appearances** — they were
projected, they dressed, they never hit. `actualFor` correctly returns `0`
rather than null for those, so `backfill` grades them, and they enter the
average as enormous one-directional misses. Splitting on whether the player
actually played (`pa > 0`, or `bf > 0` for pitchers):

| prop | played | n | mean residual | SE |
|---|---|---|---|---|
| total_bases | no | 1,566 | −0.9931 | 0.0058 |
| total_bases | **yes** | 43,047 | **+0.0290** | 0.0082 |
| hits | no | 1,566 | −0.6167 | 0.0035 |
| hits | **yes** | 43,047 | **+0.0220** | 0.0041 |
| home_runs | no | 1,566 | −0.0792 | 0.0006 |
| home_runs | **yes** | 43,047 | **+0.0023** | 0.0016 |
| strikeouts | yes | 3,893 | +0.0632 | 0.0366 |

Every batter prop flips sign. The model **under-projects players who actually
bat** — about +0.029 TB on a 1.33 mean, roughly 2% — and the pooled figure
hid it by averaging that against a 3.5% slice of didn't-play rows. Neither
effect is visible in ECE, which is exactly the blind spot named above.

Two cautions on those numbers, both of which the panel must not overstate:

- **The SEs are understated.** They treat each player-game as independent, but
  residuals cluster by game — players share a game's scoring environment,
  weather, and umpire. The real standard errors are larger, so read +0.0290
  as "small and probably real," not as 3.5 sigma.
- **Small does not mean free.** 2% on a mean is not obviously enough to move a
  prop price, and this spec does not claim it is. It is a projector
  diagnostic, not an edge.

**And the panel's value is still mostly localization.** Even corrected, the
pooled bias is ~2%. The question a residual log answers is which player, park,
or opponent that average is composed *of* — the diagnostic neither the backtest
nor CLV provides.

## Data: read `model_evals.actual`, not the box score

`model_evals` already stores the graded outcome, and `projections` stores
`proj_mean`. Join those; do not recompute the actual from
`player_game_batting` / `player_game_pitching`.

The reason is `actualFor()` (`packages/pipeline/src/props.ts:19`), the single
mapping from prop to box-score column. Its own header records why it exists:
it replaced a duplicated ternary that "would have graded a batter's hits
against a pitcher's strikeouts." That function lives in `@mlb-edge/pipeline`,
and the web app reads `@mlb-edge/db` — so a query here that did
`CASE prop_type WHEN 'total_bases' THEN b.tb …` would recreate the exact
duplication `props.ts` was written to prevent, in the one package that cannot
import it. Reading `model_evals.actual` inherits the correct mapping for free
and guarantees this panel agrees with the calibration table on the same page.

The cost is that the panel covers only games `backfill` has evaluated. That is
the correct scope, not a limitation to engineer around: outside backfill there
is no model evaluation to show a residual for.

### Verified against the live database

- **`actual` is constant within `(player_id, game_id, prop_type,
  model_version)`** — 0 violating groups out of 281,590. `DISTINCT ON` over
  the `line` fan-out is therefore safe and loses nothing. (`model_evals` holds
  one row per candidate line; the actual outcome is naturally the same across
  all of them.)
- **Join coverage is total** — all 281,590 eval groups have a matching
  `projections` row. No `LEFT JOIN`, no null `proj_mean` path to design for.
- **Three model versions are present** (`tb-so-v0.1/.2/.3`), so the panel must
  filter, or it will show the same game three times.
- **Current data spans 2026-03-16 … 2026-09-11.** Median coverage is 63 games
  per player per prop; max 148.

### Zero-PA games must be separated, not dropped

The query therefore needs the box-score join after all — not for the outcome
(`model_evals.actual` still supplies that) but for the *participation* flag:
`player_game_batting.pa` and `player_game_pitching.bf`.

This is weaker than the duplication ruled out above — it routes prop →
*table* (batter or pitcher), not prop → *column*, so it cannot mis-grade an
outcome; the worst case is a wrong DNP marker. But be honest that it is a
second place in the codebase that knows `strikeouts` is the pitcher prop, and
it is on the path of the cheapest next props (pitcher outs, hits allowed).
Whoever adds those must update this `CASE`, or the new prop silently routes
through `player_game_batting` and marks every start as DNP. If a third prop
name lands here, that is the signal to move `props.ts` into `@mlb-edge/db`
and have both packages import one mapping.

Do **not** silently filter these rows away. A projection of 1.75 TB for a
player who never batted is a real defect — in expected PAs, or in reacting to
a lineup card — and hiding it converts a visible modelling problem into a
clean-looking average. Instead:

- Mark the row in the table (a `DNP` marker in the Actual column).
- **Exclude it from every summary figure**, and print the excluded count next
  to the mean, e.g. `n = 148 · 6 DNP excluded`. A bias estimate that includes
  didn't-play rows is measuring roster churn, not the projector.

## Query

New file `packages/db/src/queries/residuals.ts`:

```ts
export interface ResidualRow {
  gameDate: string;
  matchup: string | null;
  propType: string;
  projMean: number;
  actual: number;
  residual: number;
  /** false = appeared in the box score but never batted/pitched. Row is shown
   *  as DNP and excluded from every summary figure. */
  played: boolean;
}
// `games`, not rows -- see the amendment at the top.
export async function getPlayerResiduals(
  playerId: number, games = 15,
): Promise<ResidualRow[]>
```

```sql
SELECT * FROM (
  SELECT DISTINCT ON (e.game_id, e.prop_type)
         e.game_id, e.prop_type, g.game_date,
         p.proj_mean, e.actual,
         th.name AS home, ta.name AS away,
         CASE WHEN e.prop_type = 'strikeouts'
              THEN coalesce(pp.bf, 0) > 0
              ELSE coalesce(b.pa,  0) > 0
         END AS played
  FROM model_evals e
  JOIN projections p
    ON  p.player_id     = e.player_id
    AND p.game_id       = e.game_id
    AND p.prop_type     = e.prop_type
    AND p.model_version = e.model_version
  JOIN games g ON g.id = e.game_id
  LEFT JOIN teams th ON th.id = g.home_team_id
  LEFT JOIN teams ta ON ta.id = g.away_team_id
  LEFT JOIN player_game_batting  b
    ON b.game_id  = e.game_id AND b.player_id  = e.player_id
  LEFT JOIN player_game_pitching pp
    ON pp.game_id = e.game_id AND pp.player_id = e.player_id
  WHERE e.player_id = $1
    AND e.model_version = (SELECT max(model_version) FROM projections)
    AND NOT g.is_synthetic
  ORDER BY e.game_id, e.prop_type
) t
ORDER BY t.game_date DESC, t.prop_type
LIMIT $2
```

Notes on the shape:

- `DISTINCT ON` must lead its own `ORDER BY`, which is why the date sort needs
  the wrapping select.
- `(SELECT max(model_version) FROM projections)` matches what
  `getPlayerCard` already does (`packages/db/src/queries/player.ts:24`). It is
  a *lexical* max — correct through `v0.9`, wrong the moment a `v0.10` exists.
  Reuse it for consistency, but that is a latent seam in both places, not a
  property to rely on further.
- `NOT g.is_synthetic` keeps the demo seed out, matching `clv.ts:18`.

## Presentation

A new section on `/player` below the existing projection-vs-market table.

| Date | Matchup | Prop | Proj | Actual | Residual |
|---|---|---|---|---|---|

Above it, a per-prop summary line: `n`, mean residual, and SE.

**No colour on any of it.** This is the load-bearing UI rule and the easiest
thing to get wrong, because a signed number in a betting-adjacent table invites
green and red. A residual is not a verdict: beating your projection is not a
win, and `CLAUDE.md` scopes `--good`/`--bad` to calibration, where the backtest
earned the claim. Residuals get `--ink` like every other figure in the edge
tables. Use `.num` for tabular figures and the existing `signed()` helper.

**Do not add, specifically:** hit rate, "last 5 form," streak badges, or
sorting by any of them. That is the propsmadness pattern this panel is *not*
copying — over a 40-row window those quantities are almost pure noise, and
sorting by them manufactures a leaderboard out of it.

**Do not pool across props.** One player's TB, H, and HR residuals in a single
game are the same plate appearances counted three ways; they are strongly
correlated, and a pooled mean or SE over them would understate the error. Every
summary figure is per-prop. (Per-game residuals *within* one prop are across
different games and can use a plain `sd/√n`.)

## Scope

- No migration. Every column already exists.
- No pipeline changes. `packages/db` only — which means **`npm run build:db`
  is required**, or the query will not exist at runtime (build rule #1).
- No new palette tokens, so `contrast` is unaffected.

## Verification

1. `npm run typecheck` — clean.
2. **Grading agreement.** For any three sampled `(player, game, prop)` rows,
   the panel's `actual` must equal the box-score column `actualFor` would
   pick — `tb` / `h` / `hr` for batter props, pitching `so` for strikeouts.
   Query both and diff.
3. **Aggregate residual unchanged.** Re-run the played/not-played table above;
   at `tb-so-v0.3` it must still report, for `played = true`, +0.0290 TB /
   +0.0220 hits / +0.0023 HR / +0.0632 K over 43,047 / 43,047 / 43,047 / 3,893
   rows, and 1,566 zero-PA batter rows. This is a pure read, so any movement
   means the query selects a different population than intended. In
   particular, if the DNP count comes back 0, the participation join is
   silently failing and the summary means are contaminated.
4. **`parity` will report a diff, and that is expected.** This panel adds
   numbers to `/player`, so a clean parity run would mean the panel is not
   rendering. The check is that the diff is **additive only** — capture a
   baseline before, and confirm every pre-existing line is still present and
   unchanged, with only new `/player` lines added. Do not skip the baseline
   because "a diff is expected"; additive-only is the whole assertion.

## Open question

Whether to surface park and opposing pitcher as columns. It is where the
localization argument actually lands — a residual log sorted by park is how you
would find out whether the stub park factors (`CLAUDE.md`, known seams) are
costing anything. But `game_conditions` and `probable_pitchers` are separate
joins and unvalidated for coverage here, so it is deliberately out of this
spec's scope rather than guessed at.
