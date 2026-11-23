/**
 * Safety Fix 2 — deleting an external source wins over concurrent edits, and a
 * disconnect reports complete only when the DATABASE holds nothing under the
 * source's prefix.
 *
 *   A. merge semantics on the REAL store schemas (entryMerge): external deletion
 *      beats an edit (both directions); an external addition needs a valid
 *      connect fence; non-external items keep the old rules.
 *   B. reasoning-graph merge (two-way, no base) — the same rules for external files.
 *   C. real stores in `on` mode on pg-mem, the REAL connect service (fenced sync)
 *      and the REAL disconnect: a concurrent edit committed by "another instance"
 *      before the deletion is removed via commit (version conflict → re-applied);
 *      unfenced additions are refused; completeness is read from the database;
 *      other sources and owners are untouched.
 * The two-process race is covered on real PostgreSQL (externalDeletionWins.live.test.js).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-xdw-'));
for (const k of Object.keys(process.env)) if (/(_API_KEY|^GEMINI|^GOOGLE)/.test(k)) delete process.env[k];
process.env.AQUA_STORE_PARTITIONS = 'reflection:on,mind:on,reasoning-graph:on,evidence:on,fileindex:on,uko:on,pic:on,vectors:on';
process.env.DATABASE_URL = 'postgresql://u:p@localhost:1/none';   // never dialled: the pool is replaced
process.env.MONGO_URI = '';
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';

let mem, poolMod, EM, OB, WF, L, X, U, E, FI, V, P, G, MS, ident, prov, repoOf;

before(async () => {
  poolMod = await import('../../core/db/pool.js');
  poolMod._resetForTests();
  const { createMemoryPg } = await import('../../core/tests/helpers/memoryPg.mjs');
  mem = createMemoryPg();
  poolMod._setPoolForTests(mem.pool);
  await (await import('../../core/db/migrate.js')).migrate();
  for (const ix of ['aqua_jobs_ready_ix', 'aqua_jobs_running_owner_ix', 'aqua_jobs_dead_ix', 'aqua_jobs_running_heartbeat_ix']) {
    await mem.pool.query(`DROP INDEX IF EXISTS ${ix}`);   // pg-mem partial-index artefact
  }
  await (await import('../../core/storage/index.js')).configurePartitionBindings();
  EM = await import('../../core/storage/entryMerge.js');
  OB = await import('../../core/storage/ownerBinding.js');
  WF = await import('../../core/storage/writeFence.js');
  L = await import('../../connect/ownerLease.js');
  X = await import('../externalSources.js');
  U = await import('../ukoStore.js');
  E = await import('../evidenceStore.js');
  FI = await import('../fileSearchIndex.js');
  V = await import('../../embeddings/vectorStore.js');
  P = await import('../../pic/picStore.js');
  G = await import('../../reasoning/reasoningGraph.js');
  MS = await import('../../mind/mindStore.js');
  ident = await import('../externalIdentity.js');
  prov = await import('../../embeddings/embeddingProvider.js');
  prov.__setEmbedderForTests(async texts => texts.map(() => [1, 0, 0]));
  repoOf = OB.partitionRepositoryForBindings;
});
after(async () => {
  prov?.__clearEmbedderForTests?.();
  poolMod?._resetForTests();
  await mem?.close();
  delete process.env.DATABASE_URL;
});

// ── A. merge semantics on the real store schemas ────────────────────────────
describe('A · entryMerge — external deletion wins; external additions need a connect fence', () => {
  const uko = id => ({ id, owner: 'user:m', sourceFile: { name: `${id}.md`, hash: id }, provenance: { uploadedAt: 1000 } });
  const schema = () => U.ukoPartitionBinding().mergeSchema;

  test('edit vs external deletion — the deletion wins in BOTH directions', () => {
    const X1 = 'ext_s_i_v', base = { [X1]: uko(X1) };
    const edited = { [X1]: { ...uko(X1), title: 'edited elsewhere', provenance: { uploadedAt: 2000 } } };
    // theirs deleted it (the disconnect committed), ours edited it (a stale instance)
    assert.deepEqual(EM.mergeEntry(edited, {}, base, schema(), { allowExternalAdditions: false }), {});
    assert.deepEqual(EM.mergeEntry(edited, {}, base, schema(), { allowExternalAdditions: true }), {}, 'a fence does not let an edit beat a deletion');
    // ours deleted it, theirs edited it
    assert.deepEqual(EM.mergeEntry({}, edited, base, schema()), {});
  });

  test('non-external items keep the old rule: an edit beats a deletion', () => {
    const up = 'up_1', base = { [up]: uko(up) };
    const edited = { [up]: { ...uko(up), title: 'edited', provenance: { uploadedAt: 2000 } } };
    assert.deepEqual(Object.keys(EM.mergeEntry(edited, {}, base, schema(), { allowExternalAdditions: false })), [up]);
    assert.deepEqual(Object.keys(EM.mergeEntry({}, edited, base, schema())), [up]);
  });

  test('an external ADDITION (not in the base, only ours) is refused without a fence, kept with one', () => {
    const X2 = 'ext_s_j_v', theirs = { up_1: uko('up_1') }, base = { up_1: uko('up_1') };
    const ours = { up_1: uko('up_1'), [X2]: uko(X2), up_2: uko('up_2') };
    assert.deepEqual(Object.keys(EM.mergeEntry(ours, theirs, base, schema(), { allowExternalAdditions: false })).sort(), ['up_1', 'up_2']);
    assert.deepEqual(Object.keys(EM.mergeEntry(ours, theirs, base, schema(), { allowExternalAdditions: true })).sort(), [X2, 'up_1', 'up_2'].sort());
    // without a base at all (never loaded here) the same: an unfenced addition is refused
    assert.deepEqual(Object.keys(EM.mergeEntry(ours, theirs, undefined, schema(), { allowExternalAdditions: false })).sort(), ['up_1', 'up_2']);
    // an external item that is ALREADY in the database is not an addition
    assert.deepEqual(Object.keys(EM.mergeEntry({}, { [X2]: uko(X2) }, undefined, schema(), { allowExternalAdditions: false })), [X2]);
  });

  test('evidence: an external fact archived elsewhere is deleted; byFile/evidence links follow; upload facts unaffected', () => {
    const s = E.evidencePartitionBinding().mergeSchema;
    const ev = (id, file) => ({ id, sourceFileId: file, checksum: id, createdAt: 1 });
    const base = {
      evidence: { e1: ev('e1', 'ext_s_i_v'), e2: ev('e2', 'up_9') },
      facts: { f1: { id: 'f1', evidence: ['e1'], statement: 'ext fact', createdAt: 1 }, f2: { id: 'f2', evidence: ['e2'], statement: 'upload fact', createdAt: 1 } },
      byFile: { ext_s_i_v: { facts: ['f1'], evidence: ['e1'] }, up_9: { facts: ['f2'], evidence: ['e2'] } },
      evidenceRefs: { e1: ['f1'], e2: ['f2'] },
    };
    const theirs = { evidence: { e2: base.evidence.e2 }, facts: { f2: base.facts.f2 }, byFile: { up_9: base.byFile.up_9 }, evidenceRefs: { e2: ['f2'] } };   // the disconnect
    const ours = structuredClone(base);
    ours.facts.f1 = { ...ours.facts.f1, archived: true, updatedAt: 5 };      // consolidation elsewhere, after its base
    ours.facts.f2 = { ...ours.facts.f2, review: { at: 5 }, updatedAt: 5 };
    const m = EM.mergeEntry(ours, theirs, base, s, { allowExternalAdditions: false });
    assert.deepEqual(Object.keys(m.facts), ['f2']);
    assert.deepEqual(Object.keys(m.evidence), ['e2']);
    assert.deepEqual(Object.keys(m.byFile), ['up_9']);
    assert.deepEqual(m.facts.f2.review, { at: 5 }, 'the upload fact edit is kept');
  });

  test('PIC: an external subject re-touched elsewhere stays deleted; fact subjects keep the old rule', () => {
    const s = P.picPartitionBinding().mergeSchema;
    const rec = at => ({ state: 'linked', updatedAt: at, transitions: [{ to: 'linked', at }] });
    const base = { lifecycle: { 'uko:ext_s_i_v': rec(1), 'uko:up_1': rec(1) }, versions: {}, signals: {}, sessions: [], ledger: [] };
    const theirs = { lifecycle: {}, versions: {}, signals: {}, sessions: [], ledger: [] };
    const ours = { ...structuredClone(base), lifecycle: { 'uko:ext_s_i_v': rec(5), 'uko:up_1': rec(5) } };
    const m = EM.mergeEntry(ours, theirs, base, s, { allowExternalAdditions: false });
    assert.deepEqual(Object.keys(m.lifecycle), ['uko:up_1']);
  });

  test('vectors: every chunk of the external-files namespace and marked claim vectors are external; others are not', () => {
    const s = V.vectorsPartitionBinding().mergeSchema;
    const r = (ts, meta = null) => ({ vec: [1], hash: 'h', ts, model: 'm', ...(meta ? { meta } : {}) });
    const theirs = {}, base = {};
    assert.deepEqual(EM.mergeEntry({ 'ext:s:i:v#0': r(1) }, theirs, base, s, { allowExternalAdditions: false, key: 'xfiles:user:m' }), {});
    assert.deepEqual(Object.keys(EM.mergeEntry({ f1: r(1, { kind: 'claim', external: true }), f2: r(1, { kind: 'claim' }) }, theirs, base, s, { allowExternalAdditions: false, key: 'claims:user:m' })), ['f2']);
  });
});

// ── B. graph merge ──────────────────────────────────────────────────────────
describe('B · reasoning-graph merge — external files', () => {
  const g = (files, removed = null) => {
    const nodes = {}, byFile = {};
    for (const [f, ids, at] of files) { byFile[f] = { nodes: ids, edges: [], ...(at ? { at } : {}) }; for (const id of ids) nodes[id] = { id, type: 'entity', sourceFiles: [f] }; }
    return { nodes, edges: {}, byFile, ...(removed ? { removedFiles: removed } : {}) };
  };
  test('unfenced: an external file link the database does not hold is not written; with a fence it is', () => {
    const ours = g([['up_1', ['n1']], ['ext_s_i_v', ['n2']]]), theirs = g([['up_1', ['n1']]]);
    const m = G.mergeGraphs(ours, theirs, { allowExternalAdditions: false });
    assert.deepEqual(Object.keys(m.byFile), ['up_1']);
    assert.equal(m.nodes.n2, undefined);
    assert.deepEqual(Object.keys(G.mergeGraphs(ours, theirs, { allowExternalAdditions: true }).byFile).sort(), ['ext_s_i_v', 'up_1']);
  });
  test('unfenced: a REMOVED external file is never re-linked, whatever the link time; a non-external file keeps the time rule', () => {
    const theirs = g([], { ext_s_i_v: 100, up_2: 100 });
    const ours = g([['ext_s_i_v', ['n2'], 999], ['up_2', ['n3'], 999]]);
    const m = G.mergeGraphs(ours, theirs, { allowExternalAdditions: false });
    assert.deepEqual(Object.keys(m.byFile), ['up_2']);
    assert.ok(m.nodes.n3 && !m.nodes.n2);
  });
  test('without ctx the merge is exactly as before', () => {
    const theirs = g([], { ext_s_i_v: 100 });
    const ours = g([['ext_s_i_v', ['n2'], 999]]);
    assert.deepEqual(Object.keys(G.mergeGraphs(ours, theirs).byFile), ['ext_s_i_v']);
  });
});

// ── C. real stores on pg-mem, real connect service, real disconnect ─────────
// A digit per sentence: the heuristic fact extractor (files/extractors.js) needs one.
const text = token => `The ${token} launch is planned for June 12. Lena Hart owns the ${token} service and its 3 budgets.`;
let userN = 0;
// One connection store per OWNER (as in production): every source of an owner shares it — the
// connection fencing epoch chain (Safety Fix 4) lives in that store.
const storesByOwner = new Map();
async function connectedSource(connectorId = 'fake', { userId = null } = {}) {
  const { createConnectorRegistry } = await import('../../connect/registry.js');
  const { createMemoryConnectionStore } = await import('../../connect/connectionStore.js');
  const { createCredentialVault } = await import('../../connect/credentialVault.js');
  const { createConnectService } = await import('../../connect/connectService.js');
  const { createFakeWorld, createFakeConnector } = await import('../../connect/testing/fakeConnector.js');
  const world = createFakeWorld();
  const registry = createConnectorRegistry({ allowTestOnly: true });
  registry.register(createFakeConnector({ world, id: connectorId }));
  const ownerOfThis = `user:${userId ?? `u-xdw-${process.pid}-${userN + 1}`}`;
  if (!storesByOwner.has(ownerOfThis)) storesByOwner.set(ownerOfThis, createMemoryConnectionStore());
  const service = createConnectService({ registry, store: storesByOwner.get(ownerOfThis), vault: createCredentialVault({ key: crypto.randomBytes(32) }),
    retry: { sleep: async () => {}, baseMs: 0 }, log: { log() {}, warn() {} }, trustRawUserId: true, singleInstance: true, lease: { ttlMs: 10_000 } });
  const uid = userId ?? `u-xdw-${process.pid}-${++userN}`;
  const ownerId = `user:${uid}`;
  const account = `acct-${uid}-${connectorId}`;
  await OB.ensureOwnerLoaded(ownerId);
  const conn = await service.connect({ userId: uid, connectorId, input: { account, code: 'ok' } });
  const sourceId = `${connectorId}:${conn.connectionId}`;
  return {
    ownerId, sourceId, service, conn, prefix: ident.sourcePrefixes(sourceId).ukoPrefix, keyPrefix: ident.sourcePrefixes(sourceId).keyPrefix,
    put: (id, token) => world.put(account, id, { name: `${id}.md`, content: text(token) }),
    sync: async () => { await OB.ensureOwnerLoaded(ownerId); return service.sync({ userId: uid, connectionId: conn.connectionId, mode: 'full' }); },
    disconnect: async () => { await OB.ensureOwnerLoaded(ownerId); return service.disconnect({ userId: uid, connectionId: conn.connectionId }); },
  };
}
const row = async (storeKey, owner) => (await mem.pool.query(`SELECT data FROM aqua_store_partitions WHERE store_key = $1 AND owner_id = $2 AND deleted_at IS NULL AND partition_key NOT LIKE 'xfiles:%' AND partition_key NOT LIKE 'claims:%'`, [storeKey, owner])).rows.map(r => JSON.parse(r.data));
const dbHolds = async (owner, prefix, keyPrefix) => {
  const m = { ukoPrefix: prefix, keyPrefix };
  return X.remainingInDatabase(owner, m, []);
};
const sum = r => Object.values(r ?? { x: NaN }).reduce((a, b) => a + b, 0);
/**
 * Run `fn` while "another instance" commits `mutate` to this owner's row of
 * `storeKey` — right BEFORE this process's first write to that row (so that
 * write's version check fails and the deletion must be re-applied to the newer
 * row). A raw versioned write, invisible to this process's cache.
 */
