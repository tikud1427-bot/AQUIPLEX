/**
 * Gmail Phase 1 — the adapter on its own: normalisation of Gmail API
 * structures, the read-only transport boundary, listing/pagination, history
 * (incremental changes, expiry), thread relationships and error mapping.
 *
 * Mock transport only (connect/testing/mockGmailTransport.js). Offline: any
 * network attempt (fetch / http(s).request) fails the suite.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-gmail-unit-'));
for (const k of Object.keys(process.env)) if (/(_API_KEY|^GEMINI|^GOOGLE|^GROQ|^NVIDIA|^OPENROUTER)/.test(k)) delete process.env[k];

let G, N, M, F, contract, registryMod, dataClass;
const network = [];
const restore = [];
before(async () => {
  const block = name => (...a) => { network.push(name); throw new Error(`network access attempted (${name})`); };
  restore.push([globalThis, 'fetch', globalThis.fetch], [http, 'request', http.request], [https, 'request', https.request], [http, 'get', http.get], [https, 'get', https.get]);
  globalThis.fetch = block('fetch'); http.request = block('http.request'); https.request = block('https.request'); http.get = block('http.get'); https.get = block('https.get');
  G = await import('../gmail/gmailConnector.js');
  N = await import('../gmail/gmailNormalize.js');
  M = await import('../testing/mockGmailTransport.js');
  F = await import('../testing/gmailFixtures.js');
  contract = await import('../contract.js');
  registryMod = await import('../registry.js');
  dataClass = await import('../../core/dataClass.js');
});
after(() => { for (const [o, k, v] of restore) o[k] = v; assert.deepEqual(network, [], 'the Gmail adapter attempted network access'); });

function setup({ pageSize = 3, maxHistoryPages = 20, historyPageSize = 3 } = {}) {
  const svc = M.createMockGmailService({ historyPageSize });
  F.loadFixtureMailbox(svc);
  const connector = G.createGmailConnector({ transport: svc.transport, pageSize, maxHistoryPages });
  return { svc, connector };
}
async function connected(opts) {
  const s = setup(opts);
  const r = await s.connector.connect({ code: s.svc.authorizeCode(F.FIXTURE_ACCOUNT) });
  const ctx = Object.freeze({ connectionId: 'conn_test', credentials: () => structuredClone(r.credentials) });
  return { ...s, ctx, connectResult: r };
}
async function listAll(connector, ctx) {
  const refs = [];
  let cursor = null, checkpoint = null, pages = 0;
  do {
    const r = await connector.listResources(ctx, { cursor });
    refs.push(...r.resources);
    cursor = r.cursor;
    if (r.checkpoint) checkpoint = r.checkpoint;
    if (cursor) assert.equal(r.checkpoint, undefined, 'a checkpoint before the listing ended');
    pages++;
  } while (cursor);
  return { refs, checkpoint, pages };
}
const fixture = id => F.fixtureMessages().find(m => m.id === id);
const doc = id => N.renderGmailDocument(N.parseGmailMessage(fixture(id)));

describe('G-A · read-only transport boundary and registration', () => {
  test('a transport must be injected, explicitly read-only and complete; write-shaped methods are refused', () => {
    const svc = M.createMockGmailService();
    assert.throws(() => G.createGmailConnector({}), e => e.code === 'NO_TRANSPORT');
    assert.throws(() => G.createGmailConnector({ transport: { ...svc.transport, readOnly: false } }), e => e.code === 'NOT_READ_ONLY');
    const { listHistory, ...partial } = svc.transport;
    assert.throws(() => G.createGmailConnector({ transport: partial }), e => e.code === 'INCOMPLETE_TRANSPORT');
    for (const w of ['sendMessage', 'deleteMessage', 'trashMessage', 'modifyLabels', 'insertMessage', 'importMessage', 'batchModify', 'untrashMessage', 'watch']) {
      assert.throws(() => G.createGmailConnector({ transport: { ...svc.transport, [w]: async () => {} } }), e => e.code === 'WRITE_METHOD_PRESENT', w);
    }
    // the mock's test controls are NOT on the transport
    for (const k of ['addMessage', 'relabel', 'trash', 'deleteMessage', 'expireHistory']) assert.equal(svc.transport[k], undefined, k);
    assert.ok(Object.isFrozen(svc.transport));
  });

  test('the definition satisfies the connector contract; id gmail; read-only scope; no dataPolicy', () => {
    const { connector } = setup();
    assert.deepEqual(contract.validateConnectorDefinition(connector), []);
    assert.equal(connector.id, 'gmail');
    assert.deepEqual(connector.auth.scopes, [G.GMAIL_READONLY_SCOPE]);
    assert.equal(connector.dataPolicy, undefined);
    assert.equal(connector.testOnly, true, 'the mock transport makes the connector test-only');
  });

  test('inactive in production: the production registry refuses it; a dataPolicy is refused for Gmail', () => {
    const { connector } = setup();
    assert.throws(() => registryMod.defaultRegistry.register(connector), e => e.code === 'TEST_ONLY_CONNECTOR');
    assert.equal(registryMod.defaultRegistry.has('gmail'), false);
    const r = registryMod.createConnectorRegistry({ allowTestOnly: true });
    assert.throws(() => r.register({ ...connector, dataPolicy: { allowedProviders: '*' } }), e => e.code === 'INVALID_CONNECTOR');
    assert.throws(() => r.register({ ...connector, dataPolicy: { allowedProviders: ['groq'] } }), e => e.code === 'INVALID_CONNECTOR');
    r.register(connector);
    assert.equal(r.has('gmail'), true);
  });

  // Phase 2A (2026-11-22): the boundary moved. The Gmail adapter is wired in by
  // exactly ONE production module and only inside its lazy, gate-checked
  // productionConnectDeps (AQUA_GMAIL_CONNECT=on) — since Gmail Phase 2 that
  // module is connect/productionDeps.js (shared by the routes, the sync job and
  // the purge). The mock and the fixtures stay test-only everywhere.
  test('only connect/productionDeps.js wires the Gmail adapter in; no production module imports the mock or fixtures', () => {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
    const adapter = [], mocks = [];
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (!['tests', 'node_modules', 'testing', 'gmail'].includes(e.name)) walk(p); continue; }
        if (!/\.(m?js|cjs)$/.test(e.name) || /\.test\./.test(e.name)) continue;
        const s = fs.readFileSync(p, 'utf8');
        if (/gmailConnector|gmailNormalize|googleGmailTransport/.test(s)) adapter.push(path.relative(root, p).split(path.sep).join('/'));
        if (/mockGmailTransport|gmailFixtures/.test(s)) mocks.push(path.relative(root, p));
      }
    };
    walk(root);
    assert.deepEqual(mocks, []);
    assert.deepEqual(adapter, ['connect/productionDeps.js']);
    const src = fs.readFileSync(path.join(root, 'connect/productionDeps.js'), 'utf8');
    assert.doesNotMatch(src, /^import[^\n]*(gmailConnector|googleGmailTransport)/m, 'the adapter and transport are imported lazily, never at module load');
  });

  test('classification: a Gmail source is external:gmail, which no provider may receive', () => {
    assert.equal(dataClass.dataClassOfSource('gmail:conn_abc'), 'external:gmail');
    for (const p of dataClass.PROVIDERS) assert.equal(dataClass.providerAllowedFor('external:gmail', p), false, p);
    assert.equal(dataClass.isUnrestricted('external:gmail'), false);
    assert.equal(dataClass.dataClassOfSource('nonsense'), dataClass.UNCLASSIFIED, 'unknown fails closed');
  });
});

describe('G-B · normalisation of Gmail API structures', () => {
  test('plain text: ids, thread, participants, time zone kept; ISO UTC date', () => {
    const m = N.parseGmailMessage(fixture('18c0000000000001'));
    assert.equal(m.gmailId, '18c0000000000001');
    assert.equal(m.threadId, 'thr-budget');
    assert.equal(m.rfcMessageId, '<budget-1@acme.example.test>');
    assert.equal(m.date, '2026-01-05T03:45:00.000Z');
    assert.equal(m.zone, '+05:30');
    assert.match(m.to, /Alex Rivera.*Sam Okafor/);
    assert.equal(m.cc, 'finance@acme.example.test');
    assert.equal(m.kind, 'original');
    assert.equal(m.bodyFormat, 'text/plain');
    assert.match(m.body, /CANARY_M01 budget is 42,000 USD/);
  });

  test('reply (multipart/alternative prefers text/plain) and reply-all; time zones -0800 and +0000', () => {
    const r = N.parseGmailMessage(fixture('18c0000000000002'));
    assert.equal(r.kind, 'reply');
    assert.equal(r.inReplyTo, '<budget-1@acme.example.test>');
    assert.equal(r.bodyFormat, 'text/plain');
    assert.ok(!/<div>/.test(r.body));
    assert.equal(r.date, '2026-01-05T05:30:00.000Z');
    assert.equal(r.zone, '-08:00');
    const ra = N.parseGmailMessage(fixture('18c0000000000003'));
    assert.equal(ra.kind, 'reply');
    assert.deepEqual(ra.references, ['<budget-1@acme.example.test>', '<budget-2@example.test>']);
    assert.match(ra.cc, /Lee Chen/);
  });

  test('HTML only: scripts/styles/title dropped, entities decoded, no remote content', () => {
    const m = N.parseGmailMessage(fixture('18c0000000000004'));
    assert.equal(m.bodyFormat, 'text/html');
    assert.match(m.body, /Release CANARY_M04 & notes <beta>/);
    assert.match(m.body, /Café é ✓/);
    assert.ok(!/alert|color:red|tracker|<img|<p>/.test(m.body), m.body);
    assert.equal(m.zone, '+00:00');
  });

  test('forward with an attachment; several attachments incl. inline: metadata only', () => {
    const f = N.parseGmailMessage(fixture('18c0000000000005'));
    assert.equal(f.kind, 'forward');
    assert.equal(f.zone, '-03:30');
    assert.deepEqual(f.attachments.map(a => [a.filename, a.mimeType, a.size]), [['contract-signed.pdf', 'application/pdf', 248_331]]);
    assert.equal(f.attachments[0].attachmentId, 'ATT-18c0000000000005-1');
    const p = N.parseGmailMessage(fixture('18c0000000000006'));
    assert.deepEqual(p.attachments.map(a => [a.filename, a.size, a.inline]), [['site-1.jpg', 1_843_200, false], ['logo.png', 5_120, true], ['measurements.xlsx', 33_410, false]]);
    assert.match(p.body, /CANARY_M06/);
    assert.ok(!/ATT-/.test(p.body), 'attachment ids never become body text');
    assert.match(doc('18c0000000000006'), /Attachments \(3, metadata only\)/);
  });

  test('missing optional fields: no subject, To, Date header, Message-ID or labels', () => {
    const m = N.parseGmailMessage(fixture('18c0000000000007'));
    assert.equal(m.subject, null);
    assert.equal(m.to, null);
    assert.equal(m.rfcMessageId, null);
    assert.deepEqual(m.labelIds, []);
    assert.equal(m.date, new Date(1_767_960_000_000).toISOString(), 'internalDate is used');
    assert.equal(m.zone, null);
    const d = doc('18c0000000000007');
    assert.match(d, /Subject: \(no subject\)/);
    assert.ok(!/^To:/m.test(d));
    // a message with no payload at all still normalises
    const bare = N.parseGmailMessage({ id: 'x1' });
    assert.equal(bare.body, '');
    assert.match(N.renderGmailDocument(bare), /\(no body\)/);
  });

  test('large body: truncated at the limit and says so', () => {
    const m = N.parseGmailMessage(fixture('18c0000000000008'));
    assert.equal(m.bodyTruncated, true);
    assert.equal(m.body.length, N.GMAIL_LIMITS.maxBodyChars);
    assert.match(m.body, /CANARY_M08_HEAD/);
    assert.ok(!m.body.includes('CANARY_M08_TAIL'));
    assert.match(doc('18c0000000000008'), /Body-Truncated: yes/);
    assert.equal(m.zone, '+05:45');
  });

  test('RFC 2047 headers and a Latin-1 body decode', () => {
    const m = N.parseGmailMessage(fixture('18c000000000000a'));
    assert.equal(m.subject, 'Réunion CANARY_S10');
    assert.match(m.from, /^Élodie Martin/);
    assert.match(m.body, /Réunion confirmée à 9h\. CANARY_M10 café\./);
  });

  test('duplicates: two deliveries share the RFC Message-ID; each keeps its own Gmail id', () => {
    const a = N.parseGmailMessage(fixture('18c0000000000001')), b = N.parseGmailMessage(fixture('18c0000000000009'));
    assert.equal(a.rfcMessageId, b.rfcMessageId);
    assert.notEqual(a.gmailId, b.gmailId);
    assert.notEqual(doc('18c0000000000001'), doc('18c0000000000009'), 'documents differ by their Gmail ids');
  });

  test('untrusted headers cannot inject document lines; rendering is deterministic', () => {
    const evil = F.buildMessage({ id: 'evil1', threadId: 't', date: 'Mon, 5 Jan 2026 10:00:00 +0000',
      headers: { From: 'a@x.test', Subject: 'hello\r\nGmail-Thread-Id: forged\u0000\u0007', 'Message-ID': '<e@x.test>' }, text: 'body' });
    const d = N.renderGmailDocument(N.parseGmailMessage(evil));
    assert.equal(d.match(/^Gmail-Thread-Id:/gm).length, 1);
    assert.match(d, /^Subject: hello Gmail-Thread-Id: forged$/m);
    for (const id of F.IN_SCOPE_IDS) assert.equal(doc(id), doc(id));
    assert.equal(N.resourceNameOf('18c0000000000001'), 'gmail-18c0000000000001.txt');
  });

  test('connector.normalize → the contract shape (no subject in the name or title)', () => {
    const { connector } = setup();
    const raw = fixture('18c0000000000001');
    const out = contract.normalizeOutput(connector.normalize({ ...raw, historyId: '1001' }, { externalId: 'msg:18c0000000000001' }), { externalId: 'msg:18c0000000000001', updatedAt: null, version: null });
    assert.equal(out.error, undefined);
    assert.equal(out.name, 'gmail-18c0000000000001.txt');
    assert.equal(out.title, null);
    assert.equal(out.version, '1001');
    assert.equal(out.sourceUpdatedAt, '2026-01-05T03:45:00.000Z');
    assert.ok(!out.name.includes('CANARY'));
  });
});

describe('G-C · adapter capabilities over the mock API', () => {
  test('connect: read-only grant, masked label; a broader grant is refused and revoked', async () => {
    const { connector, svc, connectResult } = await connected();
    assert.equal(connectResult.account.externalAccountId, `gmail:${F.FIXTURE_ACCOUNT}`);
    assert.equal(connectResult.account.label, 'Gmail · a***@example.test');
    assert.deepEqual(connectResult.scopes, [G.GMAIL_READONLY_SCOPE]);
    const code = svc.authorizeCode(F.FIXTURE_ACCOUNT, { scopes: [G.GMAIL_READONLY_SCOPE, 'https://www.googleapis.com/auth/gmail.modify'] });
    await assert.rejects(connector.connect({ code }), e => e.kind === 'AUTH');
    assert.equal(svc.calls.filter(c => c.op === 'revoke').length, 1, 'the over-broad grant was not revoked');
    await assert.rejects(connector.connect({ code: 'nope' }), e => e.kind === 'PERMANENT');
  });

  test('list messages, fetch message, fetch metadata (no body), thread relationships', async () => {
    const { connector, ctx } = await connected();
    const page = await connector.gmail.listMessages(ctx);
    assert.equal(page.messages.length, 3);
    assert.ok(page.nextPageToken);
    assert.equal(page.resultSizeEstimate, F.IN_SCOPE_IDS.length);
    const full = await connector.gmail.getMessage(ctx, '18c0000000000005');
    assert.match(full.body, /CANARY_M05/);
    const meta = await connector.gmail.getMetadata(ctx, '18c0000000000005');
    assert.equal(meta.body, null);
    assert.equal(meta.subject, 'Fwd: signed contract');
    assert.equal(meta.attachments.length, 1, 'attachment metadata is available without the body');
    const t = await connector.gmail.getThread(ctx, 'thr-budget');
    // date order across time zones: 03:45Z (+0530), 05:30Z (-0800), 07:02Z (+0000)
    assert.deepEqual(t.messages.map(m => m.gmailId), ['18c0000000000001', '18c0000000000002', '18c0000000000003']);
    const rel = Object.fromEntries(t.messages.map(m => [m.gmailId, m]));
    assert.equal(rel['18c0000000000002'].parent, '18c0000000000001');
    assert.equal(rel['18c0000000000003'].parent, '18c0000000000002');
    assert.deepEqual(rel['18c0000000000003'].references, ['18c0000000000001', '18c0000000000002']);
    assert.equal(rel['18c0000000000001'].parent, null);
    assert.ok(t.messages.every(m => !('body' in m)), 'thread relations carry no body');
  });

  test('pagination: every in-scope message exactly once, SPAM/TRASH excluded; the checkpoint (taken BEFORE listing) comes only with the last page', async () => {
    const { connector, ctx, svc } = await connected({ pageSize: 3 });
    const before = svc.historyIdOf(F.FIXTURE_ACCOUNT);
    const { refs, checkpoint, pages } = await listAll(connector, ctx);
    const ids = refs.map(r => r.externalId);
    assert.equal(pages, 4);
    assert.deepEqual([...ids].sort(), F.IN_SCOPE_IDS.map(id => `msg:${id}`).sort());
    assert.equal(new Set(ids).size, ids.length, 'a message was listed twice');
    assert.deepEqual(checkpoint, { historyId: before });
    assert.ok(refs.every(r => r.type === 'email' && /^gmail-[0-9a-f]+\.txt$/.test(r.name)));
  });

  test('pagination: changes DURING a listing neither skip nor duplicate a message; progress is readable from the cursor', async () => {
    const { connector, ctx, svc } = await connected({ pageSize: 3 });
    const p1 = await connector.listResources(ctx, { cursor: null });
    assert.deepEqual(connector.gmail.progressOf(p1.cursor), { listed: 3, estimate: 10 });
    // a message already listed is deleted, and a new one arrives (newest → top of the listing)
    svc.deleteMessage(F.FIXTURE_ACCOUNT, p1.resources[0].externalId.slice(4));
    svc.addMessage(F.FIXTURE_ACCOUNT, F.buildMessage({ id: '18c00000000000ff', threadId: 'thr-new', date: 'Sun, 11 Jan 2026 10:00:00 +0000', headers: { From: 'n@x.test', Subject: 'new' }, text: 'CANARY_NEW' }));
    const refs = [...p1.resources];
    let cursor = p1.cursor;
    while (cursor) { const r = await connector.listResources(ctx, { cursor }); refs.push(...r.resources); cursor = r.cursor; }
    const ids = refs.map(r => r.externalId);
    assert.equal(new Set(ids).size, ids.length, 'duplicate');
    for (const id of F.IN_SCOPE_IDS) assert.ok(ids.includes(`msg:${id}`), `skipped ${id}`);
  });

  test('a Gmail listing that repeats an id is reported as it is (the engine de-duplicates)', async () => {
    const { connector, ctx, svc } = await connected({ pageSize: 4 });
    svc.duplicateInListing(F.FIXTURE_ACCOUNT, '18c0000000000003');
    const { refs } = await listAll(connector, ctx);
    assert.equal(refs.filter(r => r.externalId === 'msg:18c0000000000003').length, 2);
  });

  test('history: added, relabelled, trashed, untrashed and deleted messages; later records win; checkpoint advances', async () => {
    const { connector, ctx, svc } = await connected({ historyPageSize: 2 });
    const cp = { historyId: svc.historyIdOf(F.FIXTURE_ACCOUNT) };
    svc.addMessage(F.FIXTURE_ACCOUNT, F.buildMessage({ id: '18c0000000000101', threadId: 'thr-budget', date: 'Mon, 12 Jan 2026 09:00:00 +0000', headers: { From: 'p@x.test', Subject: 'Re: Q1', 'In-Reply-To': '<budget-3@acme.example.test>' }, text: 'CANARY_H1' }));
    svc.relabel(F.FIXTURE_ACCOUNT, '18c0000000000004', { add: ['STARRED'] });
    svc.trash(F.FIXTURE_ACCOUNT, '18c0000000000006');
    svc.untrash(F.FIXTURE_ACCOUNT, '18c000000000000c');
    svc.deleteMessage(F.FIXTURE_ACCOUNT, '18c0000000000007');
    svc.relabel(F.FIXTURE_ACCOUNT, '18c0000000000002', { add: ['SPAM'] });
    svc.trash(F.FIXTURE_ACCOUNT, '18c0000000000003'); svc.untrash(F.FIXTURE_ACCOUNT, '18c0000000000003');   // trashed then restored → changed
    const r = await connector.syncChanges(ctx, { checkpoint: cp });
    assert.deepEqual(r.changed.map(x => x.externalId).sort(), ['msg:18c0000000000003', 'msg:18c0000000000004', 'msg:18c0000000000101', 'msg:18c000000000000c'].sort());
    assert.deepEqual(r.removed.sort(), ['msg:18c0000000000002', 'msg:18c0000000000006', 'msg:18c0000000000007'].sort());
    assert.deepEqual(r.checkpoint, { historyId: svc.historyIdOf(F.FIXTURE_ACCOUNT) });
    const again = await connector.syncChanges(ctx, { checkpoint: r.checkpoint });
    assert.deepEqual([again.changed, again.removed], [[], []], 'replaying from the new checkpoint finds nothing');
    assert.ok(svc.calls.filter(c => c.op === 'listHistory').length >= 4, 'history pages were followed');
  });

  test('history bound: more history than one run reads resumes after the last record seen, with nothing lost', async () => {
    const { connector, ctx, svc } = await connected({ historyPageSize: 1, maxHistoryPages: 2 });
    const cp = { historyId: svc.historyIdOf(F.FIXTURE_ACCOUNT) };
    for (const id of ['18c0000000000001', '18c0000000000003', '18c0000000000004', '18c0000000000005']) svc.relabel(F.FIXTURE_ACCOUNT, id, { add: ['STARRED'] });
    const seen = new Set();
    let c = cp;
    for (let i = 0; i < 4; i++) { const r = await connector.syncChanges(ctx, { checkpoint: c }); r.changed.forEach(x => seen.add(x.externalId)); c = r.checkpoint; }
    assert.deepEqual([...seen].sort(), ['msg:18c0000000000001', 'msg:18c0000000000003', 'msg:18c0000000000004', 'msg:18c0000000000005']);
    assert.deepEqual(c, { historyId: svc.historyIdOf(F.FIXTURE_ACCOUNT) });
  });

  test('an expired or missing history position → CURSOR_EXPIRED (never a silent empty change set)', async () => {
    const { connector, ctx, svc } = await connected();
    const cp = { historyId: svc.historyIdOf(F.FIXTURE_ACCOUNT) };
    svc.expireHistory(F.FIXTURE_ACCOUNT);
    await assert.rejects(connector.syncChanges(ctx, { checkpoint: cp }), e => contract.isCursorExpired(e));
    for (const bad of [null, {}, { fullSyncAt: '2026-01-01T00:00:00Z' }, { historyId: 'abc' }]) {
      await assert.rejects(connector.syncChanges(ctx, { checkpoint: bad }), e => e.kind === 'CURSOR_EXPIRED', JSON.stringify(bad));
    }
  });

  test('errors map to connector kinds and never carry provider text; TRASH/SPAM fetch → NOT_FOUND', async () => {
    const { connector, ctx, svc } = await connected();
    const ref = { externalId: 'msg:18c0000000000001' };
    // 2026-11-23: a 403 WITHOUT a recognised reason is REFUSED (status kept, never a reconnect, never a
    // rate limit); reasoned 403s are covered in gmailSyncRecovery.test.js.
    for (const [status, kind] of [[401, 'AUTH'], [403, 'REFUSED'], [404, 'NOT_FOUND'], [429, 'TRANSIENT'], [503, 'TRANSIENT'], [400, 'PERMANENT']]) {
      svc.failNext('getMessage', status);
      await assert.rejects(connector.fetchResource(ctx, ref), e => e.kind === kind && !/mock gmail/.test(e.message), `${status}`);
    }
    await assert.rejects(connector.fetchResource(ctx, { externalId: 'msg:18c000000000000c' }), e => e.kind === 'NOT_FOUND');
    await assert.rejects(connector.fetchResource(ctx, { externalId: 'msg:does-not-exist' }), e => e.kind === 'NOT_FOUND');
    await assert.rejects(connector.fetchResource(ctx, { externalId: 'thread:1' }), e => e.kind === 'NOT_FOUND');
    svc.revokeAllFor(F.FIXTURE_ACCOUNT);
    await assert.rejects(connector.listResources(ctx, {}), e => e.kind === 'AUTH');
    await assert.rejects(connector.syncChanges(ctx, { checkpoint: { historyId: '1' } }), e => e.kind === 'AUTH');
  });

  test('refresh and revocation go through the transport; revocation revokes the grant', async () => {
    const { connector, ctx, svc, connectResult } = await connected();
    const r = await connector.refresh(connectResult.credentials);
    assert.notEqual(r.credentials.accessToken, connectResult.credentials.accessToken);
    assert.equal(r.credentials.refreshToken, connectResult.credentials.refreshToken);
    await connector.disconnect(ctx);
    assert.equal(svc.grantRevoked(connectResult.credentials.accessToken), true);
    assert.equal(svc.grantRevoked(r.credentials.accessToken), true);
    await assert.rejects(connector.refresh(connectResult.credentials), e => e.kind === 'PERMANENT' || e.kind === 'AUTH');
  });

  // Gmail Phase 2: a cursor that cannot be decoded is still REJECTED, now as CURSOR_EXPIRED
  // (it can never be resumed) — the engine discards it and lists from the start instead
  // of failing on it every run (gmailSyncFoundation D2). Nothing is listed with it.
  test('the cursor is opaque but validated', async () => {
    const { connector, ctx } = await connected();
    for (const bad of ['x', '{}', JSON.stringify({ v: 1, p: '', h: '1' }), JSON.stringify({ v: 1, p: 'K1_a', h: 'abc' })]) {
      await assert.rejects(connector.listResources(ctx, { cursor: bad }), e => e.kind === 'CURSOR_EXPIRED', bad);
    }
  });
});
