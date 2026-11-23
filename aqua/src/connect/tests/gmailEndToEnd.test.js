/**
 * Gmail finalization (2026-11-23) — the whole connector through the real HTTP
 * routes, in ONE process, the way production runs it:
 *
 *   OAuth start → consent (mock Google) → callback → connection (sealed credentials)
 *   → POST /sync → the in-process runner (productionDeps.createInProcessSyncRunner)
 *   → initial full sync over several listing pages → ingest → deterministic
 *   understanding → the Email intelligence API reads it in the SAME process
 *   → incremental sync (new mail; deleted mail) → pause/resume → revoke → disconnect.
 *
 * MOCK GOOGLE ONLY. This proves the wiring between the modules; it says nothing
 * about real Gmail behaviour (that needs the authorised real-mailbox test).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const K = await import('./testkit.js');
const egress = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { const u = new URL(String(url)); if (u.hostname !== '127.0.0.1') { egress.push(u.host); throw new Error('network refused'); } return realFetch(url, init); };

const express = (await import('express')).default;
const F = await import('../testing/gmailFixtures.js');
const { createGmailConnector, GMAIL_READONLY_SCOPE } = await import('../gmail/gmailConnector.js');
const { createMockGmailService } = await import('../testing/mockGmailTransport.js');
const { createConnectRouter } = await import('../../routes/connect.js');
const { buildGmailOAuth } = await import('../gmail/gmailOAuthConfig.js');
const { createInProcessSyncRunner } = await import('../productionDeps.js');
const EG = await import('../../core/egressGuard.js');

const ORIGIN = 'https://aquiplex.com';
const OAUTH = buildGmailOAuth({ AQUA_GMAIL_CLIENT_ID: '1-a.apps.googleusercontent.com', AQUA_GMAIL_CLIENT_SECRET: 'secret-e2e-123', AQUA_GMAIL_REDIRECT_URI: `${ORIGIN}/api/aqua/connect/gmail/callback`, APP_URL: ORIGIN, NODE_ENV: 'production' });
const NOW = Date.parse('2026-01-06T00:00:00Z');
const PRIYA = 'Priya Sharma <priya@acme.example>', RAJ = 'Raj Mehta <raj@acme.example>';
const mail = (id, o) => F.buildMessage({ id, threadId: o.thread ?? 'thr-launch', date: o.date, headers: { From: o.from ?? PRIYA, To: o.to ?? RAJ, Subject: o.subject ?? 'Launch plan', 'Message-ID': `<${id}@acme.example>` }, text: o.text });
const INITIAL = [
  ['18e0000000000001', { date: 'Mon, 5 Jan 2026 09:00:00 +0000', text: "I'll send the deck by Monday. We decided to use Postgres for storage." }],
  ['18e0000000000002', { date: 'Mon, 5 Jan 2026 12:00:00 +0000', from: RAJ, to: PRIYA, subject: 'Re: Launch plan', text: 'The launch is March 15.' }],
  ['18e0000000000003', { date: 'Mon, 5 Jan 2026 13:00:00 +0000', thread: 'thr-atlas', subject: 'Atlas kickoff', text: 'Project Atlas kickoff call on Thursday at 10am. Raj, please review the budget by Friday.' }],
  ['18e0000000000004', { date: 'Mon, 5 Jan 2026 14:00:00 +0000', thread: 'thr-misc', subject: 'Lunch', text: 'Thanks for lunch today, it was great to catch up.' }],
  ['18e0000000000005', { date: 'Mon, 5 Jan 2026 15:00:00 +0000', thread: 'thr-misc2', subject: 'Notes', text: 'Here are the notes from the call, nothing new to report.' }],
];

describe('E2E · Gmail connector through the real routes, one process (mock Google)', () => {
  let srv, base, mock, service, runner, sessions;
  const ACCT = `e2e-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const USER = `e2e-${crypto.randomBytes(5).toString('hex')}`;
  const OTHER = `e2e-other-${crypto.randomBytes(5).toString('hex')}`;
  let connectionId;

  before(async () => {
    mock = createMockGmailService({ now: Date.now });
    for (const [id, o] of INITIAL) mock.addMessage(ACCT, mail(id, o));
    const registry = K.createConnectorRegistry({ allowTestOnly: true });
    registry.register(createGmailConnector({ transport: mock.transport, pageSize: 2 }));   // the initial listing spans 3 pages
    service = K.createConnectService({ registry, store: K.createMemoryConnectionStore(), vault: K.createCredentialVault({ key: K.TEST_KEY }), log: { log() {}, warn() {} }, retry: { sleep: async () => {}, baseMs: 0 } });
    runner = createInProcessSyncRunner({ service, log: { log() {}, warn() {} } });
    const mkSession = userId => { const s = { userId }; Object.defineProperty(s, 'save', { value: cb => cb(), enumerable: false }); return s; };
    sessions = new Map([['a', mkSession(USER)], ['b', mkSession(OTHER)]]);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {                     // stands in for express-session + requireLogin + aquaAccess
      const sess = sessions.get(req.get('x-sid') ?? 'none');
      if (!sess?.userId) return res.status(401).json({ error: 'Login required' });
      req.session = sess;
      req.aquaUserId = String(sess.userId);
      EG.runWithDataClass('user', () => next());      // like aqua/router.js
    });
    app.use('/api/aqua/connect', createConnectRouter({
      getDeps: async () => ({ gmail: OAUTH.config, service, vault: {}, startSync: runner.start, isSyncing: runner.isRunning }),
      now: () => NOW, log: { log() {}, warn() {} },
    }));
    srv = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    base = `http://127.0.0.1:${srv.address().port}/api/aqua/connect`;
  });
  after(() => new Promise(r => srv.close(r)));

  const call = async (p, { sid = 'a', method = 'GET', body } = {}) => {
    const r = await fetch(base + p, { method, redirect: 'manual', headers: { 'x-sid': sid, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, location: r.headers.get('location'), body: json, text };
  };
  const syncAndWait = async (body = {}) => {
    const r = await call(`/connections/${connectionId}/sync`, { method: 'POST', body });
    assert.equal(r.status, 202, r.text);
    await runner.idle();
    return (await call(`/connections/${connectionId}`)).body.connection;
  };
  const commitments = async () => (await call('/gmail/intelligence/view/commitments')).body.items.map(i => i.statement);
  const ask = async question => (await call('/gmail/intelligence/ask', { method: 'POST', body: { question } })).body;

  test('E1 · connect: start → consent → callback lands on the Email page; credentials sealed, never returned', async () => {
    const start = await call('/gmail/start');
    assert.equal(start.status, 302);
    const p = Object.fromEntries(new URL(start.location).searchParams);
    assert.equal(p.scope, GMAIL_READONLY_SCOPE);
    const code = mock.authorizeCode(ACCT, { redirectUri: p.redirect_uri, codeChallenge: p.code_challenge, scopes: [GMAIL_READONLY_SCOPE] });
    const cb = await call(`/gmail/callback?${new URLSearchParams({ state: p.state, code })}`);
    assert.equal(cb.status, 303);
    const back = new URL(cb.location, ORIGIN);
    assert.deepEqual([back.pathname, back.searchParams.get('gmailConnect')], ['/aqua/email', 'connected']);
    const list = await call('/connections');
    assert.equal(list.body.connections.length, 1);
    const c = list.body.connections[0];
    assert.deepEqual([c.connectorId, c.status, c.hasCredentials, c.syncing, c.lastSync ?? null], ['gmail', 'active', true, false, null]);
    assert.deepEqual([c.syncPhase, c.imported, c.initialSyncComplete], ['not_started', 0, false]);
    assert.ok(!list.text.includes(ACCT) && !/token|secret/i.test(JSON.stringify(c.credentials ?? '')), 'no address, no credentials in the view');
    connectionId = c.connectionId;
    assert.equal((await call('/gmail/intelligence/overview')).body.counts.items, 0, 'nothing imported before a sync');
  });

  test('E2 · initial sync runs in THIS process (multi-page listing) and the Email API sees the result at once', async () => {
    const conn = await syncAndWait({ mode: 'auto' });
    assert.equal(conn.lastSync.state, 'succeeded', JSON.stringify(conn.lastSync));
    assert.equal(conn.syncing, false);
    assert.deepEqual([conn.syncPhase, conn.imported, conn.initialSyncComplete], ['initial_complete', 5, true]);
    assert.ok(conn.lastSync.lastSuccessAt);
    const ov = (await call('/gmail/intelligence/overview')).body;
    assert.equal(ov.generatedBy, 'deterministic');
    assert.ok(ov.counts.items > 0 && ov.counts.openCommitments >= 1 && ov.counts.openTasks >= 1, JSON.stringify(ov.counts));
    assert.ok((await commitments()).some(s => /send the deck by Monday/.test(s)));
    const dec = await ask('What did we decide about storage?');
    assert.deepEqual([dec.supported, dec.modelUsed, dec.items.map(i => i.statement)], [true, false, ['We decided to use Postgres for storage.']]);
    const ev = (await call(`/gmail/intelligence/evidence/${dec.items[0].id}`)).body;
    assert.equal(ev.evidence.gmailMessageId, '18e0000000000001');
    assert.match(ev.evidence.quote, /Postgres for storage/);
  });

  test('E3 · owner isolation: another signed-in user sees no connection, no items, no evidence', async () => {
    const id = (await ask('What did we decide about storage?')).items[0].id;
    assert.deepEqual((await call('/connections', { sid: 'b' })).body.connections, []);
    assert.equal((await call(`/connections/${connectionId}`, { sid: 'b' })).status, 404);
    assert.equal((await call(`/connections/${connectionId}/sync`, { sid: 'b', method: 'POST' })).status, 404);
    assert.equal((await call('/gmail/intelligence/overview', { sid: 'b' })).body.counts.items, 0);
    assert.equal((await call(`/gmail/intelligence/evidence/${id}`, { sid: 'b' })).status, 404);
    assert.equal((await call('/connections', { sid: 'nobody' })).status, 401);
  });

  test('E4 · incremental sync: new mail is understood; a superseding decision is linked', async () => {
    mock.addMessage(ACCT, mail('18e0000000000006', { date: 'Tue, 6 Jan 2026 09:00:00 +0000', text: 'Actually, we have decided to use MySQL instead.' }));
    const conn = await syncAndWait();
    assert.equal(conn.lastSync.state, 'succeeded');
    const dec = await ask('What did we decide about storage?');
    assert.deepEqual([dec.items.map(i => i.statement), dec.superseded.map(i => i.statement)], [['Actually, we have decided to use MySQL instead.'], ['We decided to use Postgres for storage.']]);
  });

  test('E5 · deletion at Gmail removes the message and everything extracted from it', async () => {
    const deck = (await call('/gmail/intelligence/view/commitments')).body.items.find(i => /send the deck/.test(i.statement));
    mock.deleteMessage(ACCT, '18e0000000000001');
    await syncAndWait();
    assert.ok(!(await commitments()).some(s => /send the deck/.test(s)));
    assert.equal((await call(`/gmail/intelligence/evidence/${deck.id}`)).status, 404);
    // The MySQL update matched "storage" only through the decision it superseded; with that
    // email deleted, the decisions view is the honest check.
    const decisions = (await call('/gmail/intelligence/view/decisions')).body.items.map(i => i.statement);
    assert.ok(decisions.includes('Actually, we have decided to use MySQL instead.'), JSON.stringify(decisions));
    assert.ok(!decisions.some(s => /Postgres/.test(s)), 'the deleted Postgres decision is gone');
    const superseded = (await call('/gmail/intelligence/view/superseded')).body.items.map(i => i.statement);
    assert.ok(!superseded.some(s => /Postgres/.test(s)));
  });

  test('E6 · single flight: a second request while a sync runs reports it running and starts nothing', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    let calls = 0;
    const slow = createInProcessSyncRunner({ service: { sync: async () => { calls++; await gate; } }, log: { log() {}, warn() {} } });
    const principal = { userId: USER };
    assert.deepEqual(slow.start({ principal, connectionId }), { started: true, running: true });
    assert.deepEqual(slow.start({ principal, connectionId }), { started: false, running: true });
    assert.equal(slow.isRunning(`user:${USER}`, connectionId), true);
    release();
    await slow.idle();
    assert.equal(calls, 1);
    assert.equal(slow.isRunning(`user:${USER}`, connectionId), false);
    const failing = createInProcessSyncRunner({ service: { sync: async () => { throw Object.assign(new Error('Subject: secret plans'), { code: 'BUSY' }); } }, log: { log() {}, warn: m => { assert.doesNotMatch(m, /secret plans/); } } });
    failing.start({ principal, connectionId });
    await failing.idle();   // a failed background sync never throws out of the runner
    assert.throws(() => failing.start({ principal: {}, connectionId }), e => e.code === 'UNAUTHENTICATED');
  });

  test('E7 · pause refuses sync; resume allows it; revoke keeps imported mail; disconnect deletes it all', async () => {
    assert.equal((await call(`/connections/${connectionId}/pause`, { method: 'POST' })).body.connection.syncPaused, true);
    assert.equal((await call(`/connections/${connectionId}`)).body.connection.syncPhase, 'paused');
    assert.equal((await call(`/connections/${connectionId}/sync`, { method: 'POST' })).status, 409);
    assert.equal((await call(`/connections/${connectionId}/resume`, { method: 'POST' })).body.connection.syncPaused, false);
    const before = (await call('/gmail/intelligence/overview')).body.counts.items;
    const rv = await call(`/connections/${connectionId}/revoke`, { method: 'POST' });
    assert.equal(rv.status, 200, rv.text);
    assert.equal((await call(`/connections/${connectionId}`)).body.connection.status, 'revoked');
    assert.equal((await call('/gmail/intelligence/overview')).body.counts.items, before, 'revoke keeps imported email (retention model)');
    assert.equal((await call(`/connections/${connectionId}/sync`, { method: 'POST' })).status, 409, 'a revoked connection cannot sync');
    const del = await call(`/connections/${connectionId}`, { method: 'DELETE' });
    assert.equal(del.status, 200, del.text);
    assert.deepEqual((await call('/connections')).body.connections, []);
    assert.equal((await call('/gmail/intelligence/overview')).body.counts.items, 0);
  });

  test('E8 · privacy: nothing left the machine, no provider call was attempted with Gmail in scope, no content remains on disk', async () => {
    assert.deepEqual(egress, []);
    assert.equal(JSON.stringify(EG.egressStats()).includes('external:gmail'), false);
    await new Promise(r => setTimeout(r, 1500));   // the UKO store's debounced writer
    const hits = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { let t = ''; try { t = fs.readFileSync(p, 'utf8'); } catch { /* binary */ } if (/MySQL instead|review the budget|catch up/.test(t)) hits.push(path.relative(K.TMP, p)); } } };
    walk(K.TMP);
    assert.deepEqual(hits, [], `email content survived disconnect: ${hits.join(', ')}`);
  });
});
