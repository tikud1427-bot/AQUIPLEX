/**
 * Capture Integrity V1 (2026-11-10, Sprint 4) — regression tests for three source
 * defects found by the Sprint 3 benchmark, end to end through memoryObserve:
 *
 *   1. questions were extracted as user facts ("Where does my sister work?" → siblings: Work)
 *   2. numbers were truncated at a thousands separator ("earn 58,000" → "… and earn 58")
 *   3. questions/requests were recorded as user goals ("Can you help me plan my training…")
 *
 * and that legitimate capture is preserved, with provenance and confidence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-capture-integrity-'));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && k !== 'AQUA_DATA_DIR') delete process.env[k];
  if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;

const engine = await import('../engine.js');
const { getFacts } = await import('../longTermMemory.js');
const { peekMind } = await import('../../mind/mindStore.js');
const { extractFactsWithReport } = await import('../memoryExtractor.js');
const { truncatedNumber } = await import('../candidateExtractor.js');

let n = 0;
function person(lines) {
  const owner = `user:capture-${++n}`;
  lines.forEach((text, i) => {
    engine.memoryObserve(owner, { userMessage: text, conversationId: `${owner}-c${i}`, userId: owner, requestId: `r${n}-${i}`, extractMessage: text });
    engine.memoryAfterTurn(owner, {});
  });
  return owner;
}
const facts = owner => Object.fromEntries(getFacts(owner).map(f => [f.key, f]));
const factText = owner => JSON.stringify(getFacts(owner).map(f => [f.key, f.value]));
const goals = owner => Object.values(peekMind(owner)?.goals ?? {}).map(g => g.title);
const keys = s => extractFactsWithReport(s).facts.map(f => `${f.key}=${typeof f.value === 'string' ? f.value : JSON.stringify(f.value)}`);

// ── 1. Questions are not facts ───────────────────────────────────────────────
test('a question about the user stores no fact', () => {
  for (const q of ['Where does my sister work?', "What's my dog called?", 'Is my sister called Ana?', 'Do I have any siblings?',
    'How old is my daughter?', "What's my partner's name?", 'Should I take the Brightmoor offer?'])
    assert.deepEqual(keys(q), [], q);
});

test('a request stores no fact from its object ("Plan a dinner for my partner and me" is not spouse: And)', () => {
  for (const q of ['Plan a dinner for my partner and me on Saturday.', 'Write a birthday message for my sister.', 'Help me plan a trip with my brother.'])
    assert.deepEqual(keys(q), [], q);
});

test('a hypothetical stores no fact', () => {
  for (const q of ['If I moved to Lisbon, would I be happier?', 'What if I worked at Google?', 'Suppose I earned 80,000 a year.'])
    assert.deepEqual(keys(q), [], q);
});

test('end to end: a person who only asks questions has no stored facts and no goals', () => {
  const o = person(['Where does my sister work?', "What's my dog called?", 'Can you help me plan my training this week?', 'Is my sister called Ana?']);
  assert.equal(getFacts(o).length, 0, factText(o));
  assert.deepEqual(goals(o), []);
});

test('a statement before a question is still captured ("I live in Leeds, can you recommend a gym?")', () => {
  assert.deepEqual(keys('I live in Leeds, can you recommend a gym?'), ['city=Leeds']);
});

// ── 2. Numbers are not truncated ─────────────────────────────────────────────
test('a value is never stored with a number cut at its separator', () => {
  const o = person(['I work as a nurse manager at St Aldric Hospital and earn 58,000 a year.']);
  const f = facts(o);
  assert.equal(f.workplace?.value, 'St Aldric Hospital', 'the employer ends where the new predicate begins');
  assert.doesNotMatch(factText(o), /earn 58(?!,)/, `no truncated 58: ${factText(o)}`);
  assert.equal(f.profession?.value, 'nurse manager');
});

test('digit-aware terminators: thousands separators and decimals stay inside the value', () => {
  assert.deepEqual(keys('My salary is 58,000.'), ['custom_salary=58,000']);
  assert.ok(!keys("I'm a designer at Fenwick, and I earn 3.5k a month.").some(k => /\b3$/.test(k)));
});

test('truncatedNumber: the defence-in-depth check behind the patterns', () => {
  assert.equal(truncatedNumber('St Aldric Hospital and earn 58', 'I work at St Aldric Hospital and earn 58,000 a year.'), true);
  assert.equal(truncatedNumber('3', 'it costs 3.5 million'), true);
  assert.equal(truncatedNumber('58,000', 'I earn 58,000 a year.'), false);
  assert.equal(truncatedNumber('217', 'my locker is 217.'), false, 'a sentence-final period is not a decimal');
  assert.equal(truncatedNumber('Northbeam', 'I work at Northbeam, 3 days a week.'), false);
});

test('organisation names joined by "and" stay whole', () => {
  assert.deepEqual(keys('I work at Marks and Spencer.'), ['workplace=Marks and Spencer']);
});

// ── 3. Questions and requests are not goals ──────────────────────────────────
test('a task request is not a goal, in the fact store or the Mind', () => {
  const o = person(['Can you help me plan my training this week?', 'Plan my wedding.', 'Should we plan to hire two engineers?', 'Help me write an email to my landlord.']);
  assert.equal(facts(o).goal, undefined, factText(o));
  assert.deepEqual(goals(o), []);
});

test('a stated goal is still a goal; an aspiration said as a request still is too', () => {
  const o = person(['My goal is to run a marathon.', 'I want to learn Italian this year.', 'Help me become a billionaire within a year.']);
  const g = goals(o).join(' | ');
  assert.match(g, /run a marathon/);
  assert.match(g, /learn Italian/);
  assert.match(JSON.stringify(facts(o).goal?.value), /become a billionaire/);
});

test('a goal stated before a request is kept ("I need to ship the beta, can you help?")', () => {
  const o = person(['I need to ship the beta, can you help?']);
  assert.match(goals(o).join(' | '), /ship the beta/);
});

// ── Provenance and confidence ────────────────────────────────────────────────
test('a stored fact carries what the sentence did; a prediction is captured only as hedged', () => {
  const [f] = extractFactsWithReport('I live in Bristol.').facts;
  assert.equal(f.metadata.speechAct, 'assertion');
  const [r] = extractFactsWithReport('Remember that my locker is 217.').facts;
  assert.equal(r.metadata.speechAct, 'remember');
  assert.equal(r.sourceText, 'Remember that my locker is 217.', 'provenance is the whole sentence the user said');
  for (const f2 of extractFactsWithReport("I'll probably be working at Google next year.").facts) assert.equal(f2.metadata.hedged, true, f2.key);
});

test('an uncertain value never replaces a confirmed one', () => {
  const o = person(['I work at Fenwick.', "I'm thinking about joining Brightmoor as a QA lead."]);
  assert.equal(facts(o).workplace?.value, 'Fenwick');
});

// ── Legitimate capture preserved ─────────────────────────────────────────────
test('legitimate statements still store what they always did', () => {
  assert.deepEqual(keys('My sister Ana is a vet.'), ['siblings=Ana']);
  assert.deepEqual(keys("I'm 41."), ['age=41']);
  assert.ok(keys('I live in Aarhus with my two cats.').includes('city=Aarhus'));
  assert.deepEqual(keys('Remember that my locker is 217.'), ['custom_locker=217']);
});

test('a job change said as an event is captured ("I just started a new job at Northbeam", "joined X as")', () => {
  assert.deepEqual(keys('I just started a new job at Northbeam.'), ['workplace=Northbeam']);
  assert.ok(keys('Big news: I quit Hendry & Ross and joined Calder Legal as a solicitor.').includes('workplace=Calder Legal'));
  assert.ok(!keys('I joined a gym as a beginner.').some(k => k.startsWith('workplace=')));
  assert.ok(!keys('My brother quit and joined Calder Legal as a clerk.').some(k => k.startsWith('workplace=')), 'not the user');
});
