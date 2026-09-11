/**
 * AQUA Web Search — Configuration
 *
 * Single source of truth for every SEARCH_* environment variable. Every
 * value has a production-safe default so the subsystem works with ZERO new
 * env configuration — only the provider API keys (already present:
 * SERPER_API_KEY_1..4 / TAVILY_API_KEY_1..4) are required for search to
 * activate. No keys → search is silently disabled and every request behaves
 * exactly as before this subsystem existed.
 *
 * Read lazily (function, not module-level constants) so tests can mutate
 * process.env between cases — same convention gemini.js's getKeys() uses.
 *
 * Supported variables:
 *   SEARCH_TIMEOUT            per-attempt HTTP timeout in ms        (default 8000)
 *   SEARCH_MAX_RESULTS        results kept after ranking            (default 6)
 *   SEARCH_PROVIDER_PRIORITY  comma list, first = preferred         (default "serper,tavily")
 *   SEARCH_CACHE_TTL          cache entry lifetime in ms            (default 900000 = 15 min)
 *   SEARCH_ENABLE_CACHE       "false"/"0" disables the cache        (default true)
 *   SEARCH_RETRY_LIMIT        max keys tried per provider per query (default 3)
 *   SEARCH_CONTEXT_TOKENS     token budget for the injected block   (default 1200)
 *   SEARCH_CACHE_MAX_ENTRIES  cache size cap (oldest evicted)       (default 200)
 */

const DEFAULTS = {
  SEARCH_TIMEOUT:            8_000,
  SEARCH_MAX_RESULTS:        6,
  SEARCH_PROVIDER_PRIORITY:  'serper,tavily',
  SEARCH_CACHE_TTL:          15 * 60 * 1_000,
  SEARCH_ENABLE_CACHE:       true,
  SEARCH_RETRY_LIMIT:        3,
  SEARCH_CONTEXT_TOKENS:     1_200,
  SEARCH_CACHE_MAX_ENTRIES:  200,
};

function intEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    console.warn(`[SEARCH] Ignoring non-numeric ${name}="${raw}" — using default ${fallback}`);
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(raw.trim().toLowerCase());
}

const KNOWN_PROVIDERS = new Set(['serper', 'tavily']);

/**
 * @returns {{
 *   timeoutMs: number,
 *   maxResults: number,
 *   providerPriority: string[],
 *   cacheTtlMs: number,
 *   cacheEnabled: boolean,
 *   retryLimit: number,
 *   contextTokenBudget: number,
 *   cacheMaxEntries: number,
 * }}
 */
export function getSearchConfig() {
  const priorityRaw = (process.env.SEARCH_PROVIDER_PRIORITY || DEFAULTS.SEARCH_PROVIDER_PRIORITY)
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(Boolean);

  // Unknown provider names are dropped with a warning rather than crashing —
  // a typo in an env var must never take the whole engine down.
  const providerPriority = priorityRaw.filter(p => {
    if (KNOWN_PROVIDERS.has(p)) return true;
    console.warn(`[SEARCH] Unknown provider "${p}" in SEARCH_PROVIDER_PRIORITY — ignored`);
    return false;
  });
  if (!providerPriority.length) providerPriority.push('serper', 'tavily');

  return {
    timeoutMs:          intEnv('SEARCH_TIMEOUT',           DEFAULTS.SEARCH_TIMEOUT,           { min: 500, max: 60_000 }),
    maxResults:         intEnv('SEARCH_MAX_RESULTS',       DEFAULTS.SEARCH_MAX_RESULTS,       { min: 1,   max: 20 }),
    providerPriority,
    cacheTtlMs:         intEnv('SEARCH_CACHE_TTL',         DEFAULTS.SEARCH_CACHE_TTL,         { min: 1_000 }),
    cacheEnabled:       boolEnv('SEARCH_ENABLE_CACHE',     DEFAULTS.SEARCH_ENABLE_CACHE),
    retryLimit:         intEnv('SEARCH_RETRY_LIMIT',       DEFAULTS.SEARCH_RETRY_LIMIT,       { min: 1,   max: 10 }),
    contextTokenBudget: intEnv('SEARCH_CONTEXT_TOKENS',    DEFAULTS.SEARCH_CONTEXT_TOKENS,    { min: 200, max: 6_000 }),
    cacheMaxEntries:    intEnv('SEARCH_CACHE_MAX_ENTRIES', DEFAULTS.SEARCH_CACHE_MAX_ENTRIES, { min: 10,  max: 5_000 }),
  };
}
