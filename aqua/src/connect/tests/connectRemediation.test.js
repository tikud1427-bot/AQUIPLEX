/**
 * Connect Engine — regression tests for the sync and credential safeguards:
 *
 *   envelopes      vault: exact 16-byte tag, 12-byte IV, strict encoding, fail closed
 *   full listings  a page-limited listing is partial, resumes from its saved position
 *   mass deletion  withhold → confirm by agreement or explicitly
 *   change limit   unchanged resources are set aside BEFORE the per-run change limit
 *   key loss       key missing / changed → needs_reauth; honest revocation results
 *   locking        one lock per process across service instances; re-check before writes
 *   schema         the strict schema keeps the new fields (document validation only)
 *
 * Same isolation as the other connect tests: testkit.js (temp data dir, no DB,
 * no Mongo, no provider keys, fake connector, test-generated key).
 */
import {
  stack, freshUser, ownerOf, settle, doc, external, TEST_KEY,
  createFakeWorld, createFakeConnector, createConnectorRegistry, createMemoryConnectionStore,
  createCredentialVault, createConnectService,
} from './testkit.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createUnavailableVault, vaultFromEnv, CredentialVaultError, IV_BYTES, TAG_BYTES,
} from '../credentialVault.js';
import { runSync, SYNC_LIMITS, MASS_DELETION } from '../syncEngine.js';
import { _ownerLockHeldForTests } from '../connectService.js';

const noRetry = { sleep: () => Promise.resolve(), baseMs: 0 };
const quiet = { log: () => {}, warn: () => {} };
const held = (owner, connectionId) => external.listExternalResources(owner, `fake:${connectionId}`);

async function connected({ account = 'acct-1', ...opts } = {}) {
  const s = stack(opts);
  const userId = freshUser('rm');
  const conn = await s.service.connect({ userId, connectorId: 'fake', input: { account, code: 'ok' } });
  return { ...s, userId, owner: ownerOf(userId), conn, account, id: conn.connectionId };
}
/** A second, independent service instance over the same registry/store/vault. */
const secondInstance = (s, { vault = s.vault } = {}) =>
  createConnectService({ registry: s.registry, store: s.store, vault, retry: noRetry, log: quiet, trustRawUserId: true });

