/**
 * AQUA Web Search — Provider Router
 *
 * The search-side sibling of src/providers/router.js. Owns the full
 * retry/fallback policy so nothing above it (SearchManager) and nothing
 * below it (provider adapters) duplicates any of this logic:
 *
 *   for each provider in SEARCH_PROVIDER_PRIORITY:        (skip if circuit open)
 *     for up to SEARCH_RETRY_LIMIT distinct keys from its KeyPool:
 *       attempt search
 *       success       → mark key + circuit healthy, return
 *       auth/rate/quota → cool THAT KEY, try next key      (provider blameless)
 *       bad_request     → abort this provider entirely     (same query = same 400)
 *       server/timeout/network → cool key briefly, strike provider, next key
 *     provider exhausted → strike circuit, fall to next provider
 *   all providers exhausted → { ok:false } — caller degrades gracefully,
 *   NEVER an exception. Search failing must never fail a chat request.
 *
 * Circuit breaker: CIRCUIT_THRESHOLD consecutive whole-provider failures
 * opens the circuit for CIRCUIT_OPEN_MS — subsequent queries skip straight
 * to the next provider instead of re-burning keys against a dead service.
 * Any success closes it. Same semantics as core/health.js, kept LOCAL to
 * search so LLM-provider health and search-provider health never mix.
 *
 * Extensibility: add a provider = one KeyPool + one adapter + one PROVIDERS
 * entry. Router logic is provider-count agnostic.
 */

import { KeyPool }             from './keyPool.js';
import { SerperProvider }      from './providers/serperProvider.js';
import { TavilyProvider }      from './providers/tavilyProvider.js';
import { classifySearchError } from './searchErrors.js';

// ── Singleton pools + adapters (module-scope, one per process) ───────────────

const pools = {
  serper: new KeyPool({ name: 'serper', envPrefix: 'SERPER_API_KEY' }),
  tavily: new KeyPool({ name: 'tavily', envPrefix: 'TAVILY_API_KEY' }),
};

const PROVIDERS = {
  serper: new SerperProvider({ keyPool: pools.serper }),
  tavily: new TavilyProvider({ keyPool: pools.tavily }),
};

// ── Circuit breaker state ─────────────────────────────────────────────────────

const CIRCUIT_THRESHOLD = 3;          // consecutive full-provider failures
const CIRCUIT_OPEN_MS   = 60 * 1_000;

const circuits = Object.fromEntries(
  Object.keys(PROVIDERS).map(name => [name, { consecutiveFailures: 0, openUntil: 0 }]),
);

