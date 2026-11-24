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

/**
 * Part slices of `json`, each ≤ CHUNK_CHARS, never ending between the two
 * halves of a UTF-16 surrogate pair. BSON stores UTF-8, and a lone half
 * encodes as U+FFFD: an emoji cut by a boundary came back as two replacement
 * characters on every later hydration (reproduced against real MongoDB,
 * 2026-11-24). Shortening such a part by one char keeps the pair together.
 */
function chunkSlices(json) {
  const out = [];
  for (let start = 0; start < json.length;) {
    let end = Math.min(start + CHUNK_CHARS, json.length);
    if (end < json.length && end - start > 1) {
      const c = json.charCodeAt(end - 1);
      if (c >= 0xD800 && c <= 0xDBFF) end -= 1;
    }
    out.push(json.slice(start, end));
    start = end;
  }
  return out;
}

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
  knownBytes:    new Map(), // filename → UTF-8 size of that generation (shrink guard, 2026-11-24)
  shrinkRefused: 0,         // payloads refused by the shrink guard
  shrinkPreserved: 0,       // generations preserved before a large shrink landed
  writeConflicts: 0,        // CAS conflicts (another writer moved a doc under us)
  lastConflict:  null,
  standbyWarned: false,
};

function log(msg)  { console.log(`[MIRROR] ${msg}`); }
function warn(msg) { console.warn(`[MIRROR] ${msg}`); }

// ── Verified initialization (Sprint 1, 2026-11-10 — audit F-20) ──────────────
//
// THE INCIDENT THIS PREVENTS. Render gives every deploy an empty disk. If Mongo
// is unreachable while a new instance boots, hydration fails and the stores
// load EMPTY. The old code then mirrored the first flush once Mongo came back:
// the CAS filter (no known generation) missed, the conflict path preserved the
// live backup under conflict/… (pruned to the newest 3) and LANDED THE EMPTY
// STORE AS LIVE. The next deploy hydrated nothing. Every user's memory gone,
// recoverable only by hand, and only while the preserved copy survived pruning.
//
// THE RULE. A local store may overwrite its backup only when its LINEAGE is
// known: this process hydrated it (or confirmed the backup has none), or the
// marker below records that it descends from the backup's current generation.
//   · Hydration failed           → `sync.status = 'unverified'`; nothing is
//                                   mirrored; the backup is untouched.
//   · Mongo answers again        → reconcile on metadata: a file whose remote
//                                   generation matches the marker resumes; a file
//                                   with unknown lineage is BLOCKED — its local
//                                   copy (the outage-period writes) is preserved
//                                   as conflict/<file>/local-<instance>, the live
//                                   backup is left alone, and status says
//                                   "recovery required: restart to load it".
//   · Next boot                  → for a file with unknown lineage the backup
//                                   wins and the local copy is preserved first.
// "Missing" vs "valid empty": a store the backup does not have, seen by a
// hydration that SUCCEEDED, is valid (new store); any store seen by a failed
// one is unverified, empty or not.
//
// THE MARKER. `<DATA_DIR>/.mirror-sync.json`, written with plain fs (never
// through atomicStore, so it is never mirrored): per file, the remote
// generation the local copy equals or descends from; `unverifiedSince` while
// the data dir has run without a verified hydration. Updated per file as
// hydration proceeds and after every successful mirror write, so an
// interrupted initialization restarts from what is actually on disk.
// No marker at all = a data dir from before this change: the previous
// newer-wins rule applies (documented in AQUIPLEX_SPRINT1_PRODUCTION_SAFETY_REPORT.md).

const SYNC_MARKER = '.mirror-sync.json';
const LOCAL_RECOVERY_TAG = 'local-';

// ── Shrink guard (2026-11-24, audit/recovery Phase E) ────────────────────────
// Every path to the 2026-11-16 loss ended the same way: a store holding almost
// nothing replaced a large backup. The state checks above stop the known paths;
// this stops the outcome, whatever the path (a store that failed to parse and
// started empty, a bug not yet found). Compared against the generation THIS
// instance last saw or wrote (knownBytes), never against a fresh remote read.
//   payload < REFUSE × remote → not written: the file is blocked and the payload
//                               preserved as a local-recovery copy (RECOVERY REQUIRED)
//   payload < PRESERVE × remote → the remote generation is preserved first
//                               (protected from pruning), then the write lands
// Only above FLOOR bytes: small stores legitimately swing in size.
// AQUA_MIRROR_SHRINK_GUARD=off disables it (rollback).
const SHRINK_FLOOR_BYTES = Number(process.env.AQUA_MIRROR_SHRINK_FLOOR_BYTES) || 64 * 1024;
const SHRINK_REFUSE_RATIO = 0.05;
const SHRINK_PRESERVE_RATIO = 0.5;
const shrinkGuardOn = () => String(process.env.AQUA_MIRROR_SHRINK_GUARD ?? 'on').trim().toLowerCase() !== 'off';
class ShrinkRefused extends Error {
  constructor(filename, bytes, prev) {
    super(`${filename}: payload ${bytes} B is under ${SHRINK_REFUSE_RATIO * 100}% of the backup's ${prev} B — refused`);
    this.code = 'SHRINK_REFUSED';
  }
}

