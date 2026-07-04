/**
 * AQUA Conversations Route
 *
 * GET  /conversations         — list all conversations (id, messageCount, meta)
 * GET  /conversations/:id     — full message history for one conversation
 * DELETE /conversations/:id   — clear a conversation
 */
import express from 'express';
import {
  getAllConversations,
  getConversation,
  getConversationMeta,
  clearConversation,
  conversationExists,
} from '../memory/conversationStore.js';

const router = express.Router();

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
      messageCount: conv.messages?.length ?? 0,
      meta:         conv.meta ?? {},
    });
  }

  // newest first (by createdAt in meta, fallback to insertion order)
  entries.sort((a, b) => (b.meta.createdAt ?? 0) - (a.meta.createdAt ?? 0));

  res.json({
    success: true,
    total:   entries.length,
    count:   Math.min(limit, Math.max(0, entries.length - skip)),
    conversations: entries.slice(skip, skip + limit),
  });
});

// ── Get one conversation ──────────────────────────────────────────────────────

router.get('/:id', (req, res) => {
  const { id } = req.params;
  if (!conversationExists(id)) {
    return res.status(404).json({ success: false, error: 'Conversation not found' });
  }
  const messages = getConversation(id);
  const meta     = getConversationMeta(id);
  res.json({
    success: true,
    id,
    meta,
    messageCount: messages.length,
    messages,
  });
});

// ── Clear a conversation ──────────────────────────────────────────────────────

router.delete('/:id', (req, res) => {
  const { id } = req.params;
  if (!conversationExists(id)) {
    return res.status(404).json({ success: false, error: 'Conversation not found' });
  }
  clearConversation(id);
  res.json({ success: true, cleared: id });
});

export default router;
