/**
 * AQUA Brain — Digital Twin Schema (Brain V1 / B6)
 *
 * THE BRIEF'S INSTRUCTION
 * ----------------------
 * "Store inferred patterns… writing style, coding style, decision style,
 *  preferred technologies, working hours, communication style, risk
 *  tolerance, learning preferences, favorite tools, product philosophy,
 *  engineering philosophy, confidence trends. These should be inferred
 *  gradually. NEVER FABRICATED. Every inference must include: confidence,
 *  supporting evidence, last verified."
 *
 * WHAT ALREADY EXISTS (and is not rebuilt)
 * ----------------------------------------
 * The Mind is already a working digital twin: seven dimensions, per-dimension
 * change/decay dynamics, a bounded evidence window per belief, contradiction
 * handling, value versioning, an `established` promotion gate, and ONE writer
 * (beliefEngine.observeSignal) that every mutation goes through. Six of the
 * brief's patterns are already inferred there:
 *
 *   decision style          DECISION.risk_tolerance
 *   preferred technologies  PREFERENCES.primary_language / frameworks
 *   communication style     COMMUNICATION.message_style / response_length
 *   risk tolerance          DECISION.risk_tolerance
 *   favorite tools          PREFERENCES.editor / os
 *   (confidence)            every belief carries it, never assumed 1.0
 *
 * THE SIX THIS ADDS
 *   writing_style           prose vs bullets vs code-first, formality
 *   coding_style            tests-first/after, comments, paradigm
 *   working_hours           when the user actually works, from turn times
 *   learning_preference     examples-first vs docs vs first-principles
 *   product_philosophy      ship-fast vs polish-first, user- vs vision-driven
 *   engineering_philosophy  simplicity / correctness / performance / pragmatism
 *
 * …plus the two reporting requirements the brief names and the Mind does not
 * currently separate:
 *
 *   lastVerified    DISTINCT from lastEvidenceAt. lastEvidenceAt moves on ANY
 *                   signal, including one that CONTRADICTS the belief. A
 *                   belief argued against five times today has a fresh
 *                   lastEvidenceAt and a stale lastVerified — and only the
 *                   second is honest about when reality last agreed.
 *   confidenceTrend rising / falling / stable, from the evidence window.
 *
 * DERIVED, NOT STORED
 * -------------------
 * Both are computed from the belief's OWN evidence window, which already
 * records { ts, delta, support } per observation. No new store, no schema
 * change to mindSchema, nothing to keep in sync — the same principle B2 used
 * for confidence/importance. Delete nothing, gain nothing to purge.
 *
 * Pure. No I/O.
 */
import { DIMENSIONS } from '../../mind/mindSchema.js';

/**
 * The six patterns this layer contributes, mapped onto the Mind's EXISTING
 * dimensions rather than inventing new ones — so per-dimension change/decay
 * dynamics, decay at reflection, and the `established` gate all apply for
 * free. Adding dimensions would have meant touching mindSchema; mapping onto
 * them means the new patterns behave exactly like the old ones.
 */
export const TWIN_PATTERNS = Object.freeze({
  writing_style:          { dimension: DIMENSIONS.COMMUNICATION, description: 'how the user writes: prose, bullets, code-first' },
  coding_style:           { dimension: DIMENSIONS.BEHAVIOR,      description: 'testing posture, commenting, paradigm leaning' },
  working_hours:          { dimension: DIMENSIONS.BEHAVIOR,      description: 'when the user actually works' },
  learning_preference:    { dimension: DIMENSIONS.PREFERENCES,   description: 'examples-first, docs-first, or first-principles' },
  product_philosophy:     { dimension: DIMENSIONS.DECISION,      description: 'ship-fast vs polish-first; user- vs vision-driven' },
  engineering_philosophy: { dimension: DIMENSIONS.DECISION,      description: 'simplicity, correctness, performance, pragmatism' },
});

export const TWIN_PATTERN_KEYS = Object.freeze(Object.keys(TWIN_PATTERNS));

