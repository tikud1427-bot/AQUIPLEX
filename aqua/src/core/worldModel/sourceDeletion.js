/**
 * AQUA — G1-1: source-scoped deletion of canonical (Postgres) knowledge.
 *
 * Removes everything the canonical World Model derived from ONE external
 * source (or one resource, or one version of a resource) — identified by the
 * Phase 1a.2 source-derived UKO-id prefix — while keeping every claim that has
 * independent support from another source (a conversation, an upload, another
 * connector).
 *
 * LINK: understanding of an external resource records its canonical source as
 *   aqua_sources.external_ref = 'extuko:<ukoId>:chunk:<n>'
 * (brain/index.js, workerRuntime.js, documentUnderstanding.js — G1-1 tagging).
 * ukoId = ext_<sourceTag12>_<itemTag16>_<versionTag> (files/externalIdentity.js),
 * so a source, a resource and a version are all prefixes of it.
 *
 * ALGORITHM (one client, BEGIN … COMMIT; any error → ROLLBACK, nothing changed):
 *   1  S  = this owner's sources whose external_ref starts with 'extuko:'+prefix
 *          (minus a kept version, for resource updates)
 *   2  E  = evidence of S;  C = claims linked to E
 *   3  a claim in C SURVIVES when it keeps ≥1 primary/corroborating evidence
 *      from a source NOT in S; otherwise it is DELETED (D). Contradicting
 *      evidence is not support.
 *   4  for D: edges (DE) and events (DV) built on them; claims/edges/events
 *      that D/DE/DV SUPERSEDED are RESTORED (state from their supersede
 *      revision, superseded_by NULL, a valid_to cutoff written by that
 *      supersession cleared); history rows (lifecycle, revisions,
 *      corrections), outbox events, queued jobs, retrieval bridge, embeddings,
 *      belief links, intervention evidence; interventions left with no evidence
 *      (and their action runs + events); then the rows themselves
 *   5  survivors: their S-evidence links removed, corroboration recomputed
 *   6  evidence E, commit-ledger rows and the sources S
 *   7  entities created by S (canonical alias from S) that nothing references
 *      any more are deleted; surviving entities keep their aliases with the
 *      deleted source's id cleared; non-canonical aliases from S are removed
 *   8  queued document-understanding jobs for the prefix (never a running one;
 *      running ones are counted and reported)
 * After COMMIT (idempotent, reported): canonical-claim vectors for D are
 * removed; Mind beliefs that ONLY the deleted claims supported are deleted
 * (bridge-seeded, every observation accounted for); others are reported.
 *
 * Owner isolation: every statement is (owner_id = $1, …). The prefix must be
 * an external UKO prefix — this can never address an upload or a conversation.
 * Without Postgres it is a no-op that says so (same convention as purgeOwner).
 */
import crypto from 'node:crypto';
import { getPool, isConfigured } from '../db/pool.js';
import { recomputeCorroborationWithClient } from '../claims/claimRepository.js';
import { lockExternalSource, recordExternalDeletion } from './externalDeletionGuard.js';
import { checkFenceOn } from '../storage/writeFence.js';

export const EXTUKO_REF_PREFIX = 'extuko:';
const DOCUMENT_JOB_KIND = 'understanding.document.v1';
const PREFIX_RE = /^ext_[0-9a-f]{12}_(?:[0-9a-f]{16}_(?:[0-9a-f]{1,12})?)?$/;
const SUPPORT_ROLES = new Set(['primary', 'corroborating']);
const SYSTEM_ACTOR = 'system:source-deletion';

export class SourceDeletionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** The canonical external_ref of a chunk of an external resource. */
export const externalUnderstandingRef = (ukoId, chunk) => `${EXTUKO_REF_PREFIX}${ukoId}:chunk:${Number.isInteger(chunk) ? chunk : 0}`;

function validate(ownerId, ukoPrefix, keepUkoId) {
  if (typeof ownerId !== 'string' || !ownerId.trim()) throw new SourceDeletionError('OWNER_REQUIRED', 'ownerId is required');
  if (typeof ukoPrefix !== 'string' || !PREFIX_RE.test(ukoPrefix)) throw new SourceDeletionError('PREFIX_INVALID', 'not an external source/resource/version prefix');
  if (keepUkoId != null && (typeof keepUkoId !== 'string' || !keepUkoId.startsWith(ukoPrefix))) throw new SourceDeletionError('KEEP_INVALID', 'keepUkoId must be under the prefix');
}

