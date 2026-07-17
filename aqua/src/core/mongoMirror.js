/**
 * AQUA Mongo Mirror (P0 — deploy-survival root cause fix, hardened)
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *   dataDir.js (the previous P0) moved every JSON store out of the deploy
 *   tree into `~/.aquiplex`. That fixes "new checkout replaced my data" on a
 *   VM. It does NOT fix Render: Render rebuilds the ENTIRE container
 *   filesystem — including $HOME — from the build image on every deploy (and
 *   may do so on restarts/instance moves). Anything written at runtime to
 *   local disk is gone.
 *
 * THE FIX
 *   MongoDB (already provisioned — users/billing/sessions live there) is the
 *   durable copy. Local files stay the hot path — every store keeps its exact
 *   load/save code — this module only:
 *
 *     1. HYDRATES at boot (dataDir.js top-level await): restore each mirrored
 *        doc from collection `aqua_kv` into DATA_DIR before any store loads.
 *        Newer-wins per file (protects a warm instance that restarted
 *        without losing its disk).
 *     2. MIRRORS on write: atomicStore.js calls mirrorWrite() after every
 *        successful file flush. Coalesced per file, fully fire-and-forget —
 *        a Mongo blip can never fail or slow a user request.
 *     3. DRAINS on shutdown: SIGTERM (every Render deploy) waits ≤5s for
 *        in-flight upserts so the session's last messages reach Mongo.
 *
 * HARDENING (risk fixes)
 *   • CANARY — on the first real connection the mirror writes a canary doc
 *     and reads it back. `[MIRROR] round-trip verified` in the deploy log =
 *     the untestable-in-CI driver path is proven on YOUR cluster, every boot.
 *   • CHUNKING — Mongo caps a document at 16 MB. Stores over CHUNK_BYTES are
 *     split into part docs + a generation-stamped manifest (chunks written
 *     first, manifest last, so hydration can never assemble a torn write).
 *     Nothing is ever "too big to survive a deploy" anymore.
 *   • WRITER HEARTBEAT — the mirror is whole-file last-writer-wins, which is
 *     only safe single-instance. A 30s heartbeat on a lock doc detects a
 *     SECOND live writer (scaled-out Render) and raises a loud, persistent
 *     alarm in logs + /provider-health instead of silently eating writes.
 *     Normal deploy overlap (old instance's final seconds) stays quiet via a
 *     3-strike grace.
 *   • STATUS — getMirrorStatus() feeds /provider-health: enabled/connected/
 *     canary/lastWriteAt/lastError/conflict at a glance after any deploy.
 *
 * ZERO NEW DEPENDENCIES — mongoose is dynamic-imported and resolves from the
 * platform's node_modules (aqua runs in-process). Standalone aqua without it
 * → clean warn + file-only. No MONGO_URI → silent no-op (tests, dev).
 */
import path from 'path';
import fs   from 'fs';
import os   from 'os';
import crypto from 'crypto';

const COLLECTION       = 'aqua_kv';
const CONNECT_TIMEOUT  = 6_000;
const CANARY_ID        = '.aqua-mirror-canary';
const LOCK_ID          = '.aqua-mirror-writer';
const HEARTBEAT_MS     = 30_000;
const CONFLICT_STRIKES = 3;      // foreign beats before alarming (deploy-overlap grace)

// Chunking: stay well under Mongo's 16 MB/doc. Parts are sliced by CHARS at
// CHUNK_BYTES/4 — worst-case UTF-8 is 4 bytes/char, so a part can never
// exceed CHUNK_BYTES; reassembly is plain string concat (byte-exact).
const CHUNK_BYTES = Number(process.env.AQUA_MIRROR_CHUNK_BYTES) || 10_000_000;
const CHUNK_CHARS = Math.max(1, Math.floor(CHUNK_BYTES / 4));

const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;

const state = {
  enabled:     false,
  collection:  null,        // mongodb Collection (native driver via mongoose)
  connecting:  null,
  pending:     new Map(),   // filename → latest json (coalesced)
  inflight:    new Map(),   // filename → Promise of the running upsert loop
  failedOnce:  false,
  // observability / hardening
  canary:      null,        // 'ok' | 'failed' | null (not attempted)
  lastWriteAt: null,
  lastError:   null,
  conflict:    false,
  conflictWith: null,
  foreignBeats: 0,
  lastBeatAt:  0,
  heartbeatTimer: null,
};

function log(msg)  { console.log(`[MIRROR] ${msg}`); }
function warn(msg) { console.warn(`[MIRROR] ${msg}`); }

// ── Connection + canary + heartbeat ──────────────────────────────────────────

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
      log(`connected — durable store: MongoDB collection "${COLLECTION}" instance=${INSTANCE_ID}`);
      await verifyRoundTrip();     // canary: prove THIS cluster round-trips, every boot
      startHeartbeat();            // multi-writer detection
      return state.collection;
    } catch (err) {
      if (!state.failedOnce) {
        state.failedOnce = true;
        state.lastError  = err.message;
        warn(`connect failed (${err.message}) — file-only persistence. Data will NOT survive a Render deploy until MONGO_URI is reachable.`);
      }
      return null;
    } finally {
      state.connecting = null;
    }
  })();
  return state.connecting;
}

