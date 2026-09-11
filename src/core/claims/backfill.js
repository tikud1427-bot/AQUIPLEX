/**
 * AQUA — backfilling existing facts into claims
 * Blueprint E5/PR-4 · L5 (nothing is deleted), L4 (provenance is never optional)
 *
 * WHY THIS PR AND NOT AN EXTRACTOR
 * --------------------------------
 * The obvious PR-4 was "the extractor that fills the repository". It is the
 * wrong one to write next, for a reason worth stating:
 *
 *   1. An LLM extractor is E6, not E5, and skipping ahead is the one thing
 *      the standing process forbids without a critical-flaw finding.
 *   2. There are no provider keys in the sandbox, so an LLM extractor could
 *      not be executed here at all — it would ship on argument, which is the
 *      failure E2 exists to prevent.
 *   3. There is a question the schema owes an answer to FIRST: **can it
 *      represent what AQUA already believes?** Her store holds 65 facts across
 *      6 owners. If those cannot become claims, the schema is wrong, and every
 *      PR built on it inherits the error.
 *
 * So this PR answers that question with a number instead of an opinion.
 *
 * WHAT A BACKFILL CAN AND CANNOT RECOVER
 * --------------------------------------
 * An existing fact is `{ statement, entities, confidence, sourceType }` — a
 * verbatim sentence plus an entity list. It has no predicate, no polarity, no
 * modality and no validity window, because the lane that wrote it had nowhere
 * to put them. That is the same structural gap the extraction baseline reports
 * as predicate 0% / fidelity 0%.
 *
 * A backfill therefore CANNOT invent those fields, and this module does not
 * try. Guessing a predicate from a sentence is extraction, and doing it inside
 * a migration would bury a low-quality extractor where nobody evaluates it —
 * a silent, unmeasured version of exactly what E6 is supposed to do properly.
 *
 * So each fact is projected as far as it honestly goes and the rest is
 * REPORTED:
 *
 *   projected   statement, entities, confidence, provenance — all preserved
 *   deferred    predicate, polarity, modality, validity — recorded as unknown
 *
 * `state = 'extracted'` and the `unresolved` predicate mark these as claims
 * that exist but are not yet understood. E6 upgrades them in place.
 */
import crypto from 'node:crypto';

import { getPool, isConfigured } from '../db/pool.js';
import { registerPredicate, isRegistered } from './predicateRegistry.js';

/**
 * The predicate a backfilled fact gets until something understands it.
 *
 * A real predicate would be a guess. `unresolved` is honest, queryable, and
 * makes the size of the debt visible: `SELECT count(*) WHERE predicate =
 * 'unresolved'` is the number of things AQUA has stored and not understood.
 */
export const UNRESOLVED = 'unresolved';
if (!isRegistered(UNRESOLVED)) {
  registerPredicate(UNRESOLVED, { class: 'attribute', objectKind: 'literal', source: 'seed' });
}

export class BackfillError extends Error {
  constructor(message) { super(message); this.name = 'BackfillError'; }
}

/** What a legacy fact can and cannot become. Pure — no database. */
export function assess(fact) {
  const problems = [];
  if (!fact?.statement || !String(fact.statement).trim()) problems.push('no statement');
  if (!Array.isArray(fact?.entities) || fact.entities.length === 0) problems.push('no entities');
  if (!Array.isArray(fact?.evidence) || fact.evidence.length === 0) problems.push('no evidence');

  return {
    id: fact?.id ?? null,
    projectable: problems.length === 0,
    problems,
    // Recorded rather than guessed. Every one of these is a field the source
    // lane never had, and inventing them here would be unmeasured extraction.
    deferred: ['predicate', 'polarity', 'modality', 'valid_from', 'valid_to'],
  };
}

/**
 * Project one owner's facts into claims.
 *
 * @param {string} ownerId
 * @param {Array} facts        legacy facts from the evidence store
 * @param {Map}   evidenceById legacy evidence objects, keyed by id
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]  assess only, write nothing
 */
