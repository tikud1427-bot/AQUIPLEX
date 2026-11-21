import { _enterDataClassForTests } from '../../core/egressGuard.js';
_enterDataClassForTests('user');   // G1-2: this file's fixture content is user-class (core/egressGuard.js)
/**
 * Sprint 6 (2026-11-11) — AQUA_HYBRID_CONTEXT on the REAL chat route.
 *
 *   off (default)  the prompt is the existing pipeline's, byte for byte
 *   shadow         computed and logged (counts only); prompt byte-identical to off
 *   on             the existing context is kept as it is, and the needs-check block
 *                  is APPENDED: removing the block from the "on" prompt gives the "off" prompt
 *
 * Plus streaming, engine errors, failed turns, isolation, precedence over
 * AQUA_INFO_NEEDS=on, and a long history. Fake provider, no network.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-hybrid-route-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.AQUA_EMBEDDINGS = 'off';
delete process.env.AQUA_INFO_NEEDS;
delete process.env.AQUA_HYBRID_CONTEXT;
for (const k of Object.keys(process.env)) {
  if (/(_API_KEY|_KEY_\d+|_KEYS)$|^OPENROUTER|^GROQ|^GEMINI|^NVIDIA|^OPENAI|^TAVILY|^SERPER|^BRAVE|^EXA/i.test(k)) delete process.env[k];
}
process.env.GROQ_API_KEY_1 = 'gsk_test_fake_key_for_hybrid_route_0001';

const Q = await import('../../providers/groq.js');
let fail = false;
const calls = [];
Q.__setClientFactoryForTests(() => ({ chat: { completions: { create: async body => {
  calls.push((body.messages ?? []).find(m => m.role === 'system')?.content ?? '');
  if (fail) { const e = new Error('upstream unavailable'); e.status = 503; throw e; }
  if (body.stream) return (async function* () { yield { choices: [{ delta: { content: 'Noted.' }, finish_reason: 'stop' }] }; })();
  return { choices: [{ message: { content: 'Noted.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } };
} } } }));
const { default: chatRoute } = await import('../chat.js');
const IN = await import('../../brain/contextEngine/informationNeeds.js');
const { getFacts } = await import('../../memory/longTermMemory.js');
const { featureStatus } = await import('../../core/flags.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.aquaUserId = req.headers['x-test-user']; next(); });
app.use('/chat', chatRoute);
let server, base;
before(() => { server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
beforeEach(() => { fail = false; calls.length = 0; delete process.env.AQUA_HYBRID_CONTEXT; delete process.env.AQUA_INFO_NEEDS; });

const post = async (user, message, p = '/chat') => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': user }, body: JSON.stringify({ message }) });
  return { status: r.status, text: await r.text() };
};
const HISTORY = [
  // Two prices for the same van, neither marked as a change: a conflict V2 can see. (V2 does not
  // see "is about 17,500" vs "the dealer said the price is 19,000": too few shared words. That is
  // recorded as a V2 limit in AQUA_HYBRID_CONTEXT_V1_RESULTS.md, not tuned here.)
  'The camper van costs 17,500.',
  'The dealer says the camper van costs 19,000.',
  'My brother Teo is training to be a pilot.',
  'I painted the fence blue last weekend.',
];
const QUESTION = 'Should we buy the camper van?';
async function seed(user, history = HISTORY) { for (const m of history) assert.equal((await post(user, m)).status, 200); }
const NONCE = /(UNTRUSTED-CONTENT) [A-Za-z0-9_-]{8,}/g;
/** The answer prompt of the last turn, with the user id and the fence nonce normalised. */
const answerPrompt = user => ([...calls].reverse().find(p => p.includes('AQUA SELF-KNOWLEDGE')) ?? '').split(user).join('<U>').replace(NONCE, '$1 <nonce>');
const stripBlock = p => p.replace(/\n\n--- NEEDS CHECK \(added after the context above; it does not replace it\) ---[\s\S]*?--- END NEEDS CHECK ---/, '');
async function withLogs(fn) {
  const lines = []; const ol = console.log, ow = console.warn;
  console.log = (...a) => { lines.push(a.join(' ')); }; console.warn = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = ol; console.warn = ow; }
  return lines;
}
async function promptUnder(mode, user, p = '/chat', extraEnv = {}) {
  await seed(user);
  if (mode) process.env.AQUA_HYBRID_CONTEXT = mode; else delete process.env.AQUA_HYBRID_CONTEXT;
  Object.assign(process.env, extraEnv);
  calls.length = 0;
  let r;
  const logs = await withLogs(async () => { r = await post(user, QUESTION, p); });
  delete process.env.AQUA_HYBRID_CONTEXT;
  for (const k of Object.keys(extraEnv)) delete process.env[k];
  return { r, prompt: answerPrompt(user), logs, count: calls.length };
}

