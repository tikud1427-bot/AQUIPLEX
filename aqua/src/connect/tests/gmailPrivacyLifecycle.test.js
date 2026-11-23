/**
 * Phase 4B (2026-11-23) — privacy and lifecycle audit on DISPOSABLE fixtures (mock Gmail,
 * the real sync → ingest → understanding → stores path, a temporary data dir).
 *
 *   P1 where Gmail content and Gmail-derived identifiers land after an import
 *   P2 nothing Gmail-derived reaches ordinary user-class reads (UKO lists, PIC retrieval, evidence)
 *   P3 disconnect removes every derived record — including PIC lifecycle entries of the shape the
 *      first real import left behind (registered before the Phase 4B fix)
 *   P4 account deletion (the real purgeOwnerData) removes every derived record
 *   P5 no cross-owner access; a stale run after disconnect writes nothing back
 *   P6 no egress
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const K = await import('./testkit.js');
const egress = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { const u = new URL(String(url)); if (u.hostname !== '127.0.0.1') { egress.push(u.host); throw new Error('network refused'); } return realFetch(url, init); };

const F = await import('../testing/gmailFixtures.js');
const { createGmailConnector } = await import('../gmail/gmailConnector.js');
const { createMockGmailService } = await import('../testing/mockGmailTransport.js');
const { principalForServerJob } = await import('../principal.js');
const { runSync, SyncStopped } = await import('../syncEngine.js');
const C = await import('../gmail/emailContext.js');
const ukoStore = await import('../../files/ukoStore.js');
const evidenceStore = await import('../../files/evidenceStore.js');
const picStore = await import('../../pic/picStore.js');
const pic = await import('../../pic/core.js');
const EG = await import('../../core/egressGuard.js');

const CANARY = 'ZEBRAQUARTZ';   // a word that exists only in the test mail
const gid = (o, i) => `18a${o}${i.toString(16).padStart(12, '0')}`;
const asUser = fn => EG.runWithDataClass('user', fn);
const flushAll = async () => { await ukoStore.flushUKOStore(); await new Promise(r => setTimeout(r, 900)); };
/** Every file under the data dir containing `needle` (relative names). */
const filesWith = needle => { const hits = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { let t = ''; try { t = fs.readFileSync(p, 'utf8'); } catch { /* binary */ } if (t.includes(needle)) hits.push(path.relative(K.TMP, p)); } } }; walk(K.TMP); return hits; };

async function owner(tag, n = 30) {
  const mock = createMockGmailService({ now: Date.now });
  const acct = `pv-${crypto.randomBytes(4).toString('hex')}@example.test`;
  for (let i = 0; i < n; i++) mock.addMessage(acct, F.buildMessage({ id: gid(tag, i), threadId: `t${tag}${i}`, date: new Date(Date.UTC(2025, 5, 1) + i * 60_000).toUTCString(), headers: { From: 'Priya <priya@acme.example>', To: 'Raj <raj@acme.example>', Subject: `${CANARY} ${tag} ${i}`, 'Message-ID': `<p${tag}${i}@x>` }, text: `I'll send the ${CANARY} report ${tag}-${i} by Friday. Please review https://docs.example.com/${tag}/${i}` }));
  const registry = K.createConnectorRegistry({ allowTestOnly: true });
  registry.register(createGmailConnector({ transport: mock.transport }));
  const store = K.createMemoryConnectionStore();
  const service = K.createConnectService({ registry, store, vault: K.createCredentialVault({ key: K.TEST_KEY }), log: { log() {}, warn() {} }, retry: { sleep: async () => {}, baseMs: 0 } });
  const user = `pv-${tag}-${crypto.randomBytes(4).toString('hex')}`;
  const principal = principalForServerJob(user);
  const conn = await service.connect({ principal, connectorId: 'gmail', input: { code: mock.authorizeCode(acct) } });
  await service.sync({ principal, connectionId: conn.connectionId });
  const sourceId = (await store.get(`user:${user}`, conn.connectionId)).sourceId;
  return { mock, acct, store, service, registry, user, principal, owner: `user:${user}`, id: conn.connectionId, sourceId };
}
const gmailUkoIds = o => asUser(() => ukoStore.listUKOs(o.owner, { limit: 1e6, includeRestricted: true }).filter(u => u.id.startsWith('ext_')).map(u => u.id));
const picGmailSubjects = o => [...picStore.picBucket(o.owner).lifecycle.keys()].filter(k => k.startsWith('uko:ext_'));

