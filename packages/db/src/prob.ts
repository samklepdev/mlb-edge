// Probability helpers shared across pricing, CLV, and the dashboard.

// Abramowitz & Stegun 7.1.26 error-function approximation.
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// P(stat > line) under a normal approximation of the projection. Half-integer
// lines, so no continuity correction. v0 shortcut; a compound distribution is
// more correct for lumpy stats like total bases.
export function pOver(mean: number, stdev: number, line: number): number {
  if (stdev <= 1e-9) return mean > line ? 1 : 0;
  return 1 - normalCdf((line - mean) / stdev);
}

export function americanToImplied(odds: number): number {
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
}

// Remove bookmaker vig from a two-way market.
//
// Proportional de-vig (io/s, iu/s) is the obvious approach and it is wrong for
// longshots: a book shades a +450 home-run "over" far harder than the matching
// "under", so scaling both by the same factor leaves the longshot's fair
// probability too high. That inflated baseline made the model's roughly-correct
// lower number look like a large "under" edge -- it produced 79 under picks
// against 3 overs on home runs alone.
//
// The power method finds the exponent k where io^k + iu^k = 1. Raising a
// probability below 1 to a higher power shrinks the smaller one proportionally
// more, so it removes more vig from the longshot -- which is where the vig
// actually sits.
export function deVig(overOdds: number, underOdds: number): { fairOver: number; fairUnder: number } {
  const io = americanToImplied(overOdds);
  const iu = americanToImplied(underOdds);
  const s = io + iu;
  if (s <= 0) return { fairOver: 0.5, fairUnder: 0.5 };
  if (s <= 1) return { fairOver: io, fairUnder: iu };   // no vig to remove
  if (io <= 0 || iu <= 0) return { fairOver: io / s, fairUnder: iu / s };

  // io^k + iu^k is monotonically decreasing in k (both are < 1), so bisect.
  // A fixed 60 iterations halve a bracket of width 99 to far below double
  // precision: the loop cannot fail to converge, cannot spin, and needs no
  // tolerance that would have to be justified.
  let lo = 1;
  let hi = 100;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (Math.pow(io, mid) + Math.pow(iu, mid) > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  const fo = Math.pow(io, k);
  const fu = Math.pow(iu, k);
  const t = fo + fu;
  if (t <= 0) return { fairOver: io / s, fairUnder: iu / s };
  // Renormalise against residual float error so the pair sums to exactly 1.
  return { fairOver: fo / t, fairUnder: fu / t };
}

// P(stat > line) from an exact probability mass function pmf[k] = P(stat = k).
// Lines are half-integers, so this sums k >= floor(line)+1.
export function pOverFromPmf(pmf: number[], line: number): number {
  const kMin = Math.floor(line) + 1;
  let s = 0;
  for (let k = kMin; k < pmf.length; k++) s += pmf[k] ?? 0;
  return Math.min(1, Math.max(0, s));
}
