/**
 * Represents a data structure for CLV (Customer Lifetime Value) row statistics.
 *
 * @interface ClvRow
 * @property {string} propType - The type or category of the property being represented.
 * @property {number} n - The count or frequency associated with the property.
 * @property {number | null} avgClv - The average customer lifetime value. Can be null if not applicable.
 * @property {number | null} hitRate - The success or hit rate percentage. Can be null if not applicable.
 */
export interface ClvRow {
  propType: string;
  n: number;
  avgClv: number | null;
  hitRate: number | null;
}

/**
 * Represents a bucket used for calibration analysis in predictive models.
 *
 * Each bucket contains statistical information about predicted probabilities
 * and their corresponding observed frequencies within a specific range.
 */
export interface CalibrationBucket {
  lo: number;
  hi: number;
  n: number;
  predicted: number;   // mean model probability in this bucket
  actual: number;      // observed win rate in this bucket
  gap: number;         // actual - predicted
}

/**
 * Represents a scorecard containing metrics and statistics for evaluating performance
 * of picks made within a system. Each property tracks a specific aspect of the picks
 * and underlying data.
 *
 * @interface Scorecard
 *
 * @property {number} settledPicks
 *   Total number of picks with a settled result. Does not include synthetic picks.
 *
 * @property {number} picksWithClose
 *   Number of real picks that have an associated captured closing line.
 *
 * @property {number | null} avgClv
 *   The mean Closing Line Value (CLV) across all picks with a captured closing line
 *   (picksWithClose). Can be null if no picks qualify.
 *
 * @property {number | null} ece
 *   Expected calibration error calculated over settled picks. Indicates the degree of
 *   alignment between predicted and actual outcomes. Can be null if not applicable.
 *
 * @property {number} syntheticSett*/
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

/**
 * Represents a scheduled game in a slate.
 *
 * @interface SlateGame
 *
 * @property {number} gameId - Unique identifier for the game.
 * @property {string} date - The date of the game in YYYY-MM-DD format.
 * @property {string} home - The name of the home team.
 * @property {string} away - The name of the away team.
 * @property {Date | null} startTime - The starting time of the game. Null if no start time is available.
 * @property {number | null} homeId - The unique identifier for the home team. Null if not applicable.
 * @property {number | null} awayId - The unique identifier for the away team. Null if not applicable.
 */
export interface SlateGame {
  gameId: number;
  date: string;
  home: string;
  away: string;
  startTime: Date | null;
  homeId: number | null;
  awayId: number | null;
}

/**
 * Represents the information related to the top edge prediction for a player in a game.
 *
 * @interface TopEdge
 *
 * @property {number} playerId - Unique identifier for the player.
 * @property {string} playerName - Name of the player.
 * @property {number} gameId - Unique identifier for the game.
 * @property {string} propType - The type of proposition or bet (e.g., points, assists, rebounds).
 * @property {'over' | 'under'} side - The side of the prediction, either "over" or "under".
 * @property {number} line - The betting line associated with the proposition.
 * @property {number} modelProb - The probability calculated by the model for the given proposition.
 * @property {number} edgePct - The edge percentage indicating the advantage in the prediction.
 */
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

/**
 * Represents a row of data for a player's card, including projections, probabilities, and market-related information.
 *
 * This interface is designed to encapsulate detailed statistical and market data associated with a player,
 * typically used for analytical or predictive purposes in a sports-related context.
 *
 * Properties:
 * - `propType`: The type of proposition or stat being analyzed (e.g., points, rebounds, assists).
 * - `matchup`: The opposing team or contextual matchup, if applicable; null if unavailable.
 * - `projMean`: The projected mean value for the proposition/stat.
 * - `projStdev`: The projected standard deviation; null if unavailable or not applicable.
 * - `line`: The betting or market line for the proposition; null if unavailable.
 * - `modelProb`: The probability calculated by the model for one side of the proposition (e.g., over or under); null if unavailable.
 * - `fairProb`: The fair probability (de-vigged or adjusted market probability) for the same side; null if unavailable.
 * - `edgePct`: The calculated edge percentage, representing the difference between model probability and fair probability; null if unavailable.
 * - `side`: Indicates whether the proposition relates to "over" or "under"; null if unclassified or unavailable.
 * - `hasPick`: A boolean indicating whether an actionable pick exists for this specific row.
 */
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

/**
 * Represents a card containing information about a player.
 *
 * This interface is used to encapsulate the detailed information of a player
 * and associated data organized in rows.
 *
 * @interface PlayerCard
 *
 * @property {number} playerId
 * The unique identifier for the player.
 *
 * @property {string} playerName
 * The name of the player.
 *
 * @property {string} date
 * The date associated with the player's card, formatted as a string.
 *
 * @property {PlayerCardRow[]} rows
 * An array of rows containing additional data relevant to the player.
 */
export interface PlayerCard {
  playerId: number;
  playerName: string;
  date: string;
  rows: PlayerCardRow[];
}

/**
 * Represents a reliability bucket used to analyze or quantify the accuracy
 * and performance of predictive models within specified ranges (buckets).
 *
 * The `ReliabilityBucket` provides a structure to group and evaluate predicted
 * and actual outcomes, measure discrepancies, and compare data within defined
 * ranges of values.
 *
 * Properties:
 * - `lo`: The lower boundary of the bucket's range.
 * - `hi`: The upper boundary of the bucket's range.
 * - `n`: The sample size or number of data points in the bucket.
 * - `predicted`: The aggregate predicted value for the bucket.
 * - `actual`: The aggregate actual outcome value for the bucket.
 * - `gap`: The difference between the predicted and actual values within the bucket.
 */
export interface ReliabilityBucket {
  lo: number;
  hi: number;
  n: number;
  predicted: number;
  actual: number;
  gap: number;
}

/**
 * Represents the summary of a backtest including statistical performance metrics.
 *
 * @interface BacktestSummary
 *
 * @property {number} n - The total number of instances evaluated in the backtest.
 * @property {number | null} ece - The expected calibration error, which measures the alignment
 * between predicted probabilities and observed outcomes. A value of `null` indicates that this
 * metric was not calculated.
 * @property {number | null} brier - The Brier score, which represents the mean squared error of the
 * predicted probabilities. A value of `null` indicates that this metric was not calculated.
 */
export interface BacktestSummary {
  n: number;
  ece: number | null;   // expected calibration error
  brier: number | null; // mean squared error of probabilities
}

/**
 * Represents a player in a roster, along with relevant details and metadata.
 *
 * @interface RosterPlayer
 * @property {number} playerId - The unique identifier for the player.
 * @property {string} playerName - The name of the player.
 * @property {(string | null)} matchup - The player's current matchup information, or null if none exists.
 * @property {string} props - A comma-separated string indicating projected prop types for the player.
 * @property {boolean} hasPick - A flag indicating whether the model has identified an edge for this player.
 */
export interface RosterPlayer {
  playerId: number;
  playerName: string;
  matchup: string | null;
  props: string;      // comma-joined prop types projected
  hasPick: boolean;   // model flagged an edge for this player
}
