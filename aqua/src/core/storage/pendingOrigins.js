/**
 * Safety Fix 3 — the ORIGINS of a store binding's pending writes.
 *
 * A pending write (one dirty key of a binding) remembers, from the moment it is
 * CREATED until it is written:
 *   · the connect-operation fences it was created under (writeFence.originFor —
 *     the operation whose work is running when markDirty/markDeleted is called);
 *   · whether any change to it was made OUTSIDE an operation ("plain").
 * The flush then runs with exactly these origins (writeFence.withWriteOrigins),
 * whatever context the debounce timer, retry, shutdown or request flush runs in.
 *
 * plan(key):
 *   lost origin, no plain change → REFUSE the whole write (work of an
 *                                  invalidated operation only): discarded.
 *   lost origin + plain change   → write it WITHOUT any origin: external items
 *                                  are frozen to the database's version (the
 *                                  invalidated work's external changes are
 *                                  refused), the unrelated changes persist.
 *   valid origins only / mixed   → write it carrying the valid origins; the
 *     with plain                   transaction proves each one (checkFenceOn).
 *   no origin                    → a plain write (external items frozen).
 */
import { originFor } from './writeFence.js';

export function createOriginTracker() {
  const origins = new Map();   // key → Set<fence>
  const plain = new Set();     // keys changed outside any operation since their last write

  return {
    /** A change to `key` (owned by `owner`) was made now. */
    note(key, owner) {
      const f = originFor(owner);
      if (!f) { plain.add(key); return; }
      let s = origins.get(key);
      if (!s) { s = new Set(); origins.set(key, s); }
      s.add(f);
    },
    /** What the next write of `key` carries (see the header). */
    plan(key) {
      const all = [...(origins.get(key) ?? [])];
      const lost = all.filter(f => f.lost);
      const valid = all.filter(f => !f.lost);
      const isPlain = plain.has(key);
      if (lost.length && !isPlain) return { refuse: lost[0].lost, origins: [], lost, valid, plain: isPlain };
      return { refuse: null, origins: lost.length ? [] : valid, lost, valid, plain: isPlain };
    },
    /** Start writing `key`: its plan, and the origins are taken (a change made meanwhile starts a new set). */
    take(key) { const p = this.plan(key); origins.delete(key); plain.delete(key); return p; },
    /** The write failed for an ordinary reason (it will be retried): give the origins back. */
    restore(key, p) {
      for (const f of [...p.lost, ...p.valid]) { let s = origins.get(key); if (!s) { s = new Set(); origins.set(key, s); } s.add(f); }
      if (p.plain) plain.add(key);
    },
    /** The write of `key` landed (or was discarded): forget its origins. */
    clear(key) { origins.delete(key); plain.delete(key); },
    /** Keys with a pending write created under `fence`. */
    keysOf(fence) { return [...origins].filter(([, s]) => s.has(fence)).map(([k]) => k); },
    isPlain: key => plain.has(key),
    originsOf: key => [...(origins.get(key) ?? [])],
    reset() { origins.clear(); plain.clear(); },
  };
}
