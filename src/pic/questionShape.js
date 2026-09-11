/**
 * AQUA — Question Shape
 * Blueprint L3 (the model reads; code decides) · E7 (retrieval) · E8/PR-1 (query understanding)
 *
 * WHAT THIS IS FOR
 * ----------------
 * Retrieval had no notion of what a question ASKS FOR. Measured on
 * `retrieval-core.v1` (200 labelled queries through the production facade),
 * every first-person question returned the SAME eight facts:
 *
 *     "What is my job?"        ─┐
 *     "Which city am I in?"     ├─►  f004 "I co-founded Aquiplex in 2023."
 *     "What is my blood type?"  │    f015 "We are building AQUA…"
 *     "Where am I employed?"   ─┘    f042 "We raised a seed round in 2024." …
 *
 * Byte-identical output for four different questions, one of which the store
 * cannot answer at all. That is not retrieval; it is a dossier dump triggered
 * by the word "my". It caps recall (the real answer is crowded out of the
 * budget), it is the whole of the measured noise (131 lines across 21 of 32
 * silence-expecting queries), and it is why the top hit was the right KIND of
 * thing only 42.9% of the time — the top hit was the same fact every time.
 *
 * This module supplies the missing half: what did the question ask FOR, and
 * does a given statement plausibly OFFER that. It is deterministic code, not a
 * model call, because L3 puts policy in code — what is admitted to a prompt is
 * policy.
 *
 * THE TWO SIGNALS, AND WHY BOTH ARE NEEDED
 * ----------------------------------------
 *   LEXICAL   does the statement share content words with the question?
 *             Sound, and insufficient alone: "Where do I work?" and "I run
 *             product at Nummo." share nothing. Requiring overlap would delete
 *             the self-anchor's entire reason for existing.
 *
 *   KIND      does the statement OFFER the kind of answer the question asks
 *             for? "Where" wants a place or an organisation; "I run product at
 *             Nummo" names one; "We raised a seed round in 2024" does not.
 *             This is the bridge across the category/instance gap, and it is
 *             what lets the gate be strict without going blind.
 *
 * A question with a TYPED expectation (where/who/when/which-city/what-job) may
 * be answered on the kind signal alone. A question whose expectation is an
 * untyped `thing` ("what is my blood type") may NOT — it must earn a hit
 * lexically. That asymmetry is the entire honesty mechanism: it is what keeps
 * "where do I work" answerable and "what is my dog's name" silent, and both
 * come from the same rule rather than from a list of things to suppress.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a semantic model, not embeddings, not a substitute for E6/E8. Surface
 * grammar over English, and it will mis-shape sentences an LLM would read
 * correctly. It is deliberately the CHEAP half: it runs on every turn, on the
 * request thread, with no provider and no budget, and its job is to stop the
 * engine from asserting relevance it cannot support. When E6 lands typed
 * claims (predicate, polarity, modality, valid_from) the kind signal reads
 * those instead of the surface — `offeredKinds` already prefers a typed entity
 * from the graph over its own regex, so that path is a swap, not a rewrite.
 *
 * Pure. No I/O, no state, no imports.
 */

/**
 * Category nouns → the kind of answer a question containing them expects.
 *
 * GENERAL ENGLISH, NOT CORPUS-DERIVED. This is the vocabulary in which people
 * ask about a category when the stored answer holds an instance, which is the
 * gap the self-anchor exists to bridge. It is deliberately small and generic:
 * a list grown to fit a dataset would score well on that dataset and teach the
 * engine nothing. It is also the most obviously provisional thing in this
 * module — a hand-built lexicon is a stand-in for the semantics E6 will carry
 * on the claim itself.
 */
