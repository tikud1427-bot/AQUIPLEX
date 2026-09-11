/**
 * AQUA Storage — Postgres blob adapter
 * Blueprint E3/PR-4
 *
 * WHAT RUNS WITHOUT A DATABASE, AND WHAT HONESTLY CANNOT
 * -----------------------------------------------------
 * The key mapping, the interface conformance, the cache semantics and the
 * write-behind bookkeeping all run anywhere. The round-trip contract does not:
 * it needs a live Postgres.
 *
 * Those tests are therefore SKIPPED WITH A REASON when `DATABASE_URL` is
 * unset — never quietly passed. It is the same rule the eval harness applies
 * to its own cases: a thing that could not run is reported as not run, and
 * never estimated. A green suite that silently skipped its only integration
 * test is worse than a red one.
 *
 *   docker compose -f docker-compose.dev.yml up -d
 *   export DATABASE_URL=postgresql://aqua:aqua@localhost:5432/aqua
 *   npm run db:migrate
 *   node --test src/core/tests/pgBlobAdapter.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPgBlobAdapter, storeKeyFor, TABLE } from '../storage/pgBlobAdapter.js';
import { createJsonFileAdapter } from '../storage/jsonFileAdapter.js';
import { assertAdapter, getAdapter, ADAPTER_FLAGS } from '../storage/index.js';
import { isConfigured, closePool } from '../db/pool.js';
import { runAdapterContract } from './helpers/adapterContract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LIVE = isConfigured();
const skip = LIVE ? false : 'DATABASE_URL is not set — this needs a live Postgres, see the header';

// ── Runs anywhere ────────────────────────────────────────────────────────────

describe('pg blob adapter — shape', () => {
  test('satisfies the adapter interface', () => {
    assert.equal(assertAdapter(createPgBlobAdapter()), true);
  });

  test('declares that writeSync is NOT durable on return', () => {
    // The finding this PR exists to surface. Node has no synchronous Postgres
    // client, so this adapter serves reads from a hydrated cache and writes
    // behind it. The file adapter returns true; the difference is declared
    // rather than discovered on the first SIGTERM.
    assert.equal(createPgBlobAdapter().syncDurable, false);
    assert.equal(createJsonFileAdapter().syncDurable, true);
    assert.ok(ADAPTER_FLAGS.includes('syncDurable'));
  });

  test('an adapter that omits the durability flag is refused', () => {
    const a = createPgBlobAdapter();
    delete a.syncDurable;
    assert.throws(() => assertAdapter(a), /syncDurable/);
  });

  test('a store path maps to its basename', () => {
    // One row per STORE FILE, not per owner — a store path carries no owner.
    // See 0002_store_blobs.sql for why that is not a shortcut.
    assert.equal(storeKeyFor('/home/u/.aquiplex/.aqua-evidence.json'), '.aqua-evidence.json');
    assert.equal(storeKeyFor('/other/root/.aqua-evidence.json'), '.aqua-evidence.json');
  });

  test('exposes flush and hydrate, which the file adapter does not need', () => {
    const a = createPgBlobAdapter();
    assert.equal(typeof a.hydrate, 'function');
    assert.equal(typeof a.flush, 'function');
    assert.equal(a.isHydrated(), false);
  });
});

describe('pg blob adapter — cache semantics, no database needed', () => {
  test('a value written synchronously is readable immediately', () => {
    const a = createPgBlobAdapter();
    // The write-behind will reject without a database; the cache still serves.
    try { a.writeSync('/x/.aqua-mind.json', '{"v":1}'); } catch { /* expected */ }
    assert.equal(a.readSync('/x/.aqua-mind.json'), '{"v":1}');
    assert.equal(a.existsSync('/x/.aqua-mind.json'), true);
  });

  test('an unknown key reads null, not a throw', () => {
    assert.equal(createPgBlobAdapter().readSync('/x/.aqua-nothing.json'), null);
    assert.equal(createPgBlobAdapter().existsSync('/x/.aqua-nothing.json'), false);
  });

  test('copySync duplicates within the cache', () => {
    const a = createPgBlobAdapter();
    try { a.writeSync('/x/.aqua-a.json', '{"n":7}'); } catch { /* expected */ }
    try { a.copySync('/x/.aqua-a.json', '/x/.aqua-a.json.bak'); } catch { /* expected */ }
    assert.equal(a.readSync('/x/.aqua-a.json.bak'), '{"n":7}');
  });

  test('a write-behind failure is recorded, never left unhandled', async () => {
    // The defect this PR found in its own adapter: the enqueued promise is by
    // definition not awaited, so a rejection escaping it is UNHANDLED — and
    // Node kills the process on an unhandled rejection. Same failure mode
    // `pool.on('error')` guards in E3/PR-1, reached by a different road.
    if (LIVE) return;
    const a = createPgBlobAdapter();
    a.writeSync('/x/.aqua-fail.json', '{"v":1}');
    await new Promise(r => setImmediate(r));
    assert.ok(a._failureCount() >= 1, 'the failure was swallowed instead of recorded');
    await assert.rejects(() => a.flush(), /store write\(s\) failed/);
  });

  test('flush clears reported failures so it is not sticky', async () => {
    if (LIVE) return;
    const a = createPgBlobAdapter();
    a.writeSync('/x/.aqua-fail2.json', '{"v":1}');
    await new Promise(r => setImmediate(r));
    await a.flush().catch(() => {});
    assert.equal(a._failureCount(), 0);
    assert.equal(await a.flush(), 0, 'a healthy flush after a failed one still throws');
  });

  test('copying a key that was never written is an error, not a silent empty', () => {
    assert.throws(() => createPgBlobAdapter().copySync('/x/.aqua-none.json', '/x/b'), /nothing to copy/);
  });

  test('hydrate refuses without a database rather than pretending to be empty', async () => {
    if (LIVE) return;
    await assert.rejects(() => createPgBlobAdapter().hydrate(), /not configured/);
  });
});

