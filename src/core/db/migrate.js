/**
 * AQUA — schema migrations
 * Blueprint E3/PR-2 · forward-only, versioned, idempotent
 *
 * WHY THE PURE PART IS SEPARATED FROM THE SQL PART
 * ------------------------------------------------
 * Applying a migration needs a database. Deciding WHICH migrations to apply,
 * in what order, and whether the set on disk is coherent does not — and that
 * decision is where every interesting mistake lives: a duplicate version, a
 * gap, a file edited after it was applied.
 *
 * So `discover()`, `validate()` and `plan()` are pure and fully tested, and
 * `migrate()` is a thin loop over a plan they produced. It is the same split
 * E1/PR-6 used when the platform could not be booted in a test process: put
 * the judgement somewhere testable, and keep the untestable part too small to
 * hide anything.
 *
 * FORWARD-ONLY, DELIBERATELY
 * --------------------------
 * There are no `down` migrations. A rollback that runs against production data
 * is a second, less-tested write path executed at the worst possible moment;
 * the honest recovery for a bad migration is a new migration that corrects it,
 * plus the backup. Blueprint L5 already says the same thing about knowledge:
 * nothing is deleted, things are superseded.
 *
 * THREE PROPERTIES THAT MATTER MORE THAN THE FEATURE SET
 * -----------------------------------------------------
 *   idempotent   running twice applies nothing the second time
 *   locked       an advisory lock means two app instances starting together
 *                cannot both migrate — which is the entire point of E3
 *   checksummed  a migration edited after it was applied is REFUSED, loudly.
 *                Silently re-reading an edited file is how two environments
 *                diverge while both report "up to date".
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { isConfigured, getPool } from './pool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(HERE, 'migrations');
export const LEDGER_TABLE = 'aqua_schema_migrations';

/** Postgres advisory lock key. Arbitrary but fixed — it only has to be unique. */
const LOCK_KEY = 8412_5309;

const FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export class MigrationError extends Error {
  constructor(message) { super(message); this.name = 'MigrationError'; }
}

export const checksum = sql =>
  crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);

/** Read the migrations directory. Pure apart from the file read. */
export function discover(dir = MIGRATIONS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(file => {
      const m = FILENAME.exec(file);
      if (!m) {
        throw new MigrationError(
          `migration filename "${file}" must look like 0001_snake_case_name.sql — ` +
          'the number is the version and the sort order');
      }
      const sql = readFileSync(path.join(dir, file), 'utf8');
      return { version: Number(m[1]), name: m[2], file, sql, checksum: checksum(sql) };
    });
}

/**
 * Refuse an incoherent set before touching the database.
 *
 * Every check here is a mistake that is cheap to make and expensive to
 * discover halfway through a deploy.
 */
export function validate(migrations) {
  const seen = new Map();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new MigrationError(
        `duplicate version ${m.version}: ${seen.get(m.version)} and ${m.file} — ` +
        'two people numbered a migration the same, and one would be skipped');
    }
    seen.set(m.version, m.file);
    if (!m.sql.trim()) throw new MigrationError(`${m.file} is empty`);
  }

  const versions = [...seen.keys()].sort((a, b) => a - b);
  for (let i = 0; i < versions.length; i++) {
    if (versions[i] !== i + 1) {
      throw new MigrationError(
        `migration versions must run 1..n with no gaps (expected ${i + 1}, found ${versions[i]}) — ` +
        'a gap usually means a file was deleted after being applied somewhere');
    }
  }
  return true;
}

/**
 * What still needs applying, and what has drifted.
 *
 * @param {Array} migrations  from discover()
 * @param {Array<{version:number, checksum:string}>} applied  ledger rows
 */
export function plan(migrations, applied) {
  validate(migrations);
  const byVersion = new Map(applied.map(r => [Number(r.version), r]));
  const pending = [];
  const drifted = [];

  for (const m of migrations) {
    const row = byVersion.get(m.version);
    if (!row) { pending.push(m); continue; }
    if (row.checksum !== m.checksum) {
      drifted.push({ ...m, appliedChecksum: row.checksum });
    }
  }

  // A version in the ledger with no file on disk means someone deleted an
  // applied migration. The schema still has its effects; the record of why is
  // gone. Reported rather than ignored.
  const orphaned = applied
    .filter(r => !migrations.some(m => m.version === Number(r.version)))
    .map(r => Number(r.version));

  return { pending, drifted, orphaned, applied: applied.length, total: migrations.length };
}

// ── The thin impure part ─────────────────────────────────────────────────────

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      version     integer PRIMARY KEY,
      name        text        NOT NULL,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer     NOT NULL
    )`);
}

async function readLedger(client) {
  const { rows } = await client.query(
    `SELECT version, name, checksum, applied_at FROM ${LEDGER_TABLE} ORDER BY version`);
  return rows;
}

/** Report only — never writes, safe to call from a health endpoint. */
export async function status({ dir = MIGRATIONS_DIR } = {}) {
  if (!isConfigured()) return { configured: false, status: 'not-configured' };
  const migrations = discover(dir);
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await ensureLedger(client);
    const p = plan(migrations, await readLedger(client));
    return { configured: true, status: p.pending.length ? 'pending' : 'up-to-date', ...p };
  } finally {
    client.release();
  }
}

/**
 * Apply every pending migration, in order, each in its own transaction.
 *
 * Per-migration transactions rather than one big one: a failure then leaves
 * the schema at a KNOWN version rather than half-applied, and the next run
 * resumes from there. One transaction around everything sounds safer and is
 * worse — it makes a partial failure unresumable.
 */
export async function migrate({ dir = MIGRATIONS_DIR, dryRun = false } = {}) {
  if (!isConfigured()) {
    throw new MigrationError('DATABASE_URL is not set — nothing to migrate against');
  }
  const migrations = discover(dir);
  const pool = await getPool();
  const client = await pool.connect();
  const applied = [];

  try {
    // Two instances booting together must not both migrate. This lock is the
    // whole reason the epic is survivable: without it, E3's first multi-
    // instance deploy would race on DDL.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureLedger(client);
    const p = plan(migrations, await readLedger(client));

    if (p.drifted.length) {
      const names = p.drifted.map(d => `${d.file} (applied ${d.appliedChecksum}, now ${d.checksum})`);
      throw new MigrationError(
        `these migrations changed after being applied: ${names.join(', ')}. ` +
        'Applying them again would produce a different schema from the one recorded. ' +
        'Write a NEW migration instead — forward-only means forward.');
    }
    if (dryRun) return { dryRun: true, ...p, applied: [] };

    for (const m of p.pending) {
      const started = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query(
          `INSERT INTO ${LEDGER_TABLE} (version, name, checksum, duration_ms) VALUES ($1,$2,$3,$4)`,
          [m.version, m.name, m.checksum, Date.now() - started]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new MigrationError(`${m.file} failed and was rolled back: ${err.message}`);
      }
      applied.push({ version: m.version, name: m.name, durationMs: Date.now() - started });
      console.log(`[DB] migrated ${m.file} (${Date.now() - started}ms)`);
    }
    return { dryRun: false, applied, pending: [], orphaned: p.orphaned, total: p.total };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
