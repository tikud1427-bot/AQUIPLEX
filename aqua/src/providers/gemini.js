/**
 * Gemini Provider v3
 *
 * Changes from v2:
 * - Model ID no longer hardcoded inline — pulled from the central Model
 *   Registry (src/providers/modelRegistry.js, Issue 5). Registry lists a
 *   primary + fallback model; a dead primary now falls through to the
 *   fallback WITHIN this call instead of failing the whole provider.
 * - TRUNCATED_MAX_TOKENS is no longer thrown as an error (Issue 1). Hitting
 *   the output-token cap is a SUCCESSFUL completion that ran out of budget,
 *   not a failure: this now returns { text, truncated: true,
 *   finishReason: 'length' } so router.js can mark the provider healthy,
 *   skip the fallback chain, and hand the partial answer straight back.
 * - Shared error classifier (providerErrors.js, Issue 4) replaces the
 *   ad-hoc status checks — 404/model-not-found is scoped to the specific
 *   model (registry), never to the provider's health.
 *
 * Preserved from v2:
 * - Timeout is set by the router via timeoutManager (task-aware: 8-65s);
 *   this file only respects the signal passed in.
 * - GoogleGenAI client instances cached per API key (HTTP connection reuse).
 * - Key selection skips cooled keys — now the shared key pool (keyPool.cjs):
 *   GEMINI_KEY_1..N (any N) + GEMINI_API_KEY + legacy Gemini_API_Key.
 */

import { GoogleGenAI } from '@google/genai';
import { getCandidateModels, markModelWorking, pinCandidates } from './modelRegistry.js';
import { rotate, keyPoolFor, raceAbort } from './keyRotation.js';
import { recordProviderCall } from '../core/costAccounting.js';

/** E12: every successful call is counted (tokens always; USD only when priced). */
function countedCall(provider, purpose, res) {
  try { recordProviderCall({ provider, model: res.model ?? null, usage: res.usage ?? null, purpose: purpose ?? 'other' }); } catch { /* observability never fails a call */ }
  return res;
}


function normalizeUsage(usage) {
  const inputTokens = Number(usage?.promptTokenCount ?? usage?.promptTokens);
  const outputTokens = Number(usage?.candidatesTokenCount ?? usage?.completionTokens ?? usage?.candidatesTokenCount);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return null;
  return { inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0, outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0 };
}

// ── Key management (shared — keyPool.cjs) ─────────────────────────────────────
// GEMINI_KEY_1..N (any N — slots 9..12 and beyond are discovered, nothing is
// hard-coded) + GEMINI_API_KEY (#bare) + legacy Gemini_API_Key (#legacy),
// deduped, blanks ignored. The SAME pool feeds embeddings
// (embeddings/embeddingProvider.js) and the platform client.
//
// 429 cools the key FOR THAT MODEL (Google meters quota per project per
// model; another model may still have quota), Retry-After / RetryInfo
// honoured; 401/403 and Google's 400 API_KEY_INVALID quarantine the key.
// Keys from ONE Google project share that project's quota: rotating among
// them buys request spreading, not more quota.

const pool = keyPoolFor('gemini');

/** Startup validation (Issue 6) — does this provider have any configured credential at all? */
export function hasConfiguredKeys() {
  return pool.hasKeys();
}

/** Milliseconds until some key can serve `model` (0 = now; null = none configured / all rejected). */
export function msUntilAnyKeyFree(model = null) {
  return pool.msUntilAvailable(model);
}

// Cache clients per key — avoids creating new HTTP agents on every request
const clientCache = new Map();
let clientFactory = key => new GoogleGenAI({ apiKey: key });

function getClient(key) {
  if (!clientCache.has(key)) clientCache.set(key, clientFactory(key));
  return clientCache.get(key);
}

const timeoutError = () => new Error('TIMEOUT');

function candidatesOrThrow(list) {
  if (!list.length) throw Object.assign(new Error('No Gemini models currently available (cooling down or deprecated)'), { code: 'NO_CANDIDATE_MODELS' });
  return list;
}

function noKeys(detail = '') {
  return Object.assign(new Error(`No Gemini keys configured${detail}`), { code: 'NO_KEYS' });
}

