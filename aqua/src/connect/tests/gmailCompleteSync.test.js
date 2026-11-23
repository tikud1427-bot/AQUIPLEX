/**
 * 2026-11-23 — complete Gmail synchronisation (the 200-message ceiling removed).
 *
 * The REAL stack in one process — in-process runner (productionDeps), connectService,
 * syncEngine, Gmail connector, externalSources → ingest → restricted UKO store — over the
 * MOCK Gmail service. Proves: every eligible message imported exactly once at any size;
 * resumable bounded passes; crash/failure/expiry recovery; mail arriving during the pass;
 * incremental after completion; concurrency; disconnect and deletion; uploads untouched;
 * positions never ahead of durable storage; no egress.
 *
 * MOCK GOOGLE ONLY — says nothing about real Gmail behaviour.
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
const { createInProcessSyncRunner } = await import('../productionDeps.js');
const { SYNC_LIMITS } = await import('../syncEngine.js');
const ukoStore = await import('../../files/ukoStore.js');
const EG = await import('../../core/egressGuard.js');
const W = await import('../../core/jobs/workerRuntime.js');
const I = await import('../gmail/emailIntelligence.js');

const quiet = { log() {}, warn() {} };
const T0 = Date.parse('2025-01-01T00:00:00Z');
const gid = i => `18b${i.toString(16).padStart(13, '0')}`;
const message = (i, over = {}) => F.buildMessage({
  id: gid(i), threadId: `t${i}`, date: new Date(T0 + i * 60_000).toUTCString(),
  headers: { From: 'Priya Sharma <priya@acme.example>', To: 'Raj Mehta <raj@acme.example>', Subject: `Report ${i}`, 'Message-ID': `<m${i}@acme.example>` },
  text: `I'll send report number ${i} by Monday.`, ...over,
});

/** A mailbox of n messages, connected, with the real service + runner. */
async function mailbox(n, { pageSize = 100, limits = null, external = undefined } = {}) {
  const mock = createMockGmailService({ now: Date.now });
  const acct = `cs-${crypto.randomBytes(4).toString('hex')}@example.test`;
  for (let i = 0; i < n; i++) mock.addMessage(acct, message(i));
  const registry = K.createConnectorRegistry({ allowTestOnly: true });
  registry.register(createGmailConnector({ transport: mock.transport, pageSize }));
  const store = K.createMemoryConnectionStore();
  const vault = K.createCredentialVault({ key: K.TEST_KEY });
  const mk = (over = {}) => K.createConnectService({ registry, store, vault, log: quiet, retry: { sleep: async () => {}, baseMs: 0 }, ...(limits ? { syncLimits: { ...SYNC_LIMITS, ...limits } } : {}), ...(external ? { external } : {}), ...over });
  const service = mk();
  const user = `cs-${crypto.randomBytes(5).toString('hex')}`;
  const principal = principalForServerJob(user);
  const owner = `user:${user}`;
  const conn = await service.connect({ principal, connectorId: 'gmail', input: { code: mock.authorizeCode(acct) } });
  const runner = createInProcessSyncRunner({ service, log: quiet, pauseMs: 0 });
  const id = conn.connectionId;
  const sourceId = (await store.get(owner, id)).sourceId;
  const s = {
    mock, acct, service, mk, store, principal, owner, id, sourceId, runner, n,
    /** One "Sync now": the runner completes the pass in bounded runs. */
    async syncNow(mode = 'auto', r = runner) { r.start({ principal, connectionId: id, mode }); await r.idle(); return EG.runWithDataClass('user', () => service.getConnection({ principal, connectionId: id })); },
    // Test reads run in a data-class scope, as every route does (aqua/router.js).
    held: () => EG.runWithDataClass('user', () => K.external.listExternalResources(owner, sourceId).map(x => x.externalId).sort()),
    expected: () => mock.messageIds(acct).map(m => `msg:${m}`).sort(),   // fixtures here carry no SPAM/TRASH/DRAFT labels
    ukoCount: () => EG.runWithDataClass('user', () => ukoStore.listUKOs(owner, { limit: 1e6, includeRestricted: true }).filter(u => u.id.startsWith('ext_')).length),
    understood: () => EG.runWithDataClass('user', () => ukoStore.listUKOs(owner, { limit: 1e6, includeRestricted: true }).filter(u => u.id.startsWith('ext_') && JSON.stringify(u).includes('aqua.email-understanding/v1')).length),
    record: () => store.get(owner, id),
  };
  return s;
}
const exactlyOnce = s => {
  const held = s.held();
  assert.equal(new Set(held).size, held.length, 'a message is held twice');
  assert.deepEqual(held, s.expected(), 'held set ≠ eligible mailbox');
  assert.equal(s.ukoCount(), held.length, 'one stored version per message');
};

