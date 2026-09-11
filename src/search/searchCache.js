/**
 * AQUA Web Search — Cache
 *
 * In-memory TTL cache keyed by NORMALIZED query. Its whole job is to cut
 * API credit burn: the same question asked twice inside the TTL window
 * (very common — user rephrases, retries after a network blip, or a second
 * user asks the same trending question) costs zero provider credits the
 * second time.
 *
 *   • Key           — normalizeQuery(): lowercase, punctuation stripped,
 *                     whitespace collapsed, terms SORTED so "node 22 release
 *                     date" and "release date node 22" share one entry.
 *                     Search type is part of the key (news ≠ web).
 *   • TTL           — SEARCH_CACHE_TTL (default 15 min), checked on read;
 *                     expired entries are deleted lazily on access.
 *   • Size cap      — SEARCH_CACHE_MAX_ENTRIES; oldest-inserted evicted
 *                     first (Map preserves insertion order).
 *   • Invalidation  — invalidate(query) for one entry, clear() for all.
 *   • Stats         — hits/misses/evictions for /provider-health.
 *
 * Toggle: SEARCH_ENABLE_CACHE=false bypasses reads AND writes.
 * Zero dependencies; process-local by design (same tier as the
 * conversation store — a shared cache is a Sprint-scale concern and this
 * module's API won't need to change to back it with Redis later).
 */

/** @type {Map<string, { value: object, expiresAt: number, storedAt: number }>} */
const store = new Map();

const stats = { hits: 0, misses: 0, evictions: 0, sets: 0 };

/**
 * Canonical cache key for a query. Exported for tests + manager logging.
 * @param {string} query
 * @param {string} [type]
 */
export function normalizeQuery(query, type = 'search') {
  const terms = String(query ?? '')
    .toLowerCase()
    .replace(/["'`.,!?;:()[\]{}<>]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort();
  return `${type}::${terms.join(' ')}`;
}

/**
 * @param {string} normalizedKey
 * @returns {object|null}  cached value, or null on miss/expiry
 */
export function cacheGet(normalizedKey) {
  const entry = store.get(normalizedKey);
  if (!entry) { stats.misses += 1; return null; }
  if (entry.expiresAt <= Date.now()) {
    store.delete(normalizedKey);
    stats.misses += 1;
    return null;
  }
  stats.hits += 1;
  return entry.value;
}

/**
 * @param {string} normalizedKey
 * @param {object} value
 * @param {{ ttlMs: number, maxEntries: number }} opts
 */
export function cacheSet(normalizedKey, value, { ttlMs, maxEntries }) {
  // Re-setting refreshes both TTL and insertion order (delete-then-set).
  store.delete(normalizedKey);
  while (store.size >= maxEntries) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
    stats.evictions += 1;
  }
  store.set(normalizedKey, { value, expiresAt: Date.now() + ttlMs, storedAt: Date.now() });
  stats.sets += 1;
}

/**
 * Invalidate one query (any phrasing that normalizes to the same key) or,
 * with no argument, the entire cache.
 * @param {string} [query]
 * @param {string} [type]
 * @returns {number} entries removed
 */
export function cacheInvalidate(query, type = 'search') {
  if (query === undefined) {
    const n = store.size;
    store.clear();
    return n;
  }
  return store.delete(normalizeQuery(query, type)) ? 1 : 0;
}

export function cacheStats() {
  return { size: store.size, ...stats };
}

/** Test hook. */
export function __resetSearchCacheForTests() {
  store.clear();
  stats.hits = 0; stats.misses = 0; stats.evictions = 0; stats.sets = 0;
}
