/**
 * Conversations on revision-based message rows (scalability Phase 2b, step 3).
 * Real child processes against the disposable test Postgres; skipped loudly
 * without one.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runProcess, tempDir, acquireStoreKeyLock } from '../../core/tests/helpers/multiProcess.mjs';
import { migrateStoreText, exportStore } from '../../core/storage/partitionMigration.js';

const LIVE = Boolean(process.env.DATABASE_URL);
let releaseLock = null;
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';
const KEY = '.aqua-history.json';
const ON = 'history:on';
const boot = { op: 'boot', stores: ['conversations'] };
const OWNER = 'user:42';
let pool;

const proc = (ops, extra = {}) => runProcess({ dataDir: tempDir('aq-c-'), partitions: ON, ...extra }, ops);
const rowsOf = async conv => (await pool.query(
  `SELECT partition_key, owner_id, data, version, deleted_at FROM aqua_store_partitions
    WHERE store_key = $1 AND (partition_key = $2 OR partition_key LIKE $3) ORDER BY partition_key`,
  [KEY, `c:${conv}`, `m:${conv}:%`])).rows;
const live = rs => rs.filter(r => r.data !== null);
const seed = () => pool.query(
  `INSERT INTO aqua_store_partitions (store_key, partition_key, owner_id, data, bytes, checksum, version)
   VALUES ($1, '~rest', '', '{"envelope":true,"sections":["c"],"doc":{"__aqua":{"schema":1,"savedAt":0},"data":{}}}', 0, 'x', 1)
   ON CONFLICT DO NOTHING`, [KEY]);
const create = id => ({ op: 'call', module: 'conversations', fn: 'getOrCreateConversation', args: [id, { userId: '42' }] });
const add = (id, text) => ({ op: 'call', module: 'conversations', fn: 'addMessage', args: [id, 'user', text] });

before(async () => {
  if (!LIVE) return;
  releaseLock = await acquireStoreKeyLock();
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  await (await import('../../core/db/migrate.js')).migrate();
});
beforeEach(async () => { if (LIVE) { await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = $1', [KEY]); await seed(); } });
after(async () => {
  if (!LIVE) return;
  try {
  await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = $1', [KEY]);
  await pool.end();
  await (await import('../../core/db/pool.js')).closePool();
  } finally { await releaseLock?.(); }
});

describe('conversation messages on partitions — real processes, real Postgres', { skip }, () => {
  test('two instances append to one conversation at once: every message kept, in time order, no rewrite', async () => {
    await proc([boot, { op: 'load', owner: OWNER }, create('c1'), add('c1', 'first'), { op: 'flush' }]);
    const bar = tempDir('aq-bar-');
    const N = 15;
    const appender = tag => proc([boot, { op: 'load', owner: OWNER }, { op: 'barrier', dir: bar, name: 'go', n: 2 },
      ...Array.from({ length: N }, (_, i) => add('c1', `${tag}${i}`)), { op: 'flush' }]);
    await Promise.all([appender('A'), appender('B')]);
    const r = await proc([boot, { op: 'load', owner: OWNER }, { op: 'convText', id: 'c1' }]);
    const texts = r.at(-1);
    assert.equal(texts.length, 1 + 2 * N, 'no message lost');
    assert.equal(new Set(texts).size, texts.length, 'no message duplicated');
    assert.equal(texts[0], 'first');
    for (const tag of ['A', 'B']) {
      const mine = texts.filter(t => t.startsWith(tag));
      assert.deepEqual(mine, Array.from({ length: N }, (_, i) => `${tag}${i}`), `${tag}'s messages keep their order`);
    }
    const rs = live(await rowsOf('c1'));
    assert.equal(rs.filter(x => x.partition_key.startsWith('m:')).length, 1 + 2 * N);
    assert.ok(rs.filter(x => x.partition_key.startsWith('m:')).every(x => Number(x.version) === 1), 'no message row was ever rewritten');
    assert.ok(rs.every(x => x.owner_id === OWNER));
  });

  test('editing one message writes that one row, versioned; the rest are untouched', async () => {
    const r1 = await proc([boot, { op: 'load', owner: OWNER }, create('c2'), add('c2', 'a'), add('c2', 'b'), add('c2', 'c'), { op: 'flush' }, { op: 'convKeys', id: 'c2' }]);
    const keys = r1.at(-1);
    const before = await rowsOf('c2');
    const r2 = await proc([boot, { op: 'load', owner: OWNER },
      { op: 'call', module: 'conversations', fn: 'editMessage', args: ['c2', keys[1], { content: 'b (corrected)' }] }, { op: 'convText', id: 'c2' }]);
    assert.equal(r2[2].ok, true);
    assert.equal(r2[2].rev, 1);
    assert.deepEqual(r2.at(-1), ['a', 'b (corrected)', 'c']);
    const after = await rowsOf('c2');
    const changed = after.filter(a => Number(a.version) !== Number(before.find(b => b.partition_key === a.partition_key)?.version));
    assert.deepEqual(changed.map(c => c.partition_key).filter(k => k.startsWith('m:')), [`m:c2:${keys[1]}`], 'exactly one message row changed');
  });

  test('two concurrent edits of one message: one lands, the other is told — no silent overwrite', async () => {
    const r1 = await proc([boot, { op: 'load', owner: OWNER }, create('c3'), add('c3', 'draft'), { op: 'flush' }, { op: 'convKeys', id: 'c3' }]);
    const key = r1.at(-1)[0];
    const bar = tempDir('aq-bar-');
    const edit = text => proc([boot, { op: 'load', owner: OWNER }, { op: 'barrier', dir: bar, name: 'go', n: 2 },
      { op: 'call', module: 'conversations', fn: 'editMessage', args: ['c3', key, { content: text }] }]);
    const [a, b] = await Promise.all([edit('version A'), edit('version B')]);
    const results = [a.at(-1), b.at(-1)];
    assert.equal(results.filter(x => x.ok).length, 1, JSON.stringify(results));
    const lost = results.find(x => !x.ok);
    assert.equal(lost.conflict, true);
    const winner = results.find(x => x.ok) === a.at(-1) ? 'version A' : 'version B';
    assert.equal(lost.current.content, winner, 'the loser is shown what won');
    const row = live(await rowsOf('c3')).find(x => x.partition_key === `m:c3:${key}`);
    assert.equal(JSON.parse(row.data).content, winner);
  });

  test('a deleted message is a tombstone: other instances drop it, and a stale edit cannot bring it back', async () => {
    const r1 = await proc([boot, { op: 'load', owner: OWNER }, create('c4'), add('c4', 'keep'), add('c4', 'remove me'), { op: 'flush' }, { op: 'convKeys', id: 'c4' }]);
    const key = r1.at(-1)[1];
    const bar = tempDir('aq-bar-');
    const [, stale] = await Promise.all([
      proc([boot, { op: 'load', owner: OWNER }, { op: 'barrier', dir: bar, name: 'l', n: 2 },
        { op: 'call', module: 'conversations', fn: 'deleteMessage', args: ['c4', key] }, { op: 'barrier', dir: bar, name: 'd', n: 2 }]),
      proc([boot, { op: 'load', owner: OWNER }, { op: 'barrier', dir: bar, name: 'l', n: 2 }, { op: 'barrier', dir: bar, name: 'd', n: 2 },
        { op: 'call', module: 'conversations', fn: 'editMessage', args: ['c4', key, { content: 'resurrected?' }] },
        { op: 'load', owner: OWNER }, { op: 'convText', id: 'c4' }]),
    ]);
    assert.equal(stale.at(-3).ok, false);
    assert.equal(stale.at(-3).deleted, true);
    assert.deepEqual(stale.at(-1), ['keep']);
    const row = (await rowsOf('c4')).find(x => x.partition_key === `m:c4:${key}`);
    assert.equal(row.data, null);
  });

  test('a conversation deleted while another instance is still appending stays deleted', async () => {
    await proc([boot, { op: 'load', owner: OWNER }, create('c5'), add('c5', 'hello'), { op: 'flush' }]);
    const bar = tempDir('aq-bar-');
    await Promise.all([
      proc([boot, { op: 'load', owner: OWNER }, { op: 'barrier', dir: bar, name: 'l', n: 2 },
        { op: 'call', module: 'conversations', fn: 'clearConversation', args: ['c5'] }, { op: 'flush' }, { op: 'barrier', dir: bar, name: 'd', n: 2 }]),
      proc([boot, { op: 'load', owner: OWNER }, { op: 'barrier', dir: bar, name: 'l', n: 2 }, { op: 'barrier', dir: bar, name: 'd', n: 2 },
        add('c5', 'late message'), { op: 'flush' }]),
    ]);
    const r = await proc([boot, { op: 'load', owner: OWNER }, { op: 'call', module: 'conversations', fn: 'conversationExists', args: ['c5'] }]);
    assert.equal(r.at(-1), false, 'the deleted conversation is not shown again');
    const header = (await rowsOf('c5')).find(x => x.partition_key === 'c:c5');
    assert.equal(header.data, null);
  });

  test('deleting a conversation also retires messages another instance wrote that this one never saw', async () => {
    await proc([boot, { op: 'load', owner: OWNER }, create('c7'), add('c7', 'seen by both'), { op: 'flush' }]);
    const bar = tempDir('aq-bar-');
    await Promise.all([
      // loads first, so it never holds B's message; deletes after B has flushed it
      proc([boot, { op: 'load', owner: OWNER }, { op: 'barrier', dir: bar, name: 'l', n: 2 }, { op: 'barrier', dir: bar, name: 'b', n: 2 },
        { op: 'call', module: 'conversations', fn: 'clearConversation', args: ['c7'] }, { op: 'flush' }]),
      proc([boot, { op: 'load', owner: OWNER }, { op: 'barrier', dir: bar, name: 'l', n: 2 },
        add('c7', 'only B saw this'), { op: 'flush' }, { op: 'barrier', dir: bar, name: 'b', n: 2 }]),
    ]);
    const rows = await rowsOf('c7');
    assert.equal(rows.length, 3, 'header + two messages');
    assert.deepEqual(live(rows), [], 'no row of the deleted conversation is left live');
  });

  test('metadata changed in two instances at once (title here, pin there): both kept', async () => {
    await proc([boot, { op: 'load', owner: OWNER }, create('c6'), add('c6', 'x'), { op: 'flush' }]);
    const bar = tempDir('aq-bar-');
    await Promise.all([
      proc([boot, { op: 'load', owner: OWNER }, { op: 'barrier', dir: bar, name: 'go', n: 2 },
        { op: 'call', module: 'conversations', fn: 'updateConversationMeta', args: ['c6', { title: 'Launch plan' }] }, { op: 'flush' }]),
      proc([boot, { op: 'load', owner: OWNER }, { op: 'barrier', dir: bar, name: 'go', n: 2 },
        { op: 'call', module: 'conversations', fn: 'updateConversationMeta', args: ['c6', { pinned: true }] }, { op: 'flush' }]),
    ]);
    const meta = JSON.parse(live(await rowsOf('c6')).find(x => x.partition_key === 'c:c6').data).meta;
    assert.equal(meta.title, 'Launch plan');
    assert.equal(meta.pinned, true);
    assert.equal(meta.userId, '42', 'identity fields untouched');
  });

  test('migrated history keeps its order; new messages follow it; export equals what the app shows', async () => {
    const text = JSON.stringify({ __aqua: { schema: 1, savedAt: 1 }, data: {
      old: { messages: [{ role: 'user', content: 'm0', ts: 1 }, { role: 'assistant', content: 'm1', ts: 2 }, { role: 'user', content: 'm2', ts: 3 }], meta: { userId: '42', title: 'Old' } },
    } });
    await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = $1', [KEY]);
    const m = await migrateStoreText({ storeKey: KEY, text, mode: 'apply', pool });
    assert.equal(m.inserted, 5);   // header + 3 messages + ~rest
    const r = await proc([boot, { op: 'load', owner: OWNER }, { op: 'convText', id: 'old' }, add('old', 'm3'), { op: 'flush' }, { op: 'convText', id: 'old' }]);
    assert.deepEqual(r[2], ['m0', 'm1', 'm2']);
    assert.deepEqual(r.at(-1), ['m0', 'm1', 'm2', 'm3']);
    const exported = JSON.parse(await exportStore({ storeKey: KEY, pool, record: false }));
    assert.deepEqual(exported.data.old.messages.map(x => x.content), ['m0', 'm1', 'm2', 'm3']);
    assert.equal(exported.data.old.meta.title, 'Old');
  });

  test('owner isolation: another user\'s conversation is neither loaded nor accessible', async () => {
    await proc([boot, { op: 'load', owner: OWNER }, create('mine'), add('mine', 'x'),
      { op: 'call', module: 'conversations', fn: 'getOrCreateConversation', args: ['theirs', { userId: '99' }] },
      { op: 'call', module: 'conversations', fn: 'addMessage', args: ['theirs', 'user', 'private'] }, { op: 'flush' }]);
    const r = await proc([boot, { op: 'load', owner: OWNER },
      { op: 'call', module: 'conversations', fn: 'conversationExists', args: ['theirs'] },
      { op: 'call', module: 'conversations', fn: 'canAccessConversation', args: ['42', 'theirs'] },
      { op: 'call', module: 'conversations', fn: 'canAccessConversation', args: ['42', 'mine'] },
      { op: 'call', module: 'conversations', fn: 'getStoreStats' }]);
    assert.equal(r[2], false);
    assert.equal(r[3], false);
    assert.equal(r[4], true);
    assert.equal(r[5].conversations, 1);
    assert.ok(live(await rowsOf('theirs')).every(x => x.owner_id === 'user:99'));
  });

  test('rollback: the JSON copy written in `on` mode serves the same conversation with the flag removed', async () => {
    const dir = tempDir('aq-rb-');
    await runProcess({ dataDir: dir, partitions: ON }, [boot, { op: 'load', owner: OWNER }, create('rb'), add('rb', 'one'), add('rb', 'two'), { op: 'flush' }]);
    const off = await runProcess({ dataDir: dir, partitions: '', database: false }, [{ op: 'convText', id: 'rb' }]);
    assert.deepEqual(off[0], ['one', 'two']);
  });

  test('a retried insert whose first attempt landed (acknowledgement lost) is not duplicated', async () => {
    const { bindConversationStore } = await import('../conversationPartitions.js');
    const store = new Map();
    const b = bindConversationStore({ file: path.join(tempDir('aq-idem-'), KEY), store, mode: 'on' });
    store.set('ci', { messages: [], meta: { userId: '42' } });
    b.hooks.created('ci');
    const msg = { role: 'user', content: 'once', ts: Date.now() };
    b.hooks.messageAdded('ci', msg);
    store.get('ci').messages.push(msg);
    // The first attempt reached the database; its acknowledgement did not reach us.
    await pool.query(
      `INSERT INTO aqua_store_partitions (store_key, partition_key, owner_id, data, bytes, checksum, version)
       VALUES ($1, $2, $3, $4, 0, 'x', 1)`, [KEY, `m:ci:${msg.mid}`, OWNER, JSON.stringify(msg)]);
    await b.flush();
    assert.equal(b.status().idempotentRetries, 1);
    assert.equal(b.status().rekeyed, 0);
    const ms = live(await rowsOf('ci')).filter(x => x.partition_key.startsWith('m:'));
    assert.equal(ms.length, 1);
    b._reset();
  });

  test('default (flag unset): messages carry no new field and no rows are written', async () => {
    const dir = tempDir('aq-off-');
    await runProcess({ dataDir: dir, partitions: '' }, [create('off1'), add('off1', 'plain')]);
    const file = JSON.parse(fs.readFileSync(path.join(dir, KEY), 'utf8'));
    assert.deepEqual(Object.keys(file.data.off1.messages[0]).sort(), ['content', 'role', 'ts']);
    assert.equal((await rowsOf('off1')).length, 0);
  });
});
