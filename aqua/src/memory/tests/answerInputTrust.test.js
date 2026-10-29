/**
 * What reaches the ANSWER model about the user (2026-10-28).
 *
 * The morning's pass hid "Profession: billionaire" (stored before the
 * profession validator learned aspirations are goals) from the Memory page.
 * The retrieval path kept injecting it, so an answer could still be told the
 * user's job is "billionaire". Separately, Mind beliefs reached the prompt as
 * "trait (62%)" whether the user said it or Aqua guessed it.
 *
 * Run: node scripts/run-tests.mjs src/memory/tests/answerInputTrust.test.js
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-answer-trust-'));
process.env.AQUA_DATA_DIR = tmp;
process.chdir(tmp);

let ltm, retriever, mindSchema, beliefs, mindRetriever;
before(async () => {
  ltm           = await import('../longTermMemory.js');
  retriever     = await import('../memoryRetriever.js');
  mindSchema    = await import('../../mind/mindSchema.js');
  beliefs       = await import('../../mind/beliefEngine.js');
  mindRetriever = await import('../../mind/mindRetriever.js');
});

test('a stored aspiration-as-profession is not injected; a real profession still is', () => {
  const owner = 'trust-profession';
  ltm.storeFact(owner, { key: 'profession', value: 'billionaire', confidence: 0.9, importance: 7, ts: Date.now(), isCorrection: true });
  ltm.storeFact(owner, { key: 'city', value: 'Guwahati', confidence: 0.9, importance: 6, ts: Date.now() });
  const got = retriever.retrieveRelevantFacts(owner, 'what is my profession and where do I live?', 10);
  assert.ok(!got.some(f => f.key === 'profession'), JSON.stringify(got));
  assert.ok(got.some(f => f.key === 'city'), 'unrelated valid facts are unaffected');
  assert.ok(ltm.getFact(owner, 'profession'), 'still stored — only its use stops');

  const owner2 = 'trust-profession-ok';
  ltm.storeFact(owner2, { key: 'profession', value: 'software engineer', confidence: 0.9, importance: 7, ts: Date.now(), isCorrection: true });
  const got2 = retriever.retrieveRelevantFacts(owner2, 'what is my profession?', 10);
  assert.ok(got2.some(f => f.key === 'profession' && /engineer/.test(String(f.value))));
});

test('an impersonal factual question carries no profile; a personal one still does', () => {
  // Live run 2026-10-29 (V7): "At sea level, what temperature does water boil
  // at?" was sent with the user's profession, project and goals.
  const owner = 'trust-impersonal';
  ltm.storeFact(owner, { key: 'profession', value: 'university student', confidence: 0.9, importance: 8, ts: Date.now() });
  ltm.storeFact(owner, { key: 'project', value: 'Tidepool', confidence: 0.9, importance: 8, ts: Date.now() });
  ltm.storeFact(owner, { key: 'city', value: 'Pune', confidence: 0.9, importance: 6, ts: Date.now() });
  assert.deepEqual(retriever.retrieveRelevantFacts(owner, 'At sea level, what temperature does water boil at in Celsius?', 10), []);
  assert.deepEqual(retriever.retrieveRelevantFacts(owner, 'Explain photosynthesis in simple terms', 10), []);
  // KNOWN LIMITATION (pre-existing keyword index, not this gate): "works" in
  // "how X works" reads as the WORK category, so it counts as naming the
  // user's profession. Pinned so a fix is visible, not to endorse it.
  assert.deepEqual(retriever.retrieveRelevantFacts(owner, 'Explain how photosynthesis works', 10).map(f => f.key), ['profession']);
  // A question that names a stored thing still gets it, even impersonally.
  assert.deepEqual(retriever.retrieveRelevantFacts(owner, 'Is Tidepool a good name for a scheduling app?', 10).map(f => f.key), ['project']);
  // Any personal reference keeps the profile, as before.
  const personal = retriever.retrieveRelevantFacts(owner, 'Help me plan my week', 10).map(f => f.key);
  assert.ok(personal.includes('profession') && personal.includes('project'), JSON.stringify(personal));
  // Recall and directed questions are unaffected.
  assert.ok(retriever.retrieveRelevantFacts(owner, 'what do you know about me?', 10).length >= 3);
});

test('the Mind block tells the model which beliefs were stated and which were inferred', () => {
  const { DIMENSIONS } = mindSchema;
  const mind = mindSchema.createEmptyMind('trust-mind');
  beliefs.observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'founder', value: true, strength: 0.9, explicit: true });
  for (let i = 0; i < 4; i++) beliefs.observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'night_owl', value: true, strength: 0.9 });
  const { block } = mindRetriever.retrieveCognitiveContext(mind, { query: 'help me plan my week' });
  assert.match(block, /founder \(user said\)/);
  assert.match(block, /night owl \(inferred, \d+%\)/);
});

test('an aspirational role belief never reaches the model as identity', () => {
  const { DIMENSIONS } = mindSchema;
  const mind = mindSchema.createEmptyMind('trust-role');
  beliefs.observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'billionaire', strength: 0.9, explicit: true });
  beliefs.observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'student', value: true, strength: 0.9, explicit: true });
  const { block } = mindRetriever.retrieveCognitiveContext(mind, { query: 'what should I study?' });
  assert.doesNotMatch(block, /billionaire/);
  assert.match(block, /student/);
});
