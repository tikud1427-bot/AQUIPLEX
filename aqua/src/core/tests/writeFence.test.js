/**
 * Multi-instance connect safety — the connect lease (connect/ownerLease.js) and
 * the per-owner write fence (core/storage/writeFence.js) on the real migrated
 * schema in pg-mem, through the REAL partition repository and REAL store
 * bindings (ownerBinding, keyedBinding) in `on` mode.
 *
 * pg-mem does not block on row locks: the atomic takeover-vs-fenced-write
 * ordering is proven on real PostgreSQL with two Node processes
 * (connect/tests/connectFencing.live.test.js). Here: every decision — who may
 * acquire, renew, release, write — and every storage path (direct write,
 * debounced flush, delayed retry, request durability, owner invalidation).
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-fence-'));
process.env.AQUA_DATA_DIR = TMP;
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
const envBefore = process.env.DATABASE_URL;

let mem, poolMod, WF, L, R, OB, KB, RW, repo;
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
  KB = await import('../storage/keyedBinding.js');
  RW = await import('../storage/requestWrites.js');
  repo = R.createPartitionRepository({ pool: mem.pool });
  OB._setRepositoryForTests(repo);
});
after(async () => {
  poolMod?._resetForTests();
  await mem?.close();
  if (envBefore === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = envBefore;
});
beforeEach(() => WF._resetWriteFencesForTests());

let n = 0;
const owner = () => `user:fence-${process.pid}-${++n}`;
const row = async (store, pk) => (await mem.pool.query('SELECT data, version, deleted_at FROM aqua_store_partitions WHERE store_key = $1 AND partition_key = $2', [store, pk])).rows[0] ?? null;
const leaseRow = async name => (await mem.pool.query('SELECT holder, expires_at <= now() AS expired FROM aqua_scheduler_leases WHERE name = $1', [name])).rows[0] ?? null;
const fenceFor = (o, lease) => WF.setOwnerFence(o, { name: lease.name, token: lease.token });
/** Run `fn` as WORK OF the operation holding `fence` (Safety Fix 3: authority travels with the work). */
const as = (fence, fn) => WF.runWithFence(fence, fn);
/** A promise gate: `wait` resolves when `open()` is called. */
const gate = () => { let open; const wait = new Promise(r => { open = r; }); return { wait, open }; };
/** Another instance takes the owner over once the lease expired. */
async function takeover(o, ttlMs = 1000) {
  await sleep(ttlMs + 150);
  const b = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 5000 });
  await b.acquire({ waitMs: 0 });
  return b;
}

// ── test stores bound in `on` mode ───────────────────────────────────────────
function ownerStore(storeKey) {
  const map = new Map();
  const binding = OB.bindOwnerStore({
    storeKey, file: path.join(TMP, storeKey), mode: 'on',
    encode: o => (map.has(o) ? map.get(o) : undefined), decode: x => x,
    install: (o, v) => { if (v === null) map.delete(o); else map.set(o, v); },
    merge: (ours, theirs) => ({ ...theirs, ...ours }), changedAt: x => x?.t ?? 0,
  });
  return { map, binding, set: (o, v) => { map.set(o, v); binding.markDirty(o); } };
}
/** A keyed test store. `external(id)` (optional): an id → external-origin predicate for a root-map entry. */
function keyedStore(storeKey, { external = null } = {}) {
  const map = new Map();
  const binding = KB.bindKeyedStore({
    storeKey, file: path.join(TMP, storeKey), mode: 'on', section: 'k',
    mergeSchema: external ? { root: { time: x => Number(x?.t) || 0, external: id => external(id) } } : {},
    encode: k => (map.has(k) ? map.get(k) : undefined), decode: x => x,
    install: (k, v) => { if (v === null) map.delete(k); else map.set(k, v); },
    ownerOf: k => String(k).split('#')[0],
  });
  return { map, binding, set: (k, v) => { map.set(k, v); binding.markDirty(k); } };
}

