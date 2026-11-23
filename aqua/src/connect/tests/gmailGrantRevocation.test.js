/**
 * F2 — a grant Google issued but AQUA did not store is revoked (bounded, best
 * effort), and the ORIGINAL failure is what the caller sees.
 *
 * Deterministic failure injection over the mock Gmail service (no network):
 *   S1 profile retrieval fails after the exchange
 *   S2 partial exchange: a refresh token but no access token
 *   S3 the exchange times out, then the tokens arrive late
 *   S4 credential sealing fails
 *   S5 connection-store creation fails
 *   S6 owner lease / fencing rejection after the exchange (LIVE: test Postgres lease)
 * plus: success never revokes; an acknowledged-but-unanswered store write keeps
 * its grant; a failing or hanging revocation never masks or delays the original
 * error beyond its bound; nothing secret is logged.
 *
 * Evidence of revocation: mock.grants() — every grant the mock issued, with its
 * revoked flag (no token values).
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const LIVE_DB = String(process.env.DATABASE_URL ?? '').trim();   // the runner's AQUA_TEST_DATABASE_URL (empty = S6 skipped)
const K = await import('./testkit.js');                         // isolated data dir; strips DATABASE_URL for everything else

const { createGmailConnector, GMAIL_READONLY_SCOPE } = await import('../gmail/gmailConnector.js');
const { createMockGmailService } = await import('../testing/mockGmailTransport.js');
const { principalForServerJob } = await import('../principal.js');

const logs = [];
const log = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) };
const REDIRECT = 'https://aquiplex.com/api/aqua/connect/gmail/callback';

function setup({ wrapTransport = t => t, vault = null, store = null, providerTimeoutMs = 2_000, revokeTimeoutMs = 2_000, lease = undefined, singleInstance = false } = {}) {
  const mock = createMockGmailService({ now: Date.now });
  const connector = createGmailConnector({ transport: wrapTransport(mock.transport), revokeTimeoutMs });
  const registry = K.createConnectorRegistry({ allowTestOnly: true });
  registry.register(connector);
  store ??= K.createMemoryConnectionStore();
  vault ??= K.createCredentialVault({ key: K.TEST_KEY });
  const service = K.createConnectService({ registry, store, vault, log, retry: { sleep: async () => {}, baseMs: 0 }, providerTimeoutMs, ...(lease ? { lease } : {}), singleInstance });
  const user = `f2-${crypto.randomBytes(6).toString('hex')}`;
  const verifier = crypto.randomBytes(64).toString('base64url');
  const code = mock.authorizeCode(`${user}@example.test`, { redirectUri: REDIRECT, codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url') });
  const connect = () => service.connect({ principal: principalForServerJob(user), connectorId: 'gmail', input: { code, redirectUri: REDIRECT, codeVerifier: verifier } });
  return { mock, service, store, user, owner: `user:${user}`, connect };
}
const waitFor = async (cond, ms = 2_000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) return false; await new Promise(r => setTimeout(r, 5)); } return true; };
const revokes = mock => mock.calls.filter(c => c.op === 'revoke').length;
/** A frozen read-only transport like the mock's, with some methods replaced. */
const override = over => t => Object.freeze({ ...t, ...over });

