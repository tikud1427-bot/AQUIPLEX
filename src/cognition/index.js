/**
 * AQUA Cognitive Intelligence Engine — the facade (CIE Phase 1)
 *
 * THE executive intelligence layer. The CIE does not answer questions —
 * it improves how AQUA answers questions. Knowledge stays where it lives
 * (PIC, Evidence Engine, Memory, Search, Reasoning Graph); this layer owns
 * COGNITION: plan → monitor → escalate → measure → reflect → improve.
 *
 *   chat.prepareTurn ──► cognitivePrepare()          meta-reasoning: question
 *                                                    model + adaptive style +
 *                                                    executive reasoning plan
 *   chat.prepareTurn ──► cognitiveKnowledgeRetrieve() "should I retrieve
 *                                                    more?" — wraps ONE PIC
 *                                                    call, adds a bounded
 *                                                    broaden pass on empty
 *   chat (post-gen)  ──► observeDraft()              reasoning monitor; can
 *                                                    ESCALATE verification
 *   chat (payload)   ──► concludeTurn()              7-dim structured
 *                                                    confidence + reflection
 *                                                    + strategy learning
 *   routes           ──► getCIEMetrics()             full observability
 *
 * Contracts (identical discipline to pic/core.js):
 *   • FAIL-OPEN everywhere. Every public method catches; cognition
 *     bookkeeping can never sink a turn. Kill switch: AQUA_CIE=off makes
 *     every call a no-op and the pipeline byte-identical to pre-CIE.
 *   • COMPOSITION ONLY. classifier / executionPlanner / reasoningStrategy /
 *     IIE / orchestrator / confidenceEngine / verification / PIC / ledger
 *     all keep their exact roles; the CIE reads their outputs and adds the
 *     executive layer none of them owned. The orchestrator's verification
 *     decision is a FLOOR — the monitor can only add review, never remove.
 *   • NO agents, no browser automation, no workflow execution, no
 *     scheduling. Deterministic modules only.
 *   • OBSERVABLE. Planning decisions, strategy selection, reasoning depth,
 *     monitor findings, escalations, reflection outcomes, confidence
 *     evolution, retrieval efficiency, verification rate — all measurable
 *     via getCIEMetrics() and /intelligence/cognition.
 */

import { assessQuestion } from './questionModel.js';
import { selectCognitiveStyle } from './strategySelector.js';
import { buildReasoningPlan, planCacheStats, _clearPlanCacheForTests } from './reasoningPlanner.js';
import { composeCognitiveConfidence } from './cognitiveConfidence.js';
import { monitorDraft } from './reasoningMonitor.js';
import { reflect } from './reflectionEngine.js';
import { recordPlan, getCognitionSnapshot, _resetCognitionStoreForTests } from './cognitiveStore.js';
import { retrieveKnowledge as picRetrieveKnowledge } from '../pic/core.js';

export function cieEnabled() {
  return String(process.env.AQUA_CIE ?? 'on').toLowerCase() !== 'off';
}

// ── Observability ────────────────────────────────────────────────────────────

const metrics = {
  plans: { built: 0, reused: 0, clarificationsRecommended: 0, byStyle: {}, byDepth: {}, bySource: {} },
  retrieval: { calls: 0, broadened: 0, broadenGained: 0, emptyAfterBroaden: 0 },
  monitor: { drafts: 0, findingsTotal: 0, byFinding: {}, escalations: 0 },
  reflection: { ran: 0, skipped: 0, outcomes: { clean: 0, adjusted: 0, misfired: 0 } },
  confidence: { overallEwma: 0, byBand: { high: 0, medium: 0, low: 0 } },
  verification: { planEncouraged: 0, escalated: 0 },
  latency: { prepareMs: 0, monitorMs: 0, concludeMs: 0 },   // EWMA, α=0.2
  failures: 0,
};
const ewma = (prev, x) => (prev === 0 ? x : Math.round((prev * 0.8 + x * 0.2) * 100) / 100);
const bump = (obj, key) => { obj[key] = (obj[key] ?? 0) + 1; };

