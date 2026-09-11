/**
 * Phase 2c — retrieveProjectContext semantic blend integration (offline).
 * Proves the payoff through the REAL retriever: a paraphrase query with zero
 * keyword overlap surfaces the right file; keyword-only ranks it below; and
 * with no semantic scores the retriever is byte-identical to pre-Phase-2c.
 * Run: node src/project/tests/projectRetrieverSemantic.test.js
 */
import assert from 'node:assert';
import { __setEmbedderForTests } from '../../embeddings/embeddingProvider.js';
import { __resetForTests as resetVectors } from '../../embeddings/vectorStore.js';
import { indexWorkspaceFiles, semanticFileScores, __resetBackfillForTests } from '../semanticProject.js';
import { retrieveProjectContext } from '../projectRetriever.js';
import { buildIndex, clearIndex } from '../projectIndex.js';
import { createWorkspace, updateWorkspace } from '../workspaceManager.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.error(`  \u2717 ${name}\n    ${e.message}`); }
}

const CONCEPTS = {
  retry: ['retry', 'backoff', 'circuit', 'attempt', 'resilien', 'recover', 'repeated', 'failure'],
  cache: ['cache', 'ttl', 'evict', 'memoize', 'expire'],
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

// Build a real workspace + index. Paths/symbols deliberately avoid the query's
// words so pure keyword scoring cannot find the target file.
async function setup() {
  __setEmbedderForTests(conceptEmbed);
  resetVectors();
  __resetBackfillForTests();
  const ws = createWorkspace({ name: 'p2c' });
  updateWorkspace(ws.id, { summary: 'test repo', projectType: 'node', overview: null });
  const index = buildIndex(ws.id, [
    // Target: about RETRY, but path "dispatcher" + symbol "send" share no query tokens.
    { path: 'src/net/dispatcher.js', lang: 'js', size: 120,
      content: 'export function send(req){ /* exponential backoff and circuit breaker; recover from repeated failure by retrying with an attempt cap */ }' },
    // Distractor: about CACHE.
    { path: 'src/store/holder.js', lang: 'js', size: 120,
      content: 'export function put(k,v){ /* memoize with a TTL and evict expired entries */ }' },
  ], { persist: false });
  await indexWorkspaceFiles(ws.id, index);
  return ws.id;
}

console.log('retrieveProjectContext — semantic blend payoff');

await test('paraphrase query: semantic blend surfaces the retry file; keyword alone does not rank it top', async () => {
  const wsId = await setup();
  const query = 'how do we recover from repeated network problems'; // no token in "dispatcher"/"send"

  const scores = await semanticFileScores(wsId, query);
  assert.ok(scores, 'semantic scores available');

  const withSemantic = retrieveProjectContext(wsId, query, 5, { semanticScores: scores });
  const keywordOnly  = retrieveProjectContext(wsId, query, 5); // no scores

  assert.ok(withSemantic, 'context returned');
  assert.equal(withSemantic.files[0].path, 'src/net/dispatcher.js', 'retry file ranked first with semantics');

  // Keyword-only: the target shares no tokens with the query, so it is NOT the
  // top keyword hit (broad-query fallback may include files, but not rank the
  // retry file first by keyword). Assert semantics changed the top result.
  const keywordTop = keywordOnly?.files?.[0]?.path;
  assert.notEqual(keywordTop, 'src/net/dispatcher.js', 'keyword alone does not surface the paraphrase-matched file first');
});

await test('a file matched ONLY by semantics still clears score>0 and is included', async () => {
  const wsId = await setup();
  const scores = await semanticFileScores(wsId, 'resilience against repeated failures');
  const ctx = retrieveProjectContext(wsId, 'resilience against repeated failures', 5, { semanticScores: scores });
  assert.ok(ctx.files.some(f => f.path === 'src/net/dispatcher.js'), 'semantic-only match surfaced');
});

console.log('retrieveProjectContext — fail-open parity');

await test('null semantic scores → identical ranking to calling without the option', async () => {
  const wsId = await setup();
  const q = 'send request'; // keyword-friendly query so both paths have signal
  const a = retrieveProjectContext(wsId, q, 5, { semanticScores: null });
  const b = retrieveProjectContext(wsId, q, 5);
  assert.deepEqual(a.files.map(f => f.path), b.files.map(f => f.path), 'ranking unchanged with null scores');
});

console.log(`\nprojectRetrieverSemantic: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
