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
 * - nextKey() loops all keys looking for a non-cooled one.
 */

import { GoogleGenAI } from '@google/genai';
import {
  getCandidateModels, markModelWorking, markModelUnavailable, markModelTempFailed,
} from './modelRegistry.js';
import { classifyProviderError, retryAfterMs } from './providerErrors.js';

// ── Key management ────────────────────────────────────────────────────────────

function getKeys() {
  return [
    process.env.GEMINI_KEY_1,
    process.env.GEMINI_KEY_2,
    process.env.GEMINI_KEY_3,
    process.env.GEMINI_KEY_4,
    process.env.GEMINI_KEY_5,
    process.env.GEMINI_KEY_6,
    process.env.GEMINI_KEY_7,
    process.env.GEMINI_KEY_8,
  ].filter(Boolean);
}

/** Startup validation (Issue 6) — does this provider have any usable key at all? */
export function hasConfiguredKeys() {
  return getKeys().length > 0;
}

let keyIndex = 0;
const keyCooldowns = new Map();

// Cache clients per key — avoids creating new HTTP agents on every request
const clientCache = new Map();

function getClient(key) {
  if (!clientCache.has(key)) {
    clientCache.set(key, new GoogleGenAI({ apiKey: key }));
  }
  return clientCache.get(key);
}

function onCooldown(key) {
  const until = keyCooldowns.get(key);
  return until ? Date.now() < until : false;
}

function applyCooldown(key, ms) {
  keyCooldowns.set(key, Date.now() + ms);
}

/**
 * Pick next non-cooled key, cycling through all available.
 * Throws if all keys are on cooldown.
 */
