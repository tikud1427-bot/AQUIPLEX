/**
 * Declarative first-person intent — the classifier's fallback seam.
 *
 * WHY THIS EXISTS
 * ---------------
 * `classifyTask` has two fallbacks, and ordinary human speech lands in both:
 *
 *   1. `msg.length < 55` with no substantive score → `conversation` @ 0.85
 *   2. no pattern matched at all                   → `simple_qa`/`research` @ 0.45
 *
 * Measured on twenty realistic first-session messages, 10 of 20 hit fallback 2.
 * The consequences are not cosmetic:
 *
 *   • 0.45 < LOW_CONFIDENCE_THRESHOLD (0.5), so verification AND the debate
 *     panel run on those turns — up to five extra LLM calls, and the streamed
 *     answer is visibly REPLACED after the user has already read it.
 *   • `simple_qa` maps to the Simple Question profile, which enables 3 of 19
 *     capabilities. Reasoning, planning, project retrieval and deep research
 *     are skipped on every one of these turns.
 *   • `searchDecision.js` hard-blocks `memory_recall` / `memory_update` /
 *     `personal_info` because those are about the user, not the web. None of
 *     those labels is ever produced for plain speech, so the block is
 *     unreachable, and a `temporal` regex hit is enough to fire a real web
 *     search on "I currently work from home".
 *
 * WHAT THIS MODULE DOES — AND DELIBERATELY DOES NOT
 * -------------------------------------------------
 * It is consulted ONLY when a message was already heading for one of the two
 * fallbacks. Any message that scores against an existing pattern keeps its
 * exact current classification: this cannot regress a turn that works today,
 * which is the whole reason it lives at the seam instead of inside the
 * pattern table. Rebalancing the scoring table is a genuinely different change
 * with a much wider blast radius, and it is not this one.
 *
 * It is also deliberately FIRST-PERSON ONLY. "Razorpay is our main competitor"
 * is caught (it carries `our`); "Dev handles engineering" is not, because a
 * bare third-person sentence with no marker tying it to the speaker is
 * indistinguishable from a general-knowledge question about a stranger. That
 * gap is stated rather than papered over — widening it means guessing.
 *
 * PURE
 * ----
 * Zero imports. Every input is an argument. Pinned by a structural test, for
 * the same reason `conversationFacts` is: this is called on every turn, and a
 * store import here would put persistence inside the classifier.
 */

/** Confidence for a resolved declarative/recall turn.
 *
 *  0.62 is chosen, not tuned. It has to clear LOW_CONFIDENCE_THRESHOLD (0.5)
 *  — that IS the fix, since below it every turn pays for verification + debate
 *  — while staying well under the 0.85 the scored patterns earn. A statement
 *  we recognised structurally is a weaker signal than one that matched a
 *  purpose-built pattern, and the number should say so. */
export const DECLARATIVE_CONFIDENCE = 0.62;

/** Openers that make a message a QUESTION even without a question mark. */
export const INTERROGATIVE_OPENER =
  /^(?:so\s+|and\s+|but\s+|ok(?:ay)?[,\s]+|hey[,\s]+)*(?:what|when|where|which|who|whom|whose|why|how|is|are|was|were|do|does|did|can|could|should|would|will|shall|may|might|have|has|had|am)\b/i;

/**
 * Forensic pass (Bug 2) — imperative information-requests disqualify the
 * "statement" reading, same role as INTERROGATIVE_OPENER for a different
 * grammatical mood. "give me the latest on the Israel-Gaza ceasefire" has no
 * "?" and does not start with a WH-word or auxiliary, so it reached the
 * catch-all below and was classified `personal_info` — which
 * searchDecision.js hard-blocks — silently killing a live-news query with an
 * explicit "latest" freshness signal. It is a REQUEST, not self-disclosure:
 * grammatically imperative, built on a request verb + "me", asking AQUA for
 * something rather than telling AQUA something.
 *
 * A false disqualify here only returns the message to its existing 0.45
 * fallback (simple_qa/research) — never worse than the classification the
 * message already had, so this can only widen coverage, not regress it.
 */
export const IMPERATIVE_REQUEST_OPENER =
  /^(?:so\s+|and\s+|but\s+|ok(?:ay)?[,\s]+|hey[,\s]+|please\s+)*(?:give|tell|show|update|fill)\s+me\b|^(?:let\s+me\s+know|walk\s+me\s+through|fill\s+me\s+in)\b/i;

/** First-person markers. Singular and plural both count as "about the speaker's
 *  world" — the exclusion of `we` in `selfDeclaration.js` is about attributing
 *  a claim to the INDIVIDUAL, which is a stricter question than this one. Here
 *  we are only deciding whether the turn is about the user's world at all. */
