'use client';

import { useRef, useState } from 'react';
import type { PropGame, OppPitcherProfile } from '@mlb-edge/db';
import { abbrev, logoUrl } from './teams';

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
// The upcoming-game card carries a matchup header plus six pitcher rates, so it
// needs its own height for the same clamping the per-game card gets.
const PENDING_CARD_H = 208;
const GAP = 14;

// Baseball rate conventions: .331 without the leading zero, 9.4% with one place.
const rate3 = (v: number | null) => (v == null ? '—' : v.toFixed(3).replace(/^0/, ''));
const pct1 = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

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
  games, line, marketLine, source, projMean, prop, pitching, pending, onLineChange,
}: {
  games: PropGame[];
  /** The EFFECTIVE line: the reader's if they moved it, else the market's. */
  line: number | null;
  /** The book's line, kept separately so the caption can name it when the
      reader has moved away from it, and so reset has something to return to. */
  marketLine: number | null;
  /** Where `line` came from. 'seeded' means no book price exists and the value
      was derived from this player's own window -- the tag and caption have to
      say so, or a derived threshold reads as a market one. */
  source: 'market' | 'seeded' | 'custom';
  /** Server-computed; see PlayerPanel for why it is a prop and not an import. */
  pitching: boolean;
  /** The game this chart is set up for, which has not been played. Drawn as an
   *  empty dashed slot at the right so the upcoming matchup has a place on the
   *  timeline instead of the chart simply stopping at the last result. Null
   *  once that game has a box score -- then it is history like the rest. */
  pending?: {
    date: string; opponentId: number | null; opponent: string | null; home: boolean;
    opp: OppPitcherProfile | null;
  } | null;
  projMean: number | null;
  prop: string;
  onLineChange: (v: number | null) => void;
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // The upcoming column is tracked separately from `active`, which indexes into
  // played games and has no slot for a game that has not happened.
  const [pendingOn, setPendingOn] = useState(false);

  // The line is owned by PlayerPanel, because the hit rate in the player header
  // reads from it too. This component only reports changes upward.
  const custom = source === 'custom';
  const effLine = line;
  // Props trade at half-integers, so that is the step and the drag snap.
  const snap = (v: number) => Math.max(0, Math.round(v * 2) / 2);
  const nudge = (d: number) => onLineChange(snap((line ?? 0.5) + d));

  // Clamp the card inside the plot box rather than letting it overhang. That
  // matters more than usual here: body sets overflow-x: hidden, so anything
  // past the viewport edge is not merely ugly, it is invisible.
  const place = (x: number, y: number, cardH = CARD_H) => {
    const w = plotRef.current?.clientWidth ?? 0;
    const h = plotRef.current?.clientHeight ?? 0;
    let left = x + GAP;
    if (left + CARD_W > w) left = x - GAP - CARD_W;
    left = Math.max(0, Math.min(left, Math.max(0, w - CARD_W)));
    let top = y - GAP - cardH;
    if (top < 0) top = y + GAP;
    top = Math.max(0, Math.min(top, Math.max(0, h - cardH)));
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

  const clear = () => { setActive(null); setPendingOn(false); setPos(null); };

  // Drag the line. Pointer capture rather than window listeners: the pointer
  // keeps reporting to this element even when it leaves the plot, so a fast
  // drag cannot "drop" the line halfway, and there is nothing to unbind on
  // unmount. `top` is read at drag time via a ref-free closure over the current
  // render, which is correct because the axis only changes when the line does.
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = plotRef.current?.getBoundingClientRect();
      if (!r || r.height === 0) return;
      // The plot is drawn bottom-up, so invert: y at the bottom edge is 0.
      const frac = 1 - (ev.clientY - r.top) / r.height;
      onLineChange(snap(Math.min(top, Math.max(0, frac * top))));
    };
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

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
            <div className={`pb-line${custom ? ' pb-line-custom' : ''}`} style={{ bottom: pctOf(effLine) }}>
              {/* The handle is a real slider, not just a drag target. Dragging
                  is mouse-only by nature, so without the role and the arrow
                  keys this control would be unusable by keyboard -- and it is
                  now the primary way to change the line. */}
              <div
                className="pb-handle"
                role="slider"
                tabIndex={0}
                aria-label="Line"
                aria-valuemin={0}
                aria-valuemax={top}
                aria-valuenow={effLine}
                aria-valuetext={`${effLine}${custom ? ' (set by you)' : ' (market line)'}`}
                onPointerDown={startDrag}
                onKeyDown={(e) => {
                  const k = e.key;
                  if (k === 'ArrowUp' || k === 'ArrowRight') { e.preventDefault(); nudge(0.5); }
                  else if (k === 'ArrowDown' || k === 'ArrowLeft') { e.preventDefault(); nudge(-0.5); }
                  else if (k === 'Home') { e.preventDefault(); onLineChange(0); }
                  else if (k === 'End') { e.preventDefault(); onLineChange(snap(top)); }
                  else if (k === 'Escape') { e.preventDefault(); onLineChange(null); }
                }}
              >
                <span className="pb-handle-grip" aria-hidden="true" />
              </div>
              <span className="pb-line-tag num">
                {source === 'custom' ? 'set' : source === 'market' ? 'line' : 'median'} {effLine}
                {/* The only remaining way back to the book's number for a mouse
                    user. The stepper row that used to hold reset is gone, and
                    Escape-on-the-handle is keyboard-only -- without this, a drag
                    would be one-way. */}
                {custom && marketLine != null && (
                  <button type="button" className="pb-reset" onClick={() => onLineChange(null)}>
                    reset to {marketLine}
                  </button>
                )}
              </span>
            </div>
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
            {pending && (
              // No value, so no bar -- an outline where one would go. Sized as a
              // sibling column so the played bars keep their widths rather than
              // being squeezed by an extra entry.
              <li
                className="pb-col pb-col-pending"
                tabIndex={0}
                aria-label={`${pending.date}, ${pending.home ? 'vs' : 'at'} ${abbrev(pending.opponentId, pending.opponent ?? '')} — not played yet`}
                onMouseMove={(e) => {
                  const r = plotRef.current?.getBoundingClientRect();
                  if (!r) return;
                  setActive(null);
                  setPendingOn(true);
                  place(e.clientX - r.left, e.clientY - r.top, PENDING_CARD_H);
                }}
                onFocus={(e) => {
                  const el = e.currentTarget;
                  setActive(null);
                  setPendingOn(true);
                  place(el.offsetLeft + el.offsetWidth / 2, el.offsetTop + 8, PENDING_CARD_H);
                }}
                onBlur={clear}
              >
                <span className="pb-pending" />
              </li>
            )}
          </ol>

          {/* The upcoming game's card: the matchup, then the opposing starter's
              season rates. Everything in it is season-to-date fact -- no
              projection, which is why a chart that otherwise only shows history
              can carry it. */}
          {pendingOn && pending && pos && (
            <div className="pb-pop pb-pop-wide" role="tooltip" style={{ left: pos.left, top: pos.top }}>
              <p className="pb-pop-h">
                {pending.date} {pending.home ? 'vs' : '@'}{' '}
                {abbrev(pending.opponentId, pending.opponent ?? '')}
              </p>
              <dl className="pb-pop-grid">
                {/* Game markets are not ingested: `lines pull` requests player
                    props only, so market_lines holds no spread or total. Shown
                    as gaps rather than dropped, so it is obvious they are
                    missing rather than forgotten. */}
                <div><dt>Run line</dt><dd className="pb-pop-na">not ingested</dd></div>
                <div><dt>Total</dt><dd className="pb-pop-na">not ingested</dd></div>
              </dl>

              <p className="pb-pop-sec cnd">Opp pitcher rankings</p>
              {pending.opp == null ? (
                <p className="pb-pop-res">No probable starter listed.</p>
              ) : (
                <>
                  <p className="pb-pop-res">
                    {pending.opp.playerName}
                    {pending.opp.throws && ` (${pending.opp.throws}HP)`} ·{' '}
                    <span className="num">{pending.opp.bf}</span> BF
                  </p>
                  <dl className="pb-pop-grid">
                    <div><dt>OBP</dt><dd className="num">{rate3(pending.opp.obp)}</dd></div>
                    <div><dt>BB%</dt><dd className="num">{pct1(pending.opp.bbPct)}</dd></div>
                    <div><dt>LOB%</dt><dd className="num">{pct1(pending.opp.lobPct)}</dd></div>
                    {/* Fixed league weights, not refit to this season -- see the
                        WOBA constant in the query. */}
                    <div><dt title="Fixed league linear weights, not refit to this season">wOBA</dt><dd className="num">{rate3(pending.opp.woba)}</dd></div>
                    <div><dt>K%</dt><dd className="num">{pct1(pending.opp.kPct)}</dd></div>
                    <div><dt>HR/9</dt><dd className="num">{pending.opp.hr9 == null ? '—' : pending.opp.hr9.toFixed(2)}</dd></div>
                  </dl>
                </>
              )}
            </div>
          )}

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
                  {/* A pitcher prop gets the pitching line. The batting fields
                      are empty for most starters, so leaving them would read as
                      missing data rather than as the wrong table. */}
                  {pitching ? (
                    <>
                      <div><dt>IP</dt><dd className="num">{d.pOuts == null ? '—' : `${Math.floor(d.pOuts / 3)}.${d.pOuts % 3}`}</dd></div>
                      <div><dt>BF</dt><dd className="num">{d.pBf ?? '—'}</dd></div>
                      <div><dt>H</dt><dd className="num">{d.pH ?? '—'}</dd></div>
                      <div><dt>ER</dt><dd className="num">{d.pEr ?? '—'}</dd></div>
                      <div><dt>K</dt><dd className="num">{d.pSo ?? '—'}</dd></div>
                      <div><dt>BB</dt><dd className="num">{d.pBb ?? '—'}</dd></div>
                      {/* Hardest ball hit OFF him, not by him. */}
                      <div><dt>Max EV</dt><dd className="num">{d.maxEv == null ? '—' : d.maxEv.toFixed(1)}</dd></div>
                    </>
                  ) : (
                    <>
                      <div><dt>PA</dt><dd className="num">{d.pa ?? '—'}</dd></div>
                      <div><dt>H</dt><dd className="num">{d.h ?? '—'}</dd></div>
                      <div><dt>2B</dt><dd className="num">{d.doubles ?? '—'}</dd></div>
                      <div><dt>3B</dt><dd className="num">{d.triples ?? '—'}</dd></div>
                      <div><dt>K</dt><dd className="num">{d.so ?? '—'}</dd></div>
                      <div><dt>BB</dt><dd className="num">{d.bb ?? '—'}</dd></div>
                      <div><dt>AVG</dt><dd className="num">{avg(d)}</dd></div>
                      {/* The hardest ball this batter hit. An em dash means
                          nothing was put in play -- a walk-and-strikeout day has
                          no exit velocity, which is different from missing. */}
                      <div><dt>Max EV</dt><dd className="num">{d.maxEv == null ? '—' : d.maxEv.toFixed(1)}</dd></div>
                    </>
                  )}
                </dl>
              </div>
            );
          })()}
        </div>

        {/* One cell per bar: opponent logo over the date played. It lives
            INSIDE .pb-chart as a grid row under the plot, so it inherits the
            plot's exact column geometry. The strip it replaces used hardcoded
            padding to approximate that alignment, which drifted the moment the
            axis width changed.
            aria-hidden because every bar's own aria-label already carries the
            date and opponent -- announcing them again would double every
            column for a screen reader. */}
        <ol className="pb-foot" aria-hidden="true">
          {data.map((d) => {
            const logo = logoUrl(d.opponentId);
            const [, m, day] = d.date.split('-');
            return (
              <li key={d.gameId} className="pb-foot-col">
                <span
                  className="pb-foot-logo"
                  style={logo ? { backgroundImage: `url(${logo})` } : undefined}
                  title={`${d.home ? 'vs' : '@'} ${abbrev(d.opponentId, d.opponent ?? '')}`}
                />
                <span className="pb-foot-date num">{Number(m)}/{Number(day)}</span>
              </li>
            );
          })}
          {pending && (
            <li className="pb-foot-col pb-foot-pending">
              <span
                className="pb-foot-logo"
                style={logoUrl(pending.opponentId)
                  ? { backgroundImage: `url(${logoUrl(pending.opponentId)})` }
                  : undefined}
                title={`${pending.home ? 'vs' : '@'} ${abbrev(pending.opponentId, pending.opponent ?? '')} — not played yet`}
              />
              <span className="pb-foot-date num">
                {Number(pending.date.split('-')[1])}/{Number(pending.date.split('-')[2])}
              </span>
            </li>
          )}
        </ol>
      </div>

      <figcaption className="cap">
        {prop.replace(/_/g, ' ')} per game, oldest to newest. The card follows the
        pointer; tabbing to a bar anchors it over that bar instead.{' '}
        {(
          <>
            Green cleared {effLine}, red did not.{' '}
            {source === 'custom' && (
              <strong>
                {marketLine == null
                  ? `${effLine} is a line you set; no book price is stored for this prop.`
                  : `${effLine} is a line you set, not the market's ${marketLine}.`}
              </strong>
            )}
            {source === 'market' && (
              <>Measured against <em>today&apos;s</em> line, not the line each game
              actually traded at.</>
            )}
            {source === 'seeded' && (
              <strong>
                No book price is stored for this prop, so {effLine} is this player&apos;s own
                median rather than a market line. Drag the handle to move it.
              </strong>
            )}{' '}
            {data.length} game(s) shown — a short window, so read the count with
            the shape.
          </>
        )}
      </figcaption>
    </figure>
  );
}
