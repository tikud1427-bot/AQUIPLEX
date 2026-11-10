/**
 * AQUA Embedding Provider (Phase 2 — semantic retrieval)
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONE place AQUA turns text into vectors. Wraps the embeddings endpoint of
 * the SAME @google/genai SDK the chat provider already uses (gemini.js) — zero
 * new dependencies, the SAME shared Gemini key pool (providers/keyPool.cjs),
 * same client-cache discipline.
 *
 * Hard guarantees (mirrors the search subsystem's "never break a request"):
 *   • embed() NEVER throws. Every failure — no key, all keys cooling/rejected,
 *     network, malformed or misaligned response — resolves to nulls. Callers treat a null
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
import { EMBED_MODEL, EMBED_DIM } from './embeddingModel.js';
import keyPoolLib from '../providers/keyPool.cjs';

const { getKeyPool, classifyKeyFailure, recordKeyAttempt } = keyPoolLib;

// ── Config ────────────────────────────────────────────────────────────────────
// Model identity lives in embeddingModel.js because the VECTOR STORE needs the
// same value to stamp records — see the note there on why a same-dimension
// model swap is more dangerous than a dimension change.
const DISABLED     = String(process.env.AQUA_EMBEDDINGS || '').toLowerCase() === 'off';
const CACHE_MAX    = 2_000;   // bounded content-hash → vector cache
const BATCH_MAX    = 64;      // items per embedContent call

// ── Keys (the SAME shared pool as gemini.js — keyPool.cjs) ────────────────────
// GEMINI_KEY_1..N (any N, incl. 9..12+) + GEMINI_API_KEY + Gemini_API_Key,
// deduped. Sharing the pool means a key gemini.js found rejected is skipped
// here too, and vice versa; cooldowns from a 429 here are scoped to
// (key, EMBED_MODEL), so a throttled embedding quota never blocks chat.
const pool = getKeyPool('gemini');
const EMBED_KEY_ATTEMPTS = 3;               // non-rejected attempts per chunk
const EMBED_RATE_LIMIT_COOLDOWN_MS = 60_000;
const EMBED_BILLING_TTL_MS = 86_400_000;

const clientCache = new Map();
function getClient(key) {
  if (!clientCache.has(key)) clientCache.set(key, new GoogleGenAI({ apiKey: key }));
  return clientCache.get(key);
}

/**
 * One embedContent call with one credential. Replaceable in tests so the
 * rotation, validation and ordering logic below runs for real offline.
 * @type {(key: string, texts: string[]) => Promise<object>}
 */
const defaultTransport = (key, texts) => getClient(key).models.embedContent({
  // outputDimensionality is what lets a 3072-native model fill a store sized
  // for 768. The model does not renormalise when reduced; cosineSim divides
  // by both magnitudes, so that is harmless here.
  model: EMBED_MODEL, contents: texts,
  config: { outputDimensionality: EMBED_DIM },
});
let transport = defaultTransport;

/**
 * True when embeddings can actually run. Callers never NEED to check this —
 * embed() already short-circuits — but the pipeline uses it to skip building a
 * query embedding at all when disabled (saves the call + a log line).
 */
