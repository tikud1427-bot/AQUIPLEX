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
import { textMeta, valueMeta, safeKey, fileMeta, stripQuoted } from '../core/logSafety.js';
import { isExternalFileId } from './externalIdentity.js';
import { isUnrestricted } from '../core/dataClass.js';
import { lockExternalSource, externalEnqueueState, observeExternalSource, externalResourcesDeletedSince } from '../core/worldModel/externalDeletionGuard.js';
import { checkFenceOn } from '../core/storage/writeFence.js';

/**
 * D-1 — the moment a SYNC saw an external source, for the enqueue check
 * (`observedAt` on each document). Taken under the per-source lock on the
 * database clock (externalDeletionGuard.observeExternalSource), so every
 * deletion of the source is strictly before it (and committed) or after it.
 *
 * Returns null without a database, or when the observation fails: the sync
 * itself goes on (file ingest needs no database), and an enqueue without an
 * observation is CONSERVATIVE — it refuses any resource a deletion covers.
 *
 * @param {string} ownerId
 * @param {string} ukoPrefix   the source's `ext_<sourceTag>_` prefix
 * @param {{ pool?: object }} [deps]
 * @returns {Promise<Date|null>}
 */
/**
 * Multi-instance connect safety — before an import batch: which of these
 * resources were deleted since the sync observed the source? Returns null when
 * there is no database (nothing can have been recorded); THROWS when the
 * database cannot answer (the caller refuses the batch — fail closed).
 * @returns {Promise<Set<string>|null>}
 */
export async function externalResourcesDeletedForImport(ownerId, ukoIds, observedAt, deps = {}) {
  let pool = deps.pool ?? null;
  if (!pool) {
    const db = await import('../core/db/pool.js');
    if (!db.isConfigured()) return null;
    pool = await db.getPool();
  }
  return externalResourcesDeletedSince(pool, { ownerId, ukoIds, observedAt });
}

export async function observeExternalSourceForSync(ownerId, ukoPrefix, deps = {}) {
  try {
    let pool = deps.pool ?? null;
    if (!pool) {
      const db = await import('../core/db/pool.js');
      if (!db.isConfigured()) return null;
      pool = await db.getPool();
    }
    return await observeExternalSource(pool, ownerId, ukoPrefix);
  } catch (err) {
    console.warn(`[FILES] source observation unavailable — external enqueue will be conservative: ${stripQuoted(String(err?.message ?? err))}`);
    return null;
  }
}

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
 * @param {Array<{ ukoId:string, name:string, kind?:string, text:string, hash?:string,
 *                 dataClass?:string, observedAt?:Date|string }>} args.documents
 *   External resources (source-derived ukoId) MUST carry their `dataClass` and
 *   SHOULD carry `observedAt` (externalDeletionGuard.observeExternalSource).
 * @param {object} [args.deps]  { enqueue, enabled, pool } for tests
 * @returns {Promise<{ enqueued:number, skipped:string|null, files:number, truncated:number,
 *                     refused:number, refusedReasons:string[] }>}
 *
 * G1-2 — an EXTERNAL resource is enqueued only when
 *   · its data class lets every provider see it (isUnrestricted); a missing or
 *     restricted class (e.g. external:gmail) is REFUSED — understanding sends
 *     text to an extraction provider and writes unlabeled canonical claims;
 *   · (D-1) no deletion covering it happened at or after the sync observed it:
 *     decided under the per-source lock, in the same transaction as the insert,
 *     so a deletion running concurrently either finished first (and is seen)
 *     or waits for this enqueue (and its job sweep then removes the job);
 *   · (D-2) its job key carries the deletion GENERATION (`:g<n>` once n > 0
 *     deletions have covered it), so the same version re-added after a
 *     deletion is a new job and is understood once more.
 */
export async function enqueueDocumentUnderstanding({ ownerId, documents = [], deps = {} } = {}) {
  const out = { enqueued: 0, skipped: null, files: 0, truncated: 0, refused: 0, refusedReasons: [] };
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
        console.warn(`[FILES] ${fileMeta(doc.name)}: ${all.length} chunks, understanding the first ${chunks.length} (MAX_CHUNKS)`);
      }
      const hash = doc.hash ?? crypto.createHash('sha256').update(doc.text).digest('hex');
      if (isExternalFileId(doc.ukoId)) {
        const r = await enqueueExternal({ ownerId, doc, hash, chunks, enqueue, deps });
        if (r.refused) { out.refused++; out.refusedReasons.push(r.refused); continue; }
        out.files++;
        out.enqueued += r.enqueued;
        continue;
      }
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
    if (out.refused) console.log(`[FILES] understanding refused owner=${ownerId} files=${out.refused} reasons=${[...new Set(out.refusedReasons)].join(',')}`);
    if (out.enqueued) console.log(`[FILES] understanding enqueued owner=${ownerId} files=${out.files} chunks=${out.enqueued}`);
    return out;
  } catch (err) {
    console.warn(`[FILES] document understanding not enqueued (fail-open): ${err?.message ?? err}`);
    return { ...out, skipped: 'error' };
  }
}

/**
 * The job key of one external chunk. G1-1: the source-derived ukoId is in it,
 * so identical text in an upload and a connected source never share one
 * canonical source. G1-2 / D-2: the deletion generation is appended once a
 * deletion has covered the resource (generation 0 keeps the G1-1 key).
 */
export function externalDocumentJobKey(ukoId, hash, chunkIndex, generation = 0) {
  return `${DOCUMENT_JOB_KIND}:${ukoId}:${String(hash).slice(0, 32)}:${chunkIndex}${generation > 0 ? `:g${generation}` : ''}`;
}

/** One external document's chunks, under the source lock, in one transaction (D-1/D-2). */
async function enqueueExternal({ ownerId, doc, hash, chunks, enqueue, deps }) {
  if (!isUnrestricted(doc.dataClass)) return { refused: 'data-class-restricted', enqueued: 0 };
  const pool = deps.pool ?? await (await import('../core/db/pool.js')).getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Multi-instance connect safety: inside a connect operation, prove this
    // process still holds the owner's lease in THIS transaction (lease row
    // first, then the source lock — one lock order everywhere).
    await checkFenceOn(client, ownerId);
    await lockExternalSource(client, ownerId, doc.ukoId);
    const state = await externalEnqueueState(client, { ownerId, ukoId: doc.ukoId, observedAt: doc.observedAt ?? null });
    if (state.deletedSince) {
      await client.query('ROLLBACK');
      return { refused: 'source-deleted', enqueued: 0 };
    }
    let enqueued = 0;
    for (const chunk of chunks) {
      await enqueue({
        ownerId, kind: DOCUMENT_JOB_KIND,
        payload: { ukoId: doc.ukoId, name: doc.name, hash, chunk: chunk.index, text: chunk.text },
        idempotencyKey: externalDocumentJobKey(doc.ukoId, hash, chunk.index, state.generation),
      }, { client });
      enqueued++;
    }
    await client.query('COMMIT');
    return { refused: null, enqueued };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
