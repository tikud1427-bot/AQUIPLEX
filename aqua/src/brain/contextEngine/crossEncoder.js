/**
 * AQUA E7 PR-8 — model-backed cross-encoder adapter.
 *
 * Uses the Hugging Face Inference API's text-classification interface. The
 * adapter is opt-in: constructing it requires an explicit token/model.
 * No model call is made at import time.
 *
 * The model is expected to score a (query, candidate text) pair. The default
 * is Xenova/ms-marco-MiniLM-L-6-v2, an ONNX/Transformers-compatible MS MARCO
 * cross-encoder.
 */

const DEFAULT_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
const DEFAULT_CACHE_SIZE = 512;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

function candidateText(candidate) {
  return String(
    candidate?.statement ??
    candidate?.text ??
    candidate?.entity ??
    candidate?.label ??
    '',
  ).trim();
}

function scoreFromResponse(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('cross-encoder response contained no scores');

  // Text-classification responses are normally [{label, score}]. Some
  // deployments wrap a single result; accept both shapes but never guess.
  const scored = rows.filter(x => Number.isFinite(Number(x?.score)));
  if (!scored.length) throw new Error('cross-encoder response contained no finite score');

  // For a single-label relevance model this is the relevance score. For a
  // multi-label response, prefer a relevance/positive label when present.
  const positive = scored.find(x => /^(relevant|positive|entailment|1)$/i.test(String(x.label)));
  return Number((positive ?? scored[0]).score);
}

export function createHuggingFaceCrossEncoder({
  token = process.env.HF_TOKEN ?? process.env.HUGGINGFACEHUB_API_TOKEN ?? '',
  model = process.env.AQUA_CROSS_ENCODER_MODEL ?? DEFAULT_MODEL,
  timeoutMs = Number(process.env.AQUA_CROSS_ENCODER_TIMEOUT_MS ?? 2500),
  fetchImpl = globalThis.fetch,
  cacheSize = Number(process.env.AQUA_CROSS_ENCODER_CACHE_SIZE ?? DEFAULT_CACHE_SIZE),
  cacheTtlMs = Number(process.env.AQUA_CROSS_ENCODER_CACHE_TTL_MS ?? DEFAULT_CACHE_TTL_MS),
} = {}) {
  if (!token) throw new Error('HF_TOKEN is required to enable the cross-encoder adapter');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required for the cross-encoder adapter');

  const endpoint = `https://router.huggingface.co/hf-inference/models/${encodeURIComponent(model)}`;
  const timeout = Math.max(250, Number.isFinite(timeoutMs) ? timeoutMs : 2500);
  const maxCache = Math.max(0, Number.isFinite(cacheSize) ? Math.floor(cacheSize) : DEFAULT_CACHE_SIZE);
  const ttl = Math.max(0, Number.isFinite(cacheTtlMs) ? cacheTtlMs : DEFAULT_CACHE_TTL_MS);
  // Small bounded LRU: reranking the same question/candidate pair across
  // adjacent turns should not pay the provider latency twice. Cache is an
  // optimization only; failures are never cached.
  const cache = new Map();
  function cacheKey(query, text) { return `${model}\0${String(query)}\0${text}`; }
  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (ttl > 0 && Date.now() - hit.at > ttl) { cache.delete(key); return null; }
    cache.delete(key); cache.set(key, hit);
    return hit.score;
  }
  function cacheSet(key, score) {
    if (!maxCache) return;
    cache.delete(key); cache.set(key, { score, at: Date.now() });
    while (cache.size > maxCache) cache.delete(cache.keys().next().value);
  }

  return {
    model,
    cacheStats() { return { size: cache.size, maxSize: maxCache, ttlMs: ttl }; },
    clearCache() { cache.clear(); },
    async scorePair(query, candidate) {
      const text = candidateText(candidate);
      if (!String(query).trim() || !text) throw new Error('cross-encoder pair requires query and candidate text');
      const key = cacheKey(query, text);
      const cached = cacheGet(key);
      if (cached !== null) return cached;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ inputs: { text: String(query), text_pair: text } }),
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          const detail = body?.error ? `: ${body.error}` : '';
          throw new Error(`cross-encoder HTTP ${response.status}${detail}`);
        }
        const score = scoreFromResponse(body);
        cacheSet(key, score);
        return score;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export { DEFAULT_MODEL };
