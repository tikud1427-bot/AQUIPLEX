/**
 * Safety Fix 4 — connection-store fencing and the complete account purge, on
 * the real migrated schema in pg-mem with the REAL lease, the REAL connect
 * service and the REAL store adapters: the memory adapter, and the Mongo
 * adapter driven through a faithful fake mongoose (helpers/fakeMongoose.mjs —
 * the adapter's own conditional filters run; no MongoDB deployment).
 *
 * "Another instance" is modelled with its own lease and fence: the in-process
 * owner lock would otherwise serialise two services of this process. pg-mem
 * does not block on locks: the orderings are proven with separate processes on
 * real PostgreSQL (connectionFencing.live.test.js).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-cfence-'));
for (const k of Object.keys(process.env)) if (/(_API_KEY|^GEMINI|^GOOGLE)/.test(k)) delete process.env[k];
process.env.DATABASE_URL = 'postgresql://u:p@localhost:1/none';   // never dialled: the pool is replaced
process.env.MONGO_URI = '';
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';

let mem, poolMod, L, CS, WF, P, D, FM, registryMod, svcMod, vaultMod, fakeMod;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gate = () => { let open; const wait = new Promise(r => { open = r; }); return { wait, open }; };

before(async () => {
  poolMod = await import('../../core/db/pool.js');
  poolMod._resetForTests();
  const { createMemoryPg } = await import('../../core/tests/helpers/memoryPg.mjs');
  mem = createMemoryPg();
  poolMod._setPoolForTests(mem.pool);
  await (await import('../../core/db/migrate.js')).migrate();
  for (const ix of ['aqua_jobs_ready_ix', 'aqua_jobs_running_owner_ix', 'aqua_jobs_dead_ix', 'aqua_jobs_running_heartbeat_ix']) {
    await mem.pool.query(`DROP INDEX IF EXISTS ${ix}`);
  }
  L = await import('../ownerLease.js');
  CS = await import('../connectionStore.js');
  WF = await import('../../core/storage/writeFence.js');
  P = await import('../connectPurge.js');
  D = await import('../../core/storage/deletedOwners.js');
  FM = await import('./helpers/fakeMongoose.mjs');
  registryMod = await import('../registry.js');
  svcMod = await import('../connectService.js');
  vaultMod = await import('../credentialVault.js');
  fakeMod = await import('../testing/fakeConnector.js');
});
after(async () => { poolMod?._resetForTests(); await mem?.close(); delete process.env.DATABASE_URL; });

let n = 0;
const newOwner = () => `user:u-cf-${process.pid}-${++n}`;
const adapters = {
  memory: () => CS.createMemoryConnectionStore(),
  mongo: () => { const m = FM.createFakeMongoose(); return Object.assign(CS.createMongoConnectionStore({ mongoose: m }), { _fake: m }); },
};
const doc = (owner, id = `conn_${crypto.randomBytes(10).toString('hex')}`) => ({ connectionId: id, ownerId: owner, connectorId: 'fake', sourceId: `fake:${id}`, status: 'active', credentials: null, checkpoint: null });
/** Another instance: its own lease (waits out the previous holder's expiry) and fence. */
async function otherInstance(owner, { ttlMs = 10_000, waitMs = 5_000 } = {}) {
  const l = L.createOwnerLease(owner, { pool: mem.pool, ttlMs });
  await l.acquire({ waitMs });
  return { lease: l, fence: WF.setOwnerFence(owner, { name: l.name, token: l.token, epoch: l.epoch, previousEpoch: l.previousEpoch }) };
}
const cwAs = (fence, owner, fn) => L.serializeConnectionWrite(fence, owner, fn, { pool: mem.pool });

