/**
 * AQUA — per-request durable write boundary (scalability Phase 4A)
 *
 * THE GAP. With stores on owner partitions, a request's changes (a forgotten
 * fact, the Mind state a chat turn observed, a renamed conversation) reached
 * the database ~50 ms AFTER the response, on each binding's debounce timer.
 * Between the two, the user had been told "done" while another API instance
 * still served the old state — and an API process that exited in that window
 * (OOM, a hard kill, CPU throttled by the platform between requests) lost the
 * change outright.
 *
 * THE BOUNDARY. Every request runs inside a write scope (AsyncLocalStorage).
 * Each partition binding records here the exact keys a request dirties — the
 * owner (owner stores), the entry key (keyed stores), the conversation id
 * (history). Before the response is sent, `flushScopeStrict` writes exactly
 * those keys — not other users' pending writes — and throws if any of them is
 * still pending (a failed or timed-out database write). Callers decide what a
 * failure means: a mutating request becomes a retryable 503; a read is logged.
 *
 * Bindings in off/shadow mode are skipped: their JSON-file path is unchanged
 * (single process; the SIGTERM flush and the Mongo mirror as before).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
const stats = { scopes: 0, flushes: 0, flushedKeys: 0, failures: 0, readWrites: 0, flushMs: [] };

/** Run `fn` inside a fresh write scope. */
export function runWithWriteScope(fn, label = null) {
  stats.scopes++;
  return als.run({ writes: new Map(), label }, fn);
}

/** Bindings call this whenever they mark a key dirty. No scope (a timer, the worker) → no-op. */
export function noteWrite(binding, key) {
  const s = als.getStore();
  if (!s || key == null || !binding) return;
  let set = s.writes.get(binding);
  if (!set) { set = new Set(); s.writes.set(binding, set); }
  set.add(String(key));
}

/** What the current scope has dirtied on AUTHORITATIVE bindings: [{ binding, keys }]. */
export function scopeWrites() {
  const s = als.getStore();
  if (!s) return [];
  const out = [];
  for (const [binding, keys] of s.writes) if (keys.size && binding.authoritative?.()) out.push({ binding, keys });
  return out;
}

export const hasScopeWrites = () => scopeWrites().length > 0;

/**
 * Write everything the current request dirtied, now. Throws FLUSH_INCOMPLETE
 * when any of those keys is still pending afterwards. Keys written are removed
 * from the scope, so a second call writes only what changed since.
 */
export async function flushScopeStrict({ timeoutMs = 10_000 } = {}) {
  const pending = scopeWrites();
  if (!pending.length) return { keys: 0, ms: 0 };
  const t0 = Date.now();
  stats.flushes++;
  let keys = 0;
  const stuck = [];
  let fenceLost = null;   // multi-instance connect safety: writes DISCARDED, not merely pending
  for (const { binding, keys: set } of pending) {
    const list = new Set(set);
    keys += list.size;
    const work = typeof binding.flushOnly === 'function' ? binding.flushOnly(list) : binding.flush();
    const outcome = await Promise.race([
      Promise.resolve(work).then(() => 'flushed', err => { if (err?.code === 'WRITE_FENCE_LOST' || err?.code === 'OWNER_DELETED') { fenceLost ??= err; for (const k of list) set.delete(k); } return 'failed'; }),
      new Promise(r => setTimeout(() => r('timeout'), timeoutMs).unref?.()),
    ]);
    const left = typeof binding.pendingAmong === 'function' ? binding.pendingAmong(list) : (binding.pendingCount?.() ?? 0);
    if (outcome !== 'flushed' || left > 0) stuck.push(`${binding.label ?? binding.storeKey}:${outcome}${left ? `/${left} pending` : ''}`);
    else for (const k of list) set.delete(k);
  }
  const ms = Date.now() - t0;
  stats.flushMs.push(ms); if (stats.flushMs.length > 2_000) stats.flushMs.shift();
  if (fenceLost) {
    // Explicit, NOT retryable: this request's writes were discarded because
    // this process lost the owner's connect lease (core/storage/writeFence.js).
    stats.failures++;
    // (or the account was deleted: OWNER_DELETED — the database barrier refused them).
    throw Object.assign(new Error(`request writes discarded: ${fenceLost.message}`), { code: fenceLost.code, retryable: false });
  }
  if (stuck.length) {
    stats.failures++;
    throw Object.assign(new Error(`request writes not durable: ${stuck.join(', ')}`), { code: 'FLUSH_INCOMPLETE', retryable: true, retryAfterMs: 2_000 });
  }
  stats.flushedKeys += keys;
  return { keys, ms };
}

export function noteReadWrites() { stats.readWrites++; }

export function requestWriteStats() {
  const ms = [...stats.flushMs].sort((a, b) => a - b);
  const pct = q => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] : null);
  return { scopes: stats.scopes, flushes: stats.flushes, flushedKeys: stats.flushedKeys, failures: stats.failures,
    readWrites: stats.readWrites, flushMs: { n: ms.length, p50: pct(0.5), p95: pct(0.95), max: ms.at(-1) ?? null } };
}
