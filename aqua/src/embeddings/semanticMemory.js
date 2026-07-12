/**
 * AQUA Semantic Memory (Phase 2 — semantic retrieval)
 * ─────────────────────────────────────────────────────────────────────────────
 * Ties embeddingProvider + vectorStore to the FACT use case. Two functions the
 * chat pipeline calls at its already-async seams — so memoryObserve() and
 * memoryRetrieve() stay synchronous and their contracts are unchanged:
 *
 *   indexOwnerFacts(ownerId, facts)   WRITE-side, fire-and-forget. Embeds only
 *                                     facts whose text changed (content-hash
 *                                     skip) and stores their vectors. Prunes
 *                                     vectors for facts that no longer exist.
 *                                     Called after memoryObserve; never awaited
 *                                     on the response path, so it adds no
 *                                     user-visible latency.
 *
 *   semanticFactScores(ownerId, q)    READ-side. Embeds the query once
 *                                     (cached, fail-open) and returns
 *                                     Map<factKey, cosine> for the retriever to
 *                                     blend into its existing score. Returns
 *                                     null when embeddings are unavailable —
 *                                     the retriever then behaves exactly as it
 *                                     did before Phase 2.
 *
 * Both fail open: any error resolves to a no-op / null. Semantic scoring can
 * only ever ADD a signal to keyword retrieval, never break it.
 */
import { embed, embedOne, isEmbeddingEnabled, contentHash } from './embeddingProvider.js';
import { upsert, has, remove, idsIn, scoreAgainst } from './vectorStore.js';

/** Canonical text embedded for a fact — key words + stringified value. */
function factText(fact) {
  const key = String(fact.key || '').replace(/_/g, ' ').trim();
  let val = fact.value;
  if (val && typeof val === 'object') { try { val = JSON.stringify(val); } catch { val = String(val); } }
  return `${key}: ${String(val ?? '').trim()}`.trim();
}

/**
 * Ensure every current fact for an owner has an up-to-date vector. Embeds only
 * the misses (new or changed text), prunes vectors for deleted facts.
 * Fire-and-forget: callers do NOT await this on the response path.
 * @param {string} ownerId
 * @param {Array<{key:string,value:any}>} facts  current facts for the owner
 */
export async function indexOwnerFacts(ownerId, facts = []) {
  if (!ownerId || !isEmbeddingEnabled() || !Array.isArray(facts)) return;
  try {
    const liveKeys = new Set();
    const toEmbed = [];   // { key, text, hash }

    for (const f of facts) {
      if (!f?.key) continue;
      liveKeys.add(f.key);
      const text = factText(f);
      if (!text) continue;
      const h = contentHash(text);
      if (!has(ownerId, f.key, h)) toEmbed.push({ key: f.key, text, hash: h });
    }

    // Prune vectors whose fact no longer exists (forgotten / overwritten key).
    for (const id of idsIn(ownerId)) {
      if (!liveKeys.has(id)) remove(ownerId, id);
    }

    if (!toEmbed.length) return;
    const vecs = await embed(toEmbed.map(t => t.text));
    toEmbed.forEach((t, i) => { if (vecs[i]) upsert(ownerId, t.key, vecs[i], t.hash); });
    const done = vecs.filter(Boolean).length;
    if (done) console.log(`[SEM_MEM] indexed ${done}/${toEmbed.length} fact vector(s) owner=${ownerId}`);
  } catch (err) {
    console.warn('[SEM_MEM] indexOwnerFacts failed (non-fatal):', err.message);
  }
}

/**
 * Semantic score of the query against the owner's stored fact vectors.
 * @returns {Promise<Map<string,number>|null>} factKey → cosine, or null when
 *   embeddings are unavailable (retriever falls back to pure keyword).
 */
export async function semanticFactScores(ownerId, query) {
  if (!ownerId || !isEmbeddingEnabled() || !query || !query.trim()) return null;
  try {
    const qvec = await embedOne(query);
    if (!qvec) return null;
    const scores = scoreAgainst(ownerId, qvec);
    return scores.size ? scores : null;
  } catch (err) {
    console.warn('[SEM_MEM] semanticFactScores failed (non-fatal):', err.message);
    return null;
  }
}
