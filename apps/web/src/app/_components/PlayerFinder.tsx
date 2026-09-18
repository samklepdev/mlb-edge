'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { SlateSearchHit } from '@mlb-edge/db';
import { Headshot } from './Headshot';
import { abbrev } from './teams';

// Type-ahead over the slate's projected players.
//
// Client-side because it filters on every keystroke, and a server round trip
// per character on a force-dynamic page would be visibly slow. The whole slate
// is ~500 rows, so it is cheaper to ship the list once than to query per key.
//
// Allowed as a client component only because nothing server-only reaches it:
// the @mlb-edge/db import is `import type` and erases at compile, so `pg` never
// enters the browser bundle (CLAUDE.md), and ./teams is a frozen map.
//
// `base` is a plain object rather than a href-building function: functions are
// not serialisable across the server/client boundary, so the URL is assembled
// here from the params the page hands over.
const MAX_SHOWN = 40;

export function PlayerFinder({
  players, base, selectedId,
}: {
  players: SlateSearchHit[];
  base: Record<string, string>;
  selectedId: number | null;
}) {
  const [q, setQ] = useState('');

  const hits = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (term.length < 2) return [];
    // Case- and accent-insensitive: the slate is full of names like Peña and
    // Suárez, and a reader typing "pena" should still find them.
    const norm = (s: string) =>
      s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const needle = norm(term);
    return players.filter((p) => norm(p.playerName).includes(needle)).slice(0, MAX_SHOWN);
  }, [q, players]);

  const term = q.trim();
  const hrefFor = (h: SlateSearchHit) => {
    const p = new URLSearchParams(base);
    p.set('game', String(h.gameId));
    p.set('player', String(h.playerId));
    return `/?${p.toString()}`;
  };

  return (
    <>
      <div className="ex-search">
        <input
          className="ex-search-in"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a player…"
          aria-label="Find a player on this slate"
          aria-describedby="ex-search-status"
          autoComplete="off"
        />
      </div>

      {/* Announced politely so a screen-reader user hears the count change as
          they type, rather than silently filtering under them. */}
      <p id="ex-search-status" className="ex-sr" role="status" aria-live="polite">
        {term.length < 2 ? '' : `${hits.length} player(s) match ${term}`}
      </p>

      {term.length >= 2 && (
        <div className="ex-results">
          {hits.length === 0 ? (
            <p className="cap ex-empty">No projected player matches that.</p>
          ) : (
            <ul className="ex-players">
              {hits.map((h) => (
                <li key={`${h.gameId}-${h.playerId}`}>
                  <Link
                    className={`ex-player${h.playerId === selectedId ? ' ex-sel' : ''}`}
                    href={hrefFor(h)}
                  >
                    <Headshot playerId={h.playerId} size={20} />
                    <span>{h.playerName}</span>
                    {/* Which game the hit is in -- the one thing a flat list
                        loses next to the grouped view below it. */}
                    <span className="ex-hit-game">
                      {abbrev(h.awayId, h.away ?? '')}@{abbrev(h.homeId, h.home ?? '')}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {hits.length === MAX_SHOWN && (
            <p className="cap ex-empty">First {MAX_SHOWN} shown — keep typing to narrow.</p>
          )}
        </div>
      )}
    </>
  );
}
