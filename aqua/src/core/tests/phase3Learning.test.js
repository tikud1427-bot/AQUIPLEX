/**
 * Scalability Phase 3 — durable post-turn learning, against the disposable
 * Postgres. Real modules, real SQL, real stores on partitions: this process is
 * one "host" (its own empty data directory); nothing is mocked except where a
 * test injects a deliberately slow or failing HANDLER to create the timing it
 * needs. Skipped loudly without a database.
 *
 *   commit     a turn's messages + jobs: one transaction, all or nothing;
 *              no user text in any job row; a retried commit creates nothing new
 *   queue      depends_on; fenced heartbeat/complete/fail; release; heartbeat
 *              keeps a long job from being reclaimed; recovery dead-letters a
 *              job that exhausted its attempts
 *   learning   the worker learns the turn once even when delivered twice;
 *              a deleted conversation / account means nothing is learned;
 *              an account deleted WHILE a job runs gets nothing written back;
 *              sensitive sentences are removed as on the request path
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIVE = Boolean(process.env.DATABASE_URL);
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';
const RUN = Date.now().toString(36);

// This process is a host with every store on partitions and the gate on.
process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-p3l-'));
process.env.AQUA_STORE_PARTITIONS = 'reflection:on,mind:on,recall-redactions:on,history:on,reasoning-graph:on,ids:on,brain:on,evidence:on,fileindex:on,uko:on,attachments:on,pic:on,vectors:on,projects:on,index:on,artifacts:on,cognition:on,ledger:on';
process.env.AQUA_POST_TURN_DURABLE = 'on';
process.env.AQUA_JOB_HEARTBEAT_STALE_MS = '1000';    // heartbeat every 250 ms
process.env.AQUA_JOB_LOG = 'off';
process.env.AQUA_E6 = 'off';
process.env.MONGO_URI = '';
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';

let M = {};
let pool;
let releaseLock = null;

async function load() {
  const { acquireStoreKeyLock } = await import('./helpers/multiProcess.mjs');
  releaseLock = await acquireStoreKeyLock();
  const { migrate } = await import('../db/migrate.js');
  await migrate();
  const { getPool } = await import('../db/pool.js');
  pool = await getPool();
  M.storage = await import('../storage/index.js');
  await M.storage.configurePartitionBindings();
  M.conv = await import('../../memory/conversationStore.js');
  M.post = await import('../../routes/turnPostProcess.js');
  M.queue = await import('../jobs/jobQueue.js');
  M.rt = await import('../jobs/workerRuntime.js');
  M.learn = await import('../../learning/turnLearning.js');
  M.del = await import('../storage/deletedOwners.js');
  M.binding = await import('../storage/ownerBinding.js');
  M.mind = await import('../../mind/mindStore.js');
  // Jobs left queued by an EARLIER, interrupted run of this suite (its own test
  // owners only) would be claimed by this run's drains: retire them.
  await pool.query(`UPDATE aqua_jobs SET state = 'dead', last_error = 'stale phase3Learning test job', claimed_by = NULL
                     WHERE (owner_id LIKE 'user:p3l-%' OR owner_id LIKE 'user:p4a-%') AND owner_id NOT LIKE $1 AND state IN ('queued', 'running')`, [`%${RUN}%`]);
}

const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
const jobsOf = owner => q(`SELECT job_id, kind, state, attempts, idempotency_key, payload, source_ref, depends_on, conversation_id
                             FROM aqua_jobs WHERE owner_id = $1 ORDER BY job_id`, [owner]);
const msgRows = (owner, conv) => q(`SELECT partition_key, data, deleted_at FROM aqua_store_partitions
                                     WHERE store_key = '.aqua-history.json' AND owner_id = $1 AND partition_key LIKE $2`, [owner, `m:${conv}:%`]);
const mindRow = async owner => (await q(`SELECT data, version FROM aqua_store_partitions WHERE store_key = '.aqua-mind.json' AND owner_id = $1 AND data IS NOT NULL`, [owner]))[0] ?? null;

let seq = 0;
async function newTurnOwner() {
  const uid = `p3l-${RUN}-${++seq}`;
  const owner = `user:${uid}`;
  const conversationId = M.conv.createConversation({ userId: uid });
  return { uid, owner, conversationId };
}

/** One durable turn, exactly as POST /chat commits it. */
async function turn(t, userMessage, assistantMessage = 'Noted.', extra = {}) {
  await M.binding.ensureOwnerLoaded(t.owner);
  return M.post.commitTurnWithLearning({
    conversationId: t.conversationId, userMessage, assistantMessage,
    ownerId: t.owner, taskType: 'conversation', rememberSensitive: false, ...extra,
  });
}

