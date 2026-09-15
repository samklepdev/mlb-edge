import Link from 'next/link';
import { getGameDetail, type GameBattingLine, type GamePitchingLine } from '@mlb-edge/db';
import { Headshot } from '../_components/Headshot';
import { Side } from '../_components/Side';
import { PropLabel } from '../_components/PropLabel';
import { abbrev, logoUrl } from '../_components/teams';

export const dynamic = 'force-dynamic';

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const signed = (v: number, d = 3) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

// Same reasoning as GameCard: pinned to ET, because these are force-dynamic
// server renders and "local" would silently mean the server's zone.
const TIME = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
});

// A game is "done" when there are runs to show. Status strings are MLB's and
// vary ('Final', 'Completed Early', ...), so the presence of a box score is the
// more reliable signal -- and it is exactly the condition under which a score
// can be rendered at all.
const outsToIp = (outs: number) => `${Math.floor(outs / 3)}.${outs % 3}`;

function TeamScore({
  teamId, name, runs, winner,
}: { teamId: number | null; name: string; runs: number | null; winner: boolean }) {
  const logo = logoUrl(teamId);
  return (
    <div className="gs-team">
      <span
        className="gs-logo"
        style={logo ? { backgroundImage: `url(${logo})` } : undefined}
        aria-hidden="true"
      />
      <span className="gs-name cnd">{abbrev(teamId, name)}</span>
      <span className="gs-full">{name}</span>
      {/* Winners are marked with a glyph, not a colour. Green on a winning
          team would be the same mistake as green on an edge: this page sits
          beside the model's picks, and colour here would read as endorsement. */}
      <span className="gs-runs num">
        {runs == null ? '—' : runs}
        {winner && <span className="gs-win" aria-label="winner"> ◂</span>}
      </span>
    </div>
  );
}