function nextKey() {
  const keys = getKeys();
  if (!keys.length) throw new Error('No Gemini keys configured');

  for (let i = 0; i < keys.length; i++) {
    const k = keys[keyIndex];
    keyIndex = (keyIndex + 1) % keys.length;
    if (!onCooldown(k)) return k;
  }
  throw new Error('All Gemini keys on cooldown');
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
export async function generateGemini(systemPrompt, messages, signal, maxTokens) {
  const keys = getKeys();
  if (!keys.length) throw new Error('No Gemini keys configured');

  const candidates = getCandidateModels('gemini');
  if (!candidates.length) throw Object.assign(new Error('No Gemini models currently available (cooling down or deprecated)'), { code: 'NO_CANDIDATE_MODELS' });

  let lastError;

  for (const modelEntry of candidates) {
    const modelId  = modelEntry.modelId;
    const capTokens = maxTokens ? Math.min(maxTokens, modelEntry.maxOutputTokens) : maxTokens;
    const maxAttempts = Math.min(keys.length, 3);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Bail immediately if caller already aborted
      if (signal?.aborted) {
        throw new Error('TIMEOUT');
      }

      let key;
      try {
        key = nextKey();
      } catch (e) {
        lastError = e;
        break; // all keys cooled — no point trying this model further
      }

      try {
        console.log(`[GEMINI] model=${modelId} attempt=${attempt + 1}/${maxAttempts} key=...${key.slice(-4)}`);

        const ai  = getClient(key);
        const req = ai.models.generateContent({
          model:    modelId,
          contents: toContents(messages),
          ...((systemPrompt || capTokens) ? {
            config: {
              ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
              ...(capTokens ? { maxOutputTokens: capTokens } : {}),
            },
          } : {}),
        });
        // Demo-stability fix: a lost Promise.race leaves `req` running
        // detached; a late rejection would be an unhandled rejection —
        // fatal on modern Node — crashing the server mid-request. No-op
        // handler marks it handled; race path unaffected. (Same fix in
        // groq.js / openrouter.js.)
        Promise.resolve(req).catch(() => {});

        const result = signal
          ? await Promise.race([
              req,
              new Promise((_, rej) => {
                if (signal.aborted) return rej(new Error('TIMEOUT'));
                signal.addEventListener('abort', () => rej(new Error('TIMEOUT')), { once: true });
              }),
            ])
          : await req;

        const finishReason = result.candidates?.[0]?.finishReason;
        const text = result.text ?? '';

        // ── Issue 1: hitting the output-token cap is SUCCESS, not failure ──
        if (capTokens && finishReason === 'MAX_TOKENS') {
          if (!text.trim()) throw new Error('INVALID_RESPONSE'); // nothing usable came back — genuine failure
          console.log(`[GEMINI] model=${modelId} hit maxTokens=${capTokens} cap — returning partial as successful completion`);
          markModelWorking('gemini', modelId);
          return { text, truncated: true, finishReason: 'length' };
        }

        if (!text) throw new Error('INVALID_RESPONSE');

        markModelWorking('gemini', modelId);
        console.log(`[GEMINI] model=${modelId} success key=...${key.slice(-4)}`);
        return { text, truncated: false, finishReason: 'stop' };

      } catch (err) {
        // TIMEOUT comes from our AbortController — propagate immediately,
        // no point trying another key/model, the router's budget is spent.
        if (err.message === 'TIMEOUT') {
          console.log(`[GEMINI] TIMEOUT key=...${key?.slice(-4)} model=${modelId} (budget exhausted for this task)`);
          throw err;
        }

        lastError = err;
        const { type, status } = classifyProviderError(err);

        if (type === 'model_not_found') {
          markModelUnavailable('gemini', modelId, `${status ?? ''} ${err.message}`.trim());
          break; // permanent — try next candidate model
        }
        if (type === 'model_unavailable') {
          markModelTempFailed('gemini', modelId, 60_000); // TRANSIENT capacity — self-heals
          break; // try next candidate model this call
        }
        if (type === 'rate_limit') {
          const cd = retryAfterMs(err) ?? 120_000;
          console.log(`[GEMINI] key=...${key.slice(-4)} rate limited → ${(cd / 1000) | 0}s cooldown`);
          applyCooldown(key, cd);
          continue;
        }
        if (type === 'server_error') {
          const cd = retryAfterMs(err) ?? 60_000;
          console.log(`[GEMINI] key=...${key.slice(-4)} service unavailable → ${(cd / 1000) | 0}s cooldown`);
          applyCooldown(key, cd);
          continue;
        }
        if (type === 'auth') {
          console.log(`[GEMINI] key=...${key.slice(-4)} auth error → 24h cooldown`);
          applyCooldown(key, 86_400_000);
          continue;
        }

        // invalid_response / network / unknown — log and retry with next key
        console.log(`[GEMINI] model=${modelId} attempt ${attempt + 1} error type=${type} status=${status} msg=${err.message}`);
      }
    }
    // exhausted every key for this model — fall through to next candidate model
  }

  throw lastError ?? new Error('All Gemini attempts exhausted');
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
  const keys = getKeys();
  if (!keys.length) throw new Error('No Gemini keys configured');

  const candidates = getCandidateModels('gemini');
  if (!candidates.length) throw Object.assign(new Error('No Gemini models currently available (cooling down or deprecated)'), { code: 'NO_CANDIDATE_MODELS' });

  let lastError;

  for (const modelEntry of candidates) {
    const modelId   = modelEntry.modelId;
    const capTokens = maxTokens ? Math.min(maxTokens, modelEntry.maxOutputTokens) : maxTokens;
    const maxAttempts = Math.min(keys.length, 3);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) throw new Error('TIMEOUT');

      let key;
      try { key = nextKey(); } catch (e) { lastError = e; break; }

      let stream;
      try {
        console.log(`[GEMINI] stream model=${modelId} attempt=${attempt + 1}/${maxAttempts} key=...${key.slice(-4)}`);
        const ai = getClient(key);
        stream = await ai.models.generateContentStream({
          model:    modelId,
          contents: toContents(messages),
          config: {
            ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
            ...(capTokens ? { maxOutputTokens: capTokens } : {}),
            abortSignal: signal, // SDK cancels the HTTP request on abort
          },
        });
      } catch (err) {
        if (signal?.aborted || err.name === 'AbortError') throw new Error('TIMEOUT');
        lastError = err;
        const { type, status } = classifyProviderError(err);
        if (type === 'model_not_found')   { markModelUnavailable('gemini', modelId, `${status ?? ''} ${err.message}`.trim()); break; }
        if (type === 'model_unavailable') { markModelTempFailed('gemini', modelId, 60_000); break; }
        if (type === 'rate_limit')        { applyCooldown(key, retryAfterMs(err) ?? 120_000);   continue; }
        if (type === 'server_error')      { applyCooldown(key, retryAfterMs(err) ?? 60_000);    continue; }
        if (type === 'auth')              { applyCooldown(key, 86_400_000); continue; }
        console.log(`[GEMINI] stream open failed model=${modelId} type=${type} msg=${err.message}`);
        continue;
      }

      let text = '';
      let finishReason = null;
      try {
        for await (const chunk of stream) {
          if (signal?.aborted) throw new Error('TIMEOUT');
          const delta = chunk?.text ?? '';
          finishReason = chunk?.candidates?.[0]?.finishReason ?? finishReason;
          if (delta) { text += delta; onDelta(delta); }
        }
      } catch (err) {
        if (text) {
          console.log(`[GEMINI] stream interrupted after ${text.length} chars model=${modelId}: ${err.message}`);
          return { text, truncated: true, finishReason: 'interrupted', streamed: true };
        }
        if (signal?.aborted || err.name === 'AbortError' || err.message === 'TIMEOUT') throw new Error('TIMEOUT');
        lastError = err;
        continue; // nothing emitted — safe to retry with next key
      }

      if (!text.trim()) { lastError = new Error('Gemini stream returned empty response'); continue; }

      markModelWorking('gemini', modelId);
      const truncated = capTokens && finishReason === 'MAX_TOKENS';
      return { text, truncated: !!truncated, finishReason: truncated ? 'length' : 'stop', streamed: true };
    }
  }

  throw lastError ?? new Error('All Gemini stream attempts exhausted');
}

