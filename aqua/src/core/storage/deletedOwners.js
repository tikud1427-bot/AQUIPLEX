/**
 * AQUA — deleted owners (scalability Phase 3)
 *
 * Account deletion records the owner in `aqua_deleted_owners` (migration 0030)
 * BEFORE any store is purged. Every per-owner write path — the partition
 * bindings and the worker — asks `isOwnerDeleted` first, so work that was
 * already in flight when the account was deleted (a learning job mid-run, a
 * debounced flush) cannot write the user's data back after the purge.
 *
 * Deletions themselves (tombstones) always pass: they are the purge.
 *
 * A positive answer is cached for good (an owner id is never reused: it is
 * `user:<Mongo ObjectId>`); a negative one for a short time. Without a
 * database there is nothing to consult and nothing was partitioned: false.
 *
 * THE TRANSACTION BARRIER (multi-instance safety). `isOwnerDeleted` is only a
 * fast pre-check: its negative cache and its separate query cannot order a
 * write against a concurrent deletion. The AUTHORITATIVE check is
 * `assertOwnerLive(client, owner)`, run inside every owner-data write
 * transaction (core/storage/writeFence.js checkFenceOn → partitionRepository,
 * the job enqueue). It takes the owner's barrier advisory lock in SHARED mode
 * and then reads the marker in a NEW statement; `markOwnerDeleted` inserts the
 * marker under the same lock in EXCLUSIVE mode. So:
 *   · a write in flight when the account is deleted commits BEFORE the marker
 *     (the marker waits for it) — and the purge, which runs after the marker,
 *     then tombstones what it wrote;
 *   · a write that starts after the marker sees it (READ COMMITTED: each
 *     statement reads what was committed when it began, and it begins after
 *     the lock was granted) and is refused: OwnerDeletedError, OWNER_DELETED,
 *     never retried.
 * A NOT EXISTS predicate alone is not enough: a statement whose snapshot
 * predates the marker's commit could insert a row the purge never sees.
 * Deletions (tombstones) never take this path — they are the purge.
 */
import crypto from 'node:crypto';

import { getPool, isConfigured } from '../db/pool.js';

const deleted = new Set();
const notDeleted = new Map();        // owner → checked at (ms)
const NEGATIVE_TTL_MS = 2_000;

export class OwnerDeletedError extends Error {
  constructor() {
    // Never prints the owner id: this message can reach a log or a response.
    super('this account was deleted: its data cannot be written');
    this.name = 'OwnerDeletedError';
    this.code = 'OWNER_DELETED';
    this.retryable = false;
  }
}
export const isOwnerDeletedError = err => err?.code === 'OWNER_DELETED';

/** 64-bit advisory-lock key of an owner's deletion barrier. */
export const ownerBarrierKey = ownerId =>
  BigInt.asIntN(64, BigInt(`0x${crypto.createHash('sha256').update(`aqua-owner-barrier:${ownerId}`).digest('hex').slice(0, 16)}`)).toString();

const noteDeleted = o => { deleted.add(o); notDeleted.delete(o); };

/**
 * Record the account deletion. Takes the owner's barrier lock EXCLUSIVELY, so
 * it waits for every owner-data write already inside its transaction; every
 * later write sees the marker and is refused (see THE TRANSACTION BARRIER).
 */
export async function markOwnerDeleted(ownerId, { reason = 'account-deletion', pool = null } = {}) {
  if (!ownerId) return false;
  const p = pool ?? (isConfigured() ? await getPool() : null);
  if (!p) return false;
  const o = String(ownerId);
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1::bigint)', [ownerBarrierKey(o)]);
    await c.query(
      `INSERT INTO aqua_deleted_owners (owner_id, reason) VALUES ($1, $2) ON CONFLICT (owner_id) DO NOTHING`,
      [o, reason]);
    await c.query('COMMIT');
  } catch (err) {
    try { await c.query('ROLLBACK'); } catch { /* connection may be gone */ }
    throw err;
  } finally {
    c.release();
  }
  noteDeleted(o);
  return true;
}

/**
 * INSIDE an owner-data write transaction (`client` has run BEGIN): prove the
 * owner was not deleted, holding the barrier until COMMIT. Ownerless ('')
 * partitions are not owner data. Throws OwnerDeletedError.
 */
export async function assertOwnerLive(client, ownerId) {
  if (ownerId === undefined || ownerId === null || ownerId === '') return;
  const o = String(ownerId);
  if (deleted.has(o)) throw new OwnerDeletedError();          // positive answers are final
  await client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [ownerBarrierKey(o)]);
  // A separate statement: its snapshot is taken AFTER the lock was granted.
  const { rows } = await client.query('SELECT 1 FROM aqua_deleted_owners WHERE owner_id = $1', [o]);
  if (rows.length) { noteDeleted(o); throw new OwnerDeletedError(); }
}

/** A write was refused by the database barrier: remember it (no further round trips). */
export function noteOwnerDeleted(ownerId) { if (ownerId) noteDeleted(String(ownerId)); }

export async function isOwnerDeleted(ownerId, { pool = null } = {}) {
  if (!ownerId) return false;
  const o = String(ownerId);
  if (deleted.has(o)) return true;
  const at = notDeleted.get(o);
  if (at && Date.now() - at < NEGATIVE_TTL_MS) return false;
  const p = pool ?? (isConfigured() ? await getPool() : null);
  if (!p) return false;
  const { rows } = await p.query('SELECT 1 FROM aqua_deleted_owners WHERE owner_id = $1', [o]);
  if (rows.length) { deleted.add(o); notDeleted.delete(o); return true; }
  notDeleted.set(o, Date.now());
  if (notDeleted.size > 50_000) notDeleted.clear();
  return false;
}

/** Tests only. */
export function _resetDeletedOwnersForTests() { deleted.clear(); notDeleted.clear(); }
