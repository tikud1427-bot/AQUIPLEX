#!/usr/bin/env node
/**
 * Conversation history → per-user Postgres partitions: audit, dry run,
 * migration, verification, export and rollback check (scalability Phase 4A).
 *
 *   inventory  --history <file> [--mirror-export <aqua_kv export>] [--trash <file>] [--users <ids file>]
 *              no database: counts by owner and storage type, missing owners,
 *              duplicates, malformed records, file ⇄ mirror ⇄ conflict-copy differences
 *   plan       --db <url> --history <file> [...]       inventory + dry run against the target
 *   apply      --db <url> --history <file> [--trash <file>] [--exclude-deleted]
 *   verify     --db <url> --history <file> [--exclude-deleted]   every conversation reassembled
 *              from the partitions equals the source (header + ordered messages) + reconcile
 *   export     --db <url> --out <file>                 the rollback file (store JSON rebuilt from partitions)
 *   rollback-check --db <url> --history <file>         export → identical to the source (canonical)
 *
 * --history may be "mirror" to use the live document of --mirror-export.
 * --union writes the file ⇄ mirror ⇄ conflict-copy union to --out (inventory only)
 * for an operator who decides to migrate it; differences are listed, never silent.
 *
 * SAFETY: the database comes only from --db (never the environment); a
 * non-local host is refused without --allow-remote. Production is never read
 * directly: sources are files the operator exported (mongoexport of aqua_kv,
 * a copy of the data directory). Reports name owners and conversations by
 * hash only — no ids, no content.
 */
import fs from 'node:fs';

// stdout carries ONLY the JSON report (operators pipe it); every module's log line goes to stderr.
const emitReport = obj => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
console.log = (...a) => console.error(...a);

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const has = n => process.argv.includes(n);
const fail = (msg, code = 2) => { console.error(`✗ ${msg}`); process.exit(code); };
const mode = process.argv[2];
if (!['inventory', 'plan', 'apply', 'verify', 'export', 'rollback-check'].includes(mode)) {
  fail('usage: history-migration.mjs <inventory|plan|apply|verify|export|rollback-check> [options] (see the header)');
}
const STORE = '.aqua-history.json';
const TRASH = '.aqua-history-trash.json';
const H = await import('../src/core/storage/historyMigration.js');
const read = p => { if (!fs.existsSync(p)) fail(`${p} does not exist`); return fs.readFileSync(p, 'utf8'); };

