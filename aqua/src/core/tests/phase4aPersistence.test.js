/**
 * Scalability Phase 4A — every accepted interaction is durable BEFORE the
 * response, against the disposable Postgres. This process is one "host" with
 * every store on partitions and durable learning on.
 *
 *   gate      a mutating request's writes are in the database when its response
 *             arrives; writes that cannot be made durable turn the success
 *             into a retryable 503; a read is never failed by its bookkeeping;
 *             a refund owed on an error is recorded before the error is sent
 *   chat      the turn's preparation writes are durable before the commit (a
 *             failure commits nothing); commit effects are awaited and written
 *             before the response; the embedding refresh is a durable job
 *   scope     a request flushes ITS keys only — another user's pending write
 *             is neither written nor waited for
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIVE = Boolean(process.env.DATABASE_URL);
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';
const RUN = Date.now().toString(36);

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-p4a-'));
process.env.AQUA_STORE_PARTITIONS = 'reflection:on,mind:on,recall-redactions:on,history:on,reasoning-graph:on,ids:on,brain:on,evidence:on,fileindex:on,uko:on,attachments:on,pic:on,vectors:on,projects:on,index:on,artifacts:on,cognition:on,ledger:on';
process.env.AQUA_POST_TURN_DURABLE = 'on';
process.env.AQUA_JOB_LOG = 'off';
process.env.AQUA_E6 = 'off';
process.env.MONGO_URI = '';
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';

const M = {};
let pool;
let releaseLock = null;
let server = null;
let base = '';

async function load() {
  const { acquireStoreKeyLock } = await import('./helpers/multiProcess.mjs');
  releaseLock = await acquireStoreKeyLock();
  const { migrate } = await import('../db/migrate.js');
  await migrate();
  pool = await (await import('../db/pool.js')).getPool();
  M.storage = await import('../storage/index.js');
  await M.storage.configurePartitionBindings();
  M.rw = await import('../storage/requestWrites.js');
  M.gate = await import('../storage/responseGate.js');
  M.mind = await import('../../mind/mindStore.js');
  M.conv = await import('../../memory/conversationStore.js');
  M.post = await import('../../routes/turnPostProcess.js');
  M.txn = await import('../../memory/turnCommit.js');
  M.rt = await import('../jobs/workerRuntime.js');
  M.ltm = await import('../../memory/longTermMemory.js');
  M.emb = await import('../../embeddings/embeddingProvider.js');
  M.binding = await import('../storage/ownerBinding.js');

  // A minimal Express app wired exactly like aqua/router.js's first middleware.
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => M.rw.runWithWriteScope(() => { M.gate.installResponseGate(req, res); next(); }));
  app.post('/mind/:owner', (req, res) => {
    const m = M.mind.getMind(req.params.owner);
    m.p4aMarker = req.body.marker;
    M.mind.touchMind(m);
    res.json({ ok: true });
  });
  app.all('/broken', (req, res) => { M.rw.noteWrite(FAILING, 'k'); res.json({ ok: true }); });
  app.post('/refund', (req, res) => {
    req.creditContext = { refund: async () => { await new Promise(r => setTimeout(r, 300)); refunded = true; return true; } };
    res.status(500).json({ ok: false });
  });
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
}

/** A store whose writes can never be made durable (a database that refuses). */
const FAILING = {
  label: 'failing-test-store', storeKey: 'failing', authoritative: () => true,
  flushOnly: async () => { throw new Error('database unavailable (simulated)'); },
  pendingAmong: keys => keys.size,
};
let refunded = false;

const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
const mindRow = async owner => (await q(`SELECT data FROM aqua_store_partitions WHERE store_key = '.aqua-mind.json' AND owner_id = $1 AND data IS NOT NULL`, [owner]))[0] ?? null;

