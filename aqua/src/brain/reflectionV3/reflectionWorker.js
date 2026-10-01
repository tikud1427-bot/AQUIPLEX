/**
 * AQUA Brain — E9 / PR-5 durable claim-reflection worker.
 *
 * The job contains only owner + claim identity. Claims remain canonical and
 * the existing Claim → Belief Adapter remains the sole reflection bridge.
 */
import { claimWithEvidence, persistInferredPattern } from '../../core/worldModel/worldModelRepository.js';
import * as canonicalReadModel from '../../core/worldModel/canonicalReadModel.js';
import { inferPatterns } from './patternInference.js';
import { reflectClaimsToBeliefs } from './claimBeliefAdapter.js';
import { reflectionEffectKey, hasReflectionEffect, markReflectionEffect } from './reflectionIdempotency.js';
import { getMind, touchMind } from '../../mind/mindStore.js';

export async function runClaimReflectionJob(job, { loadClaim = claimWithEvidence, reflect = reflectClaimsToBeliefs, loadMind = getMind, listClaims = canonicalReadModel.listClaims, persistPattern = persistInferredPattern, infer = inferPatterns } = {}) {
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

  const claim = await loadClaim(ownerId, claimId);
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

  let pattern = { proposed: 0, persisted: 0, errors: 0 };
  try {
    // Reflection sees a bounded recent canonical window. The pure inference
    // engine does the policy; the repository does the write.
    const recent = await listClaims(ownerId, { limit: 64 });
    const proposals = infer({ ownerId, claims: recent });
    pattern.proposed = proposals.length;
    for (const proposal of proposals.slice(0, 4)) {
      try {
        if (!proposal.subjectEntityId || !proposal.predicate || !proposal.statementText) continue;
        const persisted = await persistPattern(proposal);
        if (persisted?.skipped || persisted?.duplicate) continue;
        pattern.persisted += 1;
      } catch (err) {
        // Uniqueness or stale-evidence races are non-fatal to the base
        // reflection effect; the claim reflection job must remain retryable.
        pattern.errors += 1;
        console.warn(`[REFLECTION] inferred pattern write skipped: ${err?.message ?? err}`);
      }
    }
  } catch (err) {
    pattern.errors += 1;
    console.warn(`[REFLECTION] pattern inference unavailable: ${err?.message ?? err}`);
  }

  return { ok: true, ownerId, claimId, reflected: result.signals > 0, effectKey, pattern, ...result };
}
