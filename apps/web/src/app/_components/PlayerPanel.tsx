'use client';

import { useState } from 'react';
import type { PropGame, PlayerTotals } from '@mlb-edge/db';
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

export function PlayerPanel({
  playerId, playerName, prop, totals, games, marketLine, projMean, windowLabel,
}: {
  playerId: number;
  playerName: string;
  prop: string;
  totals: PlayerTotals;
  games: PropGame[];
  marketLine: number | null;
  projMean: number | null;
  windowLabel: string;
}) {
  // null means "follow the market", so a reset keeps tracking the book rather
  // than freezing today's number.
  const [override, setOverride] = useState<number | null>(null);
  const line = override ?? marketLine;

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
          <div><dt>PA</dt><dd className="num">{totals.pa}</dd></div>
          <div><dt>Hits</dt><dd className="num">{totals.h}</dd></div>
          <div><dt>AVG</dt><dd className="num">{fmt3(totals.avg)}</dd></div>
          <div><dt>OBP</dt><dd className="num">{fmt3(totals.obp)}</dd></div>
          <div>
            <dt>xBA</dt>
            <dd className="ph-na" title="Statcast expected batting average — needs per-pitch hitData, which is not ingested">—</dd>
          </div>
          <div><dt>BABIP</dt><dd className="num">{fmt3(totals.babip)}</dd></div>
        </dl>
      </div>

      <PropBars
        games={games} line={line} marketLine={marketLine} projMean={projMean}
        prop={prop} onLineChange={setOverride}
      />
    </>
  );
}