// ── 1. the lease ─────────────────────────────────────────────────────────────
describe('connect lease (aqua_scheduler_leases, database clock)', () => {
  test('acquisition is exclusive; a live lease is never overwritten (LEASE_BUSY)', async () => {
    const o = owner();
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 5000 });
    const b = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 5000 });
    await a.acquire({ waitMs: 0 });
    await assert.rejects(b.acquire({ waitMs: 150 }), e => e.code === 'LEASE_BUSY');
    assert.equal((await leaseRow(a.name)).holder, a.token);
    assert.notEqual(a.token, b.token, 'every acquisition gets a unique token');
  });

  test('expiry → takeover; the old holder can neither renew nor release the new lease', async () => {
    const o = owner();
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 1000 });
    await a.acquire({ waitMs: 0 });
    assert.equal(await a.renew(), true, 'a live holder renews');
    const b = await takeover(o, 1000);
    assert.equal((await leaseRow(a.name)).holder, b.token);
    assert.equal(await a.renew(), false, 'the old holder renewed a lease it lost');
    assert.equal(await a.verify(), false);
    assert.equal(await a.release(), false, 'the old holder released the new lease');
    assert.equal((await leaseRow(a.name)).holder, b.token);
    assert.equal(await b.verify(), true);
    assert.equal(await b.release(), true);
    const after = await leaseRow(a.name);                // released = expired in place, still naming the last holder
    assert.equal(after.holder, b.token);
    assert.equal(after.expired, true);
    const c = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 5000 });
    await c.acquire({ waitMs: 0 });                      // an expired (released) row is free at once
    assert.equal((await leaseRow(a.name)).holder, c.token);
    await c.release();
  });

  test('database unavailable → acquisition refused (LEASE_UNAVAILABLE), the operation never runs', async () => {
    const broken = { query: async () => { throw new Error('connection refused'); }, connect: async () => { throw new Error('connection refused'); } };
    let ran = false;
    await assert.rejects(L.withConnectLease(owner(), async () => { ran = true; }, { pool: broken }), e => e.code === 'LEASE_UNAVAILABLE');
    assert.equal(ran, false);
  });
});

// ── 2. the fence on direct repository writes ─────────────────────────────────
// Safety Fix 3: a write is fenced because it is WORK OF AN OPERATION (created
// inside runWithFence), not because the owner currently has a fence.
describe('write fence — direct partition writes', () => {
  test('work of an operation lands while its lease is held; after takeover it is REFUSED and nothing changes', async () => {
    const o = owner(), other = owner();
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 1000 });
    await a.acquire({ waitMs: 0 });
    const fence = fenceFor(o, a);
    await as(fence, () => repo.put('.aqua-fence-direct.json', `o:${o}`, JSON.stringify({ v: 1 }), { ownerId: o, expectedVersion: 0 }));
    assert.equal(JSON.parse((await row('.aqua-fence-direct.json', `o:${o}`)).data).v, 1);
    const invalidated = [];
    const off = WF.registerFenceInvalidator((x, err, f) => invalidated.push([x, f === fence]));
    try {
      await takeover(o, 1000);
      await assert.rejects(as(fence, () => repo.put('.aqua-fence-direct.json', `o:${o}`, JSON.stringify({ v: 2 }), { ownerId: o, expectedVersion: 1 })), e => e.code === 'WRITE_FENCE_LOST');
      assert.equal(JSON.parse((await row('.aqua-fence-direct.json', `o:${o}`)).data).v, 1, 'a superseded holder wrote');
      await assert.rejects(as(fence, () => repo.delete('.aqua-fence-direct.json', `o:${o}`, { ownerId: o, expectedVersion: 1 })), e => e.code === 'WRITE_FENCE_LOST');
      await assert.rejects(as(fence, () => repo.transact([{ storeKey: '.aqua-fence-direct.json', partitionKey: `o:${o}`, ownerId: o, data: 'null', expectedVersion: 1 }])), e => e.code === 'WRITE_FENCE_LOST');
      assert.deepEqual(invalidated, [[o, true]], 'invalidation must run once, for that fence only');
      // another owner — and a plain write outside any operation — write as before
      await as(fence, () => repo.put('.aqua-fence-direct.json', `o:${other}`, JSON.stringify({ v: 9 }), { ownerId: other, expectedVersion: 0 }));
      assert.equal(JSON.parse((await row('.aqua-fence-direct.json', `o:${other}`)).data).v, 9);
    } finally { off(); }
  });

  test('lease check failing (database error) → the write is refused (fail closed)', async () => {
    const o = owner();
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 5000 });
    await a.acquire({ waitMs: 0 });
    const fence = fenceFor(o, a);
    const flaky = {
      query: (s, p) => mem.pool.query(s, p),
      connect: async () => {
        const c = await mem.pool.connect();
        return { query: (s, p) => (/aqua_scheduler_leases/.test(String(s)) ? Promise.reject(new Error('read timeout')) : c.query(s, p)), release: () => c.release() };
      },
    };
    const r2 = R.createPartitionRepository({ pool: flaky });
    await assert.rejects(as(fence, () => r2.put('.aqua-fence-direct.json', `o:${o}`, '{"v":1}', { ownerId: o, expectedVersion: 0 })), e => e.code === 'WRITE_FENCE_LOST');
    assert.equal(await row('.aqua-fence-direct.json', `o:${o}`), null);
    assert.ok(fence.lost, 'a failed proof must lose the fence for good');
  });
});

