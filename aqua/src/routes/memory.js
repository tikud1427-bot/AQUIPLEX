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
 * Memory 5.1 — editing (versioned, never silent) + reasoning:
 *   POST   /memory/fact                     — correct/replace { key, value, mode }
 *   POST   /memory/fact/:key/pin            — pin/unpin { pinned }
 *   POST   /memory/fact/:key/archive        — archive/restore { restore, force }
 *   POST   /memory/merge                    — N facts → survivor { keys, intoKey }
 *   POST   /memory/fact/:key/split          — 1 fact → parts { parts:[…] }
 *   GET    /memory/reason?q=&mode=          — contradictions/trends/gaps/decisions/changes
 *   GET    /memory/timeline?days=&limit=    — "what changed" feed
 *
 * Back-compat (old conversation-keyed API — resolves that conversation's
 * OWNER first, then serves owner-scoped data):
 *   GET    /memory/:conversationId
 *   GET    /memory/:conversationId/:key
 *   DELETE /memory/:conversationId[/:key]
 */
import express from 'express';
import { ok, fail, ErrorCodes } from './envelope.js';
import {
  getFacts, getFact, getFactHistory,
} from '../memory/longTermMemory.js';
import {
  forgetFact, forgetAllFacts, correctFactEverywhere, worldModelWritable, MemoryControlUnavailable,
} from '../memory/forget.js';
import {
  resolveOwner, getMemoryTrace, semanticFileChunks,
  correctFact, replaceFact, mergeFacts, splitFact,
  pinFact, archiveFact, restoreFact,
  reasonOverMemory, whatChanged,
} from '../memory/engine.js';
import { retrieveRelevantFacts } from '../memory/memoryRetriever.js';
import { recallEpisodes } from '../mind/episodeRecall.js';
import { recallGraphPaths } from '../mind/graphRecall.js';
import { peekMind } from '../mind/mindStore.js';
import { conversationExists, getConversationMeta } from '../memory/conversationStore.js';
import { factLabel, factItems } from '../memory/displayLabels.js';
import { failsItsSchema } from '../memory/factVisibility.js';
import { classifySensitivity } from '../memory/sensitivity.js';
import { getMind, touchMind } from '../mind/mindStore.js';

const router = express.Router();

/** 400 for every owner-scoped route that cannot resolve who is asking. */
const noOwner = (res, message = 'No memory owner') => fail(res, ErrorCodes.BAD_REQUEST, message);

/**
 * The edit endpoints (correct/replace/pin/archive/merge/split) all return the
 * engine's own `{ ok, ... }` result spread onto the envelope. Failure keeps the
 * STATUS each endpoint always had — pin's is 404, the rest 400 — passed in
 * explicitly because they are inconsistent today and a migration is not the
 * place to quietly change a status a client may branch on.
 */
function respondEdit(res, ownerId, result, failCode) {
  if (result.ok) return ok(res, { ownerId, ...result });
  const { error, ...rest } = result;
  return fail(res, failCode, error, { ownerId, ...rest });
}

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
    fail(res, ErrorCodes.NOT_FOUND, 'Conversation not found');
    return false;
  }
  return true;
}

/** 503 — the World Model could not take the change, and nothing was changed. */
function unavailable(res) {
  return fail(res, ErrorCodes.UNAVAILABLE, new MemoryControlUnavailable().message);
}

/**
 * Run a user memory change (memory/forget.js). Returns false after answering
 * 503 when the World Model was unreachable — nothing was changed then.
 */
async function forgetOrRespond(res, fn) {
  try {
    await fn();
    return true;
  } catch (err) {
    if (err instanceof MemoryControlUnavailable) { unavailable(res); return false; }
    throw err;
  }
}

/**
 * A fact as the Memory page shows it (2026-10-28): a human `label` (null for a
 * custom_ fact — its key is a slug of its own value), the value as DISTINCT
 * `items` (a collection used to render as one run-on string), and its
 * `sensitivity`. Internal bookkeeping (revision history with operation names,
 * extractor ids, metadata) stays server-side; GET /memory/fact/:key has it.
 */
function presentFact(f) {
  return {
    key: f.key, label: factLabel(f), value: f.value, items: factItems(f.value),
    category: f.category ?? null, confidence: f.confidence, importance: f.importance,
    sourceMessage: f.sourceMessage, sourceText: f.sourceText,
    createdAt: f.createdAt, updatedAt: f.updatedAt, ts: f.ts, revision: f.revision,
    // When the user last said it (a restatement, not a retrieval) — "last
    // confirmed" is a different time from "learned" (2026-10-28, additive).
    lastConfirmedAt: f.lastMentionedAt ?? null,
    status: f.status, pinned: !!f.pinned, retrievalCount: f.retrievalCount ?? 0, lastRetrievedAt: f.lastRetrievedAt ?? null,
    sensitivity: classifySensitivity(f), sensitivityReviewedAt: f.sensitivityReviewedAt ?? null,
  };
}

