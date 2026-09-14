import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveContradiction, CONTRADICTION_ACTION as A } from '../reflectionV3/contradictionPolicy.js';

const base = (id, extra = {}) => ({
  claimId: id,
  subjectEntityId: 'ent:1',
  predicate: 'works_at',
  createdAt: 1000,
  evidence: [{ id: `${id}:e1`, role: 'primary' }],
  ...extra,
});

test('E9/PR-1 rule 1: explicit user correction wins', () => {
  const r = resolveContradiction(base('machine'), base('user', {
    actor: 'user', sourceKind: 'user_correction',
  }));
  assert.equal(r.action, A.SUPERSEDE_BY_CORRECTION);
  assert.equal(r.winner.claimId, 'user');
  assert.equal(r.rule, 1);
  assert.equal(r.confidenceCeiling, 1);
});

test('E9/PR-1 rule 2: explicit supersession wins over recency', () => {
  const r = resolveContradiction(
    base('old', { createdAt: 9000 }),
    base('new', { createdAt: 1000, supersedes: 'old' }),
  );
  assert.equal(r.action, A.SUPERSEDE_OLDER);
  assert.equal(r.winner.claimId, 'new');
  assert.equal(r.rule, 2);
});

test('E9/PR-1 rule 3: non-overlapping validity is not a contradiction', () => {
  const r = resolveContradiction(
    base('a', { validFrom: 100, validTo: 200 }),
    base('b', { validFrom: 300 }),
  );
  assert.equal(r.action, A.NOT_CONTRADICTORY);
  assert.equal(r.rule, 3);
});

test('E9/PR-1 rule 4: corroboration is advisory unless explicitly enabled', () => {
  const r = resolveContradiction(
    base('a', { evidence: [{id:'a1'}, {id:'a2'}, {id:'a3'}] }),
    base('b', { evidence: [{id:'b1'}] }),
  );
  assert.equal(r.action, A.DISPUTED);
  assert.equal(r.rule, null);

  const enabled = resolveContradiction(
    base('a', { evidence: [{id:'a1'}, {id:'a2'}, {id:'a3'}] }),
    base('b', { evidence: [{id:'b1'}] }),
    { allowHeuristicResolution: true },
  );
  assert.equal(enabled.action, A.SUPERSEDE_OLDER);
  assert.equal(enabled.rule, 4);
  assert.equal(enabled.confidenceCeiling, 0.85);
});

test('E9/PR-1 rule 5: recency is opt-in and scoped to same subject+predicate', () => {
  const a = base('a', { createdAt: 1000 });
  const b = base('b', { createdAt: 2000 });
  assert.equal(resolveContradiction(a, b).action, A.DISPUTED);

  const r = resolveContradiction(a, b, { allowRecencyResolution: true });
  assert.equal(r.action, A.SUPERSEDE_OLDER);
  assert.equal(r.winner.claimId, 'b');
  assert.equal(r.rule, 5);
  assert.equal(r.confidenceCeiling, 0.8);
});

test('negative control: different predicates do not receive recency resolution', () => {
  const r = resolveContradiction(
    base('a', { predicate: 'works_at', createdAt: 1000 }),
    base('b', { predicate: 'lives_in', createdAt: 2000 }),
    { allowRecencyResolution: true },
  );
  assert.equal(r.action, A.DISPUTED);
});

test('user correction remains authoritative even if machine claim is newer', () => {
  const r = resolveContradiction(
    base('machine', { createdAt: 999999 }),
    base('user', { actor: 'user', createdAt: 1 }),
  );
  assert.equal(r.rule, 1);
  assert.equal(r.winner.claimId, 'user');
});
