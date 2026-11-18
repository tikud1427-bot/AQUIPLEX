/**
 * Phase 1a.2 — external knowledge lifecycle (files/externalSources.js).
 *
 * Every test drives the REAL pipeline: syncExternalResources → ingestFiles →
 * parse → UKO → enrichment → evidence/facts → search index → reasoning graph →
 * PIC → file memory + chunk vectors; deleteExternalSource → every store's
 * remover. Only two things are faked: the embedder (deterministic, offline) and
 * the "connector" (plain objects with a fake sourceId). Isolated data dir, no
 * database, no Mongo mirror, no network.
 *
 * Numbered as in the Phase 1a.2 brief:
 *   1 delete one source · 2 uploads preserved · 3 unrelated memory preserved ·
 *   4 identical filenames · 5 repeated ingest · 6 update · 7 deletion after a
 *   partial sync · 8 deletion + retry · 9 cross-user isolation · 10 storage
 *   quota separation · 11 upload path unchanged · 12 account deletion ·
 *   13 retrieval after deletion · 14 cache and index invalidation
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-external-sources-'));
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

let X, ingestFiles, us, es, idx, rg, vs, fm, pic, mindStore, engine, ltm, prov, ident, purge, uko, claims;

before(async () => {
  prov = await import('../../embeddings/embeddingProvider.js');
  // Deterministic offline embedder: hashed bag of words (identical text → identical vector).
  prov.__setEmbedderForTests(async texts => texts.map(t => {
    const v = new Array(32).fill(0);
    for (const w of String(t).toLowerCase().split(/\W+/)) if (w) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 32] += 1;
    return v;
  }));
  X         = await import('../externalSources.js');
  ({ ingestFiles } = await import('../fileEngine.js'));
  us        = await import('../ukoStore.js');
  es        = await import('../evidenceStore.js');
  idx       = await import('../fileSearchIndex.js');
  rg        = await import('../../reasoning/reasoningGraph.js');
  vs        = await import('../../embeddings/vectorStore.js');
  fm        = await import('../../embeddings/fileMemory.js');
  pic       = await import('../../pic/core.js');
  mindStore = await import('../../mind/mindStore.js');
  engine    = await import('../../memory/engine.js');
  ltm       = await import('../../memory/longTermMemory.js');
  ident     = await import('../externalIdentity.js');
  purge     = await import('../../account/accountPurge.js');
  uko       = await import('../uko.js');
  claims    = await import('../../brain/contextEngine/canonicalSemantic.js');
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;
const freshOwner = tag => `user:ext-${tag}-${process.pid}-${++seq}`;
const settle = () => new Promise(r => setTimeout(r, 60));   // fire-and-forget claim vectors

/** A document the heuristic extractors turn into entities + at least one grounded fact. */
const doc = (token, extra = '') =>
  `Project ${token} is an offline-first note app built by Priya Sharma at Acme Corp. ${extra} ` +
  `The ${token} launch date is March 15, 2026. Contact priya@acme.example about ${token}.`;

const res = (externalId, name, content, more = {}) => ({ externalId, name, content, ...more });

/** Every artefact count for one owner, by class. */
function census(ownerId) {
  const ukos = us.listUKOs(ownerId, { limit: 100_000 });
  const mind = mindStore.getMind(ownerId);
  const fileKeys = Object.keys(mind.files ?? {});
  return {
    uploads: ukos.filter(u => !ident.isExternalFileId(u.id)).length,
    external: ukos.filter(u => ident.isExternalFileId(u.id)).length,
    facts: es.listFacts(ownerId, { limit: 100_000 }).length,
    uploadEntries: fileKeys.filter(k => !ident.isExternalFileKey(k)).length,
    externalEntries: fileKeys.filter(ident.isExternalFileKey).length,
    uploadChunks: vs.idsIn(fm.fileNamespace(ownerId)).length,
    externalChunks: vs.idsIn(fm.externalFileNamespace(ownerId)).length,
  };
}

