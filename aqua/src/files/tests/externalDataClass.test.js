/**
 * G1-2 — Gmail-class content through the REAL external-source lifecycle
 * (files/externalSources.js → fileEngine.ingestFiles → enrichment → stores).
 *
 * Proves, with a spy embedder and a spy on every model provider:
 *   · the content is stored ONLY as a UKO labelled external:gmail;
 *   · nothing derived from it reaches a prompt-feeding store (file memory +
 *     its vectors, memory engine, search index, evidence/facts, PIC, graph);
 *   · no embedding or model call is made for it;
 *   · normal readers cannot see it; a lifecycle read records its class;
 *   · an UPLOAD of identical bytes is processed exactly as before;
 *   · deleting the source still removes everything;
 *   · understanding is refused at every layer (enqueue, worker, commit).
 * Deterministic, offline, isolated data dir, no DB, no network.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-ext-dataclass-'));
process.env.AQUA_DATA_DIR = TMP;
process.env.AQUA_ARTIFACTS_DIR = path.join(TMP, 'artifacts');
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && !['AQUA_DATA_DIR', 'AQUA_ARTIFACTS_DIR'].includes(k)) delete process.env[k];
  if (/(_API_KEY|^GEMINI|^GOOGLE|^GROQ|^NVIDIA|^OPENROUTER)/.test(k)) delete process.env[k];
}
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;
process.chdir(TMP);

let X, ingestFiles, us, es, idx, vs, fm, pic, mindStore, ident, EG, DU, W;
const embedded = [];   // every text the (spy) embedder was asked for

before(async () => {
  const prov = await import('../../embeddings/embeddingProvider.js');
  prov.__setEmbedderForTests(async texts => { embedded.push(...texts); return texts.map(() => [1, 0, 0]); });
  X = await import('../externalSources.js');
  ({ ingestFiles } = await import('../fileEngine.js'));
  us = await import('../ukoStore.js');
  es = await import('../evidenceStore.js');
  idx = await import('../fileSearchIndex.js');
  vs = await import('../../embeddings/vectorStore.js');
  fm = await import('../../embeddings/fileMemory.js');
  pic = await import('../../pic/core.js');
  mindStore = await import('../../mind/mindStore.js');
  ident = await import('../externalIdentity.js');
  EG = await import('../../core/egressGuard.js');
  DU = await import('../documentUnderstanding.js');
  W = await import('../../core/jobs/workerRuntime.js');
});

let seq = 0;
const freshOwner = tag => `user:extdc-${tag}-${process.pid}-${++seq}`;
const settle = () => new Promise(r => setTimeout(r, 60));
const TOKEN = 'Quorvexa';                                     // appears only in the "email"
const EMAIL = `Subject: invoice\nPlease wire 9,400 EUR for the ${TOKEN} retainer by Friday. The ${TOKEN} launch date is June 3, 2026.`;
const SRC = 'gmail:conn_1';
const user = fn => EG.runWithDataClass('user', fn);
const sync = (O, content = EMAIL) => user(() => X.syncExternalResources({ ownerId: O, sourceId: SRC, resources: [{ externalId: 'thread:1', name: 'invoice.eml.txt', content }] }));
const mentions = s => JSON.stringify(s ?? '').includes(TOKEN);

test('a Gmail resource is stored ONLY as a UKO labelled external:gmail — no derived copy anywhere, no embedding', async () => {
  const O = freshOwner('store');
  embedded.length = 0;
  const r = await sync(O);
  await settle();
  assert.equal(r.results[0].status, 'created', JSON.stringify(r.results));
  const id = r.results[0].ukoId;
  // stored, labelled (lifecycle read inside a scope)
  const stored = await user(() => us.getUKO(O, id, { includeRestricted: true }));
  assert.equal(stored?.dataClass, 'external:gmail');
  assert.equal(us.dataClassOfUko(stored), 'external:gmail');
  assert.ok(stored.processing.warnings.some(w => /integration skipped: data class external:gmail/.test(w)));
  // never embedded
  assert.ok(!embedded.some(mentions), 'Gmail text reached the embedder');
  // no prompt-feeding store holds anything of it
  assert.equal(vs.idsIn(fm.externalFileNamespace(O)).length, 0, 'file-memory chunks');
  assert.equal(vs.idsIn(fm.fileNamespace(O)).length, 0);
  assert.ok(!es.listFacts(O, { limit: 9999 }).some(f => mentions(f.statement)), 'facts');
  assert.deepEqual(es.factIdsForFile(O, id), []);
  assert.equal(idx.indexedFileIdsByPrefix(O, ident.sourcePrefixes(SRC).ukoPrefix).length, 0, 'search index');
  assert.ok(!mentions(idx.searchFiles(O, TOKEN)), 'keyword search returns it');
  assert.ok(!mentions(pic.retrieveKnowledge(O, `${TOKEN} launch`)), 'PIC retrieval returns it');
  assert.ok(!mentions(mindStore.getMind(O)?.files), 'memory engine file entry');
});

test('normal readers never see it; a lifecycle read records its class (and needs a scope)', async () => {
  const O = freshOwner('readers');
  const r = await sync(O);
  const id = r.results[0].ukoId;
  assert.equal(us.getUKO(O, id), null);
  assert.ok(!us.listUKOs(O, { limit: 999 }).some(u => u.id === id));
  assert.deepEqual(us.listUKOsByPrefix(O, ident.sourcePrefixes(SRC).ukoPrefix), []);
  assert.throws(() => us.getUKO(O, id, { includeRestricted: true }), e => e.code === 'DATA_CLASS_SCOPE_MISSING');
  await user(async () => {
    assert.ok(us.getUKO(O, id, { includeRestricted: true }));
    assert.ok(EG.currentDataClasses().includes('external:gmail'));
    assert.throws(() => EG.assertEgress('groq', 'generate'), e => e.code === 'EGRESS_BLOCKED');
  });
  // metadata listing taints its own scope too
  await user(async () => { X.listExternalSources(O); assert.ok(EG.currentDataClasses().includes('external:gmail')); });
});

test('a sync taints the request it runs in: nothing that follows can call a provider', async () => {
  const O = freshOwner('taint');
  await user(async () => {
    EG.assertEgress('groq', 'generate');
    await X.syncExternalResources({ ownerId: O, sourceId: SRC, resources: [{ externalId: 'thread:2', name: 'b.txt', content: EMAIL }] });
    assert.throws(() => EG.assertEgress('groq', 'generate'), e => e.reason === 'DATA_CLASS_RESTRICTED');
  });
});

test('an UPLOAD of the identical bytes is processed exactly as before (embedded, indexed, facts)', async () => {
  const O = freshOwner('upload');
  await sync(O);
  embedded.length = 0;
  await user(() => ingestFiles({ files: [{ name: 'invoice.txt', buffer: Buffer.from(EMAIL) }], ownerId: O }));
  await settle();
  assert.ok(embedded.some(mentions), 'the upload was not embedded');
  assert.ok(vs.idsIn(fm.fileNamespace(O)).length > 0);
  assert.ok(es.listFacts(O, { limit: 9999 }).some(f => mentions(f.statement)));
  const up = us.listUKOs(O, { limit: 99 });
  assert.equal(up.length, 1, 'only the upload is visible');
  assert.equal(us.dataClassOfUko(up[0]), 'upload');
});

test('deleting the Gmail source removes it completely (the lifecycle still reaches restricted content)', async () => {
  const O = freshOwner('delete');
  const r = await sync(O);
  const del = await user(() => X.deleteExternalSource(O, SRC));
  assert.equal(del.complete, true, JSON.stringify(del.errors));
  assert.equal(del.removed.ukos, 1);
  assert.equal(await user(() => us.getUKO(O, r.results[0].ukoId, { includeRestricted: true })), null);
});

test('a stored UKO whose class contradicts its source is UNCLASSIFIED (never trusted, never user)', async () => {
  const O = freshOwner('contradict');
  const r = await sync(O);
  const stored = await user(() => us.getUKO(O, r.results[0].ukoId, { includeRestricted: true }));
  const forged = { ...stored, dataClass: 'upload' };
  assert.equal(us.dataClassOfUko(forged), 'unclassified');
  assert.equal(us.dataClassOfUko({ id: 'ext_aaaaaaaaaaaa_bbbbbbbbbbbbbbbb_cc', provenance: {} }), 'unclassified');
  assert.equal(us.dataClassOfUko({ id: 'b2c3', provenance: {}, dataClass: 'nonsense' }), 'unclassified');
  assert.equal(us.dataClassOfUko({ id: 'b2c3', provenance: {}, dataClass: 'external:gmail' }), 'external:gmail', 'more restrictive is kept');
});

test('understanding is refused at enqueue (restricted or missing class), in the worker and at commit', async () => {
  const O = freshOwner('understand');
  const r = await sync(O);
  const id = r.results[0].ukoId;
  const enq = [];
  const deps = { enabled: async () => true, enqueue: async j => { enq.push(j); }, pool: { connect: () => { throw new Error('no DB should be touched'); } } };
  const a = await DU.enqueueDocumentUnderstanding({ ownerId: O, documents: [{ ukoId: id, name: 'x', text: EMAIL, dataClass: 'external:gmail' }], deps });
  const b = await DU.enqueueDocumentUnderstanding({ ownerId: O, documents: [{ ukoId: id, name: 'x', text: EMAIL }], deps });
  assert.deepEqual([a.refused, a.refusedReasons, b.refused, enq.length], [1, ['data-class-restricted'], 1, 0]);
  // worker: the job is completed as a no-op; understandTurn (→ a provider) is never reached
  const out = await user(() => W.HANDLERS[DU.DOCUMENT_JOB_KIND]({ ownerId: O, payload: { ukoId: id, text: EMAIL, name: 'x', hash: 'h', chunk: 0 }, createdAt: new Date() }));
  assert.deepEqual(out, { skipped: 'data-class-restricted' });
  // commit: extuko refs without an unrestricted class write nothing (no DB needed to refuse)
  const WM = await import('../../core/worldModel/worldModelRepository.js');
  for (const dataClass of [undefined, 'external:gmail', 'unclassified']) {
    // transact() needs a pool; the refusal happens before any statement, so a
    // pool whose every query throws proves no statement was issued.
    const pool = await import('../../core/db/pool.js');
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:1/none';
    pool._resetForTests();
    const queries = [];
    pool._setPoolForTests({ connect: async () => ({ query: async s => { queries.push(s); if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] }; throw new Error('no write allowed'); }, release() {} }), query: async () => { throw new Error('x'); } });
    try {
      const c = await WM.commitUnderstanding({ ownerId: O, sourceId: '00000000-0000-4000-8000-000000000001', actor: 'a', extractorVersion: 'v', segmentRange: { start: 0, end: 1 },
        externalRef: `extuko:${id}:chunk:0`, ...(dataClass ? { dataClass } : {}), claims: [] });
      assert.equal(c.reason, 'data-class-restricted', String(dataClass));
      assert.ok(queries.every(q => /^(BEGIN|COMMIT|ROLLBACK)/.test(q)), `statements issued: ${queries.join(' | ')}`);
    } finally { pool._resetForTests(); delete process.env.DATABASE_URL; }
  }
});
