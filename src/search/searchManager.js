/**
 * AQUA Web Search — SearchManager
 *
 * The ONE entry point the rest of AQUA talks to. chat.js (via the
 * 'web_search' agent) calls performSearch() and receives either a ready
 * prompt block or a clean "not used" result — it never sees providers,
 * keys, retries, ranking, or cache internals, exactly as the spec's
 * "Never expose provider logic elsewhere" demands.
 *
 * Pipeline per query:
 *   buildSearchQuery → cache check ──hit──▶ return cached (zero credits)
 *                          │ miss
 *                          ▼
 *   routedSearch (provider priority → key pool → circuit breaker)
 *                          ▼
 *   rankResults (dedupe + deterministic scoring)
 *                          ▼
 *   extractSearchContext (compress to token budget)
 *                          ▼
 *   cache store → return { contextBlock, sources, meta }
 *
 * GUARANTEE: performSearch() NEVER throws. Every internal failure —
 * misconfiguration, all providers down, malformed responses — degrades to
 * { used:false, reason } and the chat pipeline proceeds exactly as if
 * search did not exist. Search can only ever ADD context, never break a
 * request.
 *
 * Progress: onStage(id, label) fires for each REAL sub-stage as it starts
 * (search / search_provider / search_rank / search_context) — the same
 * contract prepareTurn() already streams to the UI, so the existing
 * pre-built frontend renders these with zero changes.
 */

import { getSearchConfig }                      from './searchConfig.js';
import { routedSearch, searchConfigured, getSearchRouterHealth } from './searchRouter.js';
import { normalizeQuery, cacheGet, cacheSet, cacheInvalidate, cacheStats } from './searchCache.js';
import { rankResults }                          from './resultRanker.js';
import { extractSearchContext }                 from './contextExtractor.js';
import { buildSearchQuery }                     from './searchDecision.js';

const PROVIDER_LABELS = { serper: 'Serper', tavily: 'Tavily' };

/**
 * @param {{
 *   userMessage: string,
 *   taskType?: string,
 *   type?: 'search'|'news'|'images'|'academic',
 *   requestId?: string,
 *   signal?: AbortSignal,
 *   onStage?: (id: string, label: string) => void,
 *   providersOverride?: object,   // tests only — injected into routedSearch
 * }} input
 * @returns {Promise<{
 *   used: boolean,
 *   cached: boolean,
 *   provider: string|null,
 *   query: string,
 *   normalizedQuery: string,
 *   results: object[],
 *   answer: string|null,
 *   contextBlock: string,
 *   contextTokens: number,
 *   sources: { n:number, title:string, url:string }[],
 *   latencyMs: number,
 *   attempts: object[],
 *   reason?: string,
 * }>}
 */
export async function performSearch({
  userMessage, taskType = 'research', type = 'search',
  requestId = 'unknown', signal, onStage = () => {}, providersOverride,
} = {}) {
  const started = Date.now();
  const empty = (reason) => ({
    used: false, cached: false, provider: null,
    query: '', normalizedQuery: '', results: [], answer: null,
    contextBlock: '', contextTokens: 0, sources: [],
    latencyMs: Date.now() - started, attempts: [], reason,
  });

  try {
    const cfg = getSearchConfig();

    if (!providersOverride && !searchConfigured()) {
      return empty('no search provider keys configured');
    }

    const query = buildSearchQuery(userMessage);
    if (!query) return empty('empty query after normalization');
    const normalizedQuery = normalizeQuery(query, type);

    onStage('search', '🔍 Searching the web…');
    console.log(`[SEARCH] query="${query.slice(0, 120)}" type=${type} task=${taskType} req=${requestId}`);

    // ── Cache ────────────────────────────────────────────────────────────────
    if (cfg.cacheEnabled) {
      const hit = cacheGet(normalizedQuery);
      if (hit) {
        console.log(`[SEARCH] cache HIT key="${normalizedQuery.slice(0, 80)}" req=${requestId}`);
        onStage('search_context', '📝 Building context from cached results…');
        return { ...hit, cached: true, latencyMs: Date.now() - started };
      }
    }

    // ── Provider chain ───────────────────────────────────────────────────────
    const routed = await routedSearch(query, {
      maxResults: cfg.maxResults,
      timeoutMs:  cfg.timeoutMs,
      retryLimit: cfg.retryLimit,
      priority:   cfg.providerPriority,
      type, requestId, signal, providersOverride,
      onAttempt: ({ provider }) =>
        onStage('search_provider', `🌐 Using ${PROVIDER_LABELS[provider] ?? provider}…`),
    });

    if (!routed.ok) {
      // Spec: Serper fails → Tavily → still fails → CONTINUE WITHOUT SEARCH.
      return { ...empty('all search providers failed'), attempts: routed.attempts };
    }

    // ── Rank ─────────────────────────────────────────────────────────────────
    onStage('search_rank', '📑 Ranking sources…');
    const ranked = rankResults(routed.results, query, { maxResults: cfg.maxResults });

    // ── Extract + compress ───────────────────────────────────────────────────
    onStage('search_context', '📝 Building context…');
    const { block, tokens, sources, usedResults } = extractSearchContext(
      ranked, routed.answer, query, { tokenBudget: cfg.contextTokenBudget },
    );

    const payload = {
      used: !!block,
      cached: false,
      provider: routed.provider,
      query, normalizedQuery,
      results: usedResults.map(({ raw, ...r }) => r),   // raw payloads never leave this module
      answer: routed.answer,
      contextBlock: block,
      contextTokens: tokens,
      sources,
      latencyMs: Date.now() - started,
      attempts: routed.attempts,
    };

    if (!block) {
      payload.reason = 'providers returned no usable results';
      return payload;                                    // empty results are not cached
    }

    if (cfg.cacheEnabled) {
      cacheSet(normalizedQuery, payload, { ttlMs: cfg.cacheTtlMs, maxEntries: cfg.cacheMaxEntries });
    }
    console.log(`[SEARCH] ✓ provider=${payload.provider} sources=${sources.length} tokens=${tokens} latency=${payload.latencyMs}ms req=${requestId}`);
    return payload;
  } catch (err) {
    // Absolute backstop — the spec's "Never crash".
    console.error(`[SEARCH] performSearch failed open (${err.message}) req=${requestId}`);
    return empty(`internal search error: ${err.message}`);
  }
}

// ── Introspection / management ────────────────────────────────────────────────

/** Composite health for /provider-health. */
export function getSearchHealth() {
  const cfg = getSearchConfig();
  return {
    enabled: searchConfigured(),
    config: {
      timeoutMs: cfg.timeoutMs,
      maxResults: cfg.maxResults,
      providerPriority: cfg.providerPriority,
      retryLimit: cfg.retryLimit,
      cache: { enabled: cfg.cacheEnabled, ttlMs: cfg.cacheTtlMs, maxEntries: cfg.cacheMaxEntries },
      contextTokenBudget: cfg.contextTokenBudget,
    },
    providers: getSearchRouterHealth(),
    cache: cacheStats(),
  };
}

/** Invalidate one cached query (any phrasing) or the whole cache. */
export function invalidateSearchCache(query, type = 'search') {
  const removed = cacheInvalidate(query, type);
  console.log(`[SEARCH] cache invalidated ${query === undefined ? 'ALL' : `"${query}"`} (${removed} entr${removed === 1 ? 'y' : 'ies'})`);
  return removed;
}
