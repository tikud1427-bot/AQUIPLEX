/**
 * AQUA Cognitive Intelligence Engine — Question Model (CIE Phase 1)
 *
 * META-REASONING, first half: before AQUA reasons, evaluate the QUESTION.
 * Answers the spec's opening cognitive questions deterministically:
 *
 *   Do I understand the question?        → understanding score
 *   How ambiguous is it?                 → ambiguity score + named signals
 *   What evidence / retrieval is needed? → needs.{evidence,freshness,…}
 *   Should I ask a clarification?        → clarification.{recommended,reason}
 *   What reasoning style fits?           → styleHints (consumed by
 *                                          strategySelector.js)
 *
 * DOES NOT duplicate classifier.js — the classifier decides WHAT KIND of
 * task this is (taskType + confidence); this module decides HOW WELL-POSED
 * the question is and WHAT COGNITION it demands. Both feed the reasoning
 * planner; neither replaces the other.
 *
 * Pure and deterministic: no LLM calls, no I/O, same input → same output.
 */

// ── Ambiguity signals ────────────────────────────────────────────────────────

// Deictic openers with nothing to point at ("fix it", "what about that?").
const DEICTIC_RE       = /^\s*(it|this|that|these|those|the one|them)\b/i;
// Bare references to artifacts we may not have ("the file", "the bug").
const BARE_OBJECT_RE   = /\bthe (file|bug|error|issue|code|function|doc(ument)?|report|pdf|spreadsheet|script)\b/i;
// Vague imperative verbs with no concrete object.
const VAGUE_ASK_RE     = /\b(fix|improve|update|change|handle|sort out|deal with|make)\s+(it|this|that|things?|stuff|everything)\b/i;
// Catch-all filler nouns.
const FILLER_NOUN_RE   = /\b(stuff|things?|whatever|something like that)\b/gi;
// Multiple unrelated asks chained in one message.
const MULTI_ASK_RE     = /\b(and also|plus can you|oh and|another thing)\b/i;

// ── Cognitive-need cues ──────────────────────────────────────────────────────

const EVIDENCE_RE   = /\b(according to|cite|citation|source|quote|where does it say|based on the (doc|file|report|pdf|data)|in the (doc|file|report|pdf|spec)|attached|uploaded)\b/i;
const FRESHNESS_RE  = /\b(latest|newest|today|right now|currently|as of|breaking|this (week|month|year)|recent(ly)?)\b/i;
const TEMPORAL_RE   = /\b(timeline|chronolog|sequence of events|when did|what happened (first|before|after)|before or after|order of events|history of)\b/i;
const CROSS_FILE_RE = /\b(across (the )?(files|documents|repo)|between (these|the) (files|docs|documents)|all (the )?(files|documents)|which file|every file|compare the (files|docs|documents)|repo[- ]wide)\b/i;
const MEMORY_RE     = /\b(remember|last time|we (discussed|talked about)|earlier you|as i (said|mentioned)|again\b|my (name|project|preference|setup))\b/i;

// ── Style-hint cues (only styles that language can reveal live here; the
//    rest come from taskType in strategySelector.js) ─────────────────────────

const HINT_CUES = [
  { id: 'legal',          re: /\b(legal(ly)?|law(s)?\b|statute|regulation|contract(ual)?|clause|liab(le|ility)|complian(t|ce)|gdpr|copyright|license terms|jurisdiction)\b/i },
  { id: 'scientific',     re: /\b(hypothes[ie]s|experiment(al)?|peer[- ]review|p[- ]value|control group|mechanism of|study (shows|found)|empirical|replicat(e|ion))\b/i },
  { id: 'mathematical',   re: /\b(prove|proof|theorem|integral|derivative|equation|probability (of|that)|expected value|calculate|solve for)\b/i },
  { id: 'temporal',       re: TEMPORAL_RE },
  { id: 'cross_file',     re: CROSS_FILE_RE },
  { id: 'evidence_first', re: EVIDENCE_RE },
  { id: 'comparative',    re: /\b(vs\.?|versus|compare|comparison|difference between|trade[- ]?offs?|pros and cons|which is better)\b/i },
];

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * Assess a question before any reasoning happens.
 *
 * @param {string} userMessage
 * @param {object} ctx
 * @param {string}  ctx.taskType      classifyTask(...).task
 * @param {number}  ctx.confidence    classifyTask(...).confidence
 * @param {boolean} [ctx.hasWorkspace]   a workspace is attached (anchors "the code")
 * @param {boolean} [ctx.hasOwner]       a memory owner exists (anchors "my …")
 * @returns {{
 *   words: number, sentences: number, questions: number,
 *   understanding: number,
 *   ambiguity: { score: number, signals: string[] },
 *   needs: { evidence: boolean, freshness: boolean, temporal: boolean,
 *            crossFile: boolean, memoryLikely: boolean, retrievalLikely: boolean },
 *   styleHints: string[],
 *   clarification: { recommended: boolean, reason: string|null }
 * }}
 */
