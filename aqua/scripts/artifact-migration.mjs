#!/usr/bin/env node
/**
 * Existing artifacts (local disk, classic v<N> layout) → shared object store +
 * partition rows (scalability Phase 4B). Operator-controlled; nothing runs
 * against production without an explicit, authorised run on its data.
 *
 *   plan     --root <artifacts dir copy> [--history f] [--deleted f]           audit + object plan (no writes)
 *   upload   --root <dir> --store pg|gcs [--gcs-bucket b] [--gcs-endpoint u] --db <url>
 *            every planned object, idempotent (same bytes = skipped); damaged artifacts skipped unless --include-damaged
 *   rows     --root <dir> --db <url> [--apply]   index entry + manifest → partition row a:<id> (dry run unless --apply)
 *   verify   --root <dir> --store … --db <url>   every object present with its sha256 + rows reconcile clean
 *   export   --db <url> --out <file>             rollback: the artifact rows as the index file shape
 *
 * Artifacts without an owner are reported and left on the local path (they
 * cannot be placed under a user). SAFETY: databases/buckets only from flags;
 * non-local hosts refused without --allow-remote. stdout = JSON report.
 */
import fs from 'node:fs';
import path from 'node:path';

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const has = n => process.argv.includes(n);
const fail = (m, c = 2) => { console.error(`✗ ${m}`); process.exit(c); };
console.log = (...a) => console.error(...a);
const mode = process.argv[2];
if (!['plan', 'upload', 'rows', 'verify', 'export'].includes(mode)) fail('usage: artifact-migration.mjs <plan|upload|rows|verify|export> …');
const STORE = '.aqua-artifacts.json';
const isLocal = u => { try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(u).hostname); } catch { return false; } };

const root = arg('--root');
if (mode !== 'export' && (!root || !fs.existsSync(root))) fail('--root <artifacts directory copy> is required');
const DB = arg('--db');
if (mode !== 'plan') {
  if (!DB) fail('--db <postgres url> is required');
  if (!isLocal(DB) && !has('--allow-remote')) fail('refusing a non-local database without --allow-remote');
  process.env.DATABASE_URL = DB;
}
const { auditArtifactRoot, verifyObjectPlan } = await import('../src/artifacts/artifactAudit.js');
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

function storeFromFlags() {
  const kind = arg('--store') ?? fail('--store pg|gcs is required');
  if (kind === 'gcs') {
    const endpoint = arg('--gcs-endpoint');
    if (endpoint && !isLocal(endpoint) && !has('--allow-remote')) fail('refusing a non-local GCS endpoint without --allow-remote');
    return import('../src/core/storage/objectStore.js').then(O => O.createGcsObjectStore({ bucket: arg('--gcs-bucket') ?? fail('--gcs-bucket is required'), ...(endpoint ? { endpoint } : {}) }));
  }
  if (kind === 'pg') return import('../src/core/storage/objectStore.js').then(O => O.createPgObjectStore());
  return fail(`unknown --store ${kind}`);
}

/** id → owner, from the manifests (the plan carries only hashed owners). */
function ownersByArtifact() {
  const out = new Map();
  for (const name of fs.readdirSync(root)) {
    const m = readJson(path.join(root, name, 'manifest.json'));
    if (m?.id) out.set(m.id, m.ownerId ?? null);
  }
  return out;
}
/** The index file + manifests as the partition store's text (bare map id → { …lite, manifest }). */
function storeText() {
  const doc = readJson(path.join(root, '.index.json')) ?? {};
  const index = doc.__aqua && 'data' in doc ? doc.data : doc;
  const map = {}; const skipped = [];
  for (const [id, lite] of Object.entries(index)) {
    const manifest = readJson(path.join(root, id, 'manifest.json'));
    if (!manifest) { skipped.push({ id, reason: 'no-manifest' }); continue; }
    if (!manifest.ownerId) { skipped.push({ id, reason: 'no-owner' }); continue; }
    map[id] = { ...lite, ownerId: manifest.ownerId, manifest };
  }
  return { text: JSON.stringify(map), skipped };
}

