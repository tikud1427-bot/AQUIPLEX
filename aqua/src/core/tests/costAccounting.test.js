/** E12 — per-turn cost accounting. BITE (measured): default a missing price to 0 → 3 fail. */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnLedger, setPriceTable, priceCall, recordTurnCost, getCostMetrics, _resetCostMetrics } from '../costAccounting.js';

beforeEach(() => _resetCostMetrics());

describe('cost accounting', () => {
  test('with no price table cost is UNKNOWN (null), never 0, and tokens still count', () => {
    const l = createTurnLedger();
    l.record({ provider: 'groq', model: 'm', inputTokens: 1000, outputTokens: 200, purpose: 'extraction' });
    const s = l.summary();
    assert.equal(s.costUsd, null);
    assert.equal(s.inputTokens, 1000);
    assert.equal(s.unpricedCalls, 1);
  });

  test('prices are per million tokens and summed across calls', () => {
    setPriceTable({ 'groq/m': { inputPerMTok: 1, outputPerMTok: 3 } });
    assert.equal(priceCall({ provider: 'groq', model: 'm', inputTokens: 1_000_000, outputTokens: 1_000_000 }), 4);
    const l = createTurnLedger();
    l.record({ provider: 'groq', model: 'm', inputTokens: 500_000, outputTokens: 0 });
    l.record({ provider: 'groq', model: 'm', inputTokens: 0, outputTokens: 1_000_000 });
    assert.equal(l.summary().costUsd, 3.5);
  });

  test('one unpriced call makes the total unknown instead of understating it', () => {
    setPriceTable({ 'groq/m': { inputPerMTok: 1, outputPerMTok: 1 } });
    const l = createTurnLedger();
    l.record({ provider: 'groq', model: 'm', inputTokens: 1000 });
    l.record({ provider: 'other', model: 'x', inputTokens: 1000 });
    const s = l.summary();
    assert.equal(s.costUsd, null);
    assert.ok(s.pricedCostUsd > 0);
  });

  test('garbage token counts and unknown purposes are coerced, not propagated', () => {
    const l = createTurnLedger();
    l.record({ provider: 'p', model: 'm', inputTokens: -5, outputTokens: NaN, purpose: 'read-my-mail' });
    const s = l.summary();
    assert.equal(s.inputTokens, 0);
    assert.equal(s.outputTokens, 0);
    assert.deepEqual(Object.keys(s.byPurpose), ['other']);
  });

  test('process aggregate folds turns and flags itself incomplete while calls are unpriced', () => {
    const l = createTurnLedger();
    l.record({ provider: 'p', model: 'm', inputTokens: 10, outputTokens: 5, purpose: 'chat' });
    recordTurnCost(l.summary());
    recordTurnCost(l.summary());
    const m = getCostMetrics();
    assert.equal(m.turns, 2);
    assert.equal(m.inputTokens, 20);
    assert.equal(m.complete, false);
    assert.equal(m.avgTokensPerTurn, 15);
  });

  test('a ledger carries counters only — no content fields exist to leak', () => {
    const l = createTurnLedger();
    l.record({ provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, prompt: 'my SSN is ...' });
    assert.doesNotMatch(JSON.stringify(l.summary()), /SSN/);
  });
});
