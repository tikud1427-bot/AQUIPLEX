/**
 * AQUA Model Registry (Issue 5)
 *
 * Single source of truth for every model ID AQUA can call, across all three
 * providers. Before this module, model IDs were hardcoded inline in
 * gemini.js/groq.js (one literal string each) and duplicated as a bare
 * array in openrouter.js — three different places to update, three
 * different ad-hoc "is this model still alive" mechanisms.
 *
 * This registry:
 *   1. Defines every model's identity + capabilities in one place (schema
 *      below matches Issue 5's spec exactly).
 *   2. Owns per-model AVAILABILITY state (Issue 4): working / rate_limited /
 *      temp_failed / deprecated, each with its own cooldown — so a single
 *      dead OpenRouter model never has to be conflated with "OpenRouter is
 *      down" ever again. Provider-level health (src/core/health.js) stays
 *      completely separate and is never touched by a model-level event.
 *   3. Provides startup validation (Issue 6): malformed entries are
 *      disabled + logged, never thrown — one bad entry can't break a
 *      provider or block boot.
 *
 * Model list last verified 2026-07-02. OpenRouter's free catalog in
 * particular churns fast (providers rotate free slots weekly) — that's
 * exactly why every model here is behind the same self-healing 404
 * handling instead of being trusted to stay valid forever. Re-verify
 * against https://openrouter.ai/models?order=newest and
 * https://console.groq.com/docs/models periodically.
 */

// ── Registry schema ──────────────────────────────────────────────────────────
// provider, modelId, capabilities, contextWindow, maxOutputTokens,
// supportsStreaming, supportsVision, supportsTools, supportsJSON,
// supportsReasoning, costTier, enabled, health — per Issue 5.

function model(overrides) {
  return {
    provider:           overrides.provider,
    modelId:            overrides.modelId,
    capabilities:       overrides.capabilities ?? ['chat'],
    contextWindow:      overrides.contextWindow ?? 32_000,
    maxOutputTokens:    overrides.maxOutputTokens ?? 4_096,
    supportsStreaming:  overrides.supportsStreaming ?? true,
    supportsVision:     overrides.supportsVision ?? false,
    supportsTools:      overrides.supportsTools ?? false,
    supportsJSON:       overrides.supportsJSON ?? true,
    supportsReasoning:  overrides.supportsReasoning ?? false,
    costTier:           overrides.costTier ?? 'free',
    enabled:            overrides.enabled ?? true,
    note:               overrides.note,
    // Mutable at runtime by markModel*() below — never touched by hand.
    health: { status: 'working', until: 0, lastError: null },
  };
}

