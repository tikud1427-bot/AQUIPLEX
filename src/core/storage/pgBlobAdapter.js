/**
 * AQUA Storage — Postgres blob adapter
 * Blueprint E3/PR-4 · UNUSED
 *
 * Nothing installs this. `getAdapter()` still returns the JSON adapter, and a
 * test asserts no production module imports this file. It exists to be graded
 * against the same contract the JSON adapter passes, and to surface — now,
 * cheaply — the one thing that makes the substrate swap harder than it looks.
 *
 * ⚠ THE FINDING: POSTGRES HAS NO SYNCHRONOUS CLIENT
 * -------------------------------------------------
 * The seam requires `readSync`, `writeSync`, `existsSync` and `copySync`,
 * because that is what `atomicStore` has always offered and what the shutdown
 * hooks depend on. There is no synchronous Postgres driver in Node and there
 * cannot sensibly be one.
 *
 * So this adapter is **hydrate-once, serve-from-cache, write-behind**:
 *
 *   hydrate()    async, once, at boot — loads every store blob into memory
 *   readSync     serves the cache
 *   writeSync    updates the cache and ENQUEUES a database write
 *   write        updates the cache and awaits the database write
 *   flush()      awaits every queued write — must be called on SIGTERM
 *
 * That matches how the engine already behaves (every store is fully in memory
 * and flushed on a debounce), so it is not a new risk. But it IS a different
 * durability guarantee from the file adapter, and pretending otherwise would
 * be the kind of quiet equivalence E3/PR-3 nearly shipped with temp paths.
 *
 * It is therefore declared, not buried:
 *
 *   jsonFileAdapter.syncDurable === true    writeSync has hit the disk on return
 *   pgBlobAdapter.syncDurable  === false    writeSync has hit MEMORY on return
 *
 * E3/PR-5's dual-write must call `flush()` in the SIGTERM drain. A test in
 * that PR will assert it; this comment is the reason it exists.
 */
import path from 'node:path';
import crypto from 'node:crypto';

import { getPool, isConfigured } from '../db/pool.js';

export const TABLE = 'aqua_store_blobs';

/**
 * A write lost the race. Its own error type because it is NOT a failure of the
 * database — it is the concurrency control working, and the caller's correct
 * response (re-read, merge, retry) is different from a connection error's.
 */
export class StoreConflictError extends Error {
  constructor(storeKey, detail) {
    super(`store "${storeKey}" changed underneath this instance — ${detail}`);
    this.name = 'StoreConflictError';
    this.storeKey = storeKey;
  }
}

const checksum = data => crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);

/** A store path becomes its basename. See 0002_store_blobs.sql for why. */
export const storeKeyFor = key => path.basename(String(key));

