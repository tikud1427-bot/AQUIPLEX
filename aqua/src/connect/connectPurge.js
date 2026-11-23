/**
 * AQUA Connect — account purge of EVERY piece of connector-owned state
 * (Safety Fix 4). Called by account/accountPurge.js AFTER the durable deletion
 * marker is written (core/storage/deletedOwners.markOwnerDeleted).
 *
 * INVENTORY (what a connector leaves behind for an owner):
 *   connection records (Mongo `aqua_connections` / the memory adapter) — and in
 *     them the SEALED credentials (incl. refresh tokens), the sync checkpoint,
 *     the full-listing cursor (fullSync) and a withheld mass deletion
 *     (pendingDeletion);
 *   aqua_jobs of the owner (external understanding jobs and any other pending work);
 *   aqua_external_deletions (source/resource deletion tombstones);
 *   aqua_owner_versions (the owner's partition change counter);
 *   the owner's connect lease row (aqua_scheduler_leases, connect-owner:<hash>);
 *   imported knowledge in the partition stores and canonical claims — purged
 *     by accountPurge's own steps (row tombstones, claim/world-model purges);
 *   process memory: the in-process owner lock, write fences — nothing durable.
 *
 * ORDER (race-safe, idempotent):
 *   1. the deletion marker must exist — from then on no NEW lease is granted
 *      (acquire refuses OWNER_DELETED), renewals fail, every partition write and
 *      every connection write is refused (deleted-owner barrier, Safety Fix 1;
 *      serializeConnectionWrite);
 *   2. take the owner's lease with a PURGE acquisition: it waits for in-flight
 *      connection writes (they hold the lease lock shared) and for fenced
 *      partition writes (FOR SHARE on the row), then takes over any holder —
 *      an operation still running can no longer prove its token;
 *   3. STAMP every connection store with the purge's epoch: a late update of
 *      any older operation is rejected by the store itself;
 *   4. flush this process's pending writes of the owner (tombstones land; data
 *      is refused by the barrier) — so the counters below stay deleted;
 *   5. delete the owner's jobs, external-deletion records and version counters;
 *   6. delete the connection records (credentials, cursors, checkpoints,
 *      pendingDeletion) — in ONE atomic step on the owner's connection document,
 *      which stays as a TOMBSTONE (connectionStore.js): a delayed insert of any
 *      operation, delivered at any time afterwards, writes nothing;
 *   7. VERIFY by fresh reads of every store and table — PHYSICAL absence: no
 *      record at rest, and the tombstone in place;
 *   8. FINAL stage, only when everything above is verified empty: delete the
 *      lease row while still holding it. The marker stays (durable).
 * A repeated purge does the same and finds nothing (idempotent).
 */
import { getPool, isConfigured } from '../core/db/pool.js';
import { flushOwnerStrict } from '../core/storage/ownerBinding.js';
import { createOwnerLease, connectLeaseName } from './ownerLease.js';
import { connectionStoresForPurge, createMongoConnectionStore, grantRevokerForPurge } from './connectionStore.js';

/**
 * Gmail Phase 2 — revoke the owner's provider grants BEFORE their records are
 * deleted (the sealed refresh token is the only handle to revoke them). Best
 * effort and bounded per call (the connect service's revoker); a provider
 * failure is REPORTED in the result, never turned into a purge failure, and
 * the purge itself never waits on it beyond those bounds.
 */
async function revokeGrants(stores, owner) {
  const total = { revoked: 0, failed: 0, notAttempted: 0 };
  for (const s of stores) {
    const revoke = grantRevokerForPurge(s);
    if (!revoke) continue;
    try {
      const r = await revoke(owner);
      for (const k of Object.keys(total)) total[k] += Number(r?.[k] ?? 0);
    } catch { total.failed++; }
  }
  return total;
}

/** Physical state of one store for the owner: records at rest, and whether the tombstone is in place. */
async function physical(store, owner) {
  const connections = await store.countByOwner(owner);
  const state = typeof store.ownerState === 'function' ? await store.ownerState(owner) : null;
  return { connections, tombstoneMissing: state && !state.deleted ? 1 : 0 };
}

/** The connection stores to clear: every store a connect service registered, and the platform's Mongo store when connected. */
async function defaultStores() {
  // Gmail Phase 2: with Gmail Connect on, build the production connect service in
  // this process (if not yet) — it registers the Mongo store AND the grant revoker,
  // so an account deleted right after a restart still has its grants revoked.
  try {
    const { gmailConnectEnabled } = await import('./gmail/gmailOAuthConfig.js');
    if (gmailConnectEnabled()) await (await import('./productionDeps.js')).productionConnectDeps();
  } catch { /* the purge proceeds without provider revocation; the records are still deleted */ }
  const stores = connectionStoresForPurge();
  if (!stores.some(s => s.kind === 'mongo')) {
    try {
      const mongoose = (await import('mongoose')).default;
      if (mongoose.connection?.readyState === 1) stores.push(createMongoConnectionStore());
    } catch { /* no mongoose: no Mongo connection records can exist */ }
  }
  return stores;
}

