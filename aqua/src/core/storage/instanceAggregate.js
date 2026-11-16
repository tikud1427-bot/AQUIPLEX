/**
 * AQUA Storage — instance-partitioned aggregates (scalability Phase 2b, step 5)
 *
 * THE PROBLEM, MEASURED (AQUIPLEX_PER_OWNER_STORAGE_PLAN.md §6.2): a single row
 * that every request updates is a contention point. 32 processes, 30% of writes
 * on one row: nothing lost, but p99 1.7 s and a worst case of 15.8 s. Three
 * such rows exist: `.aqua-cognition.json`, `.aqua-ledger.json` (global running
 * statistics updated per turn) and the uko content cache.
 *
 * THE DESIGN: each instance writes ONLY ITS OWN ROW.
 *
 *   ~agg              the folded total (base). Written only by fold().
 *   ~inst:<instance>  one instance's CUMULATIVE contribution since it started,
 *                     plus a heartbeat. Only that instance writes it, so a
 *                     publish never contends; re-publishing the same totals is a
 *                     no-op (idempotent retries).
 *   read()            base + Σ live instance rows, combined by `add`.
 *   fold()            an instance row whose heartbeat is older than the TTL
 *                     (instance gone: crash, scale-in, deploy) is ADDED to the
 *                     base and TOMBSTONED in ONE transaction, both version-
 *                     checked. Two folders racing: one commits, the other
 *                     conflicts and re-reads, so a contribution is counted
 *                     exactly once (deduplication). Any instance may fold.
 *   recovery          a restarted process is a NEW instance (new id) starting
 *                     from zero; its predecessor's last published totals are
 *                     folded when they expire. What a crash loses is bounded by
 *                     the publish interval.
 *
 * WHEN THIS IS ALLOWED: only for state whose merge is DETERMINISTIC regardless
 * of order — `add` must be commutative and associative. `addAggregates` below
 * satisfies that for counters (sums), timestamps (max) and EWMAs combined as
 * sample-weighted means. It is NOT for authoritative user data, and the EWMA
 * combination is an approximation of a single process's recency-weighted EWMA.
 */
import os from 'node:os';
import crypto from 'node:crypto';

import { createPartitionRepository, PartitionConflictError } from './partitionRepository.js';
import { parsePartitionModes, registerPartitionBinding, partitionsDatabaseConfigured } from './ownerBinding.js';
import { errorText } from '../errorText.js';

export const BASE_KEY = '~agg';
export const instanceKey = id => `~inst:${id}`;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const WEIGHT_KEYS = ['reflected', 'turns', 'n', 'count', 'planned'];

/**
 * Structural, order-independent combination of two aggregate trees:
 *   *Ewma / *Avg numbers → mean weighted by the owning object's sample count
 *   *At / last* fields   → the later value (ISO strings compare correctly)
 *   other numbers        → sum
 *   objects              → recurse; anything else → the later/defined value
 * Weight of an object = its first numeric field among WEIGHT_KEYS (default 1).
 */
