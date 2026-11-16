/**
 * Per-store migration matrix (scalability Phase 2b, step 6), against a REAL
 * Postgres. For every store integrated in Phase 2b:
 *
 *   dry-run → nothing written        apply → every partition inserted
 *   reconcile → counts + hashes      export → equals the source
 *   re-run → idempotent              rollback → the exported file, loaded by a
 *                                    real process with the flag OFF, serves the data
 * and an INTERRUPTED migration (the CLI killed mid-apply) resumes without loss
 * or duplication. Concurrent writes and deletions per store are covered by each
 * store's own suite (see AQUIPLEX_PHASE_2B_REPORT.md §5).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { migrateStoreText, reconcileStore, exportStore } from '../storage/partitionMigration.js';
import { splitStore, canonicalChecksum } from '../storage/partitionLayout.js';
import { runProcess, tempDir, acquireStoreKeyLock } from './helpers/multiProcess.mjs';

const LIVE = Boolean(process.env.DATABASE_URL);
let releaseLock = null;
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'partition-migrate.mjs');
let pool;

const env = data => ({ __aqua: { schema: 1, savedAt: 1_700_000_000_000 }, data });
const OWNERS = 120;
const owners = Array.from({ length: OWNERS }, (_, i) => `user:${i}`);

/** Realistic fixtures + one reader per store for the rollback check. */
const STORES = {
  '.aqua-reflection.json': {
    text: JSON.stringify(env(Object.fromEntries(owners.map((o, i) => [o, {
      snapshot: { nodes: { [`ent:${i}`]: { label: `E${i}` } }, edges: {}, takenAt: 1000 + i }, lastReflectionAt: 1000 + i, lastSurfacedAt: 2000 + i }])))),
    read: { op: 'call', module: 'reflection', fn: 'loadSurfacedAt', args: ['user:7'] }, expect: 2007,
  },
  '.aqua-mind.json': {
    text: JSON.stringify({ __aqua: { schema: 1, savedAt: 1, deletedOwners: { 'user:gone': 5 } }, data: Object.fromEntries(owners.map((o, i) => [o, {
      version: 2, ownerId: o, updatedAt: 3000 + i, facts: { city: { key: 'city', value: `City${i}`, ts: 3000 + i } }, files: {}, beliefs: {}, goals: {}, episodes: {},
      tombstones: { facts: { old: 1 } }, graph: { nodes: {}, edges: {} } }])) }),
    read: { op: 'mindFacts', owner: 'user:7' }, expect: { city: 'City7' },
  },
  '.aqua-recall-redactions.json': {
    text: JSON.stringify(env(Object.fromEntries(owners.map((o, i) => [o, { forgetAllAt: 4000 + i, phrases: { [`h${i}`]: { n: 1, at: 4000 + i } } }])))),
    read: { op: 'isRedacted', owner: 'user:7', sentence: 'anything', ts: 3000 }, expect: true,   // before forgetAllAt 4007
  },
  '.aqua-history.json': {
    text: JSON.stringify(env(Object.fromEntries(owners.slice(0, 40).map((o, i) => [`conv-${i}`, {
      messages: Array.from({ length: 6 }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', content: `c${i}m${k}`, ts: 5000 + k })),
      meta: { userId: String(i), title: `T${i}`, createdAt: 5000 } }])))),
    read: { op: 'convText', id: 'conv-7' }, expect: ['c7m0', 'c7m1', 'c7m2', 'c7m3', 'c7m4', 'c7m5'],
  },
  '.aqua-reasoning-graph.json': {
    text: JSON.stringify(env(Object.fromEntries(owners.map((o, i) => [o, {
      nodes: { [`n${i}`]: { id: `n${i}`, type: 'entity', label: `N${i}`, data: {}, sourceFiles: ['f'], createdAt: 6000 } },
      edges: {}, byFile: { f: { nodes: [`n${i}`], edges: [] } } }])))),
    read: { op: 'call', module: 'graph', fn: 'getNode', args: ['user:7', 'n7'] }, expectLabel: 'N7',
  },
  '.aqua-ids.json': {
    text: JSON.stringify(env(Object.fromEntries(owners.map((o, i) => [o, {
      [`ent:${i}`]: { kind: 'person', canonical: `P${i}`, norms: [`p${i}`], refs: [], createdAt: 7000, updatedAt: 7000 } }])))),
    read: { op: 'call', module: 'ids', fn: 'getEntry', args: ['user:7', 'ent:7'] }, expectCanonical: 'P7',
  },
};
const KEYS = Object.keys(STORES);

before(async () => {
  if (!LIVE) return;
  releaseLock = await acquireStoreKeyLock();
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  await (await import('../db/migrate.js')).migrate();
  await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = ANY($1)', [KEYS]);
});
after(async () => {
  if (!LIVE) return;
  try {
  await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = ANY($1)', [KEYS]);
  await pool.end();
  await (await import('../db/pool.js')).closePool();
  } finally { await releaseLock?.(); }
});

const count = async key => Number((await pool.query('SELECT count(*) FROM aqua_store_partitions WHERE store_key = $1', [key])).rows[0].count);
const ownerCounts = async key => Object.fromEntries((await pool.query(
  `SELECT owner_id, count(*)::int AS n FROM aqua_store_partitions WHERE store_key = $1 AND deleted_at IS NULL GROUP BY owner_id`, [key])).rows.map(r => [r.owner_id, r.n]));

describe('per-store migration matrix — real Postgres', { skip }, () => {
  for (const [key, spec] of Object.entries(STORES)) {
    test(`${key}: dry-run, apply, counts+hashes, export, idempotent re-run, rollback load`, async () => {
      const expected = splitStore(key, spec.text).partitions;

      // dry-run: nothing written
      const dry = await migrateStoreText({ storeKey: key, text: spec.text, mode: 'dry-run', pool });
      assert.equal(dry.wouldInsert, expected.length);
      assert.equal(await count(key), 0, 'dry-run wrote nothing');

      // apply: every partition, owner counts equal the source's
      const app = await migrateStoreText({ storeKey: key, text: spec.text, mode: 'apply', pool });
      assert.equal(app.inserted, expected.length);
      const want = {};
      for (const p of expected) want[p.ownerId] = (want[p.ownerId] ?? 0) + 1;
      assert.deepEqual(await ownerCounts(key), want, 'per-owner row counts match the source');

      // reconcile: counts AND canonical hashes
      const rec = await reconcileStore({ storeKey: key, text: spec.text, pool });
      assert.equal(rec.clean, true, JSON.stringify(rec));
      assert.equal(rec.partitionsChecksum, canonicalChecksum(spec.text));

      // export (the rollback file) equals the source
      const out = await exportStore({ storeKey: key, pool });
      assert.deepEqual(JSON.parse(out), JSON.parse(spec.text));

      // idempotent: a second apply inserts nothing, duplicates nothing
      const again = await migrateStoreText({ storeKey: key, text: spec.text, mode: 'apply', pool });
      assert.equal(again.inserted, 0);
      assert.equal(again.identical, expected.length);
      assert.equal(await count(key), expected.length + (app.tombstonesCreated ?? 0), 'no duplicate rows');

      // rollback: the exported file, in a data dir, served by a real process with the flag OFF
      const dir = tempDir('aq-mx-');
      fs.writeFileSync(path.join(dir, key), out);
      const r = await runProcess({ dataDir: dir, partitions: '', database: false }, [spec.read]);
      const got = r[0];
      if ('expect' in spec) assert.deepEqual(got, spec.expect);
      if (spec.expectLabel) assert.equal(got?.label, spec.expectLabel);
      if (spec.expectCanonical) assert.equal(got?.canonical, spec.expectCanonical);
    });
  }

  test('an interrupted migration (process killed mid-apply) resumes with no loss and no duplicates', async () => {
    const key = '.aqua-history.json';
    await pool.query('DELETE FROM aqua_store_partitions WHERE store_key = $1', [key]);
    // ~12,000 rows → ~60 transactions of 200: long enough to kill part-way.
    const text = JSON.stringify(env(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`big-${i}`, {
      messages: Array.from({ length: 30 }, (_, k) => ({ role: 'user', content: `b${i}.${k} ${'x'.repeat(200)}`, ts: k })),
      meta: { userId: String(i % 50) } }]))));
    const expected = splitStore(key, text).partitions.length;
    const src = path.join(tempDir('aq-int-'), key);
    fs.writeFileSync(src, text);

    const child = spawn(process.execPath, [CLI, '--db', process.env.DATABASE_URL, '--store', 'history', '--from', src, '--mode', 'apply'],
      { stdio: 'ignore', env: { ...process.env, DATABASE_URL: '' } });
    const t0 = Date.now();
    while ((await count(key)) === 0 && Date.now() - t0 < 30_000) await new Promise(r => setTimeout(r, 20));
    child.kill('SIGKILL');
    await new Promise(r => child.on('exit', r));
    const partial = await count(key);
    assert.ok(partial > 0 && partial < expected, `killed part-way: ${partial} of ${expected} rows`);
    assert.equal(partial % 200, 0, 'each batch is all-or-nothing: no half-written batch');

    const resumed = await migrateStoreText({ storeKey: key, text, mode: 'apply', pool });
    assert.equal(resumed.inserted + resumed.identical, expected);
    assert.equal(resumed.conflicting, 0);
    assert.equal(await count(key), expected, 'every row exactly once');
    const rec = await reconcileStore({ storeKey: key, text, pool });
    assert.equal(rec.clean, true);
  });

  test('the CLI refuses a non-local database and never reads DATABASE_URL from the environment', async () => {
    const run = args => new Promise(res => {
      const c = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL } });
      let err = ''; c.stderr.on('data', d => { err += d; });
      c.on('exit', code => res({ code, err }));
    });
    const remote = await run(['--db', 'postgresql://u:p@db.example.com:5432/x', '--store', 'mind', '--from', 'pg-blob']);
    assert.equal(remote.code, 2);
    assert.match(remote.err, /refusing non-local database host/);
    const none = await run(['--store', 'mind', '--from', 'pg-blob']);
    assert.equal(none.code, 2);
    assert.match(none.err, /--db <postgres url> is required/);
  });
});
