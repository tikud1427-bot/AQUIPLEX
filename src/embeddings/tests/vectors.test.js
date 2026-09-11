/**
 * Phase 2 — embedding substrate tests (offline; embedder injected).
 * Run: node src/embeddings/tests/vectors.test.js
 */
import assert from 'node:assert';
import {
  embed, embedOne, isEmbeddingEnabled, contentHash,
  __setEmbedderForTests, __clearEmbedderForTests,
} from '../embeddingProvider.js';
import {
  upsert, has, getVec, remove, clearNamespace, idsIn,
  cosineSim, scoreAgainst, topK, __resetForTests,
} from '../vectorStore.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { const r = fn(); if (r instanceof Promise) return r.then(() => { passed++; console.log(`  \u2713 ${name}`); }, e => { failed++; console.error(`  \u2717 ${name}\n    ${e.message}`); }); passed++; console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.error(`  \u2717 ${name}\n    ${e.message}`); }
}

// Deterministic fake embedder: maps each distinct token to a fixed basis dim,
// so texts sharing words get high cosine and disjoint texts get ~0. Lets us
// assert semantic geometry without a network or a real model.
const VOCAB = ['rust', 'python', 'climb', 'bould', 'dog', 'cat', 'coffee', 'tea', 'weekend', 'outdoor', 'language', 'pet'];
function fakeEmbed(texts) {
  return texts.map(t => {
    const v = new Array(VOCAB.length).fill(0);
    const low = t.toLowerCase();
    VOCAB.forEach((w, i) => { if (low.includes(w)) v[i] = 1; });
    if (v.every(x => x === 0)) v[0] = 0.001; // avoid zero-vector
    return v;
  });
}

console.log('embeddingProvider — disabled by default (no key, offline)');
await test('isEmbeddingEnabled false with no key + no injection', () => {
  __clearEmbedderForTests();
  assert.equal(isEmbeddingEnabled(), false);
});
await test('embed() returns nulls when disabled (fail-open, zero-change guarantee)', async () => {
  __clearEmbedderForTests();
  const out = await embed(['rust', 'python']);
  assert.deepEqual(out, [null, null]);
});

console.log('embeddingProvider — with injected embedder');
await test('isEmbeddingEnabled true when embedder injected', () => {
  __setEmbedderForTests(fakeEmbed);
  assert.equal(isEmbeddingEnabled(), true);
});
await test('embed returns one vector per input, order preserved', async () => {
  __setEmbedderForTests(fakeEmbed);
  const out = await embed(['rust language', 'dog pet']);
  assert.equal(out.length, 2);
  assert.equal(out[0][VOCAB.indexOf('rust')], 1);
  assert.equal(out[1][VOCAB.indexOf('dog')], 1);
});
await test('empty string embeds to null', async () => {
  __setEmbedderForTests(fakeEmbed);
  const [v] = await embed(['']);
  assert.equal(v, null);
});
await test('content-hash cache: identical text served from cache (embedder called once)', async () => {
  let calls = 0;
  __setEmbedderForTests(t => { calls += t.length; return fakeEmbed(t); });
  await embed(['coffee']);
  await embed(['coffee']);
  assert.equal(calls, 1, 'second identical embed must hit cache');
});
await test('embedOne convenience', async () => {
  __setEmbedderForTests(fakeEmbed);
  const v = await embedOne('cat pet');
  assert.equal(v[VOCAB.indexOf('cat')], 1);
});
await test('contentHash stable + distinct', () => {
  assert.equal(contentHash('abc'), contentHash('abc'));
  assert.notEqual(contentHash('abc'), contentHash('abd'));
});

console.log('vectorStore — cosine');
test('cosineSim identical = 1', () => assert.ok(Math.abs(cosineSim([1, 0, 1], [1, 0, 1]) - 1) < 1e-9));
test('cosineSim orthogonal = 0', () => assert.equal(cosineSim([1, 0], [0, 1]), 0));
test('cosineSim mismatched dims = 0', () => assert.equal(cosineSim([1, 0], [1, 0, 0]), 0));
test('cosineSim zero vector = 0', () => assert.equal(cosineSim([0, 0], [1, 1]), 0));

console.log('vectorStore — CRUD + scoring');
test('upsert + getVec + has(hash)', () => {
  __resetForTests();
  upsert('ns1', 'a', [1, 0, 0], 'h1');
  assert.deepEqual(getVec('ns1', 'a'), [1, 0, 0]);
  assert.equal(has('ns1', 'a', 'h1'), true);
  assert.equal(has('ns1', 'a', 'DIFFERENT'), false);
  assert.equal(has('ns1', 'a'), true);
});
test('upsert ignores empty/null vec', () => {
  __resetForTests();
  upsert('ns1', 'a', [], 'h');
  upsert('ns1', 'b', null, 'h');
  assert.equal(getVec('ns1', 'a'), null);
});
test('namespaces isolated', () => {
  __resetForTests();
  upsert('nsA', 'x', [1, 0], 'h');
  assert.equal(getVec('nsB', 'x'), null);
});
test('remove + idsIn', () => {
  __resetForTests();
  upsert('ns', 'a', [1], 'h'); upsert('ns', 'b', [1], 'h');
  assert.deepEqual(idsIn('ns').sort(), ['a', 'b']);
  remove('ns', 'a');
  assert.deepEqual(idsIn('ns'), ['b']);
});
test('clearNamespace', () => {
  __resetForTests();
  upsert('ns', 'a', [1], 'h');
  clearNamespace('ns');
  assert.deepEqual(idsIn('ns'), []);
});
test('scoreAgainst → cosine per id', () => {
  __resetForTests();
  upsert('ns', 'rust', [1, 0, 0], 'h');
  upsert('ns', 'dog',  [0, 1, 0], 'h');
  const scores = scoreAgainst('ns', [1, 0, 0]);
  assert.ok(Math.abs(scores.get('rust') - 1) < 1e-9);
  assert.equal(scores.get('dog'), 0);
});
test('topK ranks + honors minScore', () => {
  __resetForTests();
  upsert('ns', 'a', [1, 0, 0], 'h');
  upsert('ns', 'b', [0.9, 0.1, 0], 'h');
  upsert('ns', 'c', [0, 1, 0], 'h');
  const top = topK('ns', [1, 0, 0], 2, 0.5);
  assert.equal(top.length, 2);
  assert.equal(top[0].id, 'a');
  assert.ok(!top.some(x => x.id === 'c'), 'c below minScore excluded');
});

console.log(`\nvectors: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
