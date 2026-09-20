import assert from 'node:assert/strict';
import { runClaimReflectionJob } from './reflectionWorker.js';

const mind = { beliefs: {}, reflectionLedger: {} };
let reflected = 0;
let received = null;
const job = { ownerId: 'user:a', payload: { claimId: 'c1', outboxId: 42, eventType: 'claim.contradicted' } };
const claim = { claimId: 'c1', confidence: 0.9 };

const first = await runClaimReflectionJob(job, {
  loadClaim: async () => claim,
  loadMind: () => mind,
  reflect: async (args) => { reflected++; received = args; return { ok: true, signals: 1, touched: 1 }; },
});
assert.equal(first.ok, true);
assert.equal(reflected, 1);
assert.equal(received.reflectionEvents[0].eventType, 'contradicted');
assert.equal(received.reflectionEvents[0].claimId, 'c1');

const second = await runClaimReflectionJob(job, {
  loadClaim: async () => claim,
  loadMind: () => mind,
  reflect: async () => { reflected++; return { ok: true, signals: 1, touched: 1 }; },
});
assert.equal(second.duplicate, true);
assert.equal(reflected, 1);

const otherOwner = await runClaimReflectionJob({ ...job, ownerId: 'user:b' }, {
  loadClaim: async () => claim,
  loadMind: () => ({ beliefs: {}, reflectionLedger: {} }),
  reflect: async () => ({ ok: true, signals: 0, touched: 0 }),
});
assert.equal(otherOwner.ok, true);
assert.notEqual(otherOwner.effectKey, first.effectKey);

console.log('E9 production reflection worker lifecycle wiring: 6/6 assertions passed');


import fs from 'node:fs';
const workerSource = fs.readFileSync(new URL('./reflectionWorker.js', import.meta.url), 'utf8');
if (!workerSource.includes("../../core/worldModel/worldModelRepository.js")) throw new Error('E9 reflection worker is not using canonical world-model claims');
console.log('E9 canonical claim loader boundary: 1/1 assertion passed');
