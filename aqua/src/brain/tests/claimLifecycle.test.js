/**
 * Changing facts: the pieces that let a new value retire the old one, and
 * nothing else (2026-10-04). The end-to-end measure is
 * eval/suites/claim-lifecycle.suite.mjs; these pin each mechanism.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { contradictionBetween, dedupAndDetect } from '../understanding/claimDedup.js';
import { isDeclaredSnapshotPair, runClaimContradictionJob } from '../reflectionV3/contradictionWorker.js';
import { resolveContradiction, CONTRADICTION_ACTION } from '../reflectionV3/contradictionPolicy.js';

const c = (id, subject, predicate, object, over = {}) => ({
  claimId: id, subject, subjectEntityId: `e-${subject}`, predicate,
  objectKind: object.entity !== undefined ? 'entity' : 'literal', object,
  polarity: 'asserted', modality: 'fact', state: 'active', ...over,
});

describe('S8', () => {
  test('one-per-object: two owners of one thing compete; one owner of two things does not', () => {
    const opts = { singleObjectPredicates: new Set(['owns']) };
    const lena = c('a', 'Lena', 'owns', { entity: 'billing', entityId: 'e-b' });
    assert.equal(contradictionBetween(c('b', 'Omar', 'owns', { entity: 'billing', entityId: 'e-b' }), lena, opts).kind, 'object');
    assert.equal(contradictionBetween(c('b', 'Lena', 'owns', { entity: 'search', entityId: 'e-s' }), lena, opts).contradicts, false);
    assert.equal(contradictionBetween(c('b', 'Omar', 'owns', { entity: 'billing', entityId: 'e-b' }), lena, {}).contradicts, false,
      'without the declaration nothing fires');
  });

  test('history is never contradicted', () => {
    const fn = { functionalPredicates: new Set(['located_in']) };
    const old = c('a', 'You', 'located_in', { entity: 'Berlin' }, { state: 'superseded' });
    assert.equal(contradictionBetween(c('b', 'You', 'located_in', { entity: 'Rome' }), old, fn).reason, 'historical');
  });

  test('returning to a superseded value is a new claim, not corroboration of history', () => {
    const fn = { functionalPredicates: new Set(['located_in']) };
    const old = c('a', 'You', 'located_in', { entity: 'Berlin' }, { state: 'superseded' });
    const cur = c('b', 'You', 'located_in', { entity: 'Paris' });
    const out = dedupAndDetect([c('a2', 'You', 'located_in', { entity: 'Berlin' })], [old, cur], fn);
    assert.equal(out.evidenceAttachments.length, 0, 'evidence was attached to a superseded claim');
    assert.equal(out.contradictions.length, 1);
    assert.equal(out.contradictions[0].existing.claimId, 'b');
  });
});

describe('E9 worker: declared snapshots only', () => {
  const w = (id, subj, obj, over = {}) => ({ claimId: id, predicate: 'located_in', subjectEntityId: subj,
    object: { entityId: obj }, polarity: 'asserted', modality: 'fact', ...over });

  test('a snapshot pair needs a single-valued predicate, same subject, different value, both asserted facts', () => {
    assert.equal(isDeclaredSnapshotPair(w('a', 's', 'x'), w('b', 's', 'y')), true);
    assert.equal(isDeclaredSnapshotPair(w('a', 's', 'x'), w('b', 's', 'x')), false, 'same value');
    assert.equal(isDeclaredSnapshotPair(w('a', 's', 'x'), w('b', 't', 'y')), false, 'different subjects');
    assert.equal(isDeclaredSnapshotPair(w('a', 's', 'x'), w('b', 's', 'y', { polarity: 'negated' })), false);
    assert.equal(isDeclaredSnapshotPair(w('a', 's', 'x'), w('b', 's', 'y', { modality: 'intent' })), false);
    assert.equal(isDeclaredSnapshotPair({ ...w('a', 's', 'x'), predicate: 'uses' }, { ...w('b', 's', 'y'), predicate: 'uses' }), false,
      'uses is multi-valued');
  });

  test('the policy retires the older snapshot only when told it is one', () => {
    const older = { ...w('a', 's', 'x'), assertedAt: '2026-01-01' };
    const newer = { ...w('b', 's', 'y'), assertedAt: '2026-02-01' };
    assert.equal(resolveContradiction(newer, older, {}).action, CONTRADICTION_ACTION.DISPUTED);
    const d = resolveContradiction(newer, older, { snapshotPair: true });
    assert.equal(d.action, CONTRADICTION_ACTION.SUPERSEDE_OLDER);
    assert.equal(d.loser.claimId, 'a');
  });

  test('a loser that is already retired is a no-op, never a throw (no DLQ churn)', async () => {
    const store = {
      a: { ...w('a', 's', 'x'), state: 'superseded', supersededBy: 'z', assertedAt: '2026-01-01' },
      b: { ...w('b', 's', 'y'), state: 'active', assertedAt: '2026-02-01' },
    };
    let transitions = 0;
    const r = await runClaimContradictionJob({ ownerId: 'u', payload: { incomingClaimId: 'b', existingClaimId: 'a' } }, {
      loadClaim: async id => store[id], applyTransition: async () => { transitions++; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.alreadyRetired, true);
    assert.equal(transitions, 0);
  });
});
