/**
 * AQUA — one turn at a time per conversation (2026-11-16, audit D-14).
 *
 * The user and assistant messages of a turn are persisted at the END of the
 * turn. Two overlapping turns in one conversation (double send, a retry after
 * a timeout, two tabs) each built their context without the other and were
 * stored in completion order. This lease serialises turns PER CONVERSATION:
 *
 *   - A second turn waits (bounded, default 15 s — long enough for a stopped
 *     stream to unwind) for the first to finish, then reads the history that
 *     now includes it. If the first is still running after the wait, the
 *     second gets `null` and the route answers 409 CONVERSATION_BUSY
 *     (retryable). Nothing is reordered or lost.
 *   - Different conversations never block each other (one entry per id).
 *   - Releasing is idempotent; a lease older than the stale limit (default
 *     10 min, far beyond the provider retry budget) is reclaimed with a
 *     warning, so a turn that died without unwinding cannot lock a
 *     conversation forever. No deadlock: one lock per turn, never nested.
 *
 * SCOPE: in-process. Correct for the supported single-instance deployment
 * (the conversation store itself is single-writer — STORAGE_AND_DURABILITY_AUDIT).
 * It does NOT coordinate several instances; that needs the partition-backed
 * store, not Redis.
 */

const leases = new Map();   // conversationId → { token, since, waiters: Set<fn> }
let seq = 0;

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function turnLockEnabled(env = process.env) {
  return String(env.AQUA_CONVERSATION_TURN_LOCK ?? 'on').trim().toLowerCase() !== 'off';
}

function tryTake(id, staleMs) {
  const cur = leases.get(id);
  if (cur && Date.now() - cur.since < staleMs) return null;
  if (cur) console.warn(`[TURN-LOCK] stale lease reclaimed after ${Date.now() - cur.since}ms`);
  const token = ++seq;
  leases.set(id, { token, since: Date.now(), waiters: cur?.waiters ?? new Set() });
  return token;
}

function releaser(id, token) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const cur = leases.get(id);
    if (!cur || cur.token !== token) return;   // reclaimed meanwhile — not ours to release
    leases.delete(id);
    for (const wake of cur.waiters) { try { wake(); } catch { /* ignore */ } }
  };
}

/**
 * Acquire the turn lease for a conversation.
 * @returns {Promise<(() => void) | null>} a release function, or null when the
 *   conversation is still busy after `waitMs`. With the lock disabled, a no-op
 *   release is returned immediately.
 */
export async function acquireConversationTurn(conversationId, { waitMs, staleMs, env = process.env } = {}) {
  if (!conversationId || !turnLockEnabled(env)) return () => {};
  const id = String(conversationId);
  const wait = waitMs ?? num(env.AQUA_TURN_LOCK_WAIT_MS, 15_000);
  const stale = staleMs ?? num(env.AQUA_TURN_LOCK_STALE_MS, 10 * 60_000);
  const deadline = Date.now() + wait;
  for (;;) {
    const token = tryTake(id, stale);
    if (token) return releaser(id, token);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const cur = leases.get(id);
    if (!cur) continue;   // released between the attempt and now — try again
    await new Promise((resolve) => {
      const wake = () => { clearTimeout(t); cur?.waiters.delete(wake); resolve(); };
      const t = setTimeout(wake, Math.min(remaining, stale));
      t.unref?.();
      cur?.waiters.add(wake);
    });
  }
}

/** Diagnostics: how many conversations hold a lease (no ids). */
export function activeTurnLeases() { return leases.size; }

export function _resetTurnLocksForTests() { leases.clear(); }
