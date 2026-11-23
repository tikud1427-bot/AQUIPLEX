/**
 * Multi-instance connect safety on a REAL PostgreSQL with TWO SEPARATE NODE
 * PROCESSES (fixtures/fencingChild.mjs). Each child has its own scratch data
 * directory and every store partition-backed (`on`), so the two share state
 * ONLY through the database — exactly two instances.
 *
 *   F1  same owner: a disconnect-deletion waits for a running sync's lease,
 *       then deletes everything it imported.
 *   F2  lease expiry + takeover: a sync that stalled past its lease (no
 *       renewal) resumes after another instance took the owner over — its
 *       writes are REFUSED by the fence (LEASE_LOST) and nothing it imported
 *       reaches the database; it cannot release the new holder's lease.
 *   F3  disconnect racing a stalled sync: the deletion takes over and deletes;
 *       the stale sync resumes and writes nothing (LEASE_LOST).
 *   F5  trailing fence: a finished sync's late (fire-and-forget) write lands
 *       until another instance took the owner over — and stays refused after
 *       that instance released.
 *   F4  different owners at the same time: both succeed independently.
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
import { fileURLToPath } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
const { isConfigured, getPool, closePool } = await import('../../core/db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';
const CHILD = fileURLToPath(new URL('./fixtures/fencingChild.mjs', import.meta.url));
const PARTITIONS = 'reflection:on,mind:on,recall-redactions:on,history:on,reasoning-graph:on,ids:on,brain:on,evidence:on,fileindex:on,uko:on,attachments:on,pic:on,vectors:on,projects:on,index:on,artifacts:on,cognition:on,ledger:on';
const RUN = `${Date.now().toString(36)}${process.pid}`;
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
    await p.query('DELETE FROM aqua_owner_versions WHERE owner_id = $1', [o]);   // per-owner change counter (0027 trigger)
  }
  await closePool();
});

let n = 0;
function newCase(tag) {
  const userId = `u-fence-${RUN}-${tag}-${++n}`;
  OWNERS.push(`user:${userId}`);
  return { userId, owner: `user:${userId}`, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-fence-case-')) };
}
function child(args) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-fence-proc-'));
  const env = { ...process.env, DATABASE_URL: DB_URL, AQUA_DATA_DIR: scratch, HOME: scratch, USERPROFILE: scratch,
    AQUA_STORE_PARTITIONS: PARTITIONS, AQUA_EMBEDDINGS: 'off', AQUA_DISABLE_MONGO_MIRROR: '1' };
  for (const k of ['MONGO_URI', 'MONGODB_URI', 'AQUA_CONNECTOR_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'HF_TOKEN', 'AQUA_E6']) delete env[k];
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CHILD, JSON.stringify(args)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let outText = '', errText = '';
    c.stdout.on('data', d => { outText += d; });
    c.stderr.on('data', d => { errText += d; });
    const kill = setTimeout(() => { c.kill(); reject(new Error(`child ${args.mode} timed out\n${errText.slice(-800)}`)); }, 60_000);
    c.on('exit', () => {
      clearTimeout(kill);
      const line = outText.split('\n').find(l => l.startsWith('RESULT:'));
      if (!line) return reject(new Error(`child ${args.mode} gave no result\n${outText.slice(-600)}\n${errText.slice(-800)}`));
      resolve({ ...JSON.parse(line.slice(7)), pid: c.pid });
    });
  });
}
/** Every live partition row of the owner that still contains one of these words. */
async function holding(owner, words) {
  const { rows } = await p.query('SELECT store_key, data FROM aqua_store_partitions WHERE owner_id = $1 AND deleted_at IS NULL', [owner]);
  return rows.filter(r => words.some(w => String(r.data ?? '').includes(w))).map(r => r.store_key);
}
async function externalUkos(owner) {
  const { rows } = await p.query(`SELECT data FROM aqua_store_partitions WHERE owner_id = $1 AND store_key = '.aqua-uko.json' AND deleted_at IS NULL`, [owner]);
  return rows.flatMap(r => Object.keys(JSON.parse(r.data ?? '{}') ?? {})).filter(k => k.startsWith('ext_'));
}
const leaseRow = async owner => {
  const { connectLeaseName } = await import('../ownerLease.js');
  return (await p.query('SELECT holder, expires_at <= now() AS expired FROM aqua_scheduler_leases WHERE name = $1', [connectLeaseName(owner)])).rows[0] ?? null;
};

test('connect fencing live: Postgres is available', { skip }, () => { assert.ok(LIVE); });

