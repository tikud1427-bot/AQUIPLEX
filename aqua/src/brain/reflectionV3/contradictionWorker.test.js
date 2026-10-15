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

// D6: the commit keeps the revision marker in the evidence locator; the worker
// must read it from there (claimWithEvidence returns evidence rows, not flags).
test('a revision recorded in the evidence locator supersedes the older claim (polarity flip on a many-valued predicate)', async () => {
  const claims = new Map([
    ['go', base('go', { predicate: 'uses', object: { entity: 'Go', entityId: 'e:go' } })],
    ['not-go', base('not-go', { predicate: 'uses', polarity: 'negated', object: { entity: 'Go', entityId: 'e:go' },
      assertedAt: '2026-09-18T11:00:00Z', evidence: [{ role: 'primary', locator: { segmentStart: 0, segmentEnd: 30, revision: true } }] })],
  ]);
  const transitions = [];
  const out = await runClaimContradictionJob({ ownerId: 'owner:a', payload: { incomingClaimId: 'not-go', existingClaimId: 'go' } }, {
    loadClaim: async id => claims.get(id),
    applyTransition: async input => { transitions.push(input); return input; },
  });
  assert.equal(out.action, CONTRADICTION_ACTION.SUPERSEDE_OLDER);
  assert.deepEqual(transitions.map(x => [x.targetId, x.toState, x.supersededBy]), [['go', 'superseded', 'not-go']]);
});

test('the same flip WITHOUT a revision marker is still disputed', async () => {
  const claims = new Map([
    ['go', base('go', { predicate: 'uses', object: { entity: 'Go', entityId: 'e:go' } })],
    ['not-go', base('not-go', { predicate: 'uses', polarity: 'negated', object: { entity: 'Go', entityId: 'e:go' }, assertedAt: '2026-09-18T11:00:00Z' })],
  ]);
  const transitions = [];
  const out = await runClaimContradictionJob({ ownerId: 'owner:a', payload: { incomingClaimId: 'not-go', existingClaimId: 'go' } }, {
    loadClaim: async id => claims.get(id),
    applyTransition: async input => { transitions.push(input); return input; },
  });
  assert.equal(out.action, CONTRADICTION_ACTION.DISPUTED);
});

// Pass 2 (2026-10-11): a future value wins, but only from its start date.
test('a FUTURE winner is scheduled, not applied: the current value stays current until valid_from', async () => {
  const claims = new Map([
    ['claire', base('claire', { predicate: 'reports_to', object: { entityId: 'e:claire' } })],
    ['priya', base('priya', { predicate: 'reports_to', object: { entityId: 'e:priya' }, validFrom: '2026-11-01T00:00:00Z',
      sourceKind: 'user_correction', assertedAt: '2026-10-11T10:00:00Z' })],
  ]);
  const transitions = [];
  const scheduled = [];
  const job = { ownerId: 'owner:a', payload: { incomingClaimId: 'priya', existingClaimId: 'claire' } };
  const deps = {
    loadClaim: async id => claims.get(id),
    applyTransition: async input => { transitions.push(input); return input; },
    scheduleAt: async s => { scheduled.push(s); },
  };
  const before = await runClaimContradictionJob(job, { ...deps, now: () => Date.parse('2026-10-11T12:00:00Z') });
  assert.equal(before.resolved, false);
  assert.equal(before.scheduled, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(transitions, [], 'nothing retired before the change takes effect');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].runAfter, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(scheduled[0].payload, job.payload, 'the SAME job re-runs on the date');

  // On the date the scheduled job re-runs and the supersession applies.
  const after = await runClaimContradictionJob(job, { ...deps, now: () => Date.parse('2026-11-01T00:00:05Z') });
  assert.equal(after.resolved, true);
  assert.deepEqual(transitions.map(x => [x.targetId, x.toState, x.supersededBy]), [['claire', 'superseded', 'priya']]);
});
