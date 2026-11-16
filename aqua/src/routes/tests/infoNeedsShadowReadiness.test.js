/**
 * Sprint 4 (2026-11-11) — Render shadow readiness for AQUA_INFO_NEEDS=shadow, on
 * the REAL chat route. Each test is one item of AQUA_RENDER_SHADOW_READINESS.md:
 *
 *   1. shadow does not alter the answer      — the prompt sent is byte-identical to off
 *   2. no extra model calls                  — the provider is called the same number of times
 *   3. no raw content in logs; metrics only  — the [NEEDS] line holds counts and hashes only
 *   4. safe fallback on failure              — an engine error leaves the turn as off would
 *   5. user isolation                        — shadow never reads another user's history
 *   6. latency                               — the engine's own time is recorded and small
 *   7. production pipeline unchanged         — the engine writes nothing to any store
 *
 * The fake Groq client records every request, so the tests compare what the model
 * actually receives. No network, no real provider, no database.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-needs-shadow-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.AQUA_EMBEDDINGS = 'off';
delete process.env.AQUA_INFO_NEEDS;
for (const k of Object.keys(process.env)) {
  if (/(_API_KEY|_KEY_\d+|_KEYS)$|^OPENROUTER|^GROQ|^GEMINI|^NVIDIA|^OPENAI|^TAVILY|^SERPER|^BRAVE|^EXA/i.test(k)) delete process.env[k];
}
process.env.GROQ_API_KEY_1 = 'gsk_test_fake_key_for_shadow_readiness_01';

const Q = await import('../../providers/groq.js');
const calls = [];   // every provider request: { system, messages }
Q.__setClientFactoryForTests(() => ({ chat: { completions: { create: async body => {
  calls.push({ system: (body.messages ?? []).find(m => m.role === 'system')?.content ?? '', n: (body.messages ?? []).length });
  const text = 'Understood.';
  if (body.stream) return (async function* () { yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] }; })();
  return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
} } } }));
const { default: chatRoute } = await import('../chat.js');
const IN = await import('../../brain/contextEngine/informationNeeds.js');
const { sensitivePolicy } = await import('../../memory/sensitivity.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.aquaUserId = req.headers['x-test-user']; next(); });
app.use('/chat', chatRoute);
let server, base;
before(() => { server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
beforeEach(() => { calls.length = 0; delete process.env.AQUA_INFO_NEEDS; });

const post = async (user, message, path_ = '/chat') => {
  const r = await fetch(base + path_, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': user }, body: JSON.stringify({ message }) });
  return { status: r.status, text: await r.text() };
};
const HISTORY = [
  'I run a small bakery called Crumb & Co with two staff, Hana and Lev.',
  'We make about 4,000 a month profit.',
  'A second oven would cost 6,500.',
  'My brother Teo is training to be a pilot.',
];
async function seed(user) { for (const m of HISTORY) assert.equal((await post(user, m)).status, 200); }
const QUESTION = 'Should I buy a second oven?';
/** The answer-generation prompt with the user id replaced, so two users' prompts compare. */
// The untrusted-content fence carries a per-request random nonce (a security feature): the ONLY
// normalisation applied before comparing prompts.
const NONCE = /(UNTRUSTED-CONTENT) [A-Za-z0-9_-]{8,}/g;
const answerPrompts = (user) => calls.map(c => c.system.split(user).join('<USER>').replace(NONCE, '$1 <nonce>'));
async function captureLogs(fn) {
  const lines = [];
  const ol = console.log, ow = console.warn, oe = console.error;
  console.log = (...a) => { lines.push(a.join(' ')); };
  console.warn = (...a) => { lines.push(a.join(' ')); };
  console.error = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = ol; console.warn = ow; console.error = oe; }
  return lines;
}

async function turnUnder(mode, user, path_ = '/chat') {
  if (mode) process.env.AQUA_INFO_NEEDS = mode; else delete process.env.AQUA_INFO_NEEDS;
  await seed(user);
  calls.length = 0;
  let r;
  const logs = await captureLogs(async () => { r = await post(user, QUESTION, path_); });
  return { r, prompts: answerPrompts(user), count: calls.length, logs };
}

test('1+2. shadow: every prompt the model receives is byte-identical to off, and there are as many calls', async () => {
  for (const p of ['/chat', '/chat/stream']) {
    const off = await turnUnder(null, `shadow-cmp-off${p.length}`, p);
    const sh = await turnUnder('shadow', `shadow-cmp-sh${p.length}`, p);
    assert.equal(off.r.status, 200); assert.equal(sh.r.status, 200);
    assert.equal(sh.count, off.count, `${p}: same number of provider calls`);
    assert.ok(off.count >= 1);
    assert.deepEqual(
      sh.prompts.map(s => s.split(`shadow-cmp-sh${p.length}`).join('<U>')),
      off.prompts.map(s => s.split(`shadow-cmp-off${p.length}`).join('<U>')),
      `${p}: shadow changes nothing the model sees`,
    );
    assert.doesNotMatch(sh.prompts.join('\n'), /INFORMATION NEEDS/);
  }
});

