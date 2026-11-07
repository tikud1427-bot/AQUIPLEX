/**
 * When is a dense (meaning) signal believed? — PIC Lane 6's rule, for the Mind
 * (C9, 2026-11-07).
 *
 * The same constants and the same decision as PIC Lane 6 (pic/retrievalIntelligence.js),
 * so the Mind's question-aware selection (mind/itemMeaning.js) trusts meaning under
 * exactly the rule that was measured — not a second, unmeasured threshold. Lane 6
 * itself is left untouched (its source pins its calibration and is tested as such);
 * mind/tests/cognitiveRelevanceMeaning.test.js reads Lane 6's constants from its
 * source and fails if the two ever drift. The calibration record (the sweep tables,
 * the N=20 finding) is in Lane 6's comments.
 *
 *   DENSE_LANE_FLOOR    a match must reach this cosine to be proposed (0.55)
 *   DENSE_LANE_MAX      at most this many proposals per question (12)
 *   DENSE_MARGIN_FLOOR  the best match must stand this far above the corpus
 *                       median for the signal to be trusted at all (0.15)
 *   DENSE_MIN_CORPUS    below this many scored statements nothing is trusted (60)
 *
 * Pure: no I/O, no provider. A caller with no scores gets `trusted: null`.
 */
export const DENSE_LANE_FLOOR = 0.55;
export const DENSE_LANE_MAX = 12;
export const DENSE_MARGIN_FLOOR = 0.15;
export const DENSE_MIN_CORPUS = 60;

/**
 * @param {Map<string, number>|null|undefined} scores  id → cosine for every scored statement
 * @returns {{ trusted: Map<string, number>|null, margin: number|null, corpus: number, reason: string }}
 *   trusted — the same Map when the signal is believed, else null
 *   margin  — top − median, or null when the corpus is too small to estimate it
 */
export function denseAdmission(scores) {
  const raw = scores instanceof Map ? scores : null;
  if (!raw || !raw.size) return { trusted: null, margin: null, corpus: 0, reason: 'no scores' };
  if (raw.size < DENSE_MIN_CORPUS) return { trusted: null, margin: null, corpus: raw.size, reason: `corpus ${raw.size} < ${DENSE_MIN_CORPUS}` };
  const sorted = [...raw.values()].sort((a, b) => b - a);
  const margin = sorted[0] - sorted[Math.floor(sorted.length / 2)];
  return margin >= DENSE_MARGIN_FLOOR
    ? { trusted: raw, margin, corpus: raw.size, reason: 'trusted' }
    : { trusted: null, margin, corpus: raw.size, reason: `margin ${margin.toFixed(3)} < ${DENSE_MARGIN_FLOOR}` };
}
