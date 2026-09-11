/**
 * Entity detection for CONVERSATIONAL text.
 *
 * WHY THIS EXISTS AS A SEPARATE PATH
 * ----------------------------------
 * `files/extractors.js extractEntities` finds proper nouns by looking for
 * capital letters. That is the right heuristic for documents — reports,
 * contracts and slide decks are written in sentence case — and it is exactly
 * the wrong one for chat, where people type "my brother's name is ananya
 * prabal das" and mean every word of it.
 *
 * The production consequence was severe and silent: zero entities from a
 * lowercase turn hits the early return in `conversationIngest.js`, which
 * happens BEFORE any fact is written. So a message dense with durable facts
 * produced nothing at all, and the facts that did get captured were captured
 * only because AQUA's own reply echoed the names back in title case.
 *
 * The shared extractor is deliberately NOT loosened. Lowering its bar would
 * flood the document pipeline — where capitalisation is a genuine signal —
 * with false entities, and every uploaded file would pay for a chat problem.
 * This module wraps it instead, and is imported only by conversation ingest.
 *
 * THREE PASSES, MOST CONSERVATIVE FIRST
 * ------------------------------------
 *   A. shared    the existing extractor, unmodified. Everything it finds
 *                today it still finds, including all the typed patterns
 *                (email, url, money, phone…) that never depended on case.
 *   B. known     entities this owner ALREADY has in the world model, matched
 *                case-insensitively. Zero fabrication risk — the name was
 *                established elsewhere; we are only recognising it again.
 *                This is what makes the second mention of "aquiplex" work.
 *   C. declared  a deliberately narrow set of cues where the phrasing ITSELF
 *                asserts that a proper noun follows: "his name is X", "the
 *                co-founder of X", "works at X". Only these can introduce a
 *                NEW lowercase entity, because only these carry enough signal
 *                to be worth the false-positive risk.
 *
 * Pass C is the one that can invent things, so it is kept small on purpose.
 * "i am tired" must never yield an entity called "tired" — hence no bare
 * "i am X" cue, and hence the blocklist below.
 */
import { extractEntities } from '../../files/extractors.js';
import { SELF_KIND, SELF_LABEL } from '../identity/selfEntity.js';
import { hasSelfDeclaration } from './selfDeclaration.js';

/**
 * FIRST-PERSON SELF-DISCLOSURE (U1)
 * ---------------------------------
 * "I'm building the understanding engine" resolved to nothing, because every
 * pass above looks for a NAME and there is no name in that sentence. The
 * subject is the owner, and the owner had no way to be a subject. Measured
 * cost: a realistic 8-answer "getting to know you" conversation produced 0
 * entities and 0 facts.
 *
 * WHY THIS DOES NOT BREAK THE NEVER-FUSE INVARIANT
 * ------------------------------------------------
 * `selfEntity.js` registers the self node with NO norms, on purpose, so that
 * nothing can ever resolve into it BY NAME — otherwise learning the user is
 * called Priya would quietly fuse them with any other Priya.
 *
 * That invariant is about names. `I` / `my` is not a name; it is deixis, and
 * it means the speaker whoever they are. So resolution happens HERE, in the
 * conversation extractor, on the grammar of the sentence — never in idStore,
 * and never by registering a pronoun as an alias. A negative test pins that a
 * named person still cannot reach the self node.
 *
 * FIRST-PERSON SINGULAR ONLY
 * --------------------------
 * `we` and `our` are deliberately excluded. A group claim is not an individual
 * one: "we're building X" says the team builds X and leaves the speaker's own
 * role unstated. Attributing it to the owner anyway is exactly the quiet
 * inference that puts a wrong line on a summary card.
 *
 * The grammar itself lives in `selfDeclaration.js`, not here: conversationFacts
 * needs the identical rule and is a PURE builder pinned by a structural test
 * that it cannot reach a store. This module imports the entity extractor and
 * the self-entity constants, and selfEntity imports idStore — so importing it
 * would have put persistence back inside that pure builder. The test caught
 * exactly that, which is the reason to keep such tests. Re-exported here so
 * existing callers of this module keep working.
 */
