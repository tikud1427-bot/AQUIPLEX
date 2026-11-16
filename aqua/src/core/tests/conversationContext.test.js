/**
 * core/conversationContext.js — the shared resolved conversation context
 * (2026-11-16 conversation recovery; audit D-02/D-03). Pure: no I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationContext, resolveReference, retrievalQueryFor, isPersonalWorldQuestion,
  referenceNote, renderRecentConversation, conversationContextStats, subjectPhrases,
} from '../conversationContext.js';

const u = (content) => ({ role: 'user', content });
const a = (content) => ({ role: 'assistant', content });
const ctxOf = (message, history, env = {}) => buildConversationContext({ message, history, conversationId: 'c1', ownerId: 'user:x', env });

test('pneumonia: "it" resolves to the subject of the previous user turn, predicate words excluded', () => {
  const h = [u('Is pneumonia curable?'), a('Often, yes.'), u('Tell me about pneumonia.'), a('Pneumonia is an infection of the lungs...')];
  const c = ctxOf('Is it curable?', h);
  assert.equal(c.reference.status, 'resolved');
  assert.deepEqual(c.reference.subjects, ['pneumonia']);
  assert.equal(c.retrievalQuery, 'Is it curable? pneumonia');
  assert.match(referenceNote(c), /points to "pneumonia"/);
  assert.match(referenceNote(c), /do not ask what it refers to/);
});

test('the antecedent is found even when the previous user turn was itself "Is pneumonia curable?" (predicate shared with the follow-up)', () => {
  const c = ctxOf('Is it curable?', [u('Is pneumonia curable?'), a('...')]);
  assert.deepEqual(c.reference.subjects, ['pneumonia']);
});

test('photosynthesis: "Why is it important?"', () => {
  const c = ctxOf('Why is it important?', [u('Explain photosynthesis.'), a('Photosynthesis converts light...')]);
  assert.deepEqual(c.reference.subjects, ['photosynthesis']);
  assert.equal(c.reference.status, 'resolved');
});

test('two entities + "which one" → resolved to the set (comparison context kept)', () => {
  const c = ctxOf('Which one is easier to scale?', [u('Compare MongoDB and PostgreSQL.'), a('...')]);
  assert.equal(c.reference.status, 'resolved');
  assert.deepEqual(c.reference.subjects, ['MongoDB', 'PostgreSQL']);
  assert.match(c.retrievalQuery, /MongoDB PostgreSQL$/);
});

test('two entities + singular "it" with nothing selecting → ambiguous (clarify only here)', () => {
  const c = ctxOf('Is it better?', [u('Compare MongoDB and PostgreSQL.'), a('...')]);
  assert.equal(c.reference.status, 'ambiguous');
  assert.deepEqual(c.reference.candidates, ['MongoDB', 'PostgreSQL']);
  assert.match(referenceNote(c), /ask which one they mean/);
});

test('topic switch: "its" binds to the most recent subject, never an older one', () => {
  const h = [u('Explain pneumonia.'), a('...'), u('Now explain cloud storage.'), a('...')];
  const c = ctxOf('What are its advantages?', h);
  assert.deepEqual(c.reference.subjects, ['cloud storage']);
  assert.doesNotMatch(c.retrievalQuery, /pneumonia/);
});

test('a chain of follow-ups walks back to the last turn that named a subject', () => {
  const h = [u('Tell me about tuberculosis.'), a('...'), u('Is it contagious?'), a('...')];
  assert.deepEqual(ctxOf('What are its symptoms?', h).reference.subjects, ['tuberculosis']);
});

test('no history → unresolved, query unchanged; no pronoun → none', () => {
  const c = ctxOf('Is it safe?', []);
  assert.equal(c.reference.status, 'unresolved');
  assert.equal(c.retrievalQuery, 'Is it safe?');
  assert.equal(ctxOf('Explain gravity.', [u('Explain photosynthesis.')]).reference.status, 'none');
});

test('a message that names its own subject is not rewritten ("Is it raining in Paris?")', () => {
  const c = ctxOf('Is it raining in Paris?', [u('Tell me about pneumonia.'), a('...')]);
  assert.equal(c.reference.status, 'own_subject');
  assert.equal(c.retrievalQuery, 'Is it raining in Paris?');
  assert.equal(referenceNote(c), '');
});

test('ordinary follow-up shapes from the spec all resolve against "Tell me about aspirin."', () => {
  const h = [u('Tell me about aspirin.'), a('...')];
  for (const q of ['Is it safe?', 'How much does it cost?', 'What are its symptoms?', 'Can I use it?', 'Explain that further.', 'Is that still true?']) {
    assert.deepEqual(ctxOf(q, h).reference.subjects, ['aspirin'], q);
  }
});

test('long conversations: only the bounded recent window is carried; lookback is bounded', () => {
  const h = [];
  for (let i = 0; i < 40; i += 1) h.push(u(`Explain topic${i}.`), a('x'.repeat(2000)));
  const c = ctxOf('Why is it important?', h);
  assert.equal(c.recent.length, 6);
  assert.ok(c.recent.every(m => m.content.length < 800), 'each carried message is clipped');
  assert.deepEqual(c.reference.subjects, ['topic39']);
});

test('the context is deep-frozen and copies its strings (no cross-stage mutation)', () => {
  const h = [u('Explain photosynthesis.'), a('...')];
  const c = ctxOf('Why is it important?', h);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.recent) && Object.isFrozen(c.reference.subjects));
  assert.throws(() => { 'use strict'; c.recent.push({}); });
  h[0].content = 'mutated';
  assert.equal(c.recent[0].content, 'Explain photosynthesis.');
});

test('personal-world detection: possessives and first-person state, not a bare "Can I"', () => {
  assert.equal(isPersonalWorldQuestion('When is my launch?'), true);
  assert.equal(isPersonalWorldQuestion('Should I hire another developer?'), true);
  assert.equal(isPersonalWorldQuestion('What did I decide about pricing?'), true);
  assert.equal(isPersonalWorldQuestion('Is pneumonia curable?'), false);
  assert.equal(isPersonalWorldQuestion('Can I use it?'), false);
  // A follow-up to a personal statement is personal.
  const c = ctxOf('When is it due?', [u('My tax filing is coming up.'), a('...')]);
  assert.equal(c.personalWorld, true);
});

test('AQUA_CONVERSATION_CONTEXT=off: no resolution, raw query (rollback)', () => {
  const c = ctxOf('Is it curable?', [u('Tell me about pneumonia.')], { AQUA_CONVERSATION_CONTEXT: 'off' });
  assert.equal(c.reference.status, 'none');
  assert.equal(c.retrievalQuery, 'Is it curable?');
  assert.equal(retrievalQueryFor('Is it curable?', c), 'Is it curable?');
});

test('renderers: recent conversation is newest-kept within budget; stats carry no text', () => {
  const h = [u('Explain photosynthesis.'), a('A'.repeat(500)), u('ok'), a('B'.repeat(500))];
  const c = ctxOf('Why is it important?', h);
  const r = renderRecentConversation(c, { maxChars: 600 });
  assert.match(r, /B{100}/);
  assert.doesNotMatch(r, /Explain photosynthesis/);
  const s = conversationContextStats(c);
  assert.deepEqual(Object.keys(s).sort(), ['augmented', 'history', 'personal', 'refStatus', 'refSubjects']);
  assert.ok(!JSON.stringify(s).includes('photosynthesis'));
});

test('subject phrases are capped and stop/predicate words never become subjects', () => {
  assert.deepEqual(subjectPhrases('Can you please tell me more about the history of Rome?'), ['Rome']);
  const c = ctxOf('Is it true?', [u(`Tell me about ${'x'.repeat(200)}.`)]);
  assert.ok(c.reference.subjects[0].length <= 60);
});
