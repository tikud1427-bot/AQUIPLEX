/**
 * AQUA Connect — per-owner connect LEASE (multi-instance safety)
 *
 * connect, sync, revoke and disconnect of one owner must never run on two
 * instances at once (a disconnect deleting a source while another instance's
 * sync re-imports it). The in-process lock (connectService.withOwnerLock) only
 * covers one Node.js process; this lease covers every process that shares the
 * database. Table: aqua_scheduler_leases (migration 0029) — no new schema.
 *
 *   acquire   ONE conditional upsert: insert, or take over a row whose
 *             expires_at < now() (database clock). Exactly one racer wins; a
 *             live lease of another holder is waited for (bounded), never
 *             overwritten. Each acquisition writes a NEW unique holder token.
 *   renew     only `holder = <my token> AND expires_at > now()` — an expired
 *             or superseded holder cannot renew (or resurrect) anything.
 *   release   EXPIRE only `holder = <my token>` (expires_at in the past; the row
 *             stays, naming the last holder — the trailing fence needs that
 *             history) — never another holder's lease.
 *
 * A lease alone cannot stop a STALE holder (a process that stalled past expiry)
 * from writing what it still has in memory. withConnectLease therefore also
 * sets a WRITE FENCE (core/storage/writeFence.js): every partition-backed write
 * of the owner by this process, and the enqueue and deletion transactions,
 * re-check the lease row FOR SHARE inside their own transaction and are refused
 * once it is gone. Before release, every pending write of the owner is flushed
 * while still fenced; what cannot be proven written is discarded, never left
 * for an unfenced retry.
 *
 * EPOCH (Safety Fix 4). Every acquisition advances the row's acquired_at
 * strictly (under the lease name's advisory lock: max(clock_timestamp(),
 * previous + 1 ms)); the EPOCH is that time in MILLISECONDS (strictly increasing:
 * every acquisition advances it by at least 1 ms). It never decreases
 * and is never reused while the row exists (release only expires the row; only
 * an account purge deletes it, after which the owner can never acquire again).
 * Connection-store writes carry (epoch, token): see serializeConnectionWrite.
 *
 * Fail closed: with a database configured, a lease that cannot be acquired,
 * renewed or verified refuses (or ends) the operation. With NO database at all
 * there is no shared store for another instance to write to — every store is a
 * local file — and the in-process lock is the whole guarantee ('local' mode).
 */
import crypto from 'node:crypto';
import os from 'node:os';
import { getPool, isConfigured } from '../core/db/pool.js';
import { flushOwnerStrict } from '../core/storage/ownerBinding.js';
import { setOwnerFence, clearOwnerFence, invalidateFence, runWithFence, FenceLostError, leaseLockKey } from '../core/storage/writeFence.js';

export const CONNECT_LEASE_TTL_MS = (() => {
  const v = Number(process.env.AQUA_CONNECT_LEASE_MS);
  return Number.isFinite(v) && v >= 1000 ? v : 30_000;
})();

const INSTANCE = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;

export class LeaseError extends Error {
  constructor(code, message) { super(message); this.name = 'LeaseError'; this.code = code; }
}

/** The lease row of an owner (hashed: no owner id in the table). */
/** The epoch of an acquisition: its acquired_at in milliseconds (an integer). */
const epochOf = t => { const ms = t instanceof Date ? t.getTime() : Date.parse(String(t)); return Number.isSafeInteger(ms) ? ms : NaN; };

