/**
 * AQUA — Resolved conversation context (2026-11-16, conversation recovery).
 *
 * WHY THIS EXISTS
 *   Audit 2026-11-16 (audit/forensic-2026-11-16): of ~15 stages that shape an
 *   answer, only the drafter saw the conversation. Every retrieval lane queried
 *   with the literal message ("Is it curable?"), the Context Engine declared the
 *   topic unknown, and the reviewers judged "it" with no antecedent and
 *   rewrote correct answers into "which condition do you mean?".
 *
 * WHAT IT IS
 *   ONE pure, deterministic builder. Each stage reads the frozen result instead
 *   of re-deriving its own idea of the conversation:
 *
 *     conversation context  — bounded recent turns of THIS conversation
 *     reference resolution  — what "it / that / which one" points at, or that
 *                             it is genuinely ambiguous
 *     retrieval query       — the message plus the resolved subject, for
 *                             retrieval lanes only (never shown, never stored)
 *     personal-world flag   — is the question about the user's own world?
 *                             (a missing personal fact never means a general
 *                             question is unanswerable)
 *     focus entity ids      — the existing conversationFocus carry-over, passed
 *                             in by the caller (no second focus system)
 *
 *   It reads only the history it is given (one conversation, one owner), keeps
 *   no state, makes no I/O and no model call, and returns deep-frozen objects
 *   with copied strings, so no stage can mutate another stage's view and no
 *   user's data can reach another user's turn through it.
 *
 * WHAT IT IS NOT
 *   Not an LLM rewriter, not a summarizer, not a memory store. When a reference
 *   cannot be resolved with confidence it says so ('ambiguous' / 'unresolved')
 *   instead of guessing.
 *
 * ROLLBACK
 *   AQUA_CONVERSATION_CONTEXT=off → retrievalQuery is the raw message, no
 *   reference is resolved, personalWorld falls back to the message alone. The
 *   reviewers still receive the recent turns (that is a correctness fix with
 *   no product trade-off).
 */

export const CONVERSATION_CONTEXT_VERSION = 1;

/** Recent messages carried to reviewers / graph nodes (bounded). */
const RECENT_MESSAGES = 6;
/** Per-message character cap in the carried view (long answers are clipped, marked). */
const RECENT_MESSAGE_CHARS = 700;
/** How many earlier user turns may be searched for an antecedent. */
const ANTECEDENT_LOOKBACK = 6;
/** Max subject phrases carried into a retrieval query. */
const MAX_SUBJECTS = 3;
/** Max characters of one subject phrase (it is quoted into an operator note). */
const MAX_PHRASE_CHARS = 60;

export function conversationContextEnabled(env = process.env) {
  return String(env.AQUA_CONVERSATION_CONTEXT ?? 'on').trim().toLowerCase() !== 'off';
}

// ── Vocabulary ────────────────────────────────────────────────────────────────

/** Referring expressions that point back into the conversation. */
const SINGULAR_REF = /\b(it|its|it's|itself|this|that)\b/i;
const PLURAL_REF = /\b(they|them|their|theirs|these|those|both)\b/i;
const SELECTION_REF = /\b(which\s+one|which\s+of\s+(?:them|these|those|the\s+two)|the\s+(?:first|second|third|last|former|latter|other)(?:\s+one)?|either(?:\s+one)?|neither)\b/i;
/** A comparative over candidates ("is it better", "which is easier") — "which" selects among them. */
const WHICH_RE = /\bwhich\b/i;

/** Function words — never a subject. */
const STOP = new Set(`a an the and or but if then so of to in on at by for with from as into onto about over under than
is are was were be been being am do does did done have has had having can could will would shall should may might must
i me my mine myself we us our ours you your yours he him his she her hers it its it's itself they them their theirs this that these those
what which who whom whose when where why how whether there here not no nor yes also just only very too more most less least much many
some any all each every both either neither one ones other another such own same lot lots bit kind sort way thing things stuff
tell explain describe show give say talk let lets let's please now ok okay so well then again still really actually just also
compare comparison versus vs difference between`.split(/\s+/));

/**
 * Predicate / follow-up words: what a follow-up asks ABOUT its antecedent.
 * They never name the subject ("Is it curable?" → the subject is not "curable").
 */
const GENERIC = new Set(`curable cure cured cures treatable treat treated treatment treatments safe safer safest dangerous risky risk risks
important importance useful use used using usable good better best bad worse worst easy easier easiest hard harder hardest difficult
cheap cheaper expensive cost costs price prices pricing much fast faster slow slower big bigger small smaller scale scales scaling scalable
advantage advantages disadvantage disadvantages benefit benefits pros cons drawback drawbacks downside downsides upside
symptom symptoms cause causes caused effect effects side work works working worked happen happens happened mean means meaning
true false still further more detail details example examples info information overview summary
common rare serious contagious infectious fatal deadly normal possible likely real popular famous
new old latest current recent today history future reason reasons why purpose
first second third last former latter other next previous
right wrong correct ok fine enough need needed require required`.split(/\s+/));

const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}+#.\-']*/gu;

