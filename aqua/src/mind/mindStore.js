/**
 * AQUA Mind Store
 * ─────────────────────────────────────────────────────────────────────────────
 * USER-scoped persistence for cognitive models. One Mind per owner.
 *
 * Deliberately mirrors the proven longTermMemory/conversationStore pattern:
 * in-memory Map + debounced JSON file write. Single file (.aqua-mind.json)
 * per engineering requirement "avoid duplicate storage" — subsystems are
 * modular in CODE, unified in PERSISTENCE.
 *
 * Owner resolution (see resolveMindOwner):
 *   platform session → `user:<aquaUserId>`  (cross-conversation, the real goal)
 *   engine run bare  → `conv:<conversationId>` fallback so the Mind still
 *                      works in dev/demo without the platform session layer.
 *
 * NOTE (scaling / migration path): the Map+file store is the same tier the
 * rest of AQUA persistence currently uses. All access goes through this
 * module's API, so swapping to SQLite/Postgres later touches ONE file.
 */
import fs from 'node:fs';
import { createEmptyMind } from './mindSchema.js';
import { createDebouncedWriter, loadJsonFile, wrapStore, unwrapStore } from '../core/atomicStore.js';
import { migrateLegacyFile } from '../core/dataDir.js';
import { clearNamespace } from '../embeddings/vectorStore.js';
import { bindOwnerStore } from '../core/storage/ownerBinding.js';
import { isExternalFileKey } from '../files/externalIdentity.js';

// P0 — memory is critical user data: it now lives in the canonical DATA
// DIRECTORY (survives every redeploy), with a one-time loss-proof migration
// of any legacy cwd file on boot. See core/dataDir.js.
const STORE_FILE   = migrateLegacyFile('.aqua-mind.json');
const STORE_SCHEMA = 1; // envelope version (mind objects carry their own `version` field)

// ownerId → Mind
const store = new Map();
let loaded = false;

// ── TWO PROCESSES, ONE FILE (P0 2026-10-12) ──────────────────────────────────
// The launcher runs server + worker on one DATA_DIR and both persist this
// store. Each used to write its WHOLE in-memory map: measured on the real
// product, the worker (loaded before a user existed) overwrote the server's
// copy and the user's 4 facts went to 0 — on disk and in the Mongo mirror.
// Now a flush writes only what THIS process changed, merged into what is on
// disk right now:
//   · owners this process did not change are taken from disk (and refreshed
//     in memory, in place — references other modules hold stay valid);
//   · owners changed by both processes are merged field by field (facts per
//     key, newer wins; beliefs/goals/episodes/files union);
//   · owners deleted here stay deleted.
// The read→rename window that remains is covered by the mirror's generation
// CAS, which preserves anything overwritten (core/mongoMirror.js).
const dirty = new Set();          // owners this process changed since its last flush
const deleted = new Map();        // owner → when THIS process deleted it (persisted in the envelope, see below)
const baseUpdatedAt = new Map();  // owner → updatedAt this process last loaded or wrote

// ── DELETIONS THAT HOLD ACROSS PROCESSES (audit 2026-10-12) ─────────────────
// The merge above unions the two processes' versions, and a union cannot tell
// "deleted here" from "never seen here": a fact the user deleted through the
// server was re-added from the worker's older copy on the server's next flush,
// and the worker's own next flush wrote its stale copy back. The same held for
// beliefs, goals, episodes, files — and for a whole deleted owner, whose
// `deleted` mark lived only in the deleting process's memory.
// A deletion is therefore recorded as DATA:
//   · per item  — mind.tombstones[bag][key] = when it was deleted;
//   · per owner — `deletedOwners` in the file envelope (beside schema/savedAt).
// An item is live iff it changed AFTER its tombstone, so saying the same thing
// again later brings it back, and a stale copy never does.
const TOMBSTONE_BAGS = Object.freeze(['facts', 'beliefs', 'goals', 'episodes', 'files']);
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;   // far beyond any flush interval between the two processes
const TOMBSTONE_CAP = 2000;                        // per bag, newest kept

/**
 * When an item last changed. Facts keep `ts` = first stored; a correction moves `updatedAt`.
 * Episodes carry `startedAt` / `lastActivityAt` (mindSchema.createEpisode) and none of the
 * other fields — before 2026-11-24 their itemTime was 0 (audit/recovery, Phase E).
 */
