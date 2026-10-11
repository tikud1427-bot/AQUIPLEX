/**
 * AQUA — BOUNDED ACTION executor (Phase 5, 2026-10-06).
 *
 *   PLAN (planner.js) → APPROVAL (owner, explicit) → EXECUTION (this module,
 *   as a durable job) → OUTCOME (step results on the run + the intervention's
 *   outcome) → LEARNING (the response/outcome the proactive policy reads back).
 *
 * Safety contract:
 *   · nothing runs unless the run is `approved` by its owner (approve());
 *   · every step is from the closed set below, within the plan's step budget
 *     and a per-step timeout; retries are bounded by max_attempts (job queue
 *     backoff) and skip steps that already completed (idempotent);
 *   · the ONLY World-Model effect (resolve_contradiction) goes through the
 *     canonical lifecycle path (worldModelRepository.transition: lifecycle row,
 *     revision, outbox), actor 'user', and re-checks that the claims are still
 *     disputed — a stale plan fails rather than acting on a changed world;
 *   · nothing is ever sent outside the product: a draft is returned to the
 *     user, who decides whether to send it;
 *   · every transition is audited in the outbox (action.*).
 */
import * as runs from './repository.js';
import { STEP_TIMEOUT_MS } from './planner.js';
import { transition } from '../../core/worldModel/worldModelRepository.js';
import { enqueue } from '../../core/jobs/jobQueue.js';
import { recordDecision } from '../proactive/repository.js';
import { getPool } from '../../core/db/pool.js';

export const ACTION_JOB_KIND = 'action.execute.v1';

/** Owner approval — the seam. `choice` is required for plans that need one. */
export async function approve(ownerId, runId, { choice = null, actor = 'user' } = {}) {
  const run = await runs.getRun(ownerId, runId);
  if (!run) return { ok: false, code: 'NOT_FOUND' };
  if (run.status !== 'proposed') return { ok: run.status === 'approved' || run.status === 'running' || run.status === 'succeeded', code: 'NOT_PROPOSED', run };
  if (new Date(run.expiresAt) <= new Date()) {
    await runs.transitionRun(ownerId, runId, 'proposed', 'expired', { actor: 'aqua:actions' });
    return { ok: false, code: 'EXPIRED' };
  }
  if (run.plan?.needsChoice) {
    const allowed = run.plan.steps?.[0]?.claimIds ?? [];
    if (!choice || !allowed.includes(choice)) return { ok: false, code: 'CHOICE_REQUIRED', options: allowed };
  }
  const approved = await runs.transitionRun(ownerId, runId, 'proposed', 'approved', {
    set: { approval: { by: actor, at: new Date().toISOString(), choice }, approved_at: new Date() }, actor, audit: { choice },
  });
  if (!approved) return { ok: false, code: 'LOST_RACE' };
  const job = await enqueue({ ownerId, kind: ACTION_JOB_KIND, payload: { runId }, idempotencyKey: `action:execute:${runId}`,
    priority: 60, maxAttempts: approved.maxAttempts });
  return { ok: true, run: approved, jobId: job.jobId };
}

export async function reject(ownerId, runId, { actor = 'user' } = {}) {
  const r = await runs.transitionRun(ownerId, runId, 'proposed', 'rejected', { actor, set: { finished_at: new Date() } });
  return r ? { ok: true, run: r } : { ok: false, code: 'NOT_PROPOSED' };
}

const withTimeout = (p, ms, label) => Promise.race([p,
  new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: 'STEP_TIMEOUT' })), ms))]);

/** The closed set of step operations. Each returns a JSON-able result. */
const OPS = {
  async compose_draft({ step }) {
    return { draft: { to: String(step.to ?? ''), body: String(step.body ?? '') }, sent: false,
      note: 'Draft only — the user sends it; Aqua has no outbound channel.' };
  },
  async schedule_reminder({ ownerId, run, step }) {
    const at = new Date(step.at);
    if (Number.isNaN(at.getTime())) throw new Error('reminder time invalid');
    const evidence = run.plan.evidenceClaimIds ?? [];
    const r = await recordDecision(ownerId, {
      type: 'reminder', subjectEntityId: null, subjectLabel: null, cooldownKey: `reminder:${run.runId}`,
      evidenceClaimIds: evidence, reason: `Reminder you approved (${run.title}).`, message: String(step.message ?? run.title), blockers: [],
    }, {
      fire: true, reason: 'approved-reminder', severity: 'medium', urgency: 0.6, idempotencyKey: `reminder:${run.runId}`,
      deliverAfter: at, expiresAt: new Date(at.getTime() + 3 * 86_400_000), score: null, confidence: {}, trace: ['user-approved action'],
    }, { actor: 'user' });
    return { reminderInterventionId: r.interventionId ?? null, at: at.toISOString(), created: r.created };
  },
  async apply_choice({ ownerId, run, step }) {
    const choice = run.approval?.choice;
    const ids = step.claimIds ?? [];
    if (!choice || !ids.includes(choice)) throw Object.assign(new Error('no valid user choice'), { code: 'CHOICE_REQUIRED', permanent: true });
    const p = await getPool();
    const { rows } = await p.query(`SELECT claim_id, state FROM aqua_claims WHERE owner_id=$1 AND claim_id = ANY($2::uuid[])`, [ownerId, ids]);
    const state = new Map(rows.map(r => [r.claim_id, r.state]));
    if (rows.length !== ids.length) throw Object.assign(new Error('a claim in the plan no longer exists for this owner'), { permanent: true });
    const out = [];
    // Idempotent re-run: a claim already in its target state is skipped.
    if (state.get(choice) === 'disputed') {
      await transition({ ownerId, actor: 'user', targetKind: 'claim', targetId: choice, toState: 'active',
        reason: 'user-resolved-contradiction', source: 'action:resolve_contradiction' });
      out.push({ claimId: choice, to: 'active' });
    } else if (!['active', 'trusted'].includes(state.get(choice))) {
      throw Object.assign(new Error(`chosen claim is ${state.get(choice)} — the world changed since the plan`), { permanent: true });
    }
    for (const id of ids.filter(x => x !== choice)) {
      const s = state.get(id);
      if (s === 'superseded') continue;
      if (s !== 'disputed') throw Object.assign(new Error(`claim ${id} is ${s} — the world changed since the plan`), { permanent: true });
      await transition({ ownerId, actor: 'user', targetKind: 'claim', targetId: id, toState: 'superseded', supersededBy: choice,
        reason: 'user-resolved-contradiction', source: 'action:resolve_contradiction' });
      out.push({ claimId: id, to: 'superseded', supersededBy: choice });
    }
    return { kept: choice, transitions: out };
  },
};

