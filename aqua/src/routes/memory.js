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
import { resolveOwner, getMemoryTrace, semanticFileChunks } from '../memory/engine.js';
import { retrieveRelevantFacts } from '../memory/memoryRetriever.js';
import { recallEpisodes } from '../mind/episodeRecall.js';
import { recallGraphPaths } from '../mind/graphRecall.js';
import { peekMind } from '../mind/mindStore.js';
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

/**
 * Memory 5.0 Phase G — UNIFIED RECALL. One query, every memory layer:
 * ranked facts + matching episodes + graph paths + uploaded-file chunks.
 * Powering surface for the frontend Mind View search and for agents.
 * Owner-scoped like every route here; each lane fails open to [].
 *
 *   GET /memory/recall?q=<query>[&limit=8]
 */
router.get('/recall', async (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return res.status(400).json({ success: false, error: 'No memory owner (no session and no ?conversationId)' });
  const q = String(req.query.q || '').slice(0, 500);
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 8));

  let facts = [];
  try {
    facts = retrieveRelevantFacts(ownerId, q, limit).map(f => ({
      key: f.key, value: f.value, category: f.category,
      confidence: f.confidence, importance: f.importance,
      pinned: !!f.pinned, lastMentionedAt: f.lastMentionedAt,
    }));
  } catch { /* lane fails open */ }

  const mind = peekMind(ownerId);
  let episodes = [];
  let graphPaths = [];
  try {
    episodes = (mind ? recallEpisodes(mind, q, { limit: 3 }) : []).map(({ episode: e, score }) => ({
      id: e.id, title: e.title, status: e.status, outcome: e.outcome,
      lessons: e.lessons || [], startedAt: e.startedAt, endedAt: e.endedAt, score,
    }));
  } catch { /* lane fails open */ }
  try {
    graphPaths = mind ? recallGraphPaths(mind, q) : [];
  } catch { /* lane fails open */ }

  let files = [];
  try {
    files = (await semanticFileChunks(ownerId, q, { k: 3 })).map(c => ({
      name: c.name, fileKey: c.fileKey, idx: c.idx, score: c.score,
      excerpt: String(c.text).replace(/\s+/g, ' ').slice(0, 240),
    }));
  } catch { /* lane fails open */ }

  res.json({ success: true, ownerId, query: q, facts, episodes, graphPaths, files });
});

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