function circuitOpen(name)   { return circuits[name].openUntil > Date.now(); }
function circuitSuccess(name){ circuits[name].consecutiveFailures = 0; circuits[name].openUntil = 0; }
function circuitStrike(name) {
  const c = circuits[name];
  c.consecutiveFailures += 1;
  if (c.consecutiveFailures >= CIRCUIT_THRESHOLD) {
    c.openUntil = Date.now() + CIRCUIT_OPEN_MS;
    console.warn(`[SEARCH:ROUTER] circuit OPEN for ${name} (${c.consecutiveFailures} consecutive failures, ${CIRCUIT_OPEN_MS / 1000}s)`);
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Execute one query across the provider chain. NEVER throws.
 *
 * @param {string} query
 * @param {{
 *   maxResults: number,
 *   timeoutMs: number,
 *   retryLimit: number,
 *   priority: string[],
 *   type?: 'search'|'news'|'images'|'academic',
 *   requestId?: string,
 *   signal?: AbortSignal,
 *   onAttempt?: (info: { provider: string, keySlot: number, attempt: number }) => void,
 *   providersOverride?: Object<string, import('./providers/searchProvider.js').SearchProvider>,  // tests
 * }} opts
 * @returns {Promise<{
 *   ok: boolean,
 *   provider: string|null,
 *   results: object[],
 *   answer: string|null,
 *   latencyMs: number,
 *   attempts: { provider: string, keySlot: number|null, outcome: 'success'|'failed'|'skipped', reason?: string, latencyMs: number|null }[],
 * }>}
 */
export async function routedSearch(query, {
  maxResults, timeoutMs, retryLimit, priority,
  type = 'search', requestId = 'unknown', signal, onAttempt,
  providersOverride,
} = {}) {
  const registry = providersOverride ?? PROVIDERS;
  const attempts = [];
  const started  = Date.now();
  let attemptNo  = 0;

  for (const name of priority) {
    const provider = registry[name];
    if (!provider) continue;                                   // unknown name already warned by config

    if (!provider.keyPool.hasKeys()) {
      attempts.push({ provider: name, keySlot: null, outcome: 'skipped', reason: 'no_keys', latencyMs: null });
      continue;
    }
    if (circuitOpen(name)) {
      attempts.push({ provider: name, keySlot: null, outcome: 'skipped', reason: 'circuit_open', latencyMs: null });
      console.log(`[SEARCH:ROUTER] ${name} skipped — circuit open req=${requestId}`);
      continue;
    }

    // Distinct type support check — e.g. academic on a provider without it.
    const typeOk =
      type === 'search' ||
      (type === 'news'     && provider.supportsNews()) ||
      (type === 'images'   && provider.supportsImages()) ||
      (type === 'academic' && provider.supportsAcademic());
    if (!typeOk) {
      attempts.push({ provider: name, keySlot: null, outcome: 'skipped', reason: `no_${type}_support`, latencyMs: null });
      continue;
    }

    const triedKeys   = new Set();
    const maxAttempts = Math.min(retryLimit, provider.keyPool.size());
    let providerHadSuccess = false;

    for (let k = 0; k < maxAttempts; k++) {
      if (signal?.aborted) {
        attempts.push({ provider: name, keySlot: null, outcome: 'skipped', reason: 'aborted', latencyMs: null });
        return { ok: false, provider: null, results: [], answer: null, latencyMs: Date.now() - started, attempts };
      }

      const slot = provider.keyPool.acquire({ exclude: triedKeys });
      if (!slot) break;                                        // no more usable keys
      triedKeys.add(slot.key);
      attemptNo += 1;

      onAttempt?.({ provider: name, keySlot: slot.index + 1, attempt: attemptNo });
      const t0 = Date.now();

      try {
        const { results, answer } = await provider.search(query, {
          key: slot.key, maxResults, timeoutMs, type, signal,
        });
        const latency = Date.now() - t0;

        provider.keyPool.reportSuccess(slot.key);
        circuitSuccess(name);
        providerHadSuccess = true;

        attempts.push({ provider: name, keySlot: slot.index + 1, outcome: 'success', latencyMs: latency });
        console.log(`[SEARCH:ROUTER] ✓ ${name} key#${slot.index + 1} results=${results.length} latency=${latency}ms req=${requestId}`);

        return { ok: true, provider: name, results, answer, latencyMs: Date.now() - started, attempts };
      } catch (err) {
        const latency    = Date.now() - t0;
        const classified = classifySearchError(err);

        provider.keyPool.reportFailure(slot.key, classified);
        if (classified.providerStrike) { /* counted once per provider below */ }

        attempts.push({ provider: name, keySlot: slot.index + 1, outcome: 'failed', reason: classified.kind, latencyMs: latency });
        console.warn(`[SEARCH:ROUTER] ✗ ${name} key#${slot.index + 1} ${classified.kind} (${String(err.message).slice(0, 120)}) req=${requestId}`);

        if (!classified.retryNextKey) break;                   // bad_request — stop burning keys
      }
    }

    if (!providerHadSuccess) circuitStrike(name);              // whole provider failed this query
  }

  const chain = attempts.map(a => `${a.provider}:${a.outcome}${a.reason ? `(${a.reason})` : ''}`).join(' → ');
  console.warn(`[SEARCH:ROUTER] all providers exhausted req=${requestId} chain=${chain || '(none configured)'}`);
  return { ok: false, provider: null, results: [], answer: null, latencyMs: Date.now() - started, attempts };
}

// ── Introspection ─────────────────────────────────────────────────────────────

/** Full health snapshot for /provider-health — never exposes key material. */
export function getSearchRouterHealth() {
  const now = Date.now();
  return Object.fromEntries(Object.entries(PROVIDERS).map(([name, p]) => {
    const c = circuits[name];
    return [name, {
      ...p.health(),
      capabilities: { images: p.supportsImages(), news: p.supportsNews(), academic: p.supportsAcademic() },
      circuit: {
        open: c.openUntil > now,
        consecutiveFailures: c.consecutiveFailures,
        opensRemainingMs: c.openUntil > now ? c.openUntil - now : 0,
      },
    }];
  }));
}

/** True if at least one provider has at least one key. */
export function searchConfigured() {
  return Object.values(pools).some(p => p.hasKeys());
}

/** Test hook — reset circuits + key runtime state. */
export function __resetSearchRouterForTests() {
  for (const c of Object.values(circuits)) { c.consecutiveFailures = 0; c.openUntil = 0; }
  for (const p of Object.values(pools)) p.__resetForTests();
}
