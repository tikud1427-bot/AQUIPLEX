import test from 'node:test';
import assert from 'node:assert/strict';
import { reflectClaimsToBeliefs } from './claimBeliefAdapter.js';
import { createEmptyMind } from '../../mind/mindSchema.js';
import { observeSignal } from '../../mind/beliefEngine.js';

function signalBelief(dimension, key, value) {
  return {
    dimension,
    key,
    value,
    confidence: 0.8,
    status: 'active',
    id: 'bel_test_1',
  };
}

test('E9/PR-2 links claim-backed belief updates after the belief writer succeeds', async () => {
  const mind = createEmptyMind('owner:e9');
  observeSignal(mind, { dimension: 'knowledge', key: 'typescript', value: true, strength: 0.8 });
  const links = [];
  const result = await reflectClaimsToBeliefs({
    ownerId: 'owner:e9',
    affectedClaims: [{ claimId: 'claim-1', confidence: 0.9 }],
    deps: {
      getMind: () => mind,
      beliefsForClaim: async () => [{
        claimId: 'claim-1',
        beliefId: 'bel_test_1',
        dimension: 'knowledge',
        beliefKey: 'typescript',
        relation: 'supporting',
        weight: 1,
      }],
      observeSignals: (_mind, signals) => signals.map(s => signalBelief(s.dimension, s.key, s.value)),
      linkBeliefClaim: async (row) => { links.push(row); return row; },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.linksWritten, 1);
  assert.equal(result.linksFailed, 0);
  assert.equal(links[0].ownerId, 'owner:e9');
  assert.equal(links[0].claimId, 'claim-1');
  assert.equal(links[0].beliefId, 'bel_test_1');
  assert.equal(links[0].relation, 'supporting');
});

test('E9/PR-2 remains fail-open when canonical link storage is unavailable', async () => {
  const mind = createEmptyMind('owner:e9-b');
  observeSignal(mind, { dimension: 'knowledge', key: 'postgres', value: true, strength: 0.8 });
  const result = await reflectClaimsToBeliefs({
    ownerId: 'owner:e9-b',
    affectedClaims: [{ claimId: 'claim-2', confidence: 0.7 }],
    deps: {
      getMind: () => mind,
      beliefsForClaim: async () => [{
        claimId: 'claim-2',
        beliefId: 'bel_test_2',
        dimension: 'knowledge',
        beliefKey: 'postgres',
        relation: 'supporting',
        weight: 1,
      }],
      observeSignals: (_mind, signals) => signals.map(s => signalBelief(s.dimension, s.key, s.value)),
      linkBeliefClaim: async () => { throw new Error('DATABASE_URL is not set'); },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.linksWritten, 0);
  assert.equal(result.linksFailed, 1);
});
