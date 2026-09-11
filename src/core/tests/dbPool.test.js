/**
 * AQUA — Postgres pool
 * Blueprint E3/PR-1
 *
 * Two things are under test, and the first matters more than the second:
 *
 *   1. INERTNESS. Nothing in the engine reads or writes through this module,
 *      no connection is attempted at import, and behaviour is identical
 *      whether or not DATABASE_URL is set. E3 replaces the substrate under 24
 *      stores holding every user's world; this PR has to be provably a no-op.
 *
 *   2. It does not leak credentials, and it fails at CONFIG time rather than
 *      at the first query in production.
 *
 * None of these need a Postgres server. That is deliberate — a test suite that
 * only runs where a database happens to exist is a suite that stops running.
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isConfigured, readConfig, describe as describeDb, dbHealth,
  getPool, closePool, bootLine, _resetForTests, DbConfigError,
} from '../db/pool.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ORIGINAL = process.env.DATABASE_URL;

const withUrl = (url, fn) => {
  const prev = process.env.DATABASE_URL;
  if (url === null) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = url;
  _resetForTests();
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prev;
    _resetForTests();
  }
};

beforeEach(() => { delete process.env.DATABASE_URL; _resetForTests(); });
after(async () => {
  await closePool();
  if (ORIGINAL === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = ORIGINAL;
});

// ── Inertness ────────────────────────────────────────────────────────────────

describe('db pool — inert by default', () => {
  test('no DATABASE_URL means not configured, and nothing throws', () => {
    assert.equal(isConfigured(), false);
    assert.equal(readConfig(), null);
    assert.deepEqual(describeDb(), { configured: false });
  });

  test('getPool returns null rather than constructing anything', async () => {
    assert.equal(await getPool(), null);
    assert.equal(await closePool(), false, 'a pool was created despite no configuration');
  });

  test('health reports not-configured instead of erroring', async () => {
    assert.deepEqual(await dbHealth(), { configured: false, status: 'not-configured' });
  });

  test('importing the module connects to nothing', async () => {
    // If this module ever connected at import, every route in the engine would
    // depend on a reachable database at boot. Laziness here is a safety
    // property, not a performance one.
    await withUrl('postgresql://u:p@127.0.0.1:1/none', async () => {
      const fresh = await import(`../db/pool.js?probe=${Date.now()}`);
      assert.equal(await fresh.closePool(), false, 'a pool existed before anything asked for one');
    });
  });

  test('only DECLARED consumers import the pool — nothing has drifted onto it', () => {
    // E3/PR-1 asserted NO production module imported the pool. E3/PR-4 added
    // the Postgres blob adapter, which must — and this test failed, which is
    // exactly what it was for: the change became a deliberate edit rather than
    // a drift nobody noticed.
    //
    // The adapter is still UNUSED (`getAdapter()` returns the JSON one, and
    // pgBlobAdapter.test.js asserts nothing imports IT), so the engine remains
    // a no-op with respect to Postgres. What changed is which file is allowed
    // to know the pool exists.
    // Grows by DELIBERATE edit only. E3/PR-4 added the adapter; E3/PR-5 added
    // the seam, which asks the pool whether a database is configured before
    // installing shadow mode. Each entry cost a red battery first, which is
    // the point of the guard.
    const ALLOWED = [
      'src/core/storage/pgBlobAdapter.js',
      'src/core/storage/index.js',
      'src/core/db/migrate.js',
      'src/core/db/cli.mjs',
      'src/core/claims/claimRepository.js',   // E5/PR-3 — claims live in Postgres
      'src/core/claims/backfill.js',          // E5/PR-4 — projects legacy facts
      'src/core/claims/projection.js',        // E5/PR-5 — the read path
      // E5/PR-5 (this change) — resolves whether claim shadow writes can run.
      // It asks the pool the SAME question the storage seam above asks, for the
      // same reason and with the same answer: flag on with no DATABASE_URL
      // degrades to off carrying a stated reason, rather than throwing (L11) or
      // going quiet (L13). It reads availability only; it writes nothing.
      'src/core/claims/shadowMode.js',
    ];
    const offenders = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'tests' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(m?js|cjs)$/.test(name)) continue;
        if (full.endsWith(path.join('core', 'db', 'pool.js'))) continue;
        if (/db\/pool\.js/.test(readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full));
      }
    };
    walk(path.join(ROOT, 'src'));
    const undeclared = offenders.filter(f => !ALLOWED.includes(f.split(path.sep).join('/')));
    assert.deepEqual(undeclared, [], 'a new module depends on the pool — add it to ALLOWED on purpose, or do not');
  });
});

// ── Config parsing, without connecting ───────────────────────────────────────

describe('db pool — config is validated at boot, not at first query', () => {
  test('a normal URL parses into host, port and database', () => {
    withUrl('postgresql://aqua:secret@db.internal:6432/aquadb', () => {
      const c = readConfig();
      assert.equal(c.host, 'db.internal');
      assert.equal(c.port, 6432);
      assert.equal(c.database, 'aquadb');
      assert.equal(c.ssl, false);
    });
  });

  test('port defaults to 5432', () => {
    withUrl('postgres://u:p@h/db', () => assert.equal(readConfig().port, 5432));
  });

  test('sslmode=require turns SSL on', () => {
    withUrl('postgresql://u:p@h/db?sslmode=require', () => {
      assert.ok(readConfig().ssl, 'a managed provider URL would connect without TLS');
    });
  });

  test('sslmode=disable turns it off', () => {
    withUrl('postgresql://u:p@h/db?sslmode=disable', () => assert.equal(readConfig().ssl, false));
  });

  test('a malformed URL fails LOUDLY at config time', () => {
    // A typo in a deploy environment should surface at boot with a readable
    // message, not as a confusing timeout on whichever request first touches
    // the database.
    withUrl('not a url at all', () => assert.throws(() => readConfig(), DbConfigError));
  });

  test('a non-postgres scheme is refused', () => {
    withUrl('mysql://u:p@h/db', () => assert.throws(() => readConfig(), /postgres/));
  });

  test('a URL with no database name is refused', () => {
    withUrl('postgresql://u:p@h', () => assert.throws(() => readConfig(), /no database name/));
  });

  test('pool sizing is tunable by env', () => {
    const prev = process.env.PGPOOL_MAX;
    process.env.PGPOOL_MAX = '25';
    try {
      withUrl('postgresql://u:p@h/db', () => assert.equal(readConfig().max, 25));
    } finally {
      if (prev === undefined) delete process.env.PGPOOL_MAX; else process.env.PGPOOL_MAX = prev;
    }
  });
});

// ── Credentials ──────────────────────────────────────────────────────────────

describe('db pool — credentials never reach a log', () => {
  const URL_WITH_SECRET = 'postgresql://aqua:hunter2@db.internal:5432/aquadb?sslmode=require';

  test('describe() exposes host, port and database and nothing else', () => {
    withUrl(URL_WITH_SECRET, () => {
      const d = describeDb();
      const text = JSON.stringify(d);
      assert.ok(!text.includes('hunter2'), 'the password is in describe()');
      assert.ok(!text.includes('postgresql://'), 'the raw URL is in describe()');
      assert.equal(d.host, 'db.internal');
      assert.equal(d.database, 'aquadb');
    });
  });

  test('the boot line carries no secret', () => {
    // A connection string in a log file is a credential in a log file, and log
    // files get pasted into issues.
    withUrl(URL_WITH_SECRET, () => {
      const line = bootLine();
      assert.ok(!line.includes('hunter2'));
      assert.ok(!line.includes('aqua:'));
      assert.match(line, /postgres=configured/);
      assert.match(line, /db=aquadb/);
    });
  });

  test('the boot line always says something, configured or not', () => {
    assert.match(bootLine(), /not-configured/);
    withUrl('postgresql://u:p@h/db', () => assert.match(bootLine(), /configured/));
    withUrl('garbage', () => assert.match(bootLine(), /MISCONFIGURED/));
  });

  test('the boot line is wired into router.js', () => {
    // L13: a configured database must never be a surprise. Without this the
    // module could sit unreported forever.
    assert.match(readFileSync(path.join(ROOT, 'router.js'), 'utf8'), /bootLine\(\)/);
  });
});

// ── Health ───────────────────────────────────────────────────────────────────

describe('db pool — health never throws', () => {
  test('a misconfigured URL reports, it does not blow up', async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'nonsense://';
    _resetForTests();
    try {
      const h = await dbHealth({ timeoutMs: 200 });
      assert.equal(h.status, 'misconfigured');
      assert.ok(h.error);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prev;
      _resetForTests();
    }
  });

  test('an unreachable database reports unreachable, with a latency', async () => {
    // Port 1 on loopback refuses immediately, so this stays fast and needs no
    // server — the suite must run everywhere, not only where Postgres exists.
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/none';
    _resetForTests();
    try {
      const h = await dbHealth({ timeoutMs: 2_000 });
      assert.equal(h.configured, true);
      assert.equal(h.status, 'unreachable');
      assert.equal(typeof h.latencyMs, 'number');
      assert.ok(h.error);
    } finally {
      await closePool();
      if (prev === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prev;
      _resetForTests();
    }
  });
});

// ── Dependency ───────────────────────────────────────────────────────────────

describe('db pool — the driver is declared', () => {
  test('pg is a dependency and is pinned to a major', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.dependencies.pg, 'pg is not declared');
    assert.match(pkg.dependencies.pg, /^\^?8\./, 'pg should be pinned to the 8.x line');
  });

  test('a dev compose file exists so the database is reproducible', () => {
    const compose = readFileSync(path.join(ROOT, '..', 'docker-compose.dev.yml'), 'utf8');
    assert.match(compose, /postgres/i);
    assert.match(compose, /5432/);
  });
});
