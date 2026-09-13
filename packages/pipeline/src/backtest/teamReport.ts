import { teamReliability, teamBacktestSummary, teamEvalMarkets, teamResolution, MIN_GAMES } from '@mlb-edge/db';
import type { ReliabilityBucket, BacktestSummary, ResolutionCheck, ResolutionVerdict } from '@mlb-edge/db';

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

const VERDICT_TEXT: Record<ResolutionVerdict, string> = {
  beats: 'BEATS THE BASE RATE',
  worse: 'WORSE THAN THE BASE RATE',
  indistinguishable: 'INDISTINGUISHABLE FROM THE BASE RATE',
  insufficient: 'INSUFFICIENT DATA',
};

function signed(x: number, dp = 4): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(dp)}`;
}

// Resolution check: does the model separate likely games from unlikely ones, or
// does it just track the market's overall base rate? A model can be
// well-calibrated (good ECE) and still carry zero information. The base-rate
// Brier is what a model that always predicts the market's own hit rate scores;
// beating it -- significantly, clustered by game -- is the bar for "this model
// knows something."
function printResolution(r: ResolutionCheck): void {
  if (r.baseRateBrier == null || r.advantage == null || r.baseRate == null) {
    console.log('  base-rate Brier = n/a (no evaluations)');
    return;
  }
  console.log(
    `  base-rate Brier = ${r.baseRateBrier.toFixed(4)}  ` +
      `(predicting the ${(r.baseRate * 100).toFixed(1)}% base rate for every game)`,
  );

  if (r.ciLo == null || r.ciHi == null || r.skillScore == null) {
    console.log(`  model advantage = ${signed(r.advantage)}  (no interval)`);
    console.log(`  verdict         = ${VERDICT_TEXT.insufficient}`);
    console.log(`                    (needs ${MIN_GAMES}+ games and a non-degenerate base rate)`);
    return;
  }

  console.log(
    `  model advantage = ${signed(r.advantage)}  ` +
      `95% CI [${signed(r.ciLo)}, ${signed(r.ciHi)}]  (clustered by game)`,
  );
  console.log(`  skill score     = ${signed(r.skillScore * 100, 1)}%  (advantage / base-rate Brier)`);
  console.log(`  verdict         = ${VERDICT_TEXT[r.verdict]}${r.verdict === 'worse' ? '  <<<' : ''}`);
  if (r.verdict === 'indistinguishable') {
    console.log('                    (no evidence this market carries information)');
  }
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
    const [summary, buckets, resolution] = await Promise.all([
      teamBacktestSummary(market),
      teamReliability(10, market),
      teamResolution(market),
    ]);
    console.log(`-- ${market} (${summary.n} evaluations, ${resolution.games} games) --`);
    printSummaryLine(summary);
    printResolution(resolution);
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
      '    -- it does not measure RESOLUTION (does the model separate likely games from\n' +
      "    unlikely ones). A model that always predicts a market's own base rate can score\n" +
      '    a fine ECE while carrying zero information. The base-rate Brier above is that\n' +
      '    no-information baseline.',
  );
  console.log(
    '  * The verdict is a SIGNIFICANCE TEST, not a sign test, and the interval is\n' +
      '    clustered by game -- one game contributes up to 4 evaluations (one per candidate\n' +
      '    line) scored against a single realized outcome, so treating them as independent\n' +
      '    would overstate precision. INDISTINGUISHABLE is the DEFAULT, not a soft pass: it\n' +
      '    means the data cannot tell this market apart from guessing the base rate. Both\n' +
      '    BEATS and WORSE have to be earned.',
  );
  console.log(
    '  * Three markets are tested here, which is a multiple-comparisons setting. No\n' +
      '    correction is applied: each market is pre-registered to be compared against\n' +
      '    ITSELF over time (see CLAUDE.md), and a Bonferroni bar of t ~ 2.39 would change\n' +
      '    no verdict at present. If a market ever lands just past the threshold, treat\n' +
      '    that as a hypothesis to re-test on a different date range, not a finding.',
  );
}
