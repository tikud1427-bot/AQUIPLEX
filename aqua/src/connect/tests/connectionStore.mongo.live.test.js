/**
 * MG-1 — the MongoDB connection store against a REAL, DISPOSABLE, LOCAL MongoDB.
 *
 * Verifies the CURRENT design (connectionStore.js, "ONE DOCUMENT PER OWNER"):
 * every connection of an owner lives in ONE document of `aqua_connection_sets`
 *   { _id: ownerId, ownerId, deleted, deletedAt, fenceEpoch, fenceToken, connections: { <id>: record }, updatedAt }
 * and every write is one conditional single-document operation:
 *   FENCE = fenceEpoch < E  OR  (fenceEpoch = E AND fenceToken = T); no epoch at all never matches.
 * An account purge turns the document into a permanent TOMBSTONE (deleted: true,
 * connections: {}) and clears the legacy per-connection collection `aqua_connections`.
 * (2026-11-22: rewritten from the per-connection version committed in G0, which read
 * the legacy collection the store no longer writes.)
 *
 * SKIPPED unless MG1_DISPOSABLE_MONGO_URI is set. Safety rails (all enforced
 * before connecting):
 *   · host must be 127.0.0.1, ::1 or localhost — never a remote / Atlas / production host
 *   · the database name must start with "aqua_disposable_"
 *   · a SEPARATE mongoose instance is used (the platform's default connection is never touched)
 *   · the database must be EMPTY at start (refuses to run against anything that holds data)
 *   · only fake owners, fake ids and fake envelopes are written
 *   · the whole database is dropped at the end
 *
 * Example (aqua-test-mongo container):
 *   MG1_DISPOSABLE_MONGO_URI="mongodb://127.0.0.1:57017/aqua_disposable_g2a" \
 *     node scripts/run-tests.mjs src/connect/tests/connectionStore.mongo.live.test.js
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const URI = process.env.MG1_DISPOSABLE_MONGO_URI || '';

function refusal(uri) {
  if (!uri) return 'MG1_DISPOSABLE_MONGO_URI not set (no disposable local MongoDB)';
  let u;
  try { u = new URL(uri); } catch { return 'MG1_DISPOSABLE_MONGO_URI is not a URL'; }
  if (u.protocol !== 'mongodb:') return 'only mongodb:// (no +srv / remote clusters)';
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return `refusing non-local host ${u.hostname}`;
  const db = u.pathname.replace(/^\//, '');
  if (!/^aqua_disposable_[a-z0-9_]+$/.test(db)) return 'database name must match aqua_disposable_*';
  return null;
}
const SKIP = refusal(URI);

describe('MG-1 · Mongo connection store (owner documents, fences, tombstones) against a disposable local MongoDB', { skip: SKIP ?? false }, () => {
  let mongoose, inst, store, M, Sets;
  const id = n => 'conn_' + String(n).padStart(20, '0');
  const envelope = { v: 1, alg: 'aes-256-gcm', keyId: 'k'.repeat(16), iv: 'aaaaaaaaaaaaaaaa', tag: 'bbbbbbbbbbbbbbbbbbbbbb==', ct: 'Y3Q=' };
  const envelope2 = { v: 1, alg: 'aes-256-gcm', keyId: 'n'.repeat(16), iv: 'cccccccccccccccc', tag: 'dddddddddddddddddddddd==', ct: 'bmV3' };
  const doc = (n, owner, extra = {}) => ({
    connectionId: id(n), ownerId: owner, connectorId: 'fake', connectorVersion: '1.0.0', sourceId: `fake:${id(n)}`,
    status: 'active', account: { label: 'Fake account', externalAccountHash: 'h'.repeat(24) }, scopes: ['fake.read'],
    credentials: envelope, credentialsExpireAt: 1, checkpoint: null, lastSync: null, syncCount: 0, ...extra,
  });
  const F = (epoch, token, previousEpoch = null) => ({ epoch, token, previousEpoch });
  const raw = owner => Sets.findOne({ _id: owner });
  const code = c => e => e?.code === c;

  before(async () => {
    mongoose = (await import('mongoose')).default;
    inst = new mongoose.Mongoose();
    await inst.connect(URI, { serverSelectionTimeoutMS: 3000 });
    const existing = await inst.connection.db.listCollections().toArray();
    if (existing.length) throw new Error(`refusing: disposable database is not empty (${existing.length} collections)`);
    const { createMongoConnectionStore, _connectionModelForTests } = await import('../connectionStore.js');
    store = createMongoConnectionStore({ mongoose: inst });
    M = await _connectionModelForTests(inst);        // the LEGACY per-connection collection (purge-only)
    await M.init();
    Sets = inst.connection.db.collection('aqua_connection_sets');
  });
  after(async () => {
    if (inst?.connection?.readyState === 1) {
      await inst.connection.db.dropDatabase();
      await inst.disconnect();
    }
  });

  // ── 1 · one owner document, many connections ─────────────────────────────
  test('1 · several connections of one owner live in ONE document of aqua_connection_sets; nothing in the legacy collection', async () => {
    const o = 'user:mg1-one';
    for (const n of [1, 2, 3]) await store.create(doc(n, o), { fence: F(100, 'tok-a') });
    const d = await raw(o);
    assert.equal(d._id, o);
    assert.equal(d.ownerId, o);
    assert.equal(d.deleted, false);
    assert.deepEqual(Object.keys(d.connections).sort(), [id(1), id(2), id(3)]);
    assert.equal(await Sets.countDocuments({ _id: o }), 1);
    assert.equal(await M.countDocuments({}), 0, 'the legacy per-connection collection is never written');
    assert.deepEqual((await store.listByOwner(o)).map(c => c.connectionId).sort(), [id(1), id(2), id(3)]);
    assert.deepEqual(await store.ownerState(o), { exists: true, deleted: false, connections: 3 });
    assert.equal(await store.countByOwner(o), 3);
  });

  test('1b · a duplicate connection id within the owner is refused (DUPLICATE) and changes nothing', async () => {
    const o = 'user:mg1-one';
    const before = await raw(o);
    await assert.rejects(store.create(doc(2, o, { syncCount: 99 }), { fence: F(100, 'tok-a') }), code('DUPLICATE'));
    assert.deepEqual((await raw(o)).connections[id(2)], before.connections[id(2)]);
  });

  // ── 2 · create / update / remove individual connections ──────────────────
  test('2 · create → get round trip keeps Mixed fields; readers see the owner\'s epoch/token on each record', async () => {
    const o = 'user:mg1-mixed';
    const full = { cursor: 'p2', startedAt: '2026-11-18T09:00:00.000Z', runs: 2, seenHeld: ['a', 'b'] };
    const pending = { key: 'k'.repeat(32), ids: ['x', 'y', 'z'], origin: 'full', count: 3, held: 4, firstSeenAt: '2026-11-18T09:00:00.000Z' };
    const got = await store.create(doc(10, o, { checkpoint: { seq: 7 }, fullSync: full, pendingDeletion: pending, lastSync: { state: 'partial', counts: { listed: 2 } } }), { fence: F(50, 'tok-m') });
    assert.deepEqual(got.fullSync, full);
    assert.deepEqual(got.pendingDeletion, pending);
    assert.deepEqual(got.checkpoint, { seq: 7 });
    assert.equal(got.lastSync.counts.listed, 2);
    assert.equal(got._id, undefined);
    assert.equal(got.fenceEpoch, 50);
    assert.equal(got.fenceToken, 'tok-m');
    assert.deepEqual(await store.get(o, id(10)), got);
  });

  test('2b · update changes ONE record and returns it post-update; the siblings are byte-for-byte untouched', async () => {
    const o = 'user:mg1-one';
    const before = await raw(o);
    const after = await store.update(o, id(2), { status: 'needs_reauth', syncCount: 5 }, { fence: F(100, 'tok-a') });
    assert.equal(after.status, 'needs_reauth');
    assert.equal(after.syncCount, 5);
    const d = await raw(o);
    assert.deepEqual(d.connections[id(1)], before.connections[id(1)]);
    assert.deepEqual(d.connections[id(3)], before.connections[id(3)]);
    assert.ok(d.connections[id(2)].updatedAt >= before.connections[id(2)].updatedAt);
    assert.equal(await store.update(o, id(999), { status: 'active' }, { fence: F(100, 'tok-a') }), null, 'missing id → null');
  });

  test('2c · $set null clears fullSync, pendingDeletion and the credential envelope of that record only', async () => {
    const o = 'user:mg1-mixed';
    await store.update(o, id(10), { fullSync: null, pendingDeletion: null, credentials: null, credentialsExpireAt: null }, { fence: F(50, 'tok-m') });
    const r = (await raw(o)).connections[id(10)];
    assert.equal(r.fullSync, null);
    assert.equal(r.pendingDeletion, null);
    assert.equal(r.credentials, null, 'the envelope was not cleared');
    assert.equal(r.credentialsExpireAt, null);
  });

  test('2d · remove deletes ONE record ($unset); the document and the other records stay; a second remove is false', async () => {
    const o = 'user:mg1-one';
    assert.equal(await store.remove(o, id(3), { fence: F(100, 'tok-a') }), true);
    const d = await raw(o);
    assert.deepEqual(Object.keys(d.connections).sort(), [id(1), id(2)]);
    assert.equal(d.deleted, false);
    assert.equal(await store.remove(o, id(3), { fence: F(100, 'tok-a') }), false);
    assert.equal(await store.get(o, id(3)), null);
  });

  // ── 3 · credential envelope preservation ─────────────────────────────────
  test('3 · the sealed envelope is stored and returned exactly; a rotation (new envelope) replaces it exactly', async () => {
    const o = 'user:mg1-one';
    assert.deepEqual((await raw(o)).connections[id(1)].credentials, envelope);
    assert.deepEqual((await store.get(o, id(1))).credentials, envelope);
    await store.update(o, id(1), { credentials: envelope2 }, { fence: F(100, 'tok-a') });
    assert.deepEqual((await raw(o)).connections[id(1)].credentials, envelope2);
    assert.deepEqual((await store.get(o, id(1))).credentials, envelope2);
  });

  test('3b · strict schema: plaintext credential fields and unknown paths never reach the document (create and update)', async () => {
    const o = 'user:mg1-strict';
    await store.create(doc(20, o, { notInSchema: 'x', credentials: { ...envelope, accessToken: 'plain-SECRETVALUE' } }), { fence: F(10, 'tok-s') });
    await store.update(o, id(20), { alsoNot: 'y', credentials: { ...envelope2, refreshToken: 'plain-SECRETVALUE' } }, { fence: F(10, 'tok-s') });
    const d = await raw(o);
    assert.ok(!JSON.stringify(d).includes('SECRETVALUE'), 'plaintext stored');
    assert.equal(d.connections[id(20)].notInSchema, undefined);
    assert.equal(d.connections[id(20)].alsoNot, undefined);
    assert.deepEqual(d.connections[id(20)].credentials, envelope2);
  });

  test('3c · schema enforcement: an unknown status is refused on create AND on update (INVALID_RECORD); the stored record is unchanged', async () => {
    const o = 'user:mg1-strict';
    await assert.rejects(store.create(doc(21, o, { status: 'hacked' }), { fence: F(10, 'tok-s') }), code('INVALID_RECORD'));
    const before = (await raw(o)).connections[id(20)];
    await assert.rejects(store.update(o, id(20), { status: 'hacked' }, { fence: F(10, 'tok-s') }), code('INVALID_RECORD'));
    assert.deepEqual((await raw(o)).connections[id(20)], before);
    assert.equal((await raw(o)).connections[id(21)], undefined);
  });

  // ── 4 · fence epoch and token ────────────────────────────────────────────
  test('4 · a fenced write stamps (epoch, token) on the owner document', async () => {
    const d = await raw('user:mg1-one');
    assert.equal(d.fenceEpoch, 100);
    assert.equal(d.fenceToken, 'tok-a');
  });

  test('4b · stamp raises the epoch only upward; a lower or equal stamp changes nothing', async () => {
    const o = 'user:mg1-fence';
    await store.create(doc(30, o), { fence: F(200, 'tok-1') });
    assert.equal(await store.stamp(o, F(300, 'tok-2', 200)), 1);
    assert.deepEqual([(await raw(o)).fenceEpoch, (await raw(o)).fenceToken], [300, 'tok-2']);
    assert.equal(await store.stamp(o, F(250, 'tok-old')), 0);
    assert.equal(await store.stamp(o, F(300, 'tok-other')), 0, 'equal epoch, other token');
    assert.deepEqual([(await raw(o)).fenceEpoch, (await raw(o)).fenceToken], [300, 'tok-2']);
    await assert.rejects(store.stamp(o, null), code('FENCE_INVALID'));
  });

  test('4c · malformed fences are refused before any write', async () => {
    const o = 'user:mg1-fence';
    for (const bad of [{ epoch: 0, token: 't' }, { epoch: -1, token: 't' }, { epoch: 1.5, token: 't' }, { epoch: 400, token: '' }, { epoch: 400 }, { epoch: 400, token: 't', previousEpoch: 400 }]) {
      await assert.rejects(store.update(o, id(30), { syncCount: 9 }, { fence: bad }), code('FENCE_INVALID'), JSON.stringify(bad));
    }
    assert.equal((await raw(o)).connections[id(30)].syncCount, 0);
  });

  // ── 5 · conditional writes, stale-write rejection ────────────────────────
  test('5 · same epoch + same token passes; same epoch + another token, or an OLDER epoch, is FENCE_STALE and writes nothing', async () => {
    const o = 'user:mg1-fence';
    assert.equal((await store.update(o, id(30), { syncCount: 1 }, { fence: F(300, 'tok-2') })).syncCount, 1);
    const before = await raw(o);
    await assert.rejects(store.update(o, id(30), { syncCount: 2 }, { fence: F(300, 'tok-intruder') }), code('FENCE_STALE'));
    await assert.rejects(store.update(o, id(30), { syncCount: 3 }, { fence: F(299, 'tok-older') }), code('FENCE_STALE'));
    await assert.rejects(store.remove(o, id(30), { fence: F(299, 'tok-older') }), code('FENCE_STALE'));
    await assert.rejects(store.create(doc(31, o), { fence: F(299, 'tok-older') }), code('FENCE_STALE'), 'a delayed insert of an older operation');
    const after = await raw(o);
    assert.deepEqual(after.connections, before.connections);
    assert.deepEqual([after.fenceEpoch, after.fenceToken], [300, 'tok-2']);
  });

  test('5b · a NEWER epoch takes over: its write passes and moves the fence; the previous holder is then stale', async () => {
    const o = 'user:mg1-fence';
    assert.equal((await store.update(o, id(30), { syncCount: 4 }, { fence: F(400, 'tok-3', 300) })).syncCount, 4);
    assert.deepEqual([(await raw(o)).fenceEpoch, (await raw(o)).fenceToken], [400, 'tok-3']);
    await assert.rejects(store.update(o, id(30), { syncCount: 5 }, { fence: F(300, 'tok-2') }), code('FENCE_STALE'));
    assert.equal((await raw(o)).connections[id(30)].syncCount, 4);
  });

  test('5c · recorded design: a document that never carried an epoch is NEVER matched by a fenced write or stamp (fail closed)', async () => {
    const o = 'user:mg1-unfenced';
    await store.create(doc(40, o));                                         // unfenced: local mode
    assert.equal((await raw(o)).fenceEpoch, null, 'the schema default: no epoch');
    assert.equal(await store.stamp(o, F(10, 'tok-x')), 0);
    await assert.rejects(store.update(o, id(40), { syncCount: 1 }, { fence: F(10, 'tok-x') }), code('FENCE_STALE'));
    assert.equal((await raw(o)).connections[id(40)].syncCount, 0);
    console.log('[MG1] recorded: an owner document created unfenced (local mode) cannot be stamped later; lease mode refuses it (FENCE_STALE)');
  });

  test('5d · concurrent fenced writers of two epochs: exactly the newer one wins, whatever the order', async () => {
    const o = 'user:mg1-race';
    await store.create(doc(50, o), { fence: F(1000, 't0') });
    const results = await Promise.allSettled([
      store.update(o, id(50), { syncCount: 11 }, { fence: F(1001, 't1', 1000) }),
      store.update(o, id(50), { syncCount: 22 }, { fence: F(1002, 't2', 1001) }),
    ]);
    const d = await raw(o);
    assert.deepEqual([d.fenceEpoch, d.fenceToken], [1002, 't2']);
    assert.equal(d.connections[id(50)].syncCount, 22, 'the newer epoch\'s value stands');
    assert.equal(results[1].status, 'fulfilled');
    if (results[0].status === 'rejected') assert.equal(results[0].reason.code, 'FENCE_STALE');
  });

  // ── 6 · permanent tombstones ─────────────────────────────────────────────
  test('6 · purge: ONE atomic step empties the document and leaves a TOMBSTONE; readers see nothing', async () => {
    const o = 'user:mg1-purge';
    for (const n of [60, 61]) await store.create(doc(n, o), { fence: F(500, 'tok-p') });
    assert.equal(await store.purgeOwner(o), 2);
    const d = await raw(o);
    assert.equal(d.deleted, true);
    assert.equal(typeof d.deletedAt, 'number');
    assert.deepEqual(d.connections, {});
    assert.ok(!JSON.stringify(d).includes(envelope.ct), 'no envelope remains in the tombstone');
    assert.equal(await store.get(o, id(60)), null);
    assert.deepEqual(await store.listByOwner(o), []);
    assert.deepEqual(await store.ownerState(o), { exists: true, deleted: true, connections: 0 });
    assert.equal(await store.countByOwner(o), 0);
  });

  test('6b · the tombstone is permanent: no write of any kind (fenced, newer epoch, unfenced) revives it; a repeated purge is idempotent', async () => {
    const o = 'user:mg1-purge';
    await assert.rejects(store.create(doc(62, o), { fence: F(9_999, 'tok-new') }), code('OWNER_DELETED'));
    await assert.rejects(store.create(doc(62, o)), code('OWNER_DELETED'));
    assert.equal(await store.update(o, id(60), { status: 'active' }, { fence: F(9_999, 'tok-new') }), null);
    assert.equal(await store.update(o, id(60), { status: 'active' }), null);
    assert.equal(await store.remove(o, id(60), { fence: F(9_999, 'tok-new') }), false);
    assert.equal(await store.stamp(o, F(9_999, 'tok-new')), 0);
    assert.equal(await store.purgeOwner(o), 0, 'nothing left to purge');
    const d = await raw(o);
    assert.equal(d.deleted, true);
    assert.deepEqual(d.connections, {});
    assert.equal(await Sets.countDocuments({ _id: o }), 1, 'still exactly one (tombstone) document');
  });

  // ── 7 · delayed creation after purge ─────────────────────────────────────
  test('7 · an owner purged BEFORE it ever had a document gets a tombstone; a delayed first insert is refused', async () => {
    const o = 'user:mg1-never';
    assert.equal(await raw(o), null);
    assert.equal(await store.purgeOwner(o), 0);
    assert.equal((await raw(o)).deleted, true);
    await assert.rejects(store.create(doc(70, o), { fence: F(1, 'tok-late') }), code('OWNER_DELETED'));
    await assert.rejects(store.create(doc(70, o)), code('OWNER_DELETED'));
    assert.deepEqual((await raw(o)).connections, {});
  });

  test('7b · a create issued with the PRE-purge fence (an operation in flight when the account was deleted) writes nothing', async () => {
    const o = 'user:mg1-inflight';
    await store.create(doc(71, o), { fence: F(700, 'tok-op') });
    await store.stamp(o, F(800, 'tok-purge', 700));                          // the purge takes the lease first
    await store.purgeOwner(o);
    await assert.rejects(store.create(doc(72, o), { fence: F(700, 'tok-op') }), code('OWNER_DELETED'));
    await assert.rejects(store.update(o, id(71), { status: 'active' }, { fence: F(700, 'tok-op') }).then(r => { if (r === null) throw Object.assign(new Error('null'), { code: 'NO_RECORD' }); return r; }), code('NO_RECORD'));
    assert.deepEqual((await raw(o)).connections, {});
  });

  // ── 8 · owner isolation ──────────────────────────────────────────────────
  test('8 · get / list / update / remove never cross owners, even with the same connection id', async () => {
    const a = 'user:mg1-iso-a', b = 'user:mg1-iso-b';
    await store.create(doc(80, a), { fence: F(10, 'tok-ia') });
    await store.create(doc(80, b, { syncCount: 7 }), { fence: F(10, 'tok-ib') });   // same id, other owner: a separate document
    assert.equal((await store.get(a, id(80))).syncCount, 0);
    assert.equal((await store.get(b, id(80))).syncCount, 7);
    assert.equal(await store.update('user:mg1-iso-OTHER', id(80), { syncCount: 1 }), null);
    assert.equal(await store.remove('user:mg1-iso-OTHER', id(80)), false);
    await store.update(a, id(80), { syncCount: 3 }, { fence: F(10, 'tok-ia') });
    assert.equal((await raw(b)).connections[id(80)].syncCount, 7, 'B untouched by A\'s write');
    await store.purgeOwner(a);
    assert.equal((await raw(b)).deleted, false, 'purging A leaves B alive');
    assert.equal((await store.get(b, id(80))).syncCount, 7);
  });

  test('8b · countByConnector counts live owners only (tombstones excluded), with and without a status filter', async () => {
    const all = await Sets.find({ deleted: { $ne: true } }).toArray();
    const expect = (statuses) => all.reduce((n, d) => n + Object.values(d.connections ?? {}).filter(r => r.connectorId === 'fake' && (!statuses || statuses.includes(r.status))).length, 0);
    assert.equal(await store.countByConnector('fake'), expect(null));
    assert.equal(await store.countByConnector('fake', ['needs_reauth']), expect(['needs_reauth']));
    assert.equal(await store.countByConnector('fake', ['needs_reauth']), 1, 'the one record set to needs_reauth in 2b');
    assert.equal(await store.countByConnector('nothing'), 0);
    assert.ok(expect(null) >= 6);
  });

  // ── 9 · legacy collection cleanup ────────────────────────────────────────
  test('9 · purge also deletes the owner\'s records in the LEGACY collection — and only that owner\'s', async () => {
    const o = 'user:mg1-legacy', other = 'user:mg1-legacy-other';
    await M.create(doc(90, o));
    await M.create(doc(91, o));
    await M.create(doc(92, other));
    await store.create(doc(93, o), { fence: F(10, 'tok-l') });
    assert.equal(await store.countByOwner(o), 3, 'physical count = owner-document records + legacy records');
    assert.equal(await store.purgeOwner(o), 3);
    assert.equal(await M.countDocuments({ ownerId: o }), 0);
    assert.equal(await M.countDocuments({ ownerId: other }), 1, 'another owner\'s legacy record is untouched');
    assert.equal(await store.countByOwner(o), 0);
    assert.equal((await raw(o)).deleted, true);
  });

  test('9b · the legacy collection keeps its indexes (unique connectionId; ownerId+connectionId) used by the purge', async () => {
    const idx = await M.collection.indexes();
    assert.ok(idx.some(i => i.unique && i.key.connectionId === 1));
    assert.ok(idx.some(i => i.key.ownerId === 1 && i.key.connectionId === 1));
  });

  // ── server limits / failure behaviour ────────────────────────────────────
  test('10 · an owner document over the 16 MB limit is refused by the server; the records survive', async () => {
    const o = 'user:mg1-one';
    const before = await raw(o);
    await assert.rejects(() => store.update(o, id(2), { checkpoint: { big: 'x'.repeat(17 * 1024 * 1024) } }, { fence: F(100, 'tok-a') }));
    assert.deepEqual((await raw(o)).connections, before.connections);
  });

  test('11 · fails closed when the connection is not open (no buffering)', async () => {
    const { createMongoConnectionStore } = await import('../connectionStore.js');
    const s = createMongoConnectionStore({ mongoose: new mongoose.Mongoose() });
    await assert.rejects(() => s.get('user:mg1-one', id(1)), code('STORE_UNAVAILABLE'));
    await assert.rejects(() => s.create(doc(99, 'user:mg1-x')), code('STORE_UNAVAILABLE'));
  });
});

if (SKIP) {
  test('MG-1 live store tests', { skip: SKIP }, () => {});
}
