// Over/under direction, as a bare glyph.
//
// The arrow carries no colour on purpose. This column lives in the edge and
// pick tables, where every figure is an untested hypothesis -- a green "over"
// there reads as an endorsement the backtest has not earned (CLAUDE.md:
// "Colour never encodes data"). Shape does the work instead, which also means
// it survives a colour-blind reader and a black-and-white print.
//
// role="img" + aria-label is load-bearing, not boilerplate. The word used to
// sit beside the arrow, which made the glyph decoration; now the glyph IS the
// value, so without a name this cell announces as "up arrow" or as nothing at
// all depending on the screen reader. `title` gives sighted readers the same
// word on hover, since an unlabelled arrow is only obvious in context.
export function Side({ side }: { side: 'over' | 'under' | null | undefined }) {
  if (!side) return <>—</>;
  return (
    <span className="side" role="img" aria-label={side} title={side}>
      {side === 'over' ? '↑' : '↓'}
    </span>
  );
}
