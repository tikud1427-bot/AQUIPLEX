/**
 * AQUA Data Directory (P0 — persistence root cause fix)
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *   Every JSON store used to live at `path.join(process.cwd(), '.aqua-*.json')`.
 *   That ties user data (chat history, memory, mind, ledger, vectors, project
 *   index, artifacts) to the DEPLOY DIRECTORY. Any deploy strategy that
 *   replaces the app folder — fresh checkout, release-N symlink switch,
 *   container rebuild, `git clean`, moving the repo — silently deletes or
 *   orphans ALL user data. This is the "chats disappear after upgrade" bug.
 *
 * THE FIX
 *   One canonical data directory, resolved ONCE, outside the deploy tree:
 *
 *     1. AQUA_DATA_DIR env var        — explicit (containers, mounted volumes)
 *     2. <os home>/.aquiplex          — default: survives every redeploy
 *     3. <cwd>/.aquiplex-data        — last-resort fallback (no writable home)
 *
 *   Plus a ONE-TIME, LOSS-PROOF migration of every legacy cwd file into the
 *   data dir on boot:
 *     • copy legacy → dataDir (never move first — copy, then verify size)
 *     • verify byte length matches
 *     • rename legacy → `<file>.migrated-to-datadir` (kept as a backup,
 *       and prevents double-loading on next boot)
 *   If ANY step fails, the legacy file is left untouched and the store falls
 *   back to reading it in place — migration can never lose data.
 *
 * Existing-data precedence: if a file already exists in the data dir, it wins
 * and the legacy copy is left alone (it is stale by definition — the data dir
 * became the write target the moment it was populated).
 */
import fs   from 'fs';
import os   from 'os';
import path from 'path';

function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveDataDir() {
  const fromEnv = process.env.AQUA_DATA_DIR;
  if (fromEnv) {
    const dir = path.resolve(fromEnv);
    if (isWritableDir(dir)) return dir;
    console.error(`[DATA] AQUA_DATA_DIR="${fromEnv}" is not writable — falling back. Fix the mount/permissions to use it.`);
  }

  const home = os.homedir?.();
  if (home) {
    const dir = path.join(home, '.aquiplex');
    if (isWritableDir(dir)) return dir;
  }

  // Last resort: still inside cwd, but namespaced so it is at least
  // recognizable/backupable, and the deploy docs can point at it.
  const fallback = path.join(process.cwd(), '.aquiplex-data');
  fs.mkdirSync(fallback, { recursive: true });
  console.warn(`[DATA] No writable home directory — using ${fallback}. Set AQUA_DATA_DIR to a path outside the deploy tree so data survives redeploys.`);
  return fallback;
}

export const DATA_DIR = resolveDataDir();

/** Absolute path for a store file inside the canonical data directory. */
export function dataPath(filename) {
  return path.join(DATA_DIR, filename);
}

/**
 * One-time migration of a single legacy cwd file into the data dir.
 * Loss-proof by construction (copy → verify → rename-source-as-backup).
 * Returns the path the caller should LOAD from:
 *   • dataDir path when it exists (already migrated / freshly migrated / new)
 *   • legacy path only when migration could not complete (read-only fallback)
 */
export function migrateLegacyFile(filename, { legacyDir = process.cwd() } = {}) {
  const target = dataPath(filename);
  const legacy = path.join(legacyDir, filename);

  if (path.resolve(legacyDir) === path.resolve(DATA_DIR)) return target;

  try {
    const targetExists = fs.existsSync(target);
    const legacyExists = fs.existsSync(legacy);

    if (!legacyExists) return target;                 // nothing to migrate
    if (targetExists) {
      // Data dir already authoritative — leave the stale legacy copy alone
      // (it is itself a historical backup). Never double-load.
      return target;
    }

    const srcStat = fs.statSync(legacy);
    fs.copyFileSync(legacy, target);
    const dstStat = fs.statSync(target);
    if (dstStat.size !== srcStat.size) {
      // Verification failed — remove the bad copy, keep reading legacy.
      try { fs.unlinkSync(target); } catch { /* best effort */ }
      console.error(`[DATA] Migration size mismatch for ${filename} — keeping legacy file in place.`);
      return legacy;
    }

    // Success: keep the original as an on-disk backup, renamed so the next
    // boot doesn't see it as live data.
    try {
      fs.renameSync(legacy, `${legacy}.migrated-to-datadir`);
    } catch {
      /* rename is cosmetic — target already verified; worst case the stale
         legacy file stays named as-is and is simply never read again because
         the target now exists. */
    }
    console.log(`[DATA] Migrated ${filename} → ${DATA_DIR} (legacy kept as ${path.basename(legacy)}.migrated-to-datadir)`);
    return target;
  } catch (err) {
    console.error(`[DATA] Migration failed for ${filename}: ${err.message} — reading legacy file in place.`);
    return fs.existsSync(legacy) ? legacy : target;
  }
}

/**
 * Migrate a legacy DIRECTORY (e.g. `.aqua-artifacts/`) into the data dir.
 * Copy-then-marker, never delete. Returns the directory to USE.
 */
export function migrateLegacyDir(dirname, { legacyDir = process.cwd() } = {}) {
  const target = dataPath(dirname);
  const legacy = path.join(legacyDir, dirname);

  if (path.resolve(legacyDir) === path.resolve(DATA_DIR)) return target;

  try {
    const targetExists = fs.existsSync(target);
    const legacyExists = fs.existsSync(legacy);
    if (!legacyExists || targetExists) return target;

    fs.cpSync(legacy, target, { recursive: true });
    // Marker file instead of deleting/renaming a possibly-huge tree.
    try { fs.writeFileSync(path.join(legacy, '.migrated-to-datadir'), DATA_DIR, 'utf8'); } catch { /* cosmetic */ }
    console.log(`[DATA] Migrated directory ${dirname}/ → ${DATA_DIR}`);
    return target;
  } catch (err) {
    console.error(`[DATA] Directory migration failed for ${dirname}: ${err.message} — using legacy location.`);
    return fs.existsSync(legacy) ? legacy : target;
  }
}
