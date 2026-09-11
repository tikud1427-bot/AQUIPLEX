/**
 * AQUA Brain — Reflection state, made durable.
 *
 * THE DEFECT THIS EXISTS TO FIX
 * -----------------------------
 * Reflection V2 answers "what changed in the world model since last time" by
 * diffing the graph against the previous snapshot. That snapshot lived in a
 * module-level `Map`, so it did not survive the process. Measured:
 *
 *   run 1, reflect       → 5 entities changed, 1 relationship changed   (correct)
 *   run 1, reflect again → 0 changed, worldModelUpdated: false          (correct)
 *   RESTART, reflect     → 5 entities changed, 1 relationship changed   ← WRONG
 *
 * The third line had no new turns between it and the second. An empty
 * `before` makes every node look new, so the first reflection after every
 * deploy fabricates a full-graph delta for every active user.
 *
 * That is bad anywhere. It is worse here, because with `AQUA_REFLECT_V2=on`
 * the applier ACTS on the delta, and because the whole point of this subsystem
 * is to tell someone what AQUA changed its mind about. A feature whose first
 * output after every deploy is "everything about you just changed" is not a
 * weak feature, it is a lying one.
 *
 * `lastReflectionAt` had the same problem with a quieter symptom: losing it
 * resets the obsolescence window to `since: 0`, so contradiction detection
 * rescans an owner's entire fact corpus instead of what arrived recently.
 *
 * WHAT THIS HOLDS — AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------
 * A diff BASELINE and a watermark. No knowledge: entities live in the graph,
 * facts in evidenceStore, beliefs in the Mind. Every entry here is a
 * fingerprint that references knowledge by id. Delete this file and the next
 * reflection reports one over-large delta and then self-corrects forever —
 * the same failure it has today, once, instead of on every deploy.
 *
 * Same primitives as every other AQUA store: atomicStore debounced writer,
 * dataDir resolution, the free Mongo mirror, per-owner buckets, bounded,
 * schema-versioned, `_reset` for tests.
 */
import {
  createDebouncedWriter, loadJsonFile, wrapStore, unwrapStore,
} from '../../core/atomicStore.js';
import { dataPath } from '../../core/dataDir.js';

const STORE_FILE = dataPath('.aqua-reflection.json');
const SCHEMA     = 1;

/** Same cap the in-memory Map used, kept so behaviour under pressure is unchanged. */
export const MAX_OWNERS = 1000;

/** ownerId → { snapshot, lastReflectionAt, lastSurfacedAt } */
const store = new Map();

function evictIfNeeded() {
  // FIFO on insertion order — identical policy to the Map this replaces.
  while (store.size > MAX_OWNERS) store.delete(store.keys().next().value);
}

/**
 * The baseline to diff against. Returns null when this owner has never been
 * reflected on, so the caller keeps its own "empty snapshot" default and this
 * module never has to know what an empty snapshot looks like.
 */
export function loadSnapshot(ownerId) {
  if (!ownerId) return null;
  return store.get(ownerId)?.snapshot ?? null;
}

/** Timestamp of the last reflection, for the obsolescence `since` window. */
export function loadWatermark(ownerId) {
  if (!ownerId) return 0;
  return store.get(ownerId)?.lastReflectionAt ?? 0;
}

/**
 * Timestamp of the last revision AQUA actually RAISED with this person.
 *
 * A separate watermark from `lastReflectionAt` on purpose: reflection happens
 * on a cadence whether or not anyone is told, and conflating "I noticed" with
 * "I mentioned it" is how a feature ends up either silent or repeating itself.
 */
export function loadSurfacedAt(ownerId) {
  if (!ownerId) return 0;
  return store.get(ownerId)?.lastSurfacedAt ?? 0;
}

/**
 * Record that a revision was raised, so it is never raised twice.
 *
 * ADVANCED AT INJECTION, not after the model demonstrably said it — there is no
 * observable point where "the model actually mentioned it" is known. The
 * tradeoff is deliberate and one-directional: a revision the model chose to
 * skip is lost, rather than repeated on every subsequent turn until someone
 * responds to it. A missed observation is a small loss; a nagging assistant is
 * the reason people switch a feature off.
 */
export function markSurfaced(ownerId, at) {
  if (!ownerId) return;
  const rec = store.get(ownerId);
  if (rec) rec.lastSurfacedAt = Number(at) || Date.now();
  else store.set(ownerId, { snapshot: null, lastReflectionAt: 0, lastSurfacedAt: Number(at) || Date.now() });
  evictIfNeeded();
  scheduleReflectionSave();
}

/** Roll the baseline forward. Snapshot Maps are stored as-is; save serialises. */
export function saveReflectionState(ownerId, snapshot, lastReflectionAt) {
  if (!ownerId) return;
  store.set(ownerId, { snapshot, lastReflectionAt });
  evictIfNeeded();
  scheduleReflectionSave();
}

/** Account deletion / tests. */
export function forgetReflectionState(ownerId) {
  if (store.delete(ownerId)) scheduleReflectionSave();
}

function loadFromDisk() {
  const parsed = loadJsonFile(STORE_FILE, { label: 'reflection' });
  if (parsed == null) return;
  const { data } = unwrapStore(parsed, { expected: SCHEMA, file: STORE_FILE, label: 'reflection' });
  if (!data || typeof data !== 'object') return;
  for (const [owner, rec] of Object.entries(data)) {
    const snap = rec?.snapshot;
    // A record can legitimately have no snapshot: `markSurfaced` may run for an
    // owner whose reflection has not yet produced one. Dropping it here would
    // lose the "already told them" watermark and re-raise a revision.
    store.set(owner, {
      // Maps do not survive JSON. Rehydrating here rather than at the call site
      // keeps the caller's shape contract identical to the in-memory version.
      snapshot: snap ? {
        nodes:   new Map(Object.entries(snap.nodes ?? {})),
        edges:   new Map(Object.entries(snap.edges ?? {})),
        takenAt: Number(snap.takenAt) || 0,
      } : null,
      lastReflectionAt: Number(rec.lastReflectionAt) || 0,
      lastSurfacedAt:   Number(rec.lastSurfacedAt) || 0,
    });
  }
  if (store.size) {
    console.log(`[BRAIN] Reflection state loaded: ${store.size} owner(s) from ${STORE_FILE}`);
  }
}

const _writer = createDebouncedWriter(STORE_FILE);
export function scheduleReflectionSave() {
  _writer.schedule(() => {
    const data = {};
    for (const [owner, rec] of store.entries()) {
      data[owner] = {
        snapshot: rec.snapshot ? {
          nodes:   Object.fromEntries(rec.snapshot.nodes ?? new Map()),
          edges:   Object.fromEntries(rec.snapshot.edges ?? new Map()),
          takenAt: rec.snapshot.takenAt ?? 0,
        } : null,
        lastReflectionAt: rec.lastReflectionAt ?? 0,
        lastSurfacedAt:   rec.lastSurfacedAt ?? 0,
      };
    }
    return JSON.stringify(wrapStore(SCHEMA, data));
  });
}

loadFromDisk();

export function reflectionStoreStats() {
  let nodes = 0, edges = 0;
  for (const r of store.values()) {
    nodes += r.snapshot?.nodes?.size ?? 0;
    edges += r.snapshot?.edges?.size ?? 0;
  }
  return { owners: store.size, nodes, edges };
}

export function _resetReflectionStoreForTests() { store.clear(); }
