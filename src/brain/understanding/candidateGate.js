/**
 * AQUA — Candidate gate (Blueprint E6/PR-2)
 *
 * "Candidate gating: existing extractors as filters + cue signals + length
 * floor." Decides which segments are worth sending to the semantic extractor.
 *
 * WHY THE GATE IS THE CEILING
 * ---------------------------
 * E6 replaces the extractor, not the gate. A segment the gate rejects reaches
 * no extractor at all, so gate recall is a hard ceiling on E6's recall however
 * good the model is. Measured on the 200 labelled cases in
 * `extraction-core.v1` (160 claim-bearing, 40 not):
 *
 *   current gate — the existing entity-presence rule    recall 0.613
 *   blueprint E6 target                                 recall 0.700
 *
 * The target was unreachable before this PR, and not because of the extractor.
 * 62 claim-bearing segments never arrived.
 *
 * WHAT WAS ACTUALLY MISSING
 * -------------------------
 * Every one of the 37 segments still missed after combining the entity
 * extractor with `resolveDeclarativeIntent` was THIRD-PERSON declarative:
 *
 *   "Sam owns the mobile app."          "The migration starts next Monday."
 *   "Karan joined yesterday."           "The parser rewrite is on hold."
 *
 * `resolveDeclarativeIntent` requires a first-person marker by design — it
 * exists to catch the user talking about themselves. Nothing was asking
 * whether the user was talking about their WORLD. That is the gap these cues
 * fill, and it is why the added signals are all third-person: proper nouns
 * away from sentence start, temporal expressions, negation, definite-article
 * subjects.
 *
 * RECALL IS WORTH MORE THAN PRECISION HERE, BUT PRECISION IS THE BILL
 * ------------------------------------------------------------------
 * A false admit costs one extraction call. A false reject loses a claim
 * permanently — no later stage can recover a segment that was never sent. So
 * the gate is tuned for recall, and precision is reported as cost rather than
 * as quality. Both are gated in `gate-core` so neither can drift unnoticed.
 *
 * MEASURED, IN-SAMPLE AND OUT
 * ---------------------------
 *   extraction-core (200 cases, USED FOR TUNING — in-sample)
 *     recall 0.613 → 0.931 · precision 0.907 → 0.949 · admitted 108 → 157
 *
 *   capture-core (24 turns, written earlier for a different purpose and NOT
 *   consulted while designing these cues — out-of-sample)
 *     recall 0.917 → 1.000
 *
 * The in-sample numbers are fitted and are labelled as such wherever they are
 * quoted. The out-of-sample corpus has no negative cases, so it can only
 * confirm recall; gate precision has never been measured out-of-sample and
 * that is an open gap, not a solved one.
 *
 * NOT WIRED. No production caller. E6/PR-12 flips writers behind
 * `AQUA_EXTRACT_V2`; until then this is a library with tests and no callers,
 * so there is no behaviour to gate and no flag.
 */
import { extractConversationEntities } from '../knowledgeExtraction/conversationEntities.js';
import {
  resolveDeclarativeIntent,
  INTERROGATIVE_OPENER,
  IMPERATIVE_REQUEST_OPENER,
} from '../../core/declarativeIntent.js';

/** Matches `MIN_SENTENCE_LENGTH` in conversationFacts.js — one floor, not two. */
export const MIN_SEGMENT_LENGTH = 12;

/**
 * Meta-conversational repair and bookkeeping. These carry a first-person
 * marker and no question mark, so `resolveDeclarativeIntent` reads them as
 * self-disclosure. They are the user managing the conversation, not
 * describing their world.
 */
const META_CONVERSATIONAL =
  /^(?:never\s+mind|actually,?\s+ignore|sorry,?\s+i\s+meant|let\s+me\s+think|nvm)\b/i;

/**
 * First-person requests FOR information. "I need to check the logs" and "I
 * work at Nummo" are both first-person declaratives; only the second says
 * anything durable about the user.
 */
