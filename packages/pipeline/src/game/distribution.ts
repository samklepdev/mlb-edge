// Runs per team-game are OVERDISPERSED relative to Poisson: measured variance
// 10.697 against mean 4.523, a variance/mean of 2.365 where Poisson requires
// exactly 1.0. So the family is negative binomial, whose variance is
// mean + mean^2/r.
//
// Built by recurrence rather than the closed form, which avoids needing a
// gamma function for non-integer r entirely:
//   P(0) = p^r
//   P(k) = P(k-1) * ((k + r - 1) / k) * (1 - p)      where p = r / (r + mean)
export function runsPmf(mean: number, dispersion: number, maxRuns = 40): number[] {
  if (!(mean > 0) || !(dispersion > 0)) return [1];
  const p = dispersion / (dispersion + mean);
  const pmf: number[] = [Math.pow(p, dispersion)];
  for (let k = 1; k <= maxRuns; k++) {
    pmf.push(pmf[k - 1] * ((k + dispersion - 1) / k) * (1 - p));
  }
  // Renormalise against the truncated tail beyond maxRuns.
  const total = pmf.reduce((s, x) => s + x, 0);
  return total > 0 ? pmf.map((x) => x / total) : pmf;
}

// Distribution of the SUM of two independent counts.
export function convolve(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  }
  return out;
}

// P(home + away > line). Lines are half-integers, so no tie case arises.
export function pTotalOver(home: number[], away: number[], line: number): number {
  const total = convolve(home, away);
  let s = 0;
  for (let k = 0; k < total.length; k++) if (k > line) s += total[k];
  return s;
}

// P(home - away > line), for the run line. Half-integer lines again, so no tie.
export function pMarginOver(home: number[], away: number[], line: number): number {
  let s = 0;
  for (let h = 0; h < home.length; h++) {
    for (let a = 0; a < away.length; a++) {
      if (h - a > line) s += home[h] * away[a];
    }
  }
  return s;
}

// P(home team wins).
//
// Convolution puts real mass on home == away, an outcome that cannot occur --
// MLB has no ties. That mass is split 50/50, and the 50/50 is deliberate:
// home advantage is ALREADY in the run means (4.592 vs 4.453 measured), so
// biasing the tie-split toward the home team would count the same effect
// twice. Real extra-innings outcomes do lean home (~52-54%), but there is no
// inning-level data here to fit that, so this is an honest approximation and
// not a result.
export function pHomeWin(home: number[], away: number[]): number {
  let win = 0;
  let tie = 0;
  for (let h = 0; h < home.length; h++) {
    for (let a = 0; a < away.length; a++) {
      const m = home[h] * away[a];
      if (h > a) win += m;
      else if (h === a) tie += m;
    }
  }
  return win + 0.5 * tie;
}
