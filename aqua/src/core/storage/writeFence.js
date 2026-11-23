/**
 * AQUA Storage — WRITE-CARRIED connect fences (multi-instance connect safety)
 *
 * THE PROBLEM. A connect operation (connect, sync, disconnect) holds a per-owner
 * lease (connect/ownerLease.js) so two instances never run one concurrently.
 * A lease alone does not stop a STALE holder: a process that stalled past its
 * lease may wake after another instance took the owner over and deleted a
 * source — and then write what it had in memory. Worse, work an operation
 * STARTED (a detached claim-vector embedding, a retry, a debounced flush) can
 * finish long after the operation ended — after its fence is gone, or after a
 * NEW operation of the same owner took a NEW fence in this very process.
 *
 * SAFETY FIX 3 — THE AUTHORITY TRAVELS WITH THE WORK.
 *
 *   1. One fence object per connect operation: { owner, name, token, lost,
 *      ended }. `withConnectLease` runs the operation inside
 *      `runWithFence(fence, fn)` (AsyncLocalStorage): every promise, timer and
 *      callback created inside the operation — detached or not — sees it as
 *      `currentFence()`.
 *   2. ORIGIN AT CREATION. A store binding records `currentFence()` as an
 *      ORIGIN of a pending write when the write is CREATED (markDirty /
 *      markDeleted / enqueueOp) — not when it is flushed. Debounce timers,
 *      retry backoff, shutdown and request flushes run in arbitrary contexts;
 *      they carry the recorded origins (`withWriteOrigins`), never the ambient
 *      context. A mutation made OUTSIDE any operation has no origin ("plain").
 *   3. VALIDATION AT PERSISTENCE, IN THE WRITE TRANSACTION, against the
 *      database, of THE ORIGINAL TOKEN (`checkFenceOn`):
 *        lost   → refused, always (a lost fence is lost for good);
 *        active → SELECT … WHERE name AND holder = token AND expires_at > now()
 *                 FOR SHARE (a takeover waits for the in-flight write);
 *        ended  → transaction advisory lock of the lease name (the lock every
 *                 acquisition takes), then the row must still name THIS token.
 *                 Release only EXPIRES the row, so ANY acquisition since —
 *                 another instance's or a new operation in this process —
 *                 replaced the token. No time limit, no timer.
 *      A failed validation marks THAT fence lost (permanently) and invalidates
 *      only the pending writes created under it.
 *   4. A NEW FENCE NEVER AUTHORISES OLD WORK: validation is of the origin's own
 *      token; the owner's current fence is never consulted.
 *   5. NO ORIGIN, OR A REFUSED ORIGIN → EXTERNAL DATA IS FROZEN. A plain write
 *      may not add or update external-origin items (entryMerge / mindStore /
 *      reasoningGraph keep the database's version); everything else merges
 *      normally, so unrelated non-external writes are never discarded.
 *
 * DELETED OWNERS (Safety Fix 1). The same transaction first runs the account-
 * deletion barrier (deletedOwners.assertOwnerLive) for every owner-data write,
 * fenced or not. Deletions (`{ deletion: true }`) skip it: they are the purge.
 *
 * No pool here: checks take the caller's transaction client.
 */
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import { assertOwnerLive, isOwnerDeletedError } from './deletedOwners.js';

/** 64-bit advisory-lock key of a lease name (acquisition and ended-fence writes). */
export const leaseLockKey = name => BigInt.asIntN(64, BigInt(`0x${crypto.createHash('sha256').update(`aqua-connect-lease:${name}`).digest('hex').slice(0, 16)}`)).toString();

export class FenceLostError extends Error {
  constructor(ownerId, reason = 'lease no longer held') {
    super(`write fence lost for this owner: ${reason}`);
    this.name = 'FenceLostError';
    this.code = 'WRITE_FENCE_LOST';
    this.retryable = false;
    this.ownerId = ownerId;
  }
}
export const isFenceLost = err => err?.code === 'WRITE_FENCE_LOST';
/** Refused for good (fence lost, or the account was deleted): discard, never retry. */
export const isWriteRefused = err => isFenceLost(err) || isOwnerDeletedError(err);