const seed = (world, account, n, prefix = 'r') => {
  for (let i = 0; i < n; i++) world.put(account, `${prefix}${String(i).padStart(3, '0')}`, { name: `${prefix}${i}.md`, content: doc(`Item${prefix}${i}x`) });
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// ── Credential envelopes ─────────────────────────────────────────────────────

describe('vault envelope integrity', () => {
  const vault = createCredentialVault({ key: TEST_KEY });
  const b = { ownerId: 'user:a', connectionId: 'conn_' + 'a'.repeat(20), connectorId: 'fake' };
  const sealed = () => vault.seal({ accessToken: 'tok-SECRETVALUE' }, b);
  const b64 = buf => buf.toString('base64');

  test('a fresh seal uses a 12-byte IV and a 16-byte tag, and round-trips', () => {
    const e = sealed();
    assert.equal(Buffer.from(e.iv, 'base64').length, IV_BYTES);
    assert.equal(Buffer.from(e.tag, 'base64').length, TAG_BYTES);
    assert.equal(vault.open(e, b).accessToken, 'tok-SECRETVALUE');
  });

  test('truncated tags (4, 8, 12, 15 bytes) are refused before decryption', () => {
    for (const n of [4, 8, 12, 15]) {
      const e = sealed();
      const tag = Buffer.from(e.tag, 'base64').subarray(0, n);
      assert.throws(() => vault.open({ ...e, tag: b64(tag) }, b), err => err instanceof CredentialVaultError && err.code === 'ENVELOPE_INVALID', `tag of ${n} bytes accepted`);
    }
  });

  test('wrong tag and IV lengths are refused (too long, too short, empty)', () => {
    const e = sealed();
    const tag = Buffer.from(e.tag, 'base64');
    const iv = Buffer.from(e.iv, 'base64');
    const bad = [
      { tag: b64(Buffer.concat([tag, Buffer.from([0])])) },
      { tag: '' },
      { iv: b64(iv.subarray(0, 8)) },
      { iv: b64(Buffer.concat([iv, iv])) },
      { iv: '' },
      { ct: '' },
    ];
    for (const patch of bad) assert.throws(() => vault.open({ ...e, ...patch }, b), err => err.code === 'ENVELOPE_INVALID', JSON.stringify(patch));
  });

  test('malformed encodings are refused: wrong alphabet, non-canonical padding, whitespace, non-strings', () => {
    const e = sealed();
    const bad = [
      { tag: e.tag.replace(/=+$/, '') },                 // padding removed
      { tag: `${e.tag}=` },                              // extra padding
      { tag: e.tag.replace(/[A-Za-z]/, '-') },           // base64url alphabet
      { iv: ` ${e.iv}` },                                // whitespace
      { iv: e.iv.replace(/.$/, '!') },
      { tag: 12345 }, { iv: null }, { ct: { length: 4 } },
      { iv: Buffer.from(e.iv, 'base64').toString('hex') },  // right bytes, wrong encoding
    ];
    for (const patch of bad) assert.throws(() => vault.open({ ...e, ...patch }, b), err => err.code === 'ENVELOPE_INVALID', JSON.stringify(patch));
  });

  test('tampering with the ciphertext, the tag or the IV fails closed as DECRYPT_FAILED', () => {
    const e = sealed();
    const flip = (s, i = 0) => { const x = Buffer.from(s, 'base64'); x[i] ^= 1; return b64(x); };
    for (const patch of [{ ct: flip(e.ct) }, { tag: flip(e.tag, 15) }, { iv: flip(e.iv, 11) }]) {
      assert.throws(() => vault.open({ ...e, ...patch }, b), err => err.code === 'DECRYPT_FAILED', JSON.stringify(Object.keys(patch)));
    }
  });

  test('a truncated tag from a REAL envelope never yields plaintext', () => {
    // Node accepts a 4-byte tag unless authTagLength is pinned; the vault refuses it.
    const e = sealed();
    const short = b64(Buffer.from(e.tag, 'base64').subarray(0, 4));
    let opened = null;
    try { opened = vault.open({ ...e, tag: short }, b); } catch { /* expected */ }
    assert.equal(opened, null);
  });
});

// ── Full listings ────────────────────────────────────────────────────────────

describe('page-limited listings are partial and resume', () => {
  test('52 resources, one per page: run 1 is partial and saves its position; run 2 finishes; all 52, no duplicates', async () => {
    const world = createFakeWorld({ pageSize: 1 });
    const s = await connected({ world });
    seed(world, s.account, 52);

    const r1 = await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    assert.equal(r1.lastSync.state, 'partial', 'a page-limited listing must not be reported as success');
    assert.equal(r1.lastSync.complete, false);
    assert.match(r1.lastSync.note, /listing incomplete after 50 page/);
    assert.equal(r1.lastSync.counts.listed, SYNC_LIMITS.maxPages);
    const raw1 = s.store._rawForTests()[0];
    assert.equal(raw1.checkpoint, null, 'checkpoint advanced before the pass finished');
    assert.equal(raw1.fullSync.cursor, '50');
    assert.equal(raw1.fullSync.seenHeld.length, 50);
    assert.equal((await s.service.getConnection({ userId: s.userId, connectionId: s.id })).fullSyncInProgress, true);
    assert.equal(held(s.owner, s.id).length, 50);

    // auto mode continues the unfinished pass rather than switching to incremental
    const r2 = await s.service.sync({ userId: s.userId, connectionId: s.id });
    assert.equal(r2.lastSync.mode, 'full');
    assert.equal(r2.lastSync.state, 'succeeded');
    assert.equal(r2.lastSync.complete, true);
    const listCalls = world.calls.filter(c => c.op === 'list');
    assert.equal(listCalls.at(-2).cursor, '50', 'run 2 did not resume from the saved position');
    const raw2 = s.store._rawForTests()[0];
    assert.equal(raw2.fullSync, null);
    assert.ok(raw2.checkpoint?.fullSyncAt, 'checkpoint not advanced after the pass completed');

    const items = held(s.owner, s.id);
    assert.equal(items.length, 52);
    assert.equal(new Set(items.map(x => x.externalId)).size, 52, 'duplicate resources');
    assert.equal(r2.lastSync.counts.removed, 0);
  });

  test('deletions wait for the whole pass: removals at the end of the source are applied only by the completing run', async () => {
    const world = createFakeWorld({ pageSize: 1 });
    const s = await connected({ world });
    seed(world, s.account, 53);
    await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    await s.service.sync({ userId: s.userId, connectionId: s.id });
    assert.equal(held(s.owner, s.id).length, 53);

    world.remove(s.account, 'r052');
    world.remove(s.account, 'r051');
    const p1 = await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    assert.equal(p1.lastSync.state, 'partial');
    assert.equal(p1.lastSync.counts.removed, 0, 'deleted from an incomplete listing');
    assert.equal(held(s.owner, s.id).length, 53);

    // 51 entries remain: the resumed run lists the last one and completes the pass.
    const p2 = await s.service.sync({ userId: s.userId, connectionId: s.id });
    assert.equal(p2.lastSync.state, 'succeeded');
    assert.equal(p2.lastSync.counts.removed, 2);
    assert.deepEqual(held(s.owner, s.id).map(x => x.externalId).filter(id => id >= 'r051'), []);
    assert.equal(held(s.owner, s.id).length, 51);
  });

  test('the persisted listing cursor is bounded: an oversized or non-string cursor fails discovery before any write', async () => {
    for (const bad of ['c'.repeat(SYNC_LIMITS.maxCursorChars + 1), { deep: 'object' }, 42]) {
      const world = createFakeWorld();
      const base = createFakeConnector({ world });
      const s = await connected({ world, connectorOverrides: {
        async listResources(ctx, o) { const r = await base.listResources(ctx, o); return { ...r, cursor: bad }; },
      } });
      seed(world, s.account, 3);
      const r = await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
      assert.equal(r.lastSync.state, 'failed');
      assert.match(r.lastSync.error, /invalid listing cursor/);
      const raw = s.store._rawForTests()[0];
      assert.deepEqual([raw.fullSync, raw.checkpoint], [null, null]);
      assert.equal(held(s.owner, s.id).length, 0);
    }
  });

  test('a run that fails mid-pass keeps the saved position (it does not restart or skip)', async () => {
    const world = createFakeWorld({ pageSize: 1 });
    const s = await connected({ world });
    seed(world, s.account, 52);
    await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    world.failList(5, { transient: false });
    const r = await s.service.sync({ userId: s.userId, connectionId: s.id });
    assert.equal(r.lastSync.state, 'failed');
    assert.equal(s.store._rawForTests()[0].fullSync.cursor, '50');
    world.failures.list = 0;
    const r3 = await s.service.sync({ userId: s.userId, connectionId: s.id });
    assert.equal(r3.lastSync.state, 'succeeded');
    assert.equal(held(s.owner, s.id).length, 52);
  });
});

// ── Mass deletion ────────────────────────────────────────────────────────────

describe('mass-deletion guard', () => {
  async function holding(n, opts = {}) {
    const s = await connected(opts);
    seed(s.world, s.account, n);
    const r = await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    assert.equal(r.lastSync.state, 'succeeded');
    assert.equal(held(s.owner, s.id).length, n);
    return s;
  }

  test('an empty complete listing does not wipe the connection; a later full listing that agrees resolves it', async () => {
    let glitch = false;
    const world = createFakeWorld();
    const base = createFakeConnector({ world });
    const s = await holding(5, { world, connectorOverrides: {
      listResources: (ctx, o) => (glitch ? Promise.resolve({ resources: [], cursor: null }) : base.listResources(ctx, o)),
    } });
    // A provider glitch: the listing comes back empty and "complete".
    glitch = true;
    const r = await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    assert.equal(r.lastSync.state, 'partial');
    assert.equal(r.lastSync.counts.withheldRemovals, 5);
    assert.equal(r.lastSync.counts.removed, 0);
    assert.match(r.lastSync.note, /mass deletion withheld/);
    assert.equal(held(s.owner, s.id).length, 5, 'knowledge deleted on a single empty listing');
    const v = await s.service.getConnection({ userId: s.userId, connectionId: s.id });
    assert.deepEqual([v.pendingDeletion.count, v.pendingDeletion.held, v.pendingDeletion.origin], [5, 5, 'full']);
    assert.ok(!('key' in v.pendingDeletion), 'the view exposes the removal-set hash');

    // The glitch passes: the next complete listing shows everything again → nothing removed, pending cleared.
    glitch = false;
    const r2 = await s.service.sync({ userId: s.userId, connectionId: s.id });
    assert.equal(r2.lastSync.mode, 'full', 'auto mode must re-list fully while a full-origin deletion is pending');
    assert.equal(r2.lastSync.state, 'succeeded');
    assert.equal(r2.lastSync.counts.removed, 0);
    assert.equal(held(s.owner, s.id).length, 5);
    assert.equal((await s.service.getConnection({ userId: s.userId, connectionId: s.id })).pendingDeletion, null);
  });

  // Phase 1b.2: agreement requires the SAME set from a complete listing at least one hour later.
  test('a genuinely emptied source is reconciled by an identical complete listing at least an hour later', async () => {
    let t = Date.parse('2026-11-18T09:00:00Z');
    const now = () => t;
    const s = await holding(5, { world: createFakeWorld({ now }), now });
    for (let i = 0; i < 5; i++) s.world.remove(s.account, `r${String(i).padStart(3, '0')}`);
    const r1 = await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    assert.equal(r1.lastSync.counts.withheldRemovals, 5);
    assert.equal(held(s.owner, s.id).length, 5);
    t += 59 * 60 * 1000;
    const early = await s.service.sync({ userId: s.userId, connectionId: s.id });
    assert.equal(early.lastSync.mode, 'full');
    assert.equal(early.lastSync.counts.withheldRemovals, 5, 'confirmed before the interval');
    t += 60 * 1000;
    const r2 = await s.service.sync({ userId: s.userId, connectionId: s.id });
    assert.equal(r2.lastSync.mode, 'full');
    assert.equal(r2.lastSync.state, 'succeeded');
    assert.equal(r2.lastSync.counts.removed, 5);
    assert.equal(held(s.owner, s.id).length, 0);
    assert.equal(s.store._rawForTests()[0].pendingDeletion, null);
  });

  test('explicit confirmation applies a withheld mass deletion at once', async () => {
    const s = await holding(4);
    for (let i = 0; i < 4; i++) s.world.remove(s.account, `r${String(i).padStart(3, '0')}`);
    const r = await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full', confirmMassDeletion: true });
    assert.equal(r.lastSync.state, 'succeeded');
    assert.equal(r.lastSync.counts.removed, 4);
    assert.equal(held(s.owner, s.id).length, 0);
    // a truthy non-boolean is NOT a confirmation
    const t = await holding(4);
    for (let i = 0; i < 4; i++) t.world.remove(t.account, `r${String(i).padStart(3, '0')}`);
    const r2 = await t.service.sync({ userId: t.userId, connectionId: t.id, mode: 'full', confirmMassDeletion: 'yes' });
    assert.equal(r2.lastSync.counts.withheldRemovals, 4);
  });

  test('a different removal set restarts the sequence (agreement means the SAME set, an hour apart)', async () => {
    let t = Date.parse('2026-11-18T09:00:00Z');
    const now = () => t;
    const s = await holding(6, { world: createFakeWorld({ now }), now });
    for (const id of ['r000', 'r001', 'r002', 'r003']) s.world.remove(s.account, id);
    await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    t += 61 * 60 * 1000;
    s.world.remove(s.account, 'r004');
    const r2 = await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    assert.equal(r2.lastSync.counts.withheldRemovals, 5, 'a different set must not be confirmed by the older sighting');
    assert.equal(held(s.owner, s.id).length, 6);
    assert.equal(s.store._rawForTests()[0].pendingDeletion.firstSeenAt, new Date(t).toISOString(), 'the sequence restarted');
    t += 60 * 60 * 1000;
    const r3 = await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    assert.equal(r3.lastSync.counts.removed, 5);
    assert.deepEqual(held(s.owner, s.id).map(x => x.externalId), ['r005']);
  });

  test('legitimate individual deletions still apply immediately (full and incremental)', async () => {
    const s = await holding(5);
    s.world.remove(s.account, 'r002');
    const r = await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    assert.equal(r.lastSync.state, 'succeeded');
    assert.equal(r.lastSync.counts.removed, 1);
    s.world.remove(s.account, 'r003');
    s.world.remove(s.account, 'r004');
    const r2 = await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'incremental' });
    assert.equal(r2.lastSync.counts.removed, 2, `2 of 4 is not more than ${MASS_DELETION.maxFraction}`);
    assert.equal(held(s.owner, s.id).length, 2);
  });

  test('a change feed reporting a mass removal is withheld and can never confirm it; complete full listings do', async () => {
    let t = Date.parse('2026-11-18T09:00:00Z');
    const now = () => t;
    const s = await holding(5, { world: createFakeWorld({ now }), now });
    await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'incremental' });   // establish a feed checkpoint
    for (const id of ['r000', 'r001', 'r002', 'r003']) s.world.remove(s.account, id);
    const r1 = await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'incremental' });
    assert.equal(r1.lastSync.counts.withheldRemovals, 4);
    assert.equal(s.store._rawForTests()[0].pendingDeletion.origin, 'feed');
    t += 2 * 60 * 60 * 1000;
    const r2 = await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'incremental' });
    assert.equal(r2.lastSync.counts.withheldRemovals, 4, 'a repeated feed confirmed a mass deletion');
    assert.equal(held(s.owner, s.id).length, 5);
    const full1 = await s.service.sync({ userId: s.userId, connectionId: s.id });   // auto → full (pending)
    assert.equal(full1.lastSync.mode, 'full');
    assert.equal(full1.lastSync.counts.withheldRemovals, 4, 'the first complete listing only records the sighting');
    t += 60 * 60 * 1000;
    const full2 = await s.service.sync({ userId: s.userId, connectionId: s.id });
    assert.equal(full2.lastSync.counts.removed, 4);
    assert.equal(full2.lastSync.state, 'succeeded');
    assert.equal(held(s.owner, s.id).length, 1);
  });

  test('partial and failed listings never delete, even with confirmation', async () => {
    const world = createFakeWorld({ pageSize: 1 });
    const s = await connected({ world });
    seed(world, s.account, 52);
    await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    await s.service.sync({ userId: s.userId, connectionId: s.id });
    for (let i = 0; i < 40; i++) world.remove(s.account, `r${String(i).padStart(3, '0')}`);
    world.failList(5, { transient: false });
    const failedRun = await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full', confirmMassDeletion: true });
    assert.equal(failedRun.lastSync.state, 'failed');
    assert.equal(held(s.owner, s.id).length, 52);
    world.failures.list = 0;
    // 12 entries left: one run lists them completely, so give a page limit instead via the engine directly.
    const conn = s.store._rawForTests()[0];
    const out = await runSync({
      ownerId: s.owner, conn, connector: s.registry.get('fake'), external, retry: noRetry, confirmMassDeletion: true,
      ctx: { connectionId: s.id, credentials: () => s.vault.open(conn.credentials, { ownerId: s.owner, connectionId: s.id, connectorId: 'fake' }) },
      mode: 'full', limits: { ...SYNC_LIMITS, maxPages: 3 },
    });
    assert.equal(out.lastSync.state, 'partial');
    assert.equal(out.lastSync.counts.removed, 0, 'deleted from a page-limited listing');
    assert.equal(held(s.owner, s.id).length, 52);
  });
});