// ── sources ──────────────────────────────────────────────────────────────────
const mirror = arg('--mirror-export') ? H.readMirrorExport(read(arg('--mirror-export')), STORE) : null;
let historyText = null;
if (arg('--history') === 'mirror') { historyText = mirror?.live ?? fail('--history mirror: the export has no live .aqua-history.json document', 1); }
else if (arg('--history')) historyText = read(arg('--history'));
const trashText = arg('--trash') ? read(arg('--trash')) : null;
const knownUserIds = arg('--users') ? new Set(read(arg('--users')).split(/[\s,"[\]]+/).filter(Boolean)) : null;

// ── database (plan / apply / verify / export / rollback-check) ───────────────
const DB = arg('--db');
let P = null;
let deletedOwners = null;
if (mode !== 'inventory') {
  if (!DB) fail('--db <postgres url> is required (never read from the environment)');
  let host; try { host = new URL(DB).hostname; } catch { fail('--db is not a valid URL'); }
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && !has('--allow-remote')) fail(`refusing non-local database host ${host} without --allow-remote`);
  process.env.DATABASE_URL = DB;
  const { migrate } = await import('../src/core/db/migrate.js');
  await migrate();
  P = await import('../src/core/storage/partitionMigration.js');
  const { getPool } = await import('../src/core/db/pool.js');
  const rows = (await (await getPool()).query('SELECT owner_id FROM aqua_deleted_owners').catch(() => ({ rows: [] }))).rows;
  deletedOwners = new Set(rows.map(r => r.owner_id));
}

/** The source without conversations of deleted accounts (they must not come back). */
function withoutDeleted(text) {
  if (!has('--exclude-deleted') || !deletedOwners?.size) return text;
  const { data, envelope } = H.parseHistoryText(text);
  const doc = JSON.parse(text);
  const kept = {};
  for (const [id, conv] of data) {
    const owner = conv && !Array.isArray(conv) && conv.meta?.userId != null && String(conv.meta.userId) !== '' ? `user:${conv.meta.userId}` : `conv:${id}`;
    if (!deletedOwners.has(owner)) kept[id] = conv;
  }
  return JSON.stringify(envelope ? { ...doc, data: kept } : kept);
}

let report = { mode, at: new Date().toISOString() };
let code = 0;
try {
  if (mode === 'inventory' || mode === 'plan') {
    if (!historyText) fail('--history <file|mirror> is required');
    report.inventory = H.inventoryHistory(historyText, { label: arg('--history'), knownUserIds, deletedOwners });
    if (mirror) {
      report.mirror = { live: Boolean(mirror.live), conflictCopies: mirror.conflicts.length,
        localRecoveryCopies: mirror.conflicts.filter(c => c.localRecovery).length, problems: mirror.problems };
      const sources = [{ label: 'source', text: historyText }];
      if (mirror.live && arg('--history') !== 'mirror') sources.push({ label: 'mirror', text: mirror.live });
      mirror.conflicts.forEach((c, i) => sources.push({ label: `conflict-${i}${c.localRecovery ? '-local-recovery' : ''}`, text: c.text }));
      if (sources.length > 1) {
        const cmp = H.compareHistorySources(sources);
        const { unionText, ...rest } = cmp;
        report.sourceComparison = rest;
        if (has('--union')) {
          const out = arg('--out') ?? fail('--union needs --out <file>');
          if (fs.existsSync(out) && !has('--force')) fail(`${out} exists (use --force)`);
          fs.writeFileSync(out, unionText);
          report.unionWritten = out;
        }
      }
    }
    if (trashText) {
      // The trash file is a bare array of { id, deletedAt, ...conversation } snapshots (newest 40).
      const parsed = JSON.parse(trashText);
      const snaps = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
      const asMap = Object.fromEntries(snaps.map((t, i) => [`${String(i).padStart(6, '0')}:${t?.id ?? ''}`, t]));
      report.trash = { snapshots: snaps.length, ...H.inventoryHistory(JSON.stringify(asMap), { label: 'trash', knownUserIds, deletedOwners }) };
      // A conversation both live and in the trash: deleted, then written again (or restored).
      const live = H.parseHistoryText(historyText).data;
      report.trash.alsoLive = snaps.filter(t => t?.id && live.has(t.id)).length;
    }
    if (mode === 'plan') {
      report.dryRun = await P.migrateStoreText({ storeKey: STORE, text: withoutDeleted(historyText), mode: 'dry-run', source: 'json-file' });
      if (trashText) report.trashDryRun = await P.migrateStoreText({ storeKey: TRASH, text: trashText, mode: 'dry-run', source: 'json-file' });
    }
  } else if (mode === 'apply') {
    if (!historyText) fail('--history <file|mirror> is required');
    report.apply = await P.migrateStoreText({ storeKey: STORE, text: withoutDeleted(historyText), mode: 'apply', source: 'json-file' });
    if (trashText) report.trashApply = await P.migrateStoreText({ storeKey: TRASH, text: trashText, mode: 'apply', source: 'json-file' });
    if (report.apply.conflicting) code = 1;
  } else if (mode === 'verify') {
    if (!historyText) fail('--history <file|mirror> is required');
    const exported = await P.exportStore({ storeKey: STORE, record: false });
    const excludeOwners = has('--exclude-deleted') ? deletedOwners : null;
    report.verify = H.verifyHistoryPreserved(historyText, exported, { excludeOwners });
    report.reconcile = await P.reconcileStore({ storeKey: STORE, text: withoutDeleted(historyText), source: 'json-file' });
    if (!report.verify.clean) code = 1;
  } else if (mode === 'export') {
    const out = arg('--out') ?? fail('--out <file> is required');
    if (fs.existsSync(out) && !has('--force')) fail(`${out} exists (use --force)`);
    const text = await P.exportStore({ storeKey: STORE });
    if (text == null) fail('no history partitions', 1);
    fs.writeFileSync(out, text);
    report.export = { out, bytes: Buffer.byteLength(text), conversations: H.parseHistoryText(text).data.size };
  } else if (mode === 'rollback-check') {
    if (!historyText) fail('--history <file|mirror> is required');
    const text = await P.exportStore({ storeKey: STORE, record: false });
    const v = H.verifyHistoryPreserved(withoutDeleted(historyText), text);
    report.rollback = { conversationsRestorable: v.preserved, missing: v.missing, changed: v.changed, clean: v.clean };
    if (!v.clean) code = 1;
  }
} catch (err) {
  report.error = String(err?.stack ?? err).slice(0, 800);
  code = 2;
} finally {
  if (P) { const { closePool } = await import('../src/core/db/pool.js'); await closePool().catch(() => {}); }
}
emitReport(report);
process.exit(code);
