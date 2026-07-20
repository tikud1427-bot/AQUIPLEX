/**
 * AQUA Intelligence Routes — Persistent Intelligence Core API (Phase 4)
 *
 * Owner-scoped (same resolveOwner contract as /memory) maintenance +
 * observability surface over the PIC facade:
 *
 *   GET  /intelligence/knowledge?q=…        knowledge-first retrieval (items + block)
 *   GET  /intelligence/project              the owner's knowledge space, understood
 *   GET  /intelligence/health               full health report
 *   POST /intelligence/maintain             consolidate + re-measure (before/after)
 *   GET  /intelligence/lifecycle/:kind/:id  one subject's state + transitions + revisions
 *   GET  /intelligence/ledger               recent intelligence operations
 *   GET  /intelligence/metrics              PIC counters + latency EWMAs (no owner needed)
 *
 * Read-heavy by design; the only mutating endpoint is /maintain, whose
 * writes go exclusively through the consolidation engine's annotate-and-
 * archive path (statements are never rewritten, knowledge never deleted).
 */
import express from 'express';
import { resolveOwner } from '../memory/engine.js';
import {
  retrieveKnowledge, getProjectIntelligence, getHealth, maintain,
  getLifecycle, getHistory, confidenceTrajectory, getLedger, getPICMetrics, picEnabled,
} from '../pic/core.js';
import { getCIEMetrics, cieEnabled, getCognitionSnapshot } from '../cognition/index.js';   // Cognitive Intelligence Engine

const router = express.Router();

function ownerOf(req) {
  return resolveOwner({
    userId: req.aquaUserId ?? null,
    conversationId: req.query.conversationId ?? null,
  });
}

function requireOwner(req, res) {
  const ownerId = ownerOf(req);
  if (!ownerId) {
    res.status(400).json({ success: false, error: 'No owner (no session and no ?conversationId)' });
    return null;
  }
  return ownerId;
}

router.get('/metrics', (_req, res) => {
  res.json({ success: true, metrics: getPICMetrics() });
});

router.get('/knowledge', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  const q = String(req.query.q || '').slice(0, 500);
  if (!q) return res.status(400).json({ success: false, error: 'Missing ?q=' });
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 8));
  const out = retrieveKnowledge(ownerId, q, { limit });
  res.json({ success: true, ownerId, query: q, ...out });
});

router.get('/project', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  try {
    res.json({ success: true, project: getProjectIntelligence(ownerId) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/health', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  try {
    res.json({ success: true, enabled: picEnabled(), health: getHealth(ownerId) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/maintain', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  try {
    const consolidate = req.body?.consolidate !== false;
    res.json({ success: true, ...maintain(ownerId, { consolidate }) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Subject inspection: /lifecycle/fact/<id>, /lifecycle/uko/<id>, /lifecycle/entity/<id> */
router.get('/lifecycle/:kind/:id', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  const subject = `${req.params.kind}:${req.params.id}`;
  const lifecycle = getLifecycle(ownerId, subject);
  if (!lifecycle) return res.status(404).json({ success: false, error: 'Unknown subject' });
  res.json({
    success: true, subject, lifecycle,
    revisions: getHistory(ownerId, subject),
    confidenceTrajectory: confidenceTrajectory(ownerId, subject),
  });
});

router.get('/ledger', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  res.json({ success: true, ledger: getLedger(ownerId, { limit }) });
});

// ── Cognitive Intelligence Engine observability ──────────────────────────────
// Global aggregates (like /metrics — no owner needed): the CIE learns
// (taskType × cognitive style) planning patterns, not per-owner knowledge.

/** Planning decisions, monitor findings, escalations, reflection outcomes,
 *  confidence evolution, retrieval efficiency, plan-cache reuse. */
router.get('/cognition', (req, res) => {
  try {
    res.json({ success: true, enabled: cieEnabled(), metrics: getCIEMetrics() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Learned strategy aggregates — which cognitive styles are winning per
 *  task type (effectiveness EWMAs, outcomes, better-strategy hints). */
router.get('/cognition/strategies', (req, res) => {
  try {
    res.json({ success: true, strategies: getCognitionSnapshot() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