// ── Change limit ─────────────────────────────────────────────────────────────

/** A stateful stand-in for the Phase 1a.2 API: counts what the engine asks to import. */
function stubExternal(initial = []) {
  const items = new Map(initial.map(r => [r.externalId, { ...r }]));
  const imported = [];
  return {
    imported, items,
    EXTERNAL_LIMITS: { resourcesPerSync: 100 },
    listExternalResources: () => [...items.values()].map(r => ({ ...r })),
    async syncExternalResources({ resources }) {
      const results = resources.map(r => {
        imported.push(r.externalId);
        const status = items.has(r.externalId) ? 'updated' : 'created';
        items.set(r.externalId, { externalId: r.externalId, version: r.version });
        return { externalId: r.externalId, status };
      });
      return { results };
    },
    async deleteExternalResource(_o, _s, id) { items.delete(id); return { complete: true }; },
  };
}

describe('the change limit counts only resources that need work', () => {
  const big = async ({ total, changed, maxChanges = SYNC_LIMITS.maxChanges }) => {
    const world = createFakeWorld({ pageSize: 100 });
    for (let i = 0; i < total; i++) world.put('acct', `x${String(i).padStart(4, '0')}`, { name: `x${i}.md`, content: `body ${i}` });
    const ext = stubExternal([...world.accountOf('acct').resources.values()].map(r => ({ externalId: r.externalId, version: r.version })));
    for (let i = 0; i < changed; i++) { const k = total - 1 - i * 7; world.put('acct', `x${String(k).padStart(4, '0')}`, { name: `x${k}.md`, content: `changed ${i}` }); }   // changes sit at the END of the listing, beyond the 1,000th entry
    const connector = createFakeConnector({ world });
    const issued = world.issue('acct');
    const conn = { connectionId: 'conn_' + 'c'.repeat(20), sourceId: 'fake:conn_' + 'c'.repeat(20), checkpoint: null };
    const ctx = { connectionId: conn.connectionId, credentials: () => ({ accessToken: issued.accessToken }) };
    const run = c => runSync({ ownerId: 'user:cs3', conn: c, connector, ctx, external: ext, retry: noRetry, mode: 'full', limits: { ...SYNC_LIMITS, maxChanges } });
    return { world, ext, conn, run };
  };

  test('1,005 listed, 5 changed: all 5 imported in one clean run', async () => {
    const { ext, conn, run } = await big({ total: 1005, changed: 5 });
    const out = await run(conn);
    const c = out.lastSync.counts;
    assert.equal(c.listed, 1005);
    assert.equal(c.considered, 1005);
    assert.equal(c.skippedSameVersion, 1000);
    assert.equal(c.fetched, 5);
    assert.equal(c.updated, 5);
    assert.equal(out.lastSync.state, 'succeeded');
    assert.equal(out.lastSync.note, undefined, 'no truncation note expected');
    assert.equal(ext.imported.length, 5);
    assert.ok(out.checkpoint?.fullSyncAt);
  });

  // 2026-11-23: a full pass no longer truncates (and skips) beyond maxChanges; it stops
  // LISTING once the run's budget is reached and resumes from the saved cursor.
  test('when real changes exceed the limit the run is partial, keeps its checkpoint, and the next runs finish the rest', async () => {
    const { ext, conn, run } = await big({ total: 1005, changed: 8, maxChanges: 3 });
    const o1 = await run(conn);
    assert.equal(o1.lastSync.state, 'partial');
    assert.match(o1.lastSync.note, /listing incomplete/);
    assert.equal(o1.lastSync.more, true);
    assert.ok(o1.fullSync?.cursor, 'the pass resumes from a saved cursor');
    assert.equal(o1.checkpoint, null);
    let prev = o1, runs = 1;
    while (prev.lastSync.more && runs < 20) { prev = await run({ ...conn, checkpoint: prev.checkpoint, fullSync: prev.fullSync }); runs++; }
    assert.equal(prev.lastSync.state, 'succeeded');
    assert.ok(prev.checkpoint?.fullSyncAt);
    assert.ok(runs >= 2, 'the pass spans runs (a run lists whole pages: at most one page beyond the budget)');
    assert.equal(ext.imported.length, 8, 'a change was imported twice or never');
    assert.equal(new Set(ext.imported).size, 8);
  });
});

