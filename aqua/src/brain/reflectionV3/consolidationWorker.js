/**
 * AQUA Brain — E9 J3: semantic consolidation as a durable job (2026-10-04).
 *
 * Job kind `claim.consolidation.v1`, one per owner, scheduled by the worker
 * (workerRuntime.scheduleConsolidation) only for owners that HAVE duplicate
 * groups. The queue supplies durability, retries (2^n backoff), max attempts →
 * DLQ, and per-owner serialisation; this module is the domain step.
 *
 * Equivalence oracle: S8's structural identity (same subject, predicate,
 * object, polarity, modality, validity), found by the repository query and
 * RE-VERIFIED under row locks at merge time. No similarity threshold — the
 * planner (semanticConsolidator.js) refuses to invent one, and so does this.
 * Survivor: the planner's existing rule (source rank → evidence count → id).
 *
 * Non-destructive and provenance-preserving: the absorbed claim is archived,
 * never deleted; its evidence and belief links are added to the survivor; the
 * merge is a lifecycle row + 'merge' revision + record outbox event
 * (worldModelRepository.consolidateClaimDuplicate).
 *
 * Idempotent and concurrency-safe: a re-run finds no group for a pair already
 * merged; two jobs racing on one pair serialise on the row locks and the
 * loser gets { applied:false } (counted as `raced`, not an error).
 */
import { consolidateSemanticDuplicates } from './semanticConsolidator.js';
import * as repo from '../../core/worldModel/worldModelRepository.js';
import { recordJ3 } from '../../core/observability.js';

export const CONSOLIDATION_KIND = 'claim.consolidation.v1';
export const CONSOLIDATION_ACTOR = 'e9:j3-consolidation';

/** Map stored provenance onto the planner's source ranks (explicit > file > chat > inferred). */
function sourceTier(c) {
  if (c.actor === 'user') return 'explicit';
  if (c.trust == null) return 'inferred';
  return c.trust >= 0.9 ? 'file' : 'chat';
}

/**
 * Plan one duplicate group with the production planner. Every member of the
 * group is structurally identical, so the oracle answers "equivalent" — the
 * planner's job here is the survivor choice and the merge list.
 */
export async function planGroup(ownerId, group) {
  const shaped = group.map(c => ({ ...c, subject: 'group', predicate: 'group', sourceTier: sourceTier(c),
    evidence: new Array(Number(c.evidenceCount) || 0).fill(null) }));
  const [first, ...rest] = shaped;
  const plan = await consolidateSemanticDuplicates({ ownerId, existing: [first], incoming: rest, semanticEquivalent: () => true });
  // The planner reports pairwise merges; a later merge may absorb an earlier
  // survivor. Collapse to the final survivor so every absorbed claim points at it.
  const finalSurvivor = plan.survivors[0]?.claimId;
  const absorbed = shaped.map(c => c.claimId).filter(id => id !== finalSurvivor);
  return { survivorId: finalSurvivor, absorbed };
}

export async function runClaimConsolidationJob(job, deps = {}) {
  const ownerId = job?.ownerId;
  if (!ownerId) throw new Error('consolidation job requires ownerId');
  const groupsFor = deps.groupsFor ?? (o => repo.structuralDuplicateGroups(o, { limit: 50 }));
  const merge = deps.merge ?? repo.consolidateClaimDuplicate;
  recordJ3('runs');
  const result = { ownerId, groups: 0, merged: 0, raced: 0, evidenceLinked: 0 };
  try {
    const groups = await groupsFor(ownerId);
    result.groups = groups.length;
    recordJ3('groups', groups.length);
    for (const group of groups) {
      const { survivorId, absorbed } = await planGroup(ownerId, group);
      for (const absorbedId of absorbed) {
        const r = await merge({ ownerId, survivorId, absorbedId, actor: CONSOLIDATION_ACTOR, jobId: job.jobId ?? null });
        if (r.applied) { result.merged++; result.evidenceLinked += r.evidenceLinked; }
        else result.raced++;
      }
    }
    recordJ3('merged', result.merged);
    recordJ3('raced', result.raced);
    recordJ3('evidenceLinked', result.evidenceLinked);
    return result;
  } catch (err) {
    recordJ3('failures');
    throw err;          // the queue retries with backoff, then dead-letters
  }
}