const zeroRemaining = r => Object.values(r).every(n => n === 0);
const upload = (ownerId, name, content, extra = {}) =>
  ingestFiles({ files: [{ name, buffer: Buffer.from(content) }], ownerId, ...extra });

// ── 1 · Deleting one external source ─────────────────────────────────────────

test('1 · deleting one source removes everything it contributed, from every store', async () => {
  const O = freshOwner('del');
  const r = await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [
    res('a/one.md', 'one.md', doc('Zephyrion')), res('a/two.md', 'two.md', doc('Quillfeather')),
  ] });
  assert.deepEqual(r.results.map(x => x.status), ['created', 'created']);
  await settle();
  const before = census(O);
  assert.equal(before.external, 2);
  assert.ok(before.facts > 0 && before.externalEntries === 2 && before.externalChunks > 0, JSON.stringify(before));

  const d = await X.deleteExternalSource(O, 'fake:alpha');
  assert.equal(d.complete, true, JSON.stringify(d));
  assert.deepEqual(d.errors, []);
  assert.ok(zeroRemaining(d.remaining), JSON.stringify(d.remaining));
  assert.equal(d.removed.ukos, 2);

  const after = census(O);
  assert.deepEqual([after.external, after.facts, after.externalEntries, after.externalChunks], [0, 0, 0, 0]);
  assert.deepEqual(X.listExternalSources(O), []);
  const { ukoPrefix } = ident.sourcePrefixes('fake:alpha');
  assert.equal(rg.graphFileIds(O).filter(id => id.startsWith(ukoPrefix)).length, 0, 'graph contributions remain');
});

// ── 2 · Preserving unrelated user uploads ────────────────────────────────────

test('2 · user uploads (including a same-named one) survive a source deletion untouched', async () => {
  const O = freshOwner('uploads');
  await upload(O, 'README.md', doc('Uploadium', 'Written by the user.'));
  await upload(O, 'notes.md', doc('Notarion'));
  await settle();
  const uploadsBefore = us.listUKOs(O, { limit: 100 }).map(u => ({ id: u.id, hash: u.sourceFile.hash }));
  const factsBefore = es.listFacts(O, { limit: 9999 }).map(f => f.id).sort();
  const c0 = census(O);

  await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [res('a/README.md', 'README.md', doc('Externium'))] });
  await X.deleteExternalSource(O, 'fake:alpha');

  assert.deepEqual(us.listUKOs(O, { limit: 100 }).map(u => ({ id: u.id, hash: u.sourceFile.hash })), uploadsBefore);
  assert.deepEqual(es.listFacts(O, { limit: 9999 }).map(f => f.id).sort(), factsBefore, 'upload facts changed');
  const c1 = census(O);
  assert.deepEqual(
    [c1.uploads, c1.uploadEntries, c1.uploadChunks, c1.facts],
    [c0.uploads, c0.uploadEntries, c0.uploadChunks, c0.facts],
  );
  assert.ok(mindStore.getMind(O).files['file:readme.md'], 'the upload README.md entry was removed');
  assert.ok(mindStore.getMind(O).graph.nodes['artifact:readme.md'], 'the upload artifact node was removed');
});

// ── 3 · Preserving unrelated memories ────────────────────────────────────────

