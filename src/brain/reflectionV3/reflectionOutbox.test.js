import assert from 'node:assert/strict';
import { isClaimReflectionEvent, reflectionJobKey, toReflectionJob } from './reflectionOutbox.js';
import { runClaimReflectionJob } from './reflectionWorker.js';

const base = { outboxId: 42, ownerId: 'user:a', eventType: 'claim.created', aggregateId: 'claim-1', payload: { claimId: 'claim-1' } };

assert.equal(isClaimReflectionEvent('claim.created'), true);
assert.equal(isClaimReflectionEvent('claim.superseded'), true);
assert.equal(isClaimReflectionEvent('entity.created'), false);
assert.equal(reflectionJobKey(base), 'e9:claim-reflection:outbox:42');
assert.deepEqual(toReflectionJob(base), {
  ownerId: 'user:a', kind: 'claim.reflection.v1',
  payload: { ownerId: 'user:a', claimId: 'claim-1', eventType: 'claim.created', outboxId: 42 },
  idempotencyKey: 'e9:claim-reflection:outbox:42', priority: 30,
});
assert.equal(toReflectionJob({ ...base, eventType: 'entity.created' }), null);

const calls = [];
const result = await runClaimReflectionJob(
  { ownerId: 'user:a', payload: { claimId: 'claim-1' } },
  {
    loadClaim: async (id, owner) => ({ claimId: id, ownerId: owner, confidence: 0.8 }),
    reflect: async input => { calls.push(input); return { ok: true, signals: 1, touched: 1 }; },
  });
assert.equal(result.reflected, true);
assert.equal(calls[0].ownerId, 'user:a');
assert.equal(calls[0].affectedClaims[0].claimId, 'claim-1');

console.log('reflection outbox/worker tests: 8/8 passed');
