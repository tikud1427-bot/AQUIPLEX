/**
 * AQUA Conversation Store v3
 *
 * ROOT FIXES (v3 — supersedes v2):
 *   Problem1 (orphan entries): old createConversation() ALWAYS minted its
 *     own internal uuidv4(), silently discarding any id the caller passed
 *     in meta.id. chat.js kept using ITS OWN id for everything downstream
 *     (logging, addMessage, response) while the store quietly held a
 *     permanent 0-message entry under the discarded id. Every first turn
 *     left exactly one orphan behind — confirmed live via repro.
 *   Problem3 (impossible log sequence): chat.js decided CREATED vs REUSED
 *     from "did the client send an id at all", not "does this id actually
 *     exist in the store". Any brand-new caller-supplied id (custom/test
 *     id, or first-ever id under the orphan bug above) got logged as
 *     REUSED on its very first appearance — no prior CREATED log for that
 *     id ever existed. Logically impossible to reuse what was never
 *     created — confirmed live: "[CHAT] CONVERSATION_REUSED id=phase6-simple"
 *     with zero preceding CREATED line for that id anywhere.
 *
 *   FIX: getOrCreateConversation(id, meta) is the new shared layer — ONE
 *   atomic check decides existence, performs the mutation (if needed) AT
 *   THE EXACT id the caller keeps using, and emits the CREATED/REUSED log
 *   itself in the same branch. Log and mutation share one source of truth,
 *   so they can no longer disagree. chat.js is wired to call this instead
 *   of hand-rolling its own conversationExists()+createConversation()
 *   branching. createConversation() stays exported (other callers may still
 *   want "always ensure this id exists") but no longer discards meta.id and
 *   no longer clobbers an existing conversation if that id is already taken.
 *
 * ID contract:
 *   conversationId — stable across entire conversation, generated once by server
 *   requestId      — unique per HTTP request (in observability context, NOT here)
 *   sessionId      — optional: caller's concept, stored as metadata only
 */

import { v4 as uuidv4 } from 'uuid';
import {
  createDebouncedWriter,
  atomicWriteFileSync,
  loadJsonFile,
  wrapStore,
  unwrapStore,
} from '../core/atomicStore.js';
import { migrateLegacyFile, dataPath } from '../core/dataDir.js';
import { bindConversationStore, MESSAGE_KEY } from './conversationPartitions.js';
import { getMirrorStatus } from '../core/mongoMirror.js';

// P0 v4 — history lives in the canonical DATA DIRECTORY, not the deploy tree.
// migrateLegacyFile() performs the one-time, loss-proof move of any existing
// cwd `.aqua-history.json` on boot (copy → verify → keep original as backup).
const HISTORY_FILE = migrateLegacyFile('.aqua-history.json');
const TRASH_FILE   = dataPath('.aqua-history-trash.json');
const SCHEMA       = 1;

// P0 v4 — the old MAX_HISTORY_PER_CONV=200 rolling splice PERMANENTLY DELETED
// messages beyond 200 per conversation. The model context window is budgeted
// separately (buildContextWindow), so the cap bought nothing and silently
// destroyed history. Storage now keeps everything up to a wide safety valve.
const HARD_CAP_PER_CONV = 5000; // safety valve only — warn + trim far past any real use

// Map<conversationId, { messages: Array, meta: object }>
const store = new Map();

// Ids deleted by this process (bounded) — addMessage never resurrects them (D-13).
const deletedIds = new Set();
function noteDeleted(id) {
  deletedIds.add(id);
  if (deletedIds.size > 2000) deletedIds.delete(deletedIds.values().next().value);
}

