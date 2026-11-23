/**
 * Gmail Phase 1 — the mock Gmail connector through the EXISTING engine:
 *
 *   connectService (owner lease + fence, sealed credentials, Mongo adapter over
 *   the fake mongoose — the adapter's own conditional writes run)
 *   → syncEngine.runSync → externalSources (real ingestFiles, real stores)
 *   → disconnect / revoke / account purge (real paths)
 *
 * on the real migrated schema in pg-mem (deletion records, enqueue checks,
 * lease, deletion marker). No network (fetch/http(s) blocked), no provider
 * keys, an isolated data dir, a spy embedder.
 *
 * The founder's ten Phase 1 proofs: classification · idempotent re-sync ·
 * incremental changes · pagination without skips or duplicates · a revoked
 * source stops syncing · disconnect removes derived records · stale work
 * cannot resurrect · account purge · other owners/sources untouched · no Gmail
 * content reaches an AI or embedding service.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const K = await import('./testkit.js');           // isolated data dir, env stripped, test registry/vault
process.env.DATABASE_URL = 'postgresql://u:p@localhost:1/none';   // never dialled: the pool is replaced below
process.env.AQUA_E6 = 'on';                        // the understanding enqueue's own gate (proves Gmail is still refused)

let mem, poolMod, X, US, EG, ident, prov, G, M, F, FM, SE, es, idx, vs, fm, pic, mindStore, purgeOwnerData;
const embedded = [];
const network = [];
const logs = [];
const restore = [];

before(async () => {
  const block = name => () => { network.push(name); throw new Error(`network access attempted (${name})`); };
  restore.push([globalThis, 'fetch', globalThis.fetch], [http, 'request', http.request], [https, 'request', https.request], [http, 'get', http.get], [https, 'get', https.get]);
  globalThis.fetch = block('fetch'); http.request = block('http.request'); https.request = block('https.request'); http.get = block('http.get'); https.get = block('https.get');
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    restore.push([console, k, console[k]]);
    console[k] = (...a) => { logs.push(a.map(x => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ')); };
  }

  poolMod = await import('../../core/db/pool.js');
  poolMod._resetForTests();
  const { createMemoryPg } = await import('../../core/tests/helpers/memoryPg.mjs');
  mem = createMemoryPg();
  poolMod._setPoolForTests(mem.pool);
  await (await import('../../core/db/migrate.js')).migrate();
  for (const ix of ['aqua_jobs_ready_ix', 'aqua_jobs_running_owner_ix', 'aqua_jobs_dead_ix', 'aqua_jobs_running_heartbeat_ix']) {
    await mem.pool.query(`DROP INDEX IF EXISTS ${ix}`);   // pg-mem partial-index artefact (see sourceDeletion.test.js)
  }
  X = K.external;
  US = await import('../../files/ukoStore.js');
  EG = await import('../../core/egressGuard.js');
  ident = await import('../../files/externalIdentity.js');
  prov = await import('../../embeddings/embeddingProvider.js');
  prov.__setEmbedderForTests(async texts => { embedded.push(...texts); return texts.map(() => [1, 0, 0]); });
  G = await import('../gmail/gmailConnector.js');
  M = await import('../testing/mockGmailTransport.js');
  F = await import('../testing/gmailFixtures.js');
  FM = await import('./helpers/fakeMongoose.mjs');
  SE = await import('../syncEngine.js');
  es = await import('../../files/evidenceStore.js');
  idx = await import('../../files/fileSearchIndex.js');
  vs = await import('../../embeddings/vectorStore.js');
  fm = await import('../../embeddings/fileMemory.js');
  pic = await import('../../pic/core.js');
  mindStore = await import('../../mind/mindStore.js');
  ({ purgeOwnerData } = await import('../../account/accountPurge.js'));
});
after(async () => {
  for (const [o, k, v] of restore.reverse()) o[k] = v;
  X?.__setExternalUnderstandingForTests(false);
  poolMod?._resetForTests();
  await mem?.close();
  delete process.env.DATABASE_URL;
});

// ── helpers ─────────────────────────────────────────────────────────────────
const user = fn => EG.runWithDataClass('user', fn);
// The connect service refreshes credentials against the real clock: the mock issues tokens on it too.
const newMock = () => M.createMockGmailService({ now: () => Date.now() });
const mongoStore = () => K.createMongoConnectionStore({ mongoose: FM.createFakeMongoose() });
const inScope = () => F.IN_SCOPE_IDS.map(id => `msg:${id}`).sort();
const mentionsAny = (s, tokens) => { const t = typeof s === 'string' ? s : JSON.stringify(s ?? ''); return tokens.some(c => t.includes(c)); };
const ALL_CANARIES = () => [...F.CANARIES, 'CANARY_OTHER1', 'CANARY_OTHER2', 'CANARY_NEW', 'CANARY_H1', 'CANARY_UNIQ'];
const rows = async (sql, args) => (await mem.pool.query(sql, args)).rows;

function serviceFor({ mock, store, pageSize = 4, wrap = c => c, extra = [] }) {
  const registry = K.createConnectorRegistry({ allowTestOnly: true });
  registry.register(wrap(G.createGmailConnector({ transport: mock.transport, pageSize })));
  for (const c of extra) registry.register(c);
  return K.createConnectService({
    registry, store, vault: K.createCredentialVault({ key: K.TEST_KEY }),
    retry: { sleep: async () => {}, baseMs: 0 }, log: { log() {}, warn() {} }, trustRawUserId: true,
    lease: { pool: mem.pool, ttlMs: 10_000 },
  });
}
async function gmailUser({ account = F.FIXTURE_ACCOUNT, load = F.loadFixtureMailbox, mock = null, store = null, pageSize = 4, wrap, extra, userId = null, service = null } = {}) {
  mock ??= newMock();
  store ??= mongoStore();
  if (load) load(mock, account);
  service ??= serviceFor({ mock, store, pageSize, wrap, extra });
  userId ??= K.freshUser('gm');
  const conn = await service.connect({ userId, connectorId: 'gmail', input: { code: mock.authorizeCode(account) } });
  const ownerId = K.ownerOf(userId);
  const sourceId = `gmail:${conn.connectionId}`;
  const s = {
    mock, service, store, userId, ownerId, conn, sourceId, account, connectionId: conn.connectionId,
    prefix: ident.sourcePrefixes(sourceId).ukoPrefix,
    sync: (mode = 'auto') => service.sync({ userId, connectionId: conn.connectionId, mode }),
    held: () => X.listExternalResources(ownerId, sourceId).map(r => r.externalId).sort(),
    docs: () => user(() => US.listUKOsByPrefix(ownerId, ident.sourcePrefixes(sourceId).ukoPrefix, { includeRestricted: true })),
    record: () => store.get(ownerId, conn.connectionId),
  };
  return s;
}
const ops = (mock, from = 0) => mock.calls.slice(from).map(c => c.op);

// ── 1. classification ───────────────────────────────────────────────────────
describe('GL-1 · classification and provenance', () => {
  test('every Gmail-derived object is external:gmail, carries its ids/timestamps, and is invisible to normal readers', async () => {
    const s = await gmailUser();
    const before = s.mock.historyIdOf(s.account);
    const r = await s.sync('full');
    assert.equal(r.lastSync.state, 'succeeded', JSON.stringify(r.lastSync));
    assert.equal(r.lastSync.counts.created, F.IN_SCOPE_IDS.length);
    assert.deepEqual(s.held(), inScope(), 'SPAM/TRASH must not be stored; every in-scope message must be');
    const fixtures = new Map(F.fixtureMessages().map(m => [m.id, m]));
    for (const u of s.docs()) {
      assert.equal(u.dataClass, 'external:gmail');
      assert.equal(US.dataClassOfUko(u), 'external:gmail');
      const ext = u.provenance.external;
      const gid = ext.externalId.slice(4);
      assert.equal(ext.sourceId, s.sourceId);
      assert.match(ext.externalId, /^msg:/);
      assert.equal(ext.sourceUpdatedAt, new Date(Number(fixtures.get(gid).internalDate)).toISOString());
      assert.match(String(ext.version), /^\d+$/, 'version = the message historyId');
      assert.equal(ext.title, null, 'no subject in the title');
      assert.equal(u.sourceFile.name, `gmail-${gid}.txt`);
      assert.match(u.rawContent, new RegExp(`Gmail-Message-Id: ${gid}`));
      assert.match(u.rawContent, new RegExp(`Gmail-Thread-Id: ${fixtures.get(gid).threadId}`));
      assert.ok(u.processing.warnings.some(w => /integration skipped: data class external:gmail is restricted/.test(w)));
      // not in the classless content-hash cache (shared by identical bytes)
      assert.equal(US.getCachedKnowledge(u.sourceFile.hash, null, { ownerId: s.ownerId }), null, 'Gmail content entered the content-hash cache');
      // normal readers never see it
      assert.equal(US.getUKO(s.ownerId, u.id), null);
    }
    assert.equal(US.listUKOs(s.ownerId, { limit: 999 }).length, 0);
    assert.deepEqual((await s.record()).checkpoint, { historyId: before }, 'the incremental start point is the mailbox position BEFORE the listing');
  });

  test('unknown classification fails closed: a forged class on a Gmail UKO reads as unclassified', async () => {
    const s = await gmailUser();
    await s.sync('full');
    const u = s.docs()[0];
    assert.equal(US.dataClassOfUko({ ...u, dataClass: 'upload' }), 'unclassified');
    assert.equal(US.dataClassOfUko({ ...u, provenance: { ...u.provenance, external: { ...u.provenance.external, sourceId: 'not-a-source' } } }), 'unclassified');
  });
});

// ── 2. idempotent repeated sync ─────────────────────────────────────────────
describe('GL-2 · idempotent repeated sync', () => {
  test('a repeated full sync changes nothing; auto mode then runs incrementally and fetches nothing', async () => {
    const s = await gmailUser();
    await s.sync('full');
    const ids1 = s.docs().map(u => u.id).sort();
    const r2 = await s.sync('full');
    assert.deepEqual([r2.lastSync.counts.created, r2.lastSync.counts.updated, r2.lastSync.counts.removed, r2.lastSync.counts.unchanged], [0, 0, 0, F.IN_SCOPE_IDS.length]);
    assert.deepEqual(s.docs().map(u => u.id).sort(), ids1, 'a re-sync replaced versions');
    const mark = s.mock.calls.length;
    const r3 = await s.sync('auto');
    assert.equal(r3.lastSync.mode, 'incremental');
    assert.equal(r3.lastSync.state, 'succeeded');
    assert.equal(r3.lastSync.counts.considered, 0);
    assert.ok(!ops(s.mock, mark).includes('getMessage') && !ops(s.mock, mark).includes('listMessages'), ops(s.mock, mark).join(','));
    assert.deepEqual(s.docs().map(u => u.id).sort(), ids1);
  });
});

// ── 3. incremental changes ──────────────────────────────────────────────────
describe('GL-3 · incremental changes and expired history', () => {
  test('new, relabelled, trashed, restored and permanently deleted messages are applied by the history feed', async () => {
    const s = await gmailUser();
    await s.sync('full');
    s.mock.addMessage(s.account, F.buildMessage({ id: '18c0000000000101', threadId: 'thr-budget', date: 'Mon, 12 Jan 2026 09:00:00 +0000',
      headers: { From: 'p@x.example.test', Subject: 'Re: Q1', 'In-Reply-To': '<budget-3@acme.example.test>' }, text: 'CANARY_H1 follow-up.' }));
    s.mock.relabel(s.account, '18c0000000000004', { add: ['STARRED'] });
    s.mock.trash(s.account, '18c0000000000006');
    s.mock.untrash(s.account, '18c000000000000c');
    s.mock.deleteMessage(s.account, '18c0000000000007');
    const r = await s.sync('auto');
    assert.equal(r.lastSync.mode, 'incremental');
    assert.equal(r.lastSync.state, 'succeeded', JSON.stringify(r.lastSync));
    assert.deepEqual([r.lastSync.counts.created, r.lastSync.counts.updated, r.lastSync.counts.removed], [2, 1, 2]);
    const expected = [...F.IN_SCOPE_IDS.filter(id => !['18c0000000000006', '18c0000000000007'].includes(id)), '18c0000000000101', '18c000000000000c'].map(id => `msg:${id}`).sort();
    assert.deepEqual(s.held(), expected);
    const starred = s.docs().find(u => u.provenance.external.externalId === 'msg:18c0000000000004');
    assert.match(starred.rawContent, /Labels: INBOX, STARRED/);
    assert.equal(s.docs().filter(u => u.provenance.external.externalId === 'msg:18c0000000000004').length, 1, 'the old version was not replaced');
    assert.deepEqual((await s.record()).checkpoint, { historyId: s.mock.historyIdOf(s.account) });
  });

  test('expired history (auto): the same run lists the whole source; deletions are judged by that complete listing; incremental resumes after', async () => {
    const s = await gmailUser();
    await s.sync('full');
    s.mock.expireHistory(s.account);
    s.mock.deleteMessage(s.account, '18c0000000000003');
    const r = await s.sync('auto');
    assert.equal(r.lastSync.mode, 'full');
    assert.equal(r.lastSync.state, 'succeeded', JSON.stringify(r.lastSync));
    assert.match(r.lastSync.note ?? '', /expired at the source/);
    assert.equal(r.lastSync.counts.removed, 1);
    assert.ok(!s.held().includes('msg:18c0000000000003'));
    assert.deepEqual((await s.record()).checkpoint, { historyId: s.mock.historyIdOf(s.account) });
    s.mock.relabel(s.account, '18c0000000000001', { add: ['STARRED'] });
    const r2 = await s.sync('auto');
    assert.deepEqual([r2.lastSync.mode, r2.lastSync.counts.updated], ['incremental', 1]);
  });

  test('expired history (explicit incremental): the run fails and CLEARS the position; the next auto run is full — never a loop', async () => {
    const s = await gmailUser();
    await s.sync('full');
    s.mock.expireHistory(s.account);
    const r = await s.sync('incremental');
    assert.equal(r.lastSync.state, 'failed');
    assert.match(r.lastSync.error, /expired/);
    assert.equal((await s.record()).checkpoint, null);
    const r2 = await s.sync('auto');
    assert.deepEqual([r2.lastSync.mode, r2.lastSync.state], ['full', 'succeeded']);
    assert.equal(r2.lastSync.counts.unchanged, F.IN_SCOPE_IDS.length);
  });

  test('a mass removal reported by the history feed is withheld (Phase 1b.2 guard still applies to Gmail)', async () => {
    const s = await gmailUser();
    await s.sync('full');
    for (const id of F.IN_SCOPE_IDS.slice(0, 7)) s.mock.trash(s.account, id);
    const r = await s.sync('auto');
    assert.equal(r.lastSync.state, 'partial');
    assert.equal(r.lastSync.counts.withheldRemovals, 7);
    assert.deepEqual(s.held(), inScope(), 'a feed alone deleted most of the mailbox');
  });
});

// ── 4. pagination ───────────────────────────────────────────────────────────
describe('GL-4 · pagination: no skips, no duplicates', () => {
  test('one run over several pages with a repeated id: every message stored exactly once', async () => {
    const mock = newMock();
    F.loadFixtureMailbox(mock);
    mock.duplicateInListing(F.FIXTURE_ACCOUNT, '18c0000000000003');
    const s = await gmailUser({ mock, load: null, pageSize: 3 });
    const r = await s.sync('full');
    assert.equal(r.lastSync.state, 'succeeded');
    assert.equal(r.lastSync.counts.listed, F.IN_SCOPE_IDS.length + 1, 'the repeated id was listed');
    assert.equal(r.lastSync.counts.considered, F.IN_SCOPE_IDS.length);
    assert.equal(r.lastSync.counts.created, F.IN_SCOPE_IDS.length);
    assert.equal(s.mock.calls.filter(c => c.op === 'listMessages').length, 5);
    assert.deepEqual(s.held(), inScope());
    assert.equal(s.docs().length, F.IN_SCOPE_IDS.length, 'one version per message');
  });

  test('a full pass spanning several runs, with the mailbox changing between runs: the pass resumes, then the history start point catches up', async () => {
    const mock = newMock();
    F.loadFixtureMailbox(mock);
    const connector = G.createGmailConnector({ transport: mock.transport, pageSize: 2 });
    const c = await connector.connect({ code: mock.authorizeCode(F.FIXTURE_ACCOUNT) });
    const ctx = Object.freeze({ connectionId: 'conn_pass', credentials: () => structuredClone(c.credentials) });
    const ownerId = K.ownerOf(K.freshUser('gm-pass'));
    let conn = { sourceId: `gmail:conn_pass${process.pid}${Date.now() % 100000}`, checkpoint: null, fullSync: null, pendingDeletion: null };
    const run = async (mode = 'auto') => {
      const out = await SE.runSync({ ownerId, conn, connector, ctx, mode, external: X, retry: { sleep: async () => {}, baseMs: 0 }, limits: { ...SE.SYNC_LIMITS, maxPages: 2 } });
      conn = { ...conn, checkpoint: out.checkpoint, fullSync: out.fullSync, pendingDeletion: out.pendingDeletion };
      return out;
    };
    const r1 = await run();
    assert.ok(conn.fullSync?.cursor, 'the first run must stop mid-listing');
    assert.equal(r1.checkpoint, null, 'no checkpoint before the pass completes');
    assert.deepEqual(connector.gmail.progressOf(conn.fullSync.cursor), { listed: 4, estimate: 10 });
    const firstPage = X.listExternalResources(ownerId, conn.sourceId).map(r => r.externalId);
    // between runs: a message the pass already imported is deleted; a new one arrives
    mock.deleteMessage(F.FIXTURE_ACCOUNT, firstPage[0].slice(4));
    mock.addMessage(F.FIXTURE_ACCOUNT, F.buildMessage({ id: '18c00000000000ff', threadId: 'thr-new', date: 'Sun, 11 Jan 2026 10:00:00 +0000', headers: { From: 'n@x.example.test', Subject: 'new' }, text: 'CANARY_NEW arrives mid-pass.' }));
    let guard = 0;
    while (conn.fullSync?.cursor && guard++ < 10) await run();
    assert.ok(conn.checkpoint?.historyId, 'a completed pass stores the history start point');
    const out = await run();                                   // incremental from the pre-listing position
    assert.equal(out.lastSync.mode, 'incremental');
    const listedNow = (await (async () => { const all = []; let cur = null; do { const p = await mock.transport.listMessages(c.credentials.accessToken, { pageToken: cur ?? undefined, maxResults: 100 }); all.push(...(p.messages ?? [])); cur = p.nextPageToken; } while (cur); return all; })()).map(m => `msg:${m.id}`).sort();
    const held = X.listExternalResources(ownerId, conn.sourceId).map(r => r.externalId);
    assert.equal(new Set(held).size, held.length, 'a message was stored twice');
    assert.deepEqual([...held].sort(), listedNow, 'the stored set must equal the mailbox');
  });
});

// ── 5. revocation ───────────────────────────────────────────────────────────
describe('GL-5 · a revoked source stops syncing', () => {
  test('revokeCredentials: revoked at the source, credentials wiped, every further sync refused — no Gmail call is made', async () => {
    const s = await gmailUser();
    await s.sync('full');
    const token = s.mock.calls.length;
    const r = await s.service.revokeCredentials({ userId: s.userId, connectionId: s.connectionId });
    assert.equal(r.providerRevocation, 'revoked');
    assert.equal(r.connection.status, 'revoked');
    assert.equal(r.connection.hasCredentials, false);
    const mark = s.mock.calls.length;
    assert.deepEqual(ops(s.mock, token), ['revoke']);
    await assert.rejects(s.sync('auto'), e => e.code === 'NOT_ACTIVE');
    await assert.rejects(s.sync('full'), e => e.code === 'NOT_ACTIVE');
    assert.equal(s.mock.calls.length, mark, 'a revoked connection still called Gmail');
  });

  test('access removed in the Google account: the sync stops (needs_reauth), keeps what it had, and never runs again until reconnected', async () => {
    const s = await gmailUser();
    await s.sync('full');
    s.mock.revokeAllFor(s.account);
    s.mock.addMessage(s.account, F.buildMessage({ id: '18c0000000000102', threadId: 't', date: 'Mon, 12 Jan 2026 09:00:00 +0000', headers: { From: 'z@x.example.test' }, text: 'CANARY_H1 after revoke' }));
    const r = await s.sync('auto');
    assert.equal(r.status, 'needs_reauth');
    assert.equal(r.lastSync.state, 'failed');
    assert.deepEqual(s.held(), inScope(), 'a refused sync must not delete or add anything');
    const mark = s.mock.calls.length;
    await assert.rejects(s.sync('auto'), e => e.code === 'NOT_ACTIVE');
    assert.equal(s.mock.calls.length, mark);
  });

  test('access removed AND the token expired: the refresh is refused, the connection needs re-authorisation, nothing is read', async () => {
    const s = await gmailUser();
    await s.sync('full');
    s.mock.revokeAllFor(s.account);
    s.mock.expireAccessTokens();
    await s.store.update(s.ownerId, s.connectionId, { credentialsExpireAt: 1 }, { fence: { epoch: (await s.record()).fenceEpoch, token: (await s.record()).fenceToken } });
    const mark = s.mock.calls.length;
    await assert.rejects(s.sync('auto'), e => e.code === 'NEEDS_REAUTH');
    assert.equal((await s.record()).status, 'needs_reauth');
    assert.deepEqual(ops(s.mock, mark), ['refresh'], 'only the refused refresh may reach Gmail');
    assert.deepEqual(s.held(), inScope());
  });

  test('access removed DURING a sync: the run stops at the first refused call and imports nothing', async () => {
    let tripped = false;
    const mock = newMock();
    const s = await gmailUser({ mock, wrap: c => ({ ...c, fetchResource: async (...a) => { if (!tripped) { tripped = true; mock.revokeAllFor(F.FIXTURE_ACCOUNT); } return c.fetchResource(...a); } }) });
    const r = await s.sync('full');
    assert.ok(tripped);
    assert.equal(r.status, 'needs_reauth');
    assert.deepEqual(s.held(), []);
  });
});

// ── 6. disconnect ───────────────────────────────────────────────────────────
const uniqueMailbox = token => (svc, email) => {
  svc.addMessage(email, F.buildMessage({ id: '18e0000000000001', threadId: 'thr-u', date: 'Mon, 5 Jan 2026 10:00:00 +0000',
    headers: { From: 'u@x.example.test', To: email, Subject: `about ${token}`, 'Message-ID': '<u1@x.example.test>' }, text: `${token} private body line one.` }));
  svc.addMessage(email, F.buildMessage({ id: '18e0000000000002', threadId: 'thr-u', date: 'Mon, 5 Jan 2026 11:00:00 +0000',
    headers: { From: email, To: 'u@x.example.test', Subject: `Re: about ${token}`, 'In-Reply-To': '<u1@x.example.test>' }, text: `${token} reply body.` }));
};
function filesContaining(token) {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { try { if (fs.readFileSync(p, 'utf8').includes(token)) out.push(path.relative(K.TMP, p)); } catch { /* binary */ } } } };
  walk(K.TMP);
  return out;
}

