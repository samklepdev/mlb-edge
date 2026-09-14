import { query } from '../pool.js';
import type { CalibrationBucket } from '../types.js';

/**
 * Calculates calibration buckets based on prediction probabilities and their actual outcomes.
 *
 * @param {number} [buckets=10] - The number of buckets to divide the predictions into. Each bucket represents a range of prediction probabilities.
 * @return {Promise<CalibrationBucket[]>} A promise that resolves to an array of calibration buckets, each containing the prediction range, the number of predictions,
 * the average predicted probability, the actual outcome probability, and the gap between actual and predicted probabilities.
 */
export async function calibrationBuckets(buckets = 10): Promise<CalibrationBucket[]> {
  const res = await query<{ pick_prob: number | string; won: boolean }>(
    `SELECT pk.pick_prob, pk.won
     FROM picks pk JOIN games g ON g.id = pk.game_id
     WHERE pk.result IS NOT NULL AND pk.won IS NOT NULL AND NOT g.is_synthetic`,
  );

  const bins = Array.from({ length: buckets }, () => ({ n: 0, predSum: 0, wins: 0 }));
  for (const row of res.rows) {
    const p = Number(row.pick_prob);
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor(p * buckets)));
    bins[idx].n++;
    bins[idx].predSum += p;
    if (row.won) bins[idx].wins++;
  }

  const out: CalibrationBucket[] = [];
  bins.forEach((b, i) => {
    if (b.n === 0) return;
    const predicted = b.predSum / b.n;
    const actual = b.wins / b.n;
    out.push({ lo: i / buckets, hi: (i + 1) / buckets, n: b.n, predicted, actual, gap: actual - predicted });
  });
  return out;
}
