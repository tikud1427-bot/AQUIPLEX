/**
 * Semantic recall query vector: started at the top of the turn, reused by recall
 * (2026-11-05). The live run measured 608–699 ms per single embedding; awaited
 * in sequence inside recall it added that to every ranked turn. Now it overlaps
 * the turn's earlier work, and recall reuses the vector — never a second call.
 *
 * Real chat turn (routes/chat.js prepareTurn), private data dir, slow FAKE
 * dedicated transport (no network), no database.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-semantic-latency-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && !['AQUA_DATA_DIR', 'AQUA_DISABLE_MONGO_MIRROR'].includes(k)) delete process.env[k];
  if (/(_API_KEY|^GEMINI_KEY|^GEMINI_API|^Gemini_API|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}

const store = await import('../conversationStore.js');
const DE = await import('../../embeddings/dedicatedEmbedder.js');
const SR = await import('../semanticRecall.js');
const R = await import('../episodicRecall.js');
const { EMBED_DIM } = await import('../../embeddings/embeddingModel.js');
const { prepareTurn } = await import('../../routes/chat.js');
const { createContext } = await import('../../core/observability.js');

const DAY = 86_400_000;
const FUNDING = ['funding', 'fundraising', 'seed', 'round', 'investors', 'sequoia'];
const vec = t => { const w = String(t).toLowerCase().match(/[a-z]+/g) ?? []; const v = new Array(EMBED_DIM).fill(0); v[0] = w.filter(x => FUNDING.includes(x)).length; v[1] = w.filter(x => ['pasta', 'dinner', 'sunny', 'weather'].includes(x)).length; v[2] = 0.15; return v; };
let delayMs = 300;
const calls = [];
DE.__setDedicatedTransportForTests(async (key, texts) => {
  calls.push({ at: Date.now(), texts: [...texts] });
  await new Promise(r => setTimeout(r, delayMs));
  return { embeddings: texts.map(t => ({ values: vec(t) })) };
});

let n = 0;
function told(userId, sentences, daysAgo, conv = `told-${userId}-${n++}`) {
  store.getOrCreateConversation(conv, { userId });
  for (const s of sentences) { store.addMessage(conv, 'user', s); store.addMessage(conv, 'assistant', 'Got it.'); }
  store.getAllConversations().get(conv).messages.forEach(m => { m.ts -= daysAgo * DAY; });
  return conv;
}
const filler = i => `On day ${i} the weather was sunny and I made pasta for dinner, nothing else worth noting today, entry ${i}.`;
async function longHistory(user) {
  told(user, ['We closed our seed round with Sequoia.'], 20);
  told(user, Array.from({ length: 70 }, (_, i) => filler(i)), 10);
  // Vectors exist already (as after earlier turns), so the turn's only query-path call is the query vector.
  R.__clearCacheForTests();
  const units = R.collectUnits({ userId: user, conversationId: 'none' });
  await SR.indexRecallUnits(`user:${user}`, units, { limit: 1000 });
}
const ask = async (userId, q, conv = `ask-${userId}-${n++}`) => {
  store.getOrCreateConversation(conv, { userId });
  return prepareTurn({ userMessage: q, workspaceId: null, conversationId: conv, userId, ctx: createContext({ conversationId: conv, requestId: conv }), requestId: conv, skipReasoningPass: true });
};
const queryCalls = q => calls.filter(c => c.texts.length === 1 && c.texts[0] === q);

beforeEach(() => {
  process.env.AQUA_SEMANTIC_RECALL = 'on';
  process.env.AQUA_EMBEDDING_API_KEY = 'test-only-dedicated-recall-key';
  DE.__resetDedicatedForTests();
  delayMs = 300;
  calls.length = 0;
});

test('the query vector starts at the top of the turn and recall reuses it: one call, the semantic match quoted', async () => {
  await longHistory('lat1');
  calls.length = 0;
  const q = "How's fundraising going?";
  const t0 = Date.now();
  const p = await ask('lat1', q);
  const qc = queryCalls(q);
  assert.equal(qc.length, 1, 'exactly one query embedding call');
  assert.ok(qc[0].at - t0 < 40, `started ${qc[0].at - t0} ms into the turn`);
  assert.match(p.systemPrompt, /We closed our seed round with Sequoia\./, 'the early vector was used');
});

test('no early call when recall would not rank (short history): zero query embeddings', async () => {
  told('lat2', ['We closed our seed round with Sequoia.'], 5);
  calls.length = 0;
  await ask('lat2', "How's fundraising going?");
  assert.equal(queryCalls("How's fundraising going?").length, 0);
});

test('history long only through the current conversation: no early start, recall embeds once (no duplicate)', async () => {
  const conv = told('lat3', ['We closed our seed round with Sequoia.', ...Array.from({ length: 70 }, (_, i) => filler(i))], 3, 'lat3-current');
  R.__clearCacheForTests();
  await SR.indexRecallUnits('user:lat3', R.collectUnits({ userId: 'lat3', conversationId: 'none' }), { limit: 1000 });
  calls.length = 0;
  await ask('lat3', 'Anything about investors?', conv);
  assert.ok(queryCalls('Anything about investors?').length <= 1);
});

test('the 1.5 s timeout still holds: a provider slower than that is not waited for, keyword recall answers', async () => {
  await longHistory('lat4');
  calls.length = 0;
  delayMs = 2500;
  const t0 = Date.now();
  const p = await ask('lat4', "How's fundraising going?");
  const took = Date.now() - t0;
  assert.ok(took < 2300, `turn took ${took} ms`);
  assert.doesNotMatch(p.systemPrompt, /seed round/, 'no semantic hit without a vector');
});

test('switch off or no dedicated key: no early call at all', async () => {
  await longHistory('lat5');
  for (const env of [{ AQUA_SEMANTIC_RECALL: '' }, { AQUA_EMBEDDING_API_KEY: '' }]) {
    calls.length = 0;
    Object.assign(process.env, env);
    await ask('lat5', "How's fundraising going?");
    assert.equal(calls.length, 0, JSON.stringify(env));
    process.env.AQUA_SEMANTIC_RECALL = 'on'; process.env.AQUA_EMBEDDING_API_KEY = 'test-only-dedicated-recall-key';
  }
});
