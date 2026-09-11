/**
 * AQUA Brain — Digital Twin Pattern Inferrer (Brain V1 / B6)
 *
 * Turns one conversation turn into SIGNALS for the six patterns the Mind does
 * not yet infer. It emits signals — it never writes beliefs. Every signal
 * goes through beliefEngine.observeSignal, the Mind's single writer, so
 * confidence math, evidence windows, contradiction handling, value versioning
 * and decay all apply exactly as they do to the existing seven dimensions.
 *
 * "NEVER FABRICATED" — HOW THAT IS ENFORCED HERE
 * ----------------------------------------------
 *   1. Every signal requires a CONCRETE TEXTUAL TRIGGER. There is no default
 *      case, no "probably an engineer" prior, no inference from absence. If
 *      the turn contains no matching phrase, the pattern emits nothing.
 *   2. Every signal carries `note` — the literal thing that triggered it —
 *      which becomes the belief's evidence entry. An inference that cannot be
 *      traced to a specific observation does not get made.
 *   3. Signal strengths are LOW (0.3–0.6). A pattern needs repeated
 *      independent observations to clear the inference bar; one phrase can
 *      never establish a claim about who someone is.
 *   4. Competing evidence emits competing signals. Saying "ship it fast" once
 *      and "let's get this right" twice lets the Mind's contradiction handling
 *      settle it, rather than this module picking a winner.
 *
 * Pure: (text, meta) → signals[]. No I/O, no state, no model call.
 */
import { TWIN_PATTERNS } from './twinSchema.js';

/**
 * Pattern rules. Each is [regex, value, strength, label].
 * Strengths stay low by design — see (3) above.
 */

