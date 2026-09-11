#!/usr/bin/env node
/**
 * AQUA — database CLI
 * Blueprint E3/PR-2
 *
 *   npm run db:status     what is applied, what is pending  (read-only)
 *   npm run db:migrate    apply everything pending
 *   npm run db:migrate -- --dry-run     plan only, touch nothing
 *
 * EXIT CODES
 *   0  up to date, or a dry run that found a coherent plan
 *   1  a migration failed, or the set on disk is incoherent
 *   2  DATABASE_URL is not set
 *
 * The distinct code for "not configured" matters: a deploy script that treats
 * an unconfigured database as success will happily start an app whose schema
 * was never created.
 */
import { migrate, status, discover, validate, MigrationError } from './migrate.js';
import { isConfigured, closePool, bootLine } from './pool.js';

const args = process.argv.slice(2);
const wantStatus = args.includes('--status');
const wantDrift = args.includes('--drift');
const dryRun = args.includes('--dry-run');

console.log(bootLine());

// Validate the files on disk FIRST. An incoherent set is a mistake worth
// reporting even on a machine with no database attached.
try {
  validate(discover());
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}

if (!isConfigured()) {
  console.error('\n✗ DATABASE_URL is not set. The migration files are valid, but there is nothing to apply them to.');
  process.exit(2);
}

try {
  if (wantDrift) {
    const { checkDrift, driftLine, cleanSince } = await import('./drift.js');
    const r = await checkDrift();
    console.log(`\n${driftLine(r)}`);
    for (const m of r.mismatched ?? []) console.log(`   ✗ ${m.key}  primary ${m.primary}  postgres ${m.shadow}`);
    for (const k of r.missingShadow ?? []) console.log(`   ✗ ${k} — never reached postgres`);
    for (const k of r.missingPrimary ?? []) console.log(`   ! ${k} — row with no store file`);
    const history = await cleanSince();
    if (history?.cleanSince) console.log(`\n   clean since ${new Date(history.cleanSince).toISOString()} over ${history.runs} recorded run(s)`);
    process.exit(r.clean ? 0 : 1);
  }

  if (wantStatus) {
    const s = await status();
    console.log(`\n   status     ${s.status}`);
    console.log(`   applied    ${s.applied} of ${s.total}`);
    if (s.pending.length) console.log(`   pending    ${s.pending.map(m => m.file).join(', ')}`);
    if (s.drifted.length) console.log(`   ✗ DRIFTED  ${s.drifted.map(m => m.file).join(', ')}`);
    if (s.orphaned.length) console.log(`   ! orphaned ${s.orphaned.join(', ')} (applied, but the file is gone)`);
    process.exit(s.drifted.length ? 1 : 0);
  }

  const r = await migrate({ dryRun });
  if (r.dryRun) {
    console.log(`\n   dry run — ${r.pending.length} pending: ${r.pending.map(m => m.file).join(', ') || 'none'}`);
  } else if (r.applied.length === 0) {
    console.log('\n✓ up to date — nothing to apply');
  } else {
    console.log(`\n✓ applied ${r.applied.length} migration(s)`);
  }
  process.exit(0);
} catch (err) {
  console.error(`\n✗ ${err instanceof MigrationError ? err.message : err.stack}`);
  process.exit(1);
} finally {
  await closePool();
}