const zeroCounts = () => ({
  sources: 0, evidence: 0, claimsDeleted: 0, claimsKept: 0, claimsRestored: 0,
  edgesDeleted: 0, edgesRestored: 0, eventsDeleted: 0, eventsRestored: 0,
  history: 0, outbox: 0, jobs: 0, runningJobsSkipped: 0, bridge: 0, beliefLinks: 0,
  interventionLinks: 0, interventionsDeleted: 0, actionRunsDeleted: 0, ledger: 0,
  entitiesDeleted: 0, aliasesDeleted: 0, aliasesUnlinked: 0,
  vectorsRemoved: 0, beliefsDeleted: 0, beliefsKept: 0, beliefsValueFromDeletedSource: 0,
});

/** Sources under the prefix (portable prefix match: no SQL wildcards on user data). */
async function sourcesUnder(q, ownerId, ukoPrefix, keepUkoId) {
  const { rows } = await q.query(
    `SELECT source_id, external_ref FROM aqua_sources WHERE owner_id = $1 AND external_ref LIKE 'extuko:%'`, [ownerId]);
  const want = EXTUKO_REF_PREFIX + ukoPrefix;
  const keep = keepUkoId ? `${EXTUKO_REF_PREFIX}${keepUkoId}:` : null;
  return rows.filter(r => typeof r.external_ref === 'string' && r.external_ref.startsWith(want) && !(keep && r.external_ref.startsWith(keep)))
    .map(r => String(r.source_id));
}

async function documentJobsUnder(q, ownerId, ukoPrefix, keepUkoId) {
  const { rows } = await q.query(
    `SELECT job_id, state, payload->>'ukoId' AS uko FROM aqua_jobs WHERE owner_id = $1 AND kind = $2`, [ownerId, DOCUMENT_JOB_KIND]);
  return rows.filter(r => typeof r.uko === 'string' && r.uko.startsWith(ukoPrefix) && r.uko !== keepUkoId);
}

/**
 * Restore a claim/edge/event that a deleted row superseded. State comes from
 * its own 'supersede' revision (before.state); a valid_to cutoff written by
 * that supersession (no earlier than the revision, within 5 s) is cleared.
 * A restored CLAIM that would duplicate a current claim is archived instead.
 */
async function restoreSuperseded(client, ownerId, kind, id) {
  const table = { claim: 'aqua_claims', edge: 'aqua_edges', event: 'aqua_events' }[kind];
  const idCol = `${kind}_id`;
  const { rows: rev } = await client.query(
    `SELECT before, created_at FROM aqua_revisions
      WHERE owner_id = $1 AND target_kind = $2 AND target_id = $3 AND change_kind = 'supersede'
      ORDER BY created_at DESC LIMIT 1`, [ownerId, kind, id]);
  let before = rev[0]?.before ?? null;
  if (typeof before === 'string') { try { before = JSON.parse(before); } catch { before = null; } }
  let state = before?.state && before.state !== 'superseded' ? before.state : 'active';
  const cutAt = rev[0]?.created_at ? new Date(rev[0].created_at).getTime() : null;

  const { rows: cur } = await client.query(`SELECT * FROM ${table} WHERE owner_id = $1 AND ${idCol} = $2`, [ownerId, id]);
  if (!cur.length) return null;
  const row = cur[0];
  const vt = row.valid_to ? new Date(row.valid_to).getTime() : null;
  const clearValidTo = vt != null && cutAt != null && vt >= cutAt - 5_000 && vt <= cutAt + 5_000;

  if (kind === 'claim' && !['archived', 'superseded'].includes(state)) {
    const { rows: dup } = await client.query(
      `SELECT claim_id FROM aqua_claims
        WHERE owner_id = $1 AND claim_id <> $2 AND subject_entity_id = $3 AND predicate = $4 AND statement_norm = $5
          AND polarity = $6 AND modality = $7 AND state NOT IN ('superseded','archived')`,
      [ownerId, id, row.subject_entity_id, row.predicate, row.statement_norm, row.polarity, row.modality]);
    if (dup.length) state = 'archived';
  }
  await client.query(
    `UPDATE ${table} SET state = $3, superseded_by = NULL${clearValidTo ? ', valid_to = NULL' : ''}, updated_at = now()
      WHERE owner_id = $1 AND ${idCol} = $2`, [ownerId, id, state]);
  await client.query(
    `INSERT INTO aqua_lifecycle_transitions (transition_id, owner_id, target_kind, target_id, from_state, to_state, reason, actor)
     VALUES ($1,$2,$3,$4,'superseded',$5,'source-deleted-restore',$6)`,
    [crypto.randomUUID(), ownerId, kind, id, state, SYSTEM_ACTOR]);
  return state;
}

