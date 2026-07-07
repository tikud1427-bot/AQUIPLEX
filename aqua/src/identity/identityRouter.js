/**
 * AQUA Identity Smart Router
 * ─────────────────────────────────────────────────────────────────────────────
 * Three jobs:
 *
 *   1. detectIdentityIntent(query) — is this question about Aquiplex/AQUA
 *      itself, and if so, which topic(s)? Runs BEFORE heavy retrieval so the
 *      chat pipeline can skip project/vector retrieval and inject the expanded
 *      identity context instead.
 *
 *   2. answerFromIdentity(query) — a deterministic, well-composed answer built
 *      straight from the structured profile (no LLM). This is:
 *        • the guaranteed grounded answer the refusal-guard substitutes if the
 *          model ever hedges on an identity question, and
 *        • what the automated tests assert against (no network needed in CI).
 *
 *   3. isRefusal(text) — does an answer contain a "I don't know / not familiar
 *      / no source" style refusal? Used by the guard and by the tests that
 *      enforce the spec's FAILURE CONDITIONS.
 *
 * Detection rule (kept simple + robust):
 *   isSelf = mentions "aqua"/"aquiplex"  OR  (addresses the assistant with
 *            "you"/"your"/"yourself"  AND  matches ≥1 identity topic).
 *   The second-person requirement is what keeps user-memory questions out:
 *   "what is MY favorite language" has no self-noun and no "you/your", so it
 *   is never mistaken for an identity question.
 */
import { getIdentityProfile } from './identityLoader.js';

