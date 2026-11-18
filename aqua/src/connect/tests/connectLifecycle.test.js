/**
 * Phase 1b — Connect Engine lifecycle, end to end with the deterministic fake
 * connector: registry → connect (sealed credentials) → sync (discovery, import
 * through ingestFiles, change detection, retries, partial failure, checkpoint)
 * → disconnect (revoke + knowledge deletion). Real Phase 1a.2 lifecycle, real
 * ingestion pipeline, in-memory connection store, isolated data dir.
 *
 * Numbered scenarios follow the Phase 1b brief §6 (fake connector 1–12).
 */
import {
  stack, freshUser, ownerOf, settle, doc, external, createFakeWorld,
  createConnectorRegistry, defaultRegistry, createFakeConnector, ConnectError,
} from './testkit.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

async function connected({ account = 'acct-1', ...opts } = {}) {
  const s = stack(opts);
  const userId = freshUser('lc');
  const conn = await s.service.connect({ userId, connectorId: 'fake', input: { account, code: 'ok' } });
  return { ...s, userId, owner: ownerOf(userId), conn, account };
}
const held = (owner, conn) => external.listExternalResources(owner, `fake:${conn.connectionId}`);

// ── Registry ─────────────────────────────────────────────────────────────────

describe('registry', () => {
  test('registration, discovery and a credential-free description', () => {
    const r = createConnectorRegistry({ allowTestOnly: true });
    const d = r.register(createFakeConnector({ world: createFakeWorld() }));
    assert.equal(d.id, 'fake');
    assert.equal(d.version, '1.0.0');
    assert.equal(d.auth.type, 'oauth2');
    assert.deepEqual(d.capabilities, ['list', 'fetch', 'sync', 'incremental', 'refresh']);
    assert.deepEqual(d.resourceTypes, ['document']);
    assert.deepEqual(d.permissions, ['read:documents']);
    assert.equal(d.health.state, 'unknown');
    assert.deepEqual(r.list().map(x => x.id), ['fake']);
    assert.ok(!JSON.stringify(r.list()).includes('function'), 'descriptions must not expose implementation');
  });

  test('duplicates and invalid definitions are refused', () => {
    const r = createConnectorRegistry({ allowTestOnly: true });
    const world = createFakeWorld();
    r.register(createFakeConnector({ world }));
    assert.throws(() => r.register(createFakeConnector({ world })), e => e.code === 'DUPLICATE_CONNECTOR');
    assert.throws(() => r.register(createFakeConnector({ world, id: 'Bad Id' })), e => e.code === 'INVALID_CONNECTOR');
    assert.throws(() => r.register(createFakeConnector({ world, id: 'nofetch', overrides: { fetchResource: undefined } })), e => e.code === 'INVALID_CONNECTOR');
    assert.throws(() => r.register(createFakeConnector({ world, id: 'noinc', overrides: { syncChanges: undefined } })), /incremental/);
    assert.throws(() => r.register(createFakeConnector({ world, id: 'badver', version: '1' })), e => e.code === 'INVALID_CONNECTOR');
  });

  test('the production registry refuses the test-only fake connector', () => {
    assert.throws(() => defaultRegistry.register(createFakeConnector({ world: createFakeWorld(), id: 'fake-prod-probe' })), e => e.code === 'TEST_ONLY_CONNECTOR');
    assert.equal(defaultRegistry.has('fake-prod-probe'), false);
    assert.deepEqual(defaultRegistry.list(), [], 'no connector is registered in production yet');
  });

  test('safe unregistration: refused while a connection exists, allowed after disconnect', async () => {
    const s = await connected();
    await assert.rejects(() => s.service.unregisterConnector('fake'), e => e.code === 'CONNECTOR_IN_USE');
    await s.service.disconnect({ userId: s.userId, connectionId: s.conn.connectionId });
    assert.equal(await s.service.unregisterConnector('fake'), true);
    assert.equal(s.registry.has('fake'), false);
  });

  test('health follows real outcomes and the connector probe', async () => {
    const s = await connected();
    s.world.put(s.account, 'a', { name: 'a.md', content: doc('Healthy') });
    await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId });
    assert.equal(s.registry.describe('fake').health.state, 'ok');
    s.world.setDown(true);
    for (let i = 0; i < 3; i++) await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId, mode: 'full' });
    assert.equal(s.registry.describe('fake').health.state, 'down');
    assert.equal((await s.service.connectorHealth('fake')).ok, false);
    s.world.setDown(false);
    assert.equal((await s.service.connectorHealth('fake')).ok, true);
    assert.equal(s.registry.describe('fake').health.state, 'ok');
  });
});

