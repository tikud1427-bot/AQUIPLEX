/**
 * AQUA Storage — owner-partitioned repository (scalability Phase 2a)
 *
 * One row per (store, partition) in `aqua_store_partitions` (migration 0026).
 * One owner's update touches that owner's rows only.
 *
 * NOTHING IN PRODUCTION USES THIS YET. It is the substrate that Phase 2b cuts
 * stores over to, one store at a time behind a flag. The battery's pool guard
 * (dbPool.test.js) lists it on purpose.
 *
 * THE CONTRACT
 * ------------
 *   Everything is async, and says so. There is no `readSync`: Node has no
 *   synchronous Postgres client (E3/PR-4), and a hydrate-everything cache is
 *   exactly the whole-world load this replaces. Consumers load an OWNER at the
 *   start of a unit of work (a request, a job) with `loadOwner` and work from
 *   the cache inside it.
 *
 *   Optimistic concurrency. A write states the version it read. If the row has
 *   moved, nothing is written and the caller gets PartitionConflictError. A
 *   write that has not read the row first is refused: writing over a value
 *   nobody looked at is the lost update this layer exists to prevent.
 *   `update(mutate)` is the read-modify-write loop that re-applies the
 *   mutation to the latest value on conflict. It is what consumers should use.
 *
 *   Tombstones. `delete` keeps the row with data NULL and a new version, so a
 *   writer holding a pre-deletion version cannot resurrect the data, and a
 *   writer that never read the row cannot insert over the tombstone either.
 *   Re-creating deleted data is a write that has SEEN the tombstone.
 *
 *   Ownership. Every row carries owner_id. A write may not move a row to
 *   another owner (the UPDATE predicate includes owner_id). A read that names
 *   an owner refuses a row belonging to someone else (PartitionOwnershipError).
 *
 *   Bounded cache. LRU by entry count and by bytes. Writes go through to the
 *   database before they enter the cache, so the cache never holds anything the
 *   database does not, and eviction can never lose a write.
 *
 *   Cross-instance freshness. `refreshOwner` compares the cached versions with
 *   the database's in one index range scan and drops what moved. Correctness
 *   never depends on it: a stale cache entry produces a conflict, not a lost
 *   update. It is what makes reads current at the start of a unit of work.
 */
import os from 'node:os';
import crypto from 'node:crypto';

import { getPool } from '../db/pool.js';
import { partitionChecksum } from './partitionLayout.js';
import { withOwnerFence, checkFenceOn } from './writeFence.js';
import { OwnerDeletedError, noteOwnerDeleted } from './deletedOwners.js';

export const TABLE = 'aqua_store_partitions';

// Account-deletion barrier, part 2 (part 1: deletedOwners.assertOwnerLive in the
// same transaction). Every write that can put owner DATA into a row carries
// this predicate, so the statement itself never writes for a deleted owner.
// Tombstones do not: they are the purge. $OWNER is the statement's owner param.
const LIVE_OWNER = p => `NOT EXISTS (SELECT 1 FROM aqua_deleted_owners d WHERE d.owner_id = ${p})`;

export class PartitionConflictError extends Error {
  constructor(storeKey, partitionKey, expected, actual) {
    super(`partition ${storeKey}/${partitionKey} moved: expected version ${expected}, found ${actual ?? 'none'}`);
    this.name = 'PartitionConflictError';
    this.storeKey = storeKey;
    this.partitionKey = partitionKey;
    this.expected = expected;
    this.actual = actual ?? null;
  }
}

export class PartitionOwnershipError extends Error {
  constructor(storeKey, partitionKey) {
    // Never prints either owner id: this message can reach a log.
    super(`partition ${storeKey}/${partitionKey} belongs to a different owner`);
    this.name = 'PartitionOwnershipError';
    this.storeKey = storeKey;
    this.partitionKey = partitionKey;
  }
}

export class UnreadWriteError extends Error {
  constructor(storeKey, partitionKey) {
    super(`refusing to write ${storeKey}/${partitionKey} without reading it first — use get() or update()`);
    this.name = 'UnreadWriteError';
  }
}

// Literal process.env reads, so the flag registry's scanner sees them (flags.js SETTINGS).
const positive = (raw, dflt) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const ck = (storeKey, partitionKey) => `${storeKey}\u0000${partitionKey}`;
const toVersion = v => (v == null ? 0 : Number(v));