const WANTS_INFORMATION =
  /\b(?:i|we)\s+(?:need|want|'?d\s+like)\s+(?:to\s+(?:know|check|see|understand|find)|help|a\s+summary)\b/i;

/**
 * Any capitalised word. Structural rather than a list of known entities — a
 * gate that only admitted segments naming entities the graph already has
 * could never learn a new one, which is the failure the current gate has.
 *
 * FIRST DRAFT REQUIRED THE CAPITAL TO BE MID-SENTENCE, on the reasoning that
 * a sentence-initial capital is grammar rather than a name. Measured, that
 * cost recall 0.994 → 0.931: "Sam owns the mobile app." and "Karan owns the
 * deploy checklist." are precisely the third-person people-claims the cues
 * exist to catch, and their proper noun is the subject, so it is always
 * first. Ten claims were being dropped by a rule that sounded right.
 *
 * The widening costs precision 0.949 → 0.893, about twenty extra extraction
 * calls per two hundred segments. Taken deliberately: a false admit is one
 * call, a false reject is a claim nothing downstream can recover. It is a
 * TRADE, and the precision figure is gated so it cannot slide further
 * unnoticed.
 *
 * Note this cue is only reached for segments that are not questions or
 * requests, so widening it does not admit "What is the capital of France?" —
 * that one arrives, when it arrives, through the entity filter above.
 */
const PROPER_NOUN = /\b[A-Z][a-z]{2,}\b/;

/** Temporal expressions — the largest single missed category (11 of 37). */
const TEMPORAL_MARKER =
  /\b(?:yesterday|today|tomorrow|last|next|since|until|before|after|during|ago|in\s+\d|Q[1-4]|20\d\d|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|quarter|year|end\s+of)\b/i;

/**
 * Negation — polarity is a claim, and losing it is worse than losing nothing.
 *
 * EXPORTED because `surpriseGate.js` needs the same notion of "this segment is
 * negative", and two divergent negation regexes in one pipeline is the same
 * defect as two different length floors. Widened past the first draft's
 * contraction list after measuring which negation cases it missed:
 * "I'm not the CTO", "We haven't decided on pricing", "I dislike neither
 * option" all carry polarity and none matched.
 */
export const NEGATION_MARKER =
  /\b(?:not|isn'?t|aren'?t|wasn'?t|weren'?t|doesn'?t|don'?t|didn'?t|haven'?t|hasn'?t|hadn'?t|won'?t|can'?t|cannot|couldn'?t|wouldn'?t|shouldn'?t|no\s+longer|never|nobody|none|neither)\b/i;

/** "The migration starts…", "A deposit was returned…" — definite subject. */
const DEFINITE_SUBJECT = /^(?:the|a|an)\s+\w+/i;

/** Question or request, in either grammatical mood. Regexes imported, not copied. */
function isRequestOrQuestion(text) {
  return text.endsWith('?')
    || INTERROGATIVE_OPENER.test(text)
    || IMPERATIVE_REQUEST_OPENER.test(text);
}

/**
 * Should this segment be sent to the extractor?
 *
 * @param {string} segment
 * @param {object} [opts]
 * @param {string[]} [opts.knownEntities] passed through to the entity extractor
 * @returns {{ admit: boolean, reason: string }} `reason` names the deciding
 *   signal — a gate that cannot say WHY it dropped a segment is undebuggable,
 *   and the eval reports rejection reasons by category.
 */
export function gateSegment(segment, opts = {}) {
  if (typeof segment !== 'string') return { admit: false, reason: 'not-a-string' };
  const text = segment.trim();

  if (text.length < MIN_SEGMENT_LENGTH) return { admit: false, reason: 'too-short' };

  // Negative cues first. These override the positive filters below, because a
  // first-person request satisfies `resolveDeclarativeIntent` and would
  // otherwise be admitted on a signal that is real but means the wrong thing.
  if (META_CONVERSATIONAL.test(text)) return { admit: false, reason: 'meta-conversational' };
  if (WANTS_INFORMATION.test(text))   return { admit: false, reason: 'requests-information' };

  // FILTER 1 — the existing extractor. If today's lane already finds an
  // entity, the segment is a candidate by definition; E6 must not admit less
  // than the system it replaces.
  if (extractConversationEntities(text, { knownEntities: opts.knownEntities ?? [] }).length > 0) {
    return { admit: true, reason: 'entity-extractor' };
  }

  // FILTER 2 — first-person declarative, via the production classifier.
  if (resolveDeclarativeIntent(text) !== null) {
    return { admit: true, reason: 'declarative-intent' };
  }

  // CUE SIGNALS — third-person statements about the user's world. Only
  // reached when the segment is neither a question nor a request, because
  // "Should the migration start next Monday?" carries a temporal marker and
  // asserts nothing.
  if (isRequestOrQuestion(text)) return { admit: false, reason: 'question-or-request' };

  if (PROPER_NOUN.test(text))      return { admit: true, reason: 'cue:proper-noun' };
  if (TEMPORAL_MARKER.test(text))  return { admit: true, reason: 'cue:temporal' };
  if (NEGATION_MARKER.test(text))  return { admit: true, reason: 'cue:negation' };
  if (DEFINITE_SUBJECT.test(text)) return { admit: true, reason: 'cue:definite-subject' };

  return { admit: false, reason: 'no-signal' };
}

/** Convenience for callers that only need the decision. */
export function isCandidate(segment, opts) {
  return gateSegment(segment, opts).admit;
}