function factsPayload(ownerId) {
  // failsItsSchema: "loveit" as a language, "billionaire" as a profession —
  // stored before those validators were fixed (memory/factVisibility.js).
  const all = getFacts(ownerId).filter(f => !failsItsSchema(f)).map(presentFact);
  // Health and mood facts: never in the main list, never in chat (memory/
  // sensitivity.js) — listed apart so the user can delete or keep them (L5).
  const facts = all.filter(f => !f.sensitivity);
  const hiddenSensitive = all.filter(f => f.sensitivity);
  return { ownerId, factCount: facts.length, facts, hiddenSensitive };
}

// ── Memory Inspector: explainable per-turn trace (Req 14) ────────────────────
router.get('/inspector/:requestId', (req, res) => {
  const trace = getMemoryTrace(req.params.requestId);
  if (!trace) {
    return fail(res, ErrorCodes.NOT_FOUND, 'No trace for that requestId (ring keeps the last 100 turns)');
  }
  ok(res, { requestId: req.params.requestId, trace });
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
  if (!ownerId) return noOwner(res, 'No memory owner (no session and no ?conversationId)');
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

  ok(res, { ownerId, query: q, facts, episodes, graphPaths, files });
});

router.get('/', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return noOwner(res, 'No memory owner (no session and no ?conversationId)');
  ok(res, factsPayload(ownerId));
});

router.get('/fact/:key', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return noOwner(res);
  const fact = getFact(ownerId, req.params.key);
  if (!fact) return fail(res, ErrorCodes.NOT_FOUND, `Fact '${req.params.key}' not found`);
  ok(res, { ownerId, key: req.params.key, fact, history: getFactHistory(ownerId, req.params.key) });
});

router.delete('/fact/:key', async (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return noOwner(res);
  if (!(await forgetOrRespond(res, () => forgetFact(ownerId, req.params.key)))) return;
  ok(res, { ownerId, deleted: req.params.key });
});

router.delete('/', async (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return noOwner(res);
  if (!(await forgetOrRespond(res, () => forgetAllFacts(ownerId)))) return;
  ok(res, { ownerId, cleared: true });
});

// ── Memory 5.1 — EDITING (spec: correction/replacement/merge/split, versioned,
// never silent). All through the engine facade; every op returns the edited
// fact(s) with a revision count so the caller sees the trail grew. ──────────

/** POST /memory/fact  { key, value, mode?: 'correct'|'replace', reason? } */
router.post('/fact', async (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return noOwner(res);
  const { key, value, mode = 'correct', reason } = req.body || {};
  // The correction must reach the World Model too, or its old value keeps
  // answering; refuse up front rather than apply half of it.
  if (!(await worldModelWritable())) return unavailable(res);
  const oldValue = key ? getFact(ownerId, key)?.value : undefined;
  const result = mode === 'replace'
    ? replaceFact(ownerId, key, value, { reason })
    : correctFact(ownerId, key, value, { reason });
  if (result.ok && !(await forgetOrRespond(res, () => correctFactEverywhere(ownerId, key, oldValue, value)))) return;
  respondEdit(res, ownerId, result, ErrorCodes.BAD_REQUEST);
});

/** POST /memory/fact/:key/pin  { pinned?: boolean } (default true) */
router.post('/fact/:key/pin', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return noOwner(res);
  const pinned = req.body?.pinned !== false;
  const result = pinFact(ownerId, req.params.key, pinned);
  respondEdit(res, ownerId, result, ErrorCodes.NOT_FOUND);
});

/**
 * POST /memory/fact/:key/keep — "Keep" on a fact in the hidden sensitive
 * section: it stays stored and stays out of chat; the review is recorded so the
 * page stops asking. (Delete is DELETE /memory/fact/:key, which forgets it
 * everywhere.) Only a sensitive fact can be kept this way.
 */
router.post('/fact/:key/keep', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return noOwner(res);
  const fact = getFact(ownerId, req.params.key);
  const kind = fact ? classifySensitivity(fact) : null;
  if (!fact || !kind) return fail(res, ErrorCodes.NOT_FOUND, `No hidden fact '${req.params.key}'`);
  fact.sensitivity = kind;
  fact.sensitivityReviewedAt = Date.now();
  touchMind(peekMind(ownerId) ?? getMind(ownerId));
  ok(res, { ownerId, fact: presentFact(fact) });
});

/**
 * POST /memory/fact/:key/confirm — legacy review (mind/legacyReview.js): the
 * user says a value today's validator rejects is right after all. It is shown
 * and used again (factVisibility.failsItsSchema respects it). Only a fact the
 * review flagged can be confirmed this way.
 */
router.post('/fact/:key/confirm', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return noOwner(res);
  const fact = getFact(ownerId, req.params.key);
  if (!fact || !failsItsSchema(fact)) return fail(res, ErrorCodes.NOT_FOUND, `No fact to confirm for '${req.params.key}'`);
  fact.userConfirmedAt = Date.now();
  touchMind(peekMind(ownerId) ?? getMind(ownerId));
  ok(res, { ownerId, fact: presentFact(fact) });
});

/**
 * POST /memory/fact/:key/split-item  { item, parts: string[] } | { item, keep: true }
 * Legacy review (mind/legacyReview.js `merged_goal_item`): one item of a
 * collection fact held several goals. Split replaces that item with its parts
 * through correctFact, so the revision history records before → after; keep
 * records the decision and the review stops asking. Only an exact existing item.
 */
