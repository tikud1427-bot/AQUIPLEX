/**
 * AQUA — the welcome line service (2026-10-10).
 *
 *   authenticated owner → canonical World Model slice (repository.js)
 *                       → legacy Mind goals, ONLY where the read mode allows
 *                       → selectWelcome (selector.js, pure)
 *
 * Source precedence is the Context Engine's, not a new one (brain/index.js
 * `canonicalReadMode`):
 *   'authoritative' (default with Postgres)  canonical first; legacy goals only
 *                   fill the gap, and never against a canonical contradiction.
 *                   A canonical read FAILURE drops legacy too (fail-closed,
 *                   same as the answer path's legacy veto) — the line falls
 *                   back to a neutral one rather than to unchecked memory.
 *   'canonical'     canonical only.
 *   'legacy'        no Postgres / brain off: legacy goals only.
 *
 * No model call and no write, so there is nothing to cache for cost: each
 * request re-reads the current world (one bounded query) and the selector is
 * deterministic, which is what makes the line both stable and never stale.
 * `worldVersion` / `messageId` let the client keep what it shows when nothing
 * relevant changed.
 */
import { selectWelcome } from './selector.js';
import { loadWelcomeSlice } from './repository.js';
import { canonicalReadMode } from '../index.js';
import { peekMind } from '../../mind/mindStore.js';

const REAL_DEPS = {
  readMode: () => canonicalReadMode(),
  loadClaims: ownerId => loadWelcomeSlice(ownerId),
  legacyGoals: ownerId => Object.values(peekMind(ownerId)?.goals ?? {}),
};
let deps = REAL_DEPS;

/** Test seam (same pattern as __setEmbedderForTests). */
export function __setWelcomeDepsForTests(over) { deps = { ...REAL_DEPS, ...over }; }
export function __resetWelcomeDepsForTests() { deps = REAL_DEPS; }

/**
 * @param {string} ownerId  the AUTHENTICATED owner; never derived from client input
 * @param {{history?:boolean, now?:Date}} [opts]
 */
export async function welcomeFor(ownerId, { history = false, now = new Date() } = {}) {
  if (!ownerId) throw new Error('welcomeFor: ownerId is required');
  const mode = deps.readMode();
  let claims = [];
  let unavailable = false;
  if (mode !== 'legacy') {
    try {
      claims = await deps.loadClaims(ownerId);
    } catch (err) {
      console.warn(`[WELCOME] canonical read failed (neutral line served): ${err?.message ?? err}`);
      unavailable = true;
    }
  }
  let legacyGoals = [];
  if (mode !== 'canonical' && !unavailable) {
    try {
      legacyGoals = deps.legacyGoals(ownerId) ?? [];
    } catch (err) {
      console.warn(`[WELCOME] legacy goals unreadable: ${err?.message ?? err}`);
      if (mode === 'legacy') unavailable = true;
    }
  }
  return { ...selectWelcome({ claims, legacyGoals, history, unavailable, now }), readMode: mode };
}
