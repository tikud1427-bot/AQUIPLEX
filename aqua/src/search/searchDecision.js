/**
 * AQUA Web Search — Smart Search Decision
 *
 * The "Need Web?" gate. PURE, SYNCHRONOUS, DETERMINISTIC — same inputs
 * always produce the same decision, no LLM calls, no I/O — because it runs
 * inside orchestrate()'s capability detection, which documents exactly that
 * invariant. It is a weighted-signal scorer in the same spirit as
 * core/classifier.js, not a second classifier: it consumes classifier.js's
 * winning taskType rather than re-deriving one.
 *
 * Spec mapping:
 *   YES — latest news · programming documentation · GitHub · current APIs ·
 *         research · pricing · today's information · comparison
 *   NO  — creative writing · math · reasoning · conversation · memory
 *         recall · uploaded files · existing project knowledge
 *
 * Mechanics:
 *   HARD BLOCKS  — task types where searching is categorically wrong
 *                  (memory/personal/conversation/creative) or an explicit
 *                  user opt-out ("don't search"). Always { needed:false }.
 *   FORCE        — explicit user opt-in ("search the web for…"). Always
 *                  { needed:true }.
 *   SIGNALS      — additive positive/negative pattern weights + task-type
 *                  bias + workspace-grounding penalty. needed when the
 *                  total clears THRESHOLD.
 *
 * Also exports buildSearchQuery(): strips imperative lead-ins ("can you
 * google…") and caps at 380 chars (Tavily's <400 recommendation).
 */

// ── Hard blocks ───────────────────────────────────────────────────────────────

const BLOCKED_TASK_TYPES = new Set([
  'memory_recall', 'memory_update', 'personal_info',   // about the user, not the web
  'conversation',                                       // greetings/acks
  'creative_writing', 'brainstorming',                  // spec: creative → NO
]);