// Phase 2b, step 3 — revision-based message persistence (memory/conversationPartitions.js).
// AQUA_STORE_PARTITIONS=history:<mode>. Off (default): every hook is a no-op.
const partitions = bindConversationStore({ file: HISTORY_FILE, store, reloadJson: () => loadFromDisk() });
const P = partitions.hooks;

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFromDisk() {
  const parsed = loadJsonFile(HISTORY_FILE, { label: 'history' });
  if (parsed == null) return;
  const { data } = unwrapStore(parsed, { expected: SCHEMA, file: HISTORY_FILE, label: 'history' });
  if (!data || typeof data !== 'object') return;
  let total = 0;
  for (const [id, conv] of Object.entries(data)) {
    // Support both old format (array) and new format ({ messages, meta })
    const messages = Array.isArray(conv) ? conv : (conv.messages || []);
    const meta     = Array.isArray(conv) ? {} : (conv.meta || {});
    store.set(id, { messages, meta });
    total += messages.length;
  }
  P.adoptJsonLoaded();
  console.log(`[STORE] Loaded ${store.size} conversations (${total} messages) from ${HISTORY_FILE}`);
}

// Phase 3b — atomic + async persistence via the shared primitive.
// The writer also takes a boot backup (`.bak`) before this process's first
// flush, so every deploy leaves a last-known-good snapshot behind.
// 2026-11-16 (audit D-15): what the history file's writer actually did — read by
// persistenceState(), never assumed from an in-memory write.
const writeState = { lastOkAt: null, lastErrorAt: null, lastError: null };
const _writer = createDebouncedWriter(HISTORY_FILE, {
  onFlushed: () => { writeState.lastOkAt = Date.now(); },
  onError: (err) => {
    writeState.lastErrorAt = Date.now();
    writeState.lastError = String(err?.code ?? err?.name ?? 'error');
    console.warn(`[STORE] atomic write failed for ${HISTORY_FILE.split(/[\\/]/).pop()}: ${err?.message ?? err}`);
  },
});
function scheduleSave() {
  // Partitions authoritative: the binding writes per message and keeps the
  // JSON rollback copy itself. The whole file is never rewritten from memory,
  // which now holds only the owners loaded by requests.
  if (!partitions.writesWholeJson()) return;
  _writer.schedule(() => {
    const data = {};
    for (const [id, conv] of store.entries()) {
      data[id] = conv;
    }
    return JSON.stringify(wrapStore(SCHEMA, data));
  });
}

