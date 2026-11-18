/**
 * AQUA Storage — owner bindings: an existing store, persisted per owner
 * (scalability Phase 2b)
 *
 * A store keeps its in-memory Map and its synchronous accessors. The binding
 * changes WHERE each owner's entry is persisted and WHEN it is loaded:
 *
 *   loaded   per owner, asynchronously, at the start of a unit of work
 *            (`ensureOwnerLoaded`: the aqua router per request, the worker per
 *            job). One index range scan covers every bound store.
 *   written  per owner. A mutation marks the owner dirty; a short debounce later
 *            only the dirty owners are written, each through
 *            partitionRepository.update(), i.e. version-checked. On a conflict
 *            the store's MERGE is applied to the newer database value, so a
 *            server and a worker that both changed one owner keep both changes.
 *   deleted  as a tombstone row. A process still holding the owner cannot bring
 *            it back unless its copy changed AFTER the deletion (then it is new
 *            information, not a stale copy).
 *
 * MODES — `AQUA_STORE_PARTITIONS=reflection:on,mind:shadow` (default: off)
 *
 *   off      exactly today's behaviour. The binding does nothing.
 *   shadow   JSON stays authoritative (loaded at boot, written whole). Dirty
 *            owners are ALSO written to partitions, best effort: a failure is
 *            counted, logged and retried, never surfaced to the user. Drift is
 *            measured with partitionMigration.reconcileStore.
 *   on       partitions are authoritative. The JSON file is not loaded at boot;
 *            owners are loaded on demand. The JSON file is still written, as a
 *            ROLLBACK COPY: the file on disk with this process's merged owners
 *            replaced (not the in-memory Map, which no longer holds everyone).
 *            Rollback = remove the flag.
 *   only     partitions only; no JSON copy. Rollback = partitionMigration
 *            .exportStore → JSON file first, then remove the flag.
 *
 * SAFETY RULES
 *   · `on`/`only` without DATABASE_URL → `off`, with the reason in the boot line.
 *   · `on`/`only` for a store with NO partition rows while its JSON file holds
 *     data → `off` (never migrated; serving it would look like total data loss).
 *   · An owner that is not loaded is NOT READY (`ready(owner) === false`). A
 *     store must not answer "nothing here" for it as if that were true: the
 *     reflection store skips reflection rather than diff against nothing.
 *
 * This module never imports core/dataDir.js (Mongo hydration at import): stores
 * pass their own file path.
 */
import fs from 'node:fs';

import { isConfigured } from '../db/pool.js';
import { createPartitionRepository } from './partitionRepository.js';
import { isOwnerDeleted } from './deletedOwners.js';
import { noteWrite } from './requestWrites.js';
import { errorText } from '../errorText.js';

export const MODES = Object.freeze(['off', 'shadow', 'on', 'only']);
const FLUSH_DEBOUNCE_MS = 250;
const RETRY_CAP_MS = 30_000;