export function getCIEMetrics() {
  return { enabled: cieEnabled(), ...metrics, planCache: planCacheStats() };
}

// ── Meta-reasoning: build the executive reasoning plan ───────────────────────

/**
 * Runs once per turn inside prepareTurn, after classify/orchestrate/plan.
 * Returns { plan, directive } — directive is appended AFTER the Phase-4
 * reasoningStrategy directive by chat.js; empty when CIE is off or the
 * style is 'fast', keeping casual traffic byte-identical.
 */
export function cognitivePrepare({ userMessage, taskType, confidence, complexity, hasWorkspace = false, hasOwner = false } = {}) {
  const empty = { plan: null, directive: '' };
  if (!cieEnabled()) return empty;
  const started = Date.now();
  try {
    const question  = assessQuestion(userMessage, { taskType, confidence, hasWorkspace, hasOwner });
    const selection = selectCognitiveStyle({ taskType, complexity, question });
    const plan      = buildReasoningPlan({ question, selection, taskType, complexity, confidence });

    recordPlan({
      taskType, styleId: plan.style.id, reused: plan.reused,
      clarification: plan.expectations.clarification.recommended,
    });

    metrics.plans.built += 1;
    if (plan.reused) metrics.plans.reused += 1;
    if (plan.expectations.clarification.recommended) metrics.plans.clarificationsRecommended += 1;
    if (plan.expectations.verification === 'encourage') metrics.verification.planEncouraged += 1;
    bump(metrics.plans.byStyle, plan.style.id);
    bump(metrics.plans.byDepth, plan.depth);
    bump(metrics.plans.bySource, plan.style.source);
    metrics.latency.prepareMs = ewma(metrics.latency.prepareMs, Date.now() - started);

    console.log(`[CIE] PLAN style=${plan.style.id}(${plan.style.source}) depth=${plan.depth} evidence=${plan.expectations.evidence} ambiguity=${plan.question.ambiguity.score} clarify=${plan.expectations.clarification.recommended} reused=${plan.reused}`);
    return { plan, directive: plan.directive };
  } catch (err) {
    metrics.failures += 1;
    console.warn(`[CIE] cognitivePrepare failed (non-fatal): ${err.message}`);
    return empty;
  }
}

// ── "Should I retrieve more?" — the knowledge-retrieval seam ─────────────────

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'about', 'what', 'when', 'where', 'which', 'who', 'how', 'why', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could', 'would', 'should', 'tell', 'me', 'please', 'you', 'your', 'this', 'that', 'these', 'those', 'of', 'in', 'on', 'to', 'from', 'have', 'has', 'had', 'it', 'its', 'my', 'our']);

