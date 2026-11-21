/**
 * AQUA — external-source deletion guard (G1-1 acceptance remediation)
 *
 * THE RACE. A document-understanding job for an external resource can be
 * RUNNING (claimed, mid-extraction) when its source or resource is deleted.
 * The worker checks that the resource still exists when it starts, but the
 * extraction takes seconds to minutes; if the deletion commits in between,
 * the job's canonical commit would recreate the source row, its claims and
 * their embedding requests — knowledge the user just deleted.
 *
 * THE CORRECTION (smallest safe one). Both sides serialise on ONE transaction-
 * scoped advisory lock per (owner, external source), and the deletion leaves a
 * tombstone row in the same transaction:
 *
 *   deletion  (sourceDeletion.js)          BEGIN → lock → INSERT tombstone → delete … → COMMIT
 *   commit    (worldModelRepository.js)    BEGIN → lock → tombstone check → write … → COMMIT
 *
 * Whichever side takes the lock first finishes before the other proceeds:
 *   - the commit first: its rows exist when the deletion reads, so the
 *     deletion removes them (it runs to completion after the commit releases);
 *   - the deletion first: the commit waits, then sees the committed tombstone
 *     (READ COMMITTED takes a fresh snapshot per statement, after the lock)
 *     and writes NOTHING.
 *
 * A tombstone blocks only work ENQUEUED BEFORE the deletion (job created_at
 * <= deleted_at). A resource re-added later is a new job, enqueued after the
 * deletion, and is understood normally. `keep_uko_id` is the version that a
 * resource update keeps (older versions are deleted, the current one is not).
 *
 * Unrelated jobs are never touched: the lock key and the tombstone are per
 * owner and per external source; uploads (`file:` refs) and conversation turns
 * never take this lock.
 *
 * This module takes a CLIENT already inside a transaction; it never opens a
 * connection of its own.
 */
import crypto from 'node:crypto';

const UKO_ID = /^ext_([0-9a-f]{12})_/;
const EXTUKO_REF = /^extuko:(ext_[0-9a-f]{12}_[^:]*):chunk:/;

/** The ukoId an `extuko:<ukoId>:chunk:<n>` external_ref names, or null. */
export function ukoIdFromExternalRef(ref) {
  const m = typeof ref === 'string' ? EXTUKO_REF.exec(ref) : null;
  return m ? m[1] : null;
}

/**
 * The lock key: a signed 64-bit hash of a namespace + owner + external SOURCE
 * tag (`ext_<12 hex>_`) — the same single-bigint form as the entity
 * find-or-create lock in worldModelRepository. Item- and source-level
 * deletions of one source take the same lock, so either granularity
 * serialises against every job under that source.
 */
export function externalSourceLockKey(ownerId, ukoIdOrPrefix) {
  const m = UKO_ID.exec(String(ukoIdOrPrefix ?? ''));
  if (!m) throw new TypeError('externalSourceLockKey: not an external ukoId/prefix');
  return BigInt.asIntN(64, BigInt(`0x${crypto.createHash('sha256')
    .update(`aqua-external-source:${ownerId}:ext_${m[1]}_`).digest('hex').slice(0, 16)}`)).toString();
}

export async function lockExternalSource(client, ownerId, ukoIdOrPrefix) {
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [externalSourceLockKey(ownerId, ukoIdOrPrefix)]);
}

/**
 * Records the deletion. Call AFTER `lockExternalSource`, inside the deletion
 * transaction. `deleted_at` is the wall clock AT THE INSERT (under the lock),
 * not the transaction start, so it orders strictly against an observation
 * (`observeExternalSource`) taken under the same lock (G1-2 / D-1).
 */
export async function recordExternalDeletion(client, { ownerId, ukoPrefix, keepUkoId = null }) {
  await client.query(
    `INSERT INTO aqua_external_deletions (deletion_id, owner_id, uko_prefix, keep_uko_id, deleted_at)
     VALUES ($1, $2, $3, $4, clock_timestamp())`,
    [crypto.randomUUID(), ownerId, ukoPrefix, keepUkoId]);
}

/** Tombstones of this owner that cover `ukoId` (prefix match, not the kept version). */
async function coveringDeletions(client, ownerId, ukoId) {
  const { rows } = await client.query(
    'SELECT uko_prefix, keep_uko_id, deleted_at FROM aqua_external_deletions WHERE owner_id = $1',
    [ownerId]);
  return rows.filter(r => String(ukoId).startsWith(String(r.uko_prefix)) && r.keep_uko_id !== ukoId);
}

/**
 * G1-2 / D-1 + D-2 — the enqueue-side view of one resource, read under the
 * source lock (`lockExternalSource` first, same transaction):
 *
 *   deletedSince  a deletion covering `ukoId` happened at or after
 *                 `observedAt` — the resource was deleted after the sync that
 *                 wants to enqueue it saw it: refuse. Without `observedAt`:
 *                 any covering deletion refuses (conservative).
 *   generation    how many deletions have ever covered `ukoId`. It goes into
 *                 the job's idempotency key, so a resource RE-ADDED after a
 *                 deletion is a new job (understood once more), while retries
 *                 between two deletions keep one key (still idempotent).
 */
export async function externalEnqueueState(client, { ownerId, ukoId, observedAt = null }) {
  const covering = await coveringDeletions(client, ownerId, ukoId);
  const since = observedAt == null ? NaN : new Date(observedAt).getTime();
  const deletedSince = covering.length > 0
    && (Number.isNaN(since) || covering.some(r => new Date(r.deleted_at).getTime() >= since));
  return { deletedSince, generation: covering.length };
}

/**
 * G1-2 / D-1 — the moment a sync SAW a source, on the database clock and under
 * the source lock: every deletion is then strictly before it (and was already
 * committed — the lock waited for it) or strictly after it. Pass it to the
 * enqueue as `observedAt`.
 */
export async function observeExternalSource(pool, ownerId, ukoIdOrPrefix) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockExternalSource(client, ownerId, ukoIdOrPrefix);
    const { rows } = await client.query('SELECT clock_timestamp() AS t');
    await client.query('COMMIT');
    return new Date(rows[0].t);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * True when a committed deletion covers `ukoId` and happened at or after the
 * job was enqueued (`enqueuedAt`). Without `enqueuedAt` the answer is
 * conservative: any covering deletion blocks. Call AFTER `lockExternalSource`.
 */
export async function externalSourceDeletedSince(client, { ownerId, ukoId, enqueuedAt = null }) {
  return (await externalEnqueueState(client, { ownerId, ukoId, observedAt: enqueuedAt })).deletedSince;
}
