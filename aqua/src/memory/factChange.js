/**
 * Changes to free-text facts (2026-10-29).
 *
 * The legacy store keys a free-text fact by the words the user used for it
 * (`my thesis is due on May 30` → custom_thesis), and replaced it only when a
 * later turn produced the SAME key. People do not restate a change that way:
 *
 *   "The thesis deadline moved to June 13."           → no key at all
 *   "My supervisor is now Dr. Raj Patel."             → custom_supervisor (beside custom_dissertation_supervisor)
 *   "Jonas Weber retired; my new accountant is Aylin." → custom_new_accountant (beside custom_accountant)
 *
 * so the profile — which tells the model to rely on it — kept the old value
 * as current (legacy replay of three development personas, 2026-10-29).
 *
 * Two rules, both conservative. A change lands on a stored fact only when the
 * statement names exactly one; anything ambiguous is left alone, so an
 * unrelated fact is never overwritten by recency. The write is an explicit
 * correction through the normal conflict-resolved path, which keeps the old
 * value in the fact's version history (longTermMemory buildVersionHistory),
 * and memoryObserve's step 4b then retires the old sentence from the
 * conversation lane. The user's original words stay in their conversations.
 */

import { clausesOf, changeKind, subjectShared, namesOf, transitionOf, stem, sentencesIn } from '../understanding/stateTransition.js';

/** Words that say WHICH aspect of a thing changed, not which thing. */
const ASPECT = new Set(['deadline', 'date', 'due', 'time', 'day', 'schedule']);
const FILLER = new Set(['the', 'my', 'our', 'of', 'for', 'a', 'an', 'to', 'on', 'at', 'in']);
const CHANGE_MARK = /^(?:new|current|latest|present)_/;

/** A calendar date in prose: "June 13", "13 June", "Dec 16th", "2026-06-13". */
const DATE = /\b(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2})\b/i;

const words = s => String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const thingWords = s => words(s).filter(w => !ASPECT.has(w) && !FILLER.has(w));
const keyWords = key => thingWords(String(key).replace(/^custom_/i, '').replace(/_/g, ' '));
const sameSet = (a, b) => a.length === b.length && a.every(w => b.includes(w));

/**
 * Re-key extracted free-text facts that state a CHANGE onto the stored fact
 * they change. `my X is now Y` and `my new X is Y` replace X; X resolves to the
 * stored key with the same words, else to the ONE stored free-text key ending
 * in the same head noun ("supervisor" → custom_dissertation_supervisor), else
 * stays new. Returns new candidate objects; non-changes pass through untouched.
 */
export function onto(candidates, stored) {
  const custom = stored.filter(f => /^custom_/i.test(f.key));
  return candidates.map(c => {
    if (c.extractor !== 'custom_fallback' || typeof c.value !== 'string') return c;
    const bare = c.key.replace(/^custom_/i, '');
    const nowValue = /^now\s+/i.test(c.value);
    const marked = CHANGE_MARK.test(bare);
    if (!nowValue && !marked) return c;
    const value = c.value.replace(/^now\s+/i, '').trim();
    const subject = keyWords(bare.replace(CHANGE_MARK, ''));
    const exact = custom.filter(f => sameSet(keyWords(f.key), subject));
    const head = subject.at(-1);
    const byHead = exact.length ? exact
      : custom.filter(f => { const k = keyWords(f.key); return k.at(-1) === head && subject.every(w => k.includes(w)); });
    const key = byHead.length === 1 ? byHead[0].key : `custom_${subject.join('_')}`;
    return { ...c, key, value, normalizedValue: value, isCorrection: true, reason: 'free_text_change' };
  });
}

/* ── The user's later word on a stored fact (2026-11-02) ──────────────────────
   The two rules above replace a value only when the new one can be read off
   exactly. Everything else the user says about a stored fact left it as
   current, under "rely on this profile": "I resigned from Hartwell" beside
   "Company: Hartwell Bank", "I sold the Civic" beside "car: a 2012 Honda
   Civic", "Now Mellow is my biggest client" beside "biggest client: Oakline",
   "Derek Shaw moved to another branch" beside "bank contact: Derek Shaw",
   "We relocated to Bristol" beside "City: Leeds", "I raised my day rate to 720
   euros for new clients" beside "day rate: 650 euros" (profile dev set: 7 of
   10 change questions).

   The same reading the Mind's working state uses (understanding/stateTransition
   `changeKind`): a clause that resolves, ends or changes — not negated, not
   speculative or hypothetical — about ONE stored fact. The fact is not
   rewritten (the new value is often not readable off the sentence, or is
   partial: 650 still holds for existing clients); it carries the user's words
   as its later word, the profile shows them beside it, and the old value
   stays as what was true before. "About" = two shared subject words, or a name
   from the fact's value, or (the one slot rule) a relocation stated in the
   past tense for the city; and exactly one fact qualifies — anything
   ambiguous is left alone. */

