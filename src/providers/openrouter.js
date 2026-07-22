/**
 * AQUA OpenRouter Provider v4
 *
 * Changes from v3 (Issue 4 — the core production bug this version fixes):
 *   Previously, generateOpenRouter() picked ONE model, tried it ONCE, and
 *   on ANY failure — including a 404 on that single model — threw straight
 *   up to router.js. router.js's catch block then called
 *   markFailure('openrouter', ...), decrementing the WHOLE PROVIDER's
 *   health/circuit-breaker state for a problem scoped to one dead model.
 *   Worse, OpenRouter's other 6 registered models never even got a chance
 *   — the very next request would fall back to a completely different
 *   PROVIDER (Gemini/Groq) instead of trying openrouter's next model.
 *
 *   Fixed: this now loops across every currently-available OpenRouter
 *   model (from the central registry, src/providers/modelRegistry.js) for
 *   a single request. A 404/429/5xx on one model marks ONLY that model
 *   and moves to the next candidate — openrouter's provider-level health
 *   is untouched unless every model is exhausted or the failure is
 *   genuinely provider-scoped (bad key / network — see below). Model
 *   selection itself still uses the pre-existing round-robin cursor
 *   (registry's `rotate: true` for this provider) so load keeps spreading
 *   across free-tier per-model rate limits even when everything is healthy.
 *
 * Other changes:
 *   - Model IDs no longer hardcoded here — central registry (Issue 5).
 *     Full list refreshed against OpenRouter's live free catalog
 *     (2026-07-02) — see modelRegistry.js's header for the ones removed.
 *   - Shared error classifier (providerErrors.js, Issue 4) distinguishes
 *     404 / 429 / 401-403 / 5xx / network — auth and network failures are
 *     genuinely provider-scoped (a bad key or dead connection doesn't get
 *     better by trying a different model with the same key), so those
 *     still propagate immediately as real provider failures. Only
 *     model-scoped errors (404/429/5xx) retry within this call.
 *   - TRUNCATED_MAX_TOKENS is no longer thrown (Issue 1) — hitting the
 *     output cap returns { text, truncated: true, finishReason: 'length' }
 *     as a successful completion.
 */

import OpenAI from 'openai';
import {
  getCandidateModels, markModelRateLimited, markModelTempFailed, markModelUnavailable,
} from './modelRegistry.js';
import { classifyProviderError, retryAfterMs } from './providerErrors.js';

// ── Key rotation ───────────────────────────────────────────────────────────────

function getKeys() {
  return [
    process.env.OPENROUTER_API_KEY_1,
    process.env.OPENROUTER_API_KEY_2,
    process.env.OPENROUTER_API_KEY_3,
    process.env.OPENROUTER_API_KEY_4,
  ].filter(Boolean);
}

/** Startup validation (Issue 6) — does this provider have any usable key at all? */
export function hasConfiguredKeys() {
  return getKeys().length > 0;
}

let keyIndex = 0;

function nextKey() {
  const keys = getKeys();
  if (!keys.length) throw new Error('No OpenRouter keys configured');
  const key = keys[keyIndex];
  keyIndex  = (keyIndex + 1) % keys.length;
  return key;
}

const clientCache = new Map();

function getClient(key) {
  if (!clientCache.has(key)) {
    clientCache.set(key, new OpenAI({
      apiKey:  key,
      // Overridable for corporate proxies / gateways / integration tests.
      baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    }));
  }
  return clientCache.get(key);
}

// ── Generate ───────────────────────────────────────────────────────────────────

/**
 * @param {string} systemPrompt
 * @param {Array<{role,content}>} messages
 * @param {AbortSignal} [signal]
 * @param {number} [maxTokens] - Phase 6 Response Budgeting: caps output length.
 *   Clamped per-model against the registry's maxOutputTokens.
 * @returns {Promise<{ text: string, truncated: boolean, finishReason: string }>}
 */
