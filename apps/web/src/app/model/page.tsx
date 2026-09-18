import Link from 'next/link';
import {
  getScorecard, clvByProp, calibrationBuckets,
  backtestSummary, projectionReliability, evalPropTypes,
  type ClvRow,
} from '@mlb-edge/db';
import { ReliabilityPlot } from '../_components/ReliabilityPlot';
import { PropLabel } from '../_components/PropLabel';
import { Masthead } from '../_components/Masthead';

export const dynamic = 'force-dynamic';

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const signed = (v: number, d = 3) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

// Everything that answers "is the model any good?", split out from the slate.
// The two questions are genuinely separate: `/` is what is on today, this is
// whether anything here deserves to be believed. Nothing on this page depends
// on a slate date.
async function load() {
  try {
    const evalProps = await evalPropTypes();
    const [scorecard, clv, calib, bt, btBuckets, btByProp] = await Promise.all([
      getScorecard(),
      clvByProp(),
      calibrationBuckets(10),
      backtestSummary(),
      projectionReliability(10),
      // Per-prop is the figure that actually means something; the pooled one
      // mixes props with different base rates. See backtestReport for the why.
      Promise.all(evalProps.map(async (prop) => ({ prop, ...(await backtestSummary(prop)) }))),
    ]);
    return { ok: true as const, scorecard, clv, calib, bt, btBuckets, btByProp };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

export default async function ModelPage() {
  const d = await load();

  return (
    <main className="wrap">
      <Masthead section="model" />

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
                <div className="tscroll" tabIndex={0} role="region" aria-label="Model calibration by prop, scrollable">
                  <table>
                    <thead>
                      <tr><th>Prop</th><th>Evaluations</th><th>ECE</th><th>Brier</th></tr>
                    </thead>
                    <tbody>
                      {d.btByProp.map((b) => (
                        <tr key={b.prop}>
                          <td><PropLabel prop={b.prop} /></td>
                          <td className="num">{b.n.toLocaleString()}</td>
                          <td className="num">{b.ece == null ? '—' : pct(b.ece)}</td>
                          <td className="num">{b.brier == null ? '—' : b.brier.toFixed(3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="cap" style={{ marginTop: '1rem' }}>
                  Read each prop against itself over time — never against another prop. A low
                  ECE on a rare event (home runs) mostly reflects the base rate, not skill; and
                  hits at 0.5 is the same event as total bases at 0.5, so those two rows are one
                  piece of evidence, not two.
                </p>
                <div className="plot-frame"><ReliabilityPlot buckets={d.btBuckets} /></div>
                <p className="cap">
                  Curve pools all {d.bt.n.toLocaleString()} evaluations across {d.btByProp.length} props
                  (ECE {d.bt.ece == null ? '—' : pct(d.bt.ece)}), so it is not comparable to the
                  two-prop v0.1/v0.2 figures. Points below the diagonal mean the model claims
                  more than it delivers.
                </p>
              </>
            )}
          </section>

          {/* --- settled real picks: CLV + market reliability (only when present) --- */}
          {d.scorecard.settledPicks === 0 && d.scorecard.syntheticSettled > 0 && (
            <section className="notice">
              <h2>No real settled picks yet</h2>
              <p>
                The {d.scorecard.syntheticSettled} settled picks in this database are demo
                seed data, and are deliberately excluded from CLV and calibration — they
                carry invented results and would report an edge that does not exist.{' '}
                {d.scorecard.picksWithClose > 0
                  ? 'CLV below is real: it reflects captured closing lines on real picks.'
                  : 'CLV needs a captured closing line on real picks — it will appear below once the lines pull and lines capture steps have run for a slate.'}
                {' '}Calibration and hit rates need more — they wait on settlement, once the games are final.
              </p>
            </section>
          )}
          {(d.scorecard.picksWithClose > 0 || d.scorecard.settledPicks > 0) && (
            <section className="scorecard">
              <Readout label="Avg closing line value"
                value={d.scorecard.avgClv == null ? '—' : signed(d.scorecard.avgClv)}
                verdict={d.scorecard.avgClv == null
                  ? 'no closing lines yet'
                  : `${d.scorecard.picksWithClose} picks across ${d.scorecard.clvGames} games — not yet a signal; picks cluster by slate, so the effective sample is far smaller than the pick count`} />
              <Readout label="Pick calibration (ECE)"
                value={d.scorecard.ece == null ? '—' : pct(d.scorecard.ece)}
                tone={d.scorecard.ece == null ? undefined : d.scorecard.ece < 0.02 ? 'good' : d.scorecard.ece >= 0.05 ? 'bad' : undefined}
                verdict={d.scorecard.settledPicks === 0 ? 'needs settled picks' : 'settled picks vs outcomes'} />
              <Readout label="Settled picks"
                value={<span className="num">{d.scorecard.settledPicks}</span>}
                verdict={`${d.scorecard.picksWithClose} with a closing line` +
                  (d.scorecard.excludedClose > 0
                    ? ` (${d.scorecard.excludedClose} more have a close_line but were captured at or after` +
                      ' first pitch, or never timestamped, so are excluded here)'
                    : '')} />
            </section>
          )}
          {d.clv.length > 0 && (
            <section className="clv">
              <h2>Closing line value by prop</h2>
              <p className="cap">
                Not colored — n is too low per row to call a direction. Read the count
                alongside the number, not the number alone.
              </p>
              <div className="tscroll" tabIndex={0} role="region" aria-label="Closing line value by prop, scrollable">
                <table>
                  <thead><tr><th>Prop</th><th>n</th><th>Avg CLV</th><th>Hit rate</th></tr></thead>
                  <tbody>
                    {d.clv.map((r: ClvRow) => (
                      <tr key={r.propType}>
                        <td><PropLabel prop={r.propType} /></td>
                        <td className="num">{r.n}</td>
                        <td className="num">{r.avgClv == null ? '—' : signed(r.avgClv)}</td>
                        <td className="num">{r.hitRate == null ? '—' : pct(r.hitRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
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
