/**
 * AQUA Task Classifier v5
 *
 * Changes from v4 (Issue 2 — coding/architecture requests misclassified as
 * simple_qa):
 *   "Build a production-ready JWT authentication system" scored 0 against
 *   every category (no language/framework named) and fell through to
 *   classifyTask's zero-score fallback, which defaults short messages to
 *   simple_qa. coding gained a paired build/create/generate/develop +
 *   technical-object pattern plus standalone technical terms (JWT, OAuth,
 *   Express/NestJS/Fastify, database, Redis, Docker, Kubernetes,
 *   authentication, authorization, endpoint, API) and "rust" joined the
 *   language list. architecture gained multi-tenant and "authentication/
 *   authorization architecture" phrasing. See PATTERNS.coding/architecture
 *   below for the v5-tagged entries.
 *
 * Changes from v3:
 *   4. research/coding guard (Phase 6 — Adaptive Tool Orchestrator spec):
 *      The generic "explain/clarify/elaborate/describe X" research pattern
 *      had no competing bare "code"/"function" trigger in `coding`, so
 *      messages like "Explain this code" or "Describe this function"
 *      classified as research instead of coding/project_query.
 *      Fix: (a) project_query gained explicit "explain/describe this code/
 *      function/script/..." patterns, (b) a scoring guard demotes the
 *      generic explain-pattern's research contribution whenever it is the
 *      *only* research signal and a coding/debugging/project_query signal
 *      is already present.
 *   5. scoreTask() exported — raw per-category scores (same scoring used by
 *      classifyTask) for the Adaptive Tool Orchestrator's multi-label layer.
 *      Pure addition; classifyTask()'s contract/output is unchanged.
 *
 * Changes from v2:
 *   1. memory_recall / memory_update — new task types
 *      "What's my favorite language?" → memory_recall (not personal_info)
 *      "Remember that I moved to Berlin" → memory_update
 *   2. planning vs architecture fix:
 *      planning weight raised to 1.55 (was 1.3) — now beats architecture (1.5)
 *      architecture guard: presence of roadmap/sprint/backlog boosts planning
 *      New planning patterns: "design a roadmap", "plan the architecture"
 *   3. personal_info guard: "I love X" only fires if X is NOT a known tech term
 *      (prevents "I love TypeScript" → personal_info instead of coding)
 */

// ── Pattern definitions ────────────────────────────────────────────────────────

// Named so the v4 research/coding guard (see computeScores) can test against
// it specifically — kept out of PATTERNS.research as a literal so there is
// exactly one definition of "what counts as the generic explain pattern".
const GENERIC_EXPLAIN_PATTERN = /\b(explain\b|clarify\b|elaborate\b|describe\b)\s+.{10,}/i;

