import { query } from '../pool.js';
import type { ReliabilityBucket, BacktestSummary } from '../types.js';

// Reliability of the model's own probabilities vs realized outcomes (model_evals).
export async function projectionReliability(buckets = 10): Promise<ReliabilityBucket[]> {
  const res = await query<{ model_prob: string; hit: boolean }>(
    `SELECT model_prob, hit FROM model_evals
     WHERE model_version = (SELECT max(model_version) FROM model_evals)`,
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

export async function backtestSummary(): Promise<BacktestSummary> {
  const r = (
    await query<{ n: string; brier: string | null }>(
      `SELECT count(*) AS n,
              avg(power(model_prob - (hit)::int, 2))::float8 AS brier
       FROM model_evals
       WHERE model_version = (SELECT max(model_version) FROM model_evals)`,
    )
  ).rows[0];
  const buckets = await projectionReliability(10);
  const totalN = buckets.reduce((s, b) => s + b.n, 0);
  const ece = totalN === 0 ? null : buckets.reduce((s, b) => s + b.n * Math.abs(b.gap), 0) / totalN;
  return {
    n: Number(r?.n ?? 0),
    ece,
    brier: r?.brier == null ? null : Number(r.brier),
  };
}