function BattingTable({ rows, label }: { rows: GameBattingLine[]; label: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="tscroll" tabIndex={0} role="region" aria-label={`${label} batting, scrollable`}>
      <table>
        <thead>
          <tr>
            <th>{label} — batting</th><th>PA</th><th>AB</th><th>H</th>
            <th>HR</th><th>TB</th><th>BB</th><th>K</th><th>R</th><th>RBI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.playerId}>
              <td>
                <Link className="prow" href={`/player?id=${b.playerId}`}>
                  <Headshot playerId={b.playerId} size={24} />
                  <span>{b.playerName}</span>
                </Link>
              </td>
              <td className="num">{b.pa}</td><td className="num">{b.ab}</td>
              <td className="num">{b.h}</td><td className="num">{b.hr}</td>
              <td className="num">{b.tb}</td><td className="num">{b.bb}</td>
              <td className="num">{b.so}</td><td className="num">{b.r}</td>
              <td className="num">{b.rbi}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PitchingTable({ rows, label }: { rows: GamePitchingLine[]; label: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="tscroll" tabIndex={0} role="region" aria-label={`${label} pitching, scrollable`}>
      <table>
        <thead>
          <tr>
            <th>{label} — pitching</th><th>IP</th><th>BF</th>
            <th>H</th><th>BB</th><th>K</th><th>ER</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.playerId}>
              <td>
                <Link className="prow" href={`/player?id=${p.playerId}`}>
                  <Headshot playerId={p.playerId} size={24} />
                  <span>{p.playerName}</span>
                </Link>
              </td>
              <td className="num">{outsToIp(p.outs)}</td><td className="num">{p.bf}</td>
              <td className="num">{p.h}</td><td className="num">{p.bb}</td>
              <td className="num">{p.so}</td><td className="num">{p.er}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function GamePage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const sp = await searchParams;
  const id = Number(sp.id);

  let game = null;
  let error: string | null = null;
  try {
    game = Number.isFinite(id) ? await getGameDetail(id) : null;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const played = game != null && (game.home.runs != null || game.away.runs != null);
  const homeBatting = game?.batting.filter((b) => b.teamId === game.home.teamId) ?? [];
  const awayBatting = game?.batting.filter((b) => b.teamId === game.away.teamId) ?? [];
  const homePitching = game?.pitching.filter((p) => p.teamId === game.home.teamId) ?? [];
  const awayPitching = game?.pitching.filter((p) => p.teamId === game.away.teamId) ?? [];
  const settled = game?.picks.filter((p) => p.result != null) ?? [];

  return (
    <main className="wrap">
      <header className="masthead">
        <h1 className="wordmark">
          <Link href="/">mlb-edge</Link> <span>/ game</span>
        </h1>
        <p className="purpose">
          What happened, and what the model had said about it. These are
          per-player prop picks, not a prediction about who wins.
        </p>
      </header>

      {error ? (
        <section className="notice"><h2>Error</h2><p>{error}</p></section>
      ) : !game ? (
        <section className="notice">
          <h2>Game not found</h2>
          <p>Open a game from the slate on the home page, or pass ?id=.</p>
        </section>
      ) : (
        <>
          <section className="gamescore">
            <TeamScore
              teamId={game.away.teamId} name={game.away.name} runs={game.away.runs}
              winner={played && (game.away.runs ?? 0) > (game.home.runs ?? 0)} />
            <TeamScore
              teamId={game.home.teamId} name={game.home.name} runs={game.home.runs}
              winner={played && (game.home.runs ?? 0) > (game.away.runs ?? 0)} />
            <div className="gs-meta">
              <span>{game.status}</span>
              <span>{game.date}</span>
              {game.startTime && <span className="num">{TIME.format(game.startTime)} ET</span>}
              {game.venue && <span>{game.venue}</span>}
            </div>
          </section>

          {/* Pregame picture. Shown for an unplayed game, where it is the only
              thing there is; kept for a played one because the probable
              starters are what the projection was conditioned on. */}
          {(game.probableAway || game.probableHome || game.weather) && (
            <section className="clv">
              <h2>{played ? 'Conditions' : 'Pregame'}</h2>
              <div className="tscroll" tabIndex={0} role="region" aria-label="Pregame details, scrollable">
                <table>
                  <tbody>
                    {game.probableAway && (
                      <tr>
                        <td>{abbrev(game.away.teamId, game.away.name)} probable</td>
                        <td>
                          <Link className="prow" href={`/player?id=${game.probableAway.playerId}`}>
                            <Headshot playerId={game.probableAway.playerId} size={24} />
                            <span>{game.probableAway.playerName}</span>
                          </Link>
                          {game.probableAway.throws && ` (${game.probableAway.throws}HP)`}
                        </td>
                      </tr>
                    )}
                    {game.probableHome && (
                      <tr>
                        <td>{abbrev(game.home.teamId, game.home.name)} probable</td>
                        <td>
                          <Link className="prow" href={`/player?id=${game.probableHome.playerId}`}>
                            <Headshot playerId={game.probableHome.playerId} size={24} />
                            <span>{game.probableHome.playerName}</span>
                          </Link>
                          {game.probableHome.throws && ` (${game.probableHome.throws}HP)`}
                        </td>
                      </tr>
                    )}
                    {game.weather && (
                      <tr>
                        <td>Weather</td>
                        <td>
                          {[
                            game.weather.condition,
                            game.weather.tempF == null ? null : `${game.weather.tempF}°F`,
                            game.weather.wind,
                          ].filter(Boolean).join(' · ') || '—'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* The model's picks for this game. This is the part a scoreboard
              doesn't have, and the reason the page exists. */}
          {game.picks.length > 0 && (
            <section className="clv">
              <h2>Model picks on this game</h2>
              <p className="cap">
                {settled.length > 0
                  ? `${game.picks.length} pick(s), ${settled.length} settled. A settled pick is one
                     outcome of one prop — it is not evidence the model has an edge. That question
                     is answered by closing line value across many picks, not by this game.`
                  : `${game.picks.length} flagged edge(s). An edge is a hypothesis, not a
                     recommendation — the market is usually right about what the model is missing.`}
              </p>
              <div className="tscroll" tabIndex={0} role="region" aria-label="Model picks, scrollable">
                <table>
                  <thead>
                    <tr>
                      <th>Player</th><th>Prop</th><th>Side</th><th>Line</th>
                      <th>Model</th><th>Edge</th><th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {game.picks.map((p) => (
                      <tr key={`${p.playerId}-${p.propType}`}>
                        <td>
                          <Link className="prow" href={`/player?id=${p.playerId}&date=${game.date}`}>
                            <Headshot playerId={p.playerId} size={24} />
                            <span>{p.playerName}</span>
                          </Link>
                        </td>
                        <td><PropLabel prop={p.propType} /></td>
                        <td><Side side={p.side} /></td>
                        <td className="num">{p.line}</td>
                        <td className="num">{pct(p.modelProb)}</td>
                        <td className="num">{p.edgePct == null ? '—' : signed(p.edgePct)}</td>
                        {/* Result is a fact, but it still gets no colour: a
                            green "win" beside an untested model reads as a
                            track record. */}
                        <td>{p.result ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {played ? (
            <section className="clv">
              <h2>Box score</h2>
              <BattingTable rows={awayBatting} label={abbrev(game.away.teamId, game.away.name)} />
              <BattingTable rows={homeBatting} label={abbrev(game.home.teamId, game.home.name)} />
              <PitchingTable rows={awayPitching} label={abbrev(game.away.teamId, game.away.name)} />
              <PitchingTable rows={homePitching} label={abbrev(game.home.teamId, game.home.name)} />
            </section>
          ) : (
            <section className="clv">
              <h2>Box score</h2>
              <p className="cap">
                Nothing to show yet — this game has no ingested box score. It
                appears once the game is final and <code style={{ display: 'inline' }}>ingest games</code> has run.
              </p>
            </section>
          )}
        </>
      )}
    </main>
  );
}
