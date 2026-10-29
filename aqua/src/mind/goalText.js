/**
 * AQUA — the TEXT rules for goals (2026-10-29): is a phrase a goal, how many
 * goals a phrase holds, when two phrasings are the same goal. Pure — no store,
 * no I/O — so both writers of goals use one rule: the Mind's goal tracker
 * (goalTracker.js) and the fact extractor's goal collection
 * (memory/candidateExtractor.js), which stored "become a billionaire and build
 * a company people love" as one item until this module existed.
 */

/**
 * Head verbs that START a new goal inside a coordinated list. Splitting is
 * keyed on these, not on "and": "build and ship the app" is one goal (the left
 * side is a bare verb), "launch the beta and hire a designer" is two. A
 * closed list on purpose — a wrong split invents two half-goals, so an
 * unlisted verb keeps the phrase whole (the pre-2026-10-28 behaviour).
 */
export const GOAL_HEADS = new Set((
  'become,build,launch,ship,hire,raise,learn,start,grow,reach,hit,get,finish,complete,close,create,write,' +
  'publish,release,move,buy,save,earn,make,run,open,found,land,win,pass,improve,reduce,cut,increase,double,' +
  'triple,scale,sell,find,travel,study,master,quit,join,lose,gain,train,read,finalize,finalise,secure,sign,' +
  'automate,migrate,rewrite,redesign,refactor,deploy,expand,apply,graduate,prepare,practice,practise,visit,' +
  'pay,invest,lead,teach,mentor,partner,acquire,onboard,validate,test,fix,deliver,submit,achieve,crack'
).split(','));

const COORD = /\s*(?:,\s*)?\b(?:and(?:\s+also)?|plus|as well as|also)\s+(?:to\s+)?/gi;

/** Split "launch the beta and hire a designer" → two goals; keep "build and ship X" whole. */
export function splitCoordinated(capture) {
  const parts = [];
  let start = 0;
  for (const m of capture.matchAll(COORD)) {
    const left = capture.slice(start, m.index).trim();
    const nextWord = capture.slice(m.index + m[0].length).split(/\s+/)[0]?.toLowerCase().replace(/[^a-z-]/g, '');
    if (!GOAL_HEADS.has(nextWord) || left.split(/\s+/).length < 2) continue;
    parts.push(left);
    start = m.index + m[0].length;
  }
  parts.push(capture.slice(start).trim());
  return parts.filter(Boolean);
}

/**
 * A comma-separated list after the capture: "I want to launch the beta, hire
 * a designer, and raise a seed round". The capture stops at the first comma
 * (on purpose — "I want to ship it, but …"), so continuation items are read
 * only while each one starts with a goal head verb.
 */
const LIST_ITEM = /^\s*,\s*(?:and\s+|or\s+)?(?:also\s+)?(?:to\s+)?([a-z][^.,;!?]{3,89}?)(?=[.,;!](?!\d)|$)/i;
export function listContinuation(text, from) {
  const items = [];
  let rest = text.slice(from);
  for (let i = 0; i < 6; i++) {
    const m = rest.match(LIST_ITEM);
    if (!m) break;
    const head = m[1].split(/\s+/)[0].toLowerCase();
    if (!GOAL_HEADS.has(head)) break;
    items.push(m[1].trim());
    rest = rest.slice(m[0].length);
  }
  return items;
}

/**
 * Head verbs that make a capture a REQUEST rather than an intention.
 *
 * "I want to know how this works" and "I need to check the logs" are things
 * the user wants from this turn, not things they are working toward. They must
 * never reach the card, so they are named explicitly rather than excluded by
 * an allowlist that would also drop every outcome verb nobody thought of.
 */
const NOT_A_GOAL_HEAD = new Set([
  'know', 'understand', 'see', 'ask', 'hear', 'check', 'find', 'look',
  'read', 'say', 'tell', 'talk', 'discuss', 'confirm', 'clarify', 'explain',
  'remember', 'show', 'compare', 'review', 'double-check', 'verify', 'figure',
]);

/** Tokens that carry no goal. A capture made ENTIRELY of these is noise —
 *  "do it", "get more", "be better". Checked per-token rather than against the
 *  whole string, because the contentless case is usually two words, not one. */
const CONTENTLESS = new Set((
  'it,this,that,them,thing,things,stuff,something,anything,more,less,better,' +
  'faster,best,out,up,down,go,going,be,do,doing,get,getting,make,making,work,on'
).split(','));

/**
 * A capture is a goal unless it reads as a request or is empty of content.
 * Kept strict on purpose: goals are the heaviest term in the understanding
 * score and the most visible line on the card.
 */
export function isGoalLike(capture) {
  const v = String(capture ?? '').trim();
  if (v.length < 4 || v.length > 90) return false;
  if (v.endsWith('?')) return false;                 // a question is not a plan
  const tokens = v.toLowerCase().split(/\s+/).map(t => t.replace(/[^\p{L}\p{N}-]/gu, '')).filter(Boolean);
  if (!tokens.length) return false;
  if (NOT_A_GOAL_HEAD.has(tokens[0])) return false;
  if (tokens.every(t => CONTENTLESS.has(t))) return false;
  return true;
}

const STOPWORDS = new Set(['the','a','an','to','of','for','and','or','in','on','with','our','my','it','this','that','be','is','are']);

/** "launching" / "launched" / "launches" all match "launch". */
const stem = w => (w.length > 5
  ? w.replace(/(?:ing|ed|es)$/, '').replace(/([b-df-hj-np-tv-z])\1$/, '$1')   // "shipped" → "ship"
  : w.length > 3 ? w.replace(/s$/, '') : w);

function tokenize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w)).map(stem);
}

/** Jaccard-ish token overlap — good enough for goal re-mention matching. */
export function goalSimilarity(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

/**
 * A stored goal title as the separate goals it holds, by the same rule new
 * messages are split with. One part (or none) = nothing to split. Used by the
 * legacy review (legacyReview.js); never applied to stored goals on its own.
 */
export function splitGoalTitle(title) {
  const parts = [];
  for (const p of splitCoordinated(String(title ?? '').trim().replace(/\s+/g, ' '))) {
    if (isGoalLike(p) && !parts.some(x => goalSimilarity(x, p) >= 0.9)) parts.push(p);
  }
  return parts;
}


/** A fact-extractor goal capture as its separate goals; the capture itself when it holds one (or none passes). */
export function goalParts(value) {
  const parts = splitGoalTitle(value);
  return parts.length >= 2 ? parts : [value];
}
