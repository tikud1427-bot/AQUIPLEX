/**
 * AQUA Mind — Observers (the "Observe → Infer" step)
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns ONE chat turn into inference SIGNALS for the belief engine.
 *
 * Deliberately zero-LLM, pure heuristics — same discipline as
 * workspaceAnalyzer: deterministic, fast (<1ms), runs inline on every turn
 * without cost. LLM-assisted observation can be added later as an
 * additional observer without changing any consumer.
 *
 * Sources fused per turn:
 *   1. classifier output      → identity / behavior signals
 *   2. message text           → communication style, knowledge, sentiment
 *   3. extracted schema facts → FACT BRIDGE: lifts the existing regex
 *      extractor's output into the cognitive model as evidence. Reuses the
 *      whole proven extraction pipeline — no duplicate extraction.
 *   4. workspace presence     → builder/behavior signals
 *
 * Never asks the user trait questions. Everything is inferred (Layer 2 rule).
 */
import { DIMENSIONS } from './mindSchema.js';
import { uusEnabled } from '../understanding/flags.js';

// ── 1. Task-type → trait mapping ──────────────────────────────────────────────
const TASK_TRAIT_MAP = {
  coding:           [{ key: 'engineer',          strength: 0.5 }, { key: 'builder', strength: 0.35 }],
  debugging:        [{ key: 'engineer',          strength: 0.55 }],
  architecture:     [{ key: 'systems_thinker',   strength: 0.6 }, { key: 'engineer', strength: 0.3 }],
  planning:         [{ key: 'long_term_planner', strength: 0.55 }],
  research:         [{ key: 'researcher',        strength: 0.5 }],
  analysis:         [{ key: 'researcher',        strength: 0.4 }],
  creative_writing: [{ key: 'creative',          strength: 0.5 }],
  brainstorming:    [{ key: 'creative',          strength: 0.4 }],
  project_query:    [{ key: 'builder',           strength: 0.4 }],
};

// ── 2. Text heuristics ────────────────────────────────────────────────────────
//
// TECH TERMS — two sets, because half of these are ordinary English words.
//
// The single flat list this replaces matched `go` in "go deep, don't
// over-explain", `rust`, `swift`, `react`, `express`, `java`, `ruby`, `flask`
// and `azure` the same way. Reproduced 3/3: "Go deep…", "I want to go to the
// beach", "Just go ahead" each minted knowledge:tech:go. In ordinary chat that
// is noise buried under real signal. On a "here's what I understand about you"
// card it is the one line that costs the user's trust, so it is a correctness
// bug, not a tidy-up.
//
// UNAMBIGUOUS terms mean the technology wherever they appear.
const TECH_UNAMBIGUOUS = String.raw`typescript|javascript|python|golang|kotlin|c\+\+|c#|sql|vue|svelte|next\.?js|node\.js|django|fastapi|postgres(?:ql)?|mysql|mongodb|redis|docker|kubernetes|k8s|graphql|grpc|terraform|aws|gcp|vite|webpack`;

// AMBIGUOUS terms are also ordinary English. They must earn their reading.
const TECH_AMBIGUOUS = String.raw`rust|go|java|swift|ruby|react|angular|express|node|flask|azure|tailwind`;

const TECH_ANY_RE = new RegExp(String.raw`\b(${TECH_UNAMBIGUOUS}|${TECH_AMBIGUOUS})\b`, 'gi');
const TECH_UNAMBIGUOUS_RE = new RegExp(String.raw`^(?:${TECH_UNAMBIGUOUS})$`, 'i');