// ── A. the store adapters' conditional writes ────────────────────────────────
for (const [kind, make] of Object.entries(adapters)) {
  describe(`A · ${kind} connection store — epoch/token compare-and-set`, () => {
    test('an OLD epoch never overwrites (or removes) a record a NEWER epoch wrote or stamped', async () => {
      const s = make(); const o = newOwner(); const d = doc(o);
      await s.create(d, { fence: { epoch: 100, token: 'A' } });
      assert.equal(await s.stamp(o, { epoch: 200, token: 'B', previousEpoch: 100 }), 1);
      await s.update(o, d.connectionId, { checkpoint: 'B' }, { fence: { epoch: 200, token: 'B' } });
      await assert.rejects(s.update(o, d.connectionId, { checkpoint: 'A-stale', pendingDeletion: null }, { fence: { epoch: 100, token: 'A' } }), e => e.code === 'FENCE_STALE');
      await assert.rejects(s.remove(o, d.connectionId, { fence: { epoch: 100, token: 'A' } }), e => e.code === 'FENCE_STALE');
      const r = await s.get(o, d.connectionId);
      assert.equal(r.checkpoint, 'B');
      assert.equal(r.fenceEpoch, 200);
    });

    test('same epoch, different token → stale; same epoch and token → allowed', async () => {
      const s = make(); const o = newOwner(); const d = doc(o);
      await s.create(d, { fence: { epoch: 300, token: 'T' } });
      await assert.rejects(s.update(o, d.connectionId, { checkpoint: 'x' }, { fence: { epoch: 300, token: 'other' } }), e => e.code === 'FENCE_STALE');
      assert.equal((await s.update(o, d.connectionId, { checkpoint: 'y' }, { fence: { epoch: 300, token: 'T' } })).checkpoint, 'y');
    });

    test('a missing or malformed epoch/token fails closed (FENCE_INVALID); a record without an epoch is never matched', async () => {
      const s = make(); const o = newOwner(); const d = doc(o);
      for (const bad of [{ epoch: null, token: 'T' }, { epoch: 1.5, token: 'T' }, { epoch: 'x', token: 'T' }, { epoch: 5 }, { epoch: 5, token: '' }, { epoch: -1, token: 'T' }]) {
        await assert.rejects(s.create(doc(o), { fence: bad }), e => e.code === 'FENCE_INVALID', JSON.stringify(bad));
        await assert.rejects(s.update(o, d.connectionId, {}, { fence: bad }), e => e.code === 'FENCE_INVALID');
        await assert.rejects(s.stamp(o, bad), e => e.code === 'FENCE_INVALID');
      }
      await s.create(d);                                   // no epoch at all (unfenced)
      await assert.rejects(s.update(o, d.connectionId, { checkpoint: 'x' }, { fence: { epoch: 9, token: 'T' } }), e => e.code === 'FENCE_STALE');
      assert.equal(await s.stamp(o, { epoch: 9, token: 'T', previousEpoch: 5 }), 0, 'a record without an epoch was adopted by a stamp');
    });

    test('a CREATE of an older operation (after a newer stamp) is refused by the store itself — nothing is written', async () => {
      const s = make(); const o = newOwner();
      const valid = doc(o), late = doc(o);
      await s.create(valid, { fence: { epoch: 100, token: 'prev' } });
      assert.equal(await s.stamp(o, { epoch: 200, token: 'new', previousEpoch: 100 }), 1);
      assert.equal((await s.get(o, valid.connectionId)).fenceEpoch, 200);
      await assert.rejects(s.create(late, { fence: { epoch: 150, token: 'older-op' } }), e => e.code === 'FENCE_STALE');
      assert.equal(await s.countByOwner(o), 1, 'a stale insert was physically written');
      assert.equal(await s.stamp(o, { epoch: 150, token: 'older' }), 0, 'a stamp lowered the epoch');
      await assert.rejects(s.stamp(o, { epoch: 300, token: 'x', previousEpoch: 300 }), e => e.code === 'FENCE_INVALID');
    });

    test('after a PURGE the owner document is a tombstone: any later create (any epoch, unfenced too) writes nothing; purge is idempotent', async () => {
      const s = make(); const o = newOwner();
      await s.create(doc(o), { fence: { epoch: 100, token: 'a' } });
      assert.equal(await s.purgeOwner(o), 1);
      for (const fence of [{ epoch: 99, token: 'old' }, { epoch: 100, token: 'a' }, { epoch: 9_999_999_999_999, token: 'future' }, null]) {
        await assert.rejects(s.create(doc(o), fence ? { fence } : {}), e => e.code === 'OWNER_DELETED', JSON.stringify(fence));
      }
      assert.deepEqual(await s.ownerState(o), { exists: true, deleted: true, connections: 0 });
      assert.equal(await s.countByOwner(o), 0);
      assert.equal(await s.purgeOwner(o), 0, 'a repeated purge found something');
      // an owner that never had a document still gets a tombstone (a delayed FIRST insert is refused too)
      const fresh = newOwner();
      await s.purgeOwner(fresh);
      await assert.rejects(s.create(doc(fresh), { fence: { epoch: 5, token: 't' } }), e => e.code === 'OWNER_DELETED');
      assert.equal(await s.countByOwner(fresh), 0);
    });

    test('stamp / purge / count are per owner', async () => {
      const s = make(); const a = newOwner(), b = newOwner();
      await s.create(doc(a), { fence: { epoch: 10, token: 'a' } });
      await s.create(doc(b), { fence: { epoch: 10, token: 'b' } });
      assert.equal(await s.stamp(a, { epoch: 20, token: 'a2', previousEpoch: 10 }), 1);
      assert.equal((await s.listByOwner(b))[0].fenceEpoch, 10);
      assert.equal(await s.purgeOwner(a), 1);
      assert.equal(await s.countByOwner(a), 0);
      assert.equal(await s.countByOwner(b), 1);
    });

    if (kind === 'mongo') {
      test('every fenced write sends the conditional filter and a server-side time limit', async () => {
        const s = make(); const o = newOwner(); const d = doc(o);
        await s.create(d, { fence: { epoch: 50, token: 'T' } });
        await s.update(o, d.connectionId, { checkpoint: 'c' }, { fence: { epoch: 50, token: 'T' } });
        await s.remove(o, d.connectionId, { fence: { epoch: 50, token: 'T' } });
        // create = conditional upsert, update = conditional findOneAndUpdate, remove = conditional updateOne — all on the OWNER document
        const writes = s._fake.calls.filter(c => c.model === 'AquaConnectionSet' && ['findOneAndUpdate', 'updateOne'].includes(c.op));
        assert.equal(writes.length, 3, JSON.stringify(writes.map(w => w.op)));
        for (const w of writes) {
          assert.equal(w.filter._id, o);
          assert.deepEqual(w.filter.deleted, { $ne: true }, 'a write does not respect the purge tombstone');
          assert.deepEqual(w.filter.$or, [{ fenceEpoch: { $lt: 50 } }, { fenceEpoch: 50, fenceToken: 'T' }], JSON.stringify(w.filter));
          assert.ok(w.options.maxTimeMS > 0);
        }
        assert.equal(writes[0].options.upsert, true, 'create is not an upsert on the owner document');
      });
    }
  });
}