async function withConcurrentCommit(owner, storeKey, mutate, fn) {
  let done = false;
  const real = mem.pool;
  const connect = real.connect.bind(real);
  poolMod._setPoolForTests({
    query: (q, p) => real.query(q, p),
    connect: async () => {
      const c = await connect();
      return { release: () => c.release(), query: async (q, p) => {
        if (!done && /^\s*UPDATE aqua_store_partitions/.test(String(q)) && p?.[0] === storeKey) {
          done = true;
          const { rows } = await real.query('SELECT partition_key, data FROM aqua_store_partitions WHERE store_key = $1 AND owner_id = $2 AND deleted_at IS NULL', [storeKey, owner]);
          await real.query('UPDATE aqua_store_partitions SET data = $1, version = version + 1 WHERE store_key = $2 AND partition_key = $3',
            [JSON.stringify(mutate(JSON.parse(rows[0].data))), storeKey, rows[0].partition_key]);
        }
        return c.query(q, p);
      } };
    },
  });
  try { return { result: await fn(), injected: () => done }; } finally { poolMod._setPoolForTests(real); }
}

describe('C · real stores (on) on pg-mem — fenced sync, disconnect, database verification', () => {
  test('a sync writes external items to every store (precondition)', async () => {
    const s = await connectedSource();
    s.put('r1', 'Aldermoor'); s.put('r2', 'Brindlewick');
    const r = await s.sync();
    assert.equal(r.lastSync.state, 'succeeded', JSON.stringify(r.lastSync));
    const held = await dbHolds(s.ownerId, s.prefix, s.keyPrefix);
    assert.ok(held.ukos >= 2 && held.facts >= 2 && held.fileLinks >= 2 && held.indexed >= 2, JSON.stringify(held));
  });

  test('edit committed by another instance BEFORE the disconnect: the deletion is re-applied to the newer row (forced version conflict); nothing remains; complete matches the database', async () => {
    const s = await connectedSource();
    s.put('r1', 'Cobbleford'); s.put('r2', 'Dunmarsh');
    await s.sync();
    const conflictsBefore = repoOf().stats().conflicts;
    // Another instance archives/reviews the external facts (propagation / consolidation)
    // and COMMITS just before this process's first write of the evidence row during
    // the disconnect: that write's version check fails → reload → re-apply.
    let edited = false;
    const real = mem.pool;
    const connect = real.connect.bind(real);
    poolMod._setPoolForTests({
      query: (q, p) => real.query(q, p),
      connect: async () => {
        const c = await connect();
        return { release: () => c.release(), query: async (q, p) => {
          if (!edited && /^\s*UPDATE aqua_store_partitions/.test(String(q)) && p?.[0] === '.aqua-evidence.json') {
            edited = true;
            const { rows } = await real.query(`SELECT partition_key, data FROM aqua_store_partitions WHERE store_key = '.aqua-evidence.json' AND owner_id = $1`, [s.ownerId]);
            const ev = JSON.parse(rows[0].data);
            for (const f of Object.values(ev.facts)) { f.review = { text: 'elsewhere', at: Date.now() }; f.updatedAt = Date.now(); }
            await real.query(`UPDATE aqua_store_partitions SET data = $1, version = version + 1 WHERE store_key = '.aqua-evidence.json' AND partition_key = $2`, [JSON.stringify(ev), rows[0].partition_key]);
          }
          return c.query(q, p);
        } };
      },
    });
    let d;
    try { d = await s.disconnect(); } finally { poolMod._setPoolForTests(real); }
    assert.equal(edited, true, 'precondition: the concurrent edit was committed during the disconnect');
    assert.equal(d.deleted, true, JSON.stringify(d));
    assert.ok(repoOf().stats().conflicts > conflictsBefore, 'the stale base did not produce a version conflict — the re-apply path was not exercised');
    const held = await dbHolds(s.ownerId, s.prefix, s.keyPrefix);
    assert.equal(sum(held), 0, `external items remain in the database: ${JSON.stringify(held)}`);
    const evRows = await row('.aqua-evidence.json', s.ownerId);
    assert.ok(evRows.every(ev => Object.values(ev.facts ?? {}).every(f => f.review?.text !== 'elsewhere')), 'the concurrent edit survived the deletion');
  });

  test('an external item ADDED by another instance after this process loaded the owner is removed too (commit prunes the latest row)', async () => {
    const s = await connectedSource();
    s.put('r1', 'Eastwold');
    await s.sync();
    const stray = `${s.prefix}strayitem_v1`;
    const conflictsBefore = repoOf().stats().conflicts;
    // Committed during the disconnect, after this process loaded the owner: never in its memory.
    const { result: d, injected } = await withConcurrentCommit(s.ownerId, '.aqua-uko.json',
      o => ({ ...o, [stray]: { id: stray, owner: s.ownerId, sourceFile: { name: 'x', hash: 'x' }, provenance: { uploadedAt: Date.now() } } }),
      () => s.disconnect());
    assert.equal(injected(), true);
    assert.ok(repoOf().stats().conflicts > conflictsBefore, 'no version conflict: the re-apply path was not exercised');
    assert.equal(d.deleted, true, JSON.stringify(d));
    assert.equal(sum(await dbHolds(s.ownerId, s.prefix, s.keyPrefix)), 0);
    assert.ok(!(await row('.aqua-uko.json', s.ownerId)).some(r => r[stray]), 'the item another instance added under the prefix survived');
  });

  test('external evidence and a fact ADDED by another instance during the disconnect (never in this process) are removed by the commit', async () => {
    const s = await connectedSource();
    s.put('r1', 'Lowerbury');
    await s.sync();
    await OB.ensureOwnerLoaded(s.ownerId);
    const file = U.listUKOs(s.ownerId, { limit: 50, includeRestricted: true }).find(u => u.id.startsWith(s.prefix)).id;
    const { result: d, injected } = await withConcurrentCommit(s.ownerId, '.aqua-evidence.json', ev => {
      ev.evidence.eStray = { id: 'eStray', sourceFileId: file, checksum: 'stray', createdAt: Date.now() };
      ev.facts.fStray = { id: 'fStray', evidence: ['eStray'], statement: 'stray external fact 7', createdAt: Date.now() };
      ev.byFile[file] = { facts: [...(ev.byFile[file]?.facts ?? []), 'fStray'], evidence: [...(ev.byFile[file]?.evidence ?? []), 'eStray'] };
      ev.evidenceRefs.eStray = ['fStray'];
      return ev;
    }, () => s.disconnect());
    assert.equal(injected(), true);
    assert.equal(d.deleted, true, JSON.stringify(d));
    const [ev] = await row('.aqua-evidence.json', s.ownerId);
    assert.equal(ev?.facts?.fStray, undefined, 'a fact another instance added under the deleted source survived');
    assert.equal(ev?.evidence?.eStray, undefined);
    assert.equal(sum(await dbHolds(s.ownerId, s.prefix, s.keyPrefix)), 0);
  });

  test('completeness comes from the DATABASE: a matching item written after the deletion\'s commits makes the disconnect report incomplete', async () => {
    const s = await connectedSource();
    s.put('r1', 'Fallowmere');
    await s.sync();
    // A raw writer (bypassing every merge rule) re-inserts an external UKO while the
    // disconnect is between its commits and its verification (at the canonical step).
    const stray = `${s.prefix}late_v1`;
    let injected = false;
    const real = mem.pool;
    const connect = real.connect.bind(real);
    poolMod._setPoolForTests({
      query: (q, p) => real.query(q, p),
      connect: async () => {
        const c = await connect();
        return { release: () => c.release(), query: async (q, p) => {
          if (!injected && /aqua_external_deletions/.test(String(q)) && /INSERT/i.test(String(q))) {
            injected = true;
            const { rows } = await real.query(`SELECT partition_key, data, version FROM aqua_store_partitions WHERE store_key = '.aqua-uko.json' AND owner_id = $1`, [s.ownerId]);
            const o = JSON.parse(rows[0].data ?? '{}'); o[stray] = { id: stray, owner: s.ownerId, provenance: { uploadedAt: Date.now() } };
            await real.query(`UPDATE aqua_store_partitions SET data = $1, version = version + 1 WHERE store_key = '.aqua-uko.json' AND partition_key = $2`, [JSON.stringify(o), rows[0].partition_key]);
          }
          return c.query(q, p);
        } };
      },
    });
    let d;
    try { d = await s.disconnect(); } finally { poolMod._setPoolForTests(real); }
    assert.equal(injected, true, 'precondition: the late write was injected');
    assert.equal(d.deleted, false, `a disconnect reported complete while the database held an external item: ${JSON.stringify(d)}`);
    assert.equal(d.remaining?.ukos, 1, JSON.stringify(d.remaining));
    assert.equal(X.remainingUnder(s.ownerId, { ukoPrefix: s.prefix, keyPrefix: s.keyPrefix }).ukos, 0, 'precondition: this process\'s memory says nothing remains');
  });

  test('an external addition WITHOUT a connect fence is refused at the flush; WITH one it lands', async () => {
    const s = await connectedSource();
    s.put('r1', 'Glenhallow');
    await s.sync();
    await OB.ensureOwnerLoaded(s.ownerId);
    const template = U.listUKOs(s.ownerId, { limit: 50, includeRestricted: true }).find(u => u.id.startsWith(s.prefix));
    WF._resetWriteFencesForTests();                         // no trailing fence: a plain, unfenced process
    const unfenced = `${template.id.slice(0, template.id.lastIndexOf('_'))}_unfenced`;
    U.saveUKO({ ...structuredClone(template), id: unfenced });
    await OB.flushOwnerStrict(s.ownerId);
    const ids = () => row('.aqua-uko.json', s.ownerId).then(rs => rs.flatMap(r => Object.keys(r)));
    assert.ok(!(await ids()).includes(unfenced), 'an unfenced process added an external item');
    const fenced = `${template.id.slice(0, template.id.lastIndexOf('_'))}_fenced`;
    await L.withConnectLease(s.ownerId, async () => { U.saveUKO({ ...structuredClone(template), id: fenced }); });
    assert.ok((await ids()).includes(fenced), 'a fenced connect operation could not add an external item');
  });

  test('mind (owner binding): an unfenced process cannot write a deleted external file entry back; a non-external entry is kept', async () => {
    const s = await connectedSource();
    s.put('r1', 'Kingsmead');
    await s.sync();
    await OB.ensureOwnerLoaded(s.ownerId);
    const mind = MS.getMind(s.ownerId);
    const extKey = Object.keys(mind.files ?? {}).find(k => k.startsWith(s.keyPrefix));
    assert.ok(extKey, 'precondition: the sync remembered the external file');
    const stale = structuredClone(mind.files[extKey]);
    const d = await s.disconnect();
    assert.equal(d.deleted, true, JSON.stringify(d));
    WF._resetWriteFencesForTests();                         // a plain process, no connect fence
    const m2 = MS.getMind(s.ownerId);
    m2.files[extKey] = { ...stale, lastReferencedAt: Date.now() + 5_000 };   // a stale copy, re-touched later
    m2.files['upload:keep.md'] = { key: 'upload:keep.md', name: 'keep.md', uploadedAt: Date.now(), lastReferencedAt: Date.now() };   // (mind items need a time)
    MS.touchMind(m2);
    await OB.flushOwnerStrict(s.ownerId);
    const stored = await MS.mindPartitionBinding().readCommitted(s.ownerId);
    assert.equal(stored.files?.[extKey], undefined, 'the deleted external file entry was written back');
    assert.ok(stored.files?.['upload:keep.md'], 'a non-external entry was lost');
  });

  test('prune (pure): evidence removal mirrors removeFile and also takes facts that lost their file link', async () => {
    const { pruneEvidence } = await import('../externalPrune.js');
    const entry = {
      evidence: { e1: { id: 'e1', sourceFileId: 'ext_s_i_v' }, e2: { id: 'e2', sourceFileId: 'up_1' }, e3: { id: 'e3', sourceFileId: 'ext_s_i_v' } },
      facts: { f1: { id: 'f1', evidence: ['e1'] }, f2: { id: 'f2', evidence: ['e2'] }, f3: { id: 'f3', evidence: ['e3'] } },
      byFile: { ext_s_i_v: { facts: ['f1'], evidence: ['e1'] }, up_1: { facts: ['f2'], evidence: ['e2'] } },
      evidenceRefs: { e1: ['f1'], e2: ['f2'], e3: ['f3'] },
    };
    const r = pruneEvidence(entry, { ukoPrefix: 'ext_s_' });
    assert.deepEqual(Object.keys(r.entry.facts), ['f2']);
    assert.deepEqual(Object.keys(r.entry.evidence), ['e2']);
    assert.deepEqual(Object.keys(r.entry.byFile), ['up_1']);
    assert.deepEqual(r.factIds.sort(), ['f1', 'f3']);
    assert.ok(entry.facts.f1, 'the input entry was mutated');
    assert.equal(pruneEvidence(r.entry, { ukoPrefix: 'ext_s_' }).removed, 0, 'not idempotent');
    // A swept fact written back WITHOUT its links (dangling evidence) is still attributed by id.
    const dangling = { ...structuredClone(r.entry), facts: { ...r.entry.facts, f1: { id: 'f1', evidence: ['e1'] } } };
    assert.equal(pruneEvidence(dangling, { ukoPrefix: 'ext_s_' }).facts, 0, 'precondition: not attributable by links');
    const k = pruneEvidence(dangling, { ukoPrefix: 'ext_s_' }, ['f1']);
    assert.equal(k.facts, 1);
    assert.deepEqual(Object.keys(k.entry.facts), ['f2']);
  });

  test('other sources and other owners are unaffected', async () => {
    const a = await connectedSource('fake');
    const b = await connectedSource('fake2', { userId: a.ownerId.slice(5) });   // same owner, second source
    const other = await connectedSource('fake');                                  // another owner
    a.put('r1', 'Hartmoor'); b.put('r1', 'Ivybridge'); other.put('r1', 'Juniperton');
    await a.sync(); await b.sync(); await other.sync();
    const before = { b: await dbHolds(b.ownerId, b.prefix, b.keyPrefix), other: await dbHolds(other.ownerId, other.prefix, other.keyPrefix) };
    const d = await a.disconnect();
    assert.equal(d.deleted, true, JSON.stringify(d));
    assert.equal(sum(await dbHolds(a.ownerId, a.prefix, a.keyPrefix)), 0);
    assert.deepEqual(await dbHolds(b.ownerId, b.prefix, b.keyPrefix), before.b, 'the other source of the same owner changed');
    assert.deepEqual(await dbHolds(other.ownerId, other.prefix, other.keyPrefix), before.other, 'another owner changed');
    assert.ok(sum(before.b) > 0 && sum(before.other) > 0);
  });
});