// ── Fake connector scenarios 1–12 ───────────────────────────────────────────

describe('fake connector lifecycle', () => {
  test('1 · initial connection: active, credentials sealed, nothing secret in the view', async () => {
    const s = await connected();
    assert.equal(s.conn.status, 'active');
    assert.equal(s.conn.hasCredentials, true);
    assert.equal(s.conn.account.label, 'Fake account acct-1');
    assert.match(s.conn.connectionId, /^conn_[0-9a-f]{20}$/);
    assert.ok(!JSON.stringify(s.conn).includes('SECRETVALUE'));
    const raw = s.store._rawForTests()[0];
    assert.equal(raw.credentials.alg, 'aes-256-gcm');
    assert.ok(!JSON.stringify(raw).includes('SECRETVALUE'), 'plaintext credential at rest');
  });

  test('2 + 3 · discovery across pages and import of every resource through ingestFiles', async () => {
    const s = await connected();
    for (let i = 1; i <= 5; i++) s.world.put(s.account, `doc-${i}`, { name: `doc-${i}.md`, content: doc(`Projectus${i}`) });
    const r = await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId });
    assert.equal(r.lastSync.state, 'succeeded');
    assert.equal(r.lastSync.mode, 'full');
    assert.equal(r.lastSync.counts.listed, 5);
    assert.equal(r.lastSync.counts.created, 5);
    assert.equal(s.world.calls.filter(c => c.op === 'list').length, 3, 'pageSize 2 → 3 pages');
    assert.equal(held(s.owner, s.conn).length, 5);
    assert.ok(external.externalUsage(s.owner).items === 5);
  });

  test('4 · identical file names from different resources coexist', async () => {
    const s = await connected();
    s.world.put(s.account, 'repo-a/README.md', { name: 'README.md', content: doc('Readmea') });
    s.world.put(s.account, 'repo-b/README.md', { name: 'README.md', content: doc('Readmeb') });
    await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId });
    const h = held(s.owner, s.conn);
    assert.equal(h.length, 2);
    assert.deepEqual(h.map(x => x.name), ['README.md', 'README.md']);
    assert.equal(new Set(h.map(x => x.ukoId)).size, 2);
  });

  test('5 · unchanged resources: no re-fetch, no duplicates (full and incremental)', async () => {
    const s = await connected();
    for (let i = 1; i <= 3; i++) s.world.put(s.account, `u-${i}`, { name: `u${i}.md`, content: doc(`Steady${i}`) });
    await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId, mode: 'full' });
    const fetches = s.world.calls.filter(c => c.op === 'fetch').length;
    const full = await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId, mode: 'full' });
    assert.equal(full.lastSync.counts.skippedSameVersion, 3);
    assert.equal(s.world.calls.filter(c => c.op === 'fetch').length, fetches, 'unchanged resources were fetched again');
    const inc = await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId, mode: 'incremental' });
    assert.equal(inc.lastSync.state, 'succeeded');
    assert.equal(held(s.owner, s.conn).length, 3);
  });

  test('6 · modified resource: incremental sync updates the same resource', async () => {
    const s = await connected();
    s.world.put(s.account, 'spec', { name: 'spec.md', content: doc('Specv', 'Launch is March 15.') });
    await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId });
    const before = held(s.owner, s.conn)[0];
    s.world.put(s.account, 'spec', { name: 'spec.md', content: doc('Specv', 'Launch moved to April 30.') });
    const r = await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId });
    assert.equal(r.lastSync.mode, 'incremental');
    assert.equal(r.lastSync.counts.updated, 1);
    const after = held(s.owner, s.conn);
    assert.equal(after.length, 1);
    assert.notEqual(after[0].ukoId, before.ukoId);
    assert.equal(after[0].version, '2');
  });

  test('7 · resource deleted at the source: removed by incremental AND inferred by a complete full listing', async () => {
    const s = await connected();
    for (const id of ['keep', 'gone-1', 'gone-2']) s.world.put(s.account, id, { name: `${id}.md`, content: doc(`Del${id.replace('-', '')}`) });
    await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId });
    s.world.remove(s.account, 'gone-1');
    const inc = await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId, mode: 'incremental' });
    assert.equal(inc.lastSync.counts.removed, 1);
    s.world.remove(s.account, 'gone-2');
    const full = await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId, mode: 'full' });
    assert.equal(full.lastSync.counts.removed, 1);
    assert.deepEqual(held(s.owner, s.conn).map(x => x.externalId), ['keep']);
  });

  test('7b · an INCOMPLETE listing never deletes knowledge', async () => {
    const s = await connected();
    for (const id of ['x1', 'x2', 'x3']) s.world.put(s.account, id, { name: `${id}.md`, content: doc(`Safe${id}`) });
    await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId, mode: 'full' });
    s.world.failList(10, { transient: false });
    const r = await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId, mode: 'full' });
    assert.equal(r.lastSync.state, 'failed');
    assert.equal(held(s.owner, s.conn).length, 3, 'a failed listing deleted knowledge');
  });

  test('8 · temporary API failure: transient errors are retried within the run', async () => {
    const s = await connected();
    s.world.put(s.account, 'flaky', { name: 'flaky.md', content: doc('Flakey') });
    s.world.failFetch('flaky', { times: 2, transient: true });
    s.world.failList(1, { transient: true });
    const r = await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId });
    assert.equal(r.lastSync.state, 'succeeded');
    assert.equal(r.lastSync.counts.created, 1);
    assert.equal(s.world.calls.filter(c => c.op === 'fetch' && c.externalId === 'flaky').length, 3);
  });

  test('9 + 10 · partial failure keeps the checkpoint; the retry completes it without duplicates', async () => {
    const s = await connected();
    for (const id of ['ok-1', 'bad', 'ok-2']) s.world.put(s.account, id, { name: `${id}.md`, content: doc(`Part${id.replace('-', '')}`) });
    s.world.failFetch('bad', { times: 1, transient: false });
    const r1 = await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId });
    assert.equal(r1.lastSync.state, 'partial');
    assert.deepEqual(r1.lastSync.failed.map(f => f.externalId), ['bad']);
    assert.equal(r1.lastSync.counts.created, 2);
    const c1 = (await s.service.getConnection({ userId: s.userId, connectionId: s.conn.connectionId }));
    assert.equal(c1.lastSync.state, 'partial');
    assert.equal((await s.store.get(s.owner, s.conn.connectionId)).checkpoint, null, 'checkpoint advanced past a failure');

    const r2 = await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId });
    assert.equal(r2.lastSync.state, 'succeeded');
    assert.equal(r2.lastSync.counts.created, 1);
    assert.equal(r2.lastSync.counts.skippedSameVersion, 2);
    assert.equal(held(s.owner, s.conn).length, 3);
    assert.ok((await s.store.get(s.owner, s.conn.connectionId)).checkpoint, 'checkpoint not advanced after a clean run');
  });

  test('11 + 12 · disconnection revokes at the source and deletes exactly this connection\'s knowledge', async () => {
    const world = createFakeWorld();
    const s = await connected({ world });
    const other = await s.service.connect({ userId: s.userId, connectorId: 'fake', input: { account: 'acct-2', code: 'ok' } });
    world.put('acct-1', 'one', { name: 'README.md', content: doc('Firstconn') });
    world.put('acct-2', 'one', { name: 'README.md', content: doc('Secondconn') });
    await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId });
    await s.service.sync({ userId: s.userId, connectionId: other.connectionId });
    await settle();
    const token = world.calls.find(c => c.op === 'list' && c.account === 'acct-1').token;

    const d = await s.service.disconnect({ userId: s.userId, connectionId: s.conn.connectionId });
    assert.deepEqual([d.deleted, d.revokedAtSource, d.knowledgeRemoved], [true, true, true]);
    assert.equal(world.tokenState(token).revoked, true);
    await assert.rejects(() => s.service.getConnection({ userId: s.userId, connectionId: s.conn.connectionId }), e => e.code === 'NOT_FOUND');
    assert.equal(held(s.owner, s.conn).length, 0);
    assert.equal(external.listExternalResources(s.owner, `fake:${other.connectionId}`).length, 1, 'the other connection lost knowledge');
    const { ukoPrefix, keyPrefix } = (await import('../../files/externalIdentity.js')).sourcePrefixes(`fake:${s.conn.connectionId}`);
    assert.ok(Object.values(external.remainingUnder(s.owner, { ukoPrefix, keyPrefix })).every(n => n === 0));
    assert.equal((await s.service.disconnect({ userId: s.userId, connectionId: other.connectionId })).deleted, true);
    assert.deepEqual(await s.service.listConnections({ userId: s.userId }), []);
  });
});