const CATEGORY_NOUNS = Object.freeze({
  // organisation
  company: 'org', employer: 'org', firm: 'org', startup: 'org',
  organisation: 'org', organization: 'org', workplace: 'org', business: 'org',
  // place
  city: 'place', town: 'place', country: 'place', office: 'place',
  location: 'place', address: 'place', region: 'place', base: 'place',
  // person
  manager: 'person', boss: 'person', colleague: 'person', teammate: 'person',
  cofounder: 'person', founder: 'person', partner: 'person', lead: 'person',
  team: 'person', reports: 'person', hire: 'person', head: 'person',
  // role
  job: 'role', role: 'role', title: 'role', position: 'role',
  occupation: 'role', profession: 'role', responsibility: 'role',
  // time
  deadline: 'time', date: 'time', schedule: 'time', timeline: 'time',
  birthday: 'time', anniversary: 'time',
  // goal — named in the canonical world model alongside facts and preferences,
  // and asked about in vocabulary that never overlaps the answer: "What is my
  // target?" against "I want to hit 10,000 active merchants by December".
  goal: 'goal', target: 'goal', objective: 'goal', quota: 'goal',
  ambition: 'goal', milestone: 'goal',
});

/** Interrogatives that carry a typed expectation on their own. */
const WH_EXPECTS = Object.freeze({
  where: 'place', who: 'person', whom: 'person', whose: 'person', when: 'time',
});

/**
 * Negation and rejection cues.
 *
 * Polarity is not decoration. "I no longer own the parser" answered to "do I
 * own the parser?" as though it were affirmative is the failure mode D2 calls
 * worse than no extraction at all, and it is reachable at RETRIEVAL even when
 * extraction got the polarity right — a negated statement ranked against an
 * affirmative question inverts its meaning on the way into the prompt.
 */
const NEGATION_CUE = /\b(not|never|no longer|nobody|none|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|stopped|dropped|rejected|declined|against|instead of|turned down|turn down|ruled out|passed on|gave up|no more|paused|pausing|on hold|suspended|shelved|cancelled|canceled|called off|abandoned|scrapped|refused|opted out|backed out|withdrew|withdrawn|vetoed|walked away)\b/i;
// The second half of that list COMPLETES A CLASS the first half already
// contains. `stopped`, `dropped`, `gave up` and `no more` were there from the
// start; `paused`, `on hold`, `suspended`, `shelved`, `cancelled`, `abandoned`
// are the same predicate in different words, and their absence was why "What
// is paused?" could not reach "The parser rewrite is on hold." — one clause
// negating the other with no word in common.
//
// TWO WORDS WERE CONSIDERED AND DELIBERATELY LEFT OUT.
//
//   `blocked`  "Priya is blocked on the design tokens" is a STATUS REPORT, not
//              a negation. Adding it flips that fact to negated, which puts it
//              in polarity conflict with the affirmative question that asks
//              for it ("What is blocking design?") and demotes the one right
//              answer by 0.3×. A cessation word and an obstacle word are not
//              the same word.
//
//   `lost`     "We lost the deal" negates; "Which option lost?" asks about a
//              comparison; "I lost my keys" is neither. Too polysemous to
//              decide from surface grammar, so it stays out and the question
//              that needs it stays a measured miss.
//
// The test is whether a word means THIS STOPPED in general English, not
// whether adding it moves a number on this dataset.

/** Present-tense / currency cues: the asker wants today's answer. */
const CURRENT_CUE = /\b(now|currently|current|today|these days|right now|still|at the moment|nowadays|present)\b/i;

/** Past cues: the asker wants the superseded answer, and it is the ANSWER. */
const PAST_CUE = /\b(used to|previously|formerly|former|before|earlier|anymore|any more|no longer|last (?:year|month|week)|back then|originally)\b/i;

