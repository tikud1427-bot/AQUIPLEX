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

export function picBucket(ownerId) {
  const key = ownerId ?? 'anon';
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
export function schedulePicSave() {
  _writer.schedule(() => {
    const data = {};
    for (const [owner, b] of store.entries()) {
      data[owner] = {
        lifecycle: Object.fromEntries(b.lifecycle),
        versions:  Object.fromEntries(b.versions),
        signals:   Object.fromEntries(b.signals),
        sessions:  b.sessions,
        ledger:    b.ledger,
      };
    }
    return JSON.stringify(wrapStore(SCHEMA, data));
  });
}

loadFromDisk();

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

export function getPicStoreStats() {
  let subjects = 0, revisions = 0, sessions = 0;
  for (const b of store.values()) {
    subjects += b.lifecycle.size;
    for (const revs of b.versions.values()) revisions += revs.length;
    sessions += b.sessions.length;
  }
  return { owners: store.size, subjects, revisions, sessions };
}

export function _resetPicStoreForTests() { store.clear(); }
