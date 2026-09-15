import Link from 'next/link';
import type { SlateGame } from '@mlb-edge/db';
import { abbrev, logoUrl } from './teams';

// Pinned to ET rather than rendered "local". These pages are force-dynamic
// server renders, so an unpinned local time would silently mean the *server's*
// zone, and a client-side conversion would trade a cosmetic detail for a
// hydration mismatch. ET is also how MLB.com labels start times.
const TIME = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/New_York',
});

function firstPitch(startTime: Date | null): string {
  return startTime ? `${TIME.format(startTime)} ET` : '—';
}

function TeamLine({ id, name, runs }: { id: number | null; name: string; runs: number | null }) {
  const logo = logoUrl(id);
  return (
    <div className="gc-team">
      {/* A background-image, not an <img>: the logo CDN has no default-image
          transform, so an unknown id 404s. This degrades to blank space
          instead of a broken-image icon, and the abbreviation beside it
          carries the identity regardless. */}
      <span
        className="gc-logo"
        style={logo ? { backgroundImage: `url(${logo})` } : undefined}
        aria-hidden="true"
      />
      <span className="gc-abbr cnd">{abbrev(id, name)}</span>
      {runs != null && <span className="gc-runs num">{runs}</span>}
    </div>
  );
}

export function GameCard({ game, listedEdges }: { game: SlateGame; listedEdges: number }) {
  const played = game.homeRuns != null || game.awayRuns != null;
  return (
    // The whole card is the link, so the target matches what a user reads as
    // one object. The accessible name has to be built explicitly: the card's
    // own text is two abbreviations and a time, which announces as "LAA NYY
    // 7:05 PM ET" and tells a screen-reader user nothing about where it goes.
    <Link
      className="gamecard"
      href={`/game?id=${game.gameId}`}
      aria-label={
        played
          ? `${game.away} ${game.awayRuns ?? 0}, ${game.home} ${game.homeRuns ?? 0}, ${game.status} — game detail`
          : `${game.away} at ${game.home}, ${firstPitch(game.startTime)} — game detail`
      }
    >
      <TeamLine id={game.awayId} name={game.away} runs={game.awayRuns} />
      <TeamLine id={game.homeId} name={game.home} runs={game.homeRuns} />
      {/* Once a game has been played the start time is no longer the useful
          fact; the status is. */}
      <div className="gc-meta num">{played ? game.status : firstPitch(game.startTime)}</div>
      <div className="gc-edges">
        {/* "not projected" is a distinct state from "projected, no edges". The
            first is a missing pipeline step the user can act on; the second is
            the model having nothing to say. Collapsing both to an em dash is
            what made ingested games look like they had failed to load. */}
        {!game.hasProjections
          ? 'not projected'
          : listedEdges > 0 ? `${listedEdges} listed` : '—'}
      </div>
    </Link>
  );
}
