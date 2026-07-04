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

  const keyChecks = { gemini: false, groq: false, openrouter: false };
  try { keyChecks.gemini     = geminiHasKeys(); }     catch { /* no-op — treated as "no keys" */ }
  try { keyChecks.groq       = groqHasKeys(); }       catch { /* no-op */ }
  try { keyChecks.openrouter = openrouterHasKeys(); } catch { /* no-op */ }

  for (const [provider, ok] of Object.entries(keyChecks)) {
    if (!ok) {
      console.warn(`[STARTUP] ⚠ No API keys configured for provider="${provider}" — it will score 0 and be skipped until keys are added.`);
    }
  }

  if (Object.values(keyChecks).every(ok => !ok)) {
    console.warn('[STARTUP] ⚠⚠ NO providers have any configured keys — every request will fail until at least one is set.');
  }

  console.log(`[STARTUP] Ready. Registry: ${registryResult.validCount} valid / ${registryResult.disabledCount} disabled models.`);

  return { registry: registryResult, keyChecks, snapshot: getRegistrySnapshot() };
}