// ── Message format ────────────────────────────────────────────────────────────

function toContents(messages) {
  return messages.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

// ── Generate ──────────────────────────────────────────────────────────────────

/**
 * @param {string} systemPrompt
 * @param {Array<{role:string,content:string}>} messages
 * @param {AbortSignal} [signal]  — fired by router's timedAbort (task-aware)
 * @param {number} [maxTokens] - Phase 6 Response Budgeting: caps output length.
 *   Clamped against the registry's maxOutputTokens for whichever model is
 *   actually selected. Omitted entirely → field is not sent to the API.
 * @returns {Promise<{ text: string, truncated: boolean, finishReason: string }>}
 */
/**
 * @param {object} [opts] E6/PR-5b — additive, and inert when omitted.
 *   `opts.model`       pin to exactly this model, or throw
 *                      MODEL_PIN_UNAVAILABLE. Never silently substituted.
 *   `opts.temperature` sent only when supplied, so an omitted value leaves
 *                      the request bytes identical to before this change.
 *   `opts.purpose`     cost/usage bucket.
 *   The return gains `model` (which model answered) and `keySlot` (the slot
 *   label, never the key). Additive: every existing caller destructures
 *   { text, truncated, finishReason }.
 */
export async function generateGemini(systemPrompt, messages, signal, maxTokens, opts = {}) {
  if (!pool.hasKeys()) throw noKeys();
  const candidates = candidatesOrThrow(pinCandidates(getCandidateModels('gemini'), opts.model ?? null, 'gemini'));

  const res = await rotate('gemini', {
    models: candidates, signal, purpose: opts?.purpose ?? 'other',
    attempt: async ({ key, modelId, model }) => {
      const capTokens = maxTokens ? Math.min(maxTokens, model.maxOutputTokens) : maxTokens;
      const req = getClient(key).models.generateContent({
        model:    modelId,
        contents: toContents(messages),
        ...((systemPrompt || capTokens) ? {
          config: {
            ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
            ...(capTokens ? { maxOutputTokens: capTokens } : {}),
            ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          },
        } : {}),
      });
      // Demo-stability fix (kept): a lost race must not leave an unhandled rejection.
      const result = await raceAbort(req, signal);

      const finishReason = result.candidates?.[0]?.finishReason;
      const text = result.text ?? '';
      const usage = normalizeUsage(result?.usageMetadata);

      // ── Issue 1: hitting the output-token cap is SUCCESS, not failure ──
      if (capTokens && finishReason === 'MAX_TOKENS') {
        if (!text.trim()) throw new Error('INVALID_RESPONSE'); // nothing usable came back — genuine failure
        console.log(`[GEMINI] model=${modelId} hit maxTokens=${capTokens} cap — returning partial as successful completion`);
        return { text, truncated: true, finishReason: 'length', model: modelId, usage };
      }
      if (!text) throw new Error('INVALID_RESPONSE');
      return { text, truncated: false, finishReason: 'stop', model: modelId, usage };
    },
  });

  markModelWorking('gemini', res.model);
  console.log(`[GEMINI] model=${res.model} success key=${res.keySlot}`);
  return countedCall('gemini', opts?.purpose, res);
}

/**
 * Streaming variant (Day 3 — Real Streaming).
 *
 * Same key rotation + model-registry fallback as generateGemini, with the
 * streaming rule: fallback only BEFORE the first emitted delta. Mid-stream
 * failures return the partial as finishReason='interrupted' — the client
 * has already rendered those tokens.
 *
 * @param {(delta: string) => void} onDelta
 * @returns {Promise<{ text:string, truncated:boolean, finishReason:string, streamed:true }>}
 */
export async function streamGemini(systemPrompt, messages, signal, maxTokens, onDelta) {
  if (!pool.hasKeys()) throw noKeys();
  const candidates = candidatesOrThrow(getCandidateModels('gemini'));
  const purpose = 'chat';

  const res = await rotate('gemini', {
    models: candidates, signal, label: 'stream ', purpose,
    attempt: async ({ key, modelId, model }) => {
      const capTokens = maxTokens ? Math.min(maxTokens, model.maxOutputTokens) : maxTokens;
      const started = Date.now();
      let stream;
      try {
        stream = await getClient(key).models.generateContentStream({
          model:    modelId,
          contents: toContents(messages),
          config: {
            ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
            ...(capTokens ? { maxOutputTokens: capTokens } : {}),
            abortSignal: signal, // SDK cancels the HTTP request on abort
          },
        });
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
          const delta = chunk?.text ?? '';
          finishReason = chunk?.candidates?.[0]?.finishReason ?? finishReason;
          usage = normalizeUsage(chunk?.usageMetadata) ?? usage;
          if (delta) {
            if (ttftMs == null) ttftMs = Date.now() - started;
            text += delta; onDelta(delta);
          }
        }
      } catch (err) {
        if (text) {
          console.log(`[GEMINI] stream interrupted after ${text.length} chars model=${modelId}: ${err.message}`);
          throw Object.assign(new Error('STREAM_INTERRUPTED'), {
            partial: { text, truncated: true, finishReason: 'interrupted', streamed: true, model: modelId, usage },
          });
        }
        if (signal?.aborted || err.name === 'AbortError' || err.message === 'TIMEOUT') throw timeoutError();
        throw err; // nothing emitted — safe to retry with next key/model
      }

      if (!text.trim()) throw Object.assign(new Error('Gemini stream returned empty response'), { code: 'INVALID_RESPONSE' });
      const truncated = capTokens && finishReason === 'MAX_TOKENS';
      return { text, truncated: !!truncated, finishReason: truncated ? 'length' : 'stop', streamed: true, model: modelId, usage, ttftMs };
    },
  });

  if (res.finishReason === 'interrupted') return res; // uncounted (unchanged contract)
  markModelWorking('gemini', res.model);
  return countedCall('gemini', purpose, res);
}

