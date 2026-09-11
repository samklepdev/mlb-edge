// Probability helpers shared by edge-finding and CLV.

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

// P(stat > line) under a normal approximation of the projection. Prop lines are
// half-integers, so no continuity correction is needed. This is a v0 shortcut;
// a compound distribution is more correct for lumpy stats like total bases.
export function pOver(mean: number, stdev: number, line: number): number {
  if (stdev <= 1e-9) return mean > line ? 1 : 0;
  return 1 - normalCdf((line - mean) / stdev);
}

// American odds -> implied probability (includes the vig).
export function americanToImplied(odds: number): number {
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
}

// Remove the vig from a two-way market by normalizing the implied probabilities.
export function deVig(overOdds: number, underOdds: number): { fairOver: number; fairUnder: number } {
  const io = americanToImplied(overOdds);
  const iu = americanToImplied(underOdds);
  const s = io + iu;
  if (s <= 0) return { fairOver: 0.5, fairUnder: 0.5 };
  return { fairOver: io / s, fairUnder: iu / s };
}
