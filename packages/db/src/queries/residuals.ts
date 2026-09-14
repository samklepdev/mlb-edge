import { query } from '../pool.js';
import type { ResidualRow, ResidualSummary } from '../types.js';

// Per-game model residuals: what was projected against what happened.
//
// The backtest answers whether the model's PROBABILITIES are honest. It cannot
// answer whether the projected MEAN is biased, or where -- a pooled ECE over
// ~45k evaluations averages across every player, park and opponent at once, so
// a projector that runs high in one park and low in another has no pooled
// signature. Residuals are the mean-level diagnostic that sits underneath.
//
// The outcome comes from `model_evals.actual`, NOT from the box score.
// `actualFor()` (packages/pipeline/src/props.ts) is the single prop -> column
// mapping and lives in a package the web app cannot import; re-deriving the
// actual here would recreate exactly the duplication that function exists to
// prevent -- its own header records that the ternary it replaced would have
// graded a batter's hits against a pitcher's strikeouts. Reading the already
// graded value inherits the right mapping and keeps this panel consistent with
// the calibration table on the same page.
//
// The cost is that this only covers games `backfill` has evaluated. That is
// the correct scope: outside backfill there is no model evaluation to show.
// `games` is a number of GAMES, not of rows. A batter contributes three rows
// per game (TB, H, HR), so a row limit truncates mid-game and leaves one prop
// summarised over one more game than the others -- which is exactly what makes
// two per-prop means non-comparable. Select the games first, then take every
// prop for them.
export async function getPlayerResiduals(playerId: number, games = 15): Promise<ResidualRow[]> {
  const rows = (
    await query<{
      game_date: string; prop_type: string; proj_mean: string; actual: string;
      home: string | null; away: string | null; played: boolean;
    }>(
      // DISTINCT ON collapses the candidate-line fan-out in `model_evals`
      // (one row per line, all carrying the same outcome -- verified: 0 groups
      // of 281,590 have a varying `actual`). It must lead its own ORDER BY,
      // which is why the date sort needs the wrapping select.
      //
      // The box-score joins supply PARTICIPATION only, never the outcome.
      // `pa`/`bf` are how a "projected 1.75 TB, never batted" row is told apart
      // from a real miss; see the `played` note in types.ts.
      `WITH recent AS (
         SELECT g.id AS game_id, g.game_date
         FROM games g
         WHERE NOT g.is_synthetic
           AND EXISTS (
             SELECT 1 FROM model_evals e
             WHERE e.game_id = g.id AND e.player_id = $1
               AND e.model_version = (SELECT max(model_version) FROM projections))
         ORDER BY g.game_date DESC, g.id DESC
         LIMIT $2
       )
       SELECT * FROM (
         SELECT DISTINCT ON (e.game_id, e.prop_type)
                to_char(r.game_date, 'YYYY-MM-DD') AS game_date,
                e.prop_type, p.proj_mean, e.actual,
                th.name AS home, ta.name AS away,
                CASE WHEN e.prop_type = 'strikeouts'
                     THEN coalesce(pp.bf, 0) > 0
                     ELSE coalesce(b.pa,  0) > 0
                END AS played
         FROM recent r
         JOIN model_evals e ON e.game_id = r.game_id AND e.player_id = $1
         JOIN projections p
           ON  p.player_id     = e.player_id
           AND p.game_id       = e.game_id
           AND p.prop_type     = e.prop_type
           AND p.model_version = e.model_version
         JOIN games g ON g.id = e.game_id
         LEFT JOIN teams th ON th.id = g.home_team_id
         LEFT JOIN teams ta ON ta.id = g.away_team_id
         LEFT JOIN player_game_batting  b  ON b.game_id  = e.game_id AND b.player_id  = e.player_id
         LEFT JOIN player_game_pitching pp ON pp.game_id = e.game_id AND pp.player_id = e.player_id
         WHERE e.model_version = (SELECT max(model_version) FROM projections)
         ORDER BY e.game_id, e.prop_type
       ) t
       ORDER BY t.game_date DESC, t.prop_type`,
      [playerId, games],
    )
  ).rows;

  return rows.map((r) => {
    const projMean = Number(r.proj_mean);
    const actual = Number(r.actual);
    return {
      // Formatted by to_char in SQL, as latestSlateDate does (slate.ts:8):
      // a bare DATE comes back as a JS Date in the local zone, which can shift
      // the day. 'YYYY-MM-DD' text also sorts identically to the date, so the
      // outer ORDER BY is unaffected.
      gameDate: r.game_date,
      matchup: r.away && r.home ? `${r.away} @ ${r.home}` : null,
      propType: r.prop_type,
      projMean,
      actual,
      residual: actual - projMean,
      played: r.played,
    };
  });
}

// Mean residual per prop, with the count it was computed over.
//
// Two rules are load-bearing here, and both are about not overstating what a
// residual mean supports:
//
// 1. DNP rows are excluded from the mean and counted separately. A bias
//    estimate that includes didn't-play games is measuring roster churn, not
//    the projector -- pooled over the whole database those rows drag every
//    batter prop from a real +0.02..+0.03 down to ~0, which reads as "no bias"
//    and is wrong.
// 2. Props are never pooled with each other. One player's TB, H and HR in a
//    single game are the same plate appearances counted three ways; they are
//    strongly correlated, and a mean or SE across them would understate the
//    error.
//
// The SE reported is `sd/sqrt(n)`, which treats each game as independent. For
// one player's own games that is defensible, but it is still a floor: it is
// the reason the UI labels this a diagnostic and not a result.
export function summarizeResiduals(rows: ResidualRow[]): ResidualSummary[] {
  const byProp = new Map<string, ResidualRow[]>();
  for (const r of rows) {
    const list = byProp.get(r.propType);
    if (list) list.push(r);
    else byProp.set(r.propType, [r]);
  }

  const out: ResidualSummary[] = [];
  for (const [propType, all] of byProp) {
    const played = all.filter((r) => r.played);
    const n = played.length;
    const mean = n === 0 ? null : played.reduce((s, r) => s + r.residual, 0) / n;
    // Sample sd needs n >= 2; with one game there is no spread to report.
    let se: number | null = null;
    if (mean != null && n >= 2) {
      const varSum = played.reduce((s, r) => s + (r.residual - mean) ** 2, 0);
      se = Math.sqrt(varSum / (n - 1)) / Math.sqrt(n);
    }
    out.push({ propType, n, dnp: all.length - n, meanResidual: mean, se });
  }
  out.sort((a, b) => a.propType.localeCompare(b.propType));
  return out;
}
