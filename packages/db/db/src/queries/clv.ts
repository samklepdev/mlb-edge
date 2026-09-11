import { query } from '../pool.js';
import type { ClvRow } from '../types.js';

// CLV grouped by prop type. Positive avg CLV = the market moved toward our
// picks after we made them -- the leading indicator that an edge is real.
export async function clvByProp(): Promise<ClvRow[]> {
  const res = await query<{
    prop_type: string;
    n: number | string;
    avg_clv: number | string | null;
    hit_rate: number | string | null;
  }>(`
    SELECT prop_type,
           count(*)::int                        AS n,
           (avg(clv_pct))::float8               AS avg_clv,
           (avg((won)::int))::float8            AS hit_rate
    FROM picks
    WHERE close_line IS NOT NULL
    GROUP BY prop_type
    ORDER BY prop_type
  `);
  return res.rows.map((r) => ({
    propType: r.prop_type,
    n: Number(r.n),
    avgClv: r.avg_clv == null ? null : Number(r.avg_clv),
    hitRate: r.hit_rate == null ? null : Number(r.hit_rate),
  }));
}
