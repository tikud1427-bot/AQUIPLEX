/**
 * AQUA Storage — JSON file adapter
 * Blueprint E3/PR-3
 *
 * The filesystem behaviour that has always been inside `atomicStore.js`, moved
 * behind an interface and NOT otherwise changed. Temp-then-rename, the same
 * unlink-on-failure, the same sync and async pairs.
 *
 * WHY THE KEY IS A PATH
 * ---------------------
 * Every caller passes an absolute file path today. Keying the interface by
 * path means the 19 modules that use `atomicStore` do not change at all in
 * this PR — the refactor stops at the seam it was designed for.
 *
 * A Postgres adapter will map that path to `(owner, store)` with
 * `path.basename(key)`; the store filenames are already stable and unique
 * (`.aqua-evidence.json`, `.aqua-mind.json`, …). Introducing a store-name key
 * would mean editing all 19 call sites AND swapping the backend in one change,
 * which is the second risky thing the blueprint's E3 ordering forbids.
 */
import fs   from 'fs';
import path from 'path';

/**
 * The ORIGINAL scheme from atomicStore, preserved byte for byte.
 *
 * Two properties are load-bearing and were nearly lost in this refactor:
 *   · the temp file sits in the SAME DIRECTORY as the target, which is what
 *     makes rename(2) atomic — across filesystems it is a copy, not a rename
 *   · a monotonic COUNTER, not a timestamp. Two writes to one file inside the
 *     same millisecond would share a `Date.now()` temp path and race; the
 *     counter cannot collide. The first version of this adapter used
 *     Date.now() and that is exactly the kind of "equivalent" rewrite a
 *     zero-behaviour-change PR exists to prevent.
 */
let tmpCounter = 0;
const tmpPathFor = key =>
  path.join(path.dirname(key), `.${path.basename(key)}.tmp.${process.pid}.${tmpCounter++}`);

/**
 * WINDOWS: rename() onto a file that another rename (or a reader) holds open
 * fails with EPERM / EACCES / EBUSY instead of replacing it atomically as
 * POSIX rename(2) does. Two concurrent writes to one store therefore threw on
 * a Windows dev machine (adapterContract "concurrent writes … last value
 * wins"). The condition is transient, so retry briefly — the same remedy
 * graceful-fs applies. POSIX never takes this branch: rename there does not
 * raise these codes for this case.
 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DEADLINE_MS = 2_000;
const isWin = process.platform === 'win32';

async function renameWithRetry(from, to) {
  const started = performance.now();
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try { return await fs.promises.rename(from, to); } catch (err) {
      if (!isWin || !RENAME_RETRY_CODES.has(err?.code) || performance.now() - started > RENAME_RETRY_DEADLINE_MS) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function renameSyncWithRetry(from, to) {
  const started = performance.now();
  for (;;) {
    try { return fs.renameSync(from, to); } catch (err) {
      if (!isWin || !RENAME_RETRY_CODES.has(err?.code) || performance.now() - started > RENAME_RETRY_DEADLINE_MS) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

export function createJsonFileAdapter() {
  return {
    id: 'json-file',

    /**
     * writeSync has hit the DISK by the time it returns.
     *
     * Declared rather than assumed, because E3/PR-4's Postgres adapter cannot
     * offer the same guarantee — Node has no synchronous Postgres client, so
     * that adapter writes behind a cache and reports `false`. A caller that
     * needs durability on return (the SIGTERM drain) has to be able to ask.
     */
    syncDurable: true,

    existsSync(key) { return fs.existsSync(key); },

    readSync(key) {
      try {
        return fs.readFileSync(key, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },

    /** Temp-then-rename: a reader sees the complete old file or the complete new one. */
    async write(key, data) {
      const tmp = tmpPathFor(key);
      try {
        await fs.promises.writeFile(tmp, data, 'utf8');
        await renameWithRetry(tmp, key);
      } catch (err) {
        try { await fs.promises.unlink(tmp); } catch { /* temp may not exist */ }
        throw err;
      }
    },

    writeSync(key, data) {
      const tmp = tmpPathFor(key);
      try {
        fs.writeFileSync(tmp, data, 'utf8');
        renameSyncWithRetry(tmp, key);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* temp may not exist */ }
        throw err;
      }
    },

    copySync(from, to) { fs.copyFileSync(from, to); },
  };
}
