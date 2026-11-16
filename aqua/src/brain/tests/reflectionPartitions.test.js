/**
 * Reflection store on owner partitions (scalability Phase 2b, step 1).
 *
 * Every multi-process case runs REAL child processes (helpers/storeProcess.mjs):
 * one plays the server (raises a revision: markSurfaced), one the worker
 * (reflects: saveReflectionState). Each has its own disk, pool and memory.
 * Against the disposable test Postgres; skipped loudly without one.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runProcess, tempDir, acquireStoreKeyLock } from '../../core/tests/helpers/multiProcess.mjs';
import {
  mergeReflectionRecords, reflectionChangedAt, encodeReflectionRecord, decodeReflectionRecord,
} from '../reflectionV2/reflectionStore.js';

const LIVE = Boolean(process.env.DATABASE_URL);
let releaseLock = null;
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';
const KEY = '.aqua-reflection.json';
let pool;

const rows = async owner => (await pool.query(
  'SELECT partition_key, owner_id, data, version, deleted_at FROM aqua_store_partitions WHERE store_key = $1 AND partition_key = $2',
  [KEY, `o:${owner}`])).rows;
const snap = (ids, takenAt) => ({ nodes: ids.map(id => [id, { label: id.toUpperCase(), kind: 'entity' }]), edges: [], takenAt });
const ON = 'reflection:on';

before(async () => {
  if (!LIVE) return;
  releaseLock = await acquireStoreKeyLock();
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  await (await import('../../core/db/migrate.js')).migrate();
});
beforeEach(async () => { if (LIVE) await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = $1', [KEY]); });
after(async () => {
  if (!LIVE) return;
  try {
  await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = $1', [KEY]);
  await pool.end();
  await (await import('../../core/db/pool.js')).closePool();
  } finally { await releaseLock?.(); }
});

/** Seed one marker row so `on` is not refused as "never migrated". */
const seedMigrated = () => pool.query(
  `INSERT INTO aqua_store_partitions (store_key, partition_key, owner_id, data, bytes, checksum, version)
   VALUES ($1, '~rest', '', '{"envelope":true,"sections":["o"],"doc":{"__aqua":{"schema":1,"savedAt":0},"data":{}}}', 0, 'x', 1)
   ON CONFLICT DO NOTHING`, [KEY]);

describe('reflection merge — pure', () => {
  const a = { snapshot: { nodes: { 'ent:1': {} }, edges: {}, takenAt: 5000 }, lastReflectionAt: 5000, lastSurfacedAt: 0 };
  const b = { snapshot: null, lastReflectionAt: 0, lastSurfacedAt: 7000 };
  const c = { snapshot: { nodes: { 'ent:9': {} }, edges: {}, takenAt: 6000 }, lastReflectionAt: 6000, lastSurfacedAt: 6500 };

  test('keeps the newer reflection AND the larger surfaced watermark', () => {
    assert.deepEqual(mergeReflectionRecords(a, b), { snapshot: a.snapshot, lastReflectionAt: 5000, lastSurfacedAt: 7000 });
  });
  test('commutative, idempotent and associative (order of arrival does not matter)', () => {
    for (const [x, y] of [[a, b], [a, c], [b, c]]) assert.deepEqual(mergeReflectionRecords(x, y), mergeReflectionRecords(y, x));
    for (const x of [a, b, c]) assert.deepEqual(mergeReflectionRecords(x, x), mergeReflectionRecords(x, x));
    assert.deepEqual(mergeReflectionRecords(mergeReflectionRecords(a, b), c), mergeReflectionRecords(a, mergeReflectionRecords(b, c)));
  });
  test('a snapshot never travels without its own reflection time', () => {
    const m = mergeReflectionRecords(a, c);
    assert.equal(m.lastReflectionAt, 6000);
    assert.deepEqual(Object.keys(m.snapshot.nodes), ['ent:9']);
  });
  test('FIX: a reflection no longer resets the surfaced watermark (it re-raised revisions)', async () => {
    const r = await runProcess({ dataDir: tempDir('aq-fix-'), database: false }, [
      { op: 'call', module: 'reflection', fn: 'markSurfaced', args: ['user:w', 7000] },
      { op: 'call', module: 'reflection', fn: 'saveReflectionState', args: ['user:w', snap(['ent:1'], 8000), 8000] },
      { op: 'call', module: 'reflection', fn: 'loadSurfacedAt', args: ['user:w'] },
    ]);
    assert.equal(r[2], 7000);
  });

  test('encode/decode round-trips with stable node ids', () => {
    const rec = decodeReflectionRecord(a);
    assert.deepEqual(encodeReflectionRecord(rec), a);
    assert.equal(reflectionChangedAt(c), 6500);
  });
});

