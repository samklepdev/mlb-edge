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
// The advantage is baseRateBrier - modelBrier. baseRateBrier is the Brier score
// of a baseline that predicts, for every game, the hit rate of the specific
// (market, line) being evaluated -- i.e. the n-weighted mean of r_k(1-r_k)
// across that market's candidate lines, supplied by SQL. Positive means the
// model beats that no-information baseline.
//
// The baseline is deliberately GIVEN THE LINE. Pooling one base rate per market
// would make the baseline weaker than the model's own information set, since
//   pooled r(1-r) = E[r_k(1-r_k)] + Var(r_k),
// so the model would collect Var(r_k) -- pure line identity -- as "skill". For
// run_line that term alone is 0.01905, which was essentially the whole apparent
// advantage under the pooled baseline.
//
// INDISTINGUISHABLE is the default: both BEATS and WORSE must earn significance.
// A bare sign test on this quantity reports noise as a finding in both
// directions.
export function resolutionFromStats(s: ResolutionStats): ResolutionCheck {
  const {
    n, games, baseRate, baseRateBrier, lines, baseRateLo, baseRateHi,
    modelBrier, sumDg, sumDg2, sumNgDg, sumNg2,
  } = s;

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
    lines,
    baseRateLo,
    baseRateHi,
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
  // baseRateBrier == 0 holds exactly when EVERY line's rate r_k is 0 or 1, and
  // then advantage = -modelBrier <= 0 by construction: the baseline is a perfect
  // in-sample predictor and the comparison is vacuous. Without this guard such a
  // market prints a confident WORSE.
  //
  // This is tested on baseRateBrier, not on the pooled baseRate: with a per-line
  // baseline the pooled rate can sit anywhere (two lines at r=0 and r=1 pool to
  // 0.5) while every cell is still degenerate, and conversely a non-degenerate
  // set of lines can never make baseRateBrier 0.
  if (baseRateBrier == null || baseRateBrier === 0) return out;

  const t = tCritical(games - 1);
  out.ciLo = advantage - t * se;
  out.ciHi = advantage + t * se;
  out.skillScore = advantage / baseRateBrier;
  out.verdict = out.ciLo > 0 ? 'beats' : out.ciHi < 0 ? 'worse' : 'indistinguishable';
  return out;
}