const sync = {
  status: 'pending',          // 'pending' | 'verified' | 'unverified' | 'not-configured'
  dataDir: null,
  unverifiedSince: null,
  blocked: new Map(),         // filename → { reason, remoteGen, since, preservedAs }
  lastAttemptAt: 0,
  reconciling: null,          // single-flight promise
  preservedLocal: [],         // ids of local copies preserved during recovery
};
const RECONCILE_MIN_INTERVAL_MS = 15_000;

function markerPath() { return sync.dataDir ? path.join(sync.dataDir, SYNC_MARKER) : null; }

function readMarker() {
  const p = markerPath();
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** Atomic (temp + rename). Never throws: a marker that cannot be written leaves the previous one. */
function writeMarker(m) {
  const p = markerPath();
  if (!p) return;
  const tmp = `${p}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...m, updatedAt: Date.now() }), 'utf8');
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* absent */ }
    warn(`sync marker not written (${err.code ?? err.message}) — lineage of local stores stays unverified`);
  }
}

function updateMarker(fn) {
  const m = readMarker() ?? { files: {}, unverifiedSince: null };
  m.files ??= {};
  fn(m);
  writeMarker(m);
}

/** Record that the local copy of `filename` now equals remote generation `gen`. */
function recordLineage(filename, gen) {
  if (gen === undefined || gen === null) return;
  updateMarker(m => { m.files[filename] = { gen, at: Date.now() }; });
}

function enterUnverified(reason) {
  sync.status = 'unverified';
  const m = readMarker();
  sync.unverifiedSince = m?.unverifiedSince ?? Date.now();
  updateMarker(mm => { mm.unverifiedSince = sync.unverifiedSince; mm.unverifiedReason = reason; });
  warn(`initialization UNVERIFIED (${reason}) — local stores are not mirrored; the Mongo backup is left untouched until its state is confirmed`);
}

/** Can this file's payload overwrite its backup right now? */
function writeAllowed(filename) {
  return sync.status === 'verified' && !sync.blocked.has(filename);
}

/** Lineage of an existing local file against a remote generation. */
function lineageKnown(marker, filename, remoteGen) {
  return !!marker && marker.files?.[filename]?.gen !== undefined && marker.files[filename].gen === remoteGen;
}

/** Docs that are live stores (not parts, canary, lock or preserved generations). */
function liveDocs(docs) {
  return docs.filter(d => !d.part && d._id !== CANARY_ID && d._id !== LOCK_ID
    && !d.conflict && !String(d._id ?? '').startsWith(CONFLICT_PREFIX));
}

/**
 * Store a LOCAL copy whose lineage is unknown under conflict/<file>/local-<instance>,
 * chunked like a live store when large. Never touches the live doc. Excluded from
 * pruning (prunePreserved skips localRecovery docs): it can be the only copy of
 * what users wrote while the backup was unreachable.
 */
async function preserveLocal(col, filename, json) {
  const id = `${CONFLICT_PREFIX}${filename}/${LOCAL_RECOVERY_TAG}${INSTANCE_ID}`;
  const bytes = Buffer.byteLength(json, 'utf8');
  const base = { conflict: true, localRecovery: true, of: filename, writer: INSTANCE_ID, preservedAt: Date.now(), updatedAt: Date.now(), bytes,
    unverifiedSince: sync.unverifiedSince };
  if (bytes <= CHUNK_BYTES) {
    await col.updateOne({ _id: id }, { $set: { ...base, chunked: false, parts: 0, json } }, { upsert: true });
  } else {
    const gen = nextGen();
    const slices = chunkSlices(json);
    const n = slices.length;
    for (let i = 0; i < n; i++) {
      await col.updateOne({ _id: `${id}::part${gen}:${i}` },
        { $set: { part: true, of: id, i, gen, json: slices[i] } }, { upsert: true });
    }
    await col.updateOne({ _id: id }, { $set: { ...base, chunked: true, parts: n, gen, json: null } }, { upsert: true });
  }
  if (!sync.preservedLocal.includes(id)) sync.preservedLocal.push(id);
  return id;
}

/**
 * Mongo answered after an unverified start: decide, per remote store, whether
 * this process may resume writing it. Metadata only (no store bodies are read).
 * Single-flight and rate-limited; never throws.
 */
async function reconcileAfterOutage() {
  if (sync.status === 'verified') return true;
  if (sync.reconciling) return sync.reconciling;
  if (Date.now() - sync.lastAttemptAt < RECONCILE_MIN_INTERVAL_MS) return false;
  sync.lastAttemptAt = Date.now();
  sync.reconciling = (async () => {
    try {
      const col = await connect();
      if (!col) return false;
      const docs = await listMirrorMeta(col);   // metadata only, no chunk parts
      const marker = readMarker();
      for (const doc of liveDocs(docs)) {
        const filename = String(doc._id);
        if (lineageKnown(marker, filename, doc.gen)) {
          state.knownGen.set(filename, doc.gen);
          continue;
        }
        sync.blocked.set(filename, { reason: 'lineage-unknown', remoteGen: doc.gen ?? null, since: sync.unverifiedSince, preservedAs: null });
      }
      sync.status = 'verified';   // the remote state is KNOWN now; blocked files stay blocked
      if (sync.blocked.size) {
        warn(`RECOVERY REQUIRED — Mongo is reachable again after an unverified start. ${sync.blocked.size} store(s) hold a backup this instance did not load; the backups are left untouched and this instance's local copies are preserved as conflict/<file>/${LOCAL_RECOVERY_TAG}<instance>. Restart the service to load the backups.`);
      } else {
        updateMarker(m => { m.unverifiedSince = null; m.unverifiedReason = null; });
        sync.unverifiedSince = null;
        log('initialization verified after outage — no backed-up store diverged; mirroring resumes');
      }
      return true;
    } catch (err) {
      noteFailure('post-outage reconciliation failed', err);
      return false;
    } finally {
      sync.reconciling = null;
    }
  })();
  return sync.reconciling;
}

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
//
// BOUNDED MEMORY (2026-11-24 — Render heap OOM, audit/render-heap-oom/).
// Hydration used to run `col.find({}).toArray()`: EVERY document in aqua_kv,
// bodies included — live stores, every chunk part of every generation
// (superseded generations are never GC'd while a chunked conflict copy of the
// file exists), and every preserved conflict copy — then joined each chunked
// store into one more string. On the Node versions Render runs (20/22), those
// decoded strings live on the V8 heap at up to 2 bytes/char, so peak heap was
// ~3.4× the collection's data size; a 512 MB instance has a 259 MB heap.
// Reproduced: a 140 MB collection exhausts it exactly as production does.
//
// Now: one metadata listing (no bodies, no chunk parts), then ONE file at a
// time — an unchunked body, or a chunked store streamed part by part into its
// temp file. Peak heap is bounded by the largest single document (≤ CHUNK_BYTES),
// whatever the collection holds. Every decision below is unchanged: generation
// tracking, lineage/newer-wins, conflict and preserved-copy exclusion,
// incomplete-chunk blocking, temp + rename.

