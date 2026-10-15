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
 *   - Key pool (2026-10-15): keys now rotate through the shared pool
 *     (keyPool.cjs). A refused/out-of-credit key or an ACCOUNT-scoped 429
 *     moves the same request to the next key instead of failing the
 *     provider; model-scoped failures keep the behaviour described above.
 *   - TRUNCATED_MAX_TOKENS is no longer thrown (Issue 1) — hitting the
 *     output cap returns { text, truncated: true, finishReason: 'length' }
 *     as a successful completion.
 */

import OpenAI from 'openai';
import { getCandidateModels, pinCandidates } from './modelRegistry.js';
import { rotate, keyPoolFor, raceAbort } from './keyRotation.js';
import { recordProviderCall } from '../core/costAccounting.js';

/** E12: every successful call is counted (tokens always; USD only when priced). */
function countedCall(provider, purpose, res) {
  try { recordProviderCall({ provider, model: res.model ?? null, usage: res.usage ?? null, purpose: purpose ?? 'other' }); } catch { /* observability never fails a call */ }
  return res;
}

// ── Key rotation (shared — keyPool.cjs) ────────────────────────────────────────
// OPENROUTER_API_KEY_1..N (any N) + the bare OPENROUTER_API_KEY, deduped.
// Which failures move to ANOTHER KEY (keyRotation.js policy):
//   401/403          the key is refused → quarantined, next key
//   402              that account's credits are spent → key cooldown, next key
//   429 key/account  "Rate limit exceeded: free-models-per-day" etc → key cooldown
//                    (X-RateLimit-Reset honoured), next key
// Which stay MODEL-scoped (unchanged): 404 not-found (permanent), "no
// endpoints" capacity (transient), 429 upstream saturation, 5xx.

const pool = keyPoolFor('openrouter');

/** Startup validation (Issue 6) — does this provider have any usable key at all? */
export function hasConfiguredKeys() {
  return pool.hasKeys();
}

const clientCache = new Map();

function getClient(key) {
  const url = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const cacheKey = `${url}\u0000${key}`;
  if (!clientCache.has(cacheKey)) {
    clientCache.set(cacheKey, new OpenAI({
      apiKey:  key,
      // Overridable for corporate proxies / gateways / integration tests.
      baseURL: url,
      // Retries are OURS: the SDK would re-send a 429 on the same key.
      maxRetries: 0,
    }));
  }
  return clientCache.get(cacheKey);
}

function normalizeUsage(usage) {
  const inputTokens = Number(usage?.prompt_tokens ?? usage?.promptTokens);
  const outputTokens = Number(usage?.completion_tokens ?? usage?.completionTokens);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return null;
  return { inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0, outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0 };
}

const timeoutError = () => new Error('TIMEOUT');
const emptyResponse = detail => Object.assign(new Error(`OpenRouter: ${detail}`), { code: 'INVALID_RESPONSE' });

function chatMessagesOf(systemPrompt, messages) {
  return [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];
}

// Bounded so a fully-degraded registry can't turn into an unbounded loop —
// never more models than this per call (pre-existing limit).
const MODEL_ATTEMPT_LIMIT = 5;

// ── Generate ───────────────────────────────────────────────────────────────────

/**
 * @param {string} systemPrompt
 * @param {Array<{role,content}>} messages
 * @param {AbortSignal} [signal]
 * @param {number} [maxTokens] - Phase 6 Response Budgeting: caps output length.
 *   Clamped per-model against the registry's maxOutputTokens.
 * @returns {Promise<{ text: string, truncated: boolean, finishReason: string }>}
 */
/**
 * @param {object} [opts] E6/PR-5b — additive, and inert when omitted.
 *   `opts.model`       pin to exactly this model, or throw
 *                      MODEL_PIN_UNAVAILABLE. Never silently substituted.
 *   `opts.temperature` sent only when supplied, so an omitted value leaves
 *                      the request bytes identical to before this change.
 *   `opts.purpose`     cost/usage bucket.
 *   The return gains `model` (which model answered) and `keySlot` (slot
 *   label, never the key). Additive.
 */
