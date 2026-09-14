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
    FROM picks pk JOIN games g ON g.id = pk.game_id
    WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic
      -- A close taken after first pitch is a LIVE in-game price, not a closing
      -- price. Structural rather than incidental: the guarantee holds even if a
      -- future capture runs at the wrong time. NULL means "not verifiable"
      -- (pre-backfill or demo data) and is excluded for the same reason.
      AND pk.close_captured_at IS NOT NULL
      AND pk.close_captured_at < g.start_time
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

// Rows that have a closing line but are excluded from clvByProp above -- either
// captured at or after first pitch (a live in-game price, not a closing one) or
// never stamped (not verifiable). Reported alongside the CLV table so a reader
// comparing against a raw `close_line IS NOT NULL` count sees where the gap
// went, instead of a smaller n with no explanation.
export async function clvExcludedCount(): Promise<number> {
  const res = await query<{ n: number | string }>(`
    SELECT count(*)::int AS n
    FROM picks pk JOIN games g ON g.id = pk.game_id
    WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic
      AND NOT (pk.close_captured_at IS NOT NULL AND pk.close_captured_at < g.start_time)
  `);
  return Number(res.rows[0].n);
}
