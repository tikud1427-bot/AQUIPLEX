/**
 * Sprint 1 Task D — a failed turn leaves no knowledge behind (2026-11-10).
 *
 * Audit F-12: memoryObserve writes facts and Mind state BEFORE generation; a
 * provider failure then persisted no message, yet everything learned from it
 * stayed. Driven through the REAL routes with a fake Groq client (no network):
 * the commit boundary is the user message reaching the conversation.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-failed-turn-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.AQUA_EMBEDDINGS = 'off';
for (const k of Object.keys(process.env)) {
  if (/(_API_KEY|_KEY_\d+|_KEYS)$|^OPENROUTER|^GROQ|^GEMINI|^NVIDIA|^OPENAI|^TAVILY|^SERPER|^BRAVE|^EXA/i.test(k)) delete process.env[k];
}
process.env.GROQ_API_KEY_1 = 'gsk_test_fake_key_for_failed_turn_0001';

const Q = await import('../../providers/groq.js');
let mode = 'ok';          // ok | fail | slow
let release = null;       // resolves a held 'slow' generation
Q.__setClientFactoryForTests(() => ({ chat: { completions: { create: async body => {
  // 'fail-after-wait' fails every call, including the router's retries of the held one.
  if (mode === 'fail' || mode === 'fail-after-wait') { const e = new Error('upstream unavailable'); e.status = 503; throw e; }
  const text = 'Understood.';
  if (mode === 'slow') {
    await new Promise(r => { release = r; });
    if (mode === 'fail-after-wait') { const e = new Error('upstream unavailable'); e.status = 503; throw e; }
  }
  if (body.stream) return (async function* () { yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] }; })();
  return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
} } } }));
const Q2 = await import('../../providers/router.js');   // eslint-disable-line no-unused-vars
const { default: chatRoute } = await import('../chat.js');
const { getFacts } = await import('../../memory/longTermMemory.js');
const { peekMind } = await import('../../mind/mindStore.js');
const { getConversation } = await import('../../memory/conversationStore.js');

let currentUser = 'ft-user';
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.aquaUserId = req.headers['x-test-user'] ?? currentUser; next(); });
app.use('/chat', chatRoute);
let server, base;
before(() => { server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
beforeEach(() => { mode = 'ok'; });

const post = async (p, body, user) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
};
const factsOf = user => Object.fromEntries(getFacts(`user:${user}`).map(f => [f.key, f.value]));
const goalsOf = user => Object.values(peekMind(`user:${user}`)?.goals ?? {}).map(g => g.title);
const settle = () => new Promise(r => setTimeout(r, 150));

test('POST /chat: provider failure → no facts, no goals, no message; the retry learns it once', async () => {
  const u = 'ft-json';
  mode = 'fail';
  const r = await post('/chat', { message: 'My name is Quorrin and my goal is to run a marathon in May.', conversationId: 'conv-ft-json' }, u);
  assert.ok(r.status >= 500, `expected a failed turn, got ${r.status}`);
  await settle();
  assert.deepEqual(factsOf(u), {}, 'nothing learned from a turn that did not happen');
  assert.deepEqual(goalsOf(u), []);
  assert.deepEqual(getConversation('conv-ft-json'), [], 'and nothing in the history');

  mode = 'ok';
  const ok = await post('/chat', { message: 'My name is Quorrin and my goal is to run a marathon in May.', conversationId: 'conv-ft-json' }, u);
  assert.equal(ok.status, 200);
  await settle();
  assert.equal(factsOf(u).name, 'Quorrin', 'a successful turn still learns (behaviour preserved)');
  assert.equal(goalsOf(u).length, 1);
  assert.equal(getConversation('conv-ft-json').filter(m => m.role === 'user').length, 1);
});

test('retries are idempotent: fail, fail, succeed == succeed once', async () => {
  const msg = 'I live in Tromsø and I prefer short answers.';
  mode = 'fail';
  await post('/chat', { message: msg }, 'ft-retry');
  await post('/chat', { message: msg }, 'ft-retry');
  mode = 'ok';
  await post('/chat', { message: msg }, 'ft-retry');
  await post('/chat', { message: msg }, 'ft-once');
  await settle();
  assert.deepEqual(factsOf('ft-retry'), factsOf('ft-once'));
  const strip = u => Object.fromEntries(Object.entries(peekMind(`user:${u}`).beliefs ?? {}).map(([k, b]) => [k, [b.value, b.evidence?.length ?? b.evidenceCount ?? null]]));
  assert.deepEqual(strip('ft-retry'), strip('ft-once'), 'belief evidence counted once, not three times');
});

test('POST /chat/stream: provider failure (SSE error) → nothing learned, nothing persisted', async () => {
  const u = 'ft-stream';
  mode = 'fail';
  const r = await post('/chat/stream', { message: 'My company is Velloway and my sister Ana works at Stripe.', conversationId: 'conv-ft-stream' }, u);
  assert.match(r.text, /event: error/);
  await settle();
  assert.deepEqual(factsOf(u), {});
  assert.deepEqual(getConversation('conv-ft-stream'), []);
});

test('a FORGET in a failed turn stays honoured; nothing else from that turn is kept', async () => {
  const u = 'ft-forget';
  mode = 'ok';
  await post('/chat', { message: 'I work at Fintrail.' }, u);
  await settle();
  assert.equal(factsOf(u).workplace, 'Fintrail', 'control');
  mode = 'fail';
  await post('/chat', { message: 'My name is Ellory. Forget my workplace' }, u);
  await settle();
  assert.equal(factsOf(u).workplace, undefined, 'the user asked to forget it: still gone after the failure');
  assert.equal(factsOf(u).name, undefined, 'but the name from the failed turn was not learned');
});

test('a concurrent successful turn is not undone by a failing one', async () => {
  const u = 'ft-concurrent';
  mode = 'slow';
  const failing = post('/chat', { message: 'My name is Brannoc.' }, u);   // observed, now generating…
  await new Promise(r => setTimeout(r, 200));
  // …meanwhile the same user's other tab completes a turn (fake answers it immediately).
  const heldRelease = release;
  mode = 'ok';
  const okRes = await post('/chat', { message: 'I live in Bergen.' }, u);
  assert.equal(okRes.status, 200);
  mode = 'fail-after-wait';
  heldRelease();
  const f = await failing;
  assert.ok(f.status >= 500);
  await settle();
  const facts = factsOf(u);
  assert.equal(facts.name, undefined, 'the failed turn\'s fact is undone');
  assert.ok(Object.values(facts).some(v => /bergen/i.test(String(v))), 'the concurrent turn\'s fact survives');
});

test('a turn the USER stopped mid-stream happened: its message is persisted and its memory commits', async () => {
  const u = 'ft-abort';
  mode = 'slow';
  const ac = new AbortController();
  const p = fetch(`${base}/chat/stream`, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', 'x-test-user': u },
    body: JSON.stringify({ message: 'My name is Halvard.', conversationId: 'conv-ft-abort' }) }).then(r => r.text()).catch(() => 'aborted');
  await new Promise(r => setTimeout(r, 300));
  ac.abort();                              // the Stop button
  await p;
  await new Promise(r => setTimeout(r, 300));
  if (release) release();                  // let the held provider call end
  await settle();
  const userMsgs = getConversation('conv-ft-abort').filter(m => m.role === 'user');
  assert.equal(userMsgs.length, 1, 'the stopped turn is in the history (existing contract)');
  assert.equal(factsOf(u).name, 'Halvard', 'so what it taught is kept');
});

test('the rollback is logged with counts only — no user content', async () => {
  const lines = [];
  const ol = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    mode = 'fail';
    await post('/chat', { message: 'My name is Zorblaxian.' }, 'ft-log');
    await settle();
  } finally { console.log = ol; }
  const rb = lines.find(l => l.includes('TURN_ROLLBACK'));
  assert.ok(rb, 'rollback is observable');
  assert.match(rb, /reverted=\d+/);
  assert.ok(!lines.some(l => l.includes('Zorblaxian')));
});