// Rotate = true → pickModel() cycles through candidates round-robin even
// when all are healthy (spreads load across free-tier rate limits — this
// is openrouter.js's pre-existing modelCursor behavior, preserved as-is).
// Rotate = false → pickModel() always prefers the first available entry,
// falling through in listed order (primary → fallback → fallback...),
// which is the right behavior for gemini/groq's small curated lists.
const PROVIDER_LISTS = {
  gemini: {
    rotate: false,
    models: [
      model({
        provider: 'gemini', modelId: 'gemini-2.5-flash',
        capabilities: ['chat', 'reasoning', 'vision', 'tools'],
        contextWindow: 1_048_576, maxOutputTokens: 65_536,
        supportsVision: true, supportsTools: true, supportsReasoning: true,
        costTier: 'free',
        note: 'Primary. GA, confirmed current as of 2026-06-30. Google\'s stated shutdown horizon is 2026-10-16 — gemini-3.5-flash is registered below as the pre-vetted fallback for when it starts 404ing.',
      }),
      model({
        provider: 'gemini', modelId: 'gemini-3.5-flash',
        capabilities: ['chat', 'reasoning', 'vision', 'tools'],
        contextWindow: 1_048_576, maxOutputTokens: 65_536,
        supportsVision: true, supportsTools: true, supportsReasoning: true,
        costTier: 'free',
        note: 'Fallback. GA since 2026-05-19, no announced shutdown date at time of writing.',
      }),
    ],
  },
  groq: {
    rotate: false,
    models: [
      model({
        provider: 'groq', modelId: 'openai/gpt-oss-120b',
        capabilities: ['chat', 'reasoning', 'tools'],
        contextWindow: 131_072, maxOutputTokens: 65_536,
        supportsTools: true, supportsReasoning: true,
        costTier: 'free',
        note: 'Primary. Groq\'s own recommended replacement for llama-3.3-70b-versatile (deprecation announced 2026-06-17) — also faster (500 t/s vs 280 t/s) and cheaper.',
      }),
      model({
        provider: 'groq', modelId: 'openai/gpt-oss-20b',
        capabilities: ['chat', 'reasoning', 'tools'],
        contextWindow: 131_072, maxOutputTokens: 65_536,
        supportsTools: true, supportsReasoning: true,
        costTier: 'free',
        note: 'Fallback — smaller/faster (~1000 t/s) sibling of the primary.',
      }),
      model({
        provider: 'groq', modelId: 'llama-3.3-70b-versatile',
        capabilities: ['chat', 'tools'],
        contextWindow: 131_072, maxOutputTokens: 32_768,
        supportsTools: true,
        costTier: 'free',
        note: 'Tertiary safety net only. Groq announced deprecation 2026-06-17; still live at time of writing but do not promote back to primary.',
      }),
    ],
  },
  openrouter: {
    rotate: true, // preserves the pre-existing modelCursor load-spreading behavior
    models: [
      model({
        provider: 'openrouter', modelId: 'openai/gpt-oss-120b:free',
        capabilities: ['chat', 'reasoning', 'tools'], contextWindow: 131_072,
        maxOutputTokens: 8_192, supportsTools: true, supportsReasoning: true,
      }),
      model({
        provider: 'openrouter', modelId: 'z-ai/glm-4.5-air:free',
        capabilities: ['chat', 'reasoning', 'tools'], contextWindow: 131_072,
        maxOutputTokens: 8_192, supportsTools: true, supportsReasoning: true,
      }),
      model({
        provider: 'openrouter', modelId: 'nvidia/nemotron-3-super-120b-a12b:free',
        capabilities: ['chat', 'reasoning'], contextWindow: 1_000_000,
        maxOutputTokens: 8_192, supportsReasoning: true,
      }),
      model({
        provider: 'openrouter', modelId: 'google/gemma-4-31b-it:free',
        capabilities: ['chat'], contextWindow: 262_144, maxOutputTokens: 8_192,
      }),
      model({
        provider: 'openrouter', modelId: 'openai/gpt-oss-20b:free',
        capabilities: ['chat', 'reasoning', 'tools'], contextWindow: 131_072,
        maxOutputTokens: 8_192, supportsTools: true, supportsReasoning: true,
      }),
      model({
        provider: 'openrouter', modelId: 'moonshotai/kimi-k2.6:free',
        capabilities: ['chat', 'reasoning'], contextWindow: 262_144,
        maxOutputTokens: 8_192, supportsReasoning: true,
      }),
      model({
        provider: 'openrouter', modelId: 'nvidia/nemotron-nano-9b-v2:free',
        capabilities: ['chat'], contextWindow: 131_072, maxOutputTokens: 8_192,
      }),
    ],
  },
};

let openrouterCursor = 0;

// ── Availability ──────────────────────────────────────────────────────────────

function isAvailable(entry) {
  if (!entry.enabled) return false;
  const h = entry.health;
  if (h.status === 'deprecated') return false;
  if ((h.status === 'rate_limited' || h.status === 'temp_failed') && h.until) {
    if (Date.now() < h.until) return false;
    h.status = 'working'; // cooldown expired — self-heal
    h.until  = 0;
  }
  return true;
}