// ── Credentials over time ────────────────────────────────────────────────────

describe('credential lifecycle', () => {
  test('expiring credentials are refreshed before a sync and re-sealed', async () => {
    let now = Date.parse('2026-11-17T00:00:00Z');
    const world = createFakeWorld({ now: () => now });
    const s = await connected({ world, now: () => now });
    world.put(s.account, 'r', { name: 'r.md', content: doc('Refresho') });
    const sealedBefore = s.store._rawForTests()[0].credentials.ct;
    now += 3_600_000 + 1;            // the access token has expired
    const r = await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId });
    assert.equal(r.lastSync.state, 'succeeded');
    const raw = s.store._rawForTests()[0];
    assert.notEqual(raw.credentials.ct, sealedBefore, 'refreshed credentials were not re-sealed');
    assert.ok(raw.credentialsExpireAt > now);
  });

  test('a refused refresh marks the connection needs_reauth; knowledge is kept; sync is refused', async () => {
    let now = Date.parse('2026-11-17T00:00:00Z');
    const world = createFakeWorld({ now: () => now });
    const s = await connected({ world, now: () => now });
    world.put(s.account, 'r', { name: 'r.md', content: doc('Keptknow') });
    await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId });
    now += 3_600_000 + 1;
    world.failures.refresh = true;
    await assert.rejects(() => s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId }), e => e.code === 'NEEDS_REAUTH');
    assert.equal((await s.service.getConnection({ userId: s.userId, connectionId: s.conn.connectionId })).status, 'needs_reauth');
    await assert.rejects(() => s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId }), e => e.code === 'NOT_ACTIVE');
    assert.equal(held(s.owner, s.conn).length, 1);
  });

  test('an AUTH error mid-sync (token revoked at the source) stops the run without touching knowledge', async () => {
    const s = await connected();
    s.world.put(s.account, 'a', { name: 'a.md', content: doc('Authstop') });
    await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId });
    s.world.revoke(s.world.calls.find(c => c.op === 'list').token);
    s.world.put(s.account, 'b', { name: 'b.md', content: doc('Authnew') });
    const r = await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId });
    assert.equal(r.status, 'needs_reauth');
    assert.equal(r.lastSync.state, 'failed');
    assert.equal(held(s.owner, s.conn).length, 1);
  });

  test('credential revocation: revoked at the source and wiped locally; knowledge kept until disconnect', async () => {
    const s = await connected();
    s.world.put(s.account, 'a', { name: 'a.md', content: doc('Revokeme') });
    await s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId });
    const token = s.world.calls.find(c => c.op === 'list').token;
    const r = await s.service.revokeCredentials({ userId: s.userId, connectionId: s.conn.connectionId });
    assert.equal(r.revokedAtSource, true);
    assert.equal(r.connection.status, 'revoked');
    assert.equal(r.connection.hasCredentials, false);
    assert.equal(s.store._rawForTests()[0].credentials, null);
    assert.equal(s.world.tokenState(token).revoked, true);
    assert.equal(held(s.owner, s.conn).length, 1);
    await assert.rejects(() => s.service.sync({ userId: s.userId, connectionId: s.conn.connectionId }), e => e.code === 'NOT_ACTIVE');
    assert.equal((await s.service.disconnect({ userId: s.userId, connectionId: s.conn.connectionId })).knowledgeRemoved, true);
    assert.equal(held(s.owner, s.conn).length, 0);
  });

  test('ConnectError is the only error surface for callers', async () => {
    const s = stack();
    await assert.rejects(() => s.service.connect({ userId: freshUser('x'), connectorId: 'fake', input: { account: 'a', code: 'WRONG' } }), e => e instanceof ConnectError && e.code === 'AUTH_FAILED');
  });
});
