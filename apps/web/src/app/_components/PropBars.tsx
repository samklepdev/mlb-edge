'use client';

import { useRef, useState } from 'react';
import type { PropGame } from '@mlb-edge/db';
import { abbrev } from './teams';

// A client component, which is allowed here only because nothing server-only
// reaches it: the @mlb-edge/db import is `import type`, so it is erased at
// compile and `pg` never enters the client bundle (CLAUDE.md forbids the
// runtime import), and ./teams is a frozen map with no imports at all. Props
// arrive from the server page as plain JSON -- PropGame holds only primitives,
// no Date objects.
//
// The interactivity is the whole reason: a cursor-following card needs pointer
// coordinates, which CSS cannot see.

// Card box, used to keep it inside the plot. Fixed rather than measured: a
// read of offsetHeight on every mousemove would force layout each frame.
const CARD_W = 200;
// Includes the result line below the header. Must be updated whenever a row is
// added to the card -- it is what keeps the card clamped inside the plot.
const CARD_H = 150;
const GAP = 14;

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
  const plotRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // A line the reader can move, on top of the market's.
  //
  // Deliberately local state rather than a URL parameter, unlike every other
  // control on this page: stepping a line is a scrubbing gesture, and routing
  // each press through a force-dynamic server render would make it lag badly.
  // The cost is that a moved line is not linkable, which is the right trade for
  // something explicitly framed as a what-if.
  //
  // `null` means "follow the market". Resetting restores that rather than
  // freezing today's number, so the chart keeps tracking the book if the page
  // is reloaded later.
  const [override, setOverride] = useState<number | null>(null);
  const effLine = override ?? line;
  const custom = override != null;
  // Props trade at half-integers, so that is the step. Clamped at 0: a negative
  // line is meaningless for a counting stat.
  const nudge = (d: number) =>
    setOverride(Math.max(0, Math.round(((override ?? line ?? 0.5) + d) * 2) / 2));

  // Clamp the card inside the plot box rather than letting it overhang. That
  // matters more than usual here: body sets overflow-x: hidden, so anything
  // past the viewport edge is not merely ugly, it is invisible.
  const place = (x: number, y: number) => {
    const w = plotRef.current?.clientWidth ?? 0;
    const h = plotRef.current?.clientHeight ?? 0;
    let left = x + GAP;
    if (left + CARD_W > w) left = x - GAP - CARD_W;
    left = Math.max(0, Math.min(left, Math.max(0, w - CARD_W)));
    let top = y - GAP - CARD_H;
    if (top < 0) top = y + GAP;
    top = Math.max(0, Math.min(top, Math.max(0, h - CARD_H)));
    setPos({ left, top });
  };

  const onMove = (i: number) => (e: React.MouseEvent<HTMLLIElement>) => {
    const r = plotRef.current?.getBoundingClientRect();
    if (!r) return;
    setActive(i);
    place(e.clientX - r.left, e.clientY - r.top);
  };

  // Keyboard has no cursor, so focus anchors the card over the bar instead.
  // Without this the card would be unreachable without a mouse, which is what
  // the previous CSS-only version got right and a naive rewrite would lose.
  const onFocusCol = (i: number) => (e: React.FocusEvent<HTMLLIElement>) => {
    const el = e.currentTarget;
    setActive(i);
    place(el.offsetLeft + el.offsetWidth / 2, el.offsetTop + 8);
  };

  const clear = () => { setActive(null); setPos(null); };

  if (games.length === 0) {
    return <p className="cap">No games match these filters.</p>;
  }

  // Oldest → newest reads left to right, the way time is read.
  const data = [...games].reverse();
  // The axis must accommodate the EFFECTIVE line: nudging it above the tallest
  // bar would otherwise push the rule off the top of the plot.
  const top = Math.max(1, Math.ceil(Math.max(...data.map((d) => d.value), effLine ?? 0, projMean ?? 0)) + 1);
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
      {/* Sits over the graph, as asked. Buttons rather than a bare number input
          so it can be driven by keyboard and by touch without a soft keyboard;
          the input is there too for jumping straight to a value. */}
      <div className="pb-setline">
        <span className="pb-setline-l" id="pb-line-label">Line</span>
        <button type="button" className="pb-step" onClick={() => nudge(-0.5)}
          aria-label="Lower the line by 0.5">−</button>
        <input
          className="pb-line-in num"
          type="number" step={0.5} min={0}
          aria-labelledby="pb-line-label"
          value={effLine ?? ''}
          placeholder="—"
          onChange={(e) => {
            const v = e.target.value;
            // Clearing the field returns to the market line rather than
            // freezing a blank, so the control always has a defined meaning.
            setOverride(v === '' ? null : Math.max(0, Number(v)));
          }}
        />
        <button type="button" className="pb-step" onClick={() => nudge(0.5)}
          aria-label="Raise the line by 0.5">+</button>
        {custom && (
          <button type="button" className="pb-reset" onClick={() => setOverride(null)}>
            {line == null ? 'clear' : `reset to ${line}`}
          </button>
        )}
      </div>

      <div className="pb-chart">
        <div className="pb-axis" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="pb-tick num" style={{ bottom: pctOf(t) }}>{t}</span>
          ))}
        </div>

        <div className="pb-plot" ref={plotRef}>
          {ticks.map((t) => (
            <span key={t} className="pb-grid" style={{ bottom: pctOf(t) }} aria-hidden="true" />
          ))}

          {/* Reference rules. --ink for the market line because it is what the
              whole chart is read against; --ref is only 2.10:1 on --panel and a
              rule nobody can see is worse than none. They separate by WEIGHT,
              not by hue. */}
          {effLine != null && (
            <span className={`pb-line${custom ? ' pb-line-custom' : ''}`} style={{ bottom: pctOf(effLine) }} aria-hidden="true">
              <span className="pb-line-tag num">{custom ? 'set' : 'line'} {effLine}</span>
            </span>
          )}
          {projMean != null && (
            <span className="pb-proj" style={{ bottom: pctOf(projMean) }} aria-hidden="true">
              <span className="pb-proj-tag num">model {projMean.toFixed(2)}</span>
            </span>
          )}

          <ol className="pb-bars" onMouseLeave={clear}>
            {data.map((d, i) => {
              const cleared = effLine == null ? null : d.value > effLine;
              const opp = abbrev(d.opponentId, d.opponent ?? '');
              const res = outcome(d);
              return (
                <li key={d.gameId} className="pb-col" tabIndex={0}
                  onMouseMove={onMove(i)}
                  onFocus={onFocusCol(i)}
                  onBlur={clear}
                  aria-label={`${d.date} ${d.home ? 'vs' : 'at'} ${opp}, ${prop.replace(/_/g, ' ')} ${d.value}${res ? `, ${res}` : ''}`}>
                  <span
                    className={`pb-bar${cleared == null ? '' : cleared ? ' pb-over' : ' pb-under'}`}
                    style={{ height: d.value === 0 ? '2px' : pctOf(d.value) }}
                  />
                </li>
              );
            })}
          </ol>

          {/* One card, moved to the pointer, rather than fifteen hidden ones.
              It sits outside the <ol> so it is never a child of the element
              being hovered -- pointer-events: none plus that separation means
              it cannot steal the mousemove and flicker. */}
          {active != null && pos != null && (() => {
            const d = data[active];
            const opp = abbrev(d.opponentId, d.opponent ?? '');
            const res = outcome(d);
            return (
              <div className="pb-pop" role="tooltip" style={{ left: pos.left, top: pos.top }}>
                {/* Two lines, not one. "2026-08-28 @ SF (Won by 4)" does not
                    fit 200px at this size, and the result was the part that got
                    clipped -- the least guessable half of the header. */}
                <p className="pb-pop-h">{d.date} {d.home ? 'vs' : '@'} {opp}</p>
                {res && <p className="pb-pop-res">{res}</p>}
                <dl className="pb-pop-grid">
                  <div><dt>PA</dt><dd className="num">{d.pa ?? '—'}</dd></div>
                  <div><dt>H</dt><dd className="num">{d.h ?? '—'}</dd></div>
                  <div><dt>2B</dt><dd className="num">{d.doubles ?? '—'}</dd></div>
                  <div><dt>3B</dt><dd className="num">{d.triples ?? '—'}</dd></div>
                  <div><dt>K</dt><dd className="num">{d.so ?? '—'}</dd></div>
                  <div><dt>BB</dt><dd className="num">{d.bb ?? '—'}</dd></div>
                  <div><dt>AVG</dt><dd className="num">{avg(d)}</dd></div>
                  {/* Asked for, and honestly unavailable: exit velocity is
                      hitData.launchSpeed in the live feed this project already
                      downloads, but nothing stores it. A visible gap beats a
                      silently dropped field. */}
                  <div><dt>Max EV</dt><dd className="pb-pop-na">not ingested</dd></div>
                </dl>
              </div>
            );
          })()}
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
        {prop.replace(/_/g, ' ')} per game, oldest to newest. The card follows the
        pointer; tabbing to a bar anchors it over that bar instead.{' '}
        {effLine == null ? (
          <>No market line for this prop — set one above to mark bars over or under.</>
        ) : (
          <>
            Green cleared {effLine}, red did not.{' '}
            {custom ? (
              <strong>
                {line == null
                  ? `${effLine} is a line you set; no book price is stored for this prop.`
                  : `${effLine} is a line you set, not the market's ${line}.`}
              </strong>
            ) : (
              <>Measured against <em>today&apos;s</em> line, not the line each game
              actually traded at.</>
            )}{' '}
            A run of green means this player has beaten this number often; it is
            not evidence the next one clears. Max exit velocity is not stored yet
            — it is in the live feed already downloaded for every game, alongside
            pitch types.
          </>
        )}
      </figcaption>
    </figure>
  );
}