export function assessQuestion(userMessage, { taskType, confidence = 1.0, hasWorkspace = false, hasOwner = false } = {}) {
  const text  = String(userMessage ?? '').trim();
  const words = text ? text.split(/\s+/).length : 0;
  const sentences = text ? text.split(/[.!?]+\s+/).filter(Boolean).length : 0;
  const questions = (text.match(/\?/g) ?? []).length;

  // ── Ambiguity ──────────────────────────────────────────────────────────────
  const signals = [];
  if (DEICTIC_RE.test(text) && words < 12)              signals.push('deictic_opener');
  if (BARE_OBJECT_RE.test(text) && !hasWorkspace)       signals.push('unanchored_reference');
  if (VAGUE_ASK_RE.test(text))                          signals.push('vague_ask');
  if ((text.match(FILLER_NOUN_RE) ?? []).length >= 2)   signals.push('filler_nouns');
  if (MULTI_ASK_RE.test(text) || questions >= 3)        signals.push('multi_ask');
  if (words > 0 && words < 3)                           signals.push('too_short');

  // Weighted: the first three are strong under-specification; the rest mild.
  const strong = signals.filter(s => ['deictic_opener', 'unanchored_reference', 'vague_ask'].includes(s)).length;
  const mild   = signals.length - strong;
  const ambiguityScore = clamp01(strong * 0.35 + mild * 0.15);

  // ── Understanding — how well-posed the question is for us ─────────────────
  // Ambiguity is the main drag; a rock-bottom classifier confidence also
  // means WE are unsure what we're even looking at.
  const understanding = clamp01(1 - 0.55 * ambiguityScore - (confidence < 0.4 ? 0.15 : 0));

  // ── Needs ─────────────────────────────────────────────────────────────────
  const GROUNDING_TASKS = new Set(['project_query', 'research', 'file_analysis', 'debugging']);
  const needs = {
    evidence:     EVIDENCE_RE.test(text) || GROUNDING_TASKS.has(taskType),
    freshness:    FRESHNESS_RE.test(text),
    temporal:     TEMPORAL_RE.test(text),
    crossFile:    CROSS_FILE_RE.test(text),
    memoryLikely: MEMORY_RE.test(text) && hasOwner,
  };
  needs.retrievalLikely = needs.evidence || needs.crossFile || needs.memoryLikely || needs.temporal;

  // ── Style hints, in cue order (priority order for the selector) ───────────
  const styleHints = HINT_CUES.filter(c => c.re.test(text)).map(c => c.id);

  // ── Clarification — "Should I ask a clarification question?" ──────────────
  // Recommended only when the question is genuinely under-specified AND the
  // classifier is also unsure AND there isn't enough text to self-resolve.
  // Deliberately conservative: a wrongly-recommended clarification wastes a
  // turn, so all three conditions must hold.
  let clarification = { recommended: false, reason: null };
  if (ambiguityScore >= 0.6 && confidence < 0.7 && words < 15) {
    clarification = {
      recommended: true,
      reason: `ambiguity=${ambiguityScore.toFixed(2)} (${signals.join(',')}) with classifier confidence ${confidence.toFixed(2)}`,
    };
  }

  return {
    words, sentences, questions,
    understanding: +understanding.toFixed(2),
    ambiguity: { score: +ambiguityScore.toFixed(2), signals },
    needs,
    styleHints,
    clarification,
  };
}