// ── 3. the fence on every binding path ───────────────────────────────────────
describe('write fence — debounced flushes, retries, merges and callers', () => {
  test('fence lost before a debounced flush: the operation\'s writes are discarded (not retried); unrelated writes land', async () => {
    const S = ownerStore('.aqua-fence-own1.json');
    const o = owner(), other = owner();
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 1000 });
    await a.acquire({ waitMs: 0 });
    const fence = fenceFor(o, a);
    await takeover(o, 1000);                           // this process stalled; another instance took over
    as(fence, () => S.set(o, { t: Date.now(), data: 'stale-external-resource' }));   // …then its work writes what it had
    S.set(other, { t: Date.now(), data: 'unrelated' });
    await sleep(600);                                  // the DEBOUNCED background flush (250 ms) runs by itself
    assert.equal(await row('.aqua-fence-own1.json', `o:${o}`), null, 'a stale debounced write landed');
    assert.equal(JSON.parse((await row('.aqua-fence-own1.json', `o:${other}`)).data).data, 'unrelated');
    assert.equal(S.binding.isDirty(o), false, 'a fence-lost write is back in the retry queue');
    assert.equal(S.binding.pendingCount(), 0);
    assert.equal(S.map.has(o), false, 'the unproven in-memory copy was kept');
    assert.equal(S.binding.isLoaded(o), false);
    assert.equal(S.map.get(other).data, 'unrelated', 'another owner\'s in-memory state was touched');
    await assert.rejects(S.binding.flushOnly(new Set([o])), e => e.code === 'WRITE_FENCE_LOST', 'the caller must get an explicit error');
    await sleep(700);                                    // any scheduled retry would have fired by now
    assert.equal(await row('.aqua-fence-own1.json', `o:${o}`), null);
  });

  test('fence lost before a DELAYED RETRY: the retry carries the ORIGINAL fence and is refused and discarded', async () => {
    const S = ownerStore('.aqua-fence-own2.json');
    const o = owner();
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 1000 });
    await a.acquire({ waitMs: 0 });
    const fence = fenceFor(o, a);
    const realRepo = repo;
    let blip = true;
    OB._setRepositoryForTests({ ...realRepo, update: (...args) => (blip ? Promise.reject(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })) : realRepo.update(...args)) });
    try {
      as(fence, () => S.set(o, { t: Date.now(), data: 'stale' }));
      await S.binding.flush();
      assert.equal(S.binding.isDirty(o), true, 'a transient failure must be retried');
      await takeover(o, 1000);                           // lease lost while retries keep failing
      blip = false;
      await sleep(1600);                                 // the scheduled DELAYED RETRY runs by itself (plain timer context)
      assert.equal(S.binding.isDirty(o), false);
      assert.equal(await row('.aqua-fence-own2.json', `o:${o}`), null, 'the delayed retry wrote after the takeover');
    } finally { OB._setRepositoryForTests(realRepo); }
  });

  test('keyed store: only the lost operation\'s keys are discarded and invalidated; conflict merges are fenced too', async () => {
    const S = keyedStore('.aqua-fence-key.json');
    const o = owner(), other = owner();
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 1000 });
    await a.acquire({ waitMs: 0 });
    const fence = fenceFor(o, a);
    as(fence, () => S.set(`${o}#ext-1`, { v: 1 }));
    await S.binding.flush();                             // lands while held
    assert.ok(await row('.aqua-fence-key.json', `k:${o}#ext-1`));
    await repo.put('.aqua-fence-key.json', `k:${o}#ext-1`, JSON.stringify({ v: 1, w: 'other-instance' }), { ownerId: o, expectedVersion: undefined }).catch(() => {});
    await takeover(o, 1000);
    as(fence, () => { S.set(`${o}#ext-1`, { v: 2, stale: true }); S.set(`${o}#ext-2`, { v: 1, stale: true }); });
    S.set(`${other}#x`, { v: 1 });
    await sleep(600);
    const r1 = JSON.parse((await row('.aqua-fence-key.json', `k:${o}#ext-1`)).data);
    assert.ok(!r1.stale, 'a stale merge landed');
    assert.equal(await row('.aqua-fence-key.json', `k:${o}#ext-2`), null);
    assert.ok(await row('.aqua-fence-key.json', `k:${other}#x`), 'another owner\'s write was blocked');
    assert.equal(S.map.has(`${o}#ext-1`) || S.map.has(`${o}#ext-2`), false, 'the operation\'s keys were not invalidated');
    assert.ok(S.map.has(`${other}#x`));
    await assert.rejects(S.binding.flushOnly(new Set([`${o}#ext-2`])), e => e.code === 'WRITE_FENCE_LOST');
  });

  test('conversation history (insert/header ops): a lost operation\'s queued ops are refused, dropped from the queue and reported', async () => {
    const { bindConversationStore } = await import('../../memory/conversationPartitions.js');
    const store = new Map();
    const b = bindConversationStore({ file: path.join(TMP, '.aqua-history.json'), store, mode: 'on' });
    const uid = `fh${process.pid}${++n}`, o = `user:${uid}`, convo = `c-${uid}`;
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 1000 });
    await a.acquire({ waitMs: 0 });
    const fence = fenceFor(o, a);
    await takeover(o, 1000);
    store.set(convo, { messages: [], meta: { userId: uid } });
    const msg = { role: 'user', content: 'stale message', ts: Date.now() };
    as(fence, () => { b.hooks.created(convo); b.hooks.messageAdded(convo, msg); });
    store.get(convo).messages.push(msg);
    await b.flush();
    const rows = (await mem.pool.query(`SELECT partition_key FROM aqua_store_partitions WHERE store_key = '.aqua-history.json' AND owner_id = $1`, [o])).rows;
    assert.deepEqual(rows, [], 'a stale holder wrote conversation rows');
    assert.equal(b.pendingCount(), 0, 'fence-lost ops are back in the retry queue');
    await assert.rejects(b.flushOnly(new Set([convo])), e => e.code === 'WRITE_FENCE_LOST');
    b._reset?.();
  });

  test('a request whose writes were discarded gets an explicit, non-retryable WRITE_FENCE_LOST', async () => {
    const S = ownerStore('.aqua-fence-req.json');
    const o = owner();
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 1000 });
    await a.acquire({ waitMs: 0 });
    const fence = fenceFor(o, a);
    await RW.runWithWriteScope(async () => {
      await takeover(o, 1000);
      as(fence, () => S.set(o, { t: Date.now(), data: 'request-write' }));
      await assert.rejects(RW.flushScopeStrict(), e => e.code === 'WRITE_FENCE_LOST' && e.retryable === false);
    });
    assert.equal(await row('.aqua-fence-req.json', `o:${o}`), null);
  });

  test('a plain write after a discard is accepted (no lingering error); it never inherits the lost fence', async () => {
    const S = ownerStore('.aqua-fence-new.json');
    const o = owner();
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 1000 });
    await a.acquire({ waitMs: 0 });
    const fence = fenceFor(o, a);
    await takeover(o, 1000);
    as(fence, () => S.set(o, { t: Date.now(), data: 'stale' }));
    await S.binding.flush();
    S.set(o, { t: Date.now(), data: 'fresh, later request' });   // fence NOT cleared: a plain write is not its work
    await S.binding.flushOnly(new Set([o]));
    assert.equal(JSON.parse((await row('.aqua-fence-new.json', `o:${o}`)).data).data, 'fresh, later request');
  });
});

