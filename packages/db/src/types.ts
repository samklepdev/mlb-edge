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
  status: string;
  /** false = ingested but `project` has not been run for this date yet. The
   *  card says so rather than being hidden, which used to look like a failed
   *  ingest. */
  hasProjections: boolean;
  /** Summed from the box score; null until the game has one. */
  homeRuns: number | null;
  awayRuns: number | null;
  venue: string | null;
  /** Weather is null for a Scheduled game — MLB's feed returns an empty
   *  weather object until a game is near first pitch, so an upcoming slate has
   *  a park but no conditions. Not a missing ingest. */
  condition: string | null;
  tempF: number | null;
  wind: string | null;
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

export interface GameSide {
  teamId: number | null;
  name: string;
  /** Summed from the box score -- there is no score column. Null when the
   *  game has not been played, or its boxscore was never ingested. */
  runs: number | null;
}
export interface GameBattingLine {
  playerId: number; playerName: string; teamId: number | null;
  pa: number; ab: number; h: number; hr: number; tb: number;
  so: number; bb: number; r: number; rbi: number;
}
export interface GamePitchingLine {
  playerId: number; playerName: string; teamId: number | null;
  outs: number; so: number; bb: number; h: number; er: number; bf: number;
}
export interface GamePick {
  playerId: number; playerName: string; propType: string;
  side: 'over' | 'under'; line: number; modelProb: number;
  edgePct: number | null;
  result: 'win' | 'loss' | null;
  /** Best price across the books stored for this prop. `line` above stays the
   *  reference book's, so settlement and CLV keep grading what they always did;
   *  these say where the bet would actually have been placed. */
  bestBook: string | null;
  bestOdds: number | null;
  bestLine: number | null;
  /** 1 means only one book quoted it, so no shopping happened. */
  booksCompared: number | null;
}
export interface GameProbable {
  playerId: number; playerName: string; throws: string | null;
}
export interface GameDetail {
  gameId: number;
  date: string;
  startTime: Date | null;
  status: string;
  venue: string | null;
  home: GameSide;
  away: GameSide;
  weather: { condition: string | null; tempF: number | null; wind: string | null } | null;
  probableHome: GameProbable | null;
  probableAway: GameProbable | null;
  batting: GameBattingLine[];
  pitching: GamePitchingLine[];
  picks: GamePick[];
}

export interface ExplorerPlayer {
  playerId: number;
  playerName: string;
  props: string[];
  /** Resolved from this game's box score when it exists, else the player's most
   *  recent appearance — an upcoming game has no box score to read. Null when
   *  the player has never appeared, so the UI must handle an unplaced player. */
  teamId: number | null;
}
export interface PropGame {
  gameId: number;
  date: string;
  value: number;
  opponent: string | null;
  opponentId: number | null;
  home: boolean;
  /** Both sides' runs, summed from the box score — there is no score column. */
  teamRuns: number | null;
  oppRuns: number | null;
  /** The player's batting line for that game, for the hover card. Null when the
   *  player has no batting row (e.g. a pitcher prop). Max exit velocity is
   *  deliberately absent: it lives in the live feed's hitData.launchSpeed,
   *  which nothing stores yet. */
  pa: number | null;
  ab: number | null;
  h: number | null;
  doubles: number | null;
  triples: number | null;
  so: number | null;
  bb: number | null;
}
export interface MatchupContext {
  venue: string | null;
  condition: string | null;
  tempF: number | null;
  wind: string | null;
  pitcher: { playerId: number; playerName: string; throws: string | null } | null;
  /** Career-to-date split vs the probable starter's hand, from the PA-level
   *  platoon table. Null when the hand is unknown or there are no such PAs. */
  vsHand: {
    hand: string; pa: number;
    hitsPerPa: number; hrPerPa: number; soPerPa: number; tbPerPa: number;
  } | null;
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
