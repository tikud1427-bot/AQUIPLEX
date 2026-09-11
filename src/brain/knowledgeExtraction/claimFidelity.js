/**
 * AQUA — Claim Fidelity
 * Blueprint L3 (the model reads; code decides) · E2/PR-3 · E5 (claim schema)
 *
 * WHAT THIS IS FOR
 * ----------------
 * The conversation lane stores a verbatim sentence and a list of entities.
 * Nothing else. Measured on `extraction-core.v1` (200 cases, 167 labelled
 * claims):
 *
 *     fidelity_accuracy   0.0%     polarity · modality · time
 *     negation detection  45.0%    ...and EVERY ONE CAPTURED IS STORED POSITIVELY
 *
 * That second line is the serious one, and it is not a scoring artefact. It
 * means the store contains:
 *
 *     user said:  "I don't use Kubernetes."
 *     store has:  "I don't use Kubernetes."   ← as an ASSERTED fact
 *
 * A reader asking "does the user use Kubernetes?" finds a fact whose statement
 * is about Kubernetes, marked asserted, and hands it to the model. The text
 * still carries the "don't", so a careful reader may survive it — but nothing
 * in the DATA says the claim is negative, so every consumer has to re-derive
 * it from prose, and any consumer that summarises, counts, or reasons over
 * polarity gets it backwards. The retrieval gate already re-derives it on
 * every read, which is duplicated work built on a field that should exist.
 *
 * Losing negation is called out as a thing that must never happen silently.
 * Same for modality and temporal qualifiers, and for "unknown must remain
 * unknown". This module is the write-side half of that: read what the sentence
 * actually commits to, and store it as structure rather than leaving it in
 * prose for someone else to infer.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * NO PREDICATE. `predicate_accuracy` is also 0%, and it stays 0% here. A
 * predicate is a relation drawn from a controlled vocabulary — `works_at`,
 * `role_is`, `prefers` — and choosing between them is a semantic judgement
 * that belongs to E5's schema and E6's model-backed pipeline. Surface rules
 * that guessed predicate names would score against the labels in this dataset
 * and teach the system nothing transferable. The honest report is a real
 * fidelity number next to an unchanged zero.
 *
 * Fidelity is a different kind of thing, and that is why it is reachable here:
 * polarity, modality and time are grammatical properties of the sentence, not
 * domain relations. "I don't", "I want to", "if we", "she said", "last month"
 * are marked in the surface form. Reading them is parsing, not inference.
 *
 * HONESTY UNDER UNCERTAINTY
 * -------------------------
 * Every function here returns a value it can defend from the text, or the
 * neutral default. `asserted` and `fact` are not guesses dressed as findings —
 * they are what an unmarked declarative sentence means. Where a sentence is
 * genuinely ambiguous the module does NOT invent a reading; it leaves the
 * default and records nothing further, because an unknown that stays unknown
 * is recoverable and a confident wrong label is not.
 *
 * Pure. No I/O, no state.
 */

/**
 * Negation cues.
 *
 * Shared vocabulary with `pic/questionShape.js`, which reads polarity off the
 * QUESTION. Same linguistic fact, opposite side of the pipeline. They are
 * deliberately not imported from one another: the read side asks "what is the
 * asker looking for" and the write side asks "what did the speaker commit to",
 * and collapsing them would couple retrieval policy to storage semantics.
 * The overlap is real and small; the coupling would not be.
 */
const NEGATION = /\b(not|n't|never|no longer|nobody|none|cannot|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|shouldn't|wouldn't|can't|stopped|rejected|declined|refused|against|instead of|turned down|ruled out|passed on|gave up|dropped|no more|without)\b/i;

