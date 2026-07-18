/**
 * AQUA Observability v2
 *
 * Changes:
 *   - createContext() now accepts { conversationId, requestId } object
 *     (was: single string conversationId — silently lost requestId separation)
 *   - logMemoryEvent() — new: records every memory lifecycle event
 *   - logCompletion() extended: memoriesExtracted, memoriesInjected fields
 *   - All log lines carry requestId + conversationId for full correlation
 *
 * Log types emitted:
 *   AQUA_REQUEST  — one per HTTP request at completion
 *   AQUA_MEMORY   — one per memory event (EXTRACTED / RETRIEVED / INJECTED / SKIPPED)
 *   AQUA_PLAN     — Phase 4: one per request, execution plan (complexity/multiStep/reasoningMode)
 */

import { v4 as uuidv4 } from 'uuid';

// ── In-memory metrics (Prometheus-ready — swap for prom-client later) ─────────

const metrics = {
  totalRequests:   0,
  totalSuccesses:  0,
  totalFailures:   0,
  byProvider:      {},  // provider → { requests, successes, failures, totalLatencyMs }
  byTask:          {},  // task     → { requests, successes, failures }
  memoryEvents:    {},  // event    → count
  latencyWindow:   [],  // last 500 request latencies (ms)
  planComplexity:  {},  // Phase 4: complexity tier → count
  intelligenceActivations: 0, // Internal Intelligence Engine: count of active runs
  orchestratorProfiles:    {}, // Phase 6: execution profile id → count
  orchestratorCapabilities: { enabled: {}, skipped: {} }, // Phase 6: capability id → count
  verificationEnabled: 0, // Phase 6: count of requests where verification was warranted
  verificationRuns:    0, // count of requests where the verification agent actually executed
  verificationRevised: 0, // of those, count where the draft was replaced
  verificationFailed:  0, // count where the verifier call itself errored (failed open)
  debateRuns:          0, // Phase 6 debate: count of deep reviews run by the panel instead of the single critic
  searchEvents: { performed: 0, cached: 0, failed: 0, noResults: 0 }, // Web Search: outcome counts
  searchByProvider: {},   // Web Search: provider → successful searches served
};

// ── Recent log ring buffer (last 200 structured AQUA_REQUEST entries) ─────────
const LOG_RING_SIZE = 200;
const recentLogs    = [];

// ── Memory 5.0 Phase F — memory retrieval quality/latency counters ────────────
// Fed by memory/engine.js memoryRetrieve on every turn. Bounded ring of
// latencies; lane counters show which Memory 5.0 lanes actually fire in
// production (facts / graph / episodes / fileChunks / files / identity).
const MEM_LAT_RING = 500;
const memRetrieval = {
  count: 0,
  nonEmpty: 0,          // retrievals that produced a non-empty memory block
  latencies: [],        // ms, ring-capped
  lanes: { identity: 0, facts: 0, cognitive: 0, graph: 0, episodes: 0, fileChunks: 0, files: 0 },
};

/**
 * Record one memoryRetrieve execution.
 * @param {{ latencyMs: number, nonEmpty: boolean, lanes?: string[] }} r
 */
export function recordMemoryRetrieval({ latencyMs = 0, nonEmpty = false, lanes = [] } = {}) {
  memRetrieval.count += 1;
  if (nonEmpty) memRetrieval.nonEmpty += 1;
  memRetrieval.latencies.push(latencyMs);
  if (memRetrieval.latencies.length > MEM_LAT_RING) {
    memRetrieval.latencies.splice(0, memRetrieval.latencies.length - MEM_LAT_RING);
  }
  for (const lane of lanes) {
    if (lane in memRetrieval.lanes) memRetrieval.lanes[lane] += 1;
  }
}

function ensureProvider(p) {
  if (!metrics.byProvider[p])
    metrics.byProvider[p] = { requests: 0, successes: 0, failures: 0, totalLatencyMs: 0 };
}

function ensureTask(t) {
  if (!metrics.byTask[t])
    metrics.byTask[t] = { requests: 0, successes: 0, failures: 0 };
}

function pushLatency(ms) {
  metrics.latencyWindow.push(ms);
  if (metrics.latencyWindow.length > 500) metrics.latencyWindow.shift();
}

// ── Request context ───────────────────────────────────────────────────────────

