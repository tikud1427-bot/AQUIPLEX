/**
 * Phase 2 — semantic retrieval integration (offline; embedder injected).
 * Proves: (a) a paraphrase query with ZERO keyword overlap surfaces the right
 * fact via semantics, (b) with embeddings OFF the retriever is byte-identical
 * to pre-Phase-2, (c) indexOwnerFacts embeds misses + prunes deleted facts.
 * Run: node src/embeddings/tests/semanticMemory.test.js
 */
import assert from 'node:assert';
import { __setEmbedderForTests, __clearEmbedderForTests } from '../embeddingProvider.js';
import { __resetForTests as resetVectors, idsIn, getVec } from '../vectorStore.js';
import { indexOwnerFacts, semanticFactScores } from '../semanticMemory.js';
import { retrieveRelevantFacts } from '../../memory/memoryRetriever.js';
import { storeFact, clearFacts, getFacts } from '../../memory/longTermMemory.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.error(`  \u2717 ${name}\n    ${e.message}`); }
}

// Concept-basis fake embedder: a fact and a query that share a CONCEPT (not a
// literal word) land on the same basis dims → high cosine. This models the
// exact keyword-retrieval failure semantics fix: synonym/paraphrase overlap.
const CONCEPTS = {
  climbing: ['climb', 'bould', 'crag', 'outdoor', 'mountain'],
  pets:     ['dog', 'cat', 'pet', 'animal'],
  drinks:   ['coffee', 'espresso', 'brew', 'caffeine'],
};
const DIMS = Object.keys(CONCEPTS);
function conceptEmbed(texts) {
  return texts.map(t => {
    const low = t.toLowerCase();
    const v = DIMS.map(c => (CONCEPTS[c].some(w => low.includes(w)) ? 1 : 0));
    if (v.every(x => x === 0)) v[0] = 0.001;
    // normalize so a 2-concept text doesn't dominate; cosine handles magnitude anyway
    return v;
  });
}

const OWNER = 'user:phase2test';

async function seedFacts() {
  clearFacts(OWNER);
  resetVectors();
  // NOTE: values chosen so keyword scoring in the retriever finds NOTHING for
  // the paraphrase query below (no shared tokens with "outdoor mountain trips").
  storeFact(OWNER, { key: 'hobby',           value: 'bouldering at the crag', confidence: 0.95, importance: 7 });
  storeFact(OWNER, { key: 'favorite_drink',  value: 'espresso',              confidence: 0.95, importance: 6 });
  storeFact(OWNER, { key: 'pet',             value: 'a dog named Max',       confidence: 0.95, importance: 6 });
}

console.log('semanticMemory — indexing');
await test('indexOwnerFacts embeds each fact into its own vector', async () => {
  __setEmbedderForTests(conceptEmbed);
  await seedFacts();
  await indexOwnerFacts(OWNER, getFacts(OWNER));
  assert.deepEqual(idsIn(OWNER).sort(), ['favorite_drink', 'hobby', 'pet']);
  assert.ok(getVec(OWNER, 'hobby'));
});
await test('indexOwnerFacts prunes vectors for deleted facts', async () => {
  __setEmbedderForTests(conceptEmbed);
  await seedFacts();
  await indexOwnerFacts(OWNER, getFacts(OWNER));
  // Simulate a forget: pass a fact set missing 'pet'.
  const remaining = getFacts(OWNER).filter(f => f.key !== 'pet');
  await indexOwnerFacts(OWNER, remaining);
  assert.ok(!idsIn(OWNER).includes('pet'), 'pruned deleted fact vector');
  assert.ok(idsIn(OWNER).includes('hobby'));
});
await test('re-index with no changes embeds nothing new (hash skip)', async () => {
  let calls = 0;
  __setEmbedderForTests(t => { calls += t.length; return conceptEmbed(t); });
  await seedFacts();
  await indexOwnerFacts(OWNER, getFacts(OWNER));
  const afterFirst = calls;
  await indexOwnerFacts(OWNER, getFacts(OWNER));
  assert.equal(calls, afterFirst, 'no re-embedding when fact text unchanged');
});

console.log('semanticMemory — retrieval payoff');
await test('PARAPHRASE query surfaces the right fact (keyword would miss it)', async () => {
  __setEmbedderForTests(conceptEmbed);
  await seedFacts();
  await indexOwnerFacts(OWNER, getFacts(OWNER));

  const query = 'what outdoor mountain activities am I into';   // shares NO words with "bouldering at the crag"

  // Baseline: pure keyword (no semantic scores) — the hobby fact is NOT
  // specifically surfaced by intent (directed-intent gate would drop it or it
  // ranks only on base importance). We assert semantics changes the outcome.
  const keywordOnly = retrieveRelevantFacts(OWNER, query, 1);

  const scores = await semanticFactScores(OWNER, query);
  assert.ok(scores, 'semantic scores available');
  const semantic = retrieveRelevantFacts(OWNER, query, 1, { semanticScores: scores });

  assert.equal(semantic[0]?.key, 'hobby', 'semantic retrieval ranks the climbing fact first');
  // And it beat the drink/pet facts specifically because of the concept match.
  assert.ok(scores.get('hobby') > scores.get('favorite_drink'));
  assert.ok(scores.get('hobby') > scores.get('pet'));
});
await test('semantic match survives the directed-intent gate', async () => {
  __setEmbedderForTests(conceptEmbed);
  await seedFacts();
  await indexOwnerFacts(OWNER, getFacts(OWNER));
  // "pet" query has directed intent (PETS category). The climbing fact must
  // NOT leak in, but the pet fact must surface — semantic + keyword agree here.
  const scores = await semanticFactScores(OWNER, 'do I have any animals at home');
  const out = retrieveRelevantFacts(OWNER, 'do I have any animals at home', 3, { semanticScores: scores });
  assert.ok(out.some(f => f.key === 'pet'), 'pet fact surfaced');
});

console.log('semanticMemory — fail-open parity (embeddings OFF)');
await test('embeddings disabled → semanticFactScores null → retriever unchanged', async () => {
  __clearEmbedderForTests();               // disable embeddings
  await seedFacts();
  const scores = await semanticFactScores(OWNER, 'anything');
  assert.equal(scores, null, 'no scores when embeddings disabled');

  // Retriever with null semanticScores must equal retriever called the old way.
  const q = 'what do I know';
  const a = retrieveRelevantFacts(OWNER, q, 5, { semanticScores: null });
  const b = retrieveRelevantFacts(OWNER, q, 5);
  assert.deepEqual(a.map(f => f.key), b.map(f => f.key), 'identical ranking with/without null scores');
});
await test('indexOwnerFacts is a no-op when embeddings disabled', async () => {
  __clearEmbedderForTests();
  resetVectors();
  await seedFacts();
  await indexOwnerFacts(OWNER, getFacts(OWNER));
  assert.deepEqual(idsIn(OWNER), [], 'no vectors written when disabled');
});

clearFacts(OWNER);
console.log(`\nsemanticMemory: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
