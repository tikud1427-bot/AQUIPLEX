/**
 * AQUA — the claim repository
 * Blueprint E5/PR-3 · D2, L2 (the claim is the only atom), L9 (every write has
 * an actor), L19 (per-owner isolation is structural)
 *
 * THE ONE WRITER.
 *
 * Every claim that ever exists is created here. Not because a facade is tidy,
 * but because the alternative is what the audit found: three semantic stores
 * with three write paths, and the reason nobody can say what AQUA believes is
 * that it depends which one you ask.
 *
 * WHAT THIS MODULE REFUSES TO DO, AND WHY EACH REFUSAL IS LOAD-BEARING
 * -------------------------------------------------------------------
 *   no claim without evidence   The table demands it; this refuses BEFORE the
 *                               insert so the caller gets a readable error
 *                               rather than a constraint violation. A claim
 *                               with no span is a hallucination with a row.
 *
 *   no claim without an actor   L9. "Who said this?" must be answerable for
 *                               every row, including rows written by the
 *                               extractor at 3am.
 *
 *   no silent object guessing   The predicate declares its objectKind. A claim
 *                               whose object does not match is REFUSED, not
 *                               coerced — coercion is how `works_at` ends up
 *                               with a literal in half the rows and an entity
 *                               in the other half, and the join stops working.
 *
 *   no cross-owner write        Asserted per call. L19 says isolation is
 *                               structural; a repository that trusted its
 *                               caller would make it conventional again.
 *
 * SUPERSESSION IS A WRITE, NOT A DELETE
 * -------------------------------------
 * L5. `supersede()` marks the old claim and links it forward in ONE
 * transaction. Both halves or neither: a half-applied supersession leaves a
 * claim that is neither current nor superseded, and the retrieval baseline
 * already shows what happens when currency is ambiguous — the OLD employer
 * wins, measured at 20%.
 *
 * NOTHING CALLS THIS YET. E5/PR-4 is the extractor that does.
 */
import crypto from 'node:crypto';

import { getPool, isConfigured } from '../db/pool.js';
import { ensurePredicate, objectKindOf } from './predicateRegistry.js';

export class ClaimError extends Error {
  constructor(message) { super(message); this.name = 'ClaimError'; }
}

const POLARITIES = new Set(['asserted', 'negated']);
const MODALITIES = new Set(['fact', 'intent', 'hypothetical', 'question', 'quote']);

/**
 * Normalised statement text — the dedup key.
 *
 * Two utterances of the same sentence are ONE claim with two pieces of
 * evidence, which is what makes corroboration mean anything. Case and
 * whitespace differences are not new beliefs.
 */
export const normalizeStatement = text =>
  String(text ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();

/** Which object column a value belongs in, given the predicate. */
function objectColumns(predicate, object) {
  const kind = objectKindOf(predicate) ?? 'literal';
  const given = Object.keys(object).filter(k => object[k] !== undefined && object[k] !== null);

  if (given.length !== 1) {
    throw new ClaimError(
      `a claim needs exactly one object (got ${given.length}: ${given.join(', ') || 'none'}). ` +
      'Two objects is two claims; none is not a claim.');
  }
  const [form] = given;
  const expected = { entity: 'entityId', literal: 'literal', quantity: 'quantity', time: 'timeFrom' }[kind];

  if (form !== expected) {
    // Refused rather than coerced. Coercion is how one predicate ends up with
    // a literal in half its rows and an entity in the other half.
    throw new ClaimError(
      `predicate "${predicate}" expects a ${kind} object (${expected}), got ${form}. ` +
      'Register the predicate with a different objectKind, or fix the caller.');
  }

  return {
    object_entity_id: form === 'entityId' ? object.entityId : null,
    object_literal: form === 'literal' ? String(object.literal) : null,
    object_quantity: form === 'quantity' ? object.quantity : null,
    object_time_from: form === 'timeFrom' ? object.timeFrom : null,
  };
}

function validate(input) {
  for (const field of ['ownerId', 'subjectEntityId', 'predicate', 'statementText', 'actor', 'extractor']) {
    if (!input[field]) throw new ClaimError(`claim.${field} is required`);
  }
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    throw new ClaimError(
      'a claim needs at least one piece of evidence — a claim with no span is a hallucination with a database row');
  }
  const polarity = input.polarity ?? 'asserted';
  const modality = input.modality ?? 'fact';
  if (!POLARITIES.has(polarity)) throw new ClaimError(`unknown polarity "${polarity}"`);
  if (!MODALITIES.has(modality)) throw new ClaimError(`unknown modality "${modality}"`);
  if (input.validFrom && input.validTo && input.validTo < input.validFrom) {
    throw new ClaimError('validTo is before validFrom');
  }
  return { polarity, modality };
}

