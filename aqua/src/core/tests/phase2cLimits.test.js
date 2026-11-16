/**
 * Phase 2c — the four Phase 2b limitations, fixed and pinned (real Postgres,
 * real processes). Skipped loudly without a database.
 *
 *   1+2  messages after a conversation's deletion; orphan cleanup that can never
 *        touch a re-created conversation
 *   3    deletion decisions independent of host clocks
 *   4    an unchanged owner costs one primary-key lookup, whatever its size
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { runProcess, tempDir, acquireStoreKeyLock } from './helpers/multiProcess.mjs';
import { createPartitionRepository } from '../storage/partitionRepository.js';

const LIVE = Boolean(process.env.DATABASE_URL);
let releaseLock = null;
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';
const H = '.aqua-history.json';
const R = '.aqua-reflection.json';
const OWNER = 'user:42';
let pool;

const seed = key => pool.query(
  `INSERT INTO aqua_store_partitions (store_key, partition_key, owner_id, data, bytes, checksum, version)
   VALUES ($1, '~rest', '', '{"envelope":true,"sections":["c"],"doc":{"__aqua":{"schema":1,"savedAt":0},"data":{}}}', 0, 'x', 1)
   ON CONFLICT DO NOTHING`, [key]);
const rowsOf = async conv => (await pool.query(
  `SELECT partition_key, data, deleted_at FROM aqua_store_partitions WHERE store_key = $1
    AND (partition_key = $2 OR left(partition_key, length($3)) = $3)`, [H, `c:${conv}`, `m:${conv}:`])).rows;
const create = id => ({ op: 'call', module: 'conversations', fn: 'getOrCreateConversation', args: [id, { userId: '42' }] });
const add = (id, text) => ({ op: 'call', module: 'conversations', fn: 'addMessage', args: [id, 'user', text] });
const bootC = { op: 'boot', stores: ['conversations'] };

before(async () => {
  if (!LIVE) return;
  releaseLock = await acquireStoreKeyLock();
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  await (await import('../db/migrate.js')).migrate();
});
beforeEach(async () => {
  if (!LIVE) return;
  await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = ANY($1)', [[H, R]]);
  await seed(H);
  await pool.query(`INSERT INTO aqua_store_partitions (store_key, partition_key, owner_id, data, bytes, checksum, version)
    VALUES ($1, '~rest', '', '{"envelope":true,"sections":["o"],"doc":{"__aqua":{"schema":1,"savedAt":0},"data":{}}}', 0, 'x', 1) ON CONFLICT DO NOTHING`, [R]);
});
after(async () => {
  if (!LIVE) return;
  try {
    await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = ANY($1)', [[H, R]]);
    await pool.end();
    await (await import('../db/pool.js')).closePool();
  } finally { await releaseLock?.(); }
});

describe('1+2 — no message outlives its conversation', { skip }, () => {
  test('an instance appending while another deletes the conversation: zero live rows afterwards', async () => {
    await runProcess({ dataDir: tempDir('aq-o-'), partitions: 'history:on' }, [bootC, { op: 'load', owner: OWNER }, create('race'), add('race', 'm0'), { op: 'flush' }]);
    const bar = tempDir('aq-bar-');
    const appends = Array.from({ length: 25 }, (_, i) => [add('race', `late ${i}`), { op: 'flush' }]).flat();
    await Promise.all([
      runProcess({ dataDir: tempDir('aq-a-'), partitions: 'history:on' }, [bootC, { op: 'load', owner: OWNER }, { op: 'barrier', dir: bar, name: 'go', n: 2 }, ...appends]),
      runProcess({ dataDir: tempDir('aq-d-'), partitions: 'history:on' }, [bootC, { op: 'load', owner: OWNER }, { op: 'barrier', dir: bar, name: 'go', n: 2 },
        { op: 'call', module: 'conversations', fn: 'clearConversation', args: ['race'] }, { op: 'flush' }]),
    ]);
    const rows = await rowsOf('race');
    assert.ok(rows.find(r => r.partition_key === 'c:race').deleted_at, 'conversation deleted');
    assert.deepEqual(rows.filter(r => r.data !== null).map(r => r.partition_key), [], 'no live message under the deleted conversation');
  });

  test('the orphan sweep retires legacy orphans and never touches a re-created conversation', async () => {
    const repo = createPartitionRepository({ pool, instanceId: 'sweep-test' });
    const ins = (pk, data, deleted = false) => pool.query(
      `INSERT INTO aqua_store_partitions (store_key, partition_key, owner_id, data, bytes, checksum, version, deleted_at)
       VALUES ($1, $2, $3, $4, 0, 'x', 1, ${deleted ? 'now()' : 'NULL'})`, [H, pk, OWNER, deleted ? null : data]);
    // A legacy orphan: header tombstoned, a message still live (Phase 2b could leave this).
    await ins('c:gone', null, true);
    await ins('m:gone:1-a', '{"content":"orphan"}');
    // A conversation deleted and then CREATED AGAIN under the same id: live header, live messages.
    await ins('c:back', '{"meta":{"userId":"42"},"messages":"\\u0000messages"}');
    await ins('m:back:1-a', '{"content":"valid"}');
    // An id that is a prefix of another must not match it ("gone" vs "gone2").
    await ins('c:gone2', '{"meta":{"userId":"42"},"messages":"\\u0000messages"}');
    await ins('m:gone2:1-a', '{"content":"also valid"}');
    const r = await repo.sweepOrphans({ storeKey: H });
    assert.equal(r.swept, 1);
    const live = (await pool.query(`SELECT partition_key FROM aqua_store_partitions WHERE store_key=$1 AND data IS NOT NULL AND partition_key LIKE 'm:%' ORDER BY 1`, [H])).rows.map(x => x.partition_key);
    assert.deepEqual(live, ['m:back:1-a', 'm:gone2:1-a']);
  });
});

describe('3 — deletions do not depend on hosts agreeing on the time', { skip }, () => {
  test('a host whose clock is 10 minutes SLOW, which never saw the deletion, keeps what it learned after it (measured offset)', async () => {
    const owner = 'user:slow-mind';
    await runProcess({ dataDir: tempDir('aq-m0-'), partitions: 'mind:on' }, [{ op: 'boot', stores: ['mind'] }, { op: 'load', owner },
      { op: 'mindSet', owner, key: 'old', value: 'before the deletion', at: 1000 }, { op: 'flush' }]);
    const bar = tempDir('aq-bar-');
    await Promise.all([
      runProcess({ dataDir: tempDir('aq-m1-'), partitions: 'mind:on' }, [{ op: 'boot', stores: ['mind'] }, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 },
        { op: 'call', module: 'mind', fn: 'deleteMind', args: [owner] }, { op: 'flush' }, { op: 'barrier', dir: bar, name: 'd', n: 2 }]),
      // Loaded BEFORE the deletion (its offset measured then), no reload: learns a
      // new fact stamped by its own clock, 10 minutes behind the database.
      runProcess({ dataDir: tempDir('aq-m2-'), partitions: 'mind:on', env: { STORE_PROCESS_CLOCK_SKEW_MS: String(-10 * 60_000) } },
        [{ op: 'boot', stores: ['mind'] }, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 }, { op: 'barrier', dir: bar, name: 'd', n: 2 },
          { op: 'mindSet', owner, key: 'new', value: 'after the deletion' }, { op: 'flush' }]),
    ]);
    const row = (await pool.query(`SELECT data FROM aqua_store_partitions WHERE store_key='.aqua-mind.json' AND partition_key=$1`, [`o:${owner}`])).rows[0];
    assert.ok(row?.data, 'the new fact was not mistaken for a pre-deletion copy');
    assert.deepEqual(Object.keys(JSON.parse(row.data).facts), ['new'], 'and the deleted one did not come back');
    await pool.query(`DELETE FROM aqua_store_partitions WHERE store_key='.aqua-mind.json' AND owner_id=$1`, [owner]);
  });

  test('a host that reloads after the deletion needs no clock at all (it holds the tombstone)', async () => {
    const owner = 'user:skew';
    await runProcess({ dataDir: tempDir('aq-s0-'), partitions: 'reflection:on' }, [{ op: 'boot' }, { op: 'load', owner },
      { op: 'call', module: 'reflection', fn: 'markSurfaced', args: [owner, 1000] }, { op: 'flush' }]);
    const bar = tempDir('aq-bar-');
    await Promise.all([
      runProcess({ dataDir: tempDir('aq-s1-'), partitions: 'reflection:on' }, [{ op: 'boot' }, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 },
        { op: 'call', module: 'reflection', fn: 'forgetReflectionState', args: [owner] }, { op: 'flush' }, { op: 'barrier', dir: bar, name: 'd', n: 2 }]),
      // Loaded before the deletion; after it, makes a REAL new change — stamped with a clock 10 min behind.
      runProcess({ dataDir: tempDir('aq-s2-'), partitions: 'reflection:on', env: { STORE_PROCESS_CLOCK_SKEW_MS: String(-10 * 60_000) } },
        [{ op: 'boot' }, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 }, { op: 'barrier', dir: bar, name: 'd', n: 2 },
          { op: 'load', owner },   // a new request: measures its clock against the database
          { op: 'call', module: 'reflection', fn: 'saveReflectionState', args: [owner, { nodes: [['ent:new', {}]], edges: [], takenAt: null }, null] },
          { op: 'flush' }]),
    ]);
    const row = (await pool.query(`SELECT data FROM aqua_store_partitions WHERE store_key=$1 AND partition_key=$2`, [R, `o:${owner}`])).rows[0];
    assert.ok(row.data, 'the new change was kept, not mistaken for a pre-deletion copy');
    assert.deepEqual(Object.keys(JSON.parse(row.data).snapshot.nodes), ['ent:new']);
  });

  test('a host whose clock is 10 minutes FAST cannot pass an old copy off as new', async () => {
    const owner = 'user:fast';
    await runProcess({ dataDir: tempDir('aq-f0-'), partitions: 'mind:on' }, [{ op: 'boot', stores: ['mind'] }, { op: 'load', owner },
      { op: 'mindSet', owner, key: 'secret', value: 'old', at: 1000 }, { op: 'flush' }]);
    const bar = tempDir('aq-bar-');
    await Promise.all([
      runProcess({ dataDir: tempDir('aq-f1-'), partitions: 'mind:on' }, [{ op: 'boot', stores: ['mind'] }, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 },
        { op: 'call', module: 'mind', fn: 'deleteMind', args: [owner] }, { op: 'flush' }, { op: 'barrier', dir: bar, name: 'd', n: 2 }]),
      runProcess({ dataDir: tempDir('aq-f2-'), partitions: 'mind:on', env: { STORE_PROCESS_CLOCK_SKEW_MS: String(10 * 60_000) } },
        [{ op: 'boot', stores: ['mind'] }, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 }, { op: 'barrier', dir: bar, name: 'd', n: 2 },
          // touches its pre-deletion copy: touchMind stamps updatedAt with a clock 10 minutes ahead
          { op: 'mindSet', owner, key: 'secret', value: 'old', at: 1000 }, { op: 'flush' }]),
    ]);
    const row = (await pool.query(`SELECT data FROM aqua_store_partitions WHERE store_key='.aqua-mind.json' AND partition_key=$1`, [`o:${owner}`])).rows[0];
    assert.equal(row?.data ?? null, null, 'the deleted fact did not come back');
    await pool.query(`DELETE FROM aqua_store_partitions WHERE store_key='.aqua-mind.json' AND owner_id=$1`, [owner]);
  });
});

describe('4 — an unchanged owner costs one lookup', { skip }, () => {
  test('the counter moves on every write by anyone; an unchanged owner skips the versions query', async () => {
    const r = await runProcess({ dataDir: tempDir('aq-c-'), partitions: 'history:on' }, [bootC, { op: 'load', owner: OWNER },
      create('cnt'), ...Array.from({ length: 30 }, (_, i) => add('cnt', `m${i}`)), { op: 'flush' },
      { op: 'load', owner: OWNER },                 // own writes moved the counter: full load
      { op: 'load', owner: OWNER },                 // nothing moved: fast path
      { op: 'load', owner: OWNER }]);
    assert.equal(r.at(-1).unchanged, true);
    assert.equal(r.at(-2).unchanged, true);
    assert.notEqual(r.at(-3).unchanged, true);
    const before = Number((await pool.query('SELECT version FROM aqua_owner_versions WHERE owner_id=$1', [OWNER])).rows[0].version);
    // a write by "another instance" — directly in SQL — must move it
    await pool.query(`UPDATE aqua_store_partitions SET version = version + 1 WHERE store_key=$1 AND partition_key='c:cnt'`, [H]);
    const after = Number((await pool.query('SELECT version FROM aqua_owner_versions WHERE owner_id=$1', [OWNER])).rows[0].version);
    assert.ok(after > before);
    // the global rows never move a counter (no hot row)
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM aqua_owner_versions WHERE owner_id = ''`)).rows[0].n, 0);
  });
});
