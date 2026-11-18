/**
 * AQUA PIC Store — Persistent Intelligence Core (Phase 4)
 *
 * The ONE persistence surface for PIC META-STATE. This store never holds
 * knowledge itself — facts live in evidenceStore, objects in ukoStore, the
 * graph in reasoningGraph, memories in memory/. The PIC's critical
 * requirement ("never duplicate data, never create parallel memory systems,
 * never create competing knowledge stores") is enforced structurally: this
 * file persists only what NO existing store owns —
 *
 *   lifecycle  Map<subject, { state, transitions[], meta }>   subject = 'uko:<id>' | 'fact:<id>' | 'entity:<id>'
 *   versions   Map<subject, revisions[]>                      compact before/after deltas, never full copies
 *   signals    Map<factId, { ok, bad, lastAt }>               reasoning-feedback aggregates
 *   sessions   ring of reasoning sessions                     what reasoning used, and whether it held up
 *   ledger     ring of intelligence operations                consolidation / maintenance / ingest events
 *
 * Every entry REFERENCES knowledge by id. Deleting this file loses history
 * and feedback, never knowledge — the PIC degrades to Phase-3 behavior.
 *
 * Same primitives as every AQUA store: atomicStore debounced writer +
 * dataDir + the free Mongo mirror, per-owner buckets, bounded everywhere,
 * schema-versioned, `_reset` for tests.
 */
import {
  createDebouncedWriter, loadJsonFile, wrapStore, unwrapStore,
} from '../core/atomicStore.js';
import { dataPath } from '../core/dataDir.js';
import { bindKeyedStore } from '../core/storage/keyedBinding.js';

const STORE_FILE = dataPath('.aqua-pic.json');
const SCHEMA     = 1;

export const MAX_SUBJECTS_PER_OWNER   = 20_000;
export const MAX_TRANSITIONS_PER_SUBJ = 30;
export const MAX_REVISIONS_PER_SUBJ   = 20;
export const MAX_SESSIONS_PER_OWNER   = 500;
export const MAX_LEDGER_PER_OWNER     = 300;
export const MAX_SIGNALS_PER_OWNER    = 10_000;

/** ownerKey → bucket */
const store = new Map();

// Owners whose bucket was handed out since the last save. Callers mutate the
// bucket and then call schedulePicSave() with no owner; these are the owners
// that save may concern (an untouched one is skipped against its base).
const touched = new Set();

