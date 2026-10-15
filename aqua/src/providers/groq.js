/**
 * Groq Provider v3
 *
 * Changes from v2:
 * - Model ID no longer hardcoded — pulled from the central Model Registry
 *   (Issue 5). llama-3.3-70b-versatile and llama-3.1-8b-instant (the old
 *   hardcoded defaults) were decommissioned by Groq on 2026-08-16; registry
 *   now defaults to openai/gpt-oss-120b (Groq's own recommended replacement
 *   — also faster and cheaper), with openai/gpt-oss-20b as the sole ordered
 *   fallback. No Llama model is registered for Groq anymore.
 * - Added a per-request fallback loop across those candidate models
 *   (Issue 4/12): a single dead/rate-limited model no longer fails the
 *   whole Groq call — only exhausting every candidate does.
 * - TRUNCATED_MAX_TOKENS is no longer thrown (Issue 1). Hitting the output
 *   cap is a successful completion — returns { text, truncated: true,
 *   finishReason: 'length' } so it's never counted as a provider failure.
 * - Shared error classifier (providerErrors.js, Issue 4) replaces the
 *   inline status checks.
 *
 * Preserved from v2:
 * - Client cached per key (HTTP connection reuse).
 * - signal.aborted check before starting each race.
 * - Key rotation skips cooled keys — now via the shared key pool (keyPool.cjs):
 *   GROQ_API_KEY_1..N + GROQ_API_KEY, per-(key, model) 429 cooldowns, the
 *   same request retried on the next key, 401/403 quarantine.
 */

import Groq from 'groq-sdk';
import { getCandidateModels, markModelWorking, pinCandidates } from './modelRegistry.js';
import { rotate, keyPoolFor, raceAbort } from './keyRotation.js';
import { recordProviderCall } from '../core/costAccounting.js';

/** E12: every successful call is counted (tokens always; USD only when priced). */
function countedCall(provider, purpose, res) {
  try { recordProviderCall({ provider, model: res.model ?? null, usage: res.usage ?? null, purpose: purpose ?? 'other' }); } catch { /* observability never fails a call */ }
  return res;
}

/** Normalize Groq/OpenAI-compatible usage metadata for E12 cost accounting. */
export function normalizeUsage(usage) {
  const inputTokens = Number(usage?.prompt_tokens ?? usage?.promptTokens);
  const outputTokens = Number(usage?.completion_tokens ?? usage?.completionTokens);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return null;
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
  };
}

// ── Key pool (shared — keyPool.cjs) ───────────────────────────────────────────
// GROQ_API_KEY_1..N (any N) + the bare GROQ_API_KEY, deduped, blanks ignored.
// A 429 cools that key FOR THAT MODEL (Groq meters per organisation per model)
// and the same request retries on the next key; 401/403 quarantines the key.

const pool = keyPoolFor('groq');
const clientCache = new Map();

/** Startup validation (Issue 6) — does this provider have any usable key at all? */
export function hasConfiguredKeys() {
  return pool.hasKeys();
}

/**
 * Milliseconds until at least one key is usable again.
 *
 * 0 when a key is free now, null when none are configured (or all are
 * rejected). Exposed for the E6 shadow harness: a rate limit is a WAIT, not a
 * failure — the provider states exactly how long — and the harness was
 * treating the two the same, losing a whole run to cooldowns it could have
 * slept through. With `model`, the wait for that model specifically.
 */
export function msUntilAnyKeyFree(model = null) {
  return pool.msUntilAvailable(model);
}

let clientFactory = key => new Groq({
  apiKey: key,
  // Retries are OURS: the SDK's built-in retry re-sends a 429 on the SAME
  // throttled key (sleeping through Retry-After inside the router's budget)
  // instead of rotating to the next key.
  maxRetries: 0,
});

function getClient(key) {
  if (!clientCache.has(key)) clientCache.set(key, clientFactory(key));
  return clientCache.get(key);
}

const timeoutError = () => new Error('TIMEOUT');

function chatMessagesOf(systemPrompt, messages) {
  return [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];
}

function candidatesFor(opts) {
  const candidates = pinCandidates(getCandidateModels('groq'), opts.model ?? null, 'groq');
  if (!candidates.length) throw Object.assign(new Error('No Groq models currently available (cooling down or deprecated)'), { code: 'NO_CANDIDATE_MODELS' });
  return candidates;
}

/**
 * @param {string} systemPrompt
 * @param {Array<{role:string,content:string}>} messages
 * @param {AbortSignal} [signal]
 * @param {number} [maxTokens] - Phase 6 Response Budgeting: caps output length.
 *   Clamped against the registry's maxOutputTokens for whichever model is
 *   actually selected.
 * @returns {Promise<{ text: string, truncated: boolean, finishReason: string }>}
 */
/**
 * @param {object} [opts] E6/PR-5b — additive, and inert when omitted.
 *   `opts.model`       pin to exactly this model, or throw
 *                      MODEL_PIN_UNAVAILABLE. Never silently substituted.
 *   `opts.temperature` sent only when supplied, so an omitted value leaves
 *                      the request bytes identical to before this change.
 *   `opts.purpose`     cost/usage bucket.
 *   The return gains `model` (which model answered) and `keySlot` (which key
 *   slot — the label, never the key). Additive: every existing caller
 *   destructures { text, truncated, finishReason }.
 */
