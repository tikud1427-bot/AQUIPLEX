/**
 * Safety Fix 2 on a REAL PostgreSQL with TWO SEPARATE NODE PROCESSES
 * (fixtures/xdwChild.mjs): one instance keeps editing the source's EXTERNAL
 * facts the way propagation and PIC consolidation do, another disconnects the
 * source. Nothing under the source's prefix may remain in the database, and
 * the disconnect's reported completion must match the database.
 *
 *   X1  editor commits immediately BEFORE the deletion, then edits its STALE
 *       copy and commits immediately AFTER it (3 rounds).
 *   X2  editor edits and commits in a tight loop across the deletion (3 rounds).
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
const CHILD = fileURLToPath(new URL('./fixtures/xdwChild.mjs', import.meta.url));
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
  const userId = `u-xdw-${RUN}-${tag}-${++n}`;
  OWNERS.push(`user:${userId}`);
  return { userId, owner: `user:${userId}`, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-xdw-case-')) };
}
function child(args) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-xdw-proc-'));
  const env = { ...process.env, DATABASE_URL: DB_URL, AQUA_DATA_DIR: scratch, HOME: scratch, USERPROFILE: scratch,
    AQUA_STORE_PARTITIONS: PARTITIONS, AQUA_EMBEDDINGS: 'off', AQUA_DISABLE_MONGO_MIRROR: '1' };
  for (const k of ['MONGO_URI', 'MONGODB_URI', 'AQUA_CONNECTOR_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'HF_TOKEN', 'AQUA_E6']) delete env[k];
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
const sum = r => Object.values(r ?? { x: NaN }).reduce((a, b) => a + b, 0);
/** Independent raw check: any live row of the owner whose JSON still names an id under the prefix as a KEY or a source. */
async function rawHolds(owner, ukoPrefix, keyPrefix) {
  const { rows } = await p.query('SELECT store_key, data FROM aqua_store_partitions WHERE owner_id = $1 AND deleted_at IS NULL', [owner]);
  const hits = [];
  for (const r of rows) {
    const d = JSON.parse(r.data ?? 'null');
    if (r.store_key === '.aqua-uko.json') for (const k of Object.keys(d ?? {})) if (k.startsWith(ukoPrefix)) hits.push(`uko:${k}`);
    if (r.store_key === '.aqua-evidence.json') {
      for (const k of Object.keys(d?.byFile ?? {})) if (k.startsWith(ukoPrefix)) hits.push(`byFile:${k}`);
      for (const e of Object.values(d?.evidence ?? {})) if (String(e?.sourceFileId ?? '').startsWith(ukoPrefix)) hits.push(`evidence:${e.id}`);
      for (const f of Object.values(d?.facts ?? {})) if (String(f?.review?.text ?? '').startsWith('editor-')) hits.push(`edited-fact:${f.id}`);
    }
    if (r.store_key === '.aqua-fileindex.json') for (const k of Object.keys(d?.files ?? {})) if (k.startsWith(ukoPrefix)) hits.push(`index:${k}`);
    if (r.store_key === '.aqua-mind.json') for (const k of Object.keys(d?.files ?? {})) if (k.startsWith(keyPrefix)) hits.push(`mind:${k}`);
    if (r.store_key === '.aqua-reasoning-graph.json') for (const k of Object.keys(d?.byFile ?? {})) if (k.startsWith(ukoPrefix)) hits.push(`graph:${k}`);
  }
  return hits;
}

test('external deletion wins live: Postgres is available', { skip }, () => { assert.ok(LIVE); });

describe('external deletion wins live · two separate Node processes', { skip }, () => {
  for (const phase of ['around', 'loop']) {
    const tag = phase === 'around' ? 'X1' : 'X2';
    const title = phase === 'around'
      ? 'X1 · the editor commits immediately BEFORE the deletion and its stale copy immediately AFTER: nothing remains; completion matches the database'
      : 'X2 · the editor edits and commits in a tight loop across the deletion: nothing remains; completion matches the database';
    test(title, async t => {
      for (let round = 1; round <= 3; round++) {
        const c = newCase(`${tag.toLowerCase()}r${round}`);
        const s = await child({ mode: 'sync', userId: c.userId, dir: c.dir, tokens: [`Kestrel${round}`, `Larkspur${round}`] });
        assert.equal(s.ok, true, JSON.stringify(s));
        const [e, d] = await Promise.all([
          child({ mode: 'editor', userId: c.userId, dir: c.dir, phase }),
          child({ mode: 'deleter', userId: c.userId, dir: c.dir, waitFor: phase === 'around' ? 'edited' : 'editing' }),
        ]);
        assert.equal(e.ok, true, JSON.stringify(e));
        assert.equal(d.ok, true, JSON.stringify(d));
        assert.notEqual(e.pid, d.pid);
        assert.ok(e.edits > 0, `round ${round}: the editor edited nothing: ${JSON.stringify(e)}`);
        const v = await child({ mode: 'verify', userId: c.userId, dir: c.dir });
        assert.equal(v.ok, true, JSON.stringify(v));
        const raw = await rawHolds(c.owner, v.ukoPrefix, v.keyPrefix);
        t.diagnostic(`${tag} round ${round}: editor pid ${e.pid} rounds=${e.rounds} edits=${e.edits} flushErrors=${e.flushErrors}; deleter pid ${d.pid} complete=${d.complete} removedFacts=${d.removedFacts} errors=${JSON.stringify(d.errors)}; database remaining=${sum(v.remaining)} raw=${raw.length}`);
        assert.equal(sum(v.remaining), 0, `round ${round}: external items remain in the database: ${JSON.stringify(v.remaining)}`);
        assert.deepEqual(raw, [], `round ${round}: raw rows still hold the deleted source`);
        assert.equal(d.complete, sum(v.remaining) === 0, `round ${round}: reported complete=${d.complete} but the database holds ${sum(v.remaining)}`);
        assert.equal(d.complete, true, `round ${round}: ${JSON.stringify(d)}`);
      }
    });
  }
});
