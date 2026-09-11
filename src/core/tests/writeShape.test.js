/**
 * AQUA Storage — the write shape, pinned
 * Blueprint E3 · the finding that replaced PR-10
 *
 * E3 moved the store blobs into Postgres. It did **not** change the shape that
 * made them a scaling problem: every store is still one row containing every
 * owner, rewritten in full whenever any part of it changes.
 *
 * This suite exists so that fact cannot be quietly forgotten between now and
 * E5. It asserts what is TRUE TODAY, which means these assertions are expected
 * to INVERT when per-owner storage lands — the same mechanism E1/PR-1 used for
 * the missing ratio ceiling that E1/PR-3 closed.
 *
 * Sizes here are deliberately small: the point is the SHAPE, not a benchmark.
 * The growth figures live in E3_SCALING_FINDING.md, measured separately —
 * timing assertions in a battery are how flaky suites are born.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryPg } from './helpers/memoryPg.mjs';
import { _setPoolForTests, _resetForTests } from '../db/pool.js';
import { createPgBlobAdapter, TABLE } from '../storage/pgBlobAdapter.js';

let mem, restorePool;
const envBefore = process.env.DATABASE_URL;
const KEY = '/x/.aqua-evidence.json';

before(async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/aqua';
  _resetForTests();
  mem = createMemoryPg();
  restorePool = _setPoolForTests(mem.pool);
  await (await import('../db/migrate.js')).migrate();
});

after(async () => {
  restorePool?.();
  await mem?.close();
  if (envBefore === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = envBefore;
  _resetForTests();
});

/** A store holding several owners, as every store does today. */
const manyOwners = (n, marker = 'original') =>
  JSON.stringify(Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`user:${i}`, { facts: [`${marker}-${i}`] }])));

describe('E3 — the write shape is unchanged, and that is the open problem', () => {
  test('OPEN: one store is ONE ROW containing every owner', async () => {
    // The audit's second existential finding. E3 changed where the blob lives,
    // not what it is. When E5 partitions claims by owner_id, this assertion
    // inverts — and the inversion is the proof, exactly as E1/PR-1's ratio
    // ceiling inverted in E1/PR-3.
    const a = createPgBlobAdapter();
    await a.hydrate();
    await a.write(KEY, manyOwners(50));

    const { rows } = await mem.pool.query(
      `SELECT count(*)::int AS n FROM ${TABLE} WHERE store_key = '.aqua-evidence.json'`);
    assert.equal(Number(rows[0].n), 1,
      'the store is no longer one row — per-owner storage has landed, invert this test and close the finding');
  });

  test('OPEN: changing ONE owner rewrites the whole store', async () => {
    // The cost that does not scale. A single user learning a single fact
    // rewrites every other user's data with it.
    const a = createPgBlobAdapter();
    await a.hydrate();
    await a.write(KEY, manyOwners(50));
    const before = await mem.pool.query(
      `SELECT bytes, version FROM ${TABLE} WHERE store_key = '.aqua-evidence.json'`);

    // One owner changes. Everything is written.
    const changed = manyOwners(50).replace('"original-7"', '"changed-7"');
    await a.write(KEY, changed);

    const after = await mem.pool.query(
      `SELECT bytes, version FROM ${TABLE} WHERE store_key = '.aqua-evidence.json'`);
    assert.equal(after.rows[0].version, before.rows[0].version + 1);
    assert.ok(after.rows[0].bytes > 1000,
      'a one-owner change wrote a small payload — the write shape changed, invert this test');
  });

  test('OPEN: a boot loads every owner of every store into memory', async () => {
    // The other half of the same problem: memory scales with TOTAL owners
    // rather than active ones, and boot time scales with total data.
    const a = createPgBlobAdapter();
    await a.hydrate();
    await a.write(KEY, manyOwners(50));

    const b = createPgBlobAdapter();
    await b.hydrate();
    const loaded = JSON.parse(b.readSync(KEY));
    assert.equal(Object.keys(loaded).length, 50,
      'hydrate loaded a subset — lazy or per-owner loading has landed, invert this test');
  });

  test('WHAT E3 DID FIX: the same write is safe under two instances', async () => {
    // Kept alongside the open problems on purpose. E3's exit criterion IS met,
    // and this suite would otherwise read as "the epic achieved nothing".
    await mem.pool.query(`DELETE FROM ${TABLE}`);
    const a = createPgBlobAdapter();
    const b = createPgBlobAdapter();
    await a.hydrate();
    await b.hydrate();

    await a.write(KEY, manyOwners(5, 'alice'));
    await assert.rejects(() => b.write(KEY, manyOwners(5, 'bob')));

    const { rows } = await mem.pool.query(
      `SELECT data FROM ${TABLE} WHERE store_key = '.aqua-evidence.json'`);
    assert.match(rows[0].data, /alice/, "the first instance's write was lost");
  });

  test('the finding is written down, not only remembered', () => {
    // A measurement that lives only in a chat log is a measurement that gets
    // re-derived by whoever hits it next.
    const doc = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)), '../../../E3_SCALING_FINDING.md');
    assert.ok(fs.existsSync(doc), 'E3_SCALING_FINDING.md is missing');
    const text = fs.readFileSync(doc, 'utf8');
    assert.match(text, /not yet scalable/);
    assert.match(text, /per-owner/);
  });
});