describe('GL-6 · disconnect removes every derived record', () => {
  test('disconnect: revoked at Gmail, credentials wiped, every message removed from every store and from disk, connection record gone', async () => {
    const token = `CANARY_UNIQ${process.pid}D`;
    const s = await gmailUser({ load: uniqueMailbox(token) });
    await s.sync('full');
    assert.equal(s.held().length, 2);
    await K.settle(1200);                                       // let the debounced stores write
    const at = filesContaining(token);
    assert.ok(at.length > 0, 'precondition: the content is on disk');
    assert.ok(at.every(f => /aqua-uko/.test(f)), `Gmail content stored outside the UKO store: ${at.join(', ')}`);
    const before = s.mock.calls.length;
    const r = await s.service.disconnect({ userId: s.userId, connectionId: s.connectionId });
    assert.deepEqual([r.deleted, r.knowledgeRemoved, r.providerRevocation], [true, true, 'revoked']);
    assert.deepEqual(ops(s.mock, before), ['revoke']);
    assert.deepEqual(s.held(), []);
    assert.equal(s.docs().length, 0);
    assert.equal(await s.store.countByOwner(s.ownerId), 0);
    await assert.rejects(s.service.getConnection({ userId: s.userId, connectionId: s.connectionId }), e => e.code === 'NOT_FOUND');
    await K.settle(1200);
    assert.deepEqual(filesContaining(token), [], 'Gmail content left on disk after disconnect');
    const jobs = await rows(`SELECT count(*)::int AS n FROM aqua_jobs WHERE owner_id = $1`, [s.ownerId]);
    assert.equal(jobs[0].n, 0);
  });
});

