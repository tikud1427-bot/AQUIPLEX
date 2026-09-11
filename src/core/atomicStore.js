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
import { mirrorWrite, drainMirror } from './mongoMirror.js';
// E3/PR-3 — every byte that leaves or enters a store now passes through an
// adapter. The JSON adapter is the same filesystem code that was inline here,
// moved; nothing about the public API or the semantics changed. See
// src/core/storage/index.js for why the seam is keyed by path.
import { getAdapter, flushStorage } from './storage/index.js';
import { drainJobs, drainLine } from './jobs/jobRegistry.js';

// ── P0 durability additions ──────────────────────────────────────────────────
// loadJsonFile()  — corrupt-safe load: NEVER lets a bad parse wipe a store.
//                   Corrupt file is preserved (renamed aside), `.bak` is tried,
//                   caller gets null only when nothing readable exists.
// backupOnce()    — one boot-time snapshot per file per process: before the
//                   first write of a session, copy the last-known-good file to
//                   `<file>.bak`. This is the "automatic backup before
//                   destructive operations" guarantee for every store.
// wrap/unwrapStore — schema-version envelope. Loaders accept BOTH the legacy
//                   bare-object shape (schema 0) and the envelope, so old
//                   files keep loading forever; version mismatches are logged
//                   and the file is snapshotted before the first overwrite.

const _bootBackupDone = new Set();

// ── Shutdown flush (P0) ───────────────────────────────────────────────────────
// Deploys stop the process with SIGTERM. Debounced writers can be holding up
// to `debounceMs` of un-flushed mutations (the user's most recent messages).
// Every writer auto-registers here; one set of signal hooks synchronously
// flushes them all before the process dies. Handlers are installed lazily on
// the first writer so importing this module has zero side effects.
const _allWriters = new Set();
let _shutdownHooked = false;

function flushAllWriters(reason) {
  let flushed = 0;
  for (const w of _allWriters) {
    try {
      if (w.isPending()) { w.flush(); flushed++; }
    } catch { /* a failed flush must never block shutdown */ }
  }
  if (flushed) console.log(`[STORE] shutdown flush (${reason}): ${flushed} store(s) persisted`);
}

function hookShutdownOnce() {
  if (_shutdownHooked) return;
  _shutdownHooked = true;
  process.on('beforeExit', () => flushAllWriters('beforeExit'));
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      flushAllWriters(sig);
      // P0 (Render) — a deploy IS a SIGTERM. The sync file flush above queued
      // Mongo upserts (mirrorWrite); give them ≤5s to land so the session's
      // last messages survive the container swap. Never blocks longer.
      const code = sig === 'SIGINT' ? 130 : 143; // conventional codes; re-raising would loop
      // E3/PR-5 — the storage adapter may write BEHIND a cache (the Postgres
      // adapter reports syncDurable:false, so its writeSync has only reached
      // memory when it returns). The sync flush above therefore does not mean
      // the bytes are safe; flushStorage awaits the deferred writes. Run
      // alongside the Mongo drain, not after it — a deploy will not wait twice.
      // E4/PR-1 — deferred post-turn work joins the drain. It was invisible
      // here until now: measured, 3 of 3 outstanding jobs lost on SIGTERM
      // with nothing tracking them, so every deploy discarded the
      // understanding side-effects of whatever turns were in flight.
      //
      // Run alongside the others, not after — a deploy will not wait three
      // times, and the platform sends SIGKILL on its own schedule regardless.
      Promise.allSettled([
        drainMirror(5_000),
        flushStorage(5_000),
        drainJobs(5_000).then(r => { const line = drainLine(r); if (r.drained || r.timedOut) console.log(line); }),
      ]).finally(() => process.exit(code));
    });
  }
}

/**
 * Copy `file` → `file.bak` once per process (before this process's first
 * write). Cheap, synchronous, best-effort — a failed backup must never block
 * a save. The .bak therefore always holds the last state written by the
 * PREVIOUS process generation: exactly what you want back after a bad deploy.
 */
