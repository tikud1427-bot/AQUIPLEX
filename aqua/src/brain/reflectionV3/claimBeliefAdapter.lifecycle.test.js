import assert from 'node:assert/strict';
import { reflectClaimsToBeliefs } from './claimBeliefAdapter.js';

function makeMind() {
  return {
    beliefs: {
      'identity:role': {
        id: 'bel_test', dimension: 'identity', key: 'role', value: 'founder',
        confidence: 0.8, contradictions: 0, evidence: [], evidenceCount: 0,
        privacy: { locked: false }, status: 'active', history: [],
      },
    },
  };
}

const cases = [
  ['claim.created', true, 1],
  ['claim.corroborated', true, 1],
  ['claim.contradicted', false, 1],
  ['claim.superseded', false, 1],
  ['claim.stale', false, 0.25],
];

for (const [eventType, expectedSupport, expectedWeight] of cases) {
  let applied = null;
  const result = await reflectClaimsToBeliefs({
    ownerId: 'user:test',
    affectedClaims: [{ claimId: 'c1', confidence: 0.8 }],
    reflectionEvents: [{ claimId: 'c1', eventType }],
    deps: {
      getMind: () => makeMind(),
      beliefsForClaim: async () => [{ claimId: 'c1', dimension: 'identity', beliefKey: 'role', relation: 'supporting', weight: 1 }],
      observeSignals: (_mind, signals) => { applied = signals; return signals; },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.signals, 1);
  assert.equal(applied[0].support, expectedSupport, eventType);
  assert.equal(applied[0].strength, +(0.8 * expectedWeight).toFixed(4), eventType);
}

console.log('E9 lifecycle semantics at production adapter seam: 15/15 assertions passed');
