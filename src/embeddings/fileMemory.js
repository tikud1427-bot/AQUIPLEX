/**
 * AQUA File Memory (Memory 5.0, Phase D — file content becomes knowledge)
 * ─────────────────────────────────────────────────────────────────────────────
 * Before: an upload survived only as a 280-char summary in mind.files — the
 * CONTENT was gone after the turn. "What did that PDF say about pricing?"
 * next week was unanswerable. Now uploads become durable, semantically
 * searchable owner knowledge:
 *
 *   indexFileChunks(owner, fileKey, name, content)
 *       WRITE-side, fire-and-forget (never awaited on a request path).
 *       Chunks the extracted text, embeds only misses (per-chunk content
 *       hash), stores each vector WITH its source text in vectorStore
 *       namespace `files:<ownerId>` — one namespace per owner, so chunks
 *       can never cross owners by construction.
 *
 *   fileChunkScores(owner, query)
 *       READ-side. Embeds the query once (provider caches) and returns the
 *       top matching chunks [{ text, name, fileKey, score }]. Empty array
 *       when embeddings are unavailable — the FILE RECALL lane simply
 *       doesn't appear, and behavior matches pre-Phase-D exactly.
 *
 *   removeFileChunks / clearOwnerFileChunks
 *       Eviction (file-memory cap) + GDPR cascade.
 *
 * Same architecture rules as every memory stage: zero new deps, existing
 * vectorStore tier (meta is an additive record field), fail-open everywhere.
 */
import { embed, embedOne, isEmbeddingEnabled, contentHash } from './embeddingProvider.js';
import { upsert, has, remove, idsIn, topK, getMeta, clearNamespace } from './vectorStore.js';

export const CHUNK_CHARS = 700;          // target chunk size
export const MAX_CHUNKS_PER_FILE = 30;   // per-file cap (big docs: head coverage)
export const CHUNK_MIN_SCORE = 0.60;     // cosine floor — below this, not recall

export function fileNamespace(ownerId) {
  return `files:${ownerId}`;
}

function chunkIdPrefix(fileKey) {
  return `${fileKey}#`;
}

// ── Chunking ──────────────────────────────────────────────────────────────────
/**
 * Paragraph-first packer: paragraphs are merged up to CHUNK_CHARS; an
 * over-long paragraph is split on sentence boundaries, then hard-split as a
 * last resort. Pure, deterministic, capped.
 */
export function chunkText(content, { chunkChars = CHUNK_CHARS, maxChunks = MAX_CHUNKS_PER_FILE } = {}) {
  const text = String(content || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const units = [];
  for (const p of paragraphs) {
    if (p.length <= chunkChars) { units.push(p); continue; }
    // sentence split for oversized paragraphs
    const sentences = p.match(/[^.!?\n]+[.!?]?\s*/g) || [p];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > chunkChars && buf) { units.push(buf.trim()); buf = ''; }
      if (s.length > chunkChars) {
        // pathological unbroken run — hard split
        for (let i = 0; i < s.length; i += chunkChars) units.push(s.slice(i, i + chunkChars).trim());
      } else {
        buf += s;
      }
    }
    if (buf.trim()) units.push(buf.trim());
  }

  // pack units up to chunkChars
  const chunks = [];
  let buf = '';
  for (const u of units) {
    if ((buf ? buf.length + 2 : 0) + u.length > chunkChars && buf) { chunks.push(buf); buf = ''; }
    buf = buf ? `${buf}\n\n${u}` : u;
    if (chunks.length >= maxChunks) break;
  }
  if (buf && chunks.length < maxChunks) chunks.push(buf);
  return chunks.slice(0, maxChunks);
}

// ── Write side ────────────────────────────────────────────────────────────────
/**
 * (Re)index one file's content for an owner. Fire-and-forget; callers never
 * await on a request path. Re-upload of identical content is a no-op per
 * chunk (content-hash skip); changed content re-embeds only changed chunks
 * and prunes chunks that no longer exist.
 */
export async function indexFileChunks(ownerId, fileKey, name, content) {
  if (!ownerId || !fileKey || !isEmbeddingEnabled()) return;
  try {
    const nsKey = fileNamespace(ownerId);
    const chunks = chunkText(content);
    const prefix = chunkIdPrefix(fileKey);

    const live = new Set();
    const toEmbed = []; // { id, text, hash }
    chunks.forEach((text, idx) => {
      const id = `${prefix}${idx}`;
      live.add(id);
      const h = contentHash(text);
      if (!has(nsKey, id, h)) toEmbed.push({ id, text, hash: h, idx });
    });

    // prune stale chunk ids for THIS file (shrunk / changed re-upload)
    for (const id of idsIn(nsKey)) {
      if (id.startsWith(prefix) && !live.has(id)) remove(nsKey, id);
    }

    if (!toEmbed.length) return;
    const vecs = await embed(toEmbed.map(t => t.text));
    toEmbed.forEach((t, i) => {
      if (vecs[i]) upsert(nsKey, t.id, vecs[i], t.hash, { text: t.text, fileKey, name, idx: t.idx });
    });
    const done = vecs.filter(Boolean).length;
    if (done) console.log(`[FILE_MEM] indexed ${done}/${toEmbed.length} chunk(s) owner=${ownerId} file="${name}"`);
  } catch (err) {
    console.warn('[FILE_MEM] indexFileChunks failed (non-fatal):', err.message);
  }
}

// ── Read side ─────────────────────────────────────────────────────────────────
/**
 * Top semantically-matching chunks of the owner's uploaded files for a query.
 * @returns {Promise<Array<{ text, name, fileKey, idx, score }>>} [] fail-open.
 */
export async function fileChunkScores(ownerId, query, { k = 4, minScore = CHUNK_MIN_SCORE } = {}) {
  if (!ownerId || !isEmbeddingEnabled() || !query || !query.trim()) return [];
  try {
    const nsKey = fileNamespace(ownerId);
    const qvec = await embedOne(query);
    if (!qvec) return [];
    const hits = topK(nsKey, qvec, k, minScore);
    const out = [];
    for (const { id, score } of hits) {
      const meta = getMeta(nsKey, id);
      if (meta?.text) out.push({ text: meta.text, name: meta.name, fileKey: meta.fileKey, idx: meta.idx, score: +score.toFixed(3) });
    }
    return out;
  } catch (err) {
    console.warn('[FILE_MEM] fileChunkScores failed (non-fatal):', err.message);
    return [];
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
/** Drop every chunk of one file (file-memory cap eviction). */
export function removeFileChunks(ownerId, fileKey) {
  if (!ownerId || !fileKey) return;
  try {
    const nsKey = fileNamespace(ownerId);
    const prefix = chunkIdPrefix(fileKey);
    for (const id of idsIn(nsKey)) {
      if (id.startsWith(prefix)) remove(nsKey, id);
    }
  } catch { /* non-fatal */ }
}

/** GDPR cascade: every file chunk for an owner. */
export function clearOwnerFileChunks(ownerId) {
  if (ownerId) clearNamespace(fileNamespace(ownerId));
}