export function backupOnce(file) {
  if (_bootBackupDone.has(file)) return;
  _bootBackupDone.add(file);
  try {
    const S = getAdapter();
    if (S.existsSync(file)) S.copySync(file, `${file}.bak`);
  } catch (err) {
    console.warn(`[STORE] boot backup failed for ${path.basename(file)}: ${err.message}`);
  }
}

/**
 * Read + parse a JSON store file without ever destroying data:
 *   • missing file          → null (fresh store)
 *   • parses cleanly        → parsed value
 *   • corrupt               → preserve as `<file>.corrupt-<ts>`, try `.bak`;
 *                             recovered .bak is returned, else null.
 * The original corrupt bytes are ALWAYS kept on disk for manual recovery.
 */
export function loadJsonFile(file, { label = path.basename(file) } = {}) {
  let raw;
  try {
    raw = getAdapter().readSync(file);
    if (raw === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[STORE] ${label}: read failed (${err.message})`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const aside = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, aside); } catch { try { getAdapter().copySync(file, aside); } catch { /* keep going */ } }
    console.error(`[STORE] ${label}: file is corrupt — preserved as ${path.basename(aside)}, attempting .bak recovery`);
    try {
      const bak = JSON.parse(getAdapter().readSync(`${file}.bak`) ?? '');
      console.warn(`[STORE] ${label}: RECOVERED from ${path.basename(file)}.bak`);
      return bak;
    } catch {
      console.error(`[STORE] ${label}: no usable .bak — starting empty. Corrupt snapshot kept for manual recovery.`);
      return null;
    }
  }
}

/** Envelope a store payload with schema metadata for forward-safe loading. */
export function wrapStore(schema, data) {
  return { __aqua: { schema, savedAt: Date.now() }, data };
}

/**
 * Accepts either the schema envelope or a legacy bare object (treated as
 * schema 0). NEVER refuses to load on a version mismatch — a newer-schema
 * file (e.g. after a rollback) is snapshotted aside first, then loaded
 * best-effort, so a rollback can't wipe forward data.
 */
export function unwrapStore(parsed, { expected, file, label } = {}) {
  if (parsed == null) return { schema: null, data: null };
  const isEnvelope = typeof parsed === 'object' && parsed.__aqua && 'data' in parsed;
  const schema = isEnvelope ? (parsed.__aqua.schema ?? 0) : 0;
  const data   = isEnvelope ? parsed.data : parsed;
  if (expected != null && schema > expected && file) {
    const aside = `${file}.v${schema}.bak`;
    try {
      if (!getAdapter().existsSync(aside)) getAdapter().copySync(file, aside);
      console.warn(`[STORE] ${label ?? path.basename(file)}: file schema v${schema} > expected v${expected} (rollback?) — snapshot kept at ${path.basename(aside)}, loading best-effort.`);
    } catch { /* snapshot is best-effort */ }
  }
  return { schema, data };
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
  await getAdapter().write(file, data);
}

/**
 * Synchronous atomic write — same temp-then-rename crash-safety, for shutdown
 * hooks, one-off config writes, and tests where a synchronous flush is needed.
 * @param {string} file
 * @param {string} data
 */
export function atomicWriteFileSync(file, data) {
  getAdapter().writeSync(file, data);
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
          mirrorWrite(file, data);  // P0 (Render) — durable copy → MongoDB, fire-and-forget
        } catch (err) {
          warn(err);              // keep draining; a later schedule may retry
        }
      }
    } finally {
      writing = false;
    }
  }

  const api = {
    schedule(serialize) {
      backupOnce(file);               // last-good snapshot before this process's first write
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
          const data = serializeFn();
          atomicWriteFileSync(file, data);
          mirrorWrite(file, data);  // P0 (Render) — the SIGTERM drain below awaits this
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
  _allWriters.add(api);
  hookShutdownOnce();
  return api;
}
