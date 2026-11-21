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
import { bindOwnerStore } from '../../core/storage/ownerBinding.js';

const STORE_FILE = dataPath('.aqua-reflection.json');
const SCHEMA     = 1;

/** Same cap the in-memory Map used, kept so behaviour under pressure is unchanged. */
export const MAX_OWNERS = 1000;

/** ownerId → { snapshot, lastReflectionAt, lastSurfacedAt } */
const store = new Map();

function evictIfNeeded() {
  // FIFO on insertion order — identical policy to the Map this replaces. An
  // owner with an unwritten partition change is never evicted (Phase 2b): its
  // entry is the only copy until the flush lands.
  if (store.size <= MAX_OWNERS) return;
  for (const owner of [...store.keys()]) {
    if (store.size <= MAX_OWNERS) break;
    if (binding.isDirty(owner)) continue;
    store.delete(owner);
    binding.evicted(owner);
  }
}

// ── Per-owner persistence (scalability Phase 2b) ─────────────────────────────
//
// WRITERS. Two code paths write one owner's record, possibly in two processes:
//   · reflectWorldModel → saveReflectionState  (snapshot + lastReflectionAt)
//   · revisionDirectiveFor → markSurfaced      (lastSurfacedAt)
// MERGE (deterministic, order-independent):
//   · lastSurfacedAt  = the larger. A watermark only moves forward; taking the
//                       smaller would re-raise a revision already raised.
//   · snapshot + lastReflectionAt move TOGETHER, from the more recent
//     reflection (ties: the later snapshot.takenAt, then the larger JSON text,
//     so both sides pick the same one). A snapshot paired with another
//     reflection's watermark would skip or repeat obsolescence work.
// DELETION: forgetReflectionState → tombstone. A process's copy survives a
// deletion only if it changed after it.

/** One owner's record exactly as the JSON file holds it. Stable ids: node/edge keys are kept verbatim. */
export function encodeReflectionRecord(rec) {
  return {
    snapshot: rec.snapshot ? {
      nodes:   Object.fromEntries(rec.snapshot.nodes ?? new Map()),
      edges:   Object.fromEntries(rec.snapshot.edges ?? new Map()),
      takenAt: rec.snapshot.takenAt ?? 0,
    } : null,
    lastReflectionAt: rec.lastReflectionAt ?? 0,
    lastSurfacedAt:   rec.lastSurfacedAt ?? 0,
  };
}

export function decodeReflectionRecord(rec) {
  const snap = rec?.snapshot;
  return {
    // Maps do not survive JSON. Rehydrating here rather than at the call site
    // keeps the caller's shape contract identical to the in-memory version.
    snapshot: snap ? {
      nodes:   new Map(Object.entries(snap.nodes ?? {})),
      edges:   new Map(Object.entries(snap.edges ?? {})),
      takenAt: Number(snap.takenAt) || 0,
    } : null,
    lastReflectionAt: Number(rec?.lastReflectionAt) || 0,
    lastSurfacedAt:   Number(rec?.lastSurfacedAt) || 0,
  };
}

export function mergeReflectionRecords(ours, theirs) {
  const rank = r => [Number(r.lastReflectionAt) || 0, Number(r.snapshot?.takenAt) || 0, JSON.stringify(r.snapshot ?? null)];
  const a = rank(ours);
  const b = rank(theirs);
  const oursNewer = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];
  const base = oursNewer ? ours : theirs;
  return {
    snapshot: base.snapshot ?? null,
    lastReflectionAt: Number(base.lastReflectionAt) || 0,
    lastSurfacedAt: Math.max(Number(ours.lastSurfacedAt) || 0, Number(theirs.lastSurfacedAt) || 0),
  };
}

export const reflectionChangedAt = r =>
  Math.max(Number(r?.lastReflectionAt) || 0, Number(r?.lastSurfacedAt) || 0, Number(r?.snapshot?.takenAt) || 0);

const binding = bindOwnerStore({
  storeKey: '.aqua-reflection.json',
  file: STORE_FILE,
  label: 'reflection',
  schema: SCHEMA,
  encode: owner => { const rec = store.get(owner); return rec ? encodeReflectionRecord(rec) : undefined; },
  decode: decodeReflectionRecord,
  install: (owner, rec) => { if (rec) store.set(owner, rec); else store.delete(owner); },
  merge: mergeReflectionRecords,
  changedAt: reflectionChangedAt,
  reloadJson: () => loadFromDisk(),
});

/**
 * May this owner's reflection state be trusted as complete? False only when
 * partitions are authoritative and the owner has not been loaded in this unit
 * of work. A caller must then do nothing rather than act on "no state", which
 * for reflection means "everything changed".
 */