const META_ONLY = { projection: { json: 0 } };

/** Every doc that is not a chunk part, without bodies. */
async function listMirrorMeta(col) {
  return (await col.find({ part: { $exists: false } }, META_ONLY).toArray());
}

/** Write a string to an fd as UTF-8, looping over partial writes. */
function writeAllSync(fd, str) {
  const buf = Buffer.from(str, 'utf8');
  for (let off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off, buf.length - off);
  return buf.length;
}

/**
 * Stream one chunked generation into `tmp`, one part in memory at a time.
 * Same completeness rule as before: exactly `doc.parts` parts with indices
 * 0..n-1 for `doc.gen`, each holding a string. Returns { ok, found, bytes }.
 * The caller unlinks `tmp` on failure.
 */
async function streamChunksTo(col, filename, doc, tmp, counters) {
  const metas = (await col.find({ part: true, of: filename, gen: doc.gen }, META_ONLY).toArray())
    .filter(p => p.part && p.of === filename && p.gen === doc.gen)   // defensive: a driver/fake ignoring the filter
    .sort((a, b) => a.i - b.i);
  if (metas.length !== doc.parts || metas.some((p, i) => p.i !== i)) return { ok: false, found: metas.length };
  const fd = fs.openSync(tmp, 'w');
  let bytes = 0, carry = '';
  try {
    for (const m of metas) {
      const p = await col.findOne({ _id: m._id });
      counters.parts++;
      if (!p || p.gen !== doc.gen || p.i !== m.i || typeof p.json !== 'string') return { ok: false, found: m.i };
      // Parts are sliced by UTF-16 unit, so one may end inside a surrogate pair.
      // Encoding the halves separately would not be byte-identical to encoding
      // the joined string; hold a trailing high surrogate for the next part.
      let s = carry + p.json;
      carry = '';
      const last = s.charCodeAt(s.length - 1);
      if (last >= 0xD800 && last <= 0xDBFF) { carry = s.slice(-1); s = s.slice(0, -1); }
      if (s) bytes += writeAllSync(fd, s);
    }
    if (carry) bytes += writeAllSync(fd, carry);
  } finally {
    fs.closeSync(fd);
  }
  return { ok: true, found: metas.length, bytes };
}

