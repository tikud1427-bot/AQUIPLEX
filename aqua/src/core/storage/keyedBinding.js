/**
 * AQUA Storage — keyed bindings with three-way merge (scalability Phase 2c)
 *
 * The Phase 2b `ownerBinding` persists ONE entry per owner and merges with a
 * store-specific function. The remaining stores need more:
 *
 *   · entries keyed by something other than the owner (an attachment list per
 *     CONVERSATION, a workspace, a vector namespace, an artifact) whose owner is
 *     resolved from the data (`ownerOf`);
 *   · several entries per owner, loaded together by the owner's unit of work;
 *   · a three-way merge (core/storage/entryMerge.js) against the BASE — the
 *     entry as this process last loaded or wrote it — so deletions and edits
 *     are attributed exactly, without tombstones per item or clocks.
 *
 * Same modes, flag, lifecycle and safety rules as ownerBinding (see its header):
 * AQUA_STORE_PARTITIONS=<store>:<off|shadow|on|only>, registered in the same
 * registry, loaded by ensureOwnerLoaded, flushed on SIGTERM.
 *
 * Deletion of a whole entry:
 *   pending local delete  → DATABASE ORDER: whatever the row holds is retired;
 *                           only what this process re-created after its own
 *                           delete survives (its own clock alone).
 *   deleted elsewhere     → with a base: three-way against an EMPTY entry, so
 *                           what this process did not change since its base is
 *                           gone and what it changed survives. Without a base:
 *                           the deletion's database time, converted with the
 *                           measured clock offset.
 */
import fs from 'node:fs';

import {
  parsePartitionModes, registerPartitionBinding, partitionRepositoryForBindings, partitionsDatabaseConfigured,
} from './ownerBinding.js';
import { mergeEntry } from './entryMerge.js';
import { isOwnerDeleted } from './deletedOwners.js';
import { noteWrite } from './requestWrites.js';
import { errorText } from '../errorText.js';

const FLUSH_DEBOUNCE_MS = 250;
const RETRY_CAP_MS = 30_000;

/**
 * @param {object} spec
 * @param {string} spec.storeKey
 * @param {string} spec.file                  JSON file (rollback copy in `on` mode)
 * @param {string} [spec.label]
 * @param {string} [spec.section]             partition section; key → '<section>:<key>' (match partitionLayout)
 * @param {string[]} [spec.jsonPath]          where the keyed map sits inside the file's data (uko: ['owners'])
 * @param {number} [spec.schema]
 * @param {object} spec.mergeSchema           entryMerge schema
 * @param {() => any} [spec.empty]            an empty entry (deleted-elsewhere three-way)
 * @param {(key, encoded) => string|null} [spec.ownerOf]  owner of an entry; default: the key itself
 * @param {(key) => any} spec.encode           entry as the JSON file holds it; undefined = absent
 * @param {(obj, key) => any} spec.decode
 * @param {(key, rec|null) => void} spec.install
 * @param {(key) => void} [spec.evict]
 * @param {(obj) => number} [spec.changedAt]
 * @param {() => void} [spec.reloadJson]
 */
