/**
 * AQUIPLEX — E9 / PR-2 belief ↔ canonical claim relationship repository.
 *
 * This is a provenance index, not a knowledge store. Claims remain canonical
 * in aqua_claims; beliefs remain in Mind. Every operation requires ownerId and
 * all claim access is structurally owner-scoped in SQL.
 */
import { getPool, isConfigured } from '../db/pool.js';

export class BeliefClaimError extends Error {
  constructor(message) { super(message); this.name = 'BeliefClaimError'; }
}

const RELATIONS = new Set(['supporting', 'contradicting']);

async function pool() {
  if (!isConfigured()) throw new BeliefClaimError('DATABASE_URL is not set');
  return getPool();
}

function validateOwner(ownerId) {
  if (!ownerId) throw new BeliefClaimError('ownerId is required');
}

function validateRelation(relation) {
  const r = relation ?? 'supporting';
  if (!RELATIONS.has(r)) throw new BeliefClaimError(`unknown relation "${r}"`);
  return r;
}

function validateWeight(weight) {
  const n = Number(weight ?? 1);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new BeliefClaimError('weight must be between 0 and 1');
  }
  return n;
}

export async function linkBeliefClaim({
  ownerId, beliefId, dimension, beliefKey, claimId,
  relation = 'supporting', weight = 1,
} = {}) {
  validateOwner(ownerId);
  if (!beliefId || !dimension || !beliefKey || !claimId) {
    throw new BeliefClaimError('beliefId, dimension, beliefKey and claimId are required');
  }
  const rel = validateRelation(relation);
  const w = validateWeight(weight);
  const p = await pool();
  const result = await p.query(
    `INSERT INTO aqua_belief_claims
       (owner_id, belief_id, dimension, belief_key, claim_id, relation, weight)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (owner_id, belief_id, claim_id)
     DO UPDATE SET dimension = EXCLUDED.dimension,
                   belief_key = EXCLUDED.belief_key,
                   relation = EXCLUDED.relation,
                   weight = EXCLUDED.weight,
                   updated_at = now()
     RETURNING owner_id, belief_id, dimension, belief_key, claim_id, relation, weight,
               created_at, updated_at`,
    [ownerId, beliefId, dimension, beliefKey, claimId, rel, w]
  );
  return result.rows[0];
}

export async function unlinkBeliefClaim({ ownerId, beliefId, claimId } = {}) {
  validateOwner(ownerId);
  if (!beliefId || !claimId) throw new BeliefClaimError('beliefId and claimId are required');
  const p = await pool();
  const result = await p.query(
    `DELETE FROM aqua_belief_claims
      WHERE owner_id = $1 AND belief_id = $2 AND claim_id = $3
      RETURNING claim_id`,
    [ownerId, beliefId, claimId]
  );
  return result.rowCount === 1;
}

export async function claimsForBelief({ ownerId, beliefId } = {}) {
  validateOwner(ownerId);
  if (!beliefId) throw new BeliefClaimError('beliefId is required');
  const p = await pool();
  const result = await p.query(
    `SELECT owner_id, belief_id, dimension, belief_key, claim_id, relation, weight,
            created_at, updated_at
       FROM aqua_belief_claims
      WHERE owner_id = $1 AND belief_id = $2
      ORDER BY created_at ASC`,
    [ownerId, beliefId]
  );
  return result.rows;
}

export async function beliefsForClaim({ ownerId, claimId } = {}) {
  validateOwner(ownerId);
  if (!claimId) throw new BeliefClaimError('claimId is required');
  const p = await pool();
  const result = await p.query(
    `SELECT owner_id, belief_id, dimension, belief_key, claim_id, relation, weight,
            created_at, updated_at
       FROM aqua_belief_claims
      WHERE owner_id = $1 AND claim_id = $2
      ORDER BY created_at ASC`,
    [ownerId, claimId]
  );
  return result.rows;
}