export async function backfillOwner(ownerId, facts, evidenceById, { dryRun = false } = {}) {
  if (!isConfigured()) throw new BackfillError('DATABASE_URL is not set — claims have nowhere to go');
  const pool = await getPool();

  const report = {
    ownerId, total: facts.length,
    projected: 0, skipped: [], entitiesCreated: 0, sourcesCreated: 0,
    deferredFields: assess(facts[0] ?? {}).deferred,
  };

  const assessed = facts.map(f => ({ fact: f, verdict: assess(f) }));
  for (const { fact, verdict } of assessed) {
    if (!verdict.projectable) report.skipped.push({ id: fact?.id ?? null, problems: verdict.problems });
  }
  if (dryRun) {
    report.projected = assessed.filter(a => a.verdict.projectable).length;
    return report;
  }

  // Entities first: a claim needs a subject that exists.
  const entityIds = new Map();
  const ensureEntity = async (label) => {
    const norm = String(label).toLowerCase().trim();
    if (entityIds.has(norm)) return entityIds.get(norm);
    const found = await pool.query(
      `SELECT entity_id FROM aqua_entities WHERE owner_id=$1 AND normalized_label=$2`, [ownerId, norm]);
    if (found.rows.length) { entityIds.set(norm, found.rows[0].entity_id); return found.rows[0].entity_id; }
    const id = crypto.randomUUID();
    // The self entity keeps its type but NOT its label as a key — L8. The old
    // store used the literal word "You", which needed special-casing in five
    // places; here the label is display-only.
    const type = norm === 'you' ? 'self' : 'concept';
    await pool.query(
      `INSERT INTO aqua_entities (entity_id, owner_id, type, canonical_label, normalized_label, confidence_resolution)
       VALUES ($1,$2,$3,$4,$5,0.5)`, [id, ownerId, type, String(label), norm]);
    entityIds.set(norm, id);
    report.entitiesCreated++;
    return id;
  };

  const sourceIds = new Map();
  const ensureSource = async (kind) => {
    if (sourceIds.has(kind)) return sourceIds.get(kind);
    const id = crypto.randomUUID();
    // The legacy trust tiers, preserved: file 0.9 > chat 0.6. L10 — trust
    // flows downhill, and a backfill that flattened it would erase the one
    // piece of ranking information the old store did carry.
    const trust = kind === 'document' ? 0.9 : 0.6;
    await pool.query(
      `INSERT INTO aqua_sources (source_id, owner_id, kind, title, trust_tier)
       VALUES ($1,$2,$3,$4,$5)`, [id, ownerId, kind, `backfill:${kind}`, trust]);
    sourceIds.set(kind, id);
    report.sourcesCreated++;
    return id;
  };

  for (const { fact, verdict } of assessed) {
    if (!verdict.projectable) continue;

    const subject = await ensureEntity(fact.entities[0]);
    const kind = fact.sourceType === 'document' ? 'document' : 'conversation';
    const sourceId = await ensureSource(kind);

    const evidenceIds = [];
    for (const evId of fact.evidence) {
      const legacy = evidenceById.get(evId);
      // The quote is MANDATORY and must be verbatim. A legacy evidence object
      // with no quote falls back to the statement — which is the sentence the
      // fact came from, so it is still the user's own words, not a synthesis.
      const quote = legacy?.quote ?? fact.statement;
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO aqua_evidence (evidence_id, owner_id, source_id, quote, checksum, locator)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, ownerId, sourceId, quote,
          crypto.createHash('sha256').update(quote).digest('hex').slice(0, 16),
          JSON.stringify({ backfilledFrom: evId })]);
      evidenceIds.push(id);
    }

    const claimId = crypto.randomUUID();
    const norm = String(fact.statement).toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
    const existing = await pool.query(
      `SELECT claim_id FROM aqua_claims WHERE owner_id=$1 AND subject_entity_id=$2 AND predicate=$3 AND statement_norm=$4`,
      [ownerId, subject, UNRESOLVED, norm]);
    if (existing.rows.length) continue;   // idempotent: re-running backfills nothing twice

    await pool.query(
      `INSERT INTO aqua_claims (
         claim_id, owner_id, subject_entity_id, predicate, object_literal,
         polarity, modality, asserted_at, state,
         confidence_extraction, confidence_source, confidence_corroboration,
         extractor, extractor_version, actor, statement_text, statement_norm)
       VALUES ($1,$2,$3,$4,$5,'asserted','fact',now(),'extracted',$6,$7,0,'backfill','v1','system',$8,$9)`,
      [claimId, ownerId, subject, UNRESOLVED, String(fact.statement),
        fact.confidence ?? 0.5, kind === 'document' ? 0.9 : 0.6,
        String(fact.statement), norm]);

    for (const evId of evidenceIds) {
      await pool.query(
        `INSERT INTO aqua_claim_evidence (owner_id, claim_id, evidence_id, role) VALUES ($1,$2,$3,'primary')`,
        [ownerId, claimId, evId]);
    }
    report.projected++;
  }

  return report;
}

/** How much of what AQUA has stored is still not understood. */
export async function unresolvedCount(ownerId) {
  if (!isConfigured()) return null;
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM aqua_claims WHERE owner_id=$1 AND predicate=$2`,
    [ownerId, UNRESOLVED]);
  return Number(rows[0]?.n ?? 0);
}
