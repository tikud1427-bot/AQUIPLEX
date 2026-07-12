/**
 * AQUA Memory Inspector Route (UNIFIED)
 * ─────────────────────────────────────────────────────────────────────────────
 * Owner-scoped: memories belong to the resolved owner (user session first,
 * conversation fallback) — never permanently to a conversationId.
 *
 *   GET    /memory                          — all facts for the caller's owner
 *   GET    /memory/inspector/:requestId     — full decision trace for one chat
 *                                             turn (Req 14: explainable memory)
 *   GET    /memory/fact/:key                — single fact + revision history
 *   DELETE /memory/fact/:key                — delete a fact
 *   DELETE /memory                          — clear the caller's facts
 *
 * Back-compat (old conversation-keyed API — resolves that conversation's
 * OWNER first, then serves owner-scoped data):
 *   GET    /memory/:conversationId
 *   GET    /memory/:conversationId/:key
 *   DELETE /memory/:conversationId[/:key]
 */
import express from 'express';
import {
  getFacts, getFact, deleteFact, clearFacts, getFactHistory,
} from '../memory/longTermMemory.js';
import { resolveOwner, getMemoryTrace } from '../memory/engine.js';
import { conversationExists, getConversationMeta } from '../memory/conversationStore.js';

const router = express.Router();

function ownerOf(req, conversationId = null) {
  return resolveOwner({
    userId: req.aquaUserId ?? null,
    conversationId: conversationId ?? req.query.conversationId ?? null,
  });
}

/** Old-style routes carried a conversationId — resolve it to its true owner. */
function ownerForLegacyConversation(req, conversationId) {
  const meta = conversationExists(conversationId) ? getConversationMeta(conversationId) : null;
  return resolveOwner({
    userId: req.aquaUserId ?? meta?.userId ?? null,
    conversationId,
  });
}

// ── Ownership guard for legacy conversation-keyed routes (Phase 1 — security) ──
// resolveOwner() has a SIDE EFFECT: given a userId + a conversationId whose
// pre-login `conv:` mind exists, it merges that mind into the caller's user
// mind and tombstones it (adoption). Without this guard an authenticated user
// could pass a *victim's* conversationId and siphon + destroy the victim's
// orphan mind — and in dev mode read any conversation's facts. When authed,
// the caller must own the named conversation; a non-existent id resolves to
// the caller's own owner (no cross-user reach) and is allowed. 404 on mismatch
// (no existence oracle). Dev/standalone (no session) is unchanged.
function assertLegacyConvAccess(req, res, conversationId) {
  const scopeUser = req.aquaUserId ?? null;
  if (!scopeUser) return true;                                  // dev/standalone — unchanged
  if (!conversationExists(conversationId)) return true;         // resolves to caller's own owner
  const owner = getConversationMeta(conversationId)?.userId ?? null;
  if (owner !== scopeUser) {
    res.status(404).json({ success: false, error: 'Conversation not found' });
    return false;
  }
  return true;
}

function factsPayload(ownerId) {
  const facts = getFacts(ownerId);
  return { success: true, ownerId, factCount: facts.length, facts };
}

// ── Memory Inspector: explainable per-turn trace (Req 14) ────────────────────
router.get('/inspector/:requestId', (req, res) => {
  const trace = getMemoryTrace(req.params.requestId);
  if (!trace) {
    return res.status(404).json({ success: false, error: 'No trace for that requestId (ring keeps the last 100 turns)' });
  }
  res.json({ success: true, requestId: req.params.requestId, trace });
});

// ── Owner-scoped API ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return res.status(400).json({ success: false, error: 'No memory owner (no session and no ?conversationId)' });
  res.json(factsPayload(ownerId));
});

router.get('/fact/:key', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return res.status(400).json({ success: false, error: 'No memory owner' });
  const fact = getFact(ownerId, req.params.key);
  if (!fact) return res.status(404).json({ success: false, error: `Fact '${req.params.key}' not found` });
  res.json({ success: true, ownerId, key: req.params.key, fact, history: getFactHistory(ownerId, req.params.key) });
});

router.delete('/fact/:key', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return res.status(400).json({ success: false, error: 'No memory owner' });
  deleteFact(ownerId, req.params.key);
  res.json({ success: true, ownerId, deleted: req.params.key });
});

router.delete('/', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return res.status(400).json({ success: false, error: 'No memory owner' });
  clearFacts(ownerId);
  res.json({ success: true, ownerId, cleared: true });
});

// ── Back-compat: conversation-keyed paths → owner-scoped data ────────────────
router.get('/:conversationId', (req, res) => {
  if (!assertLegacyConvAccess(req, res, req.params.conversationId)) return;
  const ownerId = ownerForLegacyConversation(req, req.params.conversationId);
  res.json({ ...factsPayload(ownerId), conversationId: req.params.conversationId });
});

router.get('/:conversationId/:key', (req, res) => {
  const { conversationId, key } = req.params;
  if (!assertLegacyConvAccess(req, res, conversationId)) return;
  const ownerId = ownerForLegacyConversation(req, conversationId);
  const fact = getFact(ownerId, key);
  if (!fact) return res.status(404).json({ success: false, error: `Fact '${key}' not found` });
  res.json({ success: true, ownerId, conversationId, key, fact, history: getFactHistory(ownerId, key) });
});

router.delete('/:conversationId/:key', (req, res) => {
  const { conversationId, key } = req.params;
  if (!assertLegacyConvAccess(req, res, conversationId)) return;
  const ownerId = ownerForLegacyConversation(req, conversationId);
  deleteFact(ownerId, key);
  res.json({ success: true, ownerId, conversationId, deleted: key });
});

router.delete('/:conversationId', (req, res) => {
  const { conversationId } = req.params;
  if (!assertLegacyConvAccess(req, res, conversationId)) return;
  const ownerId = ownerForLegacyConversation(req, conversationId);
  clearFacts(ownerId);
  res.json({ success: true, ownerId, conversationId, cleared: true });
});

export default router;