describe('Phase 4A — durable before the response (real Postgres)', { skip, concurrency: false }, () => {
  before(load);
  after(async () => {
    // Jobs this suite created and did not run are retired, so other suites' drains never see them.
    await pool?.query(`UPDATE aqua_jobs SET state = 'dead', last_error = 'phase4a test cleanup', claimed_by = NULL
                        WHERE owner_id LIKE 'user:p4a-%' AND state IN ('queued', 'running')`).catch(() => {});
    server?.close();
    await releaseLock?.();
    M.emb?.__clearEmbedderForTests?.();
    await M.storage?.flushStorage(3000);
    await (await import('../db/pool.js')).closePool();
  });

  test('a mutating request\'s write is in the database when its response arrives (no timer)', async () => {
    const owner = `user:p4a-gate-${RUN}`;
    await M.binding.ensureOwnerLoaded(owner);
    const r = await fetch(`${base}/mind/${encodeURIComponent(owner)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marker: `m-${RUN}` }) });
    assert.equal(r.status, 200);
    const row = await mindRow(owner);        // read IMMEDIATELY — before any debounce could fire
    assert.ok(row && JSON.parse(row.data).p4aMarker === `m-${RUN}`, 'the response arrived before the write was durable');
  });

  test('a mutating request whose writes cannot be made durable gets a retryable 503, not a success', async () => {
    const r = await fetch(`${base}/broken`, { method: 'POST' });
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.retryable, true);
    assert.equal(r.headers.get('retry-after'), '2');
  });

  test('a read is not failed by bookkeeping it could not save', async () => {
    const r = await fetch(`${base}/broken`, { method: 'GET' });
    assert.equal(r.status, 200);
  });

  test('a refund owed by an error is recorded before the error response is sent', async () => {
    refunded = false;
    const r = await fetch(`${base}/refund`, { method: 'POST' });
    assert.equal(r.status, 500);
    assert.equal(refunded, true, 'the client heard of the failure before its credit was given back');
  });

  test('a request flushes ITS writes only: another user\'s pending write is not written or waited for', async () => {
    const a = `user:p4a-scope-a-${RUN}`; const b = `user:p4a-scope-b-${RUN}`;
    await M.binding.ensureOwnerLoaded(a); await M.binding.ensureOwnerLoaded(b);
    // b's change is made OUTSIDE any request scope (another request, still pending).
    const mb = M.mind.getMind(b); mb.p4aMarker = 'b'; M.mind.touchMind(mb);
    await M.rw.runWithWriteScope(async () => {
      const ma = M.mind.getMind(a); ma.p4aMarker = 'a'; M.mind.touchMind(ma);
      const r = await M.rw.flushScopeStrict();
      assert.equal(r.keys, 1, 'this request wrote one key');
    });
    assert.ok(await mindRow(a), 'own write durable');
    assert.equal(M.mind.mindPartitionBinding().pendingAmong(new Set([b])), 1, 'the other user\'s write was flushed by this request');
    await M.storage.flushStorage(3000);
  });

  test('chat: the turn\'s preparation writes are durable BEFORE the commit; if they cannot be, nothing is committed', async () => {
    const uid = `p4a-pre-${RUN}`; const owner = `user:${uid}`;
    const conversationId = M.conv.createConversation({ userId: uid });
    await M.binding.ensureOwnerLoaded(owner);
    let committed = false;
    await assert.rejects(M.rw.runWithWriteScope(async () => {
      M.rw.noteWrite(FAILING, 'observation');
      return M.post.commitTurnWithLearning({ conversationId, userMessage: `pre-commit failure ${RUN}`, assistantMessage: 'x',
        ownerId: owner, commitMemory: () => { committed = true; } });
    }), err => err.retryable === true && err.where === 'pre-commit');
    assert.equal(committed, false);
    const msgs = await q(`SELECT 1 FROM aqua_store_partitions WHERE store_key = '.aqua-history.json' AND owner_id = $1 AND partition_key LIKE $2 AND data IS NOT NULL`, [owner, `m:${conversationId}:%`]);
    assert.equal(msgs.length, 0, 'messages were committed although the turn state was not durable');
    assert.equal((await q(`SELECT 1 FROM aqua_jobs WHERE owner_id = $1`, [owner])).length, 0);
  });

  test('chat: what the turn observed is in the database when commitTurnWithLearning returns', async () => {
    const uid = `p4a-obs-${RUN}`; const owner = `user:${uid}`;
    const conversationId = M.conv.createConversation({ userId: uid });
    await M.binding.ensureOwnerLoaded(owner);
    await M.rw.runWithWriteScope(async () => {
      const m = M.mind.getMind(owner); m.p4aMarker = 'observed'; M.mind.touchMind(m);   // stands for memoryObserve
      await M.post.commitTurnWithLearning({ conversationId, userMessage: 'hello', assistantMessage: 'hi', ownerId: owner });
    });
    const row = await mindRow(owner);
    assert.ok(row && JSON.parse(row.data).p4aMarker === 'observed');
  });

  test('chat: commit effects are awaited and written before the response; the embedding refresh becomes a durable job', async () => {
    const uid = `p4a-eff-${RUN}`; const owner = `user:${uid}`;
    const conversationId = M.conv.createConversation({ userId: uid });
    await M.binding.ensureOwnerLoaded(owner);
    M.emb.__setEmbedderForTests(async texts => texts.map(() => Array.from({ length: 8 }, (_, i) => (i + 1) / 10)));
    let effectDone = false; let indexRanInline = false;
    await M.rw.runWithWriteScope(async () => {
      const txn = M.txn.beginTurnMemory(owner);
      txn.defer(async () => { await new Promise(r => setTimeout(r, 200)); const m = M.mind.getMind(owner); m.p4aEffect = 'done'; M.mind.touchMind(m); effectDone = true; });
      txn.defer(() => { indexRanInline = true; }, 'index');
      M.txn.sealTurnMemory(txn);
      await M.post.commitTurnWithLearning({ conversationId, userMessage: 'I work at Initech.', assistantMessage: 'Noted.', ownerId: owner, memoryTxn: txn });
    });
    assert.equal(effectDone, true, 'the effect had not finished when the turn returned');
    assert.equal(JSON.parse((await mindRow(owner)).data).p4aEffect, 'done', 'the effect\'s write was not durable when the turn returned');
    assert.equal(indexRanInline, false, 'the embedding refresh still ran on the request path');
    const jobs = await q(`SELECT kind, payload FROM aqua_jobs WHERE owner_id = $1 AND kind = 'memory.index.v1'`, [owner]);
    assert.equal(jobs.length, 1, 'no durable index job');
    assert.deepEqual(jobs[0].payload, {}, 'the index job must carry no content');
  });

  test('the durable index job embeds the owner\'s facts in the worker', async () => {
    const uid = `p4a-idx-${RUN}`; const owner = `user:${uid}`;
    const conversationId = M.conv.createConversation({ userId: uid });
    await M.binding.ensureOwnerLoaded(owner);
    M.emb.__setEmbedderForTests(async texts => texts.map(() => Array.from({ length: 8 }, (_, i) => (i + 1) / 10)));
    await M.rw.runWithWriteScope(async () => {
      M.ltm.storeFact(owner, { key: 'employer', value: 'Initech', confidence: 0.95, sourceText: 'I work at Initech.' });
      const txn = M.txn.beginTurnMemory(owner);
      txn.defer(() => {}, 'index');
      M.txn.sealTurnMemory(txn);
      await M.post.commitTurnWithLearning({ conversationId, userMessage: 'I work at Initech.', assistantMessage: 'Noted.', ownerId: owner, memoryTxn: txn });
    });
    await q(`UPDATE aqua_jobs SET run_after = now() + interval '1 day' WHERE owner_id LIKE 'user:p4a-%' AND owner_id <> $1 AND state = 'queued'`, [owner]);
    let ran = null;
    for (let i = 0; i < 10 && !ran; i++) {
      const r = await M.rt.runOneJob(`p4a-${RUN}`, { kinds: ['memory.index.v1'] });
      if (r?.ownerId === owner) ran = r;
      if (!r) break;
    }
    assert.ok(ran?.ok, JSON.stringify(ran));
    const vec = await q(`SELECT partition_key FROM aqua_store_partitions WHERE owner_id = $1 AND store_key LIKE '%vector%' AND data IS NOT NULL`, [owner]);
    assert.ok(vec.length >= 1, 'no vector written by the index job');
  });
});
