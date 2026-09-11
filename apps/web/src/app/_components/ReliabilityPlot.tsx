interface Bucket { lo: number; hi: number; n: number; predicted: number; actual: number; gap: number; }

// Predicted vs actual against the perfect-calibration diagonal.
export function ReliabilityPlot({ buckets }: { buckets: Bucket[] }) {
  const S = 460;
  const pad = 46;
  const x = (v: number) => pad + v * (S - 2 * pad);
  const y = (v: number) => S - pad - v * (S - 2 * pad);
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label="Reliability diagram">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} y1={y(0)} x2={x(t)} y2={y(1)} stroke="var(--grid)" strokeWidth={1} />
          <line x1={x(0)} y1={y(t)} x2={x(1)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
          <text x={x(t)} y={y(0) + 18} textAnchor="middle" fontSize={11} fill="var(--faint)" className="num">{t.toFixed(2)}</text>
          <text x={x(0) - 10} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--faint)" className="num">{t.toFixed(2)}</text>
        </g>
      ))}
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--ref)" strokeWidth={1.5} strokeDasharray="4 4" />
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
      <text x={x(0.5)} y={S - 8} textAnchor="middle" fontSize={12} fill="var(--muted)">predicted probability</text>
      <text x={14} y={y(0.5)} textAnchor="middle" fontSize={12} fill="var(--muted)" transform={`rotate(-90 14 ${y(0.5)})`}>actual rate</text>
    </svg>
  );
}