// ── Key loss and revocation ──────────────────────────────────────────────────

describe('key loss and honest revocation results', () => {
  test('vaultFromEnv: a missing or invalid key yields an unavailable vault, never a fallback key', () => {
    const missing = vaultFromEnv({});
    assert.equal(missing.unavailable, true);
    assert.equal(missing.code, 'KEY_MISSING');
    assert.equal(missing.keyId, null);
    assert.throws(() => missing.seal({ a: 1 }, { ownerId: 'o', connectionId: 'c', connectorId: 'f' }), e => e.code === 'KEY_MISSING');
    assert.equal(vaultFromEnv({ AQUA_CONNECTOR_KEY: 'too-short' }).code, 'KEY_INVALID');
    assert.equal(vaultFromEnv({ AQUA_CONNECTOR_KEY: crypto.randomBytes(32).toString('base64') }).unavailable, undefined);
  });

  test('missing key: connecting is refused before the provider issues anything; existing connections become needs_reauth', async () => {
    const s = await connected();
    s.world.put(s.account, 'a', { name: 'a.md', content: doc('Keyloss') });
    await s.service.sync({ userId: s.userId, connectionId: s.id });
    const callsBefore = s.world.calls.length;

    const noKey = secondInstance(s, { vault: createUnavailableVault('KEY_MISSING') });
    await assert.rejects(() => noKey.connect({ userId: s.userId, connectorId: 'fake', input: { account: 'acct-9', code: 'ok' } }), e => e.code === 'CREDENTIAL_KEY_UNAVAILABLE');
    await assert.rejects(() => noKey.sync({ userId: s.userId, connectionId: s.id }), e => e.code === 'CREDENTIALS_UNREADABLE');
    const v = await noKey.getConnection({ userId: s.userId, connectionId: s.id });
    assert.equal(v.status, 'needs_reauth');
    assert.match(v.lastSync.error, /reconnect required/);
    assert.equal(s.world.calls.length, callsBefore, 'the provider was called without usable credentials');
    assert.equal(held(s.owner, s.id).length, 1, 'knowledge must be kept');

    const d = await noKey.disconnect({ userId: s.userId, connectionId: s.id });
    assert.equal(d.deleted, true);
    assert.equal(d.knowledgeRemoved, true);
    assert.equal(d.localCredentialsDeleted, true);
    assert.equal(d.providerRevocation, 'not_attempted');
    assert.equal(d.revokedAtSource, false, 'claimed a provider revocation that never happened');
    assert.match(d.providerRevocationReason, /cannot be opened/);
    assert.equal(held(s.owner, s.id).length, 0);
  });

  test('changed key: sync marks needs_reauth with a reconnect message; disconnect reports not_attempted', async () => {
    const s = await connected();
    const token = s.world.calls.length;   // no provider calls yet
    const other = secondInstance(s, { vault: createCredentialVault({ key: crypto.randomBytes(32) }) });
    await assert.rejects(() => other.sync({ userId: s.userId, connectionId: s.id }), e => e.code === 'CREDENTIALS_UNREADABLE');
    const raw = s.store._rawForTests()[0];
    assert.equal(raw.status, 'needs_reauth');
    assert.equal(raw.lastSync.error, 'reconnect required (stored credentials cannot be opened)');
    assert.ok(raw.credentials, 'sealed credentials are kept so the original key could still open them');
    assert.equal(s.world.calls.length, token);
    const r = await other.revokeCredentials({ userId: s.userId, connectionId: s.id });
    assert.deepEqual([r.localCredentialsDeleted, r.providerRevocation, r.revokedAtSource], [true, 'not_attempted', false]);
    assert.equal(s.store._rawForTests()[0].credentials, null);
  });

  test('corrupted or tampered stored envelope → needs_reauth (not a crash, not "active")', async () => {
    const s = await connected();
    const raw = s.store._rawForTests()[0];
    await s.store.update(s.owner, s.id, { credentials: { ...raw.credentials, tag: Buffer.from(raw.credentials.tag, 'base64').subarray(0, 4).toString('base64') } });
    await assert.rejects(() => s.service.sync({ userId: s.userId, connectionId: s.id }), e => e.code === 'CREDENTIALS_UNREADABLE');
    assert.equal(s.store._rawForTests()[0].status, 'needs_reauth');
  });

  test('successful provider revocation is reported as revoked', async () => {
    const s = await connected();
    s.world.put(s.account, 'a', { name: 'a.md', content: doc('Okrevoke') });
    await s.service.sync({ userId: s.userId, connectionId: s.id });
    const token = s.world.calls.find(c => c.op === 'list').token;
    const d = await s.service.disconnect({ userId: s.userId, connectionId: s.id });
    assert.deepEqual([d.localCredentialsDeleted, d.providerRevocation, d.providerRevocationReason, d.revokedAtSource], [true, 'revoked', null, true]);
    assert.equal(s.world.tokenState(token).revoked, true);
  });

  test('failed provider revocation is reported as failed; local credentials are still wiped; no provider text leaks', async () => {
    const s = await connected({ connectorOverrides: { async disconnect() { throw new Error('upstream 500 token=fake-access-LEAK'); } } });
    s.world.put(s.account, 'a', { name: 'a.md', content: doc('Failrevoke') });
    await s.service.sync({ userId: s.userId, connectionId: s.id });
    const token = s.world.calls.find(c => c.op === 'list').token;
    const r = await s.service.revokeCredentials({ userId: s.userId, connectionId: s.id });
    assert.deepEqual([r.localCredentialsDeleted, r.providerRevocation, r.revokedAtSource], [true, 'failed', false]);
    assert.ok(!JSON.stringify(r).includes('LEAK'));
    assert.equal(s.store._rawForTests()[0].credentials, null);
    assert.equal(s.world.tokenState(token).revoked, false, 'the fake provider still honours the token — exactly what the result must admit');
    const d = await s.service.disconnect({ userId: s.userId, connectionId: s.id });
    assert.deepEqual([d.deleted, d.providerRevocation, d.revokedAtSource], [true, 'not_attempted', false], 'credentials were already wiped, so nothing could be attempted');
  });
});