for (const p of ['/chat', '/chat/stream']) {
  test(`${p}: off and shadow send byte-identical prompts; on keeps the existing context and appends the block`, async () => {
    const off = await promptUnder(null, `hy-off${p.length}`, p);
    const sh = await promptUnder('shadow', `hy-sh${p.length}`, p);
    const on = await promptUnder('on', `hy-on${p.length}`, p);
    for (const x of [off, sh, on]) assert.equal(x.r.status, 200);
    assert.ok(off.prompt.length > 0);
    assert.equal(sh.prompt, off.prompt, 'shadow changes nothing the model sees');
    assert.equal(sh.count, off.count, 'shadow adds no model call');
    assert.doesNotMatch(off.prompt, /NEEDS CHECK/);
    assert.match(on.prompt, /--- NEEDS CHECK/, 'on appends the block');
    assert.equal(stripBlock(on.prompt), off.prompt, 'removing the block gives exactly the existing prompt');
    assert.equal(on.count, off.count, 'on adds no model call');
    // What the block says for this history: the conflict between the two prices, and the unknown money.
    assert.match(on.prompt, /Conflict[^\n]*17,500[^\n]*19,000|Conflict[^\n]*19,000[^\n]*17,500/);
    assert.match(on.prompt, /<<<UNTRUSTED-CONTENT <nonce>>>>[\s\S]*NEEDS CHECK[\s\S]*<<<END-UNTRUSTED-CONTENT <nonce>>>>/, 'the block is inside the untrusted-content fence');
    const block = on.prompt.match(/--- NEEDS CHECK[\s\S]*?--- END NEEDS CHECK ---/)[0];
    assert.doesNotMatch(block, /Teo|pilot|fence/, 'unrelated and third-party statements are not added');
    assert.match(block, /Not known: money available/);
  });
}

test('shadow logs one content-free [HYBRID] line and reports the feature as active', async () => {
  const user = 'hy-shadow-log';
  await seed(user);
  process.env.AQUA_HYBRID_CONTEXT = 'shadow';
  const logs = await withLogs(async () => { await post(user, QUESTION); });
  const state = featureStatus().find(f => f.name === 'AQUA_HYBRID_CONTEXT').state;
  const line = logs.find(l => l.startsWith('[HYBRID]'));
  assert.ok(line, 'logged');
  assert.match(line, /^\[HYBRID\] mode=shadow reason=\S+ added=\d+ dup=\d+ weak=\d+ conflicts=\d+ changes=\d+ ended=\d+ ambiguous=\d+ unknowns=\d+ not_matched=\d+ not_retrieved=\d+ question=[01] tokens=\d+ trimmed=\d+ ms=[\d.-]+ owner=#[0-9a-f]{8} req=\S+$/);
  for (const s of ['camper', '17,500', '19,000', 'Teo', 'pilot', 'fence', user]) assert.ok(!line.includes(s), `no "${s}"`);
  assert.equal(state, 'active');
});

test('an engine error under on serves the existing context unchanged', async () => {
  const off = await promptUnder(null, 'hy-err-off');
  IN.__failNextForTests(Object.assign(new Error('boom with private words camper'), { name: 'TypeError' }));
  const on = await promptUnder('on', 'hy-err-on');
  assert.equal(on.r.status, 200);
  assert.equal(on.prompt, off.prompt);
  const line = on.logs.find(l => l.startsWith('[HYBRID]'));
  assert.match(line, /reason=engine-TypeError/);
  assert.doesNotMatch(on.logs.join('\n'), /boom with private words/);
});

test('a failed provider turn under on leaves no memory', async () => {
  process.env.AQUA_HYBRID_CONTEXT = 'on';
  fail = true;
  const r = await post('hy-fail', 'My name is Quorrin and I work at Kestrel Labs. Should we buy the camper van?');
  assert.ok(r.status >= 500);
  await new Promise(res => setTimeout(res, 150));
  assert.deepEqual(getFacts('user:hy-fail'), []);
});

test('isolation: one user\'s history never appears in another\'s block', async () => {
  await post('hy-iso-b', 'A second-hand camper van is about 99,999. My accountant is Zelda Quist.');
  const on = await promptUnder('on', 'hy-iso-a');
  assert.doesNotMatch(on.prompt, /99,999|Zelda/);
});

test('precedence: with AQUA_INFO_NEEDS=on as well, the existing context is kept (no replacement)', async () => {
  const off = await promptUnder(null, 'hy-prec-off');
  const both = await promptUnder('on', 'hy-prec-both', '/chat', { AQUA_INFO_NEEDS: 'on' });
  assert.equal(stripBlock(both.prompt), off.prompt, 'the existing context is not replaced');
  assert.doesNotMatch(both.prompt, /--- INFORMATION NEEDS \(what this question requires/, 'the replacement block is not used');
});

test('a long history: the block stays within its token budget', async () => {
  const user = 'hy-long';
  const filler = Array.from({ length: 80 }, (_, i) => `Note ${i}: I tidied shelf ${i} and found ${i} receipts.`);
  await seed(user, [...filler, ...HISTORY]);
  process.env.AQUA_HYBRID_CONTEXT = 'on';
  process.env.AQUA_HYBRID_MAX_TOKENS = '120';
  calls.length = 0;
  let logs;
  try { logs = await withLogs(async () => { await post(user, QUESTION); }); } finally { delete process.env.AQUA_HYBRID_MAX_TOKENS; }
  const line = logs.find(l => l.startsWith('[HYBRID]'));
  const tokens = Number(line.match(/tokens=(\d+)/)[1]);
  assert.ok(tokens <= 120, `tokens ${tokens}`);
});

test('an unrelated, impersonal question adds nothing under on', async () => {
  const off = await promptUnder(null, 'hy-imp-off');
  calls.length = 0;
  await seed('hy-imp-on');
  process.env.AQUA_HYBRID_CONTEXT = 'on';
  await post('hy-imp-on', 'How far is Mars from the Sun?');
  const onPrompt = answerPrompt('hy-imp-on');
  assert.doesNotMatch(onPrompt, /NEEDS CHECK/);
  assert.ok(off.prompt.length > 0);
});
