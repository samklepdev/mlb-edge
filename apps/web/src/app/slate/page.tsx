import Link from 'next/link';
import {
  latestSlateDate, getSlateGames, getTopEdges, getSlateRoster,
  adjacentSlateDates, slateDateBounds,
} from '@mlb-edge/db';
import { SlateNav } from '../_components/SlateNav';
import { RosterSearch } from '../_components/RosterSearch';
import { GameCard } from '../_components/GameCard';
import { Headshot } from '../_components/Headshot';
import { Side } from '../_components/Side';
import { PropLabel } from '../_components/PropLabel';

export const dynamic = 'force-dynamic';

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const signed = (v: number, d = 3) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

// `requested` is ?date=. Falling back to latestSlateDate() keeps the default
// landing view on the most recent PROJECTED slate: a default of "today" would
// often open on a date whose games are ingested but not yet projected, which
// is an empty dashboard. Navigation can still reach those dates deliberately.
async function load(requested?: string) {
  try {
    const latest = await latestSlateDate();
    const slateDate = requested ?? latest;
    const [games, edges, roster] = await Promise.all([
      slateDate ? getSlateGames(slateDate) : Promise.resolve([]),
      slateDate ? getTopEdges(slateDate, 25) : Promise.resolve([]),
      slateDate ? getSlateRoster(slateDate) : Promise.resolve([]),
    ]);
    const [adjacent, bounds] = await Promise.all([
      slateDate ? adjacentSlateDates(slateDate) : Promise.resolve({ prev: null, next: null }),
      slateDateBounds(),
    ]);
    return { ok: true as const, slateDate, games, edges, roster, adjacent, bounds };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

// A date is only accepted in the canonical YYYY-MM-DD form. Anything else is
// ignored rather than passed to the query layer, so a hand-edited ?date= can
// never reach a parameterised date cast and 500 the page.
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const sp = await searchParams;
  const requested = sp.date && VALID_DATE.test(sp.date) ? sp.date : undefined;
  const d = await load(requested);

  const listedByGame = new Map<number, number>();
  if (d.ok) for (const e of d.edges) listedByGame.set(e.gameId, (listedByGame.get(e.gameId) ?? 0) + 1);
  const unprojected = d.ok ? d.games.filter((g) => !g.hasProjections).length : 0;

  return (
    <main className="wrap">
      <header className="masthead">
        <h1 className="wordmark">
          <Link href="/">mlb-edge</Link> <span>/ slate</span>
        </h1>
        <p className="purpose">
          Today&apos;s games and where the model disagrees with the market. An
          edge here is a hypothesis, not a recommendation —{' '}
          {/* The calibration and CLV figures moved to /model, so this link is
              load-bearing: without it the landing page shows edges with no
              route to the evidence about whether they mean anything. */}
          <Link href="/model">check the model</Link> before believing one.
        </p>
      </header>

      {!d.ok ? (
        <section className="notice">
          <h2>Can&apos;t reach the database</h2>
          <p>Start Postgres and apply migrations, then reload. Error: {d.error}</p>
          <code>{`docker compose up -d\nnpm run db:migrate`}</code>
        </section>
      ) : (
        <>
          {/* --- today's slate: games + top edges --- */}
          {d.slateDate && (
            <section className="clv">
              <h2>Slate · {d.slateDate}</h2>
              <SlateNav
                date={d.slateDate}
                prev={d.adjacent.prev}
                next={d.adjacent.next}
                min={d.bounds.min}
                max={d.bounds.max}
              />
              {d.games.length === 0 ? (
                <p className="cap">No games ingested for {d.slateDate}. Run <code style={{ display: 'inline' }}>ingest schedule --date {d.slateDate}</code>.</p>
              ) : (
                <>
                  <div className="slate-strip" tabIndex={0} role="region" aria-label="Slate scoreboard, scrollable">
                    {d.games.map((g) => (
                      <GameCard key={g.gameId} game={g} listedEdges={listedByGame.get(g.gameId) ?? 0} />
                    ))}
                  </div>
                  {unprojected > 0 && (
                    <p className="cap">
                      {unprojected} of these {d.games.length} game(s) have no projection yet, so
                      they carry no edges — they are ingested, not missing. Run{' '}
                      <code style={{ display: 'inline' }}>project --date {d.slateDate}</code> to
                      model them.
                    </p>
                  )}
                  <p className="cap">
                    {d.games.length} game(s). &ldquo;Listed&rdquo; counts this
                    game&apos;s picks in the table below, which shows only the
                    highest-edge {d.edges.length} of the slate — not every edge
                    on the game.
                  </p>
                </>
              )}
              {d.edges.length > 0 && (
                <div className="tscroll" tabIndex={0} role="region" aria-label="Top edges, scrollable">
                  <table>
                    <thead>
                      <tr><th>Player</th><th>Prop</th><th>Side</th><th>Line</th><th>Model</th><th>Edge</th></tr>
                    </thead>
                    <tbody>
                      {d.edges.map((e) => (
                        <tr key={`${e.playerId}-${e.propType}`}>
                          <td>
                            <Link className="prow" href={`/player?id=${e.playerId}&date=${d.slateDate}`}>
                              <Headshot playerId={e.playerId} size={28} />
                              <span>{e.playerName}</span>
                            </Link>
                          </td>
                          <td><PropLabel prop={e.propType} /></td>
                          <td><Side side={e.side} /></td>
                          <td className="num">{e.line}</td>
                          <td className="num">{pct(e.modelProb)}</td>
                          <td className="num">{signed(e.edgePct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {/* --- full browsable roster --- */}
          {d.slateDate && d.roster.length > 0 && (
            <section className="clv">
              <h2>Players on this slate</h2>
              <p className="cap">
                All {d.roster.length} projected players. &#9679; marks the model&apos;s
                flagged edges. Open anyone&apos;s card to see projection vs market.
              </p>
              <RosterSearch roster={d.roster} date={d.slateDate} />
            </section>
          )}

        </>
      )}
    </main>
  );
}
