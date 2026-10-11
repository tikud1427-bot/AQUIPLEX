import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { selectWorldCore, WORLD_CORE_HEADER } from './worldCore.js';

const NOW = Date.parse('2026-10-11T12:00:00Z');
let n = 0;
const c = (statement, extra = {}) => ({
  claimId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  statement, state: 'active', assertedAt: new Date(NOW - (100 - n) * 60_000).toISOString(), ...extra,
});

describe('worldCore — the current-world section', () => {
  test('superseded, archived and closed-past claims are not current; future-dated ones are labelled', () => {
    const r = selectWorldCore([
      c('I report to Mei Tan', { state: 'superseded' }),
      c('Old note', { state: 'archived' }),
      c('I lived in Kyoto until 2023', { validTo: '2023-12-31T23:59:59Z' }),
      c('I now report to Daniel Koh'),
      c("I'm moving to Kuala Lumpur in January", { validFrom: '2027-01-01T00:00:00Z' }),
    ], { now: NOW });
    assert.deepEqual(r.lines, ['• "I now report to Daniel Koh"', `• "I'm moving to Kuala Lumpur in January" (scheduled from 2027-01-01 — not yet current)`]);
    assert.equal(r.considered, 2);
    assert.ok(r.block.startsWith(WORLD_CORE_HEADER));
  });

  test('one line per source sentence; a sentence already rendered for any of its claims is not repeated', () => {
    const go = c('We use PostgreSQL and Go');
    const pg = { ...c('We use PostgreSQL and Go'), statement: 'We use PostgreSQL and Go' };
    const shown = c('Nadia will replace Tomás as tech lead');
    const twin = { ...c('x'), statement: 'Nadia will replace Tomás as tech lead', polarity: 'negated' };
    const r = selectWorldCore([go, pg, shown, twin, c('My manager is Grace Liu.')],
      { now: NOW, excludeIds: [shown.claimId], excludeTexts: ['My manager is Grace Liu'] });
    assert.deepEqual(r.lines, ['• "We use PostgreSQL and Go"']);
    assert.equal(r.claimIds.length, 2, 'both claims of the sentence are accounted to the one line');
  });

  test('rendered oldest → newest; the budget keeps relevance first, then recency', () => {
    const a = c('Splitpay launches December 16');
    const b = c('I prefer short numbered lists');
    const d = c('I am allergic to shellfish');
    const scores = new Map([[a.claimId, 0.8]]);
    const budget = WORLD_CORE_HEADER.length + 1 + `• "${a.statement}"`.length + 1 + `• "${d.statement}"`.length + 1;
    const r = selectWorldCore([d, b, a], { now: NOW, scores, charBudget: budget });
    // a (most relevant) and d (most recent of the rest) fit; b is omitted.
    assert.deepEqual(r.lines, [`• "${a.statement}"`, `• "${d.statement}"`]);
    assert.equal(r.omitted, 1);
    assert.ok(r.chars <= budget);
  });

  test('a sentence that also carried a RETIRED claim is never quoted: current readings only, or nothing', () => {
    const fennel = c('My biggest client is a restaurant called Fennel.', { predicate: 'is_a' });
    const plain = c('I prefer short bullet answers');
    const reading = x => (x.predicate === 'is_a' ? 'Fennel is restaurant' : null);
    const r = selectWorldCore([fennel, plain], { now: NOW, retiredTexts: ['My biggest client is a restaurant called Fennel'], reading });
    assert.deepEqual(r.lines, ['• Fennel is restaurant', '• "I prefer short bullet answers"']);
    const none = selectWorldCore([fennel], { now: NOW, retiredTexts: [fennel.statement] });
    assert.deepEqual(none.lines, [], 'no reading → left out, never re-quoted');
  });

  test('precision, not a dump: relevant and personal facts first, unrelated background capped', () => {
    const bg = Array.from({ length: 10 }, (_, i) => c(`Background fact number ${i}`, { predicate: 'has_property' }));
    const pref = c('I am vegan', { predicate: 'prefers' });
    const rel = c('The kiln repair is booked', { predicate: 'has_status' });
    const r = selectWorldCore([...bg, pref, rel], { now: NOW, scores: new Map([[rel.claimId, 0.71]]) });
    assert.ok(r.lines.includes('• "The kiln repair is booked"'), 'the question-relevant fact is kept');
    assert.ok(r.lines.includes('• "I am vegan"'), 'the personal fact is kept');
    assert.equal(r.lines.filter(l => l.includes('Background fact')).length, 6, 'unrelated background is capped');
    assert.equal(r.omitted, 4);
  });

  test('disputed is labelled; file provenance is shown; nothing current → empty block', () => {
    const r = selectWorldCore([
      c('The launch is January 15', { state: 'disputed' }),
      c('Monthly rent: $6,400, fixed for 3 years.', { sourceKind: 'document', sourceExternalRef: 'file:lease_terms.txt:chunk:0' }),
    ], { now: NOW });
    assert.deepEqual(r.lines, [
      '• "The launch is January 15" (disputed — treat as contested)',
      '• [from uploaded file lease_terms.txt] "Monthly rent: $6,400, fixed for 3 years"',
    ]);
    assert.equal(selectWorldCore([c('x', { state: 'superseded' })], { now: NOW }).block, '');
    assert.equal(selectWorldCore(null).block, '');
  });
});