// ── 4. withConnectLease end to end ───────────────────────────────────────────
describe('withConnectLease', () => {
  test('flushes every pending (debounced) write of the operation BEFORE release; releases only its own token; the fence ENDS', async () => {
    const S = ownerStore('.aqua-fence-wcl1.json');
    const o = owner();
    let name, fence;
    await L.withConnectLease(o, async ({ lease, fence: f }) => {
      name = lease.name; fence = f;
      assert.equal(WF.currentFence(), f, 'the operation does not run inside its fence');
      S.set(o, { t: Date.now(), data: 'imported' });     // debounced: not written yet
      assert.equal(await row('.aqua-fence-wcl1.json', `o:${o}`), null);
    }, { pool: mem.pool, ttlMs: 5000 });
    assert.equal(JSON.parse((await row('.aqua-fence-wcl1.json', `o:${o}`)).data).data, 'imported', 'pending writes were not flushed before release');
    const r = await leaseRow(name);
    assert.equal(r.expired, true, 'the lease was not released');
    assert.equal(fence.ended, true);
    assert.equal(fence.lost, null);
    assert.equal(WF.ownerFence(o), null, 'no running operation is registered after it ended');
  });

  test('detached work of a finished operation lands while nobody acquired since — and is refused after another holder acquired', async () => {
    const S = ownerStore('.aqua-fence-trail.json');
    const o = owner();
    const g1 = gate(), g2 = gate();
    let w1, w2;
    await L.withConnectLease(o, async () => {
      w1 = (async () => { await g1.wait; S.set(o, { t: Date.now(), data: 'late derived write #1' }); })();   // fire-and-forget
      w2 = (async () => { await g2.wait; S.set(o, { t: Date.now(), data: 'late derived write #2' }); })();
    }, { pool: mem.pool, ttlMs: 5000 });
    g1.open(); await w1;
    await S.binding.flush();
    assert.equal(JSON.parse((await row('.aqua-fence-trail.json', `o:${o}`)).data).data, 'late derived write #1');
    const b = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 5000 });  // another instance takes the owner (e.g. disconnect)
    await b.acquire({ waitMs: 0 });
    g2.open(); await w2;
    await S.binding.flush();
    assert.equal(JSON.parse((await row('.aqua-fence-trail.json', `o:${o}`)).data).data, 'late derived write #1', 'a late write landed after another holder took over');
    assert.equal(S.binding.isDirty(o), false);
    await b.release();
  });

  test('detached work is refused even after the other holder already RELEASED (its token stays on the expired row)', async () => {
    const S = ownerStore('.aqua-fence-trail2.json');
    const o = owner();
    const g = gate(); let w;
    await L.withConnectLease(o, async () => { w = (async () => { await g.wait; S.set(o, { t: Date.now(), data: 'late derived write after B finished' }); })(); }, { pool: mem.pool, ttlMs: 5000 });
    const b = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 5000 });                                // instance B: acquire, delete, release
    await b.acquire({ waitMs: 0 });
    assert.equal(await b.release(), true);
    g.open(); await w;
    await S.binding.flush();
    assert.equal(await row('.aqua-fence-trail2.json', `o:${o}`), null, 'a late write landed after another instance acquired and released');
  });

  test('ended-fence proof fails closed: the lease row is gone (ownership cannot be proven) → refused', async () => {
    const S = ownerStore('.aqua-fence-trail3.json');
    const o = owner();
    let name; const g = gate(); let w;
    await L.withConnectLease(o, async ({ lease }) => { name = lease.name; w = (async () => { await g.wait; S.set(o, { t: Date.now(), data: 'late write with no provable ownership' }); })(); }, { pool: mem.pool, ttlMs: 5000 });
    await mem.pool.query('DELETE FROM aqua_scheduler_leases WHERE name = $1', [name]);
    g.open(); await w;
    await S.binding.flush();
    assert.equal(await row('.aqua-fence-trail3.json', `o:${o}`), null, 'an ended-fence write landed without a lease row');
  });

  test('lease lost during the operation (no renewal, expiry, takeover): LEASE_LOST, its writes discarded, the new holder kept; plain writes unaffected', async () => {
    const S = ownerStore('.aqua-fence-wcl2.json');
    const o = owner(), other = owner();
    let b = null; const g = gate(); let w;
    await assert.rejects(L.withConnectLease(o, async () => {
      S.set(o, { t: Date.now(), data: 'written before the stall' });
      await S.binding.flush();                           // valid: lands
      b = await takeover(o, 1000);                       // stall past expiry → another instance takes over
      S.set(o, { t: Date.now(), data: 'stale, after takeover' });
      S.set(other, { t: Date.now(), data: 'other owner' });
      w = (async () => { await g.wait; S.set(o, { t: Date.now(), data: 'late background write of the lost operation' }); })();
    }, { pool: mem.pool, ttlMs: 1000, renewEveryMs: 0 }), e => e.code === 'LEASE_LOST');
    assert.equal(JSON.parse((await row('.aqua-fence-wcl2.json', `o:${o}`)).data).data, 'written before the stall');
    assert.equal((await leaseRow(b.name)).holder, b.token, 'the stale holder released the new holder\'s lease');
    g.open(); await w;                                   // detached work of the LOST operation finishes later
    await S.binding.flush();
    assert.equal(JSON.parse((await row('.aqua-fence-wcl2.json', `o:${o}`)).data).data, 'written before the stall', 'work of a lost operation landed');
    assert.equal(JSON.parse((await row('.aqua-fence-wcl2.json', `o:${other}`)).data).data, 'other owner');
    S.set(o, { t: Date.now(), data: 'a later plain write' });   // not the operation's work: never discarded
    await S.binding.flush();
    assert.equal(JSON.parse((await row('.aqua-fence-wcl2.json', `o:${o}`)).data).data, 'a later plain write');
    await b.release();
  });

  test('renewal keeps a long operation alive past the TTL', async () => {
    const S = ownerStore('.aqua-fence-wcl3.json');
    const o = owner();
    await L.withConnectLease(o, async () => {
      await sleep(1600);                                 // > ttl
      S.set(o, { t: Date.now(), data: 'after a long fetch' });
    }, { pool: mem.pool, ttlMs: 1000, renewEveryMs: 250 });
    assert.equal(JSON.parse((await row('.aqua-fence-wcl3.json', `o:${o}`)).data).data, 'after a long fetch');
  });

  test('different owners run concurrently; the same owner from a second holder waits (BUSY within the bound)', async () => {
    const o1 = owner(), o2 = owner();
    let inside = 0, maxInside = 0;
    const op = o => L.withConnectLease(o, async () => { inside++; maxInside = Math.max(maxInside, inside); await sleep(200); inside--; }, { pool: mem.pool, ttlMs: 5000 });
    await Promise.all([op(o1), op(o2)]);
    assert.equal(maxInside, 2, 'unrelated owners were serialised');
    const holder = L.createOwnerLease(o1, { pool: mem.pool, ttlMs: 5000 });
    await holder.acquire({ waitMs: 0 });
    await assert.rejects(L.withConnectLease(o1, async () => {}, { pool: mem.pool, waitMs: 200 }), e => e.code === 'LEASE_BUSY');
    await holder.release();
  });
});