describe('F2 · a successful exchange followed by a failure revokes the grant', () => {
  test('control: a successful connect is stored and its grant is NOT revoked', async () => {
    const s = setup();
    const view = await s.connect();
    assert.equal(view.status, 'active');
    assert.deepEqual(s.mock.grants().map(g => g.revoked), [false]);
    assert.equal(revokes(s.mock), 0);
    assert.equal((await s.store.listByOwner(s.owner)).length, 1);
  });

  test('S1 · profile retrieval fails → grant revoked; the original error is returned; nothing stored', async () => {
    const s = setup();
    s.mock.failNext('getProfile', 500);
    await assert.rejects(s.connect(), e => e.code === 'CONNECT_FAILED');
    assert.deepEqual(s.mock.grants().map(g => g.revoked), [true]);
    assert.equal((await s.store.listByOwner(s.owner)).length, 0);
  });

  test('S1b · profile fails AND the revocation fails → still the original error (never masked); revocation was attempted', async () => {
    const s = setup();
    s.mock.failNext('getProfile', 401);
    s.mock.failNext('revoke', 503);
    await assert.rejects(s.connect(), e => e.code === 'AUTH_FAILED');
    assert.equal(revokes(s.mock), 1);
    assert.deepEqual(s.mock.grants().map(g => g.revoked), [false], 'reported honestly: the grant could not be revoked');
  });

  test('S1c · a revocation that HANGS is bounded: the original error arrives within the bound', async () => {
    const s = setup({ revokeTimeoutMs: 100 });
    s.mock.failNext('getProfile', 500);
    s.mock.gate('revoke');                                  // never released
    const t0 = Date.now();
    await assert.rejects(s.connect(), e => e.code === 'CONNECT_FAILED');
    assert.ok(Date.now() - t0 < 1_500, `took ${Date.now() - t0} ms`);
  });

  test('S2 · partial exchange: a refresh token but no access token → the grant is revoked by its refresh token', async () => {
    let refreshTokenSeen = null;
    const s = setup({ wrapTransport: t => override({ async exchangeCode(a) { const r = await t.exchangeCode(a); refreshTokenSeen = r.refreshToken; return { ...r, accessToken: null }; } })(t) });
    await assert.rejects(s.connect(), e => e.code === 'AUTH_FAILED');
    assert.ok(refreshTokenSeen);
    assert.equal(s.mock.grantRevoked(refreshTokenSeen), true);
    assert.deepEqual(s.mock.grants().map(g => g.revoked), [true]);
  });

  test('S3 · the exchange times out, then the tokens arrive → revoked on arrival; never stored', async () => {
    const s = setup({ providerTimeoutMs: 80 });
    const release = s.mock.gate('exchangeCode');
    await assert.rejects(s.connect(), e => e.code === 'CONNECT_FAILED');
    assert.deepEqual(s.mock.grants(), [], 'nothing issued yet when the caller got its answer');
    release();                                              // Google answers late
    assert.ok(await waitFor(() => s.mock.grants().length === 1 && s.mock.grants()[0].revoked), 'the late grant is revoked');
    assert.equal((await s.store.listByOwner(s.owner)).length, 0);
    assert.ok(logs.some(l => /late after timeout\); grant revocation=revoked/.test(l)));
  });

  test('S4 · credential sealing fails → grant revoked; the seal error is returned', async () => {
    const real = K.createCredentialVault({ key: K.TEST_KEY });
    const vault = Object.freeze({ ...real, seal: () => { throw Object.assign(new Error('seal failed'), { code: 'SEAL_TEST_FAILURE' }); } });
    const s = setup({ vault });
    await assert.rejects(s.connect(), e => e.code === 'SEAL_TEST_FAILURE');
    assert.deepEqual(s.mock.grants().map(g => g.revoked), [true]);
    assert.equal((await s.store.listByOwner(s.owner)).length, 0);
  });

  test('S5 · connection-store creation fails → grant revoked; the store error is returned (not a revocation error)', async () => {
    const real = K.createMemoryConnectionStore();
    const store = { ...real, create: async () => { throw Object.assign(new Error('store down'), { code: 'STORE_UNAVAILABLE' }); } };
    const s = setup({ store });
    s.mock.failNext('revoke', 503);                         // and the revocation fails too
    await assert.rejects(s.connect(), e => e.code === 'STORE_UNAVAILABLE');
    assert.equal(revokes(s.mock), 1);
    const s2 = setup({ store: { ...K.createMemoryConnectionStore(), create: async () => { throw Object.assign(new Error('store down'), { code: 'STORE_UNAVAILABLE' }); } } });
    await assert.rejects(s2.connect(), e => e.code === 'STORE_UNAVAILABLE');
    assert.deepEqual(s2.mock.grants().map(g => g.revoked), [true]);
  });

  test('S5b · the store WROTE the record but the reply was lost → the grant is kept (a stored connection is never revoked)', async () => {
    const real = K.createMemoryConnectionStore();
    const store = { ...real, create: async (doc, o) => { await real.create(doc, o); throw Object.assign(new Error('reply lost'), { code: 'STORE_REPLY_LOST' }); } };
    const s = setup({ store });
    await assert.rejects(s.connect(), e => e.code === 'STORE_REPLY_LOST');
    assert.deepEqual(s.mock.grants().map(g => g.revoked), [false]);
    assert.equal(revokes(s.mock), 0);
    assert.equal((await real.listByOwner(s.owner)).length, 1);
  });

  test('S5c · a store whose existence check also fails → revoke (never leave an unconfirmed grant live)', async () => {
    const real = K.createMemoryConnectionStore();
    const store = { ...real, create: async () => { throw new Error('store down'); }, get: async () => { throw new Error('store down'); } };
    const s = setup({ store });
    await assert.rejects(s.connect(), /store down/);
    assert.deepEqual(s.mock.grants().map(g => g.revoked), [true]);
  });

  test('S5d · a hanging revocation after a store failure is bounded by providerTimeoutMs', async () => {
    const real = K.createMemoryConnectionStore();
    const s = setup({ store: { ...real, create: async () => { throw new Error('store down'); } }, providerTimeoutMs: 100 });
    s.mock.gate('revoke');
    const t0 = Date.now();
    await assert.rejects(s.connect(), /store down/);
    assert.ok(Date.now() - t0 < 1_500, `took ${Date.now() - t0} ms`);
    assert.ok(logs.some(l => /\(not stored\); grant revocation=failed/.test(l)));
  });

  const liveSkip = LIVE_DB ? false : 'needs the test Postgres (AQUA_TEST_DATABASE_URL)';
  /** S6 on the real lease: `interrupt(owner, pool)` happens while Google is answering the exchange. */
  async function leaseScenario({ lease: leaseOpts, interrupt }) {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: LIVE_DB, max: 4 });
    const { connectLeaseName } = await import('../ownerLease.js');
    const s = setup({ lease: { pool, ...leaseOpts }, singleInstance: true });
    const cleanup = [];
    try {
      const release = s.mock.gate('exchangeCode');
      const p = s.connect();
      assert.ok(await waitFor(() => s.mock.calls.some(c => c.op === 'exchangeCode')), 'exchange in flight');
      cleanup.push(await interrupt(s.owner, pool));
      release();                                                          // Google answers: tokens issued
      const err = await p.then(() => null, e => e);
      assert.ok(err, 'the connect must fail');
      assert.deepEqual(s.mock.grants().map(g => g.revoked), [true], 'the issued grant is revoked');
      assert.equal((await s.store.listByOwner(s.owner)).length, 0, 'nothing stored');
      return err;
    } finally {
      for (const c of cleanup) await c?.();
      await pool.query('DELETE FROM aqua_scheduler_leases WHERE name = $1', [connectLeaseName(s.owner)]);
      await pool.end();
    }
  }

  test('S6a · the connect lease EXPIRES during the exchange and another instance takes the owner → fenced out; grant revoked', { skip: liveSkip }, async () => {
    const { createOwnerLease } = await import('../ownerLease.js');
    const err = await leaseScenario({
      lease: { ttlMs: 1_000, renewEveryMs: 60_000 },                     // no renewal: the lease lapses mid-exchange
      interrupt: async (owner, pool) => {
        await new Promise(r => setTimeout(r, 1_200));
        const other = createOwnerLease(owner, { pool, ttlMs: 10_000 });
        await other.acquire({ waitMs: 5_000 });
        return () => (other.held ? other.release() : null);
      },
    });
    assert.match(String(err.code), /LEASE_LOST|FENCE|WRITE_FENCE_LOST/);
  });

  test('S6b · the ACCOUNT is deleted during the exchange (purge takes the lease) → refused; grant revoked', { skip: liveSkip }, async () => {
    const { createOwnerLease } = await import('../ownerLease.js');
    await leaseScenario({
      lease: { ttlMs: 10_000 },
      interrupt: async (owner, pool) => {
        await pool.query(`INSERT INTO aqua_deleted_owners (owner_id, reason) VALUES ($1, 'f2-test') ON CONFLICT (owner_id) DO NOTHING`, [owner]);
        const purge = createOwnerLease(owner, { pool, ttlMs: 10_000 });
        await purge.acquire({ purge: true, waitMs: 5_000 });
        return () => (purge.held ? purge.release() : null);
      },
    });
  });

  test('nothing secret reaches a log line or an error message', () => {
    assert.ok(!logs.join('\n').includes('SECRETVALUE'));
    assert.ok(!/@example\.test/.test(logs.join('\n')));
    assert.ok(logs.some(l => /grant revocation=revoked/.test(l)), 'the revocation is logged (outcome only)');
  });
});

after(() => { /* nothing global to restore */ });
