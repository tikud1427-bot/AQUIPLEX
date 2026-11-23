/**
 * Safety Fix 3 on the REAL stores (`on`, pg-mem), the REAL connect service and
 * the REAL fire-and-forget claim-vector indexing (evidenceStore.saveFact →
 * void indexCanonicalClaim → embed → vectorStore.upsert):
 *
 *   · a claim embedding started by a sync that finishes AFTER the sync ended
 *     lands while no acquisition happened since (the ended fence is proven);
 *   · …and is REFUSED once another holder acquired (even after it released),
 *     and when a NEW operation of the same owner runs in this very process;
 *   · …and is refused when the sync LOST its fence;
 *   · a plain (non-operation) backfill may not add an external fact's vector,
 *     and a plain update of an external fact is frozen to the database's
 *     version — while non-external writes of the same process land.
 * pg-mem does not block on locks: the multi-process proof is writeCarriedFence.live.test.js.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-wcf-'));
for (const k of Object.keys(process.env)) if (/(_API_KEY|^GEMINI|^GOOGLE)/.test(k)) delete process.env[k];
process.env.AQUA_STORE_PARTITIONS = 'reflection:on,mind:on,reasoning-graph:on,evidence:on,fileindex:on,uko:on,pic:on,vectors:on';
process.env.DATABASE_URL = 'postgresql://u:p@localhost:1/none';   // never dialled: the pool is replaced
process.env.MONGO_URI = '';
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';

let mem, poolMod, OB, WF, L, E, V, CS, prov;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Claim embeddings (one fact statement) wait for the gate; file chunks (the whole text) never do.
let gate = null;
const isClaim = texts => texts.length === 1 && !/June 12\. Lena/.test(texts[0]);

before(async () => {
  poolMod = await import('../../core/db/pool.js');
  poolMod._resetForTests();
  const { createMemoryPg } = await import('../../core/tests/helpers/memoryPg.mjs');
  mem = createMemoryPg();
  poolMod._setPoolForTests(mem.pool);
  await (await import('../../core/db/migrate.js')).migrate();
  for (const ix of ['aqua_jobs_ready_ix', 'aqua_jobs_running_owner_ix', 'aqua_jobs_dead_ix', 'aqua_jobs_running_heartbeat_ix']) {
    await mem.pool.query(`DROP INDEX IF EXISTS ${ix}`);
  }
  await (await import('../../core/storage/index.js')).configurePartitionBindings();
  OB = await import('../../core/storage/ownerBinding.js');
  WF = await import('../../core/storage/writeFence.js');
  L = await import('../../connect/ownerLease.js');
  E = await import('../evidenceStore.js');
  V = await import('../../embeddings/vectorStore.js');
  CS = await import('../../brain/contextEngine/canonicalSemantic.js');
  prov = await import('../../embeddings/embeddingProvider.js');
  prov.__setEmbedderForTests(async texts => {
    if (gate && isClaim(texts)) await gate.wait;
    return texts.map((t, i) => [1, i, t.length]);
  });
});
after(async () => {
  prov?.__clearEmbedderForTests?.();
  poolMod?._resetForTests();
  await mem?.close();
  delete process.env.DATABASE_URL;
});
beforeEach(() => { gate = null; });

const newGate = () => { let open; const wait = new Promise(r => { open = r; }); return { wait, open }; };
const text = token => `The ${token} launch is planned for June 12. Lena Hart owns the ${token} service and its 3 budgets.`;
let userN = 0;
async function connectedSource({ ttlMs = 10_000, renewEveryMs = null } = {}) {
  const { createConnectorRegistry } = await import('../../connect/registry.js');
  const { createMemoryConnectionStore } = await import('../../connect/connectionStore.js');
  const { createCredentialVault } = await import('../../connect/credentialVault.js');
  const { createConnectService } = await import('../../connect/connectService.js');
  const { createFakeWorld, createFakeConnector } = await import('../../connect/testing/fakeConnector.js');
  const world = createFakeWorld();
  const registry = createConnectorRegistry({ allowTestOnly: true });
  registry.register(createFakeConnector({ world }));
  const service = createConnectService({ registry, store: createMemoryConnectionStore(), vault: createCredentialVault({ key: crypto.randomBytes(32) }),
    retry: { sleep: async () => {}, baseMs: 0 }, log: { log() {}, warn() {} }, trustRawUserId: true, singleInstance: true, lease: { ttlMs, renewEveryMs } });
  const uid = `u-wcf-${process.pid}-${++userN}`;
  const ownerId = `user:${uid}`;
  const account = `acct-${uid}`;
  await OB.ensureOwnerLoaded(ownerId);
  const conn = await service.connect({ userId: uid, connectorId: 'fake', input: { account, code: 'ok' } });
  return {
    ownerId, service,
    put: (id, token) => world.put(account, id, { name: `${id}.md`, content: text(token) }),
    sync: async () => { await OB.ensureOwnerLoaded(ownerId); return service.sync({ userId: uid, connectionId: conn.connectionId, mode: 'full' }); },
  };
}
const claimRow = async owner => (await V.vectorsPartitionBinding().readCommitted(CS.canonicalClaimNamespace(owner), { ownerId: owner })) ?? {};
const externalFacts = owner => E.listFacts(owner, { limit: 500 }).filter(f => E.isExternalFactOf(owner, f));
/** Let the gated claim embeddings finish (they are detached work of the sync), then flush. */
async function finishLateWork(owner) {
  gate.open();
  await sleep(150);                       // the detached promises resume and upsert
  await OB.flushOwnerStrict(owner).catch(() => {});
  await sleep(50);
}

