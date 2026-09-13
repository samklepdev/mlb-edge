import { query } from '../pool.js';
import type { ReliabilityBucket, BacktestSummary } from '../types.js';

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
