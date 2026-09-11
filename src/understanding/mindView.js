/**
 * UUS — the one adapter between the Mind's storage shape and the coverage
 * model's input shape.
 *
 * `coverage.js` and `interview.js` are pure by design: they take
 * `{ beliefsByDimension, goals }` and import nothing. That is what lets the
 * card, the dashboard and the interviewer all use the same math without three
 * different sets of store stubs.
 *
 * Something still has to fetch. This is that something, and it is the ONLY
 * place that does it — otherwise the read endpoint and the interviewer would
 * each grow their own slightly different version of "get the beliefs", and the
 * conversation would start steering by a picture that disagrees with the one
 * the user is shown.
 *
 * Every function fails open. A missing Mind is the normal state for a brand new
 * account, not an error: it is precisely the case the interview exists to fix,
 * so it must return empty rather than throw.
 */
import { peekMind } from '../mind/mindStore.js';
import { getBeliefs } from '../mind/beliefEngine.js';
import { COVERAGE_DIMENSIONS } from './coverage.js';

/** Beliefs grouped by dimension, in the shape coverage.js expects. */
export function beliefsForCoverage(ownerId) {
  const out = {};
  for (const dim of COVERAGE_DIMENSIONS) out[dim] = [];
  if (!ownerId) return out;
  try {
    const mind = peekMind(ownerId);
    if (!mind) return out;
    for (const dim of COVERAGE_DIMENSIONS) out[dim] = getBeliefs(mind, { dimension: dim }) ?? [];
  } catch { /* fail open — an empty picture, never a thrown turn */ }
  return out;
}

/** Goals as an array. `mind.goals` is keyed by id; coverage accepts either. */
export function goalsForCoverage(ownerId) {
  if (!ownerId) return [];
  try {
    return Object.values(peekMind(ownerId)?.goals ?? {});
  } catch { return []; }
}

/** Turn count, for readyToSummarise. Zero when there is no Mind yet. */
export function turnCountFor(ownerId) {
  if (!ownerId) return 0;
  try { return peekMind(ownerId)?.turnCount ?? 0; } catch { return 0; }
}
