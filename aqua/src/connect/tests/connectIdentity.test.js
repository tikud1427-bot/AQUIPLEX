/**
 * G0 — IS-1 at the service boundary: the authenticated server-side identity is
 * authoritative; a client-supplied userId / ownerId can never select whose
 * connections are touched. No HTTP route exists; a route is SIMULATED as a
 * handler over an express-like req to prove the intended wiring.
 */
import { stack, freshUser, ownerOf, doc, external, createConnectService } from './testkit.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { principalFromRequest, principalForServerJob, isPrincipal } from '../principal.js';

const quiet = { log: () => {}, warn: () => {} };
const noRetry = { sleep: () => Promise.resolve(), baseMs: 0 };

/** A STRICT service (the production default: no trustRawUserId) over a test stack. */
function strict() {
  const s = stack();
  const svc = createConnectService({ registry: s.registry, store: s.store, vault: s.vault, retry: noRetry, log: quiet });
  return { ...s, svc };
}
/** What the platform's /api/aqua chain produces for a signed-in user (index.js aquaAccess). */
const reqFor = (userId, extra = {}) => ({ session: { userId }, aquaUserId: String(userId), body: {}, query: {}, params: {}, headers: {}, ...extra });
const held = (owner, cid) => external.listExternalResources(owner, `fake:${cid}`);

async function twoUsers() {
  const s = strict();
  const A = freshUser('idA'), B = freshUser('idB');
  const pA = principalFromRequest(reqFor(A)), pB = principalFromRequest(reqFor(B));
  const cA = await s.svc.connect({ principal: pA, connectorId: 'fake', input: { account: 'acct-A', code: 'ok' } });
  s.world.put('acct-A', 'a1', { name: 'a1.md', content: doc('Identitya') });
  await s.svc.sync({ principal: pA, connectionId: cA.connectionId });
  return { ...s, A, B, pA, pB, cA };
}

describe('principal: built only from authenticated server-side request state', () => {
  test('requires session.userId and the server-bound aquaUserId, and they must agree', () => {
    assert.throws(() => principalFromRequest({}), e => e.code === 'UNAUTHENTICATED');
    assert.throws(() => principalFromRequest({ session: { userId: 'u1' } }), e => e.code === 'UNAUTHENTICATED');
    assert.throws(() => principalFromRequest({ aquaUserId: 'u1' }), e => e.code === 'UNAUTHENTICATED');
    assert.throws(() => principalFromRequest({ session: { userId: 'u1' }, aquaUserId: 'u2' }), e => e.code === 'UNAUTHENTICATED');
    const p = principalFromRequest(reqFor('u1'));
    assert.equal(p.userId, 'u1');
    assert.ok(Object.isFrozen(p));
    assert.ok(isPrincipal(p));
  });

  test('never reads body, query, params or headers', () => {
    const p = principalFromRequest(reqFor('real-user', {
      body: { userId: 'victim', ownerId: 'user:victim' }, query: { userId: 'victim' },
      params: { userId: 'victim' }, headers: { 'x-user-id': 'victim', 'x-test-user': 'victim' },
    }));
    assert.equal(p.userId, 'real-user');
  });

  test('a look-alike object is not a principal', () => {
    assert.equal(isPrincipal({ userId: 'u1' }), false);
    assert.equal(isPrincipal(Object.freeze({ userId: 'u1' })), false);
    assert.equal(isPrincipal(null), false);
    assert.ok(isPrincipal(principalForServerJob('u1')));
  });
});

