/**
 * Gmail Phase 2 — the durable sync job on the REAL job queue (aqua_test).
 *
 *   enqueueSync (productionDeps) → aqua_jobs row (owner = principal's, idempotent per minute)
 *   → workerRuntime.runOneJob (real claim, heartbeat, owner checks, complete)
 *   → connect.sync.v1 → connectService.sync under the owner's connect LEASE (Postgres)
 *   → the external-source lifecycle.
 * The connect service is the test's own (mock Gmail, in-memory connection store
 * marked singleInstance); only the job's kind is claimed. Rows of this test's
 * owners are removed at the end (jobs, lease rows; the source via disconnect).
 * Skipped without AQUA_TEST_DATABASE_URL.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const LIVE_DB = String(process.env.DATABASE_URL ?? '').trim();
const K = await import('./testkit.js');               // strips DATABASE_URL …
if (LIVE_DB) process.env.DATABASE_URL = LIVE_DB;        // … this file runs against the runner's test database
const skip = LIVE_DB ? false : 'needs the test Postgres (AQUA_TEST_DATABASE_URL)';

const { createGmailConnector } = await import('../gmail/gmailConnector.js');
const { createMockGmailService } = await import('../testing/mockGmailTransport.js');
const F = await import('../testing/gmailFixtures.js');
const { principalForServerJob } = await import('../principal.js');
const { enqueueSync, CONNECT_SYNC_JOB_KIND } = await import('../productionDeps.js');
const { runConnectSyncJob } = await import('../syncJob.js');

const owners = [];
let pool = null;
after(async () => {
  if (!LIVE_DB) return;
  const { getPool } = await import('../../core/db/pool.js');
  pool = await getPool();
  const { connectLeaseName } = await import('../ownerLease.js');
  for (const o of owners) {
    await pool.query('DELETE FROM aqua_jobs WHERE owner_id = $1', [o]);
    await pool.query('DELETE FROM aqua_scheduler_leases WHERE name = $1', [connectLeaseName(o)]);
  }
});

describe('Gmail Phase 2 · connect.sync.v1 on the real job queue', { skip }, () => {
  test('enqueue (idempotent per minute) → claim → run under the lease → done; a paused connection is a completed no-op', async () => {
    const W = await import('../../core/jobs/workerRuntime.js');
    const { getPool } = await import('../../core/db/pool.js');
    const p = await getPool();
    const mock = createMockGmailService({ now: Date.now });
    const registry = K.createConnectorRegistry({ allowTestOnly: true });
    registry.register(createGmailConnector({ transport: mock.transport, pageSize: 2 }));
    const store = K.createMemoryConnectionStore();
    const service = K.createConnectService({ registry, store, vault: K.createCredentialVault({ key: K.TEST_KEY }), log: { log() {}, warn() {} }, retry: { sleep: async () => {}, baseMs: 0 }, singleInstance: true });
    const user = `p2job-${crypto.randomBytes(5).toString('hex')}`;
    const owner = `user:${user}`;
    owners.push(owner);
    const principal = principalForServerJob(user);
    const acct = `${user}@example.test`;
    for (const id of ['18e0000000000001', '18e0000000000002', '18e0000000000003']) {
      mock.addMessage(acct, F.buildMessage({ id, threadId: 't', date: 'Mon, 5 Jan 2026 10:00:00 +0000', headers: { From: 'x@example.test', To: acct, Subject: 's', 'Message-ID': `<${id}@x>` }, text: `job body ${id}` }));
    }
    const conn = await service.connect({ principal, connectorId: 'gmail', input: { code: mock.authorizeCode(acct) } });

    const now = Date.now();
    const e1 = await enqueueSync({ ownerId: owner, connectionId: conn.connectionId, now });
    const e2 = await enqueueSync({ ownerId: owner, connectionId: conn.connectionId, now });
    assert.equal(e1.created, true);
    assert.deepEqual(e2, { jobId: e1.jobId, created: false }, 'a second request in the same minute is the same job');
    const row = (await p.query('SELECT owner_id, kind, payload, state FROM aqua_jobs WHERE job_id = $1', [e1.jobId])).rows[0];
    assert.deepEqual({ owner: row.owner_id, kind: row.kind, state: row.state }, { owner, kind: CONNECT_SYNC_JOB_KIND, state: 'queued' });
    assert.deepEqual(Object.keys(row.payload).sort(), ['confirmMassDeletion', 'connectionId', 'mode'], 'the payload carries no owner and no content');

    const handlers = { [CONNECT_SYNC_JOB_KIND]: job => runConnectSyncJob(job, { getDeps: async () => ({ service }) }) };
    const r = await W.runOneJob(`p2-test-${process.pid}`, { kinds: [CONNECT_SYNC_JOB_KIND], handlers });
    assert.equal(r?.jobId, e1.jobId);
    assert.equal(r.ok, true);
    assert.equal((await p.query('SELECT state FROM aqua_jobs WHERE job_id = $1', [e1.jobId])).rows[0].state, 'done');
    const synced = await service.getConnection({ principal, connectionId: conn.connectionId });
    assert.equal(synced.lastSync.state, 'succeeded');
    assert.equal(K.external.listExternalResources(owner, `gmail:${conn.connectionId}`).length, 3);

    await service.pauseSync({ principal, connectionId: conn.connectionId });
    const e3 = await enqueueSync({ ownerId: owner, connectionId: conn.connectionId, mode: 'full', now });
    const r2 = await W.runOneJob(`p2-test-${process.pid}`, { kinds: [CONNECT_SYNC_JOB_KIND], handlers });
    assert.equal(r2?.jobId, e3.jobId);
    assert.equal((await p.query('SELECT state FROM aqua_jobs WHERE job_id = $1', [e3.jobId])).rows[0].state, 'done', 'a paused connection: completed as a no-op, not retried');
    assert.equal((await service.getConnection({ principal, connectionId: conn.connectionId })).syncCount, 1, 'no second sync ran');

    await service.resumeSync({ principal, connectionId: conn.connectionId });
    const d = await service.disconnect({ principal, connectionId: conn.connectionId });
    assert.equal(d.deleted, true);
  });
});
