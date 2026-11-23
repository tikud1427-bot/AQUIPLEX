/**
 * D-1 — the PRODUCTION sync path observes the source and carries `observedAt`
 * to the understanding enqueue:
 *
 *   connectService.sync → syncEngine.runSync (observeSource BEFORE discovery)
 *     → externalSources.syncExternalResources({ observedAt }) → ingestFiles
 *     → enqueueDocumentUnderstanding (lock + tombstone vs observedAt; D-2 keys)
 *   removals → deleteExternalResource → forgetExternalSourceClaims (lock + tombstone)
 *
 * Real migrated schema (pg-mem), REAL job queue, REAL deletion, fake connector.
 * External-source understanding is OFF in production; this suite turns on the
 * test-only switch (externalSources.__setExternalUnderstandingForTests) so the
 * real enqueue runs. pg-mem stubs advisory locks: two real connections racing
 * are covered by the live suite (sourceDeletion.live.test.js L8/L9).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const K = await import('./testkit.js');           // isolated data dir, offline embedder, env stripped
process.env.DATABASE_URL = 'postgresql://u:p@localhost:1/none';   // never dialled: the pool is replaced below
process.env.AQUA_E6 = 'on';                        // enqueue's own gate (understanding pipeline flags)

let mem, poolMod, X, SD, ident, prov;
const embedded = [];
let spyEvents = null;                              // when set, records 'observe' (statements) and connector calls

before(async () => {
  poolMod = await import('../../core/db/pool.js');
  poolMod._resetForTests();
  const { createMemoryPg } = await import('../../core/tests/helpers/memoryPg.mjs');
  mem = createMemoryPg();
  poolMod._setPoolForTests(mem.pool);
  await (await import('../../core/db/migrate.js')).migrate();
  for (const ix of ['aqua_jobs_ready_ix', 'aqua_jobs_running_owner_ix', 'aqua_jobs_dead_ix', 'aqua_jobs_running_heartbeat_ix']) {
    await mem.pool.query(`DROP INDEX IF EXISTS ${ix}`);   // pg-mem partial-index artefact (see sourceDeletion.test.js)
  }
  // Record statements on the module pool so the ORDER of observation vs discovery is visible.
  const connect = mem.pool.connect.bind(mem.pool);
  poolMod._setPoolForTests({
    query: (s, p) => mem.pool.query(s, p),
    connect: async () => {
      const c = await connect();
      return { query: (s, p) => { if (spyEvents && /clock_timestamp\(\)\s+AS t/i.test(String(s))) spyEvents.push('observe'); return c.query(s, p); }, release: () => c.release() };
    },
  });
  X = K.external;
  X.__setExternalUnderstandingForTests(true);
  SD = await import('../../core/worldModel/sourceDeletion.js');
  ident = await import('../../files/externalIdentity.js');
  prov = await import('../../embeddings/embeddingProvider.js');
  prov.__setEmbedderForTests(async texts => { embedded.push(...texts); return texts.map(() => [1, 0, 0]); });
});
after(async () => {
  X?.__setExternalUnderstandingForTests(false);
  poolMod?._resetForTests();
  await mem?.close();
  delete process.env.DATABASE_URL;
});

// ── fixtures ────────────────────────────────────────────────────────────────
const noVectors = { removeVector: () => true, canonicalNamespace: () => 'x' };
const text = token => `The ${token} launch is planned for June. Lena owns the ${token} service and its budget.`;

function serviceWith({ world, id = 'fake', wrap = c => c, gmail = false }) {
  const registry = K.createConnectorRegistry({ allowTestOnly: true });
  let connector = K.createFakeConnector({ world, id });
  if (gmail) { const { dataPolicy, ...rest } = connector; connector = rest; }   // Gmail's policy is fixed in code
  registry.register(wrap(connector));
  return K.createConnectService({
    registry, store: K.createMemoryConnectionStore(), vault: K.createCredentialVault({ key: K.TEST_KEY }),
    retry: { sleep: async () => {}, baseMs: 0 }, log: { log() {}, warn() {} }, trustRawUserId: true, singleInstance: true,
  });
}
async function connected(opts) {
  const world = opts.world ?? K.createFakeWorld();
  const service = serviceWith({ ...opts, world });
  const userId = K.freshUser('d1');
  const account = `acct-${userId}`;
  const conn = await service.connect({ userId, connectorId: opts.id ?? 'fake', input: { account, code: 'ok' } });
  const ownerId = K.ownerOf(userId);
  const sourceId = `${opts.id ?? "fake"}:${conn.connectionId}`;   // connectService: sourceId = <connectorId>:<connectionId>
  return {
    world, service, conn, ownerId, account,
    sourceId, prefix: ident.sourcePrefixes(sourceId).ukoPrefix,
    sync: () => service.sync({ userId, connectionId: conn.connectionId, mode: 'full' }),
    put: (externalId, token) => world.put(account, externalId, { name: `${externalId}.md`, content: text(token) }),
  };
}
const jobs = async ownerId => (await mem.pool.query(`SELECT idempotency_key, state, payload FROM aqua_jobs WHERE owner_id = $1 AND kind = 'understanding.document.v1'`, [ownerId])).rows
  .map(r => ({ key: r.idempotency_key, state: r.state, ukoId: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload).ukoId }));
const forItem = (rows, s, externalId) => rows.filter(j => j.ukoId.startsWith(ident.itemPrefixes(s.sourceId, externalId).ukoPrefix));

describe('D-1 · the production sync observes the source and the enqueue honours it', () => {
  test('the source is observed BEFORE discovery; the sync enqueues understanding (generation-0 keys)', async () => {
    const events = [];
    const s = await connected({ wrap: c => ({ ...c, listResources: async (...a) => { events.push('list'); return c.listResources(...a); } }) });
    s.put('r1', 'Aldermoor'); s.put('r2', 'Brindlewick'); s.put('r3', 'Cobbleford');
    spyEvents = events;
    try { await s.sync(); } finally { spyEvents = null; }
    assert.ok(events.includes('observe') && events.includes('list'), JSON.stringify(events));
    assert.ok(events.indexOf('observe') < events.indexOf('list'), `observation must precede discovery: ${events.join(' → ')}`);
    const j = await jobs(s.ownerId);
    assert.equal(new Set(j.map(x => x.ukoId)).size, 3, JSON.stringify(j));
    assert.ok(j.every(x => !/:g\d+$/.test(x.key) && x.state === 'queued'));
    // an unchanged re-sync writes no new job
    await s.sync();
    assert.equal((await jobs(s.ownerId)).length, j.length);
  });

  test('deletion BEFORE observation (resource removed at the source), then re-added: understood again under a :g1 key, once', async () => {
    const s = await connected({});
    s.put('r1', 'Dunmarrow'); s.put('r2', 'Eldwyck'); s.put('r3', 'Fenhollow');
    await s.sync();
    assert.equal(forItem(await jobs(s.ownerId), s, 'r1').length > 0, true);
    s.world.remove(s.account, 'r1');
    const removal = await s.sync();
    assert.equal(removal.lastSync?.counts?.removed ?? 1, 1);
    assert.deepEqual(forItem(await jobs(s.ownerId), s, 'r1'), [], 'the deletion swept the queued job');
    s.put('r1', 'Dunmarrow');                                   // identical content comes back
    await s.sync();
    const back = forItem(await jobs(s.ownerId), s, 'r1');
    assert.ok(back.length > 0, 'a re-added resource was silently skipped');
    assert.ok(back.every(x => x.key.endsWith(':g1') && x.state === 'queued'), JSON.stringify(back));
    await s.sync();                                             // retry / re-sync: idempotent
    assert.equal(forItem(await jobs(s.ownerId), s, 'r1').length, back.length);
    assert.equal(forItem(await jobs(s.ownerId), s, 'r2').length > 0, true, 'an unrelated resource lost its job');
  });

  test('deletion RACING the sync (committed after observation, while fetching): nothing this run fetched is enqueued', async () => {
    let deleted = false;
    const s0 = { ownerId: null, prefix: null };
    const s = await connected({ wrap: c => ({ ...c, fetchResource: async (...a) => {
      if (!deleted) { deleted = true; await SD.forgetExternalSourceClaims(s0.ownerId, { ukoPrefix: s0.prefix }, noVectors); }   // another process deletes the source
      return c.fetchResource(...a);
    } }) });
    Object.assign(s0, { ownerId: s.ownerId, prefix: s.prefix });
    s.put('r1', 'Gallowmere'); s.put('r2', 'Hartsedge');
    const r = await s.sync();
    assert.ok(deleted, 'the deletion did not run mid-sync');
    // Multi-instance safety: the import-batch re-check rejects what was deleted
    // after the sync observed the source — nothing reaches the file store either.
    assert.equal(r.lastSync?.counts?.created ?? 0, 0, `the racing run still imported: ${JSON.stringify(r.lastSync?.counts)}`);
    assert.ok((r.lastSync?.counts?.rejected ?? 0) >= 2, JSON.stringify(r.lastSync?.counts));
    assert.deepEqual(X.listExternalResources(s.ownerId, s.sourceId), [], 'a deleted resource was written to the file store');
    assert.deepEqual(await jobs(s.ownerId), [], 'a resource deleted after the sync observed the source was enqueued');
  });

  test('deletion AFTER the enqueue committed: the deletion sweeps the queued jobs', async () => {
    const s = await connected({});
    s.put('r1', 'Ivybridge'); s.put('r2', 'Jessamine');
    await s.sync();
    assert.ok((await jobs(s.ownerId)).length > 0);
    await SD.forgetExternalSourceClaims(s.ownerId, { ukoPrefix: s.prefix }, noVectors);
    assert.deepEqual(await jobs(s.ownerId), []);
  });

  test('other sources and owners are independent of a deletion', async () => {
    const a = await connected({}), b = await connected({});
    a.put('r1', 'Kestrelholm'); b.put('r1', 'Larkspire');
    await SD.forgetExternalSourceClaims(a.ownerId, { ukoPrefix: a.prefix }, noVectors);   // an OLD deletion of a's source
    await a.sync(); await b.sync();
    assert.ok((await jobs(a.ownerId)).every(x => x.key.endsWith(':g1')), 'a re-sync after an old deletion is a re-addition');
    assert.ok((await jobs(a.ownerId)).length > 0);
    assert.ok((await jobs(b.ownerId)).length > 0 && (await jobs(b.ownerId)).every(x => !/:g\d+$/.test(x.key)));
  });
});

describe('D-1 · Gmail stays out of AI processing through the production sync', () => {
  test('a gmail connection syncs (stored, labelled) with no enqueue, no embedding and no derived knowledge', async () => {
    embedded.length = 0;
    const s = await connected({ id: 'gmail', gmail: true });
    s.put('thread-1', 'Mirevale');
    const r = await s.sync();
    assert.equal(r.lastSync?.state, 'succeeded', JSON.stringify(r.lastSync));
    assert.ok((r.lastSync?.counts?.created ?? 0) >= 1);
    assert.deepEqual(await jobs(s.ownerId), [], 'Gmail content was enqueued for understanding');
    assert.ok(!embedded.some(t => String(t).includes('Mirevale')), 'Gmail content reached the embedder');
    const us = await import('../../files/ukoStore.js');
    assert.equal(us.listUKOs(s.ownerId, { limit: 99 }).length, 0, 'a normal reader saw Gmail content');
  });
});