export function addAggregates(a, b) {
  if (a == null) return structuredClone(b ?? null);
  if (b == null) return structuredClone(a);
  if (typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return isNum(a) && isNum(b) ? a + b : b;
  const weight = o => { for (const k of WEIGHT_KEYS) if (isNum(o?.[k])) return o[k]; return 1; };
  const wa = weight(a); const wb = weight(b);
  // Which side is more recent, for non-time values (e.g. lastLesson): by the
  // object's own lastAt/updatedAt; ties broken by value so the result does not
  // depend on argument order.
  const recency = o => String(o?.lastAt ?? o?.updatedAt ?? '');
  const out = {};
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[k]; const y = b[k];
    if (k === 'version' || k === 'schema') {
      out[k] = isNum(x) && isNum(y) ? Math.max(x, y) : (x ?? y);     // a format version, not a count
    } else if (typeof x === 'string' && typeof y === 'string' && !/At$/.test(k)) {
      const ra = recency(a); const rb = recency(b);
      out[k] = ra !== rb ? (ra > rb ? x : y) : (x >= y ? x : y);
    } else if (/(Ewma|Avg)$/.test(k)) {
      if (!isNum(x)) out[k] = isNum(y) ? y : (x ?? y ?? null);
      else if (!isNum(y)) out[k] = x;
      else out[k] = (wa + wb) > 0 ? (x * wa + y * wb) / (wa + wb) : (x + y) / 2;
    } else if (/At$/.test(k)) {
      out[k] = x == null ? y : y == null ? x : (String(x) >= String(y) ? x : y);
    } else if (isNum(x) || isNum(y)) {
      out[k] = (isNum(x) ? x : 0) + (isNum(y) ? y : 0);
    } else if (x && typeof x === 'object' && y && typeof y === 'object') {
      out[k] = addAggregates(x, y);
    } else {
      out[k] = y !== undefined ? y : x;
    }
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.storeKey
 * @param {string} opts.instanceId
 * @param {object} [opts.repo]       partition repository (default: the process one)
 * @param {(a,b)=>object} [opts.add] commutative, associative combination
 * @param {number} [opts.ttlMs]      an instance silent this long is folded (default 15 min)
 */
export function createInstanceAggregate({ storeKey, instanceId, repo = null, add = addAggregates, ttlMs = 15 * 60_000 }) {
  const R = repo ?? createPartitionRepository({ instanceId });
  let pending = null;      // changes recorded since the last publish began
  let retained = null;     // { delta, seq } — a publish whose outcome is unknown; re-sent with the SAME seq
  let seq = 0;             // last sequence number confirmed in this generation's row
  let gen = 0;             // bumped when this instance's row was folded under it
  const stats = { publishes: 0, deduplicated: 0, generations: 0, folded: 0, foldConflicts: 0 };
  const key = () => instanceKey(gen ? `${instanceId}.${gen}` : instanceId);

  /** Add `delta` (sequence `n`) to this instance's row, exactly once. */
  async function send(delta, n, now) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let folded = false;
      let duplicate = false;
      await R.update(storeKey, key(), (cur, meta) => {
        if (meta.deleted) { folded = true; return undefined; }
        const row = cur ? JSON.parse(cur) : { contribution: null, seq: 0 };
        if ((row.seq ?? 0) >= n) { duplicate = true; return undefined; }   // this delta already landed
        return JSON.stringify({ contribution: add(row.contribution ?? null, delta), seq: n, heartbeat: now });
      }, { ownerId: '' });
      if (duplicate) stats.deduplicated++;
      if (!folded) return n;
      // Our row was folded into the base and tombstoned (we looked expired).
      // Everything already in it is counted; this delta goes to a NEW row.
      gen++; seq = 0; n = 1; stats.generations++;
    }
    throw new Error(`instance aggregate ${storeKey}: could not find a live row for ${instanceId}`);
  }

  return {
    instanceId,
    /** Apply a local change (`fn` mutates the pending delta). */
    record(fn) { pending ??= {}; fn(pending); },
    pending: () => pending,

    /** Add what was recorded since the last publish to this instance's row. Never contends; exactly once. */
    async publish(now = Date.now()) {
      if (retained) {                       // the previous publish's outcome is unknown: same seq → deduplicated if it landed
        seq = await send(retained.delta, retained.seq, now);
        retained = null;
      }
      if (!pending) {                       // heartbeat only, so a live idle instance is not folded
        await R.update(storeKey, key(), (cur, meta) => {
          if (!cur || meta.deleted) return undefined;
          const row = JSON.parse(cur);
          return JSON.stringify({ ...row, heartbeat: now });
        }, { ownerId: '' });
        return { published: false };
      }
      const delta = pending;
      pending = null;
      retained = { delta, seq: seq + 1 };
      seq = await send(delta, seq + 1, now);
      retained = null;
      stats.publishes++;
      return { published: true, seq, generation: gen };
    },

    /** base + Σ live instance rows (deterministic: summed in instance-id order). */
    async read() {
      const rows = await R.listStore(storeKey);
      const base = rows.find(r => r.partitionKey === BASE_KEY);
      let total = base?.data ? JSON.parse(base.data) : null;
      const insts = rows.filter(r => r.partitionKey.startsWith('~inst:')).sort((x, y) => (x.partitionKey < y.partitionKey ? -1 : 1));
      for (const r of insts) total = add(total, JSON.parse(r.data).contribution ?? null);
      return { total, instances: insts.length };
    },

    /**
     * Fold every expired instance row into the base, exactly once: the base
     * update and the instance tombstone commit together, both version-checked.
     */
    async fold(now = Date.now()) {
      let folded = 0;
      for (let attempt = 0; attempt < 10; attempt++) {
        const rows = await R.listStore(storeKey, { includeDeleted: false });
        const expired = rows.filter(r => r.partitionKey.startsWith('~inst:') && (JSON.parse(r.data).heartbeat ?? 0) < now - ttlMs)
          .sort((x, y) => (x.partitionKey < y.partitionKey ? -1 : 1));
        if (!expired.length) break;
        const base = rows.find(r => r.partitionKey === BASE_KEY);
        let total = base?.data ? JSON.parse(base.data) : null;
        for (const r of expired) total = add(total, JSON.parse(r.data).contribution ?? null);
        try {
          await R.transact([
            { storeKey, partitionKey: BASE_KEY, ownerId: '', data: JSON.stringify(total), expectedVersion: base?.version ?? 0 },
            ...expired.map(r => ({ storeKey, partitionKey: r.partitionKey, ownerId: '', data: null, expectedVersion: r.version })),
          ]);
          folded += expired.length;
          stats.folded += expired.length;
          break;
        } catch (err) {
          if (!(err instanceof PartitionConflictError)) throw err;
          stats.foldConflicts++;    // another folder (or a late publish) won: re-read and try again
        }
      }
      return { folded };
    },

    stats: () => ({ ...stats }),
  };
}

