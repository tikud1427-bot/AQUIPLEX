/**
 * AQUA — E9 / PR-10 deterministic lifecycle integration harness.
 *
 * This is a dependency-free executable model of the durable reflection contract.
 * It intentionally models the ordering boundaries rather than mocking Postgres:
 * canonical event -> idempotent job -> worker effect -> acknowledgement,
 * including crash/retry/reconciliation cases.
 *
 * Production adapters remain claimRepository, jobQueue, reflectionWorker and
 * reflectionReconciliation. This module gives those seams one contract test
 * that can run without DATABASE_URL or node_modules.
 */

import { reflectionJobKey } from './reflectionOutbox.js';
import { reflectionEffectKey, hasReflectionEffect } from './reflectionIdempotency.js';
import { reconciliationDecision } from './reflectionReconciliation.js';

export function createReflectionLifecycleHarness({ ownerId = 'owner:test' } = {}) {
  const state = {
    ownerId,
    nextOutboxId: 1,
    jobs: new Map(),
    effects: new Set(),
    events: [],
  };

  function publish(eventType, claimId) {
    const outboxId = state.nextOutboxId++;
    const event = { ownerId, outboxId, eventType, claimId };
    const key = reflectionJobKey(event);
    state.events.push(event);
    if (!state.jobs.has(key)) {
      state.jobs.set(key, {
        key, state: 'queued', attempts: 0,
        event,
      });
    }
    return state.jobs.get(key);
  }

  function run(key, { crashAfterEffect = false } = {}) {
    const job = state.jobs.get(key);
    if (!job) throw new Error(`unknown reflection job ${key}`);
    if (job.state === 'done') return { duplicate: true, state: job.state };
    if (job.state !== 'queued') throw new Error(`job is not runnable: ${job.state}`);

    job.state = 'running';
    job.attempts++;
    const effectKey = reflectionEffectKey(job.event);
    if (state.effects.has(effectKey)) {
      job.state = 'done';
      return { duplicate: true, effectKey, state: job.state };
    }

    state.effects.add(effectKey);
    if (crashAfterEffect) {
      job.state = 'done'; // models an acknowledgement that outran durable Mind
      return { crashed: true, effectKey, state: job.state };
    }

    job.state = 'done';
    return { applied: true, effectKey, state: job.state };
  }

  function reconcile(key) {
    const job = state.jobs.get(key);
    if (!job) return { action: 'missing-job' };
    const applied = state.effects.has(reflectionEffectKey(job.event));
    const action = reconciliationDecision({
      eventType: job.event.eventType,
      jobState: job.state,
      hasEffect: applied,
    });
    if (action === 'requeue-done' || action === 'requeue-dead') job.state = 'queued';
    return { action, state: job.state, applied };
  }

  return {
    state,
    publish,
    run,
    reconcile,
    hasEffect: key => hasReflectionEffect({ reflectionEffects: [...state.effects].map(effectKey => ({ effectKey })) }, key),
  };
}

export const E9_REFLECTION_EVENTS = Object.freeze([
  'claim.created',
  'claim.corroborated',
  'claim.contradicted',
  'claim.superseded',
  'claim.stale',
]);