// ── Locking ──────────────────────────────────────────────────────────────────

describe('one lock per process; re-checks before every write', () => {
  /** A stack whose fetchResource pauses on the first call until released. */
  async function gated() {
    const gate = deferred();
    const reached = deferred();
    let first = true;
    const world = createFakeWorld();
    const base = createFakeConnector({ world });
    const s = await connected({
      world,
      connectorOverrides: {
        async fetchResource(ctx, ref) {
          if (first) { first = false; reached.resolve(); await gate.promise; }
          return base.fetchResource(ctx, ref);
        },
      },
    });
    seed(world, s.account, 3);
    return { ...s, gate, reached };
  }

  test('disconnect on a second instance waits for the running sync; nothing is resurrected afterwards', async () => {
    const s = await gated();
    const B = secondInstance(s);
    const syncing = s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    await s.reached.promise;
    let disconnected = false;
    const disc = B.disconnect({ userId: s.userId, connectionId: s.id }).then(r => { disconnected = true; return r; });
    await settle(30);
    assert.equal(disconnected, false, 'instance B did not wait for instance A');
    assert.equal(_ownerLockHeldForTests(s.owner), true);
    assert.equal(s.store._rawForTests()[0].status, 'active', 'disconnect started while the sync held the lock');
    s.gate.resolve();
    const r = await syncing;
    assert.equal(r.lastSync.state, 'succeeded');
    const d = await disc;
    assert.equal(d.deleted, true);
    await settle();
    assert.equal(held(s.owner, s.id).length, 0, 'knowledge resurrected after disconnect');
    assert.deepEqual(s.store._rawForTests(), []);
    assert.equal(_ownerLockHeldForTests(s.owner), false);
  });

  test('two concurrent syncs on two instances are serialised: one listing at a time, consistent checkpoint, no duplicates', async () => {
    const world = createFakeWorld();
    const base = createFakeConnector({ world });
    let inFlight = 0, maxInFlight = 0;
    const s = await connected({
      world,
      connectorOverrides: {
        async listResources(ctx, o) {
          inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
          await settle(5);
          try { return await base.listResources(ctx, o); } finally { inFlight--; }
        },
      },
    });
    seed(world, s.account, 5);
    const B = secondInstance(s);
    const runs = await Promise.all([
      s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' }),
      B.sync({ userId: s.userId, connectionId: s.id, mode: 'full' }),
      s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' }),
      B.sync({ userId: s.userId, connectionId: s.id, mode: 'full' }),
    ]);
    assert.equal(maxInFlight, 1, 'two syncs listed at the same time');
    assert.deepEqual(runs.map(r => r.lastSync.state), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    assert.deepEqual(runs.map(r => r.lastSync.counts.created), [5, 0, 0, 0]);
    const raw = s.store._rawForTests()[0];
    assert.equal(raw.syncCount, 4, 'a sync overwrote another\'s record');
    assert.ok(raw.checkpoint?.fullSyncAt);
    assert.equal(raw.fullSync, null);
    assert.equal(held(s.owner, s.id).length, 5);
  });

  test('a status change made outside the lock (another process) aborts the run before its next import batch', async () => {
    const s = await gated();
    const syncing = s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    await s.reached.promise;
    await s.store.update(s.owner, s.id, { status: 'disconnecting' });   // not through the service: simulates another process
    s.gate.resolve();
    const r = await syncing;
    assert.equal(r.aborted, true);
    assert.equal(r.lastSync.state, 'aborted');
    const raw = s.store._rawForTests()[0];
    assert.equal(raw.status, 'disconnecting', 'the sync overwrote the disconnecting status');
    assert.equal(raw.checkpoint, null);
    assert.equal(raw.syncCount, 0);
    assert.equal(held(s.owner, s.id).length, 0, 'imported after the connection stopped being active');
  });

  test('a record deleted mid-run is not recreated, and nothing is imported', async () => {
    const s = await gated();
    const syncing = s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    await s.reached.promise;
    await s.store.remove(s.owner, s.id);
    s.gate.resolve();
    const r = await syncing;
    assert.deepEqual([r.aborted, r.status], [true, 'deleted']);
    assert.deepEqual(s.store._rawForTests(), []);
    assert.equal(held(s.owner, s.id).length, 0);
  });

  test('removals also re-check: a connection revoked before deletions are applied deletes nothing', async () => {
    const world = createFakeWorld();
    const s = await connected({ world });
    seed(world, s.account, 4);
    await s.service.sync({ userId: s.userId, connectionId: s.id, mode: 'full' });
    world.remove(s.account, 'r000');
    const base = s.registry.get('fake');
    const conn = s.store._rawForTests()[0];
    let checks = 0;
    const out = await runSync({
      ownerId: s.owner, conn, connector: base, external, retry: noRetry, mode: 'full',
      ctx: { connectionId: s.id, credentials: () => s.vault.open(conn.credentials, { ownerId: s.owner, connectionId: s.id, connectorId: 'fake' }) },
      guard: async () => (++checks, false),   // no imports needed (all unchanged), so the first check is the removal
    });
    assert.equal(out.aborted, true);
    assert.equal(checks, 1);
    assert.equal(held(s.owner, s.id).length, 4);
  });

  test('the lock is shared by instances built from different registries and stores in one process (per owner)', async () => {
    const a = await connected();
    const other = stack();
    const userB = freshUser('rm');
    const order = [];
    const slow = deferred();
    const gateConn = createConnectService({
      registry: (() => { const r = createConnectorRegistry({ allowTestOnly: true }); r.register(createFakeConnector({ world: a.world, overrides: { async listResources() { order.push('A-start'); await slow.promise; order.push('A-end'); return { resources: [], cursor: null }; } } })); return r; })(),
      store: a.store, vault: a.vault, retry: noRetry, log: quiet, trustRawUserId: true,
    });
    const p1 = gateConn.sync({ userId: a.userId, connectionId: a.id, mode: 'full' });
    await settle(10);
    const p2 = a.service.getConnection({ userId: a.userId, connectionId: a.id }).then(() => order.push('read'));   // reads are not locked
    const p3 = a.service.revokeCredentials({ userId: a.userId, connectionId: a.id }).then(() => order.push('revoke'));
    const otherConn = await other.service.connect({ userId: userB, connectorId: 'fake', input: { account: 'b', code: 'ok' } });
    const p4 = other.service.sync({ userId: userB, connectionId: otherConn.connectionId }).then(() => order.push('other-owner'));
    await Promise.all([p2, p4]);
    assert.deepEqual(order, ['A-start', 'read', 'other-owner'], 'another owner (or a read) was blocked, or revoke ran early');
    slow.resolve();
    await Promise.all([p1, p3]);
    assert.deepEqual(order.slice(-2), ['A-end', 'revoke']);
  });
});

// ── MongoDB schema (document validation) ─────────────────────────────────────

describe('MongoDB schema keeps the full-listing and pending-deletion fields', () => {
  test('fullSync and pendingDeletion survive the strict schema; unknown paths do not', async () => {
    const mongoose = (await import('mongoose')).default;
    const { _connectionModelForTests } = await import('../connectionStore.js');
    const M = await _connectionModelForTests(mongoose);
    const id = 'conn_' + '4'.repeat(20);
    const d = new M({
      connectionId: id, ownerId: 'user:a', connectorId: 'fake', sourceId: `fake:${id}`, status: 'active',
      fullSync: { cursor: 'abc', startedAt: '2026-11-18T00:00:00.000Z', runs: 2, seenHeld: ['x', 'y'] },
      pendingDeletion: { key: 'k'.repeat(32), origin: 'full', count: 5, held: 5, firstSeenAt: '2026-11-18T00:00:00.000Z' },
      notInSchema: 'dropped',
    });
    assert.equal(d.validateSync(), undefined);
    const o = d.toObject();
    assert.deepEqual(o.fullSync.seenHeld, ['x', 'y']);
    assert.equal(o.pendingDeletion.count, 5);
    assert.equal(o.notInSchema, undefined);
    const empty = new M({ connectionId: 'conn_' + '5'.repeat(20), ownerId: 'user:a', connectorId: 'fake', sourceId: 's', status: 'active' }).toObject();
    assert.equal(empty.fullSync, null);
    assert.equal(empty.pendingDeletion, null);
  });
});