export const connectLeaseName = ownerId =>
  `connect-owner:${crypto.createHash('sha256').update(String(ownerId)).digest('hex').slice(0, 40)}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {string} ownerId
 * @param {{ pool?: object, ttlMs?: number }} [opts]
 */
export function createOwnerLease(ownerId, { pool: injected = null, ttlMs = CONNECT_LEASE_TTL_MS } = {}) {
  const name = connectLeaseName(ownerId);
  const token = `${INSTANCE}:${crypto.randomUUID()}`;
  const ttl = String(Math.max(1000, Math.floor(ttlMs)));
  const pool = async () => injected ?? (isConfigured() ? await getPool() : null);
  let held = false;
  let epoch = null;
  let previousEpoch = null;

  return {
    name, token, ttlMs: Number(ttl),
    get held() { return held; },
    /** The monotonic epoch of THIS acquisition (null before it succeeded). */
    get epoch() { return epoch; },
    /** The epoch of the acquisition BEFORE this one (null: none) — what valid connection records carried until now. */
    get previousEpoch() { return previousEpoch; },

    /**
     * Take the lease (waits up to `waitMs` for a live holder). Throws LEASE_BUSY /
     * LEASE_UNAVAILABLE / OWNER_DELETED. `purge` (account purge ONLY): the owner
     * must already be marked deleted; a live holder is TAKEN OVER at once (every
     * operation of a deleted owner is invalid — its writes are refused anyway).
     */
    async acquire({ waitMs = 10_000, purge = false } = {}) {
      const deadline = Date.now() + Math.max(0, waitMs);
      for (;;) {
        let rows;
        try {
          const p = await pool();
          if (!p) throw new Error('no database');
          // One transaction under the lease name's advisory lock — the lock a
          // TRAILING write of the previous holder takes (writeFence.js), so the
          // two are ordered: an in-flight trailing write commits first.
          const c = await p.connect();
          try {
            await c.query('BEGIN');
            await c.query('SELECT pg_advisory_xact_lock($1::bigint)', [leaseLockKey(name)]);
            // A deleted account never gets a connect lease again (its writes are
            // refused by the storage barrier anyway — this refuses the operation).
            const gone = await c.query('SELECT 1 FROM aqua_deleted_owners WHERE owner_id = $1', [String(ownerId)]);
            if (gone.rows.length && !purge) throw new LeaseError('OWNER_DELETED', 'this account was deleted');   // rolled back below
            if (!gone.rows.length && purge) throw new LeaseError('PURGE_NOT_MARKED', 'a purge acquisition needs the account deletion marker first');
            const prev = await c.query('SELECT acquired_at FROM aqua_scheduler_leases WHERE name = $1', [name]);
            // acquired_at advances STRICTLY (the epoch): never equal to, never below the previous acquisition.
            ({ rows } = await c.query(
              `INSERT INTO aqua_scheduler_leases AS l (name, holder, expires_at, acquired_at, renewed_at)
                    VALUES ($1, $2, now() + ($3::text || ' milliseconds')::interval, clock_timestamp(), now())
               ON CONFLICT (name) DO UPDATE
                     SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at,
                         acquired_at = CASE WHEN clock_timestamp() > l.acquired_at + interval '1 millisecond'
                                            THEN clock_timestamp() ELSE l.acquired_at + interval '1 millisecond' END,
                         renewed_at = now()
                   WHERE ${purge ? 'true' : 'l.expires_at < now()'}
               RETURNING holder, acquired_at`, [name, token, ttl]));
            await c.query('COMMIT');
            if (rows[0]?.holder === token) previousEpoch = prev.rows.length ? epochOf(prev.rows[0].acquired_at) : null;
          } catch (e) {
            try { await c.query('ROLLBACK'); } catch { /* connection may be gone */ }
            throw e;
          } finally { c.release(); }
        } catch (err) {
          if (err instanceof LeaseError) throw err;   // OWNER_DELETED: final, not "unavailable"
          throw new LeaseError('LEASE_UNAVAILABLE', `connect lease could not be acquired: ${String(err?.message ?? err).slice(0, 160)}`);
        }
        if (rows[0]?.holder === token) {
          epoch = epochOf(rows[0].acquired_at);
          if (!Number.isSafeInteger(epoch) || epoch <= 0) { held = false; throw new LeaseError('LEASE_UNAVAILABLE', 'connect lease epoch is malformed'); }
          held = true; return true;
        }
        if (Date.now() >= deadline) throw new LeaseError('LEASE_BUSY', 'another instance is running a connect operation for this user');
        await sleep(50 + Math.floor(Math.random() * 100));
      }
    },

    /** Extend MY live lease. false when it expired or was taken over (or the database cannot answer). */
    async renew() {
      if (!held) return false;
      try {
        const p = await pool();
        const { rows } = await p.query(
          `UPDATE aqua_scheduler_leases
              SET expires_at = now() + ($3::text || ' milliseconds')::interval, renewed_at = now()
            WHERE name = $1 AND holder = $2 AND expires_at > now()
              AND NOT EXISTS (SELECT 1 FROM aqua_deleted_owners d WHERE d.owner_id = $4)
            RETURNING 1`, [name, token, ttl, String(ownerId)]);   // a deleted account's operation loses its lease
        if (!rows.length) held = false;
        return rows.length > 0;
      } catch {
        return false;
      }
    },

    /** Is MY lease live right now (database clock)? */
    async verify() {
      try {
        const p = await pool();
        const { rows } = await p.query(
          'SELECT 1 FROM aqua_scheduler_leases WHERE name = $1 AND holder = $2 AND expires_at > now()', [name, token]);
        return rows.length > 0;
      } catch {
        return false;
      }
    },

    /**
     * Give up MY lease only: expire it in place (the row keeps my token until
     * the next acquisition — writeFence's trailing check relies on that).
     * Never touches a newer holder's row.
     */
    async release() {
      held = false;
      try {
        const p = await pool();
        const { rowCount } = await p.query(
          `UPDATE aqua_scheduler_leases SET expires_at = now() - interval '1 millisecond', renewed_at = now()
            WHERE name = $1 AND holder = $2`, [name, token]);
        return rowCount > 0;
      } catch {
        return false;   // the TTL frees it
      }
    },

    /**
     * Account purge ONLY, its very last step: DELETE my row (still holding it).
     * Afterwards a new acquisition is refused by the deletion marker, and an old
     * operation's ended-fence proof finds no row (fail closed).
     */
    async deleteRow() {
      const p = await pool();
      const { rowCount } = await p.query('DELETE FROM aqua_scheduler_leases WHERE name = $1 AND holder = $2', [name, token]);
      held = false;
      return rowCount > 0;
    },
  };
}

// ── Safety Fix 4: connection-store writes ordered with lease acquisition ─────
export const CONNECTION_WRITE_BOUND_MS = 5_000;   // a connection-store call never holds the serialisation longer
export const CONNECTION_WRITE_GRACE_MS = 1_000;   // after a timeout: the store's own server-side limit has passed

const withTimeout = (p, ms, onTimeout) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(onTimeout()), ms); t.unref?.(); })]).finally(() => clearTimeout(t));
};

/**
 * Run ONE connection-store write `fn(fence)` ordered against lease acquisition,
 * across the two stores (PostgreSQL lease, MongoDB connections):
 *
 *   BEGIN; pg_advisory_xact_lock_SHARED(lease name)   — every ACQUISITION takes
 *          it EXCLUSIVELY, so an acquisition waits for this write to finish;
 *   the owner is not deleted (marker) and the lease row still names THIS
 *          fence's token, live — else refused (LEASE_LOST / OWNER_DELETED);
 *   fn(fence): the store's conditional write (epoch/token compare-and-set),
 *          bounded (CONNECTION_WRITE_BOUND_MS; the Mongo adapter passes the
 *          same bound as maxTimeMS so the server abandons it too);
 *   COMMIT.
 *
 * Ordering 1 — an old write already in progress holds the shared lock: the
 * newer acquisition waits for it, then stamps the connections with its epoch
 * before reading them (it sees the old write). Ordering 2 — a newer acquisition
 * committed first: the old write finds another token and is refused before it
 * touches the store; and a store request delivered LATE anyway is rejected by
 * the store itself (its epoch is below the stamp — storage-enforced fencing).
 * A timeout (outcome unknown) loses the fence: the lock is held a further
 * grace period (past the store's own limit) and the operation fails closed.
 */
export async function serializeConnectionWrite(fence, ownerId, fn, { pool: injected = null, boundMs = CONNECTION_WRITE_BOUND_MS, graceMs = CONNECTION_WRITE_GRACE_MS } = {}) {
  if (!fence || !fence.name || !fence.token || !Number.isSafeInteger(fence.epoch) || fence.epoch <= 0
      || (fence.previousEpoch != null && !Number.isSafeInteger(fence.previousEpoch))) {
    throw new LeaseError('CONNECTION_FENCE_MISSING', 'a connection-store write needs a valid connect fence (epoch and token)');
  }
  if (fence.lost) throw new LeaseError('LEASE_LOST', `the connect lease was lost (${fence.lost.message})`);
  const p = injected ?? (isConfigured() ? await getPool() : null);
  if (!p) throw new LeaseError('LEASE_UNAVAILABLE', 'no database to order the connection write');
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [leaseLockKey(fence.name)]);
    const gone = await c.query('SELECT 1 FROM aqua_deleted_owners WHERE owner_id = $1', [String(ownerId)]);
    if (gone.rows.length) {
      invalidateFence(fence, new FenceLostError(ownerId, 'the account was deleted'));
      throw new LeaseError('OWNER_DELETED', 'this account was deleted');
    }
    const live = await c.query('SELECT 1 FROM aqua_scheduler_leases WHERE name = $1 AND holder = $2 AND expires_at > now()', [fence.name, fence.token]);
    if (!live.rows.length) {
      invalidateFence(fence, new FenceLostError(ownerId, 'lease expired or taken over before a connection write'));
      throw new LeaseError('LEASE_LOST', 'the connect lease is no longer held');
    }
    let result;
    try {
      result = await withTimeout(Promise.resolve().then(() => fn({ epoch: fence.epoch, token: fence.token, previousEpoch: fence.previousEpoch })), boundMs,
        () => Object.assign(new Error('connection write timed out'), { code: 'CONNECTION_WRITE_TIMEOUT' }));
    } catch (err) {
      if (err?.code === 'CONNECTION_WRITE_TIMEOUT') {
        invalidateFence(fence, new FenceLostError(ownerId, 'a connection write did not complete in time (outcome unknown)'));
        await sleep(graceMs);                            // keep acquisitions out until the store's own limit has passed
        throw new LeaseError('LEASE_LOST', 'a connection write did not complete in time; the operation was stopped');
      }
      if (err?.code === 'FENCE_STALE') {
        invalidateFence(fence, new FenceLostError(ownerId, 'the connection store holds a newer epoch'));
        throw new LeaseError('LEASE_LOST', 'a newer connect operation owns this connection');
      }
      throw err;
    }
    await c.query('COMMIT');
    return result;
  } catch (err) {
    try { await c.query('ROLLBACK'); } catch { /* connection may be gone */ }
    throw err;
  } finally {
    c.release();
  }
}

/**
 * The owner's CURRENT epoch (the latest acquisition), for views outside an
 * operation: a connection record is valid only when it carries it. null when
 * the account was deleted, or no lease row exists (nothing valid to show).
 */
export async function currentOwnerEpoch(ownerId, { pool: injected = null } = {}) {
  const p = injected ?? (isConfigured() ? await getPool() : null);
  if (!p) return null;
  const { rows } = await p.query(
    `SELECT l.acquired_at,
            EXISTS (SELECT 1 FROM aqua_deleted_owners d WHERE d.owner_id = $2) AS gone
       FROM aqua_scheduler_leases l WHERE l.name = $1`, [connectLeaseName(ownerId), String(ownerId)]);
  if (!rows.length || rows[0].gone) return null;
  const e = epochOf(rows[0].acquired_at);
  return Number.isSafeInteger(e) && e > 0 ? e : null;
}

/**
 * Run `fn` holding the owner's connect lease and write fence. Call it INSIDE
 * the in-process owner lock (connectService.withOwnerLock).
 *
 *   1. acquire (fail closed)            4. flush every pending write of the
 *   2. a NEW fence for this operation      owner (each with the fence it was
 *   3. run fn INSIDE runWithFence,         created under)
 *      renewing in background           5. verify, release (token-specific), END the fence
 *
 * Safety Fix 3: the fence travels with the operation's work (AsyncLocalStorage)
 * and with every pending write created under it. Work that finishes AFTER the
 * operation is validated against THIS fence's token for as long as it exists
 * (core/storage/writeFence.js) — a later operation's fence never authorises it.
 *
 * Throws LeaseError LEASE_LOST when the lease was lost at any point (writes
 * made after the loss were refused and discarded), LEASE_BUSY /
 * LEASE_UNAVAILABLE when it could not be acquired.
 *
 * @param {string} ownerId
 * @param {(ctx: { mode: 'lease'|'local', fence?: object, lease?: object }) => Promise<any>} fn
 * @param {{ pool?: object, ttlMs?: number, renewEveryMs?: number, waitMs?: number }} [opts]
 */
export async function withConnectLease(ownerId, fn, { pool = null, ttlMs = CONNECT_LEASE_TTL_MS, renewEveryMs = null, waitMs = 10_000 } = {}) {
  if (!pool && !isConfigured()) return fn({ mode: 'local' });   // no shared store exists: the process lock is the guarantee

  const lease = createOwnerLease(ownerId, { pool, ttlMs });
  await lease.acquire({ waitMs });
  const fence = setOwnerFence(ownerId, { name: lease.name, token: lease.token, epoch: lease.epoch, previousEpoch: lease.previousEpoch });

  const every = renewEveryMs ?? Math.max(250, Math.floor(lease.ttlMs / 3));
  let renewing = false;
  const timer = every > 0 ? setInterval(async () => {
    if (renewing || fence.lost) return;
    renewing = true;
    try {
      if (!(await lease.renew())) invalidateFence(fence, new FenceLostError(ownerId, 'lease renewal refused (expired or taken over)'));
    } finally { renewing = false; }
  }, every) : null;
  timer?.unref?.();

  let result;
  let error = null;
  try {
    result = await runWithFence(fence, () => fn({ mode: 'lease', fence, lease }));
  } catch (err) {
    error = err;
  }
  // Every pending write of this owner — including debounced ones and retries —
  // goes to the database NOW, fenced. Anything that cannot be proven written is
  // discarded (never left for an unfenced retry after release).
  try {
    await flushOwnerStrict(ownerId);
  } catch (err) {
    if (!fence.lost) invalidateFence(fence, new FenceLostError(ownerId, `final flush failed: ${String(err?.message ?? err).slice(0, 120)}`));
    error ??= err;
  }
  if (timer) clearInterval(timer);
  // Ownership must be PROVEN to the end, even when no write was attempted (a
  // stale holder whose imports were all rejected wrote nothing — but its
  // operation did not run under a valid lease, and must not report success).
  if (!fence.lost && !(await lease.verify())) {
    invalidateFence(fence, new FenceLostError(ownerId, 'lease not held at the end of the operation'));
  }
  const lost = fence.lost;
  await lease.release();
  // END the fence (no timer). Work this operation started that is still running
  // keeps it: a held fence is validated as ENDED (the lease row must still name
  // this token — any later acquisition refuses it); a lost fence stays lost.
  clearOwnerFence(ownerId, fence);
  if (lost) {
    throw Object.assign(new LeaseError('LEASE_LOST', `the connect lease was lost; this operation's unwritten changes were discarded (${lost.message})`), { cause: error ?? lost });
  }
  if (error) throw error;
  return result;
}