/**
 * THE ANTI-FABRICATION BAR.
 *
 * A pattern is only REPORTED as a real inference once it clears both gates.
 * Below the bar the belief still exists and still accumulates evidence — it
 * is simply not presented as something AQUA knows about the user. This is the
 * operative meaning of "never fabricated": a single offhand phrase produces a
 * weak signal, not a claim about who someone is.
 */
export const INFERENCE_BAR = Object.freeze({
  minEvidence: 3,        // at least three independent observations
  minConfidence: 0.45,   // and confidence past coin-flip
});

/** Trend classification thresholds over the evidence window. */
const TREND_EPSILON = 0.02;

/**
 * Last time evidence CONFIRMED this belief, as opposed to merely touching it.
 *
 * Confirmation = a supporting observation that actually moved confidence up
 * (delta > 0). A supporting signal that hit the confidence ceiling has
 * delta ≈ 0 and still counts, so a stable well-established belief does not
 * look unverified — hence `delta >= 0 && support`.
 *
 * @param {object} belief
 * @returns {number|null} timestamp, or null if nothing in the window confirmed it
 */
export function lastVerifiedAt(belief) {
  const window = belief?.evidence ?? [];
  for (let i = window.length - 1; i >= 0; i--) {
    const e = window[i];
    if (e.support !== false && (e.delta ?? 0) >= 0) return e.ts ?? null;
  }
  return null;
}

/**
 * How stale is the confirmation, in days? Distinct from "how long since
 * anything touched this".
 */
export function daysSinceVerified(belief, now = Date.now()) {
  const ts = lastVerifiedAt(belief);
  if (!ts) return null;
  return Math.max(0, (now - ts) / 86_400_000);
}

/**
 * Confidence trend from the evidence window's deltas.
 *
 * Sums the deltas actually recorded — this is the belief's own history, not a
 * model of it. A belief being argued against trends `falling` even while its
 * absolute confidence is still high, which is exactly the early warning the
 * brief's "confidence trends" asks for.
 *
 * @returns {{ direction:'rising'|'falling'|'stable', net:number, samples:number }}
 */
export function confidenceTrend(belief, { window = 6 } = {}) {
  const evidence = (belief?.evidence ?? []).slice(-window);
  if (evidence.length < 2) return { direction: 'stable', net: 0, samples: evidence.length };
  const net = evidence.reduce((sum, e) => sum + (e.delta ?? 0), 0);
  const direction = net > TREND_EPSILON ? 'rising' : net < -TREND_EPSILON ? 'falling' : 'stable';
  return { direction, net: Math.round(net * 1000) / 1000, samples: evidence.length };
}

/** Does this belief clear the anti-fabrication bar? */
export function meetsInferenceBar(belief) {
  if (!belief) return false;
  return (belief.evidenceCount ?? 0) >= INFERENCE_BAR.minEvidence
      && (belief.confidence ?? 0) >= INFERENCE_BAR.minConfidence;
}

/**
 * The reportable view of an inferred pattern — exactly the three things the
 * brief requires on every inference, plus the trend.
 *
 * @returns {object} { pattern, value, confidence, evidence[], evidenceCount,
 *                     lastVerified, daysSinceVerified, trend, established }
 */
export function describeInference(patternKey, belief, { now = Date.now(), evidenceSamples = 3 } = {}) {
  if (!belief) return null;
  return {
    pattern: patternKey,
    dimension: belief.dimension,
    value: belief.value,
    confidence: Math.round((belief.confidence ?? 0) * 1000) / 1000,
    // SUPPORTING EVIDENCE — the actual observations, not a count. An inference
    // you cannot trace back to what was said is a fabrication with a number
    // attached.
    evidence: (belief.evidence ?? []).slice(-evidenceSamples).map(e => ({
      at: e.ts, observed: e.signal, support: e.support !== false, delta: e.delta ?? 0,
    })),
    evidenceCount: belief.evidenceCount ?? 0,
    lastVerified: lastVerifiedAt(belief),
    daysSinceVerified: round1(daysSinceVerified(belief, now)),
    trend: confidenceTrend(belief),
    established: !!belief.established,
    contradictions: belief.contradictions ?? 0,
  };
}

function round1(n) { return n == null ? null : Math.round(n * 10) / 10; }