describe('Safety Fix 3 · real fire-and-forget claim-vector indexing', () => {
  test('control: a claim embedding that finishes after the sync ENDED lands while nobody acquired since', async () => {
    const s = await connectedSource();
    s.put('r1', 'Ashgrove');
    gate = newGate();
    const r = await s.sync();
    assert.equal(r.lastSync.state, 'succeeded', JSON.stringify(r.lastSync));
    assert.equal(Object.keys(await claimRow(s.ownerId)).length, 0, 'precondition: the claim vectors were still being embedded at the end of the sync');
    await finishLateWork(s.ownerId);
    const stored = await claimRow(s.ownerId);
    const ext = externalFacts(s.ownerId).map(f => String(f.id));
    assert.ok(ext.length >= 1);
    assert.ok(ext.every(id => stored[id]), `the late claim vectors of a valid ended sync did not land: ${JSON.stringify(Object.keys(stored))}`);
    assert.ok(ext.every(id => stored[id].meta?.external === true), 'claim vectors of external facts are marked external');
  });

  test('…REFUSED after another holder acquired (and released): the old token no longer names the lease row', async () => {
    const s = await connectedSource();
    s.put('r1', 'Birchmead');
    gate = newGate();
    await s.sync();
    const b = L.createOwnerLease(s.ownerId, { pool: mem.pool, ttlMs: 5000 });   // another instance: acquire, (delete), release
    await b.acquire({ waitMs: 0 });
    await b.release();
    await finishLateWork(s.ownerId);
    assert.deepEqual(Object.keys(await claimRow(s.ownerId)), [], 'a superseded sync\'s late claim vectors landed');
  });

  test('…REFUSED when a NEW operation of the same owner runs in THIS process (its fence never authorises old work)', async () => {
    const s = await connectedSource();
    s.put('r1', 'Cinderford');
    gate = newGate();
    await s.sync();
    await L.withConnectLease(s.ownerId, async () => { await finishLateWork(s.ownerId); }, { pool: mem.pool, ttlMs: 5000 });
    assert.deepEqual(Object.keys(await claimRow(s.ownerId)), [], 'old work was authorised by the newer operation\'s fence');
  });

  test('…REFUSED when the sync LOST its fence while the embedding ran', async () => {
    const s = await connectedSource({ ttlMs: 1000, renewEveryMs: 0 });
    s.put('r1', 'Dovecote');
    gate = newGate();
    const lease = L.createOwnerLease(s.ownerId, { pool: mem.pool, ttlMs: 5000 });
    // The sync runs past its 1 s lease (a slow connector would do the same); another instance takes over.
    const syncP = s.sync().catch(e => e);
    await sleep(1300);
    await lease.acquire({ waitMs: 5000 });
    await syncP;
    await finishLateWork(s.ownerId);
    assert.deepEqual(Object.keys(await claimRow(s.ownerId)), [], 'work of a lost operation landed');
    await lease.release();
  });
});