test('3 · conversation memory, Mind state and other sources survive a source deletion', async () => {
  const O = freshOwner('memory');
  ltm.storeFact(O, { key: 'name', value: 'Priya', confidence: 0.9 });
  engine.memoryObserve(O, { userMessage: 'My goal is to launch Lumen by March.', conversationId: `${O}-c`, userId: O, requestId: 'r1', extractMessage: 'My goal is to launch Lumen by March.' });
  const goalsBefore = Object.keys(mindStore.getMind(O).goals ?? {}).sort();
  await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [res('a/x.md', 'x.md', doc('Alphanor'))] });
  await X.syncExternalResources({ ownerId: O, sourceId: 'fake:beta', resources: [res('b/y.md', 'y.md', doc('Betavex'))] });
  const betaBefore = X.listExternalResources(O, 'fake:beta');

  await X.deleteExternalSource(O, 'fake:alpha');

  assert.equal(ltm.getFact(O, 'name')?.value, 'Priya');
  assert.deepEqual(Object.keys(mindStore.getMind(O).goals ?? {}).sort(), goalsBefore);
  assert.deepEqual(X.listExternalResources(O, 'fake:beta'), betaBefore, 'another source was touched');
  assert.ok(es.listFacts(O, { limit: 9999 }).some(f => /Betavex/.test(f.statement ?? '')), 'beta facts lost');
  assert.ok(!es.listFacts(O, { limit: 9999 }).some(f => /Alphanor/.test(f.statement ?? '')), 'alpha facts remain');
});

// ── 4 · Identical filenames across sources ───────────────────────────────────

test('4 · README.md from two sources and an upload coexist, each with its own content', async () => {
  const O = freshOwner('names');
  await upload(O, 'README.md', doc('Uplodex'));
  await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [res('repo/README.md', 'README.md', doc('Alphadex'))] });
  await X.syncExternalResources({ ownerId: O, sourceId: 'fake:beta', resources: [res('repo/README.md', 'README.md', doc('Betadex'))] });
  const ukos = us.listUKOs(O, { limit: 100 });
  assert.equal(ukos.length, 3);
  assert.equal(new Set(ukos.map(u => u.id)).size, 3);
  const entries = Object.values(mindStore.getMind(O).files);
  assert.equal(entries.filter(e => e.name === 'README.md').length, 3, 'entries merged by name');
  assert.equal(new Set(entries.map(e => e.key)).size, entries.length);
  for (const token of ['Alphadex', 'Betadex']) {
    assert.ok(vs.idsIn(fm.externalFileNamespace(O)).some(id => /Alphadex|Betadex/.test(vs.getMeta(fm.externalFileNamespace(O), id)?.text ?? '') && (vs.getMeta(fm.externalFileNamespace(O), id).text.includes(token))), `${token} chunk missing`);
  }
  assert.ok(vs.idsIn(fm.fileNamespace(O)).some(id => vs.getMeta(fm.fileNamespace(O), id)?.text?.includes('Uplodex')), 'upload chunk missing');
});

// ── 5 · Repeated ingestion without duplicates ───────────────────────────────

test('5 · re-syncing identical content is a no-op: no duplicate files, facts, entries or chunks', async () => {
  const O = freshOwner('repeat');
  const batch = [res('a/one.md', 'one.md', doc('Repetio')), res('a/two.md', 'two.md', doc('Iterix'))];
  await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: batch });
  await settle();
  const c0 = census(O);
  const indexed0 = idx.indexedFileIdsByPrefix(O, ident.sourcePrefixes('fake:alpha').ukoPrefix).length;
  for (let i = 0; i < 3; i++) {
    const r = await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: batch });
    assert.deepEqual(r.results.map(x => x.status), ['unchanged', 'unchanged']);
  }
  await settle();
  assert.deepEqual(census(O), c0);
  assert.equal(idx.indexedFileIdsByPrefix(O, ident.sourcePrefixes('fake:alpha').ukoPrefix).length, indexed0);
});

// ── 6 · Updating an existing external resource ──────────────────────────────

