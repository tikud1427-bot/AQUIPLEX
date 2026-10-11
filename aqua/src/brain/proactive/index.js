/**
 * AQUA — PROACTIVE INTELLIGENCE (Phase 4, 2026-10-06).
 *
 *   WORLD MODEL → CHANGE (claim event / time passing) → TRIGGERS (triggers.js)
 *   → POLICY (policy.js) → INTERVENTION (repository.js) → DELIVERY (one per
 *   turn, chat directive; or pulled via GET /brain/interventions) → USER
 *   RESPONSE → LEARNING (the policy reads the responses back) → OUTCOME.
 *
 * Built on the canonical substrate only — no second memory, no second event
 * system: it reads canonical claims, is fed by the transactional outbox and
 * runs as a durable job (`proactive.evaluate.v1`), owner-scoped, idempotent,
 * bounded, observable (recordProactive → /metrics) and purgeable.
 *
 * Gate: AQUA_PROACTIVE (registered in core/flags.js).
 */
import { detectTriggers } from './triggers.js';
import { decide } from './policy.js';
import * as repo from './repository.js';
import { proposeAction } from '../actions/planner.js';
import * as actionRuns from '../actions/repository.js';
import { recordProactive } from '../../core/observability.js';
import { isConfigured } from '../../core/db/pool.js';

export const PROACTIVE_JOB_KIND = 'proactive.evaluate.v1';

/**
 * ON by default (2026-10-06), promoted on its L14 evaluation:
 * eval/suites/proactive-core (40 labelled situations: precision 1.0, recall
 * 1.0, 0 false / duplicate / wrong-type interventions — baseline recorded) and
 * the live production path (proactive.live.test.js). NOT measured: real-user
 * acceptance/dismissal rates (instrumented, interventionStats). =off is the
 * rollback; without Postgres there is nothing to evaluate.
 */
export function proactiveEnabled(env = process.env) {
  return String(env.AQUA_PROACTIVE ?? '').toLowerCase() !== 'off' && isConfigured();
}

/**
 * Evaluate one owner's World Model now. Idempotent: an unchanged world writes
 * nothing (idempotency key = trigger + subject + evidence fingerprint).
 */
export async function evaluateOwner(ownerId, { now = new Date(), deps = repo } = {}) {
  if (!ownerId) throw new Error('evaluateOwner: ownerId is required');
  const started = Date.now();
  recordProactive('evaluations');
  const [claims, history, prefs] = await Promise.all([
    deps.loadWorldSlice(ownerId), deps.loadHistory(ownerId), deps.loadPrefs(ownerId),
  ]);
  const claimsById = new Map(claims.map(c => [c.claimId, c]));
  const candidates = detectTriggers(claims, now);
  recordProactive('candidates', candidates.length);
  const summary = { ownerId, candidates: candidates.length, fired: 0, suppressed: 0, redundant: 0, skipped: {}, interventions: [] };

  for (const cand of candidates) {
    const decision = decide(cand, { ownerId, claimsById, history, prefs, now });
    if (!decision.record) { summary.skipped[decision.reason] = (summary.skipped[decision.reason] ?? 0) + 1; continue; }
    // Older than the 30-day history window but already judged → still redundant.
    if (await deps.hasIdempotencyKey(ownerId, decision.idempotencyKey)) { summary.redundant++; recordProactive('redundant'); continue; }
    const proposedAction = decision.fire ? proposeAction(cand) : null;
    const r = await deps.recordDecision(ownerId, cand, decision, { proposedAction });
    if (!r.created) { summary.redundant++; recordProactive('redundant'); continue; }
    if (decision.fire) { summary.fired++; recordProactive('fired'); }
    // Phase 5: the plan becomes a PROPOSED run awaiting the owner's approval.
    if (decision.fire && proposedAction) {
      await (deps.proposeRun ?? actionRuns.proposeRun)(ownerId, { interventionId: r.interventionId, plan: proposedAction, expiresAt: decision.expiresAt });
    }
    else { summary.suppressed++; recordProactive('suppressed'); recordProactive(`suppressed_${decision.reason}`); }
    summary.interventions.push({ interventionId: r.interventionId, type: cand.type, fired: decision.fire, reason: decision.reason });
    // The new row is part of the history the next candidate is judged against
    // (frequency cap, cooldown) in this same evaluation.
    history.unshift({ triggerType: cand.type, cooldownKey: cand.cooldownKey, idempotencyKey: decision.idempotencyKey,
      severity: decision.severity, status: decision.fire ? 'proposed' : 'suppressed', createdAt: now });
  }
  const expired = await deps.expire(ownerId, now);
  if (expired) recordProactive('expired', expired);
  summary.expired = expired;
  summary.ms = Date.now() - started;
  return summary;
}

