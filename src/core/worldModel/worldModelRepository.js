/**
 * AQUA — canonical World Model repository
 *
 * E5 write path. This is the only application writer for edges, events,
 * lifecycle transitions, revisions, corrections and the transactional outbox.
 *
 * Rules:
 * - every mutation is owner-scoped;
 * - every mutation records an actor where the schema requires one;
 * - domain mutation + lifecycle/revision + outbox are one transaction;
 * - edges/events never exist without a provenance claim;
 * - corrections are append-only records; the target change is represented by
 *   a normal state/revision mutation, never by rewriting history.
 */
import crypto from 'node:crypto';
import { getPool, isConfigured } from '../db/pool.js';

export class WorldModelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorldModelError';
  }
}

async function getClient() {
  if (!isConfigured()) {
    throw new WorldModelError('DATABASE_URL is not set — world model has nowhere to go');
  }
  const p = await getPool();
  return p.connect();
}

function required(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new WorldModelError(`${name} is required`);
  }
  return value;
}

function json(value) {
  return JSON.stringify(value ?? {});
}

async function assertOwned(client, table, idColumn, id, ownerId) {
  const allowed = new Set(['aqua_entities', 'aqua_claims', 'aqua_edges', 'aqua_events']);
  if (!allowed.has(table)) throw new WorldModelError(`unsupported owned table ${table}`);
  const { rows } = await client.query(
    `SELECT 1 FROM ${table} WHERE ${idColumn}=$1 AND owner_id=$2`,
    [id, ownerId]);
  if (!rows.length) {
    throw new WorldModelError(`${table}.${id} does not belong to ${ownerId}`);
  }
}

async function revision(client, input) {
  const id = input.revisionId ?? crypto.randomUUID();
  await client.query(
    `INSERT INTO aqua_revisions
      (revision_id, owner_id, target_kind, target_id, change_kind,
       before, after, reason, actor, source, reversible)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)`,
    [id, required(input.ownerId, 'ownerId'), required(input.targetKind, 'targetKind'),
      required(input.targetId, 'targetId'), required(input.changeKind, 'changeKind'),
      input.before == null ? null : json(input.before), json(input.after),
      required(input.reason, 'reason'), required(input.actor, 'actor'),
      input.source ?? null, input.reversible ?? true]);
  return id;
}

