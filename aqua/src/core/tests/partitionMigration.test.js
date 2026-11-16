/**
 * Whole-file store → partitions: migrate, reconcile, export (Phase 2a),
 * against a REAL Postgres. Skipped loudly without DATABASE_URL.
 *
 * The rollback guarantee under test: export(migrate(F)) parses to exactly F,
 * so the existing JSON code can load the result unchanged.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { migrateStoreText, reconcileStore, exportStore, readBlobSource } from '../storage/partitionMigration.js';
import { createPartitionRepository, TABLE } from '../storage/partitionRepository.js';
import { acquireStoreKeyLock } from './helpers/multiProcess.mjs';

const LIVE = Boolean(process.env.DATABASE_URL);
let releaseLock = null;
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres';
const RUN = crypto.randomBytes(4).toString('hex');
const BLOB_KEY = `.test-${RUN}-blob.json`;
// Real store keys (the layout is keyed by them). Only tests write this table.
const KEYS = ['.aqua-mind.json', '.aqua-history.json', '.aqua-uko.json'];
let pg, pool;

const wipe = () => pool.query(`DELETE FROM ${TABLE} WHERE store_key = ANY($1)`, [[...KEYS, BLOB_KEY]]);

before(async () => {
  if (!LIVE) return;
  releaseLock = await acquireStoreKeyLock();
  pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  await (await import('../db/migrate.js')).migrate();
  await wipe();
});

after(async () => {
  if (!LIVE) return;
  try {
  await wipe();
  await pool.query('DELETE FROM aqua_store_blobs WHERE store_key = $1', [BLOB_KEY]);
  await pool.query('DELETE FROM aqua_store_partition_runs WHERE store_key = ANY($1)', [[...KEYS, BLOB_KEY]]);
  await pool.end();
  await (await import('../db/pool.js')).closePool();
  } finally { await releaseLock?.(); }
});

const mindFile = (owners = 50) => JSON.stringify({
  __aqua: { schema: 1, savedAt: 1731400000000, deletedOwners: { 'user:gone': 1731300000000 } },
  data: Object.fromEntries(Array.from({ length: owners }, (_, i) => [`user:${i}`, {
    version: 2, facts: { name: { value: `N${i}`, ts: i } }, tombstones: { facts: { old: 1 } },
  }])),
});

describe('partition migration — against Postgres', { skip }, () => {
  test('dry-run writes nothing and says what it would do', async () => {
    const text = mindFile();
    const r = await migrateStoreText({ storeKey: '.aqua-mind.json', text, mode: 'dry-run', pool });
    assert.equal(r.wouldInsert, 51);              // 50 owners + ~rest
    assert.equal(r.inserted, 0);
    assert.equal(r.impliedTombstones, 1, 'the envelope\'s deleted owner');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE store_key='.aqua-mind.json'`);
    assert.equal(rows[0].n, 0);
  });

  test('apply → reconcile clean → export equals the source', async () => {
    const text = mindFile();
    const r = await migrateStoreText({ storeKey: '.aqua-mind.json', text, mode: 'apply', pool });
    assert.equal(r.inserted, 51);
    assert.equal(r.tombstonesCreated, 1);
    assert.equal(r.owners, 50);

    const rec = await reconcileStore({ storeKey: '.aqua-mind.json', text, pool });
    assert.equal(rec.clean, true, JSON.stringify(rec));

    const out = await exportStore({ storeKey: '.aqua-mind.json', pool });
    assert.deepEqual(JSON.parse(out), JSON.parse(text));
    assert.equal(out, text, 'compact source → identical text');
  });

  test('an owner deleted in the envelope is a tombstone a stale writer cannot fill', async () => {
    const repo = createPartitionRepository({ pool, instanceId: 'stale' });
    const cur = await repo.get('.aqua-mind.json', 'o:user:gone');
    assert.equal(cur.deleted, true);
    await assert.rejects(repo.put('.aqua-mind.json', 'o:user:gone', '{"facts":{}}', { ownerId: 'user:gone', expectedVersion: 0 }));
  });

  test('a second apply is a no-op: idempotent', async () => {
    const r = await migrateStoreText({ storeKey: '.aqua-mind.json', text: mindFile(), mode: 'apply', pool });
    assert.equal(r.inserted, 0);
    assert.equal(r.identical, 51);
    assert.equal(r.conflicting, 0);
  });

  test('a partition changed after cutover is never overwritten by an old file', async () => {
    const repo = createPartitionRepository({ pool, instanceId: 'live' });
    await repo.update('.aqua-mind.json', 'o:user:3', () => '{"version":2,"facts":{"name":{"value":"NEW"}}}', { ownerId: 'user:3' });
    const r = await migrateStoreText({ storeKey: '.aqua-mind.json', text: mindFile(), mode: 'apply', pool });
    assert.equal(r.conflicting, 1);
    assert.equal(r.conflicts[0].partitionKey, 'o:user:3');
    assert.equal(r.inserted, 0);
    const now = await repo.get('.aqua-mind.json', 'o:user:3', { fresh: true });
    assert.match(now.data, /NEW/);
    const rec = await reconcileStore({ storeKey: '.aqua-mind.json', text: mindFile(), pool });
    assert.equal(rec.clean, false);
    assert.equal(rec.mismatched, 1);
  });

  test('a purged owner is absent from the export (the rollback carries the deletion)', async () => {
    const repo = createPartitionRepository({ pool, instanceId: 'purge' });
    await repo.purgeOwner('user:4');
    const out = JSON.parse(await exportStore({ storeKey: '.aqua-mind.json', pool }));
    assert.equal('user:4' in out.data, false);
    assert.equal('user:5' in out.data, true);
  });

  test('conversations: owners derived from meta.userId survive the round trip', async () => {
    const text = JSON.stringify({ __aqua: { schema: 1, savedAt: 1 }, data: {
      c1: { messages: [{ role: 'user', content: 'a' }], meta: { userId: '42' } },
      c2: { messages: [], meta: {} },
    } });
    await migrateStoreText({ storeKey: '.aqua-history.json', text, mode: 'apply', pool });
    const { rows } = await pool.query(`SELECT partition_key, owner_id FROM ${TABLE} WHERE store_key='.aqua-history.json' ORDER BY ordinal NULLS LAST`);
    assert.deepEqual(rows.map(r => [r.partition_key, r.owner_id]), [['c:c1', 'user:42'], ['m:c1:0-000000', 'user:42'], ['c:c2', 'conv:c2'], ['~rest', '']]);
    assert.equal(await exportStore({ storeKey: '.aqua-history.json', pool }), text);
  });

  test('uko: two sections, one of them global, round-trip through the database', async () => {
    const text = JSON.stringify({ __aqua: { schema: 1, savedAt: 1 }, data: {
      owners: { 'user:1': { u1: { id: 'u1' } } }, cache: { h1: { s: 1 } },
    } });
    await migrateStoreText({ storeKey: '.aqua-uko.json', text, mode: 'apply', pool });
    assert.equal((await reconcileStore({ storeKey: '.aqua-uko.json', text, pool })).clean, true);
    assert.equal(await exportStore({ storeKey: '.aqua-uko.json', pool }), text);
  });

  test('the E3 blob table is a valid source', async () => {
    const text = JSON.stringify({ whatever: [1, 2, 3] });
    await pool.query(
      `INSERT INTO aqua_store_blobs (store_key, data, bytes, checksum, version) VALUES ($1, $2, $3, 'x', 1)`,
      [BLOB_KEY, text, text.length]);
    const src = await readBlobSource(BLOB_KEY, { pool });
    const r = await migrateStoreText({ storeKey: BLOB_KEY, text: src, mode: 'apply', source: 'pg-blob', pool });
    assert.equal(r.inserted, 1);
    assert.equal(await exportStore({ storeKey: BLOB_KEY, pool }), text);
  });

  test('every run is recorded with its source checksum', async () => {
    const { rows } = await pool.query(
      `SELECT kind, mode, source, clean FROM aqua_store_partition_runs WHERE store_key = '.aqua-mind.json' ORDER BY run_id`);
    const kinds = rows.map(r => `${r.kind}/${r.mode}`);
    assert.ok(kinds.includes('migrate/dry-run'));
    assert.ok(kinds.includes('migrate/apply'));
    assert.ok(kinds.includes('reconcile/dry-run'));
    assert.ok(kinds.includes('export/dry-run'));
    assert.ok(rows.some(r => r.kind === 'reconcile' && r.clean === false), 'the unclean reconcile is on record too');
  });
});
