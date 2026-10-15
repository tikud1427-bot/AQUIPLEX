/**
 * AQUA NVIDIA Provider v1
 *
 * NVIDIA's hosted API (build.nvidia.com / integrate.api.nvidia.com) speaks the
 * OpenAI Chat Completions wire format, so this adapter rides the same `openai`
 * SDK openrouter.js already depends on — no new dependency, and the same
 * request/response shapes the router already handles.
 *
 * Same contract as groq.js / openrouter.js:
 *   generateNvidia(systemPrompt, messages, signal, maxTokens, opts)
 *     → { text, truncated, finishReason, model, usage, keySlot }
 *   streamNvidia(systemPrompt, messages, signal, maxTokens, onDelta, opts)
 *     → { text, truncated, finishReason, streamed: true, model, usage, keySlot }
 * `keySlot` ("#3") is additive observability — the slot NUMBER, never the key.
 *
 * KEY POOL — shared with every adapter and the platform client (keyPool.cjs).
 *   Keys come from NVIDIA_API_KEY_1..N (any N, discovered from the env, not a
 *   fixed list) plus the bare NVIDIA_API_KEY. Blank values are ignored and a
 *   key that appears in two slots is used once. Selection is round-robin and
 *   skips keys on cooldown. Cooldowns are PER KEY:
 *     429       → that key cools for Retry-After (or 60s), the SAME request
 *                 retries on the next key. One throttled key is not a
 *                 provider failure, so it never reaches router health.
 *     401/403   → that key is quarantined until reset/restart (a bad
 *                 credential does not heal by waiting), next key.
 *     402       → credits spent: that key cools 24h, next key.
 *   Only when EVERY key is cooling does the call fail — as a rate_limit carrying
 *   the time until the first key frees, so the router backs off by exactly that.
 *
 * MODEL SCOPE — kept apart from key scope.
 *   404 / deprecation  → markModelUnavailable (that model only; keys untouched)
 *   capacity           → markModelTempFailed (self-heals)
 *   5xx / network / empty response → next candidate model; with none left the
 *                 error propagates and the router counts a provider failure.
 *   Model ids live in modelRegistry.js (NVIDIA_DEFAULT_MODEL selects the
 *   default). `opts.model` pins exactly one model and throws
 *   MODEL_PIN_UNAVAILABLE rather than substitute — an evaluation run must
 *   never hop models silently.
 *
 * Never logged: the key, the Authorization header, or any part of either.
 */

import OpenAI from 'openai';
import { getCandidateModels, markModelWorking, pinCandidates } from './modelRegistry.js';
import { rotate, keyPoolFor } from './keyRotation.js';
import { recordProviderCall } from '../core/costAccounting.js';

const PROVIDER = 'nvidia';
const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
// The router's AbortSignal is the real budget; this only stops a direct caller
// (E6 harness, smoke test) from hanging on a dead socket forever.
const REQUEST_TIMEOUT_MS = 120_000;

/** E12: every successful call is counted (tokens always; USD only when priced). */
function countedCall(purpose, res) {
  try { recordProviderCall({ provider: PROVIDER, model: res.model ?? null, usage: res.usage ?? null, purpose: purpose ?? 'other' }); } catch { /* observability never fails a call */ }
  return res;
}

/** OpenAI-compatible usage → the E12 cost-accounting shape. */
export function normalizeUsage(usage) {
  const inputTokens = Number(usage?.prompt_tokens ?? usage?.promptTokens);
  const outputTokens = Number(usage?.completion_tokens ?? usage?.completionTokens);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return null;
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
  };
}

// ── Key pool ──────────────────────────────────────────────────────────────────
//
// Discovery, cooldowns and quarantine live in the shared key pool
// (keyPool.cjs) — the same instance the platform client and every other
// adapter use. Slot labels ("#3", "#bare") are the only identifiers printed.

const pool = keyPoolFor(PROVIDER);
const clientCache = new Map(); // baseURL + key → OpenAI client (in-memory only)

