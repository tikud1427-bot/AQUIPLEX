/**
 * Semantic episodic recall (2026-11-05).
 *
 * Episodic recall (episodicRecall.js) quotes what the user said before. While
 * the whole history fits its window it is quoted whole; past that it was ranked
 * by keyword overlap only (BM25), so "How's fundraising going?" could not reach
 * "We closed our seed round". This module adds the user's past passages to the
 * existing vector tier and a hybrid ranking: keyword relevance + embedding
 * similarity + recency. Keyword recall is unchanged whenever this is off or
 * unavailable.
 *
 *   semanticRecallEnabled()      AQUA_SEMANTIC_RECALL=on AND the dedicated key
 *                                AQUA_EMBEDDING_API_KEY is set and not held back
 *                                (embeddings/dedicatedEmbedder.js). OFF by default:
 *                                enabling sends the user's past messages to the
 *                                embedding provider. No fallback to the shared
 *                                Gemini pool, ever.
 *   semanticScores(owner, units, query)
 *                                READ: one query vector (own cache; the shared
 *                                fact-retrieval vector is NOT reused — it was made
 *                                with another credential), cosine against the
 *                                stored passage vectors of the units that exist
 *                                now. Bounded by a timeout; null = keyword only.
 *   indexRecallUnits(owner, units)
 *                                WRITE, fire-and-forget: embeds passages without
 *                                a vector (newest first, ≤ one batch per call),
 *                                prunes vectors of passages deleted, redacted or
 *                                no longer eligible. Never embeds a forgotten
 *                                (redacted) or health/mood sentence.
 *   rankHybrid(units, query, semantic)
 *                                PURE: the combined ranking, duplicates removed
 *                                (identical text → the later occurrence).
 *
 * Vectors live in vectorStore namespace `recall:<owner>` (deleteMind clears it).
 * Never throws; every failure resolves to the keyword path.
 */
// The DEDICATED credential only (AQUA_EMBEDDING_API_KEY) — never the shared Gemini
// pool that chat, fact and file embeddings use (embeddings/dedicatedEmbedder.js).
import { dedicatedEmbed as embed, dedicatedEmbedOne as embedOne, dedicatedEmbeddingEnabled as isEmbeddingEnabled, dedicatedContentHash as contentHash } from '../embeddings/dedicatedEmbedder.js';
import { upsert, has, remove, idsIn, scoreAgainst } from '../embeddings/vectorStore.js';
import { redactionsFor } from './recallRedactions.js';
import { scoreUnits, forgetClean } from './episodicRecall.js';
import { embeddableSentences, questionEmbedText } from './retrievalPrivacy.js';

// Ranking parameters (2026-11-05, from the live gemini-embedding-001 run: cosines
// are compressed into ~0.43–0.74, relevant and unrelated bands overlap at the edge,
// but within each question relevant passages always rank first — so meaning is
// judged against the question's own spread, not an absolute cosine).
// NOTE: chosen on that run's 10 questions; to be confirmed on an independent set.
export const SEMANTIC_DEFAULTS = Object.freeze({
  minCosine: 0.58,        // absolute floor: below this a passage is never "about" the question by meaning
  band: 0.10,             // …and it must be within this of the question's best cosine
  smallPool: 8,           // fewer vectors than this: the per-question median is unreliable → absolute scale
  keywordHalf: 1.5,       // BM25 at which keyword strength is 0.5 (bm25 / (bm25 + keywordHalf)), absolute, not best-normalised
  keywordSupport: 0.15,   // a keyword hit the meaning does not admit counts at most this fraction
  weights: Object.freeze({ keyword: 0.35, semantic: 0.6, recency: 0.05 }),
  indexPerCall: 64,       // one provider batch per turn at most
  maxVectors: 450,        // newest passages kept embedded (vectorStore caps a namespace at 500)
  queryTimeoutMs: 1500,   // the read path never waits longer for a query vector
  indexFromFraction: 0.5, // start indexing once the history reaches half the whole-history window
});

export function semanticRecallEnabled(env = process.env) {
  return String(env.AQUA_SEMANTIC_RECALL ?? '').toLowerCase() === 'on' && isEmbeddingEnabled();
}

export const recallNamespace = ownerId => `recall:${ownerId}`;

/**
 * The text of a passage that may be sent to the embedding provider, or null.
 * SENTENCE BY SENTENCE (2026-11-06): every sensitive (health / mood) sentence is
 * left out whatever the turn's policy — it never leaves the process for this —
 * and the passage's other sentences are still embedded. The previous check
 * classified the whole passage: "I have asthma. We are building an app for
 * runners." read as not sensitive (the sibling's product framing), so the
 * health sentence was sent. `u` has already lost its forgotten sentences
 * (forgetClean); `extra` is an optional caller matcher, applied per sentence.
 * The vector's content hash is of THIS text, so the read side (semanticScores)
 * only trusts a vector made from exactly what is eligible now.
 */
