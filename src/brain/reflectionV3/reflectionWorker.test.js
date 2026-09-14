import assert from 'node:assert/strict';
import { runClaimReflectionJob } from './reflectionWorker.js';

const mind = { beliefs: {}, reflectionLedger: {} };
let reflected = 0;
const job = { ownerId: 'user:a', payload: { claimId: 'c1', outboxId: 42, eventType: 'claim.created' } };
const claim = { claimId: 'c1' };

const first = await runClaimReflectionJob(job, {
  loadClaim: async () => claim,
  loadMind: () => mind,
  reflect: async () => { reflected++; return { ok: true, signals: 0, touched: 0 }; },
});
assert.equal(first.ok, true);
assert.equal(first.duplicate, undefined);
assert.equal(reflected, 1);

const second = await runClaimReflectionJob(job, {
  loadClaim: async () => claim,
  loadMind: () => mind,
  reflect: async () => { reflected++; return { ok: true, signals: 0, touched: 0 }; },
});
assert.equal(second.ok, true);
assert.equal(second.duplicate, true);
assert.equal(reflected, 1);

const otherOwner = await runClaimReflectionJob({ ...job, ownerId: 'user:b' }, {
  loadClaim: async () => claim,
  loadMind: () => ({ beliefs: {}, reflectionLedger: {} }),
  reflect: async () => ({ ok: true, signals: 0, touched: 0 }),
});
assert.equal(otherOwner.ok, true);
assert.notEqual(otherOwner.effectKey, first.effectKey);

console.log('E9 PR-6 reflection worker idempotency: 3/3 assertions passed');