/** Words that carry no topic. Kept tight — an over-broad list eats real terms. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'yours', 'are',
  'was', 'were', 'can', 'could', 'would', 'should', 'what', 'when', 'where',
  'which', 'who', 'whom', 'whose', 'how', 'why', 'about', 'from', 'into',
  'out', 'get', 'got', 'has', 'have', 'had', 'not', 'but', 'all', 'any',
  'some', 'just', 'like', 'does', 'did', 'doing', 'done', 'our', 'ours',
  'their', 'them', 'his', 'her', 'its', 'mine', 'myself', 'ourselves',
  'tell', 'know', 'remind', 'say', 'said', 'give', 'want', 'need', 'please',
  'now', 'currently', 'today', 'still', 'anymore', 'longer', 'ever',
]);

/**
 * A question the asker is asking ABOUT THEMSELVES.
 *
 * Includes the OBJECT forms `me`/`my`/`mine`, which the previous predicate in
 * `retrievalIntelligence` deliberately excluded because bare "me" fires inside
 * requests ("tell me about Nummo"). That exclusion cost real answers —
 * "Which company pays me?" and "Who employs me right now?" both returned
 * SILENCE on the baseline, because neither contains a first-person subject.
 *
 * They are admitted here because the exclusion is no longer the thing holding
 * the noise back: every self-anchored candidate now has to clear the relevance
 * gate regardless of how it was anchored. Widening the anchor and gating the
 * results is strictly better than narrowing the anchor and gating nothing —
 * the narrow version was silent on questions it could answer AND noisy on
 * questions it could not.
 *
 * First-person SINGULAR only. `we`/`our` is a group claim and anchoring it to
 * the individual is the quiet inference that puts a wrong line in front of the
 * model — the U1 precedent, unchanged.
 */
