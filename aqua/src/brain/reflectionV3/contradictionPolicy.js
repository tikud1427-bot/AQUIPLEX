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

/**
 * An explicit successor relation. Either a stored link (`supersedes`), or the
 * user's own words: a claim they stated AS a change or correction ("I moved
 * to Porto", "not Go — Rust", "the launch is now May 2"; `revises`, E6 rule
 * 11) succeeds the OLDER claim it conflicts with. Only the newer side can be
 * the successor, so an old revision never undoes a newer statement. An
 * unmarked polarity flip ("I use Redis" … "I don't use Redis") is NOT
 * explicit and still falls through to DISPUTED.
 */
function explicitSupersession(a, b) {
  const revisesOlder = (x, y) => x?.revises === true && createdAt(x) > createdAt(y);
  const successorOfA = a?.supersedes === b?.claimId || a?.supersededClaimId === b?.claimId || revisesOlder(a, b);
  const successorOfB = b?.supersedes === a?.claimId || b?.supersededClaimId === a?.claimId || revisesOlder(b, a);
  return { successorOfA, successorOfB };
}

const ms = v => (v == null ? null : (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v)));

function temporalNonOverlap(a, b) {
  const aFrom = ms(a?.validFrom), aTo = ms(a?.validTo);
  const bFrom = ms(b?.validFrom), bTo = ms(b?.validTo);
  // HISTORY vs PRESENT (2026-10-06, World-Model Lift p9): "I lived in Kyoto
  // until 2023" (validity closed 2023-12-31) RETIRED the current "based in
  // Osaka" — both lacked validFrom, so this rule abstained and rule 5 let the
  // newer statement win by recency. A claim whose validity ENDED before the
  // other was even asserted, while the other is still open, describes the past:
  // the two do not compete.
  const closedBefore = (closed, open) => {
    const end = ms(closed?.validTo);
    const openNow = open?.validTo == null;
    const since = ms(open?.validFrom) ?? ms(open?.assertedAt ?? open?.createdAt);
    return end != null && openNow && since != null && Number.isFinite(end) && end < since;
  };
  if (closedBefore(a, b) || closedBefore(b, a)) return true;
  if (aFrom == null || bFrom == null || !Number.isFinite(aFrom) || !Number.isFinite(bFrom)) return false;
  const endA = aTo == null ? Infinity : aTo;
  const endB = bTo == null ? Infinity : bTo;
  return endA < bFrom || endB < aFrom;
}

function evidenceCount(claim) {
  return asArray(claim?.evidence).filter(e => e && e.role !== 'contradicting').length;
}

function createdAt(claim) {
  const raw = claim?.createdAt ?? claim?.assertedAt ?? 0;
  // A Date from Postgres must keep its milliseconds: Date.parse(date) goes
  // through toString() and drops them, so two turns in the same second tied
  // and rule 5 left a real change DISPUTED (live Postgres, 2026-10-04).
  const n = raw instanceof Date ? raw.getTime() : typeof raw === 'number' ? raw : Date.parse(raw);
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
  // `snapshotPair`: the CALLER has established from declared semantics (the
  // predicate registry's cardinality) that these are competing snapshots of
  // one single-valued fact — same predicate, same subject (one-per-subject) or
  // same object (one-per-object), both asserted facts, different values. That
  // is exactly the condition this rule's header requires; without it recency
  // still never resolves anything.
  const declaredSnapshots = opts.snapshotPair === true && samePredicate;
  if ((opts.allowRecencyResolution === true && samePredicate && sameSubject) || declaredSnapshots) {
    // TEMPORAL SUCCESSION (2026-10-11, Pass 2): "from next month my manager
    // will be Mark" starts AFTER "my manager is Claire" was said — it is the
    // successor whatever the order of assertion (both can be said in one
    // breath). Only a START LATER than the other claim's assertion and its
    // own start counts; a past-dated statement ("moved to Berlin in 2024")
    // falls through to recency. The worker applies a future successor only
    // once its valid_from has come (scheduled supersession).
    const startsAfter = (x, y) => {
      const s = ms(x?.validFrom);
      if (s == null || !Number.isFinite(s)) return false;
      const yStart = ms(y?.validFrom);
      return s > createdAt(y) && (yStart == null || s > yStart);
    };
    const lLater = startsAfter(left, right), rLater = startsAfter(right, left);
    if (lLater !== rLater) {
      const winner = lLater ? left : right;
      const loser = winner === left ? right : left;
      return {
        action: ACTION.SUPERSEDE_OLDER, winner, loser,
        reason: 'a later-starting snapshot succeeds the earlier one (temporal succession)',
        rule: 5, confidenceCeiling: 0.8,
      };
    }
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
