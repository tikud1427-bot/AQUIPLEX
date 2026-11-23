/**
 * Gmail Phase 2 — ingestion & synchronisation foundation (mock-first, no network).
 *
 *   R  reconnect without duplicate connections (and F2 on the reconnect path)
 *   P  user pause / resume
 *   C  removal confirmation: a listing that skips a PRESENT message never deletes it
 *   D  a dead saved listing position is discarded (Gmail 400 / undecodable cursor); a transient failure keeps it
 *   A  Retry-After honoured (bounded); a long pause ends the attempt
 *   X  drafts are out of scope
 *   G  account purge revokes the owner's grants before deleting the records
 *   J  the durable sync job (connect.sync.v1): owner from the job, never the payload
 *   W  authenticated status / sync / pause / resume routes
 *
 * Real connect service + syncEngine + external-source lifecycle (files/externalSources.js)
 * over the mock Gmail service; in-memory connection store; isolated data dir (testkit).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const K = await import('./testkit.js');
const egress = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.hostname !== '127.0.0.1') { egress.push(u.host); throw new Error('network refused in tests'); }
  return realFetch(url, init);
};

const express = (await import('express')).default;
const { createGmailConnector, GMAIL_READONLY_SCOPE } = await import('../gmail/gmailConnector.js');
const { createMockGmailService } = await import('../testing/mockGmailTransport.js');
const F = await import('../testing/gmailFixtures.js');
const { principalForServerJob } = await import('../principal.js');
const { withRetry, MAX_RETRY_AFTER_MS } = await import('../syncEngine.js');
const { createGoogleGmailTransport, parseRetryAfter } = await import('../gmail/googleGmailTransport.js');
const { purgeConnectorState } = await import('../connectPurge.js');
const { runConnectSyncJob } = await import('../syncJob.js');
const { enqueueSync, CONNECT_SYNC_JOB_KIND } = await import('../productionDeps.js');
const { createConnectRouter } = await import('../../routes/connect.js');
const { buildGmailOAuth } = await import('../gmail/gmailOAuthConfig.js');

const logs = [];
const log = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) };
const ACCT = 'phase2.owner@example.test';

function setup({ store = null, pageSize = 3, mock = null, vault = null } = {}) {
  mock ??= createMockGmailService({ now: Date.now });
  const registry = K.createConnectorRegistry({ allowTestOnly: true });
  registry.register(createGmailConnector({ transport: mock.transport, pageSize }));
  store ??= K.createMemoryConnectionStore();
  const service = K.createConnectService({ registry, store, vault: vault ?? K.createCredentialVault({ key: K.TEST_KEY }), log, retry: { sleep: async () => {}, baseMs: 0 } });
  const user = `p2-${crypto.randomBytes(5).toString('hex')}`;
  const principal = principalForServerJob(user);
  const connect = (email = ACCT) => service.connect({ principal, connectorId: 'gmail', input: { code: mock.authorizeCode(email) } });
  const held = id => K.external.listExternalResources(`user:${user}`, `gmail:${id}`).map(r => r.externalId).sort();
  return { mock, registry, store, service, user, owner: `user:${user}`, principal, connect, held };
}
const msg = (id, extra = {}) => F.buildMessage({ id, threadId: `thr-${id}`, date: 'Mon, 5 Jan 2026 10:00:00 +0000', headers: { From: 'a@example.test', To: ACCT, Subject: `S ${id}`, 'Message-ID': `<${id}@example.test>` }, text: `Body of ${id} CANARY_${id}.`, ...extra });
const ids = n => Array.from({ length: n }, (_, i) => `18f${String(i + 1).padStart(13, '0')}`);

// ══════════════════════════════════════════════════════════════════════════════
describe('R · reconnect without duplicate connections', () => {
  test('R1 · the same account connected again refreshes the SAME connection (id, source, knowledge kept)', async () => {
    const s = setup();
    for (const id of ids(2)) s.mock.addMessage(ACCT, msg(id));
    const a = await s.connect();
    await s.service.sync({ principal: s.principal, connectionId: a.connectionId });
    assert.equal(s.held(a.connectionId).length, 2);
    await s.store.update(s.owner, a.connectionId, { status: 'needs_reauth' });
    const before = (await s.store.get(s.owner, a.connectionId)).credentials;
    const b = await s.connect();
    assert.equal(b.connectionId, a.connectionId);
    assert.equal(b.status, 'active');
    assert.equal((await s.service.listConnections({ principal: s.principal })).length, 1, 'no duplicate');
    assert.notEqual((await s.store.get(s.owner, a.connectionId)).credentials.iv, before.iv, 'new credentials sealed');
    assert.equal(s.held(a.connectionId).length, 2, 'imported knowledge kept');
    assert.equal(s.mock.grants().filter(g => g.revoked).length, 0, 'neither grant revoked (Google would revoke both)');
    assert.ok(logs.some(l => l.includes(`reconnected connector=gmail`) && l.includes(a.connectionId)));
  });

  test('R2 · a revoked connection is revived by reconnecting the same account; a DIFFERENT account gets its own connection', async () => {
    const s = setup();
    const a = await s.connect();
    await s.service.revokeCredentials({ principal: s.principal, connectionId: a.connectionId });
    assert.equal((await s.connect()).connectionId, a.connectionId);
    const other = await s.connect('someone.else@example.test');
    assert.notEqual(other.connectionId, a.connectionId);
    assert.equal((await s.service.listConnections({ principal: s.principal })).length, 2);
  });

  test('R3 · a connection being deleted is NEVER revived: a new connection is created', async () => {
    const s = setup();
    const a = await s.connect();
    for (const st of ['disconnecting', 'disconnect_incomplete']) {
      await s.store.update(s.owner, a.connectionId, { status: st });
      const b = await s.connect();
      assert.notEqual(b.connectionId, a.connectionId, st);
      await s.service.disconnect({ principal: s.principal, connectionId: b.connectionId });
    }
    assert.equal((await s.store.get(s.owner, a.connectionId)).status, 'disconnect_incomplete', 'the deleting record untouched');
  });

  test('R4 · F2 on reconnect: the store refuses the update → the NEW grant is revoked; the old record is unchanged', async () => {
    const real = K.createMemoryConnectionStore();
    const s = setup({ store: real });
    const a = await s.connect();
    const old = (await real.get(s.owner, a.connectionId)).credentials;
    const failing = { ...real, update: async () => { throw Object.assign(new Error('store down'), { code: 'STORE_UNAVAILABLE' }); } };
    const s2 = setup({ store: failing, mock: s.mock });
    const p2 = principalForServerJob(s.user);
    await assert.rejects(s2.service.connect({ principal: p2, connectorId: 'gmail', input: { code: s.mock.authorizeCode(ACCT) } }), e => e.code === 'STORE_UNAVAILABLE');
    assert.deepEqual(s.mock.grants().map(g => g.revoked), [false, true], 'first grant kept, the new one revoked');
    assert.deepEqual((await real.get(s.owner, a.connectionId)).credentials, old);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('P · pause / resume', () => {
  test('P1 · a paused connection refuses sync (PAUSED) until resumed; the view says so', async () => {
    const s = setup();
    s.mock.addMessage(ACCT, msg(ids(1)[0]));
    const a = await s.connect();
    assert.equal((await s.service.pauseSync({ principal: s.principal, connectionId: a.connectionId })).syncPaused, true);
    await assert.rejects(s.service.sync({ principal: s.principal, connectionId: a.connectionId }), e => e.code === 'PAUSED');
    assert.equal(s.held(a.connectionId).length, 0);
    assert.equal((await s.service.resumeSync({ principal: s.principal, connectionId: a.connectionId })).syncPaused, false);
    assert.equal((await s.service.sync({ principal: s.principal, connectionId: a.connectionId })).lastSync.state, 'succeeded');
    assert.equal(s.held(a.connectionId).length, 1);
  });

  test('P2 · pause is refused for a connection being deleted; another owner cannot pause it', async () => {
    const s = setup();
    const a = await s.connect();
    await assert.rejects(s.service.pauseSync({ principal: principalForServerJob('intruder'), connectionId: a.connectionId }), e => e.code === 'NOT_FOUND');
    await s.store.update(s.owner, a.connectionId, { status: 'disconnect_incomplete' });
    await assert.rejects(s.service.pauseSync({ principal: s.principal, connectionId: a.connectionId }), e => e.code === 'NOT_ACTIVE');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('C · removal confirmation (an incomplete or drifting listing never deletes)', () => {
  test('C1 · a full listing that SKIPS a present message keeps it; a message really deleted is removed', async () => {
    const s = setup();
    const [m1, m2, m3] = ids(3);
    for (const id of [m1, m2, m3]) s.mock.addMessage(ACCT, msg(id));
    const a = await s.connect();
    await s.service.sync({ principal: s.principal, connectionId: a.connectionId, mode: 'full' });
    assert.equal(s.held(a.connectionId).length, 3);
    s.mock.hideFromListing(ACCT, m2);                       // pagination drift: Gmail did not return it
    const r = await s.service.sync({ principal: s.principal, connectionId: a.connectionId, mode: 'full' });
    assert.equal(r.lastSync.counts.keptStillPresent, 1);
    assert.equal(r.lastSync.counts.removed, 0);
    assert.equal(s.held(a.connectionId).length, 3, 'the skipped message was NOT deleted');
    s.mock.hideFromListing(ACCT, m2, false);
    s.mock.deleteMessage(ACCT, m3);                        // really deleted at Gmail
    const r2 = await s.service.sync({ principal: s.principal, connectionId: a.connectionId, mode: 'full' });
    assert.equal(r2.lastSync.counts.removed, 1);
    assert.deepEqual(s.held(a.connectionId), [`msg:${m1}`, `msg:${m2}`]);
  });

  test('C2 · confirmation impossible (Gmail failing) → kept, run not clean, position not advanced; confirmed next run', async () => {
    const s = setup();
    const [m1] = ids(1);
    s.mock.addMessage(ACCT, msg(m1));
    const a = await s.connect();
    await s.service.sync({ principal: s.principal, connectionId: a.connectionId, mode: 'full' });
    const cp = (await s.store.get(s.owner, a.connectionId)).checkpoint;
    s.mock.deleteMessage(ACCT, m1);
    s.mock.failNext('getMessage', 503, 3);                 // every retry of the confirmation fails
    const r = await s.service.sync({ principal: s.principal, connectionId: a.connectionId, mode: 'full' });
    assert.equal(r.lastSync.state, 'partial');
    assert.equal(r.lastSync.counts.removalUnconfirmed, 1);
    assert.equal(s.held(a.connectionId).length, 1, 'kept while unconfirmed');
    assert.deepEqual((await s.store.get(s.owner, a.connectionId)).checkpoint, cp, 'position not advanced');
    const r2 = await s.service.sync({ principal: s.principal, connectionId: a.connectionId, mode: 'full' });
    assert.equal(r2.lastSync.counts.removed, 1);
    assert.equal(s.held(a.connectionId).length, 0);
  });

  test('C3 · incremental: a history deletion is confirmed (404) and applied; a TRASHed message is confirmed out of scope', async () => {
    const s = setup();
    const [m1, m2, m3, m4] = ids(4);
    for (const id of [m1, m2, m3, m4]) s.mock.addMessage(ACCT, msg(id));
    const a = await s.connect();
    await s.service.sync({ principal: s.principal, connectionId: a.connectionId });
    s.mock.deleteMessage(ACCT, m1);
    s.mock.trash(ACCT, m2);
    const r = await s.service.sync({ principal: s.principal, connectionId: a.connectionId });
    assert.equal(r.lastSync.mode, 'incremental');
    assert.equal(r.lastSync.counts.removed, 2);
    assert.deepEqual(s.held(a.connectionId), [`msg:${m3}`, `msg:${m4}`]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('D · a dead saved listing position', () => {
  async function midPass() {
    const s = setup({ pageSize: 1 });
    for (const id of ids(52)) s.mock.addMessage(ACCT, msg(id));
    const a = await s.connect();
    const r = await s.service.sync({ principal: s.principal, connectionId: a.connectionId, mode: 'full' });   // 50 pages: incomplete
    assert.ok((await s.store.get(s.owner, a.connectionId)).fullSync?.cursor, 'a pass is saved');
    assert.equal(r.lastSync.state, 'partial');
    return { s, a };
  }

  test('D1 · Gmail rejects the saved page token (400) → position discarded, nothing deleted, next run lists from the start', async () => {
    const { s, a } = await midPass();
    const heldBefore = s.held(a.connectionId).length;
    s.mock.failNext('listMessages', 400);
    const r = await s.service.sync({ principal: s.principal, connectionId: a.connectionId });
    assert.equal(r.lastSync.state, 'failed');
    assert.match(r.lastSync.error, /saved listing position was discarded/);
    assert.equal((await s.store.get(s.owner, a.connectionId)).fullSync, null);
    assert.equal(s.held(a.connectionId).length, heldBefore, 'nothing deleted');
    const r2 = await s.service.sync({ principal: s.principal, connectionId: a.connectionId });
    assert.equal(r2.lastSync.mode, 'full');
    assert.equal((await s.store.get(s.owner, a.connectionId)).fullSync.runs, 1, 'a fresh pass');
  });

  test('D2 · an undecodable saved cursor is discarded the same way', async () => {
    const { s, a } = await midPass();
    const fs0 = (await s.store.get(s.owner, a.connectionId)).fullSync;
    await s.store.update(s.owner, a.connectionId, { fullSync: { ...fs0, cursor: 'not-json' } });
    const r = await s.service.sync({ principal: s.principal, connectionId: a.connectionId });
    assert.match(r.lastSync.error, /saved listing position was discarded/);
    assert.equal((await s.store.get(s.owner, a.connectionId)).fullSync, null);
  });

  test('D3 · a TRANSIENT failure on the resumed page keeps the position (Phase 1b.1 behaviour preserved)', async () => {
    const { s, a } = await midPass();
    const cursor = (await s.store.get(s.owner, a.connectionId)).fullSync.cursor;
    s.mock.failNext('listMessages', 503, 5);
    const r = await s.service.sync({ principal: s.principal, connectionId: a.connectionId });
    assert.equal(r.lastSync.state, 'failed');
    assert.equal((await s.store.get(s.owner, a.connectionId)).fullSync.cursor, cursor);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('A · Retry-After', () => {
  test('A1 · parseRetryAfter: seconds, HTTP-date, garbage', () => {
    assert.equal(parseRetryAfter('2'), 2000);
    assert.equal(parseRetryAfter(new Date(10_000 + 5_000).toUTCString(), () => 10_000), 5000);
    assert.equal(parseRetryAfter('soon'), null);
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter(new Date(0).toUTCString(), () => 10_000), 0, 'never negative');
  });

  function transportWith(status, retryAfter) {
    let calls = 0;
    const f = async () => { calls++; return calls === 1 ? new Response('{}', { status, headers: retryAfter == null ? {} : { 'retry-after': retryAfter } }) : new Response(JSON.stringify({ messages: [] }), { status: 200 }); };
    const t = createGoogleGmailTransport({ clientId: 'x.apps.googleusercontent.com', clientSecret: 'secret-xyz-123', redirectUri: 'https://a.test/api/aqua/connect/gmail/callback', fetch: f });
    return { c: createGmailConnector({ transport: t }), calls: () => calls };
  }
  const ctx = { connectionId: 'conn_x', credentials: () => ({ accessToken: 'a' }) };

  test('A2 · 429 with Retry-After: 2 → the run waits exactly 2 s (not its own backoff), then succeeds', async () => {
    const { c, calls } = transportWith(429, '2');
    const slept = [];
    const r = await withRetry(() => c.gmail.listMessages(ctx), { attempts: 3, baseMs: 1, sleep: async ms => { slept.push(ms); } });
    assert.deepEqual(slept, [2000]);
    assert.equal(calls(), 2);
    assert.deepEqual(r.messages, []);
  });

  test(`A3 · a Retry-After above ${MAX_RETRY_AFTER_MS / 1000} s ends the attempt at once (the durable job waits it out)`, async () => {
    const { c, calls } = transportWith(503, '120');
    const slept = [];
    await assert.rejects(withRetry(() => c.gmail.listMessages(ctx), { attempts: 3, baseMs: 1, sleep: async ms => { slept.push(ms); } }), e => e.kind === 'TRANSIENT' && e.retryAfterMs === 120_000);
    assert.deepEqual(slept, []);
    assert.equal(calls(), 1);
  });

  test('A4 · without Retry-After the engine\'s own bounded exponential backoff is used', async () => {
    const { c } = transportWith(503, null);
    const slept = [];
    // random → 1: the jitter's upper bound, i.e. exactly baseMs·2^i (jitter: [cap/2, cap]).
    await withRetry(() => c.gmail.listMessages(ctx), { attempts: 3, baseMs: 7, random: () => 1, sleep: async ms => { slept.push(ms); } });
    assert.deepEqual(slept, [7]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('X · drafts are out of scope', () => {
  test('X1 · a DRAFT is never imported; a sent message is', async () => {
    const s = setup();
    const [d, sent] = ids(2);
    s.mock.addMessage(ACCT, msg(d, { labels: ['DRAFT'], text: 'CANARY_DRAFT unsent words' }));
    s.mock.addMessage(ACCT, msg(sent, { labels: ['SENT'] }));
    const a = await s.connect();
    await s.service.sync({ principal: s.principal, connectionId: a.connectionId });
    assert.deepEqual(s.held(a.connectionId), [`msg:${sent}`]);
    assert.ok(!K.dataDirText().includes('CANARY_DRAFT'), 'no draft text at rest');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('G · account purge revokes the owner\'s grants first', () => {
  test('G1 · purge (local mode): every stored grant revoked at the provider, then the records and a tombstone', async () => {
    const s = setup();
    await s.connect();
    await s.connect('second@example.test');
    const r = await purgeConnectorState(s.owner, { stores: [s.store] });
    assert.equal(r.complete, true);
    assert.deepEqual(r.removed.providerRevocations, { revoked: 2, failed: 0, notAttempted: 0 });
    assert.deepEqual(s.mock.grants().map(g => g.revoked), [true, true]);
    assert.equal(r.removed.connections, 2);
  });

  test('G2 · a provider that refuses revocation is REPORTED; the purge still completes', async () => {
    const s = setup();
    await s.connect();
    s.mock.failNext('revoke', 503);
    const r = await purgeConnectorState(s.owner, { stores: [s.store] });
    assert.equal(r.complete, true);
    assert.deepEqual(r.removed.providerRevocations, { revoked: 0, failed: 1, notAttempted: 0 });
    assert.equal(await s.store.countByOwner(s.owner), 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('J · the durable sync job (connect.sync.v1)', () => {
  test('J1 · the job syncs the job OWNER\'s connection', async () => {
    const s = setup();
    for (const id of ids(2)) s.mock.addMessage(ACCT, msg(id));
    const a = await s.connect();
    const r = await runConnectSyncJob({ ownerId: s.owner, payload: { connectionId: a.connectionId } }, { getDeps: async () => ({ service: s.service }) });
    assert.equal(r.state, 'succeeded');
    assert.equal(s.held(a.connectionId).length, 2);
  });

  test('J2 · a job owned by ANOTHER user naming this connection finds nothing (no cross-owner sync)', async () => {
    const s = setup();
    s.mock.addMessage(ACCT, msg(ids(1)[0]));
    const a = await s.connect();
    const r = await runConnectSyncJob({ ownerId: 'user:intruder', payload: { connectionId: a.connectionId, ownerId: s.owner, userId: s.user } }, { getDeps: async () => ({ service: s.service }) });
    assert.deepEqual(r, { skipped: 'NOT_FOUND' });
    assert.equal(s.held(a.connectionId).length, 0);
  });

  test('J3 · paused / non-user owner / connect off → completes as a reported no-op; a busy lease is RETRIED (thrown)', async () => {
    const s = setup();
    const a = await s.connect();
    await s.service.pauseSync({ principal: s.principal, connectionId: a.connectionId });
    assert.deepEqual(await runConnectSyncJob({ ownerId: s.owner, payload: { connectionId: a.connectionId } }, { getDeps: async () => ({ service: s.service }) }), { skipped: 'PAUSED' });
    assert.deepEqual(await runConnectSyncJob({ ownerId: 'conv:x', payload: {} }, { getDeps: async () => ({ service: s.service }) }), { skipped: 'not-a-user-owner' });
    assert.deepEqual(await runConnectSyncJob({ ownerId: s.owner, payload: {} }, { getDeps: async () => ({ gmail: null }) }), { skipped: 'connect-disabled' });
    const busy = { sync: async () => { throw Object.assign(new Error('busy'), { code: 'BUSY' }); } };
    await assert.rejects(runConnectSyncJob({ ownerId: s.owner, payload: { connectionId: a.connectionId } }, { getDeps: async () => ({ service: busy }) }), e => e.code === 'BUSY');
  });

  test('J4 · the worker runtime does NOT run connect syncs (UKO store has one writer: the API); enqueueSync still validates', async () => {
    const W = await import('../../core/jobs/workerRuntime.js');
    assert.equal(W.HANDLERS[CONNECT_SYNC_JOB_KIND], undefined, 'a worker-run sync would split the UKO store between processes');
    await assert.rejects(enqueueSync({ ownerId: 'conv:x', connectionId: 'conn_00000000000000000000' }), e => e.code === 'UNAUTHENTICATED');
    await assert.rejects(enqueueSync({ ownerId: 'user:a', connectionId: '../x' }), e => e.code === 'NOT_FOUND');
    await assert.rejects(enqueueSync({ ownerId: 'user:a', connectionId: 'conn_00000000000000000000', mode: 'everything' }), e => e.code === 'BAD_REQUEST');
    await assert.rejects(enqueueSync({ ownerId: 'user:a', connectionId: 'conn_00000000000000000000' }), e => e.code === 'SYNC_QUEUE_UNAVAILABLE', 'no database in this file');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('W · authenticated status / sync / pause / resume routes', () => {
  let srv, base, s, a, enq;
  const sessions = new Map();
  before(async () => {
    s = setup({ pageSize: 1 });
    for (const id of ids(3)) s.mock.addMessage(ACCT, msg(id));
    a = await s.connect();
    enq = [];
    const built = buildGmailOAuth({ AQUA_GMAIL_CLIENT_ID: '1-a.apps.googleusercontent.com', AQUA_GMAIL_CLIENT_SECRET: 'secret-xyz-123', AQUA_GMAIL_REDIRECT_URI: 'https://a.test/api/aqua/connect/gmail/callback', APP_URL: 'https://a.test' });
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const sid = req.get('x-sid') ?? 'none';
      if (!sessions.has(sid)) sessions.set(sid, {});
      req.session = sessions.get(sid);
      if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
      req.aquaUserId = String(req.session.userId);
      next();
    });
    app.use('/api/aqua/connect', createConnectRouter({ getDeps: async () => ({ gmail: built.config, service: s.service, vault: {}, startSync: args => { enq.push({ ownerId: `user:${args.principal.userId}`, connectionId: args.connectionId, mode: args.mode, confirmMassDeletion: args.confirmMassDeletion }); return { started: true, running: true }; } }), log }));
    srv = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    base = `http://127.0.0.1:${srv.address().port}`;
    sessions.set('owner', { userId: s.user });
    sessions.set('other', { userId: 'someone-else' });
  });
  after(() => new Promise(r => srv.close(r)));
  const call = async (path, sid, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}/api/aqua/connect${path}`, { method, headers: { 'x-sid': sid, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, body: JSON.parse(text || 'null'), text };
  };

  test('W1 · status of the caller\'s connection: view + last sync + progress (counts only); no secrets', async () => {
    await s.service.sync({ principal: s.principal, connectionId: a.connectionId, mode: 'full' });   // pageSize 1, maxPages 50: completes 3
    const r = await call(`/connections/${a.connectionId}`, 'owner');
    assert.equal(r.status, 200);
    assert.equal(r.body.connection.connectionId, a.connectionId);
    assert.equal(r.body.connection.lastSync.state, 'succeeded');
    assert.equal(r.body.connection.syncPaused, false);
    assert.ok(!r.text.includes('SECRETVALUE') && !r.text.includes('CANARY_') && !r.text.includes(ACCT), 'no token, no content, no address');
    assert.equal((await call(`/connections/${a.connectionId}`, 'other')).status, 404);
    assert.equal((await call(`/connections/${a.connectionId}`, 'nobody')).status, 401);
  });

  test('W2 · POST /sync starts for the PRINCIPAL\'s owner (202); body may carry only mode/confirmMassDeletion', async () => {
    const r = await call(`/connections/${a.connectionId}/sync`, 'owner', { method: 'POST', body: { mode: 'incremental' } });
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { success: true, started: true, running: true });
    assert.deepEqual(enq.at(-1), { ownerId: s.owner, connectionId: a.connectionId, mode: 'incremental', confirmMassDeletion: false });
    const n = enq.length;
    assert.equal((await call(`/connections/${a.connectionId}/sync`, 'owner', { method: 'POST', body: { ownerId: 'user:victim' } })).status, 400);
    assert.equal((await call(`/connections/${a.connectionId}/sync`, 'owner', { method: 'POST', body: { userId: 'victim' } })).status, 400);
    assert.equal((await call(`/connections/${a.connectionId}/sync`, 'owner', { method: 'POST', body: { mode: 'everything' } })).status, 400);
    assert.equal((await call(`/connections/${a.connectionId}/sync`, 'owner', { method: 'POST', body: { confirmMassDeletion: 'yes' } })).status, 400);
    assert.equal((await call(`/connections/${a.connectionId}/sync`, 'other', { method: 'POST' })).status, 404, 'another owner cannot queue it');
    assert.equal(enq.length, n, 'nothing queued by any refused request');
  });

  test('W3 · pause → status says paused, /sync refused 409 PAUSED; resume → queued again', async () => {
    assert.equal((await call(`/connections/${a.connectionId}/pause`, 'owner', { method: 'POST' })).body.connection.syncPaused, true);
    const r = await call(`/connections/${a.connectionId}/sync`, 'owner', { method: 'POST' });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'PAUSED');
    assert.equal((await call(`/connections/${a.connectionId}/pause`, 'other', { method: 'POST' })).status, 404);
    assert.equal((await call(`/connections/${a.connectionId}/resume`, 'owner', { method: 'POST' })).body.connection.syncPaused, false);
    assert.equal((await call(`/connections/${a.connectionId}/sync`, 'owner', { method: 'POST' })).status, 202);
  });

  test('W4 · with no sync runner the route answers 503 (never runs a sync inside the request)', async () => {
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { req.session = { userId: s.user }; req.aquaUserId = s.user; next(); });
    const built = buildGmailOAuth({ AQUA_GMAIL_CLIENT_ID: '1-a.apps.googleusercontent.com', AQUA_GMAIL_CLIENT_SECRET: 'secret-xyz-123', AQUA_GMAIL_REDIRECT_URI: 'https://a.test/api/aqua/connect/gmail/callback', APP_URL: 'https://a.test' });
    app.use('/c', createConnectRouter({ getDeps: async () => ({ gmail: built.config, service: s.service, vault: {} }), log }));
    const x = await new Promise(r => { const y = app.listen(0, '127.0.0.1', () => r(y)); });
    try {
      const r = await fetch(`http://127.0.0.1:${x.address().port}/c/connections/${a.connectionId}/sync`, { method: 'POST' });
      assert.equal(r.status, 503);
      assert.equal((await r.json()).code, 'unavailable');
    } finally { await new Promise(r => x.close(r)); }
  });
});

describe('isolation', () => {
  test('no request left the machine; nothing secret or mailbox-like in the logs', () => {
    assert.deepEqual(egress, []);
    const text = logs.join('\n');
    assert.ok(!text.includes('SECRETVALUE') && !text.includes('CANARY_') && !/[\w.]+@example\.test/.test(text));
  });
});