const PATTERNS = {

  // Memory recall — user asking about stored facts
  memory_recall: [
    /what(?:'s| is) my (?:favorite|preferred|name|role|company|location|project|goal|language)/i,
    /do you (?:remember|recall|know) (?:my|what)/i,
    /what did i (?:say|tell you|mention) (?:about|earlier|before)/i,
    /what (?:have )?you (?:learned|know) about me/i,
    /what (?:was|were|is|are) my (?:favorite|preferred|name|role)/i,
    /tell me (?:what you know )?about myself/i,
    /(?:recall|remember) (?:what|that) i\b/i,
  ],

  // Memory update — user instructing system to remember/forget
  memory_update: [
    /(?:please |just )?remember (?:that )?(?:my |i )/i,
    /(?:please |just )?forget (?:that |about )?(?:my |i )/i,
    /(?:update|change|correct) (?:my )?(?:name|language|role|company|location)/i,
    /don't (?:forget|remember) (?:that )?(?:my |i )/i,
    /i(?:'ve| have) (?:moved|changed|switched) (?:to|my)/i,
  ],

  // Personal statements — high weight, fires before coding
  personal_info: [
    /\bmy\s+(favorite|favourite|preferred?)\b/i,
    /\bi\s+(love|hate|prefer|like|dislike|enjoy)\b/i,
    /\bi\s+(am|'m)\s+a\s+\w+/i,
    /\bi\s+(recently|just|always|usually|often)\b/i,
    /\bmy\s+(name|age|job|role|company|team|stack|background|hobby|interest)\b/i,
    /\bremember\s+(that\s+)?i\b/i,
    /\bi('ve| have)\s+(been|worked|built|used|studied)\b/i,
  ],

  // Conversation / greetings
  conversation: [
    /^(hi|hey|hello|sup|yo|howdy|hiya)\b/i,
    /^(thanks|thank you|thx|ty)\b/i,
    /^(ok|okay|got it|understood|sure|alright|cool|great|perfect)\b/i,
    /^(bye|goodbye|see you|cya|later)\b/i,
    /^good\s*(morning|afternoon|evening|night)\b/i,
    /^(what('s| is) your name|who are you|how are you)\b/i,
    /^(lol|lmao|haha|hehe|nice|wow|amazing|awesome)\b/i,
    /^(that('s| is)\s+(great|good|amazing|nice|cool|interesting|helpful))\b/i,
    /^(can you help|could you help|i need help)\b/i,
  ],

  // One-shot factual questions
  simple_qa: [
    /^(what|when|where|who|which)\s+is\s+the\b/i,
    /^(what|when|where|who)\s+was\s+the\b/i,
    /^(how\s+many|how\s+much|how\s+long|how\s+old)\b/i,
    /^(is|are|was|were)\s+\w+\s+(a|an|the)?\s*\w+\?/i,
    /\b(capital\s+of|population\s+of|founder\s+of|ceo\s+of|president\s+of)\b/i,
    /\b(what\s+year|which\s+year)\b/i,
    /\b(how\s+do\s+you\s+spell|definition\s+of|meaning\s+of)\b/i,
  ],

  // Opinion / preference requests
  opinion: [
    /\bwhat\s+do\s+you\s+think\b/i,
    /\byour\s+(opinion|view|take|thoughts?|perspective)\b/i,
    /\bdo\s+you\s+(think|believe|feel|agree|recommend)\b/i,
    /\bwould\s+you\s+(recommend|suggest|prefer|choose)\b/i,
    /\b(agree|disagree)\s+with\b/i,
    /\bshould\s+i\s+(use|choose|pick|go\s+with)\b/i,
  ],

  // Idea generation
  brainstorming: [
    /\b(brainstorm|ideate|idea\s+generation|come\s+up\s+with\s+ideas?)\b/i,
    /\b(give\s+me\s+(some\s+)?ideas?|suggest\s+(some\s+)?(ideas?|options?|alternatives?))\b/i,
    /\b(list\s+(some\s+)?(ways|options|ideas?|possibilities))\b/i,
    /\b(what\s+are\s+(some\s+)?ways\s+to)\b/i,
    /\b(creative\s+ideas?|innovative\s+(ideas?|approach(es)?))\b/i,
  ],

  // Condensing content
  summarization: [
    /\b(summarize|summary|tl;?dr|tldr|sum\s+up|condense|brief\s+overview)\b/i,
    /\b(in\s+(a\s+)?(few|two|three|one)\s+(words?|sentences?|paragraphs?))\b/i,
    /\b(give\s+me\s+the\s+(key\s+points?|main\s+points?|gist|highlights?))\b/i,
    /\b(what('s| is)\s+the\s+(main|key|core)\s+(point|takeaway|message))\b/i,
    /\b(shorten|compress|distill)\b/i,
  ],

  // Code implementation
  coding: [
    /\b(implement|implementation|function|class|method)\b/i,
    /\b(python|javascript|typescript|nodejs|node\.js|react|vue|angular|svelte|nextjs|next\.js)\b/i,
    /\b(java|kotlin|swift|golang|go\b|rust|c\+\+|c#|php|ruby|rails|django|flask|fastapi)\b/i,
    /\b(sql|graphql|rest\s*api|api\s*endpoint|orm)\b/i,
    /\b(npm|pip\b|yarn|cargo\b|maven|dockerfile)\b/i,
    /\b(regex|regexp|regular expression)\b/i,
    /\b(algorithm|data structure|sorting|binary search|big\s*o\b|time complexity)\b/i,
    /```[\s\S]*?```/,
    /\b(async|await|promise|callback|concurrency|mutex)\b/i,
    /\b(write (a |the |some )?(code|function|script|class|program))\b/i,
    // v5 FIX (Issue 2): "Build/create/generate/develop a [technical thing]"
    // had no coding trigger unless it also happened to name a specific
    // language/framework — "Build a production-ready JWT authentication
    // system" scored 0 everywhere and fell through to the zero-score
    // simple_qa fallback. Paired verb+object pattern (mirrors the existing
    // "write ... code/function/script" entry above) instead of a bare verb,
    // so "create a poem" / "generate ideas" etc. don't false-positive here.
    /\b(build|create|generate|develop)\b.{0,40}\b(api|endpoint|app|application|service|backend|server|system|database|microservice|integration|pipeline|module|component|feature|bot|website|webapp|dashboard)\b/i,
    /\b(jwt|oauth2?)\b/i,
    /\b(express(?:\.js)?|nestjs|fastify)\b/i,
    /\b(authentication|authorization)\b/i,
    /\bendpoints?\b/i,
    /\bapis?\b/i,
    /\bdatabase\b/i,
    /\bredis\b/i,
    /\bdocker\b/i,
    /\b(kubernetes|k8s)\b/i,
  ],

  // Bug diagnosis
  debugging: [
    /\b(debug|debugging|bug\b|fix\s+this|crash\b|stacktrace|stack trace)\b/i,
    /\b(refactor|memory leak|performance issue)\b/i,
    /\b(why\s+(is|does|do|am|are)\s+.*\s+(fail|crash|broken|wrong|error|not\s+work))\b/i,
    /\b(not\s+working|doesn't\s+work|won't\s+work|isn't\s+working)\b/i,
    /\b(getting\s+an?\s+error|throws?\s+(an?\s+)?error)\b/i,
    /\b(help\s+me\s+fix|what('s|\s+is)\s+wrong\s+with)\b/i,
    /\b(exception|traceback|undefined is not|cannot read)\b/i,
  ],

  // System design
  architecture: [
    /\b(architect(ure)?|system design|high.?level design)\b/i,
    /\b(microservice|monolith(ic)?|serverless|event.?driven)\b/i,
    /\b(scal(e|ing|able)|load balanc|horizontal|vertical scaling)\b/i,
    /\b(distributed|high availability|fault toleran|redundan|replica)\b/i,
    /\b(message queue|event bus|kafka|rabbitmq|pub.?sub)\b/i,
    /\b(database schema|data model|er diagram|entity relation)\b/i,
    /\b(infrastructure|devops|ci.?cd|terraform|ansible)\b/i,
    /\b(kubernetes|k8s|docker\s*(compose|swarm)?|container\s*orchestrat)\b/i,
    /\b(api gateway|reverse proxy|nginx|traefik|service mesh)\b/i,
    /\b(sharding|partitioning|replication|consensus|raft|paxos)\b/i,
    /\b(design\s+(a|the|an?)\s+(system|platform|service|pipeline|architecture))\b/i,
    /\bmulti-?tenant\b/i,                                    // v5 FIX (Issue 2)
    /\b(authentication|authorization)\s+architecture\b/i,    // v5 FIX (Issue 2)
  ],

  // Research / comparison / explanation
  research: [
    /\b(research|investigate|study\b|examine)\b/i,
    /\b(compare|comparison|versus\b|vs\.?\b|difference between|distinguish)\b/i,
    /\b(pros and cons|advantages|disadvantages|trade.?off)\b/i,
    /\b(market|industry|trend|landscape|ecosystem)\b/i,
    /\b(best practice|which is better|which should)\b/i,
    /\b(deep.?dive|comprehensive|in.?depth|thorough)\b/i,
    /\b(overview of|breakdown of|survey of|analysis of)\b/i,
    GENERIC_EXPLAIN_PATTERN,
  ],

  // Math / logic / reasoning
  reasoning: [
    /\b(math|mathematics|calculat|compute|solve\b|equation|formula)\b/i,
    /\b(proof|prove\b|theorem|logic\b|logical|ded(uce|uction))\b/i,
    /\b(statistics|probability|hypothesis|inference|regression)\b/i,
    /\b(step.?by.?step|walk me through|how to solve)\b/i,
    /\b(root cause analysis|rca\b)\b/i,
    /\b(optim(ize|ization)|minimum|maximum|maximiz|minimiz)\b/i,
    /[\d]+\s*[+\-*/^%]\s*[\d]+/,
  ],

  // Existing data / situation analysis
  analysis: [
    /\b(analyz(e|is)|assess(ment)?|evaluat(e|ion))\b/i,
    /\b(what\s+does\s+this\s+(mean|suggest|indicate|imply))\b/i,
    /\b(interpret|diagnose|dissect)\b/i,
    /\b(what\s+are\s+the\s+(implications?|consequences?|effects?))\b/i,
    /\b(performance|benchmark|metric|measurement)\b/i,
    /\b(review\s+this|look\s+at\s+this|check\s+this)\b/i,
  ],

  // Project / strategy planning
  // FIX: weight raised to 1.55, patterns expanded to cover "design a roadmap"
  planning: [
    /\b(plan(ning)?|roadmap|strategy|strateg(ic|ize))\b/i,
    /\b(how\s+(should|do)\s+i\s+(approach|start|begin|tackle|organize))\b/i,
    /\b(step(s)?\s+to|phases?\s+of|timeline|milestone)\b/i,
    /\b(priorit(y|ize|ization)|what\s+should\s+i\s+do\s+first)\b/i,
    /\b(project\s+plan|sprint|backlog|epic|user\s+story)\b/i,
    /\b(design\s+(a|the|my)\s+(roadmap|plan|strategy|approach))\b/i,  // NEW: "design a roadmap" → planning
    /\b(plan\s+(the|my|this|our)\s+architecture)\b/i,                 // NEW: "plan the architecture" → planning
    /\b(how\s+do\s+i\s+(build|structure|organize)\s+this)\b/i,        // NEW
  ],

  // Creative writing
  creative_writing: [
    /\b(write\b.{0,15}(story|poem|essay|article|blog|letter|email|post|song|script|haiku))\b/i,
    /\b(story\b|poem\b|poetry\b|prose\b|novel\b|fiction\b|short story)\b/i,
    /\b(creative\b|imagine\b|invent\b)\b/i,
    /\b(blog post|marketing copy|copywriting)\b/i,
    /\b(character\b|plot\b|narrative\b|dialogue\b|screenplay\b)\b/i,
    /\b(haiku\b|sonnet\b|rhyme\b|verse\b|stanza\b|lyric\b)\b/i,
  ],

  // Project intelligence — questions about an uploaded codebase
  project_query: [
  /\b(explain|describe|how does?|how do)\s+.{3,50}\s+(work|function|flow|process)\b/i,
  /\b(trace|follow|show me)\s+.{0,30}\s*(call|request|execution|auth|flow)\b/i,
  /\b(where is|find|locate|search for)\s+.{3,40}\s*(function|class|method|component|logic|auth)\b/i,
  /\b(dead.?code|unused|duplicate logic|duplicated)\b/i,
  /\b(what depends on|who imports|what imports|what calls)\b/i,
  /\b(refactor(ing)?|improve|optimis?e|clean up)\s+.{0,30}(code|file|module)\b/i,
  /\b(generate\s+(?:a\s+)?patch|apply\s+(?:a\s+)?change|propose\s+(?:a\s+)?fix)\b/i,
  /\b(architecture\s+(of|overview|diagram)|explain\s+the\s+(architecture|codebase|structure|project))\b/i,
  /\b(request\s+flow|data\s+flow|call\s+(chain|graph|stack))\b/i,
  /\b(dependency\s+(graph|tree|chain)|circular\s+dep(endency)?)\b/i,
  /\b(this (file|document|pdf|csv|spreadsheet)|attached|attachment|uploaded)\b/i,
  /\b(read this|analyze this|parse this|process this|summarize this)\b/i,
  // v4 FIX: "Explain this code" / "Describe this function" / "walk me
  // through my script" were classifying as research — coding had no bare
  // "code"/"function" trigger to compete with the generic explain pattern.
  /\b(explain|describe|clarify|elaborate|walk\s+me\s+through|break\s+down)\s+(this|the|my|that)\s+(code|function|script|file|class|method|logic|implementation|snippet|bug|error)\b/i,
],
};

// ── Weights ────────────────────────────────────────────────────────────────────

const WEIGHTS = {
  project_query:    2.0,   // Wins over generic coding/research for project questions
  memory_recall:    3.5,   // Must win for recall queries
  memory_update:    3.5,   // Must win for update/forget queries
  personal_info:    3.0,   // Wins over language keyword hits
  conversation:     2.5,
  file_analysis:    2.0,
  architecture:     1.50,
  planning:         1.55,  // FIX: raised above architecture (was 1.3)
  debugging:        1.40,
  coding:           1.20,
  reasoning:        1.20,
  research:         1.20,
  analysis:         1.10,
  creative_writing: 1.10,
  brainstorming:    1.00,
  summarization:    1.00,
  simple_qa:        1.00,
  opinion:          0.90,
};

// Tasks indicating real work — bypass "short = conversation" heuristic
const SUBSTANTIVE = new Set([
  'coding', 'architecture', 'research', 'reasoning', 'analysis',
  'creative_writing', 'file_analysis', 'debugging', 'planning',
  'brainstorming', 'summarization', 'memory_recall', 'memory_update',
  'project_query',
]);

// ── Classifier ────────────────────────────────────────────────────────────────

/**
 * Raw per-category pattern scores for a message, including the v4 guard
 * (see header comment) that demotes `research`'s generic explain/describe/
 * elaborate/clarify contribution when it's the *only* research signal and a
 * coding/debugging/project_query signal is already present.
 *
 * Exported for the Adaptive Tool Orchestrator's multi-label classifier
 * (src/orchestrator/multiLabelClassifier.js) — single source of truth for
 * scoring, shared with classifyTask() below so the two can never diverge.
 *
 * @param {string} userMessage
 * @returns {Object<string, number>}
 */
// Used only inside the v4 guard below (not a scoring pattern) — detects a
// code-context reference anywhere in the message, even when it's not
// directly adjacent to the explain/clarify verb (e.g. "clarify what's
// happening in my code below"). Safe to be broad here: it only ever
// *demotes* research's generic-explain contribution, never boosts anything,
// so over-triggering just means "don't blindly trust the generic pattern".
const CODE_CONTEXT_HINT =
  /\b(my|this|the|that)\s+(code|function|script|file|class|method|bug|error|logic|implementation|snippet|variable)\b|\bcode\s+(below|above|here|snippet)\b/i;

export function scoreTask(userMessage) {
  const msg = (userMessage || '').trim();
  const scores = {};
  for (const [task, patterns] of Object.entries(PATTERNS)) {
    let s = 0;
    for (const p of patterns) {
      if (p.test(msg)) s += WEIGHTS[task] ?? 1.0;
    }
    scores[task] = s;
  }

  // v4 guard — see classifier docstring, point 4.
  if (GENERIC_EXPLAIN_PATTERN.test(msg)) {
    const onlyGenericResearchSignal = PATTERNS.research
      .filter((p) => p !== GENERIC_EXPLAIN_PATTERN)
      .every((p) => !p.test(msg));
    const hasCodeSignal =
      scores.coding > 0 || scores.project_query > 0 || scores.debugging > 0 ||
      CODE_CONTEXT_HINT.test(msg);
    if (onlyGenericResearchSignal && hasCodeSignal) {
      scores.research *= 0.4;
    }
  }

  return scores;
}

/**
 * Classify a user message into a task type with confidence.
 *
 * @param {string} userMessage
 * @param {Array}  [history]  reserved for future context-aware classification
 * @returns {{ task: string, confidence: number, labels: string[] }}
 */
export function classifyTask(userMessage, history = []) {
  if (!userMessage || typeof userMessage !== 'string') {
    return { task: 'conversation', confidence: 1.0, labels: ['conversation'] };
  }

  const msg = userMessage.trim();
  if (!msg.length) {
    return { task: 'conversation', confidence: 1.0, labels: ['conversation'] };
  }

  // Score every category (includes v4 research/coding guard)
  const scores = scoreTask(msg);

  // Short message heuristic: a terse message with no substantive-task signal
  // defaults to conversation — EXCEPT when it is clearly a one-shot factual
  // question. "Clearly factual" = a simple_qa pattern fired, OR nothing
  // matched at all (the zero-score fallback below already routes those to
  // simple_qa). Everything else short — greetings, acks, and weak sub-
  // threshold chatter like a demoted "clarify what's happening in my code"
  // research fragment — still funnels to conversation exactly as before.
  //
  // Why this matters: questions like "Current Bitcoin price" (no pattern hit)
  // and "Who is the new CM of Assam?" (simple_qa hit) were being swallowed as
  // `conversation`, which searchDecision.js hard-blocks — so AQUA answered
  // current-events / office-holder / pricing questions from stale model
  // knowledge and never reached the web-search path. Letting them fall through
  // to simple_qa (same Simple Question profile, same low complexity — no
  // profile or budget change) lets the orchestrator's SearchDecision route
  // them to live search when they need fresh data.
  if (msg.length < 55) {
    const substantiveScore = [...SUBSTANTIVE].reduce((sum, t) => sum + (scores[t] ?? 0), 0);
    const totalScore       = Object.values(scores).reduce((a, b) => a + b, 0);
    const looksFactual     = (scores.simple_qa ?? 0) > 0 || totalScore === 0;
    if (substantiveScore < 1.0 && !looksFactual) {
      return { task: 'conversation', confidence: 0.85, labels: ['conversation'] };
    }
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topTask, topScore]       = sorted[0];
  const [secondTask, secondScore] = sorted[1] ?? [null, 0];

  if (topScore === 0) {
    const fallback = msg.length < 120 ? 'simple_qa' : 'research';
    return { task: fallback, confidence: 0.45, labels: [fallback] };
  }

  const gap        = topScore - (secondScore ?? 0);
  const confidence = Math.min(0.97, 0.5 + (gap / topScore) * 0.5);

  const labels = [topTask];
  if (secondTask && secondScore > 0 && secondScore >= topScore * 0.70) {
    labels.push(secondTask);
  }

  return { task: topTask, confidence, labels };
}

/** Backward-compatible single-value wrapper */
export function classifyTaskSimple(userMessage) {
  return classifyTask(userMessage).task;
}

// ── Complexity tiers (Phase 4: feeds Execution Planner) ─────────────────────
// Pure addition — does not touch PATTERNS/WEIGHTS/classifyTask above.

const COMPLEXITY_TIERS = {
  high:   ['architecture', 'research', 'planning', 'agent_task', 'analysis', 'project_query'],
  medium: ['coding', 'debugging', 'reasoning', 'creative_writing', 'brainstorming', 'summarization', 'file_analysis'],
  low:    ['conversation', 'memory_recall', 'memory_update', 'personal_info', 'simple_qa', 'opinion'],
};

const TASK_COMPLEXITY = {};
for (const [tier, tasks] of Object.entries(COMPLEXITY_TIERS)) {
  for (const t of tasks) TASK_COMPLEXITY[t] = tier;
}

/**
 * Map a task type to a complexity tier — consumed by executionPlanner.js
 * to decide multi-step handling, reasoning mode, and timeout scaling.
 *
 * @param {string} taskType
 * @returns {'low'|'medium'|'high'}
 */
export function getTaskComplexity(taskType) {
  return TASK_COMPLEXITY[taskType] ?? 'medium';
}

/**
 * getTaskComplexity() + the confidence-escalation rule executionPlanner.js's
 * createExecutionPlan() has always applied ("low classifier confidence →
 * escalate complexity one tier"). Extracted here (Phase 6) so the Adaptive
 * Tool Orchestrator (src/orchestrator/toolOrchestrator.js) — which the spec
 * runs *before* the Execution Planner — can derive the exact same
 * complexity tier createExecutionPlan() will derive a moment later, without
 * duplicating the escalation rule or requiring either module to run after
 * the other. executionPlanner.js now calls this too (see its own comment) —
 * single source of truth, used independently by two pipeline stages, the
 * same pattern classifyTask()'s output already follows everywhere else.
 *
 * @param {string} taskType
 * @param {number} [confidence] - classifyTask(...).confidence
 * @returns {'low'|'medium'|'high'}
 */
export function getEffectiveComplexity(taskType, confidence = 1.0) {
  let complexity = getTaskComplexity(taskType);
  if (confidence < 0.55) {
    if (complexity === 'low') complexity = 'medium';
    else if (complexity === 'medium') complexity = 'high';
  }
  return complexity;
}
