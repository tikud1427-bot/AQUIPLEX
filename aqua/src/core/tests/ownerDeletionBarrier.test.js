/**
 * Account deletion as a DATABASE barrier (core/storage/deletedOwners.js
 * assertOwnerLive + the partitionRepository statement predicate), on the real
 * migrated schema in pg-mem, through the REAL repository, store bindings,
 * request durability and connect lease.
 *
 * The marker is inserted with plain SQL — as ANOTHER INSTANCE would — so this
 * process's isOwnerDeleted cache still says "not deleted": the barrier must
 * refuse anyway. pg-mem does not block on advisory locks; the ordering of a
 * racing writer against markOwnerDeleted is proven on real PostgreSQL with two
 * Node processes (ownerDeletionBarrier.live.test.js).
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-barrier-'));
process.env.AQUA_DATA_DIR = TMP;
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
const envBefore = process.env.DATABASE_URL;

let mem, poolMod, WF, L, R, OB, RW, D, repo;
const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:1/none';   // never dialled: pool injected
  poolMod = await import('../db/pool.js');
  poolMod._resetForTests();
  const { createMemoryPg } = await import('./helpers/memoryPg.mjs');
  mem = createMemoryPg();
  poolMod._setPoolForTests(mem.pool);
  await (await import('../db/migrate.js')).migrate();
  WF = await import('../storage/writeFence.js');
  L = await import('../../connect/ownerLease.js');
  R = await import('../storage/partitionRepository.js');
  OB = await import('../storage/ownerBinding.js');
  RW = await import('../storage/requestWrites.js');
  D = await import('../storage/deletedOwners.js');
  repo = R.createPartitionRepository({ pool: mem.pool });
  OB._setRepositoryForTests(repo);
});
after(async () => {
  poolMod?._resetForTests();
  await mem?.close();
  if (envBefore === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = envBefore;
});
beforeEach(() => { WF._resetWriteFencesForTests(); D._resetDeletedOwnersForTests(); });

let n = 0;
const owner = () => `user:barrier-${process.pid}-${++n}`;
const S0 = '.aqua-barrier-direct.json';
const row = async (store, pk) => (await mem.pool.query('SELECT data, version, deleted_at FROM aqua_store_partitions WHERE store_key = $1 AND partition_key = $2', [store, pk])).rows[0] ?? null;
/** Another instance deletes the account: the marker only (this process's cache is untouched). */
const deletedElsewhere = o => mem.pool.query('INSERT INTO aqua_deleted_owners (owner_id) VALUES ($1)', [o]);
const isDeleted = e => e?.code === 'OWNER_DELETED' && e.retryable === false;

function ownerStore(storeKey) {
  const map = new Map();
  const binding = OB.bindOwnerStore({
    storeKey, file: path.join(TMP, storeKey), mode: 'on',
    encode: o => (map.has(o) ? map.get(o) : undefined), decode: x => x,
    install: (o, v) => { if (v === null) map.delete(o); else map.set(o, v); },
    merge: (ours, theirs) => ({ ...theirs, ...ours }), changedAt: x => x?.t ?? 0,
  });
  return { map, binding, set: (o, v) => { map.set(o, v); binding.markDirty(o); }, del: o => { map.delete(o); binding.markDeleted(o); } };
}