// ── Multimodal (Day 5 — Universal Upload) ─────────────────────────────────────
//
// Image / audio / video understanding for the unified upload pipeline
// (src/upload/mediaPipeline.js). Reuses this file's key rotation, cooldowns,
// client cache, and error classification — no parallel key-management stack.
//
// parts: Gemini content parts, e.g.
//   [{ inlineData: { mimeType: 'image/png', data: '<base64>' } }, { text: 'Describe…' }]

export async function analyzeMediaWithGemini(parts, { systemPrompt, maxTokens = 2048, signal } = {}) {
  const keys = getKeys();
  if (!keys.length) throw new Error('No Gemini keys configured — media analysis unavailable');

  const candidates = getCandidateModels('gemini');
  if (!candidates.length) throw Object.assign(new Error('No Gemini models currently available (cooling down or deprecated)'), { code: 'NO_CANDIDATE_MODELS' });

  let lastError;

  for (const modelEntry of candidates) {
    const modelId = modelEntry.modelId;
    const maxAttempts = Math.min(keys.length, 3);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) throw new Error('TIMEOUT');

      let key;
      try { key = nextKey(); } catch (e) { lastError = e; break; }

      try {
        console.log(`[GEMINI] media model=${modelId} attempt=${attempt + 1}/${maxAttempts} key=...${key.slice(-4)}`);
        const ai = getClient(key);
        const req = ai.models.generateContent({
          model:    modelId,
          contents: [{ role: 'user', parts }],
          config: {
            ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
            maxOutputTokens: Math.min(maxTokens, modelEntry.maxOutputTokens ?? maxTokens),
          },
        });
        Promise.resolve(req).catch(() => {}); // mark handled (same race-leak fix as generateGemini)

        const result = signal
          ? await Promise.race([
              req,
              new Promise((_, rej) => {
                if (signal.aborted) return rej(new Error('TIMEOUT'));
                signal.addEventListener('abort', () => rej(new Error('TIMEOUT')), { once: true });
              }),
            ])
          : await req;

        const text = result.text ?? '';
        if (!text.trim()) { lastError = new Error('Gemini returned empty media analysis'); continue; }

        markModelWorking('gemini', modelId);
        return { text: text.trim(), model: modelId };
      } catch (err) {
        if (signal?.aborted || err.name === 'AbortError') throw new Error('TIMEOUT');
        lastError = err;
        const { type, status } = classifyProviderError(err);
        if (type === 'model_not_found')   { markModelUnavailable('gemini', modelId, `${status ?? ''} ${err.message}`.trim()); break; }
        if (type === 'model_unavailable') { markModelTempFailed('gemini', modelId, 60_000); break; }
        if (type === 'rate_limit')        { applyCooldown(key, retryAfterMs(err) ?? 120_000);    continue; }
        if (type === 'server_error')      { applyCooldown(key, retryAfterMs(err) ?? 60_000);     continue; }
        if (type === 'auth')              { applyCooldown(key, 86_400_000); continue; }
        console.log(`[GEMINI] media analysis failed model=${modelId} type=${type} msg=${err.message}`);
        continue;
      }
    }
  }

  throw lastError ?? new Error('All Gemini media analysis attempts exhausted');
}