if (partitions.loadsJsonAtBoot()) loadFromDisk();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ensure a conversation exists. If meta.id is supplied and already exists,
 * this is a no-op (never clobbers existing messages). If meta.id is
 * supplied and is new, the conversation is created AT THAT id (this is the
 * Problem1 fix — the old version silently minted a different id here).
 * If no meta.id is supplied, a fresh UUID is minted, matching old behavior
 * for any caller that never passed an id.
 *
 * Most callers wanting "create or get, and tell me which happened" should
 * use getOrCreateConversation() instead — it's atomic and also drives the
 * CREATED/REUSED log from the same check, so it can't disagree with itself.
 *
 * @param {object} [meta]  - optional metadata: { id, userId, sessionId, userAgent }
 * @returns {string} conversationId (the id used — caller's id if provided)
 */
export function createConversation(meta = {}) {
  const { id: requestedId, ...rest } = meta;

  if (requestedId && store.has(requestedId)) {
    console.log(`[STORE] createConversation no-op, already exists id=${requestedId}`);
    return requestedId;
  }

  const id = requestedId || uuidv4();
  store.set(id, { messages: [], meta: { createdAt: Date.now(), ...rest } });
  P.created(id);
  scheduleSave();
  console.log(`[STORE] CREATED conversation=${id}`);
  return id;
}

/**
 * Shared layer — single atomic create-or-get. THE authoritative source of
 * truth for "is this conversation new". The store mutation and the
 * CREATED/REUSED log happen together, in the same branch, so they cannot
 * diverge (this is the Problem3 fix).
 *
 * @param {string|null|undefined} id  - caller-supplied id, or falsy to mint one
 * @param {object} [meta]             - metadata for a freshly created conversation (ignored on reuse)
 * @returns {{ id: string, isNew: boolean }}
 */
export function getOrCreateConversation(id, meta = {}) {
  if (id && store.has(id)) {
    console.log(`[STORE] REUSED conversation=${id}`);
    return { id, isNew: false };
  }

  const finalId = id || uuidv4();
  store.set(finalId, { messages: [], meta: { createdAt: Date.now(), ...meta } });
  P.created(finalId);
  scheduleSave();
  console.log(`[STORE] CREATED conversation=${finalId}`);
  return { id: finalId, isNew: true };
}

/**
 * Check if a conversation exists.
 * Used by other routes (conversations.js, memory.js) for existence checks
 * that don't need create-on-miss semantics.
 */
export function conversationExists(id) {
  return typeof id === 'string' && id.length > 0 && store.has(id);
}

/**
 * Phase 0 (audit F4) — object-level authorization, store edition.
 * Platform sessions (scopeUserId set) may only touch conversations they
 * own; sessionless/dev traffic (scopeUserId null) is unscoped, exactly
 * matching the contract conversations.js assertOwnership established.
 * Pure store lookup — routes decide the HTTP shape (404, no oracle).
 */
export function canAccessConversation(scopeUserId, id) {
  if (!scopeUserId) return true;
  const owner = store.get(id)?.meta?.userId ?? null;
  return owner === scopeUserId;
}

/**
 * Get message history for a conversation.
 * Returns empty array (not null) for unknown IDs.
 * Does NOT auto-create — use createConversation() explicitly.
 */
export function getConversation(id) {
  const conv = store.get(id);
  if (!conv) {
    console.warn(`[STORE] getConversation miss id=${id} — returning []`);
    return [];
  }
  return conv.messages;
}

/**
 * Append a message to a conversation.
 * Auto-creates if missing (defensive — shouldn't normally happen).
 */
export function addMessage(id, role, content, extra = null) {
  if (!store.has(id)) {
    // D-13 (2026-11-16): a conversation deleted while a turn was in flight is
    // NOT resurrected (it would come back owner-less and unreadable — and the
    // user asked for it to be gone). Any other auto-create carries the owner
    // the caller vouches for, so it stays reachable by that user.
    if (deletedIds.has(id)) {
      console.warn(`[STORE] addMessage: conversation ${id} was deleted during the turn — message not stored`);
      return null;
    }
    console.warn(`[STORE] addMessage: conversation ${id} not found — auto-creating`);
    const owner = extra?.ownerUserId ?? null;
    store.set(id, { messages: [], meta: { autoCreated: true, createdAt: Date.now(), ...(owner ? { userId: String(owner) } : {}) } });
    P.created(id);
  }

  const conv = store.get(id);
  // extra: contextRefs (memory/contextProvenance.js) — references, never
  // personal text, so forget/correct have nothing new to chase — and, since
  // 2026-11-16 (D-06), the verification verdict of an assistant message
  // (status words only), so a reviewer-revised answer is never
  // indistinguishable from a confirmed one in the history.
  const msg = { role, content, ts: Date.now() };
  if (Array.isArray(extra?.contextRefs) && extra.contextRefs.length) msg.contextRefs = extra.contextRefs;
  if (role === 'assistant' && extra?.verification && typeof extra.verification === 'object') {
    const v = extra.verification;
    msg.verification = {
      status: typeof v.status === 'string' ? v.status.slice(0, 32) : null,
      outcome: typeof v.outcome === 'string' ? v.outcome.slice(0, 32) : null,
      revised: !!v.revised,
    };
  }
  conv.meta.updatedAt = Date.now();
  P.messageAdded(id, msg);   // partitions on: a stable `mid` and its own row (no-op when off)
  conv.messages.push(msg);

  // Safety valve ONLY (was a silent 200-message rolling delete — see header).
  // Context sent to the model is budgeted separately; storage keeps history.
  if (conv.messages.length > HARD_CAP_PER_CONV) {
    console.warn(`[STORE] conversation ${id} exceeded ${HARD_CAP_PER_CONV} messages — trimming oldest (safety valve)`);
    P.messagesTrimmed(id, conv.messages.splice(0, conv.messages.length - HARD_CAP_PER_CONV));
  }

  scheduleSave();
  return conv.messages;
}

// ── Meta management (P0 v4 — titles/pins/archive live SERVER-side) ───────────

// UUS U5: `kind` marks a conversation's ROLE — currently only
// 'understanding_intro', which is how the first-run gate knows an account has
// already done the intro. It is derived first-run state living beside the
// conversation itself rather than a stored "has onboarded" flag that could
// disagree with whether the conversation happened.
//
// It has to be here. The architecture called conversation.meta "an open bag";
// it is not — this whitelist silently DROPS anything unlisted, and `continue`
// makes the drop invisible. U2 wrote `kind` for a full phase and every write
// was discarded with no error, which is exactly the class of failure this
// sprint has now hit three times: the code exists, the intent exists, nothing
// happens, and nobody is told.
const META_PATCH_WHITELIST = new Set(['title', 'pinned', 'archived', 'kind', 'introCompletedAt']);

/** Values `kind` may take. An unrecognised role is rejected, not stored. */
const META_KINDS = new Set(['understanding_intro']);

/**
 * Patch a conversation's metadata. Only whitelisted, user-facing fields are
 * accepted (title / pinned / archived) — identity fields (userId, createdAt)
 * can never be overwritten through this path. Returns the updated meta, or
 * null if the conversation doesn't exist.
 */
export function updateConversationMeta(id, patch = {}) {
  const conv = store.get(id);
  if (!conv) return null;
  P.metaChanged(id, ['updatedAt', ...Object.keys(patch).filter(k => META_PATCH_WHITELIST.has(k))]);
  for (const [k, v] of Object.entries(patch)) {
    if (!META_PATCH_WHITELIST.has(k)) continue;
    if (k === 'kind') {
      if (!META_KINDS.has(v)) continue;
      conv.meta.kind = v;
      continue;
    }
    if (k === 'introCompletedAt') {
      if (!Number.isFinite(v)) continue;
      conv.meta.introCompletedAt = v;
      continue;
    }
    if (k === 'title') {
      if (typeof v !== 'string') continue;
      const t = v.trim().slice(0, 120);
      if (!t) continue;
      conv.meta.title = t;
    } else {
      conv.meta[k] = !!v;
    }
  }
  conv.meta.updatedAt = Date.now();
  scheduleSave();
  return conv.meta;
}

/**
 * Derive a stable server-side title from the first user message. The server
 * owns titles now (P0 — they used to live only in one browser's localStorage,
 * so a cache clear or second device "lost" every conversation name).
 */
export function deriveTitle(text) {
  const raw = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!raw) return 'New conversation';
  const cut = raw.slice(0, 64);
  const nice = cut.length < raw.length
    ? cut.slice(0, Math.max(24, cut.lastIndexOf(' '))).trim() + '…'
    : cut;
  return nice.charAt(0).toUpperCase() + nice.slice(1);
}

