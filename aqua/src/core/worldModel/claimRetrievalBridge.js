/**
 * Explicit bridge between canonical claim identity and the legacy retrieval
 * identity. It stores no belief content and cannot create claims.
 */
import { getPool, isConfigured } from '../db/pool.js';

export class ClaimRetrievalBridgeError extends Error {
  constructor(message) { super(message); this.name = 'ClaimRetrievalBridgeError'; }
}

function required(v, name) {
  if (v === undefined || v === null || v === '') throw new ClaimRetrievalBridgeError(`${name} is required`);
  return v;
}

export async function linkClaimRetrievalKey({ ownerId, claimId, retrievalKey }) {
  required(ownerId, 'ownerId'); required(claimId, 'claimId'); required(retrievalKey, 'retrievalKey');
  if (!isConfigured()) throw new ClaimRetrievalBridgeError('DATABASE_URL is not set');
  const p = await getPool();
  const { rows } = await p.query(`
    INSERT INTO aqua_claim_retrieval_bridge (owner_id, claim_id, retrieval_key)
    VALUES ($1,$2,$3)
    ON CONFLICT (owner_id, claim_id) DO UPDATE SET retrieval_key=EXCLUDED.retrieval_key
    RETURNING owner_id, claim_id, retrieval_key`, [ownerId, claimId, String(retrievalKey)]);
  return rows[0];
}

export async function claimIdsForRetrievalKeys({ ownerId, retrievalKeys = [] }) {
  required(ownerId, 'ownerId');
  if (!isConfigured() || !retrievalKeys.length) return new Map();
  const p = await getPool();
  const { rows } = await p.query(`
    SELECT retrieval_key, claim_id
      FROM aqua_claim_retrieval_bridge
     WHERE owner_id=$1 AND retrieval_key = ANY($2::text[])`, [ownerId, retrievalKeys.map(String)]);
  return new Map(rows.map(r => [String(r.retrieval_key), String(r.claim_id)]));
}

export async function retrievalKeysForClaimIds({ ownerId, claimIds = [] }) {
  required(ownerId, 'ownerId');
  if (!isConfigured() || !claimIds.length) return new Map();
  const p = await getPool();
  const { rows } = await p.query(`
    SELECT claim_id, retrieval_key
      FROM aqua_claim_retrieval_bridge
     WHERE owner_id=$1 AND claim_id = ANY($2::uuid[])`, [ownerId, claimIds.map(String)]);
  return new Map(rows.map(r => [String(r.claim_id), String(r.retrieval_key)]));
}