async function lifecycle(client, input) {
  const id = input.transitionId ?? crypto.randomUUID();
  await client.query(
    `INSERT INTO aqua_lifecycle_transitions
      (transition_id, owner_id, target_kind, target_id, from_state, to_state, reason, actor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, required(input.ownerId, 'ownerId'), required(input.targetKind, 'targetKind'),
      required(input.targetId, 'targetId'), input.fromState ?? null,
      required(input.toState, 'toState'), required(input.reason, 'reason'),
      required(input.actor, 'actor')]);
  return id;
}

async function outbox(client, input) {
  const { rows } = await client.query(
    `INSERT INTO aqua_outbox
      (owner_id, event_type, aggregate_kind, aggregate_id, payload, actor)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)
     RETURNING outbox_id`,
    [required(input.ownerId, 'ownerId'), required(input.eventType, 'eventType'),
      required(input.aggregateKind, 'aggregateKind'), required(input.aggregateId, 'aggregateId'),
      json(input.payload), required(input.actor, 'actor')]);
  return rows[0].outbox_id;
}

async function transact(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Find-or-create an opaque entity. Labels are never join keys.
 */
/**
 * Durable S9/E6 idempotency ledger.
 *
 * Returns `committed:true` only when this exact owner/source/range/version
 * tuple already exists. The insert is deliberately part of the caller's
 * transaction when a client is supplied; the standalone form is transactional.
 */
export async function recordUnderstandingCommit(input, { client: suppliedClient = null } = {}) {
  const ownerId = required(input.ownerId, 'ownerId');
  const sourceId = required(input.sourceId, 'sourceId');
  const extractorVersion = required(input.extractorVersion, 'extractorVersion');
  const start = Number(input.segmentRange?.start ?? input.segmentRange?.[0]);
  const end = Number(input.segmentRange?.end ?? input.segmentRange?.[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    throw new WorldModelError('segmentRange must be an integer [start,end] with end >= start');
  }
  const actor = required(input.actor, 'actor');

  const work = async client => {
    const existing = await client.query(
      `SELECT commit_id, committed_at FROM aqua_understanding_commit_ledger
       WHERE owner_id=$1 AND source_id=$2 AND segment_start=$3 AND segment_end=$4
         AND extractor_version=$5
       FOR UPDATE`,
      [ownerId, sourceId, start, end, extractorVersion]);
    if (existing.rows.length) {
      return { committed: true, commitId: existing.rows[0].commit_id,
        committedAt: existing.rows[0].committed_at };
    }
    const commitId = input.commitId ?? crypto.randomUUID();
    const inserted = await client.query(
      `INSERT INTO aqua_understanding_commit_ledger
       (commit_id,owner_id,source_id,segment_start,segment_end,extractor_version,actor,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (owner_id,source_id,segment_start,segment_end,extractor_version)
       DO NOTHING
       RETURNING commit_id, committed_at`,
      [commitId, ownerId, sourceId, start, end, extractorVersion, actor, json(input.metadata)]);
    if (!inserted.rows.length) {
      const winner = await client.query(
        `SELECT commit_id, committed_at FROM aqua_understanding_commit_ledger
         WHERE owner_id=$1 AND source_id=$2 AND segment_start=$3 AND segment_end=$4
           AND extractor_version=$5`,
        [ownerId, sourceId, start, end, extractorVersion]);
      return { committed: true, commitId: winner.rows[0]?.commit_id ?? null,
        committedAt: winner.rows[0]?.committed_at ?? null };
    }
    return { committed: false, commitId };
  };

  return suppliedClient ? work(suppliedClient) : transact(work);
}

export async function understandingCommitExists(input) {
  const ownerId = required(input.ownerId, 'ownerId');
  const sourceId = required(input.sourceId, 'sourceId');
  const extractorVersion = required(input.extractorVersion, 'extractorVersion');
  const start = Number(input.segmentRange?.start ?? input.segmentRange?.[0]);
  const end = Number(input.segmentRange?.end ?? input.segmentRange?.[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return false;
  const p = await getPool();
  const { rows } = await p.query(
    `SELECT 1 FROM aqua_understanding_commit_ledger
     WHERE owner_id=$1 AND source_id=$2 AND segment_start=$3 AND segment_end=$4
       AND extractor_version=$5 LIMIT 1`,
    [ownerId, sourceId, start, end, extractorVersion]);
  return rows.length > 0;
}


async function upsertEntityInTransaction(client, { ownerId, entity, actor, sourceId }) {
  const label = required(entity?.canonicalLabel ?? entity?.canonical ?? entity?.name, 'entity.canonicalLabel');
  const normalized = label.trim().toLowerCase().replace(/\s+/g, ' ');
  const allowed = new Set(['person','org','project','product','technology','place','document','concept','event','self']);
  const type = allowed.has(entity?.type) ? entity.type : 'concept';

  const existing = await client.query(
    `SELECT entity_id FROM aqua_entities
     WHERE owner_id=$1 AND type=$2 AND normalized_label=$3 AND status='active'
     ORDER BY last_seen_at DESC LIMIT 1 FOR UPDATE`,
    [ownerId, type, normalized]);
  if (existing.rows.length) {
    const entityId = existing.rows[0].entity_id;
    await client.query(
      `UPDATE aqua_entities SET mention_count=mention_count+1,last_seen_at=now()
       WHERE entity_id=$1 AND owner_id=$2`,
      [entityId, ownerId]);
    return entityId;
  }

  const entityId = crypto.randomUUID();
  await client.query(
    `INSERT INTO aqua_entities
      (entity_id,owner_id,type,canonical_label,normalized_label,
       confidence_resolution,mention_count,status)
     VALUES ($1,$2,$3,$4,$5,$6,1,'active')`,
    [entityId, ownerId, type, label, normalized, entity?.confidence ?? 0.5]);

  if (sourceId) {
    await client.query(
      `INSERT INTO aqua_entity_aliases
        (alias_id,owner_id,entity_id,surface_form,normalized,source_id,is_canonical)
       VALUES ($1,$2,$3,$4,$5,$6,true)
       ON CONFLICT (owner_id,entity_id,normalized) DO NOTHING`,
      [crypto.randomUUID(), ownerId, entityId, label, normalized, sourceId]);
  }
  await lifecycle(client, { ownerId, targetKind: 'entity', targetId: entityId,
    fromState: null, toState: 'active', reason: 'e6-entity', actor });
  await revision(client, { ownerId, targetKind: 'entity', targetId: entityId,
    changeKind: 'create', before: null, after: { type, canonicalLabel: label },
    reason: 'e6-entity', actor, source: 'e6' });
  await outbox(client, { ownerId, eventType: 'entity.created',
    aggregateKind: 'entity', aggregateId: entityId, actor,
    payload: { entityId, sourceId } });
  return entityId;
}

export async function commitUnderstanding(input = {}) {
  const ownerId = required(input.ownerId, 'ownerId');
  const sourceId = required(input.sourceId, 'sourceId');
  const actor = required(input.actor, 'actor');
  const extractorVersion = required(input.extractorVersion, 'extractorVersion');
  const start = Number(input.segmentRange?.start ?? input.segmentRange?.[0]);
  const end = Number(input.segmentRange?.end ?? input.segmentRange?.[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start)
    throw new WorldModelError('segmentRange must be an integer [start,end] with end >= start');
  const claims = Array.isArray(input.claims) ? input.claims : [];
  return transact(async client => {
    // The commit ledger has a real FK to aqua_sources. Establish the source
    // first, inside THIS transaction, then reserve the S9 idempotency tuple.
    // The previous order attempted the ledger insert first, which could never
    // satisfy the FK on a fresh conversation.
    await client.query(`INSERT INTO aqua_sources
      (source_id,owner_id,kind,external_ref,title,trust_tier,content_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (source_id) DO NOTHING`,
      [sourceId,ownerId,input.sourceKind??'conversation',input.externalRef??null,input.title??null,input.trustTier??1,input.contentHash??null]);

    const ledger = await recordUnderstandingCommit({ownerId,sourceId,segmentRange:{start,end},
      extractorVersion,actor,metadata:{claimCount:claims.length}}, {client});
    if (ledger.committed) return {...ledger,skipped:true,claims:[]};
    const committed=[];
    for (const c of claims) {
      if (!c?.resolution?.ready && !c._canonicalSubject) continue;
      const statement=required(c.statementText,'claim.statementText');
      const subjectEntityId = await upsertEntityInTransaction(client, {
        ownerId, actor, sourceId,
        entity: c._canonicalSubject ?? { name: c.subject, canonical: c.subject, type: 'concept' },
      });
      const objectEntityId = c.objectKind === 'entity'
        ? await upsertEntityInTransaction(client, {
            ownerId, actor, sourceId,
            entity: c._canonicalObject ?? { name: c.object?.entity, canonical: c.object?.entity, type: 'concept' },
          })
        : null;
      const object=c.object??{}, norm=statement.trim().toLowerCase().replace(/\s+/g,' ');
      // Validate the claim shape BEFORE creating evidence. Evidence without a
      // corresponding claim would violate the canonical claim/evidence atom
      // and would become orphaned if the caller supplied an unsupported
      // objectKind. The entire transaction must remain clean even when an
      // extractor produces malformed output.
      const cols={entity:['object_entity_id',objectEntityId ?? object.entity],literal:['object_literal',String(object.literal)],
        quantity:['object_quantity',Number(object.quantity),'object_unit',object.unit??null],
        time:['object_time_from',object.time??c.validFrom??null,'object_time_to',c.validTo??null]}[c.objectKind];
      if(!cols) continue;
      const claimId=c.claimId??crypto.randomUUID(), evidenceId=crypto.randomUUID();
      await client.query(`INSERT INTO aqua_evidence
        (evidence_id,owner_id,source_id,locator,quote,checksum) VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
        [evidenceId,ownerId,sourceId,JSON.stringify({segmentStart:start,segmentEnd:end}),statement,crypto.createHash('sha256').update(statement).digest('hex')]);
      const fields=['claim_id','owner_id','subject_entity_id','predicate',...Array.from({length:cols.length/2},(_,i)=>cols[i*2]),'polarity','modality','valid_from','valid_to','asserted_at','time_precision','state','extractor','extractor_version','actor','statement_text','statement_norm'];
      const vals=[claimId,ownerId,subjectEntityId,c.predicate,...Array.from({length:cols.length/2},(_,i)=>cols[i*2+1]),
        c.polarity??'asserted',c.modality??'fact',c.validFrom??null,c.validTo??null,input.assertedAt??new Date(),c.timePrecision??'none','extraction',extractorVersion,actor,statement,norm];
      const placeholders=vals.map((_,i)=>'$'+(i+1)).join(',');
      await client.query(`INSERT INTO aqua_claims (${fields.join(',')}) VALUES (${placeholders}) ON CONFLICT (claim_id) DO NOTHING`,vals);
      await client.query(`INSERT INTO aqua_claim_evidence(owner_id,claim_id,evidence_id,role) VALUES($1,$2,$3,'primary') ON CONFLICT DO NOTHING`,[ownerId,claimId,evidenceId]);
      await lifecycle(client,{ownerId,targetKind:'claim',targetId:claimId,fromState:null,toState:'extracted',reason:'e6-commit',actor});
      await revision(client,{ownerId,targetKind:'claim',targetId:claimId,changeKind:'create',before:null,after:{predicate:c.predicate,polarity:c.polarity,modality:c.modality},reason:'e6-commit',actor,source:'e6'});
      await outbox(client,{ownerId,eventType:'claim.created',aggregateKind:'claim',aggregateId:claimId,actor,payload:{claimId,sourceId,segmentStart:start,segmentEnd:end}});

      // E5 canonical projections: relationship/event rows are indexes over the
      // claim atom, never independent facts. Keep them in THIS transaction so
      // a claim can never become visible without its graph/timeline projection.
      let edgeId = null;
      let eventId = null;

      if (c.objectKind === 'entity' && objectEntityId && subjectEntityId) {
        // The claim's subject/object entity IDs are the canonical graph nodes.
        // Do not use labels as graph keys and never manufacture a free edge.
        edgeId = crypto.randomUUID();
        await client.query(`INSERT INTO aqua_edges
          (edge_id,owner_id,from_entity_id,to_entity_id,predicate,claim_id,
           state,valid_from,valid_to)
         VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8)`,
          [edgeId, ownerId, subjectEntityId, objectEntityId, c.predicate, claimId,
            c.validFrom ?? null, c.validTo ?? null]);

        await lifecycle(client, {
          ownerId, targetKind: 'edge', targetId: edgeId, fromState: null,
          toState: 'active', reason: 'e6-claim-projection', actor
        });
        await revision(client, {
          ownerId, targetKind: 'edge', targetId: edgeId, changeKind: 'create',
          before: null,
          after: {
            fromEntityId: subjectEntityId,
            toEntityId: objectEntityId,
            predicate: c.predicate,
            claimId,
          },
          reason: 'e6-claim-projection', actor, source: 'e6'
        });
        await outbox(client, {
          ownerId, eventType: 'edge.created', aggregateKind: 'edge',
          aggregateId: edgeId, actor,
          payload: { edgeId, claimId, fromEntityId: subjectEntityId,
            toEntityId: objectEntityId, predicate: c.predicate }
        });
      }

      // Events are projected only when the extractor explicitly identifies an
      // event type. A temporal claim alone is not enough to invent an event:
      // L2/L7 require the event to remain a derived view of a real claim.
      if (c.eventType) {
        eventId = crypto.randomUUID();
        await client.query(`INSERT INTO aqua_events
          (event_id,owner_id,event_type,statement_text,subject_entity_id,claim_id,
           occurred_at,occurred_to,asserted_at,time_precision,state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')`,
          [eventId, ownerId, c.eventType, statement, subjectEntityId ?? null,
            claimId, c.occurredAt ?? c.validFrom ?? null, c.occurredTo ?? c.validTo ?? null,
            input.assertedAt ?? new Date(), c.timePrecision ?? c.timePrecision ?? 'none']);

        await lifecycle(client, {
          ownerId, targetKind: 'event', targetId: eventId, fromState: null,
          toState: 'active', reason: 'e6-event-projection', actor
        });
        await revision(client, {
          ownerId, targetKind: 'event', targetId: eventId, changeKind: 'create',
          before: null,
          after: { eventType: c.eventType, statementText: statement, claimId },
          reason: 'e6-event-projection', actor, source: 'e6'
        });
        await outbox(client, {
          ownerId, eventType: 'event.created', aggregateKind: 'event',
          aggregateId: eventId, actor,
          payload: { eventId, claimId, eventType: c.eventType }
        });
      }

      committed.push({claimId,evidenceId,edgeId,eventId});
    }
    return {...ledger,skipped:false,claims:committed};
  });
}

