/**
 * AQUA File Search Index — File Intelligence V1
 *
 * Per-owner inverted indices over UKO knowledge: entity → files,
 * keyword → files, plus a file registry for hydration. This is the SEARCH
 * PREPARATION layer the brief requires — the interfaces
 * (searchByEntity / searchByKeyword / searchFiles) exist and are indexed
 * from day one, while cross-file REASONING over the results stays a later
 * phase. Semantic search remains fileMemory (embeddings); this module adds
 * the keyword/entity lanes → hybrid search = both, merged by the caller.
 *
 * Persistence: same primitives as every store (atomicStore + dataDir),
 * bounded per owner (newest files win), schema-versioned.
 */
import {
  createDebouncedWriter, loadJsonFile, wrapStore, unwrapStore,
} from '../core/atomicStore.js';
import { dataPath } from '../core/dataDir.js';

const STORE_FILE = dataPath('.aqua-fileindex.json');
const SCHEMA     = 1;

const MAX_FILES_PER_OWNER = 200;   // eviction horizon — oldest indexed file drops first
const MAX_TERM_LENGTH     = 80;

/** ownerId → { files: Map<ukoId,{name,kind,conversationId,indexedAt}>, entities: Map<value,Set<ukoId>>, keywords: Map<term,Set<ukoId>> } */
const store = new Map();

// ── Persistence ──────────────────────────────────────────────────────────────

function loadFromDisk() {
  const parsed = loadJsonFile(STORE_FILE, { label: 'fileindex' });
  if (parsed == null) return;
  const { data } = unwrapStore(parsed, { expected: SCHEMA, file: STORE_FILE, label: 'fileindex' });
  if (!data || typeof data !== 'object') return;
  for (const [owner, o] of Object.entries(data)) {
    store.set(owner, {
      files:    new Map(Object.entries(o.files ?? {})),
      entities: new Map(Object.entries(o.entities ?? {}).map(([k, v]) => [k, new Set(v)])),
      keywords: new Map(Object.entries(o.keywords ?? {}).map(([k, v]) => [k, new Set(v)])),
    });
  }
  if (store.size) console.log(`[FILES] Search index loaded for ${store.size} owner(s) from ${STORE_FILE}`);
}

const _writer = createDebouncedWriter(STORE_FILE);
function scheduleSave() {
  _writer.schedule(() => {
    const data = {};
    for (const [owner, o] of store.entries()) {
      data[owner] = {
        files:    Object.fromEntries(o.files),
        entities: Object.fromEntries([...o.entities].map(([k, v]) => [k, [...v]])),
        keywords: Object.fromEntries([...o.keywords].map(([k, v]) => [k, [...v]])),
      };
    }
    return JSON.stringify(wrapStore(SCHEMA, data));
  });
}

loadFromDisk();

function ownerIndex(ownerId) {
  let o = store.get(ownerId);
  if (!o) {
    o = { files: new Map(), entities: new Map(), keywords: new Map() };
    store.set(ownerId, o);
  }
  return o;
}

const norm = (s) => String(s).toLowerCase().trim().slice(0, MAX_TERM_LENGTH);

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Index one UKO's knowledge for its owner. Idempotent per ukoId (re-index
 * replaces). Bounded: past MAX_FILES_PER_OWNER the oldest file is evicted
 * from every lane.
 */
export function indexUKO(ownerId, uko) {
  if (!ownerId || !uko?.id) return { indexed: false };
  const o = ownerIndex(ownerId);

  if (o.files.has(uko.id)) removeFromLanes(o, uko.id);
  if (o.files.size >= MAX_FILES_PER_OWNER) {
    const oldest = [...o.files.entries()].sort((a, b) => a[1].indexedAt - b[1].indexedAt)[0]?.[0];
    if (oldest) { removeFromLanes(o, oldest); o.files.delete(oldest); }
  }

  o.files.set(uko.id, {
    name: uko.sourceFile.name, kind: uko.fileType,
    conversationId: uko.conversation ?? null, indexedAt: Date.now(),
  });
  for (const e of uko.entities)  addToLane(o.entities, norm(e.value), uko.id);
  for (const k of uko.keywords)  addToLane(o.keywords, norm(k.term),  uko.id);

  scheduleSave();
  return { indexed: true, entities: uko.entities.length, keywords: uko.keywords.length };
}

function addToLane(lane, key, ukoId) {
  if (!key) return;
  const set = lane.get(key) ?? new Set();
  set.add(ukoId);
  lane.set(key, set);
}

function removeFromLanes(o, ukoId) {
  for (const lane of [o.entities, o.keywords]) {
    for (const [key, set] of lane) {
      set.delete(ukoId);
      if (!set.size) lane.delete(key);
    }
  }
}

export function removeUKOFromIndex(ownerId, ukoId) {
  const o = store.get(ownerId);
  if (!o || !o.files.has(ukoId)) return false;
  removeFromLanes(o, ukoId);
  o.files.delete(ukoId);
  scheduleSave();
  return true;
}

/**
 * Account deletion — drop an owner's whole index (files + entity/keyword
 * lanes). Returns the number of indexed files removed.
 */
export function purgeOwner(ownerId) {
  const o = store.get(ownerId);
  if (!o) return 0;
  const removed = o.files.size;
  store.delete(ownerId);
  scheduleSave();
  return removed;
}

// ── Query interfaces (search phases build on these) ──────────────────────────

function hydrate(o, ids) {
  return [...ids].map(id => ({ ukoId: id, ...(o.files.get(id) ?? {}) })).filter(f => f.name);
}

/** Exact entity-value lookup: "which files mention NVIDIA?" */
export function searchByEntity(ownerId, value) {
  const o = store.get(ownerId);
  if (!o) return [];
  return hydrate(o, o.entities.get(norm(value)) ?? new Set());
}

/** Exact keyword lookup. */
export function searchByKeyword(ownerId, term) {
  const o = store.get(ownerId);
  if (!o) return [];
  return hydrate(o, o.keywords.get(norm(term)) ?? new Set());
}

/**
 * Multi-term OR search across both lanes with per-file hit scoring —
 * the keyword half of future hybrid search. Not reasoning: just retrieval.
 */
export function searchFiles(ownerId, query, { limit = 10 } = {}) {
  const o = store.get(ownerId);
  if (!o || !query) return [];
  const terms = [...String(query).matchAll(/[A-Za-z0-9][\w\-.]{1,}/g)].map(m => norm(m[0]));
  if (!terms.length) return [];

  const scores = new Map(); // ukoId → hits
  for (const t of terms) {
    for (const lane of [o.entities, o.keywords]) {
      for (const id of lane.get(t) ?? []) scores.set(id, (scores.get(id) ?? 0) + 1);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, hits]) => ({ ukoId: id, hits, ...(o.files.get(id) ?? {}) }))
    .filter(f => f.name);
}

export function getIndexStats(ownerId) {
  const o = store.get(ownerId);
  if (!o) return { files: 0, entities: 0, keywords: 0 };
  return { files: o.files.size, entities: o.entities.size, keywords: o.keywords.size };
}

export function _resetFileIndexForTests() { store.clear(); }
