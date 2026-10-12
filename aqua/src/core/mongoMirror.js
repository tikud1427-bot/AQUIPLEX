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
 * OUTAGE BEHAVIOUR (Jul-31 audit — the mirror was silently NOT mirroring)
 *   Production logged ~150 consecutive `heartbeat failed` lines (Atlas DNS
 *   EAI_AGAIN + secureConnect timeouts). Three defects turned a recoverable
 *   network outage into silent data loss:
 *
 *     1. DROPPED WRITES. upsertLoop() removed a payload from `pending`, tried
 *        it, and on failure returned — the JSON was gone. "Retries on the next
 *        write" is only true for a file that gets written again soon; a
 *        low-traffic store could lose its newest generation until a redeploy
 *        wiped the disk copy too. Payloads are now RE-QUEUED (newer-wins) and
 *        retried on bounded exponential backoff until they land.
 *     2. THE HEALTH CHECK LIED. `connected` was `!!state.collection` and
 *        `canary` was set once at boot; neither is re-checked, so
 *        /provider-health stayed green with the cluster unreachable and every
 *        write failing. Status now also reports evidence-based fields —
 *        durable / verdict / lastOkAt / consecutiveFailures / queuedFiles —
 *        derived from whether a mirror operation has recently SUCCEEDED.
 *     3. LOG STORM. Every 30s heartbeat failure printed an identical line
 *        forever, burying real errors. Repeats now collapse to a periodic
 *        summary, and recovery is announced (and re-verified by canary).
 *
 *   All three are fail-open exactly as before: a Mongo blip still cannot fail,
 *   slow, or block a user request. Nothing here changes the healthy path.
 *
 * ZERO NEW DEPENDENCIES — mongoose is dynamic-imported and resolves from the
 * platform's node_modules (aqua runs in-process). Standalone aqua without it
 * → clean warn + file-only. No MONGO_URI → silent no-op (tests, dev).
 */
import path from 'path';
import fs   from 'fs';
import os   from 'os';
import crypto from 'crypto';
import { computeBackoff } from './backoff.js';

const COLLECTION       = 'aqua_kv';
const CONNECT_TIMEOUT  = 6_000;
const CANARY_ID        = '.aqua-mirror-canary';
const LOCK_ID          = '.aqua-mirror-writer';
const HEARTBEAT_MS     = 30_000;
const CONFLICT_STRIKES = 3;      // foreign beats before alarming (deploy-overlap grace)

// Retry of a failed mirror write. Shares core/backoff.js with the provider
// router — one jittered-backoff implementation, no second ad-hoc copy. The
// cap is deliberately long: an Atlas outage lasting minutes should cost a
// handful of retries, not a tight loop against a dead socket.
const RETRY_BASE_MS = Number(process.env.AQUA_MIRROR_RETRY_BASE_MS) || 2_000;
const RETRY_CAP_MS  = Number(process.env.AQUA_MIRROR_RETRY_CAP_MS)  || 60_000;

// A mirror is only as trustworthy as its last SUCCESS. Past this long with no
// successful op while writes are queued, /provider-health reports not-durable.
// The count is a second, time-independent trigger: whatever the clock says,
// "42 consecutive failures but healthy" must never be a printable state.
const STALE_AFTER_MS  = Number(process.env.AQUA_MIRROR_STALE_MS) || 120_000;
const STALE_AFTER_FAILS = Number(process.env.AQUA_MIRROR_STALE_FAILS) || 5;

// Collapse an unchanging failure to one line per this interval (the log storm).
const WARN_REPEAT_MS = 5 * 60_000;

// Chunking: stay well under Mongo's 16 MB/doc. Parts are sliced by CHARS at
// CHUNK_BYTES/4 — worst-case UTF-8 is 4 bytes/char, so a part can never
// exceed CHUNK_BYTES; reassembly is plain string concat (byte-exact).
const CHUNK_BYTES = Number(process.env.AQUA_MIRROR_CHUNK_BYTES) || 10_000_000;
const CHUNK_CHARS = Math.max(1, Math.floor(CHUNK_BYTES / 4));

const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;

