/**
 * Computes the error function (erf) of a given number.
 *
 * The error function is a mathematical function used in probability, statistics, and partial differential equations.
 *
 * @param {number} x - The input value for which the error function is to be computed.
 * @return {number} The value of the error function for the given input.
 */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/**
 * Computes the cumulative distribution function (CDF) of the standard normal distribution for a given z-value.
 *
 * @param z The z-value for which the CDF is to be calculated.
 * @return The value of the CDF for the given z-value.
 */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Calculates the probability that a value is greater than a given threshold
 * assuming a normal distribution defined by the provided mean and standard deviation.
 *
 * @param {number} mean - The mean of the normal distribution.
 * @param {number} stdev - The standard deviation of the normal distribution.
 * @param {number} line - The threshold line to compare against.
 * @return {number} The probability that a value drawn from the distribution is greater than the threshold.
 */
export function pOver(mean: number, stdev: number, line: number): number {
  if (stdev <= 1e-9) return mean > line ? 1 : 0;
  return 1 - normalCdf((line - mean) / stdev);
}

/**
 * Converts American odds to implied probability.
 *
 * @param {number} odds - The American odds to be converted.
 * @return {number} The implied probability as a decimal.
 */
export function americanToImplied(odds: number): number {
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
}

/**
 * Removes the vig (overround) from a pair of American odds, returning the fair probabilities.
 *
 * @param {number} overOdds - The American odds for the "over" outcome.
 * @param {number} underOdds - The American odds for the "under" outcome.
 * @return {{ fairOver: number; fairUnder: number }} An object containing the fair probabilities for both outcomes.
 */
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

/**
 * Calculates the probability of a value being over a given threshold based on a probability mass function (PMF).
 *
 * @param {number[]} pmf - An array representing the probability mass function, where each index corresponds to a discrete outcome and the value at that index is its probability.
 * @param {number} line - The threshold value beyond which the probabilities are summed.
 * @return {number} The sum of probabilities for all outcomes greater than the specified threshold, clamped between 0 and 1.
 */
export function pOverFromPmf(pmf: number[], line: number): number {
  const kMin = Math.floor(line) + 1;
  let s = 0;
  for (let k = kMin; k < pmf.length; k++) s += pmf[k] ?? 0;
  return Math.min(1, Math.max(0, s));
}
