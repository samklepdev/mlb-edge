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

export function deVig(overOdds: number, underOdds: number): { fairOver: number; fairUnder: number } {
  const io = americanToImplied(overOdds);
  const iu = americanToImplied(underOdds);
  const s = io + iu;
  if (s <= 0) return { fairOver: 0.5, fairUnder: 0.5 };
  return { fairOver: io / s, fairUnder: iu / s };
}

// P(stat > line) from an exact probability mass function pmf[k] = P(stat = k).
// Lines are half-integers, so this sums k >= floor(line)+1.
export function pOverFromPmf(pmf: number[], line: number): number {
  const kMin = Math.floor(line) + 1;
  let s = 0;
  for (let k = kMin; k < pmf.length; k++) s += pmf[k] ?? 0;
  return Math.min(1, Math.max(0, s));
}