// ── Single authoritative writer (P0 2026-10-12) ──────────────────────────────
// The heartbeat used to DETECT a second writer and alarm; both kept writing.
// The incident's second writer was a laptop running the app with the
// production MONGO_URI next to Render. Three layers now:
//   1. ROLE — only the deployment writes. On Render (RENDER=true) the role is
//      'writer'; anywhere else it is 'reader' (hydrates, never writes) unless
//      AQUA_MIRROR_ROLE=writer says otherwise, explicitly.
//   2. LEASE — among writers, the lock doc is a lease (TTL below). A writer
//      defers to another instance's live lease and takes over only once it
//      expires or is released (SIGTERM drain releases it). Locks written by
//      pre-lease code carry no `lease` flag; such a writer honours nothing, so
//      it is not deferred to — the multi-writer alarm below still covers it.
//   3. GENERATION CAS — every data write is conditional on the generation this
//      instance last saw. If another writer moved the doc, its version is
//      PRESERVED under `conflict/<file>/<gen>` before ours lands, and the
//      conflict is logged and counted. Nothing is overwritten silently.
const LEASE_TTL_MS = Number(process.env.AQUA_MIRROR_LEASE_MS) || HEARTBEAT_MS * 3;
const ON_RENDER = String(process.env.RENDER ?? '').toLowerCase() === 'true';
function configuredRole() {
  const v = String(process.env.AQUA_MIRROR_ROLE ?? '').toLowerCase();
  if (v === 'writer' || v === 'reader') return v;
  return ON_RENDER ? 'writer' : 'reader';
}
const HOST = os.hostname();
/**
 * Host of the instance that last stamped the lock — ALWAYS from its
 * instanceId (`hostname:pid:hex`). Never from `lock.host`: pre-lease code
 * stamps only instanceId+ts with $set, so a `host` left by our own last stamp
 * would survive a foreign writer's beat and make it look like our sibling.
 */
const hostOf = lock => String(lock?.instanceId ?? '').split(':')[0];
const CONFLICT_PREFIX = 'conflict/';   // contains '/', so pre-lease hydration skips it as "suspicious"
const isDuplicateKey = err => err?.code === 11000 || /E11000/.test(String(err?.message ?? ''));
let genSeq = 0;
/** Strictly increasing within a process, and practically unique across instances. */
function nextGen() { genSeq = (genSeq + 1) % 1000; return Date.now() * 1000 + genSeq; }

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
  // outage tracking (Jul-31 audit)
  lastOkAt:      null,      // last SUCCESSFUL mirror op — the only durability evidence
  lastFailureAt: null,
  consecutiveFailures: 0,
  retryTimers:   new Map(), // filename → pending retry timer
  retryAttempts: new Map(), // filename → consecutive failed attempts
  warnKey:       null,      // last warn text, for storm collapsing
  warnAt:        0,
  warnSuppressed: 0,
  retryDelayOverride: null, // test seam
  // single writer + CAS (P0 2026-10-12)
  role:          configuredRole(),
  leader:        false,     // this instance holds the writer lease
  leaseHolder:   null,      // who does, when it is not us
  knownGen:      new Map(), // filename → generation this instance last saw/wrote
  writeConflicts: 0,        // CAS conflicts (another writer moved a doc under us)
  lastConflict:  null,
  standbyWarned: false,
};

function log(msg)  { console.log(`[MIRROR] ${msg}`); }
function warn(msg) { console.warn(`[MIRROR] ${msg}`); }

/**
 * Warn, but collapse an unchanging message. An outage repeats the SAME error
 * every 30s forever; printing all of them buries everything else in the log.
 * First occurrence prints immediately, identical repeats are counted and
 * summarised at most every WARN_REPEAT_MS.
 */
function warnThrottled(msg) {
  const now = Date.now();
  if (msg === state.warnKey && now - state.warnAt < WARN_REPEAT_MS) {
    state.warnSuppressed++;
    return;
  }
  const suffix = state.warnSuppressed > 0 && msg === state.warnKey
    ? ` (repeated ${state.warnSuppressed + 1}× in the last ${Math.round((now - state.warnAt) / 1000)}s)`
    : '';
  warn(msg + suffix);
  state.warnKey = msg;
  state.warnAt = now;
  state.warnSuppressed = 0;
}