const count = async (p, sql, args) => Number((await p.query(sql, args)).rows[0]?.n ?? 0);
// aqua_owner_versions comes from migration 0027 (a trigger table); where it does not exist there is nothing to clear.
const missingTable = err => err?.code === '42P01' || /relation "aqua_owner_versions" does not exist/.test(String(err?.message ?? ''));
const ownerVersions = async (p, sql, args, fallback) => { try { return await p.query(sql, args); } catch (err) { if (missingTable(err)) return fallback; throw err; } };

/**
 * @param {string} ownerId
 * @param {{ stores?: object[], pool?: object, ttlMs?: number, waitMs?: number }} [opts]
 * @returns {Promise<{ complete: boolean, removed: object, remaining: object|null, errors: string[] }>}
 */
export async function purgeConnectorState(ownerId, { stores = null, pool = null, ttlMs = 60_000, waitMs = 15_000 } = {}) {
  const owner = String(ownerId);
  if (!owner || owner === 'user:') throw new Error('purgeConnectorState: an owner id is required');
  const all = stores ?? await defaultStores();
  const removed = { connections: 0, jobs: 0, externalDeletions: 0, ownerVersions: 0, lease: false, providerRevocations: null };
  const errors = [];
  const p = pool ?? (isConfigured() ? await getPool() : null);

  if (!p) {
    // Local mode (no database): no lease, no tables — clear the stores of this process.
    removed.providerRevocations = await revokeGrants(all, owner);
    for (const s of all) removed.connections += await s.purgeOwner(owner);
    const remaining = { connections: 0, tombstoneMissing: 0 };
    for (const s of all) { const ph = await physical(s, owner); remaining.connections += ph.connections; remaining.tombstoneMissing += ph.tombstoneMissing; }
    return { complete: remaining.connections === 0 && remaining.tombstoneMissing === 0, removed, remaining, errors };
  }

  // 1. The durable marker comes first (account purge order).
  if (!(await p.query('SELECT 1 FROM aqua_deleted_owners WHERE owner_id = $1', [owner])).rows.length) {
    throw Object.assign(new Error('connector purge needs the account deletion marker first'), { code: 'PURGE_NOT_MARKED' });
  }
  // 2. Authority: a purge acquisition (waits for in-flight writes, takes over any holder).
  const lease = createOwnerLease(owner, { pool: p, ttlMs });
  await lease.acquire({ purge: true, waitMs });
  const fence = { epoch: lease.epoch, token: lease.token, previousEpoch: lease.previousEpoch };
  let remaining = null;
  try {
    // 3. Stamp: a late update of any older operation is now rejected by every store.
    for (const s of all) await s.stamp(owner, fence);
    // 4. This process's pending writes of the owner (tombstones land; data is refused).
    try { await flushOwnerStrict(owner); } catch (err) { if (!['OWNER_DELETED', 'WRITE_FENCE_LOST'].includes(err?.code)) errors.push(`flush: ${err?.code ?? err?.message}`); }
    // 5. Connector work and metadata.
    removed.jobs = (await p.query('DELETE FROM aqua_jobs WHERE owner_id = $1', [owner])).rowCount;
    removed.externalDeletions = (await p.query('DELETE FROM aqua_external_deletions WHERE owner_id = $1', [owner])).rowCount;
    removed.ownerVersions = (await ownerVersions(p, 'DELETE FROM aqua_owner_versions WHERE owner_id = $1', [owner], { rowCount: 0 })).rowCount;
    // 6. Connection records (credentials, cursors, checkpoints, pendingDeletion) —
    //    after the owner's grants were revoked at their providers (best effort, Gmail Phase 2).
    removed.providerRevocations = await revokeGrants(all, owner);
    for (const s of all) removed.connections += await s.purgeOwner(owner);
    // 7. Verify — fresh reads, not this process's memory.
    let connections = 0, tombstoneMissing = 0;
    for (const s of all) { const ph = await physical(s, owner); connections += ph.connections; tombstoneMissing += ph.tombstoneMissing; }
    remaining = {
      connections,
      tombstoneMissing,
      jobs: await count(p, 'SELECT count(*)::int AS n FROM aqua_jobs WHERE owner_id = $1', [owner]),
      externalDeletions: await count(p, 'SELECT count(*)::int AS n FROM aqua_external_deletions WHERE owner_id = $1', [owner]),
      ownerVersions: Number((await ownerVersions(p, 'SELECT count(*)::int AS n FROM aqua_owner_versions WHERE owner_id = $1', [owner], { rows: [{ n: 0 }] })).rows[0]?.n ?? 0),
      leaseHeld: await count(p, 'SELECT count(*)::int AS n FROM aqua_scheduler_leases WHERE name = $1 AND holder = $2', [connectLeaseName(owner), lease.token]),
    };
    // 8. FINAL stage — only when everything else is verified gone: the lease row, still held.
    if (!errors.length && remaining.leaseHeld === 1 && ['connections', 'tombstoneMissing', 'jobs', 'externalDeletions', 'ownerVersions'].every(k => remaining[k] === 0)) {
      removed.lease = await lease.deleteRow();
    }
    remaining.lease = await count(p, 'SELECT count(*)::int AS n FROM aqua_scheduler_leases WHERE name = $1', [connectLeaseName(owner)]);
    delete remaining.leaseHeld;
  } finally {
    if (lease.held) await lease.release();          // not deleted (incomplete): give the row back, expired
  }
  const complete = !errors.length && remaining != null && Object.values(remaining).every(n => n === 0);
  return { complete, removed, remaining, errors };
}
