/**
 * AQUA Mind Routes — Layers 17 (explainable), 18 (editable), 19 (privacy)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mounted at /api/aqua/mind. Owner resolution mirrors chat:
 * req.aquaUserId when the platform session exists, else ?conversationId
 * fallback (dev/engine-standalone), else 404 — a Mind must have an owner.
 *
 *   GET    /mind                          — full model summary (Mind View data)
 *   GET    /mind/export                   — complete raw export (user owns it)
 *   GET    /mind/beliefs                  — beliefs (?dimension=&min=)
 *   GET    /mind/beliefs/:dim/:key        — one belief + explanation (Layer 17)
 *   PATCH  /mind/beliefs/:dim/:key        — correct { value } (Layer 18)
 *   POST   /mind/beliefs/:dim/:key/lock   — { locked } pin/unpin
 *   POST   /mind/beliefs/:dim/:key/temporary — { temporary }
 *   DELETE /mind/beliefs/:dim/:key        — delete one belief
 *   PATCH  /mind/goals/:id                — edit goal (status/priority/title)
 *   DELETE /mind/goals/:id                — delete goal
 *   POST   /mind/goals/:id/split          — legacy review: split a merged goal / keep it
 *   GET    /mind/review                   — legacy records to review (read-only)
 *   POST   /mind/beliefs/:dim/:key/review — legacy review: "it's right"
 *   GET    /mind/graph                    — nodes+edges (?around=nodeKey)
 *   GET    /mind/reflections              — reflection history
 *   DELETE /mind                          — erase the entire cognitive model
 *   GET    /mind/view                     — Mind View dev panel (env-gated)
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveMindOwner, peekMind, getMind, deleteMind, exportMind, mindStats } from './mindStore.js';
import { getBeliefs, correctBelief, lockBelief, markTemporary, deleteBelief } from './beliefEngine.js';
import { getActiveGoals } from './goalTracker.js';
import { getEpisodes } from './episodeTracker.js';
import { presentBeliefs, presentGoals, presentEpisodes, presentWorking, presentPredictions, presentTimeline, presentExplanation } from './mindPresentation.js';
import { neighborhood } from './relationshipGraph.js';
import { recentTimeline } from './timeline.js';
import { currentFocus } from './workingMemory.js';
import { beliefKey, GOAL_STATUS, createGoal } from './mindSchema.js';
import { reviewCandidates } from './legacyReview.js';
import { getFacts } from '../memory/longTermMemory.js';
import { touchMind, deleteItem } from './mindStore.js';

const router = express.Router();
const __dir = path.dirname(fileURLToPath(import.meta.url));

function ownerOf(req) {
  return resolveMindOwner({
    userId: req.aquaUserId ?? null,
    conversationId: req.query.conversationId ?? req.body?.conversationId ?? null,
  });
}

function requireMind(req, res) {
  const ownerId = ownerOf(req);
  if (!ownerId) {
    res.status(400).json({ success: false, error: 'No mind owner: log in, or pass ?conversationId= for the dev fallback.' });
    return null;
  }
  const mind = peekMind(ownerId);
  if (!mind) {
    res.status(404).json({ success: false, error: `No cognitive model yet for ${ownerId} — it forms as conversations happen.` });
    return null;
  }
  return mind;
}

// ── Mind View dev panel (never exposed unless enabled) ────────────────────────
router.get('/view', (req, res) => {
  if (process.env.AQUA_MIND_VIEW !== '1') {
    return res.status(404).json({ success: false, error: 'Mind View is disabled. Set AQUA_MIND_VIEW=1 to enable.' });
  }
  try {
    const html = fs.readFileSync(path.join(__dir, 'mindView.html'), 'utf8');
    res.type('html').send(html);
  } catch {
    res.status(500).json({ success: false, error: 'mindView.html missing' });
  }
});

// ── Full model summary — the Mind View data source ────────────────────────────
router.get('/', (req, res) => {
  const mind = requireMind(req, res);
  if (!mind) return;
  res.json({
    success: true,
    ownerId: mind.ownerId,
    turnCount: mind.turnCount,
    createdAt: mind.createdAt,
    updatedAt: mind.updatedAt,
    // What a person may see (mind/mindPresentation.js): no intent ids, no
    // markup "domains", no goal as a profession, no health/mood beliefs, and
    // evidence lines from real evidence.
    identity:      presentBeliefs(getBeliefs(mind, { dimension: 'identity' })),
    personality:   presentBeliefs(getBeliefs(mind, { dimension: 'personality' })),
    communication: presentBeliefs(getBeliefs(mind, { dimension: 'communication' })),
    preferences:   presentBeliefs(getBeliefs(mind, { dimension: 'preferences' })),
    knowledge:     presentBeliefs(getBeliefs(mind, { dimension: 'knowledge' })),
    behavior:      presentBeliefs(getBeliefs(mind, { dimension: 'behavior' })),
    decision:      presentBeliefs(getBeliefs(mind, { dimension: 'decision' })),
    goals: presentGoals(Object.values(mind.goals).sort((a, b) => b.lastMentionedAt - a.lastMentionedAt)),
    activeGoals: getActiveGoals(mind, 10).map(g => g.id),
    episodes: presentEpisodes(getEpisodes(mind, { limit: 10 })),
    working: presentWorking(mind.working, currentFocus(mind, 8)),
    predictions: presentPredictions(mind.predictions),
    timeline: presentTimeline(recentTimeline(mind, 30)),
    graph: {
      nodeCount: Object.keys(mind.graph.nodes).length,
      edgeCount: Object.keys(mind.graph.edges).length,
    },
    reflections: mind.reflections.slice(-5),
    lastReflectionAt: mind.lastReflectionAt,
    stats: mindStats(),
  });
});

function compactBelief(b) {
  return {
    dimension: b.dimension, key: b.key, value: b.value,
    confidence: +b.confidence.toFixed(3), evidenceCount: b.evidenceCount,
    contradictions: b.contradictions, status: b.status,
    locked: !!b.privacy?.locked, temporary: !!b.privacy?.temporary,
    source: b.privacy?.source, updatedAt: b.updatedAt,
  };
}

// ── Export (Layer 19: the user owns the model) ────────────────────────────────
router.get('/export', (req, res) => {
  const mind = requireMind(req, res);
  if (!mind) return;
  res.setHeader('Content-Disposition', `attachment; filename="aqua-mind-${Date.now()}.json"`);
  res.json(exportMind(mind.ownerId));
});

// ── Beliefs ───────────────────────────────────────────────────────────────────
router.get('/beliefs', (req, res) => {
  const mind = requireMind(req, res);
  if (!mind) return;
  const { dimension = null, min = 0 } = req.query;
  const beliefs = getBeliefs(mind, { dimension, minConfidence: Number(min) || 0, status: null })
    .map(compactBelief);
  res.json({ success: true, count: beliefs.length, beliefs });
});

router.get('/beliefs/:dim/:key', (req, res) => {
  const mind = requireMind(req, res);
  if (!mind) return;
  const belief = mind.beliefs[beliefKey(req.params.dim, req.params.key)];
  if (!belief) return res.status(404).json({ success: false, error: 'Belief not found' });
  res.json({ success: true, belief, explanation: presentExplanation(belief) }); // Layer 17, in words
});

router.patch('/beliefs/:dim/:key', (req, res) => {
  const mind = requireMind(req, res);
  if (!mind) return;
  const { value } = req.body ?? {};
  if (value === undefined) return res.status(400).json({ success: false, error: 'value is required' });
  const belief = correctBelief(mind, req.params.dim, req.params.key, value);
  res.json({ success: true, belief: compactBelief(belief) });
});

router.post('/beliefs/:dim/:key/lock', (req, res) => {
  const mind = requireMind(req, res);
  if (!mind) return;
  const belief = lockBelief(mind, req.params.dim, req.params.key, req.body?.locked !== false);
  if (!belief) return res.status(404).json({ success: false, error: 'Belief not found' });
  res.json({ success: true, belief: compactBelief(belief) });
});

router.post('/beliefs/:dim/:key/temporary', (req, res) => {
  const mind = requireMind(req, res);
  if (!mind) return;
  const belief = markTemporary(mind, req.params.dim, req.params.key, req.body?.temporary !== false);
  if (!belief) return res.status(404).json({ success: false, error: 'Belief not found' });
  res.json({ success: true, belief: compactBelief(belief) });
});

router.delete('/beliefs/:dim/:key', (req, res) => {
  const mind = requireMind(req, res);
  if (!mind) return;
  const deleted = deleteBelief(mind, req.params.dim, req.params.key);
  res.status(deleted ? 200 : 404).json({ success: deleted, deleted: `${req.params.dim}:${req.params.key}` });
});

// ── Goals ─────────────────────────────────────────────────────────────────────
router.patch('/goals/:id', (req, res) => {
  const mind = requireMind(req, res);
  if (!mind) return;
  const goal = mind.goals[req.params.id];
  if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
  const { status, priority, title, progress, deadline } = req.body ?? {};
  if (status && Object.values(GOAL_STATUS).includes(status)) {
    goal.history.push({ status: goal.status, at: Date.now(), reason: 'user edit' });
    goal.status = status;
  }
  if (priority !== undefined) goal.priority = Math.max(1, Math.min(10, Number(priority) || goal.priority));
  if (title) goal.title = String(title).slice(0, 120);
  if (progress !== undefined) goal.progress = Math.max(0, Math.min(1, Number(progress)));
  if (deadline !== undefined) goal.deadline = deadline ? Number(deadline) : null;
  goal.updatedAt = Date.now();
  goal.privacy.source = 'correction';
  touchMind(mind);
  res.json({ success: true, goal });
});

/**
 * POST /mind/goals/:id/split  { parts: string[] }  |  { keep: true }
 * Legacy review (legacyReview.js). Split: each part becomes its own goal,
 * inheriting the original's dates, mentions and projects; the original is not
 * deleted — it is marked abandoned with `splitInto` and a history entry, so its
 * evidence survives (export) and nothing reads it as current. Keep: the user
 * says it is one goal; the review stops asking. Parts are the user's to edit,
 * so they are validated, not required to match the suggestion.
 */
