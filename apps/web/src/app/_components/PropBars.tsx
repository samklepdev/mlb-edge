import type { PropGame } from '@mlb-edge/db';

// Game-by-game outcomes for one prop, against the market line.
//
// Bars are coloured by whether the game cleared the market line: --good over,
// --bad at-or-under. This is a deliberate, narrow exception to "colour never
// encodes data", and the reason it is defensible is that a past box score is a
// SETTLED FACT, not a projection -- unlike an edge or a CLV figure, which stay
// uncoloured because they are claims the backtest has not earned.
//
// Two safeguards, because the risk here is real:
//
//   * Colour is REDUNDANT, never the only channel. The reference rule is drawn
//     and every bar's height is read against it, so the same information
//     survives colour blindness, greyscale printing and forced-colours mode.
//     Removing the rule would make this chart colour-alone; do not. That is not
//     a theoretical concern here: --good/--bad differ by only 1.07:1 in
//     luminance, so in greyscale the two are the same bar. Running the palette
//     validator on the pair gives deutan ΔE 8.1 -- a PASS, but barely over the
//     floor of 8 -- and --good FAILS the chroma floor at 0.086, meaning it
//     reads closer to grey than to green. The tokens are kept anyway for
//     consistency with the calibration plot, which makes the redundant rule
//     load-bearing rather than belt-and-braces.
//   * A wall of green means a player has cleared this line often, which is NOT
//     evidence the next one clears. Past hit rate is the most seductive and
//     least predictive number on any props site. The caption says so, and the
//     line is today's, not the line each of those games was actually traded at.
//
// With no market line there is nothing to clear, so bars stay neutral rather
// than guessing.
//
// One series, so no legend: the caption names it (dataviz: a legend box for a
// single series is noise).
export function PropBars({
  games, line, projMean, prop,
}: {
  games: PropGame[];
  line: number | null;
  projMean: number | null;
  prop: string;
}) {
  if (games.length === 0) {
    return <p className="cap">No games match these filters.</p>;
  }

  // Oldest → newest reads left to right, the way time is read.
  const data = [...games].reverse();

  const W = 720;
  const H = 260;
  const padL = 34;
  const padR = 12;
  const padT = 14;
  const padB = 46;

  const maxVal = Math.max(
    1,
    ...data.map((d) => d.value),
    line ?? 0,
    projMean ?? 0,
  );
  // Whole-number ticks: every prop here is a count, so fractional gridlines
  // would be meaningless.
  const top = Math.ceil(maxVal) + 1;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const bandW = plotW / data.length;
  // 2px surface gap between adjacent bars (dataviz mark spec).
  const barW = Math.max(3, Math.min(34, bandW - 2));

  const ticks = Array.from({ length: top + 1 }, (_, i) => i);

  return (
    <figure className="propbars">
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`${prop} by game, oldest to newest, ${data.length} games`}>
        {/* Recessive grid. */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize={11}
              fill="var(--faint)" className="num">{t}</text>
          </g>
        ))}

        {data.map((d, i) => {
          const x = padL + i * bandW + (bandW - barW) / 2;
          const h = Math.max(0, y(0) - y(d.value));
          return (
            <g key={d.gameId}>
              {/* Native tooltip. A server-rendered chart gets the hover layer
                  without shipping a client component for it. */}
              <title>
                {`${d.date} ${d.home ? 'vs' : '@'} ${d.opponent ?? '—'}: ${d.value}` +
                  (line == null ? '' : d.value > line ? ` — over ${line}` : ` — under ${line}`)}
              </title>
              <rect
                x={x} y={y(d.value)} width={barW} height={h}
                rx={h > 4 ? 4 : 0}
                fill={line == null ? 'var(--navy)' : d.value > line ? 'var(--good)' : 'var(--bad)'}
                fillOpacity={0.9}
              />
              {/* A zero still needs to be visible as a game that happened. */}
              {d.value === 0 && (
                <rect x={x} y={y(0) - 2} width={barW} height={2} fill="var(--hair)" />
              )}
            </g>
          );
        })}

        {/* Reference rules. Dashed so they read as annotation rather than a
            second series, and separated by WEIGHT rather than hue -- the market
            line is what the whole chart is read against, so it is the heavier
            of the two.
            Not --ref: that token is 2.10:1 on --panel, below the 3:1 a
            meaningful graphical object needs. A rule nobody can see is worse
            than no rule, since the bars alone imply nothing. --ink is 18:1 and
            --muted 5.76:1. */}
        {line != null && (
          <g>
            <line x1={padL} y1={y(line)} x2={W - padR} y2={y(line)}
              stroke="var(--ink)" strokeWidth={1.5} strokeDasharray="6 4" />
            <text x={W - padR} y={y(line) - 5} textAnchor="end" fontSize={11}
              fill="var(--muted)" className="num">line {line}</text>
          </g>
        )}
        {projMean != null && (
          <g>
            <line x1={padL} y1={y(projMean)} x2={W - padR} y2={y(projMean)}
              stroke="var(--muted)" strokeWidth={1} strokeDasharray="2 3" />
            <text x={padL + 2} y={y(projMean) - 5} textAnchor="start" fontSize={11}
              fill="var(--muted)" className="num">model {projMean.toFixed(2)}</text>
          </g>
        )}

        <line x1={padL} y1={y(0)} x2={W - padR} y2={y(0)} stroke="var(--hair)" strokeWidth={1} />

        {/* Selective labels only: every Nth date, so they never collide. */}
        {data.map((d, i) => {
          const step = Math.ceil(data.length / 8);
          if (i % step !== 0 && i !== data.length - 1) return null;
          const x = padL + i * bandW + bandW / 2;
          return (
            <text key={d.gameId} x={x} y={H - padB + 16} textAnchor="middle"
              fontSize={10} fill="var(--faint)" className="num">
              {d.date.slice(5)}
            </text>
          );
        })}
      </svg>
      <figcaption className="cap">
        {prop.replace(/_/g, ' ')} per game, oldest to newest.{' '}
        {line == null ? (
          <>No market line for this prop, so no bar is marked over or under.</>
        ) : (
          <>
            Green cleared {line}, red did not — measured against{' '}
            <em>today&apos;s</em> line, not the line each game actually traded at.
            A run of green means this player has beaten this number often; it is
            not evidence the next one clears. Past hit rate is the most seductive
            and least predictive figure in prop betting, which is why the model
            page, not this chart, is where the question gets answered.
          </>
        )}
      </figcaption>
    </figure>
  );
}
