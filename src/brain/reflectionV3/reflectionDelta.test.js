import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyClaimTransition, buildClaimReflectionDelta, planReflectionDelta } from './reflectionDelta.js';

describe('E9 / PR-4 reflection delta planner', () => {
  test('classifies explicit lifecycle events', () => {
    assert.equal(classifyClaimTransition({ eventType: 'corroborated' }), 'corroborated');
    assert.equal(classifyClaimTransition({ previousState: 'extracted', nextState: 'superseded' }), 'superseded');
    assert.equal(classifyClaimTransition({ nextState: 'unknown' }), null);
  });

  test('creates a deterministic supporting delta', () => {
    assert.deepEqual(buildClaimReflectionDelta({
      eventType: 'created', claim: { claimId: 'c1', confidence: 0.8 },
    }), {
      ok: true, claimId: 'c1', transition: 'created', relation: 'supporting',
      multiplier: 1, strength: 0.8, reason: 'claim lifecycle: created',
    });
  });

  test('supersession becomes contradiction without changing claim storage', () => {
    const d = buildClaimReflectionDelta({
      previousState: 'extracted', nextState: 'superseded', claim: { claimId: 'c2', confidence: 0.7 },
    });
    assert.equal(d.relation, 'contradicting');
    assert.equal(d.strength, 0.7);
  });

  test('stale is deliberately weak', () => {
    const d = buildClaimReflectionDelta({ eventType: 'stale', claim: { claimId: 'c3', confidence: 0.9 } });
    assert.equal(d.multiplier, 0.25);
    assert.equal(d.strength, 0.225);
  });

  test('planning never manufactures an absent belief', () => {
    const signals = planReflectionDelta({
      claims: [{ claimId: 'c4', confidence: 0.9 }],
      events: [{ claimId: 'c4', eventType: 'created' }],
      relationships: [{ claimId: 'c4', dimension: 'identity', beliefKey: 'role', relation: 'supporting', weight: 1 }],
      beliefValues: new Map(),
    });
    assert.equal(signals.length, 0);
  });

  test('contradiction transition preserves the existing belief value', () => {
    const signals = planReflectionDelta({
      claims: [{ claimId: 'c5', confidence: 0.75 }],
      events: [{ claimId: 'c5', eventType: 'contradicted' }],
      relationships: [{ claimId: 'c5', dimension: 'preferences', beliefKey: 'drink', relation: 'supporting', weight: 1 }],
      beliefValues: new Map([['preferences:drink', 'tea']]),
    });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].support, false);
    assert.equal(signals[0].value, 'tea');
    assert.equal(signals[0].strength, 0.75);
    assert.equal(signals[0].reflectionTransition, 'contradicted');
  });
});
