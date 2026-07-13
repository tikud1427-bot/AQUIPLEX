/**
 * Phase 2c — semanticProject tests (offline; embedder injected).
 * Run: node src/project/tests/semanticProject.test.js
 */
import assert from 'node:assert';
import { __setEmbedderForTests, __clearEmbedderForTests } from '../../embeddings/embeddingProvider.js';
import { __resetForTests as resetVectors, idsIn, getVec } from '../../embeddings/vectorStore.js';
import { indexWorkspaceFiles, semanticFileScores, __resetBackfillForTests } from '../semanticProject.js';
import { buildIndex, clearIndex } from '../projectIndex.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.error(`  \u2717 ${name}\n    ${e.message}`); }
}

// Concept-basis embedder: a file and a query share a CONCEPT (not a literal
// word) → high cosine. Models the keyword-miss / semantic-hit case for code.
const CONCEPTS = {
  retry:   ['retry', 'backoff', 'circuit', 'attempt', 'resilien'],
  auth:    ['auth', 'login', 'session', 'credential', 'token'],
  payment: ['payment', 'charge', 'invoice', 'billing', 'stripe'],
};
const DIMS = Object.keys(CONCEPTS);
function conceptEmbed(texts) {
  return texts.map(t => {
    const low = t.toLowerCase();
    const v = DIMS.map(c => (CONCEPTS[c].some(w => low.includes(w)) ? 1 : 0));
    if (v.every(x => x === 0)) v[0] = 0.001;
    return v;
  });
}

const WS = 'ws-phase2c-test';

// Files whose PATHS + SYMBOL NAMES deliberately share no tokens with the
// paraphrase queries, but whose CONTENT is about a concept.
function seedIndex() {
  clearIndex(WS);
  resetVectors();
  __resetBackfillForTests();
  return buildIndex(WS, [
    { path: 'src/net/dispatcher.js', lang: 'js', size: 100,
      content: 'export function send(req){ /* exponential backoff, circuit breaker on repeated failure, retry with attempt cap */ }' },
    { path: 'src/gate/keeper.js', lang: 'js', size: 100,
      content: 'export function verify(user){ /* validate session token and login credentials */ }' },
    { path: 'src/money/ledger.js', lang: 'js', size: 100,
      content: 'export function post(txn){ /* create an invoice and charge via billing provider */ }' },
  ], { persist: false });
}

console.log('semanticProject — indexing');
await test('indexWorkspaceFiles embeds one vector per file', async () => {
  __setEmbedderForTests(conceptEmbed);
  const index = seedIndex();
  await indexWorkspaceFiles(WS, index);
  assert.deepEqual(idsIn('ws:' + WS).sort(), ['src/gate/keeper.js', 'src/money/ledger.js', 'src/net/dispatcher.js']);
  assert.ok(getVec('ws:' + WS, 'src/net/dispatcher.js'));
});
await test('re-index with no changes embeds nothing (hash skip)', async () => {
  let calls = 0;
  __setEmbedderForTests(t => { calls += t.length; return conceptEmbed(t); });
  const index = seedIndex();
  await indexWorkspaceFiles(WS, index);
  const after = calls;
  await indexWorkspaceFiles(WS, index);
  assert.equal(calls, after, 'unchanged files are not re-embedded');
});
await test('prunes vectors for files dropped from the index', async () => {
  __setEmbedderForTests(conceptEmbed);
  let index = seedIndex();
  await indexWorkspaceFiles(WS, index);
  // Rebuild without the payment file.
  index = buildIndex(WS, [
    { path: 'src/net/dispatcher.js', lang: 'js', size: 100, content: 'export function send(req){ /* backoff retry circuit */ }' },
    { path: 'src/gate/keeper.js', lang: 'js', size: 100, content: 'export function verify(user){ /* session token login */ }' },
  ], { persist: false });
  await indexWorkspaceFiles(WS, index);
  assert.ok(!idsIn('ws:' + WS).includes('src/money/ledger.js'), 'dropped file vector pruned');
});

console.log('semanticProject — scoring payoff');
await test('PARAPHRASE query surfaces the right file by content (paths share no tokens)', async () => {
  __setEmbedderForTests(conceptEmbed);
  const index = seedIndex();
  await indexWorkspaceFiles(WS, index);
  // "how do we recover from failed network calls" shares NO token with any path
  // or symbol, but is the RETRY concept → dispatcher.js content.
  const scores = await semanticFileScores(WS, 'how do we recover from repeated failures');
  assert.ok(scores, 'scores returned');
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  assert.equal(ranked[0][0], 'src/net/dispatcher.js', 'retry file ranks first semantically');
  assert.ok(scores.get('src/net/dispatcher.js') > scores.get('src/gate/keeper.js'));
});

console.log('semanticProject — lazy backfill');
await test('first query on an un-embedded workspace returns null + kicks backfill; second is semantic', async () => {
  __setEmbedderForTests(conceptEmbed);
  seedIndex();                 // builds the index but does NOT embed
  resetVectors();
  __resetBackfillForTests();
  assert.equal(idsIn('ws:' + WS).length, 0, 'no vectors yet');

  const first = await semanticFileScores(WS, 'anything');
  assert.equal(first, null, 'first call falls back to keyword while backfill runs');

  await new Promise(r => setTimeout(r, 50)); // let fire-and-forget backfill settle
  assert.ok(idsIn('ws:' + WS).length > 0, 'backfill populated vectors');

  const second = await semanticFileScores(WS, 'how do we recover from repeated failures');
  assert.ok(second && second.size > 0, 'second call is semantic');
});

console.log('semanticProject — fail-open parity (embeddings OFF)');
await test('embeddings disabled → semanticFileScores null', async () => {
  __clearEmbedderForTests();
  seedIndex();
  const scores = await semanticFileScores(WS, 'anything');
  assert.equal(scores, null);
});
await test('indexWorkspaceFiles is a no-op when embeddings disabled', async () => {
  __clearEmbedderForTests();
  const index = seedIndex();
  await indexWorkspaceFiles(WS, index);
  assert.deepEqual(idsIn('ws:' + WS), []);
});

clearIndex(WS);
console.log(`\nsemanticProject: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
