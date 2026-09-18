'use client';

import { useState } from 'react';
import type { PropGame, PlayerTotals, OppPitcherProfile } from '@mlb-edge/db';
import { Headshot } from './Headshot';
import { PropLabel } from './PropLabel';
import { PropBars } from './PropBars';

// Owns the adjustable line, because two things depend on it: the hit rate in
// the player header and the chart below. Keeping the state here is what lets
// them agree -- computing hit rate on the server would freeze it at the
// market's number and contradict the bars the moment the line moved.
//
// Client component, allowed because nothing server-only reaches it: the
// @mlb-edge/db imports are `import type` and erase at compile, so `pg` never
// enters the client bundle. Props arrive as plain JSON.

const fmt3 = (v: number | null) => (v == null ? '—' : v.toFixed(3).replace(/^0/, ''));
const fmt2 = (v: number | null) => (v == null ? '—' : v.toFixed(2));
// Outs -> innings in baseball's own notation: 19 outs is 6.1, not 6.33.
const ip = (outs: number) => `${Math.floor(outs / 3)}.${outs % 3}`;

export function PlayerPanel({
  playerId, playerName, prop, pitching, pending, totals, games, marketLine, projMean, windowLabel,
}: {
  playerId: number;
  playerName: string;
  prop: string;
  /** Computed on the SERVER and passed down. PITCHER_PROPS lives in
   *  @mlb-edge/db, whose module graph reaches `pg`; importing it as a value
   *  here -- rather than as a type -- would drag a server-only driver into the
   *  client bundle, which CLAUDE.md forbids outright. */
  pitching: boolean;
  /** The upcoming game this chart is set up for; see PropBars. */
  pending?: {
    date: string; opponentId: number | null; opponent: string | null; home: boolean;
    opp: OppPitcherProfile | null;
  } | null;
  totals: PlayerTotals;
  games: PropGame[];
  marketLine: number | null;
  projMean: number | null;
  windowLabel: string;
}) {
  // null means "follow the market", so a reset keeps tracking the book rather
  // than freezing today's number.
  const [override, setOverride] = useState<number | null>(null);

  // With no book line, seed one from the player's own window rather than
  // leaving the chart uncoloured until the reader acts. The seed is the median
  // dropped to the half-integer below it: half-integers because that is how
  // props trade, and because a whole number would make every game equal to the
  // line a push rather than a side.
  //
  // This DOES mean bars are coloured against a threshold no book is offering,
  // which is why `source` exists and why the tag and caption name it. The
  // number is derived from the player's own distribution, so it is a
  // description of their history, not a suggested bet.
  const seeded = (() => {
    const v = games.map((g) => g.value).sort((a, b) => a - b);
    const med = v[Math.floor(v.length / 2)] ?? 0;
    return Math.max(0.5, Math.floor(med) + 0.5);
  })();

  const line = override ?? marketLine ?? seeded;
  const source: 'market' | 'seeded' | 'custom' =
    override != null ? 'custom' : marketLine != null ? 'market' : 'seeded';

  const cleared = line == null ? 0 : games.filter((g) => g.value > line).length;
  const hitRate = line == null || games.length === 0
    ? null
    : Math.round((100 * cleared) / games.length);

  return (
    <>
      <div className="ph">
        <Headshot playerId={playerId} size={52} />
        <div className="ph-id">
          <h2 className="ph-name">{playerName}</h2>
          <p className="ph-sub"><PropLabel prop={prop} /> · {windowLabel}</p>
        </div>
        <dl className="ph-stats">
          {/* A pitcher prop gets a pitcher's line. Showing plate appearances
              and a batting average beside a strikeout chart would be noise --
              the same mistake as applying the handedness filter to a pitcher. */}
          {/* Hit rate first, and it tracks the line the reader sets below --
              which is why this header is inside the client component at all.
              No colour: a high hit rate is a fact about the past, not a verdict
              on the next game. */}
          <div className="ph-hr">
            <dt>Hit rate</dt>
            <dd className="num">
              {hitRate == null ? '—' : `${hitRate}%`}
              {line != null && games.length > 0 && (
                <span className="ph-hr-n num"> {cleared}/{games.length}</span>
              )}
            </dd>
          </div>
          {pitching ? (
            <>
              <div><dt>IP</dt><dd className="num">{ip(totals.pOuts)}</dd></div>
              <div><dt>BF</dt><dd className="num">{totals.pBf}</dd></div>
              <div><dt>K</dt><dd className="num">{totals.pSo}</dd></div>
              <div><dt>BB</dt><dd className="num">{totals.pBb}</dd></div>
              <div><dt>ERA</dt><dd className="num">{fmt2(totals.era)}</dd></div>
              <div><dt>WHIP</dt><dd className="num">{fmt2(totals.whip)}</dd></div>
            </>
          ) : (
            <>
              <div><dt>PA</dt><dd className="num">{totals.pa}</dd></div>
              <div><dt>Hits</dt><dd className="num">{totals.h}</dd></div>
              <div><dt>AVG</dt><dd className="num">{fmt3(totals.avg)}</dd></div>
              <div><dt>OBP</dt><dd className="num">{fmt3(totals.obp)}</dd></div>
              <div>
                <dt>xBA</dt>
                <dd className="ph-na" title="Statcast expected batting average — the per-pitch inputs are now stored, but xBA itself is a model this project does not fit">—</dd>
              </div>
              <div><dt>BABIP</dt><dd className="num">{fmt3(totals.babip)}</dd></div>
            </>
          )}
        </dl>
      </div>

      <PropBars
        games={games} line={line} marketLine={marketLine} source={source}
        projMean={projMean} prop={prop} pitching={pitching} pending={pending}
        onLineChange={setOverride}
      />
    </>
  );
}
