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
  startTime: Date | null;
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

export interface ResidualRow {
  gameDate: string;
  matchup: string | null;
  propType: string;
  projMean: number;
  actual: number;
  residual: number;          // actual - projMean
  /** false = the player appeared in the box score but never batted (pa = 0) or
   *  never faced a hitter (bf = 0). The projection was real, the opportunity
   *  was not, so the row is shown as DNP and excluded from every summary. */
  played: boolean;
}

export interface ResidualSummary {
  propType: string;
  n: number;                 // games counted (played only)
  dnp: number;               // games excluded from the mean
  meanResidual: number | null;
  se: number | null;         // sd/sqrt(n); null below n = 2
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

export interface RosterPlayer {
  playerId: number;
  playerName: string;
  matchup: string | null;
  props: string;      // comma-joined prop types projected
  hasPick: boolean;   // model flagged an edge for this player
}
