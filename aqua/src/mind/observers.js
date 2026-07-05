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
const TECH_TERMS = /\b(typescript|javascript|python|rust|golang|go|java|kotlin|swift|ruby|c\+\+|c#|sql|react|vue|svelte|angular|next\.?js|node(\.js)?|express|django|flask|fastapi|postgres(ql)?|mysql|mongodb|redis|docker|kubernetes|k8s|graphql|grpc|terraform|aws|gcp|azure|vite|webpack|tailwind)\b/gi;
const FOUNDER_HINTS = /\b((?:my|our) (?:startup|company|cofounder|co-founder|investors?|product|platform|users|customers)|fundrais|pitch deck|investor (?:demo|meeting|pitch|update)|mvp|go.to.market|runway)\b/i;
const DEADLINE_RE   = /\b(by|before|due|deadline|ship(ping)? (by|on)|launch(ing)? (by|on))\s+(tomorrow|tonight|today|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?|\d)/i;
const REJECT_FLASHY = /\b(too (flashy|busy|cluttered|noisy|much)|less is more|keep it (simple|clean|minimal)|simpler|cleaner|minimal(ist)?)\b/i;
const WANTS_DETAIL  = /\b(explain in detail|deep dive|step by step|walk me through|thorough(ly)?|comprehensive)\b/i;
const WANTS_BRIEF   = /\b(tl;?dr|be brief|short answer|quick(ly)? (answer|version)|just tell me|no fluff|concise)\b/i;
const RISK_AVERSE   = /\b(don'?t break|be careful|safe(st)? (way|option)|backward.?compat|without breaking|non.?breaking)\b/i;
const RISK_TOLERANT = /\b(rewrite (it|everything|from scratch)|rip (it )?out|nuke it|start over|move fast)\b/i;

function techMentions(text) {
  const found = new Map();
  let m;
  TECH_TERMS.lastIndex = 0;
  while ((m = TECH_TERMS.exec(text)) !== null) {
    const t = m[0].toLowerCase().replace(/\.?js$/, m[0].toLowerCase() === 'next.js' || m[0].toLowerCase() === 'nextjs' ? 'js' : '');
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
  profession:         (f) => ({ dimension: DIMENSIONS.IDENTITY,    key: 'profession',         value: f.value, strength: 0.85 }),
  workplace:          (f) => ({ dimension: DIMENSIONS.IDENTITY,    key: 'organization',       value: f.value, strength: 0.85 }),
  goal:               null, // handled by goalTracker, not beliefs
};

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
  for (const fact of extractedFacts) {
    const map = FACT_TO_BELIEF[fact.key];
    if (!map) continue;
    const sig = map(fact);
    if (sig) signals.push({ ...sig, note: `extracted fact: ${fact.key}`, conversationId, source: 'fact_bridge' });
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
