import { query } from '../pool.js';
import type { ReliabilityBucket, BacktestSummary } from '../types.js';

// Reliability of the model's own probabilities vs realized outcomes (model_evals).
// `prop` optionally restricts to a single prop_type; omitted, it pools every prop
// evaluated at the latest model_version (see backtestReport for why pooling
// across a mixed prop population is misleading).
export async function projectionReliability(buckets = 10, prop?: string): Promise<ReliabilityBucket[]> {
  const params: string[] = [];
  let where = 'model_version = (SELECT max(model_version) FROM model_evals)';
  if (prop) {
    params.push(prop);
    where += ` AND prop_type = $${params.length}`;
  }
  const res = await query<{ model_prob: string; hit: boolean }>(
    `SELECT model_prob, hit FROM model_evals WHERE ${where}`,
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

export async function backtestSummary(prop?: string): Promise<BacktestSummary> {
  const params: string[] = [];
  let where = 'model_version = (SELECT max(model_version) FROM model_evals)';
  if (prop) {
    params.push(prop);
    where += ` AND prop_type = $${params.length}`;
  }
  const r = (
    await query<{ n: string; brier: string | null }>(
      `SELECT count(*) AS n,
              avg(power(model_prob - (hit)::int, 2))::float8 AS brier
       FROM model_evals
       WHERE ${where}`,
      params,
    )
  ).rows[0];
  const buckets = await projectionReliability(10, prop);
  const totalN = buckets.reduce((s, b) => s + b.n, 0);
  const ece = totalN === 0 ? null : buckets.reduce((s, b) => s + b.n * Math.abs(b.gap), 0) / totalN;
  return {
    n: Number(r?.n ?? 0),
    ece,
    brier: r?.brier == null ? null : Number(r.brier),
  };
}

// Distinct prop types present at the current (latest) model_version, ordered by
// row count descending -- lets the report enumerate what exists instead of
// hardcoding prop names that drift out of sync with props.ts.
export async function evalPropTypes(): Promise<string[]> {
  const res = await query<{ prop_type: string }>(
    `SELECT prop_type FROM model_evals
     WHERE model_version = (SELECT max(model_version) FROM model_evals)
     GROUP BY prop_type
     ORDER BY count(*) DESC`,
  );
  return res.rows.map((r) => r.prop_type);
}