router.post('/goals/:id/split', (req, res) => {
  const mind = requireMind(req, res);
  if (!mind) return;
  const goal = mind.goals[req.params.id];
  if (!goal || goal.splitInto) return res.status(404).json({ success: false, error: 'Goal not found' });
  const now = Date.now();
  if (req.body?.keep === true) {
    goal.reviewedAt = now;
    goal.history.push({ status: goal.status, at: now, reason: 'user kept as one goal' });
    touchMind(mind);
    return res.json({ success: true, goal });
  }
  const parts = Array.isArray(req.body?.parts) ? req.body.parts.map(p => String(p ?? '').replace(/\s+/g, ' ').trim()) : [];
  if (parts.length < 2 || parts.length > 6 || parts.some(p => p.length < 3 || p.length > 120) || new Set(parts.map(p => p.toLowerCase())).size !== parts.length) {
    return res.status(400).json({ success: false, error: 'Give 2 to 6 different goals, each 3–120 characters.' });
  }
  const created = parts.map(title => {
    const g = createGoal({ title, source: 'correction', confidence: goal.confidence });
    Object.assign(g, {
      status: goal.status === GOAL_STATUS.STALE ? GOAL_STATUS.ACTIVE : goal.status,
      mentions: goal.mentions, createdAt: goal.createdAt, lastMentionedAt: goal.lastMentionedAt,
      relatedProjects: [...(goal.relatedProjects ?? [])], deadline: null,
      history: [{ status: 'split', at: now, reason: `split by user from goal ${goal.id}` }],
    });
    mind.goals[g.id] = g;
    return g;
  });
  goal.history.push({ status: goal.status, at: now, reason: `split by user into ${created.map(g => g.id).join(', ')}` });
  goal.status = GOAL_STATUS.ABANDONED;
  goal.splitInto = created.map(g => g.id);
  goal.updatedAt = now;
  touchMind(mind);
  res.json({ success: true, goals: created, original: goal.id });
});