// ── 5. Safety Fix 3 — the authority travels with the work ───────────────────
describe('Safety Fix 3 · write-carried fencing context', () => {
  test('a NEW operation\'s fence never authorises OLD work: detached work of operation A finishing during operation B (same process) is refused; B\'s own writes land', async () => {
    const S = ownerStore('.aqua-s3-newfence.json');
    const o = owner();
    const g = gate(); let w;
    await L.withConnectLease(o, async () => { w = (async () => { await g.wait; S.set(o, { t: Date.now(), data: 'A: late' }); })(); }, { pool: mem.pool, ttlMs: 5000 });
    await L.withConnectLease(o, async () => {
      g.open(); await w;                                 // A's work completes INSIDE B — B's fence is the owner's current one
      await S.binding.flushOnly(new Set([o])).catch(() => {});
    }, { pool: mem.pool, ttlMs: 5000 });
    assert.equal(await row('.aqua-s3-newfence.json', `o:${o}`), null, 'old work was authorised by a later fence');
    await L.withConnectLease(o, async () => { S.set(o, { t: Date.now(), data: 'C: own work' }); }, { pool: mem.pool, ttlMs: 5000 });
    assert.equal(JSON.parse((await row('.aqua-s3-newfence.json', `o:${o}`)).data).data, 'C: own work');
  });

  test('a timer created inside the operation fires after it ended: its write carries the operation\'s fence (lands while valid; refused after an acquisition)', async () => {
    const S = ownerStore('.aqua-s3-timer.json');
    const o = owner(), o2 = owner();
    const fired = [];
    await L.withConnectLease(o, async () => { setTimeout(() => { S.set(o, { t: Date.now(), data: 'timer write' }); fired.push(1); }, 300); }, { pool: mem.pool, ttlMs: 5000 });
    await L.withConnectLease(o2, async () => { setTimeout(() => { S.set(o2, { t: Date.now(), data: 'timer write' }); fired.push(2); }, 300); }, { pool: mem.pool, ttlMs: 5000 });
    const b = L.createOwnerLease(o2, { pool: mem.pool, ttlMs: 5000 });
    await b.acquire({ waitMs: 0 });                      // o2 taken over before its timer fires
    await sleep(450);
    assert.deepEqual(fired.sort(), [1, 2]);
    await S.binding.flush();
    assert.equal(JSON.parse((await row('.aqua-s3-timer.json', `o:${o}`)).data).data, 'timer write');
    assert.equal(await row('.aqua-s3-timer.json', `o:${o2}`), null, 'a timer of a superseded operation wrote');
    await b.release();
  });

  test('the origin is fixed at CREATION: a plain change flushed from inside an operation gains no authority over external items', async () => {
    const S = keyedStore('.aqua-s3-origin.json', { external: id => String(id).startsWith('ext_') });
    const o = owner();
    const key = `${o}#bag`;
    await L.withConnectLease(o, async () => { S.set(key, { ext_1: { v: 1 } }); }, { pool: mem.pool, ttlMs: 5000 });
    S.set(key, { ext_1: { v: 2 }, ext_2: { v: 1 }, note: { v: 'plain' } });   // plain: an external update + addition, and a plain item
    await L.withConnectLease(o, async () => { await S.binding.flushOnly(new Set([key])); }, { pool: mem.pool, ttlMs: 5000 });
    const stored = JSON.parse((await row('.aqua-s3-origin.json', `k:${key}`)).data);
    assert.deepEqual(stored.ext_1, { v: 1 }, 'a plain external UPDATE landed because the flush ran inside an operation');
    assert.equal(stored.ext_2, undefined, 'a plain external ADDITION landed');
    assert.deepEqual(stored.note, { v: 'plain' }, 'the unrelated non-external change was lost');
  });

  test('no database row yet: a plain FIRST write adds no external item; its non-external content lands (and work of an operation does add it)', async () => {
    const S = keyedStore('.aqua-s3-firstwrite.json', { external: id => String(id).startsWith('ext_') });
    const o = owner(), o2 = owner();
    S.set(`${o}#bag`, { ext_1: { v: 1 }, note: { v: 'plain' } });
    await S.binding.flush();
    const stored = JSON.parse((await row('.aqua-s3-firstwrite.json', `k:${o}#bag`)).data);
    assert.equal(stored.ext_1, undefined, 'a plain first write created an external item');
    assert.deepEqual(stored.note, { v: 'plain' });
    await L.withConnectLease(o2, async () => { S.set(`${o2}#bag`, { ext_1: { v: 1 } }); }, { pool: mem.pool, ttlMs: 5000 });
    assert.deepEqual(JSON.parse((await row('.aqua-s3-firstwrite.json', `k:${o2}#bag`)).data).ext_1, { v: 1 });
  });

  test('a pending write mixing a LOST operation\'s work with unrelated plain changes: the plain changes persist, the external changes are refused', async () => {
    const S = keyedStore('.aqua-s3-mixed.json', { external: id => String(id).startsWith('ext_') });
    const o = owner();
    const key = `${o}#bag`;
    S.set(key, { ext_0: { v: 0 }, note: { v: 0 } });
    await S.binding.flush();                             // a plain row exists (its ext_0 was an unfenced addition: stripped)
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 1000 });
    await a.acquire({ waitMs: 0 });
    const fence = fenceFor(o, a);
    as(fence, () => S.set(key, { ...S.map.get(key), ext_1: { v: 'from the lost operation' } }));
    S.set(key, { ...S.map.get(key), note: { v: 'unrelated plain change' } });
    WF.invalidateFence(fence, new WF.FenceLostError(o, 'test: lost'));
    await S.binding.flush();
    const stored = JSON.parse((await row('.aqua-s3-mixed.json', `k:${key}`)).data);
    assert.equal(stored.ext_1, undefined, 'the lost operation\'s external change landed');
    assert.deepEqual(stored.note, { v: 'unrelated plain change' }, 'an unrelated non-external write was discarded');
  });

  test('a LOST fence stays lost even while its lease row would still prove it (e.g. the final flush failed)', async () => {
    const S = ownerStore('.aqua-s3-permanent.json');
    const o = owner();
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 5000 });
    await a.acquire({ waitMs: 0 });                      // the lease row names this token and is live
    const fence = fenceFor(o, a);
    WF.invalidateFence(fence, new WF.FenceLostError(o, 'test: ownership of pending writes could not be proven'));
    as(fence, () => S.set(o, { t: Date.now(), data: 'work of a lost operation' }));
    await S.binding.flush();
    assert.equal(await row('.aqua-s3-permanent.json', `o:${o}`), null, 'a lost fence was re-validated by the database');
    // …and a DIRECT repository write of its work (e.g. a commit()) is refused too.
    await assert.rejects(as(fence, () => repo.put('.aqua-s3-permanent.json', `d:${o}`, '{"v":1}', { ownerId: o, expectedVersion: 0 })), e => e.code === 'WRITE_FENCE_LOST');
    assert.equal(await row('.aqua-s3-permanent.json', `d:${o}`), null);
    await a.release();
  });

  test('mixed with a LOST operation\'s work, another VALID operation\'s fence does not authorise it (plain part persists; the valid operation is told)', async () => {
    const S = keyedStore('.aqua-s3-mixed2.json', { external: id => String(id).startsWith('ext_') });
    const o = owner();
    const key = `${o}#bag`;
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 1000 });
    await a.acquire({ waitMs: 0 });
    const fenceA = fenceFor(o, a);
    WF.invalidateFence(fenceA, new WF.FenceLostError(o, 'test: lost'));
    await a.release();
    const b = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 5000 });
    await b.acquire({ waitMs: 0 });
    const fenceB = fenceFor(o, b);
    as(fenceA, () => S.set(key, { ext_a: { v: 'from the LOST operation' } }));
    as(fenceB, () => S.set(key, { ...S.map.get(key), ext_b: { v: 'from the valid operation' } }));
    S.set(key, { ...S.map.get(key), note: { v: 'plain' } });
    await assert.rejects(S.binding.flushOnly(new Set([key])), e => e.code === 'WRITE_FENCE_LOST', 'the valid operation must learn its external changes were refused');
    const stored = JSON.parse((await row('.aqua-s3-mixed2.json', `k:${key}`)).data);
    assert.equal(stored.ext_a, undefined, 'a lost operation\'s external change landed under another operation\'s fence');
    assert.deepEqual(stored.note, { v: 'plain' });
    await b.release();
  });

  test('owner store: a write mixing a lost operation\'s work with an unrelated plain change keeps the plain change', async () => {
    const S = ownerStore('.aqua-s3-mixed-owner.json');
    const o = owner();
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 1000 });
    await a.acquire({ waitMs: 0 });
    const fence = fenceFor(o, a);
    as(fence, () => S.set(o, { t: Date.now(), data: 'operation work' }));
    S.set(o, { t: Date.now(), data: 'unrelated plain change', plain: true });
    WF.invalidateFence(fence, new WF.FenceLostError(o, 'test: lost'));
    await S.binding.flush();
    const stored = JSON.parse((await row('.aqua-s3-mixed-owner.json', `o:${o}`))?.data ?? 'null');
    assert.equal(stored?.plain, true, 'an unrelated plain change was discarded with the lost operation\'s work');
    await a.release();
  });

  test('a fence found lost only INSIDE the write transaction: the plain part still persists, the external part is refused', async () => {
    const S = keyedStore('.aqua-s3-intx.json', { external: id => String(id).startsWith('ext_') });
    const o = owner();
    const key = `${o}#bag`;
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 1000 });
    await a.acquire({ waitMs: 0 });
    const fence = fenceFor(o, a);
    const b = await takeover(o, 1000);                   // nobody in this process knows yet
    assert.equal(fence.lost, null);
    as(fence, () => S.set(key, { ext_1: { v: 'stale external' } }));
    S.set(key, { ...S.map.get(key), note: { v: 'plain' } });
    await S.binding.flush();
    const stored = JSON.parse((await row('.aqua-s3-intx.json', `k:${key}`)).data);
    assert.equal(stored.ext_1, undefined);
    assert.deepEqual(stored.note, { v: 'plain' }, 'the plain part was discarded with the refused origin');
    assert.ok(fence.lost, 'the failed proof did not lose the fence');
    await b.release();
  });

  test('shutdown flush (flushOwnerBindings) carries the original origins: a superseded operation\'s pending write is refused', async () => {
    const S = ownerStore('.aqua-s3-shutdown.json');
    const o = owner();
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 1000 });
    await a.acquire({ waitMs: 0 });
    const fence = fenceFor(o, a);
    const b = await takeover(o, 1000);
    as(fence, () => S.set(o, { t: Date.now(), data: 'pending at shutdown' }));   // still pending (debounce not yet fired)
    await OB.flushOwnerBindings(5_000);
    assert.equal(await row('.aqua-s3-shutdown.json', `o:${o}`), null);
    await b.release();
  });

  test('a rejected write is never retried under a new fence', async () => {
    const S = ownerStore('.aqua-s3-noretry.json');
    const o = owner();
    const a = L.createOwnerLease(o, { pool: mem.pool, ttlMs: 1000 });
    await a.acquire({ waitMs: 0 });
    const fence = fenceFor(o, a);
    const b = await takeover(o, 1000);
    as(fence, () => S.set(o, { t: Date.now(), data: 'rejected' }));
    await S.binding.flush();
    await b.release();
    await L.withConnectLease(o, async () => { await S.binding.flushOnly(new Set([o])).catch(() => {}); }, { pool: mem.pool, ttlMs: 5000 });
    assert.equal(await row('.aqua-s3-noretry.json', `o:${o}`), null, 'a rejected write was replayed under a later fence');
    assert.equal(S.binding.isDirty(o), false);
  });
});