/** Write a canary doc and read it back. Converts "driver path untested" into
 *  "self-verified on every real boot" — grep the deploy log for the line. */
async function verifyRoundTrip() {
  try {
    const nonce = `${INSTANCE_ID}:${Date.now()}`;
    await state.collection.updateOne(
      { _id: CANARY_ID },
      { $set: { json: nonce, updatedAt: Date.now(), instanceId: INSTANCE_ID } },
      { upsert: true },
    );
    const back = await state.collection.findOne({ _id: CANARY_ID });
    if (back?.json === nonce) {
      state.canary = 'ok';
      log('round-trip verified — writes to this cluster are durable ✓');
    } else {
      state.canary = 'failed';
      warn(`round-trip verification FAILED (read back ${JSON.stringify(back?.json)}) — investigate before trusting deploy survival.`);
    }
  } catch (err) {
    state.canary = 'failed';
    warn(`round-trip verification errored: ${err.message}`);
  }
}

/** One heartbeat: detect a second LIVE writer, then stamp the lock. A foreign
 *  instance id that keeps beating between OUR beats = concurrent writers =
 *  whole-file last-writer-wins is now lossy → alarm loudly and persistently
 *  (logs + /provider-health). Deploy overlap (old instance finishing up)
 *  produces 1–2 foreign beats and stays under the strike threshold. */
async function heartbeatOnce() {
  const col = state.collection;
  if (!col) return;
  try {
    const now  = Date.now();
    const lock = await col.findOne({ _id: LOCK_ID });
    if (lock && lock.instanceId && lock.instanceId !== INSTANCE_ID && Number(lock.ts) > state.lastBeatAt) {
      state.foreignBeats++;
      if (state.foreignBeats === CONFLICT_STRIKES) {
        state.conflict     = true;
        state.conflictWith = lock.instanceId;
        warn(`MULTIPLE LIVE WRITERS DETECTED — this=${INSTANCE_ID} other=${lock.instanceId}. The mirror is whole-file last-writer-wins: scale the Render service to ONE instance or user data WILL interleave lossily. This alarm stays raised in /provider-health.`);
      }
    } else if (state.foreignBeats > 0 && state.foreignBeats < CONFLICT_STRIKES) {
      state.foreignBeats = 0; // the other writer went away (deploy overlap ended)
    }
    await col.updateOne(
      { _id: LOCK_ID },
      { $set: { instanceId: INSTANCE_ID, ts: now } },
      { upsert: true },
    );
    state.lastBeatAt = now;
  } catch (err) {
    warn(`heartbeat failed: ${err.message}`);
  }
}

function startHeartbeat() {
  if (state.heartbeatTimer) return;
  heartbeatOnce();                                        // immediate claim
  state.heartbeatTimer = setInterval(heartbeatOnce, HEARTBEAT_MS);
  state.heartbeatTimer.unref();                           // never holds the process open
}

// ── Boot hydration ────────────────────────────────────────────────────────────

/**
 * Restore every mirrored store file into `dataDir` before stores load.
 * Handles both shapes: single doc { _id, json, updatedAt } and chunked
 * manifest { _id, chunked, parts, gen } + part docs. Torn chunk sets
 * (gen mismatch / missing part) are skipped with a warning — the previous
 * complete generation of that file, if any, was already GC'd only AFTER its
 * successor's manifest landed, so "skip" can only mean "keep local".
 * Newer-wins per file. Never throws.
 */
export async function hydrateFromMongo(dataDir) {
  const empty = { restored: 0, kept: 0, total: 0 };
  try {
    const col = await connect();
    if (!col) return empty;

    const docs = await col.find({}).toArray();
    const parts = new Map();               // "of:gen" → [ {i, json} ]
    const mains = [];

    for (const doc of docs) {
      if (doc.part) {
        const k = `${doc.of}:${doc.gen}`;
        if (!parts.has(k)) parts.set(k, []);
        parts.get(k).push(doc);
        continue;
      }
      if (doc._id === CANARY_ID || doc._id === LOCK_ID) continue;
      mains.push(doc);
    }

    let restored = 0, kept = 0;
    for (const doc of mains) {
      const filename = String(doc._id ?? '');
      // Defense: _id is a filename WE wrote (basename form). Refuse anything
      // that could escape the data dir.
      if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        warn(`skipping suspicious doc _id=${JSON.stringify(filename)}`);
        continue;
      }

      let json;
      if (doc.chunked) {
        const set = (parts.get(`${filename}:${doc.gen}`) ?? []).sort((a, b) => a.i - b.i);
        if (set.length !== doc.parts || set.some((p, i) => p.i !== i || typeof p.json !== 'string')) {
          warn(`${filename}: chunk set incomplete (${set.length}/${doc.parts} gen=${doc.gen}) — keeping local copy.`);
          continue;
        }
        json = set.map(p => p.json).join('');
      } else if (typeof doc.json === 'string') {
        json = doc.json;
      } else {
        continue;
      }

      const target = path.join(dataDir, filename);
      let fileMtime = 0;
      try { fileMtime = fs.statSync(target).mtimeMs; } catch { /* absent */ }
      const docTime = Number(doc.updatedAt ?? 0);
      if (fileMtime && fileMtime >= docTime) { kept++; continue; }

      // Atomic write (temp+rename) — same guarantee as atomicStore, inlined
      // to avoid an import cycle (atomicStore imports this module).
      const tmp = path.join(dataDir, `.${filename}.hydrate.${process.pid}`);
      try {
        fs.writeFileSync(tmp, json, 'utf8');
        fs.renameSync(tmp, target);
        restored++;
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* temp may not exist */ }
        warn(`could not restore ${filename}: ${err.message}`);
      }
    }

    log(`hydration: ${restored} restored, ${kept} kept (local newer), ${mains.length} mirrored file(s)`);
    return { restored, kept, total: mains.length };
  } catch (err) {
    warn(`hydration failed (${err.message}) — continuing with local files only.`);
    return empty;
  }
}