/** A mirror operation succeeded — the only evidence that writes are durable. */
function noteOk() {
  const recovering = state.consecutiveFailures > 0;
  const failures   = state.consecutiveFailures;
  state.lastOkAt = Date.now();
  state.consecutiveFailures = 0;
  state.lastError = null;
  state.warnKey = null;
  state.warnSuppressed = 0;
  if (recovering) {
    log(`recovered after ${failures} failed attempt(s) — ${state.pending.size} file(s) still queued`);
    // The boot canary proved the driver path on a connection that has since
    // died. Re-prove it, so `canary` is a live fact rather than history.
    verifyRoundTrip().catch(() => { /* fail-open: status already reflects it */ });
  }
}

/** A mirror operation failed. Never throws; only records + throttled-warns. */
function noteFailure(what, err) {
  state.consecutiveFailures++;
  state.lastFailureAt = Date.now();
  state.lastError = err?.message ?? String(err);
  warnThrottled(`${what}: ${state.lastError}`);
}

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
      log(`connected — durable store: MongoDB collection "${COLLECTION}" instance=${INSTANCE_ID} role=${state.role}${state.role === 'reader' ? ' (hydrate only — this host never writes the shared mirror; AQUA_MIRROR_ROLE=writer to change)' : ''}`);
      if (state.role === 'writer') await verifyRoundTrip();   // canary: prove THIS cluster round-trips, every boot
      await startHeartbeat();      // lease claim (writers) — known before the first write
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
      noteOk();
      log('round-trip verified — writes to this cluster are durable ✓');
    } else {
      state.canary = 'failed';
      warn(`round-trip verification FAILED (read back ${JSON.stringify(back?.json)}) — investigate before trusting deploy survival.`);
    }
  } catch (err) {
    state.canary = 'failed';
    noteFailure('round-trip verification errored', err);
  }
}

/** One heartbeat: detect a second LIVE writer, then stamp the lock. A foreign
 *  instance id that keeps beating between OUR beats = concurrent writers =
 *  whole-file last-writer-wins is now lossy → alarm loudly and persistently
 *  (logs + /provider-health). Deploy overlap (old instance finishing up)
 *  produces 1–2 foreign beats and stays under the strike threshold. */
/**
 * Try to hold the writer lease. Atomic via the same conditional-upsert idiom
 * as the data CAS: the filter pins the lock state we decided on; if anyone
 * changed it in between, the upsert collides on _id (E11000) and we lost.
 * Returns whether this instance is now the leader.
 */
async function claimLease(col, lock, now) {
  // The lease belongs to a HOST (one container / one disk), not a process:
  // the launcher runs server + worker side by side, both mirroring the same
  // DATA_DIR. Siblings share the lease and renew it for each other.
  const mine     = !!lock?.instanceId && hostOf(lock) === HOST;
  const vacant   = !lock || !lock.instanceId || Number(lock.ts) === 0;
  const expired  = !vacant && now - Number(lock.ts) > LEASE_TTL_MS;
  // Written by lease-aware code only if `leaseOf` names the SAME instance that
  // stamped instanceId: pre-lease code $sets instanceId+ts and leaves our
  // older fields behind, so a bare `lease: true` proves nothing.
  const honoured = !!lock?.instanceId && lock.leaseOf === lock.instanceId;
  if (!mine && !vacant && !expired && honoured) {
    state.leaseHolder = lock.instanceId;
    return false;                                   // a live leader that honours the lease: defer
  }
  // Exact CAS on the lock as read — renewal included.
  const filter = !lock ? { _id: LOCK_ID, instanceId: { $exists: false } }
    : { _id: LOCK_ID, instanceId: lock.instanceId ?? null, ts: lock.ts ?? null };
  try {
    await col.updateOne(filter,
      { $set: { instanceId: INSTANCE_ID, leaseOf: INSTANCE_ID, ts: now, host: HOST, render: ON_RENDER } },
      { upsert: true });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    // Lost the race. If the winner is a sibling on this host, the lease is
    // still ours (shared); otherwise someone else holds it.
    const now2 = await col.findOne({ _id: LOCK_ID });
    state.leaseHolder = now2?.instanceId ?? '(raced)';
    return !!now2?.instanceId && hostOf(now2) === HOST;
  }
  // Taking over from a live PRE-LEASE writer is deliberate: it writes whatever
  // we do, the multi-writer alarm counts it, and the generation CAS preserves
  // what it wrote before ours lands.
  state.leaseHolder = INSTANCE_ID;
  return true;
}

