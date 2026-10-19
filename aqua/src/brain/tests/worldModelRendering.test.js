/**
 * Phase 2 (2026-10-06) — what the answer model READS from the World Model.
 *
 * The Lift diagnosis: canonical lines were the verbatim segment alone ("Rohan
 * took it over", "he handles engineering"), so the World Model's resolution
 * (subject, relation, polarity) never reached the answer; lines had no order in
 * time, so a correction and the value it replaced looked equally current; a
 * constant "(confidence 0.66)" made the model hedge; a sentence yielding two
 * readings kept only the first; and header lines silently pushed selected items
 * out of the block. Each is pinned here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext, tokensOf } from '../contextEngine/assembler.js';

const ctx = q => ({
  queryTokens: tokensOf(q), semanticScores: null, activeProjectTokens: new Set(), activeGoalTokens: new Set(),
  focusEntityIds: new Set(), priorEntityIds: new Set(), maxHops: 3,
});
const fact = (id, text, understood, assertedAt, extra = {}) => ({
  id, kind: 'fact', text, confidence: 0.66, entityIds: [`e-${id}`], via: 'structured:', lanes: ['structured'],
  understood, assertedAt, ...extra,
});
const u = (subject, predicate, object, extra = {}) => ({ subject, predicate, object, polarity: 'asserted', modality: 'fact', ...extra });

test('a canonical line carries the World Model\'s reading, the user\'s words and when — never a constant confidence', () => {
  const out = assembleContext([
    fact('a', 'Rohan took it over', u('Rohan', 'owns', 'payment integration'), '2026-10-06T10:00:00Z'),
  ], ctx('Who owns the payment integration?'), { limit: 8, charBudget: 1600 });
  assert.match(out.block, /• Rohan owns payment integration — "Rohan took it over" \[the user told Aqua in conversation\]$/m);
  assert.doesNotMatch(out.block, /confidence 0\.66/);
});

test('every canonical line says WHERE it came from (2026-10-19: the founder\'s chat message was called "an internal note")', () => {
  const out = assembleContext([
    fact('a', 'The price is now $39 per clinic per month', u('You', 'has_property', '$39 per clinic per month'), '2026-10-06T10:00:00Z', { sourceType: 'conversation' }),
    fact('b', 'Standard plan: $49 per clinic per month', u('Standard plan', 'has_property', '$49 per clinic per month'), '2026-10-06T09:00:00Z',
      { sourceType: 'document', sourceRef: 'file:tidepool_pricing.txt:chunk:0' }),
    fact('c', 'Our biggest risk is clinics not finishing onboarding', u('You', 'has_property', 'clinics not finishing onboarding'), '2026-10-06T11:00:00Z', { sourceType: 'user_correction' }),
  ], ctx('Where did you learn our current price?'), { limit: 8, charBudget: 2400 });
  assert.match(out.block, /"The price is now \$39 per clinic per month" \[the user told Aqua in conversation\]/);
  assert.match(out.block, /\[from the user's uploaded file tidepool_pricing\.txt\]/);
  assert.match(out.block, /\[the user corrected this in Aqua's Memory\]/);
  assert.doesNotMatch(out.block, /internal/i);
});

test('when-said is shown only when it informs (claims span ≥ 2 days), worded as when it was TOLD', () => {
  const one = assembleContext([
    fact('a', 'I work at Ledgerly', u('You', 'works_at', 'Ledgerly'), '2026-10-06T09:00:00Z'),
    fact('b', 'We are based in Pune', u('You', 'located_in', 'Pune'), '2026-10-06T10:00:00Z'),
  ], ctx('Where do I work and where are we based?'), { limit: 8, charBudget: 1600 });
  assert.doesNotMatch(one.block, / on \d{4}-\d{2}-\d{2}\]|said 20/, 'one day: the date is noise the model quotes as an event date');
  const two = assembleContext([
    fact('a', 'I work at Ledgerly', u('You', 'works_at', 'Ledgerly'), '2026-09-01T09:00:00Z'),
    fact('b', 'We are based in Pune', u('You', 'located_in', 'Pune'), '2026-10-06T10:00:00Z'),
  ], ctx('Where do I work and where are we based?'), { limit: 8, charBudget: 1600 });
  assert.match(two.block, /\[the user told Aqua in conversation on 2026-09-01\]/);
});

test('a claim whose validity CLOSED in the past reads as past, never as current', () => {
  const out = assembleContext([
    fact('k', 'I lived in Kyoto until 2023', u('You', 'located_in', 'Kyoto', { validTo: '2023-12-31T23:59:59.999Z' }), '2026-10-06T10:00:00Z'),
  ], ctx('Which city am I based in?'), { limit: 8, charBudget: 1600 });
  assert.match(out.block, /User is based in Kyoto \(until 2023-12-31 — past, not current\)/);
});

test('the user ("You") and the user\'s things ("my thesis") read as the user\'s; negation and intent are explicit', () => {
  const out = assembleContext([
    fact('a', 'I work at Ledgerly', u('You', 'works_at', 'Ledgerly'), '2026-10-01T00:00:00Z'),
    fact('b', 'We decided not to build an Android app', u('You', 'decided', 'an Android app', { polarity: 'negated' }), '2026-10-02T00:00:00Z'),
    fact('c', 'We want to launch by December 10', u('You', 'plans_to', 'launch by December 10', { modality: 'intent' }), '2026-10-03T00:00:00Z'),
    fact('d', 'My thesis is on protein folding', u('my thesis', 'is_a', 'protein folding'), '2026-10-04T00:00:00Z'),
  ], ctx('What do I work on?'), { limit: 8, charBudget: 1600 });
  assert.match(out.block, /• User works at Ledgerly/);
  assert.match(out.block, /• NOT: User decided an Android app/);
  assert.match(out.block, /• \(intends\) User plans to launch by December 10/);
  assert.match(out.block, /• User's thesis is protein folding/);
});

test('canonical lines are listed OLDEST → NEWEST, with the rule for conflicts', () => {
  const out = assembleContext([
    fact('new', 'Actually the launch is now January 15', u('iOS launch', 'deadline_for', 'January 15'), '2026-10-05T00:00:00Z'),
    fact('old', 'We launch on December 10', u('iOS launch', 'deadline_for', 'December 10'), '2026-09-01T00:00:00Z'),
  ], ctx('When is the iOS launch?'), { limit: 8, charBudget: 1600 });
  assert.match(out.block, /listed oldest → newest/);
  assert.ok(out.block.indexOf('December 10') < out.block.indexOf('January 15'), `not chronological:\n${out.block}`);
});

test('ONE sentence, TWO readings: "now January 15, not December 10" keeps both on one line', () => {
  const s = 'Actually the iOS launch date is now January 15, not December 10';
  const out = assembleContext([
    fact('neg', s, u('iOS launch', 'deadline_for', 'December 10', { polarity: 'negated' }), '2026-10-05T00:00:00Z'),
    fact('pos', s, u('iOS launch', 'deadline_for', 'January 15'), '2026-10-05T00:00:00Z'),
  ], ctx('When is the iOS launch?'), { limit: 8, charBudget: 1600 });
  const line = out.block.split('\n').find(l => l.includes('January 15'));
  assert.ok(line, `the new date was dropped:\n${out.block}`);
  assert.match(line, /iOS launch has the deadline January 15; NOT: iOS launch has the deadline December 10/);
  assert.equal(out.block.split('\n').filter(l => l.startsWith('•')).length, 1, 'the sentence was rendered twice');
});

test('RENDERED == SELECTED: header lines never push a selected item out of the block', () => {
  const cands = Array.from({ length: 12 }, (_, i) => fact(`f${i}`, `Fact ${i} about the Tidepool launch and its budget`,
    u('Tidepool', 'has_property', `detail number ${i} of the launch budget`), `2026-10-0${(i % 9) + 1}T00:00:00Z`));
  const out = assembleContext(cands, ctx('Tell me about the Tidepool launch budget'), { limit: 12, charBudget: 1600 });
  const rendered = out.block.split('\n').filter(l => l.startsWith('•')).length;
  assert.equal(rendered, out.items.length, `stats say ${out.items.length} selected, the model reads ${rendered}`);
  assert.ok(out.block.length <= 1600, `block ${out.block.length} chars exceeds the budget`);
});

test('legacy (non-canonical) facts render exactly as before', () => {
  const out = assembleContext([{ id: 'l', kind: 'fact', text: 'City: Lisbon', confidence: 0.8, entityIds: ['x'], via: 'lexical: 1' }],
    ctx('Which city?'), { limit: 8 });
  assert.match(out.block, /• City: Lisbon \(confidence 0\.80\)/);
});