/** Slot labels only — safe to print. */
export function getKeySlotSummary() {
  const slots = pool.entries().map(s => s.slot);
  return { count: slots.length, slots };
}

/** Startup validation (Issue 6) — does this provider have any usable key at all? */
export function hasConfiguredKeys() {
  return pool.hasKeys();
}

/**
 * Milliseconds until at least one key is usable: 0 when one is free now, null
 * when none are configured (or every one is rejected — waiting will not help).
 * Same contract as groq.js — the E6 harness sleeps through a finite
 * rate-limit wait instead of scoring it as a dead transport.
 */
export function msUntilAnyKeyFree() {
  return pool.msUntilAvailable();
}

function baseURL() {
  // Overridable for gateways / self-hosted NIM / integration tests.
  return process.env.NVIDIA_BASE_URL || DEFAULT_BASE_URL;
}

function getClient(key) {
  const url = baseURL();
  const cacheKey = `${url}\u0000${key}`;
  if (!clientCache.has(cacheKey)) {
    clientCache.set(cacheKey, new OpenAI({
      apiKey: key,
      baseURL: url,
      // Retries are OURS: the SDK's built-in retry would re-send a 429 on the
      // same throttled key instead of rotating to the next one.
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
    }));
  }
  return clientCache.get(cacheKey);
}

const MESSAGES = {
  noKeys: 'No NVIDIA keys configured',
  allCooling: wait => `All NVIDIA keys rate limited or cooling down (next free in ${Math.ceil(wait / 1000)}s)`,
  allRejected: 'All NVIDIA keys rejected (unauthorized) — fix credentials and restart',
  allBilling: 'All NVIDIA keys out of credits (402)',
};

function invalidResponse(detail) {
  return Object.assign(new Error(`NVIDIA: ${detail}`), { code: 'INVALID_RESPONSE' });
}

function chatMessagesOf(systemPrompt, messages) {
  return [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];
}

const timeoutError = () => new Error('TIMEOUT');

/**
 * The shared loop: every candidate model, and for each model every usable key
 * at most once (keyRotation.js — NVIDIA's policy is key-wide 429 cooldowns,
 * every key tried once per model). `attempt(client, modelId, capTokens, slot)`
 * performs one request and resolves to a result, or throws.
 */
async function runWithRotation({ opts, signal, maxTokens, label, attempt }) {
  if (signal?.aborted) throw timeoutError();
  if (!pool.hasKeys()) throw Object.assign(new Error(MESSAGES.noKeys), { code: 'NO_KEYS' });

  const candidates = pinCandidates(getCandidateModels(PROVIDER), opts.model ?? null, PROVIDER);
  if (!candidates.length) {
    throw Object.assign(new Error('No NVIDIA models currently available (cooling down or deprecated)'), { code: 'NO_CANDIDATE_MODELS' });
  }

  const res = await rotate(PROVIDER, {
    models: candidates, signal, label, purpose: opts?.purpose ?? 'other', messages: MESSAGES,
    attempt: ({ key, slot, modelId, model }) => {
      const capTokens = maxTokens ? Math.min(maxTokens, model.maxOutputTokens) : maxTokens;
      return attempt(getClient(key), modelId, capTokens, slot);
    },
  });
  if (res.finishReason !== 'interrupted') markModelWorking(PROVIDER, res.model);
  return res;
}


// ── Generate ──────────────────────────────────────────────────────────────────

/**
 * @param {string} systemPrompt
 * @param {Array<{role:string,content:string}>} messages
 * @param {AbortSignal} [signal]
 * @param {number} [maxTokens] clamped to the registry's maxOutputTokens
 * @param {object} [opts] `model` (pin), `temperature` (sent only when given), `purpose` (cost)
 */
