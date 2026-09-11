// Tunable constants for the v0 projection model. These are deliberately
// conservative and exposed here so they are easy to sweep during calibration.
export const MODEL_VERSION = 'tb-so-v0.1';

// Shrinkage weights, in pseudo-observations. Larger = regress harder toward the
// league mean (a player needs more of their own sample to move the estimate).
export const K_PA = 200; // batting rates (per plate appearance)
export const K_BF = 300; // pitching rates (per batter faced)

// Expected opportunities per game, with sane clamps and fallbacks.
export const DEFAULT_PA = 4.1;
export const PA_CLAMP: readonly [number, number] = [2.5, 5.2];
export const DEFAULT_BF = 22;
export const BF_CLAMP: readonly [number, number] = [8, 30];

// Minimum own-sample before we project a player at all.
export const MIN_PA = 20;
export const MIN_BF = 30;

// Window (days) used to infer active rosters and team-level tendencies.
export const RECENT_DAYS = 30;

// Fallback league priors for an otherwise-empty database, so projections still
// run before much history is ingested. Per-PA probabilities.
export const LEAGUE_PRIOR = {
  p1: 0.152, // single
  p2: 0.046, // double
  p3: 0.004, // triple
  p4: 0.033, // home run
  soPerPa: 0.225,
} as const;
export const PITCH_PRIOR = { hPerBf: 0.213, soPerBf: 0.235 } as const;

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
