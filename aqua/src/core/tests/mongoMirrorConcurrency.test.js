/**
 * Mongo mirror — single authoritative writer + generation CAS (P0 2026-10-12).
 *
 * The incident: a laptop ran the app with the production MONGO_URI next to the
 * Render service. The mirror is whole-file; the heartbeat only DETECTED the
 * second writer ("local and Render writers") and both kept overwriting each
 * other's store files. These tests pin the three layers that replace that:
 *   role (only the deployment writes), lease (one writer among writers),
 *   generation CAS (a moved doc is preserved, never silently overwritten).
 *
 * The fake implements the Mongo semantics the fix relies on, which the older
 * fakes in mongoMirror.test.js do not: filters are honoured ($exists, equality)
 * and an upsert whose filter misses an EXISTING _id raises E11000, exactly as a
 * real server does.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../mongoMirror.js');

function mongoLike() {
  const docs = new Map();
  const matches = (d, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && '$exists' in v) return (d[k] !== undefined) === v.$exists;
    if (v && typeof v === 'object' && '$lt' in v) return d[k] < v.$lt;
    return d[k] === v;
  });
  const col = {
    writes: [],
    find(q = {}) { return { toArray: async () => [...docs.values()].filter(d => matches(d, q)).map(d => ({ ...d })) }; },
    async findOne(q = {}) { const d = [...docs.values()].find(x => matches(x, q)); return d ? { ...d } : null; },
    async updateOne(filter, update, opts = {}) {
      const d = docs.get(filter._id);
      if (d && matches(d, filter)) { docs.set(filter._id, { ...d, ...update.$set }); col.writes.push(filter._id); return { matchedCount: 1 }; }
      if (!opts.upsert) return { matchedCount: 0 };
      if (d) { const e = new Error(`E11000 duplicate key error collection: aqua_kv index: _id_ dup key: { _id: "${filter._id}" }`); e.code = 11000; throw e; }
      docs.set(filter._id, { _id: filter._id, ...update.$set }); col.writes.push(filter._id); return { upsertedCount: 1 };
    },
    async deleteMany(q = {}) { for (const [id, d] of docs) if (matches(d, q)) docs.delete(id); },
    /** Another process writing the way the mirror does (pre-lease code: unconditional). */
    foreignWrite(id, json, writer = 'render-old:1:aaaaaa') { docs.set(id, { _id: id, json, gen: Date.now() * 1000 + 999, updatedAt: Date.now(), writer }); },
    get: id => docs.get(id),
    all: () => [...docs.values()],
  };
  return col;
}

const settle = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) { await mod.__settleForTests(); await new Promise(r => setTimeout(r, 5)); }
};

beforeEach(() => { mod.__resetForTests(); mod.__setRetryDelayForTests(1); });

test('CAS: a write over a doc another writer moved PRESERVES the foreign version, then lands — nothing silently overwritten', async () => {
  const col = mongoLike();
  mod.__setCollectionForTests(col);
  mod.mirrorWrite('/d/.aqua-mind.json', '{"from":"A","v":1}');
  await settle();
  assert.equal(col.get('.aqua-mind.json').json, '{"from":"A","v":1}');

  // Render (pre-lease code) writes its own state of the same store in between.
  col.foreignWrite('.aqua-mind.json', '{"from":"render","v":7}');

  mod.mirrorWrite('/d/.aqua-mind.json', '{"from":"A","v":2}');
  await settle();

  const preserved = col.all().filter(d => d.conflict && d.of === '.aqua-mind.json');
  assert.equal(preserved.length, 1, 'the overwritten generation is kept');
  assert.equal(preserved[0].json, '{"from":"render","v":7}', 'the OTHER writer\'s data survives');
  assert.equal(preserved[0].writer, 'render-old:1:aaaaaa');
  assert.equal(col.get('.aqua-mind.json').json, '{"from":"A","v":2}');
  const st = mod.getMirrorStatus();
  assert.equal(st.writeConflicts, 1);
  assert.equal(st.lastConflict.filename, '.aqua-mind.json');
});

test('CAS: without interference there are no conflicts and no preserved copies', async () => {
  const col = mongoLike();
  mod.__setCollectionForTests(col);
  for (let v = 1; v <= 5; v++) { mod.mirrorWrite('/d/.aqua-ledger.json', `{"v":${v}}`); await settle(); }
  assert.equal(col.get('.aqua-ledger.json').json, '{"v":5}');
  assert.equal(col.all().filter(d => d.conflict).length, 0);
  assert.equal(mod.getMirrorStatus().writeConflicts, 0);
});