export async function generateGroq(systemPrompt, messages, signal, maxTokens, opts = {}) {
  if (signal?.aborted) throw timeoutError();
  const candidates = candidatesFor(opts);
  const chatMessages = chatMessagesOf(systemPrompt, messages);

  const res = await rotate('groq', {
    models: candidates, signal, purpose: opts?.purpose ?? 'other',
    attempt: async ({ key, modelId, model }) => {
      const capTokens = maxTokens ? Math.min(maxTokens, model.maxOutputTokens) : maxTokens;
      const req = getClient(key).chat.completions.create({
        model:    modelId,
        messages: chatMessages,
        ...(capTokens ? { max_tokens: capTokens } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      });
      // Demo-stability fix (kept): a lost race leaves `req` running detached; a
      // late rejection must not become a fatal unhandled rejection.
      const result = await raceAbort(req, signal);

      const finishReason = result?.choices?.[0]?.finish_reason;
      const text = result?.choices?.[0]?.message?.content;

      // ── Issue 1: hitting the output-token cap is SUCCESS, not failure ──
      if (capTokens && finishReason === 'length') {
        if (!text || !text.trim()) throw Object.assign(new Error('Groq returned empty truncated response'), { code: 'INVALID_RESPONSE' });
        console.log(`[GROQ] model=${modelId} hit maxTokens=${capTokens} cap — returning partial as successful completion`);
        return { text, truncated: true, finishReason: 'length', model: modelId, usage: normalizeUsage(result?.usage) };
      }
      if (!text) throw Object.assign(new Error('Groq returned empty response'), { code: 'INVALID_RESPONSE' });
      return { text, truncated: false, finishReason: finishReason ?? 'stop', model: modelId, usage: normalizeUsage(result?.usage) };
    },
  });

  markModelWorking('groq', res.model);
  return countedCall('groq', opts?.purpose, res);
}

/**
 * Streaming variant (Day 3 — Real Streaming).
 *
 * Same key rotation / model-registry fallback semantics as generateGroq,
 * with one hard rule: key/model fallback only happens BEFORE the first
 * delta reaches onDelta. Once a single token has been emitted the client
 * has already seen it — a mid-stream failure is surfaced as an
 * interrupted-partial result (never silently retried on another key or
 * model, which would restart the answer under the user's cursor).
 *
 * @param {string} systemPrompt
 * @param {Array<{role:string,content:string}>} messages
 * @param {AbortSignal} [signal]      - abort = TIMEOUT (router budget) or client cancel
 * @param {number} [maxTokens]
 * @param {(delta: string) => void} onDelta - called per content token
 * @returns {Promise<{ text:string, truncated:boolean, finishReason:string, streamed:true }>}
 */
export async function streamGroq(systemPrompt, messages, signal, maxTokens, onDelta) {
  if (signal?.aborted) throw timeoutError();
  const candidates = getCandidateModels('groq');
  if (!candidates.length) throw Object.assign(new Error('No Groq models currently available (cooling down or deprecated)'), { code: 'NO_CANDIDATE_MODELS' });
  const chatMessages = chatMessagesOf(systemPrompt, messages);
  const purpose = 'chat';

  const res = await rotate('groq', {
    models: candidates, signal, label: 'stream ', purpose,
    attempt: async ({ key, modelId, model }) => {
      const capTokens = maxTokens ? Math.min(maxTokens, model.maxOutputTokens) : maxTokens;
      const started = Date.now();
      const stream = await getClient(key).chat.completions.create(
        {
          model:    modelId,
          messages: chatMessages,
          stream:   true,
          stream_options: { include_usage: true },
          ...(capTokens ? { max_tokens: capTokens } : {}),
        },
        { signal }, // SDK aborts the underlying request when the router/client cancels
      );

      let text = '';
      let finishReason = null;
      let usage = null;
      let ttftMs = null;
      try {
        for await (const chunk of stream) {
          if (signal?.aborted) throw timeoutError();
          const delta = chunk?.choices?.[0]?.delta?.content;
          finishReason = chunk?.choices?.[0]?.finish_reason ?? finishReason;
          usage = normalizeUsage(chunk?.usage) ?? usage;
          if (delta) {
            if (ttftMs == null) ttftMs = Date.now() - started;
            text += delta; onDelta(delta);
          }
        }
      } catch (err) {
        // Mid-stream failure: the client already saw `text` — the partial IS
        // the answer; never restarted on another key/model.
        if (text) {
          console.log(`[GROQ] stream interrupted after ${text.length} chars model=${modelId}: ${err.message}`);
          throw Object.assign(new Error('STREAM_INTERRUPTED'), {
            partial: { text, truncated: true, finishReason: 'interrupted', streamed: true, model: modelId, usage },
          });
        }
        if (signal?.aborted || err.name === 'AbortError') throw timeoutError();
        throw err; // nothing emitted yet — safe to try the next key/model
      }

      if (!text.trim()) throw Object.assign(new Error('Groq stream returned empty response'), { code: 'INVALID_RESPONSE' });
      const truncated = capTokens && finishReason === 'length';
      return { text, truncated: !!truncated, finishReason: truncated ? 'length' : (finishReason ?? 'stop'), streamed: true, model: modelId, usage, ttftMs };
    },
  });

  // An interrupted partial is returned uncounted (unchanged contract).
  if (res.finishReason === 'interrupted') return res;
  markModelWorking('groq', res.model);
  return countedCall('groq', purpose, res);
}

/** Test-only: swap the SDK client factory (fake transport) and clear caches. */
export function __setClientFactoryForTests(fn) {
  clientFactory = fn ?? (key => new Groq({ apiKey: key, maxRetries: 0 }));
  clientCache.clear();
}

/** Test-only: forget key cooldowns/quarantine and cached clients. */
export function __resetForTests() {
  pool.resetCredentials();
  clientCache.clear();
}
