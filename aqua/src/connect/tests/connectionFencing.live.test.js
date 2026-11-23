/**
 * Safety Fix 4 on a REAL PostgreSQL with SEPARATE NODE PROCESSES
 * (fixtures/connFenceChild.mjs) sharing ONE connection store (the real Mongo
 * adapter over a file-backed fake mongoose — no MongoDB deployment).
 *
 *   C1  ordering 1: an old connection write IN PROGRESS when a newer
 *       acquisition comes — the acquisition WAITS for it, then stamps and sees it.
 *   C2  ordering 2: a newer acquisition first — the old write is refused by the
 *       database check, and its late delivery is rejected by the store itself.
 *   C3  a token refresh completing after the lease was lost (another process
 *       revoked meanwhile): refused; the revocation stands.
 *   C4  account purge racing an ACTIVE sync: the purge completes; the sync
 *       cannot write its connection; nothing of the connector state remains.
 *   C5  a stale connect (credential exchange in flight) after the account
 *       deletion: no connection is created.
 *   C6  a new process can neither acquire the deleted owner's lease nor connect.
 *   C7  a repeated purge is idempotent, verified independently.
 *
 * Skips without AQUA_TEST_DATABASE_URL; refuses unless the server is aqua_test
 * on localhost:55432. Test owners' rows are removed in after().
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
const { isConfigured, getPool, closePool } = await import('../../core/db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';
const CHILD = fileURLToPath(new URL('./fixtures/connFenceChild.mjs', import.meta.url));
const RUN = `${Date.now().toString(36)}${process.pid}`;
const KEY = crypto.randomBytes(32).toString('hex');
const OWNERS = [];
let p;

before(async () => {
  if (!LIVE) return;
  p = await getPool();
  const id = (await p.query('select current_database() db')).rows[0];
  const u = new URL(DB_URL);
  if (id.db !== 'aqua_test' || u.port !== '55432' || !['localhost', '127.0.0.1'].includes(u.hostname)) {
    throw new Error(`refusing to run: target is ${u.hostname}:${u.port}/${id.db}`);
  }
});
after(async () => {
  if (!LIVE) return;
  const { connectLeaseName } = await import('../ownerLease.js');
  for (const o of OWNERS) {   // this suite's own test owners only
    await p.query('DELETE FROM aqua_store_partitions WHERE owner_id = $1', [o]);
    await p.query('DELETE FROM aqua_external_deletions WHERE owner_id = $1', [o]);
    await p.query('DELETE FROM aqua_jobs WHERE owner_id = $1', [o]);
    await p.query('DELETE FROM aqua_scheduler_leases WHERE name = $1', [connectLeaseName(o)]);
    await p.query('DELETE FROM aqua_owner_versions WHERE owner_id = $1', [o]);
    await p.query('DELETE FROM aqua_deleted_owners WHERE owner_id = $1', [o]);
  }
  await closePool();
});

let n = 0;
function newCase(tag) {
  const userId = `u-cfl-${RUN}-${tag}-${++n}`;
  OWNERS.push(`user:${userId}`);
  return { userId, owner: `user:${userId}`, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-cfl-case-')) };
}
function child(args) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-cfl-proc-'));
  const env = { ...process.env, DATABASE_URL: DB_URL, AQUA_DATA_DIR: scratch, HOME: scratch, USERPROFILE: scratch, AQUA_EMBEDDINGS: 'off', AQUA_DISABLE_MONGO_MIRROR: '1' };
  for (const k of ['MONGO_URI', 'MONGODB_URI', 'AQUA_CONNECTOR_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'HF_TOKEN', 'AQUA_E6', 'AQUA_STORE_PARTITIONS']) delete env[k];
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CHILD, JSON.stringify({ keyHex: KEY, ...args })], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let outText = '', errText = '';
    c.stdout.on('data', d => { outText += d; });
    c.stderr.on('data', d => { errText += d; });
    const kill = setTimeout(() => { c.kill(); reject(new Error(`child ${args.mode} timed out\n${errText.slice(-800)}`)); }, 90_000);
    c.on('exit', () => {
      clearTimeout(kill);
      const line = outText.split('\n').find(l => l.startsWith('RESULT:'));
      if (!line) return reject(new Error(`child ${args.mode} gave no result\n${outText.slice(-600)}\n${errText.slice(-800)}`));
      resolve({ ...JSON.parse(line.slice(7)), pid: c.pid });
    });
  });
}
// The shared store's raw files (fake mongoose: one file per collection). Owner documents, and every record in them.
const ownerDocs = dir => { const f = path.join(dir, 'aqua_connections.AquaConnectionSet.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8') || '[]') : []; };
const storeDocs = dir => ownerDocs(dir).flatMap(d => Object.values(d.connections ?? {}).map(r => ({ ...r, ownerId: d.ownerId ?? d._id, fenceEpoch: d.fenceEpoch, fenceToken: d.fenceToken })));
const leaseRows = async o => { const { connectLeaseName } = await import('../ownerLease.js'); return Number((await p.query('SELECT count(*)::int AS n FROM aqua_scheduler_leases WHERE name = $1', [connectLeaseName(o)])).rows[0].n); };
const tableRows = async (table, o) => Number((await p.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id = $1`, [o])).rows[0].n);

test('connection fencing live: Postgres is available', { skip }, () => { assert.ok(LIVE); });

describe('connection fencing live · separate Node processes, one connection store', { skip }, () => {
  test('R1 · a stale insert DELIVERED AFTER the purge (records deleted, verified, lease row deleted) writes nothing', async t => {
    const c = newCase('r1');
    const [a, pg] = await Promise.all([
      child({ mode: 'delayedInserter', owner: c.owner, dir: c.dir }),
      child({ mode: 'purger', owner: c.owner, dir: c.dir, waitFor: 'insert-in-flight' }),
    ]);
    await new Promise(r => setTimeout(r, 500));
    const docs = ownerDocs(c.dir).filter(d => d._id === c.owner);
    const raw = JSON.stringify(ownerDocs(c.dir));
    t.diagnostic(`R1: inserter pid ${a.pid} serialised=${a.serialised} delivered=${a.delivered} deliveredAfterPurge=${a.deliveredAt - pg.purgedAt} ms; purger pid ${pg.pid} complete=${pg.complete} removed=${JSON.stringify(pg.removed)}; owner documents=${docs.length} deleted=${docs[0]?.deleted} records=${Object.keys(docs[0]?.connections ?? {}).length} lease rows=${await leaseRows(c.owner)}`);
    assert.equal(a.serialised, 'LEASE_LOST', 'precondition: the bounded write timed out and released the serialisation');
    assert.equal(pg.complete, true, JSON.stringify(pg));
    assert.equal(pg.removed.lease, true, 'precondition: the purge deleted the lease row before the delivery');
    assert.ok(a.deliveredAt > pg.purgedAt, 'precondition: the insert was delivered after the purge completed');
    assert.equal(a.delivered, 'OWNER_DELETED', `the delayed insert was not refused: ${JSON.stringify(a)}`);
    assert.equal(storeDocs(c.dir).length, 0, 'a connection record is physically present after the purge');
    assert.ok(!raw.includes('SEALED-CREDENTIALS'), 'credentials are physically present after the purge');
    assert.equal(docs.length, 1);
    assert.equal(docs[0].deleted, true, 'the tombstone is missing');
    assert.equal(await leaseRows(c.owner), 0);
  });

  test('R2 · reverse ordering: an insert IN PROGRESS when the purge starts — the purge waits for it, then removes it', async t => {
    const c = newCase('r2');
    const [a, pg] = await Promise.all([
      child({ mode: 'slowInserter', owner: c.owner, dir: c.dir }),
      child({ mode: 'purger', owner: c.owner, dir: c.dir, waitFor: 'inserting' }),
    ]);
    const docs = ownerDocs(c.dir).filter(d => d._id === c.owner);
    t.diagnostic(`R2: inserter pid ${a.pid} created=${a.created}; purger pid ${pg.pid} purgeMs=${pg.purgeMs} complete=${pg.complete} removed=${JSON.stringify(pg.removed)} purgedAfterInsert=${pg.purgedAt - a.committedAt} ms; records at rest=${storeDocs(c.dir).length} deleted=${docs[0]?.deleted}`);
    assert.equal(a.created, 'created', 'the insert in progress was refused instead of being ordered before the purge');
    assert.ok(pg.purgeMs >= 800, `the purge did not wait for the insert in progress (${pg.purgeMs} ms)`);
    assert.ok(pg.purgedAt >= a.committedAt, 'the purge completed before the insert in progress committed');
    assert.equal(pg.complete, true, JSON.stringify(pg));
    assert.equal(pg.removed.connections, 1, 'the purge did not remove the record ordered before it');
    assert.equal(storeDocs(c.dir).length, 0);
    assert.equal(docs[0]?.deleted, true);
  });

  test('C1 · ordering 1: an old write IN PROGRESS finishes first; the newer acquisition waits for it, then stamps and sees it', async t => {
    const c = newCase('c1');
    const seed = await child({ mode: 'connect', owner: c.owner, userId: c.userId, dir: c.dir });
    assert.equal(seed.ok, true, JSON.stringify(seed));
    const [a, b] = await Promise.all([
      child({ mode: 'slowWriter', owner: c.owner, dir: c.dir, connectionId: seed.connectionId }),
      child({ mode: 'acquirer', owner: c.owner, dir: c.dir, connectionId: seed.connectionId }),
    ]);
    t.diagnostic(`C1: writer pid ${a.pid} writeMs=${a.writeMs} epoch=${a.epoch}; acquirer pid ${b.pid} waited=${b.waitedMs} ms epoch=${b.epoch} sawCheckpoint=${JSON.stringify(b.checkpoint)} acquiredAfterWrite=${b.acquiredAt - a.wroteAt} ms`);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.ok(a.writeMs >= 1900, 'precondition: the write was in progress across the lease expiry');
    assert.ok(b.waitedMs >= 500, `the newer acquisition did not wait for the write in progress (${b.waitedMs} ms)`);
    assert.ok(b.acquiredAt >= a.wroteAt - 50, 'the newer acquisition became authoritative before the old write finished');
    assert.deepEqual(b.checkpoint, { by: 'A' }, 'the newer operation did not see the old write ordered before it');
    assert.ok(b.epoch > a.epoch);
    assert.equal(b.docEpoch, b.epoch, 'the stamp did not adopt the record');
  });

  test('C2 · ordering 2: a newer acquisition first — the old write is refused, and its LATE delivery is rejected by the store', async t => {
    const c = newCase('c2');
    const seed = await child({ mode: 'connect', owner: c.owner, userId: c.userId, dir: c.dir });
    const [a, b] = await Promise.all([
      child({ mode: 'staleWriter', owner: c.owner, dir: c.dir, connectionId: seed.connectionId }),
      child({ mode: 'newWriter', owner: c.owner, dir: c.dir, connectionId: seed.connectionId }),
    ]);
    const doc = storeDocs(c.dir).find(d => d.connectionId === seed.connectionId);
    t.diagnostic(`C2: stale pid ${a.pid} epoch=${a.epoch} viaService=${a.viaService} lateDelivery=${a.late}; new pid ${b.pid} epoch=${b.epoch}; stored checkpoint=${JSON.stringify(doc.checkpoint)} pendingDeletion=${JSON.stringify(doc.pendingDeletion)} fenceEpoch=${doc.fenceEpoch}`);
    assert.equal(a.viaService, 'LEASE_LOST', JSON.stringify(a));
    assert.equal(a.late, 'FENCE_STALE', JSON.stringify(a));
    assert.deepEqual(doc.checkpoint, { by: 'B' });
    assert.deepEqual(doc.pendingDeletion, { count: 3, origin: 'B' });
    assert.equal(doc.fenceEpoch, b.epoch);
  });

  test('C3 · a token refresh completing after the lease was lost is refused; the revocation in another process stands', async t => {
    const c = newCase('c3');
    const [a, b] = await Promise.all([
      child({ mode: 'refresher', owner: c.owner, userId: c.userId, dir: c.dir }),
      child({ mode: 'revoker', owner: c.owner, userId: c.userId, dir: c.dir }),
    ]);
    const doc = storeDocs(c.dir).find(d => d.connectionId === a.connectionId);
    t.diagnostic(`C3: refresher pid ${a.pid} result=${a.result}; revoker pid ${b.pid} status=${b.status}; stored status=${doc.status} credentials=${doc.credentials === null ? 'null' : 'PRESENT'}`);
    assert.equal(b.status, 'revoked', JSON.stringify(b));
    assert.equal(a.result, 'LEASE_LOST', JSON.stringify(a));
    assert.equal(doc.credentials, null, 'a stale refresh stored credentials after the revocation');
    assert.equal(doc.status, 'revoked');
  });

  test('C4 · account purge racing an ACTIVE sync: the purge completes; nothing of the connector state remains', async t => {
    const c = newCase('c4');
    const [a, pg] = await Promise.all([
      child({ mode: 'syncer', owner: c.owner, userId: c.userId, dir: c.dir }),
      child({ mode: 'purger', owner: c.owner, dir: c.dir, waitFor: 'in-sync' }),
    ]);
    t.diagnostic(`C4: syncer pid ${a.pid} result=${a.result}; purger pid ${pg.pid} complete=${pg.complete} removed=${JSON.stringify(pg.removed)}; store docs=${storeDocs(c.dir).length} lease rows=${await leaseRows(c.owner)}`);
    assert.equal(pg.complete, true, JSON.stringify(pg));
    assert.ok(['LEASE_LOST', 'OWNER_DELETED'].includes(a.result), JSON.stringify(a));
    assert.equal(storeDocs(c.dir).length, 0, 'the active sync left or re-created a connection');
    assert.equal(await leaseRows(c.owner), 0);
    assert.equal(await tableRows('aqua_deleted_owners', c.owner), 1, 'the deletion marker must stay');
  });

  test('C5 · a stale CONNECT (credential exchange in flight) after the account deletion creates nothing', async t => {
    const c = newCase('c5');
    const [a, pg] = await Promise.all([
      child({ mode: 'exchanger', owner: c.owner, userId: c.userId, dir: c.dir }),
      child({ mode: 'purger', owner: c.owner, dir: c.dir, waitFor: 'exchanging' }),
    ]);
    t.diagnostic(`C5: exchanger pid ${a.pid} result=${a.result}; purger complete=${pg.complete}; store docs=${storeDocs(c.dir).length}`);
    assert.equal(pg.complete, true, JSON.stringify(pg));
    assert.ok(['LEASE_LOST', 'OWNER_DELETED'].includes(a.result), JSON.stringify(a));
    assert.equal(storeDocs(c.dir).length, 0, 'a stale connect created a connection after the account deletion');
  });

  test('C6 + C7 · a new process cannot acquire or connect for the deleted owner; a repeated purge is idempotent (verified independently)', async t => {
    const c = newCase('c67');
    await child({ mode: 'connect', owner: c.owner, userId: c.userId, dir: c.dir });
    const p1 = await child({ mode: 'purger', owner: c.owner, dir: c.dir });
    const q = await child({ mode: 'lateAcquire', owner: c.owner, userId: c.userId, dir: c.dir });
    const p2 = await child({ mode: 'purger', owner: c.owner, dir: c.dir });
    t.diagnostic(`C6/7: purge1 complete=${p1.complete} removed=${JSON.stringify(p1.removed)}; new process acquire=${q.acquire} connect=${q.connect}; purge2 complete=${p2.complete} removed=${JSON.stringify(p2.removed)}`);
    assert.equal(p1.complete, true, JSON.stringify(p1));
    assert.equal(p1.removed.connections, 1);
    assert.equal(q.acquire, 'OWNER_DELETED');
    assert.equal(q.connect, 'OWNER_DELETED');
    assert.equal(p2.complete, true, JSON.stringify(p2));
    assert.equal(p2.removed.connections, 0);
    // Independent verification: the shared store file and the tables themselves.
    assert.equal(storeDocs(c.dir).length, 0);
    assert.equal(await leaseRows(c.owner), 0);
    for (const tbl of ['aqua_jobs', 'aqua_external_deletions']) assert.equal(await tableRows(tbl, c.owner), 0, tbl);
    assert.equal(await tableRows('aqua_deleted_owners', c.owner), 1);
  });
});
