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
 * KEY POOL — the part that differs from the other adapters.
 *   Keys come from NVIDIA_API_KEY_1..N (any N, discovered from the env, not a
 *   fixed list) plus the bare NVIDIA_API_KEY. Blank values are ignored and a
 *   key that appears in two slots is used once. Selection is round-robin and
 *   skips keys on cooldown. Cooldowns are PER KEY:
 *     429       → that key cools for Retry-After (or 60s), the SAME request
 *                 retries on the next key. One throttled key is not a
 *                 provider failure, so it never reaches router health.
 *     401/403   → that key cools for 24h (a bad credential does not heal by
 *                 retrying), next key.
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
import {
  getCandidateModels, markModelWorking, markModelUnavailable, markModelTempFailed, pinCandidates,
} from './modelRegistry.js';
import { classifyProviderError, retryAfterMs } from './providerErrors.js';
import { recordProviderCall } from '../core/costAccounting.js';

const PROVIDER = 'nvidia';
const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 86_400_000;
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

/**
 * Discover key slots from the environment, every call (cheap; lets a test or
 * an operator change keys without a restart). Numbered slots in ascending
 * order, then the bare NVIDIA_API_KEY if it is not a duplicate of one of them.
 *
 * @returns {Array<{ slot: string, key: string }>} slot is "#<n>" or "#bare"
 */
function getKeySlots(env = process.env) {
  const numbered = [];
  for (const [name, raw] of Object.entries(env)) {
    const m = /^NVIDIA_API_KEY_(\d+)$/.exec(name);
    const key = String(raw ?? '').trim();
    if (m && key) numbered.push({ n: Number(m[1]), key });
  }
  numbered.sort((a, b) => a.n - b.n);

  const seen = new Set();
  const out = [];
  for (const { n, key } of numbered) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slot: `#${n}`, key });
  }
  const bare = String(env.NVIDIA_API_KEY ?? '').trim();
  if (bare && !seen.has(bare)) out.push({ slot: '#bare', key: bare });
  return out;
}

/** Slot labels only — safe to print. */
export function getKeySlotSummary() {
  const slots = getKeySlots().map(s => s.slot);
  return { count: slots.length, slots };
}

/** Startup validation (Issue 6) — does this provider have any usable key at all? */
export function hasConfiguredKeys() {
  return getKeySlots().length > 0;
}

let cursor = 0;
// slot label → { until: epoch ms usable again, reason: 'throttled'|'rejected' }
const keyCooldowns = new Map();
const clientCache  = new Map(); // baseURL + key → OpenAI client (in-memory only)

function onCooldown(slot) {
  const c = keyCooldowns.get(slot);
  return c ? Date.now() < c.until : false;
}

function applyCooldown(slot, ms, reason = 'throttled') {
  keyCooldowns.set(slot, { until: Date.now() + ms, reason });
}

/** Soonest a THROTTLED key frees (ms), or null when none is throttled. */
function msUntilThrottledKeyFree() {
  let soonest = null;
  for (const { slot } of getKeySlots()) {
    const c = keyCooldowns.get(slot);
    if (c?.reason !== 'throttled') continue;
    const wait = Math.max(0, c.until - Date.now());
    soonest = soonest == null ? wait : Math.min(soonest, wait);
  }
  return soonest;
}

function anyKeyThrottled() {
  return msUntilThrottledKeyFree() != null;
}

/**
 * Milliseconds until at least one key is usable: 0 when one is free now, null
 * when none are configured. Same contract as groq.js — the E6 harness sleeps
 * through a finite rate-limit wait instead of scoring it as a dead transport.
 */
export function msUntilAnyKeyFree() {
  const slots = getKeySlots();
  if (!slots.length) return null;
  let soonest = Infinity;
  for (const { slot } of slots) {
    const wait = Math.max(0, (keyCooldowns.get(slot)?.until ?? 0) - Date.now());
    if (wait === 0) return 0;
    soonest = Math.min(soonest, wait);
  }
  return soonest;
}

