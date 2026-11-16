/**
 * AQUA Storage — whole-file store → owner partitions: migrate, reconcile, export
 * (scalability Phase 2a)
 *
 * Three operations, each recorded in `aqua_store_partition_runs`:
 *
 *   migrate    split a store file (from a JSON file or an aqua_store_blobs row)
 *              and INSERT the partitions that are not there yet. It never
 *              overwrites: a partition that already exists with different
 *              content is reported as conflicting and left alone, because after
 *              a cutover the partition is newer than any file. Idempotent: a
 *              second run inserts nothing and reports every partition identical.
 *   reconcile  compare a source file with the partitions: missing, extra,
 *              mismatched, tombstoned, plus the canonical checksum of the
 *              reassembled store against the source. `clean` only when all are
 *              zero and the checksums match.
 *   export     reassemble the live partitions into the store file's JSON. This
 *              is the rollback path: the text loads in the existing JSON code,
 *              unchanged.
 *
 * Never imports core/dataDir.js. That module hydrates from Mongo at import time
 * (the 2026-10-09 incident). A migration tool must not touch the mirror.
 */
import fs from 'node:fs';
import path from 'node:path';

import { getPool } from '../db/pool.js';
import { splitStore, reassembleStore, canonicalChecksum, partitionChecksum, REST_KEY } from './partitionLayout.js';
import { createPartitionRepository, TABLE } from './partitionRepository.js';

const RUNS = 'aqua_store_partition_runs';
const BATCH = 200;

async function resolvePool(pool) {
  const p = pool ?? (await getPool());
  if (!p) throw new Error('partition migration: DATABASE_URL is not configured');
  return p;
}

