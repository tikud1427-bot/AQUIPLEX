/**
 * G0 — source-specific knowledge deletion: what a disconnected external source
 * contributed to entities, facts, relationships and the Reflection V2
 * snapshot is removed; knowledge with independent support (an upload, another
 * source) survives. Same REAL pipeline and isolation as externalSources.test.js
 * (deterministic offline embedder, isolated data dir, no DB, no network).
 *
 * The deterministic layer derives graph entities from facts (e.g. "The Orion
 * launch date is …" → entity "The Orion"), one fact copy per file. Shared
 * knowledge is therefore modelled as a sentence BOTH sources state.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-ext-knowledge-'));
process.env.AQUA_DATA_DIR = TMP;
process.env.AQUA_ARTIFACTS_DIR = path.join(TMP, 'artifacts');
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && !['AQUA_DATA_DIR', 'AQUA_ARTIFACTS_DIR'].includes(k)) delete process.env[k];
  if (/(_API_KEY|^GEMINI|^GOOGLE)/.test(k)) delete process.env[k];
}
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;
process.chdir(TMP);

let X, ingestFiles, es, idx, rg, fm, pic, engine, ident, refl, reflector;

before(async () => {
  const prov = await import('../../embeddings/embeddingProvider.js');
  prov.__setEmbedderForTests(async texts => texts.map(t => {
    const v = new Array(32).fill(0);
    for (const w of String(t).toLowerCase().split(/\W+/)) if (w) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 32] += 1;
    return v;
  }));
  X         = await import('../externalSources.js');
  ({ ingestFiles } = await import('../fileEngine.js'));
  es        = await import('../evidenceStore.js');
  idx       = await import('../fileSearchIndex.js');
  rg        = await import('../../reasoning/reasoningGraph.js');
  fm        = await import('../../embeddings/fileMemory.js');
  pic       = await import('../../pic/core.js');
  engine    = await import('../../memory/engine.js');
  ident     = await import('../externalIdentity.js');
  refl      = await import('../../brain/reflectionV2/reflectionStore.js');
  reflector = await import('../../brain/reflectionV2/deltaReflector.js');
});

let seq = 0;
const freshOwner = tag => `user:extk-${tag}-${process.pid}-${++seq}`;
const settle = () => new Promise(r => setTimeout(r, 60));
const upload = (ownerId, name, content) => ingestFiles({ files: [{ name, buffer: Buffer.from(content) }], ownerId });
const res = (externalId, name, content) => ({ externalId, name, content });

// Shared (stated by BOTH): "The Orion launch date is March 15, 2026." → entity "The Orion".
// Upload-only: The Keepwell.  Source-only: The Zephyrion.
const UPLOAD_TEXT = 'The Orion launch date is March 15, 2026. The Keepwell launch date is May 1, 2026.';
const SOURCE_TEXT = 'The Orion launch date is March 15, 2026. The Zephyrion launch date is April 30, 2026.';
const SHARED = /The Orion/i;
const ONLY_SOURCE = /Zephyrion/i;

const allNodes = O => ['entity', 'fact', 'file'].flatMap(t => rg.nodesByType(O, t));
const labelled = (O, re) => rg.nodesByType(O, 'entity').filter(n => re.test(String(n.label)));
const isExt = f => ident.isExternalFileId(String(f));
const factsMatching = (O, re) => es.listFacts(O, { limit: 10_000 }).filter(x => re.test(x.statement));

async function scenario(tag) {
  const O = freshOwner(tag);
  await upload(O, 'keepwell.md', UPLOAD_TEXT);
  const r = await X.syncExternalResources({ ownerId: O, sourceId: 'gmail-test:conn_1', resources: [res('thread:1', 'zephyrion.md', SOURCE_TEXT)] });
  await settle();
  return { O, extUko: r.results[0].ukoId };
}

test('fixture: before deletion the graph holds a shared entity, a shared fact and a source-only entity', async () => {
  const { O, extUko } = await scenario('fixture');
  const orion = labelled(O, SHARED);
  assert.equal(orion.length, 1, 'shared entity missing or duplicated');
  assert.ok(orion[0].sourceFiles.some(isExt) && orion[0].sourceFiles.some(f => !isExt(f)), 'The Orion should be supported by both');
  assert.equal(labelled(O, ONLY_SOURCE).length, 1);
  assert.ok(factsMatching(O, SHARED).length >= 2, 'one fact copy per file expected');
  assert.ok(es.factIdsForFile(O, extUko).length > 0);
});

test('shared entity survives with only its independent support; source-only entities are removed', async () => {
  const { O } = await scenario('entities');
  const del = await X.deleteExternalSource(O, 'gmail-test:conn_1');
  assert.equal(del.complete, true);
  assert.deepEqual(labelled(O, ONLY_SOURCE).map(n => n.label), [], 'source-only entity survived');
  const orion = labelled(O, SHARED);
  assert.equal(orion.length, 1, 'the shared entity was removed or duplicated');
  assert.ok(orion[0].sourceFiles.length > 0 && orion[0].sourceFiles.every(f => !isExt(f)), 'shared entity still cites the deleted source');
  for (const n of allNodes(O)) assert.ok(!(n.sourceFiles ?? []).some(isExt), `node ${n.label} still cites the deleted source`);
});

test("shared fact: the upload's copy survives; every fact of the source is gone", async () => {
  const { O, extUko } = await scenario('facts');
  const sharedBefore = factsMatching(O, SHARED).length;
  await X.deleteExternalSource(O, 'gmail-test:conn_1');
  assert.deepEqual(es.factIdsForFile(O, extUko), []);
  const sharedAfter = factsMatching(O, SHARED).length;
  assert.ok(sharedAfter > 0 && sharedAfter < sharedBefore, `shared fact copies: ${sharedBefore} → ${sharedAfter}`);
  assert.equal(factsMatching(O, ONLY_SOURCE).length, 0, 'a source-only fact survived');
  assert.match(pic.retrieveKnowledge(O, 'Keepwell launch').block ?? '', /Keepwell/, 'upload knowledge no longer retrievable');
  assert.match(pic.retrieveKnowledge(O, 'Orion launch').block ?? '', /Orion/, 'the independently supported fact is no longer retrievable');
});

test('relationships: edges supported only by the source are removed; no dangling edges remain', async () => {
  const { O } = await scenario('edges');
  const zeph = labelled(O, ONLY_SOURCE).map(n => n.id);
  assert.ok(zeph.length);
  await X.deleteExternalSource(O, 'gmail-test:conn_1');
  for (const n of allNodes(O)) {
    for (const e of rg.edgesOf(O, n.id)) {
      assert.ok(rg.getNode(O, e.from) && rg.getNode(O, e.to), `dangling edge ${e.id}`);
      assert.ok(!(e.sourceFiles ?? []).some(isExt), `edge ${e.id} still cites the deleted source`);
      assert.ok(!zeph.includes(e.from) && !zeph.includes(e.to), 'an edge still touches a source-only entity');
    }
  }
  const orion = labelled(O, SHARED)[0];
  assert.ok(rg.edgesOf(O, orion.id).length > 0, 'the shared entity lost its independently supported relationships');
});

test('Reflection V2 snapshot: deleted-source labels are pruned; shared ones kept; no false "removed" delta', async () => {
  const { O } = await scenario('reflection');
  const snap = reflector.snapshotGraph({ graph: rg }, O);
  assert.ok([...snap.nodes.values()].some(n => ONLY_SOURCE.test(n.label)), 'fixture: snapshot lacks the source label');
  refl.saveReflectionState(O, snap, Date.now());

  const del = await X.deleteExternalSource(O, 'gmail-test:conn_1');
  assert.equal(del.complete, true);
  assert.ok(del.removed.reflectionNodes > 0, 'nothing was pruned from the snapshot');
  assert.ok(!del.removed.reflectionDeferred);

  const kept = refl.loadSnapshot(O);
  const labels = [...kept.nodes.values()].map(n => n.label);
  assert.ok(!labels.some(l => ONLY_SOURCE.test(l)), 'a deleted-source label persists in the snapshot');
  assert.ok(labels.some(l => SHARED.test(l)), 'a shared entity was pruned');
  for (const e of kept.edges.values()) assert.ok(kept.nodes.has(e.from) && kept.nodes.has(e.to), 'dangling snapshot edge');
  const delta = reflector.diffSnapshots(kept, reflector.snapshotGraph({ graph: rg }, O));
  const removedLabels = (delta.entitiesChanged ?? []).filter(c => c.change === 'removed').map(c => String(c.label));
  assert.deepEqual(removedLabels.filter(l => ONLY_SOURCE.test(l)), [], 'the deletion would be reported as a world change');
});

test('pruning is a no-op for owners never reflected on, and never touches another owner', async () => {
  const { O: A } = await scenario('refl-a');
  const { O: B } = await scenario('refl-b');
  refl.saveReflectionState(B, reflector.snapshotGraph({ graph: rg }, B), Date.now());
  const bBefore = JSON.stringify([...refl.loadSnapshot(B).nodes.keys()]);
  const del = await X.deleteExternalSource(A, 'gmail-test:conn_1');
  assert.equal(del.complete, true);
  assert.equal(del.removed.reflectionNodes, 0);
  assert.equal(JSON.stringify([...refl.loadSnapshot(B).nodes.keys()]), bBefore, "another owner's snapshot changed");
});

test('no stale deleted-source knowledge in retrieval: knowledge, memory, file memory, chunks, search, graph', async () => {
  const { O } = await scenario('retrieval');
  await X.deleteExternalSource(O, 'gmail-test:conn_1');
  const chunks = await fm.fileChunkScores(O, SOURCE_TEXT, { minScore: 0.3 });
  const mem = engine.memoryRetrieve(O, { query: 'when does The Zephyrion launch?', fileChunks: chunks });
  const lanes = {
    knowledge: pic.retrieveKnowledge(O, 'Zephyrion launch').block ?? '',
    memoryBlock: mem.block ?? '',
    fileContext: mem.fileContext ?? '',
    chunks: chunks.map(c => c.text).join(' '),
    search: idx.searchFiles(O, 'zephyrion').map(f => `${f.name} ${f.id ?? ''}`).join(' '),
    graph: allNodes(O).map(n => n.label).join(' '),
  };
  for (const [lane, text] of Object.entries(lanes)) assert.doesNotMatch(text, /Zephyrion|zephyrion\.md/i, `${lane} still returns deleted-source knowledge`);
  assert.match(pic.retrieveKnowledge(O, 'Orion launch').block ?? '', /Orion/);
});