const report = { mode, at: new Date().toISOString() };
let code = 0;
try {
  if (mode === 'plan') {
    const conversationIds = arg('--history') ? new Set(Object.keys((d => (d.__aqua && 'data' in d ? d.data : d))(readJson(arg('--history')) ?? {}))) : null;
    const deletedOwners = arg('--deleted') ? new Set(fs.readFileSync(arg('--deleted'), 'utf8').split(/\s+/).filter(Boolean)) : null;
    const { plan, ...audit } = auditArtifactRoot(root, { conversationIds, deletedOwners });
    report.audit = audit;
    report.plan = { objects: plan.length, bytes: plan.reduce((s, o) => s + o.size, 0) };
    if (!audit.clean) code = 1;
  } else if (mode === 'upload') {
    const store = await storeFromFlags();
    const audit = auditArtifactRoot(root);
    const owners = ownersByArtifact();
    const damaged = new Set([...audit.integrity.indexWithoutManifest, ...audit.integrity.manifestUnreadable, ...audit.integrity.sample.map(s => s.artifact)]);
    const r = { planned: audit.plan.length, uploaded: 0, alreadyPresent: 0, skippedDamaged: 0, skippedNoOwner: 0, failed: 0, failures: [] };
    for (const o of audit.plan) {
      const id = o.key.split('/')[1];
      const owner = owners.get(id);
      if (!owner) { r.skippedNoOwner++; continue; }
      if (damaged.has(id) && !has('--include-damaged')) { r.skippedDamaged++; continue; }
      try {
        const bytes = fs.readFileSync(path.join(root, ...o.key.split('/').slice(1)));
        const res = await store.put(o.key, bytes, { ownerId: owner, contentType: o.contentType });
        if (res.created) r.uploaded++; else r.alreadyPresent++;
      } catch (err) { r.failed++; if (r.failures.length < 20) r.failures.push({ artifact: id, error: String(err?.message ?? err).slice(0, 160) }); }
    }
    report.upload = r;
    if (r.failed) code = 1;
  } else if (mode === 'rows') {
    const { migrate } = await import('../src/core/db/migrate.js'); await migrate();
    const P = await import('../src/core/storage/partitionMigration.js');
    const { text, skipped } = storeText();
    report.rows = await P.migrateStoreText({ storeKey: STORE, text, mode: has('--apply') ? 'apply' : 'dry-run', source: 'json-file' });
    report.skipped = skipped;
    if (report.rows.conflicting) code = 1;
  } else if (mode === 'verify') {
    const { migrate } = await import('../src/core/db/migrate.js'); await migrate();
    const store = await storeFromFlags();
    const audit = auditArtifactRoot(root);
    const owners = ownersByArtifact();
    const plan = audit.plan.filter(o => owners.get(o.key.split('/')[1]));
    report.objects = await verifyObjectPlan(plan, store, { ownerOf: o => owners.get(o.key.split('/')[1]) });
    const P = await import('../src/core/storage/partitionMigration.js');
    const { text } = storeText();
    const rec = await P.reconcileStore({ storeKey: STORE, text, source: 'json-file' });
    // The partition store also holds artifacts created after the switch: only THIS source must be present and equal.
    report.rows = { sourcePartitions: rec.sourcePartitions, missing: rec.missing, mismatched: rec.mismatched, tombstoned: rec.tombstoned, sample: rec.sample };
    if (!report.objects.clean || rec.missing || rec.mismatched) code = 1;
  } else if (mode === 'export') {
    const { migrate } = await import('../src/core/db/migrate.js'); await migrate();
    const P = await import('../src/core/storage/partitionMigration.js');
    const out = arg('--out') ?? fail('--out <file> is required');
    if (fs.existsSync(out) && !has('--force')) fail(`${out} exists (use --force)`);
    const text = await P.exportStore({ storeKey: STORE });
    if (text == null) fail('no artifact partitions', 1);
    fs.writeFileSync(out, text);
    report.export = { out, artifacts: Object.keys(JSON.parse(text)).length };
  }
} catch (err) {
  report.error = String(err?.stack ?? err).slice(0, 800); code = 2;
} finally {
  if (DB) { const { closePool } = await import('../src/core/db/pool.js'); await closePool().catch(() => {}); }
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
// No process.exit(): HTTP keep-alive sockets (GCS) may still be closing, and
// exiting under them aborts the process on Windows (libuv assertion). The event
// loop ends on its own.
process.exitCode = code;