/** Durable job: execute ONE approved run within its budget. */
export async function runActionJob(job) {
  const ownerId = job.ownerId;
  const runId = job.payload?.runId;
  let run = await runs.getRun(ownerId, runId);
  if (!run) return { skipped: 'not-found' };
  if (['succeeded', 'failed', 'rejected', 'expired'].includes(run.status)) return { skipped: run.status };
  if (run.status === 'approved') {
    run = await runs.transitionRun(ownerId, runId, 'approved', 'running', { actor: 'aqua:executor', set: { started_at: new Date(), attempts: 1 } });
    if (!run) return { skipped: 'lost-race' };
  } else if (run.status === 'running') {
    // A retry after a crash/failure: bounded by max_attempts.
    if (run.attempts >= run.maxAttempts) {
      await runs.transitionRun(ownerId, runId, 'running', 'failed', { actor: 'aqua:executor', set: { finished_at: new Date(), error: 'max attempts exhausted' } });
      return { failed: true };
    }
    run = await runs.transitionRun(ownerId, runId, 'running', 'running', { actor: 'aqua:executor', set: { attempts: run.attempts + 1 } });
  } else {
    return { skipped: run.status };        // proposed: never executes without approval
  }

  const steps = (run.plan?.steps ?? []).slice(0, Math.min(run.stepBudget, 3));
  const result = { ...(run.result ?? {}), steps: [...(run.result?.steps ?? [])] };
  try {
    for (let i = 0; i < steps.length; i++) {
      if (result.steps[i]?.ok) continue;                       // idempotent retry
      const op = OPS[steps[i].op];
      if (!op) throw Object.assign(new Error(`unknown step op ${steps[i].op}`), { permanent: true });
      const out = await withTimeout(op({ ownerId, run, step: steps[i] }), run.plan.stepTimeoutMs ?? STEP_TIMEOUT_MS, steps[i].op);
      result.steps[i] = { op: steps[i].op, ok: true, out, at: new Date().toISOString() };
      await runs.saveResult(ownerId, runId, result);
    }
    const done = await runs.transitionRun(ownerId, runId, 'running', 'succeeded', { actor: 'aqua:executor',
      set: { finished_at: new Date(), result }, audit: { steps: result.steps.length } });
    await recordOutcome(ownerId, run, { status: 'succeeded', result });
    return { succeeded: true, run: done };
  } catch (err) {
    await runs.saveResult(ownerId, runId, { ...result, lastError: String(err?.message ?? err) });
    if (err?.permanent) {
      await runs.transitionRun(ownerId, runId, 'running', 'failed', { actor: 'aqua:executor',
        set: { finished_at: new Date(), error: String(err.message).slice(0, 500) } });
      await recordOutcome(ownerId, run, { status: 'failed', error: String(err.message) });
      return { failed: true, error: err.message };
    }
    throw err;   // transient: the queue retries with backoff, bounded by max_attempts
  }
}

/** The run's outcome becomes the intervention's outcome — evidence for learning (Phase 3/4). */
async function recordOutcome(ownerId, run, outcome) {
  if (!run.interventionId) return;
  try {
    const p = await getPool();
    await p.query(`UPDATE aqua_interventions
       SET outcome = COALESCE(outcome,'{}'::jsonb) || jsonb_build_object('action', $3::jsonb)
     WHERE owner_id=$1 AND intervention_id=$2`, [ownerId, run.interventionId, JSON.stringify({ runId: run.runId, kind: run.kind, ...outcome })]);
  } catch (err) { console.warn(`[ACTIONS] outcome not recorded on intervention: ${err?.message ?? err}`); }
}
