import { teamReliability, teamBacktestSummary, teamEvalMarkets } from '@mlb-edge/db';
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

function printSummaryLine(s: BacktestSummary): void {
  console.log(`  ECE   = ${s.ece == null ? 'n/a' : s.ece.toFixed(4)}  (lower is better)`);
  console.log(`  Brier = ${s.brier == null ? 'n/a' : s.brier.toFixed(4)}  (lower is better)`);
}

export async function teamBacktestReport(): Promise<void> {
  const markets = await teamEvalMarkets();
  if (markets.length === 0) {
    console.log('No team evaluations yet. Run: npm run team-backfill -- --from <d> --to <d>');
    return;
  }

  console.log('GAME-OUTCOME model calibration, BY MARKET');
  console.log('=========================================');
  console.log(
    'Each market has its own base rate and difficulty. Compare a market only against\n' +
      'itself over time -- never against another market, and never against the prop\n' +
      "model's figures, which measure a different model on a different population.\n",
  );

  for (const market of markets) {
    const [summary, buckets] = await Promise.all([teamBacktestSummary(market), teamReliability(10, market)]);
    console.log(`-- ${market} (${summary.n} evaluations) --`);
    printSummaryLine(summary);
    printBuckets(buckets);
    console.log('');
  }

  console.log('How to read this:');
  console.log(
    '  * ~160 games per team-season is an order of magnitude less signal than per-PA\n' +
      '    props, which have thousands of events. A worse ECE than the prop model is\n' +
      '    EXPECTED and is not a failure. The bar here is calibrated, not sharp.',
  );
  console.log(
    '  * The two run distributions are convolved as INDEPENDENT, which they are not --\n' +
      '    a home team leading after 8.5 innings does not bat again. This biases the\n' +
      '    model in a known direction and is the largest v0 approximation.',
  );
  console.log(
    '  * Park factors are neutral and bullpens are league-average. Systematic gaps in\n' +
      '    the totals market are the place those two assumptions would show up first.',
  );
}