const SELF_TOKEN_RE = /(?:^|[^\p{L}])(?:i|i'?m|i'?ve|i'?d|my|mine|myself|me)(?:[^\p{L}]|$)/iu;

/** …and asking it as a QUESTION. A statement is not a request for retrieval. */
const INTERROGATIVE = /^(?:so\s+|and\s+|but\s+|ok(?:ay)?[,\s]+|hey[,\s]+)*(?:what|when|where|which|who|whom|whose|why|how|is|are|was|were|do|does|did|can|could|should|would|will|have|has|had|am|remind|tell)\b/i;

/** Tokens of substance, ≥3 chars, stopwords removed. */
export function contentTerms(text) {
  return [...new Set((String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    .filter(t => !STOPWORDS.has(t)))];
}

/**
 * Read a question's shape.
 *
 * @param {string} query
 * @returns {{
 *   isQuestion:boolean, selfScoped:boolean, expects:string,
 *   typed:boolean, polarity:'affirmed'|'negated', currency:'current'|'past'|'any',
 *   terms:string[]
 * }}
 */
export function analyseQuestion(query) {
  const q = String(query ?? '').trim();
  const shape = {
    isQuestion: false, selfScoped: false, expects: 'thing', typed: false,
    polarity: 'affirmed', currency: 'any', terms: [],
  };
  if (!q) return shape;

  shape.isQuestion = q.endsWith('?') || INTERROGATIVE.test(q);
  shape.selfScoped = SELF_TOKEN_RE.test(q);

  // Polarity. A negated question WANTS the negated statement — q129 "Where do
  // I not work anymore?" is answered by "I used to work at Intercom", the very
  // fact a currency filter would otherwise bury.
  if (NEGATION_CUE.test(q)) shape.polarity = 'negated';

  // Currency. PAST is checked first: "no longer" matches both cues, and it is
  // unambiguously a question about what STOPPED being true.
  if (PAST_CUE.test(q)) shape.currency = 'past';
  else if (CURRENT_CUE.test(q)) shape.currency = 'current';

  // Content terms are taken from the question with its GRAMMAR REMOVED.
  //
  // Polarity and currency phrases are structure, not subject. Leaving them in
  // put "right" — from "right now" — into the topic of "Who employs me right
  // now?", which made the question look like it was about a subject the store
  // had never heard of and silenced a question the engine could answer. A word
  // that tells you WHEN or WHETHER is never what the question is ABOUT.
  const stripped = q
    .replace(new RegExp(NEGATION_CUE.source, 'gi'), ' ')
    .replace(new RegExp(PAST_CUE.source, 'gi'), ' ')
    .replace(new RegExp(CURRENT_CUE.source, 'gi'), ' ');
  shape.terms = contentTerms(stripped);

  // Expectation. A category noun is more specific than the interrogative that
  // introduces it ("what is my company" is an org question, not a thing
  // question), so it wins.
  //
  // `cue` records WHICH word did the typing. That distinction is load-bearing:
  // the remaining content words are the question's TOPIC, and a topic the
  // store has never heard of is the difference between a question the engine
  // may answer on kind alone and one it may not. See `topicTerms` below.
  const lower = q.toLowerCase();
  const cues = new Set();

  // EVERY typing cue is recorded, not only the one that won the expectation.
  //
  // First-match-wins was the first version and it produced the exact failure
  // this distinction exists to prevent: "Where do I work now?" typed on
  // `where`, which left `work` classified as an unmatched TOPIC word — so the
  // question looked like it was about a subject the store had never heard of,
  // and the engine went silent on the one question the self-anchor was built
  // for. A word that types the answer is never also a topic.
  for (const [noun, kind] of Object.entries(CATEGORY_NOUNS)) {
    if (new RegExp(`\\b${noun}s?\\b`).test(lower)) {
      if (!shape.typed) { shape.expects = kind; shape.typed = true; }
      cues.add(noun);
    }
  }
  for (const m of lower.matchAll(/\b(where|who|whom|whose|when)\b/g)) {
    if (!shape.typed) { shape.expects = WH_EXPECTS[m[1]]; shape.typed = true; }
    cues.add(m[1]);
  }
  // "work"/"employed"/"live" are verbs, but they type the answer as firmly as
  // any noun does, and they are how people actually ask these two questions.
  for (const m of lower.matchAll(/\b(work|works|working|employ|employed|employs|paid|pays)\b/g)) {
    if (!shape.typed) { shape.expects = 'org'; shape.typed = true; }
    cues.add(m[1]);
  }
  for (const m of lower.matchAll(/\b(live|lives|living|based|located)\b/g)) {
    if (!shape.typed) { shape.expects = 'place'; shape.typed = true; }
    cues.add(m[1]);
  }

  /**
   * What the question is ABOUT, as opposed to what shape of answer it wants.
   *
   * THIS IS THE SUFFICIENCY CHECK, AND IT IS THE WHOLE HONESTY MECHANISM.
   *
   * A typed question may be answered on the kind signal alone — that is what
   * bridges "Where do I work?" to "I run product at Nummo", which share no
   * vocabulary. But the same permission, applied without limit, answers
   * "Who is my dentist?" with "Priya is our head of design": both ask for a
   * person, and the engine has no dentist.
   *
   * The difference is not the interrogative. It is that "dentist" is a topic
   * word the store has never seen, while "work" is a typing cue with no topic
   * left over. So:
   *
   *     no topic terms          → kind alone may answer      ("where do I work")
   *     topic terms, unmatched  → kind alone may NOT answer  ("who is my dentist")
   *
   * The second case is the system saying "you asked about something I have no
   * knowledge of" rather than returning the nearest thing of the right shape.
   * Unknown stays unknown.
   */
  shape.cues = [...cues];
  shape.topicTerms = shape.terms.filter(t => ![...cues].some(c => c.startsWith(t) || t.startsWith(c)));

  return shape;
}

// ── The statement side ───────────────────────────────────────────────────────

/** A date, month, weekday, year or duration — something a "when" can land on. */
const TIME_SHAPE = /\b(19|20)\d{2}\b|\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(q[1-4]|quarter|deadline|due|ship(?:s|ping)?|weeks?|months?|years?|days?)\b/i;

/**
 * Role language: what someone DOES, as opposed to who or where they are.
 *
 * The verb forms were the first version and they missed the way people
 * actually state a role, which is COPULAR: "I'm the CTO at Halcyon Labs" has
 * no role verb in it at all. That gap made "What is my role?" unanswerable
 * against a statement that answers it in five words — caught by capture-core,
 * not by retrieval-core, which is why the whole gate is run and not one suite.
 */
const ROLE_SHAPE = /\b(i|we|he|she|they)\s+(run|runs|lead|leads|manage|manages|head|heads|own|owns|build|builds)\b|\b(head of|reports? to|co-?founded|co-?founder|in charge of|responsible for|my role|works? as)\b|\b(?:i'?m|i am|is|are|was|were)\s+(?:the\s+|an?\s+)?(?:c[eofti]o|cto|ceo|cfo|coo|cio|vp|head|lead|director|manager|founder|engineer|designer|developer|analyst|consultant|president|partner|architect|scientist|officer|intern|advisor)\b/i;

/**
 * Goal language: something the person is trying to bring about.
 *
 * A goal is not a fact about the present, and the question that asks for one
 * ("what is my target") shares no vocabulary with the statement that holds it
 * ("I want to hit 10,000 active merchants by December"). Without a kind of its
 * own it is reachable only by luck.
 */
const GOAL_SHAPE = /\b(want(?:s)? to|would like to|aim(?:s|ing)? to|trying to|plan(?:s|ning)? to|hope(?:s|ing)? to|need(?:s)? to|goal is|target is|aiming for|working towards?|hit \d|reach \d|grow to|get to \d)\b/i;

/** A person reference: a capitalised name, or explicit kinship/role-to-person. */
const PERSON_SHAPE = /\b(co-?founder|colleague|manager|teammate|report|hire|head of|reports? to)\b/i;

/** Place language — a preposition of location followed by a proper noun. */
const PLACE_PREP = /\b(in|at|to|from|near|based in|moved to)\s+(the\s+)?([A-Z][\p{L}-]+)/u;

/** Organisation language — the same shape, but the object is an employer. */
const ORG_PREP = /\b(at|for|with|joined|left)\s+(the\s+)?([A-Z][\p{L}-]+)/u;

/**
 * Which kinds of answer a statement can plausibly serve, AND HOW STRONGLY.
 *
 * A boolean set was the first version and it was wrong in a way that showed up
 * immediately: every self-anchored fact that matched the asked kind scored
 * identically, so ties were broken by insertion order and "Which city am I
 * in?" ranked "I run product at Nummo" above "I moved to the Bangalore office".
 * Both offer a place. Only one of them is mostly about a place.
 *
 * Strength is confidence IN THE KIND, and the tiers are ordered by how much
 * the engine actually knows:
 *
 *   1.00  the graph typed the entity — the world model said so
 *   0.80  an unambiguous surface pattern — "in <Proper>", a date, "head of"
 *   0.40  a bare capitalised entity, which is an org OR a person and the
 *         engine cannot tell which. BOTH are offered at low strength rather
 *         than one being guessed at high strength: an unknown type must stay
 *         unknown, and the honest representation of "it is one of these two"
 *         is two weak signals, not one confident wrong one.
 *   0.30  `thing`, which every statement offers and which therefore
 *         discriminates nothing
 *
 * The ordering is the point: the signal gets BETTER as extraction gets better
 * rather than being frozen at whatever the regex knows. E6's typed claims land
 * in the 1.00 tier and demote every guess beneath them automatically.
 *
 * @param {object} fact                 { statement, entities[] }
 * @param {Map<string,string>} [types]  lowercased entity label → entityType
 * @returns {Map<string,number>} kind → strength in (0,1]
 */
export function offeredKinds(fact, types = null) {
  const kinds = new Map();
  const offer = (kind, strength) => {
    if (!(kinds.get(kind) >= strength)) kinds.set(kind, strength);
  };
  const text = String(fact?.statement ?? '');
  if (!text) return kinds;

  // ① The world model, when it knows.
  const untyped = [];
  for (const label of fact?.entities ?? []) {
    const t = types?.get(String(label).toLowerCase());
    if (t === 'self') continue;
    if (!t || t === 'name') { untyped.push(label); continue; }
    if (t === 'person') offer('person', 1);
    else if (t === 'org' || t === 'organisation' || t === 'organization' || t === 'company') offer('org', 1);
    else if (t === 'place' || t === 'location' || t === 'city') offer('place', 1);
    else if (t === 'date' || t === 'time') offer('time', 1);
    else untyped.push(label);
  }

  // ② Surface shape. Runs whether or not ① fired: a typed entity says what the
  // sentence NAMES, not everything it OFFERS. "I moved to the Bangalore office
  // last month" names a place and also answers a "when".
  if (TIME_SHAPE.test(text)) offer('time', 0.8);
  if (ROLE_SHAPE.test(text)) offer('role', 0.8);
  if (GOAL_SHAPE.test(text)) offer('goal', 0.8);
  if (PERSON_SHAPE.test(text)) offer('person', 0.8);

  // A proper noun after a preposition of place is a place — unless the token is
  // a year, which `in 2024` would otherwise make look like one.
  const place = text.match(PLACE_PREP);
  if (place && !/^\d/.test(place[3])) offer('place', 0.8);
  const org = text.match(ORG_PREP);
  if (org && !/^\d/.test(org[3])) offer('org', 0.8);

  // ③ A named entity the graph never typed. It is an organisation or a person
  // and the engine has no basis to choose, so it says so.
  for (const label of untyped) {
    if (!/^[A-Z][\p{L}-]/u.test(String(label)) || /^\d/.test(String(label))) continue;
    offer('org', 0.4); offer('person', 0.4);
  }

  offer('thing', 0.3);   // every statement is a candidate answer to "what"
  return kinds;
}

/**
 * Does this statement assert a negative?
 *
 * READS THE STORED FIELD FIRST. The extraction lane now writes `polarity` onto
 * the claim (`brain/knowledgeExtraction/claimFidelity.js`), so a fact that has
 * been through it carries the answer as DATA and there is nothing to re-derive.
 *
 * The prose fallback is for facts written before that landed, and for the
 * document lane, which does not run through it. Same tier ordering as
 * `offeredKinds`: what the world model knows beats what a regex can guess, and
 * the guess is only consulted where the knowledge is absent.
 *
 * The point is not speed. Two places deriving polarity from the same prose is
 * two places that can disagree about what the user said, and the one that
 * disagrees silently is the one that reaches the model.
 *
 * `asserted` (the writer's vocabulary) and `affirmed` (the reader's) are the
 * same state. The reader's term is kept because `analyseQuestion` produces it
 * for QUESTIONS, where "asserted" would be wrong — a question asserts nothing.
 */
export function statementPolarity(fact) {
  if (fact?.polarity === 'negated') return 'negated';
  if (fact?.polarity === 'asserted') return 'affirmed';
  return NEGATION_CUE.test(String(fact?.statement ?? '')) ? 'negated' : 'affirmed';
}

/** Does this statement describe something that has STOPPED being true? */
export function statementIsPast(fact) {
  if (fact?.tense === 'past') return true;
  if (fact?.tense === 'present') return false;
  return PAST_CUE.test(String(fact?.statement ?? ''));
}


// ═══════════════════════════════════════════════════════════════════════════
// RELEVANCE SCORING — shared by the PIC floor and the Context Engine
// ═══════════════════════════════════════════════════════════════════════════
//
// This lived inside `retrievalIntelligence.js` until the Context Engine was
// measured re-adding facts the PIC gate had just withheld: CE's step (b) hops
// `about` edges from every focus entity with no relevance test, which is the
// SAME defect the gate below was written to close, reimplemented one layer up.
// Measured on the 32 silence-expecting queries of `retrieval-core.v1`: the
// floor returned 16 noise lines, CE turned them back into 23.
//
// Copying the scorer into the assembler would have produced two gates that
// drift apart. It lives here instead — one definition of "does this fact
// answer this question", imported by both.

/** Below this, nothing supported the candidate and it is not returned. */
export const MIN_AFFINITY = 0.18;

/** A kind match with no lexical support is worth this much on its own. */
const KIND_CREDIT = 0.5;

/** Capped below KIND_CREDIT — see the note at the `sem` term in factAffinity. */
const SEMANTIC_CREDIT = 0.45;


/** Polarity disagreement: a negated statement does not answer a positive ask. */
const POLARITY_MISMATCH = 0.3;

/**
 * Word-boundary containment with light morphology.
 *
 * `platform` must not be a hit for `form` — that substring match is why "How
 * do volcanoes form?" retrieved "I lead the platform team". But `reject` must
 * hit `rejected`, or "What did we reject?" misses "We rejected the Bangalore
 * relocation" over an inflection.
 *
 * So: exact word match, or a word that EXTENDS the term by a short suffix.
 * Only for terms of four characters or more — at three, prefix matching starts
 * joining unrelated words ("own" → "ownership", "art" → "article") and the
 * precision this function exists to protect goes back out.
 */
function hasTerm(haystack, term) {
  const t = escapeRe(term);
  const tail = term.length >= 4 ? '(?:e?[sd]|ing|ed|ion|s)?' : '';
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${t}${tail}(?:[^\\p{L}\\p{N}]|$)`, 'u').test(haystack);
}
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A named entity from the query is topical evidence; the self anchor is not. */
const ANCHOR_CREDIT = 0.6;

/**
 * How well does this fact answer THIS question?
 *
 * Three independent signals, deliberately combined rather than averaged:
 *
 *   lexical  share of the question's content words the statement carries.
 *            Word-boundary matched — the lexical lane below uses substring
 *            containment, which is why "How do volcanoes form?" retrieved
 *            "I lead the platform team". That hit is real to `includes()` and
 *            meaningless to a reader.
 *
 *   kind     does the statement OFFER the kind of answer asked for? Only
 *            counted when the question is TYPED. An untyped `thing` question
 *            ("what is my blood type") must earn its hit lexically, because
 *            every statement offers a `thing` and crediting that would return
 *            the whole store for any question at all.
 *
 *   anchor   was this fact reached by hopping from an entity the QUERY NAMED?
 *            That is topical evidence and it is the only signal that survives
 *            canonicalisation: the query says "OpenAI", the stored statement
 *            says "Open AI", and the alias-aware entity lane is the one thing
 *            in the system that knows those are the same. A purely lexical
 *            gate deletes exactly the hop the graph exists to provide.
 *
 *            THE SELF ANCHOR GETS NO SUCH CREDIT. "You" matches every
 *            first-person question whatever it is about, so treating it as
 *            topical evidence is what produced the dossier in the first place.
 *            A named entity is a topic; the asker is not.
 *
 * The typed/untyped asymmetry is the honesty mechanism: "where do I work"
 * stays answerable on the kind signal alone, "what is my dog's name" stays
 * silent, and both fall out of one rule rather than a suppression list.
 *
 * @returns {{ score:number, lexical:number, kind:boolean, polarityConflict:boolean }}
 */
export function factAffinity(shape, fact, entityTypes = null, anchored = false, semantic = null) {
  const hay = ` ${String(fact?.statement ?? '')} ${(fact?.entities ?? []).join(' ')} `.toLowerCase();
  const lexical = shape.terms.length
    ? shape.terms.filter(t => hasTerm(hay, t)).length / shape.terms.length
    : 0;

  const kinds = offeredKinds(fact, entityTypes);

  // Kind credit requires that the question's TOPIC is accounted for. A typed
  // question with an unmatched topic noun ("who is my dentist") describes
  // something the store does not hold, and answering it with the nearest thing
  // of the right shape is the confident-wrong-line L11 forbids.
  // ── DENSE SIMILARITY, MEASURED INSTEAD OF SPELLED ──────────────────────────
  //
  // `recall_category` failures are semantic, not lexical: "What is my
  // educational background?" and "I studied physics before this" share no word,
  // so `topicSupported` reads the topic as unaccounted for and the right answer
  // scores zero. A cosine over committed vectors measures that property
  // directly.
  //
  // 🔴 AN EARLIER VERSION ALSO GRANTED `topicSupported` ON A COSINE FLOOR.
  // It was removed because it was measured INERT: sweeping the floor across
  // 0.10, 0.60 and 0.99 produced byte-identical results on all 200 queries.
  // The `Math.max(score, SEMANTIC_CREDIT * sem)` line below already carries the
  // signal, so the topic grant was a second path to the same place — twenty
  // lines and a confident comment that changed nothing. `SEMANTIC_CREDIT` is
  // not inert: at 0.00 recall@8 is 0.7738, at 0.45 it is 0.7976.
  //
  // It stays capped BELOW `KIND_CREDIT`: a cosine is evidence a fact is
  // on-topic, not that it answers the question, and a lane that outranks a
  // typed match on similarity alone is the dense failure this codebase spends
  // its gates avoiding. 0.90 buys 0.6 points of recall@8 and breaks that rule,
  // so it was measured and declined.
  const sem = typeof semantic === 'number' ? semantic : null;

  const topicSupported = shape.topicTerms.length === 0
    || shape.topicTerms.some(t => hasTerm(hay, t));
  const kindStrength = shape.typed && topicSupported ? (kinds.get(shape.expects) ?? 0) : 0;
  const kind = kindStrength > 0;

  let score = lexical;
  if (kind) score = Math.max(score, KIND_CREDIT * kindStrength) + 0.15 * lexical;
  if (sem != null) score = Math.max(score, SEMANTIC_CREDIT * sem);
  if (anchored) score = Math.max(score, ANCHOR_CREDIT);

  // Polarity. Losing negation at RETRIEVAL inverts meaning just as surely as
  // losing it at extraction: "I no longer own the parser" handed to "do I own
  // the parser?" tells the model the opposite of what the user said.
  const fPol = statementPolarity(fact);
  const polarityConflict = fPol !== shape.polarity;
  if (polarityConflict) score *= POLARITY_MISMATCH;
  else if (shape.polarity === 'negated') score += 0.2;   // it is the answer, not a caveat

  // Currency. A question about now should not be answered by what stopped
  // being true; a question about the past should prefer exactly that.
  //
  // 🔴 EXCEPT WHEN THE QUESTION IS NEGATED, WHERE THE TWO SIGNALS ARE ONE.
  //
  // "What is not my responsibility now?" is present-tense AND negated, and
  // the fact that answers it — "I no longer own the parser" — is BOTH. It
  // took the current-vs-past penalty (×0.5) on top of a score the polarity
  // bonus had just lifted to 0.2, landed at 0.1, and fell under the floor.
  // The engine dropped the only fact in the store that answers the question.
  //
  // The penalty was written for AFFIRMATIVE asks, where "what is true now"
  // and "what stopped being true" are genuinely different questions. Under a
  // negation they are the same question: the cessation IS the present state
  // being asked about. Penalising it charges the fact twice for one property.
  //
  // NEUTRAL, NOT REWARDED. The first version of this exemption gave the past
  // fact the same +0.2 the explicit past-tense ask gives, and that was wrong
  // in a way the measurement caught immediately: every one of the owner's past
  // facts — "I moved to the Bangalore office", "I switched from Python to Go"
  // — got the bonus on ANY negated question and crowded the real answer out of
  // the self-anchor cap. Asking "what is not X" is not asking about the past.
  // It is asking about now, and a past fact must not be penalised for being
  // the form the answer takes. Removing a penalty is the whole correction.
  const past = statementIsPast(fact);
  const negatedAsk = shape.polarity === 'negated';
  if (past && shape.currency === 'current' && !negatedAsk) score *= 0.5;
  else if (past && shape.currency === 'past') score += 0.2;

  // A DEMOTION IS NOT AN EXCLUSION.
  //
  // Both penalties above are multiplicative and they stacked: "Do I still own
  // the parser?" against "I no longer own the parser" took the polarity
  // penalty AND the currency penalty, 0.3 × 0.5, and fell under the floor —
  // so the engine dropped the one fact that answers the question. It answers
  // it with "no", which is exactly what the asker was checking.
  //
  // A fact that carries the question's topic words is ON TOPIC whatever its
  // polarity or tense. Those signals belong in the RANK, not in the gate. The
  // statement is rendered verbatim with its negation intact, so the reader can
  // see what it says; what must not happen is a stale or negated fact
  // outranking a current affirmative one, and demotion achieves that.
  if (lexical >= 0.5) score = Math.max(score, MIN_AFFINITY);

  return { score: Math.min(1, Math.max(0, score)), lexical, kind, polarityConflict };
}