/** `reflection:on, mind:shadow` → Map<'.aqua-reflection.json', 'on'> */
export function parsePartitionModes(raw = process.env.AQUA_STORE_PARTITIONS) {
  const out = new Map();
  for (const part of String(raw ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [nameRaw, modeRaw = 'shadow'] = part.split(':').map(s => s.trim());
    let key = nameRaw.startsWith('.aqua-') || nameRaw.startsWith('.') ? nameRaw : `.aqua-${nameRaw}`;
    if (!key.endsWith('.json')) key = `${key}.json`;
    const mode = String(modeRaw).toLowerCase();
    out.set(key, MODES.includes(mode) ? mode : 'off');
  }
  return out;
}

const registry = new Map();          // storeKey → binding
let repo = null;
const getRepo = () => (repo ??= createPartitionRepository());

/** Tests: install a repository (e.g. with its own pool). */
export function _setRepositoryForTests(r) { repo = r; }

/**
 * Bind one owner-keyed store.
 *
 * @param {object} spec
 * @param {string} spec.storeKey           file basename, e.g. '.aqua-reflection.json'
 * @param {string} spec.file               absolute path of the JSON file (rollback copy)
 * @param {string} [spec.label]
 * @param {string} [spec.section]          partition section ('o' → partition key 'o:<owner>'), matching partitionLayout
 * @param {number} [spec.schema]           envelope schema for the rollback copy
 * @param {(owner) => object|undefined} spec.encode   the owner's entry exactly as the JSON file holds it; undefined = absent
 * @param {(obj) => any} spec.decode       the inverse of encode (JSON object → in-memory record)
 * @param {(owner, rec|null) => void} spec.install    put a loaded/merged record into the store's Map (null = absent)
 * @param {(ours, theirs) => object} spec.merge       deterministic merge of two encoded entries
 * @param {(obj) => number} spec.changedAt            when an encoded entry last changed (ms), for tombstone decisions
 * @param {() => void} [spec.reloadJson]   load the JSON file (used when `on` is refused at boot)
 * @param {string|null} [spec.mode]        override (tests); default from AQUA_STORE_PARTITIONS
 */
export function bindOwnerStore(spec) {
  const { storeKey, file, label = storeKey, section = 'o', schema = 1, encode, decode, install, merge, changedAt } = spec;
  let mode = spec.mode ?? parsePartitionModes().get(storeKey) ?? 'off';
  let reason = null;
  if (mode !== 'off' && !isConfigured()) { reason = `AQUA_STORE_PARTITIONS asked for ${mode} but DATABASE_URL is not set`; mode = 'off'; }

  const loaded = new Map();          // owner → version installed (0 = known absent/tombstoned)
  const dirty = new Set();
  const pendingDelete = new Map();   // owner → deletion time
  const backupPending = new Map();   // owner → encoded entry | null (for the rollback copy)
  const stats = { flushed: 0, writes: 0, unchanged: 0, merged: 0, deletes: 0, droppedStale: 0, failures: 0, retries: 0, loads: 0, installs: 0, notReady: 0, evictions: 0 };
  let lastError = null;
  let timer = null;
  let running = null;
  let retryDelay = 0;
  let backupWriter = null;

  const pk = owner => `${section}:${owner}`;
  const authoritative = () => mode === 'on' || mode === 'only';
  /**
   * The part of an entry that changed after `at` (a deletion). A store whose
   * entry holds individually-timed items supplies `pruneBefore`; without it the
   * entry is kept whole when it is newer than the deletion. null = nothing left.
   */
  const prune = (obj, at) => {
    if (typeof spec.pruneBefore !== 'function') return obj;
    const p = spec.pruneBefore(structuredClone(obj), at);
    return p ?? null;
  };

  // Bounded memory (authoritative modes only; a store with its own cap, like
  // reflection's MAX_OWNERS, passes no `evict`). Least-recently-used CLEAN
  // owners leave the store's Map; an owner with an unwritten change never does.
  const maxOwners = spec.maxOwners ?? (Number(process.env.AQUA_PARTITION_STORE_OWNERS) > 0 ? Number(process.env.AQUA_PARTITION_STORE_OWNERS) : 2_000);
  const recent = new Map();          // owner → true, in least-recently-used order
  function touch(owner) {
    if (!authoritative() || typeof spec.evict !== 'function') return;
    recent.delete(owner);
    recent.set(owner, true);
    if (recent.size <= maxOwners) return;
    for (const candidate of [...recent.keys()]) {
      if (recent.size <= maxOwners) break;
      if (candidate === owner || dirty.has(candidate) || pendingDelete.has(candidate)) continue;
      recent.delete(candidate);
      loaded.delete(candidate);
      spec.evict(candidate);
      stats.evictions++;
    }
  }

  function schedule(delay = FLUSH_DEBOUNCE_MS) {
    if (mode === 'off' || timer) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, delay);
    timer.unref?.();
  }

  async function backupFlush() {
    // The rollback copy: the JSON file as it is on disk, with each merged owner
    // replaced. Never the in-memory Map, which in `on` mode holds only the
    // owners this process has loaded.
    if (!backupWriter) {
      const { createDebouncedWriter } = await import('../atomicStore.js');
      backupWriter = createDebouncedWriter(file);
    }
    backupWriter.schedule(() => {
      let doc = null;
      try { doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { doc = null; }
      const isEnv = doc && typeof doc === 'object' && doc.__aqua && 'data' in doc;
      const data = (isEnv ? doc.data : doc) ?? {};
      for (const [owner, obj] of backupPending) { if (obj === null) delete data[owner]; else data[owner] = obj; }
      backupPending.clear();
      return JSON.stringify(isEnv
        ? { ...doc, __aqua: { ...doc.__aqua, savedAt: Date.now() }, data }
        : { __aqua: { schema, savedAt: Date.now() }, data });
    });
  }

  async function flushOwner(owner) {
    const del = pendingDelete.get(owner);
    pendingDelete.delete(owner);
    // A deleted owner that was used again afterwards (the user kept chatting)
    // has BOTH a pending deletion and a new local entry: `ours` is that entry.
    // Phase 3: the account was deleted — nothing of it may be written back
    // (a job or flush that was already in flight). Its deletion still lands.
    if (!del && await isOwnerDeleted(owner)) { stats.blockedDeletedOwner = (stats.blockedDeletedOwner ?? 0) + 1; return; }
    const encoded = encode(owner);
    const ours = encoded !== undefined && (!del || changedAt(encoded) > del) ? encoded : undefined;
    if (!del && ours === undefined) return;

    let result = null;           // the entry the partition holds afterwards (null = deleted/absent)
    let kind = 'write';
    const r = await getRepo().update(storeKey, pk(owner), (cur, meta) => {
      const theirs = cur ? JSON.parse(cur) : null;
      if (del) {
        // DATABASE ORDER (Phase 2c): our deletion commits AFTER whatever the row
        // holds now, so everything in it is pre-deletion and is retired — no
        // clock comparison across hosts. What survives is only what THIS process
        // re-created after its own deletion, judged on its own clock alone.
        if (ours === undefined) {
          result = null; kind = 'delete';
          return meta.deleted ? undefined : null;
        }
        const fresh = prune(ours, del);
        if (!fresh) { result = null; kind = 'delete'; return meta.deleted ? undefined : null; }
        result = fresh;
        kind = 'recreate';
        return JSON.stringify(result);
      }
      if (meta.deleted) {
        // Another process deleted this owner. If THIS process loaded that very
        // tombstone, everything it holds was created after the deletion: no
        // clock involved. Otherwise the deletion time (a DATABASE time) is
        // converted into this process's clock with the measured offset
        // (repository.clockOffsetMs, error ≤ half a round trip) — not by
        // assuming the hosts' clocks agree.
        if (loaded.get(owner) === meta.version) { result = ours; kind = 'recreate'; return JSON.stringify(ours); }
        const cut = (meta.deletedAt ?? 0) + getRepo().clockOffsetMs();
        if (changedAt(ours) <= cut) { result = null; kind = 'dropped-stale'; return undefined; }
        // Touched after the deletion — but a process that held the record from
        // BEFORE the deletion still carries the old items. Only items that
        // changed after the deletion are new information; the rest stay deleted.
        result = prune(ours, cut);
        if (result === null) { kind = 'dropped-stale'; return undefined; }
        kind = 'recreate';
        return JSON.stringify(result);
      }
      result = theirs ? merge(ours, theirs) : ours;
      kind = theirs ? 'merge' : 'write';
      const text = JSON.stringify(result);
      if (text === cur) { kind = 'unchanged'; return undefined; }
      return text;
    }, { ownerId: owner, maxAttempts: 20 });

    stats.flushed++;
    if (kind === 'unchanged' || !r.changed) stats.unchanged++;
    else if (kind === 'merge') stats.merged++;
    if (kind === 'delete') stats.deletes++;
    if (kind === 'dropped-stale') stats.droppedStale++;
    if (r.changed && kind !== 'delete') stats.writes++;

    if (authoritative()) {
      // Install what the partition now holds, unless the owner changed again
      // while we were writing (then the next flush merges that change too).
      if (!dirty.has(owner) && !pendingDelete.has(owner)) {
        if (result !== ours) { install(owner, result === null ? null : decode(result)); stats.installs++; }
        loaded.set(owner, r.version);
      }
      if (mode === 'on') { backupPending.set(owner, result); await backupFlush(); }
    }
  }

  async function flush() {
    while (running) await running;
    if (!dirty.size) return;
    running = (async () => {
      const owners = [...dirty];
      dirty.clear();
      const failed = [];
      for (const owner of owners) {
        const del = pendingDelete.get(owner);
        try {
          await flushOwner(owner);
        } catch (err) {
          stats.failures++;
          lastError = errorText(err);
          failed.push([owner, del]);
        }
      }
      if (failed.length) {
        // Keep them dirty and retry with a capped backoff. Loud, once per batch.
        for (const [owner, del] of failed) { dirty.add(owner); if (del) pendingDelete.set(owner, del); }
        retryDelay = Math.min(RETRY_CAP_MS, Math.max(500, retryDelay * 2));
        stats.retries++;
        console.error(`[STORE] ${label} partition flush failed for ${failed.length} owner(s) (${mode}), retry in ${retryDelay}ms: ${lastError}`);
        schedule(retryDelay);
      } else {
        retryDelay = 0;
      }
    })();
    try { await running; } finally { running = null; }
    if (dirty.size && !timer) schedule();
  }

  /**
   * Phase 4A — write ONLY these owners now (a request's own writes), not every
   * dirty owner of the process. Serialized with the background flush. A
   * failure keeps the owner dirty (retried in the background) and is reported
   * by pendingAmong().
   */
  async function flushOnly(owners) {
    while (running) await running;
    const mine = [...owners].filter(o => dirty.has(o));
    if (!mine.length) return;
    running = (async () => {
      for (const owner of mine) {
        const del = pendingDelete.get(owner);
        dirty.delete(owner);
        try { await flushOwner(owner); }
        catch (err) {
          stats.failures++; lastError = errorText(err);
          dirty.add(owner); if (del) pendingDelete.set(owner, del);
          schedule(Math.max(500, retryDelay));
        }
      }
    })();
    try { await running; } finally { running = null; }
  }

  const binding = {
    storeKey, label,
    flushOnly,
    pendingAmong: owners => [...owners].filter(o => dirty.has(o) || pendingDelete.has(o)).length,
    get mode() { return mode; },
    get reason() { return reason; },
    pk,
    authoritative,
    /** Load the JSON file at boot? */
    loadsJsonAtBoot: () => mode === 'off' || mode === 'shadow',
    /** Write the whole JSON file from the Map, as today? */
    writesWholeJson: () => mode === 'off' || mode === 'shadow',
    /** May this owner's entry be trusted as complete? Always, unless partitions are authoritative and it is not loaded. */
    ready(owner) {
      if (!authoritative()) return true;
      // Loaded only. A dirty owner that was never loaded holds a PARTIAL local
      // record (e.g. a watermark set before any load); it is not the whole entry.
      const ok = loaded.has(owner);
      if (!ok) stats.notReady++;
      return ok;
    },
    isDirty: owner => dirty.has(owner) || pendingDelete.has(owner),
    /** Loaded in this process (and not evicted since)? The fast path requires it of every store. */
    isLoaded: owner => loaded.has(owner),
    markDirty(owner) {
      if (mode === 'off' || owner == null) return;
      // A pending deletion is KEPT: the flush must still retire the old data
      // before writing the re-created entry (see flushOwner).
      dirty.add(owner);
      noteWrite(binding, owner);   // Phase 4A: the request's durable write boundary
      touch(owner);
      schedule();
    },
    markDeleted(owner, at = Date.now()) {
      if (mode === 'off' || owner == null) return;
      pendingDelete.set(owner, at);
      dirty.add(owner);
      noteWrite(binding, owner);
      schedule();
    },
    /** The store dropped this owner from its Map (eviction). It must be reloaded before it is ready again. */
    evicted(owner) { if (!dirty.has(owner) && !pendingDelete.has(owner)) loaded.delete(owner); },
    /** Apply one row from a unit-of-work load. */
    applyRow(owner, row) {
      if (!authoritative()) return;
      if (dirty.has(owner) || pendingDelete.has(owner)) return;   // local changes win until merged by the flush
      const v = row?.version ?? 0;
      touch(owner);
      if (loaded.get(owner) === v) return;
      // Changed between the version query and the data fetch: do not install
      // "absent"; leave it unloaded so the next unit of work fetches it.
      if (row?._unfetched) { loaded.delete(owner); return; }
      install(owner, row && !row.deleted && row.data != null ? decode(JSON.parse(row.data)) : null);
      loaded.set(owner, v);
      stats.installs++;
    },
    /** Which partitions of this owner must be fetched (version not held here). */
    wanted(owner, versions) {
      if (!authoritative() || dirty.has(owner) || pendingDelete.has(owner)) return [];
      const v = versions.get(pk(owner));
      if (!v || v.deleted || loaded.get(owner) === v.version) return [];
      return [pk(owner)];
    },
    /** Apply a two-step load: `versions` for every row, `rows` with data for the wanted ones. */
    applyOwner(owner, versions, rows) {
      const v = versions.get(pk(owner));
      if (!v) return binding.applyRow(owner, undefined);
      if (v.deleted) return binding.applyRow(owner, { version: v.version, deleted: true, data: null });
      const row = rows.get(pk(owner));
      return binding.applyRow(owner, { version: v.version, deleted: false, data: row?.data ?? null, _unfetched: !row });
    },
    flush,
    pendingCount: () => dirty.size,
    async configure() {
      if (!authoritative()) return;
      try {
        if (await getRepo().hasAny(storeKey)) return;
        let hasJson = false;
        try { hasJson = fs.existsSync(file) && fs.statSync(file).size > 0; } catch { hasJson = false; }
        if (hasJson) {
          reason = `refused ${mode}: no partition rows for ${storeKey} but its JSON file has data — migrate it first`;
          mode = 'off';
          spec.reloadJson?.();
        }
      } catch (err) {
        // Database unreachable at boot. Stay authoritative (falling back to a JSON
        // file that may be stale would be a silent rollback); owners are not ready.
        reason = `partitions unreachable at boot: ${errorText(err)}`;
        console.error(`[STORE] ${label}: ${reason}`);
      }
    },
    status() {
      return { store: storeKey, mode, reason, loadedOwners: loaded.size, pending: dirty.size, lastError, ...stats };
    },
    /** Tests only. */
    _reset() { recent.clear(); loaded.clear(); dirty.clear(); pendingDelete.clear(); backupPending.clear(); if (timer) clearTimeout(timer); timer = null; lastError = null; for (const k of Object.keys(stats)) stats[k] = 0; },
  };
  registry.set(storeKey, binding);
  return binding;
}

/** Is any store authoritative on partitions? (Callers skip the per-request load otherwise.) */
export function anyAuthoritative() {
  for (const b of registry.values()) if (b.authoritative()) return true;
  return false;
}

/**
 * The unit-of-work load: every authoritative store's entry for this owner, in
 * ONE query, installed into the stores. Throws if the database cannot answer —
 * the caller decides (the worker fails the job so it retries; the router logs
 * and continues with the owner NOT READY).
 */
/** owner → the change counter (migration 0027) this process last fully loaded at. Bounded. */
const ownerSeen = new Map();
const OWNER_SEEN_MAX = 20_000;

export async function ensureOwnerLoaded(ownerId) {
  if (!ownerId) return { stores: 0, fetched: 0 };
  const active = [...registry.values()].filter(b => b.authoritative());
  if (!active.length) return { stores: 0, fetched: 0 };
  const owner = String(ownerId);
  const r = getRepo();
  // 0. Phase 2c fast path: one primary-key lookup. The counter is bumped by a
  //    database trigger on ANY write of this owner's rows (every instance, every
  //    tool), so "unchanged" here means unchanged everywhere. Read BEFORE the
  //    versions query: a write landing in between bumps it past what we record.
  let counter = 0;
  try { counter = await r.ownerVersion(owner); } catch { counter = 0; }   // no table yet → always the full path
  if (counter && ownerSeen.get(owner) === counter && active.every(b => b.isLoaded(owner))) {
    return { stores: active.length, fetched: 0, unchanged: true };
  }
  // 1. Versions only, every bound store, one indexed query.
  const versions = await r.ownerVersions(owner, active.map(b => b.storeKey));
  // 2. Data only for partitions whose version this process does not hold.
  let fetched = 0;
  for (const b of active) {
    const v = versions.get(b.storeKey) ?? new Map();
    const want = b.wanted(owner, v);
    const rows = want.length ? await r.getMany(b.storeKey, want) : new Map();
    fetched += rows.size;
    b.applyOwner(owner, v, rows);
  }
  if (counter) {
    ownerSeen.delete(owner);
    ownerSeen.set(owner, counter);
    if (ownerSeen.size > OWNER_SEEN_MAX) ownerSeen.delete(ownerSeen.keys().next().value);
  }
  return { stores: active.length, fetched };
}

/** Tests: forget every owner's fast-path counter. */
export function _resetOwnerSeenForTests() { ownerSeen.clear(); }

/**
 * Register a store binding that is not a single per-owner entry (the
 * conversation store's message rows). It must provide: storeKey, label, mode,
 * reason, authoritative(), wanted(owner, versions), applyOwner(owner, versions,
 * rows), flush(), configure(), status().
 */
export function registerPartitionBinding(binding) {
  registry.set(binding.storeKey, binding);
  return binding;
}

// ── Owner resolution for keys that are not owners (Phase 2c) ─────────────────
// A vector namespace "ws:<id>" belongs to the workspace's owner, but the vector
// store sits below the project module and must not import it. The project
// module registers a resolver here instead.
const ownerResolvers = new Map();   // prefix → (rest) => owner | null
export function registerOwnerResolver(prefix, fn) { ownerResolvers.set(prefix, fn); }

/** Owner of a namespace-style key: "<owner>", "files:<owner>", "recall:<owner>", "canonical-claims:<owner>", or a registered prefix. */
export function namespaceOwner(key) {
  const k = String(key);
  for (const [p, fn] of ownerResolvers) if (k.startsWith(p)) return fn(k.slice(p.length)) ?? null;
  // 'xfiles:' — Phase 1a.2 external-resource chunks (embeddings/fileMemory.js externalFileNamespace).
  for (const p of ['files:', 'xfiles:', 'recall:', 'canonical-claims:']) if (k.startsWith(p)) return k.slice(p.length);
  return k;
}

/** Shared by bindings registered from other modules (they do not import the pool themselves). */
export { getRepo as partitionRepositoryForBindings, isConfigured as partitionsDatabaseConfigured };

/** Boot: apply the safety rules that need the database. */
export async function configureOwnerBindings() {
  for (const b of registry.values()) await b.configure();
  return [...registry.values()].map(b => b.status());
}

/** SIGTERM / tests: write every dirty owner of every bound store, bounded. */
export async function flushOwnerBindings(timeoutMs = 5_000) {
  const all = Promise.all([...registry.values()].map(b => b.flush()));
  return Promise.race([all.then(() => 'flushed'), new Promise(r => setTimeout(() => r('timeout'), timeoutMs).unref?.())]);
}

/**
 * Phase 3 — a worker acknowledges a job only after what it wrote is in the
 * database. Flushes every binding and THROWS if anything is still pending (a
 * failed or timed-out write): the job is then retried, never marked done with
 * its result still in memory. Conservative: a pending write of another owner
 * also fails it (the retry is idempotent).
 */
export async function flushOwnerBindingsStrict(timeoutMs = 15_000) {
  const outcome = await flushOwnerBindings(timeoutMs);
  const pending = [...registry.values()].filter(b => b.authoritative() && (b.pendingCount?.() ?? 0) > 0)
    .map(b => `${b.label ?? b.storeKey}=${b.pendingCount()}`);
  if (outcome !== 'flushed' || pending.length) {
    throw Object.assign(new Error(`partition flush incomplete (${outcome}${pending.length ? `; pending ${pending.join(',')}` : ''})`),
      { code: 'FLUSH_INCOMPLETE' });
  }
  return outcome;
}

/** Is this store (by key) authoritative on partitions here? */
export function storeAuthoritative(storeKey) { return Boolean(registry.get(storeKey)?.authoritative()); }

export function ownerBindingStatus() { return [...registry.values()].map(b => b.status()); }

export function ownerBindingBootLine() {
  const active = [...registry.values()].filter(b => b.mode !== 'off' || b.reason);
  if (!active.length) return '[STORE] partitions=off';
  return `[STORE] partitions: ${active.map(b => `${b.label}=${b.mode}${b.reason ? ` (${b.reason})` : ''}`).join('; ')}`;
}

export function _bindingsForTests() { return registry; }