describe('Safety Fix 3 · plain (non-operation) writes cannot add or update external items', () => {
  test('a plain chat-time backfill adds no external claim vector; a non-external vector of the same namespace lands', async () => {
    const s = await connectedSource();
    s.put('r1', 'Eastholme');
    gate = newGate();
    await s.sync();
    const b = L.createOwnerLease(s.ownerId, { pool: mem.pool, ttlMs: 5000 });
    await b.acquire({ waitMs: 0 }); await b.release();          // the sync's own late work is now refused
    await finishLateWork(s.ownerId);
    gate = null;
    // A plain process (chat retrieval) reconciles the claim index and also indexes a conversation fact.
    const facts = [...E.listFacts(s.ownerId, { limit: 500 }), { id: 'conv-fact-1', statement: 'Mira prefers tea.', evidence: [] }];
    // As chat runs it: inside the 'user' data-class scope (G1-2 egress guard), outside any connect operation.
    const { runWithDataClass } = await import('../../core/egressGuard.js');
    await runWithDataClass('user', () => CS.indexCanonicalClaims(s.ownerId, facts, { isExternal: f => E.isExternalFactOf(s.ownerId, f) }));
    await OB.flushOwnerStrict(s.ownerId);
    const stored = await claimRow(s.ownerId);
    assert.deepEqual(Object.keys(stored), ['conv-fact-1'], 'a plain process added an external claim vector (or lost the plain one)');
  });

  test('PIC: a plain consolidation cannot add a FACT subject or signal of an external fact; those of other facts merge as before', async () => {
    const s = await connectedSource();
    s.put('r1', 'Glimmerdale');
    await s.sync();
    await OB.ensureOwnerLoaded(s.ownerId);
    const ext = externalFacts(s.ownerId)[0];
    assert.ok(ext, 'precondition: an external fact');
    const EM = await import('../../core/storage/entryMerge.js');
    const P = await import('../../pic/picStore.js');
    const schema = P.picPartitionBinding().mergeSchema;
    const rec = { state: 'verified', updatedAt: Date.now(), transitions: [{ to: 'verified', at: Date.now() }] };
    const empty = { lifecycle: {}, versions: {}, signals: {}, sessions: [], ledger: [] };
    const ours = { ...structuredClone(empty), lifecycle: { [`fact:${ext.id}`]: rec, 'fact:conv-1': rec }, signals: { [ext.id]: { ok: 1, lastAt: 1 }, 'conv-1': { ok: 1, lastAt: 1 } } };
    const m = EM.mergeEntry(ours, empty, structuredClone(empty), schema, { allowExternalWrites: false, key: s.ownerId });
    assert.deepEqual(Object.keys(m.lifecycle), ['fact:conv-1'], 'a plain process added a PIC subject of an external fact');
    assert.deepEqual(Object.keys(m.signals), ['conv-1']);
    const fenced = EM.mergeEntry(ours, empty, structuredClone(empty), schema, { allowExternalWrites: true, key: s.ownerId });
    assert.equal(Object.keys(fenced.lifecycle).length, 2, 'a fenced operation could not add them');
  });

  test('a plain update of an external fact is frozen to the database\'s version; a plain update of an upload fact lands', async () => {
    const s = await connectedSource();
    s.put('r1', 'Foxhollow');
    await s.sync();
    await OB.ensureOwnerLoaded(s.ownerId);
    const ext = externalFacts(s.ownerId)[0];
    assert.ok(ext, 'precondition: an external fact');
    // An upload fact (non-external) written by a plain process first.
    E.saveFact(s.ownerId, { id: 'up-fact-1', statement: 'The kitchen is 4 m wide.', evidence: [], createdAt: Date.now() }, { sourceFileId: 'up_kitchen' });
    await OB.flushOwnerStrict(s.ownerId);
    // Plain updates (propagation / consolidation style).
    E.updateFact(s.ownerId, ext.id, { review: { text: 'plain review', at: Date.now() } });
    E.updateFact(s.ownerId, 'up-fact-1', { review: { text: 'plain review', at: Date.now() } });
    await OB.flushOwnerStrict(s.ownerId);
    const row = await E.evidencePartitionBinding().readCommitted(s.ownerId, { ownerId: s.ownerId });
    assert.equal(row.facts[ext.id].review, undefined, 'a plain process updated an external fact');
    assert.deepEqual(row.facts['up-fact-1'].review?.text, 'plain review', 'a plain non-external update was lost');
  });
});