// ── B. the connect service and the cross-store serialisation ─────────────────
function service({ store, world = fakeMod.createFakeWorld(), connector = null, lease = {}, singleInstance = false } = {}) {
  const registry = registryMod.createConnectorRegistry({ allowTestOnly: true });
  registry.register(connector ?? fakeMod.createFakeConnector({ world }));
  return svcMod.createConnectService({ registry, store, vault: vaultMod.createCredentialVault({ key: TEST_KEY }),
    retry: { sleep: async () => {}, baseMs: 0 }, log: { log() {}, warn() {} }, trustRawUserId: true, singleInstance,
    lease: { pool: mem.pool, ttlMs: 10_000, ...lease } });
}
const uidOf = owner => owner.slice(5);
const TEST_KEY = crypto.randomBytes(32);   // one credential key: every service of this file is the same platform

describe('B · connect service — connection writes ordered with lease acquisition', () => {
  test('the memory store is REFUSED for multi-instance operation (a database is configured) unless explicitly single-instance', async () => {
    const o = newOwner();
    await assert.rejects(service({ store: CS.createMemoryConnectionStore() }).connect({ userId: uidOf(o), connectorId: 'fake', input: { account: 'a', code: 'ok' } }),
      e => e.code === 'STORE_NOT_DISTRIBUTED');
    const ok = await service({ store: adapters.mongo() }).connect({ userId: uidOf(o), connectorId: 'fake', input: { account: 'a', code: 'ok' } });
    assert.equal(ok.status, 'active');
  });

  test('every operation STAMPS first: records carry its epoch and token; epochs strictly increase', async () => {
    const store = adapters.mongo(); const o = newOwner();
    const svc = service({ store });
    const c = await svc.connect({ userId: uidOf(o), connectorId: 'fake', input: { account: 'a', code: 'ok' } });
    const e1 = (await store.get(o, c.connectionId)).fenceEpoch;
    await svc.sync({ userId: uidOf(o), connectionId: c.connectionId, mode: 'full' });
    const e2 = (await store.get(o, c.connectionId)).fenceEpoch;
    assert.ok(Number.isSafeInteger(e1) && e2 > e1, `epochs ${e1} → ${e2}`);
  });

  test('a token REFRESH completing after a newer acquisition is refused; the newer state (revoked) stays', async () => {
    const store = adapters.mongo(); const o = newOwner();
    const world = fakeMod.createFakeWorld({ tokenTtlMs: 1000 });   // always "expiring": every sync refreshes
    const g = gate(); let refreshing = false;
    const base = fakeMod.createFakeConnector({ world });
    const connector = { ...base, refresh: async creds => { refreshing = true; await g.wait; return base.refresh(creds); } };
    world.put('acct', 'r1', { name: 'r1.md', content: 'x 1.' });
    const svc = service({ store, connector, lease: { ttlMs: 1000, renewEveryMs: 0 } });
    const c = await svc.connect({ userId: uidOf(o), connectorId: 'fake', input: { account: 'acct', code: 'ok' } });
    const syncP = svc.sync({ userId: uidOf(o), connectionId: c.connectionId, mode: 'full' }).then(() => 'ok', e => e.code);
    while (!refreshing) await sleep(10);
    await sleep(1200);                                     // A's lease expires mid-refresh
    const B = await otherInstance(o);                      // another instance revokes
    await cwAs(B.fence, o, f => store.stamp(o, f));
    await cwAs(B.fence, o, f => store.update(o, c.connectionId, { credentials: null, credentialsExpireAt: null, status: 'revoked' }, { fence: f }));
    await B.lease.release();
    g.open();
    assert.equal(await syncP, 'LEASE_LOST');
    const r = await store.get(o, c.connectionId);
    assert.equal(r.credentials, null, 'a stale refresh wrote credentials back after the revocation');
    assert.equal(r.status, 'revoked');
  });

  test('a stale sync\'s final patch (checkpoint, cursor, pendingDeletion, syncCount) never overwrites a newer operation\'s', async () => {
    const store = adapters.mongo(); const o = newOwner();
    const world = fakeMod.createFakeWorld();
    world.put('acct', 'r1', { name: 'r1.md', content: 'x 1.' });
    const base = fakeMod.createFakeConnector({ world });
    let stalled = false;
    const connector = { ...base, fetchResource: async (...a) => { if (!stalled) { stalled = true; await sleep(1500); } return base.fetchResource(...a); } };
    const svc = service({ store, connector, lease: { ttlMs: 1000, renewEveryMs: 0 } });
    const c = await svc.connect({ userId: uidOf(o), connectorId: 'fake', input: { account: 'acct', code: 'ok' } });
    const syncP = svc.sync({ userId: uidOf(o), connectionId: c.connectionId, mode: 'full' }).then(() => 'ok', e => e.code);
    while (!stalled) await sleep(10);
    await sleep(1100);
    const B = await otherInstance(o);
    await cwAs(B.fence, o, f => store.stamp(o, f));
    const newer = { checkpoint: { cursor: 'B' }, fullSync: { cursor: 'B-list' }, pendingDeletion: { count: 9, held: 9, origin: 'B' }, syncCount: 42 };
    await cwAs(B.fence, o, f => store.update(o, c.connectionId, newer, { fence: f }));
    await B.lease.release();
    assert.equal(await syncP, 'LEASE_LOST');
    const r = await store.get(o, c.connectionId);
    for (const [k, v] of Object.entries(newer)) assert.deepEqual(r[k], v, `${k} was overwritten by the stale sync`);
  });

  test('an old write delivered LATE (bypassing the database check) is rejected by the store itself', async () => {
    const store = adapters.mongo(); const o = newOwner();
    const A = await otherInstance(o, { ttlMs: 1000 });
    const d = doc(o);
    await cwAs(A.fence, o, f => store.create(d, { fence: f }));
    await sleep(1100);
    const B = await otherInstance(o);
    await cwAs(B.fence, o, f => store.stamp(o, f));
    // A's request arrives at the store only now (it passed its database check long ago).
    await assert.rejects(store.update(o, d.connectionId, { pendingDeletion: null, checkpoint: 'late' }, { fence: { epoch: A.fence.epoch, token: A.fence.token } }), e => e.code === 'FENCE_STALE');
    await assert.rejects(cwAs(A.fence, o, f => store.update(o, d.connectionId, { checkpoint: 'late' }, { fence: f })), e => e.code === 'LEASE_LOST');
    assert.equal((await store.get(o, d.connectionId)).checkpoint, null);
    await B.lease.release();
  });

  test('the DATABASE check alone refuses an old write when the newer holder has not stamped yet (the store would still accept it)', async () => {
    const store = adapters.mongo(); const o = newOwner();
    const A = await otherInstance(o, { ttlMs: 1000 });
    const d = doc(o);
    await cwAs(A.fence, o, f => store.create(d, { fence: f }));
    await sleep(1100);
    const B = await otherInstance(o);                      // acquired — but has NOT stamped the records yet
    await assert.rejects(cwAs(A.fence, o, f => store.update(o, d.connectionId, { checkpoint: 'stale' }, { fence: f })), e => e.code === 'LEASE_LOST');
    assert.equal((await store.get(o, d.connectionId)).checkpoint, null, 'an old write landed in the window before the newer stamp');
    await B.lease.release();
  });

  test('the DATABASE check alone refuses a connection write of a deleted account while the old lease is still live', async () => {
    const store = adapters.mongo(); const o = newOwner();
    const A = await otherInstance(o, { ttlMs: 10_000 });
    const d = doc(o);
    await cwAs(A.fence, o, f => store.create(d, { fence: f }));
    await D.markOwnerDeleted(o, { pool: mem.pool });       // no purge yet: the lease row still names A, live
    await assert.rejects(cwAs(A.fence, o, f => store.update(o, d.connectionId, { credentials: { refreshed: true } }, { fence: f })), e => e.code === 'OWNER_DELETED');
    // The refusal above lost A's fence for good: any later write of A fails closed before the store.
    await assert.rejects(cwAs(A.fence, o, f => store.create(doc(o), { fence: f })), e => ['OWNER_DELETED', 'LEASE_LOST'].includes(e.code));
    assert.equal(await store.countByOwner(o), 1);
    assert.equal((await store.get(o, d.connectionId)).credentials, null);
    await A.lease.release();
  });

  test('a connection write without a fence (or with a malformed one) fails closed', async () => {
    await assert.rejects(L.serializeConnectionWrite(null, 'user:x', async () => 1, { pool: mem.pool }), e => e.code === 'CONNECTION_FENCE_MISSING');
    await assert.rejects(L.serializeConnectionWrite({ name: 'n', token: 't', epoch: null }, 'user:x', async () => 1, { pool: mem.pool }), e => e.code === 'CONNECTION_FENCE_MISSING');
  });

  test('a LATE INSERT of an older operation (delivered after a newer stamp) is refused by the store: nothing at rest, views unchanged', async () => {
    const store = adapters.mongo(); const o = newOwner();
    const svc = service({ store });
    const c = await svc.connect({ userId: uidOf(o), connectorId: 'fake', input: { account: 'a', code: 'ok' } });
    const current = (await store.get(o, c.connectionId)).fenceEpoch;
    const late = doc(o);
    await assert.rejects(store.create(late, { fence: { epoch: current - 1, token: 'old-op' } }), e => e.code === 'FENCE_STALE');
    assert.equal(await store.countByOwner(o), 1, 'a stale insert is at rest');
    const listed = await svc.listConnections({ userId: uidOf(o) });
    assert.deepEqual(listed.map(x => x.connectionId), [c.connectionId]);
  });
});

