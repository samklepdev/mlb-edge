export interface ClvRow {
  propType: string;
  n: number;
  avgClv: number | null;
  hitRate: number | null;
}

export interface CalibrationBucket {
  lo: number;
  hi: number;
  n: number;
  predicted: number;   // mean model probability in this bucket
  actual: number;      // observed win rate in this bucket
  gap: number;         // actual - predicted
}

export interface Scorecard {
  settledPicks: number;      // REAL picks with a settled result (excludes synthetic)
  picksWithClose: number;    // real picks that also have a captured closing line
  avgClv: number | null;     // mean CLV across picksWithClose
  ece: number | null;        // expected calibration error over settledPicks
  syntheticSettled: number;  // settled DEMO picks, excluded from every figure above
  clvGames: number;          // distinct real games behind picksWithClose -- picks cluster
                              // heavily by slate, so this is the real effective sample size
  excludedClose: number;     // real picks with a close_line NOT counted in picksWithClose --
                              // captured at/after first pitch, or never stamped
}

export interface SlateGame {
  gameId: number;
  date: string;
  home: string;
  away: string;
  homeId: number | null;
  awayId: number | null;
}

export interface TopEdge {
  playerId: number;
  playerName: string;
  gameId: number;
  propType: string;
  side: 'over' | 'under';
  line: number;
  modelProb: number;
  edgePct: number;
}

export interface PlayerCardRow {
  propType: string;
  matchup: string | null;
  projMean: number;
  projStdev: number | null;
  line: number | null;
  modelProb: number | null;   // P(model side)
  fairProb: number | null;    // de-vigged market prob of same side
  edgePct: number | null;
  side: 'over' | 'under' | null;
  hasPick: boolean;
}
export interface PlayerCard {
  playerId: number;
  playerName: string;
  date: string;
  rows: PlayerCardRow[];
}

export interface ReliabilityBucket {
  lo: number;
  hi: number;
  n: number;
  predicted: number;
  actual: number;
  gap: number;
}
export interface BacktestSummary {
  n: number;
  ece: number | null;   // expected calibration error
  brier: number | null; // mean squared error of probabilities
}

export type ResolutionVerdict = 'beats' | 'worse' | 'indistinguishable' | 'insufficient';

// Sufficient statistics for the game-clustered advantage test. One row per
// market, aggregated in SQL; everything else is derived purely from these.
// D_g = sum of per-eval differences d_i within game g; n_g = evals in game g.
//
// The baseline is PER (market, line), not per market: a market's evaluations
// span several candidate lines whose hit rates differ a lot (run_line -1.5 hits
// 64.2%, +1.5 hits 36.6%), and the model is told which line it is pricing. A
// pooled base rate would hand the model the across-line variance for free,
// because pooled r(1-r) = E[r_k(1-r_k)] + Var(r_k). So d_i is measured against
// eval i's OWN line's hit rate r_k, and baseRateBrier is the n-weighted mean of
// r_k(1-r_k) -- which equals mean((r_k - y_i)^2) identically, so
// advantage = baseRateBrier - modelBrier still holds exactly.
export interface ResolutionStats {
  n: number;                       // evals
  games: number;                   // clusters (distinct game_id)
  baseRate: number | null;         // pooled mean(hit) across all lines
  baseRateBrier: number | null;    // n-weighted mean of r_k(1-r_k) over lines
  lines: number;                   // distinct (market, line) baseline cells
  baseRateLo: number | null;       // lowest per-line hit rate
  baseRateHi: number | null;       // highest per-line hit rate
  modelBrier: number | null;       // mean((p - y)^2)
  sumDg: number;                   // sum of D_g
  sumDg2: number;                  // sum of D_g^2
  sumNgDg: number;                 // sum of n_g * D_g
  sumNg2: number;                  // sum of n_g^2
}

export interface ResolutionCheck {
  n: number;
  games: number;
  baseRate: number | null;       // pooled mean(hit); display only
  baseRateBrier: number | null;  // n-weighted mean of r_k(1-r_k) over lines
  lines: number;                 // distinct (market, line) baseline cells
  baseRateLo: number | null;
  baseRateHi: number | null;
  modelBrier: number | null;
  advantage: number | null;      // baseRateBrier - modelBrier
  se: number | null;             // clustered by game
  ciLo: number | null;
  ciHi: number | null;
  skillScore: number | null;     // advantage / baseRateBrier
  verdict: ResolutionVerdict;
}

export interface RosterPlayer {
  playerId: number;
  playerName: string;
  matchup: string | null;
  props: string;      // comma-joined prop types projected
  hasPick: boolean;   // model flagged an edge for this player
}

// Scope for a game-outcome model read. Every field is optional and an empty
// filter reproduces the original behaviour exactly: latest model_version, all
// markets, all dates. That default is load-bearing -- verify:resolution pins
// oracle numbers computed with it, so widening the filter must never change
// what an unfiltered call returns.
//
// `from`/`to` are inclusive game dates (YYYY-MM-DD) and filter on
// games.game_date; team_model_evals carries no date of its own. They exist so a
// version can be re-measured on a range its league constants were NOT fitted
// on -- the in-sample circularity is the standing caveat on every calibration
// figure this model reports.
export interface TeamEvalFilter {
  market?: string;
  version?: string;  // default: max(model_version), a LEXICOGRAPHIC max
  from?: string;     // inclusive
  to?: string;       // inclusive
}
