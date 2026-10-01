import test from 'node:test';
import assert from 'node:assert/strict';
import { consolidateSemanticDuplicates } from './semanticConsolidator.js';

test('E9/PR-6 consolidates only when the caller supplies an equivalence decision', async () => {
  const result = await consolidateSemanticDuplicates({
    ownerId: 'owner:a',
    existing: [{ ownerId: 'owner:a', claimId: 'old', subject: 'u', predicate: 'works_at', modality: 'fact', sourceTier: 'chat', evidence: ['e1'] }],
    incoming: [{ ownerId: 'owner:a', claimId: 'new', subject: 'u', predicate: 'works_at', modality: 'fact', sourceTier: 'file', evidence: ['e2'] }],
    semanticEquivalent: async () => true,
  });
  assert.equal(result.merges.length, 1);
  assert.equal(result.survivors[0].claimId, 'new');
  assert.deepEqual(result.survivors[0].evidence, ['e1', 'e2']);
});

test('E9/PR-6 does not manufacture a semantic threshold or cross owner boundaries', async () => {
  const noOracle = await consolidateSemanticDuplicates({ ownerId: 'owner:a', existing: [], incoming: [{ claimId: 'c' }] });
  assert.equal(noOracle.merges.length, 0);
  await assert.rejects(() => consolidateSemanticDuplicates({
    ownerId: 'owner:a',
    incoming: [{ ownerId: 'owner:b', claimId: 'c' }],
    semanticEquivalent: async () => true,
  }), /cannot mix owners/);
});
