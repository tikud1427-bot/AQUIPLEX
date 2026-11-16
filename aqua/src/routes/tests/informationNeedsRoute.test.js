/**
 * Sprint 3 — the information-needs engine on the REAL chat route (2026-11-10).
 *
 * The fake Groq client records the system prompt the route actually sends, so
 * these tests check what the model receives under each gate value:
 *   off (default)  byte-for-byte the existing pipeline: no needs block
 *   shadow         computed and logged (counts only), prompt unchanged
 *   on             the needs block and need-selected quotes replace the broad
 *                  personal lanes; failed turns still roll back (Sprint 1).
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-needs-route-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.AQUA_EMBEDDINGS = 'off';
delete process.env.AQUA_INFO_NEEDS;
for (const k of Object.keys(process.env)) {
  if (/(_API_KEY|_KEY_\d+|_KEYS)$|^OPENROUTER|^GROQ|^GEMINI|^NVIDIA|^OPENAI|^TAVILY|^SERPER|^BRAVE|^EXA/i.test(k)) delete process.env[k];
}
process.env.GROQ_API_KEY_1 = 'gsk_test_fake_key_for_needs_route_0001';

const Q = await import('../../providers/groq.js');
let fail = false;
const sent = [];   // system prompts the provider received
Q.__setClientFactoryForTests(() => ({ chat: { completions: { create: async body => {
  const sys = (body.messages ?? []).find(m => m.role === 'system')?.content ?? '';
  sent.push(sys);
  if (fail) { const e = new Error('upstream unavailable'); e.status = 503; throw e; }
  const text = 'Understood.';
  if (body.stream) return (async function* () { yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] }; })();
  return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
} } } }));
const { default: chatRoute } = await import('../chat.js');
const { getFacts } = await import('../../memory/longTermMemory.js');
const { _resetFeatureExecutionsForTests, featureStatus } = await import('../../core/flags.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.aquaUserId = req.headers['x-test-user']; next(); });
app.use('/chat', chatRoute);
let server, base;
before(() => { server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
beforeEach(() => { fail = false; sent.length = 0; delete process.env.AQUA_INFO_NEEDS; });

const post = async (user, message, path_ = '/chat') => {
  const r = await fetch(base + path_, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': user }, body: JSON.stringify({ message }) });
  return { status: r.status, text: await r.text() };
};
const HISTORY = [
  "I'm the founder of Tidewell. We have 3 engineers: Priya, Marco and Sam.",
  'We have $180k in the bank and we burn about $30k a month.',
  "Marco told me he's leaving at the end of the month.",
  'My sister is getting married in June.',
];
async function seed(user) { for (const m of HISTORY) assert.equal((await post(user, m)).status, 200); }
/** The answer-generation system prompt of the turn (a decision turn also makes reasoning and review calls, with their own prompts). */
const lastPrompt = () => [...sent].reverse().find(p => p.includes('AQUA SELF-KNOWLEDGE')) ?? '';

test('off (default): the prompt is the existing pipeline — no needs block, broad lanes present', async () => {
  await seed('r-off');
  sent.length = 0;
  await post('r-off', 'Should I hire another developer?');
  const p = lastPrompt();
  assert.ok(p.length > 0);
  assert.doesNotMatch(p, /INFORMATION NEEDS/);
  assert.match(p, /WHAT THE USER TOLD YOU BEFORE \(their own words, verbatim, oldest first; everything they said/);   // whole-history recall
  assert.match(p, /married in June/, 'the old pipeline sends the irrelevant history too');
});

test('shadow: computed and logged with counts only; the prompt is unchanged', async () => {
  await seed('r-shadow');
  process.env.AQUA_INFO_NEEDS = 'shadow';
  const lines = [];
  const ol = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await post('r-shadow', 'Should I hire another developer?'); } finally { console.log = ol; }
  const p = lastPrompt();
  assert.doesNotMatch(p, /INFORMATION NEEDS/);
  const needsLine = lines.find(l => l.startsWith('[NEEDS]'));
  assert.ok(needsLine, 'shadow logs the analysis');
  assert.match(needsLine, /mode=shadow applied=true reason=- intent=decision needs=8 /);
  assert.doesNotMatch(needsLine, /Priya|180k|Marco/, 'counts only, no content');
});

test('on: the needs block and need-selected quotes replace the broad lanes', async () => {
  await seed('r-on');
  process.env.AQUA_INFO_NEEDS = 'on';
  _resetFeatureExecutionsForTests();
  const r = await post('r-on', 'Should I hire another developer?');
  assert.equal(r.status, 200);
  const p = lastPrompt();
  assert.match(p, /--- INFORMATION NEEDS/);
  assert.match(p, /Not known: the cost of a developer/);
  for (const s of ['3 engineers', '$180k', "Marco told me he's leaving"]) assert.ok(p.includes(s), s);
  assert.doesNotMatch(p, /married in June/, 'irrelevant history is no longer sent');
  assert.doesNotMatch(p, /--- USER PROFILE & MEMORY ---|--- COGNITIVE MODEL/, 'broad lanes replaced');
  assert.match(p, /<<<UNTRUSTED-CONTENT/, 'the user\'s words stay fenced as data');
  assert.equal(featureStatus().find(f => f.name === 'AQUA_INFO_NEEDS').state, 'active', 'execution is observed and reported');
});

test('on: the stream path uses it too', async () => {
  await seed('r-on-stream');
  process.env.AQUA_INFO_NEEDS = 'on';
  await post('r-on-stream', 'Should I hire another developer?', '/chat/stream');
  assert.match(lastPrompt(), /--- INFORMATION NEEDS/);
});

test('on: an impersonal question sends no personal context', async () => {
  await seed('r-imp');
  process.env.AQUA_INFO_NEEDS = 'on';
  await post('r-imp', 'At what temperature does water boil at sea level?');
  const p = lastPrompt();
  assert.doesNotMatch(p, /Priya|180k|married|Tidewell/);
  assert.doesNotMatch(p, /WHAT THE USER TOLD YOU BEFORE/);
});

test('on: a failed turn still leaves no knowledge behind (Sprint 1 commit safety intact)', async () => {
  process.env.AQUA_INFO_NEEDS = 'on';
  fail = true;
  const r = await post('r-fail', 'My name is Quorrin and I work at Kestrel Labs.');
  assert.ok(r.status >= 500);
  await new Promise(res => setTimeout(res, 150));
  assert.deepEqual(getFacts('user:r-fail'), []);
});

test('on: users never see each other\'s history', async () => {
  process.env.AQUA_INFO_NEEDS = 'on';
  await post('r-iso-a', 'We have 3 engineers: Ada, Ben and Cy.');
  await post('r-iso-b', 'We have 9 engineers: Dot, Eve and Fay. We have $90k in the bank.');
  await post('r-iso-a', 'Should I hire another developer?');
  const p = lastPrompt();
  assert.match(p, /Ada, Ben and Cy/);
  assert.doesNotMatch(p, /Dot, Eve|\$90k/);
});
