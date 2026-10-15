/**
 * AQUA Key Rotation — per-provider failure policy over the shared key pool.
 *
 * keyPool.cjs owns credentials (discovery, cooldown, quarantine, the loop).
 * modelRegistry.js owns models. This file is the ONE place that decides, for
 * a failed attempt, which of the two a failure belongs to — so a bad key
 * never poisons a model and a dead model never burns the key pool:
 *
 *   failure                         effect                          next step
 *   401/403/400 key invalid|expired quarantine THIS key (sticky)    next key, same model
 *   402 / out of credits            quarantine THIS key (TTL)       next key, same model
 *   429, key-scoped                 cool THIS key (or key+model)    next key, same model
 *   429, model-scoped (OpenRouter   markModelRateLimited            next model
 *        upstream saturation)
 *   404 / deprecation               markModelUnavailable            next model
 *   capacity ("no endpoints")       markModelTempFailed             next model
 *   5xx / empty / network           (OpenRouter: model temp-fail)   next model — another
 *                                                                   key on the same broken
 *                                                                   upstream would not help
 * Rate-limit scope per provider, from how each one meters quota:
 *   gemini      key+model  Google meters per project PER MODEL; another model may still serve.
 *   groq        key+model  Groq meters per organisation PER MODEL.
 *   nvidia      key        account-level request limits across models.
 *   openrouter  key | model  account limits (free-models-per-day…) vs upstream model saturation.
 * More keys are not necessarily more quota: keys from one Google project
 * share that project's quota. Rotation only helps across projects/accounts;
 * the per-request budget below keeps a same-project pool from being cycled
 * pointlessly.
 */

import keyPoolLib from './keyPool.cjs';
import { classifyProviderError, retryAfterMs } from './providerErrors.js';
import { markModelUnavailable, markModelTempFailed, markModelRateLimited } from './modelRegistry.js';

const { getKeyPool, runWithKeyRotation, classifyKeyFailure, openRouterRateLimitScope } = keyPoolLib;

function envInt(name, def) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const POLICIES = {
  gemini: {
    rateLimitScope: () => 'key_model', rateLimitCooldownMs: 120_000,
    onServerError: null, onTransportError: 'next_model',
  },
  groq: {
    rateLimitScope: () => 'key_model', rateLimitCooldownMs: 90_000,
    onServerError: null, onTransportError: 'next_model',
  },
  openrouter: {
    rateLimitScope: err => (openRouterRateLimitScope(err) === 'key' ? 'key' : 'model'),
    rateLimitCooldownMs: 120_000,
    onServerError: (modelId, err) => markModelTempFailed('openrouter', modelId, retryAfterMs(err) ?? 45_000),
    // A dead connection / unknown failure is not cured by another model on the
    // same connection — pre-existing OpenRouter behaviour, kept.
    onTransportError: 'throw',
  },
  nvidia: {
    rateLimitScope: () => 'key', rateLimitCooldownMs: 60_000,
    onServerError: null, onTransportError: 'next_model', billingTtlMs: 86_400_000,
    // Pre-existing NVIDIA contract: every key is tried once per model.
    unbounded: true,
  },
};

const TRANSPORT_TYPES = new Set(['network', 'unknown']);

/** Per-request bounds (env-tunable). Rejections never count; see keyPool.cjs. */
export function rotationLimits(provider) {
  if (POLICIES[provider]?.unbounded) return { maxKeysPerModel: Infinity, maxAttempts: Infinity };
  return {
    maxKeysPerModel: envInt('AQUA_PROVIDER_MAX_KEYS_PER_MODEL', 3),
    maxAttempts: envInt('AQUA_PROVIDER_MAX_KEY_ATTEMPTS', 8),
  };
}

/** The failure → action mapping documented above. Exported for tests. */
export function decideFailure(provider, err, { modelId, log = console.log } = {}) {
  const pol = POLICIES[provider];
  const tag = `[${provider.toUpperCase()}]`;
  const cls = classifyProviderError(err);
  const key = classifyKeyFailure(err);

  // A retired model is retired whatever else the body says.
  if (cls.type === 'model_not_found' && key.kind !== 'auth') {
    markModelUnavailable(provider, modelId, `${cls.status ?? ''} ${err.message}`.trim());
    return { action: 'next_model', errorType: cls.type };
  }
  if (key.kind === 'auth') return { action: 'key_rejected', reason: 'auth', errorType: 'auth' };
  if (key.kind === 'billing') return { action: 'key_billing', ttlMs: pol.billingTtlMs, errorType: 'billing' };
  if (key.kind === 'content') {
    log(`${tag} model=${modelId} refused on content policy (status=${key.status}) — not a credential problem`);
    return { action: 'next_model', errorType: 'content' };
  }
  if (cls.type === 'model_unavailable') {
    markModelTempFailed(provider, modelId, 60_000);
    return { action: 'next_model', errorType: cls.type };
  }
  if (cls.type === 'rate_limit') {
    const ms = retryAfterMs(err) ?? pol.rateLimitCooldownMs;
    const scope = pol.rateLimitScope(err);
    if (scope === 'model') {
      markModelRateLimited(provider, modelId, ms);
      log(`${tag} model=${modelId} rate limited upstream (model-scoped) → model cooldown ${Math.ceil(ms / 1000)}s`);
      return { action: 'next_model', errorType: 'rate_limit' };
    }
    return { action: 'key_rate_limited', cooldownMs: ms, model: scope === 'key_model' ? modelId : null, errorType: 'rate_limit' };
  }
  if (cls.type === 'server_error') pol.onServerError?.(modelId, err);
  log(`${tag} model=${modelId} error type=${cls.type} status=${cls.status ?? 'n/a'} msg=${err?.message}`);
  if (TRANSPORT_TYPES.has(cls.type) && pol.onTransportError === 'throw') return { action: 'throw', errorType: cls.type };
  return { action: 'next_model', errorType: cls.type };
}

/**
 * Run `attempt({ key, slot, modelId, model })` over `models` with this
 * provider's pool and policy. Resolves to the attempt's result plus
 * `keySlot` / `keyAttempts`; see runWithKeyRotation for terminal errors.
 */
export function rotate(provider, { models, attempt, signal, label = '', purpose = 'other', messages, log = console.log }) {
  return runWithKeyRotation({
    pool: getKeyPool(provider),
    models, attempt, signal, label, purpose, messages, log,
    decide: (err, ctx) => decideFailure(provider, err, { ...ctx, log }),
    ...rotationLimits(provider),
  });
}

export function keyPoolFor(provider) { return getKeyPool(provider); }

/** Abort-aware await for SDK calls that take no signal (same race-leak guard the adapters used). */
export function raceAbort(promise, signal) {
  Promise.resolve(promise).catch(() => {}); // a lost race must not become an unhandled rejection
  if (!signal) return promise;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      if (signal.aborted) return rej(new Error('TIMEOUT'));
      signal.addEventListener('abort', () => rej(new Error('TIMEOUT')), { once: true });
    }),
  ]);
}
