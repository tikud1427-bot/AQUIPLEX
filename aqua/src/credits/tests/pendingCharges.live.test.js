/**
 * Phase 4B — pending-charge recovery against REAL Postgres and REAL Mongo.
 *
 * Every transition boundary is crossed by a process that DIES there
 * (AQUA_CHARGE_CRASH_AT, process.exit), then a reconcile pass — itself in a
 * separate process — must leave every charge terminal, every wallet exactly
 * right (charged once for a committed turn, refunded once otherwise, never
 * minted), and the credit ledger consistent with the charge states.
 *
 * Needs DATABASE_URL (via the runner) and AQUA_TEST_MONGO_URI (a TEST Mongo).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const MONGO = process.env.AQUA_TEST_MONGO_URI ? process.env.AQUA_TEST_MONGO_URI.replace(/\/([^/?]+)(\?|$)/, '/$1_charges$2') : null;
const LIVE = Boolean(process.env.DATABASE_URL && MONGO);
const skip = LIVE ? false : 'needs DATABASE_URL and AQUA_TEST_MONGO_URI (test databases)';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'helpers', 'chargeChild.mjs');
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const requireRoot = createRequire(path.join(ROOT, 'package.json'));
let mongoose; let users; let txns; let pool; let PC;
const RUN = Date.now().toString(36);
const COST = 5;   // chat_message (utils/credits/packs)

function child(op, args, crashAt = null) {
  return new Promise(resolve => {
    const c = spawn(process.execPath, [CHILD, op, JSON.stringify(args)], {
      env: { ...process.env, AQUA_PENDING_CHARGES: 'on', CHARGE_TEST_MONGO: MONGO, AQUA_CHARGE_CRASH_AT: crashAt ?? '', MONGO_URI: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('exit', code => {
      const last = out.trim().split('\n').pop();
      let json = null; try { json = JSON.parse(last); } catch { /* crashed */ }
      resolve({ code, json, out, err });
    });
  });
}