const fenceAls = new AsyncLocalStorage();     // the operation whose work this is
const originAls = new AsyncLocalStorage();    // the origins a flush carries (overrides the ambient operation)
const active = new Map();                     // owner → fence of the RUNNING operation (diagnostics, lostFenceOf)
const invalidators = new Set();               // (owner, err, fence) => void — one per store binding
const stats = { set: 0, ended: 0, checks: 0, refused: 0, lost: 0, endedChecks: 0 };

/**
 * A new fence for one connect operation. `name`/`token` identify the lease row
 * that must be held. Run the operation with `runWithFence(fence, fn)`.
 */
export function setOwnerFence(ownerId, { name, token, epoch = null, previousEpoch = null }) {
  const owner = String(ownerId);
  if (!name || !token) throw new TypeError('setOwnerFence: name and token are required');
  // epoch (Safety Fix 4): the lease acquisition's monotonic epoch — carried to connection-store writes.
  // previousEpoch: the acquisition before this one (connection records valid until now carry it).
  const fence = Object.seal({ owner, name, token, epoch: epoch == null ? null : Number(epoch), previousEpoch: previousEpoch == null ? null : Number(previousEpoch), lost: null, ended: false, since: Date.now() });
  active.set(owner, fence);
  stats.set++;
  return fence;
}

/** Run `fn` as work of this fence's operation (and everything it starts). */
export function runWithFence(fence, fn) { return fenceAls.run(fence, fn); }

/** The fence of the operation whose work is running now, or null. */
export function currentFence() { return fenceAls.getStore() ?? null; }

/**
 * The operation released its lease. Work it started may still finish: it is
 * validated as an ENDED fence from now on (the lease row must still name its
 * token). A lost fence stays lost. No timer: the fence lives as long as work
 * that references it.
 */
export function clearOwnerFence(ownerId, fence) {
  if (!fence) return;
  if (!fence.lost) fence.ended = true;
  stats.ended++;
  if (active.get(String(ownerId)) === fence) active.delete(String(ownerId));
}

/** The error of the owner's RUNNING operation's fence if it was lost, or null. */
export function lostFenceOf(ownerId) {
  return ownerFence(ownerId)?.lost ?? null;
}

/** The fence of the owner's RUNNING operation in this process, or null. */
export function ownerFence(ownerId) {
  if (ownerId === undefined || ownerId === null || ownerId === '') return null;
  return active.get(String(ownerId)) ?? null;
}

/** A store binding registers how to invalidate the pending writes created under a fence. */
export function registerFenceInvalidator(fn) {
  invalidators.add(fn);
  return () => invalidators.delete(fn);
}

/**
 * This fence is lost — for good. Every binding invalidates the pending writes
 * CREATED UNDER IT (only those). Idempotent: returns the first error.
 */
export function invalidateFence(fence, err = new FenceLostError(fence?.owner)) {
  if (!fence) return err;
  if (fence.lost) return fence.lost;
  fence.lost = err;
  stats.lost++;
  for (const fn of invalidators) {
    try { fn(fence.owner, err, fence); } catch (e) { console.error(`[FENCE] invalidation failed: ${e?.message ?? e}`); }
  }
  return err;
}

/** Compatibility: the owner's RUNNING operation lost its fence. */
export function fenceLost(ownerId, err = new FenceLostError(ownerId)) {
  const f = ownerFence(ownerId);
  return f ? invalidateFence(f, err) : err;
}

/** Ownership of an operation's pending writes cannot be proven any more (e.g. its final flush failed). */
export function discardOwnerWrites(ownerId, err, fence = ownerFence(ownerId)) {
  return fence ? invalidateFence(fence, err) : err;
}

// ── origins of a pending write ───────────────────────────────────────────────
/**
 * The origin to record for a write CREATED now for `ownerId`: the current
 * operation's fence when it belongs to that owner, else null (a plain write).
 */
export function originFor(ownerId) {
  const f = currentFence();
  return f && ownerId != null && f.owner === String(ownerId) ? f : null;
}

