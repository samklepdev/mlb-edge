import Link from 'next/link';
import {
  latestSlateDate, getSlateGames, getGamePlayers,
  getPropHistory, getPropReference, getMatchupContext,
  type SlateGame, type ExplorerPlayer, type MatchupContext,
} from '@mlb-edge/db';
import { Headshot } from './_components/Headshot';
import { PropLabel } from './_components/PropLabel';
import { PropBars } from './_components/PropBars';
import { abbrev } from './_components/teams';

export const dynamic = 'force-dynamic';

// Tab order is deliberate, not alphabetical or schema order. The default below
// is PROPS[0] rather than a separate constant, so the landing tab can never
// drift away from the leftmost one.
const PROPS = ['hits', 'home_runs', 'total_bases', 'strikeouts'] as const;
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Every control is a link that rewrites the query string, so the whole page is
// server-rendered with no client component. State lives in the URL, which also
// means any view can be linked to or reloaded.
type Q = {
  date?: string; game?: string; player?: string; prop?: string;
  last?: string; venue?: string; hand?: string;
};
const href = (q: Q) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, String(v));
  return `/?${p.toString()}`;
};

export default async function PropsPage({
  searchParams,
}: {
  searchParams: Promise<Q>;
}) {
  const sp = await searchParams;
  const date = sp.date && VALID_DATE.test(sp.date) ? sp.date : (await latestSlateDate()) ?? '';
  const prop = PROPS.includes(sp.prop as (typeof PROPS)[number]) ? sp.prop! : PROPS[0];
  const last = ['5', '10', '15', '25'].includes(sp.last ?? '') ? sp.last! : '15';
  const venue = ['home', 'away'].includes(sp.venue ?? '') ? sp.venue! : 'all';
  const hand = ['L', 'R'].includes(sp.hand ?? '') ? sp.hand! : 'all';

  let games: SlateGame[] = [];
  let players: ExplorerPlayer[] = [];
  let error: string | null = null;
  try {
    games = date ? await getSlateGames(date) : [];
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const gameId = sp.game ? Number(sp.game) : null;
  const openGame = games.find((g) => g.gameId === gameId) ?? null;
  if (openGame) players = await getGamePlayers(openGame.gameId);

  const playerId = sp.player ? Number(sp.player) : null;
  const player = players.find((p) => p.playerId === playerId) ?? null;

  const history = player
    ? await getPropHistory(player.playerId, prop, { venue, hand, limit: Number(last) })
    : [];
  const reference = player && openGame
    ? await getPropReference(player.playerId, openGame.gameId, prop)
    : { line: null, projMean: null };
  const matchup: MatchupContext | null = player && openGame
    ? await getMatchupContext(openGame.gameId, player.playerId)
    : null;

  const base: Q = { date, game: sp.game, player: sp.player, prop, last, venue: sp.venue, hand: sp.hand };

  return (
    <main className="wrap wide">
      <header className="masthead">
        <h1 className="wordmark">mlb-edge <span>/ props</span></h1>
        <p className="purpose">
          One player, one prop, game by game against the market line. Past
          results are not a forecast — see <Link href="/model">the model</Link> for
          whether any of this has predictive value, and <Link href="/slate">the
          slate</Link> for today&apos;s games.
        </p>
      </header>

      {error ? (
        <section className="notice"><h2>Error</h2><p>{error}</p></section>
      ) : (
        <>
          <div className="explore">
            {/* --- left: games, expanding to players --- */}
            <aside className="ex-games" aria-label="Games and players">
              <h2 className="ex-h">Games</h2>
              {games.length === 0 && <p className="cap">No games for {date}.</p>}
              <ul className="ex-list">
                {games.map((g) => {
                  const open = openGame?.gameId === g.gameId;
                  return (
                    <li key={g.gameId}>
                      <Link
                        className={`ex-game${open ? ' ex-open' : ''}`}
                        href={href({ ...base, game: open ? undefined : String(g.gameId), player: undefined })}
                        aria-expanded={open}
                      >
                        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                        <span className="cnd">{abbrev(g.awayId, g.away)} @ {abbrev(g.homeId, g.home)}</span>
                        {!g.hasProjections && <span className="ex-note">not projected</span>}
                      </Link>
                      {open && (
                        <>
                          {players.length === 0 && (
                            <p className="cap ex-empty">No projected players on this game.</p>
                          )}
                          {/* Grouped by team, away first, matching how the
                              matchup reads. The third group is not decoration:
                              a player whose resolved team is neither side --
                              traded mid-season, or never having appeared --
                              would otherwise vanish from a list that is the
                              only way to reach them. */}
                          {[
                            { id: g.awayId, name: g.away, label: 'away' },
                            { id: g.homeId, name: g.home, label: 'home' },
                            { id: null, name: 'Other', label: 'unplaced' },
                          ].map((side) => {
                            const roster = side.id == null
                              ? players.filter((p) => p.teamId !== g.awayId && p.teamId !== g.homeId)
                              : players.filter((p) => p.teamId === side.id);
                            if (roster.length === 0) return null;
                            return (
                              <div key={side.label} className="ex-team">
                                <p className="ex-team-h cnd">
                                  {side.id == null ? 'Other' : abbrev(side.id, side.name)}
                                  <span className="ex-team-n num">{roster.length}</span>
                                </p>
                                <ul className="ex-players">
                                  {roster.map((p) => (
                                    <li key={p.playerId}>
                                      <Link
                                        className={`ex-player${p.playerId === player?.playerId ? ' ex-sel' : ''}`}
                                        href={href({ ...base, game: String(g.gameId), player: String(p.playerId) })}
                                        aria-current={p.playerId === player?.playerId ? 'true' : undefined}
                                      >
                                        <Headshot playerId={p.playerId} size={20} />
                                        <span>{p.playerName}</span>
                                      </Link>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            );
                          })}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </aside>

            {/* --- centre: prop tabs, then the chart --- */}
            <section className="ex-main">
              {/* Directly above the graph rather than at the top of the page:
                  the tabs change what the chart plots, so they belong next to
                  it, not separated from it by the whole layout. */}
              <nav className="proptabs" aria-label="Prop type">
                {PROPS.map((p) => (
                  <Link key={p} href={href({ ...base, prop: p })}
                    className={`ptab${p === prop ? ' ptab-on' : ''}`}
                    aria-current={p === prop ? 'page' : undefined}>
                    <PropLabel prop={p} />
                  </Link>
                ))}
                <span className="ptab-date">{date || '—'}</span>
              </nav>
              {!player ? (
                <div className="notice">
                  <h2>Pick a player</h2>
                  <p>Open a game on the left, then choose a player to chart their {prop.replace(/_/g, ' ')} game by game.</p>
                </div>
              ) : (
                <>
                  <h2 className="ex-h">
                    {player.playerName} · <PropLabel prop={prop} />
                  </h2>
                  {!player.props.includes(prop) && (
                    <p className="cap">
                      The model has no {prop.replace(/_/g, ' ')} projection for this player on
                      this game — the chart still shows their history, but there is no model
                      line to compare against.
                    </p>
                  )}
                  {hand !== 'all' && prop !== 'strikeouts' && (
                    <p className="cap">
                      Filtered to {hand}HP: each bar is that game&apos;s production
                      <em> against {hand}-handers only</em>, not the game total — so a
                      bar can be lower than the player&apos;s actual line that day.
                    </p>
                  )}
                  {hand !== 'all' && prop === 'strikeouts' && (
                    <p className="cap">
                      The handedness filter is ignored here. It describes the hand a
                      <em> batter</em> faced, which says nothing about a pitcher&apos;s own
                      strikeout total.
                    </p>
                  )}
                  <PropBars games={history} line={reference.line}
                    projMean={reference.projMean} prop={prop} />

                  {/* --- matchup: conditions first, then the pitcher --- */}
                  <section className="ex-matchup">
                    <h2 className="ex-h">Matchup</h2>
                    {matchup == null ? (
                      <p className="cap">No matchup context for this game.</p>
                    ) : (
                      <>
                        <div className="ex-cond">
                          <span>{matchup.venue ?? 'Park unknown'}</span>
                          {matchup.condition && <span>{matchup.condition}</span>}
                          {matchup.tempF != null && <span className="num">{matchup.tempF}°F</span>}
                          {matchup.wind && <span>{matchup.wind}</span>}
                          {!matchup.condition && matchup.tempF == null && (
                            <span className="ex-note">weather not posted yet</span>
                          )}
                        </div>

                        {matchup.pitcher ? (
                          <p className="cap">
                            Probable starter: <strong>{matchup.pitcher.playerName}</strong>
                            {matchup.pitcher.throws && ` (${matchup.pitcher.throws}HP)`}.
                          </p>
                        ) : (
                          <p className="cap">No probable starter listed for this game.</p>
                        )}

                        {matchup.vsHand ? (
                          <>
                            <div className="tscroll" tabIndex={0} role="region"
                              aria-label="Batter versus pitcher handedness, scrollable">
                              <table>
                                <thead>
                                  <tr>
                                    <th>vs {matchup.vsHand.hand}HP</th><th>PA</th>
                                    <th>H/PA</th><th>TB/PA</th><th>HR/PA</th><th>K/PA</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  <tr>
                                    <td>{player.playerName}</td>
                                    <td className="num">{matchup.vsHand.pa}</td>
                                    <td className="num">{matchup.vsHand.hitsPerPa.toFixed(3)}</td>
                                    <td className="num">{matchup.vsHand.tbPerPa.toFixed(3)}</td>
                                    <td className="num">{matchup.vsHand.hrPerPa.toFixed(3)}</td>
                                    <td className="num">{matchup.vsHand.soPerPa.toFixed(3)}</td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                            <p className="cap">
                              Plate-appearance level, not a starter approximation: these are the
                              PAs this batter actually took against {matchup.vsHand.hand}HP,
                              including relievers. Read it as context, not as an edge — a split
                              this coarse over {matchup.vsHand.pa} PA is mostly noise, and
                              selection matters (a batter benched against same-handed starters
                              looks better against them than he is).
                            </p>
                          </>
                        ) : (
                          <p className="cap">
                            No handedness split available — either the starter&apos;s throwing
                            hand is unknown or this batter has no recorded plate appearances
                            against it.
                          </p>
                        )}

                        <div className="notice ex-todo">
                          <h2>Versus pitch types</h2>
                          <p>
                            Not built. Per-pitch data (type, speed, zone) is present in the
                            live feed this project already downloads for every game, but
                            nothing stores it — adding it means a new table and another pass
                            over history. Deliberately absent rather than approximated from
                            something else.
                          </p>
                        </div>
                      </>
                    )}
                  </section>
                </>
              )}
            </section>

            {/* --- right: filters --- */}
            <aside className="ex-filters" aria-label="Filters">
              <h2 className="ex-h">Filters</h2>

              <p className="ex-flabel" id="f-window">Window</p>
              <div className="ex-fgroup" role="group" aria-labelledby="f-window">
                {['5', '10', '15', '25'].map((n) => (
                  <Link key={n} href={href({ ...base, last: n })}
                    className={`ex-chip${n === last ? ' ex-chip-on' : ''}`}
                    aria-current={n === last ? 'true' : undefined}>last {n}</Link>
                ))}
              </div>

              <p className="ex-flabel" id="f-venue">Venue</p>
              <div className="ex-fgroup" role="group" aria-labelledby="f-venue">
                {[['all', 'All'], ['home', 'Home'], ['away', 'Away']].map(([v, label]) => (
                  <Link key={v} href={href({ ...base, venue: v === 'all' ? undefined : v })}
                    className={`ex-chip${v === venue ? ' ex-chip-on' : ''}`}
                    aria-current={v === venue ? 'true' : undefined}>{label}</Link>
                ))}
              </div>

              <p className="ex-flabel" id="f-hand">Pitcher hand</p>
              <div className="ex-fgroup" role="group" aria-labelledby="f-hand">
                {[['all', 'All'], ['L', 'vs LHP'], ['R', 'vs RHP']].map(([v, label]) => (
                  <Link key={v} href={href({ ...base, hand: v === 'all' ? undefined : v })}
                    className={`ex-chip${v === hand ? ' ex-chip-on' : ''}`}
                    aria-current={v === hand ? 'true' : undefined}>{label}</Link>
                ))}
              </div>

              <p className="cap ex-warn">
                Every filter narrows the sample. Slice far enough and any player
                clears any line — that is the failure mode this project exists to
                avoid, so read the game count under the chart before reading the
                shape.
              </p>
              <p className="cap">
                Showing <span className="num">{history.length}</span> game(s).
              </p>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