// ── 7. stale work ───────────────────────────────────────────────────────────
describe('GL-7 · stale work cannot resurrect deleted Gmail data', () => {
  test('a deletion committed while a sync is fetching: nothing that sync fetched is imported', async () => {
    let deleted = false;
    const holder = {};
    const s = await gmailUser({ wrap: c => ({ ...c, fetchResource: async (...a) => {
      if (holder.armed && !deleted) { deleted = true; await X.deleteExternalSource(holder.ownerId, holder.sourceId); }   // another instance / operator deletes the source
      return c.fetchResource(...a);
    } }) });
    Object.assign(holder, { ownerId: s.ownerId, sourceId: s.sourceId });
    await s.sync('full');
    s.mock.relabel(s.account, '18c0000000000001', { add: ['STARRED'] });
    s.mock.addMessage(s.account, F.buildMessage({ id: '18c0000000000103', threadId: 't', date: 'Mon, 12 Jan 2026 09:00:00 +0000', headers: { From: 'z@x.example.test' }, text: 'CANARY_H1 late' }));
    holder.armed = true;
    const r = await s.sync('auto');
    assert.ok(deleted);
    assert.ok(r.lastSync.counts.rejected >= 2, JSON.stringify(r.lastSync.counts));
    assert.deepEqual(s.held(), [], 'a sync that observed the source before its deletion wrote content back');
  });

  test('delayed import work carrying a pre-deletion observation is refused after disconnect', async () => {
    const s = await gmailUser();
    await s.sync('full');
    const observedAt = await X.observeSource(s.ownerId, s.sourceId);
    const late = G.createGmailConnector({ transport: s.mock.transport }).normalize(F.fixtureMessages()[0], { externalId: 'msg:18c0000000000001' });
    await s.service.disconnect({ userId: s.userId, connectionId: s.connectionId });
    const r = await user(() => X.syncExternalResources({ ownerId: s.ownerId, sourceId: s.sourceId, resources: [{ ...late, content: late.content + '\nlate edit' }], observedAt }));
    assert.equal(r.results[0].status, 'rejected', JSON.stringify(r.results));
    assert.match(r.results[0].reason, /source-deleted/);
    assert.deepEqual(s.held(), []);
  });

  test('disconnect requested while a sync is in flight: it runs after the sync, and removes what the sync imported', async () => {
    let release, entered = false;
    const gate = new Promise(r => { release = r; });
    const s = await gmailUser({ wrap: c => ({ ...c, fetchResource: async (...a) => { entered = true; await gate; return c.fetchResource(...a); } }) });
    const syncP = s.sync('full');
    while (!entered) await K.settle(5);
    const discP = s.service.disconnect({ userId: s.userId, connectionId: s.connectionId });
    release();
    await syncP;
    const d = await discP;
    assert.equal(d.deleted, true);
    assert.deepEqual(s.held(), []);
    assert.equal(await s.store.countByOwner(s.ownerId), 0);
  });

  test('an account purge racing a running Gmail sync: the purge takes over; the sync cannot write its connection or knowledge back', async () => {
    let release, entered = false;
    const gate = new Promise(r => { release = r; });
    const s = await gmailUser({ wrap: c => ({ ...c, fetchResource: async (...a) => { entered = true; await gate; return c.fetchResource(...a); } }) });
    const syncP = s.sync('full').then(() => 'ok', e => e.code ?? e.message);
    while (!entered) await K.settle(5);
    const report = await purgeOwnerData({ userId: s.userId });
    assert.equal(report.connectors?.complete, true, JSON.stringify(report.connectors ?? report.errors));
    release();
    const outcome = await syncP;
    assert.notEqual(outcome, 'ok', 'the stale sync reported success');
    assert.equal(await s.store.countByOwner(s.ownerId), 0);
    assert.deepEqual(s.held(), [], 'the stale sync imported Gmail content after the purge');
  });
});

