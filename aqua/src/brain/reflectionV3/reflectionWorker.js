/**
 * AQUA Brain — E9 / PR-5 durable claim-reflection worker.
 *
 * The job contains only owner + claim identity. Claims remain canonical and
 * the existing Claim → Belief Adapter remains the sole reflection bridge.
 */
import { claimWithEvidence } from '../../core/worldModel/worldModelRepository.js';
import { reflectClaimsToBeliefs } from './claimBeliefAdapter.js';
import { reflectionEffectKey, hasReflectionEffect, markReflectionEffect } from './reflectionIdempotency.js';
import { getMind, touchMind } from '../../mind/mindStore.js';

export async function runClaimReflectionJob(job, { loadClaim = claimWithEvidence, reflect = reflectClaimsToBeliefs, loadMind = getMind } = {}) {
  const ownerId = job?.ownerId;
  const claimId = job?.payload?.claimId;
  if (!ownerId || !claimId) throw new Error('claim reflection job requires ownerId and claimId');

  const effectKey = reflectionEffectKey({
    ownerId,
    outboxId: job?.payload?.outboxId,
    eventType: job?.payload?.eventType,
    claimId,
  });
  const mind = loadMind(ownerId);
  if (!mind) return { ok: false, ownerId, claimId, reflected: false, reason: 'mind unavailable' };
  if (hasReflectionEffect(mind, effectKey)) {
    return { ok: true, ownerId, claimId, reflected: false, duplicate: true, effectKey };
  }

  const claim = await loadClaim(claimId, ownerId);
  if (!claim) return { ok: false, ownerId, claimId, reflected: false, reason: 'claim-not-found' };

  const eventType = job?.payload?.eventType ?? null;
  const reflectionEvent = eventType
    ? {
        claimId,
        eventType: String(eventType).replace(/^claim\./, ''),
        previousState: job?.payload?.previousState ?? null,
        nextState: job?.payload?.nextState ?? null,
      }
    : null;

  const result = await reflect({
    ownerId,
    affectedClaims: [claim],
    reflectionEvents: reflectionEvent ? [reflectionEvent] : [],
    conversationId: job?.payload?.conversationId ?? null,
    deps: { getMind: () => mind },
  });
  if (!result.ok) throw new Error(`claim reflection failed: ${result.reason ?? 'unknown'}`);

  // Belief Engine mutation is synchronous. Mark immediately after it succeeds;
  // touchMind() from the writer schedules one snapshot containing both effect
  // and belief state. A retry therefore sees the marker and performs no delta.
  markReflectionEffect(mind, effectKey, { claimId, eventType: job?.payload?.eventType ?? null });
  touchMind(mind);
  return { ok: true, ownerId, claimId, reflected: result.signals > 0, effectKey, ...result };
}