/**
 * Get conversation metadata.
 */
export function getConversationMeta(id) {
  return store.get(id)?.meta || null;
}

/**
 * Clear a conversation (history + metadata).
 * P0 — destructive ops get an automatic backup: the deleted conversation is
 * snapshotted into a rolling trash file (last 40 deletions) before removal,
 * so an accidental delete is recoverable from disk.
 */
export function clearConversation(id) {
  const conv = store.get(id);
  if (conv && !P.trashed(id)) {   // partitions on: the snapshot is a row of the trash store instead
    try {
      const parsed = loadJsonFile(TRASH_FILE, { label: 'history-trash' });
      const trash  = Array.isArray(parsed) ? parsed : [];
      trash.push({ id, deletedAt: Date.now(), ...conv });
      while (trash.length > 40) trash.shift();
      atomicWriteFileSync(TRASH_FILE, JSON.stringify(trash));
    } catch (err) {
      console.warn(`[STORE] trash snapshot failed for ${id}: ${err.message} — deleting anyway`);
    }
  }
  P.conversationDeleted(id);
  store.delete(id);
  noteDeleted(id);
  scheduleSave();
}

// ── Account deletion (Google Play / GDPR) ───────────────────────────────────
// clearConversation() deliberately keeps a rolling trash snapshot so a single
// accidental delete stays recoverable. An account-deletion request is the one
// case where that guarantee must NOT apply: nothing may survive it. These
// helpers are the purge path — same store, no trash, no revival.

