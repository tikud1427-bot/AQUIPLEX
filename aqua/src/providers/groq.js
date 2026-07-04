/**
 * Groq Provider v3
 *
 * Changes from v2:
 * - Model ID no longer hardcoded — pulled from the central Model Registry
 *   (Issue 5). llama-3.3-70b-versatile (the old hardcoded default) was
 *   announced deprecated by Groq on 2026-06-17; registry now defaults to
 *   openai/gpt-oss-120b (Groq's own recommended replacement — also faster
 *   and cheaper), with openai/gpt-oss-20b and the old llama model kept as
 *   ordered fallbacks.
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
 * - Key rotation skips cooled keys.
 */

import Groq from 'groq-sdk';
import {
  getCandidateModels, markModelWorking, markModelUnavailable,
} from './modelRegistry.js';
import { classifyProviderError } from './providerErrors.js';

function getKeys() {
  return [
    process.env.GROQ_API_KEY_1,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
  ].filter(Boolean);
}

/** Startup validation (Issue 6) — does this provider have any usable key at all? */
export function hasConfiguredKeys() {
  return getKeys().length > 0;
}

let keyIndex = 0;
const keyCooldowns = new Map();
const clientCache  = new Map();

function onCooldown(key) {
  const until = keyCooldowns.get(key);
  return until ? Date.now() < until : false;
}

function applyCooldown(key, ms) {
  keyCooldowns.set(key, Date.now() + ms);
}

function getClient(key) {
  if (!clientCache.has(key)) {
    clientCache.set(key, new Groq({ apiKey: key }));
  }
  return clientCache.get(key);
}