describe('reflection store on partitions — real processes, real Postgres', { skip }, () => {
  test('server and worker change one owner from stale loads: BOTH changes survive', async () => {
    await seedMigrated();
    const bar = tempDir('aq-bar-');
    const owner = 'user:both';
    const worker = runProcess({ dataDir: tempDir('aq-w-'), partitions: ON }, [
      { op: 'boot' }, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'loaded', n: 2 },
      { op: 'call', module: 'reflection', fn: 'saveReflectionState', args: [owner, snap(['ent:1', 'ent:2'], 5000), 5000] },
      { op: 'flush' },
      { op: 'barrier', dir: bar, name: 'flushed', n: 2 }, { op: 'load', owner },
      { op: 'call', module: 'reflection', fn: 'loadSurfacedAt', args: [owner] },
    ]);
    const server = runProcess({ dataDir: tempDir('aq-s-'), partitions: ON }, [
      { op: 'boot' }, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'loaded', n: 2 },
      { op: 'call', module: 'reflection', fn: 'markSurfaced', args: [owner, 7000] },
      { op: 'flush' },
      { op: 'barrier', dir: bar, name: 'flushed', n: 2 }, { op: 'load', owner },
      { op: 'call', module: 'reflection', fn: 'loadWatermark', args: [owner] },
    ]);
    const [w, s] = await Promise.all([worker, server]);
    const [row] = await rows(owner);
    const data = JSON.parse(row.data);
    assert.deepEqual(Object.keys(data.snapshot.nodes), ['ent:1', 'ent:2'], 'the worker\'s reflection survived');
    assert.equal(data.lastReflectionAt, 5000);
    assert.equal(data.lastSurfacedAt, 7000, 'the server\'s watermark survived');
    assert.equal(w.at(-1), 7000, 'the worker sees the server\'s change after reloading');
    assert.equal(s.at(-1), 5000, 'the server sees the worker\'s change after reloading');
    assert.equal(row.owner_id, owner);
  });

  test('baseline: the same race on the whole-file JSON path loses one side (what the binding fixes)', async () => {
    const shared = tempDir('aq-shared-');
    const bar = tempDir('aq-bar-');
    const owner = 'user:both';
    const [w, s] = await Promise.all([
      runProcess({ dataDir: shared, database: false }, [
        { op: 'barrier', dir: bar, name: 'go', n: 2 },
        { op: 'call', module: 'reflection', fn: 'saveReflectionState', args: [owner, snap(['ent:1'], 5000), 5000] },
      ]),
      runProcess({ dataDir: shared, database: false }, [
        { op: 'barrier', dir: bar, name: 'go', n: 2 },
        { op: 'call', module: 'reflection', fn: 'markSurfaced', args: [owner, 7000] },
      ]),
    ]);
    assert.ok(w && s);
    const file = JSON.parse(fs.readFileSync(path.join(shared, KEY), 'utf8')).data[owner];
    const kept = (file.lastReflectionAt === 5000 ? 1 : 0) + (file.lastSurfacedAt === 7000 ? 1 : 0);
    assert.equal(kept, 1, `whole-file last-writer-wins keeps exactly one side: ${JSON.stringify(file)}`);
  });

  test('idempotent retry: flushing an unchanged owner writes nothing', async () => {
    await seedMigrated();
    const owner = 'user:idem';
    const dir = tempDir('aq-i-');
    await runProcess({ dataDir: dir, partitions: ON }, [
      { op: 'boot' }, { op: 'load', owner },
      { op: 'call', module: 'reflection', fn: 'markSurfaced', args: [owner, 4000] }, { op: 'flush' },
    ]);
    const v1 = Number((await rows(owner))[0].version);
    const r = await runProcess({ dataDir: tempDir('aq-i2-'), partitions: ON }, [
      { op: 'boot' }, { op: 'load', owner },
      { op: 'call', module: 'reflection', fn: 'markSurfaced', args: [owner, 4000] }, { op: 'flush' },   // a retry of the same change
      { op: 'call', module: 'reflection', fn: 'markSurfaced', args: [owner, 3000] }, { op: 'flush' },   // an OLDER watermark arriving late
      { op: 'status' },
    ]);
    const after = (await rows(owner))[0];
    assert.equal(Number(after.version), v1, 'no new version for a repeated or older change');
    assert.equal(JSON.parse(after.data).lastSurfacedAt, 4000, 'the watermark never moves backwards');
    assert.ok(r.at(-1)[0].unchanged >= 1);
  });

  test('deletion holds against a stale copy, and yields to genuinely newer information', async () => {
    await seedMigrated();
    const owner = 'user:del';
    await runProcess({ dataDir: tempDir('aq-d0-'), partitions: ON }, [
      { op: 'boot' }, { op: 'load', owner },
      { op: 'call', module: 'reflection', fn: 'saveReflectionState', args: [owner, snap(['ent:secret'], 2000), 2000] }, { op: 'flush' },
    ]);
    const bar = tempDir('aq-bar-');
    const stale = runProcess({ dataDir: tempDir('aq-d1-'), partitions: ON }, [
      { op: 'boot' }, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'loaded', n: 2 },
      { op: 'barrier', dir: bar, name: 'deleted', n: 2 },
      // Holds the pre-deletion record and touches it with an OLD time: a stale copy.
      { op: 'call', module: 'reflection', fn: 'markSurfaced', args: [owner, 2500] }, { op: 'flush' },
      { op: 'call', module: 'reflection', fn: 'loadSnapshot', args: [owner] },
    ]);
    const deleter = runProcess({ dataDir: tempDir('aq-d2-'), partitions: ON }, [
      { op: 'boot' }, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'loaded', n: 2 },
      { op: 'call', module: 'reflection', fn: 'forgetReflectionState', args: [owner] }, { op: 'flush' },
      { op: 'barrier', dir: bar, name: 'deleted', n: 2 },
    ]);
    const [st] = await Promise.all([stale, deleter]);
    let [row] = await rows(owner);
    assert.equal(row.data, null, 'still deleted: the stale copy did not resurrect it');
    assert.ok(row.deleted_at);
    assert.equal(st.at(-1), null, 'the stale process dropped its copy');

    // Something genuinely new after the deletion (a later reflection) re-creates it.
    await runProcess({ dataDir: tempDir('aq-d3-'), partitions: ON }, [
      { op: 'boot' }, { op: 'load', owner },
      { op: 'call', module: 'reflection', fn: 'saveReflectionState', args: [owner, snap(['ent:new'], Date.now() + 1000), Date.now() + 1000] }, { op: 'flush' },
    ]);
    [row] = await rows(owner);
    assert.deepEqual(Object.keys(JSON.parse(row.data).snapshot.nodes), ['ent:new']);
  });

  test('owner isolation: loading and writing one owner never reads or writes another', async () => {
    await seedMigrated();
    await runProcess({ dataDir: tempDir('aq-o1-'), partitions: ON }, [
      { op: 'boot' }, { op: 'load', owner: 'user:a' },
      { op: 'call', module: 'reflection', fn: 'markSurfaced', args: ['user:a', 100] }, { op: 'flush' },
      { op: 'load', owner: 'user:b' },
      { op: 'call', module: 'reflection', fn: 'markSurfaced', args: ['user:b', 200] }, { op: 'flush' },
    ]);
    const bBefore = Number((await rows('user:b'))[0].version);
    const r = await runProcess({ dataDir: tempDir('aq-o2-'), partitions: ON }, [
      { op: 'boot' }, { op: 'load', owner: 'user:a' },
      { op: 'call', module: 'reflection', fn: 'reflectionStoreStats' },
      { op: 'call', module: 'reflection', fn: 'loadSurfacedAt', args: ['user:a'] },
      { op: 'call', module: 'reflection', fn: 'markSurfaced', args: ['user:a', 300] }, { op: 'flush' },
    ]);
    assert.equal(r[2].owners, 1, 'only the requested owner is in memory');
    assert.equal(r[3], 100);
    assert.equal(Number((await rows('user:b'))[0].version), bBefore, 'owner b untouched');
    assert.equal((await rows('user:a'))[0].owner_id, 'user:a');
  });

  test('an owner that was not loaded is NOT READY: reflection skips instead of reporting "everything changed"', async () => {
    await seedMigrated();
    const r = await runProcess({ dataDir: tempDir('aq-nr-'), partitions: ON }, [
      { op: 'boot' },
      { op: 'call', module: 'reflection', fn: 'reflectionOwnerReady', args: ['user:never-loaded'] },
      { op: 'call', module: 'reflectionV2', fn: 'reflectWorldModel', args: [{}, 'user:never-loaded'] },
      { op: 'load', owner: 'user:never-loaded' },
      { op: 'call', module: 'reflection', fn: 'reflectionOwnerReady', args: ['user:never-loaded'] },
    ]);
    assert.equal(r[1], false);
    assert.equal(r[2].skipped, 'owner-not-loaded');
    assert.equal(r[4], true, 'a loaded owner with no state is ready (state is known to be empty)');
  });

  test('a never-migrated store is refused `on` and keeps serving its JSON', async () => {
    const dir = tempDir('aq-ref-');
    fs.writeFileSync(path.join(dir, KEY), JSON.stringify({ __aqua: { schema: 1, savedAt: 1 },
      data: { 'user:json': { snapshot: null, lastReflectionAt: 0, lastSurfacedAt: 999 } } }));
    const r = await runProcess({ dataDir: dir, partitions: ON }, [
      { op: 'boot' },
      { op: 'call', module: 'reflection', fn: 'loadSurfacedAt', args: ['user:json'] },
    ]);
    assert.match(r[0], /reflection=off \(refused on: no partition rows/);
    assert.equal(r[1], 999, 'the JSON data is served, not an empty store');
  });

  test('without a database, `on` falls back to off and says why', async () => {
    const r = await runProcess({ dataDir: tempDir('aq-nodb-'), partitions: ON, database: false }, [{ op: 'boot' }]);
    assert.match(r[0], /reflection=off \(AQUA_STORE_PARTITIONS asked for on but DATABASE_URL is not set\)/);
  });

  test('default (flag unset): no partition rows are written at all', async () => {
    await runProcess({ dataDir: tempDir('aq-off-'), partitions: '' }, [
      { op: 'call', module: 'reflection', fn: 'markSurfaced', args: ['user:off', 5] }, { op: 'flush' },
    ]);
    assert.equal((await rows('user:off')).length, 0);
  });

  test('rollback: the JSON copy written in `on` mode serves the same state with the flag removed', async () => {
    await seedMigrated();
    const dir = tempDir('aq-rb-');
    const owner = 'user:rb';
    await runProcess({ dataDir: dir, partitions: ON }, [
      { op: 'boot' }, { op: 'load', owner },
      { op: 'call', module: 'reflection', fn: 'saveReflectionState', args: [owner, snap(['ent:7'], 8000), 8000] },
      { op: 'call', module: 'reflection', fn: 'markSurfaced', args: [owner, 9000] }, { op: 'flush' },
    ]);
    const off = await runProcess({ dataDir: dir, partitions: '', database: false }, [
      { op: 'call', module: 'reflection', fn: 'loadSnapshot', args: [owner] },
      { op: 'call', module: 'reflection', fn: 'loadSurfacedAt', args: [owner] },
    ]);
    assert.deepEqual(Object.keys(off[0].nodes), ['ent:7']);
    assert.equal(off[1], 9000);
    const fromDb = JSON.parse((await rows(owner))[0].data);
    const fromFile = JSON.parse(fs.readFileSync(path.join(dir, KEY), 'utf8')).data[owner];
    assert.deepEqual(fromFile, fromDb, 'the rollback copy equals the partition');
  });

  test('shadow: JSON stays authoritative and the partition receives the same entry', async () => {
    const dir = tempDir('aq-sh-');
    const owner = 'user:sh';
    await runProcess({ dataDir: dir, partitions: 'reflection:shadow' }, [
      { op: 'boot' },
      { op: 'call', module: 'reflection', fn: 'markSurfaced', args: [owner, 4242] }, { op: 'flush' },
    ]);
    const fromFile = JSON.parse(fs.readFileSync(path.join(dir, KEY), 'utf8')).data[owner];
    assert.deepEqual(JSON.parse((await rows(owner))[0].data), fromFile);
  });
});
