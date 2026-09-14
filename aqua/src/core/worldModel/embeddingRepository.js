/**
 * AQUA — Postgres embedding index for canonical World-Model claims (E7).
 *
 * This is an index, never a source of truth. Claims remain authoritative in
 * aqua_claims; embeddings can be deleted and rebuilt without changing a fact.
 * All reads/writes are owner-scoped and model-stamped.
 */
import crypto from 'node:crypto';
import { getPool, isConfigured } from '../db/pool.js';
import { EMBED_DIM, modelSignature } from '../../embeddings/embeddingModel.js';

export class EmbeddingRepositoryError extends Error {
  constructor(message) { super(message); this.name = 'EmbeddingRepositoryError'; }
}

function required(v, name) {
  if (v === undefined || v === null || v === '') throw new EmbeddingRepositoryError(`${name} is required`);
  return v;
}

/** Validate and serialize a pgvector literal without trusting caller text. */
export function vectorLiteral(vector) {
  if (!Array.isArray(vector) || vector.length !== EMBED_DIM) {
    throw new EmbeddingRepositoryError(`embedding must contain exactly ${EMBED_DIM} dimensions`);
  }
  if (!vector.every(Number.isFinite)) throw new EmbeddingRepositoryError('embedding contains a non-finite value');
  return `[${vector.join(',')}]`;
}

function configuredPool() {
  if (!isConfigured()) throw new EmbeddingRepositoryError('DATABASE_URL is not set');
  return getPool();
}

/** Insert or replace the current embedding for one claim/model signature. */
export async function upsertClaimEmbedding({ ownerId, claimId, vector, contentHash, signature = modelSignature() }) {
  required(ownerId, 'ownerId');
  required(claimId, 'claimId');
  required(contentHash, 'contentHash');
  const literal = vectorLiteral(vector);
  const p = await configuredPool();
  const embeddingId = crypto.createHash('sha256')
    .update(`${ownerId}\0claim\0${claimId}\0${signature}`)
    .digest('hex')
    .slice(0, 32);
  const { rows } = await p.query(
    `INSERT INTO aqua_embeddings
      (embedding_id, owner_id, target_kind, target_id, model_signature, vector, content_hash)
     VALUES ($1,$2,'claim',$3,$4,$5::vector,$6)
     ON CONFLICT (owner_id,target_kind,target_id,model_signature)
     DO UPDATE SET vector=EXCLUDED.vector, content_hash=EXCLUDED.content_hash, updated_at=now()
     RETURNING embedding_id, updated_at`,
    [embeddingId, ownerId, claimId, signature, literal, contentHash],
  );
  return rows[0] ?? { embedding_id: embeddingId };
}

/**
 * Dense cosine scores for one owner. Returns claim_id → similarity.
 * The query embeds the owner/model filter before ANN ordering and limits the
 * candidate pool; callers can fuse this lane with lexical/graph/structured.
 */
export async function scoreClaimEmbeddings({ ownerId, queryVector, signature = modelSignature(), limit = 64 }) {
  required(ownerId, 'ownerId');
  const literal = vectorLiteral(queryVector);
  const k = Math.max(1, Math.min(256, Math.floor(Number(limit) || 64)));
  const p = await configuredPool();
  const { rows } = await p.query(
    `SELECT target_id AS claim_id,
            1 - (vector <=> $2::vector) AS similarity
       FROM aqua_embeddings
      WHERE owner_id=$1
        AND target_kind='claim'
        AND model_signature=$3
      ORDER BY vector <=> $2::vector
      LIMIT $4`,
    [ownerId, literal, signature, k],
  );
  return new Map(rows.filter(r => Number.isFinite(Number(r.similarity)))
    .map(r => [String(r.claim_id), Number(r.similarity)]));
}

export async function claimEmbeddingCount({ ownerId, signature = modelSignature() }) {
  required(ownerId, 'ownerId');
  const p = await configuredPool();
  const { rows } = await p.query(
    `SELECT count(*)::int AS count FROM aqua_embeddings
      WHERE owner_id=$1 AND target_kind='claim' AND model_signature=$2`,
    [ownerId, signature],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Remove only the derived index row; the claim itself is untouched. */
export async function removeClaimEmbedding({ ownerId, claimId, signature = modelSignature() }) {
  required(ownerId, 'ownerId');
  required(claimId, 'claimId');
  const p = await configuredPool();
  const result = await p.query(
    `DELETE FROM aqua_embeddings
      WHERE owner_id=$1 AND target_kind='claim' AND target_id=$2 AND model_signature=$3`,
    [ownerId, claimId, signature],
  );
  return result.rowCount ?? 0;
}