const FIRST_PERSON =
  /(?:^|[^\p{L}])(?:i|i'?m|i'?ve|i'?ll|i'?d|me|my|mine|myself|we|we'?re|we'?ve|we'?ll|we'?d|us|our|ours)(?:[^\p{L}]|$)/iu;

/**
 * Asking AQUA about something it was told.
 *
 * Ordered before the declarative test because several of these are phrased as
 * statements ("remind me what I said about pricing") and would otherwise be
 * read as the user telling us something new.
 */
const RECALL_CUES = [
  /\bremind\s+me\b/i,
  /\bwhat\s+did\s+i\s+(?:say|tell|mention|call|name|decide|pick|choose)\b/i,
  /\bwhat\s+did\s+we\s+(?:say|decide|agree|discuss|pick|choose|settle|land)\b/i,
  /\bwhat\s+(?:have|did)\s+(?:i|we)\s+(?:told|tell)\s+you\b/i,
  /\bdo\s+you\s+(?:remember|recall|know)\s+(?:my|our|what|who|when|where|why|how|that\s+i)\b/i,
  /\bwhat\s+do\s+you\s+know\s+about\s+(?:me|us|my|our)\b/i,
  /\bwho\s+(?:is|are|was|were)\s+(?:on|in)\s+(?:my|our)\b/i,
  /\bwho\s+(?:is|are|was|were)\s+(?:my|our)\b/i,
  /\bwhere\s+do\s+(?:i|we)\s+(?:work|live|stand)\b/i,
  /\bwhat(?:'s|\s+is|\s+was|\s+are|\s+were)\s+(?:my|our)\b/i,
  /\bwhen\s+did\s+(?:i|we)\b/i,
  /\bhow\s+many\s+(?:of\s+)?(?:my|our)\b/i,
  /\b(?:my|our)\s+\w+\s+again\b/i,
  /\bagain\?$/i,
];

/**
 * Correcting or retracting something previously stated.
 *
 * Separated from plain declaration because the downstream handling differs:
 * `memory_update` is the label the memory lane's correction path keys on, and
 * mislabelling a correction as a fresh statement is how two contradictory
 * facts end up coexisting instead of one superseding the other.
 */
const UPDATE_CUES = [
  /^\s*actually\b/i,
  /\bno\s+longer\b/i,
  /\bnot\s+anymore\b/i,
  /\bi\s+(?:used\s+to|no\s+longer)\b/i,
  /\bscratch\s+that\b/i,
  /\bi\s+(?:mis(?:spoke|typed)|meant)\b/i,
  /\b(?:correction|ignore\s+that)\b/i,
  /\b(?:i|we)\s+(?:moved|switched|changed|left|quit|joined|relocated)\b/i,
];

/**
 * Resolve a message that is heading for a classifier fallback.
 *
 * @param {string} msg  trimmed user message
 * @returns {{task:string, confidence:number, labels:string[], via:string}|null}
 *          null when nothing here applies — the caller keeps its existing
 *          fallback, unchanged.
 */
export function resolveDeclarativeIntent(msg) {
  if (!msg || typeof msg !== 'string') return null;
  const text = msg.trim();
  if (text.length < 4) return null;

  const firstPerson = FIRST_PERSON.test(text);

  // ── Recall — checked first, see RECALL_CUES ──────────────────────────────
  // Requires a first-person marker too. Without it, "when did the war end"
  // matches `when did (i|we)`… no it does not, but "how many of our users"
  // and "how many of the users" differ by one word, and the version that is
  // about the user is the one with the marker. Cheap guard, no cost.
  if (firstPerson && RECALL_CUES.some(re => re.test(text))) {
    return {
      task: 'memory_recall',
      confidence: DECLARATIVE_CONFIDENCE,
      labels: ['memory_recall'],
      via: 'declarative:recall',
    };
  }

  if (!firstPerson) return null;

  // A question about the world that merely mentions the speaker ("should I use
  // Postgres or Mongo?") is not a self-disclosure. Question mark OR an
  // interrogative opener disqualifies — both, because chat drops the mark
  // constantly and "how do I deploy this" is still a question.
  const isQuestion = text.endsWith('?') || INTERROGATIVE_OPENER.test(text) || IMPERATIVE_REQUEST_OPENER.test(text);
  if (isQuestion) return null;

  if (UPDATE_CUES.some(re => re.test(text))) {
    return {
      task: 'memory_update',
      confidence: DECLARATIVE_CONFIDENCE,
      labels: ['memory_update'],
      via: 'declarative:update',
    };
  }

  // What is left: a first-person, non-interrogative statement. That is the
  // user telling us about their world, which is the single most valuable
  // input this product receives and the one it currently classifies as an
  // unanswerable trivia question.
  return {
    task: 'personal_info',
    confidence: DECLARATIVE_CONFIDENCE,
    labels: ['personal_info'],
    via: 'declarative:statement',
  };
}
