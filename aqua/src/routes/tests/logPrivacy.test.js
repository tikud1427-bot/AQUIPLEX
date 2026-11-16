/**
 * Sprint 1 Task A — user content must not reach the logs (2026-11-10).
 *
 * The audit (F-09) measured 38 log lines carrying user text across five
 * ordinary turns: the extractor's INPUT/MATCH lines, `[MEMORY]` events with
 * `key=value`, MEMORY_RANKED printing the raw message (health and mood
 * sentences the sensitivity policy refuses to STORE), uploaded file names.
 *
 * This drives the REAL chat and upload routes — success on POST /chat and
 * /chat/stream, provider failure on both, an upload with a personal file name,
 * a forget — with sentinel words that cannot occur anywhere else, and captures
 * every console method and stderr. A sentinel in the capture is a leak.
 *
 * The provider is a fake Groq client (the SDK seam keyFailover.test.js uses):
 * no network, deterministic answers, and a switch to make it fail.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-log-privacy-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.AQUA_EMBEDDINGS = 'off';
delete process.env.AQUA_LOG_CONTENT;
for (const k of Object.keys(process.env)) {
  if (/(_API_KEY|_KEY_\d+|_KEYS)$|^OPENROUTER|^GROQ|^GEMINI|^NVIDIA|^OPENAI|^TAVILY|^SERPER|^BRAVE|^EXA/i.test(k)) delete process.env[k];
}
process.env.GROQ_API_KEY_1 = 'gsk_test_fake_key_for_log_privacy_0001';

const Q = await import('../../providers/groq.js');
let failProvider = false;
Q.__setClientFactoryForTests(() => ({ chat: { completions: { create: async body => {
  if (failProvider) { const e = new Error('upstream unavailable'); e.status = 503; throw e; }
  const text = 'Here is a helpful, general answer.';
  if (body.stream) return (async function* () { yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] }; })();
  return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 6 } };
} } } }));

const { default: chatRoute } = await import('../chat.js');
const { default: uploadRoute } = await import('../upload.js');
const { textMeta, valueMeta, safeKey, fileMeta, safeDetails, errorMeta, stripQuoted, contentLoggingAllowed } = await import('../../core/logSafety.js');
const { logMemoryEvent, logSearchEvent } = await import('../../core/observability.js');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req, _res, next) => { req.aquaUserId = 'log-privacy-user'; next(); });
app.use('/chat', chatRoute);
app.use('/upload', uploadRoute);
let server, base;
before(() => { server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

const SENTINELS = ['Zorblaxian', 'Quillverton', 'Brimwaterhouse', 'Faxonelle', 'Pelloquist', 'Vantrecor', 'Oskelvane', 'Thrennodine'];
const SENSITIVE = /therapist|anxiety|diagnosis|medical-report/i;

/** Record every console method and stderr while `fn` runs. Pass-through kept. */
async function capture(fn) {
  const out = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const orig = Object.fromEntries(methods.map(m => [m, console[m]]));
  const origErr = process.stderr.write;
  for (const m of methods) console[m] = (...a) => { out.push(a.map(x => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ')); };
  process.stderr.write = (chunk, ...rest) => { out.push(String(chunk)); return true; };
  try { await fn(); await new Promise(r => setTimeout(r, 400)); }   // deferred post-turn logs
  finally { for (const m of methods) console[m] = orig[m]; process.stderr.write = origErr; }
  return out;
}
const leaks = lines => lines.filter(l => SENTINELS.some(s => l.includes(s)) || SENSITIVE.test(l));
const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).text();

test('chat + stream + upload + forget + failed turns: no user text in any log line', async () => {
  const lines = await capture(async () => {
    failProvider = false;
    await post('/chat', { message: `My name is ${SENTINELS[0]} and I work at ${SENTINELS[1]} Labs. My therapist says my anxiety is getting worse.` });
    await post('/chat/stream', { message: `Actually my company is now ${SENTINELS[2]}. My goal is to launch ${SENTINELS[3]} by March 3.` });
    await post('/upload', { files: [{ name: `${SENTINELS[4]}-medical-report.txt`, content: Buffer.from(`Patient ${SENTINELS[5]} diagnosis notes`).toString('base64') }] });
    await post('/chat', { message: `Forget my company. Where does ${SENTINELS[0]} work?` });
    failProvider = true;
    await post('/chat/stream', { message: `My sister ${SENTINELS[6]} works at ${SENTINELS[7]}.` });
    await post('/chat', { message: `My sister ${SENTINELS[6]} works at ${SENTINELS[7]}.` });
    failProvider = false;
  });
  // Positive control: the pipeline really logged (observability kept).
  assert.ok(lines.some(l => l.includes('[EXTRACTOR] INPUT len=')), 'extractor still reports each input');
  assert.ok(lines.some(l => l.includes('[MEM_RETRIEVER] MEMORY_RANKED')), 'retriever still reports ranking');
  assert.ok(lines.some(l => l.includes('"event":"EXTRACTED"')), 'memory events still emitted');
  assert.ok(lines.length > 40, `expected a normal volume of logging, got ${lines.length}`);
  const bad = leaks(lines);
  assert.deepEqual(bad, [], `user content reached the logs:\n${bad.join('\n')}`);
});

test('memory events keep field names and drop values', () => {
  return capture(async () => {
    logMemoryEvent({ requestId: 'r1', conversationId: 'c1' }, 'EXTRACTED', [`name=${SENTINELS[0]}`, `workplace=${SENTINELS[1]} Labs`, `custom_secret_lover=${SENTINELS[2]}`]);
  }).then(lines => {
    const line = lines.find(l => l.includes('AQUA_MEMORY'));
    assert.ok(line, 'event logged');
    assert.match(line, /"name"/);
    assert.match(line, /"workplace"/);
    assert.match(line, /custom_#[0-9a-f]{8}/, 'custom_ key tails are hashed (built from the user\'s words)');
    assert.deepEqual(leaks(lines), []);
    assert.doesNotMatch(line, /secret_lover/);
  });
});

test('search events log the query as length + hash only', async () => {
  const lines = await capture(async () => {
    logSearchEvent({ requestId: 'r2', conversationId: 'c2' }, { used: true, cached: false, provider: 'x', query: `latest news on ${SENTINELS[3]}`, sources: [] });
  });
  assert.deepEqual(leaks(lines), []);
  assert.ok(lines.some(l => /"query":"len=\d+ h=[0-9a-f]{8}"/.test(l)), lines.join('\n'));
});

test('helpers: metadata only, stable within the process, distinct across inputs', () => {
  const a = textMeta(`hello ${SENTINELS[0]}`), b = textMeta(`hello ${SENTINELS[0]}`), c = textMeta('something else');
  assert.equal(a, b, 'equal inputs correlate');
  assert.notEqual(a, c);
  assert.doesNotMatch(a, new RegExp(SENTINELS[0]));
  assert.equal(valueMeta(['a', 'b']), 'list(2)');
  assert.equal(valueMeta(SENTINELS[1]), `string(len=${SENTINELS[1].length})`);
  assert.equal(safeKey('workplace'), 'workplace');
  assert.match(safeKey('custom_divorce_lawyer'), /^custom_#[0-9a-f]{8}$/);
  assert.match(safeKey('a key with spaces'), /^key#[0-9a-f]{8}$/);
  assert.match(fileMeta('Medical report Jane.PDF'), /^file\(ext=pdf len=23 h=[0-9a-f]{8}\)$/);
  assert.deepEqual(safeDetails(['name=Ana', 'goal']), ['name', 'goal']);
  assert.equal(stripQuoted(`Unexpected token "${SENTINELS[0]}" at 'x'`), `Unexpected token "…" at '…'`);
});

test('errorMeta: a body-parser parse error never carries the body', () => {
  const err = Object.assign(new SyntaxError(`Unexpected token ${SENTINELS[0]} in JSON at position 3`), { type: 'entity.parse.failed', status: 400, body: `{"message": "${SENTINELS[0]}"` });
  const s = errorMeta(err);
  assert.doesNotMatch(s, new RegExp(SENTINELS[0]));
  assert.match(s, /type=entity\.parse\.failed/);
  assert.match(s, /status=400/);
  const other = errorMeta(Object.assign(new Error(`bad value "${SENTINELS[1]}"`), { code: 'E_X' }));
  assert.match(other, /code=E_X/);
  assert.doesNotMatch(other, new RegExp(SENTINELS[1]), 'quoted spans are stripped from messages');
});

test('AQUA_LOG_CONTENT=local re-enables content only off production', () => {
  assert.equal(contentLoggingAllowed({}), false, 'default: off');
  assert.equal(contentLoggingAllowed({ AQUA_LOG_CONTENT: 'local' }), true);
  assert.equal(contentLoggingAllowed({ AQUA_LOG_CONTENT: 'local', NODE_ENV: 'production' }), false, 'never with NODE_ENV=production');
  assert.equal(contentLoggingAllowed({ AQUA_LOG_CONTENT: 'local', RENDER: 'true' }), false, 'never on Render');
  assert.equal(contentLoggingAllowed({ AQUA_LOG_CONTENT: 'on' }), false, 'only the exact value');
});

/**
 * Static guard: the specific shapes that leaked must not come back. Narrow on
 * purpose — the behavioural test above is the real check; this one fails fast
 * at the line that reintroduces the pattern, with its location.
 */
test('no console call interpolates a raw message, query, sentence or JSON value', () => {
  const src = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
  const RAW = /console\.(log|warn|error|info|debug)\(.*\$\{\s*(query|userMessage|message|sentence|normalizedQuery|bq|text)(\.slice\([^)]*\))?\s*\}/;
  const JSONVAL = /console\.(log|warn|error|info|debug)\(.*JSON\.stringify\(\s*(c|r|f|fact)\.(value|previousValue)\)/;
  const hits = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(m?js|cjs)$/.test(e.name) || /\.test\./.test(e.name)) continue;
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (RAW.test(line) || JSONVAL.test(line)) hits.push(`${path.relative(src, p)}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
  };
  walk(src);
  assert.deepEqual(hits, [], `content-logging pattern found:\n${hits.join('\n')}`);
});
