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

const STORE_FILE = dataPath('.aqua-uko.json');
const SCHEMA     = 1;

const MAX_UKOS_PER_OWNER = 100;
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

const _writer = createDebouncedWriter(STORE_FILE);
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
  mergeSchema: { root: { time: u => Number(u?.provenance?.uploadedAt) || 0 } },
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
  if (m.size >= MAX_UKOS_PER_OWNER && !m.has(uko.id)) {
    // Evict the oldest by upload time — bounded like every AQUA store.
    const oldest = [...m.values()].sort((a, b) => a.provenance.uploadedAt - b.provenance.uploadedAt)[0];
    if (oldest) m.delete(oldest.id);
  }
  m.set(uko.id, uko);
  scheduleSave(key);
  return uko;
}

export function getUKO(ownerId, ukoId) {
  return byOwner.get(ownerKey(ownerId))?.get(ukoId) ?? null;
}

export function listUKOs(ownerId, { limit = 50 } = {}) {
  const m = byOwner.get(ownerKey(ownerId));
  if (!m) return [];
  return [...m.values()]
    .sort((a, b) => b.provenance.uploadedAt - a.provenance.uploadedAt)
    .slice(0, limit);
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

export function getUKOStoreStats() {
  return {
    owners: byOwner.size,
    objects: [...byOwner.values()].reduce((n, m) => n + m.size, 0),
    cacheEntries: byHash.size,
  };
}

export function _resetUKOStoreForTests() { byOwner.clear(); byHash.clear(); binding._reset(); }