router.post('/fact/:key/split-item', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return noOwner(res);
  const fact = getFact(ownerId, req.params.key);
  const item = String(req.body?.item ?? '');
  const items = Array.isArray(fact?.value) ? fact.value : (fact ? [fact.value] : []);
  if (!fact || !item || !items.includes(item)) return fail(res, ErrorCodes.NOT_FOUND, 'No such item');
  if (req.body?.keep === true) {
    fact.reviewedItems = [...new Set([...(fact.reviewedItems ?? []), item])];
    touchMind(peekMind(ownerId) ?? getMind(ownerId));
    return ok(res, { ownerId, fact: presentFact(fact) });
  }
  const parts = Array.isArray(req.body?.parts) ? req.body.parts.map(p => String(p ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean) : [];
  if (parts.length < 2 || parts.length > 6 || parts.some(p => p.length < 3 || p.length > 120)) {
    return fail(res, ErrorCodes.BAD_REQUEST, 'Give 2 to 6 goals, each 3–120 characters.');
  }
  const next = [];
  for (const v of items.flatMap(v => (v === item ? parts : [v]))) {
    if (!next.some(x => String(x).toLowerCase() === String(v).toLowerCase())) next.push(v);
  }
  const result = correctFact(ownerId, req.params.key, next, { reason: 'user split a merged goal' });
  respondEdit(res, ownerId, result, ErrorCodes.BAD_REQUEST);
});

/** POST /memory/fact/:key/archive  { restore?: boolean, force?: boolean, reason? } */
router.post('/fact/:key/archive', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return noOwner(res);
  const { restore = false, force = false, reason } = req.body || {};
  const result = restore
    ? restoreFact(ownerId, req.params.key, { reason })
    : archiveFact(ownerId, req.params.key, { reason, force });
  respondEdit(res, ownerId, result, ErrorCodes.BAD_REQUEST);
});

/** POST /memory/merge  { keys: string[], intoKey?, reason? } */
router.post('/merge', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return noOwner(res);
  const { keys, intoKey, reason } = req.body || {};
  const result = mergeFacts(ownerId, keys, { intoKey, reason });
  respondEdit(res, ownerId, result, ErrorCodes.BAD_REQUEST);
});

/** POST /memory/fact/:key/split  { parts: [{key, value, category?, importance?}], reason? } */
router.post('/fact/:key/split', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return noOwner(res);
  const { parts, reason } = req.body || {};
  const result = splitFact(ownerId, req.params.key, parts, { reason });
  respondEdit(res, ownerId, result, ErrorCodes.BAD_REQUEST);
});

// ── Memory 5.1 — REASONING (spec: reason across memories; evidence-backed) ──

/** GET /memory/reason?q=<question>[&mode=contradictions|trends|gaps|decisions|changes] */
router.get('/reason', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return noOwner(res);
  const q = String(req.query.q || '').slice(0, 500);
  const mode = req.query.mode ? String(req.query.mode) : null;
  const result = reasonOverMemory(ownerId, q, mode ? { mode } : {});
  ok(res, { ownerId, query: q, ...result });
});

/** GET /memory/timeline?days=<n>&limit=<n> — "what changed" feed */
router.get('/timeline', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return noOwner(res);
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const changes = whatChanged(ownerId, { sinceMs: days * 24 * 3600 * 1000, limit });
  ok(res, { ownerId, days, changes });
});

// ── Back-compat: conversation-keyed paths → owner-scoped data ────────────────
router.get('/:conversationId', (req, res) => {
  if (!assertLegacyConvAccess(req, res, req.params.conversationId)) return;
  const ownerId = ownerForLegacyConversation(req, req.params.conversationId);
  ok(res, { ...factsPayload(ownerId), conversationId: req.params.conversationId });
});

router.get('/:conversationId/:key', (req, res) => {
  const { conversationId, key } = req.params;
  if (!assertLegacyConvAccess(req, res, conversationId)) return;
  const ownerId = ownerForLegacyConversation(req, conversationId);
  const fact = getFact(ownerId, key);
  if (!fact) return fail(res, ErrorCodes.NOT_FOUND, `Fact '${key}' not found`);
  ok(res, { ownerId, conversationId, key, fact, history: getFactHistory(ownerId, key) });
});

router.delete('/:conversationId/:key', async (req, res) => {
  const { conversationId, key } = req.params;
  if (!assertLegacyConvAccess(req, res, conversationId)) return;
  const ownerId = ownerForLegacyConversation(req, conversationId);
  if (!(await forgetOrRespond(res, () => forgetFact(ownerId, key)))) return;
  ok(res, { ownerId, conversationId, deleted: key });
});

router.delete('/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  if (!assertLegacyConvAccess(req, res, conversationId)) return;
  const ownerId = ownerForLegacyConversation(req, conversationId);
  if (!(await forgetOrRespond(res, () => forgetAllFacts(ownerId)))) return;
  ok(res, { ownerId, conversationId, cleared: true });
});

export default router;
