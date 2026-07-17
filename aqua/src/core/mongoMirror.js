/**
 * AQUA Mongo Mirror (P0 — deploy-survival root cause fix)
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *   dataDir.js (the previous P0) moved every JSON store out of the deploy
 *   tree into `~/.aquiplex`. That fixes "new checkout replaced my data" on a
 *   VM. It does NOT fix Render: Render rebuilds the ENTIRE container
 *   filesystem — including $HOME — from the build image on every deploy (and
 *   may do so on restarts/instance moves). Anything written at runtime to
 *   local disk is gone. `.aqua-history.json`, `.aqua-mind.json`,
 *   `.aqua-vectors.json`, `.aqua-ledger.json`, `.aqua-index.json`,
 *   `.aqua-projects.json`, `.aqua-attachments.json` — all of it.
 *
 * THE FIX
 *   MongoDB (already provisioned — users/billing/sessions live there) becomes
 *   the durable copy. Local files stay the hot path — every store keeps its
 *   exact load/save code — this module only:
 *
 *     1. HYDRATES at boot: before any store loads, copy each mirrored doc
 *        from Mongo back into DATA_DIR (collection `aqua_kv`,
 *        one doc per store file: { _id: filename, json, updatedAt }).
 *        Newer-wins: a doc only overwrites a local file when the doc is
 *        newer than the file's mtime (protects a warm instance that
 *        restarted without losing disk).
 *     2. MIRRORS on write: atomicStore.js calls mirrorWrite() after every
 *        successful file flush. Upserts are coalesced per file (latest JSON
 *        wins) and fully fire-and-forget — a Mongo blip can never fail or
 *        slow a user request.
 *     3. DRAINS on shutdown: SIGTERM (every Render deploy) waits ≤5s for
 *        in-flight upserts so the last messages of a session reach Mongo.
 *
 *   No MONGO_URI (standalone aqua, tests, dev) → module is a silent no-op and
 *   everything behaves exactly as before: file-only persistence.
 *
 * ZERO NEW DEPENDENCIES
 *   mongoose is loaded via dynamic import and resolves from the PLATFORM's
 *   node_modules (aqua runs in-process with the platform, Node walks up).
 *   Standalone aqua without mongoose installed → clean warn + no-op.
 *
 * DOCUMENT SIZE
 *   Mongo caps documents at 16 MB. Anything over MAX_MIRROR_BYTES (12 MB) is
 *   skipped with a loud warning instead of throwing — the file path keeps
 *   working, the doc simply stays at its last mirrorable state.
 */
import path from 'path';
import fs   from 'fs';

const COLLECTION       = 'aqua_kv';
const MAX_MIRROR_BYTES = 12_000_000;
const CONNECT_TIMEOUT  = 6_000;

const state = {
  enabled:    false,
  collection: null,        // mongodb Collection (native driver via mongoose)
  connecting: null,        // Promise while a connection attempt is in flight
  pending:    new Map(),   // filename → latest json (coalesced, not yet written)
  inflight:   new Map(),   // filename → Promise of the running upsert
  failedOnce: false,
};

function log(msg)  { console.log(`[MIRROR] ${msg}`); }
function warn(msg) { console.warn(`[MIRROR] ${msg}`); }

// ── Connection ────────────────────────────────────────────────────────────────

async function connect() {
  if (state.collection) return state.collection;
  if (state.connecting) return state.connecting;

  const uri = process.env.MONGO_URI;
  if (!uri || process.env.AQUA_DISABLE_MONGO_MIRROR === '1') return null;

  state.connecting = (async () => {
    let mongoose;
    try {
      mongoose = (await import('mongoose')).default;
    } catch {
      warn('mongoose not resolvable — file-only persistence (standalone mode).');
      return null;
    }
    try {
      // Own connection: the mirror must be ready BEFORE the platform's
      // mongoose.connect() runs (stores hydrate at import time).
      const conn = await mongoose.createConnection(uri, {
        serverSelectionTimeoutMS: CONNECT_TIMEOUT,
        socketTimeoutMS: 45_000,
      }).asPromise();
      state.collection = conn.db.collection(COLLECTION);
      state.enabled    = true;
      log(`connected — durable store: MongoDB collection "${COLLECTION}"`);
      return state.collection;
    } catch (err) {
      if (!state.failedOnce) {
        state.failedOnce = true;
        warn(`connect failed (${err.message}) — file-only persistence. Data will NOT survive a Render deploy until MONGO_URI is reachable.`);
      }
      return null;
    } finally {
      state.connecting = null;
    }
  })();
  return state.connecting;
}

// ── Boot hydration ────────────────────────────────────────────────────────────

