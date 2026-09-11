import Link from 'next/link';
import { getPlayerCard, latestSlateDate, type PlayerCardRow } from '@mlb-edge/db';
import { Headshot } from '../_components/Headshot';

export const dynamic = 'force-dynamic';

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const signed = (v: number, d = 3) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

export default async function PlayerPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; date?: string }>;
}) {
  const sp = await searchParams;
  const id = Number(sp.id);
  const date = sp.date ?? (await latestSlateDate()) ?? '';

  let card = null;
  let error: string | null = null;
  try {
    card = Number.isFinite(id) && date ? await getPlayerCard(id, date) : null;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="wrap">
      <header className="masthead">
        <h1 className="wordmark">
          <Link href="/">mlb-edge</Link> <span>/ player</span>
        </h1>
        <p className="purpose">
          The model&apos;s read for one player on a slate: projection, market
          line, and where they disagree. A big edge is a hypothesis, not a lock.
        </p>
      </header>

      {error ? (
        <section className="notice"><h2>Error</h2><p>{error}</p></section>
      ) : !card ? (
        <section className="notice">
          <h2>Player not found</h2>
          <p>Open a player from the slate on the home page, or pass ?id= and ?date=.</p>
        </section>
      ) : (
        <section className="clv">
          <div className="player-id">
            <Headshot playerId={card.playerId} />
            <h2>{card.playerName} · {card.date}</h2>
          </div>
          {card.rows.length === 0 ? (
            <p className="cap">No projections for this player on {card.date}.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Prop</th><th>Matchup</th><th>Projection</th><th>Line</th>
                  <th>Model</th><th>Fair</th><th>Edge</th><th>Side</th><th>Pick</th>
                </tr>
              </thead>
              <tbody>
                {card.rows.map((r: PlayerCardRow) => (
                  <tr key={r.propType}>
                    <td>{r.propType}</td>
                    <td>{r.matchup ?? '—'}</td>
                    <td className="num">{r.projMean.toFixed(2)}{r.projStdev != null ? ` ± ${r.projStdev.toFixed(2)}` : ''}</td>
                    <td className="num">{r.line ?? '—'}</td>
                    <td className="num">{r.modelProb == null ? '—' : pct(r.modelProb)}</td>
                    <td className="num">{r.fairProb == null ? '—' : pct(r.fairProb)}</td>
                    <td className={`num ${r.edgePct != null && r.edgePct > 0 ? 'good' : ''}`}>{r.edgePct == null ? '—' : signed(r.edgePct)}</td>
                    <td>{r.side ?? '—'}</td>
                    <td>{r.hasPick ? '✓' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="cap" style={{ marginTop: '1rem' }}>
            &quot;Model&quot; is the model&apos;s probability for the side it favors; &quot;Fair&quot; is the
            de-vigged market probability for that same side; &quot;Edge&quot; is the difference.
            No market line means no odds were pulled for that prop.
          </p>
        </section>
      )}
    </main>
  );
}