// ── Multimodal (Day 5 — Universal Upload) ─────────────────────────────────────
//
// Image / audio / video understanding for the unified upload pipeline
// (src/upload/mediaPipeline.js, documentPipeline.js OCR). Reuses this file's
// key pool, cooldowns, client cache, and error classification — no parallel
// key-management stack.
//
// parts: Gemini content parts, e.g.
//   [{ inlineData: { mimeType: 'image/png', data: '<base64>' } }, { text: 'Describe…' }]

export async function analyzeMediaWithGemini(parts, { systemPrompt, maxTokens = 2048, signal } = {}) {
  if (!pool.hasKeys()) throw noKeys(' — media analysis unavailable');
  const candidates = candidatesOrThrow(getCandidateModels('gemini'));

  const res = await rotate('gemini', {
    models: candidates, signal, label: 'media ', purpose: 'other',
    attempt: async ({ key, modelId, model }) => {
      const req = getClient(key).models.generateContent({
        model:    modelId,
        contents: [{ role: 'user', parts }],
        config: {
          ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
          maxOutputTokens: Math.min(maxTokens, model.maxOutputTokens ?? maxTokens),
        },
      });
      let result;
      try { result = await raceAbort(req, signal); } catch (err) {
        if (signal?.aborted || err.name === 'AbortError') throw timeoutError();
        throw err;
      }
      const text = result.text ?? '';
      if (!text.trim()) throw Object.assign(new Error('Gemini returned empty media analysis'), { code: 'INVALID_RESPONSE' });
      return { text: text.trim(), model: modelId, usage: normalizeUsage(result?.usageMetadata) };
    },
  });

  markModelWorking('gemini', res.model);
  // Return shape unchanged for the upload pipelines: { text, model } (+ keySlot).
  return countedCall('gemini', 'other', { text: res.text, model: res.model, keySlot: res.keySlot, usage: res.usage });
}

/** Test-only: swap the SDK client factory (fake transport) and clear caches. */
export function __setClientFactoryForTests(fn) {
  clientFactory = fn ?? (key => new GoogleGenAI({ apiKey: key }));
  clientCache.clear();
}

/** Test-only: forget key cooldowns/quarantine and cached clients. */
export function __resetForTests() {
  pool.resetCredentials();
  clientCache.clear();
}
