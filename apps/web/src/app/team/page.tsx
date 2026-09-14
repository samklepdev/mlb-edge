import Link from 'next/link';
import {
  teamEvalMarkets, teamBacktestSummary, teamReliability, teamResolution,
  teamEvalVersions, teamEvalDateRange, MIN_GAMES,
  type BacktestSummary, type ReliabilityBucket, type ResolutionCheck,
  type ResolutionVerdict, type TeamEvalFilter,
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
const VERDICT_SHORT: Record<ResolutionVerdict, string> = {
  beats: 'BEATS',
  worse: 'WORSE',
  indistinguishable: 'INDISTINGUISHABLE',
  insufficient: 'INSUFFICIENT',
};

interface MarketRow {
  market: string;
  summary: BacktestSummary;
  buckets: ReliabilityBucket[];
  resolution: ResolutionCheck;
}
interface ScopeResult {
  filter: TeamEvalFilter;
  label: string;
  span: { from: string; to: string } | null;
  rows: MarketRow[];
}

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
};

function readScope(sp: SP, p: 'a' | 'b'): TeamEvalFilter | null {
  const f: TeamEvalFilter = {
    version: one(sp[`${p}Version`]),
    from: one(sp[`${p}From`]),
    to: one(sp[`${p}To`]),
  };
  const any = f.version || f.from || f.to;
  // Scope A always exists (unfiltered = the whole evaluated set). Scope B only
  // exists when asked for, so the page stays a single readout by default rather
  // than inventing a comparison nobody requested.
  if (p === 'b' && !any) return null;
  return f;
}

function scopeLabel(f: TeamEvalFilter, span: { from: string; to: string } | null, fallbackVersion: string): string {
  const v = f.version ?? fallbackVersion;
  const dates = f.from || f.to ? (span ? `${span.from} → ${span.to}` : 'no games in range') : 'all dates';
  return `${v} · ${dates}`;
}

async function loadScope(filter: TeamEvalFilter, fallbackVersion: string): Promise<ScopeResult> {
  const [markets, span] = await Promise.all([teamEvalMarkets(filter), teamEvalDateRange(filter)]);
  const rows: MarketRow[] = await Promise.all(
    markets.map(async (market) => {
      const scope = { ...filter, market };
      const [summary, buckets, resolution] = await Promise.all([
        teamBacktestSummary(scope),
        teamReliability(10, scope),
        teamResolution(scope),
      ]);
      return { market, summary, buckets, resolution };
    }),
  );
  return { filter, label: scopeLabel(filter, span, fallbackVersion), span, rows };
}

