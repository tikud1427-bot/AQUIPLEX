/**
 * AQUA — State transitions between a user's statements (2026-11-02). Pure,
 * deterministic, no LLM.
 *
 * THE FAILURE THIS SERVES
 * -----------------------
 * Monday "our launch is blocked by the zoning permit", Wednesday "the zoning
 * permit came through", Friday "what is blocking our launch?". The question
 * shares its words with Monday, not Wednesday, so every relevance-ranked lane
 * found the blocker and missed its resolution. Measured on the development sets
 * (scripts/temporal-resolution-eval.mjs, ranked regime): the evidence lane held
 * the old statement without the later one on 20.4% of change questions, recall
 * on 9.3%. Two causes, both deterministic:
 *
 *   · WRITE: a conversational fact needs a resolved entity, and a resolution
 *     is typically a definite noun phrase and a verb — "The zoning permit came
 *     through.", "The audit is done and clean." — with none. The blocker was
 *     stored, its resolution never was.
 *   · READ: the lanes that do look for "a later statement on the same subject"
 *     knew change words ("moved", "switched") but not resolution words
 *     ("came through", "signed off", "repaired"), so a resolution sharing one
 *     subject word with its blocker was not followed up.
 *
 * WHAT THIS MODULE DECIDES, AND WHAT IT DOES NOT
 * ----------------------------------------------
 * It reads the GRAMMAR of a transition — does a sentence resolve, change or
 * re-report an open state — and which subject words two statements share. It
 * never decides that a later statement REPLACES an earlier one: no fact is
 * superseded, hidden or rewritten here. Callers use it to put the later
 * statement BESIDE the earlier one, in order, and the answer model (told that
 * the newer statement is the current state) reads both. A wrong match costs one
 * extra line of context, never a lost fact.
 *
 * The tokenizer is episodic recall's (moved here so PIC and the Brain can use
 * it without importing the conversation store); memory/episodicRecall.js
 * re-exports it unchanged.
 */

// "may" is deliberately absent: in this product it is far more often the month.
const STOP = new Set(('a an the is are was were be been being am i me my mine myself we our ours us you your yours '
  + 'it its this that these those to of in on at for with from by and or but do does did doing done what where when '
  + 'who whom whose how why which can could should would will shall might must have has had having not no nor so '
  + 'if then than there their theirs they them he him his she her hers about into onto up out just now also too very '
  + 'any some all each every much many more most other such own same only again ever really still yet tell know think '
  + 'remember said say told ask asked please thanks thank ok okay hi hey hello yes yeah sure like get got one '
  // contractions, apostrophe already removed by tokens()
  + 'im ive id ill youre youve youll were weve well theyre theyve thats whats wheres whos hows whys theres heres '
  + 'its lets dont doesnt didnt isnt arent wasnt werent cant couldnt wont wouldnt shouldnt havent hasnt hadnt'
  ).split(/\s+/));

/**
 * Light suffix folding so "launching"/"launched"/"launches" meet "launch".
 * A doubled final consonant left by -ing/-ed is undoubled ("shipping" → ship,
 * "planned" → plan): without it "Shipping slips to April 20" shared no word
 * with "We plan to ship the first batch" (development set, 2026-11-02).
 */
