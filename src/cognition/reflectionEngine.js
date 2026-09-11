/**
 * AQUA Cognitive Intelligence Engine — Reflection Engine (CIE Phase 1)
 *
 * REFLECTION (spec): "After reasoning, perform lightweight reflection. Was
 * the answer supported? Did evidence match the conclusion? Was retrieval
 * sufficient? Was confidence appropriate? Did another strategy perform
 * better? Only spend additional compute when beneficial."
 *
 * The beneficial gate is real: clean fast-style turns (no findings, no
 * verification, high confidence) skip reflection entirely — nothing to
 * learn, nothing written. Everything else reflects deterministically (the
 * "compute" here is trivial, but the gate also keeps the cognitive store
 * from filling with signal-free entries).
 *
 * CONTINUOUS IMPROVEMENT: every reflection lands in cognitiveStore.js as a
 * (taskType × style) aggregate — successful patterns raise a style's
 * effectiveness, misfires lower it, and betterStrategyHints accumulate so
 * strategySelector.js can reuse what actually worked. This is the loop
 * that lets "future planning reuse successful strategies."
 *
 * BOUNDARY vs the two learning systems that already exist:
 *   learningLedger.js       (task × PROVIDER) → provider routing priors.
 *   pic/reasoningFeedback.js (per-FACT)       → retrieval re-ranking.
 *   cognitiveStore.js        (task × STRATEGY) → cognition planning priors.
 * Three different keys, three different consumers. No overlap.
 *
 * Deterministic; persistence delegated to cognitiveStore (fail-open there).
 */

import { recordReflection } from './cognitiveStore.js';

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/** "Only spend additional compute when beneficial." */
export function reflectionBeneficial({ plan, monitor, verification, responseConfidence }) {
  const clean = (monitor?.findings?.length ?? 0) === 0;
  if (plan?.style?.id === 'fast' && !verification?.ran && clean && responseConfidence?.band === 'high') {
    return false;
  }
  return true;
}

/**
 * How well did this turn actually go? One scalar the store can EWMA.
 * Anchored on verification (the only direct evidence about the answer),
 * shaded by the monitor's structural findings.
 */
function computeEffectiveness({ verification, responseConfidence, monitor }) {
  let eff;
  const v = verification ?? {};
  if (!v.ran)             eff = clamp01(responseConfidence?.score ?? 0.7);
  else if (v.passed && !v.revised) eff = 0.95;
  else if (v.passed && v.revised)  eff = 0.75;
  else if (v.revised)              eff = 0.55;   // fixed at iteration cap, unproven
  else                             eff = 0.35;   // failed, unrevised

  const criticals = monitor?.findings?.filter(f => f.severity === 'critical').length ?? 0;
  const warns     = monitor?.findings?.filter(f => f.severity === 'warn').length ?? 0;
  eff -= criticals * 0.1 + warns * 0.04;
  return +clamp01(eff).toFixed(2);
}

/**
 * @param {object} input
 * @param {object}  input.plan                 CIE reasoning plan
 * @param {object}  [input.monitor]            observeDraft() result
 * @param {object}  [input.verification]       runVerification() result
 * @param {object}  [input.responseConfidence] Phase-12 assessConfidence() output
 * @param {object}  [input.cognitiveConfidence] composeCognitiveConfidence() output
 * @param {object}  [input.knowledgeStats]     PIC retrieval stats (+broadened)
 * @param {string}  input.taskType
 * @returns {{ ran:boolean, reason?:string, outcome?:string, effectiveness?:number,
 *             lessons?:string[], betterStrategyHint?:string|null, checks?:object }}
 */
export function reflect({ plan, monitor, verification, responseConfidence, cognitiveConfidence, knowledgeStats = {}, taskType }) {
  if (!plan) return { ran: false, reason: 'no cognitive plan for this turn' };
  if (!reflectionBeneficial({ plan, monitor, verification, responseConfidence })) {
    return { ran: false, reason: 'clean fast turn — reflection not beneficial' };
  }

  const v = verification ?? {};
  const findings = monitor?.findings ?? [];
  const has = (id) => findings.some(f => f.id === id);
  const lessons = [];

  // ── The spec's five reflection questions, answered from this turn's data ───
  const checks = {
    // Was the answer supported?
    supported: v.ran ? (v.passed === true) : !has('dead_end') && !has('unsupported_specifics'),
    // Did evidence match the conclusion?
    evidenceMatched: !has('possible_contradiction') && !has('unsupported_specifics'),
    // Was retrieval sufficient?
    retrievalSufficient: !(plan.expectations.retrieval.knowledge
      && (knowledgeStats.facts ?? 0) === 0 && (knowledgeStats.entities ?? 0) === 0),
    // Was confidence appropriate? (filled below)
    confidenceCalibrated: true,
    // Did another strategy perform better? (hint filled below)
    strategyFit: true,
  };

  const effectiveness = computeEffectiveness({ verification, responseConfidence, monitor });

  // Calibration: cognitive certainty vs how the turn actually went.
  const cog = cognitiveConfidence?.overall?.score;
  if (typeof cog === 'number' && Math.abs(cog - effectiveness) > 0.3) {
    checks.confidenceCalibrated = false;
    lessons.push(cog > effectiveness
      ? `overconfident: cognitive ${cog.toFixed(2)} vs outcome ${effectiveness.toFixed(2)}`
      : `underconfident: cognitive ${cog.toFixed(2)} vs outcome ${effectiveness.toFixed(2)}`);
  }

  if (!checks.retrievalSufficient) {
    lessons.push(knowledgeStats.broadened
      ? 'retrieval insufficient even after broadening — knowledge gap for this question shape'
      : 'retrieval expected knowledge and found none');
  }
  if (!checks.evidenceMatched) lessons.push('draft drifted from the injected evidence');
  if (v.revised) lessons.push('verification revised the draft');

  // ── Did another strategy perform better? ───────────────────────────────────
  let betterStrategyHint = null;
  if ((has('dead_end') || has('unsupported_specifics') || has('possible_contradiction'))
      && plan.style.id !== 'evidence_first' && plan.expectations.evidence !== 'none') {
    betterStrategyHint = 'evidence_first';
  } else if (has('token_waste') && plan.depth === 'deep' && v.passed !== false && findings.every(f => f.severity !== 'critical')) {
    betterStrategyHint = 'analytical';
  }
  if (betterStrategyHint) {
    checks.strategyFit = false;
    lessons.push(`style '${plan.style.id}' misfit — '${betterStrategyHint}' likely better here`);
  }

  const criticals = findings.filter(f => f.severity === 'critical').length;
  const outcome = (criticals > 0 || v.passed === false || effectiveness < 0.5) ? 'misfired'
    : (v.revised || findings.some(f => f.severity === 'warn') || !checks.confidenceCalibrated) ? 'adjusted'
    : 'clean';

  // ── Persist the pattern (fail-open inside the store) ───────────────────────
  recordReflection({
    taskType,
    styleId: plan.style.id,
    outcome,
    effectiveness,
    confidence: cog ?? null,
    findings: findings.length,
    verification: { ran: !!v.ran, passed: v.passed ?? null, revised: !!v.revised },
    betterStrategyHint,
    lesson: lessons[0] ?? null,
  });

  return { ran: true, outcome, effectiveness, lessons, betterStrategyHint, checks };
}
