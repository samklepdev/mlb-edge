import assert from 'node:assert/strict';
import { resolutionFromStats, tCritical, MIN_GAMES } from '@mlb-edge/db';
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
function statsFrom(evals: { game: number; d: number }[], baseRate = 0.5, modelBrier = 0.24): ResolutionStats {
  const byGame = new Map<number, { dg: number; ng: number }>();
  for (const e of evals) {
    const cur = byGame.get(e.game) ?? { dg: 0, ng: 0 };
    byGame.set(e.game, { dg: cur.dg + e.d, ng: cur.ng + 1 });
  }
  let sumDg = 0, sumDg2 = 0, sumNgDg = 0, sumNg2 = 0;
  for (const { dg, ng } of byGame.values()) {
    sumDg += dg; sumDg2 += dg * dg; sumNgDg += ng * dg; sumNg2 += ng * ng;
  }
  return { n: evals.length, games: byGame.size, baseRate, modelBrier, sumDg, sumDg2, sumNgDg, sumNg2 };
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
    const got = resolutionFromStats(statsFrom(clustered));
    assert.ok(Math.abs(got.advantage! - ref.a) < 1e-12, `advantage ${got.advantage} vs ${ref.a}`);
    assert.ok(Math.abs(got.se! - ref.se) < 1e-12, `clustered se ${got.se} vs ${ref.se}`);
  }

  // --- 3. with one eval per game, clustered SE == naive SE exactly -------
  const unclustered = Array.from({ length: 400 }, (_, i) => ({ game: i, d: rnd() - 0.5 }));
  {
    const n = unclustered.length;
    const a = unclustered.reduce((s, e) => s + e.d, 0) / n;
    const ss = unclustered.reduce((s, e) => s + (e.d - a) ** 2, 0);
    const naiveSe = Math.sqrt(ss / (n - 1)) / Math.sqrt(n);
    const got = resolutionFromStats(statsFrom(unclustered));
    assert.ok(Math.abs(got.se! - naiveSe) < 1e-12, `n_g=1 must reduce to naive se: ${got.se} vs ${naiveSe}`);
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
    n: 0, games: 0, baseRate: null, modelBrier: null,
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

  // Degenerate base rates: baseRateBrier == 0, so the comparison is vacuous.
  for (const r of [0, 1]) {
    const got = resolutionFromStats(statsFrom(noise, r, 0.1));
    assert.equal(got.verdict, 'insufficient', `base rate ${r} is vacuous`);
    assert.equal(got.skillScore, null, `no skill score at base rate ${r}`);
  }

  // --- 6. derived fields -------------------------------------------------
  {
    const got = resolutionFromStats(statsFrom(strong, 0.5, 0.2));
    assert.equal(got.baseRateBrier, 0.25, 'r=0.5 -> r(1-r)=0.25');
    assert.ok(Math.abs(got.skillScore! - got.advantage! / 0.25) < 1e-12, 'skill score is advantage / baseRateBrier');
    assert.ok(got.ciLo! < got.advantage! && got.advantage! < got.ciHi!, 'advantage sits inside its interval');
  }

  console.log('PURE CHECKS PASSED');
}

// Entry point for the `verify-resolution` CLI command. Task 2 adds a
// verifyQuery() call here; keep this the single place that sequences the
// check groups.
export async function verifyResolution(): Promise<void> {
  verifyPure();
}
