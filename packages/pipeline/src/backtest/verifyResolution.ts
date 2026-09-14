import assert from 'node:assert/strict';
import { resolutionFromStats, tCritical, MIN_GAMES, teamResolution, pool } from '@mlb-edge/db';
import type { ResolutionStats } from '@mlb-edge/db';

// Executable checks for the resolution statistics. Committed rather than
// throwaway: these are the only thing that verifies the game-clustering
// algebra and the t-table's conservatism, and the expected values below are
// an independent SQL derivation (see the plan/spec), not a snapshot of
// whatever the code happens to produce.
//
// Run: npm run verify:resolution

// --- helpers -------------------------------------------------------------
// Build sufficient statistics from raw (game, d) pairs, the way SQL will.
// The baseline fields are supplied rather than derived: SQL computes
// baseRateBrier as the n-weighted mean of r_k(1-r_k) across the market's lines,
// so it is an INPUT here and is not recoverable from the pooled baseRate.
interface BaseOpts {
  baseRate?: number;
  baseRateBrier?: number;
  lines?: number;
  baseRateLo?: number;
  baseRateHi?: number;
  modelBrier?: number;
}

function statsFrom(evals: { game: number; d: number }[], opts: BaseOpts = {}): ResolutionStats {
  const byGame = new Map<number, { dg: number; ng: number }>();
  for (const e of evals) {
    const cur = byGame.get(e.game) ?? { dg: 0, ng: 0 };
    byGame.set(e.game, { dg: cur.dg + e.d, ng: cur.ng + 1 });
  }
  let sumDg = 0, sumDg2 = 0, sumNgDg = 0, sumNg2 = 0;
  for (const { dg, ng } of byGame.values()) {
    sumDg += dg; sumDg2 += dg * dg; sumNgDg += ng * dg; sumNg2 += ng * ng;
  }
  const baseRate = opts.baseRate ?? 0.5;
  return {
    n: evals.length,
    games: byGame.size,
    baseRate,
    baseRateBrier: opts.baseRateBrier ?? 0.25,
    lines: opts.lines ?? 1,
    baseRateLo: opts.baseRateLo ?? baseRate,
    baseRateHi: opts.baseRateHi ?? baseRate,
    modelBrier: opts.modelBrier ?? 0.24,
    sumDg, sumDg2, sumNgDg, sumNg2,
  };
}

// Two-pass reference implementation, straight from the definition.
function referenceSe(evals: { game: number; d: number }[]): { a: number; se: number } {
  const n = evals.length;
  const a = evals.reduce((s, e) => s + e.d, 0) / n;
  const centered = new Map<number, number>();
  for (const e of evals) centered.set(e.game, (centered.get(e.game) ?? 0) + (e.d - a));
  let ssq = 0;
  for (const s of centered.values()) ssq += s * s;
  const g = centered.size;
  return { a, se: Math.sqrt((g / (g - 1)) * ssq) / n };
}

// Deterministic pseudo-random so runs are reproducible. MINSTD: the multiplier
// is small enough that seed * 48271 stays under 2^53, so no precision is lost.
let seed = 12345;
function rnd(): number {
  seed = (seed * 48271) % 2147483647;
  return seed / 2147483647;
}

