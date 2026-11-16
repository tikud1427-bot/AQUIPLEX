/**
 * Speech acts — what a sentence DOES before what it says (2026-11-10, Sprint 4,
 * Capture Integrity V1).
 *
 * Memory capture read every sentence as a statement about the user. A question
 * was mined for facts ("Where does my sister work?" → siblings: Work; "Is my
 * sister called Ana?" → siblings: Called), a request was mined for goals ("Can
 * you help me plan my training this week?" → goal: plan my training this week)
 * and a request's object for relations ("Plan a dinner for my partner and me"
 * → spouse: And). This module classifies a sentence first, so only what the
 * user ASSERTS about themselves becomes a fact — and anything else is either
 * dropped from capture (its words stay quotable in recall) or carried with a
 * label saying how certain it is.
 *
 * Deterministic, lexical, no model call. Acts:
 *
 *   assertion     "I teach chemistry in Leicester."          → capture
 *   negation      "I don't have a car."                      → capture (patterns must respect the negation)
 *   correction    "Sorry, my sister is Josie not Jodie."     → capture (the resolver's correction path)
 *   preference    "I hate coriander."                        → capture
 *   goal          "My goal is to learn Italian."             → capture
 *   intention     "I'm going to repaint the kitchen."        → capture, marked intention
 *   prediction    "I'll probably get the promotion."         → capture only as hedged (never a confirmed value)
 *   question      "Where does my sister work?"               → no capture
 *   request       "Help me plan my wedding."                 → no capture
 *   hypothetical  "If I moved to Lisbon, would I be happier?" → no capture
 *   remember      "Remember that my locker is 217."          → capture of the embedded assertion only
 *
 * A sentence may lead with a statement and end with a question ("I live in
 * Leeds, can you recommend a gym?"). `assertedPart` keeps the leading statement
 * and drops the rest — the statement was said; the question was asked.
 */

// Interrogative openers. Auxiliary inversion needs a subject after it ("Is my
// sister…", "Do I…", "Can we…") so "Does it matter" and "Is it worth" count, but a
// statement that merely starts with "Will" (a name) does not.
const WH = /^\s*(?:so|and|but|ok(?:ay)?|hey|hi|also|then|well|right|now)?[,\s]*(?:how|what(?:'s)?|who(?:'s)?|whom|whose|where(?:'s)?|when(?:'s)?|why|which)\b/i;
const AUX_SUBJECT = /^\s*(?:so|and|but|ok(?:ay)?|also|then|well|now)?[,\s]*(?:is|are|was|were|am|do|does|did|can|could|should|shall|would|will|have|has|had|may|might|must|isn'?t|aren'?t|wasn'?t|don'?t|doesn'?t|didn'?t|can'?t|couldn'?t|shouldn'?t|wouldn'?t|won'?t|haven'?t|hasn'?t)\s+(?:i|we|you|my|our|it|there|this|that|they|he|she|the|a|an|any|anyone|someone|his|her|their)\b/i;
// "What I want is…", "How I met my wife…", "When I write emails, …", "What a day": statements.
const STATEMENT_WH = /^\s*(?:what|how)\s+(?:a|an)\b|^\s*(?:how|what|where|when|why|which|who)\s+(?:i|we|my|our)\b(?!\s+(?:is|are|was|were|do|does|did|can|should|would)\b)/i;
const QUESTION_MARK =/\?\s*["')\]]*\s*$/;

// Requests: the user asks Aqua to do something. Leading "please"/"can you" forms
// and bare imperatives of task verbs. "Help me become…" is a request too: an
// aim stated as a request is still a request — the aim is stated elsewhere or not at all.
const REQUEST = /^\s*(?:(?:ok(?:ay)?|so|hey|hi|also|now|then|right)[,\s]+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\b|help\s+me\b|let'?s\b|tell\s+me\b|give\s+me\b|show\s+me\b|remind\s+me\b|teach\s+me\b|walk\s+me\b|talk\s+me\b|make\s+(?:me|a|an|the|my|our|some)\b|(?:recommend|suggest|explain|describe|plan|draft|write|summari[sz]e|find|list|compare|calculate|work\s+out|figure\s+out|translate|outline|create|generate|brainstorm|review|check|proofread|rewrite|rephrase|organi[sz]e|sort|schedule|book|estimate|analy[sz]e|design|build\s+me|put\s+together|come\s+up\s+with|think\s+of|pick|choose|name)\s+(?!(?:is|are|was|were|has|have|had|club|of|and|or)\b)(?=[\w"'])(?!\w*-))/i;