export function reflectionOwnerReady(ownerId) {
  return !ownerId || binding.ready(ownerId);
}

export function reflectionPartitionBinding() { return binding; }

function persist(ownerId) {
  binding.markDirty(ownerId);
  if (binding.writesWholeJson()) scheduleReflectionSave();
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
  persist(ownerId);
}

/** Roll the baseline forward. Snapshot Maps are stored as-is; save serialises. */
export function saveReflectionState(ownerId, snapshot, lastReflectionAt) {
  if (!ownerId) return;
  // FIX (2026-11-13): this replaced the whole record and dropped
  // lastSurfacedAt, so every reflection reset the "already raised" watermark
  // and a revision could be raised twice. The watermark is kept.
  const lastSurfacedAt = store.get(ownerId)?.lastSurfacedAt ?? 0;
  store.set(ownerId, { snapshot, lastReflectionAt, lastSurfacedAt });
  evictIfNeeded();
  persist(ownerId);
}

/**
 * G0 (SD-9) — after a SOURCE-scoped deletion, drop snapshot entries the live
 * graph no longer has. The snapshot holds entity LABELS, so without this a
 * deleted source's names survived until the next reflection, and that
 * reflection then reported them as "removed from your world". Nothing is
 * added or changed: only entries whose node (or edge, or either endpoint) is
 * gone are dropped. Returns null when the owner's state is not loaded in this
 * unit of work (partitioned mode) — the caller reports that, never guesses.
 *
 * @param {string} ownerId
 * @param {{ isLiveNode: (id:string)=>boolean, isLiveEdge: (edge:{id,from,to})=>boolean }} live
 * @returns {{ nodes:number, edges:number } | null}
 */
export function pruneReflectionSnapshot(ownerId, { isLiveNode, isLiveEdge }) {
  if (!ownerId) return { nodes: 0, edges: 0 };
  if (!reflectionOwnerReady(ownerId)) return null;
  const snap = store.get(ownerId)?.snapshot;
  if (!snap?.nodes) return { nodes: 0, edges: 0 };
  let nodes = 0, edges = 0;
  for (const id of [...snap.nodes.keys()]) {
    if (!isLiveNode(id)) { snap.nodes.delete(id); nodes++; }
  }
  for (const [id, e] of [...(snap.edges ?? new Map())]) {
    if (!snap.nodes.has(e.from) || !snap.nodes.has(e.to) || !isLiveEdge(e)) { snap.edges.delete(id); edges++; }
  }
  if (nodes || edges) persist(ownerId);
  return { nodes, edges };
}

/** Account deletion / tests. */
export function forgetReflectionState(ownerId) {
  if (!ownerId) return;
  // Tombstone even if this process never held the owner: another process may.
  binding.markDeleted(ownerId);
  if (store.delete(ownerId) && binding.writesWholeJson()) scheduleReflectionSave();
}

function loadFromDisk() {
  const parsed = loadJsonFile(STORE_FILE, { label: 'reflection' });
  if (parsed == null) return;
  const { data } = unwrapStore(parsed, { expected: SCHEMA, file: STORE_FILE, label: 'reflection' });
  if (!data || typeof data !== 'object') return;
  for (const [owner, rec] of Object.entries(data)) {
    // A record can legitimately have no snapshot: `markSurfaced` may run for an
    // owner whose reflection has not yet produced one. Dropping it here would
    // lose the "already told them" watermark and re-raise a revision.
    store.set(owner, decodeReflectionRecord(rec));
  }
  if (store.size) {
    console.log(`[BRAIN] Reflection state loaded: ${store.size} owner(s) from ${STORE_FILE}`);
  }
}

const _writer = createDebouncedWriter(STORE_FILE);
export function scheduleReflectionSave() {
  _writer.schedule(() => {
    const data = {};
    for (const [owner, rec] of store.entries()) data[owner] = encodeReflectionRecord(rec);
    return JSON.stringify(wrapStore(SCHEMA, data));
  });
}

// `on`/`only`: partitions are authoritative and owners load on demand. The JSON
// file is NOT loaded here: that is the whole-world boot load this replaces.
if (binding.loadsJsonAtBoot()) loadFromDisk();

export function reflectionStoreStats() {
  let nodes = 0, edges = 0;
  for (const r of store.values()) {
    nodes += r.snapshot?.nodes?.size ?? 0;
    edges += r.snapshot?.edges?.size ?? 0;
  }
  return { owners: store.size, nodes, edges };
}

export function _resetReflectionStoreForTests() { store.clear(); binding._reset(); }