export function picBucket(ownerId) {
  const key = ownerId ?? 'anon';
  touched.add(key);
  let b = store.get(key);
  if (!b) {
    b = {
      lifecycle: new Map(),   // subject → { state, transitions:[{to,at,reason}], meta:{retrievals,reasonings,...} }
      versions:  new Map(),   // subject → [{ rev, at, kind, before, after, reason, actor }]
      signals:   new Map(),   // factId  → { ok, bad, lastAt }
      sessions:  [],          // [{ at, requestId, query, outcome, usedFacts, usedEntities, confidence }]
      ledger:    [],          // [{ at, op, detail }]
    };
    store.set(key, b);
  }
  return b;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function loadFromDisk() {
  const parsed = loadJsonFile(STORE_FILE, { label: 'pic' });
  if (parsed == null) return;
  const { data } = unwrapStore(parsed, { expected: SCHEMA, file: STORE_FILE, label: 'pic' });
  if (!data || typeof data !== 'object') return;
  for (const [owner, b] of Object.entries(data)) {
    const bk = picBucket(owner);
    for (const [s, rec]  of Object.entries(b.lifecycle ?? {})) bk.lifecycle.set(s, rec);
    for (const [s, revs] of Object.entries(b.versions  ?? {})) bk.versions.set(s, revs);
    for (const [f, sig]  of Object.entries(b.signals   ?? {})) bk.signals.set(f, sig);
    bk.sessions = Array.isArray(b.sessions) ? b.sessions : [];
    bk.ledger   = Array.isArray(b.ledger)   ? b.ledger   : [];
  }
  const subjects = [...store.values()].reduce((n, b) => n + b.lifecycle.size, 0);
  if (subjects) console.log(`[PIC] Store loaded: ${subjects} lifecycle subject(s) across ${store.size} owner(s) from ${STORE_FILE}`);
}

const _writer = createDebouncedWriter(STORE_FILE);
const encodeBucket = b => ({
  lifecycle: Object.fromEntries(b.lifecycle),
  versions:  Object.fromEntries(b.versions),
  signals:   Object.fromEntries(b.signals),
  sessions:  b.sessions,
  ledger:    b.ledger,
});

export function schedulePicSave() {
  for (const owner of touched) binding.markDirty(owner);
  touched.clear();
  if (!binding.writesWholeJson()) return;
  _writer.schedule(() => {
    const data = {};
    for (const [owner, b] of store.entries()) data[owner] = encodeBucket(b);
    return JSON.stringify(wrapStore(SCHEMA, data));
  });
}

// ── Per-owner persistence (scalability Phase 2c) ─────────────────────────────
// WRITER: the server only (post-turn consolidation, lifecycle transitions,
// reasoning feedback, version history, ledger); concurrent across API instances.
// MERGE (three-way against the last-synced base, core/storage/entryMerge.js):
//   lifecycle  per subject; on a double change the record with the later
//              transition wins
//   versions   per subject: revision history UNIONED by (rev, at), capped
//   signals    per fact: ok/bad are COUNTERS — both sides' increments kept
//              (theirs + ours − base), lastAt the later
//   sessions,
//   ledger     logs unioned by identity, time-ordered, capped as today
// DELETION: purgeOwner → row tombstone.
const lifecycleTime = r => Math.max(Number(r?.updatedAt) || 0, ...(r?.transitions ?? []).map(t => Number(t?.at) || 0), 0);
const binding = bindKeyedStore({
  storeKey: '.aqua-pic.json', file: STORE_FILE, label: 'pic', schema: SCHEMA,
  mergeSchema: {
    collections: {
      lifecycle: { time: lifecycleTime },
      signals: { time: s => Number(s?.lastAt) || 0, counters: ['ok', 'bad'] },
    },
    logMaps: { versions: { id: v => `${v?.rev}:${v?.at}`, time: v => Number(v?.at) || 0, cap: MAX_REVISIONS_PER_SUBJ } },
    logs: {
      sessions: { id: x => `${x?.at}:${x?.requestId ?? ''}:${x?.query ?? ''}`, time: x => Number(x?.at) || 0, cap: MAX_SESSIONS_PER_OWNER },
      ledger: { time: x => Number(x?.at) || 0, cap: MAX_LEDGER_PER_OWNER },
    },
  },
  encode: owner => (store.has(owner) ? encodeBucket(store.get(owner)) : undefined),
  decode: obj => ({
    lifecycle: new Map(Object.entries(obj?.lifecycle ?? {})),
    versions:  new Map(Object.entries(obj?.versions ?? {})),
    signals:   new Map(Object.entries(obj?.signals ?? {})),
    sessions:  Array.isArray(obj?.sessions) ? obj.sessions : [],
    ledger:    Array.isArray(obj?.ledger) ? obj.ledger : [],
  }),
  install: (owner, b) => { if (b) store.set(owner, b); else store.delete(owner); },
  evict: owner => store.delete(owner),
  changedAt: obj => Math.max(0, ...Object.values(obj?.lifecycle ?? {}).map(lifecycleTime),
    ...Object.values(obj?.signals ?? {}).map(s => Number(s?.lastAt) || 0), ...(obj?.ledger ?? []).map(x => Number(x?.at) || 0)),
  reloadJson: () => loadFromDisk(),
});
export function picPartitionBinding() { return binding; }

if (binding.loadsJsonAtBoot()) { loadFromDisk(); touched.clear(); }

// ── Bounded push helpers (eviction policy identical everywhere: oldest-first) ─

export function pushBounded(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
  return item;
}

export function boundMap(map, max) {
  // FIFO on insertion order — same policy as ukoStore's content cache.
  while (map.size > max) map.delete(map.keys().next().value);
}

/** Append an intelligence-operation ledger entry (observability trail). */
export function ledger(ownerId, op, detail = {}) {
  const b = picBucket(ownerId);
  const entry = { at: Date.now(), op, ...detail };
  pushBounded(b.ledger, entry, MAX_LEDGER_PER_OWNER);
  schedulePicSave();
  return entry;
}

export function getLedger(ownerId, { limit = 50 } = {}) {
  return picBucket(ownerId).ledger.slice(-limit);
}

/**
 * Account deletion — drop an owner's whole PIC bucket (lifecycle, versions,
 * signals, sessions, ledger). Returns the number of lifecycle subjects removed.
 */
export function purgeOwner(ownerId) {
  const key = ownerId ?? 'anon';
  binding.markDeleted(key);
  touched.delete(key);
  const b = store.get(key);
  if (!b) return 0;
  const removed = b.lifecycle.size;
  store.delete(key);
  schedulePicSave();
  return removed;
}

/**
 * Phase 1a.2 — source-scoped deletion: drop the lifecycle, version history and
 * reasoning-feedback signals of specific UKOs and facts, and strip those fact
 * ids from recorded retrieval sessions. Leaves every other subject untouched.
 * Idempotent (a retry removes nothing more). Returns the number of records dropped.
 */
export function forgetSubjects(ownerId, { ukoIds = [], factIds = [] } = {}) {
  const key = ownerId ?? 'anon';
  const b = store.get(key) ?? (binding.mode === 'off' ? null : picBucket(ownerId));
  if (!b) return 0;
  const facts = new Set(factIds);
  let removed = 0;
  for (const subject of [...ukoIds.map(id => `uko:${id}`), ...factIds.map(id => `fact:${id}`)]) {
    if (b.lifecycle.delete(subject)) removed++;
    if (b.versions.delete(subject)) removed++;
  }
  for (const id of facts) if (b.signals.delete(id)) removed++;
  for (const s of b.sessions) {
    if (Array.isArray(s?.usedFacts) && s.usedFacts.some(id => facts.has(id))) s.usedFacts = s.usedFacts.filter(id => !facts.has(id));
  }
  if (removed) { touched.add(key); schedulePicSave(); }
  return removed;
}

export function getPicStoreStats() {
  let subjects = 0, revisions = 0, sessions = 0;
  for (const b of store.values()) {
    subjects += b.lifecycle.size;
    for (const revs of b.versions.values()) revisions += revs.length;
    sessions += b.sessions.length;
  }
  return { owners: store.size, subjects, revisions, sessions };
}

export function _resetPicStoreForTests() { store.clear(); touched.clear(); binding._reset(); }
