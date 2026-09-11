import { projectionReliability, backtestSummary } from '@mlb-edge/db';

export async function backtestReport(): Promise<void> {
  const summary = await backtestSummary();
  if (summary.n === 0) {
    console.log('No model evaluations yet. Run: npm run backfill -- --from <d> --to <d>');
    return;
  }
  const buckets = await projectionReliability(10);
  console.log(`model calibration backtest (${summary.n} evaluations)`);
  console.log(`  ECE   = ${summary.ece == null ? 'n/a' : summary.ece.toFixed(4)}  (lower is better; <0.02 good)`);
  console.log(`  Brier = ${summary.brier == null ? 'n/a' : summary.brier.toFixed(4)}  (lower is better)`);
  console.log('\nbucket       n    predicted  actual   gap');
  for (const b of buckets) {
    console.log(
      `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  ${String(b.n).padStart(5)}    ` +
        `${b.predicted.toFixed(3)}    ${b.actual.toFixed(3)}   ${b.gap >= 0 ? '+' : ''}${b.gap.toFixed(3)}`,
    );
  }
  console.log('\nWant: actual ~ predicted in every populated bucket. Below-diagonal = overconfident.');
}