// ── 8. account purge ────────────────────────────────────────────────────────
describe('GL-8 · account purge removes Gmail connection and source state', () => {
  test('purgeOwnerData: knowledge, connection (tombstoned), sealed credentials, cursors, jobs, deletion records and the lease row — and no reconnect', async () => {
    const s = await gmailUser();
    await s.sync('full');
    assert.ok((await s.record()).credentials, 'precondition: sealed credentials at rest');
    const report = await purgeOwnerData({ userId: s.userId });
    assert.equal(report.connectors?.complete, true, JSON.stringify(report.connectors ?? report.errors));
    assert.ok(report.ukos >= F.IN_SCOPE_IDS.length, `ukos=${report.ukos}`);
    assert.deepEqual(s.held(), []);
    assert.equal(await s.store.countByOwner(s.ownerId), 0);
    assert.equal((await s.store.ownerState(s.ownerId)).deleted, true);
    for (const t of ['aqua_jobs', 'aqua_external_deletions']) {
      assert.equal((await rows(`SELECT count(*)::int AS n FROM ${t} WHERE owner_id = $1`, [s.ownerId]))[0].n, 0, t);
    }
    assert.equal((await rows(`SELECT count(*)::int AS n FROM aqua_scheduler_leases WHERE name = $1`, [(await import('../ownerLease.js')).connectLeaseName(s.ownerId)]))[0].n, 0, 'the lease row');
    const mark = s.mock.calls.length;
    await assert.rejects(s.service.connect({ userId: s.userId, connectorId: 'gmail', input: { code: s.mock.authorizeCode(s.account) } }), e => e.code === 'OWNER_DELETED');
    await assert.rejects(s.sync('auto'));
    assert.ok(!ops(s.mock, mark).some(o => ['listMessages', 'getMessage', 'listHistory'].includes(o)), 'a purged account still read Gmail');
    assert.equal(await s.store.countByOwner(s.ownerId), 0);
    const again = await purgeOwnerData({ userId: s.userId });
    assert.equal(again.connectors?.complete, true, 'the purge is not idempotent');
  });
});

