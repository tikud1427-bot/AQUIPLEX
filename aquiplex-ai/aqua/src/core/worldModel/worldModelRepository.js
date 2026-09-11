/**
 * Canonical E5 World Model repository.
 *
 * This is the single application write boundary for the canonical world
 * model. E6/S6 supplies already-resolved identity keys; this module maps those
 * stable keys to opaque Postgres UUIDs and writes claims, evidence, graph
 * edges, lifecycle, events and outbox records atomically per source segment.
 *
 * Reads live in worldModelReader.js so the write boundary stays small and
 * auditable. Account erasure is exposed as purgeOwner().
 */
import crypto from 'node:crypto';
import { getPool, isConfigured } from '../db/pool.js';

const id = () => crypto.randomUUID();
const deterministicUuid = value => {
  const h = crypto.createHash('sha256').update(String(value)).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
};
const norm = value => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const rangeKey = range => Array.isArray(range)
  ? `${range[0]}:${range[1]}`
  : `${range?.start ?? ''}:${range?.end ?? ''}`;

export function commitEnabled() {
  return String(process.env.AQUA_E6_COMMIT ?? '').toLowerCase() === 'on';
}

function requireInput(input) {
  for (const k of ['ownerId', 'conversationId', 'extractorVersion', 'actor']) {
    if (!input?.[k]) throw new Error(`world-model commit requires ${k}`);
  }
}

const DB_TYPES = new Set(['person','org','project','product','technology','place','document','concept','event','self']);
const TYPE_MAP = Object.freeze({ organization: 'org', company: 'org', employer: 'org', product: 'project', workspace: 'project', goal: 'concept', objective: 'concept', conversation: 'document', artifact: 'document' });
const dbType = raw => {
  const t = TYPE_MAP[String(raw ?? '').trim().toLowerCase()] ?? String(raw ?? 'concept').trim().toLowerCase();
  return DB_TYPES.has(t) ? t : 'concept';
};

function entityInfo(input, canonicalId, fallbackLabel = null) {
  const e = input.entityById?.get(canonicalId) ?? null;
  return {
    identityKey: canonicalId,
    label: String(e?.name ?? e?.canonical ?? fallbackLabel ?? canonicalId).trim(),
    type: dbType(e?.kind ?? e?.type),
  };
}

/** Resolve/create a physical entity for an already-resolved stable identity. */
async function ensureEntity(client, ownerId, canonicalId, fallbackLabel, input) {
  if (!canonicalId) return null;
  const info = entityInfo(input, canonicalId, fallbackLabel);
  if (!info.label) throw new Error(`canonical entity ${canonicalId} has no display label`);

  const byIdentity = await client.query(
    `SELECT entity_id FROM aqua_entities WHERE owner_id=$1 AND identity_key=$2 AND status='active' LIMIT 1`,
    [ownerId, info.identityKey]);
  if (byIdentity.rows[0]) {
    await client.query(
      `UPDATE aqua_entities SET canonical_label=$3, normalized_label=$4, type=$5, last_seen_at=now(), mention_count=mention_count+1 WHERE owner_id=$1 AND entity_id=$2`,
      [ownerId, byIdentity.rows[0].entity_id, info.label, norm(info.label), info.type]);
    return byIdentity.rows[0].entity_id;
  }

  // Backfill a legacy row when the normalized label is unique for this owner.
  const legacy = await client.query(
    `SELECT entity_id, identity_key FROM aqua_entities WHERE owner_id=$1 AND normalized_label=$2 AND status='active' ORDER BY last_seen_at DESC LIMIT 2`,
    [ownerId, norm(info.label)]);
  if (legacy.rows.length === 1) {
    const row = legacy.rows[0];
    if (!row.identity_key) {
      await client.query(
        `UPDATE aqua_entities SET identity_key=$3, canonical_label=$4, type=$5, last_seen_at=now(), mention_count=mention_count+1 WHERE owner_id=$1 AND entity_id=$2`,
        [ownerId, row.entity_id, info.identityKey, info.label, info.type]);
      return row.entity_id;
    }
    if (row.identity_key === info.identityKey) return row.entity_id;
  }

  const entityId = id();
  await client.query(
    `INSERT INTO aqua_entities(entity_id,owner_id,identity_key,type,canonical_label,normalized_label,confidence_resolution,mention_count,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,1,'active')`,
    [entityId, ownerId, info.identityKey, info.type, info.label, norm(info.label), 0.9]);
  await client.query(
    `INSERT INTO aqua_entity_aliases(alias_id,owner_id,entity_id,surface_form,normalized,source_id,is_canonical)
     VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT (owner_id,entity_id,normalized) DO NOTHING`,
    [id(), ownerId, entityId, info.label, norm(info.label), input.sourceId ?? null]);
  return entityId;
}

