/**
 * AQUA Canonical Claim Semantic Lane — E7 / Retrieval V3.
 *
 * Retrieval identity contract:
 *   evidenceStore fact.id === vectorStore id === Context candidate.semanticId
 *
 * The embedded text is the canonical fact.statement, not the legacy
 * long-term-memory "key: value" representation.
 *
 * Fail-open: unavailable embeddings contribute no dense signal.
 */
import { embed, embedOne, isEmbeddingEnabled, contentHash } from '../../embeddings/embeddingProvider.js';
import { upsert, has, remove, idsIn, scoreAgainst } from '../../embeddings/vectorStore.js';

export const CANONICAL_CLAIM_NAMESPACE = 'canonical-claims';

function namespace(ownerId) {
  return `${CANONICAL_CLAIM_NAMESPACE}:${String(ownerId)}`;
}

function factText(fact) {
  return String(fact?.statement ?? '').trim();
}

/** Index ONE canonical claim without pruning the owner's other claims. */
export async function indexCanonicalClaim(ownerId, fact) {
  if (!ownerId || !fact?.id || !isEmbeddingEnabled()) return false;
  const text = factText(fact);
  if (!text) return false;
  try {
    const id = String(fact.id);
    const hash = contentHash(text);
    const ns = namespace(ownerId);
    if (has(ns, id, hash)) return false;
    const vectors = await embed([text]);
    if (!vectors[0]) return false;
    upsert(ns, id, vectors[0], hash, { kind: 'claim' });
    return true;
  } catch (err) {
    console.warn('[E7] canonical claim indexing failed (non-fatal):', err?.message ?? err);
    return false;
  }
}

/**
 * Reconcile the complete canonical claim index for an owner. Used for initial
 * backfill and after destructive fact/file operations.
 */
export async function indexCanonicalClaims(ownerId, facts = []) {
  if (!ownerId || !isEmbeddingEnabled() || !Array.isArray(facts)) {
    return { indexed: 0, skipped: 0, removed: 0, enabled: false };
  }
  try {
    const ns = namespace(ownerId);
    const live = new Set();
    const pending = [];
    let skipped = 0;

    for (const fact of facts) {
      if (!fact?.id) continue;
      const text = factText(fact);
      if (!text) continue;
      const id = String(fact.id);
      live.add(id);
      const hash = contentHash(text);
      if (has(ns, id, hash)) { skipped += 1; continue; }
      pending.push({ id, text, hash });
    }

    let removed = 0;
    for (const id of idsIn(ns)) {
      if (!live.has(id)) { remove(ns, id); removed += 1; }
    }

    if (!pending.length) return { indexed: 0, skipped, removed, enabled: true };

    const vectors = await embed(pending.map(x => x.text));
    let indexed = 0;
    for (let i = 0; i < pending.length; i++) {
      if (vectors[i]) {
        upsert(ns, pending[i].id, vectors[i], pending[i].hash, { kind: 'claim' });
        indexed += 1;
      }
    }
    return { indexed, skipped, removed, enabled: true };
  } catch (err) {
    console.warn('[E7] canonical claim reconciliation failed (non-fatal):', err?.message ?? err);
    return { indexed: 0, skipped: 0, removed: 0, enabled: true, error: err?.message ?? String(err) };
  }
}

/**
 * Query canonical claim vectors. Returned Map keys are evidence-store fact IDs
 * and therefore directly match Context Engine candidate.semanticId.
 */
export async function canonicalClaimScores(ownerId, query) {
  if (!ownerId || !query?.trim() || !isEmbeddingEnabled()) return null;
  try {
    const qvec = await embedOne(query);
    if (!qvec) return null;
    const scores = scoreAgainst(namespace(ownerId), qvec);
    return scores.size ? scores : null;
  } catch (err) {
    console.warn('[E7] canonical claim scoring failed (non-fatal):', err?.message ?? err);
    return null;
  }
}

export function canonicalClaimNamespace(ownerId) {
  return namespace(ownerId);
}
