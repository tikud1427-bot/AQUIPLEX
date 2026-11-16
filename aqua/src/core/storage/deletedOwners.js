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
 */
import { getPool, isConfigured } from '../db/pool.js';

const deleted = new Set();
const notDeleted = new Map();        // owner → checked at (ms)
const NEGATIVE_TTL_MS = 2_000;

export async function markOwnerDeleted(ownerId, { reason = 'account-deletion', pool = null } = {}) {
  if (!ownerId) return false;
  const p = pool ?? (isConfigured() ? await getPool() : null);
  if (!p) return false;
  await p.query(
    `INSERT INTO aqua_deleted_owners (owner_id, reason) VALUES ($1, $2) ON CONFLICT (owner_id) DO NOTHING`,
    [String(ownerId), reason]);
  deleted.add(String(ownerId));
  notDeleted.delete(String(ownerId));
  return true;
}

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