/** GET /mind/review — legacy records the user should look at (legacyReview.js). Read-only. */
router.get('/review', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return res.status(400).json({ success: false, error: 'No mind owner' });
  const candidates = reviewCandidates({ mind: peekMind(ownerId), facts: getFacts(ownerId) });
  res.json({ success: true, candidates });
});

/** POST /mind/beliefs/:dim/:key/review — "it's right": stop flagging it; show and use it as stated. */
router.post('/beliefs/:dim/:key/review', (req, res) => {
  const mind = requireMind(req, res);
  if (!mind) return;
  const belief = mind.beliefs[beliefKey(req.params.dim, req.params.key)];
  if (!belief) return res.status(404).json({ success: false, error: 'Belief not found' });
  belief.reviewedAt = Date.now();
  touchMind(mind);
  res.json({ success: true, belief: compactBelief(belief) });
});

router.delete('/goals/:id', (req, res) => {
  const mind = requireMind(req, res);
  if (!mind) return;
  if (!mind.goals[req.params.id]) return res.status(404).json({ success: false, error: 'Goal not found' });
  deleteItem(mind, 'goals', req.params.id);
  touchMind(mind);
  res.json({ success: true, deleted: req.params.id });
});

// ── Graph ─────────────────────────────────────────────────────────────────────
router.get('/graph', (req, res) => {
  const mind = requireMind(req, res);
  if (!mind) return;
  const { around } = req.query;
  if (around) {
    const nb = neighborhood(mind, String(around), 2, 20);
    return res.json({ success: true, ...nb });
  }
  res.json({
    success: true,
    nodes: Object.values(mind.graph.nodes),
    edges: Object.values(mind.graph.edges),
  });
});

// ── Reflections ───────────────────────────────────────────────────────────────
router.get('/reflections', (req, res) => {
  const mind = requireMind(req, res);
  if (!mind) return;
  res.json({ success: true, reflections: mind.reflections, lastReflectionAt: mind.lastReflectionAt });
});

// ── Erase the entire model ────────────────────────────────────────────────────
router.delete('/', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return res.status(400).json({ success: false, error: 'No mind owner' });
  const deleted = deleteMind(ownerId);
  res.json({ success: true, ownerId, deleted });
});

export default router;