const timeOf = v => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const itemTime = x => Math.max(timeOf(x?.updatedAt), timeOf(x?.ts), timeOf(x?.createdAt), timeOf(x?.lastReferencedAt),
  timeOf(x?.lastActivityAt), timeOf(x?.startedAt));
export { itemTime as _itemTimeForTests };

function pruneTombstones(t, now = Date.now()) {
  for (const [k, at] of Object.entries(t)) if (now - at > TOMBSTONE_TTL_MS) delete t[k];
  const keys = Object.keys(t);
  if (keys.length > TOMBSTONE_CAP) {
    keys.sort((a, b) => t[a] - t[b]).slice(0, keys.length - TOMBSTONE_CAP).forEach(k => delete t[k]);
  }
}

/**
 * Record that `mind[bag][key]` was deleted. Every deletion of a mind item goes
 * through here (or deleteItem); a bare `delete` is undone by the next merge.
 */
export function markDeleted(mind, bag, key, at = Date.now()) {
  if (!mind || key == null || !TOMBSTONE_BAGS.includes(bag)) return;
  mind.tombstones ??= {};
  const t = (mind.tombstones[bag] ??= {});
  t[key] = Math.max(t[key] ?? 0, at);
  pruneTombstones(t, at);
}

/** Delete one item and record the deletion. Returns whether it existed. */
export function deleteItem(mind, bag, key, at = Date.now()) {
  if (!mind) return false;
  const existed = !!mind[bag] && Object.prototype.hasOwnProperty.call(mind[bag], key);
  if (existed) delete mind[bag][key];
  markDeleted(mind, bag, key, at);
  return existed;
}

function readDiskData() {
  try {
    if (!fs.existsSync(STORE_FILE)) return { data: null, deletedOwners: {} };
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    const { data } = unwrapStore(parsed, { expected: STORE_SCHEMA, file: STORE_FILE, label: 'mind' });
    return { data: data && typeof data === 'object' ? data : null, deletedOwners: parsed?.__aqua?.deletedOwners ?? {} };
  } catch {
    return { data: null, deletedOwners: {} };   // unreadable mid-rename or corrupt: write ours (the previous behaviour), never block a flush
  }
}

const tsOf = x => Number(x?.ts ?? x?.updatedAt ?? 0);
/** Replace `target`'s contents with `source`'s, keeping the object identity. */
function replaceInPlace(target, source) {
  for (const k of Object.keys(target)) if (!(k in source)) delete target[k];
  Object.assign(target, source);
}
/**
 * Both processes changed this owner: fold the disk version into ours, in place.
 * `ctx.allowExternalAdditions === false` (a partition flush WITHOUT a valid
 * origin fence, Safety Fixes 2/3): external file entries (ext:… keys) are the
 * database's — one the database copy does not hold is not written back (it was
 * deleted there, or it would be an unfenced addition), and one it holds keeps
 * the database's version (no unfenced update). Other bags and keys: unchanged.
 */
function mergeConcurrent(ours, disk, ctx = {}) {
  // Tombstones first: the union of both sides' deletions, newest time wins.
  ours.tombstones ??= {};
  for (const bag of TOMBSTONE_BAGS) {
    const t = (ours.tombstones[bag] ??= {});
    for (const [k, at] of Object.entries(disk.tombstones?.[bag] ?? {})) t[k] = Math.max(t[k] ?? 0, at);
  }
  const deletedAt = (bag, key) => ours.tombstones[bag]?.[key] ?? 0;
  // Deleted only when a tombstone EXISTS and the item did not change after it.
  // `itemTime <= (tombstone ?? 0)` treated every item with no time fields as
  // deleted — every episode, on every two-process merge (audit/recovery, Phase E).
  const isDeleted = (bag, key, item) => { const at = deletedAt(bag, key); return at > 0 && itemTime(item) <= at; };
  for (const bag of TOMBSTONE_BAGS) {
    ours[bag] ??= {};
    for (const [key, item] of Object.entries(disk[bag] ?? {})) {
      if (isDeleted(bag, key, item)) continue;                      // deleted after this copy was written
      const mine = ours[bag][key];
      if (!mine || itemTime(item) > itemTime(mine)) ours[bag][key] = item;
    }
    // …and a deletion the OTHER process made removes our older copy.
    for (const [key, item] of Object.entries(ours[bag])) {
      if (isDeleted(bag, key, item)) delete ours[bag][key];
    }
    if (bag === 'files' && ctx.allowExternalAdditions === false) {
      for (const key of Object.keys(ours.files)) {
        if (!isExternalFileKey(key)) continue;
        if (Object.prototype.hasOwnProperty.call(disk.files ?? {}, key)) ours.files[key] = disk.files[key];
        else delete ours.files[key];
      }
    }
  }
  for (const part of ['nodes', 'edges']) {
    ours.graph ??= { nodes: {}, edges: {} };
    for (const [k, v] of Object.entries(disk.graph?.[part] ?? {})) if (!ours.graph[part][k]) ours.graph[part][k] = v;
  }
  ours.turnCount = Math.max(ours.turnCount ?? 0, disk.turnCount ?? 0);
  // Phase 3: the worker's applied-turn markers — union, so a retried learning
  // job that already landed on either side is recognised.
  if (disk.appliedTurns || ours.appliedTurns) {
    ours.appliedTurns = trimApplied({ ...(disk.appliedTurns ?? {}), ...(ours.appliedTurns ?? {}) });
  }
  ours.updatedAt = Math.max(tsOf(ours), tsOf(disk));
}