/**
 * Create a context object for one HTTP request.
 *
 * @param {{ conversationId: string, requestId: string } | string} [idObj]
 *   Pass an object { conversationId, requestId } from chat.js.
 *   Accepts a bare string for backward compat (treated as conversationId).
 *
 * @returns {{ requestId, conversationId, startTime, attempts }}
 */
export function createContext(idObj) {
  let conversationId, requestId;

  if (typeof idObj === 'object' && idObj !== null) {
    conversationId = idObj.conversationId || 'unknown';
    requestId      = idObj.requestId      || uuidv4();
  } else {
    // Legacy: bare string → treat as conversationId
    conversationId = idObj || 'unknown';
    requestId      = uuidv4();
  }

  return {
    requestId,
    conversationId,
    startTime: Date.now(),
    attempts:  [],
  };
}

/**
 * Record one provider attempt inside the request context.
 */
export function recordAttempt(ctx, { provider, outcome, latencyMs, reason, model, score }) {
  ctx.attempts.push({
    provider,
    outcome,
    latencyMs: latencyMs ?? null,
    reason:    reason    ?? null,
    model:     model     ?? null,
    score:     score     ?? null,
    ts:        Date.now(),
  });
}

// ── Memory event logging ───────────────────────────────────────────────────────

/**
 * Log a memory lifecycle event.
 *
 * @param {object} ctx
 * @param {'EXTRACTED'|'RETRIEVED'|'INJECTED'|'SKIPPED'|'NO_MEMORIES'} event
 * @param {string[]} details  - e.g. ['name=Ananya', 'favorite_language=Rust']
 */
export function logMemoryEvent(ctx, event, details = []) {
  // Update metric counter
  metrics.memoryEvents[event] = (metrics.memoryEvents[event] || 0) + 1;

  const entry = {
    type:           'AQUA_MEMORY',
    ts:             new Date().toISOString(),
    requestId:      ctx.requestId,
    conversationId: ctx.conversationId,
    event,
    count:          details.length,
    details,
  };

  console.log('[MEMORY]', JSON.stringify(entry));
}

// ── Plan event logging (Phase 4) ────────────────────────────────────────────

/**
 * Log an execution-plan event — one per request, right after the
 * Execution Planner runs and before generation starts.
 *
 * @param {object} ctx
 * @param {{ taskType: string, complexity: 'low'|'medium'|'high', multiStep: boolean, mode?: string, steps?: string[] }} plan
 */
export function logPlanEvent(ctx, plan) {
  metrics.planComplexity[plan.complexity] = (metrics.planComplexity[plan.complexity] || 0) + 1;

  const entry = {
    type:           'AQUA_PLAN',
    ts:             new Date().toISOString(),
    requestId:      ctx.requestId,
    conversationId: ctx.conversationId,
    taskType:       plan.taskType,
    complexity:     plan.complexity,
    multiStep:      plan.multiStep,
    reasoningMode:  plan.mode ?? null,
    stepCount:      plan.steps?.length ?? 0,
  };

  console.log('[PLAN]', JSON.stringify(entry));
}

// ── Intelligence pipeline event logging (Internal Intelligence Engine) ─────

/**
 * Log one Internal Intelligence Engine run — Planner/Reasoning Engine/
 * Critic/Synthesizer output for a single request.
 *
 * @param {object} ctx
 * @param {{ plan: object, reasoning: object, critic: object, synthesis: object }} intelligence
 */
export function logIntelligenceEvent(ctx, intelligence) {
  const active = !!intelligence?.plan?.active;
  if (active) metrics.intelligenceActivations++;

  const entry = {
    type:           'AQUA_INTELLIGENCE',
    ts:             new Date().toISOString(),
    requestId:      ctx.requestId,
    conversationId: ctx.conversationId,
    taskType:       intelligence?.plan?.taskType ?? null,
    active,
    strategy:       intelligence?.reasoning?.strategy ?? null,
    pipelineStages: intelligence?.plan?.pipeline?.map(s => s.name) ?? [],
    criticFocus:    intelligence?.critic?.focusRisks ?? [],
  };

  console.log('[INTELLIGENCE]', JSON.stringify(entry));
}

// ── Adaptive Tool Orchestrator event logging (Phase 6) ─────────────────────

