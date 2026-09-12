import { query } from '../pool.js';
import type { CalibrationBucket } from '../types.js';

// Reliability buckets: across every pick tagged at ~p, did they win ~p of the
// time? A straight curve (gap ~ 0 everywhere) is the "did I get there" test.
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
