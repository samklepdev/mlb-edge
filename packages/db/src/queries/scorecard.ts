import { query } from '../pool.js';
import { calibrationBuckets } from './calibration.js';
import type { Scorecard } from '../types.js';

/**
 * Retrieves a scorecard containing aggregated performance metrics and calibration data for picks and games.
 *
 * The method queries the database to calculate various metrics such as the number of settled picks,
 * picks with a captured closing line, average closing line value (CLV), and related statistics.
 * Calibration data is also computed for assessing prediction accuracy.
 *
 * @return {Promise<Scorecard>} A promise that resolves to a scorecard object containing:
 *                              - `settledPicks`: Total count of settled picks.
 *                              - `picksWithClose`: Count of picks that have a captured closing line before the game start.
 *                              - `avgClv`: Average CLV percentage for valid picks.
 *                              - `ece`: Expected calibration error (ECE) calculated from calibration buckets.
 *                              - `syntheticSettled`: Count of settled synthetic picks.
 *                              - `clvGames`: Count of unique games associated with valid CLV calculations.
 *                              - `excludedClose`: Count of picks with a closing line excluded from valid CLV aggregation.
 */
export async function getScorecard(): Promise<Scorecard> {
  const row = (
    await query<{
      settled: string; with_close: string; avg_clv: number | string | null;
      synthetic_settled: string; clv_games: string; excluded_close: string;
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
                                             AND pk.close_captured_at < g.start_time) AS clv_games,
        -- Real picks with a close_line that with_close above does NOT count --
        -- captured at/after first pitch, or never stamped. Surfaced so a reader
        -- comparing against a raw \`close_line IS NOT NULL\` count sees where the
        -- gap went, instead of a smaller with_close and no explanation.
        count(*) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic
                           AND NOT (pk.close_captured_at IS NOT NULL
                                     AND pk.close_captured_at < g.start_time)) AS excluded_close
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
    excludedClose: Number(row.excluded_close),
  };
}