test('CAS: a first write never clobbers a doc that appeared after hydration (insert-only filter)', async () => {
  const col = mongoLike();
  mod.__setCollectionForTests(col);
  col.foreignWrite('.aqua-history.json', '{"render":"conversations"}');   // not seen at hydration
  mod.mirrorWrite('/d/.aqua-history.json', '{"laptop":"stale"}');
  await settle();
  assert.equal(col.all().find(d => d.conflict && d.of === '.aqua-history.json')?.json, '{"render":"conversations"}');
});

test('CAS: hydration records the generation, so a write after a foreign update conflicts', async () => {
  const col = mongoLike();
  col.foreignWrite('.aqua-graph.json', '{"g":1}');
  mod.__setCollectionForTests(col);
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-cas-'));
  await mod.hydrateFromMongo(dir);
  assert.equal(fs.readFileSync(path.join(dir, '.aqua-graph.json'), 'utf8'), '{"g":1}');
  col.foreignWrite('.aqua-graph.json', '{"g":2,"render":"newer"}');
  mod.mirrorWrite(path.join(dir, '.aqua-graph.json'), '{"g":1,"laptop":"edit"}');
  await settle();
  assert.equal(col.all().find(d => d.conflict)?.json, '{"g":2,"render":"newer"}');
});

test('hydration skips preserved conflict docs (they are not live stores)', async () => {
  const col = mongoLike();
  mod.__setCollectionForTests(col);
  await col.updateOne({ _id: 'conflict/.aqua-mind.json/1' }, { $set: { conflict: true, of: '.aqua-mind.json', json: '{}' } }, { upsert: true });
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-skip-'));
  const r = await mod.hydrateFromMongo(dir);
  assert.equal(r.total, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('ROLE: a reader (any host that is not the deployment) never writes the shared mirror', async () => {
  const col = mongoLike();
  mod.__setCollectionForTests(col, { role: 'reader' });
  await mod.__heartbeatOnceForTests();
  mod.mirrorWrite('/d/.aqua-mind.json', '{"laptop":true}');
  await settle();
  assert.equal(col.writes.length, 0, 'no data doc, no lock stamp');
  assert.equal(col.get('.aqua-mirror-writer'), undefined);
  assert.match(mod.getMirrorStatus().verdict, /READ-ONLY/);
});

test('LEASE: a writer defers to another lease-holder; writes queue (not dropped, not written) and land once the lease expires', async () => {
  const col = mongoLike();
  mod.__setCollectionForTests(col, { role: 'writer', leader: false });
  const now = Date.now();
  await col.updateOne({ _id: '.aqua-mirror-writer' }, { $set: { instanceId: 'srv-render:7:bbbbbb', leaseOf: 'srv-render:7:bbbbbb', ts: now, render: true } }, { upsert: true });

  await mod.__heartbeatOnceForTests();
  assert.equal(mod.getMirrorStatus().leader, false);
  mod.mirrorWrite('/d/.aqua-mind.json', '{"mine":1}');
  await settle();
  assert.equal(col.get('.aqua-mind.json'), undefined, 'standby must not write');
  assert.equal(mod.getMirrorStatus().pending, 1, 'payload kept, not dropped');
  assert.match(mod.getMirrorStatus().verdict, /STANDBY/);

  // The holder stops renewing (died / scaled down) — past the TTL we take over.
  const lock = col.get('.aqua-mirror-writer');
  await col.updateOne({ _id: '.aqua-mirror-writer' }, { $set: { ts: lock.ts - mod.__leaseTtlForTests() - 1 } });
  await mod.__heartbeatOnceForTests();
  await settle();
  assert.equal(mod.getMirrorStatus().leader, true);
  assert.equal(col.get('.aqua-mirror-writer').instanceId, mod.__instanceIdForTests());
  assert.equal(col.get('.aqua-mind.json').json, '{"mine":1}', 'queued payload flushed on takeover');
});

test('LEASE: two writers racing for a free lease — exactly one wins', async () => {
  const col = mongoLike();
  mod.__setCollectionForTests(col, { role: 'writer', leader: false });
  // Between our read of the (absent) lock and our claim, another writer claims it.
  const realFindOne = col.findOne;
  col.findOne = async q => {
    const r = await realFindOne(q);
    if (q._id === '.aqua-mirror-writer') await col.updateOne({ _id: '.aqua-mirror-writer' }, { $set: { instanceId: 'other:2:cccccc', leaseOf: 'other:2:cccccc', ts: Date.now() } }, { upsert: true });
    return r;
  };
  await mod.__heartbeatOnceForTests();
  col.findOne = realFindOne;
  assert.equal(mod.getMirrorStatus().leader, false, 'the late claimant lost the CAS');
  assert.equal(col.get('.aqua-mirror-writer').instanceId, 'other:2:cccccc');
});

test('LEASE: SIGTERM drain releases the lease so the successor takes over immediately', async () => {
  const col = mongoLike();
  mod.__setCollectionForTests(col, { role: 'writer', leader: false });
  await mod.__heartbeatOnceForTests();
  assert.equal(mod.getMirrorStatus().leader, true);
  await mod.drainMirror(100);
  assert.equal(col.get('.aqua-mirror-writer').ts, 0, 'released');
});

test('LEASE: sibling processes on the SAME host (server + worker) share the lease — both write, no alarm', async () => {
  // Found by driving the real launcher: start-production.mjs runs server and
  // worker side by side; a per-process lease left the worker STANDBY forever,
  // so nothing it wrote would have reached the mirror.
  const os = await import('node:os');
  const col = mongoLike();
  mod.__setCollectionForTests(col, { role: 'writer', leader: false });
  const sibling = `${os.hostname()}:99999:dddddd`;
  await col.updateOne({ _id: '.aqua-mirror-writer' }, { $set: { instanceId: sibling, leaseOf: sibling, ts: Date.now(), host: os.hostname() } }, { upsert: true });
  for (let i = 0; i < 4; i++) {
    await mod.__heartbeatOnceForTests();
    await col.updateOne({ _id: '.aqua-mirror-writer' }, { $set: { instanceId: sibling, ts: Date.now() + 1 } });   // the sibling keeps renewing
  }
  const st = mod.getMirrorStatus();
  assert.equal(st.leader, true, 'a sibling on the same host is not a rival');
  assert.equal(st.multiWriterConflict, false, 'and is never reported as a second live writer');
  mod.mirrorWrite('/d/.aqua-jobs-ledger.json', '{"worker":1}');
  await settle();
  assert.equal(col.get('.aqua-jobs-ledger.json').json, '{"worker":1}');
});

test('LEASE: a PRE-LEASE writer stamping over our lock is never mistaken for a lease-holder or a sibling', async () => {
  // Pre-lease code $sets only {instanceId, ts}: our leaseOf/host survive its
  // beat. Trusting those fields would make production defer to an old laptop
  // process (standby while the laptop writes) or count it as a sibling.
  const col = mongoLike();
  mod.__setCollectionForTests(col, { role: 'writer', leader: false });
  await mod.__heartbeatOnceForTests();
  assert.equal(mod.getMirrorStatus().leader, true);
  for (let i = 0; i < 3; i++) {
    await col.updateOne({ _id: '.aqua-mirror-writer' }, { $set: { instanceId: 'laptop-old:4242:eeeeee', ts: Date.now() + 1 } });
    await mod.__heartbeatOnceForTests();
    assert.equal(mod.getMirrorStatus().leader, true, 'the deployment keeps writing');
  }
  assert.equal(mod.getMirrorStatus().multiWriterConflict, true, 'and the pre-lease writer is alarmed on');
});

test('CAS: preserved generations are capped per file (newest 3 kept) so repeated conflicts cannot grow the cluster without bound', async () => {
  const col = mongoLike();
  mod.__setCollectionForTests(col);
  for (let i = 1; i <= 6; i++) {
    col.foreignWrite('.aqua-reasoning-graph.json', `{"worker":${i}}`);
    mod.mirrorWrite('/d/.aqua-reasoning-graph.json', `{"server":${i}}`);
    await settle();
    await new Promise(r => setTimeout(r, 3));
  }
  const kept = col.all().filter(d => d.conflict && d.of === '.aqua-reasoning-graph.json').map(d => d.json).sort();
  assert.deepEqual(kept, ['{"worker":4}', '{"worker":5}', '{"worker":6}']);
  assert.equal(mod.getMirrorStatus().writeConflicts, 6, 'every conflict is still counted');
  assert.equal(col.get('.aqua-reasoning-graph.json').json, '{"server":6}');
});
