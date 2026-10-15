/**
 * AQUA — proactive intervention persistence (Phase 4, 2026-10-06).
 *
 * Every query is owner-scoped and bounded (G3, G6). Writes are idempotent on
 * (owner_id, idempotency_key) and state changes are compare-and-set, so a
 * duplicate job delivery, a retried worker or two server processes never
 * produce two interventions for one world state, or deliver one twice.
 * Each recorded decision and response also lands in the L1 delta log
 * (aqua_outbox, record rows) in the same transaction.
 */
import crypto from 'node:crypto';
import { getPool, isConfigured } from '../../core/db/pool.js';
import { DEFAULT_PREFS } from './policy.js';

const MAX_CLAIMS = 500;
const WORLD_PREDICATES = ['deadline_for', 'blocks', 'blocked_by', 'has_status', 'depends_on',
  'owns', 'owned_by', 'manages', 'task_owner'];

async function pool() {
  if (!isConfigured()) throw new Error('DATABASE_URL is not set — proactive layer needs the canonical World Model');
  return getPool();
}

function objectOf(r) {
  if (r.object_entity_id) return { kind: 'entity', entityId: r.object_entity_id, label: r.object_label ?? null };
  if (r.object_quantity != null) return { kind: 'quantity', quantity: Number(r.object_quantity), unit: r.object_unit ?? null };
  if (r.object_time_from) return { kind: 'time', from: r.object_time_from, to: r.object_time_to ?? null };
  return { kind: 'literal', value: r.object_literal ?? null };
}

/**
 * The slice of ONE owner's World Model the triggers read: current and disputed
 * claims of the planning predicates, every disputed claim, and deadline claims
 * superseded in the last 14 days (a CHANGE is itself a trigger).
 */
export async function loadWorldSlice(ownerId, { limit = MAX_CLAIMS } = {}) {
  const p = await pool();
  const { rows } = await p.query(`
    SELECT c.claim_id, c.owner_id, c.subject_entity_id, se.canonical_label AS subject_label,
           c.predicate, c.object_entity_id, oe.canonical_label AS object_label,
           c.object_literal, c.object_quantity, c.object_unit, c.object_time_from, c.object_time_to,
           c.polarity, c.modality, c.valid_from, c.valid_to, c.asserted_at, c.updated_at,
           c.state, c.superseded_by, c.extractor,
           c.confidence_extraction, c.confidence_source, c.confidence_corroboration
      FROM aqua_claims c
      JOIN aqua_entities se ON se.entity_id=c.subject_entity_id AND se.owner_id=c.owner_id
      LEFT JOIN aqua_entities oe ON oe.entity_id=c.object_entity_id AND oe.owner_id=c.owner_id
     WHERE c.owner_id=$1
       AND ( (c.state IN ('active','trusted','disputed') AND (c.predicate = ANY($2) OR c.state='disputed'))
          OR (c.state='superseded' AND c.predicate='deadline_for' AND c.updated_at > now() - interval '14 days') )
     ORDER BY c.asserted_at DESC
     LIMIT $3`, [ownerId, WORLD_PREDICATES, Math.min(Math.max(1, limit), MAX_CLAIMS)]);
  return rows.map(r => ({
    claimId: r.claim_id, ownerId: r.owner_id, subjectEntityId: r.subject_entity_id, subject: r.subject_label,
    predicate: r.predicate, object: objectOf(r), polarity: r.polarity, modality: r.modality,
    validFrom: r.valid_from, validTo: r.valid_to, assertedAt: r.asserted_at, updatedAt: r.updated_at,
    state: r.state, supersededBy: r.superseded_by, extractor: r.extractor,
    // Geometric mean of the stored components (the read model's derivation, minus recency).
    confidence: { derived: Number(Math.cbrt(Number(r.confidence_extraction ?? 0.5) * Number(r.confidence_source ?? 0.5)
      * Math.max(0.5, Number(r.confidence_corroboration ?? 0))).toFixed(3)) },
  }));
}

export async function loadHistory(ownerId, { days = 30, limit = 200 } = {}) {
  const p = await pool();
  const { rows } = await p.query(`
    SELECT intervention_id, trigger_type, cooldown_key, idempotency_key, severity, status, user_response,
           created_at, responded_at
      FROM aqua_interventions
     WHERE owner_id=$1 AND created_at > now() - ($2::int * interval '1 day')
     ORDER BY created_at DESC LIMIT $3`, [ownerId, days, limit]);
  return rows.map(r => ({ interventionId: r.intervention_id, triggerType: r.trigger_type, cooldownKey: r.cooldown_key,
    idempotencyKey: r.idempotency_key, severity: r.severity, status: r.status, userResponse: r.user_response,
    createdAt: r.created_at, respondedAt: r.responded_at }));
}

