import type { ResolutionStats, ResolutionCheck } from './types.js';

// Cluster-count floor. Cluster-robust standard errors are sharply
// downward-biased with few clusters, so below this the interval would be
// fake-narrow exactly where the data is thinnest. A pre-registered floor, not a
// tunable knob.
export const MIN_GAMES = 30;

// t(0.975, df), as [df breakpoint, t] ascending by df.
//
// Selection rule: take the row with the largest breakpoint not exceeding df.
// t decreases with df, so this always returns a t at least as large as the true
// value -- the interval errs wide.
//
// The table bottoms out at 1.980 and deliberately has no 1.960 row: the true
// t(0.975, 200) is 1.972, so a 1.960 row would narrow the interval BELOW truth
// and break that guarantee. Holding 1.980 overstates the half-width by at most
// 1% as df -> infinity, which is the right direction to be wrong in.
const T_TABLE: ReadonlyArray<readonly [number, number]> = [
  [29, 2.045],
  [40, 2.021],
  [60, 2.0],
  [120, 1.98],
];

export function tCritical(df: number): number {
  let t = T_TABLE[0][1];
  for (const [breakpoint, value] of T_TABLE) {
    if (df >= breakpoint) t = value;
  }
  return t;
}

// Turn one market's sufficient statistics into the advantage, its
// game-clustered interval, and a three-state verdict.
//
// The advantage is baseRateBrier - modelBrier, where baseRateBrier = r(1-r) is
// the Brier score of always predicting the market's own hit rate. Positive means
// the model beats that no-information baseline.
//
// INDISTINGUISHABLE is the default: both BEATS and WORSE must earn significance.
// A bare sign test on this quantity reports noise as a finding in both
// directions.
export function resolutionFromStats(s: ResolutionStats): ResolutionCheck {
  const { n, games, baseRate, modelBrier, sumDg, sumDg2, sumNgDg, sumNg2 } = s;

  const baseRateBrier = baseRate == null ? null : baseRate * (1 - baseRate);
  const advantage = n === 0 ? null : sumDg / n;

  let se: number | null = null;
  if (advantage != null && games >= 2) {
    // With S_g = D_g - n_g*A, the clustered variance needs sum(S_g^2). Expanding
    // lets SQL supply the four sums and skips a second pass over the rows:
    //   sum(S_g^2) = sum(D_g^2) - 2A*sum(n_g*D_g) + A^2*sum(n_g^2)
    const ssq = sumDg2 - 2 * advantage * sumNgDg + advantage * advantage * sumNg2;
    // That expansion is a difference of large similar terms, so cancellation can
    // land a hair below zero when the true value is ~0. Clamp rather than NaN.
    se = Math.sqrt((games / (games - 1)) * Math.max(0, ssq)) / n;
  }

  const out: ResolutionCheck = {
    n,
    games,
    baseRate,
    baseRateBrier,
    modelBrier,
    advantage,
    se,
    ciLo: null,
    ciHi: null,
    skillScore: null,
    verdict: 'insufficient',
  };

  if (n === 0 || games < MIN_GAMES) return out;
  if (advantage == null || se == null || se === 0) return out;
  // r of exactly 0 or 1 makes baseRateBrier 0, so advantage = -modelBrier <= 0
  // by construction: the baseline is a perfect in-sample predictor and the
  // comparison is vacuous. Without this guard such a market prints a confident
  // WORSE.
  if (baseRate == null || baseRate === 0 || baseRate === 1) return out;
  if (baseRateBrier == null || baseRateBrier === 0) return out;

  const t = tCritical(games - 1);
  out.ciLo = advantage - t * se;
  out.ciHi = advantage + t * se;
  out.skillScore = advantage / baseRateBrier;
  out.verdict = out.ciLo > 0 ? 'beats' : out.ciHi < 0 ? 'worse' : 'indistinguishable';
  return out;
}