function embedText(u, extra = null) {
  let kept = embeddableSentences(u);
  if (kept && extra) kept = kept.filter(s => !extra.isRedacted(s, u.ts));
  return kept?.length ? kept.join(' ') : null;
}

/** The passages as they may be embedded: forgotten sentences out (cached per forget list), then embedText. */
function embeddablePool(ownerId, units, extra = null) {
  const { pool } = forgetClean(units, redactionsFor(ownerId));
  const out = [];
  for (const u of pool) { const text = embedText(u, extra); if (text) out.push({ u, text }); }
  return out;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(v => ({ v, timedOut: false })),
    new Promise(res => { timer = setTimeout(() => res({ v: null, timedOut: true }), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Cosine of the query against the stored vectors of `units` (only units that
 * exist now, with an up-to-date vector). Map<unitKey, cosine> or null.
 */
export async function semanticScores(ownerId, units, query, { timeoutMs = SEMANTIC_DEFAULTS.queryTimeoutMs, stats = null, queryVector = undefined } = {}) {
  if (!ownerId || !Array.isArray(units) || !units.length || !String(query ?? '').trim() || !semanticRecallEnabled()) return null;
  // The CURRENT question follows the same rule as the passages: its sensitive
  // sentences are never sent; when nothing eligible is left, no call is made
  // and recall stays keyword-only for this turn.
  const qText = questionEmbedText(query);
  if (!qText) { if (stats) stats.queryWithheld = true; return null; }
  try {
    const t0 = Date.now();
    // A query vector started earlier in the turn (startRecallQueryVector) is REUSED —
    // awaited under the same timeout, never re-requested, even if it came back empty.
    const pending = queryVector !== undefined ? Promise.resolve(queryVector).catch(() => null) : embedOne(qText);
    if (stats && queryVector !== undefined) stats.early = true;
    const { v: qvec, timedOut } = await withTimeout(pending, timeoutMs);
    if (stats) Object.assign(stats, { queryMs: Date.now() - t0, timedOut });
    if (!qvec) return null;
    const ns = recallNamespace(ownerId);
    const all = scoreAgainst(ns, qvec);
    const out = new Map();
    // Only a vector of exactly what is eligible NOW counts: a passage that lost a
    // sentence to a forget, or whose vector was made from text that is no longer
    // embeddable, has a different hash and no score until it is re-indexed.
    for (const { u, text } of embeddablePool(ownerId, units)) {
      const s = all.get(u.key);
      if (s != null && has(ns, u.key, contentHash(text))) out.set(u.key, s);
    }
    if (stats) stats.scored = out.size;
    return out.size ? out : null;
  } catch (err) {
    if (stats) stats.error = String(err?.message ?? err).slice(0, 120);
    return null;
  }
}

/**
 * Start the turn's query vector now, so its round trip overlaps the rest of the
 * turn (the live run measured 608–699 ms per embedding). Only when recall is
 * CERTAIN to rank: the user's OTHER conversations alone already exceed the
 * whole-history window (`historyLowerBound` > window). Otherwise null — recall
 * then embeds the query itself only if it ranks, exactly as before. So no turn
 * makes a call it would not have made. Never rejects.
 */
export function startQueryVector(query, { historyLowerBound, window }) {
  if (!semanticRecallEnabled() || !String(query ?? '').trim()) return null;
  if (!(window > 0) || !(historyLowerBound > window)) return null;
  const qText = questionEmbedText(query);          // same rule as semanticScores: sensitive sentences never sent
  if (!qText) return null;
  return embedOne(qText).catch(() => null);
}

/**
 * Bring the owner's passage vectors up to date. `units`: every passage of the
 * owner (not windowed). Embeds at most `limit` missing ones, newest first.
 */
export async function indexRecallUnits(ownerId, units, { redaction = null, limit = SEMANTIC_DEFAULTS.indexPerCall, maxVectors = SEMANTIC_DEFAULTS.maxVectors } = {}) {
  const out = { embedded: 0, pruned: 0, missing: 0 };
  if (!ownerId || !Array.isArray(units) || !isEmbeddingEnabled()) return out;
  try {
    // Safe by default: the owner's own forget list applies even when a caller passes
    // none, and no sensitive sentence is ever embedded (embedText).
    const ns = recallNamespace(ownerId);
    const eligible = embeddablePool(ownerId, units, redaction).sort((a, b) => (b.u.ts ?? 0) - (a.u.ts ?? 0)).slice(0, maxVectors);
    const live = new Map(eligible.map(({ u, text }) => [u.key, contentHash(text)]));
    for (const id of idsIn(ns)) if (!live.has(id)) { remove(ns, id); out.pruned++; }
    const missing = eligible.filter(({ u }) => !has(ns, u.key, live.get(u.key)));
    out.missing = missing.length;
    const batch = missing.slice(0, limit);
    if (!batch.length) return out;
    const vecs = await embed(batch.map(x => x.text));
    batch.forEach(({ u }, i) => { if (vecs[i]) { upsert(ns, u.key, vecs[i], live.get(u.key)); out.embedded++; } });
    return out;
  } catch (err) {
    console.warn(`[RECALL] semantic indexing failed (non-fatal, keyword recall unaffected): ${err?.message ?? err}`);
    return out;
  }
}

const sameText = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Hybrid ranking (2026-11-05, revised on the live gemini-embedding-001 run).
 *
 * MEANING is judged against the question's own spread of cosines, not an absolute
 * cosine (real cosines are compressed and model-specific):
 *   admitted  cosine ≥ minCosine AND within `band` of the question's best cosine
 *   z         (cosine − question median) / (question best − median), clipped 0–1;
 *             with fewer than `smallPool` vectors the median is unreliable, so
 *             z = (cosine − minCosine) / (1 − minCosine)
 * KEYWORD strength is absolute — bm25 / (bm25 + keywordHalf) — so one weak word
 * is not a perfect match (the first formula normalised to the best keyword hit:
 * a lone stemming accident scored 1.0 and outranked cosine-0.99 meaning matches).
 * A keyword hit counts fully only as far as meaning supports it; one the meaning
 * does not admit is capped at `keywordSupport`.
 *
 *   score = wS·z·[admitted] + wK·keyword·max(support, keywordSupport) + wR·recency
 *
 * Candidates: a keyword hit, or admitted by meaning. Ties → the later passage.
 * Identical text said more than once → only its later occurrence. Each result
 * carries `parts` (keyword / semantic / recency) that add up to `score`.
 */
export function rankHybrid(units, query, semantic, {
  minCosine = SEMANTIC_DEFAULTS.minCosine, band = SEMANTIC_DEFAULTS.band, smallPool = SEMANTIC_DEFAULTS.smallPool,
  keywordHalf = SEMANTIC_DEFAULTS.keywordHalf, keywordSupport = SEMANTIC_DEFAULTS.keywordSupport,
  weights = SEMANTIC_DEFAULTS.weights, scored = null,
} = {}) {
  const kwScored = scored ?? scoreUnits(units, query).scored;
  const kw = new Map(kwScored.map(s => [s.unit.key, s.score]));
  const sem = semantic instanceof Map ? semantic : new Map();
  const cosines = units.map(u => sem.get(u.key)).filter(c => typeof c === 'number' && Number.isFinite(c)).sort((a, b) => a - b);
  const pool = cosines.length >= smallPool ? 'contrast' : 'small';
  const best = cosines.length ? cosines[cosines.length - 1] : -1;
  const median = cosines.length ? cosines[Math.floor(cosines.length / 2)] : -1;
  const clip = x => Math.max(0, Math.min(1, x));
  const zOf = c => (c == null ? 0 : pool === 'contrast' ? (best > median ? clip((c - median) / (best - median)) : 0) : clip((c - minCosine) / (1 - minCosine)));
  const admits = c => c != null && c >= minCosine && c >= best - band;

  const cands = units.filter(u => kw.has(u.key) || admits(sem.get(u.key)));
  if (!cands.length) return [];
  const tss = cands.map(u => u.ts ?? 0);
  const lo = Math.min(...tss), span = Math.max(...tss) - lo;
  const ranked = cands.map(u => {
    const bm25 = kw.get(u.key) ?? 0;
    const k = bm25 > 0 ? bm25 / (bm25 + keywordHalf) : 0;
    const c = sem.get(u.key);
    const admitted = admits(c);
    const z = zOf(c);
    const support = admitted ? z : Math.min(z, keywordSupport);
    const parts = {
      semantic: admitted ? weights.semantic * z : 0,
      keyword: weights.keyword * k * Math.max(support, keywordSupport),
      recency: weights.recency * (span > 0 ? ((u.ts ?? 0) - lo) / span : 0),
    };
    return { unit: u, score: parts.semantic + parts.keyword + parts.recency, parts, keyword: k, semantic: c ?? -1, z, admitted, pool, why: k > 0 ? 'match' : 'semantic' };
  });
  ranked.sort((a, b) => b.score - a.score || (b.unit.ts ?? 0) - (a.unit.ts ?? 0) || (a.unit.key < b.unit.key ? -1 : 1));
  const seenText = new Set();
  const out = [];
  // The later occurrence of a repeated sentence first, whatever its rank position.
  const latest = new Map();
  for (const x of ranked) { const t = sameText(x.unit.text); const cur = latest.get(t); if (!cur || (x.unit.ts ?? 0) > (cur.unit.ts ?? 0)) latest.set(t, x); }
  for (const x of ranked) {
    const t = sameText(x.unit.text);
    if (seenText.has(t)) continue;
    seenText.add(t);
    out.push(latest.get(t));
  }
  return out;
}
