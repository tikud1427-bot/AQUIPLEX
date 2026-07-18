/**
 * Memory 5.0 Phase G — Unified Recall API (GET /memory/recall)
 * Boots the real router on an ephemeral port; no supertest, no new deps.
 * Run: node --test src/routes/tests/recallApi.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-recallapi-'));
process.env.AQUA_DATA_DIR = tmp;
process.chdir(tmp);

const USER_ID = 'recall-tester';
const OWNER = `user:${USER_ID}`;

let server, base;
let ltm, mindStore, graph, schema, provider, vectors, fileMem;

before(async () => {
  ltm       = await import('../../memory/longTermMemory.js');
  mindStore = await import('../../mind/mindStore.js');
  graph     = await import('../../mind/relationshipGraph.js');
  schema    = await import('../../mind/mindSchema.js');
  provider  = await import('../../embeddings/embeddingProvider.js');
  vectors   = await import('../../embeddings/vectorStore.js');
  fileMem   = await import('../../embeddings/fileMemory.js');
  const { default: express } = await import('express');
  const { default: memoryRouter } = await import('../memory.js');

  // Seed every layer for the owner.
  ltm.storeFact(OWNER, { key: 'workplace', value: 'Aquiplex', category: 'work', confidence: 0.95, importance: 8, ts: Date.now() });
  ltm.storeFact(OWNER, { key: 'favorite_language', value: 'typescript', category: 'programming', confidence: 0.9, importance: 7, ts: Date.now() });

  const mind = mindStore.getMind(OWNER);
  const ep = schema.createEpisode({ title: 'aquiplex billing migration', conversationId: 'c9' });
  ep.status = 'archived'; ep.endedAt = Date.now() - 86400_000; ep.outcome = 'shipped wallet';
  mind.episodes[ep.id] = ep;

  const org = graph.upsertNode(mind, 'org', 'Aquiplex');
  const proj = graph.upsertNode(mind, 'project', 'AQUA');
  graph.upsertEdge(mind, org.key, proj.key, 'owns');

  provider.__setEmbedderForTests(texts => texts.map(t => [
    /billing|wallet|payment/i.test(t) ? 1 : 0,
    /aquiplex|aqua/i.test(t) ? 1 : 0.001,
  ]));
  await fileMem.indexFileChunks(OWNER, 'file:notes.md', 'notes.md', 'Billing wallet payment notes for the aquiplex migration sprint.');

  const app = express();
  app.use((req, _res, next) => { req.aquaUserId = USER_ID; next(); });
  app.use('/memory', memoryRouter);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  provider.__clearEmbedderForTests();
  if (server) await new Promise(r => server.close(r));
});

async function recall(q) {
  const res = await fetch(`${base}/memory/recall?q=${encodeURIComponent(q)}`);
  assert.equal(res.status, 200);
  return res.json();
}

test('recall returns every lane for a matching query', async () => {
  const body = await recall('aquiplex billing');
  assert.equal(body.success, true);
  assert.equal(body.ownerId, OWNER);
  assert.ok(body.facts.some(f => f.key === 'workplace' && f.value === 'Aquiplex'), 'facts lane');
  assert.ok(body.episodes.some(e => /billing/.test(e.title)), 'episodes lane');
  assert.ok(body.graphPaths.some(p => /Aquiplex/.test(p.line)), 'graph lane');
  assert.ok(body.files.some(f => f.name === 'notes.md' && /wallet/i.test(f.excerpt)), 'files lane');
});

test('facts payload is compact (no history/sourceMessage leakage)', async () => {
  const body = await recall('where do I work');
  const fact = body.facts.find(f => f.key === 'workplace');
  assert.ok(fact);
  assert.equal(fact.history, undefined);
  assert.equal(fact.sourceMessage, undefined);
  assert.equal(typeof fact.pinned, 'boolean');
});

test('unrelated query: lanes fail open to empty arrays, 200 always', async () => {
  const body = await recall('quantum sourdough recipes');
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.episodes) && body.episodes.length === 0);
  assert.ok(Array.isArray(body.graphPaths) && body.graphPaths.length === 0);
});

test('limit is clamped and respected', async () => {
  const body = await fetch(`${base}/memory/recall?q=typescript&limit=1`).then(r => r.json());
  assert.ok(body.facts.length <= 1);
});