export async function upsertEntity(input) {
  const ownerId = required(input.ownerId, 'ownerId');
  const type = required(input.type, 'type');
  const normalized = required(input.normalizedLabel ?? input.canonicalLabel, 'normalizedLabel');
  const canonical = required(input.canonicalLabel, 'canonicalLabel');
  const actor = required(input.actor, 'actor');

  return transact(async client => {
    const existing = await client.query(
      `SELECT entity_id FROM aqua_entities
       WHERE owner_id=$1 AND type=$2 AND normalized_label=$3 AND status='active'
       ORDER BY last_seen_at DESC LIMIT 1 FOR UPDATE`,
      [ownerId, type, normalized]);

    let entityId;
    let created = false;
    if (existing.rows.length) {
      entityId = existing.rows[0].entity_id;
      await client.query(
        `UPDATE aqua_entities
         SET mention_count=mention_count+1, last_seen_at=now(),
             confidence_resolution=GREATEST(confidence_resolution,$4)
         WHERE entity_id=$1 AND owner_id=$2`,
        [entityId, ownerId, input.confidenceResolution ?? 0.5]);
    } else {
      entityId = input.entityId ?? crypto.randomUUID();
      await client.query(
        `INSERT INTO aqua_entities
          (entity_id,owner_id,type,canonical_label,normalized_label,
           confidence_resolution,mention_count,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active')`,
        [entityId, ownerId, type, canonical, normalized,
          input.confidenceResolution ?? 0.5, input.mentionCount ?? 1]);
      created = true;
      await lifecycle(client, {
        ownerId, targetKind: 'entity', targetId: entityId,
        fromState: null, toState: 'active', reason: 'entity-created', actor
      });
      await revision(client, {
        ownerId, targetKind: 'entity', targetId: entityId,
        changeKind: 'create', before: null,
        after: { type, canonicalLabel: canonical, normalizedLabel: normalized },
        reason: 'entity-created', actor, source: input.source ?? 'world-model'
      });
    }

    if (input.alias) {
      const alias = input.alias;
      const aliasId = alias.aliasId ?? crypto.randomUUID();
      await client.query(
        `INSERT INTO aqua_entity_aliases
          (alias_id,owner_id,entity_id,surface_form,normalized,source_id,is_canonical)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (owner_id,entity_id,normalized) DO NOTHING`,
        [aliasId, ownerId, entityId, required(alias.surfaceForm, 'alias.surfaceForm'),
          required(alias.normalized, 'alias.normalized'), alias.sourceId ?? null,
          alias.isCanonical ?? false]);
    }

    await outbox(client, {
      ownerId, eventType: created ? 'entity.created' : 'entity.observed',
      aggregateKind: 'entity', aggregateId: entityId, actor,
      payload: { entityId, type, canonicalLabel: canonical, created }
    });

    return { entityId, created };
  });
}

