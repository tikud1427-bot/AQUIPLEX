/**
 * Semantic episodic recall (memory/semanticRecall.js + episodicRecall.js, 2026-11-05).
 *
 * Recall ranked the user's past words by keyword overlap only (BM25), so once a
 * history outgrew the whole-history window, "How's fundraising going?" could not
 * find "We closed our seed round". Semantic recall adds embedding similarity and
 * recency to the keyword score — keyword recall is unchanged without it.
 *
 * No network: a deterministic fake embedder (concept vectors) stands in for the
 * provider through embeddingProvider.__setEmbedderForTests. Private data dir.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-semantic-recall-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && !['AQUA_DATA_DIR', 'AQUA_DISABLE_MONGO_MIRROR'].includes(k)) delete process.env[k];
  if (/(_API_KEY|^GEMINI_KEY|^GEMINI_API|^Gemini_API|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}

const R = await import('../episodicRecall.js');
const SR = await import('../semanticRecall.js');
const RR = await import('../recallRedactions.js');
const DE = await import('../../embeddings/dedicatedEmbedder.js');
const { EMBED_DIM } = await import('../../embeddings/embeddingModel.js');
const VS = await import('../../embeddings/vectorStore.js');
const { deleteMind } = await import('../../mind/mindStore.js');
const { sensitivePolicy } = await import('../sensitivity.js');
const { GATES } = await import('../../core/flags.js');

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);

// ── Fake embedder: words → concept dimensions (synonyms share a dimension) ─────
const CONCEPTS = [
  ['funding', 'fundraising', 'seed', 'round', 'raised', 'investors', 'investment', 'sequoia', 'vc'],
  ['marathon', 'race', 'running', 'run', 'ran', 'jog', 'jogging', '21km'],
  ['release', 'launch', 'launched', 'launching', 'ship', 'shipping', 'go-live'],
  ['pasta', 'lunch', 'dinner', 'cooking', 'recipe', 'food'],
  ['weather', 'rain', 'sunny', 'cold'],
  ['depressed', 'anxious', 'sad', 'therapy'],
  ['dog', 'puppy', 'walk', 'vet'],
];
const calls = [];
function fakeVec(text) {
  const w = String(text).toLowerCase().match(/[a-z0-9-]+/g) ?? [];
  const v = CONCEPTS.map(group => w.filter(x => group.includes(x)).length);
  v.push(0.15);                                   // small shared component: unrelated texts stay well below the floor
  return v;
}
const embedder = texts => { calls.push(...texts); return texts.map(fakeVec); };
// Recall embeds through its DEDICATED credential only (embeddings/dedicatedEmbedder.js):
// the fake replaces that module's network call; the key check stays real.
const pad = v => [...v, ...new Array(EMBED_DIM - v.length).fill(0)];
const useEmbedder = fn => DE.__setDedicatedTransportForTests(async (key, texts) => ({ embeddings: (await fn(texts)).map(v => ({ values: v ? pad(v) : null })) }));

function convs(spec) {
  const m = new Map();
  for (const [id, { userId = 'u1', title = id, msgs }] of Object.entries(spec)) {
    m.set(id, { meta: { userId, title }, messages: msgs.map(([content, day], i) => ({ role: 'user', content, ts: T0 + day * DAY + i })) });
  }
  return m;
}
// Long enough that recall ranks instead of quoting everything (> allUnderChars).
const FILLER = Array.from({ length: 70 }, (_, i) => [`On day ${i} the weather was sunny and I made pasta for dinner, nothing else worth noting today number ${i}.`, i % 20]);

const turn = (c, query, extra = {}) => R.recallForTurn({ ownerId: 'user:u1', userId: 'u1', conversationId: 'now', query, conversations: c, includeFiles: false, ...extra });

beforeEach(() => {
  R.__clearCacheForTests(); RR.__resetForTests(); VS.__resetForTests(); calls.length = 0;
  DE.__resetDedicatedForTests();
  useEmbedder(embedder);
  process.env.AQUA_EMBEDDING_API_KEY = 'test-only-dedicated-recall-key';
  process.env.AQUA_SEMANTIC_RECALL = 'on';
});
afterEach(() => { DE.__clearDedicatedTransportForTests(); delete process.env.AQUA_SEMANTIC_RECALL; delete process.env.AQUA_EMBEDDING_API_KEY; });

async function indexed(c) {
  await SR.indexRecallUnits('user:u1', R.collectUnits({ userId: 'u1', conversationId: 'now', conversations: c }), { limit: 1000 });
}

describe('kill switch and fallback', () => {
  test('registered, off by default: recall is the keyword recall, and nothing is embedded', async () => {
    const g = GATES.find(x => x.name === 'AQUA_SEMANTIC_RECALL');
    assert.equal(g?.dflt, 'off');
    delete process.env.AQUA_SEMANTIC_RECALL;
    const c = convs({ a: { msgs: [['We closed our seed round with Sequoia.', 1], ...FILLER] } });
    const r = await turn(c, "How's fundraising going?");
    assert.equal(calls.length, 0, 'no embedding call with the switch off');
    assert.equal(SR.semanticRecallEnabled(), false);
    assert.ok(!r.excerpts.some(e => /seed round/.test(e.text)), 'keyword recall alone cannot find it');
  });

  test('with no dedicated key, the switch alone does nothing', () => {
    delete process.env.AQUA_EMBEDDING_API_KEY;
    assert.equal(SR.semanticRecallEnabled(), false);
  });

  test('provider failure (throws or nulls): the keyword result, unchanged, no throw', async () => {
    const c = convs({ a: { msgs: [['Our launch is on March 3.', 1], ...FILLER] } });
    const keywordOnly = R.selectRecall(R.collectUnits({ userId: 'u1', conversationId: 'now', conversations: c }), 'When is the launch?', { redaction: RR.redactionsFor('user:u1') });
    for (const broken of [() => { throw new Error('provider down'); }, texts => texts.map(() => null)]) {
      useEmbedder(broken); DE.__resetDedicatedForTests(); VS.__resetForTests(); R.__clearCacheForTests();
      const r = await turn(c, 'When is the launch?');
      assert.deepEqual(r.excerpts.map(e => e.key), keywordOnly.excerpts.map(e => e.key));
      assert.notEqual(r.stats.mode, 'hybrid');
    }
  });

  test('a slow query embedding times out to keyword recall', async () => {
    const c = convs({ a: { msgs: [['Our launch is on March 3.', 1], ...FILLER] } });
    await indexed(c);
    useEmbedder(texts => new Promise(res => setTimeout(() => res(texts.map(fakeVec)), 400)));
    const t0 = Date.now();
    const r = await turn(c, 'When is the release?', { semanticTimeoutMs: 50 });
    assert.ok(Date.now() - t0 < 350, 'did not wait for the slow provider');
    assert.equal(r.stats.semantic?.timedOut, true);
    assert.notEqual(r.stats.mode, 'hybrid');
  });
});

describe('retrieval', () => {
  test('a different wording finds the memory (semantic match)', async () => {
    const c = convs({ a: { msgs: [['We closed our seed round with Sequoia.', 1], ...FILLER] } });
    await indexed(c);
    const r = await turn(c, "How's fundraising going?");
    assert.equal(r.stats.mode, 'hybrid');
    const hit = r.excerpts.find(e => /seed round/.test(e.text));
    assert.ok(hit, 'found through meaning, not words');
    assert.equal(hit.why, 'semantic');
  });

  test('a keyword match still works with semantic on', async () => {
    const c = convs({ a: { msgs: [['My dentist is Dr. Okafor on Elm Street.', 2], ...FILLER] } });
    await indexed(c);
    const r = await turn(c, 'Who is my dentist?');
    assert.ok(r.excerpts.some(e => /Okafor/.test(e.text) && e.why === 'match'));
  });

  test('combined ranking: keyword + meaning beats either alone', async () => {
    const both = 'The launch slipped, we now plan to ship the release in April.';
    const c = convs({ a: { msgs: [
      ['Shipping the go-live is what keeps me up at night.', 3],            // meaning only (no query word)
      [both, 4],                                                            // keyword "release" + meaning
      ['The pasta recipe needs a slow release of steam while cooking dinner food.', 5], // keyword only, other meaning
      ...FILLER,
    ] } });
    await indexed(c);
    const ranked = SR.rankHybrid(R.collectUnits({ userId: 'u1', conversationId: 'now', conversations: c }), 'When is the release?',
      await SR.semanticScores('user:u1', R.collectUnits({ userId: 'u1', conversationId: 'now', conversations: c }), 'When is the release?'));
    assert.equal(ranked[0].unit.text, both);
  });

  test('recency: of two equally relevant memories the later ranks first', async () => {
    const c = convs({ a: { msgs: [['I ran a race in the spring.', 1], ['I ran a race in the autumn.', 30], ...FILLER] } });
    await indexed(c);
    const units = R.collectUnits({ userId: 'u1', conversationId: 'now', conversations: c });
    const ranked = SR.rankHybrid(units, 'How did my marathon go?', await SR.semanticScores('user:u1', units, 'How did my marathon go?'));
    assert.match(ranked[0].unit.text, /autumn/);
  });

  test('the same sentence said twice is quoted once — the later occurrence, its own date and conversation', async () => {
    const s = 'We closed our seed round with Sequoia.';
    const c = convs({ a: { msgs: [[s, 1], ...FILLER] }, b: { title: 'Board prep', msgs: [[s, 25]] } });
    await indexed(c);
    const r = await turn(c, "How's fundraising going?");
    const hits = r.excerpts.filter(e => e.text === s);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].conversationId, 'b');
    assert.equal(hits[0].ts, T0 + 25 * DAY);
  });

  test('wording, conversation and timestamp are the original ones', async () => {
    const s = 'We closed our seed round with Sequoia.';
    const c = convs({ a: { title: 'Investor update', msgs: [[s, 3], ...FILLER] } });
    await indexed(c);
    const r = await turn(c, "How's fundraising going?");
    const hit = r.excerpts.find(e => e.text === s);
    assert.equal(hit.conversationId, 'a');
    assert.equal(hit.ts, T0 + 3 * DAY);
    assert.match(r.block, /\[2026-09-04 · "Investor update"\] We closed our seed round with Sequoia\./, 'rendered dated, in the user\'s words');
  });

  test('an old statement found by meaning brings its later change with it (not presented as current)', async () => {
    const c = convs({ a: { msgs: [
      ['We plan to launch on March 3.', 1],
      ['Update: the launch moved to April 20.', 9],
      ...FILLER,
    ] } });
    await indexed(c);
    const r = await turn(c, 'When is our go-live?');
    const texts = r.excerpts.map(e => e.text);
    assert.ok(texts.includes('We plan to launch on March 3.'));
    assert.ok(texts.includes('Update: the launch moved to April 20.'), 'the later word is quoted too');
    assert.ok(texts.indexOf('We plan to launch on March 3.') < texts.indexOf('Update: the launch moved to April 20.'), 'chronological: the newer one reads last');
  });
});

describe('privacy, deletion and cost', () => {
  test('a forgotten (redacted) sentence is never embedded and never quoted', async () => {
    RR.redactPhrases('user:u1', ['Sequoia']);
    const c = convs({ a: { msgs: [['We closed our seed round with Sequoia.', 1], ...FILLER] } });
    await indexed(c);
    assert.ok(!calls.some(t => /Sequoia/.test(t)), 'not sent to the provider');
    const r = await turn(c, "How's fundraising going?");
    assert.ok(!r.excerpts.some(e => /Sequoia/.test(e.text)));
  });

  test('a health/mood sentence is never embedded', async () => {
    const c = convs({ a: { msgs: [["I've been feeling really depressed lately and started therapy.", 1], ...FILLER] } });
    await indexed(c);
    assert.ok(!calls.some(t => /depressed/.test(t)));
    const r = await turn(c, 'How am I doing emotionally?', { sensitive: sensitivePolicy({ rememberSensitive: false, message: 'x' }) });
    assert.ok(!r.excerpts.some(e => /depressed/.test(e.text)));
  });

  test('a deleted conversation is never quoted, and its vectors are pruned', async () => {
    const c = convs({ a: { msgs: [['We closed our seed round with Sequoia.', 1]] }, f: { msgs: FILLER } });
    await indexed(c);
    const key = R.collectUnits({ userId: 'u1', conversationId: 'now', conversations: c }).find(u => /Sequoia/.test(u.text)).key;
    assert.ok(VS.getVec(SR.recallNamespace('user:u1'), key));
    c.delete('a'); R.__clearCacheForTests();
    const r = await turn(c, "How's fundraising going?");
    assert.ok(!r.excerpts.some(e => /Sequoia/.test(e.text)));
    await indexed(c);
    assert.equal(VS.getVec(SR.recallNamespace('user:u1'), key), null, 'pruned on the next index pass');
  });

  test('account deletion clears the recall vectors', async () => {
    const c = convs({ a: { msgs: [['We closed our seed round with Sequoia.', 1], ...FILLER] } });
    await indexed(c);
    assert.ok(VS.idsIn(SR.recallNamespace('user:u1')).length > 0);
    deleteMind('user:u1');
    assert.equal(VS.idsIn(SR.recallNamespace('user:u1')).length, 0);
  });

  test('cached: the same content is embedded once; indexing is bounded per turn', async () => {
    const c = convs({ a: { msgs: FILLER } });
    const units = R.collectUnits({ userId: 'u1', conversationId: 'now', conversations: c });
    const first = await SR.indexRecallUnits('user:u1', units, { limit: 10 });
    assert.equal(first.embedded, 10, 'at most `limit` per pass');
    calls.length = 0;
    await SR.indexRecallUnits('user:u1', units, { limit: 1000 });
    assert.equal(calls.length, units.length - 10, 'only the remainder');
    calls.length = 0;
    VS.__resetForTests({ disablePersist: true });          // a fresh process: vectors reloaded…
    await indexed(c);                                       // …are re-embedded only because this test store forgot them
    calls.length = 0;
    await indexed(c);
    assert.equal(calls.length, 0, 'nothing re-embedded when vectors are present');
  });

  test('missing vectors: units not yet embedded are still found by keyword', async () => {
    const c = convs({ a: { msgs: [['My dentist is Dr. Okafor on Elm Street.', 2], ...FILLER] } });
    // nothing indexed
    const r = await turn(c, 'Who is my dentist?');
    assert.ok(r.excerpts.some(e => /Okafor/.test(e.text)));
  });

  test('token budget unchanged: hybrid recall stays within k and maxChars', async () => {
    const c = convs({ a: { msgs: [...Array.from({ length: 30 }, (_, i) => [`Investors call ${i}: we raised more of the seed round from VC funds and investment partners.`, i]), ...FILLER] } });
    await indexed(c);
    const r = await turn(c, "How's fundraising going?");
    assert.ok(r.excerpts.length <= R.RECALL_DEFAULTS.k + R.RECALL_DEFAULTS.followUps);
    const chars = r.excerpts.reduce((n, e) => n + e.text.length + 40, 0);
    assert.ok(chars <= R.RECALL_DEFAULTS.maxChars + 600, `within budget (${chars})`);
  });

  test('short histories are still quoted whole, with no embedding call on the read path', async () => {
    const c = convs({ a: { msgs: [['We closed our seed round with Sequoia.', 1]] } });
    calls.length = 0;
    const r = await turn(c, "How's fundraising going?");
    assert.equal(r.stats.mode, 'all');
    assert.ok(!calls.some(t => /seed round/.test(t)), 'nothing indexed while the history is far below the window');
  });
});