// ── Wiring a global heuristic store (Phase 2c, limitation 5) ────────────────

/** Drop non-finite numbers and negative counts: an aggregate row is never trusted blindly. */
export function sanitizeAggregate(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.max(0, v) : undefined;
  if (Array.isArray(v) || v === null || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const s = sanitizeAggregate(x);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

/**
 * Bind a GLOBAL heuristic store (cognition, ledger) to instance aggregates.
 * Never used for owner data: these hold strategy priors and provider
 * statistics, and nothing is read from them per user.
 *
 * AQUA_STORE_PARTITIONS=<name>:on — every change is applied to the local view
 * exactly as today AND recorded into this instance's delta. Every `syncMs`
 * the delta is published (own row, no contention) and the local view becomes
 * total + unpublished changes. Expired instances are folded on every 10th
 * sync (exactly-once, so any instance may do it). `shadow`: publish only; the
 * local view is never replaced. Off: nothing.
 *
 * @param {object} o
 * @param {string} o.storeKey
 * @param {string} o.label
 * @param {() => object} o.emptyDelta      a fresh root of the store's shape
 * @param {(view) => void} o.setLocal       replace the local view (on mode)
 * @param {number} [o.syncMs]
 */
export function bindAggregateStore({ storeKey, label, emptyDelta, setLocal, initialBase = null, syncMs = 30_000, mode: forced = null, repo = null }) {
  let mode = forced ?? parsePartitionModes().get(storeKey) ?? 'off';
  let reason = null;
  if (mode === 'only') mode = 'on';
  if (mode !== 'off' && !partitionsDatabaseConfigured()) { reason = `AQUA_STORE_PARTITIONS asked for ${mode} but DATABASE_URL is not set`; mode = 'off'; }
  const instanceId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
  const agg = mode === 'off' ? null : createInstanceAggregate({ storeKey, instanceId, ...(repo ? { repo } : {}) });
  let timer = null;
  let syncs = 0;
  let lastError = null;
  const stats = { syncs: 0, failures: 0, folded: 0 };

  let seeded = false;
  async function sync() {
    if (!agg) return;
    if (!seeded) {
      // Migration: today's single instance holds real aggregates in its JSON
      // file. The first instance to come up seeds the shared base with them
      // (insert-if-absent: exactly one wins); every later instance starts from
      // that base instead of discarding history.
      seeded = true;
      const R = repo ?? createPartitionRepository({ instanceId: `${instanceId}:seed` });
      const local = typeof initialBase === 'function' ? initialBase() : null;
      if (local && !(await R.hasAny(storeKey))) {
        try {
          await R.put(storeKey, BASE_KEY, JSON.stringify(sanitizeAggregate(local)), { ownerId: '', expectedVersion: 0 });
          stats.seeded = true;
        } catch (err) { if (!(err instanceof PartitionConflictError)) throw err; }
      }
    }
    await agg.publish();
    if (mode === 'on') {
      const { total } = await agg.read();
      setLocal(sanitizeAggregate(addAggregates(total ?? emptyDelta(), agg.pending())));
    }
    if (++syncs % 10 === 0) stats.folded += (await agg.fold()).folded;
    stats.syncs++;
  }
  const safeSync = () => sync().catch(err => { stats.failures++; lastError = errorText(err); });

  const binding = {
    storeKey, label,
    get mode() { return mode; },
    get reason() { return reason; },
    authoritative: () => false,     // never loaded per owner
    isLoaded: () => true,
    wanted: () => [],
    applyOwner: () => {},
    /** Apply a change: always to the local view; also to the delta when on. */
    apply(localRoot, fn) {
      fn(localRoot);
      if (agg) agg.record(delta => { if (!Object.keys(delta).length) Object.assign(delta, emptyDelta()); fn(delta); });
    },
    async configure() {
      if (!agg) return;
      await safeSync();
      if (!timer) { timer = setInterval(safeSync, syncMs); timer.unref?.(); }
    },
    flush: () => (agg ? agg.publish().catch(err => { stats.failures++; lastError = errorText(err); }) : Promise.resolve()),
    sync,
    status: () => ({ store: storeKey, mode, reason, kind: 'instance-aggregate', instanceId, lastError, ...stats, ...(agg?.stats() ?? {}) }),
    _stop() { if (timer) clearInterval(timer); timer = null; },
  };
  return registerPartitionBinding(binding);
}
