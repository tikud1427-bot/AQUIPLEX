/**
 * AQUA — schema migrations
 * Blueprint E3/PR-2
 *
 * Applying a migration needs a database. Deciding WHICH to apply, in what
 * order, and whether the set on disk is coherent does not — and that is where
 * every interesting mistake lives. `discover`, `validate` and `plan` are pure,
 * so all of it is tested here without a server.
 *
 * The two assertions with the most bite are DRIFT and the ADVISORY LOCK:
 *
 *   drift  a migration edited after it was applied must be REFUSED. Silently
 *          re-reading an edited file is how two environments diverge while
 *          both report "up to date".
 *   lock   two app instances starting together must not both migrate. E3's
 *          entire purpose is making multi-instance possible; racing on DDL at
 *          the first deploy would be an ugly way to learn that.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  discover, validate, plan, checksum, migrate, status,
  MIGRATIONS_DIR, LEDGER_TABLE, MigrationError,
} from '../db/migrate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** A throwaway migrations directory. */
function dirWith(files) {
  const d = mkdtempSync(path.join(tmpdir(), 'aqua-mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(d, name), sql);
  return d;
}
const M = (v, name, sql) => ({ version: v, name, file: `000${v}_${name}.sql`, sql, checksum: checksum(sql) });

// ── Discovery ────────────────────────────────────────────────────────────────

describe('migrations — discovery', () => {
  test('the real directory is discoverable and valid', () => {
    const found = discover();
    assert.ok(found.length >= 1, 'no migrations found');
    assert.equal(validate(found), true);
    assert.equal(found[0].version, 1);
  });

  test('files are ordered by version, not by filesystem order', () => {
    const d = dirWith({
      '0002_second.sql': 'SELECT 2;', '0001_first.sql': 'SELECT 1;', '0003_third.sql': 'SELECT 3;',
    });
    assert.deepEqual(discover(d).map(m => m.version), [1, 2, 3]);
  });

  test('a badly named file is refused with the rule in the message', () => {
    const d = dirWith({ 'add_users.sql': 'SELECT 1;' });
    assert.throws(() => discover(d), /must look like 0001_snake_case_name\.sql/);
  });

  test('a missing directory is empty, not an error', () => {
    assert.deepEqual(discover(path.join(tmpdir(), 'aqua-nope-' + Date.now())), []);
  });

  test('checksums are stable and line-ending independent', () => {
    // A Windows checkout must not read as drift on every file.
    assert.equal(checksum('CREATE TABLE x();\n'), checksum('CREATE TABLE x();\r\n'));
    assert.notEqual(checksum('CREATE TABLE x();'), checksum('CREATE TABLE y();'));
  });
});

// ── Validation ───────────────────────────────────────────────────────────────

describe('migrations — an incoherent set is refused before touching the database', () => {
  test('duplicate versions are refused', () => {
    // Two people numbering a migration the same, and one silently skipped.
    assert.throws(() => validate([M(1, 'a', 'SELECT 1;'), M(1, 'b', 'SELECT 2;')]), /duplicate version 1/);
  });

  test('a gap in the sequence is refused', () => {
    assert.throws(() => validate([M(1, 'a', 'SELECT 1;'), M(3, 'c', 'SELECT 3;')]), /no gaps/);
  });

  test('an empty migration is refused', () => {
    assert.throws(() => validate([M(1, 'a', '   \n ')]), /is empty/);
  });

  test('a correct set passes', () => {
    assert.equal(validate([M(1, 'a', 'SELECT 1;'), M(2, 'b', 'SELECT 2;')]), true);
  });
});

// ── Planning ─────────────────────────────────────────────────────────────────

describe('migrations — planning', () => {
  const set = [M(1, 'a', 'SELECT 1;'), M(2, 'b', 'SELECT 2;'), M(3, 'c', 'SELECT 3;')];

  test('a fresh database plans everything', () => {
    const p = plan(set, []);
    assert.deepEqual(p.pending.map(m => m.version), [1, 2, 3]);
    assert.equal(p.applied, 0);
  });

  test('IDEMPOTENT: a fully migrated database plans nothing', () => {
    const applied = set.map(m => ({ version: m.version, checksum: m.checksum }));
    assert.deepEqual(plan(set, applied).pending, []);
  });

  test('a partially migrated database plans only the rest', () => {
    const applied = [{ version: 1, checksum: set[0].checksum }];
    assert.deepEqual(plan(set, applied).pending.map(m => m.version), [2, 3]);
  });

  test('the ledger version is compared numerically, not as a string', () => {
    // pg returns integers as numbers, but a driver or a JSON round-trip can
    // hand back strings — and "1" !== 1 would re-apply every migration.
    const applied = [{ version: '1', checksum: set[0].checksum }];
    assert.deepEqual(plan(set, applied).pending.map(m => m.version), [2, 3]);
  });

  test('THE DRIFT CASE: an edited applied migration is flagged', () => {
    const applied = [{ version: 1, checksum: 'something-else' }];
    const p = plan(set, applied);
    assert.equal(p.drifted.length, 1);
    assert.equal(p.drifted[0].version, 1);
    assert.equal(p.drifted[0].appliedChecksum, 'something-else');
    assert.ok(!p.pending.some(m => m.version === 1), 'a drifted migration must not be re-applied');
  });

  test('a ledger row with no file on disk is reported as orphaned', () => {
    // The schema still has its effects; the record of why is gone.
    const applied = [{ version: 1, checksum: set[0].checksum }, { version: 9, checksum: 'x' }];
    assert.deepEqual(plan(set, applied).orphaned, [9]);
  });
});

// ── Inertness and refusals ───────────────────────────────────────────────────

describe('migrations — without a database', () => {
  test('status reports not-configured rather than throwing', async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      assert.deepEqual(await status(), { configured: false, status: 'not-configured' });
    } finally { if (prev !== undefined) process.env.DATABASE_URL = prev; }
  });

  test('migrate refuses clearly instead of failing obscurely', async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await assert.rejects(() => migrate(), MigrationError);
      await assert.rejects(() => migrate(), /DATABASE_URL is not set/);
    } finally { if (prev !== undefined) process.env.DATABASE_URL = prev; }
  });
});

