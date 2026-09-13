import Link from 'next/link';
import {
  teamEvalMarkets, teamBacktestSummary, teamReliability, teamResolution, MIN_GAMES,
  type BacktestSummary, type ReliabilityBucket, type ResolutionCheck, type ResolutionVerdict,
} from '@mlb-edge/db';
import { ReliabilityPlot } from '../_components/ReliabilityPlot';

export const dynamic = 'force-dynamic';

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const signed = (v: number, d = 4) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

// Exact strings, shared with the CLI report (backtest/teamReport.ts). These are
// not display copy to be softened: INDISTINGUISHABLE is the default verdict and
// WORSE keeps its loud marker. See CLAUDE.md.
const VERDICT_TEXT: Record<ResolutionVerdict, string> = {
  beats: 'BEATS THE BASE RATE',
  worse: 'WORSE THAN THE BASE RATE',
  indistinguishable: 'INDISTINGUISHABLE FROM THE BASE RATE',
  insufficient: 'INSUFFICIENT DATA',
};

interface MarketRow {
  market: string;
  summary: BacktestSummary;
  buckets: ReliabilityBucket[];
  resolution: ResolutionCheck;
}

async function load() {
  try {
    const markets = await teamEvalMarkets();
    const rows: MarketRow[] = await Promise.all(
      markets.map(async (market) => {
        const [summary, buckets, resolution] = await Promise.all([
          teamBacktestSummary(market),
          teamReliability(10, market),
          teamResolution(market),
        ]);
        return { market, summary, buckets, resolution };
      }),
    );
    return { ok: true as const, rows };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

// The baseline description, ported from the CLI report. With one line the pooled
// base rate IS that line's rate, so it can be named. With several, naming one
// pooled percentage would misdescribe what the baseline actually used.
function basisText(r: ResolutionCheck): string {
  if (r.baseRate == null) return 'no evaluations';
  if (r.lines === 1) return `predicting the ${pct(r.baseRate)} base rate for every game`;
  if (r.baseRateLo == null || r.baseRateHi == null) {
    return `predicting each line's own hit rate; ${r.lines} lines`;
  }
  return `predicting each line's own hit rate; ${r.lines} lines, ${pct(r.baseRateLo)}–${pct(r.baseRateHi)}`;
}

// The headline is DERIVED, never hardcoded: if a future re-measurement moves a
// market, the banner has to move with it rather than keep asserting today's
// finding.
function Banner({ rows }: { rows: MarketRow[] }) {
  const beats = rows.filter((r) => r.resolution.verdict === 'beats').map((r) => r.market);
  const worse = rows.filter((r) => r.resolution.verdict === 'worse').map((r) => r.market);
  const games = Math.max(...rows.map((r) => r.resolution.games));

  const tone = beats.length > 0 ? 'watch' : 'bad';
  const headline =
    beats.length > 0
      ? `${beats.join(', ')} beats its baseline — treat as a hypothesis, not a green light`
      : 'No market shows measurable resolution';

  return (
    <section className={`banner ${tone}`}>
      <p className="banner-eyebrow">Resolution check · {games.toLocaleString()} games</p>
      <h2 className="banner-headline">{headline}</h2>
      <p className="banner-body">
        {beats.length > 0 ? (
          <>
            A market clearing its baseline is the beginning of a measurement, not the end
            of one. Re-test it on a date range the league constants were not fitted on
            before treating it as information.
          </>
        ) : (
          <>
            Against a baseline that predicts each candidate line&apos;s own hit rate, this
            model carries no measurable information{' '}
            {worse.length > 0 ? (
              <>
                — and on {worse.join(', ')} it is significantly <strong>worse</strong> than
                that baseline.
              </>
            ) : (
              <>on any market.</>
            )}{' '}
            The probabilities below are calibrated, which is a different and much weaker
            claim. <strong>Nothing here is a betting signal</strong>, which is why this
            model has no pricing or closing-line path.
          </>
        )}
      </p>
    </section>
  );
}

function VerdictPill({ verdict }: { verdict: ResolutionVerdict }) {
  const tone =
    verdict === 'worse' ? 'bad' : verdict === 'beats' ? 'good' : 'flat';
  return (
    <span className={`pill ${tone}`}>
      {VERDICT_TEXT[verdict]}
      {verdict === 'worse' && <span className="pill-mark"> &lt;&lt;&lt;</span>}
    </span>
  );
}

function Market({ row }: { row: MarketRow }) {
  const { market, summary, buckets, resolution: r } = row;
  const hasInterval = r.ciLo != null && r.ciHi != null && r.advantage != null;

  return (
    <section className="market">
      <div className="market-head">
        <h2>{market}</h2>
        <VerdictPill verdict={r.verdict} />
      </div>
      <p className="cap">
        {summary.n.toLocaleString()} evaluations across {r.games.toLocaleString()} games.
        {r.lines > 1 && ` One game contributes up to ${r.lines} evaluations, so the interval is clustered by game.`}
      </p>

      <div className="scorecard">
        <div className="readout">
          <p className="label">Advantage over baseline</p>
          <p className={`value num ${r.advantage == null ? '' : r.verdict === 'worse' ? 'bad' : r.verdict === 'beats' ? 'good' : ''}`}>
            {r.advantage == null ? '—' : signed(r.advantage)}
          </p>
          <p className="verdict num">
            {hasInterval
              ? `95% CI [${signed(r.ciLo!)}, ${signed(r.ciHi!)}]`
              : `needs ${MIN_GAMES}+ games and a non-zero baseline`}
          </p>
        </div>
        <div className="readout">
          <p className="label">Skill score</p>
          <p className="value num">{r.skillScore == null ? '—' : signed(r.skillScore * 100, 1)}%</p>
          <p className="verdict">advantage / base-rate Brier</p>
        </div>
        <div className="readout">
          <p className="label">Calibration (ECE)</p>
          <p className="value num">{summary.ece == null ? '—' : pct(summary.ece, 2)}</p>
          <p className="verdict">not a measure of information</p>
        </div>
      </div>

      <table className="stats">
        <tbody>
          <tr>
            <td>Model Brier</td>
            <td className="num">{r.modelBrier == null ? '—' : r.modelBrier.toFixed(4)}</td>
          </tr>
          <tr>
            <td>Base-rate Brier</td>
            <td className="num">{r.baseRateBrier == null ? '—' : r.baseRateBrier.toFixed(4)}</td>
          </tr>
          <tr>
            <td>Baseline</td>
            <td>{basisText(r)}</td>
          </tr>
        </tbody>
      </table>

      <div className="plot-frame"><ReliabilityPlot buckets={buckets} /></div>
      <p className="cap">
        Predicted vs actual against the perfect-calibration diagonal. Points below the
        line mean the model claims more than it delivers.
      </p>

      <details className="buckets">
        <summary>Reliability buckets ({buckets.length})</summary>
        <table>
          <thead>
            <tr><th>Bucket</th><th>n</th><th>Predicted</th><th>Actual</th><th>Gap</th></tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={`${b.lo}-${b.hi}`}>
                <td>{b.lo.toFixed(1)}–{b.hi.toFixed(1)}</td>
                <td className="num">{b.n.toLocaleString()}</td>
                <td className="num">{b.predicted.toFixed(3)}</td>
                <td className="num">{b.actual.toFixed(3)}</td>
                <td className={`num ${Math.abs(b.gap) < 0.03 ? 'good' : 'bad'}`}>{signed(b.gap, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

export default async function TeamPage() {
  const d = await load();

  return (
    <main className="wrap">
      <header className="masthead">
        <h1 className="wordmark">
          <Link href="/">mlb-edge</Link> <span>/ game-outcome model</span>
        </h1>
        <p className="purpose">
          Does the game model know anything the base rate does not? Calibration is the
          easy half of that question and the answer below turns on the other half.
        </p>
      </header>

      {!d.ok ? (
        <section className="notice">
          <h2>Can&apos;t reach the database</h2>
          <p>Start Postgres and apply migrations, then reload. Error: {d.error}</p>
          <code>{`docker compose up -d\nnpm run db:migrate`}</code>
        </section>
      ) : d.rows.length === 0 ? (
        <section className="notice">
          <h2>No team evaluations yet</h2>
          <p>
            Project team run distributions over a date range and evaluate them against
            actual outcomes, then reload.
          </p>
          <code>{`npm run team-backfill -- --from 2026-04-01 --to 2026-09-01`}</code>
        </section>
      ) : (
        <>
          <Banner rows={d.rows} />
          {d.rows.map((row) => <Market key={row.market} row={row} />)}

          <section className="readme">
            <h2>How to read this</h2>
            <ul>
              <li>
                <strong>ECE measures calibration, not resolution.</strong> Calibration asks
                whether predicted probabilities match observed frequencies. Resolution asks
                whether the model separates likely games from unlikely ones. A model that
                always predicts each candidate line&apos;s own base rate scores a fine ECE
                while carrying zero information. The base-rate Brier is that
                no-information baseline.
              </li>
              <li>
                <strong>The baseline is per line, not per market.</strong> A market&apos;s
                evaluations span several candidate lines with very different base rates
                (run_line −1.5 hits 64.2%, +1.5 hits 36.6%), and the model is told which
                line it is pricing. Pooling would credit the model for merely knowing which
                line it is pricing: pooled <code>r(1−r) = E[r_k(1−r_k)] + Var(r_k)</code>,
                and that <code>Var(r_k)</code> term is line identity, not skill.
                <br />
                NB <code>line</code> is a threshold on the <em>home margin</em>{' '}
                (hit = margin &gt; line), so −1.5 means &ldquo;home wins by more than
                −1.5&rdquo;, i.e. home +1.5 — not the betting-convention reading where −1.5
                is the favourite. <code>Var(r_k)</code> does not depend on which side is
                which, so nothing above is affected by the labelling.
              </li>
              <li>
                <strong>The verdict is a significance test, not a sign test.</strong> The
                interval is clustered by game — one game contributes up to 4 evaluations
                (one per candidate line) scored against a single realized outcome, so
                treating them as independent would overstate precision. INDISTINGUISHABLE
                is the <em>default</em>, not a soft pass: it means the data cannot tell the
                market apart from guessing the base rate. Both BEATS and WORSE have to be
                earned.
              </li>
              <li>
                <strong>The two run distributions are convolved as independent</strong>,
                which they are not — a home team leading after 8.5 innings does not bat
                again. This biases the model in a known direction and is the largest v0
                approximation.
              </li>
              <li>
                <strong>Park factors are neutral and bullpens are league-average.</strong>{' '}
                Systematic gaps in the totals market are where those two assumptions would
                show up first.
              </li>
              <li>
                <strong>~160 games per team-season is far less signal than per-PA props</strong>,
                which have thousands of events. A worse ECE than the prop model is expected
                and is not a failure. The bar here is calibrated, not sharp.
              </li>
              <li>
                <strong>Multiplicity is documented, not corrected.</strong> Three markets
                are tested. Each is pre-registered to be compared against <em>itself</em>{' '}
                over time, and a Bonferroni bar of t ≈ 2.39 would change no verdict at
                present. If a market ever lands just past the threshold, treat that as a
                hypothesis to re-test on a different date range, not a finding.
              </li>
              <li>
                <strong>The league constants are fitted in-sample.</strong> The dispersion
                and league-rate constants were measured over essentially this same
                population, so the calibration figures are optimistic by an unmeasured
                amount. Any calibration claim needs a date range they were not fitted on.
              </li>
            </ul>
            <p className="cap">
              These are the game model&apos;s numbers only. Never read them against the prop
              model&apos;s — different model, different population.{' '}
              <Link href="/">Prop model readout →</Link>
            </p>
          </section>
        </>
      )}
    </main>
  );
}
