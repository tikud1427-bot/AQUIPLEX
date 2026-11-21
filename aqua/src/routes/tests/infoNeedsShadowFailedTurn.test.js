import { _enterDataClassForTests } from '../../core/egressGuard.js';
_enterDataClassForTests('user');   // G1-2: this file's fixture content is user-class (core/egressGuard.js)
/**
 * Sprint 6 (2026-11-11) — a FAILED turn under AQUA_INFO_NEEDS=shadow leaves no
 * memory change, even though the shadow analysis has already run for that turn.
 *
 * Order inside prepareTurn: memoryObserve (writes, held in the turn transaction)
 * → the information-needs analysis (shadow: read-only, logs [NEEDS]) → generation.
 * When generation fails, the Sprint 1 commit boundary (routes/chat.js `finally` →
 * rollbackTurnMemory) must undo the turn's writes. These tests prove that the
 * shadow analysis running in between changes nothing about that, on both
 * endpoints, for a new user and for a user who already has memory.
 *
 * Real chat route, fake provider (no network), isolated data dir. Promoted from
 * the Sprint 5 scratch test (AQUIPLEX_SPRINT5_SHADOW_READINESS_REVIEW.md §2).
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-shadow-failed-turn-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.AQUA_EMBEDDINGS = 'off';
delete process.env.AQUA_INFO_NEEDS;
for (const k of Object.keys(process.env)) {
  if (/(_API_KEY|_KEY_\d+|_KEYS)$|^OPENROUTER|^GROQ|^GEMINI|^NVIDIA|^OPENAI|^TAVILY|^SERPER|^BRAVE|^EXA/i.test(k)) delete process.env[k];
}
process.env.GROQ_API_KEY_1 = 'gsk_test_fake_key_for_shadow_failed_turn';

const Q = await import('../../providers/groq.js');
let fail = false;
Q.__setClientFactoryForTests(() => ({ chat: { completions: { create: async body => {
  if (fail) { const e = new Error('upstream unavailable'); e.status = 503; throw e; }
  if (body.stream) return (async function* () { yield { choices: [{ delta: { content: 'Noted.' }, finish_reason: 'stop' }] }; })();
  return { choices: [{ message: { content: 'Noted.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } };
} } } }));
const { default: chatRoute } = await import('../chat.js');
const { getFacts } = await import('../../memory/longTermMemory.js');
const { peekMind } = await import('../../mind/mindStore.js');
const { getAllConversations } = await import('../../memory/conversationStore.js');
const { featureStatus, _resetFeatureExecutionsForTests } = await import('../../core/flags.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.aquaUserId = req.headers['x-test-user']; next(); });
app.use('/chat', chatRoute);
let server, base;
before(() => { server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
beforeEach(() => { fail = false; process.env.AQUA_INFO_NEEDS = 'shadow'; });

const post = async (user, message, p = '/chat') => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': user }, body: JSON.stringify({ message }) });
  return { status: r.status, text: await r.text() };
};
const settle = () => new Promise(r => setTimeout(r, 200));

/** Everything a turn could leave behind for this user: facts, Mind goals/beliefs/working memory, persisted user messages. */
function memoryOf(user) {
  const mind = peekMind(`user:${user}`);
  const userMsgs = Object.values(getAllConversations())
    .filter(c => c.meta?.userId === user)
    .flatMap(c => (c.messages ?? []).filter(m => m.role === 'user').map(m => m.content));
  return JSON.stringify({
    facts: getFacts(`user:${user}`).map(f => [f.key, f.value, !!f.ended]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    goals: Object.values(mind?.goals ?? {}).map(g => [g.title, g.status]).sort(),
    beliefs: Object.values(mind?.beliefs ?? {}).map(b => [b.key, b.value]).sort(),
    working: mind?.working ? { focus: mind.working.focus ?? null, openQuestions: (mind.working.openQuestions ?? []).length } : null,
    userMsgs,
  });
}

/** Capture console output during fn (to prove the shadow analysis ran). */
async function withLogs(fn) {
  const lines = [];
  const ol = console.log, ow = console.warn;
  console.log = (...a) => { lines.push(a.join(' ')); };
  console.warn = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = ol; console.warn = ow; }
  return lines;
}

const FAILING_MESSAGE = 'My name is Quorrin, I work at Kestrel Labs, my sister is Ana and my goal is to run a marathon.';

for (const p of ['/chat', '/chat/stream']) {
  test(`${p}: a new user's failed shadow turn leaves no memory — and the analysis did run`, async () => {
    const user = `sft-new${p.length}`;
    _resetFeatureExecutionsForTests();
    fail = true;
    let r;
    const logs = await withLogs(async () => { r = await post(user, FAILING_MESSAGE, p); });
    await settle();
    if (p === '/chat') assert.ok(r.status >= 500, `status ${r.status}`);
    else assert.match(r.text, /event: error/, 'the stream reports the failure');
    // The analysis ran on this very turn, before generation failed.
    assert.ok(logs.some(l => l.startsWith('[NEEDS] mode=shadow')), 'the shadow analysis ran');
    assert.ok((featureStatus().find(f => f.name === 'AQUA_INFO_NEEDS').observed?.runs ?? 0) >= 1);
    // …and nothing of the turn remains.
    assert.deepEqual(getFacts(`user:${user}`), []);
    assert.deepEqual(Object.values(peekMind(`user:${user}`)?.goals ?? {}), []);
    assert.equal(JSON.parse(memoryOf(user)).userMsgs.length, 0, 'the user message is not persisted');
  });

  test(`${p}: an existing user's memory is byte-identical after a failed shadow turn`, async () => {
    const user = `sft-existing${p.length}`;
    for (const m of ['I live in Bristol and I work at Pellow Insurance.', 'My goal is to learn Italian this year.', 'My brother Tomas lives in Ghent.']) {
      assert.equal((await post(user, m)).status, 200);
    }
    await settle();
    const beforeTurn = memoryOf(user);
    assert.match(beforeTurn, /Bristol/);
    fail = true;
    const logs = await withLogs(async () => { await post(user, 'Actually I moved to Cardiff and I joined Calder Legal as a solicitor. Should I sell my car?', p); });
    await settle();
    assert.ok(logs.some(l => l.startsWith('[NEEDS] mode=shadow')), 'the shadow analysis ran');
    assert.equal(memoryOf(user), beforeTurn, 'facts, goals, beliefs, working memory and messages unchanged');
  });
}

test('control: the same turn under shadow WITHOUT a failure does write (the test can see writes)', async () => {
  const user = 'sft-control';
  await post(user, FAILING_MESSAGE);
  await settle();
  assert.ok(getFacts(`user:${user}`).length > 0, 'a successful turn stores facts — otherwise the assertions above prove nothing');
});