/**
 * Restore every mirrored store file into `dataDir` before stores load.
 * Newer-wins per file (doc.updatedAt vs file mtime). Never throws.
 * @param {string} dataDir  resolved DATA_DIR from dataDir.js
 * @returns {Promise<{restored: number, kept: number, total: number}>}
 */
export async function hydrateFromMongo(dataDir) {
  const empty = { restored: 0, kept: 0, total: 0 };
  try {
    const col = await connect();
    if (!col) return empty;

    const docs = await col.find({}).toArray();
    let restored = 0, kept = 0;

    for (const doc of docs) {
      const filename = String(doc._id ?? '');
      // Defense: _id is a filename WE wrote (basename form). Refuse anything
      // that could escape the data dir.
      if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        warn(`skipping suspicious doc _id=${JSON.stringify(filename)}`);
        continue;
      }
      if (typeof doc.json !== 'string') continue;

      const target = path.join(dataDir, filename);
      let fileMtime = 0;
      try { fileMtime = fs.statSync(target).mtimeMs; } catch { /* absent */ }

      const docTime = Number(doc.updatedAt ?? 0);
      if (fileMtime && fileMtime >= docTime) { kept++; continue; }

      // Atomic write (temp+rename) — same guarantee as atomicStore, inlined
      // to avoid an import cycle (atomicStore imports this module).
      const tmp = path.join(dataDir, `.${filename}.hydrate.${process.pid}`);
      try {
        fs.writeFileSync(tmp, doc.json, 'utf8');
        fs.renameSync(tmp, target);
        restored++;
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* temp may not exist */ }
        warn(`could not restore ${filename}: ${err.message}`);
      }
    }

    log(`hydration: ${restored} restored, ${kept} kept (local newer), ${docs.length} mirrored doc(s) total`);
    return { restored, kept, total: docs.length };
  } catch (err) {
    warn(`hydration failed (${err.message}) — continuing with local files only.`);
    return empty;
  }
}

// ── Write mirroring ───────────────────────────────────────────────────────────

async function upsertLoop(filename) {
  // Drain the coalesced latest value; another value may land mid-write.
  while (state.pending.has(filename)) {
    const json = state.pending.get(filename);
    state.pending.delete(filename);
    try {
      const col = await connect();
      if (!col) return;
      await col.updateOne(
        { _id: filename },
        { $set: { json, updatedAt: Date.now() } },
        { upsert: true },
      );
    } catch (err) {
      warn(`upsert failed for ${filename}: ${err.message} — will retry on next write.`);
      return; // drop this round; the next schedule() retries with fresher data
    }
  }
}

/**
 * Mirror one store file's serialized JSON to Mongo. Fire-and-forget,
 * coalesced (bursts collapse to the latest state). Called by atomicStore
 * after every successful file flush.
 * @param {string} filePath  absolute path of the store file just written
 * @param {string} json      the exact bytes written
 */
export function mirrorWrite(filePath, json) {
  const configured = state.collection || (process.env.MONGO_URI && process.env.AQUA_DISABLE_MONGO_MIRROR !== '1');
  if (!configured) return;
  if (typeof json !== 'string') return;
  if (Buffer.byteLength(json, 'utf8') > MAX_MIRROR_BYTES) {
    warn(`${path.basename(filePath)} is ${(Buffer.byteLength(json) / 1e6).toFixed(1)} MB > ${MAX_MIRROR_BYTES / 1e6} MB Mongo mirror cap — skipped (file copy still written).`);
    return;
  }

  const filename = path.basename(filePath);
  state.pending.set(filename, json);

  if (!state.inflight.has(filename)) {
    const p = upsertLoop(filename).finally(() => state.inflight.delete(filename));
    state.inflight.set(filename, p);
  }
}

/**
 * Wait for all in-flight/pending upserts to finish, capped at `ms`.
 * Called by atomicStore's SIGTERM hook so a deploy's final messages land.
 */
export async function drainMirror(ms = 5_000) {
  if (!state.inflight.size && !state.pending.size) return;
  const all = Promise.all([...state.inflight.values()]);
  await Promise.race([all, new Promise(r => setTimeout(r, ms))]);
}

// ── Test seam ─────────────────────────────────────────────────────────────────
// Inject a fake collection ({ find().toArray(), updateOne }) so the full
// write → wipe → hydrate lifecycle is testable without a mongod binary.
export function __setCollectionForTests(fakeCollection) {
  state.collection = fakeCollection;
  state.enabled    = !!fakeCollection;
  state.failedOnce = false;
}
export function __resetForTests() {
  state.collection = null;
  state.enabled = false;
  state.connecting = null;
  state.pending.clear();
  state.inflight.clear();
  state.failedOnce = false;
}
