import { shrinkRate } from './shrink.js';
import { clamp, K_PA, K_BF } from './model.js';

export interface LeagueBatting {
  p1: number; p2: number; p3: number; p4: number; // per-PA event probabilities
  soPerPa: number;
}

export interface BatterHistory {
  pa: number; singles: number; doubles: number; triples: number; hr: number; games: number;
}

// Total bases as a per-PA {0,1,2,3,4} distribution: shrink each event rate
// toward league, apply the matchup multiplier to hit outcomes, then sum over
// independent plate appearances to get a game-level mean and stdev.
export function projectTotalBases(args: {
  hist: BatterHistory;
  league: LeagueBatting;
  expPa: number;
  adj: number; // combined park * pitcher * weather multiplier on hit rates
}): { mean: number; stdev: number } {
  const { hist, league, expPa } = args;
  const p1 = shrinkRate(hist.singles, hist.pa, league.p1, K_PA);
  const p2 = shrinkRate(hist.doubles, hist.pa, league.p2, K_PA);
  const p3 = shrinkRate(hist.triples, hist.pa, league.p3, K_PA);
  const p4 = shrinkRate(hist.hr, hist.pa, league.p4, K_PA);

  const a = clamp(args.adj, 0.7, 1.4);
  let q1 = p1 * a, q2 = p2 * a, q3 = p3 * a, q4 = p4 * a;
  const hitSum = q1 + q2 + q3 + q4;
  if (hitSum > 0.95) {
    const s = 0.95 / hitSum;
    q1 *= s; q2 *= s; q3 *= s; q4 *= s;
  }

  const m = q1 + 2 * q2 + 3 * q3 + 4 * q4;           // per-PA mean TB
  const ex2 = q1 + 4 * q2 + 9 * q3 + 16 * q4;         // per-PA E[TB^2]
  const v = Math.max(1e-6, ex2 - m * m);              // per-PA variance
  return { mean: expPa * m, stdev: Math.sqrt(expPa * v) };
}

export interface PitcherHistory {
  bf: number; so: number; h: number; appearances: number;
}

// Strikeouts as Binomial(expected batters faced, per-BF K rate), where the rate
// is the pitcher's shrunk K/BF scaled by how K-prone the opposing lineup is.
export function projectStrikeouts(args: {
  hist: PitcherHistory;
  leagueSoPerBf: number;
  expBf: number;
  oppKFactor: number;
}): { mean: number; stdev: number } {
  const base = shrinkRate(args.hist.so, args.hist.bf, args.leagueSoPerBf, K_BF);
  const rate = clamp(base * clamp(args.oppKFactor, 0.85, 1.2), 0.05, 0.5);
  const n = args.expBf;
  return { mean: n * rate, stdev: Math.sqrt(n * rate * (1 - rate)) };
}