/**
 * Delete the canonical knowledge derived from an external source/resource/version.
 *
 * @param {string} ownerId           the owner (from the caller's authenticated principal chain)
 * @param {{ ukoPrefix: string, keepUkoId?: string|null }} scope
 * @param {{ pool?: object, removeVector?: Function, canonicalNamespace?: Function, mind?: object,
 *           failAfterWrites?: Function, beforeCommit?: Function }} [deps]  the last two are test seams
 * @returns {Promise<{ skipped: string|null, counts: object, beliefs: object[], complete: boolean }>}
 */
export async function forgetExternalSourceClaims(ownerId, { ukoPrefix, keepUkoId = null } = {}, deps = {}) {
  validate(ownerId, ukoPrefix, keepUkoId);
  const counts = zeroCounts();
  if (!deps.pool && !isConfigured()) return { skipped: 'postgres not configured', counts, beliefs: [], complete: true };

  const pool = deps.pool ?? await getPool();
  const client = await pool.connect();
  const deletedClaims = [];
  const beliefLinks = [];   // { beliefId, dimension, beliefKey, claimId }
  try {
    await client.query('BEGIN');
    const q = client;
    // Race guard (externalDeletionGuard.js): serialise with any running
    // understanding commit for this source, and leave a tombstone so a job
    // enqueued before this deletion can never write the knowledge back.
    // Multi-instance connect safety: inside a connect operation (disconnect,
    // sync removals) the deletion commits only while this process holds the
    // owner's lease — checked in this transaction, before the source lock.
    // A deletion: never refused by the account-deletion barrier.
    await checkFenceOn(q, ownerId, { deletion: true });
    await lockExternalSource(q, ownerId, ukoPrefix);
    await recordExternalDeletion(q, { ownerId, ukoPrefix, keepUkoId });
    const S = new Set(await sourcesUnder(q, ownerId, ukoPrefix, keepUkoId));
    counts.sources = S.size;

    // 2. evidence + affected claims
    const E = new Set();
    for (const s of S) {
      const { rows } = await q.query('SELECT evidence_id FROM aqua_evidence WHERE owner_id = $1 AND source_id = $2', [ownerId, s]);
      for (const r of rows) E.add(String(r.evidence_id));
    }
    const C = new Set();
    for (const e of E) {
      const { rows } = await q.query('SELECT claim_id FROM aqua_claim_evidence WHERE owner_id = $1 AND evidence_id = $2', [ownerId, e]);
      for (const r of rows) C.add(String(r.claim_id));
    }

    // 3. survivors vs deletions
    const D = new Set();
    const survivors = new Set();
    for (const c of C) {
      const { rows: links } = await q.query('SELECT evidence_id, role FROM aqua_claim_evidence WHERE owner_id = $1 AND claim_id = $2', [ownerId, c]);
      let independent = false;
      for (const l of links) {
        if (!SUPPORT_ROLES.has(l.role) || E.has(String(l.evidence_id))) continue;
        const { rows: ev } = await q.query('SELECT source_id FROM aqua_evidence WHERE owner_id = $1 AND evidence_id = $2', [ownerId, l.evidence_id]);
        if (ev.length && !S.has(String(ev[0].source_id))) { independent = true; break; }
      }
      (independent ? survivors : D).add(c);
    }

    // 4. deletions and what hangs off them
    const DE = new Set(), DV = new Set(), IV = new Set(), entityCandidates = new Set();
    for (const d of D) {
      const { rows: cl } = await q.query('SELECT subject_entity_id, object_entity_id FROM aqua_claims WHERE owner_id = $1 AND claim_id = $2', [ownerId, d]);
      for (const r of cl) { if (r.subject_entity_id) entityCandidates.add(String(r.subject_entity_id)); if (r.object_entity_id) entityCandidates.add(String(r.object_entity_id)); }
      for (const r of (await q.query('SELECT edge_id, from_entity_id, to_entity_id FROM aqua_edges WHERE owner_id = $1 AND claim_id = $2', [ownerId, d])).rows) {
        DE.add(String(r.edge_id)); entityCandidates.add(String(r.from_entity_id)); entityCandidates.add(String(r.to_entity_id));
      }
      for (const r of (await q.query('SELECT event_id, subject_entity_id FROM aqua_events WHERE owner_id = $1 AND claim_id = $2', [ownerId, d])).rows) {
        DV.add(String(r.event_id)); if (r.subject_entity_id) entityCandidates.add(String(r.subject_entity_id));
      }
      const links = (await q.query('SELECT belief_id, dimension, belief_key, relation FROM aqua_belief_claims WHERE owner_id = $1 AND claim_id = $2', [ownerId, d])).rows;
      // The claim as the canonical→belief bridge reads it, captured before it
      // is deleted: settleBeliefs reports whether a KEPT belief's current value
      // is the one this claim supported (claimBeliefBridge.claimToBeliefSignal).
      const shape = links.length ? (await q.query(
        `SELECT c.predicate, c.polarity, c.modality, c.state, c.object_literal, oe.canonical_label AS object_label, se.type AS subject_type
           FROM aqua_claims c
           LEFT JOIN aqua_entities se ON se.entity_id = c.subject_entity_id
           LEFT JOIN aqua_entities oe ON oe.entity_id = c.object_entity_id
          WHERE c.owner_id = $1 AND c.claim_id = $2`, [ownerId, d])).rows[0] ?? null : null;
      for (const r of links) {
        beliefLinks.push({ beliefId: r.belief_id, dimension: r.dimension, beliefKey: r.belief_key, claimId: d, relation: r.relation ?? 'supporting', claim: shape });
      }
      for (const r of (await q.query('SELECT intervention_id FROM aqua_intervention_evidence WHERE owner_id = $1 AND claim_id = $2', [ownerId, d])).rows) IV.add(String(r.intervention_id));
    }

    // 4a. restore what deleted rows superseded (outside the deleted sets)
    for (const [kind, table, set] of [['claim', 'aqua_claims', D], ['edge', 'aqua_edges', DE], ['event', 'aqua_events', DV]]) {
      for (const x of set) {
        const { rows } = await q.query(`SELECT ${kind}_id AS id FROM ${table} WHERE owner_id = $1 AND superseded_by = $2`, [ownerId, x]);
        for (const r of rows) {
          const id = String(r.id);
          if (set.has(id)) {   // superseded by another doomed row: just detach it
            await q.query(`UPDATE ${table} SET state = 'archived', superseded_by = NULL WHERE owner_id = $1 AND ${kind}_id = $2`, [ownerId, id]);
            continue;
          }
          if (await restoreSuperseded(q, ownerId, kind, id)) counts[`${kind}sRestored`]++;
        }
      }
    }

    // 4b. history, events, jobs, derived rows of D / DE / DV
    const dropTargets = [['claim', D], ['edge', DE], ['event', DV]];
    for (const [kind, set] of dropTargets) {
      for (const id of set) {
        for (const t of ['aqua_lifecycle_transitions', 'aqua_revisions', 'aqua_corrections']) {
          counts.history += (await q.query(`DELETE FROM ${t} WHERE owner_id = $1 AND target_kind = $2 AND target_id = $3`, [ownerId, kind, id])).rowCount ?? 0;
        }
        counts.outbox += (await q.query('DELETE FROM aqua_outbox WHERE owner_id = $1 AND aggregate_kind = $2 AND aggregate_id = $3', [ownerId, kind, id])).rowCount ?? 0;
      }
    }
    for (const d of D) {
      for (const key of ['claimId', 'supersededBy', 'incomingClaimId', 'existingClaimId', 'replacesClaimId']) {
        counts.outbox += (await q.query(`DELETE FROM aqua_outbox WHERE owner_id = $1 AND payload->>'${key}' = $2`, [ownerId, d])).rowCount ?? 0;
        counts.jobs += (await q.query(`DELETE FROM aqua_jobs WHERE owner_id = $1 AND state <> 'running' AND payload->>'${key}' = $2`, [ownerId, d])).rowCount ?? 0;
        counts.runningJobsSkipped += (await q.query(`SELECT 1 FROM aqua_jobs WHERE owner_id = $1 AND state = 'running' AND payload->>'${key}' = $2`, [ownerId, d])).rows.length;
      }
      counts.bridge += (await q.query('DELETE FROM aqua_claim_retrieval_bridge WHERE owner_id = $1 AND claim_id = $2', [ownerId, d])).rowCount ?? 0;
      // aqua_embeddings rows go by the declared FK ON DELETE CASCADE (0012/0013)
      // when the claim row is deleted below. Not deleted explicitly: the table
      // exists only where pgvector is installed, and a statement against a
      // missing table would abort the whole transaction.
      counts.beliefLinks += (await q.query('DELETE FROM aqua_belief_claims WHERE owner_id = $1 AND claim_id = $2', [ownerId, d])).rowCount ?? 0;
      counts.interventionLinks += (await q.query('DELETE FROM aqua_intervention_evidence WHERE owner_id = $1 AND claim_id = $2', [ownerId, d])).rowCount ?? 0;
      await q.query('DELETE FROM aqua_claim_evidence WHERE owner_id = $1 AND claim_id = $2', [ownerId, d]);
    }
    for (const s of S) counts.outbox += (await q.query(`DELETE FROM aqua_outbox WHERE owner_id = $1 AND payload->>'sourceId' = $2`, [ownerId, s])).rowCount ?? 0;

    // edges/events: detach self-references inside the doomed set, then delete
    for (const [table, idCol, set, key] of [['aqua_edges', 'edge_id', DE, 'edgesDeleted'], ['aqua_events', 'event_id', DV, 'eventsDeleted']]) {
      for (const id of set) await q.query(`UPDATE ${table} SET superseded_by = NULL, state = CASE WHEN state = 'superseded' THEN 'archived' ELSE state END WHERE owner_id = $1 AND ${idCol} = $2`, [ownerId, id]);
      for (const id of set) counts[key] += (await q.query(`DELETE FROM ${table} WHERE owner_id = $1 AND ${idCol} = $2`, [ownerId, id])).rowCount ?? 0;
    }

    // interventions left without any evidence go, with their action runs and events
    for (const iv of IV) {
      const { rows } = await q.query('SELECT 1 FROM aqua_intervention_evidence WHERE owner_id = $1 AND intervention_id = $2', [ownerId, iv]);
      if (rows.length) continue;
      const { rows: runs } = await q.query('SELECT run_id FROM aqua_action_runs WHERE owner_id = $1 AND intervention_id = $2', [ownerId, iv]);
      for (const r of runs) {
        counts.outbox += (await q.query(`DELETE FROM aqua_outbox WHERE owner_id = $1 AND aggregate_kind = 'action' AND aggregate_id = $2`, [ownerId, r.run_id])).rowCount ?? 0;
        counts.actionRunsDeleted += (await q.query('DELETE FROM aqua_action_runs WHERE owner_id = $1 AND run_id = $2', [ownerId, r.run_id])).rowCount ?? 0;
      }
      counts.outbox += (await q.query(`DELETE FROM aqua_outbox WHERE owner_id = $1 AND aggregate_kind = 'intervention' AND aggregate_id = $2`, [ownerId, iv])).rowCount ?? 0;
      counts.interventionsDeleted += (await q.query('DELETE FROM aqua_interventions WHERE owner_id = $1 AND intervention_id = $2', [ownerId, iv])).rowCount ?? 0;
    }

    // the claims themselves (detach self-references inside D first)
    for (const d of D) await q.query(`UPDATE aqua_claims SET superseded_by = NULL, state = CASE WHEN state = 'superseded' THEN 'archived' ELSE state END WHERE owner_id = $1 AND claim_id = $2`, [ownerId, d]);
    for (const d of D) {
      const n = (await q.query('DELETE FROM aqua_claims WHERE owner_id = $1 AND claim_id = $2', [ownerId, d])).rowCount ?? 0;
      counts.claimsDeleted += n;
      if (n) deletedClaims.push(d);
    }

    // 5. survivors: drop S-evidence links, recompute corroboration
    for (const c of survivors) {
      for (const e of E) await q.query('DELETE FROM aqua_claim_evidence WHERE owner_id = $1 AND claim_id = $2 AND evidence_id = $3', [ownerId, c, e]);
      await recomputeCorroborationWithClient(q, c, ownerId);
      counts.claimsKept++;
    }

    // 6. evidence, ledger, sources
    for (const e of E) {
      await q.query('DELETE FROM aqua_claim_evidence WHERE owner_id = $1 AND evidence_id = $2', [ownerId, e]);
      counts.evidence += (await q.query('DELETE FROM aqua_evidence WHERE owner_id = $1 AND evidence_id = $2', [ownerId, e])).rowCount ?? 0;
    }
    for (const s of S) counts.ledger += (await q.query('DELETE FROM aqua_understanding_commit_ledger WHERE owner_id = $1 AND source_id = $2', [ownerId, s])).rowCount ?? 0;

    // 7. entities and aliases
    for (const s of S) {
      for (const r of (await q.query('SELECT entity_id FROM aqua_entity_aliases WHERE owner_id = $1 AND source_id = $2', [ownerId, s])).rows) entityCandidates.add(String(r.entity_id));
    }
    for (const ent of entityCandidates) {
      const { rows: er } = await q.query('SELECT type FROM aqua_entities WHERE owner_id = $1 AND entity_id = $2', [ownerId, ent]);
      if (!er.length) continue;
      const { rows: aliases } = await q.query('SELECT alias_id, source_id, is_canonical FROM aqua_entity_aliases WHERE owner_id = $1 AND entity_id = $2', [ownerId, ent]);
      const createdByS = aliases.some(a => a.is_canonical && a.source_id != null && S.has(String(a.source_id)));
      const referenced = er[0].type === 'self' || await isReferenced(q, ownerId, ent);
      if (createdByS && !referenced) {
        for (const t of ['aqua_lifecycle_transitions', 'aqua_revisions', 'aqua_corrections']) {
          counts.history += (await q.query(`DELETE FROM ${t} WHERE owner_id = $1 AND target_kind = 'entity' AND target_id = $2`, [ownerId, ent])).rowCount ?? 0;
        }
        counts.outbox += (await q.query(`DELETE FROM aqua_outbox WHERE owner_id = $1 AND aggregate_kind = 'entity' AND aggregate_id = $2`, [ownerId, ent])).rowCount ?? 0;
        counts.aliasesDeleted += (await q.query('DELETE FROM aqua_entity_aliases WHERE owner_id = $1 AND entity_id = $2', [ownerId, ent])).rowCount ?? 0;
        counts.entitiesDeleted += (await q.query('DELETE FROM aqua_entities WHERE owner_id = $1 AND entity_id = $2', [ownerId, ent])).rowCount ?? 0;
        continue;
      }
      for (const a of aliases) {
        if (a.source_id == null || !S.has(String(a.source_id))) continue;
        if (a.is_canonical) counts.aliasesUnlinked += (await q.query('UPDATE aqua_entity_aliases SET source_id = NULL WHERE owner_id = $1 AND alias_id = $2', [ownerId, a.alias_id])).rowCount ?? 0;
        else counts.aliasesDeleted += (await q.query('DELETE FROM aqua_entity_aliases WHERE owner_id = $1 AND alias_id = $2', [ownerId, a.alias_id])).rowCount ?? 0;
      }
    }
    for (const s of S) await q.query('DELETE FROM aqua_sources WHERE owner_id = $1 AND source_id = $2', [ownerId, s]);

    // 8. queued document-understanding jobs for the prefix (a running job is never touched)
    for (const j of await documentJobsUnder(q, ownerId, ukoPrefix, keepUkoId)) {
      if (j.state === 'running') { counts.runningJobsSkipped++; continue; }
      counts.jobs += (await q.query('DELETE FROM aqua_jobs WHERE owner_id = $1 AND job_id = $2', [ownerId, j.job_id])).rowCount ?? 0;
    }

    if (typeof deps.failAfterWrites === 'function') deps.failAfterWrites();   // tests: prove rollback
    if (typeof deps.beforeCommit === 'function') await deps.beforeCommit();    // tests: hold the transaction open (live race)
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release?.();
  }

  // After COMMIT — idempotent, reported, never claims more than it did.
  const beliefs = [];
  try {
    const removeVector = deps.removeVector ?? (await import('../../embeddings/vectorStore.js')).remove;
    const ns = (deps.canonicalNamespace ?? (await import('../../brain/contextEngine/canonicalSemantic.js')).canonicalClaimNamespace)(ownerId);
    for (const d of deletedClaims) if (removeVector(ns, d)) counts.vectorsRemoved++;
  } catch { /* vectors are a cache of claims that no longer exist; reported via counts */ }

  if (beliefLinks.length) {
    const outcome = await settleBeliefs(ownerId, beliefLinks, pool, deps);
    counts.beliefsDeleted = outcome.filter(b => b.action === 'deleted').length;
    counts.beliefsKept = outcome.filter(b => b.action === 'kept').length;
    counts.beliefsValueFromDeletedSource = outcome.filter(b => b.valueFromDeletedSource).length;
    beliefs.push(...outcome);
  }

  const verify = await remainingExternalCanonical(ownerId, { ukoPrefix, keepUkoId }, { pool });
  const complete = verify.sources === 0 && verify.evidence === 0 && verify.queuedJobs === 0 && verify.claimsRemaining === 0;
  return { skipped: null, counts, beliefs, complete, remaining: verify };
}

