/**
 * AQUA UKO Store — File Intelligence V1
 *
 * Persistence + caching for Universal Knowledge Objects.
 *
 * Two responsibilities, one content-addressed core:
 *   1. STORE: every ingested UKO persists per owner (bounded, newest-first
 *      eviction) — the durable record future retrieval/reasoning phases
 *      read. Same primitives as every store (atomicStore + dataDir + the
 *      free Mongo mirror that comes with them).
 *   2. CACHE: parse + enrichment results are content-addressed by
 *      sourceFile.hash. Re-uploading identical bytes — any owner, any
 *      conversation — reuses the computed knowledge instead of re-running
 *      parsers and enrichment. Owner-specific effects (embeddings, memory
 *      links, search indexing) are NOT cached: the engine re-runs those
 *      integration stages against the cached knowledge, because "what the
 *      file means" is content-determined but "whose memory it enters" is
 *      not. Existing lower-level caches (media analysis LRU, OCR cache)
 *      remain and simply see fewer calls.
 *
 * Cache entries store the CONTENT-DETERMINED fields only (raw + structured
 * + knowledge + provenance.analyzer) — never owner/conversation/memory
 * fields, which makes cross-owner reuse safe by construction.
 */
import {
  createDebouncedWriter, loadJsonFile, wrapStore, unwrapStore,
} from '../core/atomicStore.js';
import { dataPath } from '../core/dataDir.js';
import { bindKeyedStore } from '../core/storage/keyedBinding.js';
import { isExternalFileId } from './externalIdentity.js';
import { dataClassOfSource, isKnownDataClass, isUnrestricted, UNCLASSIFIED } from '../core/dataClass.js';
import { noteDataClasses } from '../core/egressGuard.js';

const STORE_FILE = dataPath('.aqua-uko.json');
const SCHEMA     = 1;

const MAX_UKOS_PER_OWNER = 100;   // uploads (and workspaces) — unchanged, counted over uploads only
// Phase 1a.2 — external resources have their OWN budget. The sync layer
// (files/externalSources.js) refuses new items before ingest when it is
// reached; this backstop makes the store refuse rather than evict if any
// caller ever bypasses that check. An external UKO never evicts anything.
export const MAX_EXTERNAL_UKOS_PER_OWNER = 200;
/** Data classes with no per-owner total item cap (founder decision 2026-11-23: complete Gmail sync). */
export const UNCAPPED_CLASSES = Object.freeze(new Set(['external:gmail']));
const MAX_CACHE_ENTRIES  = 150;

/** ownerKey → Map<ukoId, uko>   (ownerKey: ownerId or 'anon') */
const byOwner = new Map();
/** contentHash → cached knowledge payload */
const byHash  = new Map();

// ── Persistence ──────────────────────────────────────────────────────────────

function loadFromDisk() {
  const parsed = loadJsonFile(STORE_FILE, { label: 'uko' });
  if (parsed == null) return;
  const { data } = unwrapStore(parsed, { expected: SCHEMA, file: STORE_FILE, label: 'uko' });
  if (!data || typeof data !== 'object') return;
  for (const [owner, ukos] of Object.entries(data.owners ?? {})) {
    byOwner.set(owner, new Map(Object.entries(ukos)));
  }
  for (const [hash, entry] of Object.entries(data.cache ?? {})) byHash.set(hash, entry);
  if (byOwner.size || byHash.size) {
    console.log(`[FILES] UKO store loaded: ${[...byOwner.values()].reduce((n, m) => n + m.size, 0)} object(s), ${byHash.size} cache entr(ies) from ${STORE_FILE}`);
  }
}

let lastWriteError = null;   // flushUKOStore: the last JSON write failure (cleared by a successful write)
const _writer = createDebouncedWriter(STORE_FILE, {
  onError: err => { lastWriteError = err; console.warn(`[STORE] atomic write failed for .aqua-uko.json: ${err?.message ?? err}`); },
  onFlushed: () => { lastWriteError = null; },
});
function scheduleSave(ownerKeyToSave = null) {
  if (ownerKeyToSave) binding.markDirty(ownerKeyToSave);
  if (!binding.writesWholeJson()) return;
  _writer.schedule(() => {
    const owners = {};
    for (const [owner, m] of byOwner.entries()) owners[owner] = Object.fromEntries(m);
    return JSON.stringify(wrapStore(SCHEMA, { owners, cache: Object.fromEntries(byHash) }));
  });
}