// ── Applied-turn markers (scalability Phase 3) ───────────────────────────────
// A durable learning job may run more than once (a worker died after writing
// and before acknowledging). Stages that are not naturally idempotent — the
// turn counter, Twin observation — record "this turn was applied" IN THE MIND,
// so the marker is written in the same row, by the same flush, as the change
// it guards: both land or neither does. Bounded: the newest APPLIED_MAX.
const APPLIED_MAX = 400;
function trimApplied(map) {
  const entries = Object.entries(map);
  if (entries.length <= APPLIED_MAX) return map;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, APPLIED_MAX));
}
export function turnApplied(mind, marker) { return Boolean(mind?.appliedTurns?.[marker]); }
export function markTurnApplied(mind, marker, at = Date.now()) {
  if (!mind) return;
  mind.appliedTurns = trimApplied({ ...(mind.appliedTurns ?? {}), [marker]: at });
}

/**
 * Pure merge step of a flush — exported for tests. Mutates `memory` in place.
 * `deletedOwners`: owner → deletion time, this process's and the file's.
 * An owner deleted at T stays deleted unless a copy changed after T (the
 * user came back and the owner was recreated).
 */
export function mergeForFlush(memory, disk, { dirtyOwners, deletedOwners, base }) {
  let merged = 0, adopted = 0;
  const deletedAtOf = ownerId => (deletedOwners instanceof Map ? deletedOwners.get(ownerId) : (deletedOwners?.has?.(ownerId) ? Infinity : undefined)) ?? 0;
  for (const [ownerId, mine] of [...memory.entries()]) {
    const at = deletedAtOf(ownerId);
    if (at && tsOf(mine) <= at) memory.delete(ownerId);           // deleted by the other process
  }
  for (const [ownerId, d] of Object.entries(disk ?? {})) {
    const at = deletedAtOf(ownerId);
    if (at && tsOf(d) <= at) continue;
    const mine = memory.get(ownerId);
    if (!mine) { memory.set(ownerId, upgradeMind(d)); base.set(ownerId, tsOf(d)); adopted++; continue; }
    const siblingChanged = tsOf(d) > (base.get(ownerId) ?? 0);
    if (!siblingChanged) continue;
    if (dirtyOwners.has(ownerId)) { mergeConcurrent(mine, upgradeMind(d)); merged++; }
    else { replaceInPlace(mine, upgradeMind(d)); adopted++; }
    base.set(ownerId, tsOf(mine));
  }
  return { merged, adopted };
}

function loadFromDisk() {
  if (loaded) return;
  loaded = true;
  // Corrupt-safe: a bad parse preserves the file aside and recovers from
  // .bak instead of silently wiping every cognitive model (old behavior).
  const parsed = loadJsonFile(STORE_FILE, { label: 'mind' });
  if (parsed == null) return;
  const { data } = unwrapStore(parsed, { expected: STORE_SCHEMA, file: STORE_FILE, label: 'mind' });
  if (!data || typeof data !== 'object') return;
  adoptDeletedOwners(parsed?.__aqua?.deletedOwners);
  for (const [ownerId, mind] of Object.entries(data)) { store.set(ownerId, upgradeMind(mind)); baseUpdatedAt.set(ownerId, tsOf(mind)); }
  console.log(`[MIND] Loaded ${store.size} cognitive models from ${STORE_FILE}`);
}