// ══════════════════════════════════════════════════════════════════════════════
describe('C1 · every mailbox size is imported completely, exactly once (production limits)', () => {
  for (const n of [0, 1, 199, 200, 201, 537, 1050]) {
    test(`${n} message(s)`, async () => {
      const s = await mailbox(n);
      const t = Date.now();
      const c = await s.syncNow();
      const ms = Date.now() - t;
      exactlyOnce(s);
      assert.equal(s.held().length, n);
      assert.equal(c.imported, n);
      assert.equal(c.initialSyncComplete, true, JSON.stringify(c.lastSync));
      assert.equal(c.lastSync.state, 'succeeded');
      assert.equal(c.fullSyncInProgress, false);
      assert.ok(c.lastSync.lastSuccessAt);
      // A second Sync now is incremental and changes nothing.
      const c2 = await s.syncNow();
      assert.equal(c2.lastSync.mode, 'incremental');
      assert.equal((c2.lastSync.counts.created ?? 0) + (c2.lastSync.counts.updated ?? 0), 0);
      exactlyOnce(s);
      if (n >= 537) process.stderr.write(`[C1] ${n} messages: initial sync ${ms} ms, runs=${c.syncCount}\n`);
    });
  }

  // Phase 4B: the views are bounded PER CATEGORY (emailIntelligence.CATEGORY_LIMITS), so every
  // commitment of a 1,050-message mailbox is visible; coverage reports found vs shown per type.
  test('every imported message is understood; every commitment is visible (per-category budgets)', async () => {
    const s = await mailbox(1050);
    await s.syncNow();
    assert.equal(s.understood(), 1050, 'understanding ran for every message');
    const ov = EG.runWithDataClass('user', () => I.overview({ principal: s.principal, now: T0 }));
    assert.equal(ov.counts.openCommitments, 1050);
    assert.deepEqual(ov.coverage.commitment, { found: 1050, shown: 1050, truncated: false });
    const newest = ov.openCommitments.map(i => i.source.gmailMessageId);
    assert.ok(newest.includes(gid(1049)), 'the newest mail is first');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('C2 · bounded, resumable passes (small budgets: pageSize 20, maxChanges 50)', () => {
  const small = { pageSize: 20, limits: { maxChanges: 50 } };

  test('a 537-message mailbox needs many runs; ONE Sync now completes it; each run is bounded', async () => {
    const s = await mailbox(537, small);
    const c = await s.syncNow();
    exactlyOnce(s);
    // A run lists whole pages until the budget (50) needs work: 3 pages of 20 → ≤ 60 per run.
    assert.ok(c.syncCount >= Math.ceil(537 / 60), `runs=${c.syncCount}`);
    // Each single run, stepwise, on a second mailbox: fetched ≤ budget + one page.
    const s2 = await mailbox(310, small);
    const perRun = [];
    for (let i = 0; i < 30; i++) {
      const r = await s2.service.sync({ principal: s2.principal, connectionId: s2.id });
      perRun.push(r.lastSync.counts.fetched);
      if (!r.lastSync.more) break;
    }
    assert.ok(perRun.length >= 5 && Math.max(...perRun) <= 50 + 20, `per-run fetches: ${perRun}`);
    exactlyOnce(s2);
    assert.equal(c.initialSyncComplete, true);
    const fetches = s.mock.calls.filter(x => x.op === 'getMessage').length;
    assert.equal(fetches, 537, 'every message fetched once (no refetch of earlier pages)');
  });

  test('restart mid-pass (a NEW service/process): resumes from the saved cursor, nothing twice, nothing skipped', async () => {
    const s = await mailbox(300, small);
    // Two single runs, as a process that then dies.
    await s.service.sync({ principal: s.principal, connectionId: s.id });
    await s.service.sync({ principal: s.principal, connectionId: s.id });
    const mid = await s.record();
    assert.ok(mid.fullSync?.cursor, 'pass in progress');
    assert.equal(mid.checkpoint, null, 'initial sync NOT marked complete');
    const before = s.held().length;
    assert.ok(before > 0 && before < 300);
    const view = await EG.runWithDataClass('user', () => s.service.getConnection({ principal: s.principal, connectionId: s.id }));
    assert.equal(view.progress.listed > 0, true);
    // "Restart": a fresh service + runner over the same durable stores.
    const svc2 = s.mk();
    const r2 = createInProcessSyncRunner({ service: svc2, log: quiet, pauseMs: 0 });
    await s.syncNow('auto', r2);
    exactlyOnce(s);
    assert.equal(s.mock.calls.filter(x => x.op === 'getMessage').length, 300, 'no message fetched twice across the restart');
  });

  test('crash AFTER imports but BEFORE the position is saved: the run repeats, imports are idempotent', async () => {
    const s = await mailbox(120, small);
    const realUpdate = s.store.update.bind(s.store);
    let crashed = false;
    s.store.update = async (o, i, patch, opts) => {
      if (!crashed && patch && 'fullSync' in patch && patch.fullSync?.cursor) { crashed = true; throw new Error('simulated crash before the cursor was saved'); }
      return realUpdate(o, i, patch, opts);
    };
    // Since the recovery fix, a failed position save is HANDLED: the run reports it and stops.
    const r = await s.service.sync({ principal: s.principal, connectionId: s.id });
    assert.equal(r.lastSync.state, 'failed');
    assert.match(r.lastSync.error, /position could not be saved/);
    assert.equal((await s.record()).fullSync ?? null, null, 'cursor not advanced');
    const importedBeforeRetry = s.held().length;
    assert.ok(importedBeforeRetry > 0, 'the run had imported before the crash');
    s.store.update = realUpdate;
    await s.syncNow();
    exactlyOnce(s);
  });

  test('a failed batch loses nothing: failed fetches dirty the pass, which is NOT marked complete; the next Sync now imports them', async () => {
    const s = await mailbox(200, small);
    s.mock.failNext('getMessage', 400, 7);   // 7 permanent failures (not retried within the run)
    const c1 = await s.syncNow();
    assert.equal(s.held().length, 193);
    assert.equal(c1.initialSyncComplete, false, 'not complete while messages are missing');
    assert.equal(c1.lastSync.state, 'partial');
    assert.match(c1.lastSync.note ?? '', /could not import every resource/);
    const c2 = await s.syncNow();
    exactlyOnce(s);
    assert.equal(c2.initialSyncComplete, true);
  });

  test('positions never run ahead of durable storage: if the import cannot be flushed, nothing advances', async () => {
    let failFlush = true;
    const ext = { ...K.external, flushImports: async () => { if (failFlush) throw new Error('disk full'); return K.external.flushImports(); } };
    const s = await mailbox(80, { ...small, external: ext });
    const c1 = await s.syncNow();
    assert.equal(c1.lastSync.state, 'failed');
    assert.match(c1.lastSync.error, /could not be made durable/);
    const rec = await s.record();
    assert.deepEqual([rec.fullSync, rec.checkpoint], [null, null]);
    failFlush = false;
    await s.syncNow();
    exactlyOnce(s);
  });

  test('after every run the stored file already holds what the saved position covers (flushed, not debounced)', async () => {
    const s = await mailbox(90, small);
    await s.service.sync({ principal: s.principal, connectionId: s.id });   // one run, then read the disk at once
    const find = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { const r = find(p); if (r) return r; } else if (e.name === '.aqua-uko.json') return p; } return null; };
    const file = find(K.TMP);
    assert.ok(file, 'the UKO store file exists');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    const owners = onDisk.data?.owners ?? onDisk.owners ?? {};
    const diskIds = Object.keys(owners[s.owner] ?? {}).filter(k => k.startsWith('ext_'));
    assert.equal(diskIds.length, s.held().length);
    assert.ok(diskIds.length > 0);
  });

  test('an expired page token mid-pass: the pass restarts from the start safely (no duplicates, nothing lost)', async () => {
    const s = await mailbox(150, small);
    await s.service.sync({ principal: s.principal, connectionId: s.id });
    assert.ok((await s.record()).fullSync?.cursor);
    s.mock.failNext('listMessages', 400, 1);   // Gmail refuses the saved page token
    const c = await s.syncNow();
    exactlyOnce(s);
    assert.equal(c.initialSyncComplete, true);
  });

  test('mail arriving DURING the initial pass is imported (the pass ends with the history position taken at its start)', async () => {
    const s = await mailbox(200, small);
    await s.service.sync({ principal: s.principal, connectionId: s.id });
    for (let i = 0; i < 4; i++) s.mock.addMessage(s.acct, message(5000 + i, { date: new Date(T0 + 9e9 + i).toUTCString() }));   // newest: above the listed pages
    s.mock.deleteMessage(s.acct, gid(199));   // and one deleted during the pass (already listed)
    await s.syncNow();      // finishes the pass
    await s.syncNow();      // incremental from the pass's start position
    exactlyOnce(s);
    assert.equal(s.held().length, 200 - 1 + 4);
  });

  test('incremental after completion: new, deleted and trashed mail are reflected; deleted mail never reappears', async () => {
    const s = await mailbox(210, small);
    await s.syncNow();
    s.mock.addMessage(s.acct, message(9001, { date: new Date(T0 + 9e9).toUTCString() }));
    s.mock.deleteMessage(s.acct, gid(3));
    s.mock.trash(s.acct, gid(4));
    const c = await s.syncNow();
    assert.equal(c.lastSync.mode, 'incremental');
    assert.ok(s.held().includes(`msg:${gid(9001)}`));
    assert.ok(!s.held().includes(`msg:${gid(3)}`) && !s.held().includes(`msg:${gid(4)}`));
    await s.syncNow('full');   // a complete re-pass must not resurrect them
    assert.ok(!s.held().includes(`msg:${gid(3)}`) && !s.held().includes(`msg:${gid(4)}`));
    assert.equal(s.held().length, 210 - 2 + 1);
  });

  test('expired history after completion: falls back to a full listing; no duplicates', async () => {
    const s = await mailbox(130, small);
    await s.syncNow();
    s.mock.addMessage(s.acct, message(7001, { date: new Date(T0 + 9e9).toUTCString() }));
    s.mock.expireHistory(s.acct);
    await s.syncNow();
    exactlyOnce(s);
    assert.equal(s.held().length, 131);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('C3 · concurrency, disconnect, uploads, single writer', () => {
  const small = { pageSize: 20, limits: { maxChanges: 50 } };

  test('concurrent Sync now requests and direct concurrent runs: one pass, no corruption, exactly once', async () => {
    const s = await mailbox(260, small);
    const a = s.runner.start({ principal: s.principal, connectionId: s.id });
    const b = s.runner.start({ principal: s.principal, connectionId: s.id });
    assert.deepEqual([a.started, b.started], [true, false]);
    // A second process-level caller racing the runner (serialised by the owner lock).
    await Promise.all([s.runner.idle(), s.service.sync({ principal: s.principal, connectionId: s.id }), s.service.sync({ principal: s.principal, connectionId: s.id })]);
    await s.syncNow();
    exactlyOnce(s);
  });

  test('disconnect DURING a multi-run sync: the sync stops and no Gmail data remains', async () => {
    const s = await mailbox(400, small);
    s.runner.start({ principal: s.principal, connectionId: s.id });
    // Wait until the first run has imported, so the disconnect really lands DURING the sync.
    for (let i = 0; i < 500 && s.held().length === 0; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(s.held().length > 0 && s.held().length < 400, 'disconnect lands mid-sync');
    assert.equal(s.runner.isRunning(s.owner, s.id), true);
    await s.service.disconnect({ principal: s.principal, connectionId: s.id });
    await s.runner.idle();
    assert.equal(K.external.listExternalResources(s.owner, s.sourceId).length, 0);
    assert.equal(s.ukoCount(), 0);
    assert.equal(EG.runWithDataClass('user', () => I.overview({ principal: s.principal, now: T0 })).counts.items, 0);
    await assert.rejects(s.service.sync({ principal: s.principal, connectionId: s.id }), e => e.code === 'NOT_FOUND');
    assert.equal(s.ukoCount(), 0, 'a late sync cannot bring anything back');
  });

  test('existing uploads stay intact through a 600-message import and its disconnect; the 200 cap still bounds other external sources', async () => {
    const s = await mailbox(600, small);
    const upload = { id: crypto.randomUUID(), owner: s.owner, dataClass: 'upload', provenance: { uploadedAt: Date.now() }, sourceFile: { name: 'notes.md', ext: '.md', bytes: 5, hash: 'h' }, fileType: 'document' };
    ukoStore.saveUKO(upload);
    await s.syncNow();
    exactlyOnce(s);
    assert.ok(ukoStore.getUKO(s.owner, upload.id));
    // Another (capped) external source for the same owner: 600 Gmail messages do not use its budget.
    assert.equal(K.external.externalUsage(s.owner).items, 0);
    await s.service.disconnect({ principal: s.principal, connectionId: s.id });
    assert.ok(ukoStore.getUKO(s.owner, upload.id), 'upload survives the Gmail disconnect');
    assert.equal(s.ukoCount(), 0);
  });

  test('storage stays single-writer: no worker handler; the sync wrote this (API) process\'s store', () => {
    assert.equal(W.HANDLERS['connect.sync.v1'], undefined);
    assert.ok(ukoStore.UNCAPPED_CLASSES.has('external:gmail') && ukoStore.UNCAPPED_CLASSES.size === 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('C4 · security regression', () => {
  test('no network, no provider/embedding attempt with Gmail in scope; Gmail text only in the restricted UKO store', async () => {
    assert.deepEqual(egress, []);
    assert.equal(JSON.stringify(EG.egressStats()).includes('external:gmail'), false);
    await new Promise(r => setTimeout(r, 1200));
    const hits = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { let t = ''; try { t = fs.readFileSync(p, 'utf8'); } catch { /* binary */ } if (t.includes('send report number')) hits.push(path.relative(K.TMP, p)); } } };
    walk(K.TMP);
    assert.ok(hits.length > 0);
    assert.deepEqual(hits.filter(h => !/uko/i.test(h)), [], `Gmail text outside the UKO store: ${hits.join(', ')}`);
  });
});