/**
 * Log one Adaptive Tool Orchestrator decision — profile, capabilities
 * enabled/skipped, cost/latency estimate, verification decision. Printed in
 * the spec's literal human-readable [ORCHESTRATOR] block (see
 * src/orchestrator/toolOrchestrator.js's formatOrchestratorLog), with a
 * parallel structured entry feeding metrics — same dual approach
 * logPlanEvent/logIntelligenceEvent already use for their console output.
 *
 * Internal-only: this never reaches the client response body. chat.js's
 * JSON response carries a much smaller `orchestration` summary field for
 * its own debugging-API consumers (mirroring its existing `plan`/
 * `intelligence` diagnostic fields) — full capability reasoning text stays
 * server-side, per the spec's "should not appear in user-facing responses".
 *
 * @param {object} ctx
 * @param {object} decision        result of orchestrate()
 * @param {string} formattedBlock  result of formatOrchestratorLog(decision)
 */
export function logOrchestratorEvent(ctx, decision, formattedBlock) {
  metrics.orchestratorProfiles[decision.profile.id] =
    (metrics.orchestratorProfiles[decision.profile.id] || 0) + 1;

  for (const c of decision.enabled) {
    metrics.orchestratorCapabilities.enabled[c.id] = (metrics.orchestratorCapabilities.enabled[c.id] || 0) + 1;
  }
  for (const c of decision.skipped) {
    metrics.orchestratorCapabilities.skipped[c.id] = (metrics.orchestratorCapabilities.skipped[c.id] || 0) + 1;
  }
  if (decision.verification.enabled) metrics.verificationEnabled++;

  console.log(formattedBlock);

  const entry = {
    type:           'AQUA_ORCHESTRATOR',
    ts:             new Date().toISOString(),
    requestId:      ctx.requestId,
    conversationId: ctx.conversationId,
    profile:        decision.profile.id,
    enabledCount:   decision.enabled.length,
    skippedCount:   decision.skipped.length,
    estimatedCost:      decision.estimatedCost,
    estimatedLatency:   decision.estimatedLatency,
    verificationEnabled: decision.verification.enabled,
  };

  console.log('[ORCHESTRATOR_EVENT]', JSON.stringify(entry));
}

// ── Verification event logging (real post-generation verification pass) ────

/**
 * Log one verification pass — whether the agent actually ran, whether the
 * draft passed as-is or was replaced, and which provider produced the
 * verdict. Distinct from logOrchestratorEvent's verificationEnabled count,
 * which only records that verification was WARRANTED — this records what
 * actually happened once src/intelligence/verificationAgent.js ran.
 *
 * @param {object} ctx
 * @param {{ ran: boolean, passed: boolean|null, revised: boolean, provider?: string, latencyMs?: number, error?: string }} result
 */
export function logVerificationEvent(ctx, result) {
  if (!result?.ran) {
    if (result?.error) metrics.verificationFailed++;
    return;
  }

  metrics.verificationRuns++;
  if (result.revised) metrics.verificationRevised++;
  if (result.agent === 'debate') metrics.debateRuns++;

  const entry = {
    type:           'AQUA_VERIFICATION',
    ts:             new Date().toISOString(),
    requestId:      ctx.requestId,
    conversationId: ctx.conversationId,
    agent:          result.agent ?? 'verification',
    panel:          result.panel ?? null,
    passed:         result.passed,
    revised:        result.revised,
    inconclusive:   result.inconclusive ?? false,
    passes:         result.passes ?? 1,
    converged:      result.converged ?? result.passed ?? null,
    disagreements:  result.disagreements?.length ?? 0,
    provider:       result.provider ?? null,
    latencyMs:      result.latencyMs ?? null,
  };

  console.log('[VERIFICATION]', JSON.stringify(entry));
}

// ── Completion logging ────────────────────────────────────────────────────────

/**
 * Emit structured log line and update metrics at request completion.
 *
 * @param {object} ctx   - from createContext()
 * @param {object} data  - completion fields
 */

// ── Search event logging (Web Search) ────────────────────────────────────────

/**
 * Log one Web Search execution — at most one per request, emitted by
 * chat.js's step 5d right after the search agent returns. `result` is the
 * SearchManager payload (see src/search/searchManager.js); this logs the
 * DIAGNOSTIC surface only — the full contextBlock never hits the log line
 * (it already lands in the prompt; duplicating ~1200 tokens per request
 * into stdout would drown everything else).
 *
 * @param {object} ctx
 * @param {{ used: boolean, cached: boolean, provider: string|null, query: string,
 *           sources: object[], contextTokens: number, latencyMs: number,
 *           attempts: object[], reason?: string }} result
 */
