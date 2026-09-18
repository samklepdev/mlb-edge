import { describe, expect, it } from 'vitest';
import { wilson } from './prob.js';

// Reference values are the standard published Wilson score intervals at 95%,
// not values read back off this implementation. A test that asserts whatever
// the code already returns proves only that the code is deterministic.
describe('wilson', () => {
  it('matches published 95% intervals at n=10', () => {
    // 0/10 -> (0.0000, 0.2775)
    const zero = wilson(0, 10);
    expect(zero.lo).toBeCloseTo(0, 4);
    expect(zero.hi).toBeCloseTo(0.2775, 3);

    // 5/10 -> (0.2366, 0.7634)
    const half = wilson(5, 10);
    expect(half.lo).toBeCloseTo(0.2366, 3);
    expect(half.hi).toBeCloseTo(0.7634, 3);

    // 10/10 -> (0.7225, 1.0000)
    const all = wilson(10, 10);
    expect(all.lo).toBeCloseTo(0.7225, 3);
    expect(all.hi).toBeCloseTo(1, 4);
  });

  it('clamps to [0, 1]', () => {
    // The raw score interval can exceed the unit interval at extreme p; a
    // displayed "hi = 1.03" would be nonsense in a percentage column.
    for (const [x, n] of [[0, 3], [3, 3], [1, 200], [199, 200]] as const) {
      const ci = wilson(x, n);
      expect(ci.lo).toBeGreaterThanOrEqual(0);
      expect(ci.hi).toBeLessThanOrEqual(1);
    }
  });

  it('is asymmetric about the point estimate at small n', () => {
    // This is the whole reason the panel renders explicit bounds rather than
    // "p +/- h". At n=44, p=0.227 the two sides differ by ~4.4 points.
    const n = 44, x = 10;
    const p = x / n;
    const ci = wilson(x, n);
    const down = p - ci.lo;
    const up = ci.hi - p;
    expect(up - down).toBeGreaterThan(0.03);
  });

  it('returns the full interval for an empty sample', () => {
    // n=0 must not produce NaN: the panel renders a row for a pitch the batter
    // has never swung at, and NaN would reach the DOM.
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });

  it('narrows as n grows', () => {
    const small = wilson(25, 50);
    const large = wilson(250, 500);
    expect(large.hi - large.lo).toBeLessThan(small.hi - small.lo);
  });
});
