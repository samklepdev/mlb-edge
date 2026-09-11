import { query } from '../pool.js';
import { calibrationBuckets } from './calibration.js';
import type { Scorecard } from '../types.js';

export async function getScorecard(): Promise<Scorecard> {
  const row = (
    await query<{ settled: string; with_close: string; avg_clv: number | string | null }>(`
      SELECT
        count(*) FILTER (WHERE result IS NOT NULL)                          AS settled,
        count(*) FILTER (WHERE close_line IS NOT NULL)                      AS with_close,
        (avg(clv_pct) FILTER (WHERE close_line IS NOT NULL))::float8        AS avg_clv
      FROM picks
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
  };
}