// Pure invariants: no database, no I/O.
function verifyPure(): void {
  // --- 1. t lookup -------------------------------------------------------
  assert.equal(tCritical(29), 2.045, 't(29)');
  assert.equal(tCritical(39), 2.045, 'df below the 40 breakpoint keeps the 29 row');
  assert.equal(tCritical(40), 2.021, 't(40)');
  assert.equal(tCritical(50), 2.021, 'df=50 rounds down to the 40 row');
  assert.equal(tCritical(60), 2.0, 't(60)');
  assert.equal(tCritical(120), 1.98, 't(120)');
  assert.equal(tCritical(100000), 1.98, 'never drops to the anti-conservative 1.960');
  for (const df of [29, 40, 50, 60, 120, 500, 100000]) {
    assert.ok(tCritical(df) >= 1.98, `t must stay conservative at df=${df}`);
  }

  // --- 2. one-pass SE equals the two-pass reference ----------------------
  // Multi-eval games (the `total` shape: 4 evals per game).
  const clustered = Array.from({ length: 200 * 4 }, (_, i) => ({ game: Math.floor(i / 4), d: rnd() - 0.5 }));
  {
    const ref = referenceSe(clustered);
    // The `total` baseline shape too: 4 lines with different rates.
    const got = resolutionFromStats(
      statsFrom(clustered, { lines: 4, baseRateBrier: 0.2399, baseRateLo: 0.338, baseRateHi: 0.5707 }),
    );
    assert.ok(Math.abs(got.advantage! - ref.a) < 1e-12, `advantage ${got.advantage} vs ${ref.a}`);
    assert.ok(Math.abs(got.se! - ref.se) < 1e-12, `clustered se ${got.se} vs ${ref.se}`);
    assert.equal(got.lines, 4, 'line count is carried through');
    assert.equal(got.baseRateBrier, 0.2399, 'baseRateBrier is supplied by SQL, not derived from baseRate');
  }

  // --- 3. with one eval per game, clustered SE == naive SE exactly -------
  const unclustered = Array.from({ length: 400 }, (_, i) => ({ game: i, d: rnd() - 0.5 }));
  const naiveSeOf = (evals: { game: number; d: number }[]): number => {
    const n = evals.length;
    const a = evals.reduce((s, e) => s + e.d, 0) / n;
    const ss = evals.reduce((s, e) => s + (e.d - a) ** 2, 0);
    return Math.sqrt(ss / (n - 1)) / Math.sqrt(n);
  };
  {
    const naiveSe = naiveSeOf(unclustered);
    const got = resolutionFromStats(statsFrom(unclustered));
    assert.ok(Math.abs(got.se! - naiveSe) < 1e-12, `n_g=1 must reduce to naive se: ${got.se} vs ${naiveSe}`);
  }

  // --- 3b. a SINGLE-LINE market (the `moneyline` shape) ------------------
  // One line means one baseline cell, so baseRateBrier is just r(1-r) and every
  // game contributes exactly one eval: clustering is a no-op and the SE must
  // reduce EXACTLY to the naive SE. This is the pure counterpart of the
  // moneyline identity checked against the database below.
  {
    const single = Array.from({ length: 300 }, (_, i) => ({ game: i, d: rnd() - 0.5 }));
    const r = 0.536;
    const got = resolutionFromStats(
      statsFrom(single, { baseRate: r, baseRateBrier: r * (1 - r), lines: 1, modelBrier: 0.25 }),
    );
    assert.equal(got.lines, 1, 'single-line market reports one line');
    assert.equal(got.n, got.games, 'single-line market is one eval per game');
    assert.equal(got.baseRateLo, r, 'single-line lo defaults to the only rate');
    assert.equal(got.baseRateHi, r, 'single-line hi defaults to the only rate');
    assert.ok(
      Math.abs(got.se! - naiveSeOf(single)) < 1e-12,
      `single-line n_g=1 must reduce to naive se: ${got.se} vs ${naiveSeOf(single)}`,
    );
  }

  // --- 4. verdicts -------------------------------------------------------
  // Advantage far above zero -> beats.
  const strong = Array.from({ length: 100 }, (_, i) => ({ game: i, d: 0.05 + (rnd() - 0.5) * 0.01 }));
  assert.equal(resolutionFromStats(statsFrom(strong)).verdict, 'beats', 'large positive advantage');

  // Mirror image -> worse.
  const weak = strong.map((e) => ({ game: e.game, d: -e.d }));
  assert.equal(resolutionFromStats(statsFrom(weak)).verdict, 'worse', 'large negative advantage');

  // Noise centred on zero -> indistinguishable (the default).
  // Built as mirrored +/- pairs so the mean is EXACTLY zero. Do not replace
  // this with unpaired random draws: the advantage would then be a random
  // variable and the assertion would fire on roughly 5% of seeds.
  const mags = Array.from({ length: 50 }, () => 0.05 + (rnd() - 0.5) * 0.02);
  const noise = mags.flatMap((m, i) => [
    { game: 2 * i, d: m },
    { game: 2 * i + 1, d: -m },
  ]);
  assert.equal(resolutionFromStats(statsFrom(noise)).verdict, 'indistinguishable', 'noise must not read as a finding');

  // --- 5. guards ---------------------------------------------------------
  const zero: ResolutionStats = {
    n: 0, games: 0, baseRate: null, baseRateBrier: null,
    lines: 0, baseRateLo: null, baseRateHi: null, modelBrier: null,
    sumDg: 0, sumDg2: 0, sumNgDg: 0, sumNg2: 0,
  };
  assert.equal(resolutionFromStats(zero).verdict, 'insufficient', 'no evaluations');
  assert.equal(resolutionFromStats(zero).advantage, null, 'no advantage without evaluations');

  // G below the floor, with an otherwise screamingly significant advantage.
  // The jitter is load-bearing: with every d identical the SE would be 0 and
  // this would pass via the zero-variance guard instead of the cluster-count one.
  const tooFew = Array.from({ length: MIN_GAMES - 1 }, (_, i) => ({ game: i, d: 0.05 + (rnd() - 0.5) * 0.01 }));
  assert.ok(resolutionFromStats(statsFrom(tooFew)).se! > 0, 'tooFew must have non-zero spread to isolate the G guard');
  assert.equal(resolutionFromStats(statsFrom(tooFew)).verdict, 'insufficient', `G < ${MIN_GAMES}`);
  const atFloor = Array.from({ length: MIN_GAMES }, (_, i) => ({ game: i, d: 0.05 + (rnd() - 0.5) * 0.01 }));
  assert.equal(resolutionFromStats(statsFrom(atFloor)).verdict, 'beats', `G == ${MIN_GAMES} is allowed`);

  // SE == 0: every d identical, so there is no spread to test.
  const flat = Array.from({ length: 100 }, (_, i) => ({ game: i, d: 0.02 }));
  assert.equal(resolutionFromStats(statsFrom(flat)).verdict, 'insufficient', 'zero variance');

  // Degenerate baselines: baseRateBrier == 0, so the comparison is vacuous.
  // Single line at r in {0, 1}.
  for (const r of [0, 1]) {
    const got = resolutionFromStats(
      statsFrom(noise, { baseRate: r, baseRateBrier: 0, lines: 1, modelBrier: 0.1 }),
    );
    assert.equal(got.verdict, 'insufficient', `base rate ${r} is vacuous`);
    assert.equal(got.skillScore, null, `no skill score at base rate ${r}`);
  }
  // Several lines, EVERY one degenerate, pooling to a perfectly ordinary 0.5.
  // The old guard tested the pooled rate and would have let this through as a
  // confident WORSE; the guard now tests baseRateBrier, which is 0 here.
  {
    const got = resolutionFromStats(
      statsFrom(noise, { baseRate: 0.5, baseRateBrier: 0, lines: 2, baseRateLo: 0, baseRateHi: 1, modelBrier: 0.1 }),
    );
    assert.equal(got.verdict, 'insufficient', 'all-degenerate lines are vacuous even when they pool to 0.5');
    assert.equal(got.skillScore, null, 'no skill score when every line is degenerate');
  }

  // --- 6. derived fields -------------------------------------------------
  {
    const got = resolutionFromStats(statsFrom(strong, { baseRate: 0.5, baseRateBrier: 0.25, modelBrier: 0.2 }));
    assert.equal(got.baseRateBrier, 0.25, 'baseRateBrier passes through unmodified');
    assert.ok(Math.abs(got.skillScore! - got.advantage! / 0.25) < 1e-12, 'skill score is advantage / baseRateBrier');
    assert.ok(got.ciLo! < got.advantage! && got.advantage! < got.ciHi!, 'advantage sits inside its interval');
  }
  // The pooled baseRate must NOT be used to derive baseRateBrier any more: a
  // multi-line market whose pooled rate is 0.5 still has baseRateBrier < 0.25,
  // by exactly Var(r_k). Pinning this stops a future "simplification" back to
  // baseRate*(1-baseRate) from passing silently.
  {
    const got = resolutionFromStats(
      statsFrom(strong, { baseRate: 0.5, baseRateBrier: 0.24, lines: 2, baseRateLo: 0.4, baseRateHi: 0.6, modelBrier: 0.2 }),
    );
    assert.equal(got.baseRateBrier, 0.24, 'baseRateBrier is not recomputed from baseRate');
    assert.ok(
      Math.abs(got.skillScore! - got.advantage! / 0.24) < 1e-12,
      'skill score divides by the per-line baseRateBrier, not baseRate*(1-baseRate)',
    );
  }

  console.log('PURE CHECKS PASSED');
}