export async function generateOpenRouter(systemPrompt, messages, signal, maxTokens) {
  if (signal?.aborted) throw new Error('TIMEOUT');

  const candidates = getCandidateModels('openrouter');
  if (!candidates.length) throw Object.assign(new Error('No OpenRouter models currently available (cooling down or deprecated)'), { code: 'NO_CANDIDATE_MODELS' });

  const key    = nextKey();
  const client = getClient(key);

  const chatMessages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];

  let lastError;
  // Bounded so a fully-degraded registry can't turn into an unbounded loop
  // — never more attempts than models actually available this call.
  const attemptLimit = Math.min(candidates.length, 5);

  for (let i = 0; i < attemptLimit; i++) {
    const modelId   = candidates[i].modelId;
    const capTokens = maxTokens ? Math.min(maxTokens, candidates[i].maxOutputTokens) : maxTokens;

    if (signal?.aborted) throw new Error('TIMEOUT');

    console.log(`[OPENROUTER] model=${modelId} key=...${key.slice(-4)} (${i + 1}/${attemptLimit})`);

    const req = client.chat.completions.create({
      model:    modelId,
      messages: chatMessages,
      ...(capTokens ? { max_tokens: capTokens } : {}),
    });
    // Demo-stability fix: a lost Promise.race leaves `req` running detached;
    // a late rejection would be an unhandled rejection — fatal on modern
    // Node — and would crash the server mid-request. No-op handler marks it
    // handled; race path unaffected. (Same fix in groq.js / gemini.js.)
    Promise.resolve(req).catch(() => {});

    let result;
    try {
      result = signal
        ? await Promise.race([
            req,
            new Promise((_, rej) => {
              if (signal.aborted) return rej(new Error('TIMEOUT'));
              signal.addEventListener('abort', () => rej(new Error('TIMEOUT')), { once: true });
            }),
          ])
        : await req;
    } catch (err) {
      if (err.message === 'TIMEOUT') throw err; // router's budget spent — propagate immediately

      lastError = err;
      const { type, status } = classifyProviderError(err);

      // ── Model-scoped failures (Issue 4): only disable THIS model, try the next one ──
      if (type === 'model_not_found') {                 // permanent — wrong/removed model id
        markModelUnavailable('openrouter', modelId, `${status ?? ''} ${err.message}`.trim());
        continue;
      }
      if (type === 'model_unavailable') {               // TRANSIENT no-capacity ("no endpoints") — self-heals
        markModelTempFailed('openrouter', modelId, 60_000);
        continue;
      }
      if (type === 'rate_limit') {
        markModelRateLimited('openrouter', modelId, retryAfterMs(err) ?? 120_000);
        continue;
      }
      if (type === 'server_error') {
        markModelTempFailed('openrouter', modelId, retryAfterMs(err) ?? 45_000);
        continue;
      }

      // ── Provider/key-scoped failures: trying a different model with the
      // same bad key/connection won't help — this genuinely IS a provider
      // failure, so propagate immediately (router.js correctly marks
      // openrouter's health for these, per Issue 4's differentiation).
      console.log(`[OPENROUTER] key=...${key.slice(-4)} model=${modelId} error type=${type} status=${status} msg=${err.message}`);
      throw err;
    }

    const finishReason = result?.choices?.[0]?.finish_reason;
    const text = result?.choices?.[0]?.message?.content;

    // ── Issue 1: hitting the output-token cap is SUCCESS, not failure ──
    if (capTokens && finishReason === 'length') {
      if (!text || !text.trim()) {
        lastError = new Error(`OpenRouter: model ${modelId} returned empty truncated response`);
        continue;
      }
      console.log(`[OPENROUTER] model=${modelId} hit maxTokens=${capTokens} cap — returning partial as successful completion`);
      return { text, truncated: true, finishReason: 'length' };
    }

    if (!text) {
      lastError = new Error(`OpenRouter: model ${modelId} returned empty response`);
      continue;
    }

    return { text, truncated: false, finishReason: finishReason ?? 'stop' };
  }

  throw lastError ?? new Error('All OpenRouter models exhausted for this request');
}