/** Fold the file's owner deletions into ours (newest time wins), bounded by the tombstone TTL. */
function adoptDeletedOwners(fromDisk, now = Date.now()) {
  for (const [ownerId, at] of Object.entries(fromDisk ?? {})) {
    if (Number.isFinite(at) && at > (deleted.get(ownerId) ?? 0)) deleted.set(ownerId, at);
  }
  for (const [ownerId, at] of deleted) if (now - at > TOMBSTONE_TTL_MS) deleted.delete(ownerId);
}

// Phase 3b — atomic + async persistence via the shared primitive. Crash-safe
// (temp+rename) and non-blocking; serialize snapshots at flush time. The
// writer also takes a `.bak` boot backup before this process's first flush.
const _writer = createDebouncedWriter(STORE_FILE);

// ── Per-owner persistence (scalability Phase 2b, step 2) ─────────────────────
//
// WRITERS. Every subsystem that learns about a person (memory engine, Mind
// post-turn, reflection V3 in the worker, propagation, the Memory UI) mutates
// that owner's Mind and calls touchMind. Server and worker both do.
// MERGE. Exactly the two-process merge this file already applies to the shared
// JSON file (mergeConcurrent): per-item tombstones as data, the newer item wins
// per key, beliefs/goals/episodes/files unioned, graph nodes/edges unioned,
// turnCount max. It is applied to COPIES; the in-memory object is then updated
// in place so references other modules hold stay valid.
// DELETION. deleteMind → a tombstone row. A copy older than the deletion is
// dropped; a mind re-created after it (the user came back) is written without
// the deleted data. Item deletions travel inside the mind (`tombstones`).
// MEMORY. In `on`/`only` only the owners loaded by a request or job are held;
// least-recently-used clean owners are evicted (AQUA_PARTITION_STORE_OWNERS).
const binding = bindOwnerStore({
  storeKey: '.aqua-mind.json',
  file: STORE_FILE,
  label: 'mind',
  schema: STORE_SCHEMA,
  encode: owner => store.get(owner) ?? undefined,
  decode: obj => upgradeMind(obj),
  install: (owner, mind) => {
    if (!mind) { store.delete(owner); baseUpdatedAt.delete(owner); return; }
    const cur = store.get(owner);
    if (cur) replaceInPlace(cur, mind); else store.set(owner, mind);
    baseUpdatedAt.set(owner, tsOf(mind));
  },
  merge: (ours, theirs, ctx = {}) => {
    const copy = structuredClone(ours);
    mergeConcurrent(copy, upgradeMind(structuredClone(theirs)), ctx);
    return copy;
  },
  changedAt: tsOf,
  pruneBefore: pruneMindBefore,
  externalAware: true,      // Safety Fix 3: the merge also guards first writes (no row) of external file entries
  evict: owner => { store.delete(owner); baseUpdatedAt.delete(owner); },
  reloadJson: () => { loaded = false; loadFromDisk(); },
});

/**
 * After a whole-mind deletion at `at`, keep only what was learned at or after
 * it. A process that loaded the mind before the deletion still holds the old
 * items, and touching the mind (which stamps updatedAt=now) must not carry them
 * back. Derived structures (graph, timeline, predictions, reflections) are
 * rebuilt from new data rather than kept. null = nothing new at all.
 */
export function pruneMindBefore(mind, at) {
  let kept = 0;
  for (const bag of TOMBSTONE_BAGS) {
    for (const [key, item] of Object.entries(mind[bag] ?? {})) {
      if (itemTime(item) >= at) kept++; else delete mind[bag][key];
    }
  }
  if (!kept) return null;
  mind.graph = { nodes: {}, edges: {} };
  for (const list of ['timeline', 'predictions', 'reflections']) if (Array.isArray(mind[list])) mind[list] = [];
  mind.tombstones = {};
  return mind;
}

/**
 * Is this owner's Mind loaded (partitions authoritative) — i.e. may an empty
 * result be read as "this person has told us nothing"? Always true when the
 * JSON file is authoritative.
 */
export function mindOwnerReady(ownerId) { return !ownerId || binding.ready(ownerId); }
export function mindPartitionBinding() { return binding; }