/** Is this world state already judged? (also checked outside the 30-day history window) */
export async function hasIdempotencyKey(ownerId, key) {
  const p = await pool();
  const { rows } = await p.query(`SELECT 1 FROM aqua_interventions WHERE owner_id=$1 AND idempotency_key=$2`, [ownerId, key]);
  return rows.length > 0;
}

export async function loadPrefs(ownerId) {
  const p = await pool();
  const { rows } = await p.query(`SELECT * FROM aqua_proactive_prefs WHERE owner_id=$1`, [ownerId]);
  const r = rows[0];
  return r ? { enabled: r.enabled, minSeverity: r.min_severity, maxPerDay: r.max_per_day,
    quietStartMin: r.quiet_start_min, quietEndMin: r.quiet_end_min, tzOffsetMin: r.tz_offset_min } : { ...DEFAULT_PREFS };
}

export async function savePrefs(ownerId, prefs = {}) {
  const cur = await loadPrefs(ownerId);
  const next = { ...cur, ...Object.fromEntries(Object.entries(prefs).filter(([, v]) => v !== undefined)) };
  const p = await pool();
  await p.query(`
    INSERT INTO aqua_proactive_prefs (owner_id, enabled, min_severity, max_per_day, quiet_start_min, quiet_end_min, tz_offset_min, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,now())
    ON CONFLICT (owner_id) DO UPDATE SET enabled=$2, min_severity=$3, max_per_day=$4,
      quiet_start_min=$5, quiet_end_min=$6, tz_offset_min=$7, updated_at=now()`,
  [ownerId, Boolean(next.enabled), next.minSeverity, Number(next.maxPerDay), next.quietStartMin ?? null,
    next.quietEndMin ?? null, Number(next.tzOffsetMin ?? 0)]);
  return loadPrefs(ownerId);
}