async function heartbeatOnce() {
  const col = state.collection;
  if (!col) return;
  try {
    const now  = Date.now();
    const lock = await col.findOne({ _id: LOCK_ID });
    if (state.role !== 'writer') {
      // Readers never stamp the lock and never write data.
      state.leader = false;
      state.leaseHolder = lock?.instanceId ?? null;
      state.lastBeatAt = now;
      noteOk();
      return;
    }
    if (lock && lock.instanceId && lock.instanceId !== INSTANCE_ID && hostOf(lock) !== HOST && Number(lock.ts) > state.lastBeatAt) {
      state.foreignBeats++;
      if (state.foreignBeats === CONFLICT_STRIKES) {
        state.conflict     = true;
        state.conflictWith = lock.instanceId;
        warn(`MULTIPLE LIVE WRITERS DETECTED — this=${INSTANCE_ID} other=${lock.instanceId}. The mirror is whole-file last-writer-wins: scale the Render service to ONE instance or user data WILL interleave lossily. This alarm stays raised in /provider-health.`);
      }
    } else if (state.foreignBeats > 0 && state.foreignBeats < CONFLICT_STRIKES) {
      state.foreignBeats = 0; // the other writer went away (deploy overlap ended)
    }
    const wasLeader = state.leader;
    state.leader = await claimLease(col, lock, now);
    state.lastBeatAt = now;
    noteOk();
    if (!state.leader) {
      if (wasLeader || !state.standbyWarned) {
        state.standbyWarned = true;
        warn(`STANDBY — writer lease held by ${state.leaseHolder}; this instance's writes stay queued (not mirrored) until the lease is free.`);
      }
      return;
    }
    if (!wasLeader) log(`writer lease held — instance=${INSTANCE_ID}`);
    // The cluster answered. Anything the write path parked during the outage
    // (or while standing by) can go now, without waiting out its own backoff.
    flushQueued();
  } catch (err) {
    noteFailure('heartbeat failed', err);
  }
}

async function startHeartbeat() {
  if (state.heartbeatTimer) return;
  state.heartbeatTimer = setInterval(heartbeatOnce, HEARTBEAT_MS);
  state.heartbeatTimer.unref();                           // never holds the process open
  await heartbeatOnce();                                  // immediate claim
}

