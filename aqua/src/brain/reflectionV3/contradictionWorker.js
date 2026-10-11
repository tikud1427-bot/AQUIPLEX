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
import { cardinalityOf } from '../../core/claims/predicateRegistry.js';

const objectKey = c => {
  const o = c?.object ?? {};
  if (o.entityId) return `e:${o.entityId}`;
  if (o.literal != null) return `l:${String(o.literal).trim().toLowerCase()}`;
  if (o.quantity != null) return `q:${o.quantity}:${o.unit ?? ''}`;
  if (o.time != null) return `t:${new Date(o.time).toISOString()}`;
  return null;
};

/**
 * Are these two claims competing SNAPSHOTS of one single-valued fact, by the
 * registry's declared cardinality? Only then may the policy retire the older
 * one (rule 5). Everything else — a polarity flip, a multi-valued predicate,
 * an intent, a hypothetical — stays with the policy's default (disputed).
 */
export function isDeclaredSnapshotPair(a, b) {
  if (!a || !b || a.predicate !== b.predicate) return false;
  if ((a.modality ?? 'fact') !== 'fact' || (b.modality ?? 'fact') !== 'fact') return false;
  if ((a.polarity ?? 'asserted') !== 'asserted' || (b.polarity ?? 'asserted') !== 'asserted') return false;
  const card = cardinalityOf(a.predicate);
  if (card === 'one-per-subject') {
    return Boolean(a.subjectEntityId) && a.subjectEntityId === b.subjectEntityId
      && objectKey(a) !== null && objectKey(a) !== objectKey(b);
  }
  if (card === 'one-per-object') {
    return Boolean(a.object?.entityId) && a.object.entityId === b.object?.entityId
      && Boolean(a.subjectEntityId) && a.subjectEntityId !== b.subjectEntityId;
  }
  return false;
}

function normalized(claim) {
  if (!claim) return null;
  return {
    ...claim,
    claimId: claim.claimId ?? claim.id,
    ownerId: claim.ownerId,
    subjectEntityId: claim.subjectEntityId,
    confidence: Number(claim.confidence ?? claim.confidenceExtraction ?? 0.5),
    createdAt: claim.createdAt ?? claim.assertedAt ?? 0,
    // The user's own words stated this claim as a change or correction (E6
    // prompt rule 11, kept in the evidence locator at commit).
    revises: claim.revises === true
      || (Array.isArray(claim.evidence) && claim.evidence.some(e => e?.locator?.revision === true)),
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
    snapshotPair: isDeclaredSnapshotPair(incoming, existing),
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
    // The loser is already retired (superseded by a later value, or archived):
    // the world already reflects "not current". Re-superseding it would throw
    // "changes nothing" and retry until DLQ; rewriting its successor would
    // falsify history. Nothing to do.
    const loserRow = loserId === (existingRaw.claimId ?? existingRaw.id) ? existingRaw : incomingRaw;
    if (loserRow.state === 'superseded' || loserRow.state === 'archived') {
      return { ok: true, ownerId, resolved: true, alreadyRetired: true, action: decision.action, winnerId, loserId, rule: decision.rule };
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