// ── 9. isolation ────────────────────────────────────────────────────────────
describe('GL-9 · other owners and other sources are untouched', () => {
  test('disconnecting one Gmail source leaves the same owner\'s second Gmail account and other connector, and another owner, intact; purging leaves the other owner intact', async () => {
    const mock = newMock();
    const world = K.createFakeWorld();
    const store = mongoStore();
    const service = serviceFor({ mock, store, extra: [K.createFakeConnector({ world })] });
    const userId = K.freshUser('gm-iso');
    const a1 = await gmailUser({ mock, store, service, userId });
    const a2 = await gmailUser({ mock, store, service, userId, account: F.OTHER_ACCOUNT, load: F.otherMailbox });
    const fakeConn = await service.connect({ userId, connectorId: 'fake', input: { account: `acct-${userId}`, code: 'ok' } });
    world.put(`acct-${userId}`, 'note-1', { name: 'note-1.md', content: K.doc('Zephyrine') });
    await service.sync({ userId, connectionId: fakeConn.connectionId, mode: 'full' });
    const fakeSource = `fake:${fakeConn.connectionId}`;
    const b = await gmailUser({ account: F.FIXTURE_ACCOUNT });   // another owner, same mailbox content
    for (const s of [a1, a2, b]) await s.sync('full');
    const snap = s => s.docs().map(u => [u.id, u.rawContent]).sort();
    const [a2Before, bBefore] = [snap(a2), snap(b)];
    const fakeBefore = X.listExternalResources(a1.ownerId, fakeSource);
    assert.equal(fakeBefore.length, 1);

    await service.disconnect({ userId, connectionId: a1.connectionId });
    assert.deepEqual(a1.held(), []);
    assert.deepEqual(snap(a2), a2Before, 'the owner\'s other Gmail account changed');
    assert.deepEqual(X.listExternalResources(a1.ownerId, fakeSource), fakeBefore, 'the owner\'s other connector changed');
    assert.deepEqual(snap(b), bBefore, 'another owner changed');
    assert.ok(US.listUKOs(a1.ownerId, { limit: 99 }).length >= 1, 'the fake (unrestricted) source is still visible to normal readers');
    assert.equal(await store.countByOwner(a1.ownerId), 2);

    const report = await purgeOwnerData({ userId });
    assert.equal(report.connectors?.complete, true);
    assert.deepEqual(snap(b), bBefore, 'another owner changed by a purge');
    assert.equal(await b.store.countByOwner(b.ownerId), 1);
    const r = await b.sync('auto');
    assert.equal(r.lastSync.state, 'succeeded', 'the other owner can no longer sync');
  });
});

