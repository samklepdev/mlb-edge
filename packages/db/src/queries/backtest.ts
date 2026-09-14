import { query } from '../pool.js';
import type { ReliabilityBucket, BacktestSummary } from '../types.js';

/**
 * Computes reliability metrics by dividing the predictions into buckets and calculates the gap between actual and predicted probabilities.
 *
 * @param {number} [buckets=10] - The number of buckets to divide the predictions into.
 * @param {string} [prop] - An optional parameter to filter the data based on a specific property type.
 * @return {Promise<ReliabilityBucket[]>} - A promise that resolves to an array of reliability buckets, each containing statistical data for that bucket.
 */
export async function projectionReliability(buckets = 10, prop?: string): Promise<ReliabilityBucket[]> {
  const params: string[] = [];
  let where = 'me.model_version = (SELECT max(model_version) FROM model_evals) AND NOT g.is_synthetic';
  if (prop) {
    params.push(prop);
    where += ` AND me.prop_type = $${params.length}`;
  }
  const res = await query<{ model_prob: string; hit: boolean }>(
    `SELECT me.model_prob, me.hit
     FROM model_evals me
     JOIN games g ON g.id = me.game_id
     WHERE ${where}`,
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

/**
 * Generates a backtesting summary which includes key metrics for evaluating model performance, such as sample count,
 * Brier score, expected calibration error (ECE), and reliability projection.
 *
 * @param {string} [prop] - An optional property type filter for model evaluations. If provided, results will
 *                          be filtered by the specified property type.
 * @return {Promise<BacktestSummary>} A promise that resolves to an object containing the backtest results,
 *                                    including the sample count (`n`), Brier score, expected calibration error (ECE),
 *                                    and detailed reliability information in buckets.
 */
export async function backtestSummary(prop?: string): Promise<BacktestSummary> {
  const params: string[] = [];
  let where = 'me.model_version = (SELECT max(model_version) FROM model_evals) AND NOT g.is_synthetic';
  if (prop) {
    params.push(prop);
    where += ` AND me.prop_type = $${params.length}`;
  }
  const r = (
    await query<{ n: string; brier: string | null }>(
      `SELECT count(*) AS n,
              avg(power(me.model_prob - (me.hit)::int, 2))::float8 AS brier
       FROM model_evals me
       JOIN games g ON g.id = me.game_id
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

/**
 * Evaluates and retrieves a list of property types from the model evaluations dataset.
 *
 * The method queries the database to fetch property types associated with the most recent
 * model version, excluding synthetic games, and orders the results by descending frequency.
 *
 * @return {Promise<string[]>} A promise that resolves to an array of property type strings.
 */
export async function evalPropTypes(): Promise<string[]> {
  const res = await query<{ prop_type: string }>(
    `SELECT me.prop_type
     FROM model_evals me
     JOIN games g ON g.id = me.game_id
     WHERE me.model_version = (SELECT max(model_version) FROM model_evals) AND NOT g.is_synthetic
     GROUP BY me.prop_type
     ORDER BY count(*) DESC`,
  );
  return res.rows.map((r) => r.prop_type);
}
