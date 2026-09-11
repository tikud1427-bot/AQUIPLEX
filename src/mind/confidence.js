/**
 * AQUA Mind — Confidence Engine (Layer 11)
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure math. No storage, no I/O. Every belief update flows through here so
 * confidence semantics are identical everywhere and independently testable.
 *
 * Model:
 *   support:        c' = c + rate * strength * (1 - c)      — asymptotic to 1
 *   contradiction:  c' = c * (1 - CONTRA_FACTOR * strength) — multiplicative drop,
 *                   never below CONTRA_FLOOR; history is preserved by caller.
 *   decay:          c' = c - decayRate * staleWeeks, floored by importance tier.
 *
 * Contradiction NEVER deletes: it lowers confidence and increments the
 * contradiction counter. Only repeated contradiction + decay archives a belief
 * (reflectionEngine decides), and archive ≠ delete.
 */

export const CONTRA_FACTOR = 0.45;
export const CONTRA_FLOOR  = 0.05;
export const PROMOTE_AT    = 0.80;  // + evidenceCount gate → "established"
export const PROMOTE_MIN_EVIDENCE = 3;
export const ARCHIVE_BELOW = 0.15;  // decayed under this → archive candidate

/** Support evidence. strength 0..1 (how strong this single observation is). */
export function reinforce(confidence, changeRate, strength = 1) {
  const c = clamp01(confidence);
  const s = clamp01(strength);
  return clamp01(c + changeRate * s * (1 - c));
}

/** Contradicting evidence. Lowers, never zeroes. */
export function contradict(confidence, strength = 1) {
  const c = clamp01(confidence);
  const s = clamp01(strength);
  return Math.max(CONTRA_FLOOR, c * (1 - CONTRA_FACTOR * s));
}

/**
 * Time decay applied at reflection. staleMs since lastEvidenceAt.
 * decayRate is per-week (see DIMENSION_DYNAMICS). Established beliefs
 * (promoted) get a floor so long-term knowledge doesn't evaporate.
 */
export function decay(confidence, decayRate, staleMs, { established = false } = {}) {
  if (decayRate <= 0) return clamp01(confidence);
  const weeks = Math.max(0, staleMs) / (7 * 24 * 3600 * 1000);
  const floor = established ? 0.4 : 0;
  return Math.max(floor, clamp01(confidence - decayRate * weeks));
}

export function isEstablished(belief) {
  return (belief.confidence >= PROMOTE_AT) && (belief.evidenceCount >= PROMOTE_MIN_EVIDENCE);
}

export function isArchiveCandidate(belief) {
  return belief.confidence < ARCHIVE_BELOW;
}

/**
 * Blend an explicit user statement/correction with an inferred belief.
 * Explicit input dominates but still isn't binary certainty.
 */
export function fromExplicit(prior = 0) {
  return Math.max(clamp01(prior), 0.9);
}

export function clamp01(x) {
  if (Number.isNaN(x) || !Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