/**
 * Run a flush of ONE pending write with the origins recorded at its creation.
 * `checkFenceOn` validates exactly these (an empty list = a plain write: no
 * lease to prove, external data frozen) — never the ambient operation.
 */
export function withWriteOrigins(origins, fn) {
  return originAls.run({ origins: [...(origins ?? [])] }, fn);
}

/** The fences a write for `ownerId` must prove, as seen from here. */
function fencesToProve(ownerId) {
  const scope = originAls.getStore();
  if (scope) return scope.origins.filter(f => f.owner === String(ownerId));
  const f = originFor(ownerId);
  return f ? [f] : [];
}

/**
 * May the write running now ADD or UPDATE external-origin items of the owner?
 * Only when it carries at least one origin fence and none of them is lost —
 * the write transaction then proves every one of them (checkFenceOn).
 */
export function externalWritesAllowed(ownerId) {
  const fs = fencesToProve(ownerId);
  return fs.length > 0 && fs.every(f => !f.lost);
}
/** Step 2 name (kept for callers): same as externalWritesAllowed. */
export const externalAdditionsAllowed = externalWritesAllowed;

/** Prove ONE fence inside the caller's transaction. Throws FenceLostError (and invalidates the fence). */
async function proveFence(client, ownerId, fence) {
  if (fence.lost) { stats.refused++; throw fence.lost; }
  stats.checks++;
  let held = false;
  try {
    if (fence.ended) {
      stats.endedChecks++;
      // Ended operation: serialise with acquisitions (they take this lock), then
      // write only while NO acquisition has happened since — the row still names
      // this token (release expires it in place; a missing row fails closed).
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [leaseLockKey(fence.name)]);
      const { rows } = await client.query('SELECT holder FROM aqua_scheduler_leases WHERE name = $1 FOR SHARE', [fence.name]);
      held = rows.length === 1 && rows[0].holder === fence.token;
    } else {
      const { rows } = await client.query(
        `SELECT 1 FROM aqua_scheduler_leases
          WHERE name = $1 AND holder = $2 AND expires_at > now()
          FOR SHARE`, [fence.name, fence.token]);
      held = rows.length > 0;
    }
  } catch (err) {
    stats.refused++;
    throw invalidateFence(fence, new FenceLostError(ownerId, `lease check failed: ${String(err?.message ?? err).slice(0, 120)}`));
  }
  if (!held) {
    stats.refused++;
    throw invalidateFence(fence, new FenceLostError(ownerId, fence.ended
      ? 'another acquisition happened after this operation ended'
      : 'lease expired or taken over'));
  }
}

/**
 * Inside a transaction: prove the owner was not deleted (unless this is a
 * deletion), then EVERY origin fence this write carries (see fencesToProve).
 * A write with no origin proves no lease (it cannot write external data).
 * Throws OwnerDeletedError / FenceLostError. Returns the first proven fence or null.
 */
export async function checkFenceOn(client, ownerId, { deletion = false } = {}) {
  if (!deletion) await assertOwnerLive(client, ownerId);   // the account-deletion barrier, before the lease
  const fs = fencesToProve(ownerId);
  for (const f of fs) await proveFence(client, ownerId, f);
  return fs[0] ?? null;
}

/**
 * Run `fn(q)` as a guarded write: one transaction on a pool client — BEGIN,
 * checkFenceOn (deletion barrier + origin fences), fn(client), COMMIT. With
 * nothing to check — a deletion carrying no origin, or an ownerless ('')
 * plain write — `fn(pool)` runs exactly as before (no transaction added).
 */
export async function withOwnerFence(pool, ownerId, fn, { deletion = false } = {}) {
  const ownerless = ownerId === undefined || ownerId === null || ownerId === '';
  if (!fencesToProve(ownerId).length && (deletion || ownerless)) return fn(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await checkFenceOn(client, ownerId, { deletion });
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    throw err;
  } finally {
    client.release();
  }
}

export const writeFenceStats = () => ({ active: active.size, ...stats });

/** Tests only. */
export function _resetWriteFencesForTests() { active.clear(); for (const k of Object.keys(stats)) stats[k] = 0; }