export async function generateNvidia(systemPrompt, messages, signal, maxTokens, opts = {}) {
  const chatMessages = chatMessagesOf(systemPrompt, messages);

  const res = await runWithRotation({
    opts, signal, maxTokens, label: '',
    attempt: async (client, modelId, capTokens) => {
      const result = await client.chat.completions.create({
        model: modelId,
        messages: chatMessages,
        ...(capTokens ? { max_tokens: capTokens } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      }, signal ? { signal } : undefined);

      const choice = result?.choices?.[0];
      const finishReason = choice?.finish_reason ?? null;
      const text = choice?.message?.content;
      const usage = normalizeUsage(result?.usage);

      if (!text || !String(text).trim()) {
        // gpt-oss spends output tokens on hidden reasoning; a budget consumed
        // entirely by reasoning leaves content empty with finish_reason=length.
        throw invalidResponse(finishReason === 'length'
          ? `model ${modelId} exhausted max_tokens before producing content`
          : `model ${modelId} returned empty response`);
      }
      // Hitting the output cap is a SUCCESSFUL completion (router v4, Issue 1).
      const truncated = finishReason === 'length';
      return { text, truncated, finishReason: truncated ? 'length' : (finishReason ?? 'stop'), model: modelId, usage };
    },
  });

  return countedCall(opts?.purpose, res);
}

// ── Stream ────────────────────────────────────────────────────────────────────

/**
 * Streaming variant. Same rotation, with the streaming rule every adapter
 * follows: key/model fallback only BEFORE the first delta reaches onDelta. A
 * failure after that returns the partial as finishReason='interrupted' — never
 * a silent restart under the user's cursor.
 *
 * @param {(delta: string) => void} onDelta
 * @param {object} [opts] `model` (pin), `purpose`
 */
export async function streamNvidia(systemPrompt, messages, signal, maxTokens, onDelta, opts = {}) {
  const chatMessages = chatMessagesOf(systemPrompt, messages);

  const res = await runWithRotation({
    opts, signal, maxTokens, label: 'stream ',
    attempt: async (client, modelId, capTokens) => {
      const stream = await client.chat.completions.create({
        model: modelId,
        messages: chatMessages,
        stream: true,
        stream_options: { include_usage: true },
        ...(capTokens ? { max_tokens: capTokens } : {}),
      }, signal ? { signal } : undefined);

      let text = '';
      let finishReason = null;
      let usage = null;
      try {
        for await (const chunk of stream) {
          if (signal?.aborted) throw timeoutError();
          const choice = chunk?.choices?.[0];
          finishReason = choice?.finish_reason ?? finishReason;
          usage = normalizeUsage(chunk?.usage) ?? usage;
          const delta = choice?.delta?.content;
          if (delta) { text += delta; onDelta(delta); }
        }
      } catch (err) {
        if (text) {
          // The client already saw `text` — return it, do not retry elsewhere.
          console.log(`[NVIDIA] stream interrupted after ${text.length} chars model=${modelId}: ${err.message}`);
          throw Object.assign(new Error('STREAM_INTERRUPTED'), {
            partial: { text, truncated: true, finishReason: 'interrupted', streamed: true, model: modelId, usage },
          });
        }
        throw err;
      }

      if (!text.trim()) {
        throw invalidResponse(finishReason === 'length'
          ? `model ${modelId} stream exhausted max_tokens before producing content`
          : `model ${modelId} stream returned empty response`);
      }
      const truncated = finishReason === 'length';
      return { text, truncated, finishReason: truncated ? 'length' : (finishReason ?? 'stop'), streamed: true, model: modelId, usage };
    },
  });

  // An interrupted partial is not counted as a successful call — same as the
  // other adapters, which return it uncounted.
  if (res.finishReason === 'interrupted') return res;
  return countedCall(opts?.purpose ?? 'chat', res);
}

/**
 * Test-only: forget cooldowns, the rotation cursor and cached clients. No
 * production path calls this (same pattern as health.js / modelRegistry.js).
 */
export function __resetForTests() {
  pool.resetCredentials();
  clientCache.clear();
}