/** Give the lease up (SIGTERM drain) so a successor takes over at once, not after the TTL. */
async function releaseLease() {
  const col = state.collection;
  if (!col || !state.leader) return;
  try {
    // state.leader stays true: drainJobs/flushStorage run alongside this drain
    // and their last flushes must still land. A successor that claims the
    // freed lease meanwhile is covered by the generation CAS (preserve, never
    // overwrite silently).
    await col.updateOne({ _id: LOCK_ID, host: HOST }, { $set: { ts: 0 } });
  } catch { /* the TTL releases it anyway */ }
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
      if (doc.conflict || String(doc._id ?? '').startsWith(CONFLICT_PREFIX)) continue;   // preserved generations are not live stores
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
      // The generation our first write of this file must find, whatever the
      // newer-wins decision below — anything else means another writer moved it.
      if (doc.gen !== undefined) state.knownGen.set(filename, doc.gen);

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

/** The filter that only matches the generation this instance last saw. */
function casFilter(filename) {
  return state.knownGen.has(filename)
    ? { _id: filename, gen: state.knownGen.get(filename) }
    : { _id: filename, gen: { $exists: false } };
}

/**
 * Another writer moved `filename` under us. Copy ITS current generation to
 * `conflict/<file>/<gen>` (chunked: the manifest; its parts are kept out of
 * GC), adopt that generation as the new CAS base, and let the caller retry.
 * Our write then lands over a version that is preserved, never silently lost.
 */
async function preserveForeignGeneration(col, filename) {
  const cur = await col.findOne({ _id: filename });
  if (!cur) { state.knownGen.delete(filename); return; }
  const preservedId = `${CONFLICT_PREFIX}${filename}/${cur.gen ?? 'nogen'}`;
  await col.updateOne({ _id: preservedId }, { $set: {
    conflict: true, of: filename, gen: cur.gen ?? null, chunked: !!cur.chunked, parts: cur.parts ?? 0,
    bytes: cur.bytes ?? null, json: cur.json ?? null, writer: cur.writer ?? null, updatedAt: cur.updatedAt ?? null,
    preservedAt: Date.now(), preservedBy: INSTANCE_ID,
  } }, { upsert: true });
  await prunePreserved(col, filename);
  state.writeConflicts += 1;
  state.lastConflict ={ filename, foreignGen: cur.gen ?? null, foreignWriter: cur.writer ?? null, preservedAs: preservedId, at: Date.now() };
  warn(`WRITE CONFLICT on ${filename} — another writer (${cur.writer ?? 'pre-lease instance'}) moved it to gen=${cur.gen}; its version is preserved as "${preservedId}" before this instance's lands. Reconcile from there if both held changes.`);
  if (cur.gen === undefined) state.knownGen.delete(filename); else state.knownGen.set(filename, cur.gen);
}

/**
 * Keep only the newest PRESERVE_PER_FILE preserved generations of a file.
 * Measured on the real launcher: server + worker share whole-file stores, so
 * one short session produced 40 conflicts — unbounded copies of multi-MB
 * stores would grow the cluster without limit. Best-effort.
 */
const PRESERVE_PER_FILE = 3;
async function prunePreserved(col, filename) {
  try {
    const docs = (await col.find({ conflict: true, of: filename }).toArray())
      .sort((a, b) => Number(b.preservedAt ?? 0) - Number(a.preservedAt ?? 0));
    for (const d of docs.slice(PRESERVE_PER_FILE)) {
      if (typeof col.deleteMany !== 'function') break;
      await col.deleteMany({ _id: d._id });
      if (d.chunked && d.gen != null) await col.deleteMany({ part: true, of: filename, gen: d.gen });
    }
  } catch { /* pruning is housekeeping; never fail a write over it */ }
}

/** Conditional upsert; on a generation conflict preserve the foreign version and retry (bounded). */
async function casUpdate(col, filename, $set) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await col.updateOne(casFilter(filename), { $set }, { upsert: true });
      state.knownGen.set(filename, $set.gen);
      return;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      await preserveForeignGeneration(col, filename);
    }
  }
  throw new Error(`generation conflict on ${filename} persisted across 3 attempts`);
}

async function writeOne(col, filename, json) {
  const bytes = Buffer.byteLength(json, 'utf8');

  if (bytes <= CHUNK_BYTES) {
    await casUpdate(col, filename, { json, updatedAt: Date.now(), chunked: false, parts: 0, gen: nextGen(), writer: INSTANCE_ID });
    return;
  }

  // Chunked: parts first, generation-stamped; manifest LAST so a concurrent
  // hydration can only ever assemble a COMPLETE generation.
  const gen = nextGen();
  const n   = Math.ceil(json.length / CHUNK_CHARS);
  for (let i = 0; i < n; i++) {
    await col.updateOne(
      { _id: `${filename}::part${gen}:${i}` },
      { $set: { part: true, of: filename, i, gen, json: json.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) } },
      { upsert: true },
    );
  }
  await casUpdate(col, filename, { chunked: true, parts: n, gen, updatedAt: Date.now(), bytes, json: null, writer: INSTANCE_ID });
  // GC superseded generations (best-effort; harmless if unsupported/failed —
  // hydration matches parts by gen, so stale parts are inert, just storage).
  // Never while a preserved (conflict) generation of this file exists: its
  // parts are the only copy of what the other writer held.
  let preservedChunked = false;
  try { preservedChunked = (await col.find({ conflict: true, of: filename }).toArray()).some(d => d.chunked); } catch { preservedChunked = true; }
  if (!preservedChunked && typeof col.deleteMany === 'function') {
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
      if (!col) {
        // Not configured/reachable yet. Keep the payload — it is the newest
        // state of that store and nothing else is holding a copy.
        requeue(filename, json);
        return;
      }
      if (!state.leader) {
        // Standing by: another instance holds the writer lease. Keep the
        // newest payload; the heartbeat flushes it the moment we hold it.
        requeue(filename, json);
        return;
      }
      await writeOne(col, filename, json);
      state.lastWriteAt = Date.now();
      state.retryAttempts.delete(filename);
      noteOk();
    } catch (err) {
      // DO NOT DROP. Before this, a failed upsert discarded the JSON and only
      // "retried" if the store happened to be written again — so a transient
      // Atlas outage silently cost a low-traffic store its newest generation.
      requeue(filename, json);
      const attempt = (state.retryAttempts.get(filename) ?? 0) + 1;
      state.retryAttempts.set(filename, attempt);
      noteFailure(`upsert failed for ${filename}`, err);
      scheduleRetry(filename, attempt);
      return;
    }
  }
}

