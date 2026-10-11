/**
 * AQUA Storage — two instances, zero data loss
 * Blueprint E3/PR-9
 *
 * The epic's exit criterion, tested rather than promised.
 *
 * Before this PR the criterion was FALSE on the new substrate. Measured: two
 * adapters each hold their own cache, instance A writes, instance B writes,
 * and A's data is gone — while both caches still believe their own version.
 * That is the identical last-writer-wins loss the Mongo mirror already warns
 * about, faithfully reproduced on Postgres.
 *
 * Moving to Postgres without fixing it would have moved the bug, not fixed it,
 * and the epic would have "completed" with its headline promise untrue.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryPg } from './helpers/memoryPg.mjs';
import { _setPoolForTests, _resetForTests } from '../db/pool.js';
import { createPgBlobAdapter, StoreConflictError, TABLE } from '../storage/pgBlobAdapter.js';

let mem, restorePool;
const envBefore = process.env.DATABASE_URL;
const KEY = '/x/.aqua-mind.json';

before(async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/aqua';
  _resetForTests();
  mem = createMemoryPg();
  restorePool = _setPoolForTests(mem.pool);
  const { migrate } = await import('../db/migrate.js');
  await migrate();
});

after(async () => {
  restorePool?.();
  await mem?.close();
  if (envBefore === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = envBefore;
  _resetForTests();
});

/** Two adapters = two instances, each with its own cache. */
async function twoInstances() {
  await mem.pool.query(`DELETE FROM ${TABLE}`);
  const a = createPgBlobAdapter();
  const b = createPgBlobAdapter();
  await a.hydrate();
  await b.hydrate();
  return [a, b];
}

const stored = async () => {
  const { rows } = await mem.pool.query(
    `SELECT data, version FROM ${TABLE} WHERE store_key = '.aqua-mind.json'`);
  return rows[0] ?? null;
};

// ── The exit criterion ───────────────────────────────────────────────────────

describe('two instances — no write is silently lost', () => {
  test('THE CRITERION: the second instance is REFUSED, not silently preferred', async () => {
    const [a, b] = await twoInstances();
    await a.write(KEY, '{"owner":"alice"}');

    await assert.rejects(
      () => b.write(KEY, '{"owner":"bob"}'),
      err => {
        assert.ok(err instanceof StoreConflictError, `got ${err.name}`);
        assert.equal(err.storeKey, '.aqua-mind.json');
        return true;
      },
    );

    const row = await stored();
    assert.equal(row.data, '{"owner":"alice"}', 'the first write was overwritten — data loss');
  });

  test('the loser is TOLD, because a caller who is not told believes it won', async () => {
    // An awaited write has somebody to tell. Swallowing the conflict is how
    // two instances end up confidently holding different data, each certain
    // it is authoritative.
    const [a, b] = await twoInstances();
    await a.write(KEY, '{"v":1}');
    let told = false;
    try { await b.write(KEY, '{"v":2}'); } catch { told = true; }
    assert.equal(told, true, 'the losing write returned successfully');
  });

  test('a write-behind conflict is recorded and surfaced by flush()', async () => {
    // writeSync has nobody to tell in the moment, so the conflict is recorded
    // and re-reported where somebody is waiting for an answer.
    const [a, b] = await twoInstances();
    await a.write(KEY, '{"v":1}');
    b.writeSync(KEY, '{"v":2}');

    // flush() is the synchronisation point, not a timer. A single setImmediate
    // was not enough — the version guard performs TWO awaited queries — and a
    // test that waits a guessed number of ticks is a flake waiting to happen.
    // flush() rejects on the conflict, which is also the assertion below.
    await assert.rejects(() => b.flush(), /store write\(s\) failed/);

    // conflicts() survives flush deliberately: flush clears `failures` so it
    // is not sticky (E3/PR-4), but an operator asking "did any write lose a
    // race?" must still get an answer afterwards.
    assert.ok(b.conflicts().length >= 1, 'the conflict was not recorded');
  });

  test('recovery: refresh, then write succeeds', async () => {
    // The conflict is not a dead end. Re-reading is DELIBERATELY manual —
    // silently adopting the other instance's value would discard this
    // instance's write with nobody told, which is the same bug wearing a
    // politer face.
    const [a, b] = await twoInstances();
    await a.write(KEY, '{"owner":"alice"}');
    await assert.rejects(() => b.write(KEY, '{"owner":"bob"}'));

    assert.equal(await b.refresh(KEY), '{"owner":"alice"}');
    await b.write(KEY, '{"owner":"merged"}');
    assert.equal((await stored()).data, '{"owner":"merged"}');
  });

  test('THE UPDATE GUARD, reached only after both instances have READ the row', async () => {
    // Found by measuring bite: dropping the `AND version = $5` clause failed
    // ZERO tests, because every earlier case is caught by the FIRST-WRITE
    // branch — B had no version, so it never reached the UPDATE at all.
    //
    // Two independent guards, and only one was exercised. This drives the
    // other: both instances hydrate AFTER the row exists, so both hold
    // version 1 and the UPDATE clause is the only thing standing between them.
    await mem.pool.query(`DELETE FROM ${TABLE}`);
    const seed = createPgBlobAdapter();
    await seed.hydrate();
    await seed.write(KEY, '{"seed":true}');

    const a = createPgBlobAdapter();
    const b = createPgBlobAdapter();
    await a.hydrate();          // both read version 1
    await b.hydrate();

    await a.write(KEY, '{"owner":"alice"}');   // → version 2
    await assert.rejects(
      () => b.write(KEY, '{"owner":"bob"}'),   // still holds version 1
      err => { assert.ok(err instanceof StoreConflictError); return true; },
    );
    assert.equal((await stored()).data, '{"owner":"alice"}');
  });

  test('the winner can keep writing — its version tracks forward', async () => {
    const [a] = await twoInstances();
    await a.write(KEY, '{"n":1}');
    await a.write(KEY, '{"n":2}');
    await a.write(KEY, '{"n":3}');
    const row = await stored();
    assert.equal(row.data, '{"n":3}');
    assert.equal(row.version, 3, 'the version did not advance with each write');
  });

  test('a store written by neither instance is unaffected', async () => {
    // The guard is per store. A conflict on one must not block another.
    const [a, b] = await twoInstances();
    await a.write(KEY, '{"a":1}');
    await b.write('/x/.aqua-artifacts.json', '{"b":1}');
    const { rows } = await mem.pool.query(
      `SELECT store_key FROM ${TABLE} ORDER BY store_key`);
    assert.deepEqual(rows.map(r => r.store_key),
      ['.aqua-artifacts.json', '.aqua-mind.json']);
  });
});