// Local evidence that an ambiguous token is being used technically. Local on
// purpose: another tech word ELSEWHERE in the message says nothing about which
// sense THIS token carries — "I go with Python daily" is not about Golang.
const TECH_PRE = new RegExp(
  String.raw`\b(?:in|on|using|uses?|used|with|write|writes|writing|wrote|written|codes?|coded|coding|learn(?:s|ing|ed|t)?|knows?|knew|prefers?|preferred|deploy(?:ed|ing)?\s+to|host(?:ed|ing)?\s+on|runs?\s+on|running\s+on|migrat(?:e|es|ing)\s+to|switch(?:es|ing)?\s+to|built\s+(?:in|with)|build\s+(?:in|with))\s+$`,
  'i',
);
const TECH_POST = new RegExp(
  String.raw`^\s+(?:code|codebase|module|modules|package|packages|library|libraries|framework|frameworks|app|apps|application|service|services|server|api|apis|backend|frontend|project|projects|developer|dev|programmer|engineer|runtime|compiler|version|goroutine|goroutines|routine|hooks|component|components|template|templates|config|cli|sdk|binary|struct|structs|trait|traits|crate|crates|gem|gems|mod|migration|migrations)\b`,
  'i',
);
// A stack listing: "React + Postgres", "Go, Python, Rust", "Node & Express".
// Only propagates FROM a token that already qualified, and only across a
// connector that DIRECTLY joins the two — "go and learn Python" never links
// `go` to `python`, because `learn` sits between them.
const TECH_JOIN = /^\s*(?:[+,/&]|and|or)\s*$/i;
const FOUNDER_HINTS = /\b((?:my|our) (?:startup|company|cofounder|co-founder|investors?|product|platform|users|customers)|fundrais|pitch deck|investor (?:demo|meeting|pitch|update)|mvp|go.to.market|runway)\b/i;
const DEADLINE_RE   = /\b(by|before|due|deadline|ship(ping)? (by|on)|launch(ing)? (by|on))\s+(tomorrow|tonight|today|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?|\d)/i;
const REJECT_FLASHY = /\b(too (flashy|busy|cluttered|noisy|much)|less is more|keep it (simple|clean|minimal)|simpler|cleaner|minimal(ist)?)\b/i;
const WANTS_DETAIL  = /\b(explain in detail|deep dive|step by step|walk me through|thorough(ly)?|comprehensive)\b/i;
const WANTS_BRIEF   = /\b(tl;?dr|be brief|short answer|quick(ly)? (answer|version)|just tell me|no fluff|concise)\b/i;
const RISK_AVERSE   = /\b(don'?t break|be careful|safe(st)? (way|option)|backward.?compat|without breaking|non.?breaking)\b/i;
const RISK_TOLERANT = /\b(rewrite (it|everything|from scratch)|rip (it )?out|nuke it|start over|move fast)\b/i;

/** Normalization preserved exactly from the original: next.js → nextjs, node.js → node. */
function normalizeTechTerm(raw) {
  const lower = raw.toLowerCase();
  return lower.replace(/\.?js$/, lower === 'next.js' || lower === 'nextjs' ? 'js' : '');
}

/**
 * Every tech token in the message, with a qualified/unqualified verdict.
 * Two passes: local evidence first, then propagation across list connectors
 * from tokens that already qualified on their own.
 */
function techMentions(text) {
  const src = String(text ?? '');
  const hits = [];
  const re = new RegExp(TECH_ANY_RE.source, 'gi'); // own lastIndex — never share a stateful regex
  let m;
  while ((m = re.exec(src)) !== null) {
    hits.push({ raw: m[0], start: m.index, end: m.index + m[0].length, qualified: false });
  }

  // Pass 1 — a term qualifies on its own if it is unambiguous, or if the words
  // touching it read technically.
  for (const h of hits) {
    if (TECH_UNAMBIGUOUS_RE.test(h.raw)) { h.qualified = true; continue; }
    const before = src.slice(Math.max(0, h.start - 40), h.start);
    const after  = src.slice(h.end, h.end + 40);
    if (TECH_PRE.test(before) || TECH_POST.test(after)) h.qualified = true;
  }

  // Pass 2 — propagate along enumerations, in both directions, until stable.
  // "The React + Postgres stack" qualifies React from Postgres; "I write Rust
  // and Go" qualifies Go from Rust, which qualified from `write`.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < hits.length - 1; i++) {
      const a = hits[i], b = hits[i + 1];
      if (a.qualified === b.qualified) continue;
      if (!TECH_JOIN.test(src.slice(a.end, b.start))) continue;
      a.qualified = b.qualified = true;
      changed = true;
    }
  }

  const found = new Map();
  for (const h of hits) {
    if (!h.qualified) continue;
    const t = normalizeTechTerm(h.raw);
    found.set(t, (found.get(t) || 0) + 1);
  }
  return found;
}

