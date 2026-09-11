import { query, withTx, pOver, pOverFromPmf } from '@mlb-edge/db';
import { runProjections, type PropKind } from './index.js';
import { MODEL_VERSION } from './model.js';

// Standard lines to evaluate the model at, sampling the CDF across its range.
const CANDIDATE_LINES: Record<PropKind, number[]> = {
  total_bases: [0.5, 1.5, 2.5, 3.5],
  strikeouts: [3.5, 4.5, 5.5, 6.5, 7.5, 8.5],
};

function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export interface BackfillResult {
  dates: number;
  projected: number;
  evals: number;
}

// For each date: (re)project, then evaluate finished games against actual
// outcomes at standard lines, writing model_evals. No market data required.
export async function backfill(from: string, to: string, props: PropKind[]): Promise<BackfillResult> {
  const dates = dateRange(from, to);
  let projected = 0;
  let evals = 0;

  for (const date of dates) {
    projected += await runProjections(date, props);

    const rows = (
      await query<{
        player_id: number; game_id: number; prop_type: PropKind;
        proj_mean: string; proj_stdev: string | null; dist: number[] | null; tb: number | null; so: number | null;
      }>(
        `SELECT p.player_id, p.game_id, p.prop_type, p.proj_mean, p.proj_stdev, p.dist, b.tb, ps.so
         FROM projections p
         JOIN games g ON g.id = p.game_id
         LEFT JOIN player_game_batting  b  ON b.game_id  = p.game_id AND b.player_id  = p.player_id
         LEFT JOIN player_game_pitching ps ON ps.game_id = p.game_id AND ps.player_id = p.player_id
         WHERE g.game_date = $1 AND g.status ILIKE '%final%' AND p.model_version = $2`,
        [date, MODEL_VERSION],
      )
    ).rows;

    await withTx(async (c) => {
      for (const r of rows) {
        const actual = r.prop_type === 'total_bases' ? r.tb : r.so;
        if (actual == null || r.proj_stdev == null) continue;
        const mean = Number(r.proj_mean);
        const stdev = Number(r.proj_stdev);
        for (const line of CANDIDATE_LINES[r.prop_type] ?? []) {
          const modelProb = r.dist ? pOverFromPmf(r.dist, line) : pOver(mean, stdev, line);
          const hit = actual > line;
          await c.query(
            `INSERT INTO model_evals
               (player_id, game_id, prop_type, line, model_prob, actual, hit, model_version)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (player_id, game_id, prop_type, line, model_version)
             DO UPDATE SET model_prob = EXCLUDED.model_prob, actual = EXCLUDED.actual, hit = EXCLUDED.hit`,
            [r.player_id, r.game_id, r.prop_type, line, modelProb.toFixed(4), actual, hit, MODEL_VERSION],
          );
          evals++;
        }
      }
    });
  }

  return { dates: dates.length, projected, evals };
}
