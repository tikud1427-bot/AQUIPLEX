/**
 * AQUIPLEX Brain — Reflection V3 / PR-1
 * Deterministic contradiction resolution policy.
 *
 * This module is deliberately PURE: it evaluates an already-detected
 * contradiction pair and returns a policy decision. It never calls an LLM,
 * mutates a claim, or writes a lifecycle transition.
 *
 * SAFETY CONTRACT
 * - unresolved disagreement is "disputed", never silently picked.
 * - explicit user correction outranks machine evidence.
 * - explicit supersession is stronger than recency.
 * - independent corroboration can support a claim, but never by itself erase
 *   a genuine counter-evidence conflict.
 * - recency is only a tie-breaker when the semantics establish that the claims
 *   are competing snapshots of the same fact.
 *
 * The five ordered rules are intentionally encoded as code, not prose:
 *   1. explicit user correction
 *   2. explicit supersession
 *   3. semantic compatibility / temporal non-overlap
 *   4. independent corroboration
 *   5. recency, only for otherwise compatible competing snapshots
 *
 * If no rule safely resolves the pair, the result is DISPUTED.
 */

const ACTION = Object.freeze({
  SUPERSEDE_OLDER: 'supersede_older',
  SUPERSEDE_BY_CORRECTION: 'supersede_by_correction',
  NOT_CONTRADICTORY: 'not_contradictory',
  DISPUTED: 'disputed',
});

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function isUserCorrection(claim) {
  return claim?.actor === 'user' ||
    claim?.sourceKind === 'user_correction' ||
    claim?.modality === 'user_correction';
}

function explicitSupersession(a, b) {
  const successorOfA = a?.supersedes === b?.claimId || a?.supersededClaimId === b?.claimId;
  const successorOfB = b?.supersedes === a?.claimId || b?.supersededClaimId === a?.claimId;
  return { successorOfA, successorOfB };
}

function temporalNonOverlap(a, b) {
  const aFrom = a?.validFrom ?? null;
  const aTo = a?.validTo ?? null;
  const bFrom = b?.validFrom ?? null;
  const bTo = b?.validTo ?? null;
  if (aFrom == null || bFrom == null) return false;
  const endA = aTo == null ? Infinity : aTo;
  const endB = bTo == null ? Infinity : bTo;
  return endA < bFrom || endB < aFrom;
}

function evidenceCount(claim) {
  return asArray(claim?.evidence).filter(e => e && e.role !== 'contradicting').length;
}

function createdAt(claim) {
  const n = Number(claim?.createdAt ?? claim?.assertedAt ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @returns {{
 *   action: string,
 *   winner: object|null,
 *   loser: object|null,
 *   reason: string,
 *   rule: number|null,
 *   confidenceCeiling: number|null
 * }}
 */
export function resolveContradiction(a, b, opts = {}) {
  const left = a ?? {};
  const right = b ?? {};

  if (!left.claimId || !right.claimId || left.claimId === right.claimId) {
    return {
      action: ACTION.DISPUTED,
      winner: null,
      loser: null,
      reason: 'invalid contradiction pair',
      rule: null,
      confidenceCeiling: null,
    };
  }

  // Rule 1 — direct user correction.
  const leftCorrection = isUserCorrection(left);
  const rightCorrection = isUserCorrection(right);
  if (leftCorrection !== rightCorrection) {
    const winner = leftCorrection ? left : right;
    const loser = leftCorrection ? right : left;
    return {
      action: ACTION.SUPERSEDE_BY_CORRECTION,
      winner,
      loser,
      reason: 'explicit user correction is authoritative',
      rule: 1,
      confidenceCeiling: 1,
    };
  }

  // Rule 2 — an explicit supersession chain beats all inferred ordering.
  const explicit = explicitSupersession(left, right);
  if (explicit.successorOfA !== explicit.successorOfB) {
    const winner = explicit.successorOfA ? left : right;
    const loser = explicit.successorOfA ? right : left;
    return {
      action: ACTION.SUPERSEDE_OLDER,
      winner,
      loser,
      reason: 'explicit supersession relation is present',
      rule: 2,
      confidenceCeiling: null,
    };
  }

  // Rule 3 — temporal non-overlap means there is no contradiction to resolve.
  if (temporalNonOverlap(left, right)) {
    return {
      action: ACTION.NOT_CONTRADICTORY,
      winner: null,
      loser: null,
      reason: 'claims describe non-overlapping validity windows',
      rule: 3,
      confidenceCeiling: null,
    };
  }

  // Rule 4 — corroboration is informative, but cannot overrule counter-evidence.
  // A claim with independent support AND no explicit contradictory evidence can
  // remain the better-supported side; however a real pair of conflicting
  // claims is still surfaced unless the evidence asymmetry is overwhelming
  // AND the caller explicitly permits heuristic resolution.
  const leftSupport = evidenceCount(left);
  const rightSupport = evidenceCount(right);
  const corroborationMargin = Math.abs(leftSupport - rightSupport);
  const allowHeuristic = opts.allowHeuristicResolution === true;
  if (allowHeuristic && corroborationMargin >= 2) {
    const winner = leftSupport > rightSupport ? left : right;
    const loser = winner === left ? right : left;
    return {
      action: ACTION.SUPERSEDE_OLDER,
      winner,
      loser,
      reason: 'independent corroboration materially outweighs the competing side',
      rule: 4,
      confidenceCeiling: 0.85,
    };
  }

  // Rule 5 — recency is a tie-breaker only for competing snapshots of the same
  // predicate. It is deliberately conservative and never silently resolves a
  // standing disagreement unless explicitly enabled.
  const samePredicate = left.predicate && right.predicate && left.predicate === right.predicate;
  const sameSubject = left.subjectEntityId && right.subjectEntityId &&
    left.subjectEntityId === right.subjectEntityId;
  if (opts.allowRecencyResolution === true && samePredicate && sameSubject) {
    const lc = createdAt(left);
    const rc = createdAt(right);
    if (lc !== rc) {
      const winner = lc > rc ? left : right;
      const loser = winner === left ? right : left;
      return {
        action: ACTION.SUPERSEDE_OLDER,
        winner,
        loser,
        reason: 'newer competing snapshot selected by explicit recency policy',
        rule: 5,
        confidenceCeiling: 0.8,
      };
    }
  }

  return {
    action: ACTION.DISPUTED,
    winner: null,
    loser: null,
    reason: 'conflicting claims lack sufficient deterministic evidence for safe resolution',
    rule: null,
    confidenceCeiling: null,
  };
}

export { ACTION as CONTRADICTION_ACTION };