async function isReferenced(q, ownerId, ent) {
  const checks = [
    ['SELECT 1 FROM aqua_claims WHERE owner_id = $1 AND (subject_entity_id = $2 OR object_entity_id = $2) LIMIT 1'],
    ['SELECT 1 FROM aqua_edges WHERE owner_id = $1 AND (from_entity_id = $2 OR to_entity_id = $2) LIMIT 1'],
    ['SELECT 1 FROM aqua_events WHERE owner_id = $1 AND subject_entity_id = $2 LIMIT 1'],
    ['SELECT 1 FROM aqua_interventions WHERE owner_id = $1 AND subject_entity_id = $2 LIMIT 1'],
    ['SELECT 1 FROM aqua_entities WHERE owner_id = $1 AND merged_into = $2 LIMIT 1'],
    ['SELECT 1 FROM aqua_entity_merges WHERE owner_id = $1 AND (from_entity_id = $2 OR into_entity_id = $2) LIMIT 1'],
  ];
  for (const [sql] of checks) if ((await q.query(sql, [ownerId, ent])).rows.length) return true;
  return false;
}

/**
 * Mind beliefs linked to deleted claims. A belief is DELETED only when it was
 * seeded by the canonical bridge (privacy.source 'fact_bridge'), keeps no
 * other claim link, and every observation it ever recorded is accounted for by
 * the deleted links (evidenceCount ≤ deleted links). Otherwise it is KEPT,
 * UNCHANGED, and reported.
 *
 * Why a kept belief is neither restored, recomputed nor marked unresolved
 * (G1-1 acceptance finding — the Mind cannot do any of the three today):
 *   · restore    belief.history entries record { value, confidence,
 *                supersededAt, reason } and evidence entries record no claim
 *                id — which observation moved the value is not attributable;
 *   · recompute  the Belief Engine is path-dependent (incremental
 *                reinforce/contradict over a 12-entry evidence window) and a
 *                belief also holds non-claim evidence (chat inference, legacy
 *                fact bridge, corrections); there is no replay function;
 *   · unresolved Mind statuses are active | archived | locked — none means
 *                "unresolved"; the nearest lifecycle signal (a superseded claim
 *                → contradicting evidence, reflectionDelta.js) would record the
 *                deletion as a CONTRADICTION in the belief's explanation, which
 *                is false.
 * What IS reported, so the effect is visible: `valueFromDeletedSource` — the
 * kept belief's current value is the value a deleted SUPPORTING claim mapped
 * to (claimBeliefBridge.claimToBeliefSignal). Fixing it needs per-observation
 * claim provenance in Mind (a Belief Engine change, out of G1-1's scope).
 */
