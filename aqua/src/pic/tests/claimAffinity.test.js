/**
 * claimAffinity — the canonical lanes' relevance gate (2026-10-17).
 *
 * THE DEFECT, AS MEASURED: the canonical read (production with Postgres)
 * applied no relevance test. A first-person question anchored on the user's
 * self entity and returned every claim about the user; on retrieval-core.v1
 * 142 of 153 noise lines came that way. These tests pin the rule the gate
 * applies to a claim: same definition as factAffinity, plus the claim's own
 * structure (predicate kind, polarity, lifecycle) and anchor provenance.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyseQuestion, claimAffinity, MIN_AFFINITY } from '../questionShape.js';

const claim = (statement, predicate, object, extra = {}) => ({
  statement, predicate, object, subject: 'You', polarity: 'asserted', state: 'active', ...extra,
});
const gate = (q, c, opts) => claimAffinity(analyseQuestion(q), c, opts);

describe('claimAffinity — canonical relevance gate', () => {
  const job = claim('I run product at Nummo', 'works_at', { kind: 'entity', label: 'Nummo' });
  const physics = claim('I studied physics before this', 'habit_of', { kind: 'literal', value: 'studied physics' });

  test('a self-anchored claim with no relevance signal does not pass ("What is my dog\'s name?")', () => {
    assert.equal(gate("What is my dog's name?", job).pass, false);
    assert.equal(gate("What is my dog's name?", physics).pass, false);
    assert.equal(gate('Who is my dentist?', job).pass, false);
  });

  test('the predicate types the answer: "Where do I work?" passes the works_at claim with no shared word', () => {
    const r = gate('Where do I work?', job, { predicateMatch: true });
    assert.equal(r.pass, true);
    assert.ok(r.score >= 0.5, `kind credit expected, got ${r.score}`);
  });

  test('a predicate cue earns nothing when the question\'s topic is unaccounted for ("Which bank do I use?")', () => {
    const notes = claim('I keep my notes in Obsidian', 'uses', { kind: 'entity', label: 'Obsidian' });
    assert.equal(gate('Which bank do I use?', notes, { predicateMatch: true }).pass, false);
  });

  test('a named anchor is topical evidence; the self entity is not', () => {
    const atlas = claim('Atlas is my side project', 'is_a', { kind: 'literal', value: 'side project' }, { subject: 'Atlas' });
    assert.equal(gate('Tell me about Atlas', atlas, { namedAnchor: true }).pass, true);
    // The same claim reached only through the self anchor must earn it lexically.
    assert.equal(gate('What should I cook tonight?', atlas, { namedAnchor: false }).pass, false);
  });

  test('a lexical match on the question\'s content words passes', () => {
    const stack = claim('We use Postgres for the substrate', 'uses', { kind: 'entity', label: 'Postgres' });
    assert.equal(gate('What database do we use for the substrate?', stack).pass, true);
  });

  test('a dense cosine passes on its own above the lane floor, never as strongly as a kind match', () => {
    const r = gate('What is my educational background?', physics, { semantic: 0.62 });
    assert.equal(r.pass, true);
    assert.ok(r.score < 0.5);
    assert.equal(gate('What is my educational background?', physics, { semantic: 0.2 }).pass, false);
  });

  test('polarity is data: a negated claim is demoted for an affirmative ask but still answers it when named', () => {
    const left = claim('I used to work at Intercom', 'works_at', { kind: 'entity', label: 'Intercom' }, { polarity: 'negated' });
    const r = gate('Do I work at Intercom?', left, { namedAnchor: true });
    assert.equal(r.polarityConflict, true);
    assert.ok(r.score >= MIN_AFFINITY, `a named, on-topic negation must stay reachable (${r.score})`);
  });

  test('a superseded claim reads as past: a "used to" question prefers it', () => {
    const old = claim('Our price is $29 per clinic per month', 'has_property', { kind: 'literal', value: '$29 per clinic per month' }, { state: 'superseded', subject: 'Our price' });
    const past = gate('What was our price before?', old);
    const now = gate('What is our price now?', old);
    assert.ok(past.score > now.score, `past ${past.score} vs now ${now.score}`);
  });

  test('accepts the worldModelRepository.claimWithEvidence shape', () => {
    const repoShape = { statementText: 'Tomás owns the calendar sync integration', predicate: 'owns', subject: 'Tomás', subjectType: 'person',
      object: { literal: 'the calendar sync integration' }, polarity: 'asserted', state: 'active' };
    assert.equal(gate('Who owns the calendar sync?', repoShape).pass, true);
  });
});
