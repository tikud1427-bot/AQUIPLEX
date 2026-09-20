import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runClaimContradictionJob } from './contradictionWorker.js';
import { CONTRADICTION_ACTION } from './contradictionPolicy.js';

const base = (id, over = {}) => ({
  claimId: id,
  ownerId: 'owner:a',
  subjectEntityId: 'subject:a',
  predicate: 'priority',
  polarity: 'asserted',
  modality: 'fact',
  state: 'active',
  confidence: 0.9,
  assertedAt: '2026-09-18T10:00:00Z',
  evidence: [{ role: 'primary' }],
  sourceKind: 'conversation',
  ...over,
});

test('explicit user correction supersedes the prior canonical claim', async () => {
  const claims = new Map([
    ['old', base('old', { object: { literal: 'growth' } })],
    ['new', base('new', { object: { literal: 'retention' }, sourceKind: 'user_correction', assertedAt: '2026-09-18T11:00:00Z' })],
  ]);
  const transitions = [];
  const out = await runClaimContradictionJob({ ownerId: 'owner:a', payload: { incomingClaimId: 'new', existingClaimId: 'old' } }, {
    loadClaim: async (id, owner) => owner === 'owner:a' ? claims.get(id) : null,
    applyTransition: async input => { transitions.push(input); return input; },
  });
  assert.equal(out.ok, true);
  assert.equal(out.action, CONTRADICTION_ACTION.SUPERSEDE_BY_CORRECTION);
  assert.deepEqual(transitions.map(x => [x.targetId, x.toState, x.supersededBy]), [['old', 'superseded', 'new']]);
});

test('unresolved contradiction marks both claims disputed without deleting either', async () => {
  const claims = new Map([
    ['a', base('a', { object: { literal: 'growth' } })],
    ['b', base('b', { object: { literal: 'retention' } })],
  ]);
  const transitions = [];
  const out = await runClaimContradictionJob({ ownerId: 'owner:a', payload: { incomingClaimId: 'b', existingClaimId: 'a' } }, {
    loadClaim: async (id, owner) => owner === 'owner:a' ? claims.get(id) : null,
    applyTransition: async input => { transitions.push(input); return input; },
  });
  assert.equal(out.ok, true);
  assert.equal(out.action, CONTRADICTION_ACTION.DISPUTED);
  assert.deepEqual(transitions.map(x => x.targetId).sort(), ['a', 'b']);
  assert.ok(transitions.every(x => x.toState === 'disputed'));
});

test('rerunning an already-applied supersession is idempotent', async () => {
  const claims = new Map([
    ['old', base('old', { state: 'superseded', supersededBy: 'new', object: { literal: 'growth' } })],
    ['new', base('new', { object: { literal: 'retention' }, sourceKind: 'user_correction' })],
  ]);
  let calls = 0;
  const out = await runClaimContradictionJob({ ownerId: 'owner:a', payload: { incomingClaimId: 'new', existingClaimId: 'old' } }, {
    loadClaim: async id => claims.get(id),
    applyTransition: async input => { calls++; return input; },
  });
  assert.equal(out.idempotent, true);
  assert.equal(calls, 0);
});

console.log('E9 contradiction worker: 3/3 assertions passed');
