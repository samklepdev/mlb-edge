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
        -- A close taken after first pitch is a LIVE in-game price, not a closing
        -- price; NULL means "not verifiable" (pre-backfill or demo data). Both
        -- are excluded from every CLV aggregate below. \`settled\` and
        -- \`synthetic_settled\` are deliberately NOT filtered -- they count
        -- graded outcomes, which capture timing does not affect.
        count(*) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic
                           AND pk.close_captured_at IS NOT NULL
                           AND pk.close_captured_at < g.start_time) AS with_close,
        (avg(pk.clv_pct) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic
                                   AND pk.close_captured_at IS NOT NULL
                                   AND pk.close_captured_at < g.start_time))::float8 AS avg_clv,
        count(*) FILTER (WHERE pk.result IS NOT NULL AND g.is_synthetic)         AS synthetic_settled,
        count(DISTINCT pk.game_id) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic
                                             AND pk.close_captured_at IS NOT NULL
                                             AND pk.close_captured_at < g.start_time) AS clv_games
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