export function stem(t) {
  let s = t;
  for (const suf of ['ing', 'ed', 'es', 's']) {
    if (s.endsWith(suf) && s.length - suf.length >= 3 && !(suf === 's' && s.endsWith('ss'))) {
      s = s.slice(0, -suf.length);
      if ((suf === 'ing' || suf === 'ed') && /([bdgmnprt])\1$/.test(s) && s.length >= 4) s = s.slice(0, -1);
      break;
    }
  }
  // AGENT NOUNS (2026-11-02): "blocker" meets "blocking"/"blocked". Only when
  // at least five letters remain, so "number", "later", "water", "corner",
  // "user" keep their own identity (vocabulary-continuity.dev.v1 controls).
  // ("blockers" arrives here as "blocker": the loop took the plural.)
  if (s.endsWith('er') && s.length - 2 >= 5) return s.slice(0, -2);
  if (s.length >= 5 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

export function tokens(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(t => (t.length > 1 || /\p{N}/u.test(t)) && !STOP.has(t))
    .map(t => (/\p{N}/u.test(t) ? t : stem(t)));
}

// ── transition grammar ─────────────────────────────────────────────────────

/** An open state was closed: a blocker cleared, a task done, a thing that ended. */
const RESOLVES = /\b(?:came through|went through|signed off|passed (?:the|my|our)\b|approved|cleared|finished|completed?|done|fixed|repaired|resolved|sorted|arrived|granted|unblocked|wrapped(?: up)?|landed|delivered|back on track|fell through|called off|broke up|split up|passed on|(?:not|isnt|isn't|arent|aren't) blocked any ?more|no longer (?:blocked|stuck|an issue|a problem))\b/i;

/** A value or plan changed. Episodic recall's original change markers plus price/plan verbs. */
const CHANGES = /\b(?:actually|correction|misspoke|no longer|not anymore|any ?more|instead|changed?|moved?|relocated|switched|now|update[ds]?|turns out|cancel(?:led|ed)?|postponed|delayed|slip(?:s|ped)?|pushed|replaced|left|leaving|quit|stopped|(?:pulling|pulled|dropping|dropped|backing|backed) out|withdr[ae]wn?|retired|resigned|joined|from now on|promoted|decided|bumped|raised|increased|decreased|lowered|reduced|cut|dropped|went from|extended|fired|hired|(?:is|are) out|(?:our|my|the) new)\b/i;

/** The speaker corrects what they said before. */
const CORRECTS = /\b(?:actually|correction|misspoke|i meant)\b|\w, not \w/i;

/** A state ENDED: a job left, a car sold, a band broken up, a plan dropped. */
const ENDS = /\b(?:left|quit|resigned|retired|sold|broke up|split up|stopped|cancel(?:led|ed)|fired|(?:pulled|dropped|moved) out|(?:is|are) out|shut down|closed down|gave up|no longer|not any ?more)\b/i;

/** The same open state re-reported ("still no word from the city"). */
const STILL_OPEN = /\b(?:still (?:no|not|nothing|waiting|pending|blocked|stuck|havent|haven't|hasnt|hasn't)|no word|no news)\b/i;

/** An open state: something blocks, waits, is planned or owed. */
const PENDING = /\b(?:block(?:ed|s|ing|er)?|stuck|waiting|wait on|until|depends? on|pending|holding (?:up|back)|held up|bottleneck|needs? to|have to|has to|promised|plan(?:ning)? to|supposed to|hasn'?t|haven'?t|not yet|due|deadline|back-?ordered|delayed)\b/i;

/**
 * The transition a sentence announces. `marked` = it resolves, changes or
 * re-reports something, i.e. it can be a later word on an earlier statement.
 */
export function transitionOf(text) {
  const s = String(text ?? '');
  const resolves = RESOLVES.test(s);
  const changes = CHANGES.test(s);
  const stillOpen = STILL_OPEN.test(s);
  const corrects = CORRECTS.test(s);
  const ends = ENDS.test(s);
  return { resolves, changes, stillOpen, corrects, ends, pending: PENDING.test(s), marked: resolves || changes || stillOpen || corrects || ends };
}

// ── closing, dates, subject words (Mind working state, 2026-11-02) ─────────

/** A cue that is negated, hedged or conditional just before it is not a transition ("hasn't arrived yet"). */
const NEGATED_BEFORE = /\b(?:not|never|no|yet to|haven'?t|hasn'?t|hadn'?t|didn'?t|isn'?t|wasn'?t|aren'?t|won'?t|can'?t|almost|nearly|once|when|after|if|until|before|hope(?:fully)?|will|should|might|could)\b[^.!?]{0,24}$/i;

function unnegated(re, text) {
  const s = String(text ?? '');
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of s.matchAll(g)) {
    if (!NEGATED_BEFORE.test(s.slice(Math.max(0, m.index - 40), m.index))) return true;
  }
  return false;
}

/**
 * Does this message CLOSE an open state — resolve it or end it — in so many
 * words, not negated or hedged? "The new driving licence arrived" closes;
 * "the licence hasn't arrived yet" and "once Apple approves it" do not.
 */
export function closes(text) {
  return closeKind(text) !== null;
}

/** 'resolved' (came through, arrived, done…), 'ended' (quit, cancelled, gave up…) or null. A resolution wins when both. */
export function closeKind(text) {
  // Said in a sarcastic frame, it did not happen: "I passed the CFA exam, yeah right" (2026-11-04).
  if (SARCASM.test(String(text ?? ''))) return null;
  // A part done is not the thing done: "I finished the first draft of my book" (2026-11-04).
  if (unnegated(RESOLVES, text)) return PARTIAL.test(String(text ?? '')) ? null : 'resolved';
  if (unnegated(ENDS, text)) return 'ended';
  return null;
}

/**
 * Speculation, hypotheticals and plans not yet made (2026-11-02): "I'm
 * thinking about selling the Civic", "I might move to Bristol next year if the
 * job works out", "we'd probably switch". A later sentence is not a later
 * FACT when it only considers one.
 */
const SPECULATIVE = /\b(?:might|may\s+(?!\d)|maybe|perhaps|possibly|probably|thinking\s+(?:about|of)|considering|planning\s+to|plan\s+to|hoping\s+to|hope\s+to|want\s+to|would\s+like|if\b|unless|whether|not\s+sure|undecided|(?:haven'?t|not|nothing(?:'s|\s+is)?)\s+(?:yet\s+)?decided|someday|eventually)/i;
// Not "will" / "going to": "the launch will be on April 14" and "Imran will be
// the lead from now on" are decided, not considered.
export function speculative(text) {
  return SPECULATIVE.test(String(text ?? ''));
}

/**
 * The kind of later word a clause is, ONLY when it is a stated fact: not
 * negated ("I haven't left Hartwell"), not speculative ("I might move"), not
 * hypothetical ("if the job works out"). 'resolved' | 'ended' | 'changed' | null.
 * The one reading the profile and the Mind's working state share.
 */
/**
 * An INTENTION is not a change: "My goal is to get promoted to senior analyst
 * at Fintrail" read as a change ("promoted") to the workplace Fintrail, and the
 * identity card said "Company: Fintrail (since changed — …)" (architecture
 * probe, 2026-11-02). Goals, aims and plans state what the user wants, not
 * what became true.
 */
const INTENT = /\b(?:(?:my|our|the)\s+(?:main\s+|top\s+|big\s+)?(?:goal|aim|objective|target|ambition|dream|plan)s?\b|(?:trying|aiming|hoping|working)\s+(?:to|toward|towards)\b|i(?:'d| would)\s+(?:love|like)\s+to\b)/i;
export function intends(text) {
  return INTENT.test(String(text ?? ''));
}

export function changeKind(text) {
  if (speculative(text) || intends(text)) return null;
  const close = closeKind(text);
  if (close) return close;
  return unnegated(CHANGES, text) || unnegated(CORRECTS, text) ? 'changed' : null;
}

/**
 * Is this the user CORRECTING what they said (the earlier value was wrong)
 * rather than reporting a CHANGE (it was true and no longer is)? "Actually, my
 * city is now Porto" corrects; "the deadline got pushed back to April 23"
 * changes. A correction's old value is not history — it was never true.
 */
export function corrects(text) {
  return unnegated(CORRECTS, text);
}

/** Capitalised words that are not the first word of a sentence (names), stemmed. */
export function namesOf(text) {
  return namesIn(text);
}

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_RE = new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b|\\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b`, 'gi');

/** Calendar dates named in a text ("December 9", "9 December", "Friday"), lower-cased. */
export function datesIn(text) {
  return [...new Set((String(text ?? '').match(DATE_RE) ?? []).map(d => d.toLowerCase().replace(/\s+/g, ' ')))];
}

// Dates and date words, and titles: neither says what two statements are ABOUT
// ("Dr" in "Dr. Osei" and "Dr. Varga" is not a shared subject).
const DATE_WORD = new RegExp(`^(?:${MONTH}|\\d+(?:st|nd|rd|th)?|today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year|next|befor|by|due|until|dr|mr|mrs|ms|mx|prof|professor|sir|madam|dame)$`, 'i');

/**
 * Subject words two short statements share, ignoring dates and date words:
 * "launch on November 18" and "the launch moved to December 9" share
 * "launch"; "dinner on November 3" and "the launch is in November" share
 * nothing.
 */
export function subjectShared(a, b) {
  const tb = new Set(tokens(b).filter(w => !DATE_WORD.test(w)));
  return [...new Set(tokens(a).filter(w => tb.has(w) && !DATE_WORD.test(w)))];
}

/**
 * The clauses of a message, for reading SEVERAL changes in one message
 * separately: "Shipping slips to April 20, and Boxwell is out — we're using
 * Freightly now" is a reschedule of the shipping and an ending of Boxwell, and
 * the ending must not be read as the shipping's.
 */
export function clausesOf(text) {
  return String(text ?? '').split(new RegExp(`${SENTENCE_END.source}|(?<=;)\\s+|\\s+[—–]\\s+|,\\s+(?=(?:and|but|so|while|whereas)\\b)`, 'i')).map(s => s.trim()).filter(Boolean);
}

/**
 * A sentence end that is not a title or abbreviation: "my supervisor is now
 * Dr. Varga" is one sentence (split after "Dr.", the value was "Dr" and the
 * title matched another fact's "Dr. Osei" — 2026-11-02).
 */
export const SENTENCE_END = /(?<=[.!?])(?<!\b(?:Dr|Mr|Mrs|Ms|Mx|Prof|St|Jr|Sr|vs|etc|No|Inc|Ltd|Co|Mt|Ft|Gen|Col|Capt|Lt|Rev|Hon|[A-Z])\.)\s+/;
export const sentencesIn = text => String(text ?? '').split(SENTENCE_END).map(s => s.trim()).filter(Boolean);

/**
 * The clauses of `text` that share a subject word with `subject`, as one
 * string — the part of the message that is about it. '' when none is.
 */
export function partAbout(text, subject) {
  return clausesOf(text).filter(c => subjectShared(c, subject).length).join(' ');
}

/** The clause of `text` that contains `needle` (lower-case), in the user's words, at most `max` chars. */
export function clauseWith(text, needle, max = 80) {
  const parts = String(text ?? '').split(/(?<=[.!?;])\s+|,\s+(?:so|but|and)\s+/);
  const hit = parts.find(p => p.toLowerCase().includes(needle)) ?? String(text ?? '');
  // "Actually, correction: the launch is December 16" → "the launch is December 16".
  const c = hit.trim().replace(/^(?:(?:actually|correction|sorry|update|good news|bad news)[:,—-]?\s*)+/i, '').replace(/[.!;,\s]+$/, '');
  return c.length > max ? `${c.slice(0, max - 1)}…` : c;
}

/**
 * Is `laterTr` a STRONG later word on an earlier statement whose transition is
 * `earlierTr` — strong enough that ONE shared subject word ties them? A
 * correction is; so is closing or re-reporting an open state ("blocked by a
 * zoning permit" → "the zoning permit came through"). A plain change is not:
 * "…depends on getting an SBA loan" → "our new loan officer is Kim Alvarez"
 * shares one word and is about something else (dev set, 2026-11-02), so a
 * change needs two shared words.
 */
export function strongContinuation(laterTr, earlierTr) {
  return laterTr.corrects || (earlierTr.pending && (laterTr.resolves || laterTr.stillOpen));
}

// ── subject continuity ─────────────────────────────────────────────────────

/**
 * Which words are SPECIFIC in a pool of texts: in fewer than ~60% of them —
 * the cut recall's idf > 0.5 makes (log(1 + (N−n+½)/(n+½)) > 0.5 ⇔ n ≲ 0.6·N)
 * — or in at most two. The floor is for a young store: with two facts, the
 * word they share ("FCC" in "stuck waiting on FCC certification" and "FCC
 * signed off") is in 100% of them and idf alone calls it generic.
 */
export function specificityOver(texts) {
  const N = texts.length;
  const df = new Map();
  for (const t of texts) for (const w of new Set(tokens(t))) df.set(w, (df.get(w) ?? 0) + 1);
  const cap = Math.max(2, 0.6 * N);
  return w => (df.get(w) ?? 0) <= cap;
}

/**
 * The SPECIFIC words an earlier and a later statement share, excluding words
 * the caller already matched on (the question's own terms). Pure.
 */
export function sharedSubject(later, earlier, { specific = null, exclude = null } = {}) {
  const a = new Set(tokens(earlier));
  const out = [];
  for (const w of new Set(tokens(later))) {
    if (!a.has(w) || exclude?.has(w) || /^\p{N}+$/u.test(w)) continue;
    if (specific && !specific(w)) continue;
    out.push(w);
  }
  // An acronym in one statement and its spelled-out form in the other are the
  // same subject: "I stopped the TA job" / "I work part-time as a teaching
  // assistant". Only between the user's OWN statements — a question's "TA" is
  // never expanded, or "Who is my TA?" would reach "Our tax advisor is Ruth".
  for (const acr of [...acronymLinks(later, earlier), ...acronymLinks(earlier, later)]) {
    if (!out.includes(acr) && !exclude?.has(acr)) out.push(acr);
  }
  return out;
}

/** Upper-case acronyms (2–5 letters) written in `text`, as written. A clock time's "3 PM" is not one. */
export function acronymsIn(text) {
  return [...new Set(String(text ?? '').match(/(?<!\d\s?)\b[A-Z]{2,5}\b/g) ?? [])];
}

/**
 * Acronyms in `a` spelled out in `b` — consecutive content words whose
 * initials are the acronym's letters, in order. Returned lower-cased.
 */
export function acronymLinks(a, b) {
  const words = String(b ?? '').normalize('NFKC').replace(/[’']/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = [];
  for (const acr of acronymsIn(a)) {
    const n = acr.length;
    for (let i = 0; i + n <= words.length; i++) {
      const run = words.slice(i, i + n);
      if (run.every((w, j) => w.length >= 2 && !STOP.has(w.toLowerCase()) && w[0].toLowerCase() === acr[j].toLowerCase())) { out.push(acr.toLowerCase()); break; }
    }
  }
  return out;
}

/** Capitalised words that are not the first word of a sentence (names), stemmed. */
function namesIn(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/(?<![.!?]\s|^)\b(\p{Lu}[\p{L}\p{N}]+)/gu)) out.add(stem(m[1].toLowerCase()));
  return out;
}

/**
 * Does `later` continue `earlier`? It must announce a transition and share
 * specific subject words with it that are not in `exclude` (the question's
 * terms: a word the question supplied says nothing about the two statements
 * being about the same thing) — one word for a strong continuation, two
 * otherwise. Returns the shared words, or null.
 */
/**
 * Hedges that speculative() leaves to its callers ("could be approved next month",
 * "hopefully gets approved", "should come through"). Used ONLY to decide that a
 * sentence does not continue another — so it can only ever link less. A stated
 * failure ("could not get the permit") or a past regret ("should have filed") is
 * not a hedge.
 */
const CONTINUATION_HEDGE = /\b(?:could|should|would)\b(?!\s*(?:not|n['’]?t|have)\b)|\bhopefully\b|\b(?:un)?likely\b|\bexpect(?:s|ed|ing)?\s+(?:it\s+|that\s+|them\s+)?to\b|\bfingers\s+crossed\b/i;

/**
 * Do two statements that share words name DIFFERENT THINGS? (C9, 2026-11-07)
 *
 * "I fixed a race condition in the Kestrel payment service." shares one word,
 * a name, with "I'm blocked on the Kestrel deploy pipeline." — and read as its
 * resolution: the Mind closed the blocker, Brain continuity linked the two. A
 * shared name or word is not a shared subject when, in both statements, it goes
 * on to different things: "Kestrel payment…" vs "Kestrel deploy…", "Kestrel
 * deploy script" vs "Kestrel deploy pipeline".
 *
 * Judged at the LAST shared word in the earlier statement's order:
 *   · the earlier statement ends there ("the zoning permit") → same thing;
 *   · the later one ends there, or continues with a shared word → same thing;
 *   · the later one continues with a closing phrase ("Apple approved the app",
 *     "FCC signed off") → the name is the subject of the resolution → same thing;
 *   · otherwise both continue with different content words → different things.
 * Pure. Used only to decide that something does NOT close or continue, so it can
 * only ever link less.
 */
const TIME_WORD = /^(?:last|next|this|earlier|later|yesterday|today|tonight|tomorrow|now|morning|afternoon|evening|night|week|weekend|month|year|ago|(?:mon|tues|wednes|thurs|fri|satur|sun)day|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i;
const contentWords = text => {
  const raw = String(text ?? '').match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
  return raw.map((w, i) => ({ raw: w, i, tok: tokens(w)[0] ?? null })).filter(x => x.tok);
};
export function differentThing(later, earlier, shared = sharedSubject(later, earlier)) {
  if (!shared?.length) return false;
  const E = contentWords(earlier), L = contentWords(later);
  const lastE = E.map((x, i) => [x, i]).filter(([x]) => shared.includes(x.tok)).at(-1);
  if (!lastE) return false;
  const nextE = E[lastE[1] + 1];
  const timeLike = x => TIME_WORD.test(x.raw) || /^\p{N}/u.test(x.raw) || /^(?:quarter|season|semester|term)$/i.test(x.raw);
  // The earlier statement ends at the shared word ("the deploy pipeline"): judge the word
  // written directly IN FRONT of the shared run instead — "sales pipeline" is not "deploy
  // pipeline". Only directly adjacent words count: "blocked by a zoning permit" has no modifier.
  if (!nextE) {
    let start = lastE[1];
    while (start > 0 && shared.includes(E[start - 1].tok) && E[start - 1].i === E[start].i - 1) start--;
    const prevE = start > 0 && E[start - 1].i === E[start].i - 1 ? E[start - 1] : null;
    const jL = L.map(x => x.tok).lastIndexOf(E[start].tok);
    const prevL = jL > 0 && L[jL - 1].i === L[jL].i - 1 ? L[jL - 1] : null;
    return !!(prevE && prevL && prevE.tok !== prevL.tok && !shared.includes(prevL.tok) && !timeLike(prevL) && !timeLike(prevE));
  }
  // …or goes on only to a time ("this quarter").
  if (timeLike(nextE)) return false;
  const iL = L.map(x => x.tok).lastIndexOf(lastE[0].tok);
  if (iL < 0) return false;
  const nextL = L[iL + 1];
  if (!nextL || shared.includes(nextL.tok) || nextL.tok === nextE.tok) return false;
  // A time word or a number names no thing: "Hartwell last Friday" is still Hartwell.
  if (TIME_WORD.test(nextL.raw) || /^\p{N}/u.test(nextL.raw)) return false;
  const rawL = String(later ?? '').match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
  if (closes(rawL.slice(nextL.i, nextL.i + 4).join(' '))) return false;
  return true;
}

export function continues(later, earlier, opts = {}) {
  const tr = transitionOf(later);
  if (!tr.marked) return null;
  // A sentence that only CONSIDERS a change continues nothing (2026-11-06):
  // "Maybe the San Antonio zoning permit will be approved soon." read as a
  // resolution ("approved"), and PIC Lane 7 ranked it above the blocker it named
  // for "is anything still blocking it?". A hedge is not a later fact.
  if (speculative(later) || CONTINUATION_HEDGE.test(String(later ?? ''))) return null;
  const shared = sharedSubject(later, earlier, opts);
  // The shared words go on to different things in the two statements (C9): not a continuation.
  if (differentThing(later, earlier, shared)) return null;
  if (shared.length >= 2 || (shared.length === 1 && strongContinuation(tr, transitionOf(earlier)))) return shared;
  // A state that ENDED, about the same NAMED thing: "I resigned from Hartwell"
  // after "I'm employed at Hartwell Bank", "I sold the Civic" after "my car is
  // a Honda Civic". One shared word is enough only when it is a name (or an
  // acronym link) — a common noun plus "stopped" is too weak to tie two statements.
  if (shared.length === 1 && tr.ends) {
    const names = namesIn(earlier);
    if (names.has(shared[0]) || acronymLinks(later, earlier).includes(shared[0]) || acronymLinks(earlier, later).includes(shared[0])) return shared;
  }
  return null;
}

// ── Achievements: the outcome a goal intends, reported as done (2026-11-04) ──
/**
 * A goal is an intended OUTCOME: a verb and what it acts on — "run a half
 * marathon", "get promoted to senior analyst", "raise a seed round". The goal
 * is achieved when the user reports that outcome done, which is not the same as
 * using a closure word: "I finally ran the half marathon", "I got the promotion"
 * and "We closed our seed round" name no "finished"/"done", and "I finished the
 * first draft of my book" does, without finishing the book.
 *
 * `achieves(text, goalTitle)` reads one clause against one goal. Achieved when
 * ALL hold:
 *   subject  the user — I / we / my team / our team — opens the clause, not
 *            "my sister", "our competitor";
 *   done     a past form of the goal's own verb (ran ← run, got ← get, bought
 *            ← buy, passed ← pass) or a verb of completion (finished, completed,
 *            achieved, reached, hit, closed, secured, landed, won, earned,
 *            nailed, made it);
 *   object   what it was done to is the goal's object: at least half of the
 *            object's content words, a nominalisation counting ("promotion"
 *            for "promoted", "certification" for "certified");
 *   asserted not negated, planned, hoped, conditional, almost, asked, or said
 *            in a sarcastic frame ("yeah right", "as if");
 *   whole    not a part of it ("the first draft", "halfway", "part of") and not
 *            an activity around it ("the route", "for training") — unless the
 *            goal itself is about that part.
 * Returns { coverage } or null. Pure.
 */
const IRREGULAR_PAST = new Map(Object.entries({
  ran: 'run', got: 'get', gotten: 'get', bought: 'buy', won: 'win', wrote: 'write', written: 'write', made: 'make',
  built: 'build', took: 'take', taken: 'take', did: 'do', done: 'do', went: 'go', became: 'become', lost: 'lose',
  sold: 'sell', met: 'meet', found: 'find', hit: 'hit', gave: 'give', given: 'give', began: 'begin', paid: 'pay', flew: 'fly',
  swam: 'swim', swum: 'swim', drove: 'drive', driven: 'drive', kept: 'keep', held: 'hold', taught: 'teach', learnt: 'learn',
  read: 'read', quit: 'quit', rode: 'ride', ridden: 'ride', climbed: 'climb', grew: 'grow', grown: 'grow', saw: 'see', seen: 'see',
}));
// Release verbs complete an outcome that is a release ("launch the billing migration" ← "shipped it"); the object must still be the goal's.
const COMPLETION = /\b(?:shipped|launched|released|published|delivered|went live|finished|completed|achieved|accomplished|reached|hit|closed|secured|landed|won|earned|nailed|made it|pulled off|got through|wrapped up|crossed off|ticked off|smashed|aced|cleared|passed)\b/i;
const USER_SUBJECT = /^(?:(?:so|well|ok|okay|finally|today|yesterday|yay|woo+|guess what|good news|great news|big news|update|news|and|but|also)[,!:]?\s+)*(?:i|i've|i have|we|we've|we have|my team|our team|my (?:wife|husband|partner) and i)\b/i;
const NOT_ASSERTED = /\b(?:didn'?t|did not|haven'?t|have not|hasn'?t|has not|hadn'?t|never|not yet|yet to|failed to|couldn'?t|could not|won'?t|wouldn'?t|almost|nearly|about to|going to|gonna|plan(?:ning)? to|hope|hoping|want to|wanna|would like|trying to|try to|will|if|unless|when i|once i|might|may|should|could|wish)\b/i;
const SARCASM = /\b(?:yeah,? right|as if|in my dreams|lol,? no|not really|sure,? sure|ha,? i wish)\b/i;
const PARTIAL = /\b(?:so far|half(?:way| of)|(?:first|second|third|rough|initial|early) (?:draft|chapter|module|part|phase|round|stage|step|section|half of)s?|part of|parts of|some of|most of|partially|in part|started|began|begun|kicked off)\b/i;
const AROUND = /\b(?:route|course map|training|practice|practise|trial run|mock|warm-?up|rehearsal|registration|sign(?:ed)?[- ]up|applied|application|interview(?:ed)?)\b/i;

// Stemmed like every other word (stem folds a final e: become → becom), so a base and its past compare equal.
// Stemmed like every other word, final e normalised: stem() keeps "save" but makes "saved" "sav", and "become" "becom".
const lemma = w => stem(IRREGULAR_PAST.get(w) ?? w).replace(/e$/, '');
const sameRoot = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && (a.startsWith(b.slice(0, 6)) || b.startsWith(a.slice(0, 6))) && a.slice(0, 5) === b.slice(0, 5));
const DATE_TOKEN = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|year|month|week|summer|winter|spring|fall|autumn|today|tomorrow|q[1-4]|\d+)$/;

/** The goal as verb + object content words. */
function outcomeOf(goalTitle) {
  const words = String(goalTitle ?? '').toLowerCase().replace(/[’']/g, '').replace(/^(?:to|be able to)\s+/, '').match(/[a-z0-9]+/g) ?? [];
  if (!words.length) return null;
  const verb = words[0];
  // The object stops at a time phrase ("by June", "this year", "in October", "before summer").
  const rest = words.slice(1);
  const cut = rest.findIndex((w, i) => (['by', 'before', 'this', 'next', 'in', 'until', 'within', 'for'].includes(w) && DATE_TOKEN.test(rest[i + 1] ?? '')) || DATE_TOKEN.test(w) && !/^\d+$/.test(w) && i > 0);   // a number is part of the object ("10,000 dollars")
  const object = (cut > 0 ? rest.slice(0, cut) : rest).filter(w => !STOP.has(w) && !DATE_TOKEN.test(w) && w.length > 1).map(stem);
  return { verb: lemma(verb), object };
}

// Past and present spelled alike: past only when the clause says when ("I read my twentieth book last night").
const SAME_SPELLING = new Set(['read', 'hit', 'quit', 'put', 'cut', 'set', 'let', 'beat']);
const PAST_TIME = /\b(?:yesterday|last (?:night|week|weekend|month|year)|this (?:morning|afternoon|week)|just|already|finally|earlier|ago|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
// Where the object noun phrase ends: a preposition, a conjunction, a time word.
const NP_END = new Set(['at', 'in', 'on', 'for', 'with', 'to', 'of', 'by', 'from', 'about', 'through', 'into', 'over', 'around', 'after', 'before',
  'and', 'but', 'so', 'because', 'while', 'last', 'this', 'yesterday', 'today', 'tonight', 'finally', 'successfully', 'it', 'was', 'were', 'and']);
const numbersIn = s => (String(s).match(/\d[\d,.]*/g) ?? []).map(n => n.replace(/,/g, '').replace(/\.$/, ''));

export function achieves(text, goalTitle) {
  const s = String(text ?? '').trim();
  if (!s || /\?\s*$/.test(s) || /^(?:did|have|has|will|do|does|can|could|should)\s+(?:i|we)\b/i.test(s)) return null;
  if (SARCASM.test(s) || speculative(s)) return null;
  const goal = outcomeOf(goalTitle);
  if (!goal || !goal.object.length) return null;
  const raw = s.toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]+/g) ?? [];
  // Done: a past form of the goal's own verb, or a verb of completion.
  let vi = raw.findIndex(w => w !== goal.verb && (IRREGULAR_PAST.has(w) || /ed$/.test(w)) && lemma(w) === goal.verb);
  if (vi < 0 && SAME_SPELLING.has(goal.verb) && PAST_TIME.test(s)) vi = raw.indexOf(goal.verb);
  let verbLen = 1;
  if (vi < 0) {
    const c = s.match(COMPLETION)?.[0];
    if (c) { const first = c.toLowerCase().replace(/[’']/g, '').split(/\s+/); vi = raw.indexOf(first[0]); verbLen = first.length; }
  }
  if (vi < 0) return null;
  const verbWord = raw[vi];
  // The user is the subject — or the clause opens on the verb ("Got my driver's license today!").
  const opensOnVerb = raw.slice(0, vi).every(w => /^(?:so|well|ok|okay|finally|just|yay|woo+|and|also|guess|what|good|great|big|news|update)$/.test(w));
  if (!USER_SUBJECT.test(s) && !opensOnVerb) return null;
  const before = s.slice(0, s.toLowerCase().replace(/[’']/g, '').indexOf(verbWord));
  if (NOT_ASSERTED.test(before)) return null;
  const goalText = String(goalTitle).toLowerCase();
  if (PARTIAL.test(s) && !PARTIAL.test(goalText)) return null;
  const around = s.match(AROUND)?.[0];
  if (around && !goalText.includes(around.toLowerCase())) return null;
  // What it was done to: the noun phrase after the verb; its head must be the goal's object.
  let np = raw.slice(vi + verbLen);
  if (np[0]?.endsWith('ing') && np.length > 1) np = np.slice(1);        // "finished writing my book" → "my book"
  const end = np.findIndex(w => NP_END.has(w));
  if (end >= 0) np = np.slice(0, end);
  const content = np.filter(w => !STOP.has(w) && !/^\d/.test(w) && !DATE_TOKEN.test(w));
  const npHead = content.length ? stem(content.at(-1)) : null;
  if (!npHead || !goal.object.some(o => sameRoot(npHead, o))) return null;
  // Quantities the user states must be the goal's: 2,000 saved is not the 10,000 goal.
  const want = numbersIn(goalTitle), got = numbersIn(s);
  if (want.length && got.length && !got.some(n => want.includes(n))) return null;
  // And enough of the object: half its words, or its distinctive head ("I got the promotion").
  const said = raw.map(stem);
  const hit = goal.object.filter(o => said.some(w => sameRoot(w, o)));
  const coverage = hit.length / goal.object.length;
  const head = goal.object[0];
  const headHit = head.length >= 5 && said.some(w => sameRoot(w, head));
  if (coverage < 0.5 && !headHit) return null;
  return { coverage, verb: verbWord };
}


/** When the user says it happened, as they said it ("last week", "on Sunday", "March 3") — not resolved to a date. */
export function whenSaid(text) {
  const rel = String(text ?? '').match(/\b(?:yesterday|today|this (?:morning|afternoon|evening|week|weekend|month)|last (?:night|week|weekend|month|year|friday|monday|tuesday|wednesday|thursday|saturday|sunday)|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i)?.[0];
  return rel ?? datesIn(text)[0] ?? null;
}

/**
 * The same reading without a goal to match: the clause reports something the
 * USER did as done and whole — the user as subject, asserted, not partial, not
 * sarcastic. For cues that already know which goal is meant (mind/goalTracker.js
 * "we shipped it" after naming the goal), so "Our competitor launched their
 * product" and "I finished the first draft" no longer complete anything.
 */
export function reportsDone(clause, doneWord = COMPLETION) {
  const s = String(clause ?? '').trim();
  if (!s || /\?\s*$/.test(s) || SARCASM.test(s) || PARTIAL.test(s) || speculative(s)) return false;
  const m = s.match(doneWord);
  // The user as subject, or a clause that opens on the done verb ("Finally launched it!").
  const opensOnVerb = !!m && /^(?:(?:so|well|ok|okay|finally|just|yay|woo+|and|also)[,!]?\s+)*$/i.test(s.slice(0, m.index));
  if (!USER_SUBJECT.test(s) && !opensOnVerb) return false;
  return !!m && !NOT_ASSERTED.test(s.slice(0, m.index));
}