describe('IS-1 · the strict (default) service', () => {
  test('refuses every user operation without a genuine principal — raw userId, look-alike, nothing', async () => {
    const s = await twoUsers();
    const id = s.cA.connectionId;
    const forged = [{ userId: s.A }, { principal: { userId: s.A } }, { principal: Object.freeze({ userId: s.A }) }, {}];
    for (const who of forged) {
      await assert.rejects(() => s.svc.connect({ ...who, connectorId: 'fake', input: { account: 'x', code: 'ok' } }), e => e.code === 'UNAUTHENTICATED', JSON.stringify(who));
      await assert.rejects(() => s.svc.listConnections(who), e => e.code === 'UNAUTHENTICATED');
      await assert.rejects(() => s.svc.getConnection({ ...who, connectionId: id }), e => e.code === 'UNAUTHENTICATED');
      await assert.rejects(() => s.svc.sync({ ...who, connectionId: id }), e => e.code === 'UNAUTHENTICATED');
      await assert.rejects(() => s.svc.revokeCredentials({ ...who, connectionId: id }), e => e.code === 'UNAUTHENTICATED');
      await assert.rejects(() => s.svc.disconnect({ ...who, connectionId: id }), e => e.code === 'UNAUTHENTICATED');
    }
    assert.equal(s.store._rawForTests()[0].status, 'active');
    assert.equal(held(ownerOf(s.A), id).length, 1);
  });

  test('forged userId next to a genuine principal is ignored: the principal decides', async () => {
    const s = await twoUsers();
    // attacker B passes the victim's id alongside their own principal
    await assert.rejects(() => s.svc.getConnection({ principal: s.pB, userId: s.A, connectionId: s.cA.connectionId }), e => e.code === 'NOT_FOUND');
    assert.deepEqual(await s.svc.listConnections({ principal: s.pB, userId: s.A }), []);
    const created = await s.svc.connect({ principal: s.pB, userId: s.A, connectorId: 'fake', input: { account: 'acct-B', code: 'ok' } });
    const rowB = s.store._rawForTests().find(r => r.connectionId === created.connectionId);
    assert.equal(rowB.ownerId, ownerOf(s.B), 'connection created for the forged userId');
  });

  test('forged ownerId (top level or inside connect input) is never used', async () => {
    const s = await twoUsers();
    assert.deepEqual(await s.svc.listConnections({ principal: s.pB, ownerId: ownerOf(s.A) }), []);
    await assert.rejects(() => s.svc.sync({ principal: s.pB, ownerId: ownerOf(s.A), connectionId: s.cA.connectionId }), e => e.code === 'NOT_FOUND');
    const c = await s.svc.connect({ principal: s.pB, ownerId: ownerOf(s.A), connectorId: 'fake', input: { account: 'acct-B2', code: 'ok', ownerId: ownerOf(s.A), userId: s.A } });
    assert.equal(s.store._rawForTests().find(r => r.connectionId === c.connectionId).ownerId, ownerOf(s.B));
    assert.equal((await s.svc.listConnections({ principal: s.pA })).length, 1, 'the victim gained a connection');
  });

  test('cross-user: B cannot see, sync, revoke or disconnect A\'s connection; A is untouched', async () => {
    const s = await twoUsers();
    const id = s.cA.connectionId;
    for (const op of [
      () => s.svc.getConnection({ principal: s.pB, connectionId: id }),
      () => s.svc.sync({ principal: s.pB, connectionId: id }),
      () => s.svc.revokeCredentials({ principal: s.pB, connectionId: id }),
      () => s.svc.disconnect({ principal: s.pB, connectionId: id }),
    ]) await assert.rejects(op, e => e.code === 'NOT_FOUND');
    const raw = s.store._rawForTests().find(r => r.connectionId === id);
    assert.equal(raw.status, 'active');
    assert.ok(raw.credentials);
    assert.equal(held(ownerOf(s.A), id).length, 1);
  });

  test('disconnect ownership: only the owner\'s principal disconnects and deletes', async () => {
    const s = await twoUsers();
    const id = s.cA.connectionId;
    await assert.rejects(() => s.svc.disconnect({ principal: s.pB, connectionId: id }), e => e.code === 'NOT_FOUND');
    assert.equal(held(ownerOf(s.A), id).length, 1);
    const d = await s.svc.disconnect({ principal: s.pA, connectionId: id });
    assert.equal(d.deleted, true);
    assert.equal(held(ownerOf(s.A), id).length, 0);
  });

  test('a SIMULATED route that spreads client data into the call cannot impersonate', async () => {
    const s = await twoUsers();
    // the intended handler shape: identity from principalFromRequest(req), everything else from the client
    const syncRoute = req => s.svc.sync({ ...req.body, ...req.query, principal: principalFromRequest(req), connectionId: req.params.id });
    const disconnectRoute = req => s.svc.disconnect({ ...req.body, principal: principalFromRequest(req), connectionId: req.params.id });
    const attack = reqFor(s.B, {
      params: { id: s.cA.connectionId },
      body: { userId: s.A, ownerId: ownerOf(s.A), principal: { userId: s.A } },
      query: { userId: s.A },
    });
    await assert.rejects(() => syncRoute(attack), e => e.code === 'NOT_FOUND');
    await assert.rejects(() => disconnectRoute(attack), e => e.code === 'NOT_FOUND');
    // a request whose session and server binding disagree never gets a principal
    await assert.rejects(async () => syncRoute({ ...attack, aquaUserId: s.A }), e => e.code === 'UNAUTHENTICATED');
    assert.equal(held(ownerOf(s.A), s.cA.connectionId).length, 1);
    // the legitimate owner through the same route shape works
    const ok = await syncRoute(reqFor(s.A, { params: { id: s.cA.connectionId } }));
    assert.equal(ok.lastSync.state, 'succeeded');
  });

  test('administrative operations stay principal-free and are not user operations', async () => {
    const s = await twoUsers();
    assert.equal(typeof s.svc.unregisterConnector, 'function');
    await assert.rejects(() => s.svc.unregisterConnector('fake'), e => e.code === 'CONNECTOR_IN_USE');
  });
});