async function settleBeliefs(ownerId, links, pool, deps) {
  const out = [];
  let mindApi = deps.mind ?? null;
  if (!mindApi) {
    try {
      const store = await import('../../mind/mindStore.js');
      const engine = await import('../../mind/beliefEngine.js');
      const schema = await import('../../mind/mindSchema.js');
      mindApi = { getMind: store.getMind, deleteBelief: engine.deleteBelief, beliefKey: schema.beliefKey };
    } catch { return links.map(l => ({ ...l, action: 'kept', reason: 'mind unavailable' })); }
  }
  let toSignal = () => null;
  try { ({ claimToBeliefSignal: toSignal } = await import('../../brain/reflectionV3/claimBeliefBridge.js')); } catch { /* value check unavailable */ }
  const supportedValue = l => {
    if (l.relation === 'contradicting' || !l.claim) return undefined;
    const c = l.claim;
    const sig = toSignal({
      claimId: l.claimId, predicate: c.predicate, polarity: c.polarity, modality: c.modality, state: c.state,
      subjectType: c.subject_type, object: c.object_label != null ? { entity: c.object_label } : { literal: c.object_literal },
    });
    return sig && sig.support && sig.dimension === l.dimension && sig.key === l.beliefKey ? sig.value : undefined;
  };
  const byBelief = new Map();
  for (const l of links) {
    const k = `${l.dimension}\u0000${l.beliefKey}`;
    if (!byBelief.has(k)) byBelief.set(k, { ...l, deletedLinks: 0, deletedValues: [] });
    const b = byBelief.get(k);
    b.deletedLinks++;
    const v = supportedValue(l);
    if (v !== undefined) b.deletedValues.push(v);
  }
  const mind = mindApi.getMind(ownerId);
  for (const b of byBelief.values()) {
    const { rows } = await pool.query('SELECT 1 FROM aqua_belief_claims WHERE owner_id = $1 AND belief_id = $2 LIMIT 1', [ownerId, b.beliefId]);
    const belief = mind?.beliefs?.[mindApi.beliefKey(b.dimension, b.beliefKey)] ?? null;
    if (!belief) { out.push({ dimension: b.dimension, beliefKey: b.beliefKey, action: 'absent' }); continue; }
    const onlyFromDeleted = !rows.length && belief.privacy?.source === 'fact_bridge'
      && Number(belief.evidenceCount ?? Infinity) <= b.deletedLinks && !belief.privacy?.locked;
    if (onlyFromDeleted) {
      mindApi.deleteBelief(mind, b.dimension, b.beliefKey);
      out.push({ dimension: b.dimension, beliefKey: b.beliefKey, action: 'deleted' });
    } else {
      const valueFromDeletedSource = b.deletedValues.some(v => JSON.stringify(v) === JSON.stringify(belief.value));
      out.push({ dimension: b.dimension, beliefKey: b.beliefKey, action: 'kept',
        reason: rows.length ? 'other claims still support it' : 'independent or unattributable evidence',
        valueFromDeletedSource });
    }
  }
  return out;
}

