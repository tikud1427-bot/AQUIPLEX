import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeBackoff, sleep } from '../backoff.js';

describe('backoff — exponential with full jitter', () => {
  test('rng=1 → nominal doubles per attempt, capped', () => {
    const o = { baseMs: 500, capMs: 8000, rng: () => 1 };
    assert.equal(computeBackoff(1, o), 500);
    assert.equal(computeBackoff(2, o), 1000);
    assert.equal(computeBackoff(3, o), 2000);
    assert.equal(computeBackoff(4, o), 4000);
    assert.equal(computeBackoff(5, o), 8000);
    assert.equal(computeBackoff(6, o), 8000); // capped
  });

  test('rng=0 → full jitter can floor to 0 (or minMs)', () => {
    assert.equal(computeBackoff(3, { baseMs: 500, rng: () => 0 }), 0);
    assert.equal(computeBackoff(3, { baseMs: 500, rng: () => 0, minMs: 300 }), 300);
    assert.equal(computeBackoff(3, { baseMs: 500, rng: () => 0, floorMs: 100 }), 100);
  });

  test('jittered result always within [minMs, nominal]', () => {
    for (let i = 0; i < 300; i++) {
      const v = computeBackoff(3, { baseMs: 500, capMs: 8000, rng: Math.random });
      assert.ok(v >= 0 && v <= 2000, `out of range: ${v}`);
    }
  });

  test('Retry-After hint (minMs) is never undercut, but still capped', () => {
    // minMs above the nominal lifts the floor to minMs.
    assert.equal(computeBackoff(1, { baseMs: 500, capMs: 8000, rng: () => 0, minMs: 5000 }), 5000);
  });

  test('huge exponent never overflows past cap', () => {
    assert.equal(computeBackoff(60, { baseMs: 500, capMs: 8000, rng: () => 1 }), 8000);
    assert.equal(computeBackoff(1000, { baseMs: 500, capMs: 8000, rng: () => 1 }), 8000);
  });

  test('sleep resolves immediately when signal already aborted', async () => {
    const ac = new AbortController(); ac.abort();
    const t = Date.now();
    await sleep(5000, ac.signal);
    assert.ok(Date.now() - t < 100, 'aborted sleep should not wait');
  });

  test('sleep(0) resolves without hanging', async () => {
    await sleep(0);
    assert.ok(true);
  });

  test('sleep is cut short when the signal fires mid-wait', async () => {
    const ac = new AbortController();
    const t = Date.now();
    setTimeout(() => ac.abort(), 20);
    await sleep(5000, ac.signal);
    assert.ok(Date.now() - t < 500, 'signal should cancel the pending delay');
  });
});