const WRITING_STYLE = [
  [/```|\bcode\s*(?:block|snippet|sample)\b|^\s*(?:const|function|def|class|import)\s/mi, 'code_first', 0.45, 'wrote code inline'],
  [/^\s*[-*•]\s+.*\n\s*[-*•]\s+/m,                                   'bullets',    0.4,  'used bullet lists'],
  [/^\s*\d+[.)]\s+.*\n\s*\d+[.)]\s+/m,                               'numbered',   0.4,  'used numbered lists'],
  [/\b(?:furthermore|moreover|therefore|consequently|nevertheless)\b/i, 'formal',   0.35, 'formal connectives'],
  [/\b(?:yeah|yep|nah|gonna|wanna|lol|btw|tbh)\b/i,                  'casual',     0.35, 'casual register'],
];

const CODING_STYLE = [
  // Plural and gerund forms matter: "tests first", "writing the tests first"
  // and "test-first" are the same posture stated three ways, and a rule that
  // only caught the singular infinitive silently under-counted the pattern.
  [/\b(?:tdd|red[- ]green|(?:writ\w+|add\w*|do\w*)?\s*(?:the\s+)?tests?[- ]first)\b/i, 'tests_first',   0.55, 'described test-first workflow'],
  [/\b(?:add tests? (?:after|later)|tests? afterwards|backfill tests?)\b/i,    'tests_after',   0.5,  'described tests-after workflow'],
  [/\b(?:pure function|immutab|side[- ]effect free|functional (?:style|approach))\b/i, 'functional', 0.45, 'functional-style language'],
  [/\b(?:class hierarch|inherit|polymorph|encapsulat)\w*\b/i,                  'object_oriented', 0.4, 'OO vocabulary'],
  [/\b(?:comment|document|jsdoc|docstring)\w*\b.*\b(?:everything|thoroughly|well|properly)\b/i, 'documents_heavily', 0.45, 'asked for thorough documentation'],
  [/\b(?:self[- ]documenting|code should explain itself|too many comments)\b/i, 'minimal_comments', 0.45, 'prefers self-documenting code'],
];

const LEARNING_PREFERENCE = [
  [/\b(?:show me an example|give me an example|example first|by example|sample code)\b/i, 'examples_first',  0.5,  'asked for examples'],
  [/\b(?:link (?:me )?the docs?|documentation|reference|spec)\b/i,                        'docs_first',      0.4,  'asked for documentation'],
  [/\b(?:from first principles|why does (?:this|it) work|explain the (?:theory|underlying)|how does .* actually work)\b/i, 'first_principles', 0.5, 'asked for underlying mechanism'],
  [/\b(?:just (?:tell|give) me|skip the explanation|don'?t explain|tl;?dr)\b/i,           'answer_first',    0.45, 'asked to skip explanation'],
];

const PRODUCT_PHILOSOPHY = [
  [/\b(?:ship (?:it|fast|now)|move fast|mvp|good enough|iterate later)\b/i,        'ship_fast',      0.5,  'favoured shipping speed'],
  [/\b(?:polish|get (?:it|this) right|craft|refine|not (?:ready|good enough) yet)\b/i, 'polish_first', 0.45, 'favoured polish'],
  [/\b(?:users? (?:want|need|asked|said)|user feedback|customer (?:said|wants))\b/i, 'user_driven',  0.45, 'cited user demand'],
  [/\b(?:the vision|long[- ]term|where (?:we|this) (?:are|is) (?:going|headed)|north star)\b/i, 'vision_driven', 0.4, 'cited long-term vision'],
];

const ENGINEERING_PHILOSOPHY = [
  [/\b(?:keep it simple|simplest|simplicity|less code|avoid (?:complexity|abstraction))\b/i, 'simplicity',  0.5,  'favoured simplicity'],
  [/\b(?:correct(?:ness)?|edge case|invariant|provably|type[- ]safe)\b/i,                     'correctness', 0.45, 'emphasised correctness'],
  [/\b(?:performance|latency|throughput|optimi[sz]|fast(?:er)? path|benchmark)\b/i,           'performance', 0.45, 'emphasised performance'],
  [/\b(?:pragmatic|good enough for now|trade[- ]?off|ship the boring)\b/i,                    'pragmatism',  0.4,  'framed a trade-off'],
  [/\b(?:maintainab|readab|future me|six months from now|legib)\w*\b/i,                       'maintainability', 0.45, 'emphasised maintainability'],
];

/**
 * Working hours from the turn's clock time. This is the one pattern inferred
 * from METADATA rather than words — and it is still evidence-bound: the
 * observation is "a turn occurred at 02:14 local", which is a fact, and the
 * note records it.
 *
 * Buckets rather than exact hours: a twin that claims "works 09:00–17:30" from
 * a handful of turns is overfitting. Buckets accumulate honestly.
 */
function workingHoursSignal(at, conversationId) {
  const hour = new Date(at).getHours();
  const bucket =
    hour >= 5 && hour < 12  ? 'morning'   :
    hour >= 12 && hour < 17 ? 'afternoon' :
    hour >= 17 && hour < 22 ? 'evening'   : 'night';
  return {
    dimension: TWIN_PATTERNS.working_hours.dimension,
    key: 'working_hours',
    value: bucket,
    strength: 0.3,               // one turn is very weak evidence of a routine
    note: `turn at ${String(hour).padStart(2, '0')}:00 local`,
    conversationId,
    source: 'inference',
  };
}

/** Apply one rule table, emitting a signal per DISTINCT matched value. */
function applyRules(rules, text, patternKey, conversationId) {
  const out = [];
  const seen = new Set();
  for (const [pattern, value, strength, label] of rules) {
    if (seen.has(value)) continue;
    if (!pattern.test(text)) continue;
    seen.add(value);
    out.push({
      dimension: TWIN_PATTERNS[patternKey].dimension,
      key: patternKey,
      value,
      strength,
      note: label,
      conversationId,
      source: 'inference',
    });
  }
  return out;
}

/**
 * Minimum lengths before a pattern is observable at all.
 *
 * WRITING STYLE needs actual writing. "yep" genuinely matches the casual
 * register rule, but a one-word acknowledgment is a protocol token, not
 * prose — counting it would bias every terse acknowledger toward `casual`
 * on evidence that is really about turn-taking. Content-bearing patterns
 * (coding style, philosophies) are exempt: "ship it fast" is a real position
 * however briefly stated.
 *
 * WORKING HOURS needs real engagement for the same reason — otherwise every
 * "ok" and "thanks" votes on the user's routine.
 */
const MIN_CHARS = Object.freeze({
  writing_style: 40,
  working_hours: 40,
});

/**
 * Infer twin-pattern signals from one turn.
 *
 * Reads the USER's message for style/philosophy patterns — the assistant's
 * own words are AQUA's, not the user's, and inferring the user's writing
 * style from AQUA's output would be a closed loop that manufactures evidence.
 *
 * @param {object} args - { userMessage, at?, conversationId? }
 * @returns {Array} signals for beliefEngine.observeSignal
 */
export function inferTwinSignals({ userMessage = '', at = Date.now(), conversationId = null } = {}) {
  const text = String(userMessage ?? '');
  const trimmedLength = text.trim().length;
  if (!trimmedLength) return [];

  const signals = [
    ...(trimmedLength >= MIN_CHARS.writing_style
      ? applyRules(WRITING_STYLE, text, 'writing_style', conversationId) : []),
    ...applyRules(CODING_STYLE,           text, 'coding_style',           conversationId),
    ...applyRules(LEARNING_PREFERENCE,    text, 'learning_preference',    conversationId),
    ...applyRules(PRODUCT_PHILOSOPHY,     text, 'product_philosophy',     conversationId),
    ...applyRules(ENGINEERING_PHILOSOPHY, text, 'engineering_philosophy', conversationId),
  ];

  if (trimmedLength >= MIN_CHARS.working_hours) signals.push(workingHoursSignal(at, conversationId));

  return signals;
}

export { WRITING_STYLE, CODING_STYLE, LEARNING_PREFERENCE, PRODUCT_PHILOSOPHY, ENGINEERING_PHILOSOPHY };
