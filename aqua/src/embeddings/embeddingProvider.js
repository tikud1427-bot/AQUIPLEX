/**
 * AQUA Embedding Provider (Phase 2 — semantic retrieval)
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONE place AQUA turns text into vectors. Wraps the embeddings endpoint of
 * the SAME @google/genai SDK the chat provider already uses (gemini.js) — zero
 * new dependencies, same GEMINI_KEY_* pool, same client-cache discipline.
 *
 * Hard guarantees (mirrors the search subsystem's "never break a request"):
 *   • embed() NEVER throws. Every failure — no key, all keys cooling, network,
 *     malformed response — resolves to an array of nulls. Callers treat a null
 *     vector as "semantic unavailable for this item" and fall back to keyword
 *     scoring. Embeddings can only ever ADD signal, never remove any.
 *   • isEmbeddingEnabled() is false when no key is configured OR the operator
 *     set AQUA_EMBEDDINGS=off. In that state embed() short-circuits to nulls
 *     with no network call — so a deployment WITHOUT embeddings behaves
 *     byte-identically to pre-Phase-2 (pure keyword retrieval).
 *
 * Testability: the network call is isolated behind a single injectable
 * function. __setEmbedderForTests(fn) swaps it for a deterministic fake so the
 * whole retrieval stack is unit-testable offline, exactly like editEngine's
 * __registerProposalForTests hook.
 *
 * Persistence / scaling note: this module is stateless beyond an in-process
 * content-hash cache. The vectors themselves live in vectorStore.js (same
 * Map+debounced-JSON tier as mindStore). Moving to a managed embedding service
 * or a different model touches ONLY this file.
 */
import { GoogleGenAI } from '@google/genai';

// ── Config ────────────────────────────────────────────────────────────────────
const EMBED_MODEL = process.env.AQUA_EMBED_MODEL || 'text-embedding-004';
const DISABLED     = String(process.env.AQUA_EMBEDDINGS || '').toLowerCase() === 'off';
const CACHE_MAX    = 2_000;   // bounded content-hash → vector cache
const BATCH_MAX    = 64;      // items per embedContent call

// ── Keys (same pool as gemini.js; read locally to stay decoupled) ─────────────
function getKeys() {
  return [
    process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3,
    process.env.GEMINI_KEY_4, process.env.GEMINI_KEY_5, process.env.GEMINI_KEY_6,
    process.env.GEMINI_KEY_7, process.env.GEMINI_KEY_8,
  ].filter(Boolean);
}

let keyIndex = 0;
function nextKey() {
  const keys = getKeys();
  if (!keys.length) return null;
  const k = keys[keyIndex];
  keyIndex = (keyIndex + 1) % keys.length;
  return k;
}

const clientCache = new Map();
function getClient(key) {
  if (!clientCache.has(key)) clientCache.set(key, new GoogleGenAI({ apiKey: key }));
  return clientCache.get(key);
}

/**
 * True when embeddings can actually run. Callers never NEED to check this —
 * embed() already short-circuits — but the pipeline uses it to skip building a
 * query embedding at all when disabled (saves the call + a log line).
 */
export function isEmbeddingEnabled() {
  if (testEmbedder) return true;
  return !DISABLED && getKeys().length > 0;
}

// ── Content-hash cache (djb2 — same hash editEngine uses) ─────────────────────
function hash(str = '') {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
export { hash as contentHash };

const cache = new Map(); // hash → number[]
function cacheGet(h) { return cache.get(h) ?? null; }
function cacheSet(h, vec) {
  cache.set(h, vec);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); // FIFO evict
}

// ── Test injection ────────────────────────────────────────────────────────────
// fn(texts:string[]) => (number[]|null)[]  — sync or async both accepted.
let testEmbedder = null;
export function __setEmbedderForTests(fn) { testEmbedder = fn; cache.clear(); }
export function __clearEmbedderForTests() { testEmbedder = null; cache.clear(); }

// ── Real network embed (isolated) ─────────────────────────────────────────────
let warnedNoKey = false;
async function callEmbedContent(texts) {
  const key = nextKey();
  if (!key) {
    if (!warnedNoKey) { console.warn('[EMBED] no GEMINI_KEY configured — semantic retrieval disabled (keyword only)'); warnedNoKey = true; }
    return texts.map(() => null);
  }
  try {
    const ai = getClient(key);
    // @google/genai embedContent accepts a single string or an array via
    // `contents`. Response shape has varied across SDK minors, so read both
    // the batched (`embeddings[]`) and single (`embedding`) forms defensively.
    const res = await ai.models.embedContent({ model: EMBED_MODEL, contents: texts });
    const list = res?.embeddings ?? (res?.embedding ? [res.embedding] : null);
    if (!Array.isArray(list)) return texts.map(() => null);
    return texts.map((_, i) => {
      const values = list[i]?.values ?? list[i]?.value ?? null;
      return Array.isArray(values) && values.length ? values : null;
    });
  } catch (err) {
    console.warn(`[EMBED] embedContent failed (non-fatal, keyword fallback): ${err.message}`);
    return texts.map(() => null);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed a batch of texts. Order-preserving; a per-item failure is null.
 * Cached by content hash across calls. NEVER throws.
 * @param {string[]} texts
 * @returns {Promise<Array<number[]|null>>}
 */
export async function embed(texts) {
  if (!Array.isArray(texts) || !texts.length) return [];
  if (!isEmbeddingEnabled()) return texts.map(() => null);

  const out = new Array(texts.length).fill(null);
  const missIdx = [];
  const missTexts = [];

  texts.forEach((t, i) => {
    const s = typeof t === 'string' ? t : String(t ?? '');
    if (!s.trim()) return;                         // empty stays null
    const hit = cacheGet(hash(s));
    if (hit) out[i] = hit; else { missIdx.push(i); missTexts.push(s); }
  });

  for (let start = 0; start < missTexts.length; start += BATCH_MAX) {
    const chunk = missTexts.slice(start, start + BATCH_MAX);
    let vecs;
    try {
      vecs = testEmbedder ? await testEmbedder(chunk) : await callEmbedContent(chunk);
    } catch (err) {
      console.warn(`[EMBED] batch failed (non-fatal): ${err.message}`);
      vecs = chunk.map(() => null);
    }
    chunk.forEach((s, j) => {
      const v = Array.isArray(vecs?.[j]) ? vecs[j] : null;
      if (v) { cacheSet(hash(s), v); out[missIdx[start + j]] = v; }
    });
  }

  return out;
}

/** Convenience: embed a single text → vector | null. NEVER throws. */
export async function embedOne(text) {
  const [v] = await embed([text]);
  return v ?? null;
}
