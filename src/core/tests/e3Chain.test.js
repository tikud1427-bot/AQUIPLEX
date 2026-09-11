/**
 * AQUA Storage — the E3 chain, executed
 * Blueprint E3/PR-8
 *
 * Six E3 PRs shipped with every live-database test skipped. The skips were
 * honest, but the effect was that the migration runner, the blob adapter, the
 * drift job and the read flip had **never been executed against anything**.
 *
 * This runs the whole chain end to end, in-process, everywhere the battery
 * runs. It is a simulator, not a substitute — see helpers/memoryPg.mjs for
 * exactly what it does not prove, and note that the live tests remain,
 * skipped-with-a-reason, as the real evidence.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryPg } from './helpers/memoryPg.mjs';
import { _setPoolForTests, _resetForTests } from '../db/pool.js';

let mem, restorePool, dataDir;
const envBefore = {};

before(async () => {
  for (const k of ['DATABASE_URL', 'AQUA_DATA_DIR', 'AQUA_STORE_PG', 'AQUA_STORE_PG_READ']) {
    envBefore[k] = process.env[k];
  }
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-e3-chain-'));
  process.env.AQUA_DATA_DIR = dataDir;
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/aqua';
  _resetForTests();
  mem = createMemoryPg();
  restorePool = _setPoolForTests(mem.pool);
});

after(async () => {
  restorePool?.();
  await mem?.close();
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  _resetForTests();
});

const store = (name, contents) => {
  const p = path.join(dataDir, name);
  fs.writeFileSync(p, contents);
  return p;
};

// ── 1. migrations ────────────────────────────────────────────────────────────

describe('E3 chain — migrations actually apply', () => {
  test('every migration on disk applies, in order', async () => {
    const { migrate } = await import('../db/migrate.js');
    // Asserted against what is ON DISK rather than a hardcoded count, so
    // adding a migration is not a false failure. E3/PR-9 added 0004 and this
    // test went red — legitimate, but "expected 3" told me nothing about
    // whether the runner was wrong or the set had simply grown.
    const { discover } = await import('../db/migrate.js');
    const onDisk = discover();
    const r = await migrate();
    assert.equal(r.applied.length, onDisk.length,
      `applied ${r.applied.map(a => a.name).join(', ')}`);
    assert.deepEqual(r.applied.map(a => a.version), onDisk.map(m => m.version));
  });

  test('IDEMPOTENT: a second run applies nothing', async () => {
    // Asserted in E3/PR-2 against a hand-built plan. This is the first time it
    // has been asserted against a database that actually recorded the first run.
    const { migrate } = await import('../db/migrate.js');
    assert.deepEqual((await migrate()).applied, []);
  });

  test('status reports up-to-date afterwards', async () => {
    const { status } = await import('../db/migrate.js');
    const s = await status();
    assert.equal(s.status, 'up-to-date');
    assert.equal(s.pending.length, 0);
    assert.deepEqual(s.drifted, []);
  });

  test('the tables the later PRs need exist', async () => {
    for (const table of ['aqua_schema_info', 'aqua_store_blobs', 'aqua_drift_runs']) {
      const r = await mem.pool.query(`SELECT count(*) FROM ${table}`);
      assert.ok(r, `${table} was never created`);
    }
  });
});

// ── 2. the blob adapter ──────────────────────────────────────────────────────

describe('E3 chain — blobs round-trip through the database', () => {
  test('a write reaches the table, not just the cache', async () => {
    // The claim PR-4 could not test. A SECOND adapter hydrating from scratch is
    // the only way to tell a real write from a cache that agrees with itself.
    const { createPgBlobAdapter } = await import('../storage/pgBlobAdapter.js');
    const a = createPgBlobAdapter();
    await a.hydrate();
    await a.write('/x/.aqua-artifacts.json', '{"v":1}');

    const b = createPgBlobAdapter();
    await b.hydrate();
    assert.equal(b.readSync('/x/.aqua-artifacts.json'), '{"v":1}');
  });

  test('writeSync is write-behind, and flush is what makes it durable', async () => {
    const { createPgBlobAdapter } = await import('../storage/pgBlobAdapter.js');
    const a = createPgBlobAdapter();
    await a.hydrate();
    a.writeSync('/x/.aqua-mind.json', '{"m":2}');

    // syncDurable:false made concrete: in flight, not yet in the database.
    assert.equal(await a.flush(), 1, 'nothing was in flight — writeSync wrote synchronously?');

    const b = createPgBlobAdapter();
    await b.hydrate();
    assert.equal(b.readSync('/x/.aqua-mind.json'), '{"m":2}');
  });

  test('the stored row carries the byte count and checksum drift relies on', async () => {
    const { checksumOf } = await import('../db/drift.js');
    const { rows } = await mem.pool.query(
      "SELECT bytes, checksum FROM aqua_store_blobs WHERE store_key = '.aqua-artifacts.json'");
    assert.equal(rows[0].bytes, Buffer.byteLength('{"v":1}'));
    assert.equal(rows[0].checksum, checksumOf('{"v":1}'),
      'the adapter and the drift job disagree about how to hash — drift would report false positives forever');
  });
});

// ── 3. drift ─────────────────────────────────────────────────────────────────

describe('E3 chain — drift detects what it claims to', () => {
  test('clean when both sides agree', async () => {
    store('.aqua-artifacts.json', '{"v":1}');
    store('.aqua-mind.json', '{"m":2}');
    const { checkDrift } = await import('../db/drift.js');
    const r = await checkDrift();
    assert.equal(r.status, 'clean', JSON.stringify(r.mismatched ?? r));
    assert.equal(r.matched, 2);
  });

  test('a real mismatch is caught', async () => {
    store('.aqua-artifacts.json', '{"v":999}');
    const { checkDrift } = await import('../db/drift.js');
    const r = await checkDrift();
    assert.equal(r.status, 'drift');
    assert.equal(r.mismatched.length, 1);
    assert.equal(r.mismatched[0].key, '.aqua-artifacts.json');
    store('.aqua-artifacts.json', '{"v":1}');   // restore
  });

  test('a store the shadow never received is caught', async () => {
    const p = store('.aqua-evidence.json', '{"new":true}');
    const { checkDrift } = await import('../db/drift.js');
    assert.deepEqual((await checkDrift()).missingShadow, ['.aqua-evidence.json']);
    fs.unlinkSync(p);
  });

  test('history rows are recorded, so the week-of-zero claim is checkable', async () => {
    const { rows } = await mem.pool.query('SELECT count(*)::int AS n FROM aqua_drift_runs');
    assert.ok(Number(rows[0].n) >= 3, 'drift ran but recorded nothing');
  });
});

// ── 4. dual write and the read flip ──────────────────────────────────────────

describe('E3 chain — the drift gate refuses a dirty store', () => {
  test('a DIRTY store does not flip, and the refusal is reported', async () => {
    // The safety property of E3/PR-7, executed rather than argued. Asserted
    // against a database that actually holds one clean store and one dirty one.
    store('.aqua-artifacts.json', '{"DIRTY":true}');
    process.env.AQUA_STORE_PG = 'shadow';
    process.env.AQUA_STORE_PG_READ = 'artifacts,mind';

    const { configureStorageFromEnv, storageBootLine } = await import('../storage/index.js');
    const r = await configureStorageFromEnv();

    assert.deepEqual(r.readFrom, ['.aqua-mind.json'], 'the dirty store flipped anyway');
    assert.ok(r.notes.some(n => n.includes('.aqua-artifacts.json')), 'the refusal was silent');
    assert.match(storageBootLine(r), /still drifts/);
  });

  test('once clean, the store flips and its read is served from Postgres', async () => {
    store('.aqua-artifacts.json', '{"v":1}');
    const { configureStorageFromEnv, getAdapter } = await import('../storage/index.js');
    const r = await configureStorageFromEnv();

    assert.deepEqual(r.readFrom.sort(), ['.aqua-artifacts.json', '.aqua-mind.json']);
    const value = getAdapter().readSync(path.join(dataDir, '.aqua-mind.json'));
    assert.equal(value, '{"m":2}');
    assert.ok(getAdapter().stats().shadowReads >= 1, 'the read did not come from the shadow');
    assert.equal(getAdapter().stats().readFallbacks, 0, 'the flipped read silently fell back to JSON');
  });

  test('a write in shadow mode lands in BOTH', async () => {
    const { getAdapter } = await import('../storage/index.js');
    const key = path.join(dataDir, '.aqua-mind.json');
    await getAdapter().write(key, '{"m":3}');
    await getAdapter().flush();

    assert.equal(fs.readFileSync(key, 'utf8'), '{"m":3}');
    const { rows } = await mem.pool.query(
      "SELECT data FROM aqua_store_blobs WHERE store_key = '.aqua-mind.json'");
    assert.equal(rows[0].data, '{"m":3}', 'the shadow half of the dual write never landed');
  });
});
