// Which box-score column a prop is graded against.
//
// Both the backfill evaluator and pick settlement read actual outcomes through
// this one function, so a prop can never be graded against the wrong stat.
// This replaced a `prop === 'total_bases' ? tb : so` ternary that was
// duplicated in both places and would have graded a batter's hits against a
// pitcher's strikeouts.
//
// Unknown props return null -- fail CLOSED. A prop added without updating this
// map produces no grade at all, which is visible as missing rows, rather than a
// wrong grade, which looks like real data.
export interface BoxScore {
  tb: number | null;
  h: number | null;
  hr: number | null;
  so: number | null;
}

export function actualFor(prop: string, box: BoxScore): number | null {
  switch (prop) {
    case 'total_bases': return box.tb;
    case 'hits':        return box.h;
    case 'home_runs':   return box.hr;
    case 'strikeouts':  return box.so;
    default:            return null;
  }
}
