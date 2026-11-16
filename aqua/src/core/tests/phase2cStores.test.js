/**
 * Phase 2c — the remaining stores on owner partitions, with real processes
 * (two "instances" each) against the disposable Postgres. Skipped loudly
 * without one. For every store: concurrent writes keep both sides, a deletion
 * on one side is honoured by the other, and only the requested owner is held.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { runProcess, tempDir, acquireStoreKeyLock } from './helpers/multiProcess.mjs';

const LIVE = Boolean(process.env.DATABASE_URL);
let releaseLock = null;
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';
const KEYS = ['.aqua-brain.json', '.aqua-evidence.json', '.aqua-fileindex.json', '.aqua-uko.json', '.aqua-attachments.json',
  '.aqua-pic.json', '.aqua-vectors.json', '.aqua-projects.json', '.aqua-index.json', '.aqua-artifacts.json',
  '.aqua-history.json', '.aqua-history-trash.json', '.aqua-cognition.json', '.aqua-ledger.json'];
const FLAGS = 'brain:on,evidence:on,fileindex:on,uko:on,attachments:on,pic:on,vectors:on,projects:on,index:on,artifacts:on,history:on,cognition:on,ledger:on';
const STORES = ['annotations', 'evidence', 'fileindex', 'uko', 'attachments', 'pic', 'vectors', 'projects', 'projectIndex', 'artifacts', 'conversations', 'cognition', 'ledger'];
const boot = { op: 'boot', stores: STORES };
const O = 'user:7';
let pool;

const proc = (ops, env = {}) => runProcess({ dataDir: tempDir('aq-2c-'), partitions: FLAGS, env }, ops);
const both = (opsA, opsB) => {
  const bar = tempDir('aq-bar-');
  const gate = [{ op: 'load', owner: O }, { op: 'barrier', dir: bar, name: 'go', n: 2 }];
  return Promise.all([proc([boot, ...gate, ...opsA, { op: 'flush' }]), proc([boot, ...gate, ...opsB, { op: 'flush' }])]);
};
const row = async (key, pk) => (await pool.query(
  'SELECT owner_id, data, version, deleted_at FROM aqua_store_partitions WHERE store_key = $1 AND partition_key = $2', [key, pk])).rows[0];
const data = async (key, pk) => { const r = await row(key, pk); return r?.data ? JSON.parse(r.data) : null; };
const call = (module, fn, ...args) => ({ op: 'call', module, fn, args });

before(async () => {
  if (!LIVE) return;
  releaseLock = await acquireStoreKeyLock();
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  await (await import('../db/migrate.js')).migrate();
});
beforeEach(async () => {
  if (!LIVE) return;
  await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = ANY($1)', [KEYS]);
  await pool.query(`DELETE FROM aqua_objects WHERE owner_id = $1`, [O]);
  // One marker row per store: "migrated", so `on` is not refused.
  for (const k of KEYS) {
    await pool.query(`INSERT INTO aqua_store_partitions (store_key, partition_key, owner_id, data, bytes, checksum, version)
      VALUES ($1, '~rest', '', '{}', 0, 'x', 1)`, [k]);
  }
});
after(async () => {
  if (!LIVE) return;
  try {
    await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = ANY($1)', [KEYS]);
    await pool.query(`DELETE FROM aqua_objects WHERE owner_id = $1`, [O]);
    await pool.end();
    await (await import('../db/pool.js')).closePool();
  } finally { await releaseLock?.(); }
});

describe('Phase 2c stores — two instances, real Postgres', { skip }, () => {
  test('annotations: both instances\' annotations kept; a removal on one side holds', async () => {
    await proc([boot, { op: 'load', owner: O }, call('annotations', 'annotate', O, 'e0', { description: 'old' }), { op: 'flush' }]);
    await both([call('annotations', 'annotate', O, 'e1', { description: 'A' }), call('annotations', 'removeAnnotation', O, 'e0')],
      [call('annotations', 'annotate', O, 'e2', { description: 'B' })]);
    assert.deepEqual(Object.keys(await data('.aqua-brain.json', `o:${O}`)).sort(), ['e1', 'e2']);
  });

  test('evidence: facts from both kept; a removed file\'s facts and links are gone; links stay consistent', async () => {
    const ev = (id, file) => call('evidence', 'saveEvidence', O, { id, checksum: `ck-${id}`, sourceFileId: file, sourceType: 'document', createdAt: 1 });
    const fact = (id, evId) => call('evidence', 'saveFact', O, { id, statement: id, evidence: [evId], createdAt: 2 });
    await proc([boot, { op: 'load', owner: O }, ev('e1', 'F1'), fact('f1', 'e1'), { op: 'flush' }]);
    await both([call('evidence', 'removeFile', O, 'F1'), ev('e2', 'F2'), fact('f2', 'e2')], [ev('e3', 'F3'), fact('f3', 'e3')]);
    const d = await data('.aqua-evidence.json', `o:${O}`);
    assert.deepEqual(Object.keys(d.facts).sort(), ['f2', 'f3']);
    assert.deepEqual(Object.keys(d.evidence).sort(), ['e2', 'e3']);
    assert.equal(d.byFile.F1, undefined);
    assert.deepEqual(d.evidenceRefs.e3, ['f3']);
  });

  test('uko + file index: uploads from both instances kept; a removed upload stays removed', async () => {
    const uko = id => ({ id, owner: O, fileType: 'document', sourceFile: { name: `${id}.pdf`, hash: `h-${id}` }, provenance: { uploadedAt: Date.now() }, entities: [{ value: id }], keywords: [id], topics: [] });
    await proc([boot, { op: 'load', owner: O }, call('uko', 'saveUKO', uko('u0')), { op: 'flush' }]);
    await both([call('uko', 'saveUKO', uko('u1')), call('fileindex', 'indexUKO', O, uko('u1')), call('uko', 'removeUKO', O, 'u0')],
      [call('uko', 'saveUKO', uko('u2')), call('fileindex', 'indexUKO', O, uko('u2'))]);
    assert.deepEqual(Object.keys(await data('.aqua-uko.json', `owners:${O}`)).sort(), ['u1', 'u2']);
    assert.deepEqual(Object.keys((await data('.aqua-fileindex.json', `o:${O}`)).files).sort(), ['u1', 'u2']);
  });

  test('attachments: belong to the conversation\'s user; uploads from both instances kept', async () => {
    const norm = t => ({ format: 'txt', title: t, content: t, metadata: {}, sections: [], pages: 1, language: 'en', truncated: false });
    await proc([boot, { op: 'load', owner: O }, call('conversations', 'getOrCreateConversation', 'cv', { userId: '7' }), { op: 'flush' }]);
    await both([call('attachments', 'attachToConversation', 'cv', { name: 'a.txt', kind: 'document', normalized: norm('A') })],
      [call('attachments', 'attachToConversation', 'cv', { name: 'b.txt', kind: 'document', normalized: norm('B') })]);
    const r = await row('.aqua-attachments.json', 'c:cv');
    assert.equal(r.owner_id, O, 'owned by the conversation\'s user, not conv:<id>');
    assert.deepEqual(JSON.parse(r.data).map(a => a.name).sort(), ['a.txt', 'b.txt']);
  });

  test('pic: feedback counters from two instances ADD (no lost increment)', async () => {
    await proc([boot, { op: 'load', owner: O }, { op: 'picSignal', owner: O, fact: 'f', ok: 1 }, { op: 'flush' }]);
    await both([{ op: 'picSignal', owner: O, fact: 'f', ok: 3 }], [{ op: 'picSignal', owner: O, fact: 'f', ok: 2, bad: 1 }]);
    const s = (await data('.aqua-pic.json', `o:${O}`)).signals.f;
    assert.equal(s.ok, 6);
    assert.equal(s.bad, 1);
  });

  test('vectors: every namespace of the user is theirs; vectors from both kept, a removed one stays removed', async () => {
    const v = (ns, id) => call('vectors', 'upsert', ns, id, [0.1, 0.2], `h-${id}`);
    await proc([boot, { op: 'load', owner: O }, v(O, 'x'), { op: 'flush' }]);
    await both([v(O, 'a'), call('vectors', 'remove', O, 'x'), v(`files:${O}`, 'chunk1')], [v(O, 'b')]);
    assert.deepEqual(Object.keys(await data('.aqua-vectors.json', `ns:${O}`)).sort(), ['a', 'b']);
    assert.equal((await row('.aqua-vectors.json', `ns:files:${O}`)).owner_id, O);
  });

  test('workspaces + project index: owned by the workspace owner; a summary here and an ingest there both land', async () => {
    const ws = { id: 'w1', ownerId: O, createdAt: 1, meta: {}, files: [], structure: {}, indexStatus: 'pending', summary: null };
    await proc([boot, { op: 'load', owner: O }, call('projects', 'saveWorkspace', 'w1', ws), { op: 'flush' }]);
    await both([call('projects', 'saveWorkspace', 'w1', { ...ws, summary: 'from A' })],
      [call('projectIndex', 'buildIndex', 'w1', [{ path: 'a.js', content: 'export const x = 1;\n', lang: 'javascript', size: 20 }])]);
    assert.equal((await data('.aqua-projects.json', 'ws:w1')).summary, 'from A');
    const idx = await row('.aqua-index.json', 'ws:w1');
    assert.equal(idx.owner_id, O, 'the index row belongs to the workspace owner');
    assert.equal(JSON.parse(idx.data)[0].path, 'a.js');
  });

  test('artifacts: a file written on one instance is served by another; concurrent edits get distinct versions', async () => {
    const [c] = (await proc([boot, { op: 'load', owner: O }, { op: 'artifactCreate', owner: O, text: 'v1 text' }])).slice(2);
    const r1 = await proc([boot, { op: 'load', owner: O }, { op: 'artifactRead', id: c.id }]);
    assert.equal(r1.at(-1).text, 'v1 text', 'read from the shared object store on a different instance');
    const [a, b] = await both([{ op: 'artifactAppend', id: c.id, text: 'edit A' }], [{ op: 'artifactAppend', id: c.id, text: 'edit B' }]);
    const versions = [a.at(-2).version, b.at(-2).version].sort();
    assert.deepEqual(versions, [2, 3], 'two edits → two versions, never the same number');
    const r = await proc([boot, { op: 'load', owner: O }, { op: 'artifactRead', id: c.id, version: 2 }, { op: 'artifactRead', id: c.id, version: 3 }]);
    assert.deepEqual([r.at(-2).text, r.at(-1).text].sort(), ['edit A', 'edit B'], 'each version holds its own files');
    await proc([boot, { op: 'load', owner: O }, call('artifacts', 'deleteArtifact', c.id)]);
    assert.ok((await row('.aqua-artifacts.json', `a:${c.id}`)).deleted_at);
    assert.equal(Number((await pool.query(`SELECT count(*) FROM aqua_objects WHERE left(object_key, length($1)) = $1`, [`artifacts/${c.id}/`])).rows[0].count), 0);
  });

  test('trash: a deleted conversation\'s snapshot is a row of its user; account purge retires it', async () => {
    await proc([boot, { op: 'load', owner: O }, call('conversations', 'getOrCreateConversation', 'gone', { userId: '7' }),
      call('conversations', 'addMessage', 'gone', 'user', 'bye'), { op: 'flush' }, call('conversations', 'clearConversation', 'gone'), { op: 'flush' }]);
    const t = (await pool.query(`SELECT data, owner_id FROM aqua_store_partitions WHERE store_key = '.aqua-history-trash.json' AND partition_key LIKE 't:%'`)).rows;
    assert.equal(t.length, 1);
    assert.equal(t[0].owner_id, O);
    assert.equal(JSON.parse(t[0].data).messages[0].content, 'bye');
    await proc([boot, { op: 'load', owner: O }, call('conversations', 'purgeTrashForUser', '7'), { op: 'flush' }]);
    const after = (await pool.query(`SELECT data FROM aqua_store_partitions WHERE store_key = '.aqua-history-trash.json' AND partition_key LIKE 't:%'`)).rows;
    assert.equal(after[0].data, null);
  });

  test('cognition + ledger: global heuristics aggregate across instances, each counting only its own turns once', async () => {
    const plans = n => Array.from({ length: n }, () => call('cognition', 'recordPlan', { taskType: 'chat', styleId: 's' }));
    const outcomes = n => Array.from({ length: n }, () => call('ledger', 'recordOutcome', { taskType: 'chat', provider: 'p', latencyMs: 100 }));
    const [a, b] = await both(
      [...plans(5), ...outcomes(4), { op: 'aggSync', storeKey: '.aqua-cognition.json' }, { op: 'aggSync', storeKey: '.aqua-ledger.json' }],
      [...plans(3), ...outcomes(2), { op: 'aggSync', storeKey: '.aqua-cognition.json' }, { op: 'aggSync', storeKey: '.aqua-ledger.json' }]);
    assert.ok(a && b);
    const r = await proc([boot, { op: 'aggSync', storeKey: '.aqua-cognition.json' }, { op: 'aggSync', storeKey: '.aqua-ledger.json' },
      call('cognition', 'getCognitionSnapshot'), call('ledger', 'getLedgerSnapshot')]);
    const cog = r.at(-2); const led = r.at(-1);
    assert.equal(cog.byTask.chat.turns, 8);
    assert.equal(cog.byTask.chat.byStrategy.s.planned, 8);
    assert.equal(led.byTask.chat.turns, 6);
    assert.equal(led.byTask.chat.byProvider.p.latencyEwma, 100);
    // never per-user: the aggregate rows have no owner
    assert.equal(Number((await pool.query(`SELECT count(*) FROM aqua_store_partitions WHERE store_key = ANY($1) AND owner_id <> ''`, [['.aqua-cognition.json', '.aqua-ledger.json']])).rows[0].count), 0);
  });

  test('isolation: loading one user holds none of another user\'s rows in any store', async () => {
    const other = 'user:8';
    await proc([boot, { op: 'load', owner: other }, call('annotations', 'annotate', other, 'secret', { description: 'x' }),
      call('vectors', 'upsert', other, 'v', [1], 'h'), { op: 'flush' }]);
    const r = await proc([boot, { op: 'load', owner: O }, call('annotations', 'annotationStats'), call('vectors', 'idsIn', other)]);
    assert.equal(r.at(-2).owners, 0, 'no annotation owner loaded besides the requested (empty) one');
    assert.deepEqual(r.at(-1), []);
    await pool.query(`DELETE FROM aqua_store_partitions WHERE owner_id = $1`, [other]);
  });
});
