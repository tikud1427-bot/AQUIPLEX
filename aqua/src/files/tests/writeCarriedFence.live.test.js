/**
 * Safety Fix 3 on a REAL PostgreSQL with SEPARATE NODE PROCESSES
 * (fixtures/wcfChild.mjs): work a sync STARTED — the real fire-and-forget
 * claim-vector indexing and a background timer created inside the operation —
 * finishes LATE. Its authority is the sync's own fence, carried with the work.
 *
 *   L1  another process acquired the owner, deleted the source and released;
 *       the late work then finishes → REFUSED; nothing of the source remains.
 *   L2  control: nobody acquired since; the late work finishes AFTER the old
 *       2×TTL window (no time limit any more) → it lands.
 *   L3  the late work races another process's deletion (3 rounds) → whichever
 *       commits first, nothing of the source remains and the deletion is complete.
 *   L4  another process only acquired+released; the late work finishes INSIDE a
 *       NEW connect operation of the same process → REFUSED; the new
 *       operation's own write lands.
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
const CHILD = fileURLToPath(new URL('./fixtures/wcfChild.mjs', import.meta.url));
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
  const { connectLeaseName } = await import('../../connect/ownerLease.js');
  for (const o of OWNERS) {   // this suite's own test owners only
    await p.query('DELETE FROM aqua_store_partitions WHERE owner_id = $1', [o]);
    await p.query('DELETE FROM aqua_external_deletions WHERE owner_id = $1', [o]);
    await p.query('DELETE FROM aqua_jobs WHERE owner_id = $1', [o]);
    await p.query('DELETE FROM aqua_scheduler_leases WHERE name = $1', [connectLeaseName(o)]);
    await p.query('DELETE FROM aqua_owner_versions WHERE owner_id = $1', [o]);
  }
  await closePool();
});

let n = 0;
function newCase(tag) {
  const userId = `u-wcf-${RUN}-${tag}-${++n}`;
  OWNERS.push(`user:${userId}`);
  return { userId, owner: `user:${userId}`, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-wcf-case-')) };
}
function child(args) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-wcf-proc-'));
  const env = { ...process.env, DATABASE_URL: DB_URL, AQUA_DATA_DIR: scratch, HOME: scratch, USERPROFILE: scratch,
    AQUA_STORE_PARTITIONS: PARTITIONS, AQUA_DISABLE_MONGO_MIRROR: '1' };
  // No provider keys: the syncer's embeddings come from the in-process test embedder only.
  for (const k of ['MONGO_URI', 'MONGODB_URI', 'AQUA_CONNECTOR_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'HF_TOKEN', 'AQUA_E6', 'AQUA_EMBEDDINGS']) delete env[k];
  for (const k of Object.keys(env)) if (/^GEMINI_KEY_\d+$|_API_KEY(_\d+)?$/.test(k)) delete env[k];
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CHILD, JSON.stringify(args)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
const waitFor = async (dir, name, ms = 60_000) => {
  const until = Date.now() + ms;
  while (!fs.existsSync(path.join(dir, name))) { if (Date.now() > until) throw new Error(`timed out waiting for ${name}`); await new Promise(r => setTimeout(r, 20)); }
};
const go = dir => fs.writeFileSync(path.join(dir, 'go'), String(Date.now()));

test('write-carried fence live: Postgres is available', { skip }, () => { assert.ok(LIVE); });

describe('write-carried fence live · separate Node processes', { skip }, () => {
  test('L1 · late work finishing after another process acquired, deleted and released is REFUSED; nothing of the source remains', async t => {
    const c = newCase('l1');
    const syncP = child({ mode: 'syncer', userId: c.userId, dir: c.dir });
    const d = await child({ mode: 'deleter', userId: c.userId, dir: c.dir });
    go(c.dir);
    const s = await syncP;
    const v = await child({ mode: 'verify', userId: c.userId, dir: c.dir });
    t.diagnostic(`L1: syncer pid ${s.pid} lateFlush=${s.lateFlush} fenceRefused=${s.fenceRefused} timer=${s.timerResult} lateAfterMs=${s.lateAfterMs}; deleter pid ${d.pid} complete=${d.complete}; db ukos=${v.ukos.length} extFacts=${v.extFacts.length} claimVectors=${v.claimVectors}`);
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(d.complete, true, JSON.stringify(d));
    assert.notEqual(s.pid, d.pid);
    assert.equal(s.timerResult, 'saved', 'precondition: the background timer ran');
    assert.ok(s.fenceRefused > 0 && s.fencesLost > 0, `the late work was not refused by the fence: ${JSON.stringify(s)}`);
    assert.ok(['WRITE_FENCE_LOST', 'flushed'].includes(s.lateFlush), JSON.stringify(s));   // refused by the explicit or the background flush
    assert.deepEqual(v.ukos, [], 'a late write re-created an external UKO');
    assert.deepEqual(v.extFacts, []);
    assert.equal(v.claimVectors, 0, 'a late claim vector landed after the source was deleted');
  });

  test('L2 · control: with no acquisition since, the late work lands — after the old 2×TTL window (no time limit)', async t => {
    const c = newCase('l2');
    const syncP = child({ mode: 'syncer', userId: c.userId, dir: c.dir, ttlMs: 1000 });
    await waitFor(c.dir, 'synced');
    await new Promise(r => setTimeout(r, 2600));          // > 2 × TTL (the old trailing window)
    go(c.dir);
    const s = await syncP;
    const v = await child({ mode: 'verify', userId: c.userId, dir: c.dir });
    t.diagnostic(`L2: syncer pid ${s.pid} lateFlush=${s.lateFlush} fenceRefused=${s.fenceRefused} timer=${s.timerResult} lateAfterMs=${s.lateAfterMs}; db ukos=${v.ukos.length} extFacts=${v.extFacts.length} claimVectors=${v.claimVectors} external=${v.externalClaimVectors}`);
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.ok(s.lateAfterMs >= 2600, `precondition: the late work finished ${s.lateAfterMs} ms after the sync`);
    assert.equal(s.lateFlush, 'flushed', JSON.stringify(s));
    assert.equal(s.fenceRefused, 0, `a valid ended operation's late work was refused: ${JSON.stringify(s)}`);
    assert.ok(v.ukos.some(k => k.endsWith('_timerlate')), 'the valid late timer write did not land');
    assert.ok(v.extFacts.length >= 1);
    assert.equal(v.externalClaimVectors, v.extFacts.length, 'the valid late claim vectors did not land');
  });

  test('L3 · late work racing another process\'s deletion (3 rounds): nothing of the source remains; the deletion is complete', async t => {
    for (let round = 1; round <= 3; round++) {
      const c = newCase(`l3r${round}`);
      const syncP = child({ mode: 'syncer', userId: c.userId, dir: c.dir });
      const delP = child({ mode: 'deleter', userId: c.userId, dir: c.dir });
      await waitFor(c.dir, 'synced');
      go(c.dir);                                           // the late work and the deletion start together
      const [s, d] = await Promise.all([syncP, delP]);
      const v = await child({ mode: 'verify', userId: c.userId, dir: c.dir });
      t.diagnostic(`L3 round ${round}: lateFlush=${s.lateFlush} fenceRefused=${s.fenceRefused} timer=${s.timerResult}; deleter complete=${d.complete}; db ukos=${v.ukos.length} extFacts=${v.extFacts.length} claimVectors=${v.claimVectors}`);
      assert.equal(s.ok, true, JSON.stringify(s));
      assert.equal(d.complete, true, JSON.stringify(d));
      assert.deepEqual(v.ukos, [], `round ${round}: an external UKO remains`);
      assert.deepEqual(v.extFacts, [], `round ${round}: an external fact remains`);
      assert.equal(v.claimVectors, 0, `round ${round}: a claim vector remains`);
    }
  });

  test('L4 · late work finishing INSIDE a new operation of the same process (after another acquisition) is REFUSED; the new operation\'s own write lands', async t => {
    const c = newCase('l4');
    const syncP = child({ mode: 'syncer', userId: c.userId, dir: c.dir, newOp: true });
    const l = await child({ mode: 'locker', userId: c.userId, dir: c.dir });
    go(c.dir);
    const s = await syncP;
    const v = await child({ mode: 'verify', userId: c.userId, dir: c.dir });
    t.diagnostic(`L4: syncer pid ${s.pid} lateFlush=${s.lateFlush} fenceRefused=${s.fenceRefused} ownWrite=${s.ownWrite}; locker pid ${l.pid} released=${l.released}; db ukos=${JSON.stringify(v.ukos.map(k => k.slice(k.lastIndexOf('_'))))} claimVectors=${v.claimVectors}`);
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(l.released, true);
    assert.ok(s.fenceRefused > 0 && s.fencesLost > 0, `old work was authorised by the newer fence: ${JSON.stringify(s)}`);
    assert.ok(['WRITE_FENCE_LOST', 'flushed'].includes(s.lateFlush), JSON.stringify(s));
    assert.ok(!v.ukos.some(k => k.endsWith('_timerlate')), 'the old timer write landed under the new fence');
    assert.equal(v.claimVectors, 0, 'old claim vectors landed under the new fence');
    assert.ok(v.ukos.some(k => k.endsWith('_newop')), 'the new operation\'s own write did not land');
  });
});