/** What canonical knowledge is still stored under the prefix (all must be 0 after a complete deletion). */
export async function remainingExternalCanonical(ownerId, { ukoPrefix, keepUkoId = null } = {}, deps = {}) {
  validate(ownerId, ukoPrefix, keepUkoId);
  if (!deps.pool && !isConfigured()) return { sources: 0, evidence: 0, claimsRemaining: 0, queuedJobs: 0, skipped: 'postgres not configured' };
  const pool = deps.pool ?? await getPool();
  const S = await sourcesUnder(pool, ownerId, ukoPrefix, keepUkoId);
  let evidence = 0, claimsRemaining = 0;
  for (const s of S) {
    const { rows } = await pool.query('SELECT evidence_id FROM aqua_evidence WHERE owner_id = $1 AND source_id = $2', [ownerId, s]);
    evidence += rows.length;
    for (const r of rows) {
      const { rows: cl } = await pool.query('SELECT claim_id FROM aqua_claim_evidence WHERE owner_id = $1 AND evidence_id = $2', [ownerId, r.evidence_id]);
      claimsRemaining += cl.length;
    }
  }
  const queuedJobs = (await documentJobsUnder(pool, ownerId, ukoPrefix, keepUkoId)).filter(j => j.state !== 'running').length;
  return { sources: S.length, evidence, claimsRemaining, queuedJobs, skipped: null };
}