/** Keyword-only reformulation for the broaden pass. Null when too little signal. */
export function broadenQuery(query) {
  const tokens = String(query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
  const uniq = [...new Set(tokens)];
  if (uniq.length < 2) return null;
  const broadened = uniq.sort((a, b) => b.length - a.length).slice(0, 6).join(' ');
  return broadened === String(query ?? '').trim().toLowerCase() ? null : broadened;
}

/**
 * Wraps PIC's retrieveKnowledge — PIC stays the sole retrieval OWNER; the
 * CIE only decides whether one more (bounded, local) attempt is worth it.
 *
 * SAFE FLOOR: the original PIC call always runs with the caller's exact
 * arguments, so with the broaden pass idle (or CIE off) the result is
 * byte-identical to calling PIC directly. The broaden pass fires only when
 * the plan REQUIRES evidence and the first pass came back empty: the query
 * is reduced to its strongest keywords and PIC is asked once more with a
 * slightly wider limit. Results merge, de-duplicated. Fail-open throughout.
 *
 * @param {string} ownerId
 * @param {string} query
 * @param {object} [opts]  { limit, plan, _retrieve }  (_retrieve: test DI, same pattern as PIC's deps)
 */
export function cognitiveKnowledgeRetrieve(ownerId, query, opts = {}) {
  const { limit = 8, plan = null, _retrieve = picRetrieveKnowledge } = opts;
  const first = _retrieve(ownerId, query, { limit });
  if (!cieEnabled() || !plan) return first;

  try {
    metrics.retrieval.calls += 1;
    const wantBroaden = plan.expectations?.retrieval?.broadenOnEmpty && first.items.length === 0;
    if (!wantBroaden) return first;

    const bq = broadenQuery(query);
    if (!bq) return first;

    metrics.retrieval.broadened += 1;
    const second = _retrieve(ownerId, bq, { limit: limit + 4 });

    if (!second.items.length) {
      metrics.retrieval.emptyAfterBroaden += 1;
      return { ...first, stats: { ...first.stats, broadened: true, broadenQuery: bq, broadenGained: 0 } };
    }

    // Merge + dedupe (first pass was empty here, but keep the merge general).
    const seen = new Set(first.items.map(i => `${i.kind}:${i.id ?? i.entity ?? i.statement}`));
    const merged = [...first.items];
    let gained = 0;
    for (const item of second.items) {
      const key = `${item.kind}:${item.id ?? item.entity ?? item.statement}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      gained += 1;
    }
    metrics.retrieval.broadenGained += gained;
    console.log(`[CIE] RETRIEVE broadened "${bq}" gained=${gained} owner=${ownerId}`);

    return {
      items: merged,
      block: first.block || second.block,
      stats: {
        ...second.stats,
        facts: merged.filter(i => i.kind === 'fact').length,
        entities: merged.filter(i => i.kind === 'entity').length,
        broadened: true, broadenQuery: bq, broadenGained: gained,
      },
    };
  } catch (err) {
    metrics.failures += 1;
    console.warn(`[CIE] cognitiveKnowledgeRetrieve failed (non-fatal): ${err.message}`);
    return first;
  }
}

// ── Reasoning monitor seam ───────────────────────────────────────────────────

const MONITOR_EMPTY = { enabled: false, findings: [], escalate: { escalate: false, reason: null }, stats: null };

/**
 * Inspect the completed draft (stream-end for /chat/stream). The returned
 * escalate decision feeds runVerification's cognitiveEscalation parameter.
 */
export function observeDraft({ draft, prep } = {}) {
  const plan = prep?.cognition?.plan;
  if (!cieEnabled() || !plan) return MONITOR_EMPTY;
  const started = Date.now();
  try {
    const out = monitorDraft({
      draft,
      plan,
      evidenceContext: prep.evidenceContext ?? '',
      knowledgeItems: prep.knowledgeItems ?? [],
      budget: prep.orchestration?.budget ?? null,
      verificationAlreadyEnabled: !!prep.orchestration?.verification?.enabled,
    });
    metrics.monitor.drafts += 1;
    metrics.monitor.findingsTotal += out.findings.length;
    for (const f of out.findings) bump(metrics.monitor.byFinding, f.id);
    if (out.escalate.escalate) metrics.verification.escalated += 1, metrics.monitor.escalations += 1;
    metrics.latency.monitorMs = ewma(metrics.latency.monitorMs, Date.now() - started);
    if (out.findings.length || out.escalate.escalate) {
      console.log(`[CIE] MONITOR findings=[${out.findings.map(f => `${f.id}:${f.severity}`).join(',')}] escalate=${out.escalate.escalate}${out.escalate.reason ? ` (${out.escalate.reason})` : ''}`);
    }
    return { enabled: true, ...out };
  } catch (err) {
    metrics.failures += 1;
    console.warn(`[CIE] observeDraft failed (non-fatal): ${err.message}`);
    return MONITOR_EMPTY;
  }
}

// ── Conclude: structured confidence + reflection + learning ──────────────────

/**
 * Called from buildResponsePayload once the verification verdict and the
 * Phase-12 responseConfidence exist. Returns the payload's `cognition`
 * block, or null (CIE off / no plan / artifact-edit branches) — absent key
 * keeps the payload byte-identical to pre-CIE for those turns.
 */
export function concludeTurn({ prep, verification, responseConfidence, draftObservation } = {}) {
  const plan = prep?.cognition?.plan;
  if (!cieEnabled() || !plan) return null;
  const started = Date.now();
  try {
    const confidence = composeCognitiveConfidence({
      plan,
      knowledgeStats: prep.knowledgeStats ?? {},
      knowledgeItems: prep.knowledgeItems ?? [],
      retrieval: {
        factsInjected: prep.relevantFacts?.length ?? 0,
        projectFilesUsed: prep.projectFiles?.length ?? 0,
        searchUsed: !!prep.search?.used,
        hasWorkspace: (prep.projectFiles?.length ?? 0) > 0 || !!prep.projectContext,
      },
      responseConfidence,
      verification,
      monitor: draftObservation,
    });

    const reflection = reflect({
      plan,
      monitor: draftObservation,
      verification,
      responseConfidence,
      cognitiveConfidence: confidence,
      knowledgeStats: prep.knowledgeStats ?? {},
      taskType: prep.taskType,
    });

    metrics.confidence.overallEwma = ewma(metrics.confidence.overallEwma, confidence.overall.score);
    bump(metrics.confidence.byBand, confidence.overall.band);
    if (reflection.ran) {
      metrics.reflection.ran += 1;
      bump(metrics.reflection.outcomes, reflection.outcome);
      console.log(`[CIE] REFLECT outcome=${reflection.outcome} effectiveness=${reflection.effectiveness}${reflection.betterStrategyHint ? ` hint=${reflection.betterStrategyHint}` : ''}${reflection.lessons.length ? ` lesson="${reflection.lessons[0]}"` : ''}`);
    } else {
      metrics.reflection.skipped += 1;
    }
    metrics.latency.concludeMs = ewma(metrics.latency.concludeMs, Date.now() - started);

    return {
      plan: {
        style: plan.style.id,
        styleSource: plan.style.source,
        depth: plan.depth,
        reused: plan.reused,
        directiveApplied: !!plan.directive,
        clarificationRecommended: plan.expectations.clarification.recommended,
        evidenceExpectation: plan.expectations.evidence,
      },
      monitor: draftObservation?.enabled ? {
        findings: draftObservation.findings.map(f => ({ id: f.id, severity: f.severity, detail: f.detail })),
        escalated: draftObservation.escalate.escalate,
        escalationReason: draftObservation.escalate.reason,
        stats: draftObservation.stats,
      } : { findings: [], escalated: false, escalationReason: null, stats: null },
      confidence,
      reflection: reflection.ran
        ? { ran: true, outcome: reflection.outcome, effectiveness: reflection.effectiveness, lessons: reflection.lessons, betterStrategyHint: reflection.betterStrategyHint }
        : { ran: false, reason: reflection.reason },
    };
  } catch (err) {
    metrics.failures += 1;
    console.warn(`[CIE] concludeTurn failed (non-fatal): ${err.message}`);
    return null;
  }
}

// ── Pass-through inspection surface (routes + tests) ─────────────────────────

export { getCognitionSnapshot };

export function _resetCIEForTests() {
  _clearPlanCacheForTests();
  _resetCognitionStoreForTests();
  metrics.plans = { built: 0, reused: 0, clarificationsRecommended: 0, byStyle: {}, byDepth: {}, bySource: {} };
  metrics.retrieval = { calls: 0, broadened: 0, broadenGained: 0, emptyAfterBroaden: 0 };
  metrics.monitor = { drafts: 0, findingsTotal: 0, byFinding: {}, escalations: 0 };
  metrics.reflection = { ran: 0, skipped: 0, outcomes: { clean: 0, adjusted: 0, misfired: 0 } };
  metrics.confidence = { overallEwma: 0, byBand: { high: 0, medium: 0, low: 0 } };
  metrics.verification = { planEncouraged: 0, escalated: 0 };
  metrics.latency = { prepareMs: 0, monitorMs: 0, concludeMs: 0 };
  metrics.failures = 0;
}