export function isEmbeddingEnabled() {
  if (testEmbedder) return true;
  return !DISABLED && pool.hasKeys();
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
export function __setEmbedderForTests(fn) { testEmbedder = fn; cache.clear(); inflight.clear(); }
export function __clearEmbedderForTests() { testEmbedder = null; cache.clear(); inflight.clear(); }

/** Replace ONLY the network call (key, texts) => response; rotation, validation
 *  and ordering stay real. Restored by __clearEmbedTransportForTests. */
export function __setEmbedTransportForTests(fn) { transport = fn; cache.clear(); }
export function __clearEmbedTransportForTests() { transport = defaultTransport; cache.clear(); }

// ── Real network embed (isolated) ─────────────────────────────────────────────

/**
 * Map a response onto its inputs, or refuse to. A response whose embedding
 * count differs from the input count cannot be aligned safely — storing
 * vector i against text i there could attach one text's meaning to another —
 * so the whole response is discarded (nulls → keyword fallback). Individually
 * malformed vectors (wrong dimension, non-finite values) become null; they are
 * never stored as successes.
 */
function alignEmbeddings(res, n) {
  const list = res?.embeddings ?? (res?.embedding ? [res.embedding] : null);
  if (!Array.isArray(list) || list.length !== n) return { vecs: new Array(n).fill(null), aligned: false };
  const vecs = list.map(e => {
    const values = e?.values ?? e?.value ?? null;
    if (!Array.isArray(values) || values.length !== EMBED_DIM) return null;
    for (const v of values) if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    return values;
  });
  return { vecs, aligned: true };
}

let warnedNoKey = false;
async function callEmbedContent(texts) {
  if (!pool.hasKeys()) {
    if (!warnedNoKey) { console.warn('[EMBED] no Gemini key configured — semantic retrieval disabled (keyword only)'); warnedNoKey = true; }
    return texts.map(() => null);
  }

  const tried = new Set();
  let budget = EMBED_KEY_ATTEMPTS;
  let prevSlot = null;
  while (budget > 0) {
    const cred = pool.acquire({ model: EMBED_MODEL, tried });
    if (!cred) break;
    tried.add(cred.slot);
    const keySwitch = prevSlot != null;
    prevSlot = cred.slot;
    const started = Date.now();
    try {
      const res = await transport(cred.key, texts);
      const { vecs, aligned } = alignEmbeddings(res, texts.length);
      if (!aligned) {
        // Transport and credential worked; the payload is unusable. Another
        // key would get the same shape back — fall back, do not cycle keys.
        pool.reportNeutralFailure(cred, 'invalid_response');
        recordKeyAttempt({ provider: 'gemini', model: EMBED_MODEL, slot: cred.slot, purpose: 'embedding', outcome: 'failure', errorType: 'invalid_response', latencyMs: Date.now() - started, keySwitch });
        console.warn(`[EMBED] key=${cred.slot} returned a misaligned/empty embedding list (non-fatal, keyword fallback)`);
        return texts.map(() => null);
      }
      pool.reportSuccess(cred, { model: EMBED_MODEL });
      // Embedding responses carry no token usage — recorded as unknown, never 0.
      recordKeyAttempt({ provider: 'gemini', model: EMBED_MODEL, slot: cred.slot, purpose: 'embedding', outcome: 'success', latencyMs: Date.now() - started, usage: null, keySwitch });
      return vecs;
    } catch (err) {
      const k = classifyKeyFailure(err);
      recordKeyAttempt({ provider: 'gemini', model: EMBED_MODEL, slot: cred.slot, purpose: 'embedding', outcome: 'failure', errorType: k.kind, latencyMs: Date.now() - started, retryAfterMs: k.retryAfterMs, keySwitch });
      if (k.kind === 'auth') {
        pool.reject(cred, 'auth');
        console.warn(`[EMBED] key=${cred.slot} credential rejected (status=${k.status ?? 'n/a'}) → quarantined, trying next key`);
        continue; // rejections are self-limiting; they do not spend the budget
      }
      if (k.kind === 'billing') {
        pool.reject(cred, 'billing', { ttlMs: EMBED_BILLING_TTL_MS });
        console.warn(`[EMBED] key=${cred.slot} billing/credits refused → trying next key`);
        continue;
      }
      budget--;
      if (k.kind === 'rate_limit') {
        const cd = k.retryAfterMs ?? EMBED_RATE_LIMIT_COOLDOWN_MS;
        pool.coolDown(cred, cd, { model: EMBED_MODEL });
        console.warn(`[EMBED] key=${cred.slot} rate limited → ${Math.ceil(cd / 1000)}s cooldown for ${EMBED_MODEL}, trying next key`);
        continue;
      }
      // Network / 5xx / model error: another key reaches the same failing
      // service — keyword fallback for this chunk, no key cycling.
      pool.reportNeutralFailure(cred, k.kind);
      console.warn(`[EMBED] embedContent failed key=${cred.slot} status=${k.status ?? 'n/a'} (non-fatal, keyword fallback): ${err.message}`);
      return texts.map(() => null);
    }
  }
  console.warn(`[EMBED] no usable Gemini key for ${EMBED_MODEL} right now (cooling/rejected/attempt budget) — keyword fallback`);
  return texts.map(() => null);
}


// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed a batch of texts. Order-preserving; a per-item failure is null.
 * Cached by content hash across calls. NEVER throws.
 * @param {string[]} texts
 * @returns {Promise<Array<number[]|null>>}
 */
// ── In-flight coalescing (2026-11-10) ─────────────────────────────────────────
// A chat turn starts three retrieval lanes at once (fact, canonical-claim and
// file recall — routes/chat.js prepareTurn), and each embeds the SAME user
// message. All three missed the cache together, so every new message cost
// three identical embedContent calls against the shared Gemini quota. A text
// already on its way to the API is now awaited instead of sent again.
// Keyed by the exact text (not the 32-bit hash) so a hash collision can never
// hand one text another's vector; entries live only while the call is open,
// so nothing here can go stale.
const inflight = new Map(); // text → Promise<number[]|null>

export async function embed(texts) {
  if (!Array.isArray(texts) || !texts.length) return [];
  if (!isEmbeddingEnabled()) return texts.map(() => null);

  const out = new Array(texts.length).fill(null);
  const waits = [];       // [index, promise] — served by a call already open
  const owned = [];       // texts this call sends: { s, resolve, idx: [indices] }
  const ownedByText = new Map();

  texts.forEach((t, i) => {
    const s = typeof t === 'string' ? t : String(t ?? '');
    if (!s.trim()) return;                         // empty stays null
    const hit = cacheGet(hash(s));
    if (hit) { out[i] = hit; return; }
    const mine = ownedByText.get(s);
    if (mine) { mine.idx.push(i); return; }        // duplicate inside this batch
    const pending = inflight.get(s);
    if (pending) { waits.push([i, pending]); return; }
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    inflight.set(s, promise);
    const entry = { s, resolve, promise, idx: [i], done: false };
    owned.push(entry);
    ownedByText.set(s, entry);
  });

  try {
    for (let start = 0; start < owned.length; start += BATCH_MAX) {
      const chunkEntries = owned.slice(start, start + BATCH_MAX);
      const chunk = chunkEntries.map(e => e.s);
      let vecs;
      try {
        vecs = testEmbedder ? await testEmbedder(chunk) : await callEmbedContent(chunk);
      } catch (err) {
        console.warn(`[EMBED] batch failed (non-fatal): ${err.message}`);
        vecs = chunk.map(() => null);
      }
      chunkEntries.forEach((e, j) => {
        const v = Array.isArray(vecs?.[j]) ? vecs[j] : null;
        if (v) cacheSet(hash(e.s), v);
        for (const i of e.idx) out[i] = v;
        if (inflight.get(e.s) === e.promise) inflight.delete(e.s);
        e.done = true;
        e.resolve(v);
      });
    }
  } finally {
    // Never leave a waiter hanging: anything not settled above resolves null
    // (keyword fallback), exactly what a failed call would have produced.
    for (const e of owned) {
      if (e.done) continue;
      if (inflight.get(e.s) === e.promise) inflight.delete(e.s);
      e.done = true;
      e.resolve(null);
    }
  }

  for (const [i, p] of waits) out[i] = await p;
  return out;
}

/** Test seam: how many distinct texts are on their way to the API right now. */
export function __inflightEmbeddingsForTests() { return inflight.size; }

/** Convenience: embed a single text → vector | null. NEVER throws. */
export async function embedOne(text) {
  const [v] = await embed([text]);
  return v ?? null;
}
