/**
 * D-1 on a REAL PostgreSQL — the production sync path (connectService.sync →
 * syncEngine.runSync → observeSource → syncExternalResources → enqueue), with
 * two real connections racing in both orders:
 *
 *   S1  baseline: the sync observes before discovery and enqueues (generation 0).
 *   S2  deletion OPEN while the sync reaches its enqueue: the enqueue waits on
 *       the source lock (pg_locks), the deletion commits, the enqueue is refused.
 *   S3  enqueue FIRST, deletion queued behind it: the enqueue commits its jobs,
 *       the deletion then runs and sweeps them.
 *   S4a identical re-addition after a lifecycle deletion: exactly `:g1` (D-2).
 *   S4b changed content after a canonical-only deletion: a new `:g<n>` key, n ≥ 1
 *       (update sweeps also write covering tombstones); re-sync adds none.
 *   S5  Gmail through the sync: stored, no enqueue, no embedding.
 *
 * Skips visibly without AQUA_TEST_DATABASE_URL (scripts/run-tests.mjs maps it
 * to DATABASE_URL). REFUSES to run unless the server identifies as `aqua_test`
 * — checked in before(), before any write. Fake owners only; their rows,
 * including their aqua_jobs rows, are removed in after().
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const DB_URL = process.env.DATABASE_URL ?? '';            // the runner's mapping; testkit.js deletes it
const K = await import('./testkit.js');                  // isolated data dir, OFFLINE fake embedder, env stripped
if (DB_URL) process.env.DATABASE_URL = DB_URL;
process.env.AQUA_E6 = 'on';                               // the enqueue's own gate
process.env.AQUA_EMBEDDINGS = 'off';

const { isConfigured, getPool, closePool } = await import('../../core/db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

let X, SD, G, ident, p;
const OWNERS = [];
const embedded = [];

before(async () => {
  if (!LIVE) return;
  p = await getPool();
  const id = (await p.query(`select current_database() db, current_setting('server_version') ver`)).rows[0];
  const u = new URL(DB_URL);
  if (id.db !== 'aqua_test' || u.port !== '55432' || !['localhost', '127.0.0.1'].includes(u.hostname)) {
    throw new Error(`refusing to run: target is ${u.hostname}:${u.port}/${id.db}`);
  }
  X = K.external;
  X.__setExternalUnderstandingForTests(true);
  SD = await import('../../core/worldModel/sourceDeletion.js');
  G = await import('../../core/worldModel/externalDeletionGuard.js');
  ident = await import('../../files/externalIdentity.js');
  (await import('../../embeddings/embeddingProvider.js')).__setEmbedderForTests(async t => { embedded.push(...t); return t.map(() => [1, 0, 0]); });
});
after(async () => {
  if (!LIVE) return;
  X?.__setExternalUnderstandingForTests(false);
  const wm = await import('../../core/worldModel/worldModelRepository.js');
  const cr = await import('../../core/claims/claimRepository.js');
  const { connectLeaseName } = await import('../ownerLease.js');
  for (const o of OWNERS) {
    await wm.purgeOwner(o); await cr.purgeOwner(o); await wm.purgeOwnerEntities(o);
    await p.query(`DELETE FROM aqua_jobs WHERE owner_id = $1 AND owner_id LIKE 'user:u-d1live-%'`, [o]);   // this suite's own fixture jobs only
    await p.query('DELETE FROM aqua_scheduler_leases WHERE name = $1', [connectLeaseName(o)]);           // released leases stay as expired rows
  }
  await closePool();
});

// ── fixtures ────────────────────────────────────────────────────────────────
const noVectors = { removeVector: () => true, canonicalNamespace: () => 'x' };
const text = t => `The ${t} launch is planned for June. Lena owns the ${t} service and its budget.`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connected({ id = 'fake', wrap = c => c, gmail = false } = {}) {
  const world = K.createFakeWorld();
  const registry = K.createConnectorRegistry({ allowTestOnly: true });
  let connector = K.createFakeConnector({ world, id });
  if (gmail) { const { dataPolicy, ...rest } = connector; connector = rest; }
  registry.register(wrap(connector));
  const service = K.createConnectService({ registry, store: K.createMemoryConnectionStore(), vault: K.createCredentialVault({ key: K.TEST_KEY }),
    retry: { sleep: async () => {}, baseMs: 0 }, log: { log() {}, warn() {} }, trustRawUserId: true, singleInstance: true });
  const userId = K.freshUser('d1live');
  const account = `acct-${userId}`;
  const conn = await service.connect({ userId, connectorId: id, input: { account, code: 'ok' } });
  const ownerId = K.ownerOf(userId);
  OWNERS.push(ownerId);
  const sourceId = `${id}:${conn.connectionId}`;
  return { world, ownerId, account, sourceId, prefix: ident.sourcePrefixes(sourceId).ukoPrefix,
    sync: () => service.sync({ userId, connectionId: conn.connectionId, mode: 'full' }),
    put: (externalId, t) => world.put(account, externalId, { name: `${externalId}.md`, content: text(t) }) };
}
const jobs = async o => (await p.query(`SELECT idempotency_key, state FROM aqua_jobs WHERE owner_id = $1 AND kind = 'understanding.document.v1'`, [o])).rows;
async function lockWaiters(o, prefix) {
  const k = BigInt.asUintN(64, BigInt(G.externalSourceLockKey(o, prefix)));
  return Number((await p.query(`SELECT count(*)::int n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid::bigint = $1 AND objid::bigint = $2 AND objsubid = 1`,
    [String(k >> 32n), String(k & 0xffffffffn)])).rows[0].n);
}
async function waitFor(fn, what, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return; await sleep(25); }
  throw new Error(`timed out waiting for: ${what}`);
}

test('D-1 live: Postgres is available', { skip }, () => { assert.ok(LIVE); });

describe('D-1 live · production sync path on real PostgreSQL', { skip }, () => {
  test('S1 · the sync observes before discovery and enqueues with generation-0 keys', async () => {
    const order = [];
    const s = await connected({ wrap: c => ({ ...c, listResources: async (...a) => { order.push(['list', Date.now()]); return c.listResources(...a); } }) });
    s.put('r1', 'Quillmere'); s.put('r2', 'Rowanhurst');
    const t0 = Date.now();
    await s.sync();
    const j = await jobs(s.ownerId);
    assert.ok(j.length >= 2 && j.every(x => !/:g\d+$/.test(x.idempotency_key) && x.state === 'queued'), JSON.stringify(j));
    assert.ok(order.length && order[0][1] >= t0);
  });

  test('S2 · deletion OPEN when the sync reaches its enqueue: the enqueue waits on the lock, then is refused (no job)', async () => {
    let release, entered;
    const held = new Promise(r => { release = r; });
    const inside = new Promise(r => { entered = r; });
    let deletion = null;
    const ctx = {};
    const s = await connected({ wrap: c => ({ ...c, fetchResource: async (...a) => {
      if (!deletion) {
        // another instance starts deleting the source and holds its transaction open
        deletion = SD.forgetExternalSourceClaims(ctx.ownerId, { ukoPrefix: ctx.prefix }, { ...noVectors, beforeCommit: async () => { entered(); await held; } });
        await inside;
      }
      return c.fetchResource(...a);
    } }) });
    Object.assign(ctx, { ownerId: s.ownerId, prefix: s.prefix });
    s.put('r1', 'Sablewood'); s.put('r2', 'Thistlebrook');
    const watcher = (async () => {
      await waitFor(async () => (await lockWaiters(s.ownerId, s.prefix)) === 1, 'the sync\'s enqueue to queue on the source lock');
      release();
    })();
    const r = await s.sync();
    await watcher;
    const d = await deletion;
    assert.equal(d.complete, true);
    assert.ok((r.lastSync?.counts?.created ?? 0) >= 1, JSON.stringify(r.lastSync?.counts));
    assert.deepEqual(await jobs(s.ownerId), [], 'the enqueue wrote jobs for a source deleted under it');
  });

  test('S3 · enqueue FIRST, deletion queued behind it: the jobs commit, then the deletion sweeps them', async () => {
    const ctx = {};
    let gate = null, deletion = null;
    const s = await connected({ wrap: c => ({ ...c, fetchResource: async (...a) => {
      if (!gate) {                                     // hold the source lock from a third session
        gate = await p.connect();
        await gate.query('BEGIN');
        await G.lockExternalSource(gate, ctx.ownerId, ctx.prefix);
      }
      return c.fetchResource(...a);
    } }) });
    Object.assign(ctx, { ownerId: s.ownerId, prefix: s.prefix });
    s.put('r1', 'Umberfield'); s.put('r2', 'Vellichor');
    const orchestrate = (async () => {
      await waitFor(async () => gate && (await lockWaiters(s.ownerId, s.prefix)) === 1, 'the sync\'s enqueue to queue first');
      deletion = SD.forgetExternalSourceClaims(s.ownerId, { ukoPrefix: s.prefix }, noVectors);
      await waitFor(async () => (await lockWaiters(s.ownerId, s.prefix)) === 2, 'the deletion to queue second');
      await gate.query('COMMIT');
      gate.release();
    })();
    await s.sync();
    await orchestrate;
    const d = await deletion;
    assert.equal(d.complete, true);
    assert.ok(d.counts.jobs >= 1, `the deletion did not sweep the jobs the sync enqueued first: ${JSON.stringify(d.counts)}`);
    assert.deepEqual(await jobs(s.ownerId), []);
  });

  test('S4a · identical content re-added after a lifecycle deletion: exactly :g1 jobs; a re-sync adds none', async () => {
    const s = await connected();
    s.put('r1', 'Wrenfold'); s.put('r2', 'Yarrowdale'); s.put('r3', 'Zephyrcombe');
    await s.sync();
    const del = await X.deleteExternalSource(s.ownerId, s.sourceId);           // full deletion: file store + canonical + jobs
    assert.equal(del.complete, true, JSON.stringify(del.errors));
    assert.deepEqual(await jobs(s.ownerId), []);
    await sleep(20);
    await s.sync();                                                            // same resources come back (same ukoIds)
    const back = await jobs(s.ownerId);
    assert.ok(back.length >= 3 && back.every(x => x.idempotency_key.endsWith(':g1') && x.state === 'queued'), JSON.stringify(back));
    await s.sync();
    assert.equal((await jobs(s.ownerId)).length, back.length, 're-sync created duplicate jobs');
  });

  test('S4b · changed content after a canonical-only deletion: a NEW generation key (≥ 1, counts every covering tombstone incl. update sweeps); idempotent', async () => {
    const s = await connected();
    s.put('r1', 'Ashcombe'); s.put('r2', 'Briarholt');
    await s.sync();
    const first = (await jobs(s.ownerId)).map(x => x.idempotency_key);
    await SD.forgetExternalSourceClaims(s.ownerId, { ukoPrefix: s.prefix }, noVectors);   // e.g. another instance deleted the source
    await sleep(20);
    s.put('r1', 'Ashcombe-2'); s.put('r2', 'Briarholt-2');
    await s.sync();
    const now = await jobs(s.ownerId);
    assert.ok(now.length >= 2 && now.every(x => /:g[1-9]d*$/.test(x.idempotency_key) && !first.includes(x.idempotency_key)), JSON.stringify(now));
    await s.sync();
    assert.equal((await jobs(s.ownerId)).length, now.length, 're-sync created duplicate jobs');
  });

  test('S5 · Gmail through the sync on real PostgreSQL: stored, no enqueue, no embedding', async () => {
    embedded.length = 0;
    const s = await connected({ id: 'gmail', gmail: true });
    s.put('thread-1', 'Amberlight');
    const r = await s.sync();
    assert.equal(r.lastSync?.state, 'succeeded', JSON.stringify(r.lastSync));
    assert.deepEqual(await jobs(s.ownerId), []);
    assert.ok(!embedded.some(t => String(t).includes('Amberlight')));
  });
});
