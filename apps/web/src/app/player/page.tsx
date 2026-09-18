import Link from 'next/link';
import {
  getPlayerCard, latestSlateDate, getPlayerResiduals, summarizeResiduals,
  type PlayerCardRow, type ResidualRow, type ResidualSummary,
} from '@mlb-edge/db';
import { Headshot } from '../_components/Headshot';
import { Side } from '../_components/Side';
import { PropLabel } from '../_components/PropLabel';
import { Masthead } from '../_components/Masthead';

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
  let residuals: ResidualRow[] = [];
  let error: string | null = null;
  try {
    if (Number.isFinite(id) && date) {
      [card, residuals] = await Promise.all([
        getPlayerCard(id, date),
        getPlayerResiduals(id),
      ]);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const summary: ResidualSummary[] = summarizeResiduals(residuals);
  // Rows are per prop per game; the caption counts games.
  const residualGames = new Set(residuals.map((r) => r.gameDate)).size;

  return (
    <main className="wrap">
      <Masthead section="player" />

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
            <Headshot playerId={card.playerId} size={72} />
            <h2>{card.playerName} · {card.date}</h2>
          </div>
          {card.rows.length === 0 ? (
            <p className="cap">No projections for this player on {card.date}.</p>
          ) : (
            <div className="tscroll" tabIndex={0} role="region" aria-label="Projection versus market by prop, scrollable">
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
                      <td><PropLabel prop={r.propType} /></td>
                      <td>{r.matchup ?? '—'}</td>
                      <td className="num">{r.projMean.toFixed(2)}{r.projStdev != null ? ` ± ${r.projStdev.toFixed(2)}` : ''}</td>
                      <td className="num">{r.line ?? '—'}</td>
                      <td className="num">{r.modelProb == null ? '—' : pct(r.modelProb)}</td>
                      <td className="num">{r.fairProb == null ? '—' : pct(r.fairProb)}</td>
                      <td className="num">{r.edgePct == null ? '—' : signed(r.edgePct)}</td>
                      <td><Side side={r.side} /></td>
                      <td>{r.hasPick ? '✓' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="cap" style={{ marginTop: '1rem' }}>
            &quot;Model&quot; is the model&apos;s probability for the side it favors; &quot;Fair&quot; is the
            de-vigged market probability for that same side; &quot;Edge&quot; is the difference.
            No market line means no odds were pulled for that prop.
          </p>

          {/* --- per-game residuals: the mean-level diagnostic the backtest can't give ---
              The backtest asks whether the model's probabilities are honest. This
              asks whether its projected MEAN is biased, which a pooled ECE
              averages away across every player, park and opponent. */}
          {residuals.length > 0 && (
            <>
              <h2 style={{ marginTop: '2.75rem' }}>Projection vs actual</h2>
              <p className="cap">
                The model&apos;s last {residualGames} evaluated games, newest first —
                every prop for each, so the per-prop means below cover the same
                games and can be read against each other. Residual is actual
                minus projection: a diagnostic for the projector, not a betting
                signal, and deliberately uncoloured — beating a projection is
                not a win.
              </p>

              <div className="tscroll" tabIndex={0} role="region" aria-label="Residual summary by prop, scrollable">
                <table>
                  <thead>
                    <tr><th>Prop</th><th>Games</th><th>Mean residual</th><th>± SE</th></tr>
                  </thead>
                  <tbody>
                    {summary.map((s) => (
                      <tr key={s.propType}>
                        <td><PropLabel prop={s.propType} /></td>
                        <td className="num">
                          {s.n}
                          {s.dnp > 0 && <span className="dnp-note"> · {s.dnp} DNP excluded</span>}
                        </td>
                        <td className="num">{s.meanResidual == null ? '—' : signed(s.meanResidual, 3)}</td>
                        <td className="num">{s.se == null ? '—' : s.se.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="cap" style={{ marginTop: '1rem' }}>
                The SE treats each game as independent. Residuals cluster by game —
                players share a game&apos;s scoring environment — so over a window this
                short, read the mean as direction at best, not as a measurement.
              </p>

              <div className="tscroll" tabIndex={0} role="region" aria-label="Per-game residuals, scrollable">
                <table>
                  <thead>
                    <tr><th>Date</th><th>Matchup</th><th>Prop</th><th>Proj</th><th>Actual</th><th>Residual</th></tr>
                  </thead>
                  <tbody>
                    {residuals.map((r) => (
                      <tr key={`${r.gameDate}-${r.propType}`}>
                        <td>{r.gameDate}</td>
                        <td>{r.matchup ?? '—'}</td>
                        <td><PropLabel prop={r.propType} /></td>
                        <td className="num">{r.projMean.toFixed(2)}</td>
                        <td className="num">
                          {r.played ? r.actual.toFixed(0) : <span className="dnp">DNP</span>}
                        </td>
                        <td className="num">
                          {r.played ? signed(r.residual, 2) : <span className="dnp">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="cap" style={{ marginTop: '1rem' }}>
                DNP means the player was projected and appeared on the roster but
                never batted or faced a hitter. Those rows are shown because a
                projection for a player who did not play is a real defect in
                expected plate appearances — but they are excluded from the means
                above, where they would measure roster churn rather than the model.
              </p>
            </>
          )}
        </section>
      )}
    </main>
  );
}
