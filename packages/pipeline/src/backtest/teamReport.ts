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

// Resolution check: does the model separate likely from unlikely games at all,
// or does it just track the market's overall base rate? A model can be
// well-calibrated (good ECE) and still carry zero information -- the base-rate
// Brier is what a model that always predicts the market's own hit rate would
// score. Beating it is the bar for "this model knows something."
function printResolutionLine(s: BacktestSummary, buckets: ReliabilityBucket[]): void {
  const totalN = buckets.reduce((sum, b) => sum + b.n, 0);
  if (totalN === 0 || s.brier == null) {
    console.log('  base-rate Brier = n/a (no buckets)');
    return;
  }
  const rate = buckets.reduce((sum, b) => sum + b.n * b.actual, 0) / totalN;
  const baseRateBrier = rate * (1 - rate);
  const advantage = baseRateBrier - s.brier;
  const sign = advantage >= 0 ? '+' : '';
  const flag = advantage < 0 ? '  <<< WORSE THAN GUESSING THE BASE RATE' : '';
  console.log(
    `  base-rate Brier = ${baseRateBrier.toFixed(4)}  (predicting the ${(rate * 100).toFixed(1)}% base rate for every game)`,
  );
  console.log(`  model advantage = ${sign}${advantage.toFixed(4)}  (base-rate Brier minus model Brier; positive = model beats guessing)${flag}`);
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
    printResolutionLine(summary, buckets);
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
  console.log(
    '  * ECE measures CALIBRATION (do predicted probabilities match observed frequencies)\n' +
      "    -- it does not measure RESOLUTION (does the model separate likely games from\n" +
      "    unlikely ones). A model that always predicts a market's own base rate can score\n" +
      '    a fine ECE while carrying zero information. The base-rate Brier line above is\n' +
      "    that no-information baseline; a NEGATIVE model advantage means the model is\n" +
      '    worse than just guessing the base rate every time, regardless of what ECE says.',
  );
}