export async function createEdge(input) {
  const ownerId = required(input.ownerId, 'ownerId');
  const actor = required(input.actor, 'actor');
  const claimId = required(input.claimId, 'claimId');
  const fromEntityId = required(input.fromEntityId, 'fromEntityId');
  const toEntityId = required(input.toEntityId, 'toEntityId');
  const predicate = required(input.predicate, 'predicate');
  if (fromEntityId === toEntityId) throw new WorldModelError('self-loop edge refused');

  return transact(async client => {
    await assertOwned(client, 'aqua_claims', 'claim_id', claimId, ownerId);
    await assertOwned(client, 'aqua_entities', 'entity_id', fromEntityId, ownerId);
    await assertOwned(client, 'aqua_entities', 'entity_id', toEntityId, ownerId);

    const edgeId = input.edgeId ?? crypto.randomUUID();
    await client.query(
      `INSERT INTO aqua_edges
        (edge_id,owner_id,from_entity_id,to_entity_id,predicate,claim_id,
         state,valid_from,valid_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (edge_id) DO NOTHING`,
      [edgeId, ownerId, fromEntityId, toEntityId, predicate, claimId,
        input.state ?? 'active', input.validFrom ?? null, input.validTo ?? null]);

    await lifecycle(client, {
      ownerId, targetKind: 'edge', targetId: edgeId, fromState: null,
      toState: input.state ?? 'active', reason: input.reason ?? 'edge-created', actor
    });
    await revision(client, {
      ownerId, targetKind: 'edge', targetId: edgeId, changeKind: 'create',
      before: null,
      after: { fromEntityId, toEntityId, predicate, claimId },
      reason: input.reason ?? 'edge-created', actor, source: input.source ?? 'world-model'
    });
    await outbox(client, {
      ownerId, eventType: 'edge.created', aggregateKind: 'edge',
      aggregateId: edgeId, actor,
      payload: { edgeId, claimId, fromEntityId, toEntityId, predicate }
    });
    return { edgeId };
  });
}