/** Run jobs of this owner only (other suites may share the queue), with the production runtime. */
async function drainOwner(owner, { handlers = M.rt.HANDLERS, kinds = [...M.learn.LEARNING_KINDS, 'ops.canary.v1'], max = 30 } = {}) {
  const ran = [];
  // Jobs other tests of this suite left queued are parked, so this drain runs only this owner's.
  await q(`UPDATE aqua_jobs SET run_after = now() + interval '1 day'
            WHERE owner_id LIKE 'user:p3l-%' AND owner_id <> $1 AND state = 'queued'`, [owner]);
  for (let i = 0; i < max; i++) {
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM aqua_jobs WHERE owner_id = $1 AND state = 'queued' AND run_after <= now()`, [owner]);
    if (!n) break;
    // Claim only this owner's work: other owners' rows are hidden by a kinds filter + owner check below.
    const r = await M.rt.runOneJob(`p3l-${RUN}`, { kinds, handlers: ownerOnly(owner, handlers) });
    if (!r) break;
    ran.push(r);
  }
  return ran;
}
/** A foreign owner's job claimed by accident is released untouched (attempt not counted). */
function ownerOnly(owner, handlers) {
  return Object.fromEntries(Object.entries(handlers).map(([kind, h]) => [kind, async job => {
    if (job.ownerId !== owner) throw Object.assign(new Error('foreign owner in test drain'), { foreign: true });
    return h(job);
  }]));
}

describe('Phase 3 — durable post-turn learning (real Postgres)', { skip, concurrency: false }, () => {
  before(load);
  after(async () => {
    await releaseLock?.();
    await M.storage?.flushStorage(3000);
    const { closePool } = await import('../db/pool.js');
    await closePool();
  });

  test('a committed turn = its messages + its learning jobs, in one transaction; no user text in the queue', async () => {
    const t = await newTurnOwner();
    const SECRET = `zebra-${RUN}-unique-phrase`;
    const r = await turn(t, `My project codename is ${SECRET}.`, `Got it: ${SECRET}.`);
    assert.equal(r.durable, true);
    const rows = await msgRows(t.owner, t.conversationId);
    assert.equal(rows.filter(x => x.data).length, 2, 'both messages are rows');
    const jobs = await jobsOf(t.owner);
    const kinds = jobs.map(j => j.kind).sort();
    assert.deepEqual(kinds, ['learning.mind.v1', 'learning.observe.v1']);
    for (const j of jobs) {
      assert.equal(j.conversation_id, t.conversationId);
      assert.ok(j.source_ref?.userMessageKey && j.source_ref?.assistantMessageKey, 'references the messages');
      assert.ok(!JSON.stringify(j).includes(SECRET), `job ${j.kind} carries user text`);
      assert.equal(j.state, 'queued');
    }
    // The message keys in the job are the rows that were written.
    const keys = new Set(rows.map(x => x.partition_key.split(':').pop()));
    assert.ok(keys.has(jobs[0].source_ref.userMessageKey) && keys.has(jobs[0].source_ref.assistantMessageKey));
  });

  test('a retried enqueue of the same turn creates no duplicate job', async () => {
    const t = await newTurnOwner();
    await turn(t, 'First message.');
    const before = await jobsOf(t.owner);
    const ref = before[0].source_ref;
    const specs = M.learn.turnLearningJobs({ ownerId: t.owner, conversationId: t.conversationId,
      keys: [ref.userMessageKey, ref.assistantMessageKey], turn: ref.turn });
    const client = await pool.connect();
    try { const again = await M.learn.enqueueTurnLearning(client, specs); assert.ok(again.every(j => !j.created)); }
    finally { client.release(); }
    assert.equal((await jobsOf(t.owner)).length, before.length);
  });

  test('if the jobs cannot be written, neither are the messages — and the turn is not acknowledged', async () => {
    const t = await newTurnOwner();
    await turn(t, 'An earlier message that stays.');
    const conv = M.conv.getConversation(t.conversationId);
    const user = M.conv.addMessage(t.conversationId, 'user', 'doomed').at(-1);
    const asst = M.conv.addMessage(t.conversationId, 'assistant', 'doomed answer').at(-1);
    await assert.rejects(M.conv.commitTurnDurably(t.conversationId, [user, asst], async client => {
      await client.query(`SELECT 1`);
      throw new Error('enqueue failed (simulated)');
    }), /enqueue failed/);
    const rows = (await msgRows(t.owner, t.conversationId)).filter(x => x.data);
    assert.equal(rows.length, 2, 'only the earlier turn is persisted');
    assert.ok(!rows.some(x => x.data.includes('doomed')), 'no row of the failed turn');
    assert.ok(!conv.some(m => m.content === 'doomed'), 'removed from memory too');
    assert.equal((await jobsOf(t.owner)).length, 2, 'no job of the failed turn');
    // And it does not linger in the background queue to be written later.
    await M.storage.flushStorage(3000);
    assert.ok(!(await msgRows(t.owner, t.conversationId)).some(x => x.data?.includes('doomed')));
  });

  test('the request path turns a failed durable commit into a retryable error', async () => {
    const t = await newTurnOwner();
    await turn(t, 'hello');
    // Delete the conversation in the database (another instance did it).
    await q(`UPDATE aqua_store_partitions SET data = NULL, deleted_at = now(), version = version + 1
              WHERE store_key = '.aqua-history.json' AND owner_id = $1 AND partition_key = $2`, [t.owner, `c:${t.conversationId}`]);
    let committedMemory = false;
    await assert.rejects(turn(t, 'after deletion', 'x', { commitMemory: () => { committedMemory = true; } }),
      err => err.retryable === true && err.type === 'turn_not_durable');
    assert.equal(committedMemory, false, 'the turn memory was not committed (it will roll back)');
    assert.ok(!(await msgRows(t.owner, t.conversationId)).some(x => x.data?.includes('after deletion')));
  });

  test('reflection waits for the turn\'s ingest (depends_on)', async () => {
    const owner = `user:p3l-dep-${RUN}`;
    await M.queue.enqueue({ ownerId: owner, kind: 'ops.canary.v1', idempotencyKey: 'first', priority: 900, payload: { ms: 0 } });
    await M.queue.enqueue({ ownerId: owner, kind: 'ops.canary.v1', idempotencyKey: 'second', priority: 1, dependsOn: ['first'], payload: { ms: 0 } });
    const a = await M.queue.claim(`dep-${RUN}`, { kinds: ['ops.canary.v1'] });
    // 'second' has the better priority but depends on 'first': 'first' must come out.
    const mine = a?.ownerId === owner ? a : null;
    assert.ok(mine, 'a job of this owner was claimable');
    assert.equal((await q(`SELECT idempotency_key FROM aqua_jobs WHERE job_id = $1`, [mine.jobId]))[0].idempotency_key, 'first');
    await M.queue.complete(mine.jobId, mine.fence);
    const b = await M.queue.claim(`dep-${RUN}`, { kinds: ['ops.canary.v1'] });
    assert.equal((await q(`SELECT idempotency_key FROM aqua_jobs WHERE job_id = $1`, [b.jobId]))[0].idempotency_key, 'second');
    await M.queue.complete(b.jobId, b.fence);
  });

  test('fencing: a worker whose job was reclaimed can neither renew, complete nor fail it', async () => {
    const owner = `user:p3l-fence-${RUN}`;
    await M.queue.enqueue({ ownerId: owner, kind: 'ops.canary.v1', idempotencyKey: 'f', payload: { ms: 0 } });
    const w1 = await M.queue.claim(`w1-${RUN}`, { kinds: ['ops.canary.v1'] });
    assert.equal(w1.ownerId, owner);
    await q(`UPDATE aqua_jobs SET heartbeat_at = now() - interval '1 hour' WHERE job_id = $1`, [w1.jobId]);
    assert.ok(await M.queue.reapStale() >= 1, 'stale heartbeat reclaimed');
    const w2 = await M.queue.claim(`w2-${RUN}`, { kinds: ['ops.canary.v1'] });
    assert.equal(w2.jobId, w1.jobId);
    assert.equal(await M.queue.heartbeat(w1.jobId, w1.fence), false);
    assert.equal(await M.queue.complete(w1.jobId, w1.fence), false);
    assert.equal((await M.queue.fail(w1.jobId, 'late', w1.fence)).state, 'lost');
    assert.equal((await q(`SELECT state, claimed_by FROM aqua_jobs WHERE job_id = $1`, [w1.jobId]))[0].claimed_by, `w2-${RUN}`);
    assert.equal(await M.queue.complete(w2.jobId, w2.fence), true);
  });

  test('concurrent claimers never run two jobs of one owner at once (per-owner exclusivity)', async () => {
    // Reproduces what the multi-worker journey caught: two workers claiming at
    // the same instant each took a different job of the SAME owner.
    const owner = `user:p3l-race-${RUN}`;
    let worst = 0;
    for (let round = 0; round < 15; round++) {
      for (let i = 0; i < 8; i++) {
        await M.queue.enqueue({ ownerId: owner, kind: 'ops.canary.v1', idempotencyKey: `race-${round}-${i}`, payload: { ms: 0 } });
      }
      const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => M.queue.claim(`race-${RUN}-${i}`, { kinds: ['ops.canary.v1'] })));
      const mine = claims.filter(c => c?.ownerId === owner);
      worst = Math.max(worst, mine.length);
      for (const c of claims.filter(Boolean)) await M.queue.complete(c.jobId, c.fence);
      await q(`UPDATE aqua_jobs SET state = 'done' WHERE owner_id = $1 AND state = 'queued'`, [owner]);
    }
    assert.ok(worst <= 1, `${worst} jobs of one owner were claimed concurrently`);
  });

  test('release gives a job back without counting the attempt', async () => {
    const owner = `user:p3l-rel-${RUN}`;
    await M.queue.enqueue({ ownerId: owner, kind: 'ops.canary.v1', idempotencyKey: 'r', payload: { ms: 0 } });
    const j = await M.queue.claim(`rel-${RUN}`, { kinds: ['ops.canary.v1'] });
    assert.equal(j.attempts, 1);
    assert.equal(await M.queue.release(j.jobId, j.fence, { reason: 'shutdown' }), true);
    const [row] = await q(`SELECT state, attempts FROM aqua_jobs WHERE job_id = $1`, [j.jobId]);
    assert.deepEqual([row.state, row.attempts], ['queued', 0]);
    const again = await M.queue.claim(`rel-${RUN}`, { kinds: ['ops.canary.v1'] });
    await M.queue.complete(again.jobId, again.fence);
  });

  test('a long job keeps its claim by heartbeat; recovery does not hand it to a second worker', async () => {
    const owner = `user:p3l-hb-${RUN}`;
    await M.queue.enqueue({ ownerId: owner, kind: 'ops.canary.v1', idempotencyKey: 'hb', payload: { ms: 3000 } });
    const run = drainOwner(owner, { kinds: ['ops.canary.v1'] });
    let reaped = 0;
    for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 300)); reaped += await M.queue.reapStale(); }
    const ran = await run;
    assert.equal(reaped, 0, 'the running job was reclaimed although its worker was alive');
    assert.equal(ran.at(-1)?.ok, true);
    const [row] = await q(`SELECT state, attempts FROM aqua_jobs WHERE owner_id = $1`, [owner]);
    assert.deepEqual([row.state, row.attempts], ['done', 1]);
  });

  test('a job that killed its worker on its last attempt is dead-lettered by recovery, not re-run forever', async () => {
    const owner = `user:p3l-poison-${RUN}`;
    await M.queue.enqueue({ ownerId: owner, kind: 'ops.canary.v1', idempotencyKey: 'p', maxAttempts: 1, payload: { ms: 0 } });
    const j = await M.queue.claim(`poison-${RUN}`, { kinds: ['ops.canary.v1'] });
    assert.equal(j.ownerId, owner);
    await q(`UPDATE aqua_jobs SET heartbeat_at = now() - interval '1 hour' WHERE job_id = $1`, [j.jobId]);
    await M.queue.reapStale();
    const [row] = await q(`SELECT state, last_error FROM aqua_jobs WHERE job_id = $1`, [j.jobId]);
    assert.equal(row.state, 'dead');
    assert.match(row.last_error, /last attempt/);
  });

  test('the worker learns a turn once, even when the job is delivered twice', async () => {
    const t = await newTurnOwner();
    await turn(t, 'I prefer short answers.');
    const ran = await drainOwner(t.owner);
    assert.ok(ran.length >= 2 && ran.every(r => r.ok), JSON.stringify(ran));
    const m1 = await mindRow(t.owner);
    assert.ok(m1, 'the Mind was persisted by the worker');
    assert.equal(JSON.parse(m1.data).turnCount, 1);
    // Duplicate delivery: the same jobs run again (a worker died after writing, before acknowledging).
    await q(`UPDATE aqua_jobs SET state = 'queued', run_after = now() WHERE owner_id = $1`, [t.owner]);
    const again = await drainOwner(t.owner);
    assert.ok(again.every(r => r.ok));
    assert.ok(again.filter(r => r.kind === 'learning.mind.v1').every(r => r.skipped === 'already-applied'));
    const m2 = await mindRow(t.owner);
    assert.equal(JSON.parse(m2.data).turnCount, 1, 'the turn was counted twice');
    assert.equal(Object.keys(JSON.parse(m2.data).appliedTurns ?? {}).filter(k => k.startsWith('twin:')).length, 1);
  });

  test('a turn whose conversation was deleted before the job ran teaches nothing', async () => {
    const t = await newTurnOwner();
    await turn(t, 'I live in Oslo.');
    M.conv.clearConversation(t.conversationId);
    await M.storage.flushStorage(3000);
    const ran = await drainOwner(t.owner);
    assert.ok(ran.every(r => r.ok && r.skipped === 'source-missing'), JSON.stringify(ran));
    const m = await mindRow(t.owner);
    assert.ok(!m || JSON.parse(m.data).turnCount === undefined || JSON.parse(m.data).turnCount === 0);
  });

  test('a job of a deleted account does nothing and writes nothing', async () => {
    const t = await newTurnOwner();
    await turn(t, 'I work at Initech.');
    await M.del.markOwnerDeleted(t.owner);
    const ran = await drainOwner(t.owner);
    assert.ok(ran.length && ran.every(r => r.skipped === 'owner-deleted'));
    assert.equal(await mindRow(t.owner), null);
  });

  test('an account deleted WHILE its job runs gets nothing written back', async () => {
    const t = await newTurnOwner();
    await turn(t, 'My dog is called Biscuit.');
    let release;
    const gate = new Promise(r => { release = r; });
    let entered;
    const entering = new Promise(r => { entered = r; });
    const slow = {
      ...M.rt.HANDLERS,
      'learning.mind.v1': async job => { entered(); await gate; return M.rt.HANDLERS['learning.mind.v1'](job); },
    };
    const run = drainOwner(t.owner, { handlers: slow, kinds: ['learning.mind.v1'] });
    await entering;
    // Account deletion: the marker first, then every partition tombstoned (accountPurge order).
    await M.del.markOwnerDeleted(t.owner);
    await q(`UPDATE aqua_store_partitions SET data = NULL, deleted_at = now(), version = version + 1 WHERE owner_id = $1 AND deleted_at IS NULL`, [t.owner]);
    release();
    await run;
    await M.storage.flushStorage(3000);
    const live = await q(`SELECT store_key FROM aqua_store_partitions WHERE owner_id = $1 AND data IS NOT NULL`, [t.owner]);
    assert.deepEqual(live, [], 'a running job wrote the deleted user\'s data back');
  });

  test('an unreachable database is told apart from a job fault (release, not fail)', () => {
    const un = M.rt.isDatabaseUnavailable;
    for (const e of [{ code: 'ECONNREFUSED' }, { code: '57P01' }, { code: '08006' }, new Error('Connection terminated unexpectedly'),
      new Error('timeout exceeded when trying to connect'), { message: 'the database system is starting up' }]) assert.equal(un(e), true, JSON.stringify(e));
    for (const e of [new Error('boom'), { code: '23505' }, new SyntaxError('Unexpected token'), null]) assert.equal(un(e), false, String(e));
  });

  test('a reference to a message that does not exist reads as nothing', () => {
    assert.equal(M.learn.readTurnText({ conversationId: `none-${RUN}`, userMessageKey: 'k' }), null);
  });

  test('sensitive sentences: the worker sees the redacted text unless the user opted in', async () => {
    const t = await newTurnOwner();
    const msg = 'I was diagnosed with depression last year. I work as a nurse.';
    await turn(t, msg);
    const [j] = (await jobsOf(t.owner)).filter(x => x.kind === 'learning.observe.v1');
    const redacted = M.learn.readTurnText(j.source_ref, { rememberSensitive: false });
    const raw = M.learn.readTurnText(j.source_ref, { rememberSensitive: true });
    assert.ok(!/depression/i.test(redacted.userMessage), redacted.userMessage);
    assert.ok(/nurse/i.test(redacted.userMessage));
    assert.ok(/depression/i.test(raw.userMessage));
    assert.equal(j.payload.rememberSensitive, false);
  });
});