async function load(sp: SP) {
  try {
    const versions = await teamEvalVersions();
    if (versions.length === 0) return { ok: true as const, versions, a: null, b: null, full: null };
    const latest = versions[versions.length - 1];
    const full = await teamEvalDateRange({});
    const aFilter = readScope(sp, 'a')!;
    const bFilter = readScope(sp, 'b');
    const [a, b] = await Promise.all([
      loadScope(aFilter, latest),
      bFilter ? loadScope(bFilter, latest) : Promise.resolve(null),
    ]);
    return { ok: true as const, versions, a, b, full };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

// Midpoint of the evaluated span, so the "compare halves" preset splits on real
// data rather than a hardcoded date.
function midpoint(from: string, to: string): string {
  const mid = new Date((Date.parse(from) + Date.parse(to)) / 2);
  return mid.toISOString().slice(0, 10);
}

// Both date bounds are INCLUSIVE, so the second half has to start the day after
// the first one ends. Reusing the midpoint for both would put every game on that
// date in both scopes -- 15 games here, silently counted twice.
function dayAfter(d: string): string {
  return new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10);
}

function ScopeForm({ versions, sp, full }: { versions: string[]; sp: SP; full: { from: string; to: string } | null }) {
  const val = (k: string) => one(sp[k]) ?? '';
  return (
    <form className="scope-form" method="get">
      {(['a', 'b'] as const).map((p) => (
        <fieldset key={p} className="scope-field">
          <legend>{p === 'a' ? 'Scope A' : 'Scope B (optional)'}</legend>
          <label>
            <span>version</span>
            <select name={`${p}Version`} defaultValue={val(`${p}Version`)}>
              <option value="">latest</option>
              {versions.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label>
            <span>from</span>
            <input type="date" name={`${p}From`} defaultValue={val(`${p}From`)} />
          </label>
          <label>
            <span>to</span>
            <input type="date" name={`${p}To`} defaultValue={val(`${p}To`)} />
          </label>
        </fieldset>
      ))}
      <div className="scope-actions">
        <button type="submit">Apply</button>
        <Link href="/team">Reset</Link>
        {full && (
          <Link
            href={`/team?aFrom=${full.from}&aTo=${midpoint(full.from, full.to)}&bFrom=${dayAfter(midpoint(full.from, full.to))}&bTo=${full.to}`}
          >
            Compare halves
          </Link>
        )}
        {versions.length > 1 && (
          <Link href={`/team?aVersion=${versions[versions.length - 2]}&bVersion=${versions[versions.length - 1]}`}>
            Compare latest two versions
          </Link>
        )}
      </div>
    </form>
  );
}

function VerdictPill({ verdict, short = false }: { verdict: ResolutionVerdict; short?: boolean }) {
  const tone = verdict === 'worse' ? 'bad' : verdict === 'beats' ? 'good' : 'flat';
  return (
    <span className={`pill ${tone}`}>
      {short ? VERDICT_SHORT[verdict] : VERDICT_TEXT[verdict]}
      {verdict === 'worse' && <span className="pill-mark"> &lt;&lt;&lt;</span>}
    </span>
  );
}

// The headline is DERIVED, never hardcoded: if a re-measurement moves a market,
// the banner has to move with it rather than keep asserting today's finding.
function Banner({ rows, label }: { rows: MarketRow[]; label: string }) {
  const beats = rows.filter((r) => r.resolution.verdict === 'beats').map((r) => r.market);
  const worse = rows.filter((r) => r.resolution.verdict === 'worse').map((r) => r.market);
  const games = rows.length ? Math.max(...rows.map((r) => r.resolution.games)) : 0;

  return (
    <section className={`banner ${beats.length > 0 ? 'watch' : 'bad'}`}>
      <p className="banner-eyebrow">Resolution check · {label} · {games.toLocaleString()} games</p>
      <h2 className="banner-headline">
        {beats.length > 0
          ? `${beats.join(', ')} beats its baseline — a hypothesis, not a green light`
          : 'No market shows measurable resolution'}
      </h2>
      <p className="banner-body">
        {beats.length > 0 ? (
          <>
            A market clearing its baseline in one window is the beginning of a measurement.
            Re-test it on a range the league constants were not fitted on before treating
            it as information.
          </>
        ) : (
          <>
            Against a baseline that predicts each candidate line&apos;s own hit rate, this
            model carries no measurable information{' '}
            {worse.length > 0 ? (
              <>— and on {worse.join(', ')} it is significantly <strong>worse</strong> than that baseline.</>
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

function Comparison({ a, b }: { a: ScopeResult; b: ScopeResult }) {
  const markets = Array.from(new Set([...a.rows.map((r) => r.market), ...b.rows.map((r) => r.market)]));
  const find = (s: ScopeResult, m: string) => s.rows.find((r) => r.market === m);
  const samePeriod = a.filter.from === b.filter.from && a.filter.to === b.filter.to;

  return (
    <section className="compare">
      <h2>A vs B</h2>
      <p className="cap">
        A = {a.label} · B = {b.label}
      </p>
      <table>
        <thead>
          <tr>
            <th>Market</th>
            <th>A advantage</th>
            <th>A verdict</th>
            <th>B advantage</th>
            <th>B verdict</th>
            <th>Δ (B − A)</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m) => {
            const ra = find(a, m)?.resolution;
            const rb = find(b, m)?.resolution;
            const delta = ra?.advantage != null && rb?.advantage != null ? rb.advantage - ra.advantage : null;
            return (
              <tr key={m}>
                <td>{m}</td>
                <td className="num">{ra?.advantage == null ? '—' : signed(ra.advantage)}</td>
                <td>{ra ? <VerdictPill verdict={ra.verdict} short /> : '—'}</td>
                <td className="num">{rb?.advantage == null ? '—' : signed(rb.advantage)}</td>
                <td>{rb ? <VerdictPill verdict={rb.verdict} short /> : '—'}</td>
                <td className="num">{delta == null ? '—' : signed(delta)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="warn">
        <strong>Δ has no confidence interval, deliberately.</strong>{' '}
        {samePeriod ? (
          <>
            These two scopes cover the same games, so the two advantage estimates are
            <em> paired</em> and strongly correlated. Differencing them and reusing either
            interval would badly understate the uncertainty.
          </>
        ) : (
          <>
            These scopes cover different games, so the estimates are independent — but the
            difference still carries the uncertainty of both, and each scope is a smaller
            sample than the full set.
          </>
        )}{' '}
        Testing whether a Δ is real needs a paired significance test that this codebase
        does not have. Read each scope&apos;s own verdict, and treat a Δ as a hypothesis to
        re-test — not as evidence that a change helped.
      </p>
    </section>
  );
}

function Market({ row }: { row: MarketRow }) {
  const { market, summary, buckets, resolution: r } = row;
  const hasInterval = r.ciLo != null && r.ciHi != null && r.advantage != null;
  const basis =
    r.baseRate == null
      ? 'no evaluations'
      : r.lines === 1
        ? `predicting the ${pct(r.baseRate)} base rate for every game`
        : r.baseRateLo == null || r.baseRateHi == null
          ? `predicting each line's own hit rate; ${r.lines} lines`
          : `predicting each line's own hit rate; ${r.lines} lines, ${pct(r.baseRateLo)}–${pct(r.baseRateHi)}`;

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
            {hasInterval ? `95% CI [${signed(r.ciLo!)}, ${signed(r.ciHi!)}]` : `needs ${MIN_GAMES}+ games and a non-zero baseline`}
          </p>
        </div>
        <div className="readout">
          <p className="label">Skill score</p>
          <p className="value num">{r.skillScore == null ? '—' : `${signed(r.skillScore * 100, 1)}%`}</p>
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
          <tr><td>Model Brier</td><td className="num">{r.modelBrier == null ? '—' : r.modelBrier.toFixed(4)}</td></tr>
          <tr><td>Base-rate Brier</td><td className="num">{r.baseRateBrier == null ? '—' : r.baseRateBrier.toFixed(4)}</td></tr>
          <tr><td>Baseline</td><td>{basis}</td></tr>
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
          <thead><tr><th>Bucket</th><th>n</th><th>Predicted</th><th>Actual</th><th>Gap</th></tr></thead>
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

export default async function TeamPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const d = await load(sp);

  if (!d.ok) {
    return (
      <main className="wrap">
        <section className="notice">
          <h2>Can&apos;t reach the database</h2>
          <p>Start Postgres and apply migrations, then reload. Error: {d.error}</p>
          <code>{`docker compose up -d\nnpm run db:migrate`}</code>
        </section>
      </main>
    );
  }

  return (
    <main className="wrap">
      <header className="masthead">
        <h1 className="wordmark">
          <Link href="/">mlb-edge</Link> <span>/ game-outcome model</span>
        </h1>
        <p className="purpose">
          Does the game model know anything the base rate does not? Scope a version and a
          date range, or set a second scope to compare two.
        </p>
      </header>

      {!d.a || d.versions.length === 0 ? (
        <section className="notice">
          <h2>No team evaluations yet</h2>
          <p>Project team run distributions over a date range and evaluate them against actual outcomes, then reload.</p>
          <code>{`npm run team-backfill -- --from 2026-04-01 --to 2026-09-01`}</code>
        </section>
      ) : (
        <>
          <ScopeForm versions={d.versions} sp={sp} full={d.full} />

          {d.a.rows.length === 0 ? (
            <section className="notice">
              <h2>No evaluations in scope A</h2>
              <p>Nothing matches {d.a.label}. Widen the range or pick another version.</p>
            </section>
          ) : (
            <>
              <Banner rows={d.a.rows} label={d.a.label} />
              {d.b && (d.b.rows.length > 0
                ? <Comparison a={d.a} b={d.b} />
                : (
                  <section className="notice">
                    <h2>No evaluations in scope B</h2>
                    <p>Nothing matches {d.b.label}, so there is nothing to compare against.</p>
                  </section>
                ))}
              {d.a.rows.map((row) => <Market key={row.market} row={row} />)}
            </>
          )}

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
                is the favourite.
              </li>
              <li>
                <strong>The baseline is re-estimated inside whatever scope you pick.</strong>{' '}
                A date-filtered figure compares the model against <em>that range&apos;s</em>{' '}
                per-line hit rates. That is the honest comparison, but narrower windows mean
                each rate comes from fewer games, so the numbers get noisier faster than the
                sample count suggests.
              </li>
              <li>
                <strong>The verdict is a significance test, not a sign test.</strong> The
                interval is clustered by game — one game contributes up to 4 evaluations
                scored against a single realized outcome. INDISTINGUISHABLE is the{' '}
                <em>default</em>, not a soft pass. Both BEATS and WORSE have to be earned.
              </li>
              <li>
                <strong>Slicing dates is a multiple-comparisons machine.</strong> Enough
                windows and one will clear the bar by chance. A verdict that appears in one
                slice and not another is a hypothesis; the intervals here are not corrected
                for how many slices you tried.
              </li>
              <li>
                <strong>The two run distributions are convolved as independent</strong>,
                which they are not — a home team leading after 8.5 innings does not bat
                again. This is the largest v0 approximation.
              </li>
              <li>
                <strong>Park factors are neutral and bullpens are league-average.</strong>{' '}
                Systematic gaps in the totals market are where those two assumptions would
                show up first.
              </li>
              <li>
                <strong>The league constants were fitted in-sample</strong>, over
                essentially the same games the default scope evaluates. That is what the
                date filter is for: a range the constants were not fitted on is the only
                place a calibration figure means much.
              </li>
            </ul>
            <p className="cap">
              Game model figures only. Never read them against the prop model&apos;s —
              different model, different population. <Link href="/">Prop model readout →</Link>
            </p>
          </section>
        </>
      )}
    </main>
  );
}
