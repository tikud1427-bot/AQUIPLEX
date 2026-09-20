/**
 * AQUA — E9 contradiction-resolution worker.
 *
 * S8 only detects contradiction. This durable worker is the S9/E9 decision
 * boundary: load the two owner-scoped canonical claims, run the pure policy,
 * then apply only the lifecycle mutation the policy explicitly permits.
 *
 * No LLM, no legacy claim store, no cross-owner reads.
 */
import { claimWithEvidence, transition } from '../../core/worldModel/worldModelRepository.js';
import { resolveContradiction, CONTRADICTION_ACTION } from './contradictionPolicy.js';

function normalized(claim) {
  if (!claim) return null;
  return {
    ...claim,
    claimId: claim.claimId ?? claim.id,
    ownerId: claim.ownerId,
    subjectEntityId: claim.subjectEntityId,
    confidence: Number(claim.confidence ?? claim.confidenceExtraction ?? 0.5),
    createdAt: claim.createdAt ?? claim.assertedAt ?? 0,
  };
}

export async function runClaimContradictionJob(
  job,
  {
    loadClaim = async (claimId, ownerId) => claimWithEvidence(ownerId, claimId),
    applyTransition = transition,
    policy = resolveContradiction,
  } = {},
) {
  const ownerId = job?.ownerId;
  const incomingClaimId = job?.payload?.incomingClaimId;
  const existingClaimId = job?.payload?.existingClaimId;
  if (!ownerId || !incomingClaimId || !existingClaimId) {
    throw new Error('claim contradiction job requires ownerId, incomingClaimId and existingClaimId');
  }

  const [incomingRaw, existingRaw] = await Promise.all([
    loadClaim(incomingClaimId, ownerId),
    loadClaim(existingClaimId, ownerId),
  ]);
  if (!incomingRaw || !existingRaw) {
    return { ok: false, ownerId, resolved: false, reason: 'claim-not-found' };
  }

  const incoming = normalized(incomingRaw);
  const existing = normalized(existingRaw);
  const decision = policy(incoming, existing, {
    allowHeuristicResolution: false,
    allowRecencyResolution: false,
  });

  if (decision.action === CONTRADICTION_ACTION.NOT_CONTRADICTORY) {
    return { ok: true, ownerId, resolved: false, action: decision.action, rule: decision.rule };
  }

  if (decision.action === CONTRADICTION_ACTION.SUPERSEDE_BY_CORRECTION ||
      decision.action === CONTRADICTION_ACTION.SUPERSEDE_OLDER) {
    const winnerId = decision.winner?.claimId;
    const loserId = decision.loser?.claimId;
    if (!winnerId || !loserId || winnerId === loserId) {
      throw new Error('contradiction policy returned an invalid supersession pair');
    }
    if (existingRaw.state === 'superseded' && existingRaw.supersededBy === winnerId) {
      return { ok: true, ownerId, resolved: true, idempotent: true, action: decision.action, winnerId, loserId, rule: decision.rule };
    }
    if (incomingRaw.state === 'superseded' && incomingRaw.supersededBy === winnerId) {
      return { ok: true, ownerId, resolved: true, idempotent: true, action: decision.action, winnerId, loserId, rule: decision.rule };
    }
    await applyTransition({
      ownerId,
      targetKind: 'claim',
      targetId: loserId,
      toState: 'superseded',
      supersededBy: winnerId,
      reason: `e9-contradiction:${decision.reason}`,
      actor: 'e9:contradiction-policy',
      source: 'e9',
    });
    return { ok: true, ownerId, resolved: true, action: decision.action, winnerId, loserId, rule: decision.rule };
  }

  if (decision.action === CONTRADICTION_ACTION.DISPUTED) {
    const ids = [incomingRaw, existingRaw]
      .filter(c => c.state !== 'disputed' && c.state !== 'superseded')
      .map(c => c.claimId ?? c.id);
    for (const claimId of ids) {
      await applyTransition({
        ownerId,
        targetKind: 'claim',
        targetId: claimId,
        toState: 'disputed',
        reason: `e9-contradiction:${decision.reason}`,
        actor: 'e9:contradiction-policy',
        source: 'e9',
      });
    }
    return { ok: true, ownerId, resolved: false, action: decision.action, disputedClaimIds: ids, rule: decision.rule };
  }

  return { ok: false, ownerId, resolved: false, reason: `unsupported policy action: ${decision.action}` };
}
