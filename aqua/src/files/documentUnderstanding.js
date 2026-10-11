/**
 * AQUA — uploaded documents → the canonical World Model (2026-10-11).
 *
 * THE GAP THIS CLOSES: an upload filled the legacy evidence store, the PIC
 * graph and the Mind (routes/upload.js → fileEngine.ingestFiles →
 * observeIngest), and was injected into prompts only while its conversation
 * lasted. Nothing from a file ever became a canonical claim, so the World
 * Model — the thing the answer path reads in every later conversation — never
 * learned that the lease is $6,400 a month or who owns the support runbook.
 *
 * WHAT IT DOES: the document's text, split into bounded chunks, is enqueued as
 * durable `understanding.document.v1` jobs. The worker runs each chunk through
 * the SAME understanding pipeline as a chat turn (Brain.understandTurn: E6
 * extraction, S6 identity, S8 reconciliation, S9 commit) with a DOCUMENT
 * source — kind 'document', the file trust tier, the file name as provenance.
 * One extractor, one reconciliation policy, one store (L8): a file is evidence
 * like a turn is, just with a different source.
 *
 * Bounded (G6): at most MAX_CHUNKS chunks of ≤ CHUNK_CHARS per file; a longer
 * document contributes its first MAX_CHUNKS chunks and says so in the log.
 * Idempotent: the job key is (owner, file content hash, chunk), so re-uploading
 * the same file enqueues nothing new, and the commit ledger dedups replays.
 * Fail-open (L11): an upload never fails because understanding is unavailable.
 */
import crypto from 'node:crypto';

export const DOCUMENT_JOB_KIND = 'understanding.document.v1';
export const MAX_CHUNKS = 24;
export const CHUNK_CHARS = 700;
/** File kinds whose text is not a statement about the user's world. */
const SKIP_KINDS = new Set(['repository', 'code', 'archive']);

/**
 * Split text into chunks on paragraph, then line, boundaries; a single line
 * longer than `chunkChars` is cut at the last sentence end that fits.
 * @returns {{ index:number, text:string }[]}
 */
export function chunkDocument(text, { maxChunks = MAX_CHUNKS, chunkChars = CHUNK_CHARS } = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trim());
  const units = [];
  for (const line of lines) {
    if (!line) { units.push(''); continue; }
    let rest = line;
    while (rest.length > chunkChars) {
      const cut = Math.max(rest.lastIndexOf('. ', chunkChars), rest.lastIndexOf('; ', chunkChars));
      const at = cut > chunkChars / 3 ? cut + 1 : chunkChars;
      units.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) units.push(rest);
  }
  const chunks = [];
  let cur = '';
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  for (const u of units) {
    if (!u) { flush(); continue; }                       // paragraph boundary
    if (cur && cur.length + 1 + u.length > chunkChars) flush();
    // A line without terminal punctuation ("Rent: $6,400") is a sentence of its
    // own: the segmenter must not glue it to the next line.
    cur += (cur ? '\n' : '') + (/[.!?;:]$/.test(u) ? u : `${u}.`);
  }
  flush();
  return chunks.slice(0, maxChunks).map((t, index) => ({ index, text: t }));
}

/**
 * Enqueue understanding jobs for uploaded documents. Never throws.
 *
 * @param {object} args
 * @param {string} args.ownerId
 * @param {Array<{ ukoId:string, name:string, kind?:string, text:string, hash?:string }>} args.documents
 * @param {object} [args.deps]  { enqueue, enabled } for tests
 * @returns {Promise<{ enqueued:number, skipped:string|null, files:number, truncated:number }>}
 */
export async function enqueueDocumentUnderstanding({ ownerId, documents = [], deps = {} } = {}) {
  const out = { enqueued: 0, skipped: null, files: 0, truncated: 0 };
  try {
    if (!ownerId) return { ...out, skipped: 'no-owner' };
    const enabled = deps.enabled ?? (async () => {
      const { isConfigured } = await import('../core/db/pool.js');
      const Brain = await import('../brain/index.js');
      return isConfigured() && Brain.e6Enabled() && Brain.e6CommitEnabled();
    });
    if (!(await enabled())) return { ...out, skipped: 'understanding-off' };
    const enqueue = deps.enqueue ?? (await import('../core/jobs/jobQueue.js')).enqueue;
    for (const doc of Array.isArray(documents) ? documents : []) {
      if (!doc?.text?.trim() || SKIP_KINDS.has(doc.kind)) continue;
      const all = chunkDocument(doc.text, { maxChunks: Number.MAX_SAFE_INTEGER });
      const chunks = all.slice(0, MAX_CHUNKS);
      if (all.length > chunks.length) {
        out.truncated++;
        console.warn(`[FILES] ${doc.name}: ${all.length} chunks, understanding the first ${chunks.length} (MAX_CHUNKS)`);
      }
      const hash = doc.hash ?? crypto.createHash('sha256').update(doc.text).digest('hex');
      out.files++;
      for (const chunk of chunks) {
        await enqueue({
          ownerId, kind: DOCUMENT_JOB_KIND,
          payload: { ukoId: doc.ukoId ?? null, name: doc.name, hash, chunk: chunk.index, text: chunk.text },
          idempotencyKey: `${DOCUMENT_JOB_KIND}:${hash.slice(0, 32)}:${chunk.index}`,
        });
        out.enqueued++;
      }
    }
    if (out.enqueued) console.log(`[FILES] understanding enqueued owner=${ownerId} files=${out.files} chunks=${out.enqueued}`);
    return out;
  } catch (err) {
    console.warn(`[FILES] document understanding not enqueued (fail-open): ${err?.message ?? err}`);
    return { ...out, skipped: 'error' };
  }
}