const OPT_OUT_RE = /\b(don'?t|do not|no need to|without)\s+(search|browse|google|use the (web|internet))\b|\boffline\b/i;
const OPT_IN_RE  = /\b(search|google|look up|check)\s+(the\s+)?(web|internet|online)\b|\bsearch (for|the web)\b|\bgoogle (this|it|for)\b|^(please\s+|hey,?\s+)?(search|google|look\s*up)\b/i;

// Pure-math shortcut — arithmetic expressions never need the web even when
// taskType lands on reasoning.
const PURE_MATH_RE = /^[\s\d.+\-*/^%()=xy]+\??$/i;

// ── Weighted signals ──────────────────────────────────────────────────────────

const POSITIVE = [
  // Freshness / news / today's information
  { re: /\b(latest|newest|most recent|recent(ly)?|breaking|trending)\b/i,                          w: 3, tag: 'freshness' },
  { re: /\b(today|tonight|yesterday|this (week|month|year)|right now|as of (now|today)|currently)\b/i, w: 3, tag: 'temporal' },
  { re: /\bnews\b|\bheadlines?\b|\bannounce(d|ment)\b/i,                                           w: 3, tag: 'news' },
  { re: /\b(20(2[4-9]|3\d))\b/,                                                                    w: 2, tag: 'recent_year' },
  // Releases / versions / changelogs / current APIs
  { re: /\b(release(d|s)?|changelog|roadmap update|out yet|shipped|launch(ed)?|version|v\d+(\.\d+)+|deprecat(ed|ion))\b/i, w: 3, tag: 'release' },
  { re: /\b(still (supported|maintained)|end of life|eol\b|breaking changes? in)\b/i,              w: 3, tag: 'lifecycle' },
  // Programming documentation / GitHub / packages
  { re: /\b(documentation|docs|api reference|official (guide|docs)|readme)\b/i,                    w: 3, tag: 'docs' },
  { re: /\b(github|gitlab) (repo(sitory)?|project|org)\b|\bgithub\.com\b/i,                        w: 3, tag: 'github' },
  { re: /\bnpm (package|module)\b|\bpypi\b|\bcrates\.io\b|\bpip install\b|\bnpm install\b/i,       w: 2, tag: 'package' },
  // Pricing / money / market
  { re: /\b(price|pricing|cost of|how much (is|does|do)|subscription (cost|price)|fee[s]?)\b/i,    w: 3, tag: 'pricing' },
  { re: /\b(stock|share price|market cap|exchange rate|crypto|bitcoin|valuation|funding round)\b/i, w: 3, tag: 'market' },
  // Live-world facts
  { re: /\b(weather|forecast|temperature (in|at)|score|match result|won the|election)\b/i,          w: 3, tag: 'live_facts' },
  { re: /\bwho\s+(is|are)\s+(the\s+)?(current(ly)?\s+|new\s+|now\s+)?(ceo|cto|cfo|coo|president|vice[-\s]?president|prime\s+minister|chief\s+minister|cm|governor|mayor|chancellor|vice[-\s]?chancellor|principal|dean|director|chair(man|person|woman)?|head|founder|co-?founder|owner|leader|minister|secretary|senator|mp|mla)\s+of\b/i, w: 3, tag: 'role_holder' },
  { re: /\b(is|are) .{2,40}\b(down|up|available|out|open|closed)( right now| today)?\??$/i,        w: 2, tag: 'status' },
  // Comparison / research (spec: YES)
  { re: /\b(compare|comparison|versus|vs\.?|difference between|which is better|better than|alternatives? (to|for)|pros and cons)\b/i, w: 2, tag: 'comparison' },
  { re: /\b(best|top \d+|recommended)\s+(\w+\s+){0,3}(tool|library|framework|service|platform|api|model|laptop|phone|provider)s?\b/i, w: 2, tag: 'best_of' },
  { re: /\b(state of the art|sota\b|benchmarks?\b|survey of|current landscape)\b/i,                w: 2, tag: 'research' },
];

const NEGATIVE = [
  // Existing project knowledge / uploaded files (spec: NO)
  { re: /\b(in|of|to|from) (my|this|the|our) (code(base)?|repo(sitory)?|project|workspace|app)\b/i, w: -3, tag: 'own_project' },
  { re: /\bthis (file|function|class|module|script|snippet|error|stack ?trace)\b/i,                 w: -3, tag: 'own_code' },
  { re: /\b(attached|uploaded|the (pdf|csv|spreadsheet|document) i)\b/i,                            w: -3, tag: 'attachment' },
  // Timeless / definitional
  { re: /^(what is|what's|define|explain) (a|an|the)\b(?!.*\b(latest|current(ly)?|today|now|new(est)?|price|pricing|cost|version|release[ds]?|20(2[4-9]|3\d))\b)/i, w: -2, tag: 'definitional' },
];

// Task-type bias — consumes classifier.js's winner, never re-classifies.
const TASK_BIAS = {
  research:  2,   // spec: research → YES-leaning by default
  simple_qa: 1,   // one-shot factual questions are often live-world facts
  coding:    -1,  // model knowledge usually suffices unless a signal fires
  debugging: -1,
  reasoning: -1,  // spec: reasoning → NO-leaning
  analysis:  0,
};

const THRESHOLD = 3;

/**
 * @param {{
 *   userMessage: string,
 *   taskType: string,          // classifier.js's classifyTask(...).task
 *   hasWorkspaceId?: boolean,
 *   profileWantsSearch?: boolean,  // execution profile lists web_search (research_request)
 * }} input
 * @returns {{ needed: boolean, score: number, confidence: number, reason: string, signals: string[] }}
 */
export function decideWebSearch({ userMessage, taskType, hasWorkspaceId = false, profileWantsSearch = false }) {
  const msg = String(userMessage ?? '');

  if (OPT_OUT_RE.test(msg)) {
    return { needed: false, score: 0, confidence: 0.95, reason: 'user explicitly opted out of web search', signals: ['opt_out'] };
  }
  if (BLOCKED_TASK_TYPES.has(taskType)) {
    return { needed: false, score: 0, confidence: 0.9, reason: `task type "${taskType}" never needs the web`, signals: [`blocked:${taskType}`] };
  }
  if (taskType === 'reasoning' && PURE_MATH_RE.test(msg.trim())) {
    return { needed: false, score: 0, confidence: 0.95, reason: 'pure math/logic — model-internal', signals: ['pure_math'] };
  }
  if (OPT_IN_RE.test(msg)) {
    return { needed: true, score: THRESHOLD + 3, confidence: 0.95, reason: 'user explicitly asked to search the web', signals: ['opt_in'] };
  }

  let score = TASK_BIAS[taskType] ?? 0;
  const signals = [];
  if (TASK_BIAS[taskType]) signals.push(`task:${taskType}(${TASK_BIAS[taskType] > 0 ? '+' : ''}${TASK_BIAS[taskType]})`);

  let hasFreshnessSignal = false;
  for (const { re, w, tag } of POSITIVE) {
    if (re.test(msg)) {
      score += w;
      signals.push(`+${tag}`);
      if (['freshness', 'temporal', 'news', 'release', 'lifecycle', 'live_facts', 'role_holder', 'recent_year'].includes(tag)) {
        hasFreshnessSignal = true;
      }
    }
  }
  for (const { re, w, tag } of NEGATIVE) {
    if (re.test(msg)) { score += w; signals.push(`-${tag}`); }
  }

  // Workspace-grounded technical questions answer from the repo, not the web
  // — UNLESS a freshness signal fired ("is our express version still
  // supported?" genuinely needs both).
  if (hasWorkspaceId
      && ['project_query', 'file_analysis', 'coding', 'debugging'].includes(taskType)
      && !hasFreshnessSignal) {
    score -= 2;
    signals.push('-workspace_grounded');
  }

  // Execution-profile pull (research_request lists web_search) — a nudge,
  // not a mandate: "explain the concept of technical debt" is research but
  // needs no live data.
  if (profileWantsSearch) { score += 2; signals.push('+profile'); }

  const needed = score >= THRESHOLD;
  const confidence = Math.max(0.1, Math.min(0.95, 0.4 + Math.abs(score - THRESHOLD) * 0.1 + (needed ? 0.1 : 0)));
  const top = signals.filter(s => s.startsWith('+')).slice(0, 3).join(', ');

  return {
    needed,
    score,
    confidence: Math.round(confidence * 100) / 100,
    reason: needed
      ? `live-web signals detected (${top || 'profile'})`
      : 'no strong freshness/documentation/pricing signal — model knowledge suffices',
    signals,
  };
}

// ── Query builder ─────────────────────────────────────────────────────────────

const LEAD_IN_RE = /^\s*(hey|hi|hello|please|ok(ay)?|can you|could you|would you|i want you to|i need you to)[,\s]+/i;
const SEARCH_VERB_RE = /^\s*(search( the web| online)?( for)?|google( for)?|look up|find( out)?( about)?|check( online)?|tell me|what do you know about)[:\s]+/i;

/**
 * Distill the user message into the provider query.
 * @param {string} userMessage
 * @returns {string} ≤380 chars
 */
export function buildSearchQuery(userMessage) {
  let q = String(userMessage ?? '').trim();
  for (let i = 0; i < 3; i++) {          // peel stacked lead-ins: "hey, can you google …"
    const before = q;
    q = q.replace(LEAD_IN_RE, '').replace(SEARCH_VERB_RE, '');
    if (q === before) break;
  }
  q = q.replace(/\s+/g, ' ').replace(/[?!.]+$/, '').trim();
  if (q.length > 380) q = `${q.slice(0, 377)}…`;
  return q || String(userMessage ?? '').slice(0, 380);
}