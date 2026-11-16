#!/usr/bin/env node
/**
 * Whole-file store ⇄ owner partitions — operator CLI (scalability Phase 2b, step 6).
 *
 *   node scripts/partition-migrate.mjs --db <url> --store <name> --from <file.json|pg-blob> --mode dry-run
 *   node scripts/partition-migrate.mjs --db <url> --store <name> --from <file.json|pg-blob> --mode apply
 *   node scripts/partition-migrate.mjs --db <url> --store <name> --from <file.json|pg-blob> --mode reconcile
 *   node scripts/partition-migrate.mjs --db <url> --store <name> --mode export --out <file.json>
 *
 * <name>: reflection | mind | recall-redactions | history | reasoning-graph | ids | … (→ .aqua-<name>.json)
 *
 * Every run is recorded in aqua_store_partition_runs. Output: one JSON report on
 * stdout. Exit 0 = success (reconcile: clean), 1 = not clean, 2 = usage/refused.
 *
 * SAFETY
 *   · The database is taken ONLY from --db, never from the environment or .env.
 *   · A non-local host is refused without --allow-remote (Cloud SQL is an
 *     explicit, authorised step; see AQUIPLEX_PHASE_2B_REPORT.md §rollback).
 *   · Never imports core/dataDir.js (Mongo hydration at import).
 *   · `apply` never overwrites a partition: differing rows are reported, and a
 *     re-run after an interruption inserts only what is missing (idempotent).
 *   · `export` writes to --out only, and refuses to overwrite an existing file
 *     without --force.
 */
import fs from 'node:fs';

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const has = name => process.argv.includes(name);
const fail = (msg, code = 2) => { console.error(`✗ ${msg}`); process.exit(code); };

const DB = arg('--db');
if (!DB) fail('--db <postgres url> is required (never read from the environment)');
let host;
try { host = new URL(DB).hostname; } catch { fail('--db is not a valid URL'); }
if (!['localhost', '127.0.0.1', '::1'].includes(host) && !has('--allow-remote')) fail(`refusing non-local database host ${host} without --allow-remote`);
const name = arg('--store');
if (!name) fail('--store <name> is required');
const storeKey = name.startsWith('.') ? name : `.aqua-${name}.json`;
const mode = arg('--mode', 'dry-run');
if (!['dry-run', 'apply', 'reconcile', 'export'].includes(mode)) fail(`unknown --mode ${mode}`);

process.env.DATABASE_URL = DB;   // read by core/db/pool.js only
const { readBlobSource, migrateStoreText, reconcileStore, exportStore, ownerResolverFor } = await import('../src/core/storage/partitionMigration.js');
// Rows that belong to a user they do not name: attachments (→ --history), workspaces,
// project indexes and "ws:" vectors (→ --projects).
const readOpt = flagName => { const p = arg(flagName); if (!p) return null; if (!fs.existsSync(p)) fail(`${flagName} ${p} does not exist`); return fs.readFileSync(p, 'utf8'); };
const resolveOwner = ownerResolverFor(storeKey, { historyText: readOpt('--history'), projectsText: readOpt('--projects') });
if (['.aqua-attachments.json'].includes(storeKey) && !resolveOwner && mode !== 'export') fail('attachments need --history <.aqua-history.json> to place each list under its user');
if (['.aqua-projects.json', '.aqua-index.json'].includes(storeKey) && !resolveOwner && mode !== 'export') fail(`${storeKey} needs --projects <.aqua-projects.json> to place each workspace under its user`);
const { migrate } = await import('../src/core/db/migrate.js');
const { closePool } = await import('../src/core/db/pool.js');

let report;
let code = 0;
try {
  await migrate();
  if (mode === 'export') {
    const out = arg('--out');
    if (!out) fail('--out <file> is required for export');
    if (fs.existsSync(out) && !has('--force')) fail(`${out} exists (use --force to overwrite)`);
    const text = await exportStore({ storeKey });
    if (text === null) fail(`${storeKey} has no partitions`, 1);
    fs.writeFileSync(out, text);
    report = { storeKey, mode, out, bytes: Buffer.byteLength(text) };
  } else {
    const from = arg('--from');
    if (!from) fail('--from <file.json | pg-blob> is required');
    const source = from === 'pg-blob' ? 'pg-blob' : 'json-file';
    const text = source === 'pg-blob' ? await readBlobSource(storeKey) : (fs.existsSync(from) ? fs.readFileSync(from, 'utf8') : null);
    if (text == null) fail(`no source data for ${storeKey} in ${from}`, 1);
    if (mode === 'reconcile') {
      report = await reconcileStore({ storeKey, text, source, resolveOwner });
      if (!report.clean) code = 1;
    } else {
      report = await migrateStoreText({ storeKey, text, mode, source, resolveOwner });
    }
  }
} finally {
  await closePool();
}
console.log(JSON.stringify(report));
process.exit(code);
