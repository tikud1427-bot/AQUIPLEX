/**
 * Retrieval privacy, sentence by sentence (2026-11-06): policy-withheld health /
 * mood sentences and forgotten sentences never influence keyword ranking,
 * semantic ranking, follow-ups or the embedding provider; the current question
 * is filtered the same way; stale vectors are never trusted. Offline: the
 * dedicated embedder's network call is replaced by a recording fake.
 * Frozen end-to-end set: eval/recall-privacy-v1.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-retrieval-privacy-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && !['AQUA_DATA_DIR', 'AQUA_DISABLE_MONGO_MIRROR'].includes(k)) delete process.env[k];
  if (/(_API_KEY|^GEMINI|^Gemini)/.test(k)) delete process.env[k];
}

const P = await import('../retrievalPrivacy.js');
const R = await import('../episodicRecall.js');
const SR = await import('../semanticRecall.js');
const RR = await import('../recallRedactions.js');
const DE = await import('../../embeddings/dedicatedEmbedder.js');
const VS = await import('../../embeddings/vectorStore.js');
const { EMBED_DIM } = await import('../../embeddings/embeddingModel.js');
const { sensitivePolicy } = await import('../sensitivity.js');

const DAY = 86_400_000, T0 = Date.UTC(2026, 6, 1);
const FILLER = ['The cat slept on the sofa all afternoon.', 'I watered the tomatoes on the balcony.', 'We watched a documentary about owls.',
  'The kettle whistles very loudly.', 'My neighbour plays the cello in the evenings.', 'I bought green apples at the market.',
  'The bus was crowded this morning.', 'I read a short story about a lighthouse keeper.', 'The library closes early on Sundays.', 'We painted the fence white.'];
const vec = t => { const v = new Array(EMBED_DIM).fill(0); v[0] = 0.2; for (const w of String(t).toLowerCase().match(/[a-z0-9]+/g) ?? []) v[1 + [...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % (EMBED_DIM - 1), 7)] += 1; return v; };
const sent = [];
const history = (owner, texts) => new Map([...texts, ...FILLER].map((t, i) => [`${owner}-c${i}`, { meta: { userId: owner, title: `c${i}` }, messages: [{ role: 'user', content: t, ts: T0 + i * DAY }] }]));
const turn = (owner, c, query, extra = {}) => R.recallForTurn({ ownerId: `user:${owner}`, userId: owner, conversationId: 'none', query, conversations: c, includeFiles: false,
  sensitive: sensitivePolicy({ rememberSensitive: extra.optIn === true, message: query }), semanticTimeoutMs: 250, ...extra });
const quoted = r => r.excerpts.map(e => e.text).join(' | ');
const settle = () => new Promise(r => setTimeout(r, 40));

beforeEach(() => {
  R.__clearCacheForTests(); RR.__resetForTests(); VS.__resetForTests(); sent.length = 0;
  DE.__resetDedicatedForTests();
  DE.__setDedicatedTransportForTests(async (key, texts) => { sent.push(...texts); return { embeddings: texts.map(t => ({ values: vec(t) })) }; });
  process.env.AQUA_RECALL_ALL_CHARS = '200';
  delete process.env.AQUA_SEMANTIC_RECALL; delete process.env.AQUA_EMBEDDING_API_KEY;
});
const semanticOn = () => { process.env.AQUA_SEMANTIC_RECALL = 'on'; process.env.AQUA_EMBEDDING_API_KEY = 'test-placeholder-not-a-key'; };

describe('sentence-level classification', () => {
  test('a passage is never classified as a whole', () => {
    assert.deepEqual(P.embeddableSentences({ text: 'I have asthma. We are building an app for runners.', sentences: ['I have asthma.', 'We are building an app for runners.'] }), ['We are building an app for runners.']);
    assert.deepEqual(P.embeddableSentences({ text: 'I bought new running shoes. The doctor in that film was funny.', sentences: ['I bought new running shoes.', 'The doctor in that film was funny.'] }).length, 2);
  });
  test('the policy is the existing one: opted in AND on topic, per kind', () => {
    const w = P.withheldBy(sensitivePolicy({ rememberSensitive: true, message: 'Is my asthma better?' }));
    assert.equal(w('I was diagnosed with asthma last year.'), false, 'health allowed this turn');
    assert.equal(w('I have been feeling depressed lately.'), true, 'mood still withheld');
    assert.equal(P.withheldBy(null)('I was diagnosed with asthma last year.'), true, 'no policy withholds every kind');
    assert.equal(P.policyKey(sensitivePolicy({ rememberSensitive: true, message: 'Is my asthma better?' })), 'h1m0');
    assert.equal(P.policyKey(sensitivePolicy({ rememberSensitive: false, message: 'Is my asthma better?' })), 'h0m0');
  });
  test('the question loses only its sensitive sentences', () => {
    assert.equal(P.questionEmbedText('I have been feeling really anxious lately. Where did our office move?'), 'Where did our office move?');
    assert.equal(P.questionEmbedText('Is my asthma getting worse?'), '');
  });
});

describe('keyword ranking and quoting', () => {
  test('a withheld sentence ranks nothing and pulls no sibling in; counted apart from forgotten', async () => {
    const c = history('k1', ['I was diagnosed with asthma last year. I also repainted the shed blue.']);
    const r = await turn('k1', c, 'What was I diagnosed with last year?');
    assert.equal(quoted(r), '');
    assert.ok(r.stats.withheldSentences >= 1);
    assert.equal(r.stats.forgottenSentences, 0);
    assert.match(quoted(await turn('k1', c, 'What was I diagnosed with last year?', { optIn: true })), /asthma/, 'opted in and on topic: unchanged');
  });
  test('a mixed passage keeps its eligible sentence; a cross-sentence match withholds nothing; a masked sentence stays withheld', async () => {
    const c = history('k2', ['I have been feeling depressed lately. Our office moved to Danforth Street.', 'I bought new running shoes. The doctor in that film was funny.', 'I have asthma. We are building an app for runners.']);
    assert.equal(quoted(await turn('k2', c, 'Where did our office move?')), 'Our office moved to Danforth Street.');
    assert.match(quoted(await turn('k2', c, 'What shoes did I buy?')), /running shoes\. The doctor in that film/);
    const masked = quoted(await turn('k2', c, 'What are we building for runners?'));
    assert.match(masked, /building an app/); assert.doesNotMatch(masked, /asthma/);
  });
  test('nothing is written to the forget list', async () => {
    const c = history('k3', ['I was diagnosed with asthma last year. I also repainted the shed blue.']);
    await turn('k3', c, 'What was I diagnosed with last year?');
    assert.equal(RR.redactionsFor('user:k3').active, false);
  });
});

describe('semantic path', () => {
  test('per-sentence embedding: eligible sentences indexed, sensitive ones never sent (masked included, opted in or not)', async () => {
    semanticOn();
    const c = history('s1', ['I have asthma. We are building an app for runners.', 'I have been feeling depressed lately. Our office moved to Danforth Street.']);
    await SR.indexRecallUnits('user:s1', R.collectUnits({ userId: 's1', conversationId: 'none', conversations: c }));
    assert.ok(sent.includes('We are building an app for runners.') && sent.includes('Our office moved to Danforth Street.'));
    assert.ok(!sent.some(t => /asthma|depressed/.test(t)), JSON.stringify(sent));
  });
  test('forgetting AFTER indexing: the stale full-text vector is not used on the very first turn', async () => {
    semanticOn();
    const c = history('s2', ['My cousin Ilse moved to the Harlow district near the river. I prefer green tea in the morning.']);
    await SR.indexRecallUnits('user:s2', R.collectUnits({ userId: 's2', conversationId: 'none', conversations: c }));
    assert.match(quoted(await turn('s2', c, 'Where did my cousin Ilse move to near the river?')), /Ilse/, 'control');
    RR.redactPhrases('user:s2', ['cousin Ilse moved to the Harlow district near the river']);
    const mark = sent.length;
    const first = await turn('s2', c, 'Where did my cousin Ilse move to near the river?');
    assert.equal(quoted(first), '', 'first turn after the forget');
    assert.ok(first.stats.forgottenSentences >= 1);
    await settle();
    const after = sent.slice(mark);
    assert.ok(after.includes('I prefer green tea in the morning.') && !after.some(t => /Harlow/.test(t)), `the re-index sends only the eligible remainder: ${JSON.stringify(after)}`);
    assert.match(quoted(await turn('s2', c, 'What do I prefer to drink in the morning?')), /green tea/, 'the remainder stays retrievable');
  });
  test('selectRecall ignores a semantic score for a passage the forget list changed (even a caller-supplied one)', () => {
    RR.redactPhrases('user:s3', ['secret orchard plan']);
    const c = history('s3', ['We drafted the secret orchard plan today. I prefer green tea in the morning.']);
    const units = R.collectUnits({ userId: 's3', conversationId: 'none', conversations: c });
    const target = units.find(u => /orchard/.test(u.text)).key;
    const semantic = new Map(units.map(u => [u.key, u.key === target ? 0.9 : 0.4]));
    const r = R.selectRecall(units, 'Which plan did we draft?', { allUnderChars: 0, forget: RR.redactionsFor('user:s3'), semantic });
    assert.ok(!r.excerpts.some(e => e.key === target), JSON.stringify(r.excerpts.map(e => e.text)));
  });
  test('the current question: partly sensitive → only its eligible part is sent; wholly sensitive → no call, keyword fallback; early vector too', async () => {
    semanticOn();
    const c = history('s4', ['Our office moved to Danforth Street.']);
    await SR.indexRecallUnits('user:s4', R.collectUnits({ userId: 's4', conversationId: 'none', conversations: c }));
    sent.length = 0;
    const r = await turn('s4', c, 'I have been feeling really anxious lately. Where did our office move?');
    assert.ok(sent.includes('Where did our office move?') && !sent.some(t => /anxious/.test(t)), JSON.stringify(sent));
    assert.match(quoted(r), /Danforth/);
    sent.length = 0;
    const w = await turn('s4', c, 'Is my asthma getting worse?');
    assert.ok(!sent.some(t => /asthma/.test(t)));
    assert.notEqual(w.stats.mode, 'hybrid');
    assert.equal(w.stats.semantic?.queryWithheld, true);
    sent.length = 0;
    R.__clearCacheForTests();
    DE.__resetDedicatedForTests();   // the filtered question is cached from the turn above: start cold
    DE.__setDedicatedTransportForTests(async (key, texts) => { sent.push(...texts); return { embeddings: texts.map(t => ({ values: vec(t) })) }; });
    const early = R.startRecallQueryVector({ userId: 's4', conversationId: 'none', query: 'I have been feeling really anxious lately. Where did our office move?', conversations: c });
    await early;
    assert.ok(!sent.some(t => /anxious/.test(t)) && sent.includes('Where did our office move?'), JSON.stringify(sent));
    assert.equal(R.startRecallQueryVector({ userId: 's4', conversationId: 'none', query: 'Is my asthma getting worse?', conversations: c }), null);
  });
  test('embedding unavailable: the keyword result, same privacy', async () => {
    semanticOn();
    const c = history('s5', ['I have been feeling depressed lately. Our office moved to Danforth Street.']);
    await SR.indexRecallUnits('user:s5', R.collectUnits({ userId: 's5', conversationId: 'none', conversations: c }));
    DE.__resetDedicatedForTests();
    DE.__setDedicatedTransportForTests(async () => { const e = new Error('server'); e.status = 500; throw e; });
    const r = await turn('s5', c, 'Where did our office move?');
    assert.equal(quoted(r), 'Our office moved to Danforth Street.');
  });
});

describe('cache follows every privacy change', () => {
  test('policy per turn, then the forget list', async () => {
    const c = history('c1', ['I was diagnosed with asthma last year. I also repainted the shed blue.', 'We repainted the garage door green.']);
    const ask = (q, optIn) => turn('c1', c, q, { optIn });
    assert.equal(quoted(await ask('What was I diagnosed with last year?', false)), '');
    assert.match(quoted(await ask('What was I diagnosed with last year?', true)), /asthma/);
    assert.equal(quoted(await ask('What was I diagnosed with last year?', false)), '');
    RR.redactPhrases('user:c1', ['repainted the shed blue']);
    assert.doesNotMatch(quoted(await ask('What did we repaint?', false)), /shed/);
  });
  test('stamps are process-wide: a purged and recreated owner never reuses one', () => {
    RR.redactPhrases('user:c2', ['first secret']);
    const a = RR.redactionsFor('user:c2').stamp;
    RR.purgeOwner('user:c2');
    RR.redactPhrases('user:c2', ['second secret']);
    assert.notEqual(RR.redactionsFor('user:c2').stamp, a);
  });
});

// ── ONE sentence, mixed (2026-11-06): the sibling clause's framing must not mask the health clause ──
describe('a single mixed sentence ("I have asthma, and we are building an app for runners.")', () => {
  const MIXED = 'I have asthma, and we are building an app for runners.';
  test('the sentence classifies (whole AND clause by clause), though classifyText alone misses it', async () => {
    const { classifyText } = await import('../sensitivity.js');
    assert.equal(classifyText(MIXED), null, 'control: the masking the fix closes');
    assert.equal(P.sensitiveKindOf(MIXED), 'health');
    assert.equal(P.questionEmbedText(`${MIXED} What should I cook?`), 'What should I cook?');
  });
  test('indexing: the provider never receives it; the passage\'s other sentence is still embedded', async () => {
    semanticOn();
    const c = history('m1', [`${MIXED} Our office moved to Danforth Street.`]);
    await SR.indexRecallUnits('user:m1', R.collectUnits({ userId: 'm1', conversationId: 'none', conversations: c }));
    const mine = sent.filter(t => !FILLER.includes(t));
    assert.deepEqual(mine, ['Our office moved to Danforth Street.'], `exactly what the provider received: ${JSON.stringify(mine)}`);
    assert.ok(!sent.some(t => /asthma|runners/i.test(t)));
  });
  test('keyword ranking: it matches nothing and pulls no sibling in (no opt-in)', async () => {
    const c = history('m2', [`${MIXED} Our office moved to Danforth Street.`]);
    assert.equal(quoted(await turn('m2', c, 'Do I have asthma?')), '');
    assert.doesNotMatch(quoted(await turn('m2', c, 'What are we building for runners?')), /asthma/);
    assert.match(quoted(await turn('m2', c, 'Where did our office move?')), /Danforth/, 'the eligible sentence is retrievable');
  });
  test('opted in AND on topic: it is quotable by keyword, and still never embedded', async () => {
    semanticOn();
    const c = history('m3', [MIXED]);
    await SR.indexRecallUnits('user:m3', R.collectUnits({ userId: 'm3', conversationId: 'none', conversations: c }));
    sent.length = 0;
    assert.match(quoted(await turn('m3', c, 'Do I still have asthma?', { optIn: true })), /asthma/);
    await settle();
    assert.ok(!sent.some(t => /asthma/i.test(t)), JSON.stringify(sent));
  });
  for (const flag of ['off', 'on']) {
    test(`follow-ups (AQUA_RECALL_FOLLOWUP_V2=${flag}): a withheld mixed sentence links nothing`, async () => {
      if (flag === 'on') process.env.AQUA_RECALL_FOLLOWUP_V2 = 'on';
      try {
        const c = history(`m4${flag}`, ['I go swimming at the Ardley pool.', 'I have asthma, and the Ardley pool changed its hours now.']);
        const q = quoted(await turn(`m4${flag}`, c, 'Where do I go swimming?'));
        assert.match(q, /Ardley pool\./);
        assert.doesNotMatch(q, /asthma|changed its hours/, q);
      } finally { delete process.env.AQUA_RECALL_FOLLOWUP_V2; }
    });
  }
  test('the current question: a mixed sensitive sentence is not embedded; the eligible one is', async () => {
    semanticOn();
    const c = history('m5', ['Our office moved to Danforth Street.']);
    await SR.indexRecallUnits('user:m5', R.collectUnits({ userId: 'm5', conversationId: 'none', conversations: c }));
    sent.length = 0;
    const r = await turn('m5', c, `${MIXED} Where did our office move?`);
    assert.deepEqual(sent.filter(t => !FILLER.includes(t)), ['Where did our office move?'], JSON.stringify(sent));
    assert.match(quoted(r), /Danforth/);
  });
});
