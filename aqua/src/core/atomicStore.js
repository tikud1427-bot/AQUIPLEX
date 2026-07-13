/**
 * AQUA Atomic Store (Phase 3b — durability hardening)
 * ─────────────────────────────────────────────────────────────────────────────
 * The single, shared persistence primitive for every JSON-backed store
 * (mindStore, conversationStore, projectIndex, learningLedger, vectorStore,
 * projectMemory). It replaces the copy-pasted `saveTimer + setTimeout(500) +
 * fs.writeFileSync` block that lived in all six, and fixes the two failure
 * modes that block on that block:
 *
 *   1. CORRUPTION ON CRASH.  fs.writeFileSync(FILE, json) writes in place. If
 *      the process dies mid-write (deploy, OOM, crash), FILE is left truncated
 *      or half-written — and the next boot's JSON.parse throws, silently
 *      wiping the ENTIRE store (memory, cognitive models, the index...). Fix:
 *      write to a sibling temp file, fsync-free, then rename() it over the
 *      target. rename(2) is atomic on a POSIX filesystem when source and
 *      destination are on the SAME filesystem — and the temp sits in the same
 *      directory, so it always is. A reader therefore sees either the complete
 *      old file or the complete new one, never a partial write.
 *
 *   2. EVENT-LOOP BLOCKING.  writeFileSync is synchronous: a flush stalls
 *      EVERY concurrent request for the duration of the write. The project
 *      index is ~2.8 MB and is rewritten whole on each change — a multi-
 *      millisecond stall on the one thread that serves all users. Fix: the
 *      write path is fully async (fs.promises.writeFile + rename), so flushes
 *      no longer block request handling.
 *
 * createDebouncedWriter() preserves the original semantics — coalesce bursts
 * of writes into one flush ~debounceMs later, always persisting the LATEST
 * state — and adds an in-flight guard so a mutation that arrives DURING an
 * async flush is not lost: it re-flushes once the current write completes.
 *
 * This module is also the seam the Phase 3 durability migration slots into:
 * all six stores now persist through ONE interface, so a Postgres/Mongo
 * adapter is a change here, not in six places.
 */
import fs   from 'fs';
import path from 'path';

let tmpCounter = 0;
function tmpPathFor(file) {
  // Same directory as the target → guaranteed same filesystem → atomic rename.
  return path.join(path.dirname(file), `.${path.basename(file)}.tmp.${process.pid}.${tmpCounter++}`);
}

/**
 * Atomically write a file: temp-then-rename. NEVER leaves a partial target.
 * Async — does not block the event loop. Rejects on failure (best-effort temp
 * cleanup first) so callers can log; the existing target file is untouched on
 * failure because the rename never happened.
 * @param {string} file
 * @param {string} data
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(file, data) {
  const tmp = tmpPathFor(file);
  try {
    await fs.promises.writeFile(tmp, data, 'utf8');
    await fs.promises.rename(tmp, file);
  } catch (err) {
    try { await fs.promises.unlink(tmp); } catch { /* temp may not exist */ }
    throw err;
  }
}

/**
 * Synchronous atomic write — same temp-then-rename crash-safety, for shutdown
 * hooks, one-off config writes, and tests where a synchronous flush is needed.
 * @param {string} file
 * @param {string} data
 */
export function atomicWriteFileSync(file, data) {
  const tmp = tmpPathFor(file);
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* temp may not exist */ }
    throw err;
  }
}

/**
 * Debounced, atomic, non-blocking writer for a single file.
 *
 * @param {string} file
 * @param {object} [opts]
 * @param {number} [opts.debounceMs=500]  coalescing window (matches the prior tier)
 * @param {(err: Error) => void} [opts.onError]  called on a failed flush (default: warn)
 * @returns {{ schedule: (serialize: () => string) => void, flush: () => void, cancel: () => void, isPending: () => boolean }}
 *
 *   schedule(serialize) — request a write. `serialize` is called at FLUSH time
 *     (not now), so it snapshots the store's latest state — same behavior as
 *     the old setTimeout callback. Bursts within the window coalesce to one
 *     write. Safe to call as often as the store mutates.
 *
 *   flush() — synchronous, immediate atomic write of the pending state (for
 *     shutdown / tests). Clears any pending timer.
 *
 *   cancel() — drop a pending write without writing (for __resetForTests).
 */
export function createDebouncedWriter(file, { debounceMs = 500, onError } = {}) {
  let timer   = null;
  let writing = false;
  let dirty   = false;
  let serializeFn = null;

  const warn = onError || (err => console.warn(`[STORE] atomic write failed for ${path.basename(file)}: ${err.message}`));

  async function runFlush() {
    timer = null;
    if (writing) return;         // a flush is already draining; it will pick up `dirty`
    writing = true;
    try {
      while (dirty) {
        dirty = false;
        const fn = serializeFn;
        let data;
        try {
          data = fn();            // snapshot latest state (sync)
        } catch (err) {
          warn(err);
          continue;
        }
        try {
          await atomicWriteFile(file, data);
        } catch (err) {
          warn(err);              // keep draining; a later schedule may retry
        }
      }
    } finally {
      writing = false;
    }
  }

  return {
    schedule(serialize) {
      serializeFn = serialize;
      dirty = true;
      if (timer || writing) return;   // already scheduled, or in-flight (loop re-runs)
      timer = setTimeout(runFlush, debounceMs);
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (dirty && serializeFn) {
        dirty = false;
        try {
          atomicWriteFileSync(file, serializeFn());
        } catch (err) {
          warn(err);
        }
      }
    },
    cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
      dirty = false;
    },
    isPending() { return !!timer || writing || dirty; },
  };
}