test('6 · changed content updates the SAME resource: new version in, old version fully out, provenance kept', async () => {
  const O = freshOwner('update');
  const r1 = await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [
    res('a/spec.md', 'spec.md', doc('Versiona', 'Launch is March 15.'), { sourceUpdatedAt: '2026-09-10T00:00:00Z', url: 'https://example.invalid/spec' }),
  ] });
  const oldId = r1.results[0].ukoId;
  const r2 = await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [
    res('a/spec.md', 'spec.md', doc('Versionb', 'Launch moved to April 30.'), { sourceUpdatedAt: '2026-11-02T00:00:00Z', url: 'https://example.invalid/spec' }),
  ] });
  assert.equal(r2.results[0].status, 'updated');
  const newId = r2.results[0].ukoId;
  assert.notEqual(newId, oldId);

  const live = X.listExternalResources(O, 'fake:alpha');
  assert.equal(live.length, 1, 'the update created a second resource');
  assert.equal(live[0].externalId, 'a/spec.md');
  assert.equal(live[0].ukoId, newId);
  assert.equal(live[0].sourceUpdatedAt, '2026-11-02T00:00:00Z');
  assert.ok(live[0].syncedAt > 0);
  const u = us.getUKO(O, newId);
  assert.equal(u.provenance.external.url, 'https://example.invalid/spec');

  const facts = es.listFacts(O, { limit: 9999 }).map(f => f.statement ?? '').join(' ');
  assert.ok(/Versionb/.test(facts) && !/Versiona/.test(facts), 'old version facts survived the update');
  const gone = X.remainingUnder(O, { ukoPrefix: oldId, keyPrefix: `ext:${oldId.slice(4).replace(/_/g, ':')}` });
  assert.ok(zeroRemaining(gone), JSON.stringify(gone));
  assert.equal(census(O).externalEntries, 1);
});

test('6b · a FAILED update keeps the previous version intact', async () => {
  const O = freshOwner('update-fail');
  const r1 = await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [res('a/spec', 'spec.md', doc('Keepsake'))] });
  const c0 = census(O);
  const r2 = await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [res('a/spec', 'spec.unsupportedext', 'new bytes that no parser accepts')] });
  assert.equal(r2.results[0].status, 'failed');
  assert.deepEqual(X.listExternalResources(O, 'fake:alpha').map(x => x.ukoId), [r1.results[0].ukoId]);
  assert.deepEqual(census(O), c0, 'a failed update changed stored knowledge');
});

// ── 7 · Deletion after a partial synchronisation ─────────────────────────────

test('7 · deletion after a crashed sync removes artefacts whose UKO was never saved', async () => {
  const O = freshOwner('partial');
  // The state a crash between enrichment and saveUKO leaves: derived data with
  // the source's ids in every store, and no UKO. Produced by a real ingest
  // whose UKO is then dropped (the only write a crash would have prevented).
  const r = await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [res('a/half.md', 'half.md', doc('Halfway'))] });
  await settle();
  us.removeUKO(O, r.results[0].ukoId);
  const { ukoPrefix, keyPrefix } = ident.sourcePrefixes('fake:alpha');
  const orphan = X.remainingUnder(O, { ukoPrefix, keyPrefix });
  assert.equal(orphan.ukos, 0);
  assert.ok(orphan.fileLinks + orphan.indexed + orphan.fileEntries + orphan.chunks > 0, 'fixture left no orphans');
  assert.deepEqual(X.listExternalSources(O), [], 'orphans are invisible to listing — only a prefix sweep can find them');

  const d = await X.deleteExternalSource(O, 'fake:alpha');
  assert.equal(d.complete, true, JSON.stringify(d));
  assert.ok(zeroRemaining(d.remaining));
  assert.equal(census(O).facts, 0);
});

// ── 8 · Deletion and retry ───────────────────────────────────────────────────

test('8 · an interrupted deletion converges on retry, and retries are idempotent', async () => {
  const O = freshOwner('retry');
  const r = await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [
    res('a/1', 'one.md', doc('Retrya')), res('a/2', 'two.md', doc('Retryb')),
  ] });
  await settle();
  // Interrupted half-way: evidence of one file and the UKO of the other are gone,
  // everything else is still there.
  es.removeFile(O, r.results[0].ukoId);
  us.removeUKO(O, r.results[1].ukoId);

  const d1 = await X.deleteExternalSource(O, 'fake:alpha');
  assert.equal(d1.complete, true, JSON.stringify(d1));
  const d2 = await X.deleteExternalSource(O, 'fake:alpha');
  assert.equal(d2.complete, true);
  assert.ok(Object.values(d2.removed).every(n => n === 0), `retry removed something: ${JSON.stringify(d2.removed)}`);
  const d3 = await X.deleteExternalSource(O, 'fake:never-synced');
  assert.equal(d3.complete, true, 'an unknown source must be a clean no-op');
});

