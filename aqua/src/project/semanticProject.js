/**
 * AQUA Semantic Project Retrieval (Phase 2c — semantic code retrieval)
 * ─────────────────────────────────────────────────────────────────────────────
 * The code-corpus analog of semanticMemory.js. Same substrate (embeddingProvider
 * + vectorStore), same fail-open contract, same two-function shape the chat
 * pipeline calls at its async seam — so projectRetriever's synchronous _score
 * stays synchronous and its contract is unchanged.
 *
 * Granularity: ONE vector per file. projectRetriever ranks and returns FILES
 * (top-5), so file-level is the matching granularity that already exists — and
 * it mirrors memory's one-vector-per-fact. The embedded "signature" is a compact
 * description of what the file IS (path + summary + symbol names + a content
 * head), which is what lets a paraphrase query — "where do we handle retries" —
 * match a file whose CODE discusses retries even when its path and symbol names
 * share no tokens with the query (the exact keyword-retrieval ceiling).
 *
 *   indexWorkspaceFiles(workspaceId, index)  WRITE-side, fire-and-forget. Embeds
 *                                            only files whose signature changed
 *                                            (content-hash skip), prunes vectors
 *                                            for deleted files. Fired from the
 *                                            ingestion pipeline after buildIndex,
 *                                            and lazily as a one-time backfill
 *                                            for workspaces indexed before this
 *                                            feature existed.
 *
 *   semanticFileScores(workspaceId, query)   READ-side. Embeds the query once
 *                                            (cached — usually a hit from the
 *                                            same turn's memory retrieval) and
 *                                            returns Map<filePath, cosine> for
 *                                            projectRetriever to blend into its
 *                                            existing score. null when embeddings
 *                                            are unavailable OR the workspace has
 *                                            no vectors yet → keyword-only, i.e.
 *                                            byte-identical to pre-Phase-2c.
 *
 * Namespace: `ws:<workspaceId>` in vectorStore — isolated from memory owners.
 *
 * ── Scaling boundary ──────────────────────────────────────────────────────────
 * File-level vectors keep a normal repo well under vectorStore's per-namespace
 * cap. Very large repos (beyond the cap) evict oldest-touched files, which then
 * degrade to keyword — acceptable, and the signal that such a workspace should
 * move to chunk-level vectors in pgvector (the Phase 3 store swap). Documented
 * here so the boundary is explicit rather than surprising.
 */
import { embed, embedOne, isEmbeddingEnabled, contentHash } from '../embeddings/embeddingProvider.js';
import { upsert, has, remove, idsIn, scoreAgainst } from '../embeddings/vectorStore.js';
import { getIndex } from '../project/projectIndex.js';

const NS_PREFIX      = 'ws:';
const SIG_CONTENT_HEAD = 800;   // chars of file content folded into the signature

function nsFor(workspaceId) { return `${NS_PREFIX}${workspaceId}`; }

/** Compact "what is this file" signature that gets embedded. */
function fileSignature(filePath, entry) {
  const parts = [filePath];
  if (entry.summary) parts.push(entry.summary);

  const fns = (entry.functions ?? []).slice(0, 20).join(', ');
  if (fns) parts.push(`functions: ${fns}`);

  const classes = (entry.classes ?? [])
    .map(c => (typeof c === 'string' ? c : c.name)).filter(Boolean).slice(0, 12).join(', ');
  if (classes) parts.push(`classes: ${classes}`);

  const exports = (entry.exports ?? []).slice(0, 12).join(', ');
  if (exports) parts.push(`exports: ${exports}`);

  // Content head captures imports + top-of-file intent/comments — real semantic
  // signal beyond names. Kept short to keep the embedding call cheap.
  if (entry.content) parts.push(entry.content.slice(0, SIG_CONTENT_HEAD));

  return parts.join('\n');
}

/**
 * Ensure every current file in a workspace index has an up-to-date vector.
 * Embeds only changed/new signatures, prunes vectors for deleted files.
 * Fire-and-forget: callers do NOT await on the response path.
 * @param {string} workspaceId
 * @param {{ byPath: Map<string, object> }} index
 */
export async function indexWorkspaceFiles(workspaceId, index) {
  if (!workspaceId || !isEmbeddingEnabled() || !index?.byPath?.size) return;
  const ns = nsFor(workspaceId);
  try {
    const liveIds = new Set();
    const toEmbed = [];   // { path, text, hash }

    for (const [filePath, entry] of index.byPath.entries()) {
      liveIds.add(filePath);
      const text = fileSignature(filePath, entry);
      if (!text) continue;
      const h = contentHash(text);
      if (!has(ns, filePath, h)) toEmbed.push({ path: filePath, text, hash: h });
    }

    // Prune vectors for files no longer in the index (deleted / renamed).
    for (const id of idsIn(ns)) {
      if (!liveIds.has(id)) remove(ns, id);
    }

    if (!toEmbed.length) return;
    const vecs = await embed(toEmbed.map(t => t.text));
    toEmbed.forEach((t, i) => { if (vecs[i]) upsert(ns, t.path, vecs[i], t.hash); });
    const done = vecs.filter(Boolean).length;
    if (done) console.log(`[SEM_PROJECT] indexed ${done}/${toEmbed.length} file vector(s) workspace=${workspaceId}`);
  } catch (err) {
    console.warn('[SEM_PROJECT] indexWorkspaceFiles failed (non-fatal):', err.message);
  }
}

// One-time lazy backfill guard: workspaces indexed before this feature existed
// (or rebuilt after an edit) get their vectors on first query, without firing
// the embedding job more than once per workspace per process.
const backfilled = new Set();

/**
 * Semantic score of the query against a workspace's stored file vectors.
 * @returns {Promise<Map<string,number>|null>} filePath → cosine, or null when
 *   embeddings are unavailable or the workspace has no vectors yet (keyword
 *   fallback — identical to pre-Phase-2c).
 */
export async function semanticFileScores(workspaceId, query) {
  if (!workspaceId || !isEmbeddingEnabled() || !query || !query.trim()) return null;
  const ns = nsFor(workspaceId);
  try {
    // Lazy backfill: if this workspace has no vectors yet, kick indexing off
    // (fire-and-forget, once) and fall back to keyword THIS turn. Next turn is
    // semantic. Mirrors how memory backfills a user's facts on first touch.
    if (!idsIn(ns).length && !backfilled.has(workspaceId)) {
      backfilled.add(workspaceId);
      const index = getIndex(workspaceId);
      if (index?.byPath?.size) indexWorkspaceFiles(workspaceId, index).catch(() => {});
      return null;
    }

    const qvec = await embedOne(query);
    if (!qvec) return null;
    const scores = scoreAgainst(ns, qvec);
    return scores.size ? scores : null;
  } catch (err) {
    console.warn('[SEM_PROJECT] semanticFileScores failed (non-fatal):', err.message);
    return null;
  }
}

/** Test-only: reset the one-time backfill guard. */
export function __resetBackfillForTests() { backfilled.clear(); }