let seq = 0;
const myUsers = [];
async function newUser({ free = 0, paid = 100 } = {}) {
  const _id = new mongoose.Types.ObjectId();
  const tomorrow = new Date(Date.now() + 20 * 3600_000);
  await users.insertOne({ _id, email: `pc-${RUN}-${++seq}@example.test`, name: 'pc', createdAt: new Date(),
    wallet: { freeCredits: free, paidCredits: paid, freeResetAt: tomorrow, totalEarned: paid, totalSpent: 0 } });
  myUsers.push(String(_id));
  return String(_id);
}
const balance = async uid => { const u = await users.findOne({ _id: new mongoose.Types.ObjectId(uid) }); return u ? (u.wallet.freeCredits + u.wallet.paidCredits) : null; };
const charge = async id => (await pool.query('SELECT * FROM aqua_charges WHERE charge_id = $1', [id])).rows[0];
const events = async id => (await pool.query('SELECT event, from_state, to_state, actor FROM aqua_charge_events WHERE charge_id = $1 ORDER BY event_id', [id])).rows;
const ledger = async uid => txns.find({ user: new mongoose.Types.ObjectId(uid), 'metadata.chargeId': { $exists: true } }).toArray();
const latestCharge = async uid => (await pool.query('SELECT * FROM aqua_charges WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [uid])).rows[0];
/** Reconcile in a separate process until nothing is open (at most 3 passes). */
async function reconcile() { let r; for (let i = 0; i < 3; i++) { r = await child('reconcile', { abandonMs: 1_000 }); if (!r.json?.abandoned && !r.json?.refunded) break; } return r; }

describe('Phase 4B — pending-charge recovery (real Postgres + real Mongo)', { skip, concurrency: false }, () => {
  before(async () => {
    const { migrate } = await import('../../core/db/migrate.js');
    await migrate();
    pool = await (await import('../../core/db/pool.js')).getPool();
    process.env.AQUA_PENDING_CHARGES = 'on';
    PC = await import('../pendingCharges.js');
    mongoose = requireRoot('mongoose');
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 5_000 });
    users = mongoose.connection.db.collection('users');
    txns = mongoose.connection.db.collection('transactions');
  });
  after(async () => {
    await mongoose?.disconnect();
    await (await import('../../core/db/pool.js')).closePool();
  });

  test('the happy path: charge → commit; charged once, ledger consistent, every transition recorded', async () => {
    const uid = await newUser();
    const b = await child('begin', { userId: uid });
    assert.equal(b.json.allowed, true, b.err.slice(-400));
    assert.equal((await charge(b.json.chargeId)).state, 'PENDING');
    assert.equal(await balance(uid), 100 - COST);
    await child('commit', { chargeId: b.json.chargeId });
    assert.equal((await charge(b.json.chargeId)).state, 'COMMITTED');
    await reconcile();
    assert.equal((await charge(b.json.chargeId)).state, 'COMMITTED', 'a committed charge is never refunded');
    assert.equal(await balance(uid), 100 - COST);
    assert.deepEqual((await events(b.json.chargeId)).map(e => e.event), ['created', 'deducted', 'committed']);
  });

  for (const point of ['after-charge-created', 'after-wallet-debit', 'after-deducted-recorded']) {
    test(`API dies while charging (${point}) → abandoned → refunded once, never minted`, async () => {
      const uid = await newUser();
      const r = await child('begin', { userId: uid }, point);
      assert.equal(r.code, 71, `the process did not die at ${point}`);
      const c0 = await latestCharge(uid);
      assert.equal(c0.state, 'PENDING');
      await pool.query(`UPDATE aqua_charges SET updated_at = now() - interval '1 hour' WHERE charge_id = $1`, [c0.charge_id]);  // age past the abandon window
      await reconcile();
      const c1 = await charge(c0.charge_id);
      assert.equal(c1.state, 'REFUNDED');
      assert.equal(await balance(uid), 100, 'the wallet must end exactly where it started');
      const refunds = (await ledger(uid)).filter(t => t.type === 'REFUND');
      assert.ok(refunds.length <= 1, `refunded ${refunds.length} times`);
      if (point === 'after-charge-created') assert.equal(refunds.length, 0, 'nothing was debited: nothing may be refunded');
      else assert.equal(refunds.length, 1);
    });
  }

  test('the API dies right after committing → stays COMMITTED, charged once', async () => {
    const uid = await newUser();
    const b = await child('begin', { userId: uid });
    const r = await child('commit', { chargeId: b.json.chargeId }, 'after-commit');
    assert.equal(r.code, 71);
    await reconcile();
    assert.equal((await charge(b.json.chargeId)).state, 'COMMITTED');
    assert.equal(await balance(uid), 100 - COST);
  });

  for (const point of ['after-refund-requested', 'after-wallet-refund', 'after-refunded-recorded']) {
    test(`a refunding process dies (${point}) → the refund completes exactly once`, async () => {
      const uid = await newUser();
      const b = await child('begin', { userId: uid });
      const r = await child('refund', { chargeId: b.json.chargeId }, point);
      assert.equal(r.code, 71);
      await reconcile();
      assert.equal((await charge(b.json.chargeId)).state, 'REFUNDED');
      assert.equal(await balance(uid), 100, 'refunded exactly once');
      assert.equal((await ledger(uid)).filter(t => t.type === 'REFUND').length, 1);
    });
  }

  test('the RECONCILER (a worker) dies during a refund → the next pass finishes it, once', async () => {
    const uid = await newUser();
    const b = await child('begin', { userId: uid });
    await child('refund', { chargeId: b.json.chargeId }, 'after-refund-requested');   // left REFUND_PENDING
    const dying = await child('reconcile', { abandonMs: 1_000 }, 'after-wallet-refund');
    assert.equal(dying.code, 71, 'the reconciler did not die mid-refund');
    assert.equal((await charge(b.json.chargeId)).state, 'REFUND_PENDING', 'wallet refunded, state not yet recorded');
    await reconcile();
    assert.equal((await charge(b.json.chargeId)).state, 'REFUNDED');
    assert.equal(await balance(uid), 100);
    assert.equal((await ledger(uid)).filter(t => t.type === 'REFUND').length, 1);
  });

  test('duplicate refunds: 6 concurrent refund processes for one charge → one refund', async () => {
    const uid = await newUser();
    const b = await child('begin', { userId: uid });
    const rs = await Promise.all(Array.from({ length: 6 }, () => child('refund', { chargeId: b.json.chargeId })));
    assert.ok(rs.every(r => r.code === 0), rs.map(r => r.err.slice(-200)).join('\n'));
    assert.equal((await charge(b.json.chargeId)).state, 'REFUNDED');
    assert.equal(await balance(uid), 100, 'credited more than once');
    assert.equal((await ledger(uid)).filter(t => t.type === 'REFUND').length, 1);
  });

  test('duplicate refunds at the SAME instant (10 in one process, all reading before any writes) → one refund', async () => {
    const uid = await newUser();
    const b = await child('begin', { userId: uid });
    await PC.requestRefund(b.json.chargeId, { reason: 'race' });
    const { createWalletAdapter } = requireRoot('./services/credits/pendingChargeWallet.js');
    const wallet = createWalletAdapter();
    // Straight at the wallet: the state machine is bypassed on purpose, so the
    // wallet's own once-only condition is what stands between 10 racers and 10 refunds.
    const rs = await Promise.all(Array.from({ length: 10 }, () => wallet.refund({ chargeId: b.json.chargeId, userId: uid, amount: COST, reason: 'race', breakdown: null })));
    assert.equal(rs.filter(r => r.outcome === 'refunded').length, 1, JSON.stringify(rs.map(r => r.outcome)));
    assert.equal(await balance(uid), 100, 'the wallet was credited more than once');
    await PC.processRefund(b.json.chargeId, { wallet });
    assert.equal((await charge(b.json.chargeId)).state, 'REFUNDED');
    assert.equal((await ledger(uid)).filter(t => t.type === 'REFUND').length, 1);
  });

  test('a refund after a commit is refused (a delivered turn is not refunded)', async () => {
    const uid = await newUser();
    const b = await child('begin', { userId: uid });
    await child('commit', { chargeId: b.json.chargeId });
    const r = await child('refund', { chargeId: b.json.chargeId });
    assert.equal(r.json.state, 'COMMITTED');
    assert.equal(await balance(uid), 100 - COST);
  });

  test('free credits go back to the free balance (same allowance period)', async () => {
    const uid = await newUser({ free: 10, paid: 100 });
    const b = await child('begin', { userId: uid });
    await child('refund', { chargeId: b.json.chargeId });
    const u = await users.findOne({ _id: new mongoose.Types.ObjectId(uid) });
    assert.deepEqual([u.wallet.freeCredits, u.wallet.paidCredits], [10, 100]);
  });

  test('the wallet is unreachable during a refund → recorded, retried, completed', async () => {
    const uid = await newUser();
    const b = await child('begin', { userId: uid });
    await PC.requestRefund(b.json.chargeId, { reason: 'test' });
    let calls = 0;
    const flaky = { refund: async () => { calls++; throw new Error('mongo unavailable (simulated)'); } };
    await assert.rejects(PC.processRefund(b.json.chargeId, { wallet: flaky }));
    const c = await charge(b.json.chargeId);
    assert.equal(c.state, 'REFUND_PENDING');
    assert.match(c.last_error, /unavailable/);
    await reconcile();
    assert.equal((await charge(b.json.chargeId)).state, 'REFUNDED');
    assert.equal(await balance(uid), 100);
  });

  test('account deleted with a charge open → VOID; account purge removes the charge rows', async () => {
    const uid = await newUser();
    const b = await child('begin', { userId: uid });
    await PC.requestRefund(b.json.chargeId, { reason: 'test' });
    await users.deleteOne({ _id: new mongoose.Types.ObjectId(uid) });
    await reconcile();
    assert.equal((await charge(b.json.chargeId)).state, 'VOID');
    const uid2 = await newUser();
    const b2 = await child('begin', { userId: uid2 });
    const r = await PC.purgeOwnerCharges(`user:${uid2}`);
    assert.equal(r.voided, 1);
    assert.equal(await charge(b2.json.chargeId), undefined);
  });

  test('credit-ledger reconciliation: consistent after all of the above; a doubled refund is detected', async () => {
    // THIS run's users only: the test database also holds earlier runs (and the bite check's deliberately broken ones).
    const all = await txns.find({ 'metadata.chargeId': { $exists: true }, user: { $in: myUsers.map(u => new mongoose.Types.ObjectId(u)) } }).toArray();
    const ledgerRows = all.map(t => ({ type: t.type, chargeId: t.metadata.chargeId }));
    const clean = await PC.reconcileLedger({ ledger: ledgerRows, sinceMs: 3600_000, userIds: myUsers });
    assert.deepEqual(clean.anomalies, [], JSON.stringify(clean.anomalies.slice(0, 5)));
    const someRefund = ledgerRows.find(t => t.type === 'REFUND');
    const dirty = await PC.reconcileLedger({ ledger: [...ledgerRows, someRefund], sinceMs: 3600_000, userIds: myUsers });
    assert.equal(dirty.anomalies.length, 1);
    assert.equal(dirty.anomalies[0].problem, 'refunded-twice');
  });
});
