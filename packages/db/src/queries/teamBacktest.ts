import { query } from '../pool.js';
import type { ReliabilityBucket, BacktestSummary, ResolutionCheck } from '../types.js';
import { resolutionFromStats } from '../resolution.js';

// Reliability of the game-outcome model's probabilities vs realized outcomes.
// Scoped to team_model_evals and TEAM_MODEL_VERSION -- deliberately separate
// from the prop model's backtest, which reads model_evals.
export async function teamReliability(buckets = 10, market?: string): Promise<ReliabilityBucket[]> {
  const params: string[] = [];
  let where = "me.model_version = (SELECT max(model_version) FROM team_model_evals)";
  if (market) {
    params.push(market);
    where += ` AND me.market = $${params.length}`;
  }
  const res = await query<{ model_prob: string; hit: boolean }>(
    `SELECT me.model_prob, me.hit FROM team_model_evals me WHERE ${where}`,
    params,
  );
  const bins = Array.from({ length: buckets }, () => ({ n: 0, predSum: 0, hits: 0 }));
  for (const r of res.rows) {
    const p = Number(r.model_prob);
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor(p * buckets)));
    bins[idx].n++;
    bins[idx].predSum += p;
    if (r.hit) bins[idx].hits++;
  }
  const out: ReliabilityBucket[] = [];
  bins.forEach((b, i) => {
    if (b.n === 0) return;
    const predicted = b.predSum / b.n;
    const actual = b.hits / b.n;
    out.push({ lo: i / buckets, hi: (i + 1) / buckets, n: b.n, predicted, actual, gap: actual - predicted });
  });
  return out;
}

export async function teamBacktestSummary(market?: string): Promise<BacktestSummary> {
  const params: string[] = [];
  let where = "me.model_version = (SELECT max(model_version) FROM team_model_evals)";
  if (market) {
    params.push(market);
    where += ` AND me.market = $${params.length}`;
  }
  const r = (
    await query<{ n: string; brier: string | null }>(
      `SELECT count(*) AS n, avg(power(me.model_prob - (me.hit)::int, 2))::float8 AS brier
       FROM team_model_evals me WHERE ${where}`,
      params,
    )
  ).rows[0];
  const buckets = await teamReliability(10, market);
  const totalN = buckets.reduce((s, b) => s + b.n, 0);
  const ece = totalN === 0 ? null : buckets.reduce((s, b) => s + b.n * Math.abs(b.gap), 0) / totalN;
  return { n: Number(r?.n ?? 0), ece, brier: r?.brier == null ? null : Number(r.brier) };
}

export async function teamEvalMarkets(): Promise<string[]> {
  const res = await query<{ market: string }>(
    `SELECT me.market FROM team_model_evals me
     WHERE me.model_version = (SELECT max(model_version) FROM team_model_evals)
     GROUP BY me.market ORDER BY count(*) DESC`,
  );
  return res.rows.map((r) => r.market);
}