export async function generateOpenRouter(systemPrompt, messages, signal, maxTokens, opts = {}) {
  if (signal?.aborted) throw timeoutError();

  const candidates = pinCandidates(getCandidateModels('openrouter'), opts.model ?? null, 'openrouter');
  if (!candidates.length) throw Object.assign(new Error('No OpenRouter models currently available (cooling down or deprecated)'), { code: 'NO_CANDIDATE_MODELS' });
  const chatMessages = chatMessagesOf(systemPrompt, messages);

  const res = await rotate('openrouter', {
    models: candidates.slice(0, MODEL_ATTEMPT_LIMIT), signal, purpose: opts?.purpose ?? 'other',
    attempt: async ({ key, modelId, model }) => {
      const capTokens = maxTokens ? Math.min(maxTokens, model.maxOutputTokens) : maxTokens;
      const req = getClient(key).chat.completions.create({
        model:    modelId,
        messages: chatMessages,
        ...(capTokens ? { max_tokens: capTokens } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      });
      const result = await raceAbort(req, signal);

      const finishReason = result?.choices?.[0]?.finish_reason;
      const text = result?.choices?.[0]?.message?.content;

      // ── Issue 1: hitting the output-token cap is SUCCESS, not failure ──
      if (capTokens && finishReason === 'length') {
        if (!text || !text.trim()) throw emptyResponse(`model ${modelId} returned empty truncated response`);
        console.log(`[OPENROUTER] model=${modelId} hit maxTokens=${capTokens} cap — returning partial as successful completion`);
        return { text, truncated: true, finishReason: 'length', model: modelId, usage: normalizeUsage(result?.usage) };
      }
      if (!text) throw emptyResponse(`model ${modelId} returned empty response`);
      return { text, truncated: false, finishReason: finishReason ?? 'stop', model: modelId, usage: normalizeUsage(result?.usage) };
    },
  });

  return countedCall('openrouter', opts?.purpose, res);
}

/**
 * Streaming variant (Day 3 — Real Streaming).
 *
 * Same registry-driven model fallback and error scoping as
 * generateOpenRouter, with the streaming rule: key/model fallback only BEFORE
 * the first emitted delta; mid-stream failures return the partial as
 * finishReason='interrupted'.
 *
 * @param {(delta: string) => void} onDelta
 * @returns {Promise<{ text:string, truncated:boolean, finishReason:string, streamed:true }>}
 */
export async function streamOpenRouter(systemPrompt, messages, signal, maxTokens, onDelta) {
  if (signal?.aborted) throw timeoutError();

  const candidates = getCandidateModels('openrouter');
  if (!candidates.length) throw Object.assign(new Error('No OpenRouter models currently available (cooling down or deprecated)'), { code: 'NO_CANDIDATE_MODELS' });
  const chatMessages = chatMessagesOf(systemPrompt, messages);
  const purpose = 'chat';

  const res = await rotate('openrouter', {
    models: candidates.slice(0, MODEL_ATTEMPT_LIMIT), signal, label: 'stream ', purpose,
    attempt: async ({ key, modelId, model }) => {
      const capTokens = maxTokens ? Math.min(maxTokens, model.maxOutputTokens) : maxTokens;
      const started = Date.now();
      let stream;
      try {
        stream = await getClient(key).chat.completions.create(
          {
            model:    modelId,
            messages: chatMessages,
            stream:   true,
            stream_options: { include_usage: true },
            ...(capTokens ? { max_tokens: capTokens } : {}),
          },
          { signal },
        );
      } catch (err) {
        if (signal?.aborted || err.name === 'AbortError') throw timeoutError();
        throw err;
      }

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
        if (text) {
          console.log(`[OPENROUTER] stream interrupted after ${text.length} chars model=${modelId}: ${err.message}`);
          throw Object.assign(new Error('STREAM_INTERRUPTED'), {
            partial: { text, truncated: true, finishReason: 'interrupted', streamed: true, model: modelId, usage },
          });
        }
        if (signal?.aborted || err.name === 'AbortError' || err.message === 'TIMEOUT') throw timeoutError();
        throw err;
      }

      if (!text.trim()) throw emptyResponse(`model ${modelId} stream returned empty response`);
      const truncated = capTokens && finishReason === 'length';
      return { text, truncated: !!truncated, finishReason: truncated ? 'length' : (finishReason ?? 'stop'), streamed: true, model: modelId, usage, ttftMs };
    },
  });

  if (res.finishReason === 'interrupted') return res; // uncounted (unchanged contract)
  return countedCall('openrouter', purpose, res);
}

/** Test-only: forget key cooldowns/quarantine and cached clients. */
export function __resetForTests() {
  pool.resetCredentials();
  clientCache.clear();
}
