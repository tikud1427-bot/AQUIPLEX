/**
 * Memory 5.0 Phase D — File Content Memory
 * Run: node --test src/embeddings/tests/fileMemory.test.js
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-filemem-'));
process.env.AQUA_DATA_DIR = tmp;
process.chdir(tmp);

let provider, vectors, fileMem, engine, mindStore;

before(async () => {
  provider  = await import('../embeddingProvider.js');
  vectors   = await import('../vectorStore.js');
  fileMem   = await import('../fileMemory.js');
  engine    = await import('../../memory/engine.js');
  mindStore = await import('../../mind/mindStore.js');
});

// Concept-basis fake embedder (same pattern as semanticMemory tests): shared
// concept between chunk and query → high cosine, no literal overlap needed.
const CONCEPTS = {
  pricing:  ['price', 'pricing', 'cost', 'tier', 'subscription', 'rupee'],
  security: ['security', 'auth', 'token', 'encrypt', 'vulnerab'],
  cooking:  ['recipe', 'bake', 'oven', 'flour'],
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

const DOC = [
  'AQUA pricing model. The subscription cost is tiered by usage: starter, growth, scale. Each tier maps to a monthly rupee price with prepaid credits.',
  '',
  'Security architecture. Every request is authenticated with a session token; secrets are never sent to third-party providers and stores encrypt nothing at rest today.',
  '',
  'Roadmap. Future work includes artifact engine phases and the mind dashboard.',
].join('\n');

function freshOwner(name) {
  return `user:phaseD-${name}-${Math.random().toString(36).slice(2, 8)}`;
}

test('chunkText: paragraph packing, oversize split, cap respected', () => {
  const chunks = fileMem.chunkText(DOC, { chunkChars: 120, maxChunks: 10 });
  assert.ok(chunks.length >= 3, `expected >=3 chunks, got ${chunks.length}`);
  assert.ok(chunks.every(c => c.length <= 240), 'no chunk wildly over target');

  const giant = 'x'.repeat(5000);
  const hard = fileMem.chunkText(giant, { chunkChars: 700, maxChunks: 4 });
  assert.ok(hard.length <= 4, 'maxChunks cap enforced');
  assert.deepEqual(fileMem.chunkText(''), []);
});

test('index + semantic recall: paraphrase query finds the right chunk', async () => {
  provider.__setEmbedderForTests(conceptEmbed);
  vectors.__resetForTests();
  const owner = freshOwner('recall');
  await fileMem.indexFileChunks(owner, 'file:report.pdf', 'report.pdf', DOC);
  assert.ok(vectors.idsIn(fileMem.fileNamespace(owner)).length >= 1, 'chunks indexed');

  // query shares CONCEPT (cost/tier) not exact sentence
  const hits = await fileMem.fileChunkScores(owner, 'what does the report say about subscription cost tiers?');
  assert.ok(hits.length >= 1, 'expected a chunk hit');
  assert.match(hits[0].text, /pricing|tier/i);
  assert.equal(hits[0].name, 'report.pdf');
});

test('owner isolation: another owner sees nothing', async () => {
  provider.__setEmbedderForTests(conceptEmbed);
  const other = freshOwner('other');
  const hits = await fileMem.fileChunkScores(other, 'subscription cost tiers');
  assert.deepEqual(hits, []);
});

test('re-index skips unchanged chunks; prunes on shrink; removeFileChunks clears file', async () => {
  provider.__setEmbedderForTests(conceptEmbed);
  vectors.__resetForTests();
  const owner = freshOwner('reindex');
  // Long doc → multiple chunks at the default 700-char target, so shrink-prune
  // is observable. Distinct paragraphs prevent identical-chunk hash collisions.
  const BIGDOC = Array.from({ length: 8 }, (_, i) =>
    `Section ${i}: subscription pricing tier ${i} details. ` + 'filler sentence about the cost model. '.repeat(8)
  ).join('\n\n');
  await fileMem.indexFileChunks(owner, 'file:doc.md', 'doc.md', BIGDOC);
  const nsKey = fileMem.fileNamespace(owner);
  const firstCount = vectors.idsIn(nsKey).length;
  assert.ok(firstCount >= 2, `long doc must yield multiple chunks (got ${firstCount})`);

  let embeds = 0;
  provider.__setEmbedderForTests(t => { embeds += t.length; return conceptEmbed(t); });
  await fileMem.indexFileChunks(owner, 'file:doc.md', 'doc.md', BIGDOC); // identical
  assert.equal(embeds, 0, 'identical content must not re-embed');

  await fileMem.indexFileChunks(owner, 'file:doc.md', 'doc.md', 'AQUA pricing model. Cost tiers only now.'); // shrunk
  assert.ok(vectors.idsIn(nsKey).length < firstCount, 'stale chunks pruned');

  fileMem.removeFileChunks(owner, 'file:doc.md');
  assert.equal(vectors.idsIn(nsKey).length, 0);
});

test('engine lane: memoryRetrieve injects FILE RECALL from precomputed chunks + traces', () => {
  const owner = freshOwner('lane');
  const chunks = [
    { text: 'The subscription cost is tiered by usage with prepaid credits.', name: 'report.pdf', fileKey: 'file:report.pdf', idx: 0, score: 0.91 },
    { text: 'Security architecture uses session tokens.', name: 'report.pdf', fileKey: 'file:report.pdf', idx: 1, score: 0.72 },
    { text: 'third chunk should be dropped (top-2 only)', name: 'report.pdf', fileKey: 'file:report.pdf', idx: 2, score: 0.65 },
  ];
  const { block, trace } = engine.memoryRetrieve(owner, { query: 'what did the report say about pricing?', fileChunks: chunks });
  assert.match(block, /FILE RECALL/);
  assert.match(block, /report\.pdf/);
  assert.equal((block.match(/- \[report\.pdf\]/g) || []).length, 2, 'top-2 chunk lines only');
  assert.equal(trace.fileChunksInjected.length, 2);

  const quiet = engine.memoryRetrieve(owner, { query: 'same query', fileChunks: [] });
  assert.ok(!/FILE RECALL/.test(quiet.block), 'empty chunks → no lane');
});

test('rememberFile(content) fire-forget indexes; embeddings OFF → graceful no-op', async () => {
  provider.__setEmbedderForTests(conceptEmbed);
  vectors.__resetForTests();
  const owner = freshOwner('rf');
  engine.rememberFile(owner, { name: 'spec.md', kind: 'document', summary: 'spec', chars: DOC.length, content: DOC });
  await new Promise(r => setTimeout(r, 30)); // let fire-and-forget land
  assert.ok(vectors.idsIn(fileMem.fileNamespace(owner)).length >= 1, 'content indexed via rememberFile');

  provider.__clearEmbedderForTests();
  const offOwner = freshOwner('off');
  engine.rememberFile(offOwner, { name: 'x.md', kind: 'document', content: DOC });
  await new Promise(r => setTimeout(r, 20));
  const hits = await fileMem.fileChunkScores(offOwner, 'pricing');
  assert.deepEqual(hits, [], 'embeddings unavailable → empty, never throws');
});

test('GDPR: deleteMind purges fact + file-chunk namespaces', async () => {
  provider.__setEmbedderForTests(conceptEmbed);
  vectors.__resetForTests();
  const owner = freshOwner('gdpr');
  mindStore.getMind(owner);
  vectors.upsert(owner, 'somefact', [1, 0, 0], 'h');                       // fact ns
  await fileMem.indexFileChunks(owner, 'file:r.pdf', 'r.pdf', DOC);        // files ns
  assert.ok(vectors.idsIn(owner).length >= 1);
  assert.ok(vectors.idsIn(fileMem.fileNamespace(owner)).length >= 1);

  mindStore.deleteMind(owner);
  assert.equal(vectors.idsIn(owner).length, 0, 'fact vectors purged');
  assert.equal(vectors.idsIn(fileMem.fileNamespace(owner)).length, 0, 'file chunks purged');
});