export function bindKeyedStore(spec) {
  const { storeKey, file, label = storeKey, section = 'o', jsonPath = [], schema = 1, mergeSchema = {} } = spec;
  let mode = spec.mode ?? parsePartitionModes().get(storeKey) ?? 'off';
  let reason = null;
  if (mode !== 'off' && !partitionsDatabaseConfigured()) { reason = `AQUA_STORE_PARTITIONS asked for ${mode} but DATABASE_URL is not set`; mode = 'off'; }
  const repo = () => partitionRepositoryForBindings();
  const authoritative = () => mode === 'on' || mode === 'only';
  const ownerOf = (key, enc) => (spec.ownerOf ? spec.ownerOf(key, enc) : String(key));
  const changedAt = spec.changedAt ?? (() => 0);
  const prefix = `${section}:`;
  const pk = key => `${prefix}${key}`;

  const loadedVersion = new Map();   // key → version installed (0 = known absent)
  const base = new Map();            // key → stable JSON of the entry as last loaded/written (the three-way base)
  const keyOwner = new Map();        // key → owner
  const ownerKeys = new Map();       // owner → Set<key>
  const loadedOwners = new Map();    // owner → true (LRU order)
  const dirty = new Set();
  const pendingDelete = new Map();   // key → local deletion time
  const backupPending = new Map();
  const maxOwners = Number(process.env.AQUA_PARTITION_STORE_OWNERS) > 0 ? Number(process.env.AQUA_PARTITION_STORE_OWNERS) : 2_000;
  const stats = { flushed: 0, writes: 0, unchanged: 0, merged: 0, deletes: 0, droppedStale: 0, unowned: 0, failures: 0, retries: 0, installs: 0, evictions: 0, notReady: 0 };
  let lastError = null; let timer = null; let running = null; let retryDelay = 0; let backupWriter = null;

  const noteOwner = (key, owner) => {
    if (!owner) return;
    const prev = keyOwner.get(key);
    if (prev && prev !== owner) ownerKeys.get(prev)?.delete(key);
    keyOwner.set(key, owner);
    if (!ownerKeys.has(owner)) ownerKeys.set(owner, new Set());
    ownerKeys.get(owner).add(key);
  };
  const baseOf = key => (base.has(key) ? JSON.parse(base.get(key)) : undefined);

  function schedule(delay = FLUSH_DEBOUNCE_MS) {
    if (mode === 'off' || timer) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, delay);
    timer.unref?.();
  }

  function touchOwner(owner) {
    loadedOwners.delete(owner);
    loadedOwners.set(owner, true);
    if (loadedOwners.size <= maxOwners || typeof spec.evict !== 'function') return;
    for (const candidate of [...loadedOwners.keys()]) {
      if (loadedOwners.size <= maxOwners) break;
      const keys = [...(ownerKeys.get(candidate) ?? [])];
      if (candidate === owner || keys.some(k => dirty.has(k) || pendingDelete.has(k))) continue;
      loadedOwners.delete(candidate);
      for (const k of keys) { spec.evict(k); loadedVersion.delete(k); base.delete(k); keyOwner.delete(k); }
      ownerKeys.delete(candidate);
      stats.evictions++;
    }
  }

  async function backupFlush() {
    if (mode !== 'on' || !backupPending.size) return;
    if (!backupWriter) {
      const { createDebouncedWriter } = await import('../atomicStore.js');
      backupWriter = createDebouncedWriter(file);
    }
    backupWriter.schedule(() => {
      let doc = null;
      try { doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { doc = null; }
      const isEnv = doc && typeof doc === 'object' && doc.__aqua && 'data' in doc;
      const data = (isEnv ? doc.data : doc) ?? {};
      let target = data;
      for (const p of jsonPath) target = (target[p] ??= {});
      for (const [key, obj] of backupPending) { if (obj === null) delete target[key]; else target[key] = obj; }
      backupPending.clear();
      if (isEnv) return JSON.stringify({ ...doc, __aqua: { ...doc.__aqua, savedAt: Date.now() }, data });
      // A bare-map store (vectors, projects, index, artifacts) stays bare: its
      // loader reads the file as the map itself.
      if (doc || spec.envelope === false) return JSON.stringify(data);
      return JSON.stringify({ __aqua: { schema, savedAt: Date.now() }, data });
    });
  }

  async function flushKey(key) {
    const del = pendingDelete.get(key);
    pendingDelete.delete(key);
    // A deleted entry left the store's Map at deletion time, so an entry present
    // now was re-created by this process AFTER its own delete.
    const ours = spec.encode(key);
    const encoded = ours;
    if (!del && ours === undefined) return;
    // Nothing changed here since the base (a read that marked the owner dirty):
    // no database round trip. A remote change is picked up by the next load.
    if (!del && base.has(key) && base.get(key) === JSON.stringify(ours)) { stats.unchanged++; return; }
    const owner = keyOwner.get(key) ?? ownerOf(key, encoded);
    if (!owner) { stats.unowned++; return; }      // not owner data we can place: left to the JSON path
    // Phase 3: a deleted account's data is never written back; its deletion still lands.
    if (!del && await isOwnerDeleted(owner)) { stats.blockedDeletedOwner = (stats.blockedDeletedOwner ?? 0) + 1; return; }
    noteOwner(key, owner);
    const b = baseOf(key);

    let result = null; let kind = 'write';
    const r = await repo().update(storeKey, pk(key), (cur, meta) => {
      const theirs = cur ? JSON.parse(cur) : null;
      if (del) {
        if (ours === undefined) { result = null; kind = 'delete'; return meta.deleted ? undefined : null; }
        result = ours; kind = 'recreate';              // re-created by THIS process after its own delete
        return JSON.stringify(ours);
      }
      if (meta.deleted) {
        if (loadedVersion.get(key) === meta.version) { result = ours; kind = 'recreate'; return JSON.stringify(ours); }
        if (b !== undefined) {
          // Deleted elsewhere after our base: what we did not change is gone; what we changed survives.
          const kept = mergeEntry(ours, spec.empty ? spec.empty() : {}, b, mergeSchema);
          const empty = kept == null || (Array.isArray(kept) ? !kept.length : !Object.keys(kept).length);
          if (empty) { result = null; kind = 'dropped-stale'; return undefined; }
          result = kept; kind = 'recreate';
          return JSON.stringify(kept);
        }
        const cut = (meta.deletedAt ?? 0) + repo().clockOffsetMs();
        if (changedAt(ours) <= cut) { result = null; kind = 'dropped-stale'; return undefined; }
        result = ours; kind = 'recreate';
        return JSON.stringify(ours);
      }
      result = theirs ? mergeEntry(ours, theirs, b, mergeSchema) : ours;
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

    // The base moves to what the partition now holds.
    if (result === null) base.delete(key); else base.set(key, JSON.stringify(result));
    if (authoritative()) {
      if (!dirty.has(key) && !pendingDelete.has(key)) {
        if (result !== ours) { spec.install(key, result === null ? null : spec.decode(result, key)); stats.installs++; }
        loadedVersion.set(key, r.version);
      }
      if (mode === 'on') { backupPending.set(key, result); await backupFlush(); }
    }
  }

  async function flush() {
    while (running) await running;
    if (!dirty.size) return;
    running = (async () => {
      const keys = [...dirty];
      dirty.clear();
      const failed = [];
      for (const key of keys) {
        const del = pendingDelete.get(key);
        try { await flushKey(key); } catch (err) { stats.failures++; lastError = errorText(err); failed.push([key, del]); }
      }
      if (failed.length) {
        for (const [key, del] of failed) { dirty.add(key); if (del) pendingDelete.set(key, del); }
        retryDelay = Math.min(RETRY_CAP_MS, Math.max(500, retryDelay * 2));
        stats.retries++;
        console.error(`[STORE] ${label} partition flush failed for ${failed.length} entr(ies) (${mode}), retry in ${retryDelay}ms: ${lastError}`);
        schedule(retryDelay);
      } else retryDelay = 0;
    })();
    try { await running; } finally { running = null; }
    if (dirty.size && !timer) schedule();
  }

  /** Phase 4A — write ONLY these keys now (a request's own writes). See ownerBinding.flushOnly. */
  async function flushOnly(keys) {
    while (running) await running;
    const mine = [...keys].filter(k => dirty.has(k));
    if (!mine.length) return;
    running = (async () => {
      for (const key of mine) {
        const del = pendingDelete.get(key);
        dirty.delete(key);
        try { await flushKey(key); }
        catch (err) {
          stats.failures++; lastError = errorText(err);
          dirty.add(key); if (del) pendingDelete.set(key, del);
          schedule(Math.max(500, retryDelay));
        }
      }
    })();
    try { await running; } finally { running = null; }
  }

  const binding = {
    storeKey, label,
    flushOnly,
    pendingAmong: keys => [...keys].filter(k => dirty.has(k) || pendingDelete.has(k)).length,
    get mode() { return mode; },
    get reason() { return reason; },
    authoritative,
    loadsJsonAtBoot: () => mode === 'off' || mode === 'shadow',
    writesWholeJson: () => mode === 'off' || mode === 'shadow',
    /** Is this owner's data loaded (partitions authoritative)? */
    ready(owner) {
      if (!authoritative()) return true;
      const ok = loadedOwners.has(String(owner));
      if (!ok) stats.notReady++;
      return ok;
    },
    /** Is this entry's state known (its owner loaded, or the entry itself loaded/written here)? */
    readyKey(key) {
      if (!authoritative()) return true;
      const owner = keyOwner.get(key);
      return loadedVersion.has(key) || (owner != null && loadedOwners.has(owner));
    },
    isLoaded: owner => loadedOwners.has(String(owner)),
    isDirty: key => dirty.has(key) || pendingDelete.has(key),
    markDirty(key) {
      if (mode === 'off' || key == null) return;
      dirty.add(key);
      noteWrite(binding, key);   // Phase 4A: the request's durable write boundary
      schedule();
    },
    markDeleted(key, at = Date.now()) {
      if (mode === 'off' || key == null) return;
      pendingDelete.set(key, at);
      dirty.add(key);
      noteWrite(binding, key);
      schedule();
    },
    /** Tell the binding an entry's owner before it is first written (e.g. from route context). */
    noteOwner,
    /**
     * Write ONE entry NOW, version-checked, re-running `mutate(current|null,
     * meta)` on the newest row after a conflict. For operations that must
     * allocate something unique from the current state (an artifact's next
     * version number) — the debounced merge cannot do that. Returns the entry
     * now stored (null = deleted) and installs it.
     */
    async commit(key, mutate, { ownerId } = {}) {
      const owner = ownerId ?? keyOwner.get(key) ?? ownerOf(key, spec.encode(key));
      if (!owner) throw new Error(`${label}: no owner for ${key}`);
      noteOwner(key, owner);
      let result = null;
      const r = await repo().update(storeKey, pk(key), (cur, meta) => {
        const current = cur && !meta.deleted ? JSON.parse(cur) : null;
        const next = mutate(current, meta);
        if (next === undefined) { result = current; return undefined; }
        result = next;
        return next === null ? null : JSON.stringify(next);
      }, { ownerId: owner, maxAttempts: 20 });
      if (result === null) base.delete(key); else base.set(key, JSON.stringify(result));
      loadedVersion.set(key, r.version);
      spec.install(key, result === null ? null : spec.decode(result, key));
      if (mode === 'on') { backupPending.set(key, result); await backupFlush(); }
      return result;
    },
    wanted(owner, versions) {
      if (!authoritative()) return [];
      const want = [];
      for (const [p, v] of versions) {
        if (!p.startsWith(prefix) || v.deleted) continue;
        const key = p.slice(prefix.length);
        if (dirty.has(key) || pendingDelete.has(key)) continue;
        if (loadedVersion.get(key) !== v.version) want.push(p);
      }
      return want;
    },
    applyOwner(owner, versions, rows) {
      if (!authoritative()) return;
      const seen = new Set();
      for (const [p, v] of versions) {
        if (!p.startsWith(prefix)) continue;
        const key = p.slice(prefix.length);
        seen.add(key);
        noteOwner(key, owner);
        if (dirty.has(key) || pendingDelete.has(key)) continue;
        if (loadedVersion.get(key) === v.version) continue;
        if (v.deleted) { spec.install(key, null); base.delete(key); loadedVersion.set(key, v.version); stats.installs++; continue; }
        const row = rows.get(p);
        if (!row) { loadedVersion.delete(key); continue; }     // changed between the two queries: next unit of work
        const obj = JSON.parse(row.data);
        spec.install(key, spec.decode(obj, key));
        base.set(key, row.data);
        loadedVersion.set(key, v.version);
        stats.installs++;
      }
      // Entries of this owner held here that the database no longer has at all.
      for (const key of [...(ownerKeys.get(owner) ?? [])]) {
        if (seen.has(key) || dirty.has(key) || pendingDelete.has(key) || !loadedVersion.get(key)) continue;
        spec.install(key, null); base.delete(key); loadedVersion.delete(key);
      }
      touchOwner(owner);
    },
    flush,
    pendingCount: () => dirty.size,
    async configure() {
      if (!authoritative()) return;
      try {
        if (await repo().hasAny(storeKey)) return;
        let hasJson = false;
        try { hasJson = fs.existsSync(file) && fs.statSync(file).size > 0; } catch { hasJson = false; }
        if (hasJson) {
          reason = `refused ${mode}: no partition rows for ${storeKey} but its JSON file has data — migrate it first`;
          mode = 'off';
          spec.reloadJson?.();
        }
      } catch (err) {
        reason = `partitions unreachable at boot: ${errorText(err)}`;
        console.error(`[STORE] ${label}: ${reason}`);
      }
    },
    status: () => ({ store: storeKey, mode, reason, loadedOwners: loadedOwners.size, entries: loadedVersion.size, pending: dirty.size, lastError, ...stats }),
    _reset() {
      loadedVersion.clear(); base.clear(); keyOwner.clear(); ownerKeys.clear(); loadedOwners.clear(); dirty.clear(); pendingDelete.clear(); backupPending.clear();
      if (timer) clearTimeout(timer); timer = null; lastError = null; for (const k of Object.keys(stats)) stats[k] = 0;
    },
  };
  return registerPartitionBinding(binding);
}