/** Durable job handler (workerRuntime). Throws on DB failure so the queue retries. */
export async function runProactiveJob(job) {
  try { return await evaluateOwner(job.ownerId, { now: new Date() }); }
  catch (err) { recordProactive('errors'); throw err; }
}

/**
 * Turn-time delivery: at most ONE deliverable intervention per turn, claimed
 * with compare-and-set so two concurrent turns never raise the same one.
 * Returns a directive for the answer model, or ''. Fail-open (L11).
 */
export async function proactiveDirectiveForTurn(ownerId, { minSeverity = null } = {}) {
  if (!ownerId || !proactiveEnabled()) return '';
  try {
    const prefs = await repo.loadPrefs(ownerId);
    if (prefs.enabled === false) return '';
    const iv = await repo.claimDeliverable(ownerId, { minSeverity: minSeverity ?? prefs.minSeverity ?? 'medium' });
    if (!iv) return '';
    recordProactive('delivered');
    return [
      'PROACTIVE NOTE — Aqua noticed something in the user\'s world that may matter now.',
      'After answering the user\'s message, add ONE short paragraph that raises it plainly. Do not add facts beyond it;',
      'offer help, do not insist, and do not repeat it if the user moves on.',
      `Note: ${iv.message}`,
      `Why (from what the user told Aqua): ${iv.reason}`,
    ].join('\n');
  } catch (err) {
    console.warn(`[PROACTIVE] delivery skipped (fail-open): ${err?.message ?? err}`);
    return '';
  }
}

/** The user's response is the learning signal the policy reads back. */
export async function respondToIntervention(ownerId, interventionId, response, opts = {}) {
  const r = await repo.respond(ownerId, interventionId, response, opts);
  if (r && !r.replayed) recordProactive(response);
  return r;
}

/** Periodic scan (time passing makes a deadline urgent with no new claim). */
export async function scheduleProactive({ enqueue, intervalMs, now = Date.now(), limit = 200 } = {}) {
  if (!proactiveEnabled() || !intervalMs) return { owners: 0, created: 0, disabled: true };
  try {
    const owners = await repo.ownersToScan({ limit });
    const bucket = Math.floor(now / intervalMs);
    let created = 0;
    for (const ownerId of owners) {
      const r = await enqueue({ ownerId, kind: PROACTIVE_JOB_KIND, payload: { reason: 'scan', bucket },
        idempotencyKey: `proactive:scan:${bucket}`, priority: 180, maxAttempts: 5 });
      if (r.created) created++;
    }
    recordProactive('scheduled', created);
    return { owners: owners.length, created };
  } catch (err) {
    console.error(`[PROACTIVE] scheduling failed: ${err?.message ?? err}`);
    return { owners: 0, created: 0, error: String(err?.message ?? err) };
  }
}

/** Debounced evaluation after a World-Model change (called by the outbox dispatcher). */
export const CHANGE_DEBOUNCE_MS = 60_000;
export function changeJob(ownerId, eventType, now = Date.now()) {
  const bucket = Math.floor(now / CHANGE_DEBOUNCE_MS);
  return {
    ownerId, kind: PROACTIVE_JOB_KIND, payload: { reason: eventType, bucket },
    idempotencyKey: `proactive:change:${bucket}`, priority: 170, maxAttempts: 5,
    // Run after the change's own reflection / contradiction work has settled.
    runAfter: new Date(now + 15_000),
  };
}

export { repo as proactiveRepository };
