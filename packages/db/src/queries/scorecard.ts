import { query } from '../pool.js';
import { calibrationBuckets } from './calibration.js';
import type { Scorecard } from '../types.js';

export async function getScorecard(): Promise<Scorecard> {
  const row = (
    await query<{
      settled: string; with_close: string; avg_clv: number | string | null;
      synthetic_settled: string; clv_games: string;
    }>(`
      SELECT
        count(*) FILTER (WHERE pk.result IS NOT NULL AND NOT g.is_synthetic)     AS settled,
        count(*) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic) AS with_close,
        (avg(pk.clv_pct) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic))::float8 AS avg_clv,
        count(*) FILTER (WHERE pk.result IS NOT NULL AND g.is_synthetic)         AS synthetic_settled,
        count(DISTINCT pk.game_id) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic) AS clv_games
      FROM picks pk JOIN games g ON g.id = pk.game_id
    `)
  ).rows[0];

  const buckets = await calibrationBuckets(10);
  const totalN = buckets.reduce((s, b) => s + b.n, 0);
  const ece = totalN === 0 ? null : buckets.reduce((s, b) => s + b.n * Math.abs(b.gap), 0) / totalN;

  return {
    settledPicks: Number(row.settled),
    picksWithClose: Number(row.with_close),
    avgClv: row.avg_clv == null ? null : Number(row.avg_clv),
    ece,
    syntheticSettled: Number(row.synthetic_settled),
    clvGames: Number(row.clv_games),
  };
}