function scheduleSave(ownerId = null) {
  if (ownerId) binding.markDirty(ownerId);
  if (!binding.writesWholeJson()) return;   // partitions are authoritative; the binding writes the rollback copy
  if (ownerId) dirty.add(ownerId);
  _writer.schedule(() => {
    const disk = readDiskData();
    adoptDeletedOwners(disk.deletedOwners);
    const r = mergeForFlush(store, disk.data, { dirtyOwners: dirty, deletedOwners: deleted, base: baseUpdatedAt });
    if (r.merged) console.log(`[MIND] merged ${r.merged} owner(s) changed concurrently by another process`);
    const data = {};
    for (const [owner, mind] of store.entries()) { data[owner] = mind; baseUpdatedAt.set(owner, tsOf(mind)); }
    dirty.clear();
    const envelope = wrapStore(STORE_SCHEMA, data);
    if (deleted.size) envelope.__aqua.deletedOwners = Object.fromEntries(deleted);
    return JSON.stringify(envelope);
  });
}
// `on`/`only`: owners load on demand (ensureOwnerLoaded); no whole-world boot load.
if (binding.loadsJsonAtBoot()) loadFromDisk();

/**
 * Write this owner's mind to disk NOW (synchronous, atomic, merged with the
 * file like any flush). memory/propagation.js calls it before touching another
 * store: a change is durable in this file before anything acts on it, so after
 * a crash the other store can lag the record of the change, never lead it.
 */
export function flushMind(ownerId = null) {
  scheduleSave(ownerId);
  if (binding.writesWholeJson()) { _writer.flush(); return; }
  // Partitions authoritative: there is no synchronous database write. The
  // flush is started now and not awaited — weaker than the file path's
  // "durable before anything acts on it". Stated in AQUIPLEX_PHASE_2B_REPORT.md
  // (propagation, the only caller, is OFF by default).
  binding.flush().catch(() => {});
}

/** Schema v1 → v2: facts + files live INSIDE the mind (single store). */
function upgradeMind(mind) {
  if (!mind) return mind;
  if (!mind.facts) mind.facts = {};
  if (!mind.files) mind.files = {};
  if (!mind.version || mind.version < 2) mind.version = 2;
  return mind;
}

/**
 * Resolve which Mind a request belongs to.
 * DEPRECATED shim — the ONE owner model now lives in memory/ownerResolver.js
 * (which also performs conv→user adoption). Kept for mindRoutes/back-compat;
 * logic identical, no adoption side effects here.
 */
export function resolveMindOwner({ userId = null, conversationId = null } = {}) {
  if (userId) return `user:${userId}`;
  if (conversationId) return `conv:${conversationId}`;
  return null;
}

/**
 * One-time adoption: merge a pre-login `conv:` mind into the real `user:`
 * mind, then tombstone the source. Facts merge via longTermMemory's conflict
 * resolver (caller wires that — see ownerResolver) is NOT needed here:
 * fact-level merge uses simple newer/higher-confidence-wins to avoid a
 * circular import; the same priority order the resolver applies.
 */
export function adoptMind(fromOwner, toOwner) {
  const src = store.get(fromOwner);
  if (!src || src.adoptedInto) return false;
  const dst = getMind(toOwner);

  // Facts: keep whichever is newer, else higher confidence. History preserved.
  for (const [key, fact] of Object.entries(src.facts || {})) {
    const existing = dst.facts[key];
    if (!existing) { dst.facts[key] = fact; continue; }
    const factTs = fact.ts || fact.updatedAt || 0;
    const exTs   = existing.ts || existing.updatedAt || 0;
    const incomingWins = factTs > exTs ||
      (factTs === exTs && (fact.confidence || 0) > (existing.confidence || 0));
    if (incomingWins) {
      fact.history = [...(existing.history || []), ...(fact.history || [])];
      fact.revision = Math.max(fact.revision || 1, (existing.revision || 1) + 1);
      dst.facts[key] = fact;
    }
  }

  // Beliefs: higher confidence wins; evidence concatenated (capped later by reflection).
  for (const [key, belief] of Object.entries(src.beliefs || {})) {
    const existing = dst.beliefs[key];
    if (!existing || (belief.confidence || 0) > (existing.confidence || 0)) {
      if (existing) belief.evidence = [...(existing.evidence || []), ...(belief.evidence || [])];
      dst.beliefs[key] = belief;
    }
  }

  // Goals / episodes / files: union, existing wins on id collision.
  for (const bag of ['goals', 'episodes', 'files']) {
    for (const [id, item] of Object.entries(src[bag] || {})) {
      if (!dst[bag][id]) dst[bag][id] = item;
    }
  }

  // Graph: union nodes/edges, weights added.
  for (const [k, n] of Object.entries(src.graph?.nodes || {})) {
    if (dst.graph.nodes[k]) dst.graph.nodes[k].weight += n.weight || 1;
    else dst.graph.nodes[k] = n;
  }
  for (const [k, e] of Object.entries(src.graph?.edges || {})) {
    if (dst.graph.edges[k]) dst.graph.edges[k].weight += e.weight || 1;
    else dst.graph.edges[k] = e;
  }

  dst.turnCount += src.turnCount || 0;
  src.adoptedInto = toOwner;
  src.adoptedAt = Date.now();
  src.updatedAt = Date.now();
  dirty.add(fromOwner);
  binding.markDirty(fromOwner);
  touchMind(dst);
  console.log(`[MIND] ADOPTED ${fromOwner} → ${toOwner} facts=${Object.keys(src.facts || {}).length} beliefs=${Object.keys(src.beliefs || {}).length}`);
  return true;
}

