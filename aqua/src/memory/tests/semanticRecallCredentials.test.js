/**
 * Semantic episodic recall uses its OWN credential (AQUA_EMBEDDING_API_KEY) and
 * nothing else (2026-11-05). The shared Gemini pool (GEMINI_KEY_*, GEMINI_API_KEY)
 * stays the fact / file / chat credential; recall never falls back to it.
 *
 * Fake credential values only; the network call is replaced
 * (__setDedicatedTransportForTests), so the key-selection logic runs for real
 * and nothing leaves the process. Private data dir.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-recall-credentials-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && !['AQUA_DATA_DIR', 'AQUA_DISABLE_MONGO_MIRROR'].includes(k)) delete process.env[k];
  if (/(_API_KEY|^GEMINI_KEY|^GEMINI_API|^Gemini_API|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}
// A shared Gemini credential IS present (fake value): recall must not use it.
const SHARED = 'shared-gemini-fake-value-0000';
const DEDICATED = 'dedicated-recall-fake-value-1111';
process.env.GEMINI_KEY_1 = SHARED;
process.env.GEMINI_API_KEY = SHARED;

const R = await import('../episodicRecall.js');
const SR = await import('../semanticRecall.js');
const DE = await import('../../embeddings/dedicatedEmbedder.js');
const EP = await import('../../embeddings/embeddingProvider.js');
const VS = await import('../../embeddings/vectorStore.js');
const { EMBED_DIM } = await import('../../embeddings/embeddingModel.js');

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);
const vecOf = t => { const v = new Array(EMBED_DIM).fill(0.01); v[0] = /seed|fund|round|sequoia/i.test(t) ? 1 : 0; v[1] = /pasta|sunny/i.test(t) ? 1 : 0; return v; };
const transportCalls = [];
const transport = (key, texts) => { transportCalls.push({ key, n: texts.length }); return { embeddings: texts.map(t => ({ values: vecOf(t) })) }; };
const sharedCalls = [];

function convs() {
  const msgs = [['We closed our seed round with Sequoia.', 1], ...Array.from({ length: 70 }, (_, i) => [`On day ${i} the weather was sunny and I made pasta for dinner, nothing else worth noting, entry ${i}.`, 5])];
  return new Map([['a', { meta: { userId: 'u1', title: 'a' }, messages: msgs.map(([content, day], i) => ({ role: 'user', content, ts: T0 + day * DAY + i })) }]]);
}
const turn = c => R.recallForTurn({ ownerId: 'user:u1', userId: 'u1', conversationId: 'now', query: "How's fundraising going?", conversations: c, includeFiles: false });
const units = c => R.collectUnits({ userId: 'u1', conversationId: 'now', conversations: c });

beforeEach(() => {
  R.__clearCacheForTests(); VS.__resetForTests(); DE.__resetDedicatedForTests();
  transportCalls.length = 0; sharedCalls.length = 0;
  DE.__setDedicatedTransportForTests(transport);
  EP.__setEmbedderForTests(texts => { sharedCalls.push(...texts); return texts.map(vecOf); });   // the SHARED path, instrumented
  process.env.AQUA_SEMANTIC_RECALL = 'on';
  delete process.env.AQUA_EMBEDDING_API_KEY;
});
afterEach(() => { DE.__clearDedicatedTransportForTests(); EP.__clearEmbedderForTests(); delete process.env.AQUA_SEMANTIC_RECALL; delete process.env.AQUA_EMBEDDING_API_KEY; });

test('no dedicated key: inactive even with the switch on and shared Gemini keys present', () => {
  assert.equal(EP.isEmbeddingEnabled(), true, 'precondition: the shared path is usable');
  assert.equal(DE.dedicatedEmbeddingEnabled(), false);
  assert.equal(SR.semanticRecallEnabled(), false);
});

test('no dedicated key: a full recall turn and an index pass make no embedding call of any kind', async () => {
  const c = convs();
  const keywordOnly = R.selectRecall(units(c), "How's fundraising going?", { redaction: { isRedacted: () => false } });
  const r = await turn(c);
  const idx = await SR.indexRecallUnits('user:u1', units(c), { limit: 1000 });
  assert.equal(transportCalls.length, 0, 'dedicated transport never called');
  assert.equal(sharedCalls.length, 0, 'shared Gemini embedder never called');
  assert.equal(idx.embedded, 0);
  assert.deepEqual(r.excerpts.map(e => e.key), keywordOnly.excerpts.map(e => e.key), 'exactly the keyword recall');
  assert.notEqual(r.stats.mode, 'hybrid');
});

test('an empty or whitespace key counts as missing', () => {
  for (const v of ['', '   ']) { process.env.AQUA_EMBEDDING_API_KEY = v; assert.equal(SR.semanticRecallEnabled(), false, JSON.stringify(v)); }
});

test('with the dedicated key: every call carries that key, never a shared one', async () => {
  process.env.AQUA_EMBEDDING_API_KEY = DEDICATED;
  const c = convs();
  await SR.indexRecallUnits('user:u1', units(c), { limit: 1000 });
  const r = await turn(c);
  assert.ok(transportCalls.length >= 2, 'index + query went through the dedicated transport');
  assert.ok(transportCalls.every(x => x.key === DEDICATED));
  assert.equal(sharedCalls.length, 0, 'the shared pool is not used, not even for the query vector');
  assert.ok(r.excerpts.some(e => /seed round/.test(e.text)), 'semantic recall works on the dedicated key');
});

test('the shared path is unchanged: fact/file embeddings still use the shared embedder, not the dedicated key', async () => {
  process.env.AQUA_EMBEDDING_API_KEY = DEDICATED;
  const v = await EP.embedOne('my workplace: Northbeam');
  assert.ok(Array.isArray(v));
  assert.equal(sharedCalls.length, 1);
  assert.equal(transportCalls.length, 0);
});

test('caches are separate: a vector embedded on the shared path is never reused by recall', async () => {
  process.env.AQUA_EMBEDDING_API_KEY = DEDICATED;
  await EP.embedOne("How's fundraising going?");               // shared cache now holds the query
  await DE.dedicatedEmbedOne("How's fundraising going?");
  assert.equal(transportCalls.length, 1, 'recall embedded it itself');
  await DE.dedicatedEmbedOne("How's fundraising going?");
  assert.equal(transportCalls.length, 1, 'and cached it in its own cache');
});

test('vectors written by another credential path are not trusted (re-embedded)', async () => {
  process.env.AQUA_EMBEDDING_API_KEY = DEDICATED;
  const c = convs();
  const u = units(c)[0];
  VS.upsert(SR.recallNamespace('user:u1'), u.key, vecOf(u.text), EP.contentHash(u.text));   // as the shared-path build stored it
  await SR.indexRecallUnits('user:u1', [u], { limit: 10 });
  assert.equal(transportCalls.length, 1, 'replaced with a dedicated-credential vector');
});

test('credentials never appear in logs or errors', async () => {
  process.env.AQUA_EMBEDDING_API_KEY = DEDICATED;
  const logged = [];
  const orig = { warn: console.warn, log: console.log, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => logged.push(a.map(String).join(' '));
  try {
    DE.__setDedicatedTransportForTests(() => { const e = new Error(`request failed for key ${DEDICATED} (also tried ${SHARED})`); e.status = 500; throw e; });
    const v = await DE.dedicatedEmbedOne('anything at all');
    assert.equal(v, null);
    const stats = {};
    await SR.semanticScores('user:u1', units(convs()), 'other question', { stats });
    assert.ok(logged.length > 0, 'the failure was logged');
    for (const line of [...logged, JSON.stringify(stats), JSON.stringify(DE.dedicatedEmbedderStatus())]) {
      assert.ok(!line.includes(DEDICATED), `no dedicated key in: ${line.slice(0, 120)}`);
      assert.ok(!line.includes(SHARED), `no shared key in: ${line.slice(0, 120)}`);
    }
  } finally { Object.assign(console, orig); }
});

test('a rejected dedicated key stops calls (no hammering) and does not fall back to the shared pool', async () => {
  process.env.AQUA_EMBEDDING_API_KEY = DEDICATED;
  let n = 0;
  DE.__setDedicatedTransportForTests(() => { n++; const e = new Error('API key not valid'); e.status = 401; throw e; });
  assert.equal(await DE.dedicatedEmbedOne('first'), null);
  assert.equal(await DE.dedicatedEmbedOne('second'), null);
  assert.equal(n, 1, 'one attempt, then the key is held back');
  assert.equal(DE.dedicatedEmbedderStatus().state, 'rejected');
  assert.equal(SR.semanticRecallEnabled(), false, 'recall goes inactive');
  assert.equal(sharedCalls.length, 0);
});
