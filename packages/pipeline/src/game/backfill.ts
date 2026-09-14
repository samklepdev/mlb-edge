import { query, withTx } from '@mlb-edge/db';
import { runTeamProjections } from './project.js';
import { pTotalOver, pMarginOver, pHomeWin } from './distribution.js';
import { TEAM_MODEL_VERSION } from './model.js';
import { dateRange } from '../dates.js';

// Standard lines, sampling each market across its realistic range.
const TOTAL_LINES = [7.5, 8.5, 9.5, 10.5];
const RUN_LINES = [-1.5, 1.5];

export async function backfillTeams(
  from: string,
  to: string,
): Promise<{ dates: number; projected: number; evals: number }> {
  const dates = dateRange(from, to);
  let projected = 0;
  let evals = 0;

  for (const date of dates) {
    projected += (await runTeamProjections(date)).rows;

    // Finished games with both teams projected and a real (non-tied) outcome.
    const rows = (
      await query<{
        game_id: number; home_team_id: number; away_team_id: number;
        home_dist: number[]; away_dist: number[]; home_runs: number; away_runs: number;
      }>(
        `WITH s AS (
           SELECT b.game_id, b.team_id, sum(b.r)::int AS runs
           FROM player_game_batting b GROUP BY b.game_id, b.team_id
         )
         SELECT g.id AS game_id, g.home_team_id, g.away_team_id,
                hp.dist AS home_dist, ap.dist AS away_dist,
                hs.runs AS home_runs, as_.runs AS away_runs
         FROM games g
         JOIN team_projections hp ON hp.game_id = g.id AND hp.team_id = g.home_team_id
                                 AND hp.model_version = $2 AND hp.market = 'runs'
         JOIN team_projections ap ON ap.game_id = g.id AND ap.team_id = g.away_team_id
                                 AND ap.model_version = $2 AND ap.market = 'runs'
         JOIN s hs  ON hs.game_id  = g.id AND hs.team_id  = g.home_team_id
         JOIN s as_ ON as_.game_id = g.id AND as_.team_id = g.away_team_id
         WHERE g.game_date = $1 AND NOT g.is_synthetic
           AND g.status ILIKE '%final%'
           AND hs.runs <> as_.runs`,
        [date, TEAM_MODEL_VERSION],
      )
    ).rows;

    await withTx(async (c) => {
      for (const r of rows) {
        const home = r.home_dist;
        const away = r.away_dist;
        const totalRuns = r.home_runs + r.away_runs;
        const margin = r.home_runs - r.away_runs;

        const write = async (market: string, line: number, prob: number, actual: number, hit: boolean) => {
          await c.query(
            `INSERT INTO team_model_evals
               (game_id, team_id, market, line, model_prob, actual, hit, model_version)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (game_id, team_id, market, line, model_version)
             DO UPDATE SET model_prob = EXCLUDED.model_prob, actual = EXCLUDED.actual, hit = EXCLUDED.hit`,
            [r.game_id, r.home_team_id, market, line, prob.toFixed(6), actual, hit, TEAM_MODEL_VERSION],
          );
          evals++;
        };

        // All three markets are recorded from the HOME team's perspective, so
        // one row per game per line -- not two mirrored rows, which would
        // double-count the same event in calibration.
        await write('moneyline', 0.5, pHomeWin(home, away), margin, margin > 0);
        for (const line of TOTAL_LINES) {
          await write('total', line, pTotalOver(home, away, line), totalRuns, totalRuns > line);
        }
        for (const line of RUN_LINES) {
          await write('run_line', line, pMarginOver(home, away, line), margin, margin > line);
        }
      }
    });
  }

  return { dates: dates.length, projected, evals };
}