function tokensOf(text) {
  return (String(text ?? '').match(TOKEN_RE) ?? []).map(t => t.replace(/[.']+$/, ''));
}

const isContent = (tok) => {
  const t = tok.toLowerCase();
  return t.length >= 2 && !STOP.has(t) && !GENERIC.has(t) && !/^\d+$/.test(t);
};

/**
 * Verbs/states a FOLLOW-UP asks about ("When is it due?", "When does it
 * launch?"). Ignored only when deciding whether the CURRENT message names its
 * own subject — in an earlier turn the same word can be the subject ("Tell me
 * about the launch").
 */
const FOLLOWUP_PREDICATES = new Set(`due when launch launches launched launching start starts started begin begins end ends ended finish finishes finished
ship ships shipped release released open opens close closes closed ready available happen take takes last lasts run runs ran go goes going
come comes coming leave leaves stay stays change changes changed move moves moved cover covers apply applies affect affects help helps
compare cost costs mean`.split(/\s+/));

/** The message's own subject words (content words that are not follow-up predicates). */
export function ownSubjectTokens(message) {
  return tokensOf(message).filter(t => isContent(t) && !FOLLOWUP_PREDICATES.has(t.toLowerCase()));
}

/**
 * Subject phrases of an earlier message: maximal runs of content words, split
 * on coordination ("MongoDB and PostgreSQL" → two phrases). Words the CURRENT
 * message also uses are its predicate, not the antecedent ("Is pneumonia
 * curable?" → "pneumonia" when the follow-up is "Is it curable?").
 */
export function subjectPhrases(text, { exclude = new Set() } = {}) {
  const phrases = [];
  // Coordination and punctuation separate entities.
  // Only COORDINATION makes several entities ("MongoDB and PostgreSQL"); within
  // one clause the first content run is the subject and later runs are its
  // predicate or object ("My tax filing is coming up" → "tax filing").
  for (const segment of String(text ?? '').split(/\b(?:and|or|vs\.?|versus)\b|[,;:!?()]/i)) {
    let run = [];
    for (const tok of tokensOf(segment)) {
      const lower = tok.toLowerCase();
      if (isContent(tok) && !exclude.has(lower)) run.push(tok);
      else if (run.length) break;
    }
    if (run.length) phrases.push(run.join(' '));
  }
  // De-duplicate case-insensitively, keep first-seen order.
  const seen = new Set();
  return phrases.filter(p => { const k = p.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ── Personal-world detection ─────────────────────────────────────────────────

/**
 * Is the question about the user's OWN world (their facts, plans, people,
 * projects), as opposed to general knowledge? Possessives and first-person
 * state/plan verbs — not a bare "I" ("Can I use it?" is a general question).
 */
const PERSONAL_RE = /\b(?:my|mine|our|ours|myself|ourselves)\b|(?<!\b(?:can|could|may|might|would)\s)\b(?:i|we)\s+(?:am|was|were|have|had|did|told|said|mentioned|decided|plan(?:ned)?|want(?:ed)?|work(?:ed)?|live[ds]?|like[ds]?|prefer(?:red)?|need(?:ed)?|should|own|use[ds]?|bought|chose|picked)\b|\b(?:did|do|have|am|was|should|shall|will)\s+(?:i|we)\b|\b(?:i'm|i've|i'd|i'll|we're|we've|we'd)\b/i;

export function isPersonalWorldQuestion(message) {
  return PERSONAL_RE.test(String(message ?? '').replace(/[‘’]/g, "'"));
}

// ── Reference resolution ─────────────────────────────────────────────────────

/**
 * @param {string} message
 * @param {Array<{role:string, content:string}>} history  prior messages of THIS conversation, oldest → newest
 * @returns {{ detected: boolean, status: 'none'|'own_subject'|'resolved'|'ambiguous'|'unresolved',
 *            form: 'singular'|'plural'|'selection'|null, subjects: string[], candidates: string[],
 *            sourceTurnsBack: number|null, sourcePersonal: boolean }}
 */
export function resolveReference(message, history = []) {
  const msg = String(message ?? '');
  const selection = SELECTION_REF.test(msg);
  const plural = PLURAL_REF.test(msg);
  const singular = SINGULAR_REF.test(msg);
  const base = { detected: false, status: 'none', form: null, subjects: [], candidates: [], sourceTurnsBack: null, sourcePersonal: false };
  if (!selection && !plural && !singular) return base;
  const form = selection ? 'selection' : plural ? 'plural' : 'singular';
  const detected = { ...base, detected: true, form };

  // A message that names its own subject ("Is it raining in Paris?") is not a
  // follow-up we may rewrite; leave it alone rather than guess.
  if (ownSubjectTokens(msg).length) return { ...detected, status: 'own_subject' };

  const exclude = new Set(tokensOf(msg).map(t => t.toLowerCase()));
  const userTurns = (Array.isArray(history) ? history : [])
    .filter(m => m && m.role === 'user' && typeof m.content === 'string')
    .slice(-ANTECEDENT_LOOKBACK)
    .reverse();
  for (let i = 0; i < userTurns.length; i += 1) {
    const phrases = subjectPhrases(userTurns[i].content, { exclude });
    if (!phrases.length) continue;   // that turn was itself a follow-up — keep walking back
    const sourcePersonal = isPersonalWorldQuestion(userTurns[i].content);
    const candidates = phrases.slice(0, MAX_SUBJECTS).map(p => p.slice(0, MAX_PHRASE_CHARS));
    // One antecedent, or a plural/selection that ranges over all of them.
    if (candidates.length === 1 || form !== 'singular' || WHICH_RE.test(msg)) {
      return { ...detected, status: 'resolved', subjects: candidates, candidates, sourceTurnsBack: i + 1, sourcePersonal };
    }
    // "Is it better?" after "Compare A and B": a singular reference with two
    // live candidates and nothing selecting between them — genuinely ambiguous.
    return { ...detected, status: 'ambiguous', subjects: [], candidates, sourceTurnsBack: i + 1, sourcePersonal };
  }
  return { ...detected, status: 'unresolved' };
}

/**
 * The retrieval query for this turn: the message, plus the resolved subject
 * when (and only when) the message is a follow-up whose reference resolved.
 * Ambiguous references add every candidate (retrieval may look at both; the
 * ANSWER still asks which one). Never used for display or storage.
 */
export function retrievalQueryFor(message, conversationContext) {
  const msg = String(message ?? '');
  const ref = conversationContext?.reference;
  if (!ref || !conversationContext?.enabled) return msg;
  const terms = ref.status === 'resolved' ? ref.subjects : ref.status === 'ambiguous' ? ref.candidates : [];
  if (!terms.length) return msg;
  return `${msg} ${terms.join(' ')}`.trim();
}

// ── Builder ──────────────────────────────────────────────────────────────────

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)} […${s.length - max} more characters not shown]`;
}

/**
 * Build the turn's resolved conversation context.
 *
 * @param {object} args
 * @param {string} args.message
 * @param {string|null} [args.conversationId]
 * @param {string|null} [args.ownerId]
 * @param {Array}  [args.history]          prior messages of this conversation (the store's array; not mutated)
 * @param {string[]} [args.focusEntityIds] conversationFocus carry-over for this owner+conversation
 * @param {object} [args.env]
 */
export function buildConversationContext({ message, conversationId = null, ownerId = null, history = [], focusEntityIds = [], env = process.env } = {}) {
  const enabled = conversationContextEnabled(env);
  const prior = (Array.isArray(history) ? history : []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
  const recent = prior.slice(-RECENT_MESSAGES).map(m => ({ role: m.role, content: clip(m.content, RECENT_MESSAGE_CHARS) }));
  const reference = enabled ? resolveReference(message, prior) : { detected: false, status: 'none', form: null, subjects: [], candidates: [], sourceTurnsBack: null, sourcePersonal: false };
  const personalWorld = isPersonalWorldQuestion(message) || (reference.status === 'resolved' && reference.sourcePersonal);
  const ctx = {
    version: CONVERSATION_CONTEXT_VERSION,
    enabled,
    conversationId: conversationId == null ? null : String(conversationId),
    ownerId: ownerId == null ? null : String(ownerId),
    message: String(message ?? ''),
    historyCount: prior.length,
    recent,
    reference,
    personalWorld,
    focusEntityIds: [...new Set((focusEntityIds ?? []).map(String))].slice(0, 12),
  };
  ctx.retrievalQuery = retrievalQueryFor(ctx.message, ctx);
  return deepFreeze(ctx);
}

// ── Renderers (what each consumer is given) ──────────────────────────────────

/**
 * The recent conversation as plain text for a reviewer or a graph node.
 * Bounded; the current message is NOT included (callers state it themselves).
 */
export function renderRecentConversation(conversationContext, { maxChars = 4000 } = {}) {
  const recent = conversationContext?.recent ?? [];
  if (!recent.length) return '';
  const lines = [];
  let used = 0;
  // Newest last; drop from the oldest end when over budget.
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const line = `${recent[i].role === 'user' ? 'User' : 'Assistant'}: ${recent[i].content}`;
    if (used + line.length > maxChars && lines.length) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * One operator line telling the model what the follow-up refers to — or that
 * it is ambiguous. Empty when there is nothing to say. Built only from the
 * user's own earlier words in this conversation.
 */
export function referenceNote(conversationContext) {
  const ref = conversationContext?.reference;
  if (!conversationContext?.enabled || !ref) return '';
  if (ref.status === 'resolved') {
    const what = ref.subjects.map(s => `"${s}"`).join(' and ');
    return `Conversation reference: in the user's latest message, the reference ("${ref.form === 'singular' ? 'it/this/that' : ref.form === 'plural' ? 'they/them/these' : 'which one'}") points to ${what}, from the user's earlier message in this conversation. Answer about ${what} directly; do not ask what it refers to.`;
  }
  if (ref.status === 'ambiguous') {
    return `Conversation reference: the user's latest message refers to one thing, but the conversation mentions several (${ref.candidates.map(s => `"${s}"`).join(', ')}). If the answer differs between them, ask which one they mean — or answer briefly for each.`;
  }
  return '';
}

/**
 * The question as a stage that sees ONLY a question should read it: the
 * literal message, plus what its reference resolved to. Used for the IIE
 * reasoning pass (it analyses a question with no history). Unchanged when
 * nothing resolved.
 */
export function resolvedQuestionFor(conversationContext) {
  const c = conversationContext;
  if (!c?.enabled || c.reference?.status !== 'resolved' || !c.reference.subjects.length) return String(c?.message ?? '');
  return `${c.message} (in this conversation, the reference means: ${c.reference.subjects.join(' and ')})`;
}

/** Privacy-safe counters for logs (no text). */
export function conversationContextStats(conversationContext) {
  const c = conversationContext ?? {};
  return {
    history: c.historyCount ?? 0,
    refStatus: c.reference?.status ?? 'none',
    refSubjects: c.reference?.subjects?.length ?? 0,
    personal: !!c.personalWorld,
    augmented: !!(c.retrievalQuery && c.retrievalQuery !== c.message),
  };
}