// ── The version column ───────────────────────────────────────────────────────

describe('two instances — the version column', () => {
  test('a fresh row starts at 1', async () => {
    const [a] = await twoInstances();
    await a.write(KEY, '{}');
    assert.equal((await stored()).version, 1);
  });

  test('hydrate loads versions, not just data', async () => {
    // Without this a re-hydrated instance would have no version and take the
    // first-write branch, overwriting whatever it never read.
    const [a] = await twoInstances();
    await a.write(KEY, '{"v":1}');
    const c = createPgBlobAdapter();
    await c.hydrate();
    await c.write(KEY, '{"v":2}');       // must succeed: c read version 1
    assert.equal((await stored()).version, 2);
  });

  test('an instance that never read the row cannot overwrite it', async () => {
    // The dangerous case: an instance that hydrated BEFORE the row existed.
    const [, b] = await twoInstances();
    await mem.pool.query(
      `INSERT INTO ${TABLE} (store_key, data, bytes, checksum, version)
       VALUES ('.aqua-mind.json', '{"other":true}', 15, 'x', 1)`);
    await assert.rejects(() => b.write(KEY, '{"mine":true}'), StoreConflictError);
    assert.equal((await stored()).data, '{"other":true}');
  });

  test('the guard does not depend on RETURNING semantics', async () => {
    // pg-mem returns a row from `ON CONFLICT DO NOTHING ... RETURNING` where
    // real Postgres returns none. A guard built on that row count would be
    // correct in production and silently wrong in every test — the worst
    // combination available. The check reads back the stored checksum instead.
    const src = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../storage/pgBlobAdapter.js', import.meta.url), 'utf8'));
    assert.ok(!/DO NOTHING\s*\n?\s*RETURNING/.test(src),
      'the first-write guard trusts RETURNING on a DO NOTHING');
    assert.match(src, /SELECT checksum, version FROM/);
  });
});