test('8b · concurrent sync and delete for one owner are serialised (no resurrection)', async () => {
  const O = freshOwner('race');
  const sync = X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [res('a/r', 'r.md', doc('Racecond'))] });
  const del = X.deleteExternalSource(O, 'fake:alpha');
  await sync;
  const d = await del;
  assert.equal(d.complete, true);
  await settle();
  assert.deepEqual(census(O), census(freshOwner('empty-reference')), 'data from the deleted source reappeared');
});

// ── 9 · Cross-user isolation ─────────────────────────────────────────────────

test('9 · same source id and content for two users: fully separate, deletion touches only one', async () => {
  const A = freshOwner('A'), B = freshOwner('B');
  const batch = [res('shared/doc.md', 'doc.md', doc('Isolatix'))];
  const ra = await X.syncExternalResources({ ownerId: A, sourceId: 'fake:team', resources: batch });
  const rb = await X.syncExternalResources({ ownerId: B, sourceId: 'fake:team', resources: batch });
  assert.equal(ra.results[0].ukoId, rb.results[0].ukoId, 'ids are derived, so they match across owners…');
  const bBefore = census(B);

  await X.deleteExternalSource(A, 'fake:team');
  assert.equal(census(A).external, 0);
  assert.deepEqual(census(B), bBefore, '…and deleting for A must not touch B');
  assert.equal(X.listExternalResources(B, 'fake:team').length, 1);
  assert.equal(X.listExternalResources(A, 'fake:team').length, 0);
  assert.ok(es.listFacts(B, { limit: 999 }).some(f => /Isolatix/.test(f.statement ?? '')));
});

// ── 10 · Storage quota separation ────────────────────────────────────────────

test('10a · UKO store: external items never evict uploads; uploads keep their own cap of 100', () => {
  const O = freshOwner('quota-uko');
  const mk = (i, external) => {
    const hash = `${external ? 'e' : 'u'}${String(i).padStart(63, '0')}`;
    const o = uko.createUKO({
      ownerId: O, sourceFile: { name: `f${i}.md`, ext: '.md', bytes: 10, hash }, fileType: 'document',
      ...(external ? { id: ident.externalIdentity('fake:quota', `r${i}`, hash).ukoId, external: { sourceId: 'fake:quota', externalId: `r${i}` } } : {}),
    });
    o.provenance.uploadedAt = i;   // deterministic age
    return o;
  };
  for (let i = 0; i < 100; i++) us.saveUKO(mk(i, false));
  for (let i = 0; i < 150; i++) us.saveUKO(mk(1000 + i, true));
  const all = us.listUKOs(O, { limit: 1000 });
  assert.equal(all.filter(u => !ident.isExternalFileId(u.id)).length, 100, 'an import evicted an upload');
  assert.equal(all.filter(u => ident.isExternalFileId(u.id)).length, 150);
  // A 101st upload evicts the oldest UPLOAD (unchanged policy), never an external item.
  us.saveUKO(mk(5000, false));
  const after = us.listUKOs(O, { limit: 1000 });
  assert.equal(after.filter(u => !ident.isExternalFileId(u.id)).length, 100);
  assert.equal(after.filter(u => ident.isExternalFileId(u.id)).length, 150);
  assert.ok(!after.some(u => u.sourceFile.name === 'f0.md'), 'the oldest upload should have been the one evicted');
  // The external budget is a hard stop, never an eviction.
  for (let i = 150; i < us.MAX_EXTERNAL_UKOS_PER_OWNER; i++) us.saveUKO(mk(1000 + i, true));
  assert.throws(() => us.saveUKO(mk(9999, true)), err => err.code === 'EXTERNAL_LIMIT');
  assert.equal(us.listUKOs(O, { limit: 1000 }).length, 100 + us.MAX_EXTERNAL_UKOS_PER_OWNER);
});

