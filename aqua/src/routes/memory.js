/**
 * AQUA Memory Inspector Route
 *
 * GET  /memory/:conversationId             — all facts for a conversation
 * GET  /memory/:conversationId/:key        — single fact (with history)
 * DELETE /memory/:conversationId/:key      — delete a fact
 * DELETE /memory/:conversationId           — clear all facts for conversation
 */
import express from 'express';
import {
  getFacts,
  getFact,
  deleteFact,
  clearFacts,
  getFactHistory,
} from '../memory/longTermMemory.js';
import { conversationExists } from '../memory/conversationStore.js';

const router = express.Router();

// ── All facts for a conversation ──────────────────────────────────────────────

router.get('/:conversationId', (req, res) => {
  const { conversationId } = req.params;
  const factsMap = getFacts(conversationId);  // Map<key, fact>
  const facts    = factsMap ? [...factsMap.values()] : [];

  // sort by importance desc, then ts desc
  facts.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || (b.ts ?? 0) - (a.ts ?? 0));

  res.json({
    success:        true,
    conversationId,
    factCount:      facts.length,
    facts,
  });
});

// ── Single fact ───────────────────────────────────────────────────────────────

router.get('/:conversationId/:key', (req, res) => {
  const { conversationId, key } = req.params;
  const fact = getFact(conversationId, key);
  if (!fact) {
    return res.status(404).json({ success: false, error: `Fact '${key}' not found` });
  }
  const history = getFactHistory(conversationId, key);
  res.json({ success: true, conversationId, key, fact, history });
});

// ── Delete single fact ────────────────────────────────────────────────────────

router.delete('/:conversationId/:key', (req, res) => {
  const { conversationId, key } = req.params;
  deleteFact(conversationId, key);
  res.json({ success: true, conversationId, deleted: key });
});

// ── Clear all facts for conversation ─────────────────────────────────────────

router.delete('/:conversationId', (req, res) => {
  const { conversationId } = req.params;
  clearFacts(conversationId);
  res.json({ success: true, conversationId, cleared: true });
});

export default router;
