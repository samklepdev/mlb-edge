// Empirical-Bayes style shrinkage of a rate toward a prior (league) mean.
// successes/n is the observed rate; k is the regression weight in the same
// units as n (think of it as k pseudo-observations pinned at priorMean).
// With no own sample (n = 0) this returns priorMean exactly.
export function shrinkRate(successes: number, n: number, priorMean: number, k: number): number {
  return (successes + k * priorMean) / (n + k);
}