function nextKey() {
  const keys = getKeys();
  if (!keys.length) throw new Error('No Groq keys configured');
  for (let i = 0; i < keys.length; i++) {
    const k = keys[keyIndex];
    keyIndex = (keyIndex + 1) % keys.length;
    if (!onCooldown(k)) return k;
  }
  throw new Error('All Groq keys on cooldown');
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
export async function generateGroq(systemPrompt, messages, signal, maxTokens) {
  if (signal?.aborted) throw new Error('TIMEOUT');

  const candidates = getCandidateModels('groq');
  if (!candidates.length) throw new Error('All Groq models permanently unavailable');

  let lastError;

  for (const modelEntry of candidates) {
    const modelId  = modelEntry.modelId;
    const capTokens = maxTokens ? Math.min(maxTokens, modelEntry.maxOutputTokens) : maxTokens;

    let key;
    try {
      key = nextKey();
    } catch (e) {
      // No usable key at all — true for every model too, stop here.
      throw e;
    }

    const client = getClient(key);
    const chatMessages = [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    console.log(`[GROQ] model=${modelId} key=...${key.slice(-4)}`);

    const req = client.chat.completions.create({
      model:    modelId,
      messages: chatMessages,
      ...(capTokens ? { max_tokens: capTokens } : {}),
    });
    // Demo-stability fix: if the timeout wins the Promise.race below, `req`
    // keeps running detached. Should it later REJECT (network drop, 5xx),
    // that becomes an unhandled promise rejection — which is FATAL on
    // modern Node (default --unhandled-rejections=throw) and would crash
    // the whole server mid-request. Subscribing a no-op handler marks any
    // late rejection as handled; the race path is unaffected.
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

      if (type === 'model_not_found') {
        markModelUnavailable('groq', modelId, `${status ?? ''} ${err.message}`.trim());
        continue; // next candidate model
      }
      if (type === 'rate_limit') {
        console.log(`[GROQ] model=${modelId} key=...${key.slice(-4)} rate limited → 90s cooldown`);
        applyCooldown(key, 90_000);
        continue;
      }
      if (type === 'auth') {
        console.log(`[GROQ] key=...${key.slice(-4)} auth error → 24h cooldown`);
        applyCooldown(key, 86_400_000);
        continue;
      }
      console.log(`[GROQ] model=${modelId} error type=${type} status=${status} msg=${err.message}`);
      continue; // server_error / network / unknown — try next candidate model
    }

    const finishReason = result?.choices?.[0]?.finish_reason;
    const text = result?.choices?.[0]?.message?.content;

    // ── Issue 1: hitting the output-token cap is SUCCESS, not failure ──
    if (capTokens && finishReason === 'length') {
      if (!text || !text.trim()) {
        lastError = new Error('Groq returned empty truncated response');
        continue; // nothing usable — try next candidate model
      }
      console.log(`[GROQ] model=${modelId} hit maxTokens=${capTokens} cap — returning partial as successful completion`);
      markModelWorking('groq', modelId);
      return { text, truncated: true, finishReason: 'length' };
    }

    if (!text) {
      lastError = new Error('Groq returned empty response');
      continue;
    }

    markModelWorking('groq', modelId);
    return { text, truncated: false, finishReason: finishReason ?? 'stop' };
  }

  throw lastError ?? new Error('All Groq attempts exhausted');
}

/**
 * Streaming variant (Day 3 — Real Streaming).
 *
 * Same key rotation / model-registry fallback semantics as generateGroq,
 * with one hard rule: model/key fallback only happens BEFORE the first
 * delta reaches onDelta. Once a single token has been emitted the client
 * has already seen it — a mid-stream failure is surfaced as an
 * interrupted-partial result (never silently retried on another model,
 * which would restart the answer under the user's cursor).
 *
 * @param {string} systemPrompt
 * @param {Array<{role:string,content:string}>} messages
 * @param {AbortSignal} [signal]      - abort = TIMEOUT (router budget) or client cancel
 * @param {number} [maxTokens]
 * @param {(delta: string) => void} onDelta - called per content token
 * @returns {Promise<{ text:string, truncated:boolean, finishReason:string, streamed:true }>}
 */
export async function streamGroq(systemPrompt, messages, signal, maxTokens, onDelta) {
  if (signal?.aborted) throw new Error('TIMEOUT');

  const candidates = getCandidateModels('groq');
  if (!candidates.length) throw new Error('All Groq models permanently unavailable');

  let lastError;

  for (const modelEntry of candidates) {
    const modelId   = modelEntry.modelId;
    const capTokens = maxTokens ? Math.min(maxTokens, modelEntry.maxOutputTokens) : maxTokens;

    let key;
    try { key = nextKey(); } catch (e) { throw e; }
    const client = getClient(key);

    const chatMessages = [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    console.log(`[GROQ] stream model=${modelId} key=...${key.slice(-4)}`);

    let stream;
    try {
      stream = await client.chat.completions.create(
        {
          model:    modelId,
          messages: chatMessages,
          stream:   true,
          ...(capTokens ? { max_tokens: capTokens } : {}),
        },
        { signal }, // SDK aborts the underlying request when the router/client cancels
      );
    } catch (err) {
      if (signal?.aborted || err.name === 'AbortError') throw new Error('TIMEOUT');
      lastError = err;
      const { type, status } = classifyProviderError(err);
      if (type === 'model_not_found') { markModelUnavailable('groq', modelId, `${status ?? ''} ${err.message}`.trim()); continue; }
      if (type === 'rate_limit')      { applyCooldown(key, 90_000);  continue; }
      if (type === 'auth')            { applyCooldown(key, 86_400_000); continue; }
      console.log(`[GROQ] stream open failed model=${modelId} type=${type} msg=${err.message}`);
      continue;
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
      // Mid-stream failure: the client already saw `text` — return it as an
      // interrupted partial rather than restarting on another model.
      if (text) {
        console.log(`[GROQ] stream interrupted after ${text.length} chars model=${modelId}: ${err.message}`);
        return { text, truncated: true, finishReason: 'interrupted', streamed: true };
      }
      if (signal?.aborted || err.name === 'AbortError' || err.message === 'TIMEOUT') throw new Error('TIMEOUT');
      lastError = err;
      continue; // nothing emitted yet — safe to try next candidate model
    }

    if (!text.trim()) { lastError = new Error('Groq stream returned empty response'); continue; }

    markModelWorking('groq', modelId);
    const truncated = capTokens && finishReason === 'length';
    return { text, truncated: !!truncated, finishReason: truncated ? 'length' : (finishReason ?? 'stop'), streamed: true };
  }

  throw lastError ?? new Error('All Groq stream attempts exhausted');
}