/** Never annotated: who the user IS called. */
const NAME_KEYS = new Set(['name', 'preferred_name', 'aliases', 'pronouns']);
const FIRST_PERSON = /\b(?:i|we|i'm|we're|i've|we've|my|our|me|us)\b/i;

/**
 * WHOSE change is it? The user's ("I resigned from Hartwell", "my biggest
 * client is now Mellow"), or the fact's own thing's ("Derek Shaw moved to
 * another branch", "Oakline got the keys") — never a third party's: "Mei Tan
 * left Coinwise" is not the user leaving Coinwise, and "Imran will be the lead
 * for Splitpay from now on" does not change the user's project (v3 dev, found
 * reading every annotation, 2026-11-02). The thing is the subject when one of
 * the fact value's names is among the clause's first three words.
 */
function changeIsOwn(clause, f) {
  if (FIRST_PERSON.test(clause)) return true;
  const head = clause.replace(/^(?:now|so|and|but|then|also|good news|bad news)[,:]?\s+/i, '').split(/\s+/).slice(0, 3).join(' ');
  const names = namesOf(typeof f.value === 'string' ? ` ${f.value}` : subjectOf(f));
  return subjectShared(head, subjectOf(f)).some(w => names.has(w));
}
const RELOCATED = /\b(?:moved|relocated)\s+(?:back\s+)?to\s+\p{Lu}/u;
const CITY_KEYS = new Set(['city', 'location', 'hometown']);
/** The user's own employment, stated: "I now work at Northbeam", "I'm a senior analyst at Northbeam", "I joined Stripe". */
const ORG = '(\\p{Lu}[\\p{L}\\p{N}&.\'’-]*(?:\\s+\\p{Lu}[\\p{L}\\p{N}&.\'’-]*){0,3})';
// Case-sensitive on purpose — the organisation must be written as a name — so
// the pronoun is spelled [Ii].
const EMPLOYED = new RegExp(`\\b[Ii]\\s+(?:now\\s+|just\\s+)?(?:work|am\\s+working)\\s+(?:at|for)\\s+${ORG}|\\b[Ii](?:'m|’m|\\s+am)\\s+(?:now\\s+)?(?:a|an)\\s+[\\p{L}\\s-]{2,40}?\\s+at\\s+${ORG}|\\b[Ii]\\s+(?:just\\s+)?(?:joined|started\\s+at)\\s+${ORG}`, 'u');
const ROLE_IN = /\b(?:as\s+(?:a|an)|[Ii](?:'m|’m|\s+am)\s+(?:now\s+)?(?:a|an))\s+([\p{L}][\p{L}\s-]{2,40}?)(?=\s+(?:at|for|in)\b|[.,;!?]|$)/u;
const WORK_KEYS = new Set(['workplace', 'organization']);

/** The words a fact is about: its key's words and its value. */
function subjectOf(f) {
  const v = typeof f.value === 'string' ? f.value : Array.isArray(f.value) ? f.value.map(x => (typeof x === 'object' ? x?.name ?? '' : String(x))).join(' ') : '';
  return `${String(f.key).replace(/^custom_/i, '').replace(/_/g, ' ')} ${v}`;
}

/**
 * Later words in this message on stored facts. Pure.
 * @returns {{ key, text, kind, at }[]} — at most one per fact; none when ambiguous
 */
export function laterWordsOnFacts(message, facts, { now = Date.now() } = {}) {
  const out = [];
  const pool = (facts ?? []).filter(f => f && !NAME_KEYS.has(f.key) && f.value != null && f.value !== '');
  for (const clause of clausesOf(message)) {
    const kind = changeKind(clause);
    if (!kind) continue;
    // An open state is a STATUS, not a new value: "Now the San Antonio opening
    // is blocked by a zoning permit" does not change the goal of opening it
    // (the Mind's working memory holds blockers).
    if (kind === 'changed' && transitionOf(clause).pending) continue;
    let hits = pool.filter(f => {
      if (String(f.sourceText ?? '').includes(clause)) return false;   // the sentence that stated it
      if (!changeIsOwn(clause, f)) return false;
      const shared = subjectShared(clause, subjectOf(f));
      if (shared.length >= 2) return true;
      const names = namesOf(typeof f.value === 'string' ? ` ${f.value}` : subjectOf(f));
      if (shared.some(w => names.has(w))) return true;
      if (CITY_KEYS.has(f.key) && kind === 'changed' && RELOCATED.test(clause)) return true;
      return WORK_KEYS.has(f.key) && kind === 'changed' && EMPLOYED.test(clause);
    });
    // A slot rule says outright which fact it is about ("I now work at
    // Northbeam" → workplace; "relocated to Bristol" → city): it wins over
    // facts that only share words — the goal "get promoted to senior analyst
    // at Fintrail" shares "senior analyst" and made the move ambiguous
    // (architecture probe, 2026-11-02).
    if (hits.length > 1) {
      const bySlot = hits.filter(f => (WORK_KEYS.has(f.key) && EMPLOYED.test(clause)) || (CITY_KEYS.has(f.key) && RELOCATED.test(clause)));
      if (bySlot.length === 1) hits = bySlot;
    }
    // The slot NAMED in full wins over a fact matched by its value: "Mellow is
    // now my biggest client" is about `biggest client`, not about `newest
    // client: Mellow` (current-state dev set, 2026-11-02).
    if (hits.length > 1) {
      const named = hits.filter(f => { const k = keyWords(f.key); return k.length && subjectShared(clause, k.join(' ')).length === new Set(k.map(w => w)).size; });
      if (named.length === 1) hits = named;
    }
    if (hits.length !== 1) continue;
    const [f] = hits;
    if (out.some(o => o.key === f.key)) continue;
    // The clause decides WHETHER; the note carries the user's whole sentence,
    // which often holds the new value: "Derek Shaw moved to another branch; our
    // new loan officer is Kim Alvarez."
    const sentence = sentencesIn(message).find(s => s.includes(clause)) ?? clause;
    out.push({ key: f.key, text: sentence.replace(/\s+/g, ' ').trim().slice(0, 200), clause, kind, at: now });
  }
  return out;
}

/* ── From later word to current state (2026-11-02) ─────────────────────────────
   A later word used to stay a NOTE beside the old value ("Company: Hartwell
   Bank (since changed — …)"), leaving the model to work out what is true now.
   Most later words say it outright. Each linked later word is resolved to:

     replace   a new value for the same slot, stated in the sentence
               ("our new loan officer is Kim Alvarez", "Mellow is now my
               biggest client", "relocated to Bristol", "I now work at
               Northbeam", "sold my Civic and bought a used Tesla Model 3")
     scoped    the new value is NARROWER than the stored one ("720 euros for
               new clients"): its own fact; the broader one stands untouched
     end       the state ended and nothing replaces it ("I no longer work at
               Hartwell", "I sold my Civic", "I passed the CFA exam")
     uncertain the ending may not be the user's own ("We sold the Civic" when
               the fact is "MY car"): kept current, flagged
     note      changed, new value not stated: the old note, honest about it

   Values are read from the user's sentence only, never inferred; a value
   that is a pronoun or empty is not a value. */

const VALUE = '([\\p{L}\\p{N}$€£][\\p{L}\\p{N}&.\'’$€£,\\- ]{0,48}?)';
const VALUE_END = '(?=\\s*(?:[.;!?]|,\\s|$)|\\s+(?:and|but|because|so|since|after|from|this|last|next|in|on|as|instead|now)\\b)';
const NEW_SLOT = new RegExp(`\\b(?:my|our)\\s+new\\s+([\\p{L}\\s'-]{2,40}?)\\s+(?:is|are|will\\s+be|'s)\\s+${VALUE}${VALUE_END}`, 'iu');
const IS_NOW_MY = new RegExp(`^(?:now,?\\s+)?${VALUE}\\s+is\\s+(?:now\\s+)?(?:my|our)\\s+(?:new\\s+)?([\\p{L}\\s'-]{2,40}?)(?=[.;,!?]|$|\\s+(?:and|but)\\b)`, 'iu');
const MY_IS_NOW = new RegExp(`\\b(?:my|our)\\s+([\\p{L}\\s'-]{2,40}?)\\s+is\\s+now\\s+${VALUE}${VALUE_END}`, 'iu');
const MOVED_TO_PLACE = new RegExp(`\\b(?:moved|relocated)\\s+(?:back\\s+)?to\\s+(\\p{Lu}[\\p{L}.'’-]*(?:\\s+\\p{Lu}[\\p{L}.'’-]*){0,2})`, 'u');
const REPLACED_WITH = new RegExp(`\\b(?:bought|got|switched\\s+to|replaced\\s+(?:it|him|her|them)\\s+with|went\\s+with|signed\\s+with|hired)\\s+${VALUE}${VALUE_END}`, 'iu');
// A pronoun at the head is a reference, not a value: "bought IT back" names nothing new.
const NOT_A_VALUE = /^(?:it|him|her|them|that|this|those|these|one|another|someone|something|nothing|none|anything|the same|a new one|new one)\b/i;
/** Narrower than the stored value: "for new clients", "for weekend jobs", "only for enterprise accounts". */
const SCOPE = /\b(?:(?:only\s+)?(?:for|with|to|on)\s+(?:new|existing|future|returning|some|certain|enterprise|small|large|weekend|weekday|international|local|repeat)\b[\p{L}\s-]{0,25}|only\s+(?:for|on|at|in)\s+[\p{L}\s-]{2,25})/iu;

// The sentence's own full stop is not part of the value: "We moved back to Austin." stored "Austin.".
const clean = v => String(v ?? '').replace(/^(?:a|an|the)\s+(?=\p{Lu})/u, '').replace(/[\s,.;:!?]+$/, '').trim();
const slotMatches = (slot, f) => subjectShared(slot, keyWords(f.key).join(' ')).length > 0;

/**
 * Resolve one later word (laterWordsOnFacts) on its fact. Pure.
 * @returns {{ action: 'replace'|'scoped'|'end'|'uncertain'|'note', value?, scope?, also?: {key, value}[] }}
 */
export function resolveCurrentState(lw, fact) {
  const sentence = String(lw?.text ?? '');
  const clause = String(lw?.clause ?? sentence);
  const valid = v => { const c = clean(v); return c.length >= 2 && !NOT_A_VALUE.test(c) && norm(c) !== norm(fact?.value) ? c : null; };
  const scoped = (value, after) => {
    const s = String(after ?? '').match(SCOPE);
    return s ? { action: 'scoped', value, scope: s[0].replace(/^only\s+/i, '').trim() } : null;
  };

  // The narrower-value case, before anything replaces: "I raised my day rate
  // to 720 euros for new clients" — the 650 for everyone else stands.
  const ch = sentence.match(MOVED) ?? sentence.match(CHANGED_MY);
  if (ch && slotMatches(ch[1], fact)) {
    const kind = [DATE, AMOUNT].find(re => re.test(ch[2]));
    if (kind) {
      const span = ch[2].match(kind)[0].trim();
      const rest = ch[2].slice(ch[2].indexOf(span) + span.length);
      const sc = scoped(span, rest);
      if (sc) return sc;
    }
  }

  let value = null;
  if (WORK_KEYS.has(fact?.key)) value = valid(sentence.match(EMPLOYED)?.slice(1).find(Boolean));
  if (!value && CITY_KEYS.has(fact?.key)) value = valid(sentence.match(MOVED_TO_PLACE)?.[1]);
  for (const re of [NEW_SLOT, MY_IS_NOW]) {
    if (value) break;
    const m = sentence.match(re);
    if (m && slotMatches(m[1], fact)) value = valid(m[2]);
  }
  if (!value) { const m = clause.match(IS_NOW_MY); if (m && slotMatches(m[2], fact)) value = valid(m[1]); }
  // "I sold my Civic and bought a used Tesla Model 3": the replacement of an ENDED thing.
  // "…and bought it back" refers to the same thing again: neither a new value
  // nor an ending — kept current, flagged.
  const replacedWith = lw?.kind === 'ended' ? sentence.match(REPLACED_WITH)?.[1] : null;
  if (!value && replacedWith) {
    value = valid(replacedWith);
    if (!value) return { action: 'uncertain' };
  }

  if (value) {
    const after = sentence.slice(sentence.indexOf(value) + value.length);
    const sc = scoped(value, after.split(/[.;!?]/)[0]);
    if (sc) return sc;
    const also = [];
    if (WORK_KEYS.has(fact.key)) { const role = sentence.match(ROLE_IN)?.[1]?.trim(); if (role) also.push({ key: 'profession', value: role }); }
    return { action: 'replace', value, also };
  }
  if (lw?.kind === 'ended' || lw?.kind === 'resolved') {
    // "We sold the Civic" on MY car: perhaps another one — do not end it.
    const mine = /\b(?:my|i|i'm|i've)\b/i.test(String(fact?.sourceText ?? ''));
    const ours = /\b(?:we|our|us)\b/i.test(clause) && !/\b(?:i|my|me|i'm|i've)\b/i.test(clause);
    return mine && ours ? { action: 'uncertain' } : { action: 'end' };
  }
  return { action: 'note' };
}

const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/* ── Preference evolution (2026-11-02) ────────────────────────────────────────
   Preferences are a collection, merged, so "I prefer short bullet-point
   answers" after "I prefer long, detailed answers with lots of background"
   left BOTH as current. A preference about the same thing — same head noun
   ("answers") — in the same context (scope in parentheses, or none) is the
   later word on the earlier one; any other pair is two preferences ("short
   answers" and "a warm tone (for emails)" both stand). */
const scopeOfPref = v => (String(v).match(/\(([^)]*)\)\s*$/)?.[1] ?? '').toLowerCase().trim();
function headOfPref(v) {
  const core = String(v).replace(/\([^)]*\)\s*$/, '').split(/\s+(?:with|for|over|in|on|at|that|which|when|from|about)\b/i)[0];
  const words = core.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean);
  return words.length ? stem(words.at(-1)) : '';
}
/** Does preference `newer` supersede `older`? Pure. */
export function preferenceSupersedes(newer, older) {
  if (!newer || !older || norm(newer) === norm(older)) return false;
  const h = headOfPref(newer);
  return h.length >= 3 && h === headOfPref(older) && scopeOfPref(newer) === scopeOfPref(older);
}

