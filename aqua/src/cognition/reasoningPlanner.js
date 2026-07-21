/**
 * AQUA Cognitive Intelligence Engine — Reasoning Planner (CIE Phase 1)
 *
 * META-REASONING, second half: turn the question model + selected cognitive
 * style into ONE executive reasoning plan for the turn. The plan answers,
 * before generation:
 *
 *   Should I retrieve (more)?        → expectations.retrieval
 *   Should I demand evidence?        → expectations.evidence
 *   Should I verify?                 → expectations.verification (encourage
 *                                      only — NEVER downgrades the
 *                                      orchestrator's shouldVerify decision)
 *   Should I express uncertainty?    → expectations.uncertainty
 *   Should I ask a clarification?    → expectations.clarification
 *   How should the model reason?     → directive (bounded, appended AFTER the
 *                                      Phase-4 reasoningStrategy directive —
 *                                      that module is untouched)
 *
 * PERFORMANCE (spec): "Reuse previous plans." Plans are cached in a small
 * LRU keyed by a cognitive signature; identical cognitive situations reuse
 * the plan instead of recomputing it, and the reuse rate is observable.
 *
 * DOES NOT duplicate executionPlanner.js (complexity tier), planner.js
 * (IIE stage pipeline), or the orchestrator (capabilities/budget). This
 * plan sits ABOVE them and only carries what none of them decide.
 *
 * Deterministic, no LLM calls, no I/O.
 */

import { resolveDepth } from './strategySelector.js';

/** Hard cap on the extra prompt text the CIE may add per turn. */
export const DIRECTIVE_MAX_CHARS = 340;

const CACHE_MAX = 200;
const CACHE_TTL_MS = 10 * 60 * 1000;
const planCache = new Map();   // signature → { plan, at }

let planSeq = 0;

// ── Directive lines (kept short — every char here is paid on every turn) ─────

const LINE_EVIDENCE_REQUIRE = 'Ground every claim in the provided context; if the context lacks it, say so instead of guessing.';
const LINE_UNCERTAINTY_EXPRESS  = "If something is uncertain, say what's uncertain.";
const LINE_UNCERTAINTY_QUANTIFY = 'State how confident you are in the key conclusions and what would change them.';
const LINE_CLARIFY = 'If the request is ambiguous, ask ONE precise clarifying question before answering.';

function composeDirective({ style, expectations }) {
  const lines = [];
  if (style.directive) lines.push(style.directive);
  if (expectations.evidence === 'require') lines.push(LINE_EVIDENCE_REQUIRE);
  if (expectations.uncertainty === 'quantify')     lines.push(LINE_UNCERTAINTY_QUANTIFY);
  else if (expectations.uncertainty === 'express') lines.push(LINE_UNCERTAINTY_EXPRESS);
  if (expectations.clarification.recommended) lines.push(LINE_CLARIFY);

  // Never exceed the cap; drop trailing lines whole rather than truncating.
  let out = '';
  for (const line of lines) {
    const next = out ? `${out} ${line}` : line;
    if (next.length > DIRECTIVE_MAX_CHARS) break;
    out = next;
  }
  return out;
}

function signatureOf({ taskType, styleId, complexity, question, confidence = 1.0 }) {
  const ambBucket = Math.round((question?.ambiguity?.score ?? 0) * 5); // 0..5
  // Confidence bucket (Phase 2 fix). expectations.uncertainty branches on
  // confidence < 0.6; without confidence in the signature, a low-confidence
  // turn could REUSE a plan built under high confidence and inherit a stale
  // 'allow' uncertainty posture (surfaced by cognitionBench, category 9).
  // Flooring at 0.2 granularity puts bucket edges exactly on 0.6 (and 0.4,
  // the questionModel understanding penalty), so no threshold spans a bucket.
  const conf = Number.isFinite(confidence) ? confidence : 1.0;
  const confBucket = Math.min(4, Math.max(0, Math.floor(conf * 5))); // 0..4, edges at .2/.4/.6/.8
  const n = question?.needs ?? {};
  const needsKey = ['evidence', 'freshness', 'temporal', 'crossFile', 'memoryLikely']
    .map(k => (n[k] ? 1 : 0)).join('');
  const clar = question?.clarification?.recommended ? 1 : 0;
  return `${taskType}|${styleId}|${complexity}|a${ambBucket}|n${needsKey}|c${clar}|f${confBucket}`;
}

/**
 * @param {object} input
 * @param {object} input.question       assessQuestion() output
 * @param {object} input.selection      selectCognitiveStyle() output
 * @param {string} input.taskType
 * @param {'low'|'medium'|'high'} input.complexity
 * @param {number} input.confidence     classifier confidence
 * @returns {object} reasoning plan (see fields below)
 */
export function buildReasoningPlan({ question, selection, taskType, complexity, confidence = 1.0 }) {
  const { style, source, reason } = selection;
  const signature = signatureOf({ taskType, styleId: style.id, complexity, question, confidence });

  // Plan reuse — identical cognitive situation, identical plan.
  const hit = planCache.get(signature);
  if (hit && (Date.now() - hit.at) < CACHE_TTL_MS) {
    planCache.delete(signature);            // LRU refresh
    planCache.set(signature, { plan: hit.plan, at: hit.at });
    return { ...hit.plan, id: `cplan_${++planSeq}`, reused: true };
  }

  const depth = resolveDepth(style, complexity);
  const needs = question?.needs ?? {};

  const evidence = style.evidencePosture === 'require' || (style.evidencePosture === 'prefer' && needs.evidence)
    ? 'require'
    : style.evidencePosture === 'prefer' ? 'prefer' : 'none';

  const expectations = {
    evidence,
    retrieval: {
      // The PIC retrieval seam ALWAYS makes at least its original call (safe
      // floor — see index.js). This flag governs the extra broaden pass.
      knowledge: evidence !== 'none' || needs.retrievalLikely,
      broadenOnEmpty: evidence === 'require',
      limit: depth === 'deep' ? 10 : 8,
    },
    // 'encourage' is a plan-level expectation the reflection engine scores
    // against; real escalation authority belongs to the reasoning MONITOR
    // (post-draft, evidence in hand) — see reasoningMonitor.js.
    verification: style.verifyBias > 0 ? 'encourage' : 'inherit',
    uncertainty: style.uncertainty === 'quantify' ? 'quantify'
      : evidence === 'require' ? 'express'
      : style.uncertainty === 'express' || confidence < 0.6 ? 'express'
      : 'allow',
    clarification: {
      recommended: !!question?.clarification?.recommended,
      reason: question?.clarification?.reason ?? null,
    },
  };

  const plan = {
    id: `cplan_${++planSeq}`,
    signature,
    createdAt: new Date().toISOString(),
    taskType, complexity,
    style: { id: style.id, label: style.label, source, reason, linkedStrategy: style.linkedStrategy ?? null },
    depth,
    question: {
      understanding: question?.understanding ?? 1,
      ambiguity: question?.ambiguity ?? { score: 0, signals: [] },
      needs,
    },
    expectations,
    directive: composeDirective({ style, expectations }),
    reused: false,
  };

  planCache.set(signature, { plan, at: Date.now() });
  if (planCache.size > CACHE_MAX) {
    planCache.delete(planCache.keys().next().value);   // evict LRU head
  }
  return plan;
}

export function planCacheStats() {
  return { size: planCache.size, max: CACHE_MAX, ttlMs: CACHE_TTL_MS };
}

export function _clearPlanCacheForTests() {
  planCache.clear();
  planSeq = 0;
}