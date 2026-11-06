/**
 * Dedicated embedder for semantic episodic recall (2026-11-05).
 *
 * Recall embeds the user's past messages. It must not ride the shared Gemini
 * key pool (GEMINI_KEY_*, GEMINI_API_KEY — chat, fact and file embeddings), so
 * it has its own credential and nothing else:
 *
 *   AQUA_EMBEDDING_API_KEY   the one key this module uses (Gemini API key for
 *                            EMBED_MODEL). Read at call time. Missing/blank →
 *                            disabled: every call resolves to nulls with no
 *                            network request, and recall stays keyword-only.
 *                            There is NO fallback to any other credential.
 *
 * Deliberately separate from embeddingProvider.js: no import of the shared key
 * pool, its own client and its own content-hash cache (a vector made with a
 * shared key is never reused here). Same model and dimension as the vector
 * store (embeddingModel.js), and AQUA_EMBEDDINGS=off still disables it.
 *
 * Never throws. Never logs or returns the key: error text is scrubbed of every
 * credential value in the environment before it is logged or stored.
 * A rejected key (401/403/billing) is held back for a day, a rate limit for its
 * retry-after (default 60 s) — no hammering, no other key tried.
 */
import { GoogleGenAI } from '@google/genai';
import { EMBED_MODEL, EMBED_DIM } from './embeddingModel.js';

export const DEDICATED_KEY_ENV = 'AQUA_EMBEDDING_API_KEY';
const CACHE_MAX = 2_000;
const BATCH_MAX = 64;
const REJECT_TTL_MS = 86_400_000;
const RATE_LIMIT_MS = 60_000;

const keyOf = () => String(process.env.AQUA_EMBEDDING_API_KEY ?? '').trim();   // = DEDICATED_KEY_ENV; literal so the flag registry sees the read
const disabledGlobally = () => String(process.env.AQUA_EMBEDDINGS || '').toLowerCase() === 'off';

let holdUntil = 0;
let state = 'ok';            // ok | rejected | rate_limited
let lastError = null;        // scrubbed

/** True when recall may embed: its own key is set and not held back. */
export function dedicatedEmbeddingEnabled() {
  if (disabledGlobally() || !keyOf()) return false;
  if (holdUntil && Date.now() < holdUntil) return false;
  return true;
}

/** No secrets: configured or not, and the last scrubbed failure. */
export function dedicatedEmbedderStatus() {
  return { configured: !!keyOf(), enabled: dedicatedEmbeddingEnabled(), state: holdUntil && Date.now() < holdUntil ? state : 'ok', lastError, model: EMBED_MODEL };
}

// ── Scrubbing ─────────────────────────────────────────────────────────────────
function scrub(text) {
  let s = String(text ?? '');
  const secrets = Object.entries(process.env)
    .filter(([k, v]) => v && v.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD/i.test(k))
    .map(([, v]) => v.trim())
    .sort((a, b) => b.length - a.length);
  for (const v of secrets) s = s.split(v).join('[redacted]');
  return s.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]').slice(0, 200);
}

// ── Content-hash cache (own; djb2 like the shared one, but a distinct store) ──
function djb2(str = '') {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
/** Vector-store hash for a text embedded HERE. Prefixed, so a record written by
 *  another credential path never counts as up to date for recall. */
export function dedicatedContentHash(text) { return `ded1:${djb2(String(text ?? ''))}`; }
const cache = new Map();
function cacheSet(h, v) { cache.set(h, v); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }

// ── Network (one call, one key) ───────────────────────────────────────────────
let client = null, clientKey = null;
const defaultTransport = (key, texts) => {
  if (!client || clientKey !== key) { client = new GoogleGenAI({ apiKey: key }); clientKey = key; }
  return client.models.embedContent({ model: EMBED_MODEL, contents: texts, config: { outputDimensionality: EMBED_DIM } });
};
let transport = defaultTransport;

function align(res, n) {
  const list = res?.embeddings ?? (res?.embedding ? [res.embedding] : null);
  if (!Array.isArray(list) || list.length !== n) return new Array(n).fill(null);
  return list.map(e => {
    const values = e?.values ?? e?.value ?? null;
    if (!Array.isArray(values) || values.length !== EMBED_DIM) return null;
    return values.every(v => typeof v === 'number' && Number.isFinite(v)) ? values : null;
  });
}

function statusOf(err) {
  const s = Number(err?.status ?? err?.code ?? err?.response?.status);
  if (Number.isFinite(s)) return s;
  const m = String(err?.message ?? '').match(/\b(4\d\d|5\d\d)\b/);
  return m ? Number(m[1]) : null;
}

async function callOnce(texts) {
  const key = keyOf();
  if (!key) return texts.map(() => null);
  try {
    return align(await transport(key, texts), texts.length);
  } catch (err) {
    const status = statusOf(err);
    const msg = scrub(err?.message ?? err);
    lastError = { status, message: msg, at: Date.now() };
    if (status === 401 || status === 403 || /api key not valid|permission|billing|quota exceeded for/i.test(msg)) {
      state = 'rejected'; holdUntil = Date.now() + REJECT_TTL_MS;
      console.warn(`[EMBED:recall] dedicated key refused (status=${status ?? 'n/a'}) — semantic recall inactive for 24h; keyword recall continues. Check ${DEDICATED_KEY_ENV}.`);
    } else if (status === 429) {
      state = 'rate_limited';
      const ra = Number(err?.retryAfterMs ?? err?.response?.headers?.['retry-after'] * 1000);
      holdUntil = Date.now() + (Number.isFinite(ra) && ra > 0 ? ra : RATE_LIMIT_MS);
      console.warn(`[EMBED:recall] dedicated key rate limited — paused, keyword recall continues`);
    } else {
      console.warn(`[EMBED:recall] embedding failed (status=${status ?? 'n/a'}, non-fatal, keyword recall continues): ${msg}`);
    }
    return texts.map(() => null);
  }
}

/** Embed texts with the dedicated key only. Order-preserving, nulls on failure. Never throws. */
export async function dedicatedEmbed(texts) {
  if (!Array.isArray(texts) || !texts.length) return [];
  const out = new Array(texts.length).fill(null);
  if (!dedicatedEmbeddingEnabled()) return out;
  const miss = [];
  texts.forEach((t, i) => {
    const s = typeof t === 'string' ? t : String(t ?? '');
    if (!s.trim()) return;
    const hit = cache.get(djb2(s));
    if (hit) out[i] = hit; else miss.push([i, s]);
  });
  for (let start = 0; start < miss.length; start += BATCH_MAX) {
    if (!dedicatedEmbeddingEnabled()) break;              // held back mid-way: stop, keyword fallback
    const chunk = miss.slice(start, start + BATCH_MAX);
    const vecs = await callOnce(chunk.map(([, s]) => s));
    chunk.forEach(([i, s], j) => { if (vecs[j]) { cacheSet(djb2(s), vecs[j]); out[i] = vecs[j]; } });
  }
  return out;
}

export async function dedicatedEmbedOne(text) {
  const [v] = await dedicatedEmbed([text]);
  return v ?? null;
}

// ── Test hooks (replace ONLY the network call; key selection stays real) ──────
export function __setDedicatedTransportForTests(fn) { transport = fn; cache.clear(); }
export function __clearDedicatedTransportForTests() { transport = defaultTransport; cache.clear(); }
export function __resetDedicatedForTests() { cache.clear(); holdUntil = 0; state = 'ok'; lastError = null; client = null; clientKey = null; }
