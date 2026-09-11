/**
 * AQUA — the scaling-shape helper
 * Blueprint: test-suite hygiene
 *
 * A helper that decides whether other tests pass has to be tested against
 * KNOWN shapes, not against a real workload whose ratio happens to sit
 * mid-band. Measuring bite on the FI-2 test proved that: mutating the helper's
 * ceiling changed nothing there, because the real ratio (~3.9×) is comfortably
 * inside the band and never touches the throw.
 *
 * So this feeds it synthetic linear and quadratic work, where the right answer
 * is known in advance.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { assertScalesLinearly } from './helpers/perfShape.mjs';

/**
 * Deterministic busy-work: cost proportional to `units`.
 *
 * Sized to clear the helper's 15ms noise floor at the base `n` used below.
 * The first version used 8,000 iterations per unit, which finished in ~2ms —
 * so the helper correctly SKIPPED rather than judging noise, and the
 * "quadratic is rejected" test failed with 'Missing expected rejection'.
 *
 * The helper was right and the fixture was too small. Worth recording: a test
 * for a noise-floor guard has to be loud enough to clear it.
 */
const burn = (units) => {
  let x = 0;
  for (let i = 0; i < units * 120_000; i++) x += Math.sqrt(i % 97);
  return x;
};

describe('perf shape — it can tell linear from quadratic', () => {
  test('LINEAR work passes', async () => {
    const r = await assertScalesLinearly(n => burn(n), { n: 100, samples: 2, label: 'linear' });
    assert.ok(r.skipped || r.ratio <= 2.5, `linear work measured ${r.ratio?.toFixed(2)}×`);
  });

  test('QUADRATIC work is REJECTED — the assertion that makes the helper worth having', async () => {
    // An absolute stopwatch budget would pass this on a fast machine. That is
    // the whole reason for the ratio: it fails on the SHAPE, not the hardware.
    await assert.rejects(
      () => assertScalesLinearly(n => burn(n * n / 100), { n: 100, samples: 2, label: 'quadratic' }),
      err => {
        assert.match(err.message, /does not scale linearly/);
        assert.match(err.message, /quadratic is ~4×/, 'the message should say what the numbers mean');
        return true;
      },
    );
  });

  test('the ceiling is respected — a generous one admits quadratic', async () => {
    // Which is exactly how the FI-2 test pins a measured-quadratic pass
    // without pretending it is linear.
    const r = await assertScalesLinearly(n => burn(n * n / 100),
      { n: 100, samples: 2, maxRatio: 6, label: 'quadratic, generous ceiling' });
    assert.ok(r.skipped || r.ratio > 2.5);
  });
});

describe('perf shape — it refuses to assert on noise', () => {
  test('work below the noise floor is SKIPPED with a reason, not judged', async () => {
    // At single-digit milliseconds the ratio is dominated by timer resolution
    // and GC. Asserting on that would create the very flake this helper exists
    // to remove — so it declines, and says why.
    const r = await assertScalesLinearly(() => 1, { n: 1, samples: 1, floorMs: 50 });
    assert.equal(r.skipped, true);
    assert.match(r.reason, /below the 50ms noise floor/);
  });

  test('a skipped result carries its measurements, so it is inspectable', async () => {
    const r = await assertScalesLinearly(() => 1, { n: 1, samples: 1, floorMs: 50 });
    assert.equal(typeof r.small, 'number');
    assert.equal(typeof r.large, 'number');
  });
});

describe('perf shape — the warm-up matters', () => {
  test('the first call is excluded from the measurement', async () => {
    // A cold first call measures module loading and JIT, not the algorithm.
    // Counting it makes the SMALL sample look slow, which flatters the ratio
    // and hides a real regression — the opposite of what this is for.
    let calls = 0;
    await assertScalesLinearly(() => { calls++; burn(30); }, { n: 30, samples: 1, floorMs: 0 });
    // one warm-up + one small + one large
    assert.equal(calls, 3, 'the warm-up call is missing or duplicated');
  });
});