export function getMind(ownerId) {
  if (!ownerId) return null;
  let mind = store.get(ownerId);
  if (!mind) {
    mind = createEmptyMind(ownerId);
    // A mind recreated after a deletion must read as newer than it, even
    // within the same millisecond, or the next flush would drop it.
    const deletedAt = deleted.get(ownerId);
    if (deletedAt && mind.updatedAt <= deletedAt) mind.updatedAt = deletedAt + 1;
    store.set(ownerId, mind);
    console.log(`[MIND] MIND_CREATED owner=${ownerId}`);
  }
  return mind;
}

/**
 * Every owner with a mind. Read-only enumeration for admin tooling — see
 * the matching helper on the reasoning graph.
 */
export function listOwners() { return [...store.keys()]; }

export function peekMind(ownerId) {
  return ownerId ? (store.get(ownerId) ?? null) : null;
}

/** Mark mutated + persist. Every subsystem calls this after writing. */
export function touchMind(mind) {
  if (!mind) return;
  mind.updatedAt = Date.now();
  // Minds from older files may lack ownerId; find the key so the change is
  // still marked as THIS process's (or the merge would take the disk copy).
  let owner = mind.ownerId ?? null;
  if (!owner) for (const [k, v] of store) if (v === mind) { owner = k; break; }
  scheduleSave(owner);
}

export function deleteMind(ownerId) {
  const existed = store.delete(ownerId);
  // Persisted (envelope `deletedOwners`), so the OTHER process drops its copy
  // too — even when this process never loaded the owner.
  const at = Date.now();
  deleted.set(ownerId, at);
  binding.markDeleted(ownerId, at);   // partitions: a tombstone row
  scheduleSave();
  // Phase D — GDPR cascade: deleting a mind also purges every vector the
  // owner accumulated (fact vectors live in ns `<ownerId>`, uploaded-file
  // content chunks in ns `files:<ownerId>`). Runs even if the mind object
  // was already gone — vectors must never outlive a deletion request.
  try {
    clearNamespace(ownerId);
    clearNamespace(`files:${ownerId}`);
    clearNamespace(`xfiles:${ownerId}`);   // Phase 1a.2: external-resource chunks (embeddings/fileMemory.js)
    clearNamespace(`recall:${ownerId}`);   // semantic episodic recall (memory/semanticRecall.js)
  } catch { /* non-fatal */ }
  return existed;
}

/** Layer 19 — full export. The user owns the model. */
export function exportMind(ownerId) {
  const mind = peekMind(ownerId);
  return mind ? JSON.parse(JSON.stringify(mind)) : null;
}

export function mindStats() {
  let beliefs = 0, goals = 0, episodes = 0;
  for (const m of store.values()) {
    beliefs  += Object.keys(m.beliefs  || {}).length;
    goals    += Object.keys(m.goals    || {}).length;
    episodes += Object.keys(m.episodes || {}).length;
  }
  return { minds: store.size, beliefs, goals, episodes };
}

/** Internal: stats iteration for the unified fact layer (longTermMemory). */
export function _iterateMindsForStats() {
  return store.values();
}

/** Test-only: reset in-memory state (does not touch disk). */
export function _clearAllForTests() {
  store.clear();
  dirty.clear(); deleted.clear(); baseUpdatedAt.clear();
  binding._reset();
}