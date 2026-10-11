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

// D6 (2026-10-05): a claim the user stated AS a change/correction (E6 rule 11,
// `revises`) is an explicit successor of the OLDER claim it conflicts with.
// Live: "not Go, it's Rust" left Go current; "I don't live in Lisbon anymore"
// left Lisbon disputed — both answered stale.
test('rule 2: a newer explicit revision supersedes the older claim, even a polarity flip on a many-valued predicate', () => {
  const r = resolveContradiction(
    base('go', { predicate: 'uses', polarity: 'asserted', createdAt: 1000 }),
    base('not-go', { predicate: 'uses', polarity: 'negated', createdAt: 2000, revises: true }),
  );
  assert.equal(r.action, A.SUPERSEDE_OLDER);
  assert.equal(r.winner.claimId, 'not-go');
  assert.equal(r.loser.claimId, 'go');
  assert.equal(r.rule, 2);
});

test('rule 2: an OLDER revision never undoes a newer statement', () => {
  const r = resolveContradiction(
    base('moved-earlier', { polarity: 'asserted', createdAt: 1000, revises: true }),
    base('denied-later', { polarity: 'negated', createdAt: 2000 }),
  );
  assert.equal(r.action, A.DISPUTED, 'the older side may not claim succession');
});

test('negative control: an UNMARKED polarity flip still stays disputed', () => {
  const r = resolveContradiction(
    base('redis', { predicate: 'uses', polarity: 'asserted', createdAt: 1000 }),
    base('no-redis', { predicate: 'uses', polarity: 'negated', createdAt: 2000 }),
  );
  assert.equal(r.action, A.DISPUTED);
});

test('rule 2: two revisions — the newer one succeeds', () => {
  const r = resolveContradiction(
    base('lisbon', { createdAt: 1000, revises: true }),
    base('porto', { createdAt: 2000, revises: true }),
  );
  assert.equal(r.winner.claimId, 'porto');
  assert.equal(r.rule, 2);
});

test('HISTORY vs PRESENT: a claim closed in the past never retires a current open claim, even as a declared snapshot', () => {
  const osaka = { claimId: 'osaka', predicate: 'located_in', subjectEntityId: 'me', validFrom: null, validTo: null,
    assertedAt: '2026-10-06T10:00:00.000Z', createdAt: '2026-10-06T10:00:00.000Z' };
  const kyoto = { claimId: 'kyoto', predicate: 'located_in', subjectEntityId: 'me', validFrom: null, validTo: '2023-12-31T23:59:59.999Z',
    assertedAt: '2026-10-06T10:05:00.000Z', createdAt: '2026-10-06T10:05:00.000Z' };
  const r = resolveContradiction(osaka, kyoto, { snapshotPair: true });
  assert.equal(r.action, 'not_contradictory');
  assert.equal(r.rule, 3);
  // …while two OPEN snapshots still resolve by recency.
  const porto = { ...kyoto, claimId: 'porto', validTo: null };
  assert.equal(resolveContradiction(osaka, porto, { snapshotPair: true }).action, 'supersede_older');
});
