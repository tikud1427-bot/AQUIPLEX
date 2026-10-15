/**
 * A forgotten memory must stop reaching the answer (audit 2026-10-12).
 *
 * Reproduced before the fix on a LEGACY read (what the deployed main serves):
 * DELETE /memory/fact/city removed the Memory-page fact, and the next turn's
 * model input still said "I live in Lisbon." — the same sentence lives in the
 * conversation evidence lane, which the delete never touched.
 *
 * These drive the real prepareTurn (the function /chat and /chat/stream build
 * the model input with) and the real /memory router, and assert on
 * `prep.systemPrompt` — the string handed to the model. Each test has a
 * positive control (the value IS in the prompt before the forget), so none can
 * pass because retrieval simply found nothing.
 *
 * No database here: the canonical-store side is memory/tests/forgetCanonical.live.test.js.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.AQUA_DATA_DIR             = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-forget-'));
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

const { prepareTurn }   = await import('../../routes/chat.js');
const { createContext } = await import('../../core/observability.js');
const mem               = await import('../engine.js');
const Brain             = await import('../../brain/index.js');
const LTM               = await import('../longTermMemory.js');
const { forgetFact, forgetAllFacts } = await import('../forget.js');
const { default: memoryRoute } = await import('../../routes/memory.js');
const pool              = await import('../../core/db/pool.js');
const ES                = await import('../../files/evidenceStore.js');

let n = 0;
async function seed(userId, sentences) {
  const owner = `user:${userId}`;
  const conv = `c-${userId}-seed`;
  let turn = 0;
  for (const userMessage of sentences) {
    mem.memoryObserve(owner, { userMessage, taskType: 'personal_info', conversationId: conv, userId, requestId: 'seed' });
    await Brain.observeConversationTurn({ ownerId: owner, conversationId: conv, turn: turn++, userMessage, assistantMessage: 'Got it.' });
  }
  return owner;
}
async function promptFor(userId, question) {
  const conv = `c-${userId}-ask-${n++}`;   // a NEW conversation: nothing comes from chat history
  const p = await prepareTurn({ userMessage: question, workspaceId: null, conversationId: conv, userId,
    ctx: createContext({ conversationId: conv, requestId: conv }), requestId: conv, skipReasoningPass: true });
  // EVERYTHING the model is given: the system prompt (identity, profile memory,
  // cognitive model, graph, knowledge context), the message window, and the
  // evidence handed to post-generation reviewers.
  return [p.systemPrompt, ...(p.messages ?? []).map(m => m.content), p.evidenceContext ?? ''].map(String).join('\n');
}
const keyOf = (owner, re) => LTM.getFacts(owner).find(f => re.test(JSON.stringify(f.value)))?.key;

const app = express();
app.use(express.json());
app.use((req, _res, next) => { const u = req.headers['x-test-user']; if (u) req.aquaUserId = String(u); next(); });
app.use('/memory', memoryRoute);
let server, base;
before(() => { server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
const call = async (method, p, user) => {
  const r = await fetch(base + p, { method, headers: { 'x-test-user': user } });
  return { status: r.status, body: await r.json() };
};

test('forgetting one fact removes it from the next answer\'s input — every copy, not only the Memory page\'s', async () => {
  const owner = await seed('f1', ['I live in Lisbon.', 'I work at Nummo as head of product.']);
  const Q = 'Where do I live and where do I work?';
  const before = await promptFor('f1', Q);
  assert.match(before, /Lisbon/, 'positive control: the fact reaches the prompt');
  assert.match(before, /Nummo/);

  const r = await forgetFact(owner, keyOf(owner, /Lisbon/));
  assert.equal(r.key, 'city');
  assert.ok(r.worldModel.conversationFacts.length >= 1, 'the conversation-lane copy was retired');

  const after = await promptFor('f1', Q);
  assert.doesNotMatch(after, /Lisbon/, 'forgotten fact still reaches the model input');
  assert.match(after, /Nummo/, 'only what was forgotten is gone');
  assert.equal(LTM.getFact(owner, 'city'), null);
});

test('forget is about the user: a sentence about someone else that names the same value stays', async () => {
  const owner = await seed('f2', ['I live in Lisbon.', 'My sister Ana lives in Lisbon too and teaches piano.', 'My dog is called Biscuit.']);
  const lane = () => Object.fromEntries(ES.listFacts(owner, { limit: 1000 }).map(f => [f.statement, !!f.archived]));
  assert.deepEqual(lane(), {
    'I live in Lisbon.': false, 'My sister Ana lives in Lisbon too and teaches piano.': false, 'My dog is called Biscuit.': false,
  }, 'precondition: all three sentences are in the conversation lane, live');
  await forgetFact(owner, keyOf(owner, /Lisbon/));
  assert.deepEqual(lane(), {
    'I live in Lisbon.': true,                                        // the user's own statement: retired
    'My sister Ana lives in Lisbon too and teaches piano.': false,    // about Ana: kept
    'My dog is called Biscuit.': false,                               // unrelated: kept
  });
});

test('forget all: nothing the user told Aqua reaches the next answer', async () => {
  const owner = await seed('f3', ['I live in Lisbon.', 'I work at Nummo as head of product.', 'My dog is called Biscuit.']);
  const Q = 'What do you know about me — where I live, where I work, my dog?';
  assert.match(await promptFor('f3', Q), /Lisbon|Nummo|Biscuit/, 'positive control');
  await forgetAllFacts(owner);
  const after = await promptFor('f3', Q);
  for (const v of ['Lisbon', 'Nummo', 'Biscuit']) assert.doesNotMatch(after, new RegExp(v), `${v} survived forget-all`);
  assert.equal(LTM.getFacts(owner).length, 0);
});

test('chat-path forget ("forget my city") reaches the conversation lane too', async () => {
  const owner = await seed('f4', ['I live in Lisbon.']);
  assert.match(await promptFor('f4', 'Where do I live?'), /Lisbon/, 'positive control');
  mem.memoryObserve(owner, { userMessage: 'Please forget my city.', taskType: 'personal_info', conversationId: 'c-f4-x', userId: 'f4', requestId: 'f' });
  await new Promise(r => setTimeout(r, 200));   // the World Model side runs in the background
  assert.doesNotMatch(await promptFor('f4', 'Where do I live?'), /Lisbon/);
});

test('superseded in conversation ("Actually, my city is now Porto"): the old sentence stops reaching the answer', async () => {
  // Reproduced before the fix: the prompt carried "City: Porto" AND
  // "• I live in Lisbon." — the conversation lane is never revised.
  const owner = await seed('f7', ['I live in Lisbon.', 'My dog is called Biscuit.']);
  assert.match(await promptFor('f7', 'Which city do I live in?'), /I live in Lisbon/, 'positive control');
  await seed('f7', ['Actually, my city is now Porto.']);
  await new Promise(r => setTimeout(r, 200));   // retirement runs in the background
  const after = await promptFor('f7', 'Which city do I live in?');
  assert.match(after, /Porto/);
  assert.doesNotMatch(after, /Lisbon/, 'the superseded value still reaches the model input');
  assert.match(await promptFor('f7', 'What is my dog called?'), /Biscuit/, 'unrelated sentences untouched');
  assert.equal(LTM.getFact(owner, 'city')?.value, 'Porto');
});

test('route: DELETE /memory/fact/:key and DELETE /memory go through the same forget', async () => {
  const owner = await seed('f5', ['I live in Lisbon.', 'My dog is called Biscuit.']);
  const key = keyOf(owner, /Lisbon/);
  const r = await call('DELETE', `/memory/fact/${key}`, 'f5');
  assert.equal(r.status, 200);
  assert.doesNotMatch(await promptFor('f5', 'Where do I live?'), /Lisbon/);
  const all = await call('DELETE', '/memory', 'f5');
  assert.equal(all.status, 200);
  assert.doesNotMatch(await promptFor('f5', 'What is my dog called?'), /Biscuit/);
});

test('route: World Model configured but unreachable → 503 and NOTHING changed (never a half-forget)', async () => {
  const owner = await seed('f6', ['I live in Lisbon.']);
  const key = keyOf(owner, /Lisbon/);
  process.env.DATABASE_URL = 'postgresql://aqua:aqua@127.0.0.1:1/aqua_unreachable';
  pool._resetForTests();
  try {
    const r = await call('DELETE', `/memory/fact/${key}`, 'f6');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'unavailable');
    assert.ok(LTM.getFact(owner, key), 'the Memory-page copy must not be deleted while the World Model copy remains');
    const all = await call('DELETE', '/memory', 'f6');
    assert.equal(all.status, 503);
    assert.ok(LTM.getFact(owner, key));
  } finally {
    delete process.env.DATABASE_URL;
    pool._resetForTests();
  }
});
