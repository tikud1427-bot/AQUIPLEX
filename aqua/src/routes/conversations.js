/**
 * AQUA Conversations Route
 *
 * GET    /conversations       — list all conversations (id, title, messageCount, meta)
 * GET    /conversations/:id   — full message history for one conversation
 * PATCH  /conversations/:id   — update title / pinned / archived (server-owned now)
 * DELETE /conversations/:id   — clear a conversation (trash-backed)
 */
import express from 'express';
import {
  getAllConversations,
  getConversation,
  getConversationMeta,
  clearConversation,
  conversationExists,
  updateConversationMeta,
} from '../memory/conversationStore.js';
import { clearAttachments } from '../upload/attachmentStore.js';
import { ok, fail, ErrorCodes } from './envelope.js';

const router = express.Router();

// ── Ownership guard (Phase 1 — security) ─────────────────────────────────────
// GET/DELETE /:id previously checked only that the conversation EXISTED — any
// authenticated user could read or delete any conversation by guessing its
// UUID (IDOR). This mirrors the list endpoint's rule exactly: when the platform
// supplies a session identity, the caller must own the row. Dev/standalone mode
// (no session → scopeUser null) is unchanged. Returns 404 (not 403) so a
// mismatch is indistinguishable from a missing id — no existence oracle.
function assertOwnership(req, res, id) {
  if (!conversationExists(id)) {
    fail(res, ErrorCodes.NOT_FOUND, 'Conversation not found');
    return false;
  }
  const scopeUser = req.aquaUserId ?? null;
  const owner = getConversationMeta(id)?.userId ?? null;
  if (scopeUser && owner !== scopeUser) {
    fail(res, ErrorCodes.NOT_FOUND, 'Conversation not found');
    return false;
  }
  return true;
}

// ── List all conversations ────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const all   = getAllConversations();  // Map<id, { messages, meta }>
  const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500);
  const skip  = parseInt(req.query.skip ?? '0', 10);

  // Per-user scoping: when the platform provides a session identity, only
  // return that user's conversations. Legacy rows with no userId stay
  // invisible to authenticated users (rather than leaking to everyone).
  const scopeUser = req.aquaUserId ?? null;

  const entries = [];
  for (const [id, conv] of all.entries()) {
    const owner = conv.meta?.userId ?? null;
    if (scopeUser && owner !== scopeUser) continue;
    entries.push({
      id,
      // Server-owned display fields (P0 — titles used to live only in one
      // browser's localStorage; every other device saw bare UUID stubs).
      title:        conv.meta?.title ?? null,
      pinned:       !!conv.meta?.pinned,
      archived:     !!conv.meta?.archived,
      updatedAt:    conv.meta?.updatedAt ?? conv.meta?.createdAt ?? 0,
      messageCount: conv.messages?.length ?? 0,
      meta:         conv.meta ?? {},
    });
  }

  // Most recent activity first (falls back to creation time for old rows).
  entries.sort((a, b) => b.updatedAt - a.updatedAt);

  ok(res, {
    total:   entries.length,
    count:   Math.min(limit, Math.max(0, entries.length - skip)),
    conversations: entries.slice(skip, skip + limit),
  });
});

// ── Get one conversation ──────────────────────────────────────────────────────

router.get('/:id', (req, res) => {
  const { id } = req.params;
  if (!assertOwnership(req, res, id)) return;
  const messages = getConversation(id);
  const meta     = getConversationMeta(id);
  ok(res, { id, meta, messageCount: messages.length, messages });
});

// ── Update conversation metadata (title / pin / archive) ─────────────────────
// P0 — the server owns these now. The frontend's localStorage overlay becomes
// a one-time seed + offline cache instead of the single copy of every title.

router.patch('/:id', (req, res) => {
  const { id } = req.params;
  if (!assertOwnership(req, res, id)) return;
  const { title, pinned, archived } = req.body ?? {};
  const patch = {};
  if (title    !== undefined) patch.title    = title;
  if (pinned   !== undefined) patch.pinned   = pinned;
  if (archived !== undefined) patch.archived = archived;
  if (Object.keys(patch).length === 0) {
    return fail(res, ErrorCodes.BAD_REQUEST, 'Nothing to update — provide title, pinned, or archived.');
  }
  const meta = updateConversationMeta(id, patch);
  ok(res, { id, meta });
});

// ── Clear a conversation ──────────────────────────────────────────────────────

router.delete('/:id', (req, res) => {
  const { id } = req.params;
  if (!assertOwnership(req, res, id)) return;
  clearConversation(id);
  clearAttachments(id); // P0 — attachments persist now; don't orphan their blobs
  ok(res, { cleared: id });
});

export default router;