export function logSearchEvent(ctx, result) {
  if (!result) return;

  if (result.used && result.cached)      metrics.searchEvents.cached    += 1;
  else if (result.used)                  metrics.searchEvents.performed += 1;
  else if (result.attempts?.some(a => a.outcome === 'failed')) metrics.searchEvents.failed += 1;
  else                                   metrics.searchEvents.noResults += 1;

  if (result.used && result.provider) {
    metrics.searchByProvider[result.provider] = (metrics.searchByProvider[result.provider] || 0) + 1;
  }

  const entry = {
    type:           'AQUA_SEARCH',
    ts:             new Date().toISOString(),
    requestId:      ctx.requestId,
    conversationId: ctx.conversationId,
    used:           result.used,
    cached:         result.cached,
    provider:       result.provider,
    query:          (result.query ?? '').slice(0, 160),
    sources:        result.sources?.length ?? 0,
    contextTokens:  result.contextTokens ?? 0,
    latencyMs:      result.latencyMs ?? null,
    attempts:       (result.attempts ?? []).map(a => `${a.provider}#${a.keySlot ?? '-'}:${a.outcome}${a.reason ? `(${a.reason})` : ''}`),
    ...(result.reason ? { reason: result.reason } : {}),
  };

  console.log('[SEARCH]', JSON.stringify(entry));
}

/**
 * Human-readable SEARCH DECISION block (server log only). chat.js step 5d
 * emits this on EVERY turn — whether search ran or was skipped — so the log
 * always states the decision and why, plus (when it ran) provider / results /
 * cache / injected-tokens / latency. This replaces the old bare
 * "Skipped: Web Search" orchestrator line with the richer diagnostic the
 * spec's Logging section asks for. Purely presentational: it reads fields off
 * the web_search capability entry (carrying decideWebSearch's reason) and the
 * SearchManager payload — it computes nothing and mutates no metrics
 * (logSearchEvent already owns the counters).
 *
 * @param {{ enabled: boolean, reason?: string }|undefined} capability  web_search entry from orchestrate().capabilities
 * @param {object|null} result  SearchManager payload, or null when search was not attempted
 * @returns {string}
 */
export function formatSearchDecisionLog(capability, result) {
  const needSearch = !!(capability && capability.enabled);
  const reason = capability?.reason
    || (needSearch ? 'live web data required' : 'model knowledge sufficient');
  const lines = ['[SEARCH DECISION]', `Need Search = ${needSearch ? 'YES' : 'NO'}`, `Reason = ${reason}`];

  if (needSearch && result) {
    if (result.used) {
      lines.push(
        `Provider = ${result.provider ?? 'unknown'}`,
        `Results = ${result.sources?.length ?? 0}`,
        `Cache = ${result.cached ? 'HIT' : 'MISS'}`,
        `Tokens Injected = ${result.contextTokens ?? 0}`,
      );
    } else {
      // Fail-open path — every provider missing/failed. The answer still
      // generates from model knowledge; the log makes that explicit.
      lines.push('Provider = none', `Outcome = ${result.reason ?? 'no usable results'} (fail-open)`);
    }
    lines.push(`Latency = ${result.latencyMs ?? 0}ms`);
  }

  return lines.join('\n');
}

