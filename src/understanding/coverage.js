/**
 * UUS U4 — Understanding coverage.
 *
 * WHY THIS EXISTS
 * ---------------
 * `understandingScore()` lived in `aqua-frontend/src/stores/mindStore.ts` —
 * client-side only. So the number the user sees was computed somewhere the
 * server cannot read, which makes two things impossible:
 *
 *   1. The brief asks confidence to drive intelligent follow-up questions
 *      ("Marketing 22%" → ask about marketing). The interviewer runs on the
 *      server; it could not see the number that is supposed to steer it.
 *   2. The world-model card needs the same figure. Computing it in two places
 *      guarantees the card and the dashboard disagree eventually — and a
 *      product whose promise is "I understand you" cannot show two different
 *      answers to "how well?".
 *
 * So the formula moves here and the client reads it. NOT duplicated: the TS
 * function is deleted in the same change. One score, one formula, one place.
 *
 * THE FORMULA IS PRESERVED EXACTLY
 * --------------------------------
 *   0.45 × avgConfidence + 0.25 × dimensionCoverage + 0.15 × depth + 0.15 × goals
 *
 * Deliberately unchanged, including the constants. Moving a formula and
 * improving it in one step means that if the number shifts, nobody can tell
 * whether the move or the improvement did it. A test asserts parity with the
 * client implementation on shared fixtures.
 *
 * PURE
 * ----
 * No store imports. Every input is passed in. That is what lets the interview
 * directive, the card and the dashboard all call it without three different
 * sets of stubs — and it is checked by the same transitive-reachability test
 * that guards conversationFacts.
 */

/** Dimensions that count toward coverage. Mirrors mindSchema.DIMENSION_LIST. */
export const COVERAGE_DIMENSIONS = Object.freeze([
  'identity', 'personality', 'communication', 'preferences', 'knowledge', 'behavior', 'decision',
]);

/** Human labels — what the dashboard and the card call each dimension. */
export const DIMENSION_LABELS = Object.freeze({
  identity:      'Who you are',
  personality:   'How you think',
  communication: 'How you like to talk',
  preferences:   'What you prefer',
  knowledge:     'What you know',
  behavior:      'How you work',
  decision:      'How you decide',
});

/**
 * Confidence expressed as language, with the number secondary.
 *
 * A bare "22%" beside "Marketing" on a first-run screen reads as a scorecard
 * the user is failing. The words carry the meaning; the number stays available
 * for anyone who wants it.
 */
export function confidenceLabel(value) {
  const v = Number(value) || 0;
  if (v >= 0.85) return 'confident';
  if (v >= 0.65) return 'fairly sure';
  if (v >= 0.40) return 'still learning';
  if (v > 0)     return 'just guessing';
  return 'nothing yet';
}

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
const active = (b) => b && b.status !== 'archived';

/**
 * Per-dimension confidence and evidence count.
 *
 * @param {object} beliefsByDimension  { identity: [belief…], … }
 * @returns {object} { identity: { avg, count, label }, … } for EVERY dimension
 */
export function dimensionCoverage(beliefsByDimension = {}) {
  // `= {}` only covers undefined. A null reaching here is a 500 on the screen
  // whose entire job is to make someone feel understood — caught by the
  // malformed-input test, not by reading the code.
  const byDim = beliefsByDimension ?? {};
  const out = {};
  for (const dim of COVERAGE_DIMENSIONS) {
    const list = (byDim[dim] ?? []).filter(active);
    const avg = list.length
      ? list.reduce((s, b) => s + (Number(b.confidence) || 0), 0) / list.length
      : 0;
    out[dim] = {
      avg: +avg.toFixed(3),
      count: list.length,
      label: DIMENSION_LABELS[dim] ?? dim,
      confidence: confidenceLabel(avg),
    };
  }
  return out;
}

/**
 * The overall understanding score, 0-100.
 *
 * @param {object} args
 * @param {object} args.beliefsByDimension
 * @param {Array}  args.goals
 * @returns {number} 0-100, integer
 */
export function understandingScore({ beliefsByDimension = {}, goals = [] } = {}) {
  const byDim = beliefsByDimension ?? {};
  const beliefs = COVERAGE_DIMENSIONS.flatMap(d => (byDim[d] ?? []).filter(active));
  const goalList = Array.isArray(goals) ? goals : Object.values(goals ?? {});
  if (!beliefs.length && !goalList.length) return 0;

  const avgConf = beliefs.length
    ? beliefs.reduce((s, b) => s + (Number(b.confidence) || 0), 0) / beliefs.length
    : 0;
  const coverage = COVERAGE_DIMENSIONS
    .filter(d => (byDim[d] ?? []).some(active)).length / COVERAGE_DIMENSIONS.length;
  const goalSignal = Math.min(1,
    goalList.filter(g => g?.status === 'active' || g?.status === 'blocked').length / 3);
  const depth = Math.min(1, beliefs.reduce((s, b) => s + (Number(b.evidenceCount) || 0), 0) / 60);

  return Math.round(100 * (0.45 * clamp01(avgConf) + 0.25 * coverage + 0.15 * depth + 0.15 * goalSignal));
}

/**
 * What AQUA does NOT know yet, ordered by what is most worth asking about.
 *
 * Phrased as invitations rather than deficits — "unknown areas" on a trust
 * screen should read as an offer to learn, not as a list of the user's
 * omissions. The caller supplies gaps from `memoryReasoner.findGaps`; this
 * function only ranks and phrases them, so it stays pure.
 *
 * @returns {Array<{ id, dimension, prompt, weight }>} highest weight first
 */
export function unknownAreas({ beliefsByDimension = {}, goals = [], gaps = {} } = {}) {
  const cov = dimensionCoverage(beliefsByDimension);
  const out = [];

  // A dimension with nothing in it at all is the biggest gap there is.
  for (const dim of COVERAGE_DIMENSIONS) {
    if (cov[dim].count === 0) {
      out.push({ id: `dim:${dim}`, dimension: dim, prompt: DIMENSION_LABELS[dim], weight: 1 });
    } else if (cov[dim].avg < 0.4) {
      out.push({ id: `dim:${dim}`, dimension: dim, prompt: DIMENSION_LABELS[dim], weight: 0.5 });
    }
  }

  // Core identity fields the memory reasoner reports as missing.
  for (const field of gaps.identityMissing ?? []) {
    out.push({ id: `identity:${field}`, dimension: 'identity', prompt: String(field), weight: 0.9 });
  }

  // No goal at all is a bigger gap than any single dimension: the brief's whole
  // premise is understanding what someone is trying to accomplish.
  const goalList = Array.isArray(goals) ? goals : Object.values(goals ?? {});
  if (!goalList.some(g => g?.status === 'active')) {
    out.push({ id: 'goals:none', dimension: 'goals', prompt: 'what you are working toward', weight: 1.2 });
  }

  return out.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}

/**
 * The full coverage read-model: score, per-dimension confidence, unknowns.
 * One call, so the card, the dashboard and the interviewer cannot drift.
 */
export function buildCoverage({ beliefsByDimension = {}, goals = [], gaps = {} } = {}) {
  const dimensions = dimensionCoverage(beliefsByDimension);
  const score = understandingScore({ beliefsByDimension, goals });
  return {
    score,
    confidence: confidenceLabel(score / 100),
    dimensions,
    unknowns: unknownAreas({ beliefsByDimension, goals, gaps }),
  };
}
