/**
 * AQUA Web Search — Serper Provider
 *
 * Adapter for serper.dev (Google SERP as JSON).
 *
 * API contract (verified against serper.dev docs, 2026):
 *   POST https://google.serper.dev/{search|news|images|scholar}
 *   Header: X-API-KEY: <key>
 *   Body:   { q: string, num: number }
 *   Response (search): {
 *     organic: [{ title, link, snippet, position, date? }],
 *     answerBox?: { answer? | snippet?, title? },
 *     knowledgeGraph?: { title, type, description? },
 *     news?: [...], peopleAlsoAsk?: [...]
 *   }
 *   Response (news):   { news:    [{ title, link, snippet, date, position }] }
 *   Response (images): { images:  [{ title, imageUrl, link, position }] }
 *   Response (scholar):{ organic: [{ title, link, snippet, ... }] }
 *   Errors: 401/403 bad key · 429 rate limit · credit exhaustion → billing error.
 *
 * Optional blocks (answerBox / knowledgeGraph) are absent for most queries —
 * every access below is defensive.
 */

import { SearchProvider } from './searchProvider.js';

const BASE = 'https://google.serper.dev';

const ENDPOINT_BY_TYPE = {
  search:   '/search',
  news:     '/news',
  images:   '/images',
  academic: '/scholar',
};

export class SerperProvider extends SearchProvider {
  constructor(opts) { super({ ...opts, name: 'serper' }); }

  supportsImages()   { return true; }
  supportsNews()     { return true; }
  supportsAcademic() { return true; }   // /scholar

  /**
   * @param {string} query
   * @param {{ key: string, maxResults: number, timeoutMs: number, type?: string, signal?: AbortSignal }} opts
   */
  async search(query, { key, maxResults, timeoutMs, type = 'search', signal }) {
    const endpoint = ENDPOINT_BY_TYPE[type] ?? ENDPOINT_BY_TYPE.search;

    const raw = await this._post(`${BASE}${endpoint}`, {
      key,
      headers: { 'X-API-KEY': key },
      body:    { q: query, num: maxResults },
      timeoutMs,
      signal,
    });

    // news/images live under their own array names; search/scholar → organic.
    const items = raw.organic ?? raw.news ?? raw.images ?? [];
    if (!Array.isArray(items)) {
      const err = new Error('serper invalid_response: no result array');
      err.status = null;
      throw err;
    }

    const results = items.map((it, i) => ({
      title:         String(it.title ?? '').trim(),
      url:           String(it.link ?? it.imageUrl ?? '').trim(),
      snippet:       String(it.snippet ?? it.description ?? '').trim(),
      position:      Number.isFinite(it.position) ? it.position : i + 1,
      score:         null,                              // Serper gives rank, not score
      publishedDate: it.date ?? null,
      source:        'serper',
    })).filter(r => r.url);

    // Direct answer, best-first: answerBox answer → answerBox snippet →
    // knowledge graph description. All optional.
    const answer =
      raw.answerBox?.answer ??
      raw.answerBox?.snippet ??
      raw.knowledgeGraph?.description ??
      null;

    return { results, answer: answer ? String(answer).trim() : null, raw };
  }
}
