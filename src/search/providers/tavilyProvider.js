/**
 * AQUA Web Search — Tavily Provider
 *
 * Adapter for tavily.com (LLM-native search).
 *
 * API contract (verified against docs.tavily.com, 2026):
 *   POST https://api.tavily.com/search
 *   Header: Authorization: Bearer <tvly-key>
 *   Body:   { query, max_results, search_depth: 'basic'|'advanced',
 *             include_answer: boolean, topic?: 'general'|'news'|'finance',
 *             include_images?: boolean }
 *   Response: {
 *     answer?: string,
 *     results: [{ title, url, content, score, published_date? }],
 *     images?: [...], response_time
 *   }
 *   Errors: 401/403 bad key · 429 rate limit · 432/insufficient credits.
 *
 * Query length: Tavily recommends < 400 chars — SearchManager's query
 * builder already caps at 380, so no truncation logic needed here.
 */

import { SearchProvider } from './searchProvider.js';

const BASE = 'https://api.tavily.com';

export class TavilyProvider extends SearchProvider {
  constructor(opts) { super({ ...opts, name: 'tavily' }); }

  supportsImages()   { return true; }    // include_images flag
  supportsNews()     { return true; }    // topic: 'news'
  supportsAcademic() { return false; }   // no scholar-equivalent endpoint

  /**
   * @param {string} query
   * @param {{ key: string, maxResults: number, timeoutMs: number, type?: string, signal?: AbortSignal }} opts
   */
  async search(query, { key, maxResults, timeoutMs, type = 'search', signal }) {
    const body = {
      query,
      max_results:    maxResults,
      search_depth:   'basic',      // 'advanced' costs 2× credits — basic is
      include_answer: true,         // right for chat-context injection
    };
    if (type === 'news')   body.topic = 'news';
    if (type === 'images') body.include_images = true;

    const raw = await this._post(`${BASE}/search`, {
      key,
      headers: { Authorization: `Bearer ${key}` },
      body,
      timeoutMs,
      signal,
    });

    const items = raw.results;
    if (!Array.isArray(items)) {
      const err = new Error('tavily invalid_response: no results array');
      err.status = null;
      throw err;
    }

    const results = items.map((it, i) => ({
      title:         String(it.title ?? '').trim(),
      url:           String(it.url ?? '').trim(),
      snippet:       String(it.content ?? '').trim(),
      position:      i + 1,
      score:         Number.isFinite(it.score) ? it.score : null,   // native 0..1
      publishedDate: it.published_date ?? null,
      source:        'tavily',
    })).filter(r => r.url);

    return { results, answer: raw.answer ? String(raw.answer).trim() : null, raw };
  }
}
