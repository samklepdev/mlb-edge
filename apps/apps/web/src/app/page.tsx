import {
  getScorecard,
  clvByProp,
  calibrationBuckets,
  type CalibrationBucket,
  type ClvRow,
  type Scorecard,
} from '@mlb-edge/db';

// Reads Postgres per-request; never prerender at build time.
export const dynamic = 'force-dynamic';

type Loaded =
  | { ok: true; scorecard: Scorecard; clv: ClvRow[]; buckets: CalibrationBucket[] }
  | { ok: false; error: string };

async function load(): Promise<Loaded> {
  try {
    const [scorecard, clv, buckets] = await Promise.all([
      getScorecard(),
      clvByProp(),
      calibrationBuckets(10),
    ]);
    return { ok: true, scorecard, clv, buckets };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const signed = (v: number, digits = 3) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;

function eceVerdict(ece: number): string {
  if (ece < 0.02) return 'well calibrated — actual tracks predicted';
  if (ece < 0.05) return 'slightly overconfident — small but real gap';
  return 'overconfident — the model claims more than it delivers';
}

function ReliabilityPlot({ buckets }: { buckets: CalibrationBucket[] }) {
  const S = 460;
  const pad = 46;
  const x = (v: number) => pad + v * (S - 2 * pad);
  const y = (v: number) => S - pad - v * (S - 2 * pad);
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label="Reliability diagram: predicted vs actual win rate">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} y1={y(0)} x2={x(t)} y2={y(1)} stroke="var(--grid)" strokeWidth={1} />
          <line x1={x(0)} y1={y(t)} x2={x(1)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
          <text x={x(t)} y={y(0) + 18} textAnchor="middle" fontSize={11} fill="var(--faint)" className="num">
            {t.toFixed(2)}
          </text>
          <text x={x(0) - 10} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--faint)" className="num">
            {t.toFixed(2)}
          </text>
        </g>
      ))}

      {/* perfect-calibration reference */}
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--ref)" strokeWidth={1.5} strokeDasharray="4 4" />

      {/* bucket points: radius ~ sample size, color ~ gap magnitude */}
      {buckets.map((b) => {
        const r = 4 + Math.min(9, Math.sqrt(b.n) * 1.2);
        const color = Math.abs(b.gap) < 0.03 ? 'var(--good)' : 'var(--bad)';
        return (
          <g key={`${b.lo}-${b.hi}`}>
            <line x1={x(b.predicted)} y1={y(b.predicted)} x2={x(b.predicted)} y2={y(b.actual)} stroke={color} strokeWidth={1} opacity={0.5} />
            <circle cx={x(b.predicted)} cy={y(b.actual)} r={r} fill={color} fillOpacity={0.18} stroke={color} strokeWidth={1.5} />
          </g>
        );
      })}

      <text x={x(0.5)} y={S - 8} textAnchor="middle" fontSize={12} fill="var(--muted)">
        predicted win rate
      </text>
      <text x={14} y={y(0.5)} textAnchor="middle" fontSize={12} fill="var(--muted)" transform={`rotate(-90 14 ${y(0.5)})`}>
        actual win rate
      </text>
    </svg>
  );
}

export default async function Page() {
  const data = await load();

  return (
    <main className="wrap">
      <header className="masthead">
        <h1 className="wordmark">
          mlb-edge <span>/ model readout</span>
        </h1>
        <p className="purpose">
          Is the model calibrated, and is it beating the closing line? Those two
          answers decide whether an edge is real. Everything else is noise.
        </p>
      </header>

      {!data.ok ? (
        <section className="notice">
          <h2>Can&apos;t reach the database</h2>
          <p>
            The dashboard reads Postgres directly. Start it and apply migrations,
            then reload. Reported error: {data.error}
          </p>
          <code>{`docker compose up -d\nnpm run db:migrate`}</code>
        </section>
      ) : data.scorecard.settledPicks === 0 ? (
        <section className="notice">
          <h2>No settled picks yet</h2>
          <p>
            Once you log picks and settle their results, calibration and CLV land
            here. To see the readout working now, seed synthetic demo data:
          </p>
          <code>{`npm run seed:demo\n# then reload this page`}</code>
        </section>
      ) : (
        <>
          <section className="scorecard">
            <Readout
              label="Avg closing line value"
              value={data.scorecard.avgClv == null ? '—' : signed(data.scorecard.avgClv)}
              tone={clvTone(data.scorecard.avgClv)}
              verdict={
                data.scorecard.avgClv == null
                  ? 'no closing lines captured yet'
                  : data.scorecard.avgClv > 0
                    ? 'market moved toward your picks'
                    : 'no closing-line edge yet'
              }
            />
            <Readout
              label="Calibration error (ECE)"
              value={data.scorecard.ece == null ? '—' : pct(data.scorecard.ece)}
              tone={eceTone(data.scorecard.ece)}
              verdict={data.scorecard.ece == null ? '—' : eceVerdict(data.scorecard.ece)}
            />
            <Readout
              label="Settled picks"
              value={<span className="num">{data.scorecard.settledPicks}</span>}
              verdict={`${data.scorecard.picksWithClose} with a closing line`}
            />
          </section>

          <section className="plot">
            <h2>Reliability</h2>
            <p className="cap">
              Each point is a probability bucket: where the model said, the more
              a point sits below the dashed line, the more the model overrated
              those picks. Teal is on target; red is a gap worth explaining.
            </p>
            <div className="plot-frame">
              <ReliabilityPlot buckets={data.buckets} />
            </div>
          </section>

          <section className="clv">
            <h2>Closing line value by prop</h2>
            <table>
              <thead>
                <tr>
                  <th>Prop</th>
                  <th>n</th>
                  <th>Avg CLV</th>
                  <th>Hit rate</th>
                </tr>
              </thead>
              <tbody>
                {data.clv.map((r) => (
                  <tr key={r.propType}>
                    <td>{r.propType}</td>
                    <td className="num">{r.n}</td>
                    <td className={`num ${r.avgClv != null && r.avgClv > 0 ? 'good' : 'bad'}`}>
                      {r.avgClv == null ? '—' : signed(r.avgClv)}
                    </td>
                    <td className="num">{r.hitRate == null ? '—' : pct(r.hitRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}

function clvTone(v: number | null): 'good' | 'bad' | undefined {
  if (v == null) return undefined;
  return v > 0 ? 'good' : 'bad';
}
function eceTone(v: number | null): 'good' | 'bad' | undefined {
  if (v == null) return undefined;
  return v < 0.02 ? 'good' : v >= 0.05 ? 'bad' : undefined;
}

function Readout({
  label,
  value,
  verdict,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  verdict: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <div className="readout">
      <p className="label">{label}</p>
      <div className={`value num${tone ? ` ${tone}` : ''}`}>{value}</div>
      <p className="verdict">{verdict}</p>
    </div>
  );
}