/**
 * Put a payload back in the queue — but never over a NEWER one. mirrorWrite()
 * may have coalesced a fresher generation of the same store while this attempt
 * was in flight; that one wins, and the stale copy is correctly discarded.
 */
function requeue(filename, json) {
  if (!state.pending.has(filename)) state.pending.set(filename, json);
}

/** Re-drive one file after a jittered backoff. Unref'd: never holds the process open. */
function scheduleRetry(filename, attempt) {
  if (state.retryTimers.has(filename)) return;      // one timer per file
  const delay = state.retryDelayOverride ?? computeBackoff(attempt, {
    baseMs: RETRY_BASE_MS, capMs: RETRY_CAP_MS, floorMs: 250,
  });
  const t = setTimeout(() => {
    state.retryTimers.delete(filename);
    drive(filename);
  }, delay);
  t.unref?.();
  state.retryTimers.set(filename, t);
}

/** Start (or join) the upsert loop for one file. */
function drive(filename) {
  if (!state.pending.has(filename) || state.inflight.has(filename)) return;
  const p = upsertLoop(filename).finally(() => state.inflight.delete(filename));
  state.inflight.set(filename, p);
}

/** Re-drive every queued file immediately (used when the cluster answers again). */
function flushQueued() {
  for (const filename of [...state.pending.keys()]) {
    const t = state.retryTimers.get(filename);
    if (t) { clearTimeout(t); state.retryTimers.delete(filename); }
    drive(filename);
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
  if (state.role !== 'writer') return;   // readers never write the shared mirror
  if (typeof json !== 'string') return;

  const filename = path.basename(filePath);
  state.pending.set(filename, json);
  drive(filename);
}

/**
 * Wait for all in-flight/pending upserts to finish, capped at `ms`.
 * Called by atomicStore's SIGTERM hook so a deploy's final messages land.
 */
export async function drainMirror(ms = 5_000) {
  if (state.inflight.size || state.pending.size) {
    // A standby with queued writes gets one last chance at the lease.
    if (!state.leader && state.role === 'writer' && state.collection) await heartbeatOnce();
    // A payload parked behind a backoff timer is NOT in flight, so the old
    // race resolved instantly and the deploy took it to the grave. Cancel the
    // timers and drive everything now — this is the last chance before SIGTERM.
    flushQueued();
    const all = Promise.all([...state.inflight.values()]);
    await Promise.race([all, new Promise(r => setTimeout(r, ms))]);
  }
  // Hand the lease to the successor now rather than after the TTL.
  await releaseLease();
}

/**
 * Live status for /provider-health — the post-deploy one-glance check.
 *
 * `connected` and `canary` are BOOT facts: a mongoose Collection handle stays
 * truthy after the cluster becomes unreachable, and the canary is written once.
 * During the Jul-31 outage both stayed green while every write failed. They are
 * kept (existing consumers read them) but are no longer the verdict — `durable`
 * and `verdict` are, and they are derived from whether a mirror operation has
 * recently SUCCEEDED.
 */
export function getMirrorStatus() {
  const enabled = state.enabled || !!(process.env.MONGO_URI && process.env.AQUA_DISABLE_MONGO_MIRROR !== '1');
  const now     = Date.now();
  const staleFor = state.lastOkAt ? now - state.lastOkAt : null;

  let durable = true;
  let verdict = 'ok — writes are reaching Mongo';
  if (!enabled) {
    durable = false;
    verdict = 'DISABLED — file-only; data will NOT survive a redeploy';
  } else if (!state.collection) {
    durable = false;
    verdict = 'NOT CONNECTED — file-only; data will NOT survive a redeploy';
  } else if (state.consecutiveFailures > 0 && state.lastOkAt === null) {
    // Never landed a single operation. The least durable state there is —
    // it must never fall through to the transient-blip branch below.
    durable = false;
    verdict = `NOT DURABLE — ${state.consecutiveFailures} failure(s), no operation has ever succeeded; data will NOT survive a redeploy`;
  } else if (state.consecutiveFailures >= STALE_AFTER_FAILS
             || (state.consecutiveFailures > 0 && staleFor !== null && staleFor > STALE_AFTER_MS)) {
    durable = false;
    verdict = `DEGRADED — ${state.consecutiveFailures} consecutive failures, no successful write for ${Math.round((staleFor ?? 0) / 1000)}s; data will NOT survive a redeploy`;
  } else if (state.consecutiveFailures > 0) {
    verdict = `retrying — ${state.consecutiveFailures} consecutive failure(s), ${state.pending.size} file(s) queued`;
  } else if (state.role !== 'writer') {
    durable = false;
    verdict = 'READ-ONLY — this host hydrates from the mirror but never writes it (not on Render; AQUA_MIRROR_ROLE=writer to change); local writes stay on this disk';
  } else if (!state.leader) {
    durable = false;
    verdict = `STANDBY — writer lease held by ${state.leaseHolder ?? 'another instance'}; ${state.pending.size} file(s) queued until it is free`;
  } else if (state.conflict) {
    durable = false;
    verdict = 'MULTIPLE LIVE WRITERS — a pre-lease instance is writing too; overwritten generations are preserved (see writeConflicts) but scale to ONE instance';
  }

  return {
    // verdict first — the field to read
    durable,
    verdict,
    enabled,
    connected:    !!state.collection,
    canary:       state.canary,          // 'ok' after every healthy real boot
    instanceId:   INSTANCE_ID,
    lastWriteAt:  state.lastWriteAt,
    lastOkAt:     state.lastOkAt,
    lastFailureAt: state.lastFailureAt,
    consecutiveFailures: state.consecutiveFailures,
    lastError:    state.lastError,
    pending:      state.pending.size,
    queuedFiles:  [...state.pending.keys()],
    retrying:     state.retryTimers.size,
    multiWriterConflict: state.conflict, // true = scale to 1 instance NOW
    conflictWith: state.conflictWith,
    role:         state.role,
    leader:       state.leader,
    leaseHolder:  state.leaseHolder,
    writeConflicts: state.writeConflicts,   // generation CAS hits; each preserved, never silently overwritten
    lastConflict: state.lastConflict,
    chunkBytes:   CHUNK_BYTES,
  };
}

// ── Test seams ────────────────────────────────────────────────────────────────
/** Install a fake cluster. Default: this instance is a writer holding the lease (the pre-lease contract). */
export function __setCollectionForTests(fakeCollection, { role = 'writer', leader = role === 'writer' } = {}) {
  state.collection = fakeCollection;
  state.enabled    = !!fakeCollection;
  state.failedOnce = false;
  state.role       = role;
  state.leader     = leader;
}
export function __instanceIdForTests() { return INSTANCE_ID; }
export function __leaseTtlForTests() { return LEASE_TTL_MS; }
export function __heartbeatOnceForTests() { return heartbeatOnce(); }
/** Make retry backoff deterministic in tests (null restores real backoff). */
export function __setRetryDelayForTests(ms) { state.retryDelayOverride = ms; }
/** Await whatever the write path currently has in flight (tests only). */
export function __settleForTests() { return Promise.all([...state.inflight.values()]); }
export function __resetForTests() {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  for (const t of state.retryTimers.values()) clearTimeout(t);
  Object.assign(state, {
    collection: null, enabled: false, connecting: null, failedOnce: false,
    canary: null, lastWriteAt: null, lastError: null,
    conflict: false, conflictWith: null, foreignBeats: 0, lastBeatAt: 0,
    heartbeatTimer: null,
    lastOkAt: null, lastFailureAt: null, consecutiveFailures: 0,
    warnKey: null, warnAt: 0, warnSuppressed: 0, retryDelayOverride: null,
    role: configuredRole(), leader: false, leaseHolder: null, writeConflicts: 0, lastConflict: null, standbyWarned: false,
  });
  state.knownGen.clear();
  state.pending.clear();
  state.inflight.clear();
  state.retryTimers.clear();
  state.retryAttempts.clear();
}