// ── Write mirroring ───────────────────────────────────────────────────────────

async function writeOne(col, filename, json) {
  const bytes = Buffer.byteLength(json, 'utf8');

  if (bytes <= CHUNK_BYTES) {
    await col.updateOne(
      { _id: filename },
      { $set: { json, updatedAt: Date.now(), chunked: false, parts: 0, gen: Date.now() } },
      { upsert: true },
    );
    return;
  }

  // Chunked: parts first, generation-stamped; manifest LAST so a concurrent
  // hydration can only ever assemble a COMPLETE generation.
  const gen = Date.now();
  const n   = Math.ceil(json.length / CHUNK_CHARS);
  for (let i = 0; i < n; i++) {
    await col.updateOne(
      { _id: `${filename}::part${gen}:${i}` },
      { $set: { part: true, of: filename, i, gen, json: json.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) } },
      { upsert: true },
    );
  }
  await col.updateOne(
    { _id: filename },
    { $set: { chunked: true, parts: n, gen, updatedAt: Date.now(), bytes, json: null } },
    { upsert: true },
  );
  // GC superseded generations (best-effort; harmless if unsupported/failed —
  // hydration matches parts by gen, so stale parts are inert, just storage).
  if (typeof col.deleteMany === 'function') {
    try { await col.deleteMany({ part: true, of: filename, gen: { $lt: gen } }); } catch { /* best effort */ }
  }
  log(`${filename}: ${(bytes / 1e6).toFixed(1)} MB mirrored in ${n} chunk(s) gen=${gen}`);
}

async function upsertLoop(filename) {
  while (state.pending.has(filename)) {
    const json = state.pending.get(filename);
    state.pending.delete(filename);
    try {
      const col = await connect();
      if (!col) return;
      await writeOne(col, filename, json);
      state.lastWriteAt = Date.now();
      state.lastError   = null;
    } catch (err) {
      state.lastError = err.message;
      warn(`upsert failed for ${filename}: ${err.message} — will retry on next write.`);
      return; // drop this round; the next schedule() retries with fresher data
    }
  }
}

/**
 * Mirror one store file's serialized JSON to Mongo. Fire-and-forget,
 * coalesced (bursts collapse to the latest state). Called by atomicStore
 * after every successful file flush. Any size — big stores are chunked.
 */
export function mirrorWrite(filePath, json) {
  const configured = state.collection || (process.env.MONGO_URI && process.env.AQUA_DISABLE_MONGO_MIRROR !== '1');
  if (!configured) return;
  if (typeof json !== 'string') return;

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

/** Live status for /provider-health — the post-deploy one-glance check. */
export function getMirrorStatus() {
  return {
    enabled:      state.enabled || !!(process.env.MONGO_URI && process.env.AQUA_DISABLE_MONGO_MIRROR !== '1'),
    connected:    !!state.collection,
    canary:       state.canary,          // 'ok' after every healthy real boot
    instanceId:   INSTANCE_ID,
    lastWriteAt:  state.lastWriteAt,
    lastError:    state.lastError,
    pending:      state.pending.size,
    multiWriterConflict: state.conflict, // true = scale to 1 instance NOW
    conflictWith: state.conflictWith,
    chunkBytes:   CHUNK_BYTES,
  };
}

// ── Test seams ────────────────────────────────────────────────────────────────
export function __setCollectionForTests(fakeCollection) {
  state.collection = fakeCollection;
  state.enabled    = !!fakeCollection;
  state.failedOnce = false;
}
export function __heartbeatOnceForTests() { return heartbeatOnce(); }
export function __resetForTests() {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  Object.assign(state, {
    collection: null, enabled: false, connecting: null, failedOnce: false,
    canary: null, lastWriteAt: null, lastError: null,
    conflict: false, conflictWith: null, foreignBeats: 0, lastBeatAt: 0,
    heartbeatTimer: null,
  });
  state.pending.clear();
  state.inflight.clear();
}
