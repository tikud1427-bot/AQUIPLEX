/**
 * Owner-partitioned repository, against a REAL Postgres (Phase 2a).
 *
 * Skipped, loudly, without DATABASE_URL (the runner maps AQUA_TEST_DATABASE_URL
 * to it). pg-mem is not used here on purpose: its ON CONFLICT DO NOTHING
 * RETURNING differs from Postgres (E3/PR-9), and that clause is the insert guard.
 *
 * "Two instances" = two pg Pools with two repositories, i.e. two caches and
 * two connection sets. That is what two Cloud Run instances are.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  createPartitionRepository, PartitionConflictError, PartitionOwnershipError, UnreadWriteError, TABLE,
} from '../storage/partitionRepository.js';

const LIVE = Boolean(process.env.DATABASE_URL);
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';

const RUN = crypto.randomBytes(4).toString('hex');
const store = name => `.test-${RUN}-${name}.json`;
let pg, poolA, poolB, admin;

before(async () => {
  if (!LIVE) return;
  pg = (await import('pg')).default;
  const mk = () => new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  poolA = mk(); poolB = mk(); admin = mk();
  await (await import('../db/migrate.js')).migrate();
});

after(async () => {
  if (!LIVE) return;
  await admin.query(`DELETE FROM ${TABLE} WHERE store_key LIKE $1`, [`.test-${RUN}-%`]);
  await Promise.all([poolA.end(), poolB.end(), admin.end()]);
  await (await import('../db/pool.js')).closePool();   // the pool migrate() opened
});

const repos = () => [createPartitionRepository({ pool: poolA, instanceId: 'A' }), createPartitionRepository({ pool: poolB, instanceId: 'B' })];

describe('partition repository — two instances, against Postgres', { skip }, () => {
  test('a stale write is refused, not silently applied (no lost update)', async () => {
    const [A, B] = repos();
    const S = store('cas');
    await A.get(S, 'o:user:1');
    await A.put(S, 'o:user:1', '{"v":1}', { ownerId: 'user:1' });
    await B.get(S, 'o:user:1');                       // B reads version 1
    await A.update(S, 'o:user:1', () => '{"v":2}', { ownerId: 'user:1' });   // A moves it to 2
    await assert.rejects(B.put(S, 'o:user:1', '{"v":"B"}', { ownerId: 'user:1' }), PartitionConflictError);
    const final = await admin.query(`SELECT data, version FROM ${TABLE} WHERE store_key=$1 AND partition_key=$2`, [S, 'o:user:1']);
    assert.equal(final.rows[0].data, '{"v":2}');
    assert.equal(Number(final.rows[0].version), 2);
  });

  test('concurrent read-modify-write from two instances: every increment lands', async () => {
    const [A, B] = repos();
    const S = store('counter');
    const inc = text => JSON.stringify({ n: (text ? JSON.parse(text).n : 0) + 1 });
    const N = 40;
    await Promise.all([
      ...Array.from({ length: N }, () => A.update(S, 'o:user:hot', inc, { ownerId: 'user:hot', maxAttempts: 200 })),
      ...Array.from({ length: N }, () => B.update(S, 'o:user:hot', inc, { ownerId: 'user:hot', maxAttempts: 200 })),
    ]);
    const { rows } = await admin.query(`SELECT data, version FROM ${TABLE} WHERE store_key=$1 AND partition_key='o:user:hot'`, [S]);
    assert.equal(JSON.parse(rows[0].data).n, 2 * N, 'lost updates under contention');
    assert.equal(Number(rows[0].version), 2 * N);
    assert.ok(A.stats().retries + B.stats().retries > 0, 'the test must actually contend');
  });

  test('a blind write (never read) is refused', async () => {
    const [A] = repos();
    await assert.rejects(A.put(store('blind'), 'o:user:1', '{}', { ownerId: 'user:1' }), UnreadWriteError);
  });

  test('two instances creating the same partition: exactly one insert wins', async () => {
    const [A, B] = repos();
    const S = store('create');
    await Promise.all([A.get(S, 'o:user:1'), B.get(S, 'o:user:1')]);
    const r = await Promise.allSettled([
      A.put(S, 'o:user:1', '{"by":"A"}', { ownerId: 'user:1' }),
      B.put(S, 'o:user:1', '{"by":"B"}', { ownerId: 'user:1' }),
    ]);
    assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
    assert.ok(r.find(x => x.status === 'rejected').reason instanceof PartitionConflictError);
  });
});

describe('partition repository — write shape', { skip }, () => {
  test('one owner\'s update writes that owner\'s bytes, whatever the owner count', async () => {
    const measure = async (owners) => {
      const S = store(`shape-${owners}`);
      const [A] = repos();
      // Seed directly: the shape under test is the UPDATE, not the seeding.
      const values = Array.from({ length: owners }, (_, i) => `('${S}','o:user:${i}','user:${i}',${i},'{"facts":["f${i}"]}',20,'x',1)`);
      for (let i = 0; i < values.length; i += 1000) {
        await admin.query(`INSERT INTO ${TABLE} (store_key,partition_key,owner_id,ordinal,data,bytes,checksum,version) VALUES ${values.slice(i, i + 1000).join(',')}`);
      }
      await A.get(S, 'o:user:7');
      const before = A.stats().bytesWritten;
      await A.update(S, 'o:user:7', () => '{"facts":["changed"]}', { ownerId: 'user:7' });
      const others = await admin.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE store_key=$1 AND version > 1`, [S]);
      return { bytes: A.stats().bytesWritten - before, rowsTouched: others.rows[0].n };
    };
    const small = await measure(100);
    const large = await measure(5000);
    assert.equal(small.bytes, large.bytes, 'bytes per one-owner write must not grow with owners');
    assert.equal(large.rowsTouched, 1, 'exactly one row changed');
  });
});

describe('partition repository — tombstones', { skip }, () => {
  test('a writer holding a pre-deletion version cannot resurrect deleted data', async () => {
    const [A, B] = repos();
    const S = store('tomb');
    await A.get(S, 'o:user:1');
    await A.put(S, 'o:user:1', '{"secret":1}', { ownerId: 'user:1' });
    await B.get(S, 'o:user:1');                                   // B holds version 1
    await A.delete(S, 'o:user:1', { ownerId: 'user:1' });          // tombstone, version 2
    await assert.rejects(B.put(S, 'o:user:1', '{"secret":1}', { ownerId: 'user:1' }), PartitionConflictError);
    const { rows } = await admin.query(`SELECT data, deleted_at FROM ${TABLE} WHERE store_key=$1`, [S]);
    assert.equal(rows[0].data, null);
    assert.ok(rows[0].deleted_at);
  });

  test('a writer that never saw the row cannot insert over a tombstone', async () => {
    const [A, B] = repos();
    const S = store('tomb2');
    await A.get(S, 'o:user:1');
    await A.delete(S, 'o:user:1', { ownerId: 'user:1' });          // tombstone for an absent row
    await assert.rejects(B.put(S, 'o:user:1', '{}', { ownerId: 'user:1', expectedVersion: 0 }), PartitionConflictError);
  });

  test('re-creating after deletion is possible only by a writer that has seen the tombstone', async () => {
    const [A, B] = repos();
    const S = store('tomb3');
    await A.get(S, 'o:user:1');
    await A.put(S, 'o:user:1', '{"a":1}', { ownerId: 'user:1' });
    await A.delete(S, 'o:user:1', { ownerId: 'user:1' });
    const seen = await B.get(S, 'o:user:1');
    assert.equal(seen.deleted, true);
    assert.equal(seen.data, null);
    const r = await B.update(S, 'o:user:1', (cur, meta) => (meta.deleted ? '{"said again":true}' : undefined), { ownerId: 'user:1' });
    assert.equal(r.changed, true);
    assert.equal((await A.get(S, 'o:user:1', { fresh: true })).data, '{"said again":true}');
  });
});

describe('partition repository — owner isolation', { skip }, () => {
  test('a write cannot move a partition to another owner', async () => {
    const [A] = repos();
    const S = store('iso');
    await A.get(S, 'o:user:1');
    await A.put(S, 'o:user:1', '{"mine":1}', { ownerId: 'user:1' });
    await assert.rejects(A.put(S, 'o:user:1', '{"theirs":1}', { ownerId: 'user:2' }), PartitionOwnershipError);
    await assert.rejects(A.put(S, 'o:user:1', '{"theirs":1}', { ownerId: 'user:2', expectedVersion: 0 }), PartitionOwnershipError);
  });

  test('a read naming an owner refuses a partition that belongs to someone else', async () => {
    const [A, B] = repos();
    const S = store('iso2');
    await A.get(S, 'o:user:1');
    await A.put(S, 'o:user:1', '{"mine":1}', { ownerId: 'user:1' });
    await assert.rejects(B.get(S, 'o:user:1', { ownerId: 'user:2' }), PartitionOwnershipError);
    await assert.rejects(A.get(S, 'o:user:1', { ownerId: 'user:2' }), PartitionOwnershipError, 'the cache must enforce it too');
  });

  test('loadOwner returns only that owner\'s partitions, across stores', async () => {
    const [A, B] = repos();
    const S1 = store('lo1'); const S2 = store('lo2');
    for (const [s, k, o] of [[S1, 'o:user:1', 'user:1'], [S2, 'c:c1', 'user:1'], [S1, 'o:user:2', 'user:2']]) {
      await A.get(s, k); await A.put(s, k, JSON.stringify({ o }), { ownerId: o });
    }
    const got = await B.loadOwner('user:1', { stores: [S1, S2] });
    assert.deepEqual([...got.keys()].sort(), [S1, S2].sort());
    for (const m of got.values()) for (const v of m.values()) assert.equal(JSON.parse(v.data).o, 'user:1');
    assert.equal(got.get(S1).has('o:user:2'), false);
  });

  test('purgeOwner removes one owner\'s content in every store and nobody else\'s', async () => {
    const [A] = repos();
    const S1 = store('pg1'); const S2 = store('pg2');
    for (const [s, k, o] of [[S1, 'o:user:del', 'user:del'], [S2, 'c:x', 'user:del'], [S1, 'o:user:keep', 'user:keep']]) {
      await A.get(s, k); await A.put(s, k, '{"x":1}', { ownerId: o });
    }
    const r = await A.purgeOwner('user:del');
    assert.ok(r.tombstoned >= 2);
    const { rows } = await admin.query(`SELECT owner_id, data FROM ${TABLE} WHERE store_key = ANY($1)`, [[S1, S2]]);
    for (const row of rows) {
      if (row.owner_id === 'user:del') assert.equal(row.data, null);
      else assert.equal(row.data, '{"x":1}');
    }
    await assert.rejects(A.purgeOwner(''), /owner id is required/);
  });
});

describe('partition repository — cache', { skip }, () => {
  test('the cache stays within its bound and reads stay correct after eviction', async () => {
    const A = createPartitionRepository({ pool: poolA, instanceId: 'A', maxEntries: 10 });
    const S = store('lru');
    for (let i = 0; i < 30; i++) { await A.get(S, `o:user:${i}`); await A.put(S, `o:user:${i}`, JSON.stringify({ i }), { ownerId: `user:${i}` }); }
    assert.ok(A.cacheInfo().entries <= 10);
    assert.ok(A.stats().evictions >= 20);
    assert.equal(JSON.parse((await A.get(S, 'o:user:0')).data).i, 0, 'an evicted partition is re-read, not lost');
  });

  test('refreshOwner drops what another instance changed', async () => {
    const [A, B] = repos();
    const S = store('refresh');
    await A.get(S, 'o:user:1'); await A.put(S, 'o:user:1', '{"v":1}', { ownerId: 'user:1' });
    await B.loadOwner('user:1', { stores: [S] });
    await A.update(S, 'o:user:1', () => '{"v":2}', { ownerId: 'user:1' });
    assert.equal((await B.get(S, 'o:user:1')).data, '{"v":1}', 'B is stale until it refreshes');
    const r = await B.refreshOwner('user:1');
    assert.equal(r.stale, 1);
    assert.equal((await B.get(S, 'o:user:1')).data, '{"v":2}');
  });
});

describe('partition repository — transactions', { skip }, () => {
  test('transact is all or nothing: one conflicting op writes nothing', async () => {
    const [A, B] = repos();
    const S = store('tx');
    await A.get(S, 'o:user:1'); await A.put(S, 'o:user:1', '{"v":1}', { ownerId: 'user:1' });
    await B.get(S, 'o:user:1'); await B.update(S, 'o:user:1', () => '{"v":2}', { ownerId: 'user:1' });
    await A.get(S, 'o:user:2');
    await assert.rejects(A.transact([
      { storeKey: S, partitionKey: 'o:user:2', ownerId: 'user:2', data: '{"new":1}' },
      { storeKey: S, partitionKey: 'o:user:1', ownerId: 'user:1', data: '{"stale":1}' },   // A holds version 1
    ]), PartitionConflictError);
    const { rows } = await admin.query(`SELECT partition_key FROM ${TABLE} WHERE store_key=$1 AND partition_key='o:user:2'`, [S]);
    assert.equal(rows.length, 0, 'the first op was rolled back');
  });
});