// ── 3. Fact bridge: schema facts → belief signals ─────────────────────────────
const FACT_TO_BELIEF = {
  favorite_language:  (f) => ({ dimension: DIMENSIONS.PREFERENCES, key: 'primary_language',  value: f.value, strength: 0.9 }),
  languages:          (f) => ({ dimension: DIMENSIONS.KNOWLEDGE,   key: 'languages',          value: f.value, strength: 0.7 }),
  favorite_framework: (f) => ({ dimension: DIMENSIONS.PREFERENCES, key: 'frameworks',         value: f.value, strength: 0.8 }),
  favorite_editor:    (f) => ({ dimension: DIMENSIONS.PREFERENCES, key: 'editor',             value: f.value, strength: 0.85 }),
  favorite_os:        (f) => ({ dimension: DIMENSIONS.PREFERENCES, key: 'os',                 value: f.value, strength: 0.85 }),
  // The single most basic thing AQUA can know, and it had no bridge either.
  // `name` was extracted at 0.98 on "I'm Maya." and then went nowhere, so the
  // card's "You" section rendered empty for a user who had introduced
  // themselves in their first sentence. Same one-line gap as `project` below —
  // found by rendering the card rather than by reading the map.
  name:               (f) => ({ dimension: DIMENSIONS.IDENTITY,    key: 'name',               value: f.value, strength: 0.9 }),
  profession:         (f) => ({ dimension: DIMENSIONS.IDENTITY,    key: 'profession',         value: f.value, strength: 0.85 }),
  workplace:          (f) => ({ dimension: DIMENSIONS.IDENTITY,    key: 'organization',       value: f.value, strength: 0.85 }),
  // What someone is BUILDING. This entry was missing, and its absence was the
  // reason the card's "Working on" section was structurally empty for anyone
  // who had not uploaded a document: the extractor caught the project
  // perfectly (`project="…"`, schema match, 0.90) and then nothing consumed
  // it, while `projectsFor()` read graph nodes typed project|product that the
  // conversation extractor never produces.
  //
  // DECISION — projects live as a BELIEF, not as a guessed graph entity.
  // Typing conversational proper nouns as projects would mean inferring which
  // of "Nummo", "Bangalore" and "Razorpay" is the thing being built, and
  // inference is what puts wrong lines on a trust screen. The user STATES
  // this, so it belongs in the lane that holds stated things — where it is
  // also correctable through the belief path that already exists, rather than
  // an entity that can be dismissed but not renamed.
  //
  // The graph path is unchanged: documents still contribute project entities,
  // and the read model unions the two. Strength matches profession/workplace
  // — same kind of claim, same standing.
  project:            (f) => ({ dimension: DIMENSIONS.IDENTITY,    key: 'project',            value: f.value, strength: 0.85 }),
  goal:               null, // handled by goalTracker, not beliefs
};

// ── 3b. Explicit declarations ────────────────────────────────────────────────
//
// A new belief's confidence is `0.25 + changeRate × strength`. For identity
// (changeRate 0.12, the slowest by design) a strength-0.85 signal lands at
// 0.35. That is right for something INFERRED — identity should move slowly —
// and wrong for something the user just said out loud. "I'm a founder" was
// arriving at 35% confident.
//
// `fromExplicit()` already exists and already means exactly this; until now
// only correctBelief() reached it. This is the second caller.
//
// The bar is deliberately narrow. `schema` means one of the curated
// first-person patterns in memorySchema matched. The `custom_fallback`
// extractor is excluded on purpose: it promotes transient states ("I'm
// exhausted today") into durable stored facts, and granting those 0.9 would
// amplify a known precision problem rather than fix a confidence one.
const EXPLICIT_MIN_CONFIDENCE = 0.8;

function isExplicitDeclaration(fact) {
  return fact?.extractor === 'schema'
    && Number(fact?.confidence ?? 0) >= EXPLICIT_MIN_CONFIDENCE
    && !fact?._isDuplicate;
}

/**
 * Main entry: one turn → array of belief signals + side-channel hints
 * (deadlines/tech) consumed by workingMemory & goalTracker.
 */
