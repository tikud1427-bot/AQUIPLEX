/**
 * AQUA Owner Resolver — THE single identity model for all long-term memory.
 * ─────────────────────────────────────────────────────────────────────────────
 * Every persistent memory (facts, beliefs, goals, graph, episodes, files)
 * belongs to exactly ONE ownerId, resolved here and nowhere else.
 *
 *   platform session present → `user:<aquaUserId>`   (cross-conversation,
 *                              cross-device, cross-restart — the real owner)
 *   no session (dev/standalone) → `conv:<conversationId>` fallback so the
 *                              engine still functions without the platform
 *                              session layer. NOT permanent user memory —
 *                              it is ADOPTED into `user:` on first login.
 *
 * Adoption: when a request carries BOTH a userId and a conversationId whose
 * `conv:` mind exists (created pre-login), that mind is merged into the
 * `user:` mind exactly once, then tombstoned. Deterministic: ten open
 * conversations for one logged-in user all resolve to the same owner.
 *
 * conversationId itself is NEVER a permanent memory key — only the
 * fallback owner prefix carries it, and only until adoption.
 */
import { peekMind, adoptMind } from '../mind/mindStore.js';
import { conversationExists, canAccessConversation } from './conversationStore.js';

/**
 * May `userId` adopt the `conv:` mind of `conversationId`? Only when the
 * conversation is unknown to the store (a pre-login id the client still
 * holds) or the store says the caller owns it — the same rule chat applies
 * before it reuses a conversation. Without this, any route that forwards a
 * client-supplied conversationId (brain GETs, /intelligence/orchestrate,
 * /project/workspace) let one account absorb and tombstone another
 * conversation's orphaned memory.
 */
function mayAdopt(userId, conversationId) {
  if (!conversationExists(conversationId)) return true;
  return canAccessConversation(userId, conversationId);
}

export function ownerForUser(userId) {
  return userId ? `user:${userId}` : null;
}

export function ownerForConversation(conversationId) {
  return conversationId ? `conv:${conversationId}` : null;
}

/**
 * Resolve the memory owner for a request. Side effect: performs one-time
 * adoption of a pre-login `conv:` mind into the `user:` mind.
 * @returns {string|null} ownerId, or null (memory disabled for this request)
 */
export function resolveOwner({ userId = null, conversationId = null } = {}) {
  if (userId) {
    const userOwner = ownerForUser(userId);
    if (conversationId) {
      const convOwner = ownerForConversation(conversationId);
      const orphan = peekMind(convOwner);
      if (orphan && !orphan.adoptedInto && mayAdopt(userId, conversationId)) {
        adoptMind(convOwner, userOwner);
      }
    }
    return userOwner;
  }
  if (conversationId) return ownerForConversation(conversationId);
  return null;
}

/** True when an owner is a real platform user (permanent memory tier). */
export function isUserOwner(ownerId) {
  return typeof ownerId === 'string' && ownerId.startsWith('user:');
}
