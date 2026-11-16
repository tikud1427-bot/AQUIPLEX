/**
 * PWI benchmark harness — the truth replay and the scoring rules, on synthetic
 * inputs (2026-11-15). The benchmark's numbers are only as good as these.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = path.join(HERE, '..', 'pwi', 'dataset', 'pwi-v1.json');
const T = await import('../pwi/truth.mjs');
const S = await import('../pwi/score.mjs');
const { dataset } = T.loadDataset(DS);
const p1 = dataset.personas.find(p => p.id === 'p1');
const p2 = dataset.personas.find(p => p.id === 'p2');
const cur = (t, slot) => t.slots[slot].current.map(v => v.value);

test('the dataset is valid and matches its frozen hash', () => {
  assert.deepEqual(T.validateDataset(dataset), { personas: 4, probes: 32 });
  const frozen = fs.readFileSync(`${DS}.sha256`, 'utf8').split(/\s+/)[0];
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(DS)).digest('hex'), frozen);
});

test('truth replay: set/end/correct/delete/hedge move values to the right state per stage', () => {
  const A = T.truthAt(p1, 'A'), B = T.truthAt(p1, 'B'), C = T.truthAt(p1, 'C');
  assert.deepEqual(cur(A, 'city'), ['Lisbon']);
  assert.deepEqual(cur(C, 'city'), ['Porto']);
  assert.deepEqual(C.slots.city.past.map(v => v.value), ['Lisbon']);
  assert.deepEqual(B.slots.city.hedged.map(v => v.value), ['Berlin'], 'a hedge is never current');
  assert.deepEqual(cur(B, 'blocker'), ['payments integration']);
  assert.deepEqual(cur(C, 'blocker'), [], 'ended');
  assert.deepEqual(C.slots.runway.wrong.map(v => v.value), ['11 months'], 'a correction makes the old value WRONG, not past');
  assert.deepEqual(C.slots.sister.deleted.map(v => v.value), ['Rosalind']);
  assert.ok(T.deletedValues(C).some(v => v.value === 'Leeds'), 'extra deleted strings');
  assert.equal(T.deletedValues(C).filter(v => T.norm(v.value).includes('rosalind')).length, 1, 'a deleted value and its entity are one item');
  assert.ok(!C.entities.some(e => e.id === 'rosalind') && C.deletedEntities.some(e => e.id === 'rosalind'));
});

test('probe resolution: requirements follow the truth; ended and changed values become stale checks', () => {
  const q = p1.probes.find(x => x.id === 'p1-hire');
  const r = T.resolveProbe(p1, q, T.truthAt(p1, 'C'));
  assert.deepEqual(r.required.map(v => v.value).sort(), ['$400,000', '14 months', '2 engineers', 'April 30'].sort());
  assert.deepEqual(r.staleChecks.map(v => `${v.kind}:${v.value}`).sort(), ['past:3 engineers', 'past:March 14', 'past:payments integration', 'wrong:11 months'].sort());
  assert.ok(!r.irrelevant.some(v => v.slot === 'name'), 'the identity card is not counted as irrelevant');
  assert.ok(r.irrelevant.some(v => v.value === 'Porto'));
  const past = T.resolveProbe(p1, p1.probes.find(x => x.id === 'p1-before'), T.truthAt(p1, 'C'));
  assert.deepEqual(past.required.map(v => `${v.kind}:${v.value}`), ['past:Lisbon']);
});

test('matching: whole tokens, accents and case folded', () => {
  assert.ok(T.mentions('Manager: Teodor Ilic', ['Ilić']));
  assert.ok(T.mentions('ATLAS launch', 'Atlas'));
  assert.ok(!T.mentions('Atlassian', 'Atlas'));
  assert.ok(T.mentions('raised $400,000.', '400,000'));
});

test('marking: graph arrows are not change markers; history words and dated quotes are', () => {
  assert.equal(T.occurrences('- user —works_on→ Lisbon office', 'Lisbon').unmarked.length, 1);
  assert.equal(T.occurrences('- City: Porto (previously: Lisbon)', 'Lisbon').marked.length, 1);
  assert.equal(T.occurrences('[2026-01-08 · another conversation] I live in Lisbon.', 'Lisbon').marked.length, 1);
  assert.equal(T.occurrences('- City: Lisbon', 'Lisbon').unmarked.length, 1);
});

const store = (over = {}) => ({ facts: [], mind: { beliefs: {}, goals: {}, working: { blockers: [], deadlines: [], openQuestions: [] }, graph: { nodes: {}, edges: {} }, episodes: {} }, evidence: [], ...over });

test('probe scoring: required/stale/deleted/leak/irrelevant on a synthetic context', () => {
  const q = p1.probes.find(x => x.id === 'p1-city');
  const truth = T.truthAt(p1, 'C');
  const ctx = [
    '- City: Lisbon',                                  // stale, unmarked → failure
    '[2026-04-02 · another conversation] Also, I moved to Porto in March.',   // required, via a quote
    '- sister: Rosalind',                              // deleted → violation
    '- Employer: Corvantis',                           // another user's canary → leak (not "Teodor": p1 has a Teodor too)
    '- runway: 14 months',                             // irrelevant to "where do I live"
  ].join('\n');
  const r = S.scoreProbe(p1, q, truth, ctx, ['Ilić', 'Corvantis'], S.storeViews(store()));
  assert.equal(r.completeness, 1);
  assert.equal(r.stale.find(s => s.value === 'Lisbon').unmarked, true);
  assert.deepEqual(r.deleted, ['Rosalind']);
  assert.deepEqual(r.leaks, ['Corvantis']);
  assert.deepEqual(r.irrelevant.map(i => i.value), ['14 months']);
  assert.equal(r.precision, 0.5);
});

test('probe scoring: a miss is attributed to capture or retrieval', () => {
  const q = p2.probes.find(x => x.id === 'p2-work');
  const truth = T.truthAt(p2, 'C');
  const stored = S.storeViews(store({ facts: [{ key: 'workplace', value: 'Lindqvist Institute' }] }));
  assert.equal(S.scoreProbe(p2, q, truth, 'nothing here', [], stored).required[0].miss, 'retrieval');
  assert.equal(S.scoreProbe(p2, q, truth, 'nothing here', [], S.storeViews(store())).required[0].miss, 'capture');
});

test('store scoring: change recorded as history, stale current value, deletion found in the Mind, source-text-only', () => {
  const truth = T.truthAt(p1, 'C');
  const snap = store({
    facts: [
      { key: 'city', value: 'Porto', history: [{ value: 'Lisbon' }], transitions: [] },
      { key: 'runway', value: '11 months', history: [] },                       // corrected value still current → stale
      { key: 'family', value: 'nurse', sourceText: 'My sister Rosalind is a nurse in Leeds.' },
    ],
    mind: { beliefs: {}, goals: {}, working: { blockers: [], deadlines: [], openQuestions: [] },
      graph: { nodes: { a: { key: 'person:rosalind', type: 'person', label: 'Rosalind' } }, edges: {} }, episodes: {} },
  });
  const r = S.scoreStore(p1, truth, snap, []);
  assert.equal(r.changes.find(c => c.slot === 'city').recordedAsHistory, true);
  assert.equal(r.changes.find(c => c.slot === 'runway').stillCurrent.facts, true);
  const ros = r.deletion.find(d => d.value === 'Rosalind');
  assert.equal(ros.found.mind, true);
  assert.equal(ros.factsDetail.sourceTextOnly, true);
  assert.deepEqual(r.entities.deletedEntityNodes, ['Rosalind']);
});

test('an unknown is acknowledged only by a line about that thing (not by fixed instructions)', () => {
  const header = 'Reading these: a newer statement about the same thing replaces an older one, and an "uncertain" note means the user has not said';
  assert.equal(S.unknownAcknowledged([header], 'annual revenue'), false);
  assert.equal(S.unknownAcknowledged(['- Not known: annual revenue — ask once if it matters'], 'annual revenue'), true);
  assert.equal(S.unknownAcknowledged(['- Not known: salary'], 'annual revenue'), false);
});

test('persistence compares measurements, not prompt bytes', () => {
  const a = { probes: [{ persona: 'p1', probe: 'x', required: [{ present: true }], stale: [], irrelevant: [], deleted: [], leaks: [] }],
    perPersona: { p1: { claims: [], changes: [], deletion: [], entities: { tp: 1, predicted: 1 }, relations: { tp: 0, predicted: 0 } } } };
  const b = JSON.parse(JSON.stringify(a));
  assert.equal(S.persistence(a, b).identical, 1);
  b.probes[0].required[0].present = false;
  assert.deepEqual(S.persistence(a, b).probeDiffs, ['p1/x']);
});
