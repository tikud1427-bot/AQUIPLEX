/**
 * Mind and recall redactions on owner partitions (scalability Phase 2b, step 2).
 *
 * Real child processes (one plays the server, one the worker), each with its
 * own disk, pool and memory, against the disposable test Postgres. Skipped
 * loudly without one.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runProcess, tempDir, acquireStoreKeyLock } from '../../core/tests/helpers/multiProcess.mjs';
import { mergeRedactionRecords } from '../../memory/recallRedactions.js';

const LIVE = Boolean(process.env.DATABASE_URL);
let releaseLock = null;
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';
const MIND = '.aqua-mind.json';
const RED = '.aqua-recall-redactions.json';
const STORES = ['mind', 'redactions'];
const ON = 'mind:on,recall-redactions:on';
let pool;

const row = async (key, owner) => (await pool.query(
  'SELECT owner_id, data, version, deleted_at FROM aqua_store_partitions WHERE store_key = $1 AND partition_key = $2',
  [key, `o:${owner}`])).rows[0];
const seed = key => pool.query(
  `INSERT INTO aqua_store_partitions (store_key, partition_key, owner_id, data, bytes, checksum, version)
   VALUES ($1, '~rest', '', '{"envelope":true,"sections":["o"],"doc":{"__aqua":{"schema":1,"savedAt":0},"data":{}}}', 0, 'x', 1)
   ON CONFLICT DO NOTHING`, [key]);
const boot = { op: 'boot', stores: STORES };
const proc = (ops, extra = {}) => runProcess({ dataDir: tempDir('aq-m-'), partitions: ON, ...extra }, ops);

before(async () => {
  if (!LIVE) return;
  releaseLock = await acquireStoreKeyLock();
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  await (await import('../../core/db/migrate.js')).migrate();
});
beforeEach(async () => {
  if (!LIVE) return;
  await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = ANY($1)', [[MIND, RED]]);
  await seed(MIND); await seed(RED);
});
after(async () => {
  if (!LIVE) return;
  try {
  await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = ANY($1)', [[MIND, RED]]);
  await pool.end();
  await (await import('../../core/db/pool.js')).closePool();
  } finally { await releaseLock?.(); }
});

describe('redaction merge — pure', () => {
  test('grow-only: phrases unioned, forgetAllAt the later, order-independent', () => {
    const a = { forgetAllAt: 10, phrases: { h1: { n: 1, at: 5 } } };
    const b = { forgetAllAt: null, phrases: { h2: { n: 2, at: 7 }, h1: { n: 1, at: 3 } } };
    const m = mergeRedactionRecords(a, b);
    assert.deepEqual(Object.keys(m.phrases).sort(), ['h1', 'h2']);
    assert.equal(m.forgetAllAt, 10);
    assert.equal(m.phrases.h1.at, 3);
    assert.deepEqual(JSON.stringify(mergeRedactionRecords(b, a).phrases.h1), JSON.stringify(m.phrases.h1));
  });
});

describe('Mind on partitions — real processes, real Postgres', { skip }, () => {
  test('server and worker learn different facts about one person concurrently: both are kept', async () => {
    const bar = tempDir('aq-bar-');
    const owner = 'user:m1';
    await proc([boot, { op: 'load', owner }, { op: 'mindSet', owner, key: 'city', value: 'Lisbon', at: 1000 }, { op: 'flush' }]);
    const [w, s] = await Promise.all([
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 },
        { op: 'mindSet', owner, key: 'employer', value: 'Acme', at: 2000 }, { op: 'flush' },
        { op: 'barrier', dir: bar, name: 'f', n: 2 }, { op: 'load', owner }, { op: 'mindFacts', owner }]),
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 },
        { op: 'mindSet', owner, key: 'pet', value: 'cat', at: 2100 }, { op: 'flush' },
        { op: 'barrier', dir: bar, name: 'f', n: 2 }, { op: 'load', owner }, { op: 'mindFacts', owner }]),
    ]);
    const facts = JSON.parse((await row(MIND, owner)).data).facts;
    assert.deepEqual(Object.keys(facts).sort(), ['city', 'employer', 'pet']);
    assert.deepEqual(w.at(-1), { city: 'Lisbon', employer: 'Acme', pet: 'cat' });
    assert.deepEqual(s.at(-1), { city: 'Lisbon', employer: 'Acme', pet: 'cat' });
  });

  test('one fact corrected in two processes: the newer value wins, everywhere', async () => {
    const bar = tempDir('aq-bar-');
    const owner = 'user:m2';
    await Promise.all([
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 }, { op: 'mindSet', owner, key: 'launch', value: 'May 1', at: 5000 }, { op: 'flush' }]),
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 }, { op: 'mindSet', owner, key: 'launch', value: 'May 2', at: 6000 }, { op: 'flush' }]),
    ]);
    assert.equal(JSON.parse((await row(MIND, owner)).data).facts.launch.value, 'May 2');
  });

  test('a fact the user deleted is not brought back by a process holding the old copy', async () => {
    const bar = tempDir('aq-bar-');
    const owner = 'user:m3';
    await proc([boot, { op: 'load', owner }, { op: 'mindSet', owner, key: 'diagnosis', value: 'private', at: 1000 }, { op: 'flush' }]);
    await Promise.all([
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 },
        { op: 'mindDeleteItem', owner, key: 'diagnosis' }, { op: 'flush' }, { op: 'barrier', dir: bar, name: 'd', n: 2 }]),
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 }, { op: 'barrier', dir: bar, name: 'd', n: 2 },
        // still holds 'diagnosis' from before the deletion; learns something else
        { op: 'mindSet', owner, key: 'hobby', value: 'chess', at: Date.now() }, { op: 'flush' }]),
    ]);
    const facts = JSON.parse((await row(MIND, owner)).data).facts;
    assert.equal('diagnosis' in facts, false, 'the deleted fact stayed deleted');
    assert.equal(facts.hobby.value, 'chess');
  });

  test('account deleted, then the person keeps talking: nothing from before comes back', async () => {
    const owner = 'user:m4';
    await proc([boot, { op: 'load', owner }, { op: 'mindSet', owner, key: 'old', value: 'secret', at: 1000 }, { op: 'flush' }]);
    await proc([boot, { op: 'load', owner },
      { op: 'call', module: 'mind', fn: 'deleteMind', args: [owner] },
      { op: 'mindSet', owner, key: 'new', value: 'fresh' },   // before the deletion was flushed
      { op: 'flush' }]);
    const facts = JSON.parse((await row(MIND, owner)).data).facts;
    assert.deepEqual(Object.keys(facts), ['new']);
  });

  test('a stale process cannot resurrect a deleted mind', async () => {
    const bar = tempDir('aq-bar-');
    const owner = 'user:m5';
    await proc([boot, { op: 'load', owner }, { op: 'mindSet', owner, key: 'x', value: '1', at: 1000 }, { op: 'flush' }]);
    await Promise.all([
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 },
        { op: 'call', module: 'mind', fn: 'deleteMind', args: [owner] }, { op: 'flush' }, { op: 'barrier', dir: bar, name: 'd', n: 2 }]),
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 }, { op: 'barrier', dir: bar, name: 'd', n: 2 },
        // flushes its unchanged pre-deletion copy (touch with the OLD time)
        { op: 'mindSet', owner, key: 'x', value: '1', at: 1000 }, { op: 'flush' }, { op: 'mindFacts', owner }]),
    ]);
    const r = await row(MIND, owner);
    assert.equal(r.data, null);
    assert.ok(r.deleted_at);
  });

  test('only the requested owner is loaded; another owner\'s row is never written', async () => {
    await proc([boot, { op: 'load', owner: 'user:a' }, { op: 'mindSet', owner: 'user:a', key: 'k', value: 'a', at: 1 }, { op: 'flush' },
      { op: 'load', owner: 'user:b' }, { op: 'mindSet', owner: 'user:b', key: 'k', value: 'b', at: 1 }, { op: 'flush' }]);
    const vB = Number((await row(MIND, 'user:b')).version);
    const r = await proc([boot, { op: 'load', owner: 'user:a' },
      { op: 'call', module: 'mind', fn: 'mindStats' },
      { op: 'mindSet', owner: 'user:a', key: 'k2', value: 'a2' }, { op: 'flush' }, { op: 'mindFacts', owner: 'user:b' }]);
    assert.equal(r[2].minds, 1);
    assert.equal(r.at(-1), null, 'user:b is not in memory');
    assert.equal(Number((await row(MIND, 'user:b')).version), vB);
    assert.equal((await row(MIND, 'user:a')).owner_id, 'user:a');
  });

  test('memory is bounded: least-recently-used clean owners are evicted and reload intact', async () => {
    const ops = [boot];
    for (let i = 0; i < 10; i++) ops.push({ op: 'load', owner: `user:lru${i}` }, { op: 'mindSet', owner: `user:lru${i}`, key: 'n', value: String(i), at: 1 }, { op: 'flush' });
    ops.push({ op: 'call', module: 'mind', fn: 'mindStats' }, { op: 'load', owner: 'user:lru0' }, { op: 'mindFacts', owner: 'user:lru0' }, { op: 'status' });
    const r = await proc(ops, { env: { AQUA_PARTITION_STORE_OWNERS: '3' } });
    const stats = r.at(-4);
    assert.ok(stats.minds <= 4, `minds in memory: ${stats.minds}`);
    assert.deepEqual(r.at(-2), { n: '0' }, 'an evicted owner reloads with its data');
    assert.ok(r.at(-1).find(s => s.store === MIND).evictions >= 6);
  });

  test('rollback: the JSON copy written in `on` mode loads with the flag removed', async () => {
    const dir = tempDir('aq-rb-');
    const owner = 'user:rb';
    await runProcess({ dataDir: dir, partitions: ON }, [boot, { op: 'load', owner }, { op: 'mindSet', owner, key: 'k', value: 'v', at: 1 }, { op: 'flush' }]);
    const off = await runProcess({ dataDir: dir, partitions: '', database: false }, [{ op: 'mindFacts', owner }]);
    assert.deepEqual(off[0], { k: 'v' });
    assert.ok(fs.existsSync(path.join(dir, MIND)));
  });
});

describe('recall redactions on partitions — real processes', { skip }, () => {
  test('two processes forget different things concurrently: both stay forgotten', async () => {
    const bar = tempDir('aq-bar-');
    const owner = 'user:r1';
    await Promise.all([
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 },
        { op: 'call', module: 'redactions', fn: 'redactPhrases', args: [owner, ['Lisbon']] }, { op: 'flush' }]),
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 },
        { op: 'call', module: 'redactions', fn: 'redactPhrases', args: [owner, ['Acme Corp']] }, { op: 'flush' }]),
    ]);
    const r = await proc([boot, { op: 'load', owner },
      { op: 'isRedacted', owner, sentence: 'I moved to Lisbon' }, { op: 'isRedacted', owner, sentence: 'I work at Acme Corp' },
      { op: 'isRedacted', owner, sentence: 'I like tea' }]);
    assert.deepEqual(r.slice(2), [true, true, false]);
  });

  test('an owner whose list is not loaded fails CLOSED: nothing may be quoted', async () => {
    const r = await proc([boot, { op: 'isRedacted', owner: 'user:r2', sentence: 'anything at all' }]);
    assert.equal(r[1], true);
  });

  test('account purge is a tombstone a stale process cannot fill', async () => {
    const bar = tempDir('aq-bar-');
    const owner = 'user:r3';
    await proc([boot, { op: 'load', owner }, { op: 'call', module: 'redactions', fn: 'redactPhrases', args: [owner, ['Lisbon'], { at: 1000 }] }, { op: 'flush' }]);
    await Promise.all([
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 },
        { op: 'call', module: 'redactions', fn: 'purgeOwner', args: [owner] }, { op: 'flush' }, { op: 'barrier', dir: bar, name: 'd', n: 2 }]),
      proc([boot, { op: 'load', owner }, { op: 'barrier', dir: bar, name: 'l', n: 2 }, { op: 'barrier', dir: bar, name: 'd', n: 2 },
        { op: 'call', module: 'redactions', fn: 'redactPhrases', args: [owner, ['Lisbon'], { at: 1000 }] }, { op: 'flush' }]),
    ]);
    const r = await row(RED, owner);
    assert.equal(r.data, null, 'purged content stays purged');
  });
});
