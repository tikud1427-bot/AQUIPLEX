/**
 * AQUA Provider Router v4
 *
 * Changes from v3 (Issue 1/7/8/9):
 *   6. callProvider()/generateText() now handle the { text, truncated,
 *      finishReason } shape gemini.js/groq.js/openrouter.js return.
 *      finishReason="length" (the output-token budget was hit) is treated
 *      as a SUCCESSFUL completion: markSuccess (not markFailure), no
 *      validateResponse reject-path, no retry on another provider — the
 *      partial answer is returned immediately with truncated=true so the
 *      client can offer "Continue". Previously providers threw
 *      TRUNCATED_MAX_TOKENS for this case, which this same catch block
 *      treated identically to a timeout/network/5xx failure — marking the
 *      provider unhealthy and burning through the whole fallback chain for
 *      a request that had actually succeeded.
 *
 * Changes from v2:
 *   1. toTry = ranked (ALL healthy providers, not just top 3)
 *      Previously: slice(0, 3) → if Groq/Gemini/OpenRouter[0] all fail → HARD TIMEOUT
 *      Now: exhausts every healthy provider before giving up
 *
 *   2. taskType accepted from caller (chat.js already classified)
 *      Avoids double classification — classifyTask runs once per request total
 *      Falls back to internal classification if not provided (backward compat)
 *
 *   3. QUALITY table extended: memory_recall, memory_update, planning columns
 *
 *   4. Degraded mode logging improved — clearly logs WHICH providers are unhealthy
 *
 * Phase 4 addition (additive, optional):
 *   5. generateText() accepts an optional executionPlan — its complexity tier
 *      biases provider order (strategy.js) and timeout budget (timeoutManager.js).
 *      Omitting the param reproduces pre-Phase-4 behavior exactly.
 */

import { classifyTask }        from '../core/classifier.js';
import { getProviderStrategy } from '../core/strategy.js';
import {
  isProviderHealthy, markSuccess, markFailure, getHealthScore,
} from '../core/health.js';
import { validateResponse }    from '../core/validator.js';
import { getTimeout }          from '../core/timeoutManager.js';
import { generateGemini, streamGemini }         from './gemini.js';
import { generateGroq, streamGroq }             from './groq.js';
import { generateOpenRouter, streamOpenRouter } from './openrouter.js';
import { getProviderPrior } from '../intelligence/learningLedger.js';
import {
  classifyProviderError, describeError, createProviderError, ProviderError,
} from './providerErrors.js';
import { computeBackoff, sleep as backoffSleep } from '../core/backoff.js';

// ── Retry-round configuration (env-tunable; sane production defaults) ──────────
// Governs ONLY the transient-failure retry path. The common case — a provider
// succeeds on the first attempt — never touches any of this and adds zero
// latency, so normal chat behavior is unchanged.
function envInt(name, def) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}
const RETRY_DEFAULTS = {
  maxRounds:     envInt('AQUA_PROVIDER_MAX_ROUNDS', 4),
  retryBudgetMs: envInt('AQUA_PROVIDER_RETRY_BUDGET_MS', 90_000),
  baseBackoffMs: envInt('AQUA_PROVIDER_BACKOFF_MS', 500),
  capBackoffMs:  envInt('AQUA_PROVIDER_BACKOFF_CAP_MS', 8_000),
};

// Per-attempt mechanics (the `[PROVIDER] → x` line) are gated behind
// AQUA_PROVIDER_LOG=debug so a benchmark run isn't flooded. Every routing
// DECISION — the ranked set, why each provider failed, retry/backoff choices,
// terminal exhaustion — still logs at info (task 9).
const LOG_DEBUG = String(process.env.AQUA_PROVIDER_LOG ?? '').toLowerCase() === 'debug';

// ── Provider quality matrix ───────────────────────────────────────────────────
// 0–100: capability of this provider for this task type.
// Empirical + benchmark-driven. Update as models improve.