test('10b · file memory and chunk namespaces: external entries never evict upload entries or chunks', () => {
  const O = freshOwner('quota-mem');
  for (let i = 0; i < 60; i++) engine.rememberFile(O, { name: `up${i}.md`, summary: 's' });
  for (let i = 0; i < 120; i++) {
    const key = ident.externalIdentity('fake:quota', `r${i}`, `a${String(i).padStart(63, '0')}`).fileKey;
    engine.rememberFile(O, { name: `ext${i}.md`, summary: 's', key, external: { sourceId: 'fake:quota', externalId: `r${i}` } });
  }
  const keys = Object.keys(mindStore.getMind(O).files);
  assert.equal(keys.filter(k => !ident.isExternalFileKey(k)).length, 60, 'uploads evicted by imports');
  assert.equal(keys.filter(ident.isExternalFileKey).length, 120);
  assert.equal(fm.externalFileNamespace(O) === fm.fileNamespace(O), false, 'chunks must have separate budgets');
});

test('10c · sync limits are deterministic: in order, rejected with a reason, nothing evicted or half-written', async () => {
  const O = freshOwner('quota-sync');
  // Pre-fill the external budget to one below the item limit with stored items.
  for (let i = 0; i < X.EXTERNAL_LIMITS.itemsPerOwner - 1; i++) {
    const hash = `f${String(i).padStart(63, '0')}`;
    us.saveUKO(uko.createUKO({
      ownerId: O, sourceFile: { name: `p${i}.md`, ext: '.md', bytes: 100, hash }, fileType: 'document',
      id: ident.externalIdentity('fake:prefill', `p${i}`, hash).ukoId, external: { sourceId: 'fake:prefill', externalId: `p${i}` },
    }));
  }
  const before = census(O);
  const r = await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [
    res('a/fits', 'fits.md', doc('Fitsix')),
    res('a/over', 'over.md', doc('Overflow')),
    { externalId: 'a/big', name: 'big.md', buffer: Buffer.alloc(X.EXTERNAL_LIMITS.bytesPerResource + 1, 97) },
    res('a/fits', 'dupe.md', doc('Dupe')),
    res('a/zip', 'bundle.zip', 'PK\u0003\u0004 not really a zip'),
  ] });
  assert.deepEqual(r.results.map(x => `${x.status}:${x.reason ?? ''}`), [
    'created:', 'rejected:limit:items', 'rejected:limit:resource-bytes', 'rejected:duplicate:externalId-in-batch', 'rejected:unsupported:archive',
  ]);
  const after = census(O);
  assert.equal(after.external, before.external + 1);
  assert.equal(after.uploads, before.uploads);
  assert.equal(X.externalUsage(O).items, X.EXTERNAL_LIMITS.itemsPerOwner);
  // At the limit, an UPDATE of an existing item still works (it replaces, it does not add).
  const u = await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [res('a/fits', 'fits.md', doc('Fitsix', 'v2'))] });
  assert.equal(u.results[0].status, 'updated');
  assert.equal(X.externalUsage(O).items, X.EXTERNAL_LIMITS.itemsPerOwner);
});

test('10d · byte budget is per owner and rejects before writing', async () => {
  const O = freshOwner('quota-bytes');
  const hash = `b${'0'.repeat(63)}`;
  us.saveUKO(uko.createUKO({
    ownerId: O, sourceFile: { name: 'huge.md', ext: '.md', bytes: X.EXTERNAL_LIMITS.bytesPerOwner - 10, hash }, fileType: 'document',
    id: ident.externalIdentity('fake:prefill', 'huge', hash).ukoId, external: { sourceId: 'fake:prefill', externalId: 'huge' },
  }));
  const r = await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [res('a/x', 'x.md', doc('Bytewise'))] });
  assert.equal(r.results[0].reason, 'limit:bytes');
  assert.equal(census(O).facts, 0, 'a rejected resource wrote facts');
  const other = freshOwner('quota-bytes-other');
  const r2 = await X.syncExternalResources({ ownerId: other, sourceId: 'fake:alpha', resources: [res('a/x', 'x.md', doc('Bytewise'))] });
  assert.equal(r2.results[0].status, 'created', 'one owner\'s usage limited another');
});