/** All conversation ids owned by one platform user. */
export function listConversationIdsForUser(userId) {
  if (!userId) return [];
  const uid = String(userId);
  const ids = [];
  for (const [id, conv] of store.entries()) {
    if (conv?.meta?.userId != null && String(conv.meta.userId) === uid) ids.push(id);
  }
  return ids;
}

/** Delete a conversation permanently — no trash snapshot. */
export function purgeConversation(id) {
  P.conversationDeleted(id);
  const existed = store.delete(id);
  noteDeleted(id);
  if (existed) scheduleSave();
  return existed;
}

/**
 * Drop every trash snapshot belonging to a user. Conversations this user
 * deleted earlier are still on disk in TRASH_FILE; account deletion has to
 * take those too. Returns the number of snapshots removed.
 */
export function purgeTrashForUser(userId) {
  if (!userId) return 0;
  // Partitions on: the user's trash rows are tombstoned by the binding's next
  // flush (the count is not known synchronously; reported as 0).
  if (P.trashPurged(String(userId))) return 0;
  const uid = String(userId);
  try {
    const parsed = loadJsonFile(TRASH_FILE, { label: 'history-trash' });
    if (!Array.isArray(parsed) || !parsed.length) return 0;
    const kept = parsed.filter(entry => String(entry?.meta?.userId ?? '') !== uid);
    const removed = parsed.length - kept.length;
    if (removed > 0) atomicWriteFileSync(TRASH_FILE, JSON.stringify(kept));
    return removed;
  } catch (err) {
    console.warn(`[STORE] trash purge failed for user=${uid}: ${err.message}`);
    return 0;
  }
}

// ── Message revisions (Phase 2b, step 3) ─────────────────────────────────────

/** A message's stable key ("1-…" for new messages, "0-000042" for migrated ones). */
export function messageKeyOf(conversationId, message) {
  const conv = store.get(conversationId);
  if (!conv || !message) return null;
  return message[MESSAGE_KEY] ?? partitions.keyOf(message, conv.messages.indexOf(message));
}

/**
 * Edit one message (content / contextRefs). With partitions on, the write is
 * checked against the version this process holds: a concurrent edit returns
 * `{ ok: false, conflict: true, current }` instead of overwriting it.
 */
export async function editMessage(conversationId, key, patch) {
  const r = await partitions.editMessage(conversationId, key, patch);
  if (r.ok) { const conv = store.get(conversationId); if (conv) conv.meta.updatedAt = Date.now(); scheduleSave(); }
  return r;
}

/** Delete one message (a tombstone with partitions on). */
export async function deleteMessage(conversationId, key) {
  const r = await partitions.deleteMessage(conversationId, key);
  if (r.ok) scheduleSave();
  return r;
}

export function conversationPartitionBinding() { return partitions; }

/**
 * Phase 3 — write this turn's messages and its learning jobs in ONE
 * transaction (memory/conversationPartitions.js commitTurn). Throws, with the
 * messages removed again, if they could not be made durable.
 */
export async function commitTurnDurably(conversationId, messages, jobsWithin) {
  return partitions.commitTurn(conversationId, messages, jobsWithin);
}

/** Can turns be committed durably here (history partitions authoritative)? */
export function durableTurnCommitAvailable() { return partitions.authoritative(); }