// ── The migration ────────────────────────────────────────────────────────────

describe('pg blob adapter — the table it needs', () => {
  const sql = readFileSync(
    path.join(ROOT, 'src/core/db/migrations/0002_store_blobs.sql'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

  test('creates the table the adapter writes to', () => {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${TABLE}`));
    assert.match(sql, /store_key\s+text\s+PRIMARY KEY/);
  });

  test('stores a checksum so the PR-6 drift job need not re-read both sides', () => {
    assert.match(sql, /checksum/);
  });

  test('is idempotent, like every migration here', () => {
    assert.match(sql, /IF NOT EXISTS/);
  });
});

// ── Inertness ────────────────────────────────────────────────────────────────

describe('pg blob adapter — reachable only through shadow mode', () => {
  test('the default adapter is still the JSON one', () => {
    // The claim that survives PR-5: shadow mode is OFF unless asked for, so a
    // default boot never constructs a Postgres adapter at all.
    assert.equal(getAdapter().id, 'json-file');
  });

  test('only the storage seam imports it', () => {
    // E3/PR-4 asserted NOTHING imported this. E3/PR-5 wires dual-write, so the
    // seam must — and this test went red, which is what it was for. The
    // adapter is still unreachable except through AQUA_STORE_PG=shadow, and
    // even then nothing READS from it (see dualWrite.test.js).
    // E3/PR-5 added the seam (it constructs the adapter); E3/PR-6 added the
    // drift job, which imports only the TABLE constant — a far weaker coupling
    // than using the adapter, but still worth being on the list rather than
    // waved through. Each entry cost a red battery first.
    const ALLOWED = ['src/core/storage/index.js', 'src/core/db/drift.js'];
    const offenders = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name === 'tests' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(m?js|cjs)$/.test(name)) continue;
        if (full.endsWith(path.join('storage', 'pgBlobAdapter.js'))) continue;
        if (/pgBlobAdapter/.test(readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full));
      }
    };
    walk(path.join(ROOT, 'src'));
    const undeclared = offenders.filter(f => !ALLOWED.includes(f.split(path.sep).join('/')));
    assert.deepEqual(undeclared, [], 'a new module reaches the Postgres adapter — make that deliberate');
  });
});

// ── The round trip — needs a live database ──────────────────────────────────

describe('pg blob adapter — round trip against a real database', { skip }, () => {
  test('hydrate, write, read back, flush', async () => {
    const a = createPgBlobAdapter();
    await a.hydrate();
    const key = `/tmp/.aqua-eval-${Date.now()}.json`;
    await a.write(key, '{"round":"trip"}');
    assert.equal(a.readSync(key), '{"round":"trip"}');
    await a.flush();

    // A second adapter proves it reached the database, not just the cache.
    const b = createPgBlobAdapter();
    await b.hydrate();
    assert.equal(b.readSync(key), '{"round":"trip"}');
    await closePool();
  });

});

// ── The shared contract, ACTUALLY RUN against Postgres ───────────────────────
//
// 🔴 THIS USED TO ASSERT THAT THE CONTRACT FUNCTION EXISTS.
//
//     const { runAdapterContract } = await import('./storageAdapter.test.js');
//     assert.equal(typeof runAdapterContract, 'function');
//
// The comment above it promised "the same nine assertions the JSON adapter
// satisfies, unchanged" — and asserted only that a function was exported. Nine
// assertions were never executed against Postgres. The runtime import also
// re-registered the whole json-file suite as a child of the running test, which
// node cancelled, so the suite failed loudly the first time a live database
// existed to run it against.
//
// Called at module scope now, gated by the same `skip`, so the contract runs
// where it was always supposed to. The adapter is not hydrated first on
// purpose: `write` is write-through to the cache, so the contract exercises the
// same read path a caller gets before any hydrate — which is the state a fresh
// process is actually in.
runAdapterContract('pg-blob', createPgBlobAdapter, () => `/tmp/.aqua-contract-${Date.now()}-${Math.random()}.json`, {
  skip,
  // 🔴 A REAL DIVERGENCE, FOUND BY RUNNING THE CONTRACT FOR THE FIRST TIME.
  //
  // The JSON adapter serialises concurrent writes to one key and the last value
  // wins. The Postgres adapter refuses them: its optimistic-concurrency guard
  // fires on the instance's OWN in-flight writes, because each write checks a
  // version the previous concurrent write has already moved. Reproduced both
  // hydrated and unhydrated, so it is the adapter and not this invocation.
  //
  // Declared as `todo` rather than fixed or loosened. Fixing it is an E3
  // decision about what optimistic concurrency should mean for a write-behind
  // cache, and does not belong bolted onto a test repair. Loosening the
  // assertion so both adapters pass would let "it works" mean two different
  // things, which is what the shared contract exists to prevent. `todo` keeps
  // the assertion exactly as written, still executed, and reported.
  todo: {
    'concurrent writes to one key all settle, last value wins':
      'pg-blob rejects concurrent writes to one key (optimistic version guard) — E3, unfixed',
  },
});