describe('connect fencing live · two separate Node processes', { skip }, () => {
  test('F1 · same owner: the deletion waits for the running sync\'s lease, then removes everything it imported', async () => {
    const c = newCase('f1');
    const words = ['Quillmere', 'Rowanhurst'];
    const [a, b] = await Promise.all([
      child({ mode: 'sync', userId: c.userId, dir: c.dir, fetchDelayMs: 800, tokens: words }),
      child({ mode: 'delete', userId: c.userId, dir: c.dir }),
    ]);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.ok((a.counts?.created ?? 0) >= 2, JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.ok(b.waitedMs >= 600, `the deletion did not wait for the sync's lease (${b.waitedMs} ms)`);
    assert.equal(b.complete, true);
    assert.ok(b.removedUkos >= 2, `the deletion did not see what the sync wrote: ${JSON.stringify(b)}`);
    assert.notEqual(a.pid, b.pid);
    assert.deepEqual(await externalUkos(c.owner), []);
    assert.deepEqual(await holding(c.owner, words), [], 'imported content survived the deletion');
    assert.equal((await leaseRow(c.owner))?.expired ?? true, true, 'a lease was left live');
  });

  test('F2 · stale holder after expiry + takeover: its writes are refused (LEASE_LOST); it cannot release the new lease', async () => {
    const c = newCase('f2');
    const words = ['Sablewood', 'Thistlebrook'];
    const syncP = child({ mode: 'sync', userId: c.userId, dir: c.dir, ttlMs: 1500, renewEveryMs: 0, fetchDelayMs: 2500, tokens: words });
    const holdP = child({ mode: 'hold', userId: c.userId, dir: c.dir });
    const a = await syncP;                               // resumes after the takeover; must fail
    fs.writeFileSync(path.join(c.dir, 'release'), '1');
    const b = await holdP;
    assert.equal(a.ok, false, `a stale holder's sync succeeded: ${JSON.stringify(a)}`);
    assert.equal(a.code, 'LEASE_LOST', JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.ok(b.waitedMs >= 1000, `the takeover did not wait for expiry (${b.waitedMs} ms)`);
    assert.equal(b.stillMineAtEnd, true, 'the stale holder released or overwrote the new holder\'s lease');
    assert.deepEqual(await externalUkos(c.owner), [], 'a superseded holder wrote resources');
    assert.deepEqual(await holding(c.owner, words), [], 'a superseded holder wrote derived knowledge');
    assert.equal((await leaseRow(c.owner))?.expired ?? true, true, 'a lease was left live');
  });

  test('F3 · disconnect racing a stalled sync: the deletion takes over; the stale sync writes nothing', async () => {
    const c = newCase('f3');
    const words = ['Umberfield', 'Vellichor'];
    const [a, b] = await Promise.all([
      child({ mode: 'sync', userId: c.userId, dir: c.dir, ttlMs: 1500, renewEveryMs: 0, fetchDelayMs: 2500, tokens: words }),
      child({ mode: 'delete', userId: c.userId, dir: c.dir }),
    ]);
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(b.complete, true);
    assert.equal(a.ok, false, `the stale sync reported success: ${JSON.stringify(a)}`);
    assert.equal(a.code, 'LEASE_LOST', JSON.stringify(a));
    assert.deepEqual(await externalUkos(c.owner), [], 'the deleted source was re-created');
    assert.deepEqual(await holding(c.owner, words), []);
  });

  test('F5 · trailing fence: a finished sync\'s late write lands until another instance takes over, then it is refused', async () => {
    const c = newCase('f5');
    const words = ['Kestrelholm', 'Larkspire'];
    const [a, b] = await Promise.all([
      child({ mode: 'sync', userId: c.userId, dir: c.dir, tokens: words, lateWrites: true }),
      child({ mode: 'delete', userId: c.userId, dir: c.dir, waitFor: 'late1-done' }),
    ]);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.late1, 'written', `a late write was refused while nobody had taken over: ${JSON.stringify(a)}`);
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(b.complete, true);
    assert.equal(a.late2, 'WRITE_FENCE_LOST', `a late write landed after another instance took over: ${JSON.stringify(a)}`);
    assert.deepEqual(await externalUkos(c.owner), [], 'the deleted source was re-created by a late write');
    assert.deepEqual(await holding(c.owner, words), []);
  });

  test('F4 · different owners in two processes at the same time: both succeed, both persisted', async () => {
    const c1 = newCase('f4a'), c2 = newCase('f4b');
    const [a, b] = await Promise.all([
      child({ mode: 'sync', userId: c1.userId, dir: c1.dir, fetchDelayMs: 300, tokens: ['Wrenfold', 'Yarrowdale'] }),
      child({ mode: 'sync', userId: c2.userId, dir: c2.dir, fetchDelayMs: 300, tokens: ['Zephyrcombe', 'Ashcombe'] }),
    ]);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal((await externalUkos(c1.owner)).length, 2);
    assert.equal((await externalUkos(c2.owner)).length, 2);
  });
});