export function observeTurn({ userMessage = '', taskType = 'conversation', extractedFacts = [], workspaceId = null, conversationId = null }) {
  const signals = [];
  const text = userMessage || '';
  const hints = { deadlines: [], tech: [], rejectedFlashy: false };

  // 1. identity/behavior from task type
  for (const t of TASK_TRAIT_MAP[taskType] || []) {
    signals.push({ dimension: DIMENSIONS.IDENTITY, key: t.key, value: true, strength: t.strength, note: `task:${taskType}`, conversationId });
  }
  if (workspaceId) {
    signals.push({ dimension: DIMENSIONS.BEHAVIOR, key: 'works_in_workspaces', value: true, strength: 0.5, note: 'attached workspace', conversationId });
  }

  // 2. founder / org hints
  if (FOUNDER_HINTS.test(text)) {
    signals.push({ dimension: DIMENSIONS.IDENTITY, key: 'founder', value: true, strength: 0.6, note: 'founder-context language', conversationId });
  }

  // 3. communication style — length & structure preferences
  const len = text.length;
  if (len > 0 && len < 120) {
    signals.push({ dimension: DIMENSIONS.COMMUNICATION, key: 'message_style', value: 'terse', strength: 0.3, note: `short message (${len} chars)`, conversationId });
  } else if (len > 900) {
    signals.push({ dimension: DIMENSIONS.COMMUNICATION, key: 'message_style', value: 'detailed', strength: 0.3, note: `long message (${len} chars)`, conversationId });
  }
  if (WANTS_BRIEF.test(text)) {
    signals.push({ dimension: DIMENSIONS.COMMUNICATION, key: 'response_length', value: 'brief', strength: 0.75, note: 'asked for brevity', conversationId });
  } else if (WANTS_DETAIL.test(text)) {
    signals.push({ dimension: DIMENSIONS.COMMUNICATION, key: 'response_length', value: 'detailed', strength: 0.7, note: 'asked for depth', conversationId });
  }

  // 4. implicit design preference (the "rejects flashy UI" case, Layer 3)
  if (REJECT_FLASHY.test(text)) {
    hints.rejectedFlashy = true;
    signals.push({ dimension: DIMENSIONS.PREFERENCES, key: 'design_style', value: 'minimal', strength: 0.7, note: 'rejected flashy/busy option', conversationId });
  }

  // 5. decision style
  if (RISK_AVERSE.test(text)) {
    signals.push({ dimension: DIMENSIONS.DECISION, key: 'risk_tolerance', value: 'cautious', strength: 0.55, note: 'asked for non-breaking/safe path', conversationId });
  } else if (RISK_TOLERANT.test(text)) {
    signals.push({ dimension: DIMENSIONS.DECISION, key: 'risk_tolerance', value: 'bold', strength: 0.55, note: 'asked for rewrite/fast path', conversationId });
  }

  // 6. knowledge model from tech mentions (Layer 4 — proficiency grows with use)
  const tech = techMentions(text);
  for (const [term, count] of tech) {
    hints.tech.push(term);
    signals.push({
      dimension: DIMENSIONS.KNOWLEDGE, key: `tech:${term}`, value: 'working_knowledge',
      strength: Math.min(0.6, 0.25 + count * 0.1), note: `mentioned ${term}`, conversationId,
    });
  }

  // 7. deadline hints → workingMemory (not a belief)
  const dl = text.match(DEADLINE_RE);
  if (dl) hints.deadlines.push({ label: dl[0].slice(0, 80), ts: null, source: 'message' });

  // 8. FACT BRIDGE — reuse the proven extractor output as high-quality evidence
  const explicitAllowed = uusEnabled();
  for (const fact of extractedFacts) {
    const map = FACT_TO_BELIEF[fact.key];
    if (!map) continue;
    const sig = map(fact);
    if (!sig) continue;
    const explicit = explicitAllowed && isExplicitDeclaration(fact);
    signals.push({
      ...sig,
      note: `extracted fact: ${fact.key}`,
      conversationId,
      source: explicit ? 'explicit' : 'fact_bridge',
      ...(explicit ? { explicit: true } : {}),
    });
  }

  return { signals, hints };
}

/**
 * Post-response observer: user's NEXT message reacting to the previous answer.
 * Detects correction/pushback → contradiction evidence on communication fit.
 * Cheap heuristic; called with previous assistant turn context by the facade.
 */
const PUSHBACK_RE = /\b(no[,.]|that'?s (wrong|not right|not what)|you misunderstood|not what i (meant|asked)|incorrect|too long|too verbose)\b/i;
export function observeReaction({ userMessage = '', conversationId = null }) {
  const signals = [];
  if (PUSHBACK_RE.test(userMessage)) {
    signals.push({
      dimension: DIMENSIONS.COMMUNICATION, key: 'assistant_fit', value: 'aligned',
      support: false, strength: 0.5, note: 'user pushed back on previous answer', conversationId,
    });
  }
  return signals;
}
