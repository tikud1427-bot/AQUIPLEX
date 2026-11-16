#!/usr/bin/env node
/**
 * Pending-charge recovery — operator CLI (scalability Phase 4B).
 *
 *   node aqua/scripts/charges-reconcile.mjs --db <postgres url> --mongo <mongo url> [--abandon-ms N] [--ledger [--user <id>]] [--stats]
 *
 * Runs ONE reconcile pass (the same function the worker's credits.reconcile.v1
 * job runs): abandoned PENDING charges → REFUND_PENDING → refunded once.
 * --ledger also compares every recent charge with the Mongo credit ledger and
 * lists anomalies (debited twice, committed but refunded, …).
 *
 * SAFETY: both databases come only from the flags; non-local hosts are refused
 * without --allow-remote. stdout = JSON report.
 */
const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const has = n => process.argv.includes(n);
const fail = (m, c = 2) => { console.error(`✗ ${m}`); process.exit(c); };
console.log = (...a) => console.error(...a);   // stdout carries only the report

const DB = arg('--db') ?? fail('--db <postgres url> is required');
const MONGO = arg('--mongo') ?? fail('--mongo <mongo url> is required');
const local = u => ['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(new URL(u.replace(/^mongodb(\+srv)?:/, 'http:')).hostname);
if ((!local(DB) || !local(MONGO)) && !has('--allow-remote')) fail('refusing a non-local database without --allow-remote');
process.env.DATABASE_URL = DB;
process.env.AQUA_PENDING_CHARGES = 'on';

const { migrate } = await import('../src/core/db/migrate.js');
await migrate();
const { runReconcile, walletAdapter } = await import('../src/credits/reconcileJob.js');
const PC = await import('../src/credits/pendingCharges.js');
const report = { at: new Date().toISOString() };
let code = 0;
try {
  const wallet = await walletAdapter({ mongoUri: MONGO });
  report.reconcile = await runReconcile({ wallet, ...(arg('--abandon-ms') ? { abandonMs: Number(arg('--abandon-ms')) } : {}) });
  if (has('--stats')) report.stats = await PC.chargeStats();
  if (has('--ledger')) {
    const { createRequire } = await import('node:module');
    const path = await import('node:path');
    const req = createRequire(path.resolve(process.cwd(), 'package.json'));
    const mongoose = req('mongoose');
    const rows = await mongoose.connection.db.collection('transactions')
      .find({ 'metadata.chargeId': { $exists: true } }, { projection: { type: 1, 'metadata.chargeId': 1 } }).toArray();
    // --user scopes the check to one account (the database may hold others whose ledger lives elsewhere).
    report.ledger = await PC.reconcileLedger({ ledger: rows.map(r => ({ type: r.type, chargeId: r.metadata?.chargeId })), userIds: arg('--user') ? [arg('--user')] : null });
    if (report.ledger.anomalies.length) code = 1;
  }
} catch (err) {
  report.error = String(err?.stack ?? err).slice(0, 600); code = 2;
} finally {
  const { closePool } = await import('../src/core/db/pool.js'); await closePool().catch(() => {});
  try { const { createRequire } = await import('node:module'); const path = await import('node:path'); createRequire(path.resolve(process.cwd(), 'package.json'))('mongoose').disconnect(); } catch { /* */ }
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(code);