export function logCompletion(ctx, {
  taskType,
  classifierConfidence,
  promptModules,
  promptTokens,
  responseLength,
  selectedProvider,
  providerScore,
  validationResult,
  finalLatencyMs,
  completionReason,
  memoriesExtracted = 0,
  memoriesInjected  = 0,
  complexity        = null,  // Phase 4
  reasoningMode     = null,  // Phase 4
  error,
}) {
  const totalMs  = Date.now() - ctx.startTime;
  const chainStr = ctx.attempts
    .map(a => `${a.provider}:${a.outcome}${a.reason ? `(${a.reason})` : ''}`)
    .join(' → ');

  const entry = {
    type:                 'AQUA_REQUEST',
    ts:                   new Date().toISOString(),
    requestId:            ctx.requestId,
    conversationId:       ctx.conversationId,
    taskType,
    classifierConfidence: classifierConfidence ? +classifierConfidence.toFixed(2) : null,
    promptModules:        promptModules ?? [],
    promptTokens:         promptTokens  ?? null,
    responseLength:       responseLength ?? null,
    selectedProvider:     selectedProvider ?? null,
    providerScore:        providerScore != null ? +providerScore.toFixed(1) : null,
    fallbackChain:        chainStr,
    attempts:             ctx.attempts.length,
    totalMs,
    finalLatencyMs:       finalLatencyMs ?? null,
    validationResult:     validationResult ?? null,
    completionReason:     completionReason ?? (error ? 'error' : 'success'),
    memoriesExtracted,
    memoriesInjected,
    complexity,
    reasoningMode,
    error:                error?.message ?? null,
  };

  console.log('[AQUA]', JSON.stringify(entry));

  // ── Push into ring buffer ──────────────────────────────────────────────────
  recentLogs.push(entry);
  if (recentLogs.length > LOG_RING_SIZE) recentLogs.shift();

  // ── Update metrics ─────────────────────────────────────────────────────────
  metrics.totalRequests++;
  if (taskType) {
    ensureTask(taskType);
    metrics.byTask[taskType].requests++;
  }

  if (selectedProvider && !error) {
    metrics.totalSuccesses++;
    if (taskType) metrics.byTask[taskType].successes++;
    ensureProvider(selectedProvider);
    metrics.byProvider[selectedProvider].requests++;
    metrics.byProvider[selectedProvider].successes++;
    metrics.byProvider[selectedProvider].totalLatencyMs += finalLatencyMs || 0;
    pushLatency(totalMs);
  } else {
    metrics.totalFailures++;
    if (taskType) metrics.byTask[taskType].failures++;
    if (selectedProvider) {
      ensureProvider(selectedProvider);
      metrics.byProvider[selectedProvider].failures++;
    }
  }
}

/**
 * Return current metrics snapshot for /metrics or Prometheus scrape.
 */
export function getMetrics() {
  const lats = metrics.latencyWindow;
  const sorted = lats.slice().sort((a, b) => a - b);

  // Memory 5.0 Phase F — retrieval quality/latency snapshot
  const memLats = memRetrieval.latencies.slice().sort((a, b) => a - b);
  const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);
  const memoryRetrieval = {
    count: memRetrieval.count,
    nonEmpty: memRetrieval.nonEmpty,
    nonEmptyRate: memRetrieval.count ? +(memRetrieval.nonEmpty / memRetrieval.count * 100).toFixed(1) : null,
    avgLatencyMs: memLats.length ? +(memLats.reduce((a, b) => a + b, 0) / memLats.length).toFixed(2) : 0,
    p50LatencyMs: +pct(memLats, 0.50).toFixed(2),
    p95LatencyMs: +pct(memLats, 0.95).toFixed(2),
    lanes: { ...memRetrieval.lanes },
  };

  return {
    memoryRetrieval,
    totalRequests:  metrics.totalRequests,
    totalSuccesses: metrics.totalSuccesses,
    totalFailures:  metrics.totalFailures,
    successRate:    metrics.totalRequests
      ? +(metrics.totalSuccesses / metrics.totalRequests * 100).toFixed(1)
      : null,
    avgLatencyMs:   lats.length
      ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length)
      : 0,
    p95LatencyMs:   sorted.length
      ? sorted[Math.floor(sorted.length * 0.95)] ?? 0
      : 0,
    memoryEvents:   metrics.memoryEvents,
    planComplexity: metrics.planComplexity,
    intelligenceActivations: metrics.intelligenceActivations,
    orchestratorProfiles:     metrics.orchestratorProfiles,
    orchestratorCapabilities: metrics.orchestratorCapabilities,
    verificationEnabled:      metrics.verificationEnabled,
    verificationRuns:         metrics.verificationRuns,
    verificationRevised:      metrics.verificationRevised,
    verificationFailed:       metrics.verificationFailed,
    byProvider:     Object.fromEntries(
      Object.entries(metrics.byProvider).map(([p, s]) => [p, {
        ...s,
        avgLatencyMs: s.requests ? Math.round(s.totalLatencyMs / s.requests) : 0,
      }])
    ),
    byTask: metrics.byTask,
  };
}

/**
 * Return recent AQUA_REQUEST log entries (newest last).
 * @param {number} [limit=50]
 */
export function getRecentLogs(limit = 50) {  return recentLogs.slice(-Math.min(limit, LOG_RING_SIZE));
}