describe('P · Gmail privacy and lifecycle (disposable fixtures)', () => {
  test('P1 · after import: content only in the restricted UKO store; no Gmail subject registered in PIC (Phase 4B)', async () => {
    const a = await owner('a');
    const ids = gmailUkoIds(a);
    assert.equal(ids.length, 30);
    assert.deepEqual(picGmailSubjects(a), [], 'restricted objects are not registered in PIC');
    await flushAll();
    assert.deepEqual(filesWith(CANARY).filter(f => !/uko/i.test(f)), [], 'Gmail text outside the UKO store');
    assert.deepEqual(filesWith(ids[0]).filter(f => !/uko/i.test(f)), [], 'a Gmail-derived id outside the UKO store');
  });

  test('P2 · nothing Gmail-derived reaches user-class reads', async () => {
    const a = await owner('b');
    asUser(() => {
      assert.equal(ukoStore.listUKOs(a.owner, { limit: 1e6 }).filter(u => u.id.startsWith('ext_')).length, 0, 'ordinary UKO listing');
      for (const id of gmailUkoIds(a).slice(0, 5)) assert.equal(ukoStore.getUKO(a.owner, id), null, 'ordinary UKO read');
      for (const id of gmailUkoIds(a).slice(0, 5)) assert.deepEqual(evidenceStore.factsForFile(a.owner, id), [], 'no evidence facts');
      const k = pic.retrieveKnowledge(a.owner, `${CANARY} report`);
      assert.ok(!JSON.stringify(k).includes(CANARY) && !JSON.stringify(k).includes('ext_'), 'PIC retrieval');
    });
  });

  test('P3 · disconnect removes every derived record, including legacy PIC lifecycle entries', async () => {
    const a = await owner('c');
    const ids = gmailUkoIds(a);
    // The shape the first real import left behind (registered before the fix): one PIC subject per Gmail object.
    pic.onKnowledgeIngested({ ownerId: a.owner, ukoIds: ids });
    assert.equal(picGmailSubjects(a).length, ids.length);
    await a.service.disconnect({ principal: a.principal, connectionId: a.id });
    assert.deepEqual(gmailUkoIds(a), []);
    assert.deepEqual(picGmailSubjects(a), [], 'PIC lifecycle entries removed by the source deletion');
    assert.deepEqual(asUser(() => C.retrieveEmailEvidence({ principal: a.principal, perType: { default: 1e6 } })).evidence, []);
    await flushAll();
    assert.deepEqual(filesWith(`${CANARY} report c-`), [], 'no Gmail text left on disk');
    assert.deepEqual(filesWith(ids[0]), [], 'no Gmail-derived id left on disk');
  });

  test('P4 · account deletion (the real purgeOwnerData) removes every derived record', async () => {
    const a = await owner('d');
    const ids = gmailUkoIds(a);
    pic.onKnowledgeIngested({ ownerId: a.owner, ukoIds: ids });
    const { purgeOwnerData } = await import('../../account/accountPurge.js');
    await purgeOwnerData({ userId: a.user });
    assert.deepEqual(gmailUkoIds(a), []);
    assert.deepEqual(picGmailSubjects(a), []);
    await flushAll();
    assert.deepEqual(filesWith(`${CANARY} report d-`), []);
    assert.deepEqual(filesWith(ids[0]), []);
  });

  test('P5 · no cross-owner access; a stale run after disconnect writes nothing back', async () => {
    const a = await owner('e');
    const b = await owner('f', 3);
    const idA = gmailUkoIds(a)[0];
    asUser(() => {
      assert.equal(ukoStore.getUKO(b.owner, idA, { includeRestricted: true }), null, 'owner B cannot read A\'s object');
      assert.equal(C.retrieveEmailEvidence({ principal: b.principal, perType: { default: 1e6 } }).evidence.filter(e => e.statement?.includes(' e-')).length, 0);
    });
    const rec = await a.store.get(a.owner, a.id);
    const token = (await a.mock.transport.exchangeCode({ code: a.mock.authorizeCode(a.acct) })).accessToken;
    await a.service.disconnect({ principal: a.principal, connectionId: a.id });
    const out = await runSync({
      ownerId: a.owner, conn: rec, connector: a.registry.get('gmail'), ctx: { connectionId: a.id, credentials: () => ({ accessToken: token }) },
      mode: 'full',   // a stale process re-listing the whole mailbox: it fetches everything, the guard must stop the import
      external: K.external, retry: { sleep: async () => {} }, guard: async () => Boolean(await a.store.get(a.owner, a.id)),
      persistProgress: async () => { throw new SyncStopped(); },
    });
    process.stderr.write(`[P5] ${JSON.stringify({ aborted: out.aborted, state: out.lastSync.state, error: out.lastSync.error ?? null, counts: out.lastSync.counts })}\n`);
    assert.equal(out.aborted, true);
    assert.deepEqual(gmailUkoIds(a), [], 'nothing resurrected');
  });

  test('P6 · no network; no provider attempt with Gmail in scope', () => {
    assert.deepEqual(egress, []);
    assert.equal(JSON.stringify(EG.egressStats()).includes('external:gmail'), false);
  });
});