// ── The properties, asserted against the source ─────────────────────────────

describe('migrations — the properties that matter', () => {
  const src = readFileSync(path.join(ROOT, 'src/core/db/migrate.js'), 'utf8');

  test('an advisory lock guards the apply path', () => {
    // Two instances booting together must not both migrate. E3 exists to make
    // multi-instance possible; racing on DDL at the first deploy would be an
    // ugly way to learn that.
    assert.match(src, /pg_advisory_lock/);
    assert.match(src, /pg_advisory_unlock/);
  });

  test('each migration runs in its OWN transaction', () => {
    // A failure then leaves the schema at a known version and the next run
    // resumes. One transaction around everything sounds safer and is worse:
    // it makes a partial failure unresumable.
    assert.match(src, /BEGIN/);
    assert.match(src, /ROLLBACK/);
    assert.match(src, /COMMIT/);
  });

  test('there are no down migrations, on purpose', () => {
    // A rollback runs a second, less-tested write path against production data
    // at the worst possible moment. The recovery for a bad migration is a new
    // migration plus the backup.
    assert.ok(!/function\s+rollback|\.down\b|_down\.sql/.test(src));
    for (const f of readdirSync(MIGRATIONS_DIR)) assert.ok(!/down/i.test(f), `${f} looks like a down migration`);
  });

  test('drift refusal names the files and says what to do instead', () => {
    assert.match(src, /changed after being applied/);
    assert.match(src, /forward-only means forward/);
  });
});

// ── The shipped migration ────────────────────────────────────────────────────

describe('migrations — 0001', () => {
  const raw = readFileSync(path.join(MIGRATIONS_DIR, '0001_schema_info.sql'), 'utf8');
  // Comments are stripped before any content check. The first version of the
  // "no CREATE EXTENSION" test matched the phrase inside the comment
  // EXPLAINING why there is no CREATE EXTENSION — the third time in this
  // project a detector has flagged its own documentation.
  const sql = raw.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

  test('it is idempotent on its own terms', () => {
    // The runner records what it applied, but a migration that is also safe to
    // re-run costs nothing and removes a whole class of recovery problem.
    assert.match(sql, /CREATE TABLE IF NOT EXISTS/);
    assert.match(sql, /ON CONFLICT .* DO NOTHING/);
  });

  test('it creates no product table — those belong to later PRs', () => {
    assert.ok(!/claims|entities|evidence|aqua_kv/i.test(sql),
      'the blob store is E3/PR-4 and the claim tables are E5');
  });

  test('it does NOT create the vector extension', () => {
    // Available in the dev image, but creating it needs privileges a managed
    // provider may not grant to the app role. It belongs in the migration that
    // first needs a vector column, where a failure explains itself.
    assert.ok(!/CREATE EXTENSION/i.test(sql));
  });

  test('the ledger table name is stable — renaming it would orphan every record', () => {
    assert.equal(LEDGER_TABLE, 'aqua_schema_migrations');
  });
});

// ── Wiring ───────────────────────────────────────────────────────────────────

describe('migrations — wiring', () => {
  test('npm scripts exist for both status and migrate', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts['db:migrate']);
    assert.ok(pkg.scripts['db:status']);
  });

  test('NO production module imports the runner yet — nothing migrates on boot', () => {
    // Migrating automatically at startup is a decision, not a default. It
    // belongs with the PR that first depends on a table existing.
    const offenders = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        if (name.name === 'tests' || name.name.startsWith('.')) continue;
        const full = path.join(dir, name.name);
        if (name.isDirectory()) { walk(full); continue; }
        if (!/\.(m?js|cjs)$/.test(name.name)) continue;
        if (full.endsWith(path.join('db', 'migrate.js')) || full.endsWith(path.join('db', 'cli.mjs'))) continue;
        if (/db\/migrate\.js/.test(readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full));
      }
    };
    walk(path.join(ROOT, 'src'));
    assert.deepEqual(offenders, [], 'something now migrates on import — make that deliberate');
  });
});
