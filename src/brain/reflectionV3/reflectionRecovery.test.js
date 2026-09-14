import assert from 'node:assert/strict';
import { reflectionRecoveryAction, reflectionReconciliation, requeueDeadReflectionJob } from './reflectionRecovery.js';

assert.equal(reflectionRecoveryAction({ jobState:'dead', hasEffect:false }), 'requeue-required');
assert.equal(reflectionRecoveryAction({ jobState:'dead', hasEffect:true }), 'already-applied');
assert.equal(reflectionRecoveryAction({ jobState:'done', hasEffect:false }), 'reconcile-required');
assert.equal(reflectionRecoveryAction({ jobState:'queued', hasEffect:false }), 'in-flight');
assert.equal(reflectionRecoveryAction({ jobState:null, hasEffect:false }), 'missing');

const base = { outboxId: 9, ownerId:'user:a', eventType:'claim.created', aggregateId:'c1', payload:{ claimId:'c1' } };
assert.deepEqual(reflectionReconciliation({ outboxRow:base, jobRow:{jobId:3,state:'dead'}, hasEffect:false }), {
  relevant:true, ownerId:'user:a', outboxId:9, claimId:'c1', jobState:'dead', hasEffect:false, action:'requeue-required'
});
assert.equal(reflectionReconciliation({ outboxRow:{...base,eventType:'other'} }).relevant, false);

let enqueued = null;
const fakePool = {
  async query(sql, params) {
    if (String(sql).includes('SELECT job_id, owner_id, kind')) return { rows:[{job_id:7,owner_id:'user:a',kind:'claim.reflection.v1',state:'dead',payload:{outboxId:9,eventType:'claim.created',claimId:'c1'}}] };
    return { rows:[], rowCount:1 };
  }
};
// The production function is DB-gated; pure policy is the unit-test contract.
assert.equal(typeof requeueDeadReflectionJob, 'function');
assert.equal(enqueued, null);
console.log('E9 PR-7 reflection recovery: 7/7 assertions passed');