describe('account deletion — the statement and transaction barrier (repository)', () => {
  test('a stale negative cache does not let a write through (the database decides)', async () => {
    const o = owner();
    assert.equal(await D.isOwnerDeleted(o), false);                       // cached: "not deleted"
    await deletedElsewhere(o);
    assert.equal(await D.isOwnerDeleted(o), false, 'precondition: the cache is stale');
    await assert.rejects(repo.put(S0, `o:${o}`, '{"x":1}', { ownerId: o, expectedVersion: 0 }), isDeleted);
    assert.equal(await row(S0, `o:${o}`), null);
  });

  test('UPDATE: an existing row is never overwritten after the account was deleted', async () => {
    const o = owner();
    const { version } = await repo.put(S0, `o:${o}`, '{"v":"before"}', { ownerId: o, expectedVersion: 0 });
    await deletedElsewhere(o);
    await assert.rejects(repo.put(S0, `o:${o}`, '{"v":"after"}', { ownerId: o, expectedVersion: version }), isDeleted);
    const r = await row(S0, `o:${o}`);
    assert.equal(r.data, '{"v":"before"}');
    assert.equal(Number(r.version), version);
  });

  test('INSERT: no new row is created after the account was deleted (child rows and multi-row transactions too)', async () => {
    const o = owner();
    await repo.put(S0, `c:${o}`, '{"h":1}', { ownerId: o, expectedVersion: 0 });   // a live parent
    await deletedElsewhere(o);
    await assert.rejects(repo.put(S0, `new:${o}`, '{"x":1}', { ownerId: o, expectedVersion: 0 }), isDeleted);
    await assert.rejects(repo.insertChild({ storeKey: S0, parentKey: `c:${o}`, partitionKey: `m:${o}:1`, data: '{"m":1}', ownerId: o }), isDeleted);
    await assert.rejects(repo.insertChildrenTx({ storeKey: S0, parentKey: `c:${o}`, ownerId: o, children: [{ partitionKey: `m:${o}:2`, data: '{"m":2}' }] }), isDeleted);
    await assert.rejects(repo.transact([{ storeKey: S0, partitionKey: `t:${o}`, ownerId: o, data: '{"t":1}', expectedVersion: 0 }]), isDeleted);
    for (const k of [`new:${o}`, `m:${o}:1`, `m:${o}:2`, `t:${o}`]) assert.equal(await row(S0, k), null, k);
  });

  test('a multi-row child transaction (no statement predicate of its own) is refused by the in-transaction check alone', async () => {
    const o = owner();
    await repo.put(S0, `c2:${o}`, '{"h":1}', { ownerId: o, expectedVersion: 0 });
    await deletedElsewhere(o);                             // nothing in this process has seen the deletion
    await assert.rejects(repo.insertChildrenTx({ storeKey: S0, parentKey: `c2:${o}`, ownerId: o, children: [{ partitionKey: `m2:${o}:1`, data: '{"m":1}' }] }), isDeleted);
    assert.equal(await row(S0, `m2:${o}:1`), null);
  });

  test('deletions still land for a deleted owner (they are the purge)', async () => {
    const o = owner();
    const a = await repo.put(S0, `d1:${o}`, '{"a":1}', { ownerId: o, expectedVersion: 0 });
    const t = await repo.put(S0, `t1:${o}`, '{"t":1}', { ownerId: o, expectedVersion: 0 });
    await deletedElsewhere(o);
    await repo.delete(S0, `d1:${o}`, { ownerId: o, expectedVersion: a.version });
    await repo.transact([{ storeKey: S0, partitionKey: `t1:${o}`, ownerId: o, data: null, expectedVersion: t.version }]);
    // (prefix / group tombstones use left()/length(), absent from pg-mem: proven on real PostgreSQL)
    for (const k of [`d1:${o}`, `t1:${o}`]) assert.notEqual((await row(S0, k)).deleted_at, null, k);
  });

  test('other owners are unaffected', async () => {
    const gone = owner(), live = owner();
    await deletedElsewhere(gone);
    await assert.rejects(repo.put(S0, `o:${gone}`, '{"x":1}', { ownerId: gone, expectedVersion: 0 }), isDeleted);
    await repo.put(S0, `o:${live}`, '{"x":2}', { ownerId: live, expectedVersion: 0 });
    assert.equal((await row(S0, `o:${live}`)).data, '{"x":2}');
    await repo.put('.aqua-barrier-global.json', 'g:1', '{"global":true}', { ownerId: '', expectedVersion: 0 });   // ownerless: not owner data
  });

  test('conversation-level tombstone recreation still works for a live owner', async () => {
    const o = owner();
    const S = '.aqua-barrier-conv.json';
    await repo.put(S, `c:${o}:conv1`, '{"title":"old"}', { ownerId: o, expectedVersion: 0 });
    await repo.update(S, `c:${o}:conv1`, () => null, { ownerId: o });                 // the conversation is deleted
    assert.notEqual((await row(S, `c:${o}:conv1`)).deleted_at, null);
    const r = await repo.update(S, `c:${o}:conv1`, (cur, meta) => (meta.deleted ? '{"title":"recreated"}' : undefined), { ownerId: o });
    assert.equal(r.changed, true);
    const after = await row(S, `c:${o}:conv1`);
    assert.equal(after.data, '{"title":"recreated"}');
    assert.equal(after.deleted_at, null);
  });

  test('…and the same recreation is refused once the ACCOUNT is deleted', async () => {
    const o = owner();
    const S = '.aqua-barrier-conv2.json';
    await repo.put(S, `c:${o}:conv1`, '{"title":"old"}', { ownerId: o, expectedVersion: 0 });
    await repo.update(S, `c:${o}:conv1`, () => null, { ownerId: o });
    await deletedElsewhere(o);
    await assert.rejects(repo.update(S, `c:${o}:conv1`, (cur, meta) => (meta.deleted ? '{"title":"recreated"}' : undefined), { ownerId: o }), isDeleted);
    assert.notEqual((await row(S, `c:${o}:conv1`)).deleted_at, null);
  });

  test('markOwnerDeleted records the marker and makes every later write fail fast', async () => {
    const o = owner();
    assert.equal(await D.markOwnerDeleted(o, { pool: mem.pool }), true);
    assert.equal((await mem.pool.query('SELECT 1 FROM aqua_deleted_owners WHERE owner_id = $1', [o])).rows.length, 1);
    await assert.rejects(repo.put(S0, `o:${o}`, '{"x":1}', { ownerId: o, expectedVersion: 0 }), isDeleted);
  });
});

