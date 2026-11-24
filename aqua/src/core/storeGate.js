/**
 * AQUA store gate (2026-11-24, audit/recovery Phase E — risk R-A5).
 *
 * THE FAILURE THIS PREVENTS. From 2026-11-18 to 11-23 two Render processes
 * started UNVERIFIED (hydration failed). The mirror guard did its job — nothing
 * they wrote replaced the backup — but the engine still served users from the
 * EMPTY local stores those processes loaded: returning users were sent through
 * onboarding again, and everything they did for five days went only into
 * local-recovery copies, invisible to the product after the next restart.
 *
 * THE RULE. While the mirror is configured and this process's stores are not
 * known to equal the backup — initialization unverified, or any store blocked
 * (recovery required) — engine routes that read or write user data answer
 * 503 STORE_NOT_VERIFIED instead. Health/diagnostic routes stay open, and
 * /ready reports `stores: false` (index.js), so an orchestrator using /ready
 * restarts the instance, which re-hydrates.
 *
 * Not configured (no MONGO_URI: tests, dev, standalone) → always open.
 * AQUA_STORE_GATE=off → always open (rollback; restores the 2026-11-23 behaviour).
 */
import { getMirrorStatus } from './mongoMirror.js';

export function storeGateEnabled() {
  return String(process.env.AQUA_STORE_GATE ?? 'on').trim().toLowerCase() !== 'off';
}

/** Paths that never touch user stores (mounted under the engine router). */
const OPEN_PREFIXES = ['/provider-health'];

/**
 * Why user stores must not be served right now, or null when they may.
 * @param {object} [status] getMirrorStatus() result (injectable for tests)
 */
export function storeGateReason(status = null) {
  if (!storeGateEnabled()) return null;
  let s = status;
  if (!s) { try { s = getMirrorStatus(); } catch { return null; } }
  if (!s?.enabled) return null;                         // no mirror configured: nothing to verify against
  if (s.sync?.status === 'unverified') return 'unverified';
  if (s.sync?.recoveryRequired) return 'recovery-required';
  return null;
}

export function storeGateMiddleware({ statusFn = null } = {}) {
  return (req, res, next) => {
    const p = String(req.path ?? '').replace(/^\/v1(?=\/|$)/, '');
    if (OPEN_PREFIXES.some(x => p === x || p.startsWith(`${x}/`))) return next();
    const reason = storeGateReason(statusFn ? statusFn() : null);
    if (!reason) return next();
    res.set('Retry-After', '30');
    return res.status(503).json({
      success: false, code: 'STORE_NOT_VERIFIED', retryable: true, reason,
      error: 'Your conversations and memory are temporarily unavailable while storage is verified. Nothing has been lost — please try again shortly.',
    });
  };
}