/** Read a store's text from a JSON file in a data directory. Null when absent. */
export function readJsonFileSource(dataDir, storeKey) {
  const file = path.join(dataDir, storeKey);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** Read a store's text from the E3 blob table. Null when absent. */
export async function readBlobSource(storeKey, { pool } = {}) {
  const p = await resolvePool(pool);
  const { rows } = await p.query('SELECT data FROM aqua_store_blobs WHERE store_key = $1', [storeKey]);
  return rows[0]?.data ?? null;
}

async function recordRun(p, run) {
  const { rows } = await p.query(
    `INSERT INTO ${RUNS} (store_key, kind, mode, source, source_checksum, source_bytes, partitions,
                          inserted, identical, conflicting, clean, report, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb, now()) RETURNING run_id`,
    [run.storeKey, run.kind, run.mode, run.source, run.sourceChecksum ?? null, run.sourceBytes ?? null,
      run.partitions ?? 0, run.inserted ?? 0, run.identical ?? 0, run.conflicting ?? 0,
      run.clean ?? null, JSON.stringify(run.report ?? {})]);
  return Number(rows[0].run_id);
}

/** Existing rows for these partition keys, in one query. */
async function existingRows(p, storeKey, keys) {
  const out = new Map();
  for (let i = 0; i < keys.length; i += 1000) {
    const { rows } = await p.query(
      `SELECT partition_key, owner_id, checksum, version, deleted_at FROM ${TABLE}
        WHERE store_key = $1 AND partition_key = ANY($2)`, [storeKey, keys.slice(i, i + 1000)]);
    for (const r of rows) out.set(r.partition_key, r);
  }
  return out;
}

/**
 * Tombstones implied by the file itself. Mind records whole-owner deletions in
 * its envelope (`__aqua.deletedOwners`), not as absent keys. Migrating them as
 * tombstone rows means a stale copy of that owner can never be inserted later.
 */
function impliedTombstones(storeKey, text, partitionKeys) {
  if (storeKey !== '.aqua-mind.json') return [];
  let doc;
  try { doc = JSON.parse(text); } catch { return []; }
  const deleted = doc?.__aqua?.deletedOwners;
  if (!deleted || typeof deleted !== 'object') return [];
  return Object.keys(deleted)
    .map(owner => ({ partitionKey: `o:${owner}`, ownerId: owner }))
    .filter(t => !partitionKeys.has(t.partitionKey));
}

/**
 * @param {object} args
 * @param {string} args.storeKey
 * @param {string} args.text           the store file's JSON text
 * @param {'dry-run'|'apply'} [args.mode]
 * @param {'json-file'|'pg-blob'} [args.source]
 * @param {object} [args.pool]
 */
/** conversationId → owner, from the history file (attachments belong to their conversation's user). */
export function ownerMapFromHistory(historyText) {
  const doc = JSON.parse(historyText);
  const data = doc?.__aqua && 'data' in doc ? doc.data : doc;
  const out = new Map();
  for (const [id, conv] of Object.entries(data ?? {})) {
    const uid = Array.isArray(conv) ? null : conv?.meta?.userId;
    if (uid != null && String(uid) !== '') out.set(id, `user:${uid}`);
  }
  return out;
}

/** workspaceId → owner, from the projects file (workspaces, their indexes and "ws:" vectors). */
export function ownerMapFromProjects(projectsText) {
  const data = JSON.parse(projectsText);
  const out = new Map();
  for (const [id, ws] of Object.entries(data ?? {})) if (ws?.ownerId) out.set(id, String(ws.ownerId));
  return out;
}

/**
 * The owner resolver for stores whose rows belong to a user the row itself
 * does not name. Returns (partitionKey, layoutOwner) => owner. Unresolved keys
 * keep the layout's owner (conv:<id> / ws:<id>) and are COUNTED: such rows are
 * not loaded by any user's request until their owner is backfilled.
 */
export function ownerResolverFor(storeKey, { historyText = null, projectsText = null } = {}) {
  const conv = historyText ? ownerMapFromHistory(historyText) : null;
  const ws = projectsText ? ownerMapFromProjects(projectsText) : null;
  if (storeKey === '.aqua-attachments.json' && conv) return (pk, dflt) => conv.get(pk.slice(2)) ?? dflt;
  if ((storeKey === '.aqua-projects.json' || storeKey === '.aqua-index.json') && ws) return (pk, dflt) => ws.get(pk.slice(3)) ?? dflt;
  if (storeKey === '.aqua-vectors.json' && ws) return (pk, dflt) => (pk.startsWith('ns:ws:') ? ws.get(pk.slice(6)) ?? dflt : dflt);
  return null;
}

export async function migrateStoreText({ storeKey, text, mode = 'dry-run', source = 'json-file', pool, resolveOwner = null } = {}) {
  if (mode !== 'dry-run' && mode !== 'apply') throw new Error(`migrate: mode must be dry-run or apply, got ${mode}`);
  const p = await resolvePool(pool);
  const { partitions } = splitStore(storeKey, text);
  let unresolvedOwners = 0;
  if (resolveOwner) {
    for (const part of partitions) {
      if (part.partitionKey === REST_KEY) continue;
      const owner = resolveOwner(part.partitionKey, part.ownerId);
      if (owner === part.ownerId && /^(conv|ws):/.test(owner)) unresolvedOwners++;
      part.ownerId = owner;
    }
  }
  const keys = new Set(partitions.map(x => x.partitionKey));
  const tombstones = impliedTombstones(storeKey, text, keys);
  const existing = await existingRows(p, storeKey, [...keys, ...tombstones.map(t => t.partitionKey)]);

  const toInsert = [];
  const conflicts = [];
  const tombstoned = [];
  let identical = 0;
  for (const part of partitions) {
    const cur = existing.get(part.partitionKey);
    if (!cur) { toInsert.push(part); continue; }
    if (cur.deleted_at != null) { tombstoned.push(part.partitionKey); continue; }
    if (cur.checksum === partitionChecksum(part.data) && cur.owner_id === part.ownerId) identical++;
    else conflicts.push({ partitionKey: part.partitionKey, reason: cur.owner_id === part.ownerId ? 'content-differs' : 'owner-differs' });
  }
  const newTombstones = tombstones.filter(t => !existing.has(t.partitionKey));

  let inserted = 0;
  let tombstonesCreated = 0;
  if (mode === 'apply') {
    const repo = createPartitionRepository({ pool: p, instanceId: 'partition-migration' });
    const ops = [
      ...toInsert.map(x => ({ storeKey, partitionKey: x.partitionKey, ownerId: x.ownerId, data: x.data, ordinal: x.ordinal, expectedVersion: 0 })),
      ...newTombstones.map(t => ({ storeKey, partitionKey: t.partitionKey, ownerId: t.ownerId, data: null, expectedVersion: 0 })),
    ];
    // Batches are each all-or-nothing. A concurrent writer that created one of
    // these rows between the read above and the insert makes the batch fail with
    // a conflict, and nothing of that batch is written; re-running continues.
    for (let i = 0; i < ops.length; i += BATCH) {
      const batch = ops.slice(i, i + BATCH);
      await repo.transact(batch);
      for (const o of batch) { if (o.data === null) tombstonesCreated++; else inserted++; }
    }
  }

  const report = {
    storeKey, mode, source,
    partitions: partitions.length,
    owners: new Set(partitions.filter(x => x.partitionKey !== REST_KEY).map(x => x.ownerId)).size,
    wouldInsert: toInsert.length, inserted, identical,
    conflicting: conflicts.length, conflicts: conflicts.slice(0, 50),
    tombstonedInPartitions: tombstoned.length,
    impliedTombstones: newTombstones.length, tombstonesCreated,
    sourceBytes: Buffer.byteLength(text, 'utf8'),
    sourceChecksum: canonicalChecksum(text),
    unresolvedOwners,
  };
  report.runId = await recordRun(p, {
    storeKey, kind: 'migrate', mode, source, sourceChecksum: report.sourceChecksum, sourceBytes: report.sourceBytes,
    partitions: partitions.length, inserted, identical, conflicting: conflicts.length,
    clean: conflicts.length === 0 && tombstoned.length === 0,
    report: { ...report, conflicts: conflicts.slice(0, 50) },
  });
  return report;
}

/**
 * Compare a source file with what the partitions hold now.
 * Conflict detail names partition keys only, never content.
 */
export async function reconcileStore({ storeKey, text, source = 'json-file', pool, record = true, resolveOwner = null } = {}) {
  const p = await resolvePool(pool);
  const repo = createPartitionRepository({ pool: p, instanceId: 'partition-reconcile' });
  const { partitions } = splitStore(storeKey, text);
  if (resolveOwner) for (const part of partitions) if (part.partitionKey !== REST_KEY) part.ownerId = resolveOwner(part.partitionKey, part.ownerId);
  const rows = await repo.listStore(storeKey, { includeDeleted: true });
  const byKey = new Map(rows.map(r => [r.partitionKey, r]));
  const srcKeys = new Set(partitions.map(x => x.partitionKey));

  const missing = [];
  const mismatched = [];
  const tombstoned = [];
  for (const part of partitions) {
    const r = byKey.get(part.partitionKey);
    if (!r) missing.push(part.partitionKey);
    else if (r.deleted) tombstoned.push(part.partitionKey);
    else if (r.data !== part.data || r.ownerId !== part.ownerId) mismatched.push(part.partitionKey);
  }
  const extra = rows.filter(r => !r.deleted && !srcKeys.has(r.partitionKey)).map(r => r.partitionKey);
  const live = rows.filter(r => !r.deleted);
  const reassembled = live.length ? reassembleStore(storeKey, live) : null;
  const sourceChecksum = canonicalChecksum(text);
  const partitionsChecksum = reassembled ? canonicalChecksum(reassembled) : null;

  const clean = !missing.length && !mismatched.length && !tombstoned.length && !extra.length
    && sourceChecksum === partitionsChecksum;
  const report = {
    storeKey, source, clean,
    sourcePartitions: partitions.length, livePartitions: live.length,
    missing: missing.length, mismatched: mismatched.length, tombstoned: tombstoned.length, extra: extra.length,
    sample: { missing: missing.slice(0, 20), mismatched: mismatched.slice(0, 20), tombstoned: tombstoned.slice(0, 20), extra: extra.slice(0, 20) },
    sourceChecksum, partitionsChecksum,
  };
  if (record) {
    report.runId = await recordRun(p, {
      storeKey, kind: 'reconcile', mode: 'dry-run', source, sourceChecksum, sourceBytes: Buffer.byteLength(text, 'utf8'),
      partitions: live.length, identical: live.length - mismatched.length, conflicting: mismatched.length + missing.length + extra.length,
      clean, report,
    });
  }
  return report;
}

/**
 * Reassemble the store's JSON text from its live partitions: the rollback path.
 * Returns null when the store has no partitions at all.
 */
export async function exportStore({ storeKey, pool, record = true } = {}) {
  const p = await resolvePool(pool);
  const repo = createPartitionRepository({ pool: p, instanceId: 'partition-export' });
  const live = await repo.listStore(storeKey);
  if (!live.length) return null;
  const text = reassembleStore(storeKey, live);
  if (record) {
    await recordRun(p, { storeKey, kind: 'export', mode: 'dry-run', source: 'partitions',
      sourceChecksum: canonicalChecksum(text), sourceBytes: Buffer.byteLength(text, 'utf8'), partitions: live.length,
      report: { partitions: live.length } });
  }
  return text;
}
