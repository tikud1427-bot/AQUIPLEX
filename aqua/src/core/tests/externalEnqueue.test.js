/**
 * G1-2 — D-1 (re-addition racing with deletion) and D-2 (same-version
 * reprocessing after deletion), on the real migrated schema in pg-mem with the
 * REAL job queue (core/jobs/jobQueue.enqueue) and the REAL deletion
 * (core/worldModel/sourceDeletion.forgetExternalSourceClaims).
 *
 * pg-mem stubs advisory locks and runs one statement at a time, so a deletion
 * "held open" is modelled by ORDER (observation → deletion commits → enqueue)
 * plus a statement-order spy proving enqueue and deletion contend on the same
 * lock, first, before reading the tombstones. Two real connections racing in
 * both orders: sourceDeletion.live.test.js (L8, L9).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-g12-enqueue-'));
process.env.AQUA_DATA_DIR = TMP;
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
const envBefore = process.env.DATABASE_URL;

let mem, restorePool, poolMod, SD, G, DU, JQ;
before(async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/aqua';
  poolMod = await import('../db/pool.js');
  poolMod._resetForTests();
  const { createMemoryPg } = await import('./helpers/memoryPg.mjs');
  mem = createMemoryPg();
  restorePool = poolMod._setPoolForTests(mem.pool);
  await (await import('../db/migrate.js')).migrate();
  for (const ix of ['aqua_jobs_ready_ix', 'aqua_jobs_running_owner_ix', 'aqua_jobs_dead_ix', 'aqua_jobs_running_heartbeat_ix']) {
    await mem.pool.query(`DROP INDEX IF EXISTS ${ix}`);   // pg-mem partial-index artefact (see sourceDeletion.test.js)
  }
  (await import('../dataClass.js')).registerConnectorDataPolicy('enqsrc', { allowedProviders: '*' });
  SD = await import('../worldModel/sourceDeletion.js');
  G = await import('../worldModel/externalDeletionGuard.js');
  DU = await import('../../files/documentUnderstanding.js');
  JQ = await import('../jobs/jobQueue.js');
});
after(async () => {
  restorePool?.();
  await mem?.close();
  if (envBefore === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = envBefore;
  poolMod?._resetForTests();
});

const hex = (n, c) => String(c).repeat(n);
const SRC_A = `ext_${hex(12, 'a')}_`, SRC_B = `ext_${hex(12, 'b')}_`;
const uko = (src, it, ver = 'abcdef123456') => `${src}${hex(16, it)}_${ver}`;
const item = (src, it) => `${src}${hex(16, it)}_`;
let seq = 0;
const freshOwner = () => `user:g12e-${process.pid}-${++seq}`;
const q = (sql, p = []) => mem.pool.query(sql, p);
const tick = () => new Promise(r => setTimeout(r, 3));
const noVectors = { removeVector: () => true, canonicalNamespace: o => `canonical-claims:${o}` };
const del = (O, scope) => SD.forgetExternalSourceClaims(O, scope, noVectors);
const observe = (O, id) => G.observeExternalSource(mem.pool, O, id);
const TEXT = 'Lena owns the Atlas service. The Atlas launch is in June.';
const doc = (id, observedAt, extra = {}) => ({ ukoId: id, name: 'r.md', kind: 'document', text: TEXT, hash: 'c'.repeat(64), dataClass: 'external:enqsrc', observedAt, ...extra });
const enqueueDoc = async (O, d) => DU.enqueueDocumentUnderstanding({ ownerId: O, documents: [d], deps: { enabled: async () => true, pool: mem.pool } });
const jobs = async (O, id = null) => (await q(`SELECT job_id, idempotency_key, state, payload FROM aqua_jobs WHERE owner_id = $1 AND kind = $2`, [O, DU.DOCUMENT_JOB_KIND])).rows
  .filter(r => !id || (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload).ukoId === id);

describe('D-1 · enqueue under the source lock, checked against the deletion tombstone', () => {
  test('1 · a resource deleted after its sync saw it (deletion held open, then committed) is NOT enqueued', async () => {
    const O = freshOwner(), id = uko(SRC_A, '1');
    const observedAt = await observe(O, id);          // the sync saw the resource
    await tick();
    await del(O, { ukoPrefix: SRC_A });               // the deletion runs and commits meanwhile
    const r = await enqueueDoc(O, doc(id, observedAt));
    assert.equal(r.enqueued, 0);
    assert.deepEqual(r.refusedReasons, ['source-deleted']);
    assert.deepEqual(await jobs(O), [], 'a job was written for a deleted resource');
  });

  test('2 · enqueue AFTER the deletion committed (re-connection / re-addition) works', async () => {
    const O = freshOwner(), id = uko(SRC_A, '1');
    await del(O, { ukoPrefix: SRC_A });
    await tick();
    const observedAt = await observe(O, id);          // a NEW sync after the deletion
    const r = await enqueueDoc(O, doc(id, observedAt));
    assert.ok(r.enqueued >= 1, JSON.stringify(r));
    assert.ok((await jobs(O, id)).length >= 1);
  });

  test('3 · ordering: enqueue and deletion contend on the SAME lock, first, before the tombstone read and any insert', async () => {
    const O = freshOwner(), id = uko(SRC_A, '7');
    const stmts = [];
    const spy = { connect: async () => { const c = await mem.pool.connect(); return { query: (s, p) => { stmts.push({ s: String(s).trim(), p }); return c.query(s, p); }, release: () => c.release() }; }, query: (s, p) => mem.pool.query(s, p) };
    await SD.forgetExternalSourceClaims(O, { ukoPrefix: item(SRC_A, '7') }, { pool: spy, ...noVectors });
    const delLock = stmts[1].p;
    stmts.length = 0;
    const observedAt = new Date(Date.now() + 1000);
    await DU.enqueueDocumentUnderstanding({ ownerId: O, documents: [doc(id, observedAt)], deps: { enabled: async () => true, pool: spy } });
    assert.match(stmts[0].s, /^BEGIN/);
    // Step 1 (account-deletion barrier): the enqueue is an owner-data write, so it
    // first takes the owner's barrier (shared) and reads the deletion marker. A
    // source deletion is a deletion and never takes the barrier: no lock cycle.
    assert.match(stmts[1].s, /pg_advisory_xact_lock_shared/);
    assert.match(stmts[2].s, /FROM aqua_deleted_owners/);
    assert.match(stmts[3].s, /pg_advisory_xact_lock\(/);
    assert.deepEqual(stmts[3].p, delLock, 'enqueue and deletion must take the same lock');
    assert.match(stmts[4].s, /FROM aqua_external_deletions/);
    const firstInsert = stmts.findIndex(x => /^INSERT INTO aqua_jobs/.test(x.s));
    assert.ok(firstInsert > 4);
    assert.match(stmts.at(-1).s, /^COMMIT/);
    // a refused enqueue writes nothing and rolls back
    stmts.length = 0;
    await DU.enqueueDocumentUnderstanding({ ownerId: O, documents: [doc(id, new Date(0))], deps: { enabled: async () => true, pool: spy } });
    assert.ok(!stmts.some(x => /^INSERT/.test(x.s)));
    assert.match(stmts.at(-1).s, /^ROLLBACK/);
  });

  test('4 · other resources, other sources and other owners are independent of a deletion', async () => {
    const O = freshOwner(), P = freshOwner();
    const observedAt = await observe(O, uko(SRC_A, '1'));
    await tick();
    await del(O, { ukoPrefix: item(SRC_A, '1') });
    assert.equal((await enqueueDoc(O, doc(uko(SRC_A, '1'), observedAt))).enqueued, 0, 'the deleted resource');
    assert.ok((await enqueueDoc(O, doc(uko(SRC_A, '2'), observedAt))).enqueued >= 1, 'sibling resource of the same source');
    assert.ok((await enqueueDoc(O, doc(uko(SRC_B, '1'), observedAt))).enqueued >= 1, 'another source');
    assert.ok((await enqueueDoc(P, doc(uko(SRC_A, '1'), observedAt))).enqueued >= 1, 'another owner');
  });

  test('a resource update: the kept version is enqueued, the replaced version is refused', async () => {
    const O = freshOwner(), v1 = uko(SRC_A, '3', '111111'), v2 = uko(SRC_A, '3', '222222');
    const observedAt = await observe(O, v1);
    await tick();
    await del(O, { ukoPrefix: item(SRC_A, '3'), keepUkoId: v2 });
    assert.equal((await enqueueDoc(O, doc(v1, observedAt))).enqueued, 0);
    assert.ok((await enqueueDoc(O, doc(v2, observedAt))).enqueued >= 1);
  });

  test('without an observation time a covered resource is refused (conservative); an uncovered one is not', async () => {
    const O = freshOwner();
    await del(O, { ukoPrefix: item(SRC_A, '1') });
    assert.equal((await enqueueDoc(O, doc(uko(SRC_A, '1'), undefined))).enqueued, 0);
    assert.ok((await enqueueDoc(O, doc(uko(SRC_A, '2'), undefined))).enqueued >= 1);
  });

  test('uploads are untouched by all of this: no lock, no transaction, the same key as before', async () => {
    const O = freshOwner();
    const keys = [];
    const r = await DU.enqueueDocumentUnderstanding({ ownerId: O, documents: [{ ukoId: 'b2c3d4e5-0000-0000-0000-000000000000', name: 'u.md', text: TEXT, hash: 'd'.repeat(64) }],
      deps: { enabled: async () => true, pool: { connect: () => { throw new Error('uploads must not open a transaction'); } }, enqueue: async j => { keys.push(j.idempotencyKey); } } });
    assert.ok(r.enqueued >= 1);
    assert.equal(keys[0], `${DU.DOCUMENT_JOB_KIND}:${'d'.repeat(32)}:0`);
  });
});

describe('D-2 · the same version re-added after a deletion is understood (exactly once); retries stay idempotent', () => {
  test('running job at deletion → completes → identical re-add gets a NEW job; its retry does not; old row and unrelated rows untouched', async () => {
    const O = freshOwner(), id = uko(SRC_A, '1'), other = uko(SRC_B, '9');
    // first import: a job, which a worker has claimed (running) when the deletion arrives
    const t0 = await observe(O, id);
    await enqueueDoc(O, doc(id, t0));
    await enqueueDoc(O, doc(other, t0));
    const [first] = await jobs(O, id);
    assert.equal(first.idempotency_key, DU.externalDocumentJobKey(id, 'c'.repeat(64), 0, 0), 'generation 0 keeps the G1-1 key');
    await q(`UPDATE aqua_jobs SET state = 'running' WHERE job_id = $1`, [first.job_id]);
    const otherBefore = JSON.stringify(await jobs(O, other));
    await tick();
    const d = await del(O, { ukoPrefix: item(SRC_A, '1') });
    assert.ok(d.counts.runningJobsSkipped >= 1, 'the running job is never deleted');
    await q(`UPDATE aqua_jobs SET state = 'done' WHERE job_id = $1`, [first.job_id]);   // it finishes (its commit was refused — G1-1)
    // the user re-adds the IDENTICAL version
    await tick();
    const t1 = await observe(O, id);
    const r = await enqueueDoc(O, doc(id, t1));
    assert.ok(r.enqueued >= 1, 'the re-added resource was silently skipped');
    const now = await jobs(O, id);
    const fresh = now.filter(j => j.job_id !== first.job_id);
    assert.ok(fresh.length >= 1);
    assert.ok(fresh.every(j => j.idempotency_key.endsWith(':g1') && j.state === 'queued'), JSON.stringify(fresh.map(j => j.idempotency_key)));
    // ordinary duplicate retry of that enqueue: idempotent
    const again = await enqueueDoc(O, doc(id, t1));
    assert.equal((await jobs(O, id)).length, now.length, 'a retry created a duplicate job');
    assert.ok(again.enqueued >= 1, 'the retry reports the chunks it (re)submitted');
    // the old completed row and the unrelated resource's rows are untouched
    assert.equal((await jobs(O, id)).find(j => j.job_id === first.job_id)?.state, 'done');
    assert.equal(JSON.stringify(await jobs(O, other)), otherBefore);
  });

  test('a second deletion and re-add → generation 2: understood once more', async () => {
    const O = freshOwner(), id = uko(SRC_A, '4');
    for (let gen = 1; gen <= 2; gen++) {
      await del(O, { ukoPrefix: item(SRC_A, '4') });
      await tick();
      await enqueueDoc(O, doc(id, await observe(O, id)));
      assert.ok((await jobs(O, id)).some(j => j.idempotency_key.endsWith(`:g${gen}`)), `generation ${gen}`);
    }
  });

  test('the generation counts only deletions that cover the resource', async () => {
    const O = freshOwner(), id = uko(SRC_A, '5');
    await del(O, { ukoPrefix: SRC_B });                                   // another source
    await del(O, { ukoPrefix: item(SRC_A, '6') });                       // another resource
    await del(O, { ukoPrefix: item(SRC_A, '5'), keepUkoId: id });        // an update that KEPT this version
    await tick();
    await enqueueDoc(O, doc(id, await observe(O, id)));
    assert.deepEqual((await jobs(O, id)).map(j => j.idempotency_key.includes(':g')), [false]);
  });
});