/** An amount: "720 euros", "$1,200", "15%", "40 hours". */
const AMOUNT = /(?:[$€£₹]\s?)?\b\d[\d,]*(?:\.\d+)?(?:\s?(?:k|%|percent|euros?|dollars?|usd|eur|gbp|chf|rupees?|inr|pounds?|hours?|days?|weeks?|months?|years?|users?|people)\b|%)?/i;

const CHANGE_VERB = '(?:moved|changed|shifted|pushed(?:\\s+back)?|postponed|rescheduled|delayed|bumped(?:\\s+up)?|brought\\s+forward|extended|slipped|raised|increased|lowered|reduced|cut|dropped|upped)';
/** "The thesis deadline moved to June 13." — subject, then the new value. */
const MOVED = new RegExp(`\\b(?:my|the|our)\\s+([\\p{L}\\p{N}][\\p{L}\\p{N}\\s'-]{1,60}?)\\s+(?:has\\s+been\\s+|have\\s+been\\s+|was\\s+|were\\s+|got\\s+|has\\s+|is\\s+(?:being\\s+)?)?${CHANGE_VERB}\\s+(?:back\\s+)?(?:to|until|till)\\s+([^.;!?]+)`, 'iu');
/** "I raised my day rate to 720 euros." — the user as the one who changed it. */
const CHANGED_MY = new RegExp(`\\b(?:i|we)\\s+(?:have\\s+|just\\s+|finally\\s+)?${CHANGE_VERB}\\s+(?:my|our)\\s+([\\p{L}\\p{N}][\\p{L}\\p{N}\\s'-]{1,60}?)\\s+(?:to|until|till)\\s+([^.;!?]+)`, 'iu');