// Does this market's model beat simply predicting, for each candidate line, that
// line's own hit rate?
//
// The baseline is per (market, line) rather than per market. A market spans
// several candidate lines with very different hit rates -- run_line -1.5 hits
// 64.2% and +1.5 hits 36.6% -- and the model is told which line it is pricing.
// Because pooled r(1-r) = E[r_k(1-r_k)] + Var(r_k), a single pooled base rate
// would hand the model Var(r_k) for free, and that term is line identity, not
// skill: for run_line it is 0.01905, essentially the entire advantage the pooled
// baseline used to report.
//
// Clustered by game_id, which is not optional here: team_model_evals is unique
// on (game_id, team_id, market, line, model_version), so one game contributes 4
// `total` evals (four candidate lines), 2 `run_line`, and 1 `moneyline` -- all
// scored against a single realized outcome. Treating those as independent
// misstates the standard error, and not by a fixed factor: under the per-line
// baseline clustering inflates `total`'s SE 1.81x and `run_line`'s 1.23x, while
// `moneyline`'s (one eval per game) is unchanged. It has to be computed -- under
// a pooled baseline the same correction SHRANK `run_line`'s SE to 0.88x, because
// the two sides' d_i offset within a game when both are scored against one
// pooled rate.
//
// Returns sufficient statistics only; all arithmetic lives in resolution.ts so
// it is exercisable without a database.
export async function teamResolution(market?: string): Promise<ResolutionCheck> {
  const params: string[] = [];
  let where = "me.model_version = (SELECT max(model_version) FROM team_model_evals)";
  if (market) {
    params.push(market);
    where += ` AND me.market = $${params.length}`;
  }
  const res = await query<{
    n: string;
    games: string;
    base_rate: number | null;
    base_rate_brier: number | null;
    lines: string;
    base_rate_lo: number | null;
    base_rate_hi: number | null;
    model_brier: number | null;
    sum_dg: number;
    sum_dg2: number;
    sum_ng_dg: number;
    sum_ng2: number;
  }>(
    `WITH e AS (
       SELECT me.game_id, me.market, me.line::float8 AS line,
              me.model_prob::float8 AS p, (me.hit)::int AS y
       FROM team_model_evals me WHERE ${where}
     ),
     -- One baseline cell per (market, line). Grouping on market too keeps the
     -- unfiltered (all-markets) call honest: a line number means different
     -- things in different markets.
     rk AS (
       SELECT market, line, avg(y)::float8 AS r, count(*)::float8 AS nk
       FROM e GROUP BY market, line
     ),
     agg AS (
       SELECT count(*)::int8               AS n,
              count(DISTINCT game_id)::int8 AS games,
              avg(y)::float8                AS base_rate,
              avg(power(p - y, 2))::float8  AS model_brier
       FROM e
     ),
     -- baseRateBrier = n-weighted mean of r_k(1-r_k), which is identically
     -- mean((r_k - y_i)^2) over the evals -- so advantage = baseRateBrier -
     -- modelBrier holds exactly, the same way it did for the pooled r(1-r).
     base AS (
       SELECT count(*)::int8                        AS lines,
              (sum(nk * r * (1 - r)) / sum(nk))::float8 AS base_rate_brier,
              min(r)::float8                        AS base_rate_lo,
              max(r)::float8                        AS base_rate_hi
       FROM rk
     ),
     -- d_i = (r_k - y_i)^2 - (p_i - y_i)^2, with r_k the hit rate of eval i's
     -- OWN (market, line).
     d AS (
       SELECT e.game_id,
              (power(rk.r - e.y, 2) - power(e.p - e.y, 2))::float8 AS di
       FROM e
       JOIN rk ON rk.market = e.market AND rk.line IS NOT DISTINCT FROM e.line
     ),
     per_game AS (
       SELECT game_id, sum(di)::float8 AS dg, count(*)::float8 AS ng
       FROM d GROUP BY game_id
     )
     SELECT agg.n::text AS n,
            agg.games::text AS games,
            agg.base_rate,
            base.base_rate_brier,
            base.lines::text AS lines,
            base.base_rate_lo,
            base.base_rate_hi,
            agg.model_brier,
            coalesce(sum(pg.dg), 0)::float8         AS sum_dg,
            coalesce(sum(pg.dg * pg.dg), 0)::float8 AS sum_dg2,
            coalesce(sum(pg.ng * pg.dg), 0)::float8 AS sum_ng_dg,
            coalesce(sum(pg.ng * pg.ng), 0)::float8 AS sum_ng2
     FROM agg CROSS JOIN base LEFT JOIN per_game pg ON true
     GROUP BY agg.n, agg.games, agg.base_rate, base.base_rate_brier,
              base.lines, base.base_rate_lo, base.base_rate_hi, agg.model_brier`,
    params,
  );
  const row = res.rows[0];
  if (!row) {
    return resolutionFromStats({
      n: 0, games: 0, baseRate: null, baseRateBrier: null,
      lines: 0, baseRateLo: null, baseRateHi: null, modelBrier: null,
      sumDg: 0, sumDg2: 0, sumNgDg: 0, sumNg2: 0,
    });
  }
  return resolutionFromStats({
    n: Number(row.n),
    games: Number(row.games),
    baseRate: row.base_rate == null ? null : Number(row.base_rate),
    baseRateBrier: row.base_rate_brier == null ? null : Number(row.base_rate_brier),
    lines: Number(row.lines),
    baseRateLo: row.base_rate_lo == null ? null : Number(row.base_rate_lo),
    baseRateHi: row.base_rate_hi == null ? null : Number(row.base_rate_hi),
    modelBrier: row.model_brier == null ? null : Number(row.model_brier),
    sumDg: Number(row.sum_dg),
    sumDg2: Number(row.sum_dg2),
    sumNgDg: Number(row.sum_ng_dg),
    sumNg2: Number(row.sum_ng2),
  });
}
