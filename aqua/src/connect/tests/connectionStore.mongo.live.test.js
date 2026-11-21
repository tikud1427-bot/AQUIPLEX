/**
 * MG-1 — the MongoDB connection store against a REAL, DISPOSABLE, LOCAL MongoDB.
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
 * Example (after a founder-approved local install, see g0/MONGODB_VALIDATION.md):
 *   MG1_DISPOSABLE_MONGO_URI="mongodb://127.0.0.1:27017/aqua_disposable_mg1" \
 *     node --test src/connect/tests/connectionStore.mongo.live.test.js
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

describe('MG-1 · Mongo connection store against a disposable local MongoDB', { skip: SKIP ?? false }, () => {
  let mongoose, inst, store, M;
  const id = n => 'conn_' + String(n).padStart(20, '0');
  const envelope = { v: 1, alg: 'aes-256-gcm', keyId: 'k'.repeat(16), iv: 'aaaaaaaaaaaaaaaa', tag: 'bbbbbbbbbbbbbbbbbbbbbb==', ct: 'Y3Q=' };
  const doc = (n, owner = 'user:mg1-a', extra = {}) => ({
    connectionId: id(n), ownerId: owner, connectorId: 'fake', connectorVersion: '1.0.0', sourceId: `fake:${id(n)}`,
    status: 'active', account: { label: 'Fake account', externalAccountHash: 'h'.repeat(24) }, scopes: ['fake.read'],
    credentials: envelope, credentialsExpireAt: 1, checkpoint: null, lastSync: null, syncCount: 0, ...extra,
  });

  before(async () => {
    mongoose = (await import('mongoose')).default;
    inst = new mongoose.Mongoose();
    await inst.connect(URI, { serverSelectionTimeoutMS: 3000 });
    const existing = await inst.connection.db.listCollections().toArray();
    if (existing.length) throw new Error(`refusing: disposable database is not empty (${existing.length} collections)`);
    const { createMongoConnectionStore, _connectionModelForTests } = await import('../connectionStore.js');
    store = createMongoConnectionStore({ mongoose: inst });
    M = await _connectionModelForTests(inst);
    await M.init();   // build indexes now (unique connectionId)
  });
  after(async () => {
    if (inst?.connection?.readyState === 1) {
      await inst.connection.db.dropDatabase();
      await inst.disconnect();
    }
  });

  test('1 · create → get round trip keeps Mixed fields (nested arrays, null)', async () => {
    const full = { cursor: 'p2', startedAt: '2026-11-18T09:00:00.000Z', runs: 2, seenHeld: ['a', 'b'] };
    const pending = { key: 'k'.repeat(32), ids: ['x', 'y', 'z'], origin: 'full', count: 3, held: 4, firstSeenAt: '2026-11-18T09:00:00.000Z' };
    await store.create(doc(1, 'user:mg1-a', { checkpoint: { seq: 7 }, fullSync: full, pendingDeletion: pending, lastSync: { state: 'partial', counts: { listed: 2 } } }));
    const got = await store.get('user:mg1-a', id(1));
    assert.deepEqual(got.fullSync, full);
    assert.deepEqual(got.pendingDeletion, pending);
    assert.deepEqual(got.checkpoint, { seq: 7 });
    assert.equal(got.lastSync.counts.listed, 2);
    assert.equal(got._id, undefined);
  });

  test('2 · update returns the POST-update document; null for a missing or another owner\'s record', async () => {
    const after = await store.update('user:mg1-a', id(1), { status: 'needs_reauth', syncCount: 5 });
    assert.equal(after.status, 'needs_reauth');
    assert.equal(after.syncCount, 5);
    assert.equal(await store.update('user:mg1-a', id(999), { status: 'active' }), null);
    assert.equal(await store.update('user:mg1-OTHER', id(1), { status: 'active' }), null, 'another owner updated the record');
    assert.equal((await store.get('user:mg1-a', id(1))).status, 'needs_reauth');
  });

  test('3 · $set null clears fullSync, pendingDeletion and the credential envelope', async () => {
    await store.update('user:mg1-a', id(1), { fullSync: null, pendingDeletion: null, credentials: null, credentialsExpireAt: null });
    const raw = await M.findOne({ connectionId: id(1) }).lean();
    assert.equal(raw.fullSync, null);
    assert.equal(raw.pendingDeletion, null);
    assert.equal(raw.credentials, null, 'the envelope sub-document was not cleared');
  });

  test('4 · owner scoping: get / list / remove never cross owners', async () => {
    await store.create(doc(2, 'user:mg1-b'));
    assert.equal(await store.get('user:mg1-b', id(1)), null);
    assert.deepEqual((await store.listByOwner('user:mg1-b')).map(c => c.connectionId), [id(2)]);
    assert.equal(await store.remove('user:mg1-b', id(1)), false);
    assert.ok(await store.get('user:mg1-a', id(1)));
  });

  test('5 · unique connectionId is enforced by the index; the (ownerId, connectionId) index exists', async () => {
    await assert.rejects(() => store.create(doc(1, 'user:mg1-c')), e => e?.code === 11000 || /duplicate key/i.test(String(e?.message)));
    const idx = await M.collection.indexes();
    assert.ok(idx.some(i => i.unique && i.key.connectionId === 1));
    assert.ok(idx.some(i => i.key.ownerId === 1 && i.key.connectionId === 1));
  });

  test('6 · countByConnector with and without a status filter', async () => {
    assert.equal(await store.countByConnector('fake'), 2);
    assert.equal(await store.countByConnector('fake', ['active']), 1);
    assert.equal(await store.countByConnector('nothing'), 0);
  });

  test('7 · MG-2 (recorded behaviour): an unknown status through update — validators do not run on update', async () => {
    let rejected = false;
    try { await store.update('user:mg1-b', id(2), { status: 'hacked' }); } catch { rejected = true; }
    const raw = await M.findOne({ connectionId: id(2) }).lean();
    // Records the CURRENT behaviour so the MG-2 fix (runValidators) is visible when it lands.
    console.log(`[MG1] update with invalid status: rejected=${rejected} stored=${raw.status}`);
    assert.ok(rejected || raw.status === 'hacked');
  });

  test('8 · strict schema drops unknown paths on update; plaintext never reaches the envelope', async () => {
    await store.update('user:mg1-b', id(2), { notInSchema: 'x', credentials: { ...envelope, accessToken: 'plain-SECRETVALUE' } });
    const raw = await M.findOne({ connectionId: id(2) }).lean();
    assert.equal(raw.notInSchema, undefined);
    assert.ok(!JSON.stringify(raw).includes('SECRETVALUE'), 'plaintext stored');
  });

  test('9 · a document over the 16 MB limit is refused by the server (MG-4)', async () => {
    const big = 'x'.repeat(17 * 1024 * 1024);
    await assert.rejects(() => store.update('user:mg1-b', id(2), { checkpoint: { big } }));
    assert.ok(await store.get('user:mg1-b', id(2)), 'the record survives a refused write');
  });

  test('10 · concurrent writers: last writer wins (MG-5 recorded behaviour)', async () => {
    await Promise.all([
      store.update('user:mg1-b', id(2), { syncCount: 1 }),
      store.update('user:mg1-b', id(2), { syncCount: 2 }),
    ]);
    const n = (await store.get('user:mg1-b', id(2))).syncCount;
    assert.ok(n === 1 || n === 2);
  });

  test('11 · fails closed when the connection drops (no buffering)', async () => {
    const { createMongoConnectionStore } = await import('../connectionStore.js');
    const dead = new mongoose.Mongoose();
    const s = createMongoConnectionStore({ mongoose: dead });
    await assert.rejects(() => s.get('user:mg1-a', id(1)), e => e.code === 'STORE_UNAVAILABLE');
  });
});

if (SKIP) {
  test('MG-1 live store tests', { skip: SKIP }, () => {});
}