/** Next usable slot not already tried this request, round-robin; null if none. */
function nextSlot(slots, tried) {
  for (let i = 0; i < slots.length; i++) {
    const s = slots[cursor % slots.length];
    cursor = (cursor + 1) % slots.length;
    if (!tried.has(s.slot) && !onCooldown(s.slot)) return s;
  }
  return null;
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

function noKeysError() {
  return Object.assign(new Error('No NVIDIA keys configured'), { code: 'NO_KEYS' });
}

/** No key usable, some only throttled — a WAIT, reported as a rate limit with the exact wait. */
function allKeysCoolingError() {
  const wait = msUntilThrottledKeyFree() ?? RATE_LIMIT_COOLDOWN_MS;
  return Object.assign(new Error(`All NVIDIA keys rate limited or cooling down (next free in ${Math.ceil(wait / 1000)}s)`), {
    status: 429, retryAfterMs: wait, code: 'ALL_KEYS_COOLING',
  });
}

/** Every key was rejected (401/402/403) earlier — permanent until keys change. */
function allKeysRejectedError() {
  return Object.assign(new Error('All NVIDIA keys rejected (unauthorized or out of credits) — key cooldown 24h'), {
    status: 401, code: 'ALL_KEYS_REJECTED',
  });
}

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
 * Apply the key/model consequence of one failed attempt.
 * @returns {'rate_limited'|'key_rejected'|'next_model'}
 */
function handleAttemptError(err, slot, modelId, label) {
  const cls = classifyProviderError(err);
  const { type, status } = cls;
  if (type === 'rate_limit') {
    const cd = retryAfterMs(err) ?? RATE_LIMIT_COOLDOWN_MS;
    applyCooldown(slot, cd);
    console.log(`[NVIDIA] ${label}model=${modelId} key=${slot} rate limited → key cooldown ${Math.ceil(cd / 1000)}s, trying next key`);
    return 'rate_limited';
  }
  // 402 = this account's credits are spent. Scoped to the KEY: the other
  // accounts' keys are unaffected, and retrying this one soon will not help.
  if (type === 'auth' || status === 402) {
    applyCooldown(slot, AUTH_COOLDOWN_MS, 'rejected');
    console.log(`[NVIDIA] ${label}key=${slot} auth error status=${status} → key cooldown 24h, trying next key`);
    return 'key_rejected';
  }
  if (type === 'model_not_found') {
    markModelUnavailable(PROVIDER, modelId, `${status ?? ''} ${err.message}`.trim());
    return 'next_model';
  }
  if (type === 'model_unavailable') {
    markModelTempFailed(PROVIDER, modelId, 60_000);
    return 'next_model';
  }
  console.log(`[NVIDIA] ${label}model=${modelId} key=${slot} error type=${type} status=${status ?? 'n/a'} msg=${err.message}`);
  return 'next_model';
}

/**
 * The shared loop: every candidate model, and for each model every usable key
 * at most once. `attempt(client, modelId, capTokens, slot)` performs one
 * request and resolves to a result, or throws.
 */
async function runWithRotation({ opts, signal, maxTokens, label, attempt }) {
  if (signal?.aborted) throw timeoutError();

  const slots = getKeySlots();
  if (!slots.length) throw noKeysError();

  const candidates = pinCandidates(getCandidateModels(PROVIDER), opts.model ?? null, PROVIDER);
  if (!candidates.length) {
    throw Object.assign(new Error('No NVIDIA models currently available (cooling down or deprecated)'), { code: 'NO_CANDIDATE_MODELS' });
  }

  let lastError = null;
  let rateLimited = false; // at least one key was throttled during THIS call

  for (const entry of candidates) {
    const modelId = entry.modelId;
    const capTokens = maxTokens ? Math.min(maxTokens, entry.maxOutputTokens) : maxTokens;
    const tried = new Set();

    for (;;) {
      if (signal?.aborted) throw timeoutError();
      const s = nextSlot(slots, tried);
      if (!s) break; // every key tried or cooling for this model
      tried.add(s.slot);

      console.log(`[NVIDIA] ${label}model=${modelId} key=${s.slot}`);
      try {
        const res = await attempt(getClient(s.key), modelId, capTokens, s.slot);
        markModelWorking(PROVIDER, modelId);
        return { ...res, keySlot: s.slot };
      } catch (err) {
        // Mid-stream interruption: tokens already reached the client, so the
        // partial is the answer — even when the cause was an abort (groq.js does
        // the same).
        if (err?.partial) return { ...err.partial, keySlot: s.slot };
        if (err?.message === 'TIMEOUT' || signal?.aborted) throw timeoutError();
        lastError = err;
        const next = handleAttemptError(err, s.slot, modelId, label);
        if (next === 'rate_limited') { rateLimited = true; continue; }
        if (next === 'key_rejected') continue;
        break;
      }
    }
  }

  // Keys ran out. If ANY key is merely throttled, the provider will come back:
  // one rate_limit carrying the exact wait — even when other keys were
  // rejected, so a mixed 429/401 pool is not reported as a permanent auth
  // failure. Only a pool that is entirely REJECTED surfaces as auth.
  const lastType = lastError ? classifyProviderError(lastError).type : null;
  const keysExhausted = !lastError || lastType === 'rate_limit' || lastType === 'auth' || lastError?.status === 402;
  if (keysExhausted) {
    if (rateLimited || anyKeyThrottled()) throw allKeysCoolingError();
    if (!lastError) throw allKeysRejectedError();
  }
  throw lastError;
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
  cursor = 0;
  keyCooldowns.clear();
  clientCache.clear();
}