// ── Per-owner persistence (scalability Phase 2c) ─────────────────────────────
// OWNERS SECTION — writer: the server only (upload / file pipeline). One row per
// owner ('owners:<owner>'), three-way per uko (newer uploadedAt on a double
// change; removeUKO and eviction attributed against the base). purgeOwner →
// row tombstone.
// CONTENT CACHE — global by design today (parsed content keyed by content hash,
// reused across owners). With partitions on it is NOT shared and NOT persisted:
// it becomes process-local and scoped per owner. Sharing it would create a
// global hot row, and would let a deleted user's parsed content outlive the
// purge in other instances' memory. It is a pure parse cache: a miss only
// re-parses.
const binding = bindKeyedStore({
  storeKey: '.aqua-uko.json', file: STORE_FILE, label: 'uko', schema: SCHEMA,
  section: 'owners', jsonPath: ['owners'],
  // Safety Fix 2: external resources (ext_ ids) — a deletion wins over a concurrent
  // edit; an addition needs a valid connect fence (core/storage/entryMerge.js).
  mergeSchema: { root: { time: u => Number(u?.provenance?.uploadedAt) || 0, external: id => isExternalFileId(id) } },
  encode: owner => (byOwner.has(owner) ? Object.fromEntries(byOwner.get(owner)) : undefined),
  decode: obj => new Map(Object.entries(obj ?? {})),
  install: (owner, m) => { if (m) byOwner.set(owner, m); else byOwner.delete(owner); },
  evict: owner => {
    byOwner.delete(owner);
    for (const k of [...byHash.keys()]) if (k.startsWith(`${owner}\u0000`)) byHash.delete(k);
  },
  changedAt: obj => Math.max(0, ...Object.values(obj ?? {}).map(u => Number(u?.provenance?.uploadedAt) || 0)),
  reloadJson: () => loadFromDisk(),
});
export function ukoPartitionBinding() { return binding; }
/** Cache key: content hash; per owner while partitions are on (see above). */
const cacheKey = (hash, ownerId) => (binding.mode === 'off' ? hash : `${ownerId ?? 'anon'}\u0000${hash}`);

if (binding.loadsJsonAtBoot()) loadFromDisk();

const ownerKey = (ownerId) => ownerId ?? 'anon';

// ── Store ─────────────────────────────────────────────────────────────────────

export function saveUKO(uko) {
  const key = ownerKey(uko.owner);
  const m = byOwner.get(key) ?? new Map();
  if (!byOwner.has(key)) byOwner.set(key, m);
  if (!m.has(uko.id)) {
    if (isExternalFileId(uko.id)) {
      // Phase 1a.2: never evict — refuse. (Thrown inside ingestOne → that file fails cleanly.)
      // Counted in RESOURCES, not versions: during an update the new version is
      // stored beside the old one until it succeeds, and that must not count twice.
      // 2026-11-23 (founder-approved): Gmail has NO total item cap — the whole eligible
      // mailbox is imported. Gmail items neither hit nor count toward this backstop,
      // which still bounds every other external source.
      const capped = u => !UNCAPPED_CLASSES.has(dataClassOfUko(u));
      const itemOf = id => id.slice(0, id.lastIndexOf('_'));
      const items = new Set([...m.values()].filter(u => isExternalFileId(u.id) && capped(u)).map(u => itemOf(u.id)));
      if (capped(uko) && !items.has(itemOf(uko.id)) && items.size >= MAX_EXTERNAL_UKOS_PER_OWNER) {
        throw Object.assign(new Error('External resource limit reached for this owner'), { code: 'EXTERNAL_LIMIT' });
      }
    } else {
      // Uploads: the original policy — evict the oldest by upload time — but
      // counted over, and choosing from, uploads only. With no external UKOs
      // present this is exactly the previous behaviour.
      const uploads = [...m.values()].filter(u => !isExternalFileId(u.id));
      if (uploads.length >= MAX_UKOS_PER_OWNER) {
        const oldest = uploads.sort((a, b) => a.provenance.uploadedAt - b.provenance.uploadedAt)[0];
        if (oldest) m.delete(oldest.id);
      }
    }
  }
  m.set(uko.id, uko);
  scheduleSave(key);
  return uko;
}

