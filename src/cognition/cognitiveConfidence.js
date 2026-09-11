/**
 * AQUA Cognitive Intelligence Engine — Cognitive Confidence (CIE Phase 1)
 *
 * CONFIDENCE MODEL (spec): "Maintain structured confidence. Track retrieval,
 * evidence, reasoning, entity, relationship, timeline, overall. Never invent
 * certainty."
 *
 * COMPOSES — does not replace — the two confidences that already exist:
 *   classifier.js confidence          → pre-generation, task-kind certainty
 *   intelligence/confidenceEngine.js  → per-response score (classification /
 *                                       grounding / generation / verification)
 * The per-response score is folded in verbatim as the core of the REASONING
 * dimension here; `responseConfidence` keeps its exact meaning, position,
 * and payload field for existing clients.
 *
 * "Never invent certainty" is enforced BOTH ways: a dimension with no signal
 * for this turn (e.g. timeline on a non-temporal question) is EXCLUDED from
 * the overall aggregate — it is neither optimistically 1.0 nor pessimistically
 * 0. Weights renormalize over the dimensions that actually carry signal.
 *
 * Pure, deterministic, no LLM calls, no I/O.
 */

import { CONFIDENCE_BANDS } from '../intelligence/confidenceEngine.js';

const WEIGHTS = {
  retrieval:    0.20,
  evidence:     0.22,
  reasoning:    0.28,
  entity:       0.10,
  relationship: 0.10,
  timeline:     0.10,
};

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const mean = (xs, fallback) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : fallback);

/**
 * @param {object} input
 * @param {object}  input.plan                the CIE reasoning plan
 * @param {object}  [input.knowledgeStats]    PIC retrieval stats (+ broadened flags)
 * @param {Array}   [input.knowledgeItems]    PIC retrieval items
 * @param {object}  [input.retrieval]         { factsInjected, projectFilesUsed, searchUsed, hasWorkspace }
 * @param {object}  [input.responseConfidence] assessConfidence() output (Phase 12)
 * @param {object}  [input.verification]      runVerification() result
 * @param {object}  [input.monitor]           observeDraft() result
 * @returns {{ overall: {score:number, band:string}, dims: Array, basis: string[] }}
 */
export function composeCognitiveConfidence({
  plan,
  knowledgeStats = {},
  knowledgeItems = [],
  retrieval = {},
  responseConfidence = null,
  verification = null,
  monitor = null,
} = {}) {
  const needs = plan?.question?.needs ?? {};
  const evidencePosture = plan?.expectations?.evidence ?? 'none';
  const facts    = knowledgeItems.filter(i => i.kind === 'fact');
  const entities = knowledgeItems.filter(i => i.kind === 'entity');
  const events   = knowledgeStats.timelineEvents ?? knowledgeItems.filter(i => i.kind === 'event').length;
  const connected = knowledgeStats.connectedFacts ?? 0;

  const dims = [];
  const push = (id, signal, score, detail) =>
    dims.push({ id, signal, score: +clamp01(score).toFixed(2), weight: WEIGHTS[id], detail });

  // ── retrieval — did the lanes this plan expected actually land? ────────────
  {
    const wantKnowledge = !!plan?.expectations?.retrieval?.knowledge;
    const lanes = [];
    if (wantKnowledge)                          lanes.push(facts.length > 0 || entities.length > 0);
    if (needs.memoryLikely)                     lanes.push((retrieval.factsInjected ?? 0) > 0);
    if (retrieval.hasWorkspace && needs.evidence) lanes.push((retrieval.projectFilesUsed ?? 0) > 0);
    if (needs.freshness)                        lanes.push(!!retrieval.searchUsed);
    const signal = lanes.length > 0;
    let score = signal ? lanes.filter(Boolean).length / lanes.length : 0;
    if (knowledgeStats.broadened && facts.length === 0 && entities.length === 0) score = Math.min(score, 0.25); // tried harder, still empty
    push('retrieval', signal, score, signal ? `${lanes.filter(Boolean).length}/${lanes.length} expected lanes landed` : 'no retrieval expected');
  }

  // ── evidence — how solid is what we grounded on? ───────────────────────────
  {
    const signal = evidencePosture !== 'none';
    let score;
    if (!signal) score = 0;
    else if (facts.length === 0) score = evidencePosture === 'require' ? 0.2 : 0.45;
    else {
      score = mean(facts.map(f => typeof f.confidence === 'number' ? f.confidence : 0.7), 0.7);
      for (const f of facts) {
        if (f.disputed) score -= 0.15;
        if (f.stale)    score -= 0.08;
        if (f.trusted)  score += 0.05;
      }
    }
    push('evidence', signal, score, signal ? `${facts.length} fact(s), posture=${evidencePosture}` : 'no evidence posture');
  }

  // ── reasoning — the existing per-response engine, adjusted by the monitor ──
  {
    let score = responseConfidence?.score ?? 0.6;
    const criticals = monitor?.findings?.filter(f => f.severity === 'critical').length ?? 0;
    const warns     = monitor?.findings?.filter(f => f.severity === 'warn').length ?? 0;
    score -= Math.min(0.4, criticals * 0.25);
    score -= warns * 0.08;
    push('reasoning', true, score, `responseConfidence=${responseConfidence?.score ?? 'n/a'} monitor(-${criticals}c/${warns}w)`);
  }

  // ── entity — resolution quality of the entities in play ────────────────────
  {
    const signal = entities.length > 0 || needs.crossFile;
    const score = entities.length
      ? mean(entities.map(e => typeof e.resolutionConfidence === 'number' ? e.resolutionConfidence : 0.7), 0.7)
      : 0.35; // expected entities, found none
    push('entity', signal, signal ? score : 0, entities.length ? `${entities.length} entit(ies)` : 'expected, none resolved');
  }

  // ── relationship — graph-connected knowledge backing the answer ────────────
  {
    const signal = connected > 0 || needs.crossFile;
    const score = connected > 0 ? Math.min(1, 0.4 + 0.15 * connected) : 0.35;
    push('relationship', signal, signal ? score : 0, `${connected} graph-connected fact(s)`);
  }

  // ── timeline — temporal grounding when the question is temporal ────────────
  {
    const signal = !!needs.temporal;
    const score = events > 0 ? Math.min(1, 0.35 + 0.15 * events) : 0.3;
    push('timeline', signal, signal ? score : 0, signal ? `${events} timeline event(s)` : 'not a temporal question');
  }

  // ── overall — renormalized over the dimensions that carry signal ───────────
  const active = dims.filter(d => d.signal);
  const wSum = active.reduce((s, d) => s + d.weight, 0) || 1;
  let overall = active.reduce((s, d) => s + d.score * d.weight, 0) / wSum;

  // Verification verdicts already live inside responseConfidence (reasoning
  // dim) — but a revised-then-unproven answer caps overall certainty.
  if (verification?.ran && verification.revised && !verification.passed) overall = Math.min(overall, 0.6);

  overall = clamp01(overall);
  const band = overall >= CONFIDENCE_BANDS.high ? 'high'
    : overall >= CONFIDENCE_BANDS.medium ? 'medium'
    : 'low';

  return {
    overall: { score: +overall.toFixed(2), band },
    dims,
    basis: active.map(d => d.id),
  };
}
