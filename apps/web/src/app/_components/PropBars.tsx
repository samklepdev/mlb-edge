import type { PropGame } from '@mlb-edge/db';
import { abbrev } from './teams';

// Game-by-game outcomes for one prop, against the market line.
//
// HTML/CSS bars rather than SVG. The hover card carries nine fields, which an
// SVG <title> cannot style and a <foreignObject> would get clipped by the
// viewBox. Plain elements also make each bar focusable, so the card is
// reachable by keyboard instead of mouse-only.
//
// COLOUR: --good over the line, --bad at or under. A past box score is a
// settled fact, which is why this is allowed where edge and CLV figures are
// not (CLAUDE.md). Two safeguards hold it up:
//
//   * Colour is REDUNDANT. The reference rule is drawn and every bar is read
//     against it. That is load-bearing: --good and --bad differ by only 1.07:1
//     in luminance, so in greyscale they are the same bar. The palette
//     validator gives deutan ΔE 8.1 -- a PASS, but barely over the floor of 8
//     -- and --good FAILS the chroma floor at 0.086, reading closer to grey
//     than green. Delete the rule and this chart becomes colour-alone.
//   * A run of green is NOT predictive, and the caption says so. Past hit rate
//     is the most seductive and least predictive figure in prop betting.
//
// With no market line there is nothing to clear, so bars stay neutral.
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
  const top = Math.max(1, Math.ceil(Math.max(...data.map((d) => d.value), line ?? 0, projMean ?? 0)) + 1);
  const pctOf = (v: number) => `${(v / top) * 100}%`;
  const ticks = Array.from({ length: top + 1 }, (_, i) => i);

  const outcome = (d: PropGame) => {
    if (d.teamRuns == null || d.oppRuns == null) return null;
    const diff = d.teamRuns - d.oppRuns;
    if (diff === 0) return 'Tied';
    return `${diff > 0 ? 'Won' : 'Lost'} by ${Math.abs(diff)}`;
  };
  const avg = (d: PropGame) =>
    d.ab != null && d.ab > 0 && d.h != null ? (d.h / d.ab).toFixed(3).replace(/^0/, '') : '—';

  return (
    <figure className="propbars">
      <div className="pb-chart">
        <div className="pb-axis" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="pb-tick num" style={{ bottom: pctOf(t) }}>{t}</span>
          ))}
        </div>

        <div className="pb-plot">
          {ticks.map((t) => (
            <span key={t} className="pb-grid" style={{ bottom: pctOf(t) }} aria-hidden="true" />
          ))}

          {/* Reference rules. --ink for the market line because it is what the
              whole chart is read against; --ref is only 2.10:1 on --panel and a
              rule nobody can see is worse than none. They separate by WEIGHT,
              not by hue. */}
          {line != null && (
            <span className="pb-line" style={{ bottom: pctOf(line) }} aria-hidden="true">
              <span className="pb-line-tag num">line {line}</span>
            </span>
          )}
          {projMean != null && (
            <span className="pb-proj" style={{ bottom: pctOf(projMean) }} aria-hidden="true">
              <span className="pb-proj-tag num">model {projMean.toFixed(2)}</span>
            </span>
          )}

          <ol className="pb-bars">
            {data.map((d, i) => {
              const cleared = line == null ? null : d.value > line;
              const opp = abbrev(d.opponentId, d.opponent ?? '');
              const res = outcome(d);
              // Cards near an edge flip their alignment so they are not clipped
              // -- body has overflow-x: hidden, so an overhanging card at the
              // right edge would simply vanish.
              const side = i < 2 ? ' pb-pop-l' : i > data.length - 3 ? ' pb-pop-r' : '';
              return (
                <li key={d.gameId} className="pb-col" tabIndex={0}
                  aria-label={`${d.date} ${d.home ? 'vs' : 'at'} ${opp}, ${prop.replace(/_/g, ' ')} ${d.value}${res ? `, ${res}` : ''}`}>
                  <span
                    className={`pb-bar${cleared == null ? '' : cleared ? ' pb-over' : ' pb-under'}`}
                    style={{ height: d.value === 0 ? '2px' : pctOf(d.value) }}
                  />
                  <div className={`pb-pop${side}`} role="tooltip">
                    <p className="pb-pop-h">
                      {d.date} {d.home ? 'vs' : '@'} {opp}
                      {res && <span className="pb-pop-res"> ({res})</span>}
                    </p>
                    <dl className="pb-pop-grid">
                      <div><dt>PA</dt><dd className="num">{d.pa ?? '—'}</dd></div>
                      <div><dt>H</dt><dd className="num">{d.h ?? '—'}</dd></div>
                      <div><dt>2B</dt><dd className="num">{d.doubles ?? '—'}</dd></div>
                      <div><dt>3B</dt><dd className="num">{d.triples ?? '—'}</dd></div>
                      <div><dt>K</dt><dd className="num">{d.so ?? '—'}</dd></div>
                      <div><dt>BB</dt><dd className="num">{d.bb ?? '—'}</dd></div>
                      <div><dt>AVG</dt><dd className="num">{avg(d)}</dd></div>
                      {/* Asked for, and honestly unavailable: exit velocity is
                          hitData.launchSpeed in the live feed this project
                          already downloads, but nothing stores it. Shown as a
                          gap rather than dropped, so it is obvious it is
                          missing rather than forgotten. */}
                      <div><dt>Max EV</dt><dd className="pb-pop-na">not ingested</dd></div>
                    </dl>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <ol className="pb-dates" aria-hidden="true">
        {data.map((d, i) => {
          const step = Math.ceil(data.length / 8);
          const show = i % step === 0 || i === data.length - 1;
          return <li key={d.gameId} className="num">{show ? d.date.slice(5) : ''}</li>;
        })}
      </ol>

      <figcaption className="cap">
        {prop.replace(/_/g, ' ')} per game, oldest to newest. Hover or focus a bar
        for that game&apos;s line.{' '}
        {line == null ? (
          <>No market line for this prop, so no bar is marked over or under.</>
        ) : (
          <>
            Green cleared {line}, red did not — against <em>today&apos;s</em> line,
            not the line each game actually traded at. A run of green means this
            player has beaten this number often; it is not evidence the next one
            clears. Max exit velocity is not stored yet — it is in the live feed
            already downloaded for every game, alongside pitch types.
          </>
        )}
      </figcaption>
    </figure>
  );
}