function findEntry(provider, modelId) {
  return PROVIDER_LISTS[provider]?.models.find(m => m.modelId === modelId) ?? null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {string} provider
 * @returns {object|null} the best available model entry for this provider,
 *   or null if every model is currently unavailable (caller should treat
 *   that as a provider-level failure — every candidate has been exhausted).
 */
export function pickModel(provider) {
  const list = getCandidateModels(provider);
  return list[0] ?? null;
}

/**
 * @param {string} provider
 * @returns {object[]} every currently-available model for this provider,
 *   in the order they should be tried this call. Lets gemini.js/groq.js/
 *   openrouter.js retry the NEXT model within the same request instead of
 *   propagating a single dead model straight up to the provider-level
 *   router (see Issue 4 — "the router gracefully degrades when individual
 *   models disappear").
 */
export function getCandidateModels(provider) {
  const cfg = PROVIDER_LISTS[provider];
  if (!cfg) return [];

  const available = cfg.models.filter(isAvailable);
  if (!available.length) return [];

  if (!cfg.rotate) return available; // preference order, as listed

  // Rotate: start from the cursor position among AVAILABLE entries so a
  // deprecated/cooling model never "eats" a rotation slot.
  const startIdx = openrouterCursor % available.length;
  openrouterCursor = (openrouterCursor + 1) % Math.max(cfg.models.length, 1);
  return [...available.slice(startIdx), ...available.slice(0, startIdx)];
}

/** @returns {object|null} full registry entry, e.g. to clamp maxTokens against maxOutputTokens. */
export function getModelSpec(provider, modelId) {
  return findEntry(provider, modelId);
}

/** Permanent — 404 / model-not-found. Never retried again this process. */
export function markModelUnavailable(provider, modelId, reason = 'not_found') {
  const entry = findEntry(provider, modelId);
  if (!entry) return;
  entry.health = { status: 'deprecated', until: 0, lastError: reason };
  console.warn(`[MODEL_REGISTRY] ${provider}/${modelId} → DEPRECATED (${reason}) — permanently skipped, provider health unaffected`);
}

/** Temporary — 429. */
export function markModelRateLimited(provider, modelId, ms = 120_000) {
  const entry = findEntry(provider, modelId);
  if (!entry) return;
  entry.health = { status: 'rate_limited', until: Date.now() + ms, lastError: 'rate_limited' };
  console.log(`[MODEL_REGISTRY] ${provider}/${modelId} → rate limited (${(ms / 1000).toFixed(0)}s)`);
}

/** Temporary — 5xx / transient. */
export function markModelTempFailed(provider, modelId, ms = 45_000) {
  const entry = findEntry(provider, modelId);
  if (!entry || entry.health.status === 'deprecated') return;
  entry.health = { status: 'temp_failed', until: Date.now() + ms, lastError: 'temp_failed' };
  console.log(`[MODEL_REGISTRY] ${provider}/${modelId} → temp failed (${(ms / 1000).toFixed(0)}s)`);
}

/** Clears a model back to working — used on a successful call. */
export function markModelWorking(provider, modelId) {
  const entry = findEntry(provider, modelId);
  if (!entry) return;
  if (entry.health.status !== 'working') {
    entry.health = { status: 'working', until: 0, lastError: null };
  }
}

// ── Startup validation (Issue 6) ─────────────────────────────────────────────

/**
 * Pure validation for a single registry entry — no side effects, safe to
 * call with synthetic data in tests. Exported separately from
 * validateRegistryOnStartup() (which runs this against the real registry
 * and mutates `enabled`) so the validation RULES themselves are directly
 * testable without needing to mutate the module-level singleton.
 *
 * @returns {string[]} list of problems; empty array means the entry is valid.
 */
export function validateEntry(entry, expectedProvider) {
  const problems = [];
  if (!entry || typeof entry !== 'object') return ['entry is not an object'];
  if (!entry.modelId || typeof entry.modelId !== 'string') problems.push('missing/invalid modelId');
  if (entry.provider !== expectedProvider) problems.push(`provider mismatch (entry says ${entry.provider})`);
  if (!Number.isFinite(entry.maxOutputTokens) || entry.maxOutputTokens <= 0) problems.push('invalid maxOutputTokens');
  if (!Number.isFinite(entry.contextWindow) || entry.contextWindow <= 0) problems.push('invalid contextWindow');
  if (!Array.isArray(entry.capabilities) || !entry.capabilities.length) problems.push('missing capabilities');
  return problems;
}

/**
 * Validates every registered model entry. Disables (enabled=false) any
 * entry that's malformed instead of throwing — one bad entry must never
 * break a provider or block server boot. Safe to call multiple times.
 *
 * @returns {{ validCount: number, disabledCount: number, issues: string[] }}
 */
export function validateRegistryOnStartup() {
  const issues = [];
  let validCount = 0, disabledCount = 0;

  for (const [provider, cfg] of Object.entries(PROVIDER_LISTS)) {
    for (const entry of cfg.models) {
      const problems = validateEntry(entry, provider);

      if (problems.length) {
        entry.enabled = false;
        disabledCount++;
        const msg = `${provider}/${entry.modelId ?? '(unknown)'}: ${problems.join(', ')}`;
        issues.push(msg);
        console.warn(`[STARTUP] ⚠ Model registry entry disabled — ${msg}`);
      } else {
        validCount++;
      }
    }

    if (!cfg.models.some(m => m.enabled)) {
      console.warn(`[STARTUP] ⚠ Provider "${provider}" has ZERO valid enabled models after validation.`);
    }
  }

  console.log(`[STARTUP] Model registry validated: ${validCount} valid, ${disabledCount} disabled.`);
  return { validCount, disabledCount, issues };
}

// ── Introspection (health endpoint) ──────────────────────────────────────────

export function getRegistrySnapshot() {
  const out = {};
  for (const [provider, cfg] of Object.entries(PROVIDER_LISTS)) {
    out[provider] = cfg.models.map(m => ({
      modelId:           m.modelId,
      enabled:           m.enabled,
      status:            m.health.status,
      cooldownRemainsS:  m.health.until && m.health.until > Date.now()
        ? +((m.health.until - Date.now()) / 1000).toFixed(0)
        : null,
      contextWindow:     m.contextWindow,
      maxOutputTokens:   m.maxOutputTokens,
      costTier:          m.costTier,
      capabilities:      m.capabilities,
    }));
  }
  return out;
}

/**
 * Test-only: restores every model's health to 'working', re-enables every
 * entry, and resets the OpenRouter rotation cursor. No production code
 * path calls this — see health.js's __resetForTests() for the same pattern.
 */
export function __resetForTests() {
  for (const cfg of Object.values(PROVIDER_LISTS)) {
    for (const entry of cfg.models) {
      entry.enabled = true;
      entry.health  = { status: 'working', until: 0, lastError: null };
    }
  }
  openrouterCursor = 0;
}
