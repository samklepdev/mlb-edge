'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Headshot } from './Headshot';

interface RosterPlayer {
  playerId: number;
  playerName: string;
  matchup: string | null;
  props: string;
  hasPick: boolean;
}

export function RosterSearch({ roster, date }: { roster: RosterPlayer[]; date: string }) {
  const [q, setQ] = useState('');
  const norm = q.trim().toLowerCase();
  const filtered = norm ? roster.filter((r) => r.playerName.toLowerCase().includes(norm)) : roster;

  return (
    <div>
      <input
        className="search"
        type="search"
        placeholder={`Search ${roster.length} projected players…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search players"
      />
      {filtered.length === 0 ? (
        <p className="cap">No players match &ldquo;{q}&rdquo;.</p>
      ) : (
        <div className="roster">
          {filtered.map((r) => (
            <Link key={r.playerId} href={`/player?id=${r.playerId}&date=${date}`} className="roster-row">
              <span className="rname">
                <Headshot playerId={r.playerId} size={28} />
                {r.playerName}
                {r.hasPick ? <span className="pickdot" aria-label="flagged edge" /> : null}
              </span>
              <span className="rmeta">{[r.matchup, r.props].filter(Boolean).join(' · ')}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