// ── 10. no provider, no embedding ───────────────────────────────────────────
describe('GL-10 · no Gmail content reaches an AI or embedding service', () => {
  test('a full Gmail lifecycle with external understanding switched ON: no embedding, no provider call, no job, no derived store, no log line carries Gmail content', async () => {
    X.__setExternalUnderstandingForTests(true);
    EG._resetEgressStatsForTests();
    const embeddedBefore = embedded.length;
    const logsBefore = logs.length;
    try {
      const s = await gmailUser();
      await s.sync('full');
      s.mock.relabel(s.account, '18c0000000000005', { add: ['STARRED'] });
      s.mock.addMessage(s.account, F.buildMessage({ id: '18c0000000000104', threadId: 'thr-budget', date: 'Mon, 12 Jan 2026 09:00:00 +0000', headers: { From: 'p@x.example.test', Subject: 'CANARY_S01 again' }, text: 'CANARY_H1 more.' }));
      await s.sync('auto');
      await K.settle(300);
      const tokens = ALL_CANARIES();
      // embeddings
      assert.ok(!embedded.slice(embeddedBefore).some(t => mentionsAny(t, tokens)), 'Gmail text reached the embedder');
      // providers: no call allowed, none even attempted (egress guard counters); no network
      const st = EG.egressStats();
      assert.equal(st.allowed, 0, 'a provider call was allowed during the Gmail lifecycle');
      assert.deepEqual(st.blocked, [], `a provider call was attempted: ${JSON.stringify(st.blocked)}`);
      assert.deepEqual(network, []);
      // understanding jobs (canonical claims path) — refused for the restricted class
      assert.equal((await rows(`SELECT count(*)::int AS n FROM aqua_jobs WHERE owner_id = $1`, [s.ownerId]))[0].n, 0);
      // derived stores: vectors, file memory, facts, search index, PIC, Mind, graph
      assert.equal(vs.idsIn(fm.externalFileNamespace(s.ownerId)).length, 0);
      assert.equal(vs.idsIn(fm.fileNamespace(s.ownerId)).length, 0);
      assert.ok(!es.listFacts(s.ownerId, { limit: 9999 }).some(f => mentionsAny(f.statement, tokens)), 'facts');
      assert.equal(idx.indexedFileIdsByPrefix(s.ownerId, s.prefix).length, 0, 'search index');
      for (const q of ['CANARY_M01 budget', 'budget', 'contract countersigned']) {
        assert.ok(!mentionsAny(idx.searchFiles(s.ownerId, q), tokens), `search: ${q}`);
        assert.ok(!mentionsAny(pic.retrieveKnowledge(s.ownerId, q), tokens), `PIC: ${q}`);
      }
      assert.ok(!mentionsAny(mindStore.getMind(s.ownerId), tokens), 'Mind');
      // canonical facts/claims and every other table: no Gmail text in the database
      let tables = [];
      try { tables = (await rows(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).map(r => r.table_name); } catch { tables = []; }
      assert.ok(tables.length > 5, 'could not enumerate the database tables');
      for (const t of tables) {
        let all = [];
        try { all = await rows(`SELECT * FROM ${t}`); } catch { continue; }
        assert.ok(!mentionsAny(all, tokens), `Gmail content found in table ${t}`);
      }
      // reading it (lifecycle) taints the scope: no provider may be called after
      await user(async () => {
        s.docs();
        for (const p of ['gemini', 'groq', 'openrouter', 'nvidia', 'huggingface']) {
          assert.throws(() => EG.assertEgress(p, 'generate'), e => e.code === 'EGRESS_BLOCKED', p);
        }
      });
      // logs and telemetry lines: no content, subjects, addresses or tokens
      const lines = logs.slice(logsBefore).join('\n');
      assert.ok(!mentionsAny(lines, [...tokens, 'priya@', 'alex.rivera@', 'SECRETVALUE', 'Q1 budget']), 'Gmail content or a credential reached a log line');
    } finally {
      X.__setExternalUnderstandingForTests(false);
    }
  });

  test('across this whole file: nothing Gmail-derived was embedded, no network call was made, no log line carries Gmail content', () => {
    const tokens = ALL_CANARIES();
    assert.ok(!embedded.some(t => mentionsAny(t, tokens)), 'Gmail text reached the embedder');
    assert.deepEqual(network, []);
    assert.ok(!mentionsAny(logs.join('\n'), [...tokens, 'SECRETVALUE', 'alex.rivera@example', 'priya@acme']), logs.filter(l => mentionsAny(l, tokens)).slice(0, 3).join('\n'));
  });
});
