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

import fs   from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createDebouncedWriter } from '../core/atomicStore.js';

const HISTORY_FILE          = path.join(process.cwd(), '.aqua-history.json');
const MAX_HISTORY_PER_CONV  = 200;  // rolling window cap

// Map<conversationId, { messages: Array, meta: object }>
const store = new Map();

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFromDisk() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const raw  = fs.readFileSync(HISTORY_FILE, 'utf8');
    const data = JSON.parse(raw);
    let total  = 0;
    for (const [id, conv] of Object.entries(data)) {
      // Support both old format (array) and new format ({ messages, meta })
      const messages = Array.isArray(conv) ? conv : (conv.messages || []);
      const meta     = Array.isArray(conv) ? {} : (conv.meta || {});
      store.set(id, { messages, meta });
      total += messages.length;
    }
    console.log(`[STORE] Loaded ${store.size} conversations (${total} messages) from disk`);
  } catch (err) {
    console.warn('[STORE] Could not load history from disk:', err.message);
  }
}

// Phase 3b — atomic + async persistence via the shared primitive.
const _writer = createDebouncedWriter(HISTORY_FILE);
function scheduleSave() {
  _writer.schedule(() => {
    const data = {};
    for (const [id, conv] of store.entries()) {
      data[id] = conv;
    }
    return JSON.stringify(data);
  });
}

loadFromDisk();

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
export function addMessage(id, role, content) {
  if (!store.has(id)) {
    console.warn(`[STORE] addMessage: conversation ${id} not found — auto-creating`);
    store.set(id, { messages: [], meta: { autoCreated: true } });
  }

  const { messages } = store.get(id);
  messages.push({ role, content, ts: Date.now() });

  // Rolling window — keep only the last N messages
  if (messages.length > MAX_HISTORY_PER_CONV) {
    messages.splice(0, messages.length - MAX_HISTORY_PER_CONV);
  }

  scheduleSave();
  return messages;
}

/**
 * Get conversation metadata.
 */
export function getConversationMeta(id) {
  return store.get(id)?.meta || null;
}

/**
 * Clear a conversation (history + metadata).
 */
export function clearConversation(id) {
  store.delete(id);
  scheduleSave();
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