/** Record one decision (fired or suppressed). Idempotent: an existing key returns { created:false }. */
export async function recordDecision(ownerId, candidate, decision, { proposedAction = null, actor = 'aqua:proactive' } = {}) {
  const p = await pool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const id = crypto.randomUUID();
    const status = decision.fire ? 'proposed' : 'suppressed';
    const delivery = decision.fire ? (decision.deliverAfter ? 'deferred' : 'pending') : 'not_delivered';
    const { rows } = await client.query(`
      INSERT INTO aqua_interventions (intervention_id, owner_id, trigger_type, subject_entity_id, cooldown_key,
        idempotency_key, status, delivery_status, severity, urgency, reason, message, world_state, confidence,
        decision, proposed_action, deliver_after, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17,$18)
      ON CONFLICT (owner_id, idempotency_key) DO NOTHING
      RETURNING intervention_id`,
    [id, ownerId, candidate.type, candidate.subjectEntityId ?? null, candidate.cooldownKey, decision.idempotencyKey,
      status, delivery, decision.severity, decision.urgency, candidate.reason, candidate.message,
      JSON.stringify({ subject: candidate.subjectLabel ?? null, deadline: candidate.deadline ?? null,
        daysLeft: candidate.daysLeft ?? null, blockers: candidate.blockers ?? [], evidenceClaimIds: candidate.evidenceClaimIds }),
      JSON.stringify(decision.confidence ?? {}),
      JSON.stringify({ reason: decision.reason, score: decision.score, trace: decision.trace }),
      proposedAction ? JSON.stringify(proposedAction) : null,
      decision.deliverAfter ?? null, decision.expiresAt]);
    if (!rows.length) { await client.query('ROLLBACK'); return { created: false }; }
    for (const claimId of candidate.evidenceClaimIds ?? []) {
      await client.query(`INSERT INTO aqua_intervention_evidence (owner_id, intervention_id, claim_id) VALUES ($1,$2,$3)
        ON CONFLICT DO NOTHING`, [ownerId, id, claimId]);
    }
    await client.query(`
      INSERT INTO aqua_outbox (owner_id, event_type, aggregate_kind, aggregate_id, payload, actor, state, published_at)
      VALUES ($1,'proactive.intervention','intervention',$2,$3::jsonb,$4,'published',now())`,
    [ownerId, id, JSON.stringify({ triggerType: candidate.type, status, reason: decision.reason, severity: decision.severity }), actor]);
    await client.query('COMMIT');
    return { created: true, interventionId: id, status };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

const API_COLUMNS = `intervention_id, trigger_type, status, delivery_status, severity, urgency, reason, message,
  world_state, confidence, decision, proposed_action, user_response, outcome, deliver_after, expires_at,
  created_at, delivered_at, responded_at`;
function apiRow(r) {
  if (!r) return null;
  return { interventionId: r.intervention_id, triggerType: r.trigger_type, status: r.status, deliveryStatus: r.delivery_status,
    severity: r.severity, urgency: r.urgency, reason: r.reason, message: r.message, worldState: r.world_state,
    confidence: r.confidence, decision: r.decision, proposedAction: r.proposed_action, userResponse: r.user_response,
    outcome: r.outcome, deliverAfter: r.deliver_after, expiresAt: r.expires_at, createdAt: r.created_at,
    deliveredAt: r.delivered_at, respondedAt: r.responded_at };
}

export async function listInterventions(ownerId, { status = null, includeSuppressed = false, limit = 50 } = {}) {
  const p = await pool();
  const { rows } = await p.query(`
    SELECT ${API_COLUMNS} FROM aqua_interventions
     WHERE owner_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3 OR status <> 'suppressed')
     ORDER BY created_at DESC LIMIT $4`, [ownerId, status, includeSuppressed, Math.min(Math.max(1, limit), 200)]);
  return rows.map(apiRow);
}

export async function getIntervention(ownerId, id) {
  const p = await pool();
  const { rows } = await p.query(`SELECT ${API_COLUMNS} FROM aqua_interventions WHERE owner_id=$1 AND intervention_id=$2`, [ownerId, id]);
  return apiRow(rows[0]);
}

/**
 * EVIDENCE STILL HOLDS (2026-10-06, found by proactive.live.test.js): a
 * contradiction intervention was delivered AFTER the user had resolved the
 * contradiction — its evidence claims were no longer disputed. An intervention
 * is only deliverable while every evidence claim is still in the state its
 * trigger requires; otherwise it is stale (WRONG_STATE) and expires.
 */
const EVIDENCE_HOLDS = `NOT EXISTS (
  SELECT 1 FROM aqua_intervention_evidence e
    JOIN aqua_claims c ON c.claim_id=e.claim_id AND c.owner_id=e.owner_id
   WHERE e.intervention_id=i.intervention_id AND e.owner_id=i.owner_id
     AND NOT (c.state = ANY(CASE i.trigger_type
       WHEN 'contradiction_unresolved' THEN ARRAY['disputed']
       WHEN 'dependent_plan_invalidated' THEN ARRAY['active','trusted','superseded']
       ELSE ARRAY['active','trusted'] END)))`;

/**
 * Take the next DELIVERABLE intervention for a turn and mark it delivered —
 * compare-and-set, so two concurrent turns never deliver the same one.
 */
export async function claimDeliverable(ownerId, { minSeverity = 'medium', now = new Date() } = {}) {
  const p = await pool();
  const sev = { low: ['low', 'medium', 'high'], medium: ['medium', 'high'], high: ['high'] }[minSeverity] ?? ['medium', 'high'];
  const { rows } = await p.query(`
    UPDATE aqua_interventions SET status='delivered', delivery_status='delivered', delivered_at=now()
     WHERE intervention_id = (
       SELECT intervention_id FROM aqua_interventions i
        WHERE owner_id=$1 AND status='proposed' AND delivery_status IN ('pending','deferred')
          AND (deliver_after IS NULL OR deliver_after <= $2) AND expires_at > $2 AND severity = ANY($3)
          AND ${EVIDENCE_HOLDS}
        ORDER BY urgency DESC, created_at ASC
        FOR UPDATE SKIP LOCKED LIMIT 1)
       AND owner_id=$1 AND status='proposed'
     RETURNING ${API_COLUMNS}`, [ownerId, now, sev]);
  return apiRow(rows[0]);
}

const RESPONSES = new Set(['accepted', 'dismissed', 'corrected', 'snoozed']);
/** The user's response — the learning signal. CAS on the current status; repeat calls are idempotent. */
export async function respond(ownerId, id, response, { note = null, snoozeHours = 24, actor = 'user' } = {}) {
  if (!RESPONSES.has(response)) throw new Error(`unknown response "${response}"`);
  const p = await pool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT status, user_response FROM aqua_interventions WHERE owner_id=$1 AND intervention_id=$2 FOR UPDATE`, [ownerId, id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return null; }
    if (cur.rows[0].user_response === response) { await client.query('ROLLBACK'); return { ...(await getIntervention(ownerId, id)), replayed: true }; }
    const snooze = response === 'snoozed';
    await client.query(`
      UPDATE aqua_interventions
         SET user_response=$3, responded_at=now(),
             status = CASE WHEN $4 THEN 'proposed' ELSE $3 END,
             delivery_status = CASE WHEN $4 THEN 'deferred' ELSE delivery_status END,
             deliver_after = CASE WHEN $4 THEN now() + ($5::int * interval '1 hour') ELSE deliver_after END,
             outcome = COALESCE(outcome,'{}'::jsonb) || jsonb_build_object('response', $3::text, 'note', $6::text)
       WHERE owner_id=$1 AND intervention_id=$2`, [ownerId, id, response, snooze, snoozeHours, note]);
    await client.query(`
      INSERT INTO aqua_outbox (owner_id, event_type, aggregate_kind, aggregate_id, payload, actor, state, published_at)
      VALUES ($1,'proactive.response','intervention',$2,$3::jsonb,$4,'published',now())`,
    [ownerId, id, JSON.stringify({ response }), actor]);
    await client.query('COMMIT');
    return getIntervention(ownerId, id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

/** Interventions whose evidence or deadline has passed leave the active set (never deleted, L5). */
export async function expire(ownerId, now = new Date()) {
  const p = await pool();
  const { rowCount } = await p.query(`
    UPDATE aqua_interventions i
       SET status='expired',
           outcome = COALESCE(outcome,'{}'::jsonb) || jsonb_build_object('expired',
             CASE WHEN expires_at <= $2 THEN 'time' ELSE 'evidence-changed' END)
     WHERE owner_id=$1 AND status='proposed' AND (expires_at <= $2 OR NOT ${EVIDENCE_HOLDS})`, [ownerId, now]);
  return rowCount ?? 0;
}

/** Owners whose World Model holds a current deadline or dispute — the periodic scan set. Bounded. */
export async function ownersToScan({ limit = 200 } = {}) {
  const p = await pool();
  const { rows } = await p.query(`
    SELECT DISTINCT owner_id FROM aqua_claims
     WHERE state IN ('active','trusted','disputed') AND (predicate='deadline_for' OR state='disputed')
     LIMIT $1`, [limit]);
  return rows.map(r => r.owner_id);
}

/** Learning/usefulness counters for one owner (Phase 4 metrics). */
export async function interventionStats(ownerId, { days = 90 } = {}) {
  const p = await pool();
  const { rows } = await p.query(`
    SELECT trigger_type, status, user_response, count(*)::int AS n
      FROM aqua_interventions WHERE owner_id=$1 AND created_at > now() - ($2::int * interval '1 day')
     GROUP BY 1,2,3`, [ownerId, days]);
  const fired = rows.filter(r => r.status !== 'suppressed').reduce((n, r) => n + r.n, 0);
  const responded = rows.filter(r => r.user_response).reduce((n, r) => n + r.n, 0);
  const by = k => rows.filter(r => r.user_response === k).reduce((n, r) => n + r.n, 0);
  // PRODUCT measurement (real users), as opposed to the authored engineering
  // test eval/suites/proactive-core. Denominator = interventions the user
  // actually SAW (delivered, whatever happened after).
  const { rows: [d] } = await p.query(`SELECT count(*)::int AS n FROM aqua_interventions
    WHERE owner_id=$1 AND delivered_at IS NOT NULL AND created_at > now() - ($2::int * interval '1 day')`, [ownerId, days]);
  const delivered = d?.n ?? 0;
  const rate = k => (delivered ? Number((by(k) / delivered).toFixed(4)) : null);
  return { fired, suppressed: rows.filter(r => r.status === 'suppressed').reduce((n, r) => n + r.n, 0), responded, delivered,
    acceptanceRate: responded ? by('accepted') / responded : null,
    dismissalRate: responded ? by('dismissed') / responded : null,
    correctionRate: responded ? by('corrected') / responded : null,
    // usefulness = accepted / delivered; falseInterventionRate = the user said
    // the premise was WRONG (response 'corrected') / delivered; unanswered
    // deliveries count in the denominator, so these are lower bounds.
    product: { delivered, usefulness: rate('accepted'), dismissal: rate('dismissed'),
      falseInterventionRate: rate('corrected'), responseRate: delivered ? Number((responded / delivered).toFixed(4)) : null,
      source: 'real user responses (aqua_interventions); not the authored engineering test' },
    rows };
}

/** G4 — every row of this owner. Evidence links cascade with the intervention. */
export async function purgeOwner(ownerId) {
  if (!ownerId) return { interventions: 0, prefs: 0, skipped: 'no owner' };
  if (!isConfigured()) return { interventions: 0, prefs: 0, skipped: 'postgres not configured' };
  const p = await getPool();
  await p.query('DELETE FROM aqua_intervention_evidence WHERE owner_id=$1', [ownerId]);
  const iv = await p.query('DELETE FROM aqua_interventions WHERE owner_id=$1', [ownerId]);
  const pr = await p.query('DELETE FROM aqua_proactive_prefs WHERE owner_id=$1', [ownerId]);
  return { interventions: iv.rowCount ?? 0, prefs: pr.rowCount ?? 0, skipped: null };
}
