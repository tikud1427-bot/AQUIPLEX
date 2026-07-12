/**
 * AQUA Internal Intelligence Engine — Confidence Engine (Phase 12)
 *
 * Per-RESPONSE confidence, distinct from the two confidences that already
 * exist in the system:
 *   - classifier.js confidence   → "how sure am I about what KIND of task
 *                                   this is" (pre-generation)
 *   - mind/confidence.js         → belief-level confidence inside long-term
 *                                   memory (per-fact, decays over time)
 *
 * This module answers the third question the spec (Phase 12) asks for and
 * nothing in the codebase answered before: "how much should THIS answer be
 * trusted" — aggregated from signals every request already produces, so it
 * adds zero LLM calls and zero I/O.
 *
 * Signals → factors (all normalized to [0,1]):
 *   classification  classifier confidence, as-is
 *   grounding       did retrieval actually land anything (memory facts,
 *                   project files) — ungrounded answers on grounding-hungry
 *                   tasks score lower
 *   generation      provider health for this turn: first-try success vs
 *                   fallback depth, truncation, abnormal finishReason
 *   verification    the strongest signal when present: a converged PASS is
 *                   direct evidence; a non-converged loop or a failed-open
 *                   verifier is direct counter-evidence
 *
 * "Low confidence should automatically trigger deeper reasoning" (spec):
 * the PRE-generation half of that trigger lives in
 * orchestrator/verificationStrategy.js (low classifier confidence now
 * warrants verification); the POST-generation half lives in chat.js, which
 * grants the verification loop a second pass for high-complexity or
 * low-classifier-confidence turns. This module is the measurement, those
 * are the actuators — kept separate so the score can never recursively
 * trigger work that changes the score it was computed from.
 *
 * Deterministic: pure function, no LLM calls, no I/O.
 */

/** Band cut points — single source of truth, reused by tests. */
export const CONFIDENCE_BANDS = { high: 0.75, medium: 0.5 };

const WEIGHTS = {
  classification: 0.25,
  grounding:      0.15,
  generation:     0.30,
  verification:   0.30,
};

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * Generation health from the provider result of this turn.
 * First provider, clean stop → 1.0. Every extra fallback attempt costs
 * 0.25 (floor 0.25). Truncation or a non-'stop' finish each cost 0.3.
 */
function generationFactor({ attemptCount = 1, truncated = false, finishReason = 'stop' }) {
  let score = 1 - Math.max(0, attemptCount - 1) * 0.25;
  score = Math.max(0.25, score);
  if (truncated) score -= 0.3;
  if (finishReason !== 'stop') score -= 0.3;
  return clamp01(score);
}

/**
 * Grounding: whether retrieval landed anything at all. Deliberately coarse —
 * a turn with zero memory facts AND zero project files answered from bare
 * model priors, which is exactly the hallucination-risk case the spec's
 * "Knowledge freshness / Evidence" inputs point at. Casual chat is excluded
 * from the penalty via `groundingExpected` (the caller knows the taskType).
 */
function groundingFactor({ factsInjected = 0, projectFilesUsed = 0, groundingExpected = false }) {
  const grounded = factsInjected > 0 || projectFilesUsed > 0;
  if (grounded) return 1.0;
  return groundingExpected ? 0.35 : 0.7; // ungrounded: mild default, sharp when grounding was expected
}

/**
 * Verification is the only factor with direct evidence about the ANSWER, so
 * it carries the widest value range. `passed` always refers to the FINAL
 * draft (the loop in verificationAgent.js sets it from the last critique):
 *   PASS, never revised                 1.0   checked, clean first time
 *   revised, then PASS on the revision  0.8   found+fixed, re-checked clean
 *   revised, fix never re-checked       0.55  fix applied at iteration cap —
 *                                             better than nothing, unproven
 *   failed open (verifier errored)      0.3   wanted a check, couldn't get one
 *   skipped (not warranted)             0.6   neutral — no evidence either way
 */
function verificationFactor(v) {
  if (!v) return 0.6;
  if (!v.ran) return v.error ? 0.3 : 0.6;
  if (v.passed) return v.revised ? 0.8 : 1.0;
  if (v.revised) return 0.55;
  return 0.6;
}

/**
 * Aggregate this turn's signals into one response-level confidence.
 *
 * Every input is optional — missing signals fall back to neutral values so
 * the engine degrades gracefully instead of throwing mid-response. All
 * callers already have every field on hand in chat.js's step 8b/8c.
 *
 * @param {object} signals
 * @param {number}  [signals.classifierConfidence] - classifyTask(...).confidence
 * @param {number}  [signals.factsInjected]        - relevantFacts.length
 * @param {number}  [signals.projectFilesUsed]     - projectFiles.length
 * @param {boolean} [signals.groundingExpected]    - task benefits from retrieval (e.g. project_query, research)
 * @param {number}  [signals.attemptCount]         - provider fallbackChain length
 * @param {boolean} [signals.truncated]
 * @param {string}  [signals.finishReason]
 * @param {object}  [signals.verification]         - runVerification() result (or the chat.js default stub)
 * @returns {{
 *   score: number,                                  // 0..1, 2-decimal
 *   band: 'high'|'medium'|'low',
 *   factors: Array<{ id: string, value: number, weight: number }>
 * }}
 */
export function assessConfidence({
  classifierConfidence = 0.6,
  factsInjected = 0,
  projectFilesUsed = 0,
  groundingExpected = false,
  attemptCount = 1,
  truncated = false,
  finishReason = 'stop',
  verification = null,
} = {}) {
  const factors = [
    { id: 'classification', value: clamp01(classifierConfidence),                                weight: WEIGHTS.classification },
    { id: 'grounding',      value: groundingFactor({ factsInjected, projectFilesUsed, groundingExpected }), weight: WEIGHTS.grounding },
    { id: 'generation',     value: generationFactor({ attemptCount, truncated, finishReason }),  weight: WEIGHTS.generation },
    { id: 'verification',   value: verificationFactor(verification),                             weight: WEIGHTS.verification },
  ];

  const score = clamp01(factors.reduce((sum, f) => sum + f.value * f.weight, 0));
  const band  = score >= CONFIDENCE_BANDS.high ? 'high'
              : score >= CONFIDENCE_BANDS.medium ? 'medium'
              : 'low';

  return {
    score: +score.toFixed(2),
    band,
    factors: factors.map(f => ({ ...f, value: +f.value.toFixed(2) })),
  };
}

/** Task types whose answers are expected to be grounded in retrieval. */
const GROUNDING_EXPECTED_TASKS = new Set(['project_query', 'research', 'file_analysis', 'debugging']);

/**
 * @param {string} taskType
 * @returns {boolean}
 */
export function isGroundingExpected(taskType) {
  return GROUNDING_EXPECTED_TASKS.has(taskType);
}
