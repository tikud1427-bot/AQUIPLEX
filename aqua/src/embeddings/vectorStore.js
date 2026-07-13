/**
 * AQUA Vector Store (Phase 2 — semantic retrieval)
 * ─────────────────────────────────────────────────────────────────────────────
 * Namespaced in-memory vector index with the SAME persistence tier as the rest
 * of AQUA (mindStore / projectIndex / conversationStore): an in-process Map +
 * debounced whole-file JSON write, loaded once on boot. Deliberately mirrors
 * that proven pattern so this slots into the existing architecture with no new
 * concepts and no new dependencies.
 *
 *   namespace  — an owner/workspace scope key. Facts use the memory ownerId
 *                (`user:<id>` / `conv:<id>`); future callers (project chunks)
 *                can use a workspaceId. Vectors never cross namespaces.
 *   id         — a stable item id within the namespace (a fact key today).
 *   hash       — content hash of the embedded text. Lets callers skip
 *                re-embedding unchanged items (has(ns, id, hash)).
 *
 * cosineSim + topK are pure. scoreAgainst() returns a Map<id, cosine> for a
 * query vector — the shape the memory retriever blends into its existing score.
 *
 * ── Scaling / migration (Phase 3) ────────────────────────────────────────────
 * All access goes through this module's API, so swapping the Map+JSON tier for
 * pgvector (the Phase 3 Postgres migration) touches ONLY this file — exactly
 * the single-swap-point property every other AQUA store was built with. The
 * persisted file holds raw float arrays; it is bounded per namespace by
 * NS_ITEM_CAP, and fact namespaces are small (tens of items). Large corpora
 * (project chunks) should move to pgvector rather than grow this JSON file —
 * noted here so the boundary is explicit.
 */
import fs   from 'fs';
import path from 'path';
import { createDebouncedWriter } from '../core/atomicStore.js';

const STORE_FILE  = path.join(process.cwd(), '.aqua-vectors.json');
const NS_ITEM_CAP = 500;   // per-namespace item cap (oldest-touched evicted)

// namespace → Map<id, { vec:number[], hash:string, ts:number, dim:number }>
const store = new Map();
let loaded = false;
let persist = true;   // disabled in tests to avoid touching disk

function loadFromDisk() {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    for (const [ns, items] of Object.entries(data)) {
      const m = new Map();
      for (const [id, rec] of Object.entries(items)) {
        if (Array.isArray(rec?.vec)) m.set(id, rec);
      }
      store.set(ns, m);
    }
    console.log(`[VECTORS] Loaded ${store.size} namespace(s) from disk`);
  } catch (err) {
    console.warn('[VECTORS] Could not load from disk:', err.message);
  }
}

// Phase 3b — atomic + async persistence via the shared primitive; persist flag
// (disabled in tests) preserved.
const _writer = createDebouncedWriter(STORE_FILE);
function scheduleSave() {
  if (!persist) return;
  _writer.schedule(() => {
    const data = {};
    for (const [ns, m] of store.entries()) data[ns] = Object.fromEntries(m.entries());
    return JSON.stringify(data);
  });
}
loadFromDisk();

// ── Namespace helpers ─────────────────────────────────────────────────────────
function ns(namespace) {
  let m = store.get(namespace);
  if (!m) { m = new Map(); store.set(namespace, m); }
  return m;
}

function enforceCap(m) {
  if (m.size <= NS_ITEM_CAP) return;
  const sorted = [...m.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
  while (sorted.length > NS_ITEM_CAP) { const [id] = sorted.shift(); m.delete(id); }
}

// ── Write ─────────────────────────────────────────────────────────────────────
/** Insert/replace a vector for (namespace, id). No-op on a null/empty vector. */
export function upsert(namespace, id, vec, hash = '') {
  if (!namespace || !id || !Array.isArray(vec) || !vec.length) return;
  const m = ns(namespace);
  m.set(id, { vec, hash, ts: Date.now(), dim: vec.length });
  enforceCap(m);
  scheduleSave();
}

/** True when (namespace, id) already holds a vector for this exact content hash. */
export function has(namespace, id, hash) {
  const rec = store.get(namespace)?.get(id);
  return !!rec && (hash === undefined || rec.hash === hash);
}

export function getVec(namespace, id) {
  return store.get(namespace)?.get(id)?.vec ?? null;
}

export function remove(namespace, id) {
  const m = store.get(namespace);
  if (m?.delete(id)) scheduleSave();
}

export function clearNamespace(namespace) {
  if (store.delete(namespace)) scheduleSave();
}

/** Ids currently held for a namespace (e.g. to prune facts that were deleted). */
export function idsIn(namespace) {
  return [...(store.get(namespace)?.keys() ?? [])];
}

// ── Similarity ────────────────────────────────────────────────────────────────
/** Cosine similarity. Returns 0 for mismatched/degenerate vectors. */
export function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Cosine of a query vector against every stored vector in a namespace.
 * @returns {Map<id, number>} id → cosine (empty Map if namespace empty / bad query)
 */
export function scoreAgainst(namespace, queryVec) {
  const out = new Map();
  const m = store.get(namespace);
  if (!m || !Array.isArray(queryVec) || !queryVec.length) return out;
  for (const [id, rec] of m.entries()) out.set(id, cosineSim(queryVec, rec.vec));
  return out;
}

/** Top-K (id, score) by cosine, optionally filtered by a minimum score. */
export function topK(namespace, queryVec, k = 10, minScore = -Infinity) {
  return [...scoreAgainst(namespace, queryVec).entries()]
    .filter(([, s]) => s >= minScore)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id, score]) => ({ id, score }));
}

// ── Test-only ─────────────────────────────────────────────────────────────────
export function __resetForTests({ disablePersist = true } = {}) {
  store.clear();
  persist = !disablePersist;
  _writer.cancel();
}
