/**
 * AQUA Startup Validation (Issue 6)
 *
 * Runs once at boot, right before the server starts listening:
 *   - Validates every entry in the central Model Registry (modelRegistry.js)
 *     and disables anything malformed.
 *   - Warns (does not fail) if a provider has zero configured API keys —
 *     that provider will simply score 0 / be skipped by the router at
 *     request time (existing degraded-mode behavior in router.js), rather
 *     than crashing startup.
 *
 * Contract: this function NEVER throws. "One invalid model must never
 * break a provider" (Issue 6) — the same principle applies to the whole
 * validation pass itself: a problem here is always a logged warning, never
 * a boot failure.
 */

import { validateRegistryOnStartup, getRegistrySnapshot } from '../providers/modelRegistry.js';
import { hasConfiguredKeys as geminiHasKeys }     from '../providers/gemini.js';
import { hasConfiguredKeys as groqHasKeys }       from '../providers/groq.js';
import { hasConfiguredKeys as openrouterHasKeys } from '../providers/openrouter.js';
import { hasConfiguredKeys as nvidiaHasKeys }     from '../providers/nvidia.js';
import { getSearchHealth }                        from '../search/searchManager.js';
import keyPoolLib                                 from '../providers/keyPool.cjs';

const { getCredentialDiagnostics } = keyPoolLib;

export function runStartupValidation() {
  console.log('[STARTUP] Validating model registry and provider configuration...');

  let registryResult = { validCount: 0, disabledCount: 0, issues: [] };
  try {
    registryResult = validateRegistryOnStartup();
  } catch (err) {
    // Defensive only — validateRegistryOnStartup() is designed to never
    // throw, but startup must continue even if it somehow does.
    console.warn(`[STARTUP] ⚠ Model registry validation raised an error (continuing anyway): ${err.message}`);
  }

  const keyChecks = { gemini: false, groq: false, openrouter: false, nvidia: false };
  try { keyChecks.gemini     = geminiHasKeys(); }     catch { /* no-op — treated as "no keys" */ }
  try { keyChecks.groq       = groqHasKeys(); }       catch { /* no-op */ }
  try { keyChecks.openrouter = openrouterHasKeys(); } catch { /* no-op */ }
  try { keyChecks.nvidia     = nvidiaHasKeys(); }     catch { /* no-op */ }
  // Key pools — slot labels and counts only, never a key value. No network
  // call is made: a configured credential is reported as configured, and its
  // health stays "credential checks pending" until a real call (or the opt-in
  // probe, scripts/provider-keys-doctor.mjs --probe) proves it.
  let credentials = null;
  try {
    credentials = getCredentialDiagnostics();
    for (const snap of Object.values(credentials)) console.log(`[STARTUP] ${snap.summary}`);
    // Pre-existing line, kept verbatim for anything that greps for it.
    if (keyChecks.nvidia) console.log(`[STARTUP] NVIDIA key pool: ${credentials.nvidia.distinctCredentials} key slot(s)`);
  } catch (err) {
    console.warn(`[STARTUP] ⚠ Key pool diagnostics raised an error (continuing anyway): ${err.message}`);
  }

  for (const [provider, ok] of Object.entries(keyChecks)) {
    if (!ok) {
      console.warn(`[STARTUP] ⚠ No API keys configured for provider="${provider}" — it will score 0 and be skipped until keys are added.`);
    }
  }

  if (Object.values(keyChecks).every(ok => !ok)) {
    console.warn('[STARTUP] ⚠⚠ NO providers have any configured keys — every request will fail until at least one is set.');
  }

  // ── Web Search keys (same warn-only contract) ───────────────────────────────
  // Zero search keys is a VALID configuration: the web_search capability
  // reports disabled and every request behaves exactly as pre-search AQUA.
  // We warn so ops can see why search is dormant, never fail boot over it.
  let searchHealth = null;
  try {
    searchHealth = getSearchHealth();
    const configuredSearch = Object.entries(searchHealth.providers)
      .filter(([, p]) => p.configured)
      .map(([name, p]) => `${name}(${p.totalKeys} key${p.totalKeys === 1 ? '' : 's'})`);
    if (!configuredSearch.length) {
      console.warn('[STARTUP] ⚠ No web search keys configured (SERPER_API_KEY_* / TAVILY_API_KEY_*) — web_search capability disabled; chat works unchanged.');
    } else {
      console.log(`[STARTUP] Web search ready: ${configuredSearch.join(', ')} | priority=${searchHealth.config.providerPriority.join(' → ')} | cache=${searchHealth.config.cache.enabled ? `${searchHealth.config.cache.ttlMs / 1000}s TTL` : 'off'}`);
    }
  } catch (err) {
    console.warn(`[STARTUP] ⚠ Search configuration check raised an error (continuing anyway): ${err.message}`);
  }

  console.log(`[STARTUP] Ready. Registry: ${registryResult.validCount} valid / ${registryResult.disabledCount} disabled models.`);

  return { registry: registryResult, keyChecks, credentials, search: searchHealth, snapshot: getRegistrySnapshot() };
}
