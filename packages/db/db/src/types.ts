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
  settledPicks: number;    // picks with a settled result
  picksWithClose: number;  // picks that also have a captured closing line
  avgClv: number | null;   // mean CLV across picksWithClose
  ece: number | null;      // expected calibration error over settledPicks
}