// Hypotheticals: a supposed situation, not a reported one.
const HYPOTHETICAL = /^\s*(?:(?:so|and|but|ok(?:ay)?)[,\s]+)?(?:what\s+if|if|suppose|supposing|imagine|hypothetically|in\s+theory|let'?s\s+say|say\s+(?:i|we)|assuming|assume|in\s+a\s+world\s+where|were\s+i\s+to|had\s+i)\b|\b(?:i|we)\s+would\s+(?:\w+\s+){0,3}if\b|\bwould\s+(?:i|we)\s+be\b/i;

// "Remember that …", "note that …", "for the record, …", "just so you know, …".
const REMEMBER = /^\s*(?:please\s+)?(?:remember|note|keep\s+in\s+mind|bear\s+in\s+mind|don'?t\s+forget|make\s+a\s+note)\s+(?:that\s+)?(?=\S)|^\s*(?:for\s+the\s+record|just\s+so\s+you\s+know|fyi|fwiw|heads\s+up)[,:\s]+/i;

const CORRECTION = /^\s*(?:sorry|oops|correction|actually|to\s+correct|i\s+meant|i\s+misspoke|scratch\s+that|typo)\b|\bnot\s+[A-Z][a-z]+\s*[.!]?\s*$|\b(?:i\s+meant|should\s+have\s+said|i\s+said\s+\w+\s+but)\b/i;
const NEGATION = /\b(?:i|we)\s+(?:don'?t|do\s+not|didn'?t|did\s+not|never|no\s+longer|haven'?t|have\s+not|am\s+not|'m\s+not|aren'?t|are\s+not|can'?t|cannot|won'?t)\b|\b(?:i'?m|we'?re)\s+not\b|\b(?:my|our)\s+\w+(?:\s+\w+)?\s+(?:is|are)(?:n'?t|\s+not)\b/i;
const PREDICTION = /\b(?:i|we)(?:'ll|\s+will|'?re\s+going\s+to\s+be|'m\s+going\s+to\s+be|\s+am\s+going\s+to\s+be)\s+(?:probably|likely|maybe|definitely|surely|almost\s+certainly)?\s*(?:be|get|have|end\s+up|need|lose|win|make)\b|\b(?:i|we)\s+(?:expect|predict|reckon|bet|doubt)\b|\b(?:will\s+probably|is\s+likely\s+to|are\s+likely\s+to|probably\s+will)\b/i;
const INTENTION = /\b(?:i|we)(?:'m|'re|\s+am|\s+are)\s+(?:going\s+to|gonna|about\s+to|planning\s+(?:to|on))\b|\b(?:i|we)(?:'ll|\s+will)\s+(?!probably|likely|maybe|be\b)\w+|\b(?:i|we)\s+(?:plan|intend|mean)\s+to\b/i;
const GOAL = /\b(?:my|our|the)\s+(?:main\s+|primary\s+|long[-\s]term\s+|current\s+)?(?:goal|aim|objective|ambition|dream|target|priority)\b|\b(?:i|we)(?:'m|'re|\s+am|\s+are)\s+(?:trying|aiming|hoping|working)\s+(?:to|toward)|\b(?:i|we)(?:'d)?\s+(?:want|would\s+like|'d\s+like|hope|wish)\s+to\b/i;
// "I wonder if I should move", "I don't know whether to…": asked, not asserted.
const INDIRECT_QUESTION = /^\s*(?:i\s+wonder|i'?m\s+wondering|i\s+(?:don'?t|do\s+not)\s+know|i'?m\s+(?:not\s+sure|unsure))\s+(?:if|whether|what|how|which|who|where|when)\b/i;
// Weighing an option is not having taken it: "I'm thinking about going freelance".
const CONSIDERING = /\b(?:i|we)(?:'m|'re|\s+am|\s+are)\s+(?:thinking\s+(?:about|of)|considering|toying\s+with|weighing\s+up|tempted\s+to)\b|\b(?:i|we)\s+(?:might|may)\s+(?!have\b)\w+/i;
const PREFERENCE =/\b(?:i|we)\s+(?:really\s+|absolutely\s+)?(?:love|like|prefer|enjoy|hate|dislike|can'?t\s+stand|adore|detest)\b|\b(?:my|our)\s+(?:favou?rite|preferred)\b/i;

/** A clean, comparable copy of a sentence. */
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Is this sentence a question (form, not punctuation alone)? */
export function isQuestion(sentence) {
  const s = norm(sentence);
  if (!s) return false;
  return QUESTION_MARK.test(s) || WH.test(s) && !STATEMENT_WH.test(s) || AUX_SUBJECT.test(s);
}

// "Plan B is…", "Book A was…": a label, not an imperative (case-sensitive on purpose).
const LABEL_HEAD = /^\s*[A-Za-z]+\s+[A-Z]\b(?!')/;
export function isRequest(sentence) { const s = norm(sentence); return REQUEST.test(s) && !LABEL_HEAD.test(s); }
export function isHypothetical(sentence) { return HYPOTHETICAL.test(norm(sentence)); }

/**
 * Classify one sentence. Returns { act, embedded?, hedged? }:
 *   act       one of the acts above
 *   embedded  for `remember`, the assertion inside it
 */
export function classifySpeechAct(sentence) {
  const s = norm(sentence);
  if (!s) return { act: 'empty' };
  const rem = s.match(REMEMBER);
  if (rem) {
    const embedded = s.slice(rem[0].length).replace(/^[,:\s]+/, '');
    // "Remember to call Mum" is a reminder request, not an assertion.
    if (/^to\b/i.test(embedded)) return { act: 'request' };
    if (embedded && !isQuestion(embedded)) return { act: 'remember', embedded };
  }
  if (isHypothetical(s)) return { act: 'hypothetical' };
  if (isQuestion(s) || INDIRECT_QUESTION.test(s)) return { act: 'question' };
  if (isRequest(s)) return { act: 'request' };
  if (CORRECTION.test(s)) return { act: 'correction' };
  if (NEGATION.test(s)) return { act: 'negation' };
  if (PREDICTION.test(s)) return { act: 'prediction', hedged: true };
  if (CONSIDERING.test(s)) return { act: 'intention', hedged: true };
  if (GOAL.test(s)) return { act: 'goal' };
  if (INTENTION.test(s)) return { act: 'intention' };
  if (PREFERENCE.test(s)) return { act: 'preference' };
  return { act: 'assertion' };
}

const ASPIRATION_REQUEST = /^\s*(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?help\s+me\s+(?:to\s+)?(?:finally\s+)?(?:become|achieve|reach|master|get\s+promoted|get\s+to\s+\w+|land|win|grow|raise|earn|launch|build|start|found|learn|lose|save\s+(?:up\s+)?for|pay\s+off|quit|run\s+a)\b/i;

/** Acts whose content the user asserted (capture may read them). */
export const ASSERTIVE = new Set(['assertion', 'negation', 'correction', 'preference', 'goal', 'intention', 'prediction', 'remember']);

// Where a leading statement ends and a question or request begins:
// "I live in Leeds, can you recommend a gym?" · "We have 3 engineers — should we hire?"
const SEGMENT = /\s*(?:[,;:]|\s[—–-])\s+|\s+(?:so|but|and)\s+(?=(?:can|could|would|will|should|what|how|is|are|do|does|any|please)\b)/gi;

/**
 * The part of a sentence the user ASSERTED, or null when nothing was asserted.
 * - an assertive sentence → itself (for `remember`, the embedded statement);
 * - a question/request/hypothetical that LEADS with a statement → that statement;
 * - otherwise → null.
 * Returns { text, act } so callers can keep provenance.
 */
export function assertedPart(sentence) {
  const s = norm(sentence);
  if (!s) return null;
  const c = classifySpeechAct(s);
  if (c.act === 'remember') return { text: c.embedded, act: 'remember' };
  if (ASSERTIVE.has(c.act)) return { text: s, act: c.act };
  if (c.act === 'hypothetical') return null;
  // An aspiration said as a request is still the user's aim: "Help me become a
  // billionaire within a year", "Can you help me get promoted?". A TASK said as a
  // request is not ("help me plan my training this week", "help me write an email").
  if ((c.act === 'request' || c.act === 'question') && ASPIRATION_REQUEST.test(s)) return { text: s, act: 'goal' };
  // A question or request: keep a leading statement, if there is one.
  let best = null;
  for (const m of s.matchAll(SEGMENT)) {
    const head = s.slice(0, m.index).trim();
    const tail = s.slice(m.index + m[0].length).trim();
    if (!head || !tail || head.split(/\s+/).length < 3) continue;
    const hc = classifySpeechAct(head);
    if (!ASSERTIVE.has(hc.act) || hc.act === 'remember') continue;
    const tc = classifySpeechAct(tail);
    if (tc.act === 'question' || tc.act === 'request' || QUESTION_MARK.test(tail)) best = { text: head, act: hc.act };
    break;
  }
  return best;
}

/**
 * The asserted text of a whole message: each sentence reduced to what was
 * asserted, in order, non-assertions removed. For capture paths that read a
 * message as a whole (the Mind's goal detector).
 */
export function assertedText(sentences) {
  const out = [];
  for (const s of sentences) {
    const a = assertedPart(s);
    if (a?.text) out.push(/[.!?]$/.test(a.text) ? a.text : `${a.text}.`);
  }
  return out.join(' ');
}