const QUALITY = {
  gemini: {
    conversation:          68, personal_info:         68, simple_qa:             80,
    opinion:               74, brainstorming:         85, summarization:         84,
    debugging:             88, coding:                90, architecture:          96,
    research:              95, reasoning:             91, analysis:              92,
    planning:              89, creative_writing:      85, file_analysis:         90,
    agent_task:            88, memory_recall:         80, memory_update:         75,
  },
  groq: {
    conversation:          95, personal_info:         92, simple_qa:             88,
    opinion:               82, brainstorming:         79, summarization:         79,
    debugging:             80, coding:                80, architecture:          70,
    research:              72, reasoning:             75, analysis:              74,
    planning:              74, creative_writing:      78, file_analysis:         70,
    agent_task:            70, memory_recall:         95, memory_update:         92,
  },
  openrouter: {
    conversation:          65, personal_info:         65, simple_qa:             70,
    opinion:               70, brainstorming:         70, summarization:         75,
    debugging:             75, coding:                75, architecture:          75,
    research:              78, reasoning:             72, analysis:              76,
    planning:              72, creative_writing:      72, file_analysis:         72,
    agent_task:            72, memory_recall:         70, memory_update:         68,
  },
};


// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Exported for tests (learned-prior delta is asserted directly against this).
 * Score = static quality × 0.55 + runtime health × 0.45 + learned prior.
 * The prior (Phase 11, learningLedger.js) is 0 until MIN_SAMPLE turns exist
 * for this (provider, taskType) and clamped to ±6 — it nudges ranking toward
 * providers whose answers for this task type historically verify clean with
 * high response confidence; it can never outvote health or a large static
 * quality gap on its own.
 */
export function scoreProvider(provider, taskType) {
  if (!isProviderHealthy(provider)) return 0;
  const quality = QUALITY[provider]?.[taskType] ?? 70;
  const health  = getHealthScore(provider);
  return (quality * 0.55) + (health * 0.45) + getProviderPrior(provider, taskType);
}

function rankProviders(taskType, complexity) {
  const order  = getProviderStrategy(taskType, complexity);
  const scored = order.map(p => ({ provider: p, score: scoreProvider(p, taskType) }));
  const active = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score);

  if (!active.length) {
    // All providers unhealthy — degraded mode: attempt all anyway
    const unhealthy = scored.map(x => x.provider).join(', ');
    console.warn(`[ROUTER] ⚠ All providers unhealthy (${unhealthy}) — degraded mode`);
    return scored.map(x => ({ ...x, score: 1 }));
  }

  return active;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function timedAbort(ms) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

