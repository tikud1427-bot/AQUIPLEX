/**
 * "Context used" under an answer (2026-10-28, faithfulness 2026-10-29) —
 * contextUsedItems.
 *
 * What the user is shown must be exactly what the model was given, in their
 * terms: real retrieval output in, the real prompt formatter between, nothing
 * internal, nothing invented, and enough to forget or correct each item.
 * Every case builds the prompt with the production formatter
 * (formatFactsForPrompt) and checks the list against it.
 *
 * The live check (a real provider turn, the prompt captured at
 * buildSystemPrompt) is in CONTEXT_VALIDATION_2026-10-29.md.
 * Run: node scripts/run-tests.mjs src/routes/tests/contextUsed.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-context-used-'));
process.env.AQUA_DATA_DIR = TMP;

const { contextUsedItems } = await import('../chat.js');
const ltm = await import('../../memory/longTermMemory.js');
const { retrieveRelevantFacts, formatFactsForPrompt } = await import('../../memory/memoryRetriever.js');

const CLAIM = '0b7f8a8e-3c1d-4e2a-9f10-1a2b3c4d5e6f';
const KNOWLEDGE = '- You launch the beta on November 3 — "We launch the beta on November 3."';
/** A system prompt the way buildSystemPrompt lays it out: memory block, then fenced context. */
const promptWith = (facts, knowledge = '') => ['SYSTEM', formatFactsForPrompt(facts), knowledge ? `<<fence>>\n${knowledge}\n<</fence>>` : ''].join('\n\n');
const fact = (key, value, confidence = 0.9) => ({ key, value, confidence });

test('real retrieval output becomes labelled items with a forget key', () => {
  const owner = 'user:ctx-used';
  ltm.storeFact(owner, { key: 'city', value: 'Guwahati', confidence: 0.9, importance: 6, ts: Date.now() });
  ltm.storeFact(owner, { key: 'favorite_language', value: 'typescript', confidence: 0.9, importance: 6, ts: Date.now() });
  const facts = retrieveRelevantFacts(owner, 'where do I live?', 10);
  const items = contextUsedItems(facts, [], { systemPrompt: promptWith(facts) });
  const city = items.find(i => i.key === 'city');
  assert.ok(city, JSON.stringify(items));
  assert.deepEqual(city, { kind: 'fact', key: 'city', label: 'City', text: 'Guwahati' });
});

test('a retrieved fact the prompt formatter left out is NOT listed (0.5 ≤ confidence < 0.55)', () => {
  const facts = [fact('city', 'Guwahati', 0.9), fact('favorite_food', 'momos', 0.52)];
  const prompt = promptWith(facts);
  assert.doesNotMatch(prompt, /momos/, 'precondition: the formatter drops it');
  const items = contextUsedItems(facts, [], { systemPrompt: prompt });
  assert.deepEqual(items.map(i => i.key), ['city']);
});

test('nothing is listed without the prompt it was supposedly in', () => {
  const facts = [fact('city', 'Guwahati')];
  assert.deepEqual(contextUsedItems(facts, []), []);
  assert.deepEqual(contextUsedItems(facts, [], { systemPrompt: 'SYSTEM only — no memory block' }), []);
});

test('canonical claims are shown in the user\'s words, with the id that corrects them — only when their block is in the prompt', () => {
  const items = [
    { kind: 'fact', id: CLAIM, statement: 'We launch the beta on November 3.', disputed: false, score: 0.9, lanes: ['lexical'], slotIds: ['x'], understood: { subject: 'You', predicate: 'deadline_for', object: 'November 3' } },
    { kind: 'fact', id: 'pic:123', statement: 'not a canonical claim' },
    { kind: 'entity', id: CLAIM, statement: 'entity, not a fact' },
    { kind: 'fact', id: '1c2d3e4f-0000-4000-8000-000000000000', statement: 'Old plan', superseded: true },
  ];
  assert.deepEqual(contextUsedItems([], items, { systemPrompt: promptWith([], KNOWLEDGE), knowledgeContext: KNOWLEDGE }),
    [{ kind: 'claim', id: CLAIM, text: 'We launch the beta on November 3.', disputed: false, value: 'November 3' }]);
  // The block was scrubbed or never built into this prompt → no claim is claimed.
  assert.deepEqual(contextUsedItems([], items, { systemPrompt: promptWith([]), knowledgeContext: KNOWLEDGE }), []);
  assert.deepEqual(contextUsedItems([], items, { systemPrompt: promptWith([], KNOWLEDGE), knowledgeContext: '' }), []);
});

test('custom_ facts have no heading; collections are distinct items; duplicates collapse; bounded', () => {
  const facts = [
    fact('custom_student_with_almost_zero_networth', 'student with almost zero networth'),
    fact('goal', ['become a billionaire', 'becoming a billionaire', 'launch the beta']),
    fact('city', 'Guwahati'),
    fact('city_dup', 'guwahati'),
  ];
  const items = contextUsedItems(facts, [], { systemPrompt: promptWith(facts) });
  assert.equal(items[0].label, null);
  assert.equal(items[1].text, 'Become a billionaire, Launch the beta');
  assert.equal(items.filter(i => /guwahati/i.test(i.text)).length, 1);
  const many = Array.from({ length: 20 }, (_, i) => fact(`k${i}`, `value ${i}`));
  assert.equal(contextUsedItems(many, [], { systemPrompt: promptWith(many) }).length, 8);
});

test('nothing injected → no items (the disclosure is absent on trivial answers)', () => {
  assert.deepEqual(contextUsedItems([], [], { systemPrompt: 'SYSTEM' }), []);
  assert.deepEqual(contextUsedItems(undefined, null), []);
  const empty = [fact('x', ''), { value: 'no key', confidence: 0.9 }];
  assert.deepEqual(contextUsedItems(empty, [], { systemPrompt: promptWith(empty) }), []);
});

test('the response payload checks against the prompt this turn built (source pin)', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'chat.js'), 'utf8');
  assert.match(src, /contextUsedItems\(relevantFacts, prep\?\.knowledgeItems, \{ systemPrompt: prep\?\.systemPrompt, knowledgeContext: prep\?\.knowledgeContext \}\)/);
  assert.match(src, /items\.length \? \{ contextUsed: \{ items \} \} : \{\}/);
});