/**
 * Restore every mirrored store file into `dataDir` before stores load.
 * Handles both shapes: single doc { _id, json, updatedAt } and chunked
 * manifest { _id, chunked, parts, gen } + part docs. Torn chunk sets
 * (gen mismatch / missing part) are skipped with a warning — the previous
 * complete generation of that file, if any, was already GC'd only AFTER its
 * successor's manifest landed, so "skip" can only mean "keep local".
 * Newer-wins per file. Never throws. Bounded memory (see above).
 */
export async function hydrateFromMongo(dataDir) {
  const empty = { restored: 0, kept: 0, total: 0 };
  sync.dataDir = dataDir;
  const mirrorConfigured = !!process.env.MONGO_URI && process.env.AQUA_DISABLE_MONGO_MIRROR !== '1';
  try {
    const col = await connect();
    if (!col) {
      // Configured but unreachable: the local stores' relation to the backup is
      // unknown. Not configured at all: there is no backup to protect.
      if (mirrorConfigured || state.collection) enterUnverified('mongo-unreachable-at-boot');
      else sync.status = 'not-configured';
      return { ...empty, verified: sync.status === 'verified', status: sync.status };
    }
    const marker = readMarker();   // BEFORE this hydration writes anything
    const t0 = Date.now();
    const heap0 = process.memoryUsage().heapUsed;
    const counters = { listed: 0, parts: 0, bytes: 0 };

    // A temp file left by a hydration killed mid-stream was never renamed into
    // place, so it is never data; without this a crash-looping instance would
    // keep one orphan per store per attempt on a warm disk.
    try {
      for (const f of fs.readdirSync(dataDir)) {
        if (/^\..+\.hydrate\.\d+$/.test(f)) { try { fs.unlinkSync(path.join(dataDir, f)); } catch { /* not a file / in use */ } }
      }
    } catch { /* best effort */ }

    const metas = await listMirrorMeta(col);
    counters.listed = metas.length;
    const mains = [];
    for (const doc of metas) {
      if (doc.part) continue;                                   // filter ignored by a driver/fake
      if (doc._id === CANARY_ID || doc._id === LOCK_ID) continue;
      if (doc.conflict || String(doc._id ?? '').startsWith(CONFLICT_PREFIX)) continue;   // preserved generations are not live stores
      mains.push(doc);
    }

    let restored = 0, kept = 0, preserved = 0;
    for (const meta of mains) {
      const filename = String(meta._id ?? '');
      // Defense: _id is a filename WE wrote (basename form). Refuse anything
      // that could escape the data dir.
      if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        warn(`skipping suspicious doc _id=${JSON.stringify(filename)}`);
        continue;
      }
      const tmp = path.join(dataDir, `.${filename}.hydrate.${process.pid}`);
      const discard = () => { try { fs.unlinkSync(tmp); } catch { /* absent */ } };

      // Load THIS file's current state: the body of a single doc, or the parts
      // of a chunked one streamed into `tmp`. A writer may supersede the
      // listed generation meanwhile (deploy overlap); follow it, bounded.
      let doc = meta, staged = null, incompleteFound = 0;
      for (let attempt = 0; ; attempt++) {
        if (!doc.chunked) {
          const full = await col.findOne({ _id: filename });
          if (full?.chunked && attempt < 2) { doc = full; continue; }
          doc = full;                         // null: removed since the listing
          break;
        }
        const r = await streamChunksTo(col, filename, doc, tmp, counters);
        if (r.ok) { staged = r; break; }
        discard();
        incompleteFound = r.found;
        const cur = attempt < 2 ? await col.findOne({ _id: filename }, META_ONLY) : null;
        if (cur && cur.gen !== doc.gen) { doc = cur; continue; }
        break;
      }
      if (!doc) continue;

      // The generation our first write of this file must find, whatever the
      // newer-wins decision below — anything else means another writer moved it.
      if (doc.gen !== undefined) state.knownGen.set(filename, doc.gen);
      // Its size, for the shrink guard (writeOne).
      const remoteBytes = doc.chunked ? Number(staged?.bytes ?? doc.bytes ?? 0)
        : (typeof doc.json === 'string' ? Buffer.byteLength(doc.json, 'utf8') : 0);
      if (remoteBytes > 0) state.knownBytes.set(filename, remoteBytes);

      if (doc.chunked && !staged) {
        // Keep the local copy for reading — but never let it overwrite a backup
        // this process could not read (Sprint 1): the file is blocked.
        sync.blocked.set(filename, { reason: 'remote-chunk-set-incomplete', remoteGen: doc.gen ?? null, since: Date.now(), preservedAs: null });
        warn(`${filename}: chunk set incomplete (${incompleteFound}/${doc.parts} gen=${doc.gen}) — keeping local copy; NOT mirroring it over the backup.`);
        continue;
      }
      if (!doc.chunked && typeof doc.json !== 'string') continue;

      const target = path.join(dataDir, filename);
      let fileMtime = 0;
      try { fileMtime = fs.statSync(target).mtimeMs; } catch { /* absent */ }
      const docTime = Number(doc.updatedAt ?? 0);
      // A local copy whose lineage the marker cannot vouch for (it was written
      // while this data dir ran unverified, or the backup has moved since) must
      // not win on mtime: preserve it in Mongo, then restore the backup.
      // No marker at all = a data dir from before this rule: newer-wins, as before.
      const unknownLineage = fileMtime && marker && !lineageKnown(marker, filename, doc.gen);
      if (unknownLineage && state.role !== 'writer') {
        // A READER never writes the shared mirror (2026-11-24: a developer laptop
        // wrote its local stores into production as local-recovery docs). Its
        // local copy is kept on ITS OWN disk, beside the restored backup.
        const aside = `${target}.local-${Date.now()}`;
        try {
          fs.copyFileSync(target, aside);
          preserved++;
          warn(`${filename}: local copy has unknown lineage — kept on this disk as ${path.basename(aside)} (reader: the shared mirror is never written), restoring the backup`);
        } catch (err) {
          discard();
          sync.blocked.set(filename, { reason: 'local-unpreservable', remoteGen: doc.gen ?? null, since: Date.now(), preservedAs: null });
          warn(`${filename}: local copy has unknown lineage and could not be set aside (${err.message}) — keeping it`);
          continue;
        }
      } else if (unknownLineage) {
        try {
          const id = await preserveLocal(col, filename, fs.readFileSync(target, 'utf8'));
          preserved++;
          warn(`${filename}: local copy has unknown lineage (written while unverified, or the backup moved) — preserved as "${id}", restoring the backup`);
        } catch (err) {
          // Could not preserve it: do not destroy it either. Keep local, block mirroring.
          discard();
          sync.blocked.set(filename, { reason: 'local-unpreservable', remoteGen: doc.gen ?? null, since: Date.now(), preservedAs: null });
          warn(`${filename}: local copy has unknown lineage and could not be preserved (${err.message}) — keeping it, NOT mirroring it`);
          continue;
        }
      } else if (fileMtime && fileMtime >= docTime) {
        discard();
        kept++;
        recordLineage(filename, doc.gen);
        continue;
      }

      // Atomic write (temp+rename) — same guarantee as atomicStore, inlined
      // to avoid an import cycle (atomicStore imports this module). A chunked
      // store is already complete in `tmp`.
      try {
        if (!staged) {
          fs.writeFileSync(tmp, doc.json, 'utf8');
          counters.bytes += Buffer.byteLength(doc.json, 'utf8');
        } else {
          counters.bytes += staged.bytes;
        }
        fs.renameSync(tmp, target);
        restored++;
        recordLineage(filename, doc.gen);   // per file: an interrupted hydration resumes from here
      } catch (err) {
        discard();
        // The backup could not be loaded, so the local copy (if any) is not it.
        sync.blocked.set(filename, { reason: 'restore-failed', remoteGen: doc.gen ?? null, since: Date.now(), preservedAs: null });
        warn(`could not restore ${filename}: ${err.message} — NOT mirroring it over the backup`);
      }
    }

    // The backup's state is known now. Blocked files stay blocked for this process.
    sync.status = 'verified';
    if (!sync.blocked.size) {
      // Clear a previous unverified state. With nothing to record, no marker is
      // written (recordLineage creates it on the first restored or mirrored file).
      if (readMarker()) updateMarker(m => { m.unverifiedSince = null; m.unverifiedReason = null; m.verifiedAt = Date.now(); });
      sync.unverifiedSince = null;
    }
    log(`hydration: ${restored} restored, ${kept} kept (local newer), ${preserved} local copies preserved, ${sync.blocked.size} blocked, ${mains.length} mirrored file(s) — initialization verified`
      + ` [${counters.listed} doc(s) listed, ${counters.parts} part(s) streamed, ${(counters.bytes / 1e6).toFixed(1)} MB written, ${Date.now() - t0} ms,`
      + ` heap ${(heap0 / 1048576).toFixed(0)}→${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB]`);
    return { restored, kept, preserved, blocked: sync.blocked.size, total: mains.length, verified: true, status: sync.status };
  } catch (err) {
    warn(`hydration failed (${err.message}) — continuing with local files only.`);
    enterUnverified('hydration-failed');
    return { ...empty, verified: false, status: sync.status };
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
  const curBytes = sizeOfDoc(cur);
  await col.updateOne({ _id: preservedId }, { $set: {
    conflict: true, of: filename, gen: cur.gen ?? null, chunked: !!cur.chunked, parts: cur.parts ?? 0,
    bytes: curBytes, json: cur.json ?? null, writer: cur.writer ?? null, updatedAt: cur.updatedAt ?? null,
    preservedAt: Date.now(), preservedBy: INSTANCE_ID,
  } }, { upsert: true });
  if (curBytes) state.knownBytes.set(filename, curBytes);   // the generation our retry now lands over
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
/** UTF-8 size of a mirror doc's store: the manifest's `bytes` when chunked, else the body. */
function sizeOfDoc(d) {
  if (!d) return null;
  if (Number(d.bytes) > 0) return Number(d.bytes);
  return typeof d.json === 'string' ? Buffer.byteLength(d.json, 'utf8') : null;
}
/**
 * Which preserved copies may the count cap delete? (2026-11-24, audit/recovery Phase E.)
 * Never one that can be the only copy of something:
 *   · a local-recovery copy (Sprint 1) or one marked `protected` (shrink guard);
 *   · a copy LARGER than the live generation — it holds more than live does;
 *   · a copy whose size is unknown (written before sizes were recorded);
 *   · the largest preserved copy of the file.
 * The 2026-11-16 pre-loss history and Mind each survived as ONE count-prunable
 * copy; three deploy-overlap conflicts would have deleted them.
 */
export function prunableCopies(docs, liveBytes, keep = PRESERVE_PER_FILE) {
  const candidates = docs.filter(d => !d.localRecovery && !d.protected)
    .sort((a, b) => Number(b.preservedAt ?? 0) - Number(a.preservedAt ?? 0));
  const largest = candidates.reduce((m, d) => (Number(d.bytes ?? 0) > Number(m?.bytes ?? -1) ? d : m), null);
  return candidates.slice(keep).filter(d => {
    if (d === largest) return false;
    if (!(Number(d.bytes) > 0)) return false;
    if (liveBytes != null && Number(d.bytes) > liveBytes) return false;
    return true;
  });
}
async function prunePreserved(col, filename) {
  try {
    const docs = await col.find({ conflict: true, of: filename }, META_ONLY).toArray();   // bodies not needed
    for (const d of prunableCopies(docs, state.knownBytes.get(filename) ?? null)) {
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

/**
 * Copy the generation this instance knows as live to `conflict/<file>/<tag>-<gen>`,
 * PROTECTED from pruning. Used before a large shrink lands. Chunked: the manifest
 * (its parts stay under the live name, and part GC is skipped while a chunked
 * preserved copy exists).
 */
async function preserveCurrentGeneration(col, filename, tag) {
  const cur = await col.findOne({ _id: filename });
  if (!cur) return null;
  const id = `${CONFLICT_PREFIX}${filename}/${tag}-${cur.gen ?? 'nogen'}`;
  await col.updateOne({ _id: id }, { $set: {
    conflict: true, protected: true, reason: tag, of: filename, gen: cur.gen ?? null, chunked: !!cur.chunked, parts: cur.parts ?? 0,
    bytes: sizeOfDoc(cur), json: cur.json ?? null, writer: cur.writer ?? null, updatedAt: cur.updatedAt ?? null,
    preservedAt: Date.now(), preservedBy: INSTANCE_ID,
  } }, { upsert: true });
  return id;
}

/** Shrink guard (see SHRINK_*): throws ShrinkRefused, or preserves the remote first. */
async function guardShrink(col, filename, bytes) {
  if (!shrinkGuardOn()) return;
  const prev = state.knownBytes.get(filename) ?? 0;
  if (prev < SHRINK_FLOOR_BYTES) return;
  if (bytes < prev * SHRINK_REFUSE_RATIO) throw new ShrinkRefused(filename, bytes, prev);
  if (bytes < prev * SHRINK_PRESERVE_RATIO) {
    const id = await preserveCurrentGeneration(col, filename, 'shrink');
    state.shrinkPreserved += 1;
    warn(`SHRINK on ${filename}: ${prev} B → ${bytes} B — the previous generation is preserved as "${id}" (protected) before this write lands`);
  }
}

async function writeOne(col, filename, json) {
  const bytes = Buffer.byteLength(json, 'utf8');
  await guardShrink(col, filename, bytes);

  if (bytes <= CHUNK_BYTES) {
    await casUpdate(col, filename, { json, updatedAt: Date.now(), chunked: false, parts: 0, bytes, gen: nextGen(), writer: INSTANCE_ID });
    state.knownBytes.set(filename, bytes);
    return;
  }

  // Chunked: parts first, generation-stamped; manifest LAST so a concurrent
  // hydration can only ever assemble a COMPLETE generation.
  const gen = nextGen();
  const slices = chunkSlices(json);
  const n   = slices.length;
  for (let i = 0; i < n; i++) {
    await col.updateOne(
      { _id: `${filename}::part${gen}:${i}` },
      { $set: { part: true, of: filename, i, gen, json: slices[i] } },
      { upsert: true },
    );
  }
  await casUpdate(col, filename, { chunked: true, parts: n, gen, updatedAt: Date.now(), bytes, json: null, writer: INSTANCE_ID });
  state.knownBytes.set(filename, bytes);
  // GC superseded generations (best-effort; harmless if unsupported/failed —
  // hydration matches parts by gen, so stale parts are inert, just storage).
  // Never while a preserved (conflict) generation of this file exists: its
  // parts are the only copy of what the other writer held.
  let preservedChunked = false;
  try { preservedChunked = (await col.find({ conflict: true, of: filename }, META_ONLY).toArray()).some(d => d.chunked); } catch { preservedChunked = true; }
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
      if (sync.status !== 'verified') {
        // Unverified start (Sprint 1): the backup's state is unknown, so this
        // payload may be an empty store about to replace everyone's data. Keep
        // it queued; establish the backup's state first.
        requeue(filename, json);
        const ok = await reconcileAfterOutage();
        if (!ok || sync.status !== 'verified') {
          const attempt = (state.retryAttempts.get(filename) ?? 0) + 1;
          state.retryAttempts.set(filename, attempt);
          scheduleRetry(filename, attempt);
          return;
        }
        continue;   // verified now: the loop takes the payload again
      }
      if (sync.blocked.has(filename)) {
        // Lineage unknown: the live backup stays as it is. The newest local
        // state (what users wrote meanwhile) is preserved beside it instead.
        const b = sync.blocked.get(filename);
        b.preservedAs = await preserveLocal(col, filename, json);
        b.lastPreservedAt = Date.now();
        state.retryAttempts.delete(filename);
        noteOk();
        continue;
      }
      await writeOne(col, filename, json);
      recordLineage(filename, state.knownGen.get(filename));   // the local copy now equals this generation
      state.lastWriteAt = Date.now();
      state.retryAttempts.delete(filename);
      noteOk();
    } catch (err) {
      if (err?.code === 'SHRINK_REFUSED') {
        // The backup stays as it is; this payload is kept beside it (the
        // blocked branch above preserves it on the next pass), and status says
        // RECOVERY REQUIRED. Never retried as-is: it would be refused again.
        state.shrinkRefused += 1;
        sync.blocked.set(filename, { reason: 'shrink-refused', remoteGen: state.knownGen.get(filename) ?? null, since: Date.now(), preservedAs: null });
        warn(`SHRINK REFUSED — ${err.message}; the backup is left untouched and this payload is preserved as a local-recovery copy`);
        requeue(filename, json);
        continue;
      }
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
 * A store restored from the mirror could not be loaded (it failed to parse) and
 * is running from a fallback (`.bak`, or empty). Its flushes must never replace
 * the backup it failed to load (2026-11-24, audit/recovery Phase E, risk R-A3):
 * block the file exactly like an unverified one. Only files this process
 * actually saw in the mirror are blocked — a local-only file has no backup.
 * @returns {boolean} whether the file is now blocked
 */
export function blockMirrorFile(filePath, reason = 'local-load-failed') {
  const filename = path.basename(String(filePath ?? ''));
  if (!filename || !state.knownGen.has(filename)) return false;
  if (!sync.blocked.has(filename)) {
    sync.blocked.set(filename, { reason, remoteGen: state.knownGen.get(filename) ?? null, since: Date.now(), preservedAs: null });
    warn(`${filename}: ${reason} — NOT mirroring it over the backup; RECOVERY REQUIRED (restart to reload the backup)`);
  }
  return true;
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
    verdict = sync.status === 'unverified'
      ? 'UNVERIFIED START — Mongo was unreachable at boot; local stores may be empty and are NOT mirrored; the backup is untouched until its state is confirmed'
      : 'NOT CONNECTED — file-only; data will NOT survive a redeploy';
  } else if (sync.status === 'unverified') {
    durable = false;
    verdict = 'UNVERIFIED START — reconciling with the backup; nothing is mirrored until its state is confirmed';
  } else if (sync.blocked.size) {
    durable = false;
    verdict = `RECOVERY REQUIRED — ${sync.blocked.size} store(s) have a backup this instance did not load; backups untouched, local copies preserved as conflict/<file>/${LOCAL_RECOVERY_TAG}<instance>. Restart to load the backups.`;
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
    shrinkGuard:  { on: shrinkGuardOn(), refused: state.shrinkRefused, preserved: state.shrinkPreserved },
    chunkBytes:   CHUNK_BYTES,
    // Sprint 1 — verified initialization. File names are store names (.aqua-*.json), never user data.
    sync: {
      status:          sync.status,
      unverifiedSince: sync.unverifiedSince,
      recoveryRequired: sync.blocked.size > 0,
      blocked:         [...sync.blocked.entries()].map(([file, b]) => ({ file, reason: b.reason, remoteGen: b.remoteGen, preservedAs: b.preservedAs ?? null })),
      preservedLocal:  [...sync.preservedLocal],
    },
  };
}

// ── Test seams ────────────────────────────────────────────────────────────────
/** Install a fake cluster. Default: this instance is a writer holding the lease (the pre-lease contract). */
export function __setCollectionForTests(fakeCollection, { role = 'writer', leader = role === 'writer', sync: syncStatus = 'verified' } = {}) {
  state.collection = fakeCollection;
  state.enabled    = !!fakeCollection;
  state.failedOnce = false;
  state.role       = role;
  state.leader     = leader;
  // Installing a reachable fake = a verified start (the pre-Sprint-1 test contract).
  // A hydration that then runs re-derives the status from what it finds.
  sync.status = syncStatus;
}
/** Sprint 1 seams: inspect / set the initialization state. */
export function __syncForTests() {
  return { status: sync.status, dataDir: sync.dataDir, unverifiedSince: sync.unverifiedSince, blocked: new Map(sync.blocked), preservedLocal: [...sync.preservedLocal] };
}
export function __setSyncForTests({ status, dataDir } = {}) {
  if (status) sync.status = status;
  if (dataDir !== undefined) sync.dataDir = dataDir;
  sync.lastAttemptAt = 0;
}
/** Simulate "Mongo was unreachable at boot" for a data dir (writes the marker as a real failed boot would). */
export function __enterUnverifiedForTests(dataDir, reason = 'test') {
  sync.dataDir = dataDir;
  enterUnverified(reason);
  sync.lastAttemptAt = 0;
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
    shrinkRefused: 0, shrinkPreserved: 0,
  });
  state.knownGen.clear();
  state.knownBytes.clear();
  state.pending.clear();
  state.inflight.clear();
  state.retryTimers.clear();
  state.retryAttempts.clear();
  Object.assign(sync, { status: 'pending', dataDir: null, unverifiedSince: null, lastAttemptAt: 0, reconciling: null, preservedLocal: [] });
  sync.blocked.clear();
}