export async function createEvent(input) {
  const ownerId = required(input.ownerId, 'ownerId');
  const actor = required(input.actor, 'actor');
  const claimId = required(input.claimId, 'claimId');
  const statementText = required(input.statementText, 'statementText');
  return transact(async client => {
    await assertOwned(client, 'aqua_claims', 'claim_id', claimId, ownerId);
    if (input.subjectEntityId) {
      await assertOwned(client, 'aqua_entities', 'entity_id', input.subjectEntityId, ownerId);
    }
    const eventId = input.eventId ?? crypto.randomUUID();
    await client.query(
      `INSERT INTO aqua_events
        (event_id,owner_id,event_type,statement_text,subject_entity_id,claim_id,
         occurred_at,occurred_to,asserted_at,time_precision,state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [eventId, ownerId, required(input.eventType, 'eventType'), statementText,
        input.subjectEntityId ?? null, claimId, input.occurredAt ?? null,
        input.occurredTo ?? null, input.assertedAt ?? new Date(),
        input.timePrecision ?? 'none', input.state ?? 'active']);

    await lifecycle(client, {
      ownerId, targetKind: 'event', targetId: eventId, fromState: null,
      toState: input.state ?? 'active', reason: input.reason ?? 'event-created', actor
    });
    await revision(client, {
      ownerId, targetKind: 'event', targetId: eventId, changeKind: 'create',
      before: null,
      after: { eventType: input.eventType, statementText, claimId },
      reason: input.reason ?? 'event-created', actor, source: input.source ?? 'world-model'
    });
    await outbox(client, {
      ownerId, eventType: 'event.created', aggregateKind: 'event',
      aggregateId: eventId, actor,
      payload: { eventId, claimId, eventType: input.eventType }
    });
    return { eventId };
  });
}

/**
 * Change lifecycle state without losing the previous state.
 */
export async function transition(input) {
  const ownerId = required(input.ownerId, 'ownerId');
  const actor = required(input.actor, 'actor');
  const targetKind = required(input.targetKind, 'targetKind');
  const targetId = required(input.targetId, 'targetId');
  const table = { claim: 'aqua_claims', entity: 'aqua_entities',
    edge: 'aqua_edges', event: 'aqua_events' }[targetKind];
  if (!table) throw new WorldModelError(`unsupported targetKind ${targetKind}`);

  return transact(async client => {
    const idColumn = targetKind === 'entity' ? 'entity_id' : `${targetKind}_id`;
    await assertOwned(client, table, idColumn, targetId, ownerId);
    const column = targetKind === 'entity' ? 'status' : 'state';
    const current = await client.query(
      `SELECT ${column} AS state FROM ${table} WHERE ${idColumn}=$1 AND owner_id=$2 FOR UPDATE`,
      [targetId, ownerId]);
    const fromState = current.rows[0].state;
    const toState = required(input.toState, 'toState');
    if (fromState === toState) throw new WorldModelError('lifecycle transition changes nothing');

    let extra = '';
    let params = [toState, targetId, ownerId];
    if (toState === 'superseded') {
      const successor = required(input.supersededBy, 'supersededBy');
      extra = ', superseded_by=$4';
      params.push(successor);
    } else if (targetKind !== 'entity') {
      extra = ', superseded_by=NULL';
    } else if (toState !== 'merged') {
      extra = ', merged_into=NULL';
    }

    if (targetKind === 'entity' && toState === 'merged') {
      const mergedInto = required(input.mergedInto, 'mergedInto');
      await assertOwned(client, 'aqua_entities', 'entity_id', mergedInto, ownerId);
      params = [toState, targetId, ownerId, mergedInto];
      extra = ', merged_into=$4';
    }
    const updatedAt = targetKind === 'entity' ? '' : ', updated_at=now()';
    await client.query(
      `UPDATE ${table} SET ${column}=$1${updatedAt}${extra}
       WHERE ${idColumn}=$2 AND owner_id=$3`, params);

    await lifecycle(client, {
      ownerId, targetKind, targetId, fromState, toState,
      reason: required(input.reason, 'reason'), actor
    });
    await revision(client, {
      ownerId, targetKind, targetId, changeKind: toState === 'superseded' ? 'supersede' : 'update',
      before: { [column]: fromState }, after: { [column]: toState },
      reason: input.reason, actor, source: input.source ?? 'world-model'
    });
    await outbox(client, {
      ownerId, eventType: 'world-model.lifecycle', aggregateKind: targetKind,
      aggregateId: targetId, actor,
      payload: { targetKind, targetId, fromState, toState }
    });
    return { targetKind, targetId, fromState, toState };
  });
}

export async function recordCorrection(input) {
  const ownerId = required(input.ownerId, 'ownerId');
  const actor = required(input.actor, 'actor');
  const targetKind = required(input.targetKind, 'targetKind');
  const targetId = required(input.targetId, 'targetId');
  const action = required(input.action, 'action');
  return transact(async client => {
    const table = { claim: 'aqua_claims', entity: 'aqua_entities',
      edge: 'aqua_edges', event: 'aqua_events' }[targetKind];
    if (!table) throw new WorldModelError(`unsupported targetKind ${targetKind}`);
    const idColumn = targetKind === 'entity' ? 'entity_id' : `${targetKind}_id`;
    await assertOwned(client, table, idColumn, targetId, ownerId);

    const correctionId = input.correctionId ?? crypto.randomUUID();
    await client.query(
      `INSERT INTO aqua_corrections
        (correction_id,owner_id,target_kind,target_id,action,before,after,actor)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
      [correctionId, ownerId, targetKind, targetId, action,
        json(input.before), input.after == null ? null : json(input.after), actor]);

    // The correction itself is immutable history. Apply only the state-bearing
    // actions here; value replacement remains a caller-provided revision so we
    // never guess which field the user meant to change.
    if (action === 'remove' || action === 'dismiss') {
      const next = targetKind === 'entity' ? 'dismissed' : 'archived';
      const column = targetKind === 'entity' ? 'status' : 'state';
      const current = await client.query(
        `SELECT ${column} AS state FROM ${table} WHERE ${idColumn}=$1 AND owner_id=$2 FOR UPDATE`,
        [targetId, ownerId]);
      if (current.rows[0].state !== next) {
        await client.query(
          `UPDATE ${table} SET ${column}=$1, updated_at=now()
           WHERE ${idColumn}=$2 AND owner_id=$3`, [next, targetId, ownerId]);
        await lifecycle(client, {
          ownerId, targetKind, targetId, fromState: current.rows[0].state,
          toState: next, reason: `user-correction:${action}`, actor
        });
        await revision(client, {
          ownerId, targetKind, targetId, changeKind: 'update',
          before: { [column]: current.rows[0].state }, after: { [column]: next },
          reason: `user-correction:${action}`, actor, source: 'user-correction'
        });
      }
    } else {
      await revision(client, {
        ownerId, targetKind, targetId, changeKind: 'update',
        before: input.before, after: input.after,
        reason: 'user-correction', actor, source: 'user-correction'
      });
    }

    await outbox(client, {
      ownerId, eventType: 'world-model.correction', aggregateKind: targetKind,
      aggregateId: targetId, actor,
      payload: { correctionId, targetKind, targetId, action }
    });
    return { correctionId };
  });
}