// ── self-reference signals ────────────────────────────────────────────────────
const SELF_NOUN     = /\b(aqua|aquiplex)\b/i;
const SECOND_PERSON = /\b(you|your|yours|yourself)\b/i;
// First-person redirect ("my", "I") — when present WITHOUT a self-noun and
// WITHOUT second-person, the question is about the user, not AQUA.
const FIRST_PERSON  = /\b(my|mine|myself|i['’]?m|i\s+(am|have|want|need))\b/i;

// ── topic patterns ────────────────────────────────────────────────────────────
// Each topic name matches a renderer in identityContext.R.
const TOPIC_PATTERNS = {
  vision:          [/\bvision\b/i],
  mission:         [/\bmission\b/i, /\bpurpose\b/i],
  values:          [/\b(core\s+)?values?\b/i, /\bprinciples?\b/i],
  capabilities:    [/\bcapabilit/i, /\bwhat\s+can\s+you\s+do\b/i, /\bwhat\s+do\s+you\s+do\b/i, /\b(able|ability)\s+to\s+do\b/i, /\byour\s+features?\b/i, /\bwhat\s+are\s+you\s+capable\b/i],
  files:           [/\b(files?|file\s*types?|formats?|documents?)\b[\s\S]{0,30}\b(process|handle|read|support|upload|accept|ingest|parse)\b/i,
                    /\b(process|handle|read|support|upload|accept|ingest|parse)\b[\s\S]{0,30}\b(files?|documents?|formats?)\b/i],
  differentiators: [/\bdifferent(iat)?/i, /\bunique\b/i, /\bstand\s?out\b/i, /\bwhat\s+makes\s+(you|aqua)\b/i, /\bwhy\s+(use|choose|pick)\b/i, /\bbetter\s+than\b/i, /\byour\s+edge\b/i],
  founders:        [/\bfound(er|ers|ed)\b/i, /\bwho\s+(made|created|started|owns)\s+aquiplex\b/i, /\bwho['’]?s?\s+behind\b/i],
  creator:         [/\bwho\s+(built|made|created|developed|designed)\s+(you|aqua)\b/i, /\bbuilt\s+by\b/i, /\byour\s+(creator|maker|developer|builder)\b/i, /\bwho\s+are\s+you\s+(built|made|created)\s+by\b/i],
  roadmap:         [/\broad\s?map\b/i, /\bwhat['’]?s\s+next\b/i, /\bfuture\s+plans?\b/i, /\bupcoming\b/i, /\bwhat\s+are\s+you\s+(building|planning)\b/i],
  models:          [/\bmodels?\b/i, /\bllms?\b/i, /\bwhich\s+ai\b/i, /\bwhat\s+ai\b/i, /\bproviders?\b/i, /\bpowered\s+by\b/i, /\bunder\s+the\s+hood\b/i],
  products:        [/\bproducts?\b/i, /\bofferings?\b/i, /\bwhat\s+do\s+you\s+(offer|sell)\b/i],
  pricing:         [/\bpric(e|es|ing)\b/i, /\bcost\b/i, /\bhow\s+much\b/i, /\bplans?\b/i, /\bsubscription\b/i, /\bfree\s+tier\b/i],
  limitations:     [/\blimitations?\b/i, /\bwhat\s+can['’]?t\s+you\b/i, /\bcannot\s+you\b/i, /\bweakness(es)?\b/i, /\bdrawbacks?\b/i, /\bconstraints?\b/i],
  company:         [/\baquiplex\b/i],
  overview:        [/\b(what|who)\s+is\s+(aqua|aquiplex)\b/i, /\b(who|what)\s+are\s+you\b/i, /\btell\s+me\s+about\s+(yourself|aqua|aquiplex)\b/i, /\bwhat['’]?s\s+aqua\b/i, /\bintroduce\s+yourself\b/i],
};

// Topics that are only meaningful as questions ABOUT the assistant, so a bare
// self-noun isn't required if the user is clearly addressing "you".
const SELF_OWNED_TOPICS = new Set([
  'vision', 'mission', 'values', 'capabilities', 'files', 'differentiators',
  'creator', 'roadmap', 'models', 'products', 'pricing', 'limitations',
]);

/**
 * @param {string} query
 * @returns {{ isSelf: boolean, topics: string[], score: number }}
 */
export function detectIdentityIntent(query) {
  const q = (query ?? '').trim();
  if (!q) return { isSelf: false, topics: [], score: 0 };

  const matched = [];
  for (const [topic, patterns] of Object.entries(TOPIC_PATTERNS)) {
    if (patterns.some(re => re.test(q))) matched.push(topic);
  }

  const hasSelfNoun = SELF_NOUN.test(q);
  const hasSecond   = SECOND_PERSON.test(q);
  const hasFirst    = FIRST_PERSON.test(q);

  // 'creator'/'company'/'overview' already require self-context in their
  // patterns; the self-owned topics can rely on second-person addressing.
  const selfOwnedHit = matched.some(t => SELF_OWNED_TOPICS.has(t));
  const contextHit   = matched.includes('creator') || matched.includes('company') || matched.includes('overview');

  let isSelf = false;
  if (hasSelfNoun) {
    isSelf = matched.length > 0;                       // e.g. "What is Aquiplex?", "What makes AQUA different?"
  } else if (contextHit) {
    isSelf = true;                                     // e.g. "Who built you?", "Who founded Aquiplex?"
  } else if (selfOwnedHit && hasSecond && !hasFirst) {
    isSelf = true;                                     // e.g. "What is your vision?", "What can you do?"
  }

  if (!isSelf) return { isSelf: false, topics: [], score: 0 };

  // Order topics deterministically and drop 'company' when a more specific
  // topic exists (company == bare aquiplex mention, low signal).
  let topics = matched;
  if (topics.length > 1) topics = topics.filter(t => t !== 'company');
  if (topics.length === 0) topics = ['overview'];

  const score = Math.min(1, 0.5 + 0.15 * topics.length + (hasSelfNoun ? 0.2 : 0));
  return { isSelf: true, topics: dedupe(topics), score: +score.toFixed(2) };
}

// ── deterministic grounded answer ─────────────────────────────────────────────

/**
 * Compose a natural-language answer for an identity question, straight from the
 * structured profile. Returns null if the query isn't an identity question.
 *
 * This never contains a refusal phrase for information present in the profile —
 * that's the whole point, and the tests assert it.
 *
 * @param {string} query
 * @param {object} [profile]
 * @returns {string|null}
 */
export function answerFromIdentity(query, profile = getIdentityProfile()) {
  const intent = detectIdentityIntent(query);
  if (!intent.isSelf) return null;
  return composeAnswer(intent.topics, profile);
}

/** Compose from an explicit topic list (used by answerFromIdentity + guard). */
export function composeAnswer(topics, profile = getIdentityProfile()) {
  const c = profile.company, a = profile.assistant;
  const t = new Set(topics && topics.length ? topics : ['overview']);
  const blocks = [];

  const one = (topic) => t.has(topic);

  if (one('overview') || one('company')) {
    blocks.push(`I'm ${a.fullName ?? a.name}, the first-party AI built by ${c.name}. ${c.description}`);
  }
  if (one('vision'))  blocks.push(`Our vision: ${c.vision}`);
  if (one('mission')) blocks.push(`Our mission: ${c.mission}`);
  if (one('values')) {
    const vals = c.coreValues ?? [];
    if (vals.length) blocks.push(`Our core values are:\n${vals.map(v => `• ${v.name}${v.detail ? ` — ${v.detail}` : ''}`).join('\n')}`);
  }
  if (one('capabilities')) {
    const caps = a.capabilities ?? [];
    if (caps.length) blocks.push(`Here's what I can do:\n${caps.map(x => `• ${x}`).join('\n')}`);
  }
  if (one('files')) {
    const f = a.processableFiles;
    if (f) {
      const parts = [];
      if (f.code?.length)      parts.push(`code repositories (${f.code.join(', ')})`);
      if (f.documents?.length) parts.push(`documents (${f.documents.join(', ')})`);
      if (f.media?.length)     parts.push(`media (${f.media.join(', ')})`);
      blocks.push(`I can process ${parts.join(', ')}.${f.note ? ` ${f.note}` : ''}`);
    }
  }
  if (one('differentiators')) {
    const d = a.differentiators ?? [];
    if (d.length) blocks.push(`What makes ${a.name} different:\n${d.map(x => `• ${x}`).join('\n')}`);
  }
  if (one('creator')) {
    blocks.push(`I was built by ${a.builtBy ?? c.name} as its first-party AI.`);
  }
  if (one('founders')) {
    const f = profile.founders ?? [];
    if (f.length) blocks.push(`${c.name} was founded by ${f.map(x => x.name).join(' and ')}.`);
  }
  if (one('products')) {
    const pr = profile.products ?? [];
    if (pr.length) blocks.push(`${c.name} products:\n${pr.map(x => `• ${x.name}${x.description ? ` — ${x.description}` : ''}`).join('\n')}`);
  }
  if (one('models')) {
    const m = profile.models;
    if (m) {
      const provs = (m.providers ?? []).map(p => `${p.name} (${(p.models ?? []).join(', ')})`).join('; ');
      blocks.push(`${m.summary}${provs ? ` I route across: ${provs}.` : ''}${m.routing ? ` ${m.routing}` : ''}`);
    }
  }
  if (one('roadmap')) {
    const r = (profile.roadmap ?? []).filter(ph => (ph.items ?? []).length);
    if (r.length) blocks.push(`Roadmap:\n${r.map(ph => `${ph.phase}:\n${ph.items.map(i => `  • ${i}`).join('\n')}`).join('\n')}`);
  }
  if (one('limitations')) {
    const l = a.limitations ?? [];
    if (l.length) blocks.push(`My limitations:\n${l.map(x => `• ${x}`).join('\n')}`);
  }
  if (one('pricing')) {
    blocks.push(`Pricing isn't part of my current profile — please check with the ${c.name} team or the website for current plans.`);
  }

  // Fallback: if somehow nothing composed, give the elevator overview so we
  // never return an empty string for a detected identity question.
  if (!blocks.length) {
    blocks.push(`I'm ${a.fullName ?? a.name}, the first-party AI built by ${c.name}. ${c.description} Our vision: ${c.vision}`);
  }
  return blocks.join('\n\n');
}

// ── refusal detection (enforces spec FAILURE CONDITIONS) ──────────────────────

const REFUSAL_PATTERNS = [
  /\bi\s+don['’]?t\s+know\b/i,
  /\bi\s+do\s+not\s+know\b/i,
  /\bi['’]?m\s+not\s+(sure|familiar)\b/i,
  /\bi\s+am\s+not\s+(sure|familiar)\b/i,
  /\bi\s+don['’]?t\s+have\s+(any\s+)?(information|info|details?|knowledge|data)\b/i,
  /\bi\s+don['’]?t\s+have\s+(a\s+)?(verifiable\s+)?source\b/i,
  /\bno\s+(verifiable\s+)?source\b/i,
  /\bi\s+(can['’]?t|cannot)\s+(find|verify|confirm)\b/i,
  /\bnot\s+familiar\s+with\b/i,
  /\bi\s+have\s+no\s+(information|knowledge|record)\b/i,
  /\bi\s+don['’]?t\s+have\s+access\s+to\b/i,
  /\bunable\s+to\s+find\b/i,
];

/**
 * True if `text` contains a refusal / "I don't know" style phrase. Used by the
 * refusal-guard (chat.js) and by the tests enforcing the FAILURE CONDITIONS.
 * @param {string} text
 * @returns {boolean}
 */
export function isRefusal(text) {
  if (!text) return false;
  return REFUSAL_PATTERNS.some(re => re.test(text));
}

function dedupe(arr) { return [...new Set(arr)]; }

export { TOPIC_PATTERNS as _topicPatterns, REFUSAL_PATTERNS as _refusalPatterns };
