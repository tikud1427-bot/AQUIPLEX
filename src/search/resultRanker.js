/**
 * AQUA Web Search — Result Ranker
 *
 * Turns raw provider hits into the best few results, deterministically
 * (same inputs → same order, no LLM, no I/O — the orchestrator-purity
 * convention this codebase holds everywhere).
 *
 * 1) DEDUPE by canonical URL — protocol dropped, host lowercased, `www.`
 *    stripped, tracking params (utm_*, fbclid, gclid, ref) removed,
 *    fragment removed, trailing slash trimmed. When duplicates collide the
 *    higher-scoring copy wins (so a Tavily hit with a rich snippet beats a
 *    Serper hit for the same page, or vice versa).
 *
 * 2) SCORE each result 0..~150:
 *      base       — provider-native score×100 when present (Tavily), else
 *                   position decay: 100 − (position−1)×8, floor 20.
 *      term match — query terms found in title (+6 each) / snippet (+2
 *                   each), capped at +30. Stop-words excluded.
 *      freshness  — parseable publishedDate: ≤7d +15, ≤30d +8, ≤365d +3.
 *      authority  — official-docs style domains (+10): docs.*, developer.*,
 *                   *.dev official lists below, github.com, MDN,
 *                   stackoverflow, wikipedia, arxiv, python/nodejs/react…
 *
 * 3) SORT desc, CAP to maxResults.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on',
  'for', 'and', 'or', 'what', 'when', 'who', 'how', 'why', 'which', 'with',
  'do', 'does', 'did', 'can', 'about', 'latest', 'current', 'new', 'me', 'i',
]);

const AUTHORITY_HOSTS = new Set([
  'github.com', 'stackoverflow.com', 'developer.mozilla.org', 'wikipedia.org',
  'en.wikipedia.org', 'arxiv.org', 'nodejs.org', 'python.org', 'react.dev',
  'nextjs.org', 'developer.apple.com', 'learn.microsoft.com', 'cloud.google.com',
  'aws.amazon.com', 'kubernetes.io', 'npmjs.com', 'www.npmjs.com', 'pypi.org',
  'developers.google.com', 'web.dev', 'go.dev', 'rust-lang.org', 'postgresql.org',
  'mongodb.com', 'redis.io', 'docker.com', 'docs.docker.com',
]);

const AUTHORITY_PREFIXES = ['docs.', 'developer.', 'devdocs.', 'api.'];

/**
 * Canonical form of a URL for dedupe. Exported for tests.
 * @param {string} url
 */
export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase().replace(/^www\./, '');
    const params = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      const key = k.toLowerCase();
      if (key.startsWith('utm_') || ['fbclid', 'gclid', 'ref', 'ref_src', 'igshid'].includes(key)) continue;
      params.append(k, v);
    }
    const qs   = params.toString();
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${host}${path}${qs ? `?${qs}` : ''}`;
  } catch {
    return String(url ?? '').trim().toLowerCase();
  }
}

function queryTerms(query) {
  return [...new Set(
    String(query ?? '')
      .toLowerCase()
      .split(/[^a-z0-9.+#-]+/i)
      .filter(t => t.length > 1 && !STOP_WORDS.has(t)),
  )];
}

function freshnessBoost(publishedDate, now) {
  if (!publishedDate) return 0;
  const ts = Date.parse(publishedDate);
  if (!Number.isFinite(ts)) return 0;
  const days = (now - ts) / 86_400_000;
  if (days < 0) return 0;         // future-dated junk
  if (days <= 7)   return 15;
  if (days <= 30)  return 8;
  if (days <= 365) return 3;
  return 0;
}

function authorityBoost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (AUTHORITY_HOSTS.has(host)) return 10;
    if (AUTHORITY_PREFIXES.some(p => host.startsWith(p))) return 10;
  } catch { /* unparseable URL — no boost */ }
  return 0;
}

/**
 * @param {object[]} results  normalized provider results (see searchProvider.js)
 * @param {string}   query
 * @param {{ maxResults: number, now?: number }} opts  now injectable for tests
 * @returns {object[]}  deduped, scored (result.rankScore), sorted, capped
 */
export function rankResults(results, query, { maxResults, now = Date.now() } = {}) {
  const terms = queryTerms(query);

  const scored = (results ?? []).filter(r => r?.url).map((r) => {
    const base = Number.isFinite(r.score) && r.score !== null
      ? r.score * 100
      : Math.max(20, 100 - ((r.position ?? 1) - 1) * 8);

    const title   = (r.title ?? '').toLowerCase();
    const snippet = (r.snippet ?? '').toLowerCase();
    let termScore = 0;
    for (const t of terms) {
      if (title.includes(t))   termScore += 6;
      if (snippet.includes(t)) termScore += 2;
    }
    termScore = Math.min(30, termScore);

    const rankScore = base + termScore + freshnessBoost(r.publishedDate, now) + authorityBoost(r.url);
    return { ...r, rankScore: Math.round(rankScore * 10) / 10 };
  });

  // Dedupe — keep the highest-scoring copy of each canonical URL.
  const byCanonical = new Map();
  for (const r of scored) {
    const key  = canonicalUrl(r.url);
    const kept = byCanonical.get(key);
    if (!kept || r.rankScore > kept.rankScore) byCanonical.set(key, r);
  }

  return [...byCanonical.values()]
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, maxResults);
}
