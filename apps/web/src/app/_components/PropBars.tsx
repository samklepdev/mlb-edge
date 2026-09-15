import type { PropGame } from '@mlb-edge/db';

// Game-by-game outcomes for one prop, against the market line.
//
// COLOUR ENCODES NOTHING HERE. Every bar is the same hue. The obvious design --
// green when the result cleared the line, red when it missed -- is what every
// props site does and is exactly what CLAUDE.md rules out: it turns a row of
// past outcomes into a scoreboard of wins and losses, which reads as a track
// record the model has not earned. Over/under is carried by position against
// the reference rule, which is unambiguous, survives colour blindness, and
// makes no claim.
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
                {`${d.date} ${d.home ? 'vs' : '@'} ${d.opponent ?? '—'}: ${d.value}`}
              </title>
              <rect
                x={x} y={y(d.value)} width={barW} height={h}
                rx={h > 4 ? 4 : 0}
                fill="var(--navy)" fillOpacity={0.85}
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
        {prop.replace(/_/g, ' ')} per game, oldest to newest. Bars are one colour
        on purpose — whether a game cleared the line is read off the dashed rule,
        not off a colour that would score it as a win.
      </figcaption>
    </figure>
  );
}