// ── Missing-conversation recovery + truthful persistence state (2026-11-16) ──
//
// Audit D-07: a conversation id the client already holds but this process's Map
// lacks (restart, second instance, unverified mirror, owner partition not
// loaded) used to be silently RE-CREATED empty at that id, and the next answer
// had no history. These two functions let the route tell the cases apart.

/** Is the configured persistence able to say whether this id exists right now? */
function persistenceUnavailableReason(userId) {
  if (partitions.authoritative() && userId && !partitions.ready(`user:${userId}`)) return 'owner-partition-not-loaded';
  try {
    const m = getMirrorStatus();
    if (m?.enabled && /^(UNVERIFIED|RECOVERY REQUIRED)/.test(String(m.verdict ?? ''))) return 'mirror-unverified';
  } catch { /* status unavailable is not evidence of anything */ }
  return null;
}

/**
 * Re-read ONE conversation from the history file into the Map (JSON-backed
 * modes only — partitions load whole owners through ensureOwnerLoaded). Used
 * when another process on the same disk wrote it after this one booted.
 * @returns {boolean} true when the conversation is now present
 */
export function recoverConversation(id) {
  if (!id || store.has(id)) return store.has(id);
  if (!partitions.loadsJsonAtBoot() || deletedIds.has(id)) return false;
  try {
    const parsed = loadJsonFile(HISTORY_FILE, { label: 'history' });
    if (parsed == null) return false;
    const { data } = unwrapStore(parsed, { expected: SCHEMA, file: HISTORY_FILE, label: 'history' });
    const conv = data?.[id];
    if (!conv) return false;
    const messages = Array.isArray(conv) ? conv : (conv.messages || []);
    const meta = Array.isArray(conv) ? {} : (conv.meta || {});
    store.set(id, { messages, meta });
    console.log(`[STORE] RECOVERED conversation=${id} from disk (messages=${messages.length})`);
    return true;
  } catch (err) {
    console.warn(`[STORE] recovery read failed for ${id}: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Where does a requested conversation id stand for this request?
 *   'present'      in the Map
 *   'recovered'    was not, and has just been reloaded from disk
 *   'unavailable'  persistence cannot answer right now (retryable)
 *   'absent'       persistence answered: no such conversation
 */
export function conversationLoadState(id, userId = null) {
  if (!id) return 'absent';
  if (store.has(id)) return 'present';
  if (recoverConversation(id)) return 'recovered';
  return persistenceUnavailableReason(userId) ? 'unavailable' : 'absent';
}

/**
 * Truthful persistence state of the conversation history (audit D-09/D-15).
 *   DURABLE    committed in the authoritative database (partitions) for this turn
 *   MIRRORED   written to disk and the Mongo mirror is verified and healthy
 *   LOCAL_ONLY written to disk, no mirror configured — lost on a Render redeploy
 *   DEGRADED   the mirror is configured but not durable (unverified, failing, standby)
 *   FAILED     the last write of the history file failed
 *   PENDING    nothing written since the change yet (debounce window)
 * @param {{ durableCommit?: boolean }} [opts]
 */
export function persistenceState({ durableCommit = false } = {}) {
  if (durableCommit) return 'DURABLE';
  if (writeState.lastErrorAt && (!writeState.lastOkAt || writeState.lastErrorAt > writeState.lastOkAt)) return 'FAILED';
  let mirror = null;
  try { mirror = getMirrorStatus(); } catch { mirror = null; }
  if (!mirror || !mirror.enabled) return 'LOCAL_ONLY';
  return mirror.durable ? 'MIRRORED' : 'DEGRADED';
}

/** Privacy-safe status for /provider-health style reporting. */
export function historyWriteStatus() {
  return { ...writeState, pending: _writer.isPending?.() ?? null, partitions: partitions.mode };
}

/**
 * Return all conversations (for admin/debug use only).
 */
export function getAllConversations() {
  return store;
}

/**
 * Return summary stats for health endpoint.
 */
export function getStoreStats() {
  let totalMessages = 0;
  for (const { messages } of store.values()) totalMessages += messages.length;
  return { conversations: store.size, totalMessages };
}