// Scorebook abbreviations for prop types.
//
// The DB keys are snake_case because that is what the pipeline writes; these
// are presentation only, so nothing downstream (market keys, filters, the
// `prop_type` column) changes shape. <abbr title> keeps the long form one
// hover away, which matters most in the calibration table, where the caption
// argues about "hits at 0.5" and "total bases at 0.5" being one piece of
// evidence -- that prose has to stay readable against these cells.
const ABBR: Record<string, string> = {
  total_bases: 'TB',
  strikeouts: 'K',
  hits: 'H',
  home_runs: 'HR',
  runs: 'R',
  rbis: 'RBI',
  // Not 'BB' bare: the box score already uses BB for a pitcher's walks issued,
  // and these tabs sit beside a pitcher prop.
  batter_walks: 'B-BB',
  hits_runs_rbis: 'H+R+RBI',
};

export function PropLabel({ prop }: { prop: string }) {
  const short = ABBR[prop];
  // The map covers every prop_type in the database today. A new prop falls
  // through to its raw key rather than an invented abbreviation: a long name
  // among short ones is obvious and asks to be fixed here, where a guessed
  // short one just looks settled.
  if (!short) return <>{prop}</>;
  return <abbr className="prop" title={prop.replace(/_/g, ' ')}>{short}</abbr>;
}
