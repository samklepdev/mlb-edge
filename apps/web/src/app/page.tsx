import Link from 'next/link';
import {
  getScorecard, clvByProp, calibrationBuckets,
  backtestSummary, projectionReliability,
  latestSlateDate, getSlateGames, getTopEdges, getSlateRoster,
  type ClvRow, type Scorecard,
} from '@mlb-edge/db';
import { ReliabilityPlot } from './_components/ReliabilityPlot';
import { RosterSearch } from './_components/RosterSearch';

export const dynamic = 'force-dynamic';

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const signed = (v: number, d = 3) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

async function load() {
  try {
    const slateDate = await latestSlateDate();
    const [scorecard, clv, calib, bt, btBuckets, games, edges, roster] = await Promise.all([
      getScorecard(),
      clvByProp(),
      calibrationBuckets(10),
      backtestSummary(),
      projectionReliability(10),
      slateDate ? getSlateGames(slateDate) : Promise.resolve([]),
      slateDate ? getTopEdges(slateDate, 25) : Promise.resolve([]),
      slateDate ? getSlateRoster(slateDate) : Promise.resolve([]),
    ]);
    return { ok: true as const, slateDate, scorecard, clv, calib, bt, btBuckets, games, edges, roster };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

export default async function Page() {
  const d = await load();

  return (
    <main className="wrap">
      <header className="masthead">
        <h1 className="wordmark">mlb-edge <span>/ model readout</span></h1>
        <p className="purpose">
          Is the model calibrated, and does it beat the closing line? Those two
          answers decide whether an edge is real. Everything else is noise.
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
          {/* --- model calibration backtest (from model_evals) --- */}
          <section className="plot">
            <h2>Model calibration</h2>
            {d.bt.n === 0 ? (
              <div className="notice">
                <p>No backtest yet — this is the honest first question: do the model&apos;s probabilities match reality?</p>
                <code>{`npm run backfill -- --from 2026-09-01 --to 2026-09-10`}</code>
              </div>
            ) : (
              <>
                <p className="cap">
                  {d.bt.n.toLocaleString()} evaluations · ECE {d.bt.ece == null ? '—' : pct(d.bt.ece)} ·
                  Brier {d.bt.brier == null ? '—' : d.bt.brier.toFixed(3)}. Points below the
                  diagonal mean the model claims more than it delivers.
                </p>
                <div className="plot-frame"><ReliabilityPlot buckets={d.btBuckets} /></div>
              </>
            )}
          </section>

          {/* --- today's slate: games + top edges --- */}
          {d.slateDate && (
            <section className="clv">
              <h2>Slate · {d.slateDate}</h2>
              {d.games.length === 0 ? (
                <p className="cap">No projected games. Run <code style={{ display: 'inline' }}>project --date {d.slateDate}</code>.</p>
              ) : (
                <p className="cap">{d.games.length} game(s): {d.games.map((g) => `${g.away} @ ${g.home}`).join(' · ')}</p>
              )}
              {d.edges.length > 0 && (
                <table>
                  <thead>
                    <tr><th>Player</th><th>Prop</th><th>Side</th><th>Line</th><th>Model</th><th>Edge</th></tr>
                  </thead>
                  <tbody>
                    {d.edges.map((e) => (
                      <tr key={`${e.playerId}-${e.propType}`}>
                        <td><Link href={`/player?id=${e.playerId}&date=${d.slateDate}`}>{e.playerName}</Link></td>
                        <td>{e.propType}</td>
                        <td>{e.side}</td>
                        <td className="num">{e.line}</td>
                        <td className="num">{pct(e.modelProb)}</td>
                        <td className="num good">{signed(e.edgePct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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

          {/* --- settled real picks: CLV + market reliability (only when present) --- */}
          {d.scorecard.settledPicks > 0 && (
            <>
              <section className="scorecard">
                <Readout label="Avg closing line value"
                  value={d.scorecard.avgClv == null ? '—' : signed(d.scorecard.avgClv)}
                  tone={d.scorecard.avgClv == null ? undefined : d.scorecard.avgClv > 0 ? 'good' : 'bad'}
                  verdict={d.scorecard.avgClv == null ? 'no closing lines yet' : d.scorecard.avgClv > 0 ? 'market moved toward your picks' : 'no closing-line edge yet'} />
                <Readout label="Pick calibration (ECE)"
                  value={d.scorecard.ece == null ? '—' : pct(d.scorecard.ece)}
                  tone={d.scorecard.ece == null ? undefined : d.scorecard.ece < 0.02 ? 'good' : d.scorecard.ece >= 0.05 ? 'bad' : undefined}
                  verdict="settled picks vs outcomes" />
                <Readout label="Settled picks"
                  value={<span className="num">{d.scorecard.settledPicks}</span>}
                  verdict={`${d.scorecard.picksWithClose} with a closing line`} />
              </section>
              {d.clv.length > 0 && (
                <section className="clv">
                  <h2>Closing line value by prop</h2>
                  <table>
                    <thead><tr><th>Prop</th><th>n</th><th>Avg CLV</th><th>Hit rate</th></tr></thead>
                    <tbody>
                      {d.clv.map((r: ClvRow) => (
                        <tr key={r.propType}>
                          <td>{r.propType}</td>
                          <td className="num">{r.n}</td>
                          <td className={`num ${r.avgClv != null && r.avgClv > 0 ? 'good' : 'bad'}`}>{r.avgClv == null ? '—' : signed(r.avgClv)}</td>
                          <td className="num">{r.hitRate == null ? '—' : pct(r.hitRate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}

function Readout({ label, value, verdict, tone }: { label: string; value: React.ReactNode; verdict: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="readout">
      <p className="label">{label}</p>
      <div className={`value num${tone ? ` ${tone}` : ''}`}>{value}</div>
      <p className="verdict">{verdict}</p>
    </div>
  );
}