/**
 * Date and amount changes to a stored free-text fact, stated without
 * "my X is": "The thesis deadline moved to June 13" updates custom_thesis
 * "due on May 30" → "due on June 13"; "I raised my day rate to 720 euros"
 * updates custom_day_rate "650 euros" → "720 euros". Applies only when the
 * subject's thing-words equal ONE stored free-text key's words and the old
 * value holds the same kind of span as the new one — that span is what is
 * replaced, so the rest of what the user said ("due on") is kept.
 *
 * @returns {{ key, category, value, previous, sentence }[]}
 */
export function detectFactChanges(message, stored) {
  const out = [];
  const custom = stored.filter(f => /^custom_/i.test(f.key) && typeof f.value === 'string');
  for (const sentence of String(message ?? '').split(/(?<=[.!?])\s+/)) {
    const m = sentence.match(MOVED) ?? sentence.match(CHANGED_MY);
    if (!m) continue;
    const subject = thingWords(m[1]);
    const kind = [DATE, AMOUNT].find(re => re.test(m[2]));
    if (!subject.length || !kind) continue;
    const span = m[2].match(kind)[0].trim();
    // A qualified change is a PARTIAL one: "I raised my day rate to 720 euros
    // for new clients" leaves 650 standing for existing clients, and storing
    // 720 as THE day rate billed an existing client at it (dev, 2026-10-29).
    // Only a change that is the whole value replaces it; the sentence itself
    // stays quotable through recall.
    if (m[2].slice(m[2].indexOf(span) + span.length).replace(/[\s,]+$/, '').trim()) continue;
    const hits = custom.filter(f => sameSet(keyWords(f.key), subject) && kind.test(f.value));
    if (hits.length !== 1) continue;
    const [fact] = hits;
    const value = fact.value.replace(kind, span);
    if (value !== fact.value) out.push({ key: fact.key, category: fact.category ?? null, value, previous: fact.value, sentence: sentence.trim() });
  }
  return out;
}