test('3. shadow logs metrics only: no question, no history, no names, no figures, no account id', async () => {
  const user = 'shadow-logs-user-7f3a';
  const { logs } = await turnUnder('shadow', user);
  const needs = logs.filter(l => l.startsWith('[NEEDS]'));
  assert.equal(needs.length, 1, 'one [NEEDS] line per turn');
  const line = needs[0];
  assert.match(line, /^\[NEEDS\] mode=shadow applied=(true|false) reason=(-|no-evidence|no-requirements|no-owner) intent=\w[\w-]* needs=\d+ essential=\d+ found=\d+ missing=\d+ uncertain=\d+ contradictory=\d+ outdated=\d+ forgotten=\d+ ambiguous=\d+ sufficiency=[\w-]+ quotes=\d+ ms=[\d.]+ owner=#[0-9a-f]{8} req=\S+$/);
  for (const secret of ['oven', 'Crumb', 'Hana', 'Lev', '4,000', '6,500', 'Teo', 'pilot', 'bakery', user]) {
    assert.ok(!line.includes(secret), `[NEEDS] line must not contain "${secret}"`);
  }
  // And nothing the engine added anywhere else in this turn's logs quotes the history.
  const engineLines = logs.filter(l => /NEEDS|information.?needs/i.test(l));
  for (const l of engineLines) assert.doesNotMatch(l, /Crumb|Hana|6,500|pilot/);
});

test('4. an engine failure leaves the turn exactly as off would serve it, and is logged without content', async () => {
  const off = await turnUnder(null, 'shadow-fail-off');
  for (const mode of ['shadow', 'on']) {
    process.env.AQUA_INFO_NEEDS = mode;
    const user = `shadow-fail-${mode}`;
    await seed(user);
    calls.length = 0;
    IN.__failNextForTests(new TypeError('simulated engine failure with private text Crumb'));
    let r;
    const logs = await captureLogs(async () => { r = await post(user, QUESTION); });
    assert.equal(r.status, 200, `${mode}: the turn is served`);
    assert.deepEqual(answerPrompts(user).map(s => s.split(user).join('<U>')), off.prompts.map(s => s.split('shadow-fail-off').join('<U>')), `${mode}: falls back to the existing pipeline`);
    const failLine = logs.find(l => l.startsWith('[NEEDS] failed'));
    assert.ok(failLine, `${mode}: the failure is logged`);
    assert.doesNotMatch(failLine, /Crumb|simulated/, 'the error message is not logged, only its name');
  }
});

test('5. isolation: the engine reads only the asking user\'s history', async () => {
  process.env.AQUA_INFO_NEEDS = 'shadow';
  await post('shadow-iso-a', 'A second oven would cost 6,500.');
  await post('shadow-iso-b', 'A second oven would cost 99,999. My accountant is Zelda Quist.');
  const r = IN.analyseInformationNeeds({ ownerId: 'user:shadow-iso-a', userId: 'shadow-iso-a', conversationId: 'shadow-iso-a-q', question: QUESTION, sensitive: sensitivePolicy() });
  const all = `${r.memoryBlock}\n${r.recallBlock}`;
  assert.match(all, /6,500/);
  assert.doesNotMatch(all, /99,999|Zelda/);
  const none = IN.analyseInformationNeeds({ ownerId: 'user:shadow-iso-nobody', userId: 'shadow-iso-nobody', conversationId: 'x', question: QUESTION, sensitive: sensitivePolicy() });
  assert.doesNotMatch(`${none.memoryBlock ?? ''}\n${none.recallBlock ?? ''}`, /6,500|99,999|Zelda/);
});

test('6. latency: the engine records its own time; it stays small on a long history', async () => {
  const user = 'shadow-latency';
  for (let i = 0; i < 60; i++) await post(user, `Note ${i}: I tidied shelf ${i} and found ${i} old receipts.`);
  await seed(user);
  const times = [];
  for (let i = 0; i < 5; i++) {
    const r = IN.analyseInformationNeeds({ ownerId: `user:${user}`, userId: user, conversationId: `${user}-q`, question: QUESTION, sensitive: sensitivePolicy() });
    times.push(r.summary.ms);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[2] < 100, `median engine time ${times[2]} ms (budget 100 ms on a test machine)`);
});

test('7. the engine is read-only: it writes nothing to any store', async () => {
  const user = 'shadow-readonly';
  await seed(user);
  await new Promise(r => setTimeout(r, 100));
  const snapshot = () => {
    const out = {};
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[p] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } };
    walk(process.env.AQUA_DATA_DIR);
    return out;
  };
  const before_ = snapshot();
  for (const q of [QUESTION, 'What does my brother do?', 'How far is the Moon?', 'Can we afford the oven?']) {
    IN.analyseInformationNeeds({ ownerId: `user:${user}`, userId: user, conversationId: `${user}-q`, question: q, sensitive: sensitivePolicy() });
  }
  assert.deepEqual(snapshot(), before_, 'no file in the data dir changed');
});
