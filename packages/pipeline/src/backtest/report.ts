import { projectionReliability, backtestSummary, evalPropTypes } from '@mlb-edge/db';
import type { ReliabilityBucket, BacktestSummary } from '@mlb-edge/db';

function printBuckets(buckets: ReliabilityBucket[]): void {
  console.log('  bucket       n    predicted  actual   gap');
  for (const b of buckets) {
    console.log(
      `  ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  ${String(b.n).padStart(5)}    ` +
        `${b.predicted.toFixed(3)}    ${b.actual.toFixed(3)}   ${b.gap >= 0 ? '+' : ''}${b.gap.toFixed(3)}`,
    );
  }
}

function printSummaryLine(summary: BacktestSummary): void {
  console.log(`  ECE   = ${summary.ece == null ? 'n/a' : summary.ece.toFixed(4)}  (lower is better; <0.02 good)`);
  console.log(`  Brier = ${summary.brier == null ? 'n/a' : summary.brier.toFixed(4)}  (lower is better)`);
}

export async function backtestReport(): Promise<void> {
  const props = await evalPropTypes();
  if (props.length === 0) {
    console.log('No model evaluations yet. Run: npm run backfill -- --from <d> --to <d>');
    return;
  }

  console.log('model calibration backtest, BY PROP (this is the number that matters)');
  console.log('======================================================================');
  console.log(
    'Each prop is a different event with its own base rate and difficulty. Compare a prop\n' +
      'only against itself over time -- never against another prop, and never against the\n' +
      'pooled figure below.\n',
  );

  for (const prop of props) {
    const [summary, buckets] = await Promise.all([backtestSummary(prop), projectionReliability(10, prop)]);
    console.log(`-- ${prop} (${summary.n} evaluations) --`);
    printSummaryLine(summary);
    printBuckets(buckets);
    console.log('');
  }

  console.log('Interpretation traps in the numbers above:');
  console.log(
    '  * home_runs ECE looks great mostly because home runs are RARE. ECE measures\n' +
      '    calibration (predicted ~ actual), not resolution (separating true positives from\n' +
      "    negatives). Predicting everyone at the league HR base rate scores near-zero ECE\n" +
      '    by construction -- it is not evidence the model discriminates HR risk well.',
  );
  console.log(
    '  * hits@0.5 and total_bases@0.5 are NOT independent rows. A batter reaches base with\n' +
      '    >=1 total base iff they record >=1 hit, so at the 0.5 line these are the same\n' +
      '    underlying event scored twice. Do not read them as two confirmations.',
  );

  console.log('\n----------------------------------------------------------------------');
  console.log('POOLED (all props combined) -- NOT COMPARABLE across different prop mixes.');
  console.log(
    'The v0.1 (0.091) and v0.2 (0.028) historical ECE figures were computed over a\n' +
      'two-prop population (total_bases, strikeouts). This pooled figure spans four props\n' +
      'with very different base rates and sample sizes, so it is not a like-for-like\n' +
      'successor to those numbers and must not be compared against them. It is printed\n' +
      'only for total row-count bookkeeping, not as a calibration signal.',
  );
  const pooled = await backtestSummary();
  console.log(`  n = ${pooled.n}`);
  printSummaryLine(pooled);
  console.log('\nWant: actual ~ predicted in every populated bucket, within each prop. Below-diagonal = overconfident.');
}
