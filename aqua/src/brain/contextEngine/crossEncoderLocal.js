/**
 * AQUA E7 PR-8 — local Transformers.js cross-encoder adapter.
 *
 * Uses the ONNX-compatible Xenova export of
 * cross-encoder/ms-marco-MiniLM-L-6-v2. No hosted inference provider is
 * required, so provider availability cannot silently block reranking.
 * The model is downloaded/cached by Transformers.js on first use.
 */

const MODEL_ID = process.env.AQUA_CROSS_ENCODER_MODEL || 'Xenova/ms-marco-MiniLM-L-6-v2';
let runtimePromise = null;
const DEFAULT_CACHE_SIZE = 512;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const pairCache = new Map();

function cacheConfig() {
  const maxSize = Math.max(0, Number.isFinite(Number(process.env.AQUA_CROSS_ENCODER_CACHE_SIZE)) ? Math.floor(Number(process.env.AQUA_CROSS_ENCODER_CACHE_SIZE)) : DEFAULT_CACHE_SIZE);
  const ttlMs = Math.max(0, Number.isFinite(Number(process.env.AQUA_CROSS_ENCODER_CACHE_TTL_MS)) ? Number(process.env.AQUA_CROSS_ENCODER_CACHE_TTL_MS) : DEFAULT_CACHE_TTL_MS);
  return { maxSize, ttlMs };
}
function pairKey(query, text) { return `${MODEL_ID}\0${String(query)}\0${text}`; }
function cacheGet(key) {
  const hit = pairCache.get(key);
  if (!hit) return null;
  const { ttlMs } = cacheConfig();
  if (ttlMs > 0 && Date.now() - hit.at > ttlMs) { pairCache.delete(key); return null; }
  pairCache.delete(key); pairCache.set(key, hit);
  return hit.score;
}
function cacheSet(key, score) {
  const { maxSize } = cacheConfig();
  if (!maxSize) return;
  pairCache.delete(key); pairCache.set(key, { score, at: Date.now() });
  while (pairCache.size > maxSize) pairCache.delete(pairCache.keys().next().value);
}

async function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers');
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(MODEL_ID),
        AutoModelForSequenceClassification.from_pretrained(MODEL_ID, {
          dtype: process.env.AQUA_CROSS_ENCODER_DTYPE || 'q8',
        }),
      ]);
      return { tokenizer, model };
    })();
  }
  return runtimePromise;
}

function candidateText(candidate) {
  return String(
    candidate?.statement ??
    candidate?.text ??
    candidate?.summary ??
    candidate?.label ??
    candidate?.value ??
    candidate?.entity ??
    '',
  ).trim();
}

export async function scorePairs(query, candidates) {
  if (!query || !Array.isArray(candidates)) return [];
  const texts = candidates.map(candidateText);
  const out = new Array(candidates.length).fill(null);
  const misses = [];

  for (let i = 0; i < candidates.length; i++) {
    const key = pairKey(query, texts[i]);
    const cached = cacheGet(key);
    if (cached !== null) out[i] = cached;
    else misses.push({ i, key });
  }
  if (!misses.length) return out;

  const { tokenizer, model } = await getRuntime();
  const missTexts = misses.map(({ i }) => texts[i]);
  const features = tokenizer(
    Array(misses.length).fill(String(query)),
    { text_pair: missTexts, padding: true, truncation: true },
  );
  const output = await model(features);
  const data = output?.logits?.data;
  if (!data || data.length < misses.length) {
    throw new Error('cross-encoder model returned no usable logits');
  }
  const stride = Math.max(1, Math.floor(data.length / misses.length));
  for (let j = 0; j < misses.length; j++) {
    const score = Number(data[j * stride]);
    if (!Number.isFinite(score)) throw new Error('cross-encoder model returned a non-finite score');
    const { i, key } = misses[j];
    out[i] = score;
    cacheSet(key, score);
  }
  return out;
}

export function crossEncoderInfo() {
  return {
    model: MODEL_ID,
    runtime: 'transformers.js-onnx-local',
    enabled: String(process.env.AQUA_CROSS_ENCODER ?? '').toLowerCase() === 'on',
  };
}

export function resetCrossEncoderRuntimeForTests() {
  runtimePromise = null;
  pairCache.clear();
}

export function crossEncoderCacheInfo() {
  const { maxSize, ttlMs } = cacheConfig();
  return { size: pairCache.size, maxSize, ttlMs };
}
