/**
 * AQUA — Surprise gate (Blueprint E6/PR-3)
 *
 * "Surprise gate: segment embedding vs owner centroid." The second half of
 * candidate gating: PR-2 asks whether a segment CARRIES a claim, this asks
 * whether the claim is one we already have. Its job is cost — not sending the
 * extractor the same thing twice.
 *
 * ⚠️ IT DOES NOTHING UNTIL A THRESHOLD IS MEASURED.
 * `DEFAULT_THRESHOLD` is 0, which admits everything. That is deliberate and it
 * is the blueprint's own rule: establish the baseline first, then define the
 * promotion gate from the measured distribution. Picking 0.15 here because it
 * sounds reasonable would be inventing a number and then measuring against it.
 * `scripts/surprise-distribution.mjs` produces the distribution; the threshold
 * is set in a later PR, from that output, with the cost it implies stated.
 *
 * THE FAILURE MODE THIS IS BUILT AROUND
 * -------------------------------------
 * A similarity gate suppresses what looks like what it already knows. The most
 * valuable thing a user ever says looks EXACTLY like what we already know:
 *
 *   stored  "Growth is my top priority this quarter."
 *   new     "Growth is no longer the priority — retention is."
 *
 * Near-identical wording, near-identical embedding, and the second one
 * invalidates the first. A naive surprise gate drops it and the world model
 * keeps answering with the stale priority forever. AQUA's committed retrieval
 * baseline already scores `superseded` at 20% — this gate, done carelessly,
 * would manufacture that failure at ingest time where nothing downstream could
 * ever recover it.
 *
 * So CHANGE CUES are exempt from suppression, unconditionally and before any
 * vector is computed. A segment that signals negation, transition, correction
 * or temporal shift is never redundant, however similar it looks. This costs
 * some extraction calls on segments that turn out to restate. That is the
 * cheaper mistake by a wide margin.
 *
 * FAIL OPEN, ALWAYS
 * -----------------
 * No key, provider down, empty centroid, degenerate vector — every one of
 * these ADMITS. A cost optimisation must never become a silent data-loss path
 * because an API was unavailable. `embed()` already returns null rather than
 * throwing; this module treats null as "admit", never as "skip".
 *
 * NOT WIRED. No production caller, no flag — E6/PR-12 flips writers behind
 * `AQUA_EXTRACT_V2` and there is no behaviour here to gate before then.
 */
import { embed, isEmbeddingEnabled } from '../../embeddings/embeddingProvider.js';
import { NEGATION_MARKER } from './candidateGate.js';
import { cosineSim } from '../../embeddings/vectorStore.js';

/**
 * Admit everything. See the header: the real value comes from the measured
 * distribution, not from a plausible-looking constant.
 */
export const DEFAULT_THRESHOLD = 0;

/**
 * Segments that must never be suppressed as redundant, whatever their
 * similarity to the centroid.
 *
 * Each group is a way of saying "what you have on file is now wrong", which is
 * precisely the class a similarity score cannot distinguish from a restatement
 * — the wording overlap that makes it look redundant is the same overlap that
 * makes it a correction of that specific fact.
 */
const CHANGE_CUES = [
  // Negation and cessation — polarity flips against something already stored.
  // Imported from candidateGate rather than restated: one definition of
  // "negative" per pipeline. The first draft had its own contraction list and
  // missed "I'm not the CTO", "We haven't decided on pricing" and "I dislike
  // neither option" — three polarity claims that would have been suppressible.
  NEGATION_MARKER,
  /\b(?:stopped|quit|ceased|cancelled|canceled)\b/i,
  // Transition — the subject moved from one state to another.
  /\b(?:left|joined|moved|switched|changed|migrated|replaced|took\s+over|handed\s+over|transferred|promoted|resigned)\b/i,
  // Explicit correction of something AQUA holds.
  /\b(?:actually|correction|i\s+meant|to\s+correct|that'?s\s+wrong|not\s+quite)\b/i,
  // Temporal contrast — "used to X, now Y" is two states and a boundary.
  /\b(?:used\s+to|previously|formerly|back\s+then|these\s+days|now\s+that|since\s+then|as\s+of)\b/i,
];

/** Does this segment announce that something known has changed? */
export function hasChangeCue(text) {
  const s = String(text ?? '');
  return CHANGE_CUES.some(re => re.test(s));
}

/**
 * Mean vector of a set of embeddings — the owner's centroid.
 *
 * Nulls are skipped rather than treated as zero vectors: a failed embedding
 * would otherwise drag the centroid toward the origin and make every
 * subsequent segment look surprising, which is a fail-open direction but for
 * the wrong reason and impossible to debug.
 *
 * @param {Array<number[]|null>} vectors
 * @returns {number[]|null} null when there is nothing to average
 */
export function centroidOf(vectors) {
  const usable = (vectors ?? []).filter(v => Array.isArray(v) && v.length > 0);
  if (!usable.length) return null;

  const dim = usable[0].length;
  // A dimension mismatch means two embedding models are in play. Averaging
  // across them produces a vector that is meaningless in both spaces, so the
  // odd ones out are dropped rather than silently corrupting the centroid.
  const same = usable.filter(v => v.length === dim);
  if (!same.length) return null;

  const out = new Array(dim).fill(0);
  for (const v of same) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= same.length;
  return out;
}

/**
 * Should this segment be extracted, given what the owner already knows?
 *
 * @param {string} segment
 * @param {number[]|null} centroid       from centroidOf()
 * @param {object} [opts]
 * @param {number} [opts.threshold]      surprise below this is redundant
 * @param {number[]|null} [opts.vector]  pre-computed segment embedding
 * @returns {Promise<{admit:boolean, reason:string, surprise:number|null}>}
 */
export async function surpriseGate(segment, centroid, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

  if (typeof segment !== 'string' || !segment.trim()) {
    return { admit: false, reason: 'empty', surprise: null };
  }

  // BEFORE any vector work. A change cue is decisive on its own, and computing
  // an embedding to then ignore it would only spend money to reach the same
  // answer more slowly.
  if (hasChangeCue(segment)) {
    return { admit: true, reason: 'change-cue', surprise: null };
  }

  // A new owner has nothing to be redundant against.
  if (!Array.isArray(centroid) || !centroid.length) {
    return { admit: true, reason: 'no-centroid', surprise: null };
  }

  if (!isEmbeddingEnabled()) {
    return { admit: true, reason: 'embeddings-unavailable', surprise: null };
  }

  const vector = opts.vector ?? (await embed([segment]))[0];
  if (!Array.isArray(vector) || !vector.length) {
    // embed() returns null rather than throwing. Null means "we could not
    // tell", and "we could not tell" must never mean "drop the claim".
    return { admit: true, reason: 'no-vector', surprise: null };
  }

  const sim = cosineSim(vector, centroid);
  const surprise = 1 - sim;

  // `>=` so a threshold of 0 admits everything including an exact restatement
  // whose surprise is 0. The default must be a true no-op, not a
  // nearly-no-op that quietly drops perfect duplicates.
  return surprise >= threshold
    ? { admit: true, reason: 'surprising', surprise }
    : { admit: false, reason: 'redundant', surprise };
}