// ── Data classes (G1-2) ───────────────────────────────────────────────────────
/**
 * The data class of a stored UKO (core/dataClass.js). An external resource's
 * class comes from its source id (`<connector>:<scope>` → external:<connector>);
 * a stored class that contradicts it, or an external id with no usable source,
 * is UNCLASSIFIED (fail closed). Uploads are `upload`; a stored class on an
 * upload is honoured only when it is at least as restrictive (never downgraded).
 */
export function dataClassOfUko(uko) {
  if (!uko) return UNCLASSIFIED;
  const external = uko.provenance?.external ?? null;
  if (isExternalFileId(uko.id) || external) {
    const derived = external?.sourceId ? dataClassOfSource(external.sourceId) : UNCLASSIFIED;
    return uko.dataClass && uko.dataClass !== derived ? UNCLASSIFIED : derived;
  }
  if (uko.dataClass === undefined || uko.dataClass === null || uko.dataClass === 'upload') return 'upload';
  return isKnownDataClass(uko.dataClass) ? uko.dataClass : UNCLASSIFIED;
}

/**
 * RESTRICTED content (a class not every provider may receive — e.g.
 * external:gmail) is invisible to every normal reader: the reasoning graph,
 * PIC, forensic/research engines, understanding observers and the chat context
 * all read through getUKO/listUKOs and simply never see it. Only lifecycle code
 * (external-source sync/delete, the understanding worker) asks for it with
 * `includeRestricted`, and that read records the class in the current
 * data-class scope (core/egressGuard.js) — or throws when there is none — so
 * nothing that follows in that request/job can send it to a provider.
 */
function visible(uko, includeRestricted) {
  if (!uko) return false;
  const cls = dataClassOfUko(uko);
  if (isUnrestricted(cls)) return true;
  if (!includeRestricted) return false;
  noteDataClasses([cls]);
  return true;
}

export function getUKO(ownerId, ukoId, { includeRestricted = false } = {}) {
  const uko = byOwner.get(ownerKey(ownerId))?.get(ukoId) ?? null;
  return visible(uko, includeRestricted) ? uko : null;
}

export function listUKOs(ownerId, { limit = 50, includeRestricted = false } = {}) {
  const m = byOwner.get(ownerKey(ownerId));
  if (!m) return [];
  return [...m.values()]
    .filter(u => visible(u, includeRestricted))
    .sort((a, b) => b.provenance.uploadedAt - a.provenance.uploadedAt)
    .slice(0, limit);
}

/**
 * Phase 1a.2 — UKOs whose id starts with `prefix` (an external source or
 * resource prefix from files/externalIdentity.js). Upload ids are uuids and
 * cannot match an external prefix.
 */
export function listUKOsByPrefix(ownerId, prefix, { includeRestricted = false } = {}) {
  if (!isExternalFileId(prefix)) return [];
  const m = byOwner.get(ownerKey(ownerId));
  return m ? [...m.values()].filter(u => u.id.startsWith(prefix) && visible(u, includeRestricted)) : [];
}

/**
 * Phase 1a.2 — drop the content-hash cache entry for `hash` unless a live UKO
 * (any owner — with partitions off the cache is shared by identical bytes)
 * still has that content. Leaves no parsed copy of deleted external content
 * in the cache; costs at most a re-parse. Returns whether an entry was dropped.
 */
export function dropCachedKnowledgeIfUnused(ownerId, hash) {
  if (!hash) return false;
  // Partitions off: one cache entry serves every owner with these bytes.
  // Partitions on: the entry is this owner's own (cacheKey), so only theirs count.
  const owners = binding.mode === 'off' ? [...byOwner.values()] : [byOwner.get(ownerKey(ownerId))].filter(Boolean);
  for (const m of owners) {
    for (const u of m.values()) if (u?.sourceFile?.hash === hash) return false;
  }
  const ck = cacheKey(hash, ownerId);
  const had = byHash.delete(ck);
  if (had && binding.mode === 'off') scheduleSave();
  return had;
}

