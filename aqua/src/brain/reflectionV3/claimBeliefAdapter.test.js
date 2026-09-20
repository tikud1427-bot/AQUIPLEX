import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planClaimReflection, claimRelationshipToSignal, applyClaimSignal } from './claimBeliefAdapter.js';

describe('E9 claim → belief reflection adapter', () => {
  test('supporting claim reinforces existing belief without copying claim value', () => {
    const signals = planClaimReflection({
      claims: [{ claimId: 'c1', confidence: 0.9 }],
      relationships: [{ claimId: 'c1', dimension: 'preferences', beliefKey: 'coffee', relation: 'supporting', weight: 1 }],
      beliefValues: new Map([['preferences:coffee', 'tea']]),
    });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].value, 'tea');
    assert.equal(signals[0].support, true);
    assert.equal(signals[0].claimId, 'c1');
  });

  test('contradicting claim lowers an existing belief', () => {
    const mind = { ownerId: 'o', beliefs: {} };
    // Use the real writer against a minimal shape produced by the schema.
    // This test focuses on policy conversion; integration tests cover persistence.
    const s = claimRelationshipToSignal({
      relationship: { claimId: 'c2', dimension: 'identity', beliefKey: 'role', relation: 'contradicting', weight: 1, currentBeliefValue: 'founder' },
      claim: { confidence: 0.8 },
    });
    assert.equal(s.support, false);
    assert.equal(s.value, 'founder');
    assert.equal(s.strength, 0.8);
  });

  test('missing belief is never manufactured from a supporting claim', () => {
    const signals = planClaimReflection({
      claims: [{ claimId: 'c3', confidence: 1 }],
      relationships: [{ claimId: 'c3', dimension: 'identity', beliefKey: 'role', relation: 'supporting' }],
      beliefValues: new Map(),
    });
    assert.equal(signals.length, 0);
  });

  test('relationship weight bounds signal strength', () => {
    const s = claimRelationshipToSignal({
      relationship: { claimId: 'c4', dimension: 'x', beliefKey: 'y', relation: 'supporting', weight: 0.4, currentBeliefValue: 'v' },
      claim: { confidence: 0.9 },
    });
    assert.equal(s.strength, 0.36);
  });

  test('pure planning is deterministic', () => {
    const args = {
      claims: [{ claimId: 'c5', confidence: 0.7 }],
      relationships: [{ claimId: 'c5', dimension: 'x', beliefKey: 'y', relation: 'supporting', weight: 0.5 }],
      beliefValues: new Map([['x:y', 'z']]),
    };
    assert.deepEqual(planClaimReflection(args), planClaimReflection(args));
  });
});
