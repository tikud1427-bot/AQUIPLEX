import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isProviderHealthy, markSuccess, markFailure, getHealthScore,
  getProviderState, getHealthReport, __resetForTests,
} from '../health.js';

// These tests exist because Issues 1/7/8/9 all hinge on one contract:
// router.js now calls markSuccess() — never markFailure() — when a
// provider's response was truncated by hitting the output-token budget.
// That's only a correct fix if markSuccess() genuinely never degrades
// health or trips the circuit breaker, no matter how many times it's
// called, and if markFailure() only opens the circuit for real,
// consecutive failures. This file pins that contract directly against
// health.js, independent of the provider-layer wiring.

describe('health.js — circuit breaker contract (Issues 1, 7, 8, 9)', () => {
  test('a fresh provider starts healthy, closed, with a positive score', () => {
    __resetForTests();
    assert.equal(isProviderHealthy('gemini'), true);
    assert.equal(getProviderState('gemini').circuitState, 'closed');
    assert.ok(getHealthScore('gemini') > 0);
  });

  test('markSuccess never opens the circuit no matter how many times it is called', () => {
    __resetForTests();
    for (let i = 0; i < 50; i++) markSuccess('gemini', 500);
    const s = getProviderState('gemini');
    assert.equal(s.circuitState, 'closed');
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(isProviderHealthy('gemini'), true);
  });

  test('Issue 1/7: 100 consecutive truncated-but-successful completions (markSuccess) keep the provider closed and highly scored — this is the exact call router.js now makes for finishReason=length instead of markFailure', () => {
    __resetForTests();
    for (let i = 0; i < 100; i++) markSuccess('groq', 800);
    assert.equal(getProviderState('groq').circuitState, 'closed');
    assert.ok(getHealthScore('groq') > 50);
  });

  test('fewer than the failure threshold (3) keeps the circuit closed', () => {
    __resetForTests();
    markFailure('gemini', 'timeout');
    markFailure('gemini', 'timeout');
    assert.equal(getProviderState('gemini').circuitState, 'closed');
    assert.equal(isProviderHealthy('gemini'), true);
  });

  test('3 consecutive genuine failures opens the circuit and drops score to 0', () => {
    __resetForTests();
    markFailure('gemini', 'timeout');
    markFailure('gemini', 'network error');
    markFailure('gemini', 'server error');
    assert.equal(getProviderState('gemini').circuitState, 'open');
    assert.equal(isProviderHealthy('gemini'), false);
    assert.equal(getHealthScore('gemini'), 0);
  });

  test('a success in between resets the consecutive-failure count, so the circuit never opens', () => {
    __resetForTests();
    markFailure('groq', 'timeout');
    markFailure('groq', 'timeout');
    markSuccess('groq', 400); // e.g. a truncated-but-successful completion
    markFailure('groq', 'timeout');
    markFailure('groq', 'timeout');
    // Only 2 consecutive failures since the intervening success.
    assert.equal(getProviderState('groq').circuitState, 'closed');
    assert.equal(isProviderHealthy('groq'), true);
  });

  test('half-open: after cooldown expires exactly one probe is allowed; success closes the circuit', (t) => {
    __resetForTests();
    t.mock.timers.enable({ apis: ['Date'] });

    markFailure('openrouter', 'x');
    markFailure('openrouter', 'x');
    markFailure('openrouter', 'x');
    assert.equal(getProviderState('openrouter').circuitState, 'open');
    assert.equal(isProviderHealthy('openrouter'), false);

    t.mock.timers.tick(61_000); // past the 60s base cooldown

    assert.equal(isProviderHealthy('openrouter'), true, 'the single probe should be allowed');
    assert.equal(getProviderState('openrouter').circuitState, 'half_open');
    assert.equal(isProviderHealthy('openrouter'), false, 'no second probe while one is in flight');

    markSuccess('openrouter', 300);
    assert.equal(getProviderState('openrouter').circuitState, 'closed');
    assert.equal(getProviderState('openrouter').consecutiveFailures, 0);
  });

  test('half-open: a failed probe reopens the circuit', (t) => {
    __resetForTests();
    t.mock.timers.enable({ apis: ['Date'] });

    markFailure('openrouter', 'x');
    markFailure('openrouter', 'x');
    markFailure('openrouter', 'x');
    t.mock.timers.tick(61_000);
    isProviderHealthy('openrouter'); // consumes the probe slot → half_open
    markFailure('openrouter', 'probe failed');

    assert.equal(getProviderState('openrouter').circuitState, 'open');
  });

  test('getHealthReport returns every provider with well-formed fields', () => {
    __resetForTests();
    const report = getHealthReport();
    for (const p of ['gemini', 'groq', 'openrouter']) {
      assert.ok(p in report);
      assert.equal(typeof report[p].circuitState, 'string');
      assert.equal(typeof report[p].score, 'string');
      assert.equal(typeof report[p].totalRequests, 'number');
    }
  });

  test('unknown provider name is handled gracefully, never throws', () => {
    __resetForTests();
    assert.equal(isProviderHealthy('not_a_real_provider'), false);
    assert.equal(getHealthScore('not_a_real_provider'), 0);
    assert.doesNotThrow(() => markSuccess('not_a_real_provider', 100));
    assert.doesNotThrow(() => markFailure('not_a_real_provider', 'x'));
  });
});
