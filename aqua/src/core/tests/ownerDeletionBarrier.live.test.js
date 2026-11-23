/**
 * Account deletion as the AUTHORITATIVE ordering barrier — on a REAL
 * PostgreSQL, with TWO SEPARATE NODE PROCESSES (fixtures/barrierChild.mjs)
 * sharing state only through the database.
 *
 *   B1  in-flight write vs deletion: a writer holds its transaction open (the
 *       barrier taken, the INSERT pending); markOwnerDeleted in the other
 *       process WAITS for it, and the purge then tombstones what it wrote.
 *   B2  writer racing account deletion (tight INSERT + UPDATE loop, stale
 *       negative cache): nothing of the owner is live afterwards; another
 *       owner's writes from the same process are untouched.
 *   B3  the same with the writer inside a HELD connect lease (active fence).
 *   B4  after the deletion, from a new process: INSERT, UPDATE, tombstone
 *       recreation, child insert and lease acquisition are refused
 *       (OWNER_DELETED); prefix/group deletions still land.
 *   B5  a finished connect operation's TRAILING fence cannot write after it.
 *   B6  conversation-level recreation still works for a live owner.
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
const { isConfigured, getPool, closePool } = await import('../db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';
const CHILD = fileURLToPath(new URL('./fixtures/barrierChild.mjs', import.meta.url));
const S = '.aqua-barrier-live.json';
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
    await p.query('DELETE FROM aqua_deleted_owners WHERE owner_id = $1', [o]);
    await p.query('DELETE FROM aqua_scheduler_leases WHERE name = $1', [connectLeaseName(o)]);
    await p.query('DELETE FROM aqua_owner_versions WHERE owner_id = $1', [o]);
  }
  await closePool();
});

let n = 0;
const newOwner = tag => { const o = `user:u-barrier-${RUN}-${tag}-${++n}`; OWNERS.push(o); return o; };
const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-barrier-case-'));
function child(args) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-barrier-proc-'));
  const env = { ...process.env, DATABASE_URL: DB_URL, AQUA_DATA_DIR: scratch, HOME: scratch, USERPROFILE: scratch,
    AQUA_EMBEDDINGS: 'off', AQUA_DISABLE_MONGO_MIRROR: '1' };
  for (const k of ['MONGO_URI', 'MONGODB_URI', 'AQUA_CONNECTOR_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'HF_TOKEN']) delete env[k];
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
const liveRows = async o => Number((await p.query('SELECT count(*)::int n FROM aqua_store_partitions WHERE owner_id = $1 AND deleted_at IS NULL', [o])).rows[0].n);
const rowOf = async key => (await p.query('SELECT data, deleted_at FROM aqua_store_partitions WHERE store_key = $1 AND partition_key = $2', [S, key])).rows[0] ?? null;
const marked = async o => (await p.query('SELECT 1 FROM aqua_deleted_owners WHERE owner_id = $1', [o])).rows.length === 1;

test('owner deletion barrier live: Postgres is available', { skip }, () => { assert.ok(LIVE); });

describe('owner deletion barrier live · two separate Node processes', { skip }, () => {
  test('B1 · a write in flight when the account is deleted: the marker WAITS for it, the purge then removes it', async t => {
    const o = newOwner('b1'); const dir = newDir();
    const [w, m] = await Promise.all([child({ mode: 'slow-writer', owner: o, dir }), child({ mode: 'marker', owner: o, dir })]);
    assert.equal(w.ok, true, JSON.stringify(w));
    assert.equal(m.ok, true, JSON.stringify(m));
    assert.notEqual(w.pid, m.pid);
    t.diagnostic(`B1 evidence: writer pid ${w.pid} result=${w.result}; marker pid ${m.pid} waited ${m.waitedMs} ms; marker committed ${m.markedAt - w.committedAt} ms after the write; purge tombstoned ${m.tombstoned}`);
    assert.equal(w.result, 'written', 'the in-flight write (begun before the deletion) should commit — ordered BEFORE the marker');
    assert.ok(m.waitedMs >= 600, `markOwnerDeleted did not wait for the in-flight write (${m.waitedMs} ms)`);
    assert.ok(m.markedAt >= w.committedAt - 50, 'the marker committed before the in-flight write');
    const r = await rowOf(`slow:${o}`);
    assert.ok(r, 'the in-flight write never reached the table');
    assert.notEqual(r.deleted_at, null, 'the purge did not see the write ordered before the marker');
    assert.equal(await liveRows(o), 0);
    assert.equal(await marked(o), true);
  });

  for (const [tag, lease] of [['b2', false], ['b3', true]]) {
    test(`${tag.toUpperCase()} · a writer racing account deletion${lease ? ' INSIDE A HELD CONNECT LEASE' : ''} cannot leave or re-create owner data`, async t => {
      for (let round = 1; round <= 3; round++) {
        const o = newOwner(`${tag}r${round}`); const other = newOwner(`${tag}x${round}`); const dir = newDir();
        const [w, pg] = await Promise.all([
          child({ mode: 'stress', owner: o, other, dir, lease }),
          child({ mode: 'purger', owner: o, dir }),
        ]);
        assert.equal(w.ok, true, JSON.stringify(w));
        assert.equal(pg.ok, true, JSON.stringify(pg));
        t.diagnostic(`${tag} round ${round}: writer pid ${w.pid} inserted=${w.inserted} updated=${w.updated} refused=${w.refused} other=${w.other} otherOwnerWrites=${w.otherOwnerWrites}; purger pid ${pg.pid} waited ${pg.waitedMs} ms tombstoned=${pg.tombstoned}`);
        assert.ok(w.inserted + w.updated > 0, `round ${round}: the writer never wrote before the deletion: ${JSON.stringify(w)}`);
        assert.ok(w.refused > 0, `round ${round}: the writer was never refused: ${JSON.stringify(w)}`);
        assert.equal(w.other, 0, `round ${round}: unexpected errors: ${JSON.stringify(w)}`);
        assert.equal(await liveRows(o), 0, `round ${round}: owner data is live after the account deletion: ${JSON.stringify(w)}`);
        assert.equal(await liveRows(other), w.otherOwnerWrites, `round ${round}: another owner's writes were affected`);
      }
    });
  }

  test('B4 · after the deletion, every write path from another process is refused; deletions still land', async () => {
    const o = newOwner('b4'); const dir = newDir();
    const [w] = await Promise.all([child({ mode: 'stress', owner: o, dir }), child({ mode: 'purger', owner: o, dir })]);
    assert.equal(w.ok, true, JSON.stringify(w));
    await p.query(`INSERT INTO aqua_store_partitions (store_key, partition_key, owner_id, data, bytes, version, deleted_at, updated_at)
                   VALUES ($1, $2, $3, NULL, 0, 1, now(), now()) ON CONFLICT DO NOTHING`, [S, `g:${o}`, o]);
    const late = await child({ mode: 'late', owner: o, dir });
    assert.equal(late.ok, true, JSON.stringify(late));
    for (const k of ['insert', 'update', 'recreate', 'child', 'lease']) assert.equal(late[k], 'OWNER_DELETED', `${k}: ${JSON.stringify(late)}`);
    assert.equal(late.prefixTombstones, 0, 'the purge already tombstoned them');
    assert.equal(await liveRows(o), 0);
  });

  test('B5 · late work of a finished connect operation (its ENDED fence) cannot write after the deletion', async () => {
    const o = newOwner('b5'); const dir = newDir();
    const [t, pg] = await Promise.all([child({ mode: 'trailing', owner: o, dir }), child({ mode: 'purger', owner: o, dir })]);
    assert.equal(pg.ok, true, JSON.stringify(pg));
    assert.equal(t.ok, true, JSON.stringify(t));
    assert.equal(t.trailing, true, 'precondition: the operation ended with its fence still valid (its late work carries it)');
    assert.equal(t.late, 'OWNER_DELETED', JSON.stringify(t));
    assert.equal(await rowOf(`tr2:${o}`), null);
    assert.equal(await liveRows(o), 0);
  });

  test('B6 · conversation-level recreation still works for a live owner (real PostgreSQL)', async () => {
    const o = newOwner('b6');
    const { createPartitionRepository } = await import('../storage/partitionRepository.js');
    const repo = createPartitionRepository({ pool: p });
    await repo.put(S, `c:${o}:conv`, '{"t":"old"}', { ownerId: o, expectedVersion: 0 });
    await repo.update(S, `c:${o}:conv`, () => null, { ownerId: o });
    const r = await repo.update(S, `c:${o}:conv`, (_t, meta) => (meta.deleted ? '{"t":"recreated"}' : undefined), { ownerId: o });
    assert.equal(r.changed, true);
    assert.equal((await rowOf(`c:${o}:conv`)).data, '{"t":"recreated"}');
  });
});
