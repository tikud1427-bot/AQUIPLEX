/**
 * Health and mood details must not reach the model (2026-10-28).
 *
 * Production's Memory page: "custom_very_bored = very bored" used 233×,
 * "custom_unable_to_enjoy_anything" 186×, "custom_right_eye = moving
 * automatically" 79× — injected into almost every reply. These drive the real
 * prepareTurn (what /chat and /chat/stream hand the model) on the LEGACY read
 * production serves, and assert on everything the model is given.
 *
 * Seeding writes the facts exactly as production holds them today — untagged,
 * from the custom_ fallback — plus the sentences in the conversation evidence
 * lane, so the read rule is proven on existing data, not only on new writes.
 * Each test has a positive control (an ordinary fact that DOES reach the
 * prompt), so none can pass because retrieval simply found nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR             = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-sensitive-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI                 = '';
delete process.env.DATABASE_URL;               // no canonical store: the legacy read
process.env.AQUA_CANONICAL_READ       = 'off';
process.env.AQUA_CONTEXT_V2           = 'on';
process.env.AQUA_BRAIN_INGEST         = 'on';
process.env.AQUA_BRAIN_INGEST_FACTS   = 'on';
for (const k of Object.keys(process.env)) {
  if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}

const { prepareTurn, memoryWriteTurn } = await import('../../routes/chat.js');
const { createContext } = await import('../../core/observability.js');
const mem               = await import('../engine.js');
const Brain             = await import('../../brain/index.js');
const LTM               = await import('../longTermMemory.js');

/** Production's stored state: untagged custom_ fallback facts + the sentences in the evidence lane. */
async function seedAsProductionHoldsIt(userId) {
  const owner = `user:${userId}`;
  const conv = `c-${userId}-seed`;
  const base = { confidence: 0.7, importance: 4, category: 'custom', extractor: 'custom_fallback', sourceConversation: conv };
  LTM.storeFact(owner, { ...base, key: 'custom_very_bored', value: 'very bored', sourceText: "I'm very bored" });
  LTM.storeFact(owner, { ...base, key: 'custom_unable_to_enjoy_anything', value: 'unable to enjoy anything', sourceText: 'I am unable to enjoy anything' });
  LTM.storeFact(owner, { ...base, key: 'custom_right_eye', value: 'moving automatically', sourceText: 'my right eye is moving automatically' });
  let turn = 0;
  // Sentences naming an entity (Nummo) so the conversation evidence lane holds
  // them as facts — entity-less sentences never become lane facts at all.
  for (const userMessage of ["I'm very bored at Nummo.", 'I am unable to enjoy anything at Nummo anymore.', 'My right eye is moving automatically since I joined Nummo.', 'I live in Lisbon.', 'I work at Nummo as head of product.']) {
    await Brain.observeConversationTurn({ ownerId: owner, conversationId: conv, turn: turn++, userMessage, assistantMessage: 'Got it.' });
  }
  mem.memoryObserve(owner, { userMessage: 'I live in Lisbon.', conversationId: conv, userId, requestId: 'seed' });
  assert.ok(LTM.getFact(owner, 'custom_very_bored'), 'precondition: the sensitive fact is stored');
  assert.equal(LTM.getFact(owner, 'custom_very_bored').sensitivity, null, 'precondition: untagged, as production holds it');
  return owner;
}

let n = 0;
async function prep(userId, question, rememberSensitive) {
  const conv = `c-${userId}-ask-${n++}`;   // a NEW conversation: nothing comes from chat history
  return prepareTurn({ userMessage: question, workspaceId: null, conversationId: conv, userId, rememberSensitive,
    ctx: createContext({ conversationId: conv, requestId: conv }), requestId: conv, skipReasoningPass: true });
}
/** Everything the model is given, minus the user's own current message. */
function modelInput(p) {
  return [p.systemPrompt, ...(p.messages ?? []).slice(0, -1).map(m => m.content), p.evidenceContext ?? ''].map(String).join('\n');
}

