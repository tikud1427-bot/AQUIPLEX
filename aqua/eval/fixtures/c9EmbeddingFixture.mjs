/**
 * C9 embedding fixture — replayed offline (2026-11-07).
 *
 * Loads eval/fixtures/c9-semantic-relevance.embeddings.v1.json, written once by
 * scripts/record-c9-embeddings.mjs --live from REAL provider responses. This
 * module never embeds, never generates, and never substitutes a vector: when
 * the fixture is missing, describes a different dataset, or fails its own
 * integrity digest, it says so ({ available: false, reason }) and returns no
 * vectors at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = path.join(HERE, 'c9-semantic-relevance.embeddings.v1.json');
export const DATASET_PATH = path.join(HERE, '../datasets/c9-semantic-relevance.dev.v1.json');
export const EXPECTED = Object.freeze({ model: 'gemini-embedding-001', dim: 768 });

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const textKey = text => sha256(Buffer.from(String(text), 'utf8'));

export function vectorsDigest(vectors) {
  const h = crypto.createHash('sha256');
  for (const k of Object.keys(vectors).sort()) h.update(k).update(':').update(JSON.stringify(vectors[k])).update('\n');
  return h.digest('hex');
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** The dataset, always available (it is committed text, not vectors). */
export function loadDataset() {
  const body = fs.readFileSync(DATASET_PATH);
  return { dataset: JSON.parse(body.toString('utf8')), sha256: sha256(body) };
}

/**
 * @returns {{ available: false, reason: string } | { available: true, meta: object, dataset: object,
 *   vectorOf: (entryId: string) => number[], cos: (idA: string, idB: string) => number }}
 */
export function loadC9Fixture({ fixturePath = FIXTURE_PATH } = {}) {
  if (!fs.existsSync(fixturePath)) return { available: false, reason: `C9 embedding fixture UNAVAILABLE: ${path.basename(fixturePath)} has not been recorded (scripts/record-c9-embeddings.mjs --live, after approval)` };
  let fx;
  try { fx = JSON.parse(fs.readFileSync(fixturePath, 'utf8')); } catch (err) { return { available: false, reason: `C9 embedding fixture unreadable: ${err.message}` }; }
  const { dataset, sha256: datasetSha } = loadDataset();
  if (fx.model !== EXPECTED.model) return { available: false, reason: `fixture model ${fx.model} is not ${EXPECTED.model}` };
  if (fx.dim !== EXPECTED.dim) return { available: false, reason: `fixture dimension ${fx.dim} is not ${EXPECTED.dim}` };
  if (fx.dataset?.sha256 !== datasetSha) return { available: false, reason: `fixture was recorded for dataset ${fx.dataset?.sha256}, the dataset is now ${datasetSha} (stale)` };
  if (!fx.vectors || vectorsDigest(fx.vectors) !== fx.vectorsSha256) return { available: false, reason: 'fixture vectors do not match their recorded digest (altered or truncated)' };
  const entries = new Map([...dataset.statements, ...dataset.queries].map(e => [e.id, e]));
  for (const e of entries.values()) {
    const v = fx.vectors[textKey(e.text)];
    if (!Array.isArray(v) || v.length !== EXPECTED.dim || !v.every(Number.isFinite)) return { available: false, reason: `fixture has no valid vector for ${e.id}` };
  }
  const vectorOf = id => { const e = entries.get(id); if (!e) throw new Error(`unknown entry ${id}`); return fx.vectors[textKey(e.text)]; };
  const { vectors, ...meta } = fx;
  return { available: true, meta, dataset, vectorOf, cos: (a, b) => cosine(vectorOf(a), vectorOf(b)) };
}