/**
 * Streaming variant (Day 3 — Real Streaming).
 *
 * Same registry-driven model fallback and error scoping as
 * generateOpenRouter, with the streaming rule: model fallback only BEFORE
 * the first emitted delta; mid-stream failures return the partial as
 * finishReason='interrupted'.
 *
 * @param {(delta: string) => void} onDelta
 * @returns {Promise<{ text:string, truncated:boolean, finishReason:string, streamed:true }>}
 */
export async function streamOpenRouter(systemPrompt, messages, signal, maxTokens, onDelta) {
  if (signal?.aborted) throw new Error('TIMEOUT');

  const candidates = getCandidateModels('openrouter');
  if (!candidates.length) throw Object.assign(new Error('No OpenRouter models currently available (cooling down or deprecated)'), { code: 'NO_CANDIDATE_MODELS' });

  const key    = nextKey();
  const client = getClient(key);

  const chatMessages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];

  let lastError;
  const attemptLimit = Math.min(candidates.length, 5);

  for (let i = 0; i < attemptLimit; i++) {
    const modelId   = candidates[i].modelId;
    const capTokens = maxTokens ? Math.min(maxTokens, candidates[i].maxOutputTokens) : maxTokens;

    if (signal?.aborted) throw new Error('TIMEOUT');
    console.log(`[OPENROUTER] stream model=${modelId} key=...${key.slice(-4)} (${i + 1}/${attemptLimit})`);

    let stream;
    try {
      stream = await client.chat.completions.create(
        {
          model:    modelId,
          messages: chatMessages,
          stream:   true,
          ...(capTokens ? { max_tokens: capTokens } : {}),
        },
        { signal },
      );
    } catch (err) {
      if (signal?.aborted || err.name === 'AbortError') throw new Error('TIMEOUT');
      lastError = err;
      const { type, status } = classifyProviderError(err);
      if (type === 'model_not_found')   { markModelUnavailable('openrouter', modelId, `${status ?? ''} ${err.message}`.trim()); continue; }
      if (type === 'model_unavailable') { markModelTempFailed('openrouter', modelId, 60_000); continue; }
      if (type === 'rate_limit')        { markModelRateLimited('openrouter', modelId, retryAfterMs(err) ?? 120_000); continue; }
      if (type === 'server_error')      { markModelTempFailed('openrouter', modelId, retryAfterMs(err) ?? 45_000);   continue; }
      // Provider/key-scoped failure — a different model won't help.
      throw err;
    }

    let text = '';
    let finishReason = null;
    try {
      for await (const chunk of stream) {
        if (signal?.aborted) throw new Error('TIMEOUT');
        const delta = chunk?.choices?.[0]?.delta?.content;
        finishReason = chunk?.choices?.[0]?.finish_reason ?? finishReason;
        if (delta) { text += delta; onDelta(delta); }
      }
    } catch (err) {
      if (text) {
        console.log(`[OPENROUTER] stream interrupted after ${text.length} chars model=${modelId}: ${err.message}`);
        return { text, truncated: true, finishReason: 'interrupted', streamed: true };
      }
      if (signal?.aborted || err.name === 'AbortError' || err.message === 'TIMEOUT') throw new Error('TIMEOUT');
      lastError = err;
      continue;
    }

    if (!text.trim()) { lastError = new Error(`OpenRouter: model ${modelId} stream returned empty response`); continue; }

    const truncated = capTokens && finishReason === 'length';
    return { text, truncated: !!truncated, finishReason: truncated ? 'length' : (finishReason ?? 'stop'), streamed: true };
  }

  throw lastError ?? new Error('All OpenRouter stream attempts exhausted');
}