export { isSelfDeclaration, hasSelfDeclaration } from './selfDeclaration.js';
import { hasSpeakersWorld } from './selfDeclaration.js';

/** Tokens that are never an entity on their own, whatever cue precedes them. */
const BLOCK = new Set((
  // SQL keywords. A pasted query is capitalised by convention rather than
  // because it names anything, and its keywords land MID-sentence, where the
  // sentence-initial COMMON_SUBJECT guard never runs — so
  // "SELECT * FROM users WHERE id = 1" minted FROM and WHERE as entities.
  'select,from,where,insert,into,update,delete,join,inner,outer,left,right,group,order,' +
  'limit,offset,values,table,index,null,true,false,and_,or_,not_,count,sum,avg,max,min,' +
  'a,an,the,and,or,but,my,your,his,her,its,our,their,me,him,them,us,i,you,he,she,it,we,they,' +
  'this,that,these,those,here,there,now,then,very,really,quite,so,too,also,just,still,not,no,' +
  'good,bad,great,fine,okay,ok,nice,tired,busy,happy,sad,angry,sure,right,wrong,better,worse,' +
  'is,are,was,were,be,been,being,am,do,does,did,have,has,had,will,would,can,could,should,' +
  'one,two,three,some,any,all,none,more,less,most,least,much,many,' +
  'today,tomorrow,yesterday,soon,later,always,never,sometimes,often,' +
  'brother,sister,mother,father,mom,dad,friend,wife,husband,son,daughter,cousin,uncle,aunt,' +
  'work,working,school,college,home,office,thing,things,stuff,person,people,guy,man,woman'
).split(','));

/**
 * Cues whose own wording promises a proper noun next.
 * Each entry: [type, regex with ONE capture group].
 */