export async function recordRevision(input) {
  return transact(async client => {
    const ownerId = required(input.ownerId, 'ownerId');
    const targetKind = required(input.targetKind, 'targetKind');
    const targetId = required(input.targetId, 'targetId');
    const table = { claim: 'aqua_claims', entity: 'aqua_entities',
      edge: 'aqua_edges', event: 'aqua_events' }[targetKind];
    const idColumn = targetKind === 'entity' ? 'entity_id' : `${targetKind}_id`;
    if (!table) throw new WorldModelError(`unsupported targetKind ${targetKind}`);
    await assertOwned(client, table, idColumn, targetId, ownerId);
    const revisionId = await revision(client, input);
    await outbox(client, {
      ownerId, eventType: 'world-model.revision', aggregateKind: targetKind,
      aggregateId: targetId, actor: required(input.actor, 'actor'),
      payload: { revisionId, targetKind, targetId, changeKind: input.changeKind }
    });
    return { revisionId };
  });
}

export async function readHistory(input) {
  const ownerId = required(input.ownerId, 'ownerId');
  const targetKind = required(input.targetKind, 'targetKind');
  const targetId = required(input.targetId, 'targetId');
  const p = await getPool();
  const tableMap = {
    claim: 'aqua_claims', entity: 'aqua_entities',
    edge: 'aqua_edges', event: 'aqua_events'
  };
  if (!tableMap[targetKind]) throw new WorldModelError(`unsupported targetKind ${targetKind}`);
  const { rows: revisions } = await p.query(
    `SELECT * FROM aqua_revisions
      WHERE owner_id=$1 AND target_kind=$2 AND target_id=$3
      ORDER BY created_at ASC`,
    [ownerId, targetKind, targetId]);
  const { rows: transitions } = await p.query(
    `SELECT * FROM aqua_lifecycle_transitions
      WHERE owner_id=$1 AND target_kind=$2 AND target_id=$3
      ORDER BY created_at ASC`,
    [ownerId, targetKind, targetId]);
  const { rows: corrections } = await p.query(
    `SELECT * FROM aqua_corrections
      WHERE owner_id=$1 AND target_kind=$2 AND target_id=$3
      ORDER BY created_at ASC`,
    [ownerId, targetKind, targetId]);
  return { revisions, transitions, corrections };
}