// ── C. the complete account purge ────────────────────────────────────────────
describe('C · account purge of connector-owned state', () => {
  async function seededOwner(store, { connector = null } = {}) {
    const o = newOwner();
    const svc = service({ store, connector });
    const c = await svc.connect({ userId: uidOf(o), connectorId: 'fake', input: { account: 'a', code: 'ok' } });
    await mem.pool.query(`INSERT INTO aqua_external_deletions (owner_id, uko_prefix, deleted_at) VALUES ($1, 'ext_x_', now())`, [o]).catch(() => {});
    return { o, svc, c };
  }
  const tableCount = async (sql, o) => Number((await mem.pool.query(sql, [o])).rows[0].n);

  test('purge removes connections (credentials, cursors, pendingDeletion), connector metadata and finally the lease; repeated purge is idempotent; the marker stays', async () => {
    const store = adapters.mongo();
    const { o, c } = await seededOwner(store);
    await store.update(o, c.connectionId, { fullSync: { cursor: 'x' }, pendingDeletion: { count: 1 } }, { fence: { epoch: (await store.get(o, c.connectionId)).fenceEpoch, token: (await store.get(o, c.connectionId)).fenceToken } });
    await D.markOwnerDeleted(o, { pool: mem.pool });
    const r1 = await P.purgeConnectorState(o, { stores: [store], pool: mem.pool });
    assert.equal(r1.complete, true, JSON.stringify(r1));
    assert.equal(r1.removed.connections, 1);
    assert.equal(r1.removed.lease, true);
    assert.equal(await store.countByOwner(o), 0);
    assert.equal(await tableCount('SELECT count(*)::int AS n FROM aqua_scheduler_leases WHERE name = $1', L.connectLeaseName(o)), 0);
    assert.equal(await tableCount('SELECT count(*)::int AS n FROM aqua_deleted_owners WHERE owner_id = $1', o), 1, 'the marker must stay');
    const r2 = await P.purgeConnectorState(o, { stores: [store], pool: mem.pool });
    assert.equal(r2.complete, true);
    assert.equal(r2.removed.connections, 0);
    await assert.rejects(L.createOwnerLease(o, { pool: mem.pool }).acquire({ waitMs: 0 }), e => e.code === 'OWNER_DELETED');
  });

  test('purge refuses without the deletion marker; a deleted owner can never connect again', async () => {
    const store = adapters.mongo();
    const { o } = await seededOwner(store);
    await assert.rejects(P.purgeConnectorState(o, { stores: [store], pool: mem.pool }), e => e.code === 'PURGE_NOT_MARKED');
    await D.markOwnerDeleted(o, { pool: mem.pool });
    await P.purgeConnectorState(o, { stores: [store], pool: mem.pool });
    await assert.rejects(service({ store }).connect({ userId: uidOf(o), connectorId: 'fake', input: { account: 'a', code: 'ok' } }), e => e.code === 'OWNER_DELETED');
    assert.equal(await store.countByOwner(o), 0, 'a connection was re-created after the account deletion');
  });

  test('purge racing an ACTIVE operation: the purge takes over; the operation can no longer write its connection', async () => {
    const store = adapters.mongo();
    const world = fakeMod.createFakeWorld();
    world.put('a', 'r1', { name: 'r1.md', content: 'x 1.' });
    const base = fakeMod.createFakeConnector({ world });
    const g = gate(); let inFetch = false;
    const connector = { ...base, fetchResource: async (...a) => { inFetch = true; await g.wait; return base.fetchResource(...a); } };
    const { o, c } = await seededOwner(store, { connector });
    const svc = service({ store, connector });          // a long lease, renewing: the operation is LIVE
    const syncP = svc.sync({ userId: uidOf(o), connectionId: c.connectionId, mode: 'full' }).then(() => 'ok', e => e.code);
    for (let i = 0; !inFetch && i < 300; i++) await sleep(10);
    assert.equal(inFetch, true, 'precondition: the sync is running (inside its fetch)');
    await D.markOwnerDeleted(o, { pool: mem.pool });
    const r = await P.purgeConnectorState(o, { stores: [store], pool: mem.pool, waitMs: 2000 });
    assert.equal(r.complete, true, JSON.stringify(r));
    g.open();
    assert.ok(['LEASE_LOST', 'OWNER_DELETED'].includes(await syncP), 'the running operation still reported success');
    assert.equal(await store.countByOwner(o), 0, 'the running operation re-created its connection after the purge');
  });

  test('a stale CONNECT (credential exchange in flight) cannot create a connection after the account was deleted', async () => {
    const store = adapters.mongo(); const o = newOwner();
    const world = fakeMod.createFakeWorld();
    const base = fakeMod.createFakeConnector({ world });
    const g = gate(); let exchanging = false;
    const connector = { ...base, connect: async input => { exchanging = true; await g.wait; return base.connect(input); } };
    const svc = service({ store, connector });
    const connectP = svc.connect({ userId: uidOf(o), connectorId: 'fake', input: { account: 'a', code: 'ok' } }).then(() => 'ok', e => e.code);
    while (!exchanging) await sleep(10);
    await D.markOwnerDeleted(o, { pool: mem.pool });
    assert.equal((await P.purgeConnectorState(o, { stores: [store], pool: mem.pool, waitMs: 2000 })).complete, true);
    g.open();
    assert.ok(['LEASE_LOST', 'OWNER_DELETED'].includes(await connectP));
    assert.equal(await store.countByOwner(o), 0);
  });

  test('owner isolation: another owner\'s connections, lease and records are untouched', async () => {
    const store = adapters.mongo();
    const a = await seededOwner(store), b = await seededOwner(store);
    await D.markOwnerDeleted(a.o, { pool: mem.pool });
    await P.purgeConnectorState(a.o, { stores: [store], pool: mem.pool });
    assert.equal(await store.countByOwner(b.o), 1);
    assert.equal(await tableCount('SELECT count(*)::int AS n FROM aqua_scheduler_leases WHERE name = $1', L.connectLeaseName(b.o)), 1);
    assert.equal((await b.svc.listConnections({ userId: uidOf(b.o) })).length, 1);
  });

  test('the lease is deleted only at the FINAL stage: a store that cannot be cleared leaves the lease (and reports incomplete)', async () => {
    const store = adapters.mongo();
    const { o } = await seededOwner(store);
    await D.markOwnerDeleted(o, { pool: mem.pool });
    const stuck = { ...store, purgeOwner: async () => 0 };   // a store that does not delete
    const r = await P.purgeConnectorState(o, { stores: [stuck], pool: mem.pool });
    assert.equal(r.complete, false);
    assert.equal(r.remaining.connections, 1);
    assert.equal(r.removed.lease, false);
    assert.equal(await tableCount('SELECT count(*)::int AS n FROM aqua_scheduler_leases WHERE name = $1', L.connectLeaseName(o)), 1, 'the lease was deleted before the cleanup completed');
    assert.equal((await P.purgeConnectorState(o, { stores: [store], pool: mem.pool })).complete, true, 'a retry did not finish the purge');
  });

  test('verification is PHYSICAL: a purge that removes the records but leaves no tombstone is reported incomplete (the lease stays)', async () => {
    const store = adapters.mongo();
    const { o } = await seededOwner(store);
    await D.markOwnerDeleted(o, { pool: mem.pool });
    const Set = store._fake.models.AquaConnectionSet;
    // A store whose purge deletes the owner document outright: zero records, but nothing refuses a delayed insert.
    const noTombstone = { ...store, purgeOwner: async owner => { const before = await store.countByOwner(owner); await Set.deleteOne({ _id: owner }); return before; } };
    const r = await P.purgeConnectorState(o, { stores: [noTombstone], pool: mem.pool });
    assert.equal(r.remaining.connections, 0);
    assert.equal(r.remaining.tombstoneMissing, 1);
    assert.equal(r.complete, false, 'a purge without a tombstone was reported complete');
    assert.equal(r.removed.lease, false);
    assert.equal((await P.purgeConnectorState(o, { stores: [store], pool: mem.pool })).complete, true, 'a retry with the real store did not complete');
    assert.deepEqual(await store.ownerState(o), { exists: true, deleted: true, connections: 0 });
  });

  test('account purge (purgeOwnerData) includes the connector state and reports it', async () => {
    const store = adapters.mongo();
    const { o } = await seededOwner(store);
    const { purgeOwnerData } = await import('../../account/accountPurge.js');
    const report = await purgeOwnerData({ userId: uidOf(o) });
    assert.equal(report.connectors?.complete, true, JSON.stringify(report.connectors ?? report.errors));
    assert.equal(await store.countByOwner(o), 0);
  });
});