test('a stored "very bored" fact does NOT reach the prompt for "help me write a cold email" (setting off)', async () => {
  const owner = await seedAsProductionHoldsIt('s1');
  const p = await prep('s1', 'help me write a cold email', false);
  const input = modelInput(p);
  assert.match(input, /Lisbon/, 'positive control: an ordinary fact reaches the prompt');
  assert.doesNotMatch(input, /bored/i);
  assert.doesNotMatch(input, /enjoy anything/i);
  assert.doesNotMatch(input, /right eye|moving automatically/i);
  assert.ok(!p.relevantFacts.some(f => /custom_very_bored|custom_right_eye|custom_unable/.test(f.key)), 'not among the facts reported as used');
  assert.equal(LTM.getFact(owner, 'custom_very_bored').retrievalCount, 0, '"Used N×" no longer climbs');
});

test('setting off and the user asks about it: nothing stored about it is brought back (every lane)', async () => {
  await seedAsProductionHoldsIt('s0');
  const owner = 'user:s0';
  const lane = (await import('../../files/evidenceStore.js')).listFacts(owner, { limit: 1000 }).map(f => f.statement);
  assert.ok(lane.some(s => /very bored/.test(s)), `precondition: the evidence lane holds the sentence (${JSON.stringify(lane)})`);
  const p = await prep('s0', 'What do you know about me and Nummo?', false);
  const input = modelInput(p);
  assert.match(input, /Nummo/, 'positive control: the lane answers about Nummo');
  assert.doesNotMatch(input, /bored|enjoy anything|moving automatically/i);
  assert.ok(p.sensitiveWithheld > 0, 'withholding is counted (L13), not silent');
});

test('opted in, but the message is not about mood: still withheld', async () => {
  await seedAsProductionHoldsIt('s2');
  const input = modelInput(await prep('s2', 'help me write a cold email', true));
  assert.match(input, /Lisbon/);
  assert.doesNotMatch(input, /bored/i);
  assert.doesNotMatch(input, /right eye/i);
});

test('opted in AND the message is about mood: "very bored" reaches the prompt (health still does not)', async () => {
  await seedAsProductionHoldsIt('s3');
  const input = modelInput(await prep('s3', "I've been feeling bored lately, what should I do", true));
  assert.match(input, /very bored/i, 'the opted-in, on-topic fact is used');
  assert.doesNotMatch(input, /right eye|moving automatically/i, 'a health fact needs a health question');
});

test('setting off: a health/mood sentence is not stored by any writer; the rest of the turn is', async () => {
  const owner = 'user:s4';
  const p = await prep('s4', "I'm very bored. I live in Porto.", false);
  assert.doesNotMatch(p.memoryWriteMessage, /bored/i, 'post-turn writers (evidence lane, World Model, twin) never see it');
  assert.match(p.memoryWriteMessage, /Porto/);
  const facts = LTM.getFacts(owner, { includeArchived: true });
  assert.ok(!facts.some(f => /bored/i.test(JSON.stringify(f))), 'no durable fact');
  assert.ok(facts.some(f => /Porto/.test(JSON.stringify(f.value))), 'positive control: the ordinary fact was stored');
  const write = memoryWriteTurn(p, "Sorry you're feeling bored. Here is a plan for Crumb.");
  assert.doesNotMatch(write.assistantMessage, /bored/i, 'the answer restating it is redacted too');
});

test('setting on: the fact is stored, tagged mood', async () => {
  const owner = 'user:s5';
  await prep('s5', "I'm very bored.", true);
  const fact = LTM.getFacts(owner, { includeArchived: true }).find(f => /bored/i.test(JSON.stringify(f.value)));
  assert.ok(fact, 'stored when opted in');
  assert.equal(fact.sensitivity, 'mood');
});

test('forget reads the whole message even when nothing in it may be learned', async () => {
  const owner = 'user:s6';
  LTM.storeFact(owner, { key: 'city', value: 'Lisbon', confidence: 0.9, importance: 7, category: 'location' });
  assert.ok(LTM.getFact(owner, 'city'), 'precondition');
  mem.memoryObserve(owner, { userMessage: 'Forget my city.', extractMessage: '', conversationId: 'c-s6', userId: 's6', requestId: 's6' });
  assert.equal(LTM.getFact(owner, 'city'), null);
});