async function callProvider(providerFns, provider, systemPrompt, messages, signal, maxTokens) {
  const start  = Date.now();
  const fn     = providerFns[provider] ?? providerFns.openrouter;
  const result = await fn(systemPrompt, messages, signal, maxTokens); // { text, truncated, finishReason }
  return { ...result, latency: Date.now() - start };
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Generate a response, trying all healthy providers in ranked order.
 *
 * @param {string} userMessage    - raw user message
 * @param {string} systemPrompt   - from promptBuilder (already includes memory block)
 * @param {Array}  messages       - [{role, content}] context window
 * @param {object} ctx            - observability context
 * @param {string} [preTaskType]  - if caller already classified, pass it to avoid re-classifying
 * @param {object} [executionPlan] - Phase 4: from executionPlanner.js — { complexity, ... }.
 *                                   Optional; omitting it reproduces pre-Phase-4 behavior exactly.
 * @param {object} [responseBudget] - Phase 6: from orchestrator's execution profile —
 *                                   { maxResponseTokens, ... }. Optional; omitting it
 *                                   reproduces pre-Phase-6 behavior exactly (no max_tokens
 *                                   sent to any provider, response length fully model-driven).
 * @returns {Promise<object>}
 */
export async function generateText(userMessage, systemPrompt, messages, ctx = {}, preTaskType, executionPlan, responseBudget, deps = {}) {
  const requestId  = ctx.requestId ?? 'unknown';
  const complexity = executionPlan?.complexity;        // undefined → strategy/timeout no-op defaults
  const maxTokens  = responseBudget?.maxResponseTokens; // undefined → providers omit the field entirely

  // Dependency-injection seam (test/soak only). Production passes nothing → real
  // provider adapters, real clock, real jittered sleep. Same deps convention
  // already used by debateAgent.js / graphRuntime.js.
  const providerFns = {
    gemini:     deps.gemini     ?? generateGemini,
    groq:       deps.groq       ?? generateGroq,
    openrouter: deps.openrouter ?? generateOpenRouter,
  };
  const now   = deps.now   ?? Date.now;
  const doNap = deps.sleep ?? backoffSleep;
  const rng   = deps.rng   ?? Math.random;
  const cfg   = { ...RETRY_DEFAULTS, ...(deps.config ?? {}) };

  // ── 1. Classify (skip if caller already did it) ──────────────────────────────
  let taskType, confidence, labels;
  if (preTaskType) {
    taskType   = preTaskType;
    confidence = 1.0;
    labels     = [preTaskType];
  } else {
    ({ task: taskType, confidence, labels } = classifyTask(userMessage));
    console.log(`[CLASSIFIER] task=${taskType} conf=${confidence.toFixed(2)} labels=[${labels}] req=${requestId}`);
  }

  const promptLength   = systemPrompt.length + messages.reduce((s, m) => s + m.content.length, 0);
  const fallbackChain  = [];
  const providerErrors = [];
  const deadline       = now() + cfg.retryBudgetMs;
  let   finalError     = null;
  let   anyRetryable   = false;
  let   retryAfterHint = 0;

  // ── 2. Bounded retry-rounds over the ranked provider set ──────────────────────
  // Round 1 is the classic single pass (byte-identical to the old behavior when a
  // provider succeeds on the first try). Extra rounds happen ONLY when every
  // provider in a pass failed AND ≥1 failure was transient (retryable): the herd
  // is spread out with exponential backoff + full jitter, and health is re-ranked
  // each round so a provider whose circuit-breaker cooldown expired (HALF_OPEN
  // probe) or whose per-model cooldown self-healed re-enters the rotation. This is
  // what makes a 429/503 burst across all providers ride out instead of instantly
  // exhausting the chain and returning a 500.
  for (let round = 1; round <= cfg.maxRounds; round++) {
    const ranked = rankProviders(taskType, complexity);
    console.log(`[ROUTER] round=${round}/${cfg.maxRounds} providers=[${ranked.map(r => `${r.provider}(${r.score.toFixed(0)})`).join(', ')}] task=${taskType} complexity=${complexity ?? 'n/a'} maxTokens=${maxTokens ?? 'n/a'} req=${requestId}`);

    let retryableThisRound = false;

    for (const { provider, score } of ranked) {
      if (ctx.clientSignal?.aborted) {
        const a = new Error('CLIENT_ABORTED'); a.code = 'CLIENT_ABORTED'; throw a;
      }

      const timeoutMs         = getTimeout(taskType, provider, promptLength, complexity);
      const { signal, clear } = timedAbort(timeoutMs);
      if (LOG_DEBUG) console.log(`[PROVIDER] → ${provider} round=${round} score=${score.toFixed(0)} timeout=${timeoutMs}ms task=${taskType}`);

      try {
        const { text, truncated, finishReason, latency } =
          await callProvider(providerFns, provider, systemPrompt, messages, signal, maxTokens);
        clear();

        // ── Issue 1/7/8/9: max-output-tokens is a SUCCESSFUL completion ────────────
        // The provider did its job and ran out of output budget — it did not fail.
        if (truncated) {
          markSuccess(provider, latency);
          fallbackChain.push({ provider, outcome: 'success', truncated: true, latencyMs: latency });
          ctx.attempts?.push({ provider, outcome: 'success', truncated: true, latencyMs: latency, score });
          console.log(`[ROUTER] ✓ ${provider} (truncated, finishReason=length) latency=${latency}ms round=${round} req=${requestId}`);
          return {
            provider, text, taskType, latency, score, confidence, labels, fallbackChain,
            truncated: true, finishReason: 'length', rounds: round, attempts: fallbackChain.length,
          };
        }

        // ── Validate (normal, non-truncated completions only) ────────────────────
        const vr = validateResponse(text, userMessage, taskType);
        if (!vr.valid) {
          console.log(`[VALIDATOR] ${provider} → invalid (${vr.reason}) — trying next req=${requestId}`);
          markFailure(provider, vr.reason, { type: 'invalid_response' });
          fallbackChain.push({ provider, outcome: 'invalid', reason: vr.reason, latencyMs: latency });
          ctx.attempts?.push({ provider, outcome: 'invalid', reason: vr.reason, latencyMs: latency, score });
          retryableThisRound = true; anyRetryable = true; // another provider may answer cleanly
          continue;
        }

        markSuccess(provider, latency);
        fallbackChain.push({ provider, outcome: 'success', latencyMs: latency });
        ctx.attempts?.push({ provider, outcome: 'success', latencyMs: latency, score });
        console.log(`[ROUTER] ✓ ${provider} latency=${latency}ms score=${score.toFixed(0)} round=${round} req=${requestId}`);
        return {
          provider, text, taskType, latency, score, confidence, labels, fallbackChain,
          truncated: false, finishReason: finishReason ?? 'stop', rounds: round, attempts: fallbackChain.length,
        };

      } catch (err) {
        clear();
        // Client walked away during the call — not a provider failure.
        if (ctx.clientSignal?.aborted || err.code === 'CLIENT_ABORTED') {
          const a = new Error('CLIENT_ABORTED'); a.code = 'CLIENT_ABORTED'; throw a;
        }

        const cls  = classifyProviderError(err);
        const perr = createProviderError({ provider, cause: err, classification: cls, attempt: fallbackChain.length + 1 });
        finalError = perr;
        providerErrors.push(perr.toJSON());

        // Health accounting differentiated by structured type; a provider-supplied
        // Retry-After widens the circuit-breaker cooldown (task 5: quota vs transient).
        markFailure(provider, describeError(cls), { cooldownMs: cls.retryAfterMs ?? undefined, type: cls.type });

        fallbackChain.push({ provider, outcome: 'failed', reason: cls.type, status: cls.status, retryable: cls.retryable, latencyMs: null });
        ctx.attempts?.push({ provider, outcome: 'failed', reason: cls.type, status: cls.status, retryable: cls.retryable, score, error: perr.toJSON() });

        console.log(`[ROUTER] ✗ ${provider} type=${cls.type}${cls.status ? ` status=${cls.status}` : ''} retryable=${cls.retryable} scope=${cls.scope} round=${round} — ${cls.retryable ? 'will retry' : 'terminal for this provider'} req=${requestId}`);

        if (cls.retryable) {
          retryableThisRound = true; anyRetryable = true;
          if (cls.retryAfterMs) retryAfterHint = Math.max(retryAfterHint, cls.retryAfterMs);
        }
      }
    }

    // ── End of a full pass with no success ────────────────────────────────────
    if (!retryableThisRound) {
      console.log(`[ROUTER] round=${round} exhausted — no retryable providers remain, stopping req=${requestId}`);
      break;
    }
    if (round >= cfg.maxRounds) {
      console.log(`[ROUTER] max rounds (${cfg.maxRounds}) reached — stopping req=${requestId}`);
      break;
    }
    const backoffMs = computeBackoff(round, {
      baseMs: cfg.baseBackoffMs, capMs: cfg.capBackoffMs,
      minMs:  Math.min(retryAfterHint, cfg.capBackoffMs), rng,
    });
    if (now() + backoffMs > deadline) {
      console.log(`[ROUTER] retry budget (${cfg.retryBudgetMs}ms) would be exceeded by a ${backoffMs}ms backoff — stopping req=${requestId}`);
      break;
    }
    console.log(`[ROUTER] round=${round} all failures retryable — backing off ${backoffMs}ms then retrying req=${requestId}`);
    await doNap(backoffMs, ctx.clientSignal);
  }

  // ── 3. Terminal: every round exhausted ────────────────────────────────────────
  const chain = fallbackChain.map(f => `${f.provider}:${f.outcome}${f.reason ? `(${f.reason})` : ''}`).join(' → ');
  const terminal = new ProviderError({
    provider: finalError?.provider ?? 'router',
    type:     finalError?.type ?? 'unknown',
    status:   finalError?.status ?? null,
    message:  `All providers exhausted | task=${taskType} | chain=${chain}`,
    retryAfterMs: anyRetryable ? (retryAfterHint || 2000) : null,
    cause:    finalError ?? undefined,
  });
  // If ANY attempt this request was transient, the exhaustion is retryable (a later
  // attempt may hit a recovered provider) — this is what lets chat.js answer a
  // 503 + Retry-After instead of a terminal 500.
  terminal.retryable      = anyRetryable;
  terminal.attempts       = fallbackChain;
  terminal.providerErrors = providerErrors;
  terminal.taskType       = taskType;
  console.error(`[ROUTER] ✗✗ exhausted task=${taskType} retryable=${anyRetryable} attempts=${fallbackChain.length} chain=${chain} req=${requestId}`);
  throw terminal;
}

// ── Streaming entry (Day 3 — Real Streaming) ─────────────────────────────────

async function callProviderStream(provider, systemPrompt, messages, signal, maxTokens, onDelta) {
  const start = Date.now();
  let result;
  if      (provider === 'gemini')     result = await streamGemini(systemPrompt, messages, signal, maxTokens, onDelta);
  else if (provider === 'groq')       result = await streamGroq(systemPrompt, messages, signal, maxTokens, onDelta);
  else                                result = await streamOpenRouter(systemPrompt, messages, signal, maxTokens, onDelta);
  return { ...result, latency: Date.now() - start };
}

/**
 * generateTextStream — same ranking / health / fallback semantics as
 * generateText, streamed. Contract:
 *
 *   • Provider fallback happens ONLY before the first token reaches the
 *     client (onEvent 'token'). Once a token is emitted, a mid-stream
 *     failure surfaces as a truncated/interrupted result, never a silent
 *     retry that restarts the answer under the user's cursor.
 *   • Per-provider timeout covers time-to-first-token (router budget from
 *     timeoutManager, unchanged). After the first token, a rolling stall
 *     timer (STALL_MS, reset on every delta) replaces it — long answers
 *     must not be killed by a budget sized for whole request/response
 *     round trips.
 *   • clientSignal (SSE socket closed / Stop pressed) aborts the active
 *     provider immediately and throws CLIENT_ABORTED with whatever partial
 *     text accumulated attached (err.partialText) so the route can persist
 *     what the user actually saw.
 *   • validateResponse is skipped for streamed output — tokens are already
 *     on screen; rejecting a fully-rendered answer and re-running it on a
 *     different provider would be strictly worse UX than keeping it.
 *
 * @param {object}   args                 same fields as generateText, plus:
 * @param {AbortSignal} [args.clientSignal] fired when the HTTP client disconnects
 * @param {(event: object) => void} args.onEvent
 *        { type:'provider_attempt', provider, score, attempt }
 *        { type:'provider_failed',  provider, reason }
 *        { type:'token', text }
 */
export async function generateTextStream({
  userMessage, systemPrompt, messages, ctx = {},
  preTaskType, executionPlan, responseBudget,
  clientSignal, onEvent,
}) {
  const requestId  = ctx.requestId ?? 'unknown';
  const complexity = executionPlan?.complexity;
  const maxTokens  = responseBudget?.maxResponseTokens;
  const STALL_MS   = 45_000; // rolling inter-token stall budget

  let taskType = preTaskType, confidence = 1.0, labels = [preTaskType];
  if (!preTaskType) {
    ({ task: taskType, confidence, labels } = classifyTask(userMessage));
  }

  const ranked = rankProviders(taskType, complexity);
  console.log(`[ROUTER] stream providers=[${ranked.map(r => `${r.provider}(${r.score.toFixed(0)})`).join(', ')}] task=${taskType} complexity=${complexity ?? 'n/a'} req=${requestId}`);

  const promptLength  = systemPrompt.length + messages.reduce((s, m) => s + m.content.length, 0);
  const fallbackChain = [];
  let   finalError;
  let   attempt = 0;

  for (const { provider, score } of ranked) {
    if (clientSignal?.aborted) {
      const err = new Error('CLIENT_ABORTED');
      err.partialText = '';
      throw err;
    }

    attempt += 1;
    const firstTokenBudget = getTimeout(taskType, provider, promptLength, complexity);
    const ctrl = new AbortController();

    // Wire client disconnect straight into the provider call.
    const onClientAbort = () => ctrl.abort();
    clientSignal?.addEventListener('abort', onClientAbort, { once: true });

    let stallTimer  = setTimeout(() => ctrl.abort(), firstTokenBudget); // covers time-to-first-token
    let tokenCount  = 0;
    let partialText = '';

    const onDelta = (delta) => {
      tokenCount += 1;
      partialText += delta;
      // First token swaps the budget model: fixed TTFT budget → rolling stall timer.
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => ctrl.abort(), STALL_MS);
      onEvent({ type: 'token', text: delta });
    };

    console.log(`[PROVIDER] → ${provider} (stream) score=${score.toFixed(0)} ttft-budget=${firstTokenBudget}ms task=${taskType}`);
    onEvent({ type: 'provider_attempt', provider, score: +score.toFixed(1), attempt });

    try {
      const { text, truncated, finishReason, latency } =
        await callProviderStream(provider, systemPrompt, messages, ctrl.signal, maxTokens, onDelta);
      clearTimeout(stallTimer);
      clientSignal?.removeEventListener('abort', onClientAbort);

      markSuccess(provider, latency);
      const outcome = { provider, outcome: 'success', truncated: !!truncated, latencyMs: latency };
      fallbackChain.push(outcome);
      ctx.attempts?.push({ ...outcome, score });
      console.log(`[ROUTER] ✓ ${provider} (stream${truncated ? `, ${finishReason}` : ''}) latency=${latency}ms tokens=${tokenCount} req=${requestId}`);

      return {
        provider, text, taskType, latency, score, confidence, labels, fallbackChain,
        truncated: !!truncated, finishReason: finishReason ?? 'stop',
      };
    } catch (err) {
      clearTimeout(stallTimer);
      clientSignal?.removeEventListener('abort', onClientAbort);

      // Client walked away (Stop button / closed tab) — not a provider failure.
      if (clientSignal?.aborted) {
        const abortErr = new Error('CLIENT_ABORTED');
        abortErr.partialText = partialText;
        throw abortErr;
      }

      finalError = err;
      const reason = err.message === 'TIMEOUT'
        ? (tokenCount === 0 ? `timeout(${firstTokenBudget}ms ttft)` : `stall(${STALL_MS}ms)`)
        : (err.message ?? 'unknown');

      // Tokens already reached the client — cannot silently retry. Providers
      // return interrupted partials themselves for most mid-stream errors;
      // this covers the stall-abort path.
      if (tokenCount > 0) {
        console.log(`[ROUTER] ⚠ ${provider} stream interrupted after ${tokenCount} tokens (${reason}) — returning partial req=${requestId}`);
        markFailure(provider, reason);
        fallbackChain.push({ provider, outcome: 'interrupted', reason, latencyMs: null });
        ctx.attempts?.push({ provider, outcome: 'interrupted', reason, score });
        return {
          provider, text: partialText, taskType, latency: null, score, confidence, labels, fallbackChain,
          truncated: true, finishReason: 'interrupted',
        };
      }

      console.log(`[ROUTER] ✗ ${provider} (stream, pre-token) reason=${reason}`);
      markFailure(provider, reason);
      fallbackChain.push({ provider, outcome: 'failed', reason, latencyMs: null });
      ctx.attempts?.push({ provider, outcome: 'failed', reason, score });
      onEvent({ type: 'provider_failed', provider, reason });
      // fall through to next ranked provider — client hasn't seen anything yet
    }
  }

  const chain = fallbackChain.map(f => `${f.provider}:${f.outcome}`).join(' → ');
  throw finalError ?? new Error(`All providers exhausted | task=${taskType} | chain=${chain}`);
}