describe('account deletion vs. connect leases and fences', () => {
  test('an ACTIVE fencing lease does not bypass the deletion (refused as OWNER_DELETED, not written)', async () => {
    const o = owner();
    const lease = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 5000 });
    await lease.acquire({ waitMs: 0 });
    WF.setOwnerFence(o, { name: lease.name, token: lease.token });
    await repo.put(S0, `f:${o}`, '{"f":"held"}', { ownerId: o, expectedVersion: 0 });   // valid while live
    await deletedElsewhere(o);
    await assert.rejects(repo.put(S0, `f2:${o}`, '{"f":"after"}', { ownerId: o, expectedVersion: 0 }), isDeleted);
    assert.equal(await row(S0, `f2:${o}`), null);
    assert.equal(await lease.verify(), true, 'the lease itself is untouched — the write was refused by the deletion');
    await lease.release();
  });

  test('a NEW lease acquisition for a deleted owner is refused (OWNER_DELETED); the operation never runs', async () => {
    const o = owner();
    await deletedElsewhere(o);
    await assert.rejects(L.createOwnerLease(o, { pool: mem.pool }).acquire({ waitMs: 0 }), e => e.code === 'OWNER_DELETED');
    let ran = false;
    await assert.rejects(L.withConnectLease(o, async () => { ran = true; }, { pool: mem.pool, waitMs: 0 }), e => e.code === 'OWNER_DELETED');
    assert.equal(ran, false);
    assert.equal((await mem.pool.query('SELECT 1 FROM aqua_scheduler_leases WHERE name = $1', [L.connectLeaseName(o)])).rows.length, 0);
  });

  test('an ENDED operation\'s late work cannot write after the deletion; the write is discarded, not retried', async () => {
    const S = ownerStore('.aqua-barrier-trail.json');
    const o = owner();
    let fence, release; const g = new Promise(r => { release = r; }); let late;
    // Detached work the operation started (Safety Fix 3: it carries the operation's fence).
    await L.withConnectLease(o, async ({ fence: f }) => { fence = f; late = (async () => { await g; S.set(o, { t: Date.now(), data: 'late derived write after the account deletion' }); })(); }, { pool: mem.pool, ttlMs: 5000 });
    assert.equal(fence.ended, true);
    await deletedElsewhere(o);
    const before = S.binding.status().retries;
    release(); await late;
    await assert.rejects(S.binding.flushOnly(new Set([o])), isDeleted);
    assert.equal(await row('.aqua-barrier-trail.json', `o:${o}`), null);
    assert.equal(S.binding.isDirty(o), false, 'an OWNER_DELETED write is back in the retry queue');
    await sleep(700);                                       // past the first retry backoff
    assert.equal(S.binding.status().retries, before, 'an ordinary retry was scheduled');
    assert.equal(await row('.aqua-barrier-trail.json', `o:${o}`), null);
  });
});

