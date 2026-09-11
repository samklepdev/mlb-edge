import { shrinkRate } from './shrink.js';
import { clamp, K_PA, K_BF } from './model.js';

export interface LeagueBatting {
  p1: number; p2: number; p3: number; p4: number; // per-PA event probabilities
  soPerPa: number;
}
export interface BatterHistory {
  pa: number; singles: number; doubles: number; triples: number; hr: number; games: number;
}
export interface PitcherHistory {
  bf: number; so: number; h: number; appearances: number;
}
export interface Projection { mean: number; stdev: number; pmf: number[] }

function convolve(a: number[], b: number[]): number[] {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  return out;
}
// Exact PMF of a sum of `expN` iid trials (fractional expN mixes floor/ceil).
function compound(perTrial: number[], expN: number): number[] {
  const lo = Math.max(0, Math.floor(expN));
  const w = expN - lo;
  let pmfLo: number[] = [1];
  for (let i = 0; i < lo; i++) pmfLo = convolve(pmfLo, perTrial);
  const pmfHi = convolve(pmfLo, perTrial);
  const len = Math.max(pmfLo.length, pmfHi.length);
  const out = new Array(len).fill(0);
  for (let k = 0; k < len; k++) out[k] = (1 - w) * (pmfLo[k] ?? 0) + w * (pmfHi[k] ?? 0);
  return out;
}
function statsFromPmf(pmf: number[]): { mean: number; stdev: number } {
  let m = 0, e2 = 0;
  for (let k = 0; k < pmf.length; k++) { m += k * pmf[k]; e2 += k * k * pmf[k]; }
  return { mean: m, stdev: Math.sqrt(Math.max(0, e2 - m * m)) };
}

// Total bases: per-PA {0,1,2,3,4} outcome distribution (shrunk to league and
// adjusted for matchup), convolved over expected PAs into the exact game PMF.
export function projectTotalBases(args: {
  hist: BatterHistory; league: LeagueBatting; expPa: number; adj: number;
}): Projection {
  const { hist, league, expPa } = args;
  const p1 = shrinkRate(hist.singles, hist.pa, league.p1, K_PA);
  const p2 = shrinkRate(hist.doubles, hist.pa, league.p2, K_PA);
  const p3 = shrinkRate(hist.triples, hist.pa, league.p3, K_PA);
  const p4 = shrinkRate(hist.hr, hist.pa, league.p4, K_PA);

  const a = clamp(args.adj, 0.7, 1.4);
  let q1 = p1 * a, q2 = p2 * a, q3 = p3 * a, q4 = p4 * a;
  const hitSum = q1 + q2 + q3 + q4;
  if (hitSum > 0.95) { const s = 0.95 / hitSum; q1 *= s; q2 *= s; q3 *= s; q4 *= s; }
  const q0 = Math.max(0, 1 - (q1 + q2 + q3 + q4));

  const perPa = [q0, q1, q2, q3, q4];   // TB per plate appearance
  const pmf = compound(perPa, expPa);
  return { ...statsFromPmf(pmf), pmf };
}

// Strikeouts: exact Binomial(expected batters faced, shrunk per-BF K rate).
export function projectStrikeouts(args: {
  hist: PitcherHistory; leagueSoPerBf: number; expBf: number; oppKFactor: number;
}): Projection {
  const base = shrinkRate(args.hist.so, args.hist.bf, args.leagueSoPerBf, K_BF);
  const rate = clamp(base * clamp(args.oppKFactor, 0.85, 1.2), 0.05, 0.5);
  const pmf = compound([1 - rate, rate], args.expBf);
  return { ...statsFromPmf(pmf), pmf };
}