// ── Restart (2026-10-05) ─────────────────────────────────────────────────────
// Live: every server restart froze the shadow for the life of the process —
// the first write per store conflicted ("a row already exists that this
// instance never read"), no version was ever recorded, and every later write
// failed the same way (609 rejected writes over 4 restarts). An instance that
// LOADED exactly what the row holds (its JSON primary at boot) may continue
// from that row; anything else is still a conflict.
describe('restart — an instance continues from the row it loaded', () => {
  const fresh = async () => { await mem.pool.query(`DELETE FROM ${TABLE}`); };

  test('a restarted instance that loaded the same content writes, and KEEPS writing', async () => {
    await fresh();
    const before = createPgBlobAdapter();
    await before.write(KEY, '{"v":1}');                  // the previous process's last write
    const after = createPgBlobAdapter();                  // restart: no hydrate (shadow mode does not)
    after.noteRead(KEY, '{"v":1}');                       // the JSON it booted from
    await after.write(KEY, '{"v":2}');
    await after.write(KEY, '{"v":3}');
    assert.deepEqual(await stored(), { data: '{"v":3}', version: 3 });
  });

  test('a restarted instance whose boot content differs from the row is still REFUSED', async () => {
    await fresh();
    const other = createPgBlobAdapter();
    await other.write(KEY, '{"other":1}');                // written by an instance this one never read
    const after = createPgBlobAdapter();
    after.noteRead(KEY, '{"mine":0}');
    await assert.rejects(() => after.write(KEY, '{"mine":1}'), StoreConflictError);
    assert.equal((await stored()).data, '{"other":1}');
  });

  test('only the FIRST read is the baseline — a later read cannot launder a conflict', async () => {
    await fresh();
    const other = createPgBlobAdapter();
    await other.write(KEY, '{"other":1}');
    const after = createPgBlobAdapter();
    after.noteRead(KEY, '{"mine":0}');
    after.noteRead(KEY, '{"other":1}');
    await assert.rejects(() => after.write(KEY, '{"mine":1}'), StoreConflictError);
  });

  test('the dual-write adapter feeds the baseline from the JSON primary', async () => {
    const { createDualWriteAdapter } = await import('../storage/dualWriteAdapter.js');
    const noted = [];
    const primary = { id: 'p', syncDurable: true, existsSync: () => true, readSync: () => '{"v":1}', write: async () => {}, writeSync: () => {}, copySync: () => {} };
    const shadow = { id: 's', syncDurable: false, existsSync: () => false, readSync: () => null, write: async () => {}, writeSync: () => {}, copySync: () => {}, noteRead: (k, d) => noted.push([k, d]) };
    createDualWriteAdapter(primary, shadow).readSync(KEY);
    assert.deepEqual(noted, [[KEY, '{"v":1}']]);
  });
});

// The REAL boot order (found live after the first fix): stores load at import
// through the plain JSON adapter; the shadow is installed afterwards, so the
// dual adapter's noteRead never sees those reads. configureStorageFromEnv
// therefore seeds the baseline from the files on disk.
describe('restart — the baseline is seeded at shadow install, from the JSON on disk', () => {
  test('previous instance wrote X, this one loaded X from disk → it continues writing', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { seedShadowBaseline } = await import('../storage/index.js');
    await mem.pool.query(`DELETE FROM ${TABLE}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-seed-'));
    fs.writeFileSync(path.join(dir, '.aqua-mind.json'), '{"v":1}');
    await createPgBlobAdapter().write(KEY, '{"v":1}');       // the previous process
    const after = createPgBlobAdapter();
    assert.equal(await seedShadowBaseline(after, { dataDir: dir }), 1);
    await after.write(KEY, '{"v":2}');
    await after.write(KEY, '{"v":3}');
    assert.deepEqual(await stored(), { data: '{"v":3}', version: 3 });
  });

  test('a row that differs from the file on disk is still refused', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { seedShadowBaseline } = await import('../storage/index.js');
    await mem.pool.query(`DELETE FROM ${TABLE}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-seed-'));
    fs.writeFileSync(path.join(dir, '.aqua-mind.json'), '{"mine":0}');
    await createPgBlobAdapter().write(KEY, '{"other":1}');
    const after = createPgBlobAdapter();
    await seedShadowBaseline(after, { dataDir: dir });
    await assert.rejects(() => after.write(KEY, '{"mine":1}'), StoreConflictError);
  });
});
