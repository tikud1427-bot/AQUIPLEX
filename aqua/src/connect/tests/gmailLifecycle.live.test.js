/**
 * Gmail Phase 1 on a REAL PostgreSQL — the mock Gmail connector through the
 * production connect path in multi-instance mode (owner lease + fence on real
 * advisory locks, the Mongo connection-store adapter over the fake mongoose):
 *
 *   GL1  full sync → incremental → expired history (full fallback): classes,
 *        positions and stored set; nothing enqueued; nothing embedded.
 *   GL2  a source deletion committed by ANOTHER connection while the sync is
 *        fetching: the import batch is refused (real deletion records).
 *   GL3  disconnect → every Gmail object gone; account purge → connection
 *        tombstoned, credentials/cursors gone, owner rows and lease row gone,
 *        no reconnect.
 *   GL4  no Gmail text in any database row of these owners.
 *
 * Skips visibly without AQUA_TEST_DATABASE_URL. REFUSES to run unless the
 * server is localhost:55432/aqua_test — checked in before(), before any write.
 * Fake owners only (user:u-gmlive-*); exactly their rows are removed in after().
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const DB_URL = process.env.DATABASE_URL ?? '';
const K = await import('./testkit.js');                  // isolated data dir, offline embedder, env stripped
if (DB_URL) process.env.DATABASE_URL = DB_URL;
process.env.AQUA_E6 = 'on';
process.env.AQUA_EMBEDDINGS = 'off';

const { isConfigured, getPool, closePool } = await import('../../core/db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

let X, US, ident, G, M, F, FM, p, purgeOwnerData, leaseName;
const OWNERS = [];
const embedded = [];

before(async () => {
  if (!LIVE) return;
  p = await getPool();
  const id = (await p.query(`select current_database() db`)).rows[0];
  const u = new URL(DB_URL);
  if (id.db !== 'aqua_test' || u.port !== '55432' || !['localhost', '127.0.0.1'].includes(u.hostname)) {
    throw new Error(`refusing to run: target is ${u.hostname}:${u.port}/${id.db}`);
  }
  X = K.external;
  X.__setExternalUnderstandingForTests(true);              // even with understanding ON, Gmail is never enqueued
  US = await import('../../files/ukoStore.js');
  ident = await import('../../files/externalIdentity.js');
  G = await import('../gmail/gmailConnector.js');
  M = await import('../testing/mockGmailTransport.js');
  F = await import('../testing/gmailFixtures.js');
  FM = await import('./helpers/fakeMongoose.mjs');
  ({ purgeOwnerData } = await import('../../account/accountPurge.js'));
  ({ connectLeaseName: leaseName } = await import('../ownerLease.js'));
  (await import('../../embeddings/embeddingProvider.js')).__setEmbedderForTests(async t => { embedded.push(...t); return t.map(() => [1, 0, 0]); });
});
after(async () => {
  if (!LIVE) return;
  X?.__setExternalUnderstandingForTests(false);
  const wm = await import('../../core/worldModel/worldModelRepository.js');
  const cr = await import('../../core/claims/claimRepository.js');
  for (const o of OWNERS) {
    if (!o.startsWith('user:u-gmlive-')) continue;          // never anything but this suite's fake owners
    await wm.purgeOwner(o); await cr.purgeOwner(o); await wm.purgeOwnerEntities(o);
    for (const t of ['aqua_jobs', 'aqua_external_deletions', 'aqua_deleted_owners']) await p.query(`DELETE FROM ${t} WHERE owner_id = $1`, [o]);
    try { await p.query('DELETE FROM aqua_owner_versions WHERE owner_id = $1', [o]); } catch { /* table absent */ }
    await p.query('DELETE FROM aqua_scheduler_leases WHERE name = $1', [leaseName(o)]);
  }
  await closePool();
});

const store = () => K.createMongoConnectionStore({ mongoose: FM.createFakeMongoose() });
async function gmailUser({ wrap = c => c } = {}) {
  const mock = M.createMockGmailService({ now: () => Date.now() });
  F.loadFixtureMailbox(mock);
  const registry = K.createConnectorRegistry({ allowTestOnly: true });
  registry.register(wrap(G.createGmailConnector({ transport: mock.transport, pageSize: 4 })));
  const st = store();
  const service = K.createConnectService({ registry, store: st, vault: K.createCredentialVault({ key: K.TEST_KEY }),
    retry: { sleep: async () => {}, baseMs: 0 }, log: { log() {}, warn() {} }, trustRawUserId: true, lease: { ttlMs: 10_000 } });
  const userId = K.freshUser('gmlive');
  const ownerId = K.ownerOf(userId);
  OWNERS.push(ownerId);
  const conn = await service.connect({ userId, connectorId: 'gmail', input: { code: mock.authorizeCode(F.FIXTURE_ACCOUNT) } });
  const sourceId = `gmail:${conn.connectionId}`;
  return { mock, service, store: st, userId, ownerId, sourceId, connectionId: conn.connectionId,
    sync: (mode = 'auto') => service.sync({ userId, connectionId: conn.connectionId, mode }),
    held: () => X.listExternalResources(ownerId, sourceId).map(r => r.externalId).sort(),
    docs: () => US.listUKOsByPrefix(ownerId, ident.sourcePrefixes(sourceId).ukoPrefix, { includeRestricted: true }),
    record: () => st.get(ownerId, conn.connectionId) };
}
const inScope = () => F.IN_SCOPE_IDS.map(id => `msg:${id}`).sort();
const count = async (sql, args) => Number((await p.query(sql, args)).rows[0].n);