/**
 * @param {object} [opts]
 * @param {object} [opts.pool]        a pg Pool (default: the process pool). Tests pass separate pools to model separate instances.
 * @param {string} [opts.instanceId]  written to updated_by (diagnostics only)
 * @param {number} [opts.maxEntries]  cache bound by entries (AQUA_PARTITION_CACHE_ENTRIES, default 5000)
 * @param {number} [opts.maxBytes]    cache bound by bytes (AQUA_PARTITION_CACHE_BYTES, default 64 MB)
 */
export function createPartitionRepository({
  pool: injectedPool = null,
  instanceId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`,
  maxEntries = positive(process.env.AQUA_PARTITION_CACHE_ENTRIES, 5_000),
  maxBytes = positive(process.env.AQUA_PARTITION_CACHE_BYTES, 64 * 1024 * 1024),
} = {}) {
  /** cacheKey → { storeKey, partitionKey, ownerId, data, version, deleted, bytes } ; Map order = LRU order */
  const cache = new Map();
  /** ownerId → Set<cacheKey> */
  const byOwner = new Map();
  let cachedBytes = 0;

  const stats = {
    reads: 0, cacheHits: 0, writes: 0, deletes: 0, conflicts: 0, retries: 0,
    ownershipRefusals: 0, bytesWritten: 0, evictions: 0, refreshedStale: 0,
  };

  async function pool() {
    const p = injectedPool ?? (await getPool());
    if (!p) throw new Error('partition repository: DATABASE_URL is not configured');
    return p;
  }

  // ── cache ────────────────────────────────────────────────────────────────
  function cacheDrop(key) {
    const e = cache.get(key);
    if (!e) return;
    cache.delete(key);
    cachedBytes -= e.bytes;
    const set = byOwner.get(e.ownerId);
    if (set) { set.delete(key); if (!set.size) byOwner.delete(e.ownerId); }
  }

  function cachePut(entry) {
    const key = ck(entry.storeKey, entry.partitionKey);
    cacheDrop(key);
    const e = { ...entry, bytes: entry.data == null ? 64 : Buffer.byteLength(entry.data, 'utf8') + 64 };
    cache.set(key, e);
    cachedBytes += e.bytes;
    if (!byOwner.has(e.ownerId)) byOwner.set(e.ownerId, new Set());
    byOwner.get(e.ownerId).add(key);
    // Evict least-recently-used. Safe by construction: nothing here is unwritten.
    while ((cache.size > maxEntries || cachedBytes > maxBytes) && cache.size > 1) {
      const oldest = cache.keys().next().value;
      cacheDrop(oldest);
      stats.evictions++;
    }
    return e;
  }

  function cacheTouch(key) {
    const e = cache.get(key);
    if (!e) return null;
    cache.delete(key);
    cache.set(key, e);
    return e;
  }

  const view = e => (e ? { data: e.deleted ? null : e.data, version: e.version, deleted: e.deleted, deletedAt: e.deletedAt ?? null, ownerId: e.ownerId } : null);
const msOf = t => (t == null ? null : (t instanceof Date ? t.getTime() : Date.parse(t)));

  function assertOwner(entry, ownerId, storeKey, partitionKey) {
    if (ownerId === undefined || entry == null || entry.version === 0) return;
    if (entry.ownerId !== String(ownerId)) {
      stats.ownershipRefusals++;
      throw new PartitionOwnershipError(storeKey, partitionKey);
    }
  }

  // ── reads ────────────────────────────────────────────────────────────────
  async function readRow(q, storeKey, partitionKey) {
    const { rows } = await q.query(
      `SELECT owner_id, data, version, deleted_at FROM ${TABLE} WHERE store_key = $1 AND partition_key = $2`,
      [storeKey, partitionKey]);
    return rows[0] ?? null;
  }

  /**
   * One partition. Served from the cache unless `fresh`. An absent row is
   * cached too (version 0), so `put` after `get` knows it is creating.
   * @returns {Promise<{data: string|null, version: number, deleted: boolean, ownerId: string}>}
   *          version 0 means the row does not exist.
   */
  async function get(storeKey, partitionKey, { ownerId, fresh = false } = {}) {
    const key = ck(storeKey, partitionKey);
    if (!fresh) {
      const hit = cacheTouch(key);
      if (hit) { stats.cacheHits++; assertOwner(hit, ownerId, storeKey, partitionKey); return view(hit); }
    }
    stats.reads++;
    const row = await readRow(await pool(), storeKey, partitionKey);
    const entry = row
      ? cachePut({ storeKey, partitionKey, ownerId: row.owner_id, data: row.data, version: toVersion(row.version), deleted: row.deleted_at != null, deletedAt: msOf(row.deleted_at) })
      : cachePut({ storeKey, partitionKey, ownerId: ownerId === undefined ? '' : String(ownerId), data: null, version: 0, deleted: false });
    assertOwner(entry, ownerId, storeKey, partitionKey);
    return view(entry);
  }

  /**
   * Every partition an owner has, in the given stores (default: all), in ONE
   * query. Fills the cache. This is the unit-of-work load.
   * @returns {Promise<Map<string, Map<string, {data, version, deleted}>>>} storeKey → partitionKey → row
   */
  async function loadOwner(ownerId, { stores = null, includeDeleted = false } = {}) {
    const p = await pool();
    const { rows } = await p.query(
      `SELECT store_key, partition_key, owner_id, data, version, deleted_at FROM ${TABLE}
        WHERE owner_id = $1 AND ($2::text[] IS NULL OR store_key = ANY($2))`,
      [String(ownerId), stores]);
    stats.reads++;
    const out = new Map();
    for (const r of rows) {
      const e = cachePut({ storeKey: r.store_key, partitionKey: r.partition_key, ownerId: r.owner_id,
        data: r.data, version: toVersion(r.version), deleted: r.deleted_at != null, deletedAt: msOf(r.deleted_at) });
      if (e.deleted && !includeDeleted) continue;
      if (!out.has(r.store_key)) out.set(r.store_key, new Map());
      out.get(r.store_key).set(r.partition_key, view(e));
    }
    return out;
  }

  /**
   * Drop cached entries of this owner whose version moved in the database
   * (written by another instance), or that no longer exist. One index scan.
   */
  async function refreshOwner(ownerId) {
    const owner = String(ownerId);
    const p = await pool();
    const { rows } = await p.query(
      `SELECT store_key, partition_key, version FROM ${TABLE} WHERE owner_id = $1`, [owner]);
    const live = new Map(rows.map(r => [ck(r.store_key, r.partition_key), toVersion(r.version)]));
    let stale = 0;
    for (const key of [...(byOwner.get(owner) ?? [])]) {
      const e = cache.get(key);
      if (!e) continue;
      const v = live.get(key);
      if ((v === undefined && e.version !== 0) || (v !== undefined && v !== e.version)) { cacheDrop(key); stale++; }
    }
    stats.refreshedStale += stale;
    return { checked: rows.length, stale };
  }

  /**
   * Versions only (no data) of an owner's partitions in the given stores: the
   * cheap first half of a unit-of-work load. Rows whose version the caller
   * already holds need not be fetched again.
   * @returns {Promise<Map<string, Map<string, {version:number, deleted:boolean, deletedAt:number|null}>>>}
   */
  async function ownerVersions(ownerId, stores) {
    const { rows } = await (await pool()).query(
      `SELECT store_key, partition_key, version, deleted_at FROM ${TABLE}
        WHERE owner_id = $1 AND store_key = ANY($2)`, [String(ownerId), stores]);
    stats.reads++;
    const out = new Map();
    for (const r of rows) {
      if (!out.has(r.store_key)) out.set(r.store_key, new Map());
      out.get(r.store_key).set(r.partition_key, { version: toVersion(r.version), deleted: r.deleted_at != null, deletedAt: msOf(r.deleted_at) });
    }
    return out;
  }

  /** Several partitions of one store with data, in one query; fills the cache. */
  async function getMany(storeKey, partitionKeys) {
    const out = new Map();
    if (!partitionKeys.length) return out;
    const p = await pool();
    for (let i = 0; i < partitionKeys.length; i += 1000) {
      const { rows } = await p.query(
        `SELECT partition_key, owner_id, ordinal, data, version, deleted_at FROM ${TABLE}
          WHERE store_key = $1 AND partition_key = ANY($2)`, [storeKey, partitionKeys.slice(i, i + 1000)]);
      stats.reads++;
      for (const r of rows) {
        const e = cachePut({ storeKey, partitionKey: r.partition_key, ownerId: r.owner_id, data: r.data,
          version: toVersion(r.version), deleted: r.deleted_at != null, deletedAt: msOf(r.deleted_at) });
        out.set(r.partition_key, { ...view(e), ordinal: r.ordinal == null ? null : Number(r.ordinal) });
      }
    }
    return out;
  }

  // ── Phase 2c ─────────────────────────────────────────────────────────────

  /**
   * Application-clock minus database-clock, in ms, estimated from round trips
   * (midpoint of the request). Deletion times are DATABASE times; a binding
   * converts them into this process's clock with this offset instead of
   * assuming the hosts' clocks agree. Error ≤ half a round trip.
   */
  let clockOffset = null;
  function noteClock(t0, dbNowMs, t1) {
    if (!Number.isFinite(dbNowMs)) return;
    const sample = (t0 + t1) / 2 - dbNowMs;
    clockOffset = clockOffset == null ? sample : clockOffset + 0.2 * (sample - clockOffset);
  }

  /**
   * The owner's change counter (migration 0027, maintained by a trigger), or
   * null when the table/trigger is absent. One primary-key lookup; also
   * refreshes the clock-offset estimate.
   */
  async function ownerVersion(ownerId) {
    const p = await pool();
    const t0 = Date.now();
    const { rows } = await p.query(
      `SELECT (SELECT version FROM aqua_owner_versions WHERE owner_id = $1) AS v,
              (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now`, [String(ownerId)]);
    noteClock(t0, Number(rows[0].now), Date.now());
    stats.reads++;
    return rows[0].v == null ? 0 : Number(rows[0].v);
  }

  /**
   * Insert a child row ONLY while its parent row is live — in one statement
   * that takes a SHARE lock on the parent. A concurrent tombstoneGroup() must
   * take the parent's row lock to delete it, so it waits for this insert to
   * commit and then retires the child with the rest; an insert that starts
   * after the deletion committed finds no live parent and writes nothing.
   * No orphan child can be created.
   * @returns {Promise<{status:'inserted'|'exists'|'parent-gone', version?:number, data?:string}>}
   */
  async function insertChild({ storeKey, parentKey, partitionKey, data, ownerId, ordinal = null }) {
    const p = await pool();
    const bytes = Buffer.byteLength(data, 'utf8');
    const { rows } = await withOwnerFence(p, ownerId, q => q.query(
      `WITH parent AS (
         SELECT 1 FROM ${TABLE}
          WHERE store_key = $1 AND partition_key = $2 AND owner_id = $4 AND deleted_at IS NULL
          FOR SHARE)
       INSERT INTO ${TABLE} (store_key, partition_key, owner_id, ordinal, data, bytes, checksum, version, updated_at, updated_by)
       SELECT $1, $3, $4, $5, $6, $7, $8, 1, now(), $9 WHERE EXISTS (SELECT 1 FROM parent) AND ${LIVE_OWNER('$4')}
       ON CONFLICT (store_key, partition_key) DO NOTHING
       RETURNING version`,
      [storeKey, parentKey, partitionKey, String(ownerId), ordinal, data, bytes, partitionChecksum(data), instanceId]));
    if (rows.length) {
      stats.writes++; stats.bytesWritten += bytes;
      cachePut({ storeKey, partitionKey, ownerId: String(ownerId), data, version: Number(rows[0].version), deleted: false });
      return { status: 'inserted', version: Number(rows[0].version) };
    }
    const cur = await readRow(p, storeKey, partitionKey);
    if (cur) return { status: 'exists', version: toVersion(cur.version), data: cur.data, deleted: cur.deleted_at != null };
    return { status: 'parent-gone' };
  }

  /**
   * Phase 3 — several child rows AND the caller's other writes (`within`, given
   * the transaction's client: the learning jobs) in ONE transaction, only
   * while the parent is live (share-locked, as insertChild). All or nothing.
   * A child key that already holds exactly our data is our own earlier attempt
   * (idempotent); a key holding different data is a collision and aborts.
   * @returns {Promise<{status:'committed', versions: Map<string, number>, extra: any}
   *                  |{status:'parent-gone'}|{status:'collision', partitionKey:string}>}
   */
  async function insertChildrenTx({ storeKey, parentKey, ownerId, children, within = null }) {
    const owner = String(ownerId);
    const client = await (await pool()).connect();
    try {
      await client.query('BEGIN');
      await checkFenceOn(client, owner);
      const parent = await client.query(
        `SELECT 1 FROM ${TABLE}
          WHERE store_key = $1 AND partition_key = $2 AND owner_id = $3 AND deleted_at IS NULL
          FOR SHARE`, [storeKey, parentKey, owner]);
      if (!parent.rowCount) { await client.query('ROLLBACK'); return { status: 'parent-gone' }; }
      const versions = new Map();
      let bytesTotal = 0;
      for (const { partitionKey, data, ordinal = null } of children) {
        const bytes = Buffer.byteLength(data, 'utf8');
        const ins = await client.query(
          `INSERT INTO ${TABLE} (store_key, partition_key, owner_id, ordinal, data, bytes, checksum, version, updated_at, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1, now(), $8)
           ON CONFLICT (store_key, partition_key) DO NOTHING RETURNING version`,
          [storeKey, partitionKey, owner, ordinal, data, bytes, partitionChecksum(data), instanceId]);
        if (ins.rowCount) { versions.set(partitionKey, Number(ins.rows[0].version)); bytesTotal += bytes; continue; }
        const cur = await readRow(client, storeKey, partitionKey);
        if (cur && cur.owner_id === owner && cur.data === data && cur.deleted_at == null) { versions.set(partitionKey, toVersion(cur.version)); continue; }
        await client.query('ROLLBACK');
        return { status: 'collision', partitionKey };
      }
      const extra = within ? await within(client) : null;
      await client.query('COMMIT');
      stats.writes += versions.size; stats.bytesWritten += bytesTotal;
      for (const { partitionKey, data } of children) {
        cachePut({ storeKey, partitionKey, ownerId: owner, data, version: versions.get(partitionKey), deleted: false });
      }
      return { status: 'committed', versions, extra };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Delete a parent and EVERY child row whose key starts with `childPrefix`,
   * in one transaction. The parent is locked first (FOR UPDATE), which waits
   * for in-flight insertChild() calls; the children are then read after they
   * committed. Exact prefix comparison (left()), not LIKE: ids may contain % or _.
   */
  async function tombstoneGroup({ storeKey, parentKey, childPrefix, ownerId }) {
    const client = await (await pool()).connect();
    try {
      await client.query('BEGIN');
      const owner = String(ownerId);
      await checkFenceOn(client, owner, { deletion: true });
      await client.query(
        `SELECT 1 FROM ${TABLE} WHERE store_key = $1 AND partition_key = $2 FOR UPDATE`, [storeKey, parentKey]);
      const parent = await client.query(
        `UPDATE ${TABLE} SET data = NULL, bytes = 0, checksum = NULL, version = version + 1,
                deleted_at = now(), updated_at = now(), updated_by = $3
          WHERE store_key = $1 AND partition_key = $2 AND deleted_at IS NULL RETURNING version`,
        [storeKey, parentKey, instanceId]);
      if (!parent.rowCount) {
        // No live parent row (absent): still leave a tombstone so a late insert has no parent.
        await client.query(
          `INSERT INTO ${TABLE} (store_key, partition_key, owner_id, data, bytes, version, deleted_at, updated_at, updated_by)
           VALUES ($1, $2, $3, NULL, 0, 1, now(), now(), $4) ON CONFLICT (store_key, partition_key) DO NOTHING`,
          [storeKey, parentKey, owner, instanceId]);
      }
      const children = await client.query(
        `UPDATE ${TABLE} SET data = NULL, bytes = 0, checksum = NULL, version = version + 1,
                deleted_at = now(), updated_at = now(), updated_by = $4
          WHERE store_key = $1 AND owner_id = $2 AND left(partition_key, length($3)) = $3 AND deleted_at IS NULL
          RETURNING partition_key`,
        [storeKey, owner, childPrefix, instanceId]);
      await client.query('COMMIT');
      cacheDrop(ck(storeKey, parentKey));
      for (const r of children.rows) cacheDrop(ck(storeKey, r.partition_key));
      stats.deletes += 1 + children.rowCount;
      return { parent: parent.rowCount, children: children.rowCount };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Retire child rows left LIVE under a TOMBSTONED parent (orphans from before
   * insertChild existed). Per parent, in its own transaction: the parent is
   * locked and re-checked as still deleted, so a parent re-created in between
   * (a live conversation again) is never touched, nor are its children.
   */
  async function sweepOrphans({ storeKey, parentPrefix = 'c:', childPrefix = 'm:', limit = 1000 }) {
    const p = await pool();
    const { rows } = await p.query(
      `SELECT h.partition_key, h.owner_id FROM ${TABLE} h
        WHERE h.store_key = $1 AND left(h.partition_key, length($2)) = $2 AND h.deleted_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM ${TABLE} m
                       WHERE m.store_key = h.store_key AND m.owner_id = h.owner_id AND m.deleted_at IS NULL
                         AND left(m.partition_key, length($3) + length(h.partition_key) - length($2) + 1)
                             = $3 || substr(h.partition_key, length($2) + 1) || ':')
        LIMIT $4`, [storeKey, parentPrefix, childPrefix, limit]);
    let swept = 0;
    for (const r of rows) {
      const id = r.partition_key.slice(parentPrefix.length);
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        const h = await client.query(
          `SELECT deleted_at FROM ${TABLE} WHERE store_key = $1 AND partition_key = $2 FOR UPDATE`, [storeKey, r.partition_key]);
        if (h.rows[0]?.deleted_at == null) { await client.query('ROLLBACK'); continue; }   // re-created: leave it alone
        const c = await client.query(
          `UPDATE ${TABLE} SET data = NULL, bytes = 0, checksum = NULL, version = version + 1,
                  deleted_at = now(), updated_at = now(), updated_by = $4
            WHERE store_key = $1 AND owner_id = $2 AND left(partition_key, length($3)) = $3 AND deleted_at IS NULL`,
          [storeKey, r.owner_id, `${childPrefix}${id}:`, `${instanceId}:orphan-sweep`]);
        await client.query('COMMIT');
        swept += c.rowCount;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      } finally {
        client.release();
      }
    }
    return { parents: rows.length, swept };
  }

  /** Tombstone one owner's live rows of one store whose key starts with `prefix` (exact prefix). */
  async function tombstonePrefix({ storeKey, ownerId, prefix }) {
    const { rows } = await withOwnerFence(await pool(), ownerId, q => q.query(
      `UPDATE ${TABLE} SET data = NULL, bytes = 0, checksum = NULL, version = version + 1,
              deleted_at = now(), updated_at = now(), updated_by = $4
        WHERE store_key = $1 AND owner_id = $2 AND left(partition_key, length($3)) = $3 AND deleted_at IS NULL
        RETURNING partition_key`, [storeKey, String(ownerId), prefix, instanceId]), { deletion: true });
    for (const r of rows) cacheDrop(ck(storeKey, r.partition_key));
    stats.deletes += rows.length;
    return rows.length;
  }

  /** Does this store have any row at all (live or tombstone)? The "was it ever migrated" check. */
  async function hasAny(storeKey) {
    const { rows } = await (await pool()).query(`SELECT 1 FROM ${TABLE} WHERE store_key = $1 LIMIT 1`, [storeKey]);
    return rows.length > 0;
  }

  /** All partitions of one store, ordered for reassembly. Tooling (migration, export), not the request path. */
  async function listStore(storeKey, { includeDeleted = false } = {}) {
    const p = await pool();
    const { rows } = await p.query(
      `SELECT partition_key, owner_id, ordinal, data, version, deleted_at FROM ${TABLE}
        WHERE store_key = $1 ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
        ORDER BY ordinal ASC NULLS LAST, partition_key ASC`, [storeKey]);
    return rows.map(r => ({ partitionKey: r.partition_key, ownerId: r.owner_id, ordinal: r.ordinal == null ? null : Number(r.ordinal),
      data: r.data, version: toVersion(r.version), deleted: r.deleted_at != null, deletedAt: msOf(r.deleted_at) }));
  }

  // ── writes ───────────────────────────────────────────────────────────────
  /** The version a write must state: what this instance last read. */
  function expectedFor(storeKey, partitionKey, expectedVersion) {
    if (expectedVersion !== undefined) return Number(expectedVersion);
    const e = cache.get(ck(storeKey, partitionKey));
    if (!e) throw new UnreadWriteError(storeKey, partitionKey);
    return e.version;
  }

  /** One CAS write on `q` (a pool or a transaction's client). Returns the new version or throws. */
  async function casWrite(q, { storeKey, partitionKey, ownerId, data, expected, ordinal = null }) {
    const owner = String(ownerId);
    const tombstone = data === null;
    const bytes = tombstone ? 0 : Buffer.byteLength(data, 'utf8');
    const sum = tombstone ? null : partitionChecksum(data);
    // Data (not a tombstone) of a real owner: refused at the statement for a deleted owner.
    const guarded = !tombstone && owner !== '';
    let rows;
    if (expected === 0) {
      ({ rows } = await q.query(
        `INSERT INTO ${TABLE} (store_key, partition_key, owner_id, ordinal, data, bytes, checksum, version, deleted_at, updated_at, updated_by)
         SELECT $1::text, $2::text, $3::text, $4::bigint, $5::text, $6::integer, $7::text, 1, ${tombstone ? 'now()' : 'NULL'}, now(), $8::text
          WHERE ${guarded ? LIVE_OWNER('$3') : 'true'}
         ON CONFLICT (store_key, partition_key) DO NOTHING
         RETURNING version, deleted_at`,
        [storeKey, partitionKey, owner, ordinal, data, bytes, sum, instanceId]));
    } else {
      ({ rows } = await q.query(
        `UPDATE ${TABLE}
            SET data = $3, bytes = $4, checksum = $5, version = version + 1,
                deleted_at = ${tombstone ? 'now()' : 'NULL'}, updated_at = now(), updated_by = $6
          WHERE store_key = $1 AND partition_key = $2 AND version = $7 AND owner_id = $8${guarded ? ` AND ${LIVE_OWNER('$8')}` : ''}
          RETURNING version, deleted_at`,
        [storeKey, partitionKey, data, bytes, sum, instanceId, expected, owner]));
    }
    if (rows.length) return { version: toVersion(rows[0].version), bytes, deletedAt: msOf(rows[0].deleted_at) };

    // Nothing written: the account was deleted (explicit, never retried), a lost
    // race, or a cross-owner write.
    if (guarded && (await q.query('SELECT 1 FROM aqua_deleted_owners WHERE owner_id = $1', [owner])).rows.length) {
      noteOwnerDeleted(owner);
      stats.ownerDeletedRefusals = (stats.ownerDeletedRefusals ?? 0) + 1;
      throw new OwnerDeletedError();
    }
    const cur = await readRow(q, storeKey, partitionKey);
    if (cur && cur.owner_id !== owner) {
      stats.ownershipRefusals++;
      throw new PartitionOwnershipError(storeKey, partitionKey);
    }
    stats.conflicts++;
    throw new PartitionConflictError(storeKey, partitionKey, expected, cur ? toVersion(cur.version) : null);
  }

  function afterWrite(w, version, bytes, deletedAt = null) {
    stats.bytesWritten += bytes;
    if (w.data === null) stats.deletes++; else stats.writes++;
    cachePut({ storeKey: w.storeKey, partitionKey: w.partitionKey, ownerId: String(w.ownerId),
      data: w.data, version, deleted: w.data === null, deletedAt });
  }

  /**
   * Write one partition. `data` is the partition's JSON text. `expectedVersion`
   * defaults to the version this instance last read; 0 means "must not exist".
   */
  async function put(storeKey, partitionKey, data, { ownerId, expectedVersion, ordinal = null } = {}) {
    if (ownerId === undefined || ownerId === null) throw new Error('put: ownerId is required (use "" for a global partition)');
    if (typeof data !== 'string') throw new TypeError('put: data must be a JSON string');
    const w = { storeKey, partitionKey, ownerId, data, ordinal, expected: expectedFor(storeKey, partitionKey, expectedVersion) };
    try {
      // Multi-instance connect safety: a fenced owner's write runs in one transaction with its lease check.
      const { version, bytes, deletedAt } = await withOwnerFence(await pool(), w.ownerId, q => casWrite(q, w));
      afterWrite(w, version, bytes, deletedAt);
      return { version };
    } catch (err) {
      if (err instanceof PartitionConflictError) cacheDrop(ck(storeKey, partitionKey));
      throw err;
    }
  }

  /** Tombstone one partition. Absent → a tombstone row is created, so a blind insert cannot follow. */
  async function remove(storeKey, partitionKey, { ownerId, expectedVersion } = {}) {
    if (ownerId === undefined || ownerId === null) throw new Error('delete: ownerId is required');
    const w = { storeKey, partitionKey, ownerId, data: null, expected: expectedFor(storeKey, partitionKey, expectedVersion) };
    try {
      const { version, deletedAt } = await withOwnerFence(await pool(), w.ownerId, q => casWrite(q, w), { deletion: true });
      afterWrite(w, version, 0, deletedAt);
      return { version };
    } catch (err) {
      if (err instanceof PartitionConflictError) cacheDrop(ck(storeKey, partitionKey));
      throw err;
    }
  }

  /**
   * Read-modify-write with retry. `mutate(currentText|null, meta)` returns the
   * new text, `null` to delete, or `undefined` for no change. It must be a pure
   * function of its input: on a conflict it runs again on the newer value.
   * `meta.deleted` tells it the current value is a tombstone; returning text
   * then re-creates the partition, deliberately (it has seen the deletion).
   */
  async function update(storeKey, partitionKey, mutate, { ownerId, maxAttempts = 8 } = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const cur = await get(storeKey, partitionKey, { ownerId, fresh: attempt > 0 });
      const next = await mutate(cur.data, { version: cur.version, deleted: cur.deleted, deletedAt: cur.deletedAt, exists: cur.version > 0, attempt });
      if (next === undefined) return { changed: false, version: cur.version, attempts: attempt + 1 };
      try {
        if (next === null) {
          // Already a tombstone: nothing to do. ABSENT: write a tombstone anyway, so a
          // process still holding this partition in memory cannot create it later.
          if (cur.deleted) return { changed: false, version: cur.version, attempts: attempt + 1 };
          const r = await remove(storeKey, partitionKey, { ownerId, expectedVersion: cur.version });
          return { changed: true, version: r.version, attempts: attempt + 1 };
        }
        const r = await put(storeKey, partitionKey, next, { ownerId, expectedVersion: cur.version });
        return { changed: true, version: r.version, attempts: attempt + 1 };
      } catch (err) {
        if (!(err instanceof PartitionConflictError)) throw err;
        stats.retries++;
        // Small jittered pause so two instances hammering one hot partition interleave.
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 5 * (attempt + 1))));
      }
    }
    throw new PartitionConflictError(storeKey, partitionKey, 'any', `still contended after ${maxAttempts} attempts`);
  }

  /**
   * Several writes, all or nothing, in one transaction. Each op:
   *   { storeKey, partitionKey, ownerId, data (text | null = tombstone), expectedVersion?, ordinal? }
   * Any conflict rolls back every op and throws. The cache changes only after COMMIT.
   */
  async function transact(ops) {
    const planned = ops.map(o => ({ ...o, data: o.data ?? null, expected: expectedFor(o.storeKey, o.partitionKey, o.expectedVersion) }));
    const client = await (await pool()).connect();
    const results = [];
    try {
      await client.query('BEGIN');
      for (const owner of new Set(planned.map(w => String(w.ownerId)))) {
        // An owner whose ops here are all tombstones is being deleted: no barrier.
        await checkFenceOn(client, owner, { deletion: planned.every(w => String(w.ownerId) !== owner || w.data === null) });
      }
      for (const w of planned) results.push({ w, ...(await casWrite(client, w)) });
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* the connection may be gone */ }
      for (const w of planned) cacheDrop(ck(w.storeKey, w.partitionKey));
      throw err;
    } finally {
      client.release();
    }
    for (const r of results) afterWrite(r.w, r.version, r.bytes, r.deletedAt);
    return results.map(r => ({ storeKey: r.w.storeKey, partitionKey: r.w.partitionKey, version: r.version }));
  }

  /**
   * Account deletion: tombstone every live partition of an owner, in every
   * store, in one statement (one transaction). Content is removed (data NULL);
   * the key rows stay as tombstones so nothing stale can write them back.
   */
  async function purgeOwner(ownerId) {
    if (ownerId === undefined || ownerId === null || String(ownerId) === '') {
      throw new Error('purgeOwner: an owner id is required (refusing to purge global partitions)');
    }
    const owner = String(ownerId);
    const p = await pool();
    const { rows } = await p.query(
      `UPDATE ${TABLE}
          SET data = NULL, bytes = 0, checksum = NULL, version = version + 1,
              deleted_at = now(), updated_at = now(), updated_by = $2
        WHERE owner_id = $1 AND deleted_at IS NULL
        RETURNING store_key, partition_key`, [owner, instanceId]);
    for (const key of [...(byOwner.get(owner) ?? [])]) cacheDrop(key);
    stats.deletes += rows.length;
    return { tombstoned: rows.length };
  }

  return {
    get, loadOwner, refreshOwner, listStore, hasAny, ownerVersions, getMany,
    ownerVersion, insertChild, insertChildrenTx, tombstoneGroup, sweepOrphans, tombstonePrefix,
    /** Application clock minus database clock (ms), or 0 before the first sample. */
    clockOffsetMs: () => clockOffset ?? 0,
    put, delete: remove, update, transact, purgeOwner,
    instanceId,
    stats: () => ({ ...stats }),
    cacheInfo: () => ({ entries: cache.size, bytes: cachedBytes, owners: byOwner.size, maxEntries, maxBytes }),
    /** Drop the whole cache (tests; or after an operator restore). */
    clearCache: () => { cache.clear(); byOwner.clear(); cachedBytes = 0; },
  };
}
