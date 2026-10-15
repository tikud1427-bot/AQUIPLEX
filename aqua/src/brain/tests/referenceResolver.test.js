import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReference, resolveReferences } from '../understanding/referenceResolver.js';
import { TIER } from '../understanding/entityResolution.js';

const prov = name => ({ entityId: null, tier: TIER.PROVISIONAL, provisional: true, proposedName: name, normalized: name.toLowerCase() });
const claim = (subject, over = {}) => ({ subject, predicate: 'has_status', objectKind: 'literal', object: { literal: 'x' },
  resolution: { subject: prov(subject), object: { entityId: null, reason: 'not-an-entity-object' }, ready: false, blockedBy: 'subject:new-provisional' }, ...over });
const lookup = (m = {}) => ({ pronoun: async () => m.pronoun ?? [], role: async () => m.role ?? [], headNoun: async () => m.head ?? [] });

test('classification', () => {
  assert.equal(classifyReference('it').method, 'pronoun');
  assert.deepEqual(classifyReference('my company').predicates, ['works_at', 'member_of', 'founded']);
  assert.equal(classifyReference('our team').method, 'role');
  assert.equal(classifyReference('our office').unresolvable, true, 'a location role is never resolved on write');
  assert.equal(classifyReference('the launch').head, 'launch');
  assert.equal(classifyReference('Quillbase'), null);
});

test('exactly one candidate resolves, and records how', async () => {
  const { claims, stats } = await resolveReferences([claim('my company')], lookup({ role: [{ label: 'Quillbase', via: 'self works_at', claimId: 'c1' }] }));
  assert.equal(claims[0].resolution.subject.proposedName, 'Quillbase');
  assert.deepEqual(claims[0]._references, [{ end: 'subject', surface: 'my company', method: 'role', resolvedTo: 'Quillbase', via: 'self works_at' }]);
  assert.equal(stats.resolved, 1);
});

test('several candidates stay UNRESOLVED with the ambiguity recorded — never a guess', async () => {
  const { claims, stats } = await resolveReferences([claim('our team')], lookup({ role: [{ label: 'Platform' }, { label: 'Growth' }] }));
  assert.equal(claims[0].resolution.subject.proposedName, 'our team');
  assert.equal(claims[0].resolution.subject.reference.outcome, 'ambiguous');
  assert.equal(claims[0].resolution.blockedBy, 'subject:ambiguous-reference');
  assert.equal(stats.ambiguous, 1);
});

test('no candidate stays unresolved; a mintable name is untouched', async () => {
  const { claims } = await resolveReferences([claim('my manager'), claim('Quillbase')], lookup());
  assert.equal(claims[0].resolution.subject.reference.outcome, 'unresolved');
  assert.equal(claims[1].resolution.subject.reference, undefined);
});

test('reference outcomes are counted in the E6 metrics (/metrics: aqua_e6_ref_*)', async () => {
  const { logE6Turn, getMetrics, _resetE6Metrics } = await import('../../core/observability.js');
  _resetE6Metrics();
  logE6Turn({ ownerId: 'o', conversationId: 'c', ms: 1, result: { stats: { admitted: 1, s6: { ready: 1, references: { resolved: 2, ambiguous: 1, unresolved: 3 } } } } });
  const e6 = getMetrics().e6;
  assert.deepEqual([e6.refResolved, e6.refAmbiguous, e6.refUnresolved], [2, 1, 3]);
  _resetE6Metrics();
});