export function createPgBlobAdapter() {
  /** @type {Map<string, string>} storeKey → serialised store */
  const cache = new Map();
  /**
   * storeKey → the row version this instance last saw.
   *
   * E3/PR-9 — the guard for the epic's exit criterion. Two instances each hold
   * their own cache; without a version, the second write overwrites the first
   * wholesale and neither cache ever learns. Measured before this existed:
   * instance A wrote, instance B wrote, A's data was gone and both caches
   * still believed their own version.
   */
  const versions = new Map();
  /** Writes rejected because another instance got there first. */
  const conflicts = [];
  /** In-flight writes, so flush() can await them. */
  const pending = new Set();
  /** Write-behind failures, surfaced by flush(). */
  const failures = [];
  let hydrated = false;

  /**
   * Track a write without ever creating an UNHANDLED rejection.
   *
   * A write-behind promise is not awaited by its caller — that is the whole
   * point — so a rejection propagating out of it is unhandled, and Node kills
   * the process on an unhandled rejection. Exactly the failure mode
   * `pool.on('error')` guards in E3/PR-1, reached by a different road.
   *
   * So the error is recorded and logged here, and RE-REPORTED by flush(). The
   * failure is loud and it is surfaced at a point where someone is waiting for
   * an answer — without taking the process down in between.
   */
  const enqueue = (promise) => {
    const tracked = promise.catch(err => {
      failures.push(err);
      // A conflict is kept separately AND survives flush(), because flush
      // clears `failures` so it is not sticky. An operator asking "did any
      // write lose a race?" must still get an answer after a flush.
      if (err instanceof StoreConflictError) conflicts.push(err);
      console.error(`[DB] store write failed: ${err.message}`);
    });
    pending.add(tracked);
    tracked.finally(() => pending.delete(tracked));
    return tracked;
  };

  /**
   * Write a store blob, guarded by the version this instance last read.
   *
   * A new row inserts at version 1. An existing row updates ONLY if its
   * version still matches what we saw — otherwise another instance wrote in
   * between, the update affects zero rows, and we say so instead of silently
   * winning.
   */
  async function upsert(storeKey, data) {
    const pool = await getPool();
    if (!pool) throw new Error('pgBlobAdapter: DATABASE_URL is not configured');
    const bytes = Buffer.byteLength(data, 'utf8');
    const sum = checksum(data);
    const seen = versions.get(storeKey);

    if (seen === undefined) {
      // First write from this instance. If a row already exists, this is a
      // conflict by definition — we are writing over something we never read.
      // Checked by READING BACK rather than by trusting `RETURNING` on a
      // DO NOTHING. pg-mem returns a row even when nothing was inserted (real
      // Postgres returns none), so a guard built on the row count would be
      // correct in production and silently wrong in every test — the worst
      // combination available. Reading back the stored checksum is true on
      // both, and it is one extra query on a path that runs once per store.
      await pool.query(
        `INSERT INTO ${TABLE} (store_key, data, bytes, checksum, version, updated_at)
         VALUES ($1, $2, $3, $4, 1, now())
         ON CONFLICT (store_key) DO NOTHING`,
        [storeKey, data, bytes, sum]);
      const { rows } = await pool.query(
        `SELECT checksum, version FROM ${TABLE} WHERE store_key = $1`, [storeKey]);
      if (rows[0]?.checksum === sum) { versions.set(storeKey, rows[0].version); return; }
      throw new StoreConflictError(storeKey, 'a row already exists that this instance never read');
    }

    const { rows } = await pool.query(
      `UPDATE ${TABLE}
          SET data = $2, bytes = $3, checksum = $4,
              version = version + 1, updated_at = now()
        WHERE store_key = $1 AND version = $5
        RETURNING version`,
      [storeKey, data, bytes, sum, seen]);

    if (!rows.length) {
      throw new StoreConflictError(storeKey,
        `expected version ${seen}; another instance wrote first`);
    }
    versions.set(storeKey, rows[0].version);
  }

  return {
    id: 'pg-blob',

    // Declared, not discovered later. See the header.
    syncDurable: false,

    /** Load every blob into memory. Must run before any sync read. */
    async hydrate() {
      if (!isConfigured()) throw new Error('pgBlobAdapter: DATABASE_URL is not configured');
      const pool = await getPool();
      const { rows } = await pool.query(`SELECT store_key, data, version FROM ${TABLE}`);
      cache.clear();
      versions.clear();
      for (const r of rows) {
        cache.set(r.store_key, r.data);
        versions.set(r.store_key, r.version);
      }
      hydrated = true;
      return cache.size;
    },

    /**
     * Re-read one store from the database — the recovery path after a conflict.
     * Deliberately NOT automatic: silently adopting the other instance's value
     * would discard this instance's write with nobody told. The caller decides.
     */
    async refresh(key) {
      const storeKey = storeKeyFor(key);
      const pool = await getPool();
      const { rows } = await pool.query(
        `SELECT data, version FROM ${TABLE} WHERE store_key = $1`, [storeKey]);
      if (!rows.length) { cache.delete(storeKey); versions.delete(storeKey); return null; }
      cache.set(storeKey, rows[0].data);
      versions.set(storeKey, rows[0].version);
      return rows[0].data;
    },

    conflicts() { return [...conflicts]; },

    isHydrated() { return hydrated; },

    existsSync(key) { return cache.has(storeKeyFor(key)); },

    readSync(key) {
      const v = cache.get(storeKeyFor(key));
      return v === undefined ? null : v;
    },

    /**
     * The caller is awaiting, so a conflict is REPORTED rather than recorded.
     *
     * `enqueue` swallows-and-records because a write-behind promise has nobody
     * to tell. An awaited write does — and a caller who is not told their write
     * lost believes it won, which is how two instances end up confidently
     * holding different data. The tracked copy still feeds flush() and the
     * conflict list.
     */
    async write(key, data) {
      const storeKey = storeKeyFor(key);
      cache.set(storeKey, data);
      const pending = upsert(storeKey, data);
      enqueue(pending);
      await pending;
    },

    /**
     * Synchronous only in the sense the caller needs: the value is readable
     * immediately. Durability is deferred — see syncDurable.
     */
    writeSync(key, data) {
      const storeKey = storeKeyFor(key);
      cache.set(storeKey, data);
      enqueue(upsert(storeKey, data));
    },

    copySync(from, to) {
      const value = cache.get(storeKeyFor(from));
      if (value === undefined) throw new Error(`pgBlobAdapter: nothing to copy from ${from}`);
      this.writeSync(to, value);
    },

    /** Await every queued write. MUST be called on SIGTERM. */
    async flush() {
      const inFlight = [...pending];
      await Promise.all(inFlight);          // already caught by enqueue()
      if (failures.length) {
        const n = failures.length;
        const first = failures[0]?.message ?? 'unknown';
        failures.length = 0;
        throw new Error(`pgBlobAdapter: ${n} store write(s) failed — first: ${first}`);
      }
      return inFlight.length;
    },

    /** Tests only — how many write-behind failures are waiting to be reported. */
    _failureCount() { return failures.length; },

    /** Tests only. */
    _cache: cache,
  };
}