describe('Gmail Phase 1 · live (aqua_test)', { skip }, () => {
  test('GL1 · full → incremental → expired history: class, positions, stored set; no enqueue, no embedding', async () => {
    const s = await gmailUser();
    const before = s.mock.historyIdOf(F.FIXTURE_ACCOUNT);
    const r1 = await s.sync('full');
    assert.equal(r1.lastSync.state, 'succeeded', JSON.stringify(r1.lastSync));
    assert.deepEqual(s.held(), inScope());
    assert.deepEqual((await s.record()).checkpoint, { historyId: before });
    const EG = await import('../../core/egressGuard.js');
    await EG.runWithDataClass('user', async () => { for (const u of s.docs()) assert.equal(US.dataClassOfUko(u), 'external:gmail'); });
    s.mock.relabel(F.FIXTURE_ACCOUNT, '18c0000000000004', { add: ['STARRED'] });
    s.mock.deleteMessage(F.FIXTURE_ACCOUNT, '18c0000000000007');
    const r2 = await s.sync('auto');
    assert.deepEqual([r2.lastSync.mode, r2.lastSync.state, r2.lastSync.counts.updated, r2.lastSync.counts.removed], ['incremental', 'succeeded', 1, 1]);
    s.mock.expireHistory(F.FIXTURE_ACCOUNT);
    s.mock.deleteMessage(F.FIXTURE_ACCOUNT, '18c0000000000003');
    const r3 = await s.sync('auto');
    assert.deepEqual([r3.lastSync.mode, r3.lastSync.state, r3.lastSync.counts.removed], ['full', 'succeeded', 1]);
    assert.equal(s.held().length, F.IN_SCOPE_IDS.length - 2);
    assert.equal(await count(`SELECT count(*)::int AS n FROM aqua_jobs WHERE owner_id = $1`, [s.ownerId]), 0, 'Gmail content was enqueued for understanding');
    assert.ok(!embedded.some(t => F.CANARIES.some(c => t.includes(c))), 'Gmail text reached the embedder');
  });

  test('GL2 · a deletion committed by another connection while the sync fetches: nothing is imported', async () => {
    let fired = false;
    const holder = {};
    const s = await gmailUser({ wrap: c => ({ ...c, fetchResource: async (...a) => {
      if (holder.armed && !fired) { fired = true; await X.deleteExternalSource(holder.ownerId, holder.sourceId); }
      return c.fetchResource(...a);
    } }) });
    Object.assign(holder, { ownerId: s.ownerId, sourceId: s.sourceId });
    await s.sync('full');
    s.mock.relabel(F.FIXTURE_ACCOUNT, '18c0000000000001', { add: ['STARRED'] });
    s.mock.addMessage(F.FIXTURE_ACCOUNT, F.buildMessage({ id: '18c0000000000103', threadId: 't', date: 'Mon, 12 Jan 2026 09:00:00 +0000', headers: { From: 'z@x.example.test' }, text: 'CANARY_H1 late' }));
    holder.armed = true;
    const r = await s.sync('auto');
    assert.ok(fired);
    assert.ok(r.lastSync.counts.rejected >= 2, JSON.stringify(r.lastSync.counts));
    assert.deepEqual(s.held(), []);
    assert.ok(await count(`SELECT count(*)::int AS n FROM aqua_external_deletions WHERE owner_id = $1`, [s.ownerId]) > 0, 'the deletion left no durable record');
  });

  test('GL3 · disconnect removes every Gmail object; account purge removes connection, credentials, cursors, owner rows and the lease row; no reconnect', async () => {
    const s = await gmailUser();
    await s.sync('full');
    const d = await s.service.disconnect({ userId: s.userId, connectionId: s.connectionId });
    assert.deepEqual([d.deleted, d.knowledgeRemoved, d.providerRevocation], [true, true, 'revoked']);
    assert.deepEqual(s.held(), []);

    const s2 = await gmailUser();
    await s2.sync('full');
    assert.ok((await s2.record()).credentials);
    const report = await purgeOwnerData({ userId: s2.userId });
    assert.equal(report.connectors?.complete, true, JSON.stringify(report.connectors ?? report.errors));
    assert.deepEqual(s2.held(), []);
    assert.equal(await s2.store.countByOwner(s2.ownerId), 0);
    assert.equal((await s2.store.ownerState(s2.ownerId)).deleted, true);
    for (const t of ['aqua_jobs', 'aqua_external_deletions']) assert.equal(await count(`SELECT count(*)::int AS n FROM ${t} WHERE owner_id = $1`, [s2.ownerId]), 0, t);
    assert.equal(await count('SELECT count(*)::int AS n FROM aqua_scheduler_leases WHERE name = $1', [leaseName(s2.ownerId)]), 0, 'lease row');
    assert.equal(await count('SELECT count(*)::int AS n FROM aqua_deleted_owners WHERE owner_id = $1', [s2.ownerId]), 1, 'the deletion marker must stay');
    await assert.rejects(s2.service.connect({ userId: s2.userId, connectorId: 'gmail', input: { code: s2.mock.authorizeCode(F.FIXTURE_ACCOUNT) } }), e => e.code === 'OWNER_DELETED');
    assert.equal(await s2.store.countByOwner(s2.ownerId), 0);
  });

  test('GL4 · no Gmail text in any database row of these owners', async () => {
    const tables = (await p.query(`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'owner_id'`)).rows.map(r => r.table_name);
    assert.ok(tables.length > 3);
    const tokens = [...F.CANARIES, 'CANARY_H1'];
    for (const t of new Set(tables)) {
      const rows = (await p.query(`SELECT * FROM "${t.replace(/"/g, '""')}" WHERE owner_id::text = ANY($1::text[])`, [OWNERS])).rows;
      const text = JSON.stringify(rows);
      assert.ok(!tokens.some(c => text.includes(c)), `Gmail content in ${t}`);
    }
  });
});