export function removeUKO(ownerId, ukoId) {
  const m = byOwner.get(ownerKey(ownerId));
  const had = m?.delete(ukoId) ?? false;
  if (had) scheduleSave(ownerKey(ownerId));
  return had;
}

/**
 * Account deletion — drop every UKO for one owner, plus the content-hash
 * cache entries derived from their files (the cache holds parsed content, so
 * leaving it behind would leave the user's file content in the store).
 * Returns the number of objects removed.
 */
export function purgeOwner(ownerId) {
  const key = ownerKey(ownerId);
  binding.markDeleted(key);
  for (const k of [...byHash.keys()]) if (k.startsWith(`${key}\u0000`)) byHash.delete(k);   // partitions on: per-owner cache
  const m = byOwner.get(key);
  if (!m) return 0;
  const removed = m.size;
  for (const uko of m.values()) {
    const hash = uko?.sourceFile?.hash;
    if (hash) byHash.delete(hash);
  }
  byOwner.delete(key);
  scheduleSave();
  return removed;
}

// ── Content-hash cache (parse + enrichment reuse) ────────────────────────────

const CONTENT_FIELDS = [
  'metadata', 'rawContent', 'structuredContent',
  'entities', 'topics', 'keywords', 'timeline', 'facts', 'summaries', 'reasoningHints',
];

export function cacheKnowledge(uko) {
  if (!uko?.sourceFile?.hash) return;
  const ck = cacheKey(uko.sourceFile.hash, uko.owner);
  if (byHash.size >= MAX_CACHE_ENTRIES && !byHash.has(ck)) {
    byHash.delete(byHash.keys().next().value); // FIFO — same policy as mediaPipeline
  }
  const entry = { cachedAt: Date.now(), fileType: uko.fileType, analyzer: uko.provenance.analyzer, parser: uko.provenance.parser, parserVersion: uko.provenance.parserVersion };
  for (const f of CONTENT_FIELDS) entry[f] = uko[f];
  byHash.set(ck, entry);
  if (binding.mode === 'off') scheduleSave();   // partitions on: process-local, never persisted
}

/**
 * Content-determined knowledge for identical bytes, or null. The engine
 * copies these fields onto a FRESH UKO (new id/owner/conversation) and
 * re-runs only the integration stages.
 */
export function getCachedKnowledge(hash, fileType, { ownerId = null } = {}) {
  const entry = byHash.get(cacheKey(hash, ownerId));
  if (!entry) return null;
  if (fileType && entry.fileType !== fileType) return null; // same bytes classified differently — don't cross-wire
  return entry;
}

/**
 * 2026-11-23 — write pending UKO changes NOW (durably) instead of on the 500 ms
 * debounce. A connector sync calls this before it persists an advanced listing
 * or history position, so a position never runs ahead of the stored messages
 * (a crash in between would otherwise skip them). JSON mode: synchronous atomic
 * write (+ the Mongo mirror). Partitioned modes: the binding's own flush.
 * Throws if the write could not be completed.
 */
export async function flushUKOStore({ timeoutMs = 10_000 } = {}) {
  if (binding.writesWholeJson()) {
    // An async debounced write may be in flight with an OLDER snapshot: let it end
    // first, then write the newest snapshot last, synchronously.
    const deadline = Date.now() + timeoutMs;
    while (_writer.isPending() && Date.now() < deadline) { _writer.flush(); await new Promise(r => setTimeout(r, 20)); }
    if (_writer.isPending()) throw Object.assign(new Error('UKO store write still pending'), { code: 'FLUSH_INCOMPLETE' });
    lastWriteError = null;
    scheduleSave();
    _writer.flush();
    if (lastWriteError) throw Object.assign(new Error(`UKO store write failed: ${lastWriteError.message ?? lastWriteError}`), { code: 'FLUSH_INCOMPLETE' });
  }
  if (binding.mode !== 'off' && typeof binding.flush === 'function') await binding.flush();
}

export function getUKOStoreStats() {
  return {
    owners: byOwner.size,
    objects: [...byOwner.values()].reduce((n, m) => n + m.size, 0),
    cacheEntries: byHash.size,
  };
}

export function _resetUKOStoreForTests() { byOwner.clear(); byHash.clear(); binding._reset(); }