const DECLARATION_CUES = [
  // "my brother's name is X" / "his name is X" / "named X" / "called X"
  ['name', /\b(?:(?:my|his|her|their|the)\s+(?:[a-z]+(?:'s)?\s+)?name\s+is|name\s+is|named|called)\s+([^.,;:!?()]{2,60})/gi],
  // "the co-founder of X" / "ceo of X" — the role phrase implies an org
  ['org',  /\b(?:co-?founder|founder|ceo|cto|coo|cfo|president|director|owner|head)\s+of\s+([^.,;:!?()]{2,60})/gi],
  // "works at X" / "employed by X"
  ['org',  /\b(?:works?|working|worked|employed|interning|interned)\s+(?:at|for|by)\s+([^.,;:!?()]{2,60})/gi],
  // "founded X" — deliberately the only bare-verb cue; "started X" and
  // "joined X" were considered and rejected as too loose ("started crying").
  ['org',  /\bfounded\s+([^.,;:!?()]{2,60})/gi],
];

/* ──────────────────────────────────────────────────────────────────────────
   FUSED PRONOUNS
   ──────────────────────────────────────────────────────────────────────────
   The shared extractor's proper-noun rule reads a run of capitalised tokens as
   ONE name. `I`, `I'm`, `We're` and `Its` are capitalised, so the first thing
   almost anyone types produces a fused entity:

       "I'm Maya, I run product at Nummo"  →  I'm Maya
       "I'm Dev and I handle engineering"  →  I'm Dev
       "We're Nummo, a fintech"            →  We're Nummo
       "Hi I'm Sarah"                      →  Hi I'm Sarah

   Two costs, and the second is the worse one. The world model shows an entity
   literally called "I'm Maya"; and when the same person is mentioned plainly
   later, "Maya" resolves as a SEPARATE node, so their facts split across two
   entities that never merge.

   This is a chat problem, not a document one — prose rarely opens a sentence
   with "I'm Maya" — so it is fixed here rather than by loosening the shared
   extractor, which every uploaded file would pay for. `src/files/` stays
   byte-identical, and a test pins that the shared extractor still fuses, so
   this stays a conversation-lane repair rather than quietly becoming the
   document rule.

   DELIBERATELY NARROW. Only first-person and `it` forms are stripped. `My`
   and `Our` are left alone: "My Chemical Romance" is a real name and the
   greeting case that motivates this does not use them.
   ────────────────────────────────────────────────────────────────────────── */
const FUSED_PREFIX =
  /^(?:(?:hi|hey|hello|yo|ok(?:ay)?|so|and|but)[,\s]+)*(?:i'?m|i'?ve|i|we'?re|we'?ve|we|it'?s|its)\s+/i;

/**
 * Drop a leading pronoun the shared extractor fused into a name.
 * Returns the value unchanged when nothing is fused, or when stripping would
 * leave nothing usable — a repair that empties the name is worse than the bug.
 */
function unfusePronoun(value) {
  const v = String(value ?? '').trim();
  if (!FUSED_PREFIX.test(v)) return v;
  const stripped = v.replace(FUSED_PREFIX, '').trim();
  if (stripped.length < 2) return v;
  if (BLOCK.has(stripped.toLowerCase())) return v;
  return stripped;
}

/** Trailing filler that commonly rides along after a cue capture. */
const TRAILING_NOISE = /\s+(?:and|but|who|which|that|because|since|while|so|then|too|also)\b.*$/i;

/* ──────────────────────────────────────────────────────────────────────────
   PASS A2 — SOLO PROPER NOUNS
   ──────────────────────────────────────────────────────────────────────────
   The capitalisation work fixed the case where the user types in lowercase.
   It did not fix the case where they type NORMALLY, and that turned out to be
   the larger hole. `files/extractors.js` keeps a bare proper noun only when:

       if (count >= 2 || v.includes(' '))

   i.e. a single-word name must be said TWICE, or be two words, to survive.
   That is a sound dedup heuristic for a 40-page document, where a one-off
   capitalised word is usually a heading artefact. A chat message is one
   sentence. Measured against the shared extractor, every one of these
   returned zero entities:

       "Razorpay is our main competitor"
       "Dev handles engineering at Nummo"
       "Nummo is based in Bangalore"
       "I moved to the Bangalore office last month"

   So the world model stayed empty even for a user typing in perfect sentence
   case. The extractor is still NOT loosened — every uploaded document would
   pay for it, and a test pins that it must not be. This pass runs only here.

   TWO TIERS, BECAUSE POSITION IS THE WHOLE SIGNAL
   ----------------------------------------------
   Mid-sentence, a capital letter in chat is deliberate: nobody capitalises
   "office" in the middle of a line by accident. That tier is accepted on the
   blocklist alone.

   Sentence-initially, the capital is grammar, not evidence — "Payments are
   our biggest cost" starts with a capital for the same reason "Razorpay is
   our main competitor" does. Tier 2 therefore demands a naming predicate
   (`X is/was/are/were/has/have/had …`) AND that the word is not an ordinary
   subject noun. That list is finite and this is its honest failure mode: an
   unusual domain noun opening a sentence with `is` can mint an entity. Both
   directions are pinned by tests so the tradeoff stays visible rather than
   becoming folklore.
   ────────────────────────────────────────────────────────────────────────── */

/** A capitalised word: ≥3 chars, may carry internal caps/digits (GitHub, K8s). */
const SOLO_RE = /[\p{Lu}][\p{L}\p{N}'’-]{2,}/gu;

/** Contractions that are not possessives — "I'm", "we've", "don't". */
const CONTRACTION_TAIL = /['’](?:t|m|re|ve|ll|d)$/i;

/** Calendar words. Capitalised by convention, never an entity worth a node. */
const CALENDAR = new Set((
  'monday,tuesday,wednesday,thursday,friday,saturday,sunday,' +
  'january,february,march,april,may,june,july,august,september,october,november,december,' +
  'jan,feb,mar,apr,jun,jul,aug,sep,sept,oct,nov,dec,mon,tue,tues,wed,thu,thur,thurs,fri,sat,sun'
).split(','));

/**
 * Ordinary subjects — words that routinely open a sentence with a naming
 * predicate and are NOT names. Only consulted for tier 2, where sentence-
 * initial capitalisation carries no information.
 */
const COMMON_SUBJECT = new Set((
  // pronouns, determiners, discourse openers
  'the,this,that,these,those,there,here,everything,everyone,someone,nobody,nothing,anything,' +
  'yes,yeah,yep,nope,sure,also,but,and,however,anyway,actually,honestly,basically,maybe,' +
  'today,tomorrow,yesterday,tonight,now,then,next,last,first,second,third,' +
  // generic work / product nouns
  'work,working,team,teams,product,products,project,projects,company,startup,business,' +
  'pricing,price,prices,payment,payments,billing,revenue,cost,costs,budget,margin,' +
  'growth,churn,retention,onboarding,activation,conversion,engagement,usage,' +
  'user,users,customer,customers,client,clients,merchant,merchants,people,staff,' +
  'engineering,design,marketing,sales,support,ops,finance,legal,hiring,recruiting,' +
  'data,code,tests,testing,docs,documentation,api,apis,backend,frontend,database,' +
  'performance,latency,security,privacy,quality,reliability,scale,scaling,infra,' +
  'meeting,meetings,standup,sprint,roadmap,backlog,ticket,tickets,bug,bugs,issue,issues,' +
  'deadline,launch,release,version,feature,features,plan,plans,goal,goals,problem,problems,' +
  'question,questions,answer,answers,idea,ideas,thing,things,stuff,part,point,reason,' +
  'everybody,most,some,many,few,both,either,neither,each,every,another,other,others,' +
  // Interrogatives. A closed function-word class, and never a name — but they
  // are sentence-initial and capitalised, so broadening the Tier-2 verb test
  // began minting "What" and "Why" as entities.
  'what,why,how,who,whom,whose,when,where,which,whether,' +
  // SQL keywords. A pasted query is capitalised by convention, not because it
  // names anything: "SELECT * FROM users WHERE id = 1" yielded FROM and WHERE.
  'select,from,where,insert,update,delete,join,group,order,limit,values,table,null,true,false'
).split(','));

/** True when the character before `index` ends a sentence (or starts the text). */
function isSentenceInitial(text, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') continue;
    if (ch === '\n' || ch === '\r') return true;
    return ch === '.' || ch === '!' || ch === '?' || ch === '•' || ch === '-' || ch === '"' || ch === '“';
  }
  return true;
}

/** The sentence-initial naming predicate: "Razorpay is …", "Nummo's team was …". */
const NAMING_PREDICATE = /^(?:['’]s\s+\w+\s+|['’]s\s+)?\s*(?:is|was|are|were|has|have|had)\b/i;

/**
 * Irregular past-tense and 3rd-person forms — a CLOSED CLASS in English.
 *
 * Listing them is not corpus-fitting the way a list of domain nouns would be:
 * English has a finite, well-documented set of strong verbs and it has not
 * grown in centuries. Regular forms are caught morphologically below.
 */
const IRREGULAR_VERB = new Set((
  'said,told,met,left,built,wrote,sent,got,came,began,won,lost,kept,held,found,knew,' +
  'thought,brought,bought,ran,led,grew,drew,spoke,chose,rose,fell,paid,sold,took,made,' +
  'gave,went,did,saw,set,put,let,quit,cut,read,cost,hit,shut,split,spread,became,began'
).split(','));

/**
 * Does a subject stand in front of this text?
 *
 * WHY THE COPULAR TEST ALONE WAS NOT ENOUGH
 * -----------------------------------------
 * Tier 2 admitted a sentence-initial capitalised word only when `is/was/are/
 * were/has/have/had` followed it. That is a sound test for "Razorpay is our
 * competitor" and it silently rejected every person who does something:
 *
 *     "Dev reports to me."                → `reports`    rejected
 *     "Rahul joined the billing team."    → `joined`     rejected
 *     "Maya introduced me to an investor."→ `introduced` rejected
 *
 * Measured on `extraction-core.v1`, subject recall for NAMED (third-person)
 * subjects was 18.1% against 58.9% for the speaker. Colleagues, reports and
 * counterparties are most of the user's world, and the lane could not see them
 * unless the sentence happened to be copular.
 *
 * A subject is followed by a FINITE VERB, not specifically by a copula. This
 * tests for one morphologically — 3rd-person `-s`, regular past `-ed`, or a
 * member of the closed irregular class — which generalises to verbs nobody
 * thought to list rather than to the ones present in a dataset.
 *
 * THE FALSE-POSITIVE RISK IS REAL AND IS HELD BY A DIFFERENT GUARD.
 * "Latency increased last week" would mint `Latency` as a name. That is what
 * COMMON_SUBJECT is for, and this change makes that list load-bearing rather
 * than a second opinion — which is why the blocklist is extended alongside it
 * and why `silence_on_negatives` is checked as carefully as recall. A bad
 * entity is worse than a missing one: it becomes a node other turns attach
 * facts to.
 */
function subjectPrecedes(rest) {
  if (NAMING_PREDICATE.test(rest)) return true;
  const m = rest.match(/^(?:['’]s)?\s+([a-z][a-z'’-]{1,})\b/i);
  if (!m) return false;
  const w = m[1].toLowerCase();
  if (IRREGULAR_VERB.has(w)) return true;
  // Regular finite forms. `-ing` is excluded: "Payments processing failed"
  // has a participle after the candidate and no subject relation at all.
  if (/(?:ed|es|s)$/.test(w) && w.length > 3 && !/(?:ss|us|is|ous)$/.test(w)) return true;
  return false;
}

/**
 * Solo capitalised proper nouns the shared extractor discarded.
 *
 * @param {string} text
 * @param {Set<string>} covered  lowercased values already found by other passes,
 *                               plus the individual words of any multi-word
 *                               name — so "Nummo Technologies" does not also
 *                               emit a competing "Nummo" node.
 * @returns {Array<{type:string, value:string}>}
 */
function soloProperNouns(text, covered) {
  const out = [];
  const seen = new Set();
  SOLO_RE.lastIndex = 0;
  for (const m of text.matchAll(SOLO_RE)) {
    const raw = m[0];
    if (CONTRACTION_TAIL.test(raw)) continue;

    const value = raw.replace(/['’]s$/i, '');           // possessive → bare name
    const lower = value.toLowerCase();
    if (value.length < 3) continue;
    if (seen.has(lower) || covered.has(lower)) continue;
    if (BLOCK.has(lower) || CALENDAR.has(lower)) continue;

    if (isSentenceInitial(text, m.index)) {
      // Tier 2 — capitalisation proves nothing here.
      if (COMMON_SUBJECT.has(lower)) continue;
      const rest = text.slice(m.index + raw.length);
      if (!subjectPrecedes(rest)) continue;
    }

    seen.add(lower);
    out.push({ type: 'name', value });
  }
  return out;
}

/**
 * Clean one cue capture into an entity value, or null if it fails the bar.
 * Kept strict: a bad entity is worse than a missing one, because it becomes a
 * node other turns can attach facts to.
 */
function refineCapture(raw) {
  if (!raw) return null;

  let v = String(raw).trim().replace(TRAILING_NOISE, '').trim();
  // Drop a leading article — "the aquiplex team" → "aquiplex team".
  v = v.replace(/^(?:a|an|the)\s+/i, '').trim();
  if (!v) return null;

  // Proper nouns in speech are short. Beyond four tokens this is a clause.
  const tokens = v.split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 4) return null;

  // Every token must look like a word, not punctuation or a number blob.
  if (!tokens.every(t => /^[\p{L}][\p{L}\p{N}'’.-]*$/u.test(t))) return null;

  // Reject if ANY token is blocked. Requiring all-clear (rather than
  // majority) is what keeps "my brother" and "tired" out.
  if (tokens.some(t => BLOCK.has(t.toLowerCase().replace(/['’.]+$/, '')))) return null;

  const value = tokens.join(' ');
  return value.length >= 3 ? value : null;
}

/** Escape a known name for safe use inside a RegExp. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Entities for a conversational turn.
 *
 * @param {string} text                    user + assistant text for the turn
 * @param {object} opts
 * @param {Array}  opts.knownEntities      [{ value, type }] already in the world
 *                                         model for this owner (labels + aliases)
 * @param {number} opts.limit              hard cap on returned entities
 * @param {string} [opts.selfText]         the USER's message alone. Only this is
 *                                         examined for first-person disclosure —
 *                                         reading AQUA's own "I can help with…"
 *                                         as the user's self-description would
 *                                         manufacture evidence out of our own
 *                                         output. Omit to disable pass D.
 * @returns {Array<{type,value,count,source}>}
 */
export function extractConversationEntities(text, { knownEntities = [], limit = 40, selfText = null } = {}) {
  if (!text || typeof text !== 'string') return [];

  const found = new Map();          // `${type}:${lowercased}` → entity
  // Keyed on the VALUE, not `type:value`. Keying on both meant one company
  // could arrive twice under two labels — "I work at Intercom" produced
  // `Intercom:name` from the solo pass AND `Intercom:org` from the declaration
  // cue, which is two graph nodes for one employer with its facts split
  // between them. Same defect class as the fused pronoun above: one thing,
  // two nodes, never merging.
  //
  // When a later pass carries a MORE SPECIFIC type, it wins and the count
  // carries over — `name` is the extractor's fallback when it recognised a
  // proper noun but nothing about it, so anything else is better information.
  const SPECIFICITY = { name: 0 };
  const add = (type, value, source) => {
    const v = String(value).trim();
    if (!v) return;
    const k = v.toLowerCase();
    const existing = found.get(k);
    if (existing) {
      existing.count += 1;
      if ((SPECIFICITY[type] ?? 1) > (SPECIFICITY[existing.type] ?? 1)) {
        existing.type = type;
        existing.source = source;
      }
      return;
    }
    found.set(k, { type, value: v, count: 1, source });
  };

  // ── Pass A — the shared document extractor, untouched ────────────────────
  for (const e of extractEntities(text, { limit })) {
    add(e.type, unfusePronoun(e.value), 'shared');
  }

  // ── Pass A2 — solo proper nouns the document dedup rule discarded ────────
  // Runs on what Pass A already found so a multi-word name suppresses its own
  // parts: "Nummo Technologies" must not also produce a rival "Nummo".
  const covered = new Set();
  for (const e of found.values()) {
    const v = String(e.value).toLowerCase();
    covered.add(v);
    for (const w of v.split(/\s+/)) if (w) covered.add(w);
  }
  for (const e of soloProperNouns(text, covered)) add(e.type, e.value, 'solo');

  // ── Pass B — recognise what this owner already knows, ignoring case ──────
  const lower = text.toLowerCase();
  for (const known of knownEntities) {
    const name = String(known?.value ?? '').trim();
    if (name.length < 3) continue;
    // THE INVARIANT, enforced where it can actually be relied on. The self
    // entity is matched by GRAMMAR (pass D) and never by surface form — its
    // label is the literal word "You", so a surface match turns "thank you"
    // into a resolved entity and a stored fact. `knownEntitiesFor` also
    // declines to offer it, but that is a convenience reader and any caller
    // can supply its own list; this is the line that makes the contract hold
    // regardless of who is calling.
    if ((known?.type ?? 'name') === SELF_KIND) continue;
    const key = `${known.type ?? 'name'}:${name.toLowerCase()}`;
    if (found.has(key)) continue;
    // Word-boundary match so "ai" does not fire inside "aircraft".
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${esc(name.toLowerCase())}(?:[^\\p{L}\\p{N}]|$)`, 'u');
    if (re.test(lower)) {
      // Emit the CANONICAL casing, not the user's lowercase rendering, so the
      // resolver merges this onto the existing node instead of forking one.
      add(known.type ?? 'name', name, 'known');
    }
  }

  // ── Pass C — declaration cues can introduce something new ────────────────
  for (const [type, re] of DECLARATION_CUES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const value = refineCapture(m[1]);
      if (!value) continue;
      // No skip. `add()` is keyed on the value and keeps the FIRST casing it
      // saw — so Pass B's canonical form still wins, which is what the skip
      // was protecting — while still letting a declaration cue upgrade the
      // TYPE. Skipping here meant "I work at Intercom" stayed `name` because
      // the solo pass got there first, and `org` is the better information:
      // `name` is only what the extractor says when it recognised a proper
      // noun and nothing about it.
      add(type, value, 'declared');
    }
  }

  // ── Pass D — the speaker, when they said something about themselves ──────
  // Emitted LAST so it can never displace a named entity out of the cap, and
  // marked `isSelf` so the caller routes it to the owner's existing self node
  // rather than resolving a new entity called "You".
  // The WIDER predicate: the speaker must become a subject on plural turns
  // too, or the fact builder has nothing to attach "our biggest problem is
  // churn" to and the sentence is discarded before it is ever considered.
  // Still deixis, never a name — the never-fuse invariant is untouched.
  if (selfText && hasSpeakersWorld(selfText)) {
    found.set(SELF_LABEL.toLowerCase(), {
      type: SELF_KIND, value: SELF_LABEL, count: 1, source: 'self', isSelf: true,
    });
  }

  return [...found.values()]
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit);
}

/**
 * Read the owner's existing entity names out of the world model, for Pass B.
 * Separated so the extractor itself stays pure and testable without a graph.
 */
export function knownEntitiesFor(G, ownerId, { limit = 500 } = {}) {
  if (!G?.nodesByType || !ownerId) return [];
  const out = [];
  try {
    for (const node of G.nodesByType(ownerId, 'entity')) {
      const label = String(node.label ?? '').trim();
      const type = node.data?.entityType ?? 'name';
      // THE SELF NODE IS NEVER A KNOWN ENTITY FOR PASS B.
      //
      // Its label is the literal word "You", and pass B is a case-insensitive
      // surface match — so once `AQUA_SELF_ENTITY` created the node, every
      // message containing "you" resolved it as a NAMED entity with
      // `isSelf: false`. Three consequences, all measured:
      //
      //   • it entered `surfaceFormIndex` (which only skips `isSelf` entities),
      //     substring-matched "you", and wrote a fact for any sentence with the
      //     word in it — "thank you" became a stored fact about the user
      //   • it forked a SECOND `You` node in the graph beside the real one
      //   • it bypassed the contract this module documents: the self entity is
      //     matched by GRAMMAR (pass D), never by surface form, precisely
      //     because a token like "you" fires inside almost every sentence
      //
      // Same root as the retrieval-noise finding: the label "You" is a
      // stopword wearing an entity's clothes. Excluded here, at the one place
      // that hands surface forms to a matcher.
      if (node.data?.entityType === SELF_KIND) continue;
      if (label.length >= 3) out.push({ value: label, type });
      for (const alias of node.data?.aliases ?? []) {
        const a = String(alias ?? '').trim();
        if (a.length >= 3) out.push({ value: a, type });
      }
      if (out.length >= limit) break;
    }
  } catch { /* fail-open: no known entities is a degraded pass, not an error */ }
  return out;
}