// ── 11 · Existing upload functionality ───────────────────────────────────────

test('11 · the upload path is unchanged: uuid ids, name keys, artifact node, attachment, files: namespace', async () => {
  const O = freshOwner('upload');
  const out = await ingestFiles({ files: [{ name: 'Plan.md', buffer: Buffer.from(doc('Uploaded')) }], ownerId: O, conversationId: `${O}-conv` });
  const r = out.results[0];
  assert.equal(r.status, 'ready');
  assert.match(r.ukoId, /^[0-9a-f]{8}-[0-9a-f]{4}-/, 'uploads must keep uuid ids');
  assert.ok(r.attachmentId, 'conversation attachment missing');
  const u = us.getUKO(O, r.ukoId);
  assert.equal(u.provenance.external, undefined);
  const mind = mindStore.getMind(O);
  assert.ok(mind.files['file:plan.md']);
  assert.ok(mind.graph.nodes['artifact:plan.md']);
  await settle();
  assert.ok(vs.idsIn(fm.fileNamespace(O)).some(id => id.startsWith('file:plan.md#')));
  assert.equal(vs.idsIn(fm.externalFileNamespace(O)).length, 0);
});

// ── 12 · Account deletion regression ─────────────────────────────────────────

test('12 · account deletion removes external knowledge too (and still removes uploads)', async () => {
  const userId = `purge-${process.pid}`;
  const O = `user:${userId}`;
  await upload(O, 'mine.md', doc('Minefield'));
  await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [res('a/1', 'ext.md', doc('Purgatory'))] });
  await settle();
  assert.ok(census(O).externalChunks > 0);
  const report = await purge.purgeOwnerData({ userId });
  assert.ok(Array.isArray(report.errors));
  const c = census(O);
  assert.deepEqual([c.uploads, c.external, c.facts, c.externalEntries, c.uploadChunks, c.externalChunks], [0, 0, 0, 0, 0, 0], JSON.stringify(c));
  assert.equal(X.externalUsage(O).items, 0);
});

// ── 13 · Retrieval after source deletion ─────────────────────────────────────

test('13 · after deletion no retrieval lane returns the source: knowledge, chunks, file memory, keyword search', async () => {
  const O = freshOwner('retrieval');
  const TOKEN = 'Xylophant';
  const content = doc(TOKEN, `${TOKEN} uses a CRDT sync engine.`);
  await upload(O, 'keep.md', doc('Keepalive'));
  await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [res('a/x', 'xylo.md', content)] });
  await settle();

  const lanes = async () => {
    const chunks = await fm.fileChunkScores(O, content.slice(0, 400), { minScore: 0.5 });
    const mem = engine.memoryRetrieve(O, { query: `what does the xylo.md file say about ${TOKEN}?`, fileChunks: chunks });
    return {
      knowledge: pic.retrieveKnowledge(O, `${TOKEN} launch`).block ?? '',
      chunks: chunks.map(c => c.text).join(' '),
      fileContext: mem.fileContext,
      search: idx.searchFiles(O, TOKEN.toLowerCase()).map(f => f.name).join(' '),   // ids + names, not content
    };
  };
  const before = await lanes();
  const marker = lane => (lane === 'search' ? /xylo.md/ : new RegExp(TOKEN, 'i'));
  for (const [lane, text] of Object.entries(before)) assert.match(text, marker(lane), `fixture: ${lane} did not surface the source before deletion`);

  await X.deleteExternalSource(O, 'fake:alpha');
  const after = await lanes();
  for (const [lane, text] of Object.entries(after)) assert.doesNotMatch(text, marker(lane), `${lane} still returns the deleted source`);
  assert.match(pic.retrieveKnowledge(O, 'Keepalive launch').block ?? '', /Keepalive/, 'the upload stopped being retrievable');
});