function objectData(claim) {
  const o = claim.object ?? {};
  if (claim.objectKind === 'entity') return { entityKey: claim.objectEntityId ?? null };
  if (claim.objectKind === 'quantity') return { quantity: o.quantity, unit: o.unit ?? null };
  if (claim.objectKind === 'time') return { timeFrom: o.time ?? claim.validFrom ?? null, timeTo: o.timeTo ?? claim.validTo ?? null };
  return { literal: o.literal };
}

function claimGroups(claims) {
  const groups = new Map();
  for (const claim of claims) {
    const key = rangeKey(claim.segment);
    if (!groups.has(key)) groups.set(key, { range: claim.segment, claims: [] });
    groups.get(key).claims.push(claim);
  }
  return [...groups.values()];
}

/** Commit all eligible claims, atomically per source segment. */
export async function commitUnderstanding(result, input = {}) {
  if (!commitEnabled()) return { committed: false, disabled: true, claims: 0 };
  if (!isConfigured()) return { committed: false, skipped: true, reason: 'database-not-configured', claims: 0 };
  requireInput(input);

  const claims = Array.isArray(result?.readyForS7) ? result.readyForS7 : [];
  if (!claims.length) return { committed: true, claims: 0, claimIds: [], segments: [] };

  const sourceId = deterministicUuid(`source:${input.ownerId}:${input.conversationId}`);
  const entityById = input.entityById instanceof Map ? input.entityById : new Map();
  const p = await getPool();
  const client = await p.connect();
  const committedIds = [];
  const committedForIndex = [];
  const segmentResults = [];

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO aqua_sources(source_id,owner_id,kind,external_ref,title,trust_tier)
       VALUES($1,$2,'conversation',$3,$4,$5) ON CONFLICT(source_id) DO UPDATE SET trust_tier=GREATEST(aqua_sources.trust_tier, EXCLUDED.trust_tier)`,
      [sourceId, input.ownerId, input.conversationId, 'Conversation', input.sourceTrust ?? 0.7]);

    for (const group of claimGroups(claims)) {
      const range = group.range;
      const [segmentStart, segmentEnd] = String(rangeKey(range)).split(':').map(Number);
      const key = crypto.createHash('sha256')
        .update(`${sourceId}\0${rangeKey(range)}\0${input.extractorVersion}`)
        .digest('hex');

      const already = await client.query(`SELECT commit_key FROM aqua_world_model_commits WHERE commit_key=$1`, [key]);
      if (already.rows[0]) {
        segmentResults.push({ range, committed: false, skipped: 'already-committed', claims: 0 });
        continue;
      }

      const segmentIds = [];
      for (const claim of group.claims) {
        if (!claim.subjectEntityId || !claim.predicate) continue;
        const subject = await ensureEntity(client, input.ownerId, claim.subjectEntityId, claim.subjectCanonical ?? claim.subject, { ...input, entityById, sourceId });
        if (!subject) continue;

        const ov = objectData(claim);
        let objectEntityId = null;
        if (claim.objectKind === 'entity') {
          objectEntityId = await ensureEntity(client, input.ownerId, ov.entityKey, claim.objectCanonical ?? claim.object?.entity, { ...input, entityById, sourceId });
          if (!objectEntityId) continue;
        }

        const statementNorm = norm(claim.statementText);
        const existing = await client.query(
          `SELECT claim_id FROM aqua_claims WHERE owner_id=$1 AND subject_entity_id=$2 AND predicate=$3 AND statement_norm=$4 AND state NOT IN ('archived') ORDER BY updated_at DESC LIMIT 1`,
          [input.ownerId, subject, claim.predicate, statementNorm]);
        const claimId = existing.rows[0]?.claim_id ?? id();
        const isNewClaim = !existing.rows[0];

        if (isNewClaim) {
          await client.query(
            `INSERT INTO aqua_claims(claim_id,owner_id,subject_entity_id,predicate,object_entity_id,object_literal,object_quantity,object_unit,object_time_from,object_time_to,
              polarity,modality,valid_from,valid_to,asserted_at,time_precision,state,confidence_extraction,confidence_source,confidence_corroboration,
              extractor,extractor_version,actor,statement_text,statement_norm)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15,'active',$16,$17,0,$18,$19,$20,$21,$22)`,
            [claimId,input.ownerId,subject,claim.predicate,objectEntityId,
             claim.objectKind === 'literal' ? String(ov.literal ?? '') : null,
             claim.objectKind === 'quantity' ? ov.quantity : null,
             claim.objectKind === 'quantity' ? ov.unit : null,
             claim.objectKind === 'time' ? ov.timeFrom : null,
             claim.objectKind === 'time' ? ov.timeTo : null,
             claim.polarity ?? 'asserted',claim.modality ?? 'fact',claim.validFrom ?? null,claim.validTo ?? null,
             claim.timePrecision ?? 'none',claim.confidenceExtraction ?? 0.5,input.sourceTrust ?? 0.7,
             'e6',input.extractorVersion,input.actor,claim.statementText,statementNorm]);
        } else {
          await client.query(
            `UPDATE aqua_claims SET confidence_corroboration=LEAST(1, confidence_corroboration + 0.1), updated_at=now() WHERE owner_id=$1 AND claim_id=$2`,
            [input.ownerId, claimId]);
        }

        const evidenceId = id();
        const checksum = crypto.createHash('sha256').update(String(claim.statementText ?? '')).digest('hex');
        await client.query(
          `INSERT INTO aqua_evidence(evidence_id,owner_id,source_id,locator,quote,checksum) VALUES($1,$2,$3,$4,$5,$6)`,
          [evidenceId,input.ownerId,sourceId,JSON.stringify({segment: claim.segment, idempotencyKey:key}),String(claim.statementText ?? ''),checksum]);
        await client.query(
          `INSERT INTO aqua_claim_evidence(owner_id,claim_id,evidence_id,role) VALUES($1,$2,$3,$4)`,
          [input.ownerId,claimId,evidenceId,isNewClaim ? 'primary' : 'corroborating']);

        if (claim.objectKind === 'entity' && objectEntityId) {
          const edgeExists = await client.query(
            `SELECT 1 FROM aqua_edges WHERE owner_id=$1 AND from_entity_id=$2 AND predicate=$3 AND to_entity_id=$4 AND state='active' LIMIT 1`,
            [input.ownerId,subject,claim.predicate,objectEntityId]);
          if (!edgeExists.rows[0]) {
            await client.query(
              `INSERT INTO aqua_edges(edge_id,owner_id,from_entity_id,predicate,to_entity_id,claim_id,confidence,state,actor)
               VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
              [id(),input.ownerId,subject,claim.predicate,objectEntityId,claimId,claim.confidenceExtraction ?? 0.5,input.actor]);
          }
        }

        if (isNewClaim) {
          await client.query(
            `INSERT INTO aqua_lifecycle_transitions(transition_id,owner_id,claim_id,from_state,to_state,reason,actor)
             VALUES($1,$2,$3,'extracted','active','e6-commit',$4)`,
            [id(),input.ownerId,claimId,input.actor]);
          await client.query(
            `INSERT INTO aqua_revisions(revision_id,owner_id,target_kind,target_id,revision_kind,previous_state,next_state,actor)
             VALUES($1,$2,'claim',$3,'created',$4,$5,$6)`,
            [id(),input.ownerId,claimId,JSON.stringify({}),JSON.stringify({statementText: claim.statementText, predicate: claim.predicate, polarity: claim.polarity ?? 'asserted'}),input.actor]);
        }
        const eventType = isNewClaim ? 'claim_committed' : 'claim_corroborated';
        await client.query(
          `INSERT INTO aqua_events(event_id,owner_id,event_type,subject_entity_id,claim_id,occurred_at,payload,actor)
           VALUES($1,$2,$3,$4,$5,now(),$6,$7)`,
          [id(),input.ownerId,eventType,subject,claimId,JSON.stringify({idempotencyKey:key, segment: claim.segment}),input.actor]);
        await client.query(
          `INSERT INTO aqua_outbox(event_id,owner_id,event_type,aggregate_type,aggregate_id,payload)
           VALUES($1,$2,$3,'claim',$4,$5)`,
          [id(),input.ownerId,eventType,claimId,JSON.stringify({claimId, sourceId, segment: claim.segment, extractorVersion: input.extractorVersion})]);

        segmentIds.push(claimId);
        committedIds.push(claimId);
        committedForIndex.push({ claimId, statementText: claim.statementText });
      }

      // One idempotency row PER SEGMENT, after every segment claim has landed.
      // This fixes the old per-claim unique-key collision and makes re-ingest
      // a true no-op for the whole segment.
      await client.query(
        `INSERT INTO aqua_world_model_commits(commit_key,owner_id,source_id,segment_start,segment_end,extractor_version,actor)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [key,input.ownerId,sourceId,Number.isFinite(segmentStart) ? segmentStart : 0,Number.isFinite(segmentEnd) ? segmentEnd : 0,input.extractorVersion,input.actor]);
      segmentResults.push({ range, committed: true, claims: segmentIds.length });
    }

    await client.query('COMMIT');
    // Semantic indexing is enrichment, never part of the transaction. Claim
    // IDs are the retrieval identity, so the Context Engine can consume these
    // scores without the old LTM/evidence keyspace mismatch.
    import('../../embeddings/semanticMemory.js').then(m => m.indexOwnerClaims(input.ownerId, committedForIndex)).catch(() => {});
    return { committed: true, claims: committedIds.length, claimIds: committedIds, segments: segmentResults, sourceId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Erase every canonical World Model row for one owner. Deletes dependents
 * first, then entities. No-op when Postgres is absent so account deletion does
 * not report a failure for a deployment that never used the substrate.
 */
export async function purgeOwner(ownerId) {
  if (!ownerId) return { skipped: 'no owner', rows: 0 };
  if (!isConfigured()) return { skipped: 'postgres not configured', rows: 0 };
  const p = await getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const tables = [
      ['aqua_claim_evidence', 'owner_id'], ['aqua_edges', 'owner_id'], ['aqua_events', 'owner_id'],
      ['aqua_lifecycle_transitions', 'owner_id'], ['aqua_revisions', 'owner_id'], ['aqua_corrections', 'owner_id'],
      ['aqua_outbox', 'owner_id'], ['aqua_world_model_commits', 'owner_id'], ['aqua_claims', 'owner_id'],
      ['aqua_evidence', 'owner_id'], ['aqua_sources', 'owner_id'], ['aqua_entity_aliases', 'owner_id'],
      ['aqua_entity_merges', 'owner_id'], ['aqua_entities', 'owner_id'],
    ];
    let rows = 0;
    for (const [table, column] of tables) {
      const r = await client.query(`DELETE FROM ${table} WHERE ${column}=$1`, [ownerId]);
      rows += r.rowCount ?? 0;
    }
    await client.query('COMMIT');
    return { skipped: null, rows };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

/**
 * Apply reflection decisions to the canonical substrate. Kept here beside
 * commitUnderstanding so every canonical mutation shares the same owner,
 * transaction, revision, lifecycle, event and outbox discipline.
 */
export async function applyReflectionDelta(ownerId, delta, { actor = 'reflection-v2' } = {}) {
  if (!ownerId || !delta || !isConfigured()) return { archived: [], revised: [], skipped: [] };
  const p = await getPool();
  const client = await p.connect();
  const report = { archived: [], revised: [], skipped: [] };
  try {
    await client.query('BEGIN');

    for (const item of delta.obsoleted ?? []) {
      const old = await client.query(
        `SELECT claim_id,state,statement_text,predicate,subject_entity_id FROM aqua_claims
         WHERE owner_id=$1 AND claim_id=$2 LIMIT 1`,
        [ownerId, item.factId]);
      if (!old.rows[0]) { report.skipped.push({ claimId: item.factId, reason: 'not-found' }); continue; }
      if (old.rows[0].state === 'archived') { report.skipped.push({ claimId: item.factId, reason: 'already-archived' }); continue; }

      const previous = old.rows[0];
      await client.query(
        `UPDATE aqua_claims SET state='archived', updated_at=now() WHERE owner_id=$1 AND claim_id=$2`,
        [ownerId, item.factId]);
      await client.query(
        `INSERT INTO aqua_lifecycle_transitions(transition_id,owner_id,claim_id,from_state,to_state,reason,actor)
         VALUES($1,$2,$3,$4,'archived',$5,$6)`,
        [id(), ownerId, item.factId, previous.state, `reflection: superseded by ${item.supersededBy} — ${item.reason ?? 'newer conflicting claim'}`, actor]);
      await client.query(
        `INSERT INTO aqua_revisions(revision_id,owner_id,target_kind,target_id,revision_kind,previous_state,next_state,actor)
         VALUES($1,$2,'claim',$3,'superseded',$4,$5,$6)`,
        [id(), ownerId, item.factId,
         JSON.stringify({ state: previous.state, statementText: previous.statement_text, predicate: previous.predicate }),
         JSON.stringify({ state: 'archived', supersededBy: item.supersededBy }), actor]);
      await client.query(
        `INSERT INTO aqua_events(event_id,owner_id,event_type,subject_entity_id,claim_id,occurred_at,payload,actor)
         VALUES($1,$2,'claim_superseded',$3,$4,now(),$5,$6)`,
        [id(), ownerId, previous.subject_entity_id, item.factId,
         JSON.stringify({ supersededBy: item.supersededBy, reason: item.reason ?? null }), actor]);
      await client.query(
        `INSERT INTO aqua_outbox(event_id,owner_id,event_type,aggregate_type,aggregate_id,payload)
         VALUES($1,$2,'claim_superseded','claim',$3,$4)`,
        [id(), ownerId, item.factId,
         JSON.stringify({ claimId: item.factId, supersededBy: item.supersededBy })]);
      report.archived.push({ claimId: item.factId, supersededBy: item.supersededBy });
    }

    // Assumption revisions are structured revisions, not free-form annotations.
    // The canonical entity/claim graph remains the source of truth; this event
    // makes the semantic "from → to" decision auditable without inventing a
    // second knowledge store.
    for (const item of delta.assumptionsRevised ?? []) {
      await client.query(
        `INSERT INTO aqua_events(event_id,owner_id,event_type,occurred_at,payload,actor)
         VALUES($1,$2,'assumption_revised',now(),$3,$4)`,
        [id(), ownerId, JSON.stringify({
          subject: item.subject ?? null, from: item.from ?? null, to: item.to ?? null, reason: item.reason ?? null,
        }), actor]);
      report.revised.push({ subject: item.subject ?? null });
    }

    await client.query('COMMIT');
    return report;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}
