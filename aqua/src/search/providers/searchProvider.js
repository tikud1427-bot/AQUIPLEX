/**
 * AQUA Web Search — SearchProvider Interface
 *
 * The contract every search provider adapter implements. Mirrors the role
 * modelRegistry/providerErrors play for LLM providers: the SearchRouter and
 * SearchManager program against THIS shape only — Serper/Tavily specifics
 * (endpoints, auth headers, response fields) never leak upward, and a
 * future provider (Brave, Exa, Bing, SearXNG…) plugs in by subclassing
 * this and adding one entry to searchRouter.js's PROVIDERS map. Nothing
 * else in the codebase changes.
 *
 * Normalized result shape every provider MUST return from search():
 *   {
 *     results: [{
 *       title: string,
 *       url: string,
 *       snippet: string,           // provider's extracted text for the hit
 *       position: number,          // 1-based provider rank
 *       score: number|null,        // provider-native relevance 0..1 if given
 *       publishedDate: string|null,// ISO-ish or provider date string
 *       source: string,            // provider name ("serper"|"tavily")
 *     }],
 *     answer: string|null,         // provider's direct answer, if any
 *     raw: object,                 // untouched provider payload (debug only)
 *   }
 *
 * search() throws on failure — errors carry `.status` when HTTP-shaped so
 * searchErrors.classifySearchError() can act. It NEVER swallows errors;
 * retry/fallback policy belongs to the router, not the adapter.
 */

export class SearchProvider {
  /**
   * @param {{ name: string, keyPool: import('./keyPool.js').KeyPool, fetchImpl?: typeof fetch }} opts
   *   fetchImpl — injectable for tests; defaults to global fetch (Node 20+).
   */
  constructor({ name, keyPool, fetchImpl }) {
    if (new.target === SearchProvider) {
      throw new Error('SearchProvider is abstract — subclass it');
    }
    this.name    = name;
    this.keyPool = keyPool;
    this.fetch   = fetchImpl ?? globalThis.fetch;
  }

  /* ── Capability flags (spec) — subclasses override honestly ─────────────── */
  supportsImages()   { return false; }
  supportsNews()     { return false; }
  supportsAcademic() { return false; }

  /**
   * Local health snapshot — key availability + pool stats. Deliberately
   * NETWORK-FREE (deterministic, safe to call from /provider-health at any
   * frequency); live failures are tracked by the router's circuit breaker
   * and the pool's per-key cooldowns, which this surfaces.
   */
  health() {
    return { provider: this.name, configured: this.keyPool.hasKeys(), ...this.keyPool.stats() };
  }

  /* eslint-disable no-unused-vars */
  /**
   * @param {string} query
   * @param {{ key: string, maxResults: number, timeoutMs: number, type?: 'search'|'news'|'images'|'academic', signal?: AbortSignal }} opts
   * @returns {Promise<{ results: object[], answer: string|null, raw: object }>}
   */
  async search(query, opts) {
    throw new Error(`${this.name}: search() not implemented`);
  }
  /* eslint-enable no-unused-vars */

  /** Shared timeout-wrapped fetch. Throws Error with .status for HTTP errors. */
  async _post(url, { key, headers, body, timeoutMs, signal }) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onOuterAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 200); } catch { /* body unreadable — status is enough */ }
        const err = new Error(`${this.name} HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
        err.status = res.status;
        throw err;
      }

      let json;
      try { json = await res.json(); }
      catch {
        const err = new Error(`${this.name} invalid_response: non-JSON body`);
        err.status = null;
        throw err;
      }
      return json;
    } catch (err) {
      if (err.name === 'AbortError' && !signal?.aborted) {
        const t = new Error('TIMEOUT');
        t.name = 'AbortError';
        throw t;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