// ── 14 · Cache and index invalidation ───────────────────────────────────────

test('14 · caches and indexes forget the source: parse cache, search index, claim vectors, chunks, PIC', async () => {
  const O = freshOwner('cache');
  const content = doc('Cachemir');
  const r = await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [res('a/c', 'c.md', content)] });
  await settle();
  const id = r.results[0].ukoId;
  const hash = us.getUKO(O, id).sourceFile.hash;
  const factIds = es.factIdsForFile(O, id);
  const claimNs = claims.canonicalClaimNamespace(O);
  assert.ok(us.getCachedKnowledge(hash, 'source', { ownerId: O }) || us.getCachedKnowledge(hash, 'document', { ownerId: O }), 'fixture: parse cache empty');
  assert.ok(factIds.length && factIds.some(f => vs.idsIn(claimNs).includes(String(f))), 'fixture: no claim vectors');

  const d = await X.deleteExternalSource(O, 'fake:alpha');
  assert.equal(d.complete, true);
  assert.equal(us.getCachedKnowledge(hash, 'source', { ownerId: O }) ?? us.getCachedKnowledge(hash, 'document', { ownerId: O }), null, 'parse cache kept deleted content');
  assert.equal(idx.indexedFileIdsByPrefix(O, id).length, 0);
  assert.ok(!factIds.some(f => vs.idsIn(claimNs).includes(String(f))), 'claim vectors of deleted facts remain');
  assert.equal(vs.idsIn(fm.externalFileNamespace(O)).length, 0);
  const lifecycle = (await import('../../pic/picStore.js')).picBucket(O).lifecycle;
  assert.ok(![...lifecycle.keys()].some(s => s === `uko:${id}` || factIds.some(f => s === `fact:${f}`)), 'PIC lifecycle kept deleted subjects');
});

test('14b · the parse cache is kept while another live file still has the same bytes', async () => {
  const O = freshOwner('cache-shared');
  const content = doc('Sharedbytes');
  await upload(O, 'same.md', content);
  await X.syncExternalResources({ ownerId: O, sourceId: 'fake:alpha', resources: [res('a/s', 'same.md', content)] });
  const hash = us.listUKOs(O, { limit: 10 })[0].sourceFile.hash;
  await X.deleteExternalSource(O, 'fake:alpha');
  assert.ok(us.getCachedKnowledge(hash, 'source', { ownerId: O }) || us.getCachedKnowledge(hash, 'document', { ownerId: O }), 'dropped a cache entry the upload still uses');
});

test('identity: sourceId and externalId are validated; ids never depend on the file name', () => {
  assert.throws(() => ident.externalIdentity('Bad Source', 'x', 'ab'.repeat(32)), TypeError);
  assert.throws(() => ident.externalIdentity('fake:alpha', '', 'ab'.repeat(32)), TypeError);
  assert.throws(() => ident.externalIdentity('fake:alpha', 'a\nb', 'ab'.repeat(32)), TypeError);
  const a = ident.externalIdentity('fake:alpha', 'x', 'ab'.repeat(32));
  const b = ident.externalIdentity('fake:beta', 'x', 'ab'.repeat(32));
  assert.notEqual(a.ukoId, b.ukoId);
  assert.ok(a.ukoId.startsWith(ident.sourcePrefixes('fake:alpha').ukoPrefix));
  assert.ok(a.ukoId.startsWith(ident.itemPrefixes('fake:alpha', 'x').ukoPrefix));
  assert.ok(!a.ukoId.startsWith(ident.sourcePrefixes('fake:beta').ukoPrefix));
});