describe('account deletion in the store bindings and request durability', () => {
  test('debounced flush: the deleted owner is discarded with OWNER_DELETED; another owner in the same flush lands; no retry', async () => {
    const S = ownerStore('.aqua-barrier-flush.json');
    const gone = owner(), live = owner();
    await D.isOwnerDeleted(gone);                          // stale negative cache in this process
    await deletedElsewhere(gone);
    const before = S.binding.status().retries;
    S.set(gone, { t: Date.now(), data: 'stale' });
    S.set(live, { t: Date.now(), data: 'fine' });
    await S.binding.flush();
    assert.equal(await row('.aqua-barrier-flush.json', `o:${gone}`), null);
    assert.equal(JSON.parse((await row('.aqua-barrier-flush.json', `o:${live}`)).data).data, 'fine');
    assert.equal(S.binding.isDirty(gone), false);
    assert.equal(S.binding.status().retries, before);
    await assert.rejects(S.binding.flushOnly(new Set([gone])), isDeleted, 'the discard is reported to a waiting caller');
  });

  test('a request whose writes were refused gets an explicit, non-retryable OWNER_DELETED', async () => {
    const S = ownerStore('.aqua-barrier-req.json');
    const o = owner();
    await D.isOwnerDeleted(o);
    await deletedElsewhere(o);
    await RW.runWithWriteScope(async () => {
      S.set(o, { t: Date.now(), data: 'request-write' });
      await assert.rejects(RW.flushScopeStrict(), isDeleted);
    });
    assert.equal(await row('.aqua-barrier-req.json', `o:${o}`), null);
  });

  test('a purge\'s pending deletion stays a pure tombstone even when the store re-created the entry locally', async () => {
    const S = ownerStore('.aqua-barrier-purge.json');
    const o = owner();
    S.set(o, { t: Date.now(), data: 'before the purge' });
    await S.binding.flush();
    await D.markOwnerDeleted(o, { pool: mem.pool });
    S.del(o);                                              // purge: markDeleted
    S.set(o, { t: Date.now() + 10, data: 'touched after the purge' });   // a late local re-creation
    await S.binding.flush();
    const r = await row('.aqua-barrier-purge.json', `o:${o}`);
    assert.notEqual(r.deleted_at, null, 'the purge tombstone did not land');
    assert.equal(r.data, null);
  });

  test('a live owner\'s own delete-then-recreate in a store still re-creates (conversation-style recovery)', async () => {
    const S = ownerStore('.aqua-barrier-recreate.json');
    const o = owner();
    S.set(o, { t: Date.now(), data: 'v1' });
    await S.binding.flush();
    S.del(o);
    S.set(o, { t: Date.now() + 10, data: 'v2 after own delete' });
    await S.binding.flush();
    assert.equal(JSON.parse((await row('.aqua-barrier-recreate.json', `o:${o}`)).data).data, 'v2 after own delete');
  });
});
