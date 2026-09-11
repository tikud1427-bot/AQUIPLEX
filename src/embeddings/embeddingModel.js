/**
 * Embedding model identity — one source of truth for the provider AND the store.
 *
 * WHY THIS TINY MODULE EXISTS
 * ---------------------------
 * Vectors are persisted (`.aqua-vectors.json`) and compared with cosine
 * similarity. Cosine only means anything BETWEEN VECTORS FROM THE SAME MODEL:
 * two embedding models can share a dimension count and still occupy entirely
 * unrelated spaces.
 *
 * That makes a model change dangerous in a way a dimension change is not. A
 * dimension mismatch fails loudly — `cosineSim` returns 0 on unequal lengths.
 * A SAME-DIMENSION model change fails silently: every stored vector keeps
 * scoring, and every score is meaningless. Retrieval would look healthy and be
 * wrong.
 *
 * So the store stamps each record with the signature below and discards
 * anything foreign. The provider and the store must agree on that signature
 * exactly, which is why it lives here rather than being derived twice.
 *
 * THE DEFAULT CHANGED, DELIBERATELY
 * ---------------------------------
 * It was `text-embedding-004`, which Google shut down on 14 January 2026.
 * Production logs showed every single turn failing with
 * `models/text-embedding-004 is not found for API version v1beta`, silently
 * falling back to keyword scoring. A default that cannot succeed is a bug, not
 * a configuration choice. `AQUA_EMBED_MODEL` still overrides it.
 *
 * `gemini-embedding-001` returns 3072 dimensions natively and accepts a
 * reduced `outputDimensionality`. 768 is the default here because it matches
 * the footprint the store was already sized and tuned for, and keeps payloads
 * a quarter the size. Set AQUA_EMBED_DIM to 1536 or 3072 to trade storage for
 * fidelity — the signature changes with it, so the store rebuilds itself
 * safely rather than mixing.
 *
 * Note: below its native size this model does not renormalise. That is fine
 * here because `cosineSim` divides by both magnitudes, but it is the reason
 * not to assume stored vectors are unit length.
 */

/** Active embedding model. Override with AQUA_EMBED_MODEL. */
export const EMBED_MODEL = process.env.AQUA_EMBED_MODEL || 'gemini-embedding-001';

/** Requested output dimensionality. Override with AQUA_EMBED_DIM. */
export const EMBED_DIM = (() => {
  const raw = Number(process.env.AQUA_EMBED_DIM);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 768;
})();

/**
 * The stamp written onto every stored vector.
 *
 * Read fresh rather than cached at import so tests can flip the env without
 * module surgery; it is two env reads and a template string, called on write
 * and on load, never in a scoring loop.
 */
export function modelSignature() {
  const model = process.env.AQUA_EMBED_MODEL || 'gemini-embedding-001';
  const raw = Number(process.env.AQUA_EMBED_DIM);
  const dim = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 768;
  return `${model}@${dim}`;
}