// Oracle values from the design session's independent SQL, matched to 5 dp.
// Baseline is per (market, line): baseRateBrier is the n-weighted mean of
// r_k(1-r_k), and lo/hi bracket the per-line hit rates.
const EXPECTED = [
  {
    market: 'total', n: 9420, games: 2355, lines: 4,
    baseRateBrier: 0.2399, baseRateLo: 0.338, baseRateHi: 0.5707,
    advantage: -0.00581, se: 0.00199, verdict: 'worse',
  },
  {
    market: 'run_line', n: 4710, games: 2355, lines: 2,
    baseRateBrier: 0.2309, baseRateLo: 0.3665, baseRateHi: 0.6425,
    advantage: 0.00036, se: 0.00171, verdict: 'indistinguishable',
  },
  {
    market: 'moneyline', n: 2355, games: 2355, lines: 1,
    baseRateBrier: 0.2487, baseRateLo: 0.5363, baseRateHi: 0.5363,
    advantage: -0.00213, se: 0.0022, verdict: 'indistinguishable',
  },
] as const;

const r5 = (x: number) => Number(x.toFixed(5));
const r4 = (x: number) => Number(x.toFixed(4));

async function verifyQuery(): Promise<void> {
  for (const e of EXPECTED) {
    const got = await teamResolution({ market: e.market });
    assert.equal(got.n, e.n, `${e.market} n`);
    assert.equal(got.games, e.games, `${e.market} games`);
    assert.equal(got.lines, e.lines, `${e.market} distinct lines: got ${got.lines}`);
    assert.equal(
      r4(got.baseRateBrier!), r4(e.baseRateBrier),
      `${e.market} base-rate Brier: got ${got.baseRateBrier}`,
    );
    assert.equal(r4(got.baseRateLo!), r4(e.baseRateLo), `${e.market} lowest line rate: got ${got.baseRateLo}`);
    assert.equal(r4(got.baseRateHi!), r4(e.baseRateHi), `${e.market} highest line rate: got ${got.baseRateHi}`);
    assert.equal(r5(got.advantage!), r5(e.advantage), `${e.market} advantage: got ${got.advantage}`);
    assert.equal(r5(got.se!), r5(e.se), `${e.market} clustered se: got ${got.se}`);
    assert.equal(got.verdict, e.verdict, `${e.market} verdict: got ${got.verdict}`);
    assert.ok(got.ciLo! < got.ciHi!, `${e.market} interval ordering`);
    // advantage = baseRateBrier - modelBrier must hold EXACTLY under the
    // per-line baseline, since mean((r_k - y_i)^2) is that weighted mean.
    assert.ok(
      Math.abs(got.advantage! - (got.baseRateBrier! - got.modelBrier!)) < 1e-12,
      `${e.market} advantage identity: ${got.advantage} vs ${got.baseRateBrier! - got.modelBrier!}`,
    );
    console.log(
      `${e.market}: ${got.lines} line(s) brier ${got.baseRateBrier!.toFixed(5)} ` +
        `advantage ${got.advantage!.toFixed(5)} se ${got.se!.toFixed(5)} -> ${got.verdict}`,
    );
  }

  // moneyline has exactly one eval per game, so clustering is a no-op and the
  // clustered SE must reduce EXACTLY to the naive SE. This is an algebraic
  // identity, not an approximation -- see the spec. Recompute the naive SE from
  // raw rows here so the check does not depend on the query's own clustering.
  // The per-row base rate is joined per LINE, matching the estimand; moneyline
  // happens to have a single line, so this also pins that the one-line case does
  // not accidentally differ from the pooled rate.
  {
    const ml = await teamResolution({ market: 'moneyline' });
    assert.equal(ml.n, ml.games, 'moneyline must be one eval per game for this check to mean anything');
    assert.equal(ml.lines, 1, 'moneyline must have exactly one candidate line');
    const rows = (
      await pool.query<{ p: number; y: number; r: number }>(
        `WITH e AS (
           SELECT line::float8 AS line, model_prob::float8 AS p, (hit)::int AS y
           FROM team_model_evals
           WHERE model_version = (SELECT max(model_version) FROM team_model_evals)
             AND market = 'moneyline'
         ),
         rk AS (SELECT line, avg(y)::float8 AS r FROM e GROUP BY line)
         SELECT e.p, e.y, rk.r FROM e JOIN rk ON rk.line = e.line`,
      )
    ).rows;
    const d = rows.map((row) => (Number(row.r) - row.y) ** 2 - (Number(row.p) - row.y) ** 2);
    const n = d.length;
    const a = d.reduce((s, x) => s + x, 0) / n;
    const naiveSe = Math.sqrt(d.reduce((s, x) => s + (x - a) ** 2, 0) / (n - 1)) / Math.sqrt(n);
    assert.ok(Math.abs(ml.se! - naiveSe) < 1e-12, `n_g=1 identity: clustered ${ml.se} vs naive ${naiveSe}`);
    assert.ok(Math.abs(ml.advantage! - a) < 1e-12, `advantage from raw rows: ${ml.advantage} vs ${a}`);
    console.log('n_g=1 identity holds exactly');
  }

  // The unfiltered call pools every market; it must at least aggregate cleanly.
  {
    const all = await teamResolution();
    assert.equal(all.n, 9420 + 4710 + 2355, 'pooled n');
    assert.equal(all.games, 2355, 'pooled games');
    // Baseline cells are (market, line) pairs, so pooling the three markets
    // gives 4 + 2 + 1 = 7 cells, not one.
    assert.equal(all.lines, 4 + 2 + 1, 'pooled baseline cells');
    console.log(`pooled: n=${all.n} games=${all.games} cells=${all.lines}`);
  }

  console.log('QUERY CHECKS PASSED');
}

// Entry point for the `verify-resolution` CLI command. Task 2 adds a
// verifyQuery() call here; keep this the single place that sequences the
// check groups.
export async function verifyResolution(): Promise<void> {
  verifyPure();
  await verifyQuery();
}