async function pool() {
  if (!isConfigured()) throw new ClaimError('DATABASE_URL is not set — claims have nowhere to go');
  return getPool();
}

/**
 * Record a claim, or attach evidence to the one that already says this.
 *
 * The dedup is the interesting half: the second time someone says a thing, the
 * right outcome is a STRONGER claim, not a second one. Returning
 * `{ created: false }` lets the caller see corroboration happening instead of
 * silently believing it wrote something new.
 */
export async function recordClaim(input) {
  const { polarity, modality } = validate(input);
  const predicateMeta = ensurePredicate(input.predicate);
  const predicate = predicateMeta.name;
  const objects = objectColumns(predicate, input.object ?? {});
  const norm = normalizeStatement(input.statementText);
  const p = await pool();
  const client = await p.connect();

  try {
    await client.query('BEGIN');

    // Lock the matching claim while deciding whether this write is new. This
    // makes the SELECT → INSERT/attach decision atomic for concurrent turns.
    const existing = await client.query(
      `SELECT claim_id FROM aqua_claims
        WHERE owner_id = $1 AND subject_entity_id = $2 AND predicate = $3 AND statement_norm = $4
        FOR UPDATE`,
      [input.ownerId, input.subjectEntityId, predicate, norm]);

    if (existing.rows.length) {
      const claimId = existing.rows[0].claim_id;
      const added = await attachEvidenceWithClient(
        client, claimId, input.ownerId, input.evidence, 'corroborating');
      await client.query('COMMIT');
      return { claimId, created: false, evidenceAdded: added };
    }

    const claimId = crypto.randomUUID();
    await client.query(
      `INSERT INTO aqua_claims (
         claim_id, owner_id, subject_entity_id, predicate,
         object_entity_id, object_literal, object_quantity, object_time_from,
         polarity, modality, valid_from, valid_to, asserted_at, time_precision,
         state, confidence_extraction, confidence_source, confidence_corroboration,
         extractor, extractor_version, actor, statement_text, statement_norm)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [claimId, input.ownerId, input.subjectEntityId, predicate,
        objects.object_entity_id, objects.object_literal, objects.object_quantity, objects.object_time_from,
        polarity, modality, input.validFrom ?? null, input.validTo ?? null,
        input.assertedAt ?? new Date(), input.timePrecision ?? 'none',
        input.state ?? 'extracted',
        input.confidenceExtraction ?? 0.5, input.confidenceSource ?? 0.5, 0.0,
        input.extractor, input.extractorVersion ?? 'v1', input.actor,
        input.statementText, norm]);

    const added = await attachEvidenceWithClient(
      client, claimId, input.ownerId, input.evidence, 'primary');

    // The outbox row is part of the SAME transaction as the belief. A crash
    // after COMMIT cannot lose the notification, and a crash before COMMIT
    // cannot publish a belief that was rolled back.
    await client.query(
      `INSERT INTO aqua_outbox (owner_id, event_type, aggregate_kind, aggregate_id, payload, actor)
       VALUES ($1, 'claim.created', 'claim', $2, $3::jsonb, $4)`,
      [input.ownerId, claimId, JSON.stringify({ claimId, predicate, polarity, modality }), input.actor]);

    await client.query('COMMIT');
    return { claimId, created: true, evidenceAdded: added };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function attachEvidenceWithClient(client, claimId, ownerId, evidenceIds, role = 'corroborating') {
  // Confirm the claim itself belongs to this owner before touching its links.
  const claim = await client.query(
    `SELECT 1 FROM aqua_claims WHERE claim_id = $1 AND owner_id = $2 FOR UPDATE`,
    [claimId, ownerId]);
  if (!claim.rows.length) {
    throw new ClaimError(`claim ${claimId} does not belong to ${ownerId} — cross-owner link refused`);
  }

  let added = 0;
  for (const evidenceId of evidenceIds) {
    const owned = await client.query(
      `SELECT 1 FROM aqua_evidence WHERE evidence_id = $1 AND owner_id = $2`, [evidenceId, ownerId]);
    if (!owned.rows.length) {
      throw new ClaimError(`evidence ${evidenceId} does not belong to ${ownerId} — cross-owner link refused`);
    }
    const existing = await client.query(
      `SELECT 1 FROM aqua_claim_evidence WHERE owner_id=$1 AND claim_id=$2 AND evidence_id=$3`,
      [ownerId, claimId, evidenceId]);
    if (existing.rows.length) continue;
    await client.query(
      `INSERT INTO aqua_claim_evidence (owner_id, claim_id, evidence_id, role) VALUES ($1,$2,$3,$4)`,
      [ownerId, claimId, evidenceId, role]);
    added++;
  }
  if (added) await recomputeCorroborationWithClient(client, claimId, ownerId);
  return added;
}

async function recomputeCorroborationWithClient(client, claimId, ownerId) {
  const { rows } = await client.query(
    `SELECT count(DISTINCT e.source_id)::int AS sources
       FROM aqua_claim_evidence ce
       JOIN aqua_evidence e ON e.evidence_id = ce.evidence_id
      WHERE ce.owner_id = $1 AND ce.claim_id = $2 AND ce.role <> 'contradicting'`,
    [ownerId, claimId]);
  const sources = Number(rows[0]?.sources ?? 0);
  const score = sources <= 1 ? 0 : Math.min(0.9, 1 - 1 / sources);
  await client.query(
    `UPDATE aqua_claims SET confidence_corroboration = $3, updated_at = now()
      WHERE claim_id = $1 AND owner_id = $2`, [claimId, ownerId, score]);
  return { sources, score };
}

/**
 * Link evidence to a claim.
 *
 * Cross-owner links are refused here rather than trusted, because a repository
 * that trusted its caller would turn L19 back into a convention.
 */
export async function attachEvidence(claimId, ownerId, evidenceIds, role = 'corroborating') {
  const p = await pool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const added = await attachEvidenceWithClient(client, claimId, ownerId, evidenceIds, role);
    await client.query('COMMIT');
    return added;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Corroboration from the number of DISTINCT SOURCES, not distinct evidence.
 *
 * Six quotes from one document is one source agreeing with itself. Counting
 * evidence rows would let a single chatty file manufacture confidence, which
 * is the failure mode consolidation already has to guard against.
 *
 * Derived on write rather than stored as an opinion (L7 in spirit: the inputs
 * are stored, the number is computed from them).
 */
export async function recomputeCorroboration(claimId, ownerId) {
  const p = await pool();
  return recomputeCorroborationWithClient(p, claimId, ownerId);
}

/**
 * Replace a claim with a newer one. ONE transaction, both halves or neither.
 *
 * A half-applied supersession leaves a claim that is neither current nor
 * superseded — and the retrieval baseline already measures what ambiguous
 * currency costs: the OLD employer wins, 20% on the superseded category.
 */
export async function supersede(oldClaimId, newClaimId, ownerId, { validTo = new Date() } = {}) {
  if (oldClaimId === newClaimId) throw new ClaimError('a claim cannot supersede itself');
  const p = await pool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE aqua_claims
          SET state = 'superseded', superseded_by = $2, valid_to = COALESCE(valid_to, $3), updated_at = now()
        WHERE claim_id = $1 AND owner_id = $4 AND state <> 'superseded'
        RETURNING claim_id`,
      [oldClaimId, newClaimId, validTo, ownerId]);
    if (!rows.length) {
      throw new ClaimError(
        `claim ${oldClaimId} is not supersedable by ${ownerId} — it is missing, already superseded, or another owner's`);
    }
    await client.query('COMMIT');
    return { superseded: oldClaimId, by: newClaimId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Live claims about a subject.
 *
 * `state <> 'superseded'` is the whole point: this is the query the current
 * engine cannot express, and its absence is why "where do I work" returns the
 * previous employer.
 */
export async function claimsAbout(ownerId, subjectEntityId, { includeSuperseded = false } = {}) {
  const p = await pool();
  const { rows } = await p.query(
    `SELECT * FROM aqua_claims
      WHERE owner_id = $1 AND subject_entity_id = $2
        ${includeSuperseded ? '' : "AND state <> 'superseded'"}
      ORDER BY asserted_at DESC`,
    [ownerId, subjectEntityId]);
  return rows;
}

/** A claim plus its evidence — provenance is never optional (L4). */
export async function claimWithEvidence(claimId, ownerId) {
  const p = await pool();
  const claim = await p.query(
    `SELECT * FROM aqua_claims WHERE claim_id = $1 AND owner_id = $2`, [claimId, ownerId]);
  if (!claim.rows.length) return null;
  const evidence = await p.query(
    `SELECT e.*, ce.role FROM aqua_claim_evidence ce
       JOIN aqua_evidence e ON e.evidence_id = ce.evidence_id
      WHERE ce.owner_id = $1 AND ce.claim_id = $2`, [ownerId, claimId]);
  return { ...claim.rows[0], evidence: evidence.rows };
}

/**
 * Erase one owner's claim-path data. E5/PR-6 · G4 · L5's one exception.
 *
 * 🔴 THIS WAS A REAL GAP, FOUND BY RUNNING THE GATE RATHER THAN READING IT.
 * PR-6 began writing owner-scoped rows into Postgres and `accountPurge` had no
 * path to them. Worse, the purge-completeness pin added in PR-4 could not see
 * the hole: it scans for modules EXPORTING `purgeOwner`, and a store that never
 * had one is invisible to a test that looks for one. A deleted user's claims
 * would have survived while every purge test stayed green.
 *
 * The fix is the convention, not a special case: this store now exports
 * `purgeOwner` like the other eight, so the completeness pin covers it for free
 * and the next store that forgets is caught by the same test.
 *
 * NO-OP WITHOUT POSTGRES, DELIBERATELY. Most deployments have no DATABASE_URL,
 * and a throw here would land in `accountPurge`'s `errors[]` — which the module
 * header defines as "NOT fully erased", a deletion-contract failure. Reporting
 * a compliance failure because a database the deployment never had is absent
 * would train callers to ignore the one array that must never be ignored.
 *
 * Order matters: evidence links reference claims, so links go first.
 */
export async function purgeOwner(ownerId) {
  if (!ownerId) return { claims: 0, evidenceLinks: 0, skipped: 'no owner' };
  if (!isConfigured()) return { claims: 0, evidenceLinks: 0, skipped: 'postgres not configured' };

  const p = await pool();
  const links = await p.query('DELETE FROM aqua_claim_evidence WHERE owner_id = $1', [ownerId]);
  const claims = await p.query('DELETE FROM aqua_claims WHERE owner_id = $1', [ownerId]);
  return { claims: claims.rowCount ?? 0, evidenceLinks: links.rowCount ?? 0, skipped: null };
}