/** Intent: something the speaker means to bring about but has not yet. */
const INTENT = /\b(want(?:s)? to|would like to|plan(?:s|ning)? to|going to|gonna|intend(?:s)? to|aim(?:s|ing)? to|hope(?:s|ing)? to|trying to|will\b|we'?ll|i'?ll|need(?:s)? to|should\b|must\b|let'?s\b|next step|todo|to-do)/i;

/**
 * Hypothetical: entertained rather than claimed.
 *
 * The conditional is the load-bearing case. "If we move to Postgres we'd need
 * a migration" is NOT a claim that we are moving to Postgres, and storing it
 * as one manufactures a decision the user never made.
 */
const HYPOTHETICAL = /\b(if\b|whether|suppose|supposing|imagine|hypothetically|in case|were to|would be|would need|could be|might be|may be|maybe|perhaps|possibly|potentially|assuming)/i;

/** Reported speech: someone else's claim, not the speaker's. */
const QUOTE = /\b(said|says|told|mentioned|according to|claims?|reported|wrote|per\b|quoted)\b/i;

/** Interrogative: the speaker is asking, not asserting. */
const QUESTION_SHAPE = /^\s*(what|when|where|which|who|whom|whose|why|how|is|are|was|were|do|does|did|can|could|should|would|will|have|has|had|am|any)\b/i;

/**
 * Temporal expressions.
 *
 * Presence is what matters, not resolution to a calendar date. A claim that
 * carries a time qualifier and stores none has lost the qualifier — which is
 * the failure this guards. Resolving "last month" to an instant needs the
 * turn's timestamp and belongs with the claim schema, not here.
 */
const TIME_EXPR = /\b(19|20)\d{2}\b|\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(q[1-4])\b|\b(today|tomorrow|yesterday|tonight|now|currently)\b|\b(last|next|this|past|coming)\s+(week|month|year|quarter|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(\d+\s+)?(days?|weeks?|months?|years?|quarters?)\s+(ago|from now|later)\b|\b(since|until|till|by|before|after|during)\s+\S+|\b(used to|no longer|anymore|previously|formerly|originally|already|yet|soon|recently|lately)\b/i;

/** Past-tense / no-longer-true markers, for `validTo`-shaped knowledge. */
const PAST_MARKER = /\b(used to|no longer|anymore|any more|previously|formerly|former|back then|originally|left|quit|resigned|ended|finished|stopped)\b/i;

/**
 * Read what a sentence actually commits to.
 *
 * @param {string} sentence
 * @returns {{
 *   polarity: 'asserted'|'negated',
 *   modality: 'fact'|'intent'|'hypothetical'|'question'|'quote',
 *   time: string|null,
 *   tense: 'past'|'present',
 * }}
 */
export function readFidelity(sentence) {
  const text = String(sentence ?? '').trim();
  const out = { polarity: 'asserted', modality: 'fact', time: null, tense: 'present' };
  if (!text) return out;

  // ── Polarity ───────────────────────────────────────────────────────────────
  if (NEGATION.test(text)) out.polarity = 'negated';

  // ── Modality, most-specific first ──────────────────────────────────────────
  //
  // Order is the whole design. These overlap constantly in real sentences and
  // the wrong precedence produces confidently wrong labels:
  //
  //   "Did she say we'll use Stripe?"  question > quote > intent
  //   "She said we'll use Stripe."     quote > intent  — it is HER intent,
  //                                    reported; storing it as the speaker's
  //                                    own plan attributes a commitment to the
  //                                    wrong person
  //   "If we win we'll hire two."      hypothetical > intent — the intent is
  //                                    conditional on something that has not
  //                                    happened
  //
  // A question is checked first because an interrogative frame overrides
  // everything inside it: nothing in a question is being claimed at all.
  if (text.endsWith('?') || QUESTION_SHAPE.test(text)) out.modality = 'question';
  else if (QUOTE.test(text)) out.modality = 'quote';
  else if (HYPOTHETICAL.test(text)) out.modality = 'hypothetical';
  else if (INTENT.test(text)) out.modality = 'intent';

  // ── Time ───────────────────────────────────────────────────────────────────
  const t = text.match(TIME_EXPR);
  if (t) out.time = t[0].trim();
  if (PAST_MARKER.test(text)) out.tense = 'past';

  return out;
}

/**
 * Is this sentence a REQUEST rather than a claim about the world?
 *
 * "Explain how OAuth works to me." currently produces a stored fact, because
 * OAuth reads as an entity and the lane has no notion of a request. Six of the
 * ten false positives on `extraction-core.v1` are this exact shape, and the
 * same failure was already fixed once at the self-declaration gate — this is
 * the general path catching up with a decision that was already made.
 *
 * A request tells you what the user wants DONE. It is not evidence about their
 * world, and storing it as such fills the world model with imperatives that
 * will later be retrieved as if they were facts.
 *
 * Kept narrow on purpose: an imperative verb in FIRST position, or an explicit
 * please/can-you frame. "Ship the parser by Friday" is a request; "We ship the
 * parser on Friday" is a claim, and only the leading verb distinguishes them.
 */
const REQUEST_VERB = /^\s*(please\s+)?(explain|describe|tell|show|give|list|write|draft|make|create|generate|build|find|search|look|check|fix|help|summari[sz]e|translate|convert|compare|analyse|analyze|review|remind|send|open|run|add|remove|delete|update|set|change)\b/i;
const REQUEST_FRAME = /^\s*(can|could|would|will)\s+you\b|^\s*please\b|\bfor me\b\s*[.?!]?\s*$/i;

/**
 * A wh-question: the speaker is asking for a value they do not have.
 *
 * POLAR AND WH QUESTIONS ARE NOT THE SAME KIND OF THING, and treating them
 * alike was a mistake worth writing down. Both were gated as "a question
 * asserts nothing", which is true of the ASSERTION and false of the CONTENT:
 *
 *   "Do I still report to Priya?"     polar — puts a specific proposition
 *                                     (SELF reports_to Priya) up for
 *                                     confirmation. The proposition is right
 *                                     there, and the fact that the user is
 *                                     asking about it is itself worth knowing.
 *
 *   "Why did the deploy fail?"        wh — the thing being asked for is
 *                                     exactly the part that is missing. There
 *                                     is no candidate claim to capture, only a
 *                                     presupposition, and storing a
 *                                     presupposition as a fact is how a guess
 *                                     becomes knowledge the user never gave.
 *
 * So a polar question keeps its claim under `modality: 'question'` — captured,
 * and explicitly NOT asserted — while a wh-question yields nothing. Gating
 * both cost 3.7 points of detection recall for no honesty gain.
 */
const WH_QUESTION = /^\s*(what|why|how|who|whom|whose|when|where|which)\b/i;

export function isInformationRequest(sentence) {
  const text = String(sentence ?? '').trim();
  if (!text) return false;
  return WH_QUESTION.test(text);
}

export function isRequest(sentence) {
  const text = String(sentence ?? '').trim();
  if (!text) return false;
  // "Can you explain X?" is a request even though it is shaped as a question.
  if (REQUEST_FRAME.test(text)) return true;
  // A leading imperative, but NOT when the sentence has a subject before it —
  // "I check the logs daily" is a habit, "Check the logs" is an instruction.
  return REQUEST_VERB.test(text);
}