import { assembleContext } from './assembler.js';
describe('canonical lines never assert more than their source (Pass 2)', () => {
  const fact = (id, text, understood) => ({ kind: 'fact', id, text, confidence: 0.6, citations: [], entityIds: [], lanes: ['structured'],
    slotIds: [], understood, assertedAt: '2026-10-01T10:00:00Z', selectionScore: 0.9 });
  const ctx = { queryTokens: new Set(), activeProjectTokens: new Set(), activeGoalTokens: new Set(), focusEntityIds: new Set(), now: Date.now() };
  test('a hedged statement is labelled undecided; a future state is labelled scheduled', () => {
    const out = assembleContext([
      fact('a', "We're thinking about cross-border splits in version 2, nothing is decided",
        { subject: 'You', predicate: 'plans_to', object: 'cross-border splits in version 2', polarity: 'asserted', modality: 'intent' }),
      fact('b', 'From next month my manager will be Mark',
        { subject: 'You', predicate: 'reports_to', object: 'Mark', polarity: 'asserted', modality: 'fact', validFrom: '2099-01-01T00:00:00Z' }),
    ], ctx, { limit: 8, charBudget: 1600, minScore: 0, relativeFloor: 0, requireRelevance: false });
    assert.match(out.block, /• \(undecided — not decided by the user\) \(intends\) User plans to/);
    assert.match(out.block, /User reports to Mark \(scheduled from 2099-01-01 — not yet current\)/);
  });
});

describe('unknown stays unknown (Pass 2)', () => {
  test('every rendered context states that what is not listed is not known', () => {
    const ctx = { queryTokens: new Set(), activeProjectTokens: new Set(), activeGoalTokens: new Set(), focusEntityIds: new Set(), now: Date.now() };
    const out = assembleContext([{ kind: 'fact', id: 'x', text: 'I live in Toronto', confidence: 0.6, citations: [], entityIds: [], lanes: ['structured'],
      slotIds: [], understood: { subject: 'You', predicate: 'located_in', object: 'Toronto', polarity: 'asserted', modality: 'fact' },
      assertedAt: '2026-10-01T10:00:00Z', selectionScore: 0.9 }], ctx, { limit: 8, charBudget: 1600, minScore: 0, relativeFloor: 0, requireRelevance: false });
    assert.match(out.block, /not stated in this context is unknown: never invent/);
    assert.match(out.block, /User is based in Toronto/, 'the instruction does not cost the item its seat');
  });
});
