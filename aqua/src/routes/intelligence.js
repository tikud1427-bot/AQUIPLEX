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
import { ok, fail, ErrorCodes } from './envelope.js';
import { resolveOwner } from '../memory/engine.js';
import {
  retrieveKnowledge, getProjectIntelligence, getHealth, maintain,
  getLifecycle, getHistory, confidenceTrajectory, getLedger, getPICMetrics, picEnabled,
  getForensics, getResearch, compareKnowledgeFiles, whatCaused,   // File Intelligence 2.0
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
    fail(res, ErrorCodes.BAD_REQUEST, 'No owner (no session and no ?conversationId)');
    return null;
  }
  return ownerId;
}

router.get('/metrics', (_req, res) => {
  ok(res, { metrics: getPICMetrics() });
});

router.get('/knowledge', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  const q = String(req.query.q || '').slice(0, 500);
  if (!q) return fail(res, ErrorCodes.BAD_REQUEST, 'Missing ?q=');
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 8));
  const out = retrieveKnowledge(ownerId, q, { limit });
  ok(res, { ownerId, query: q, ...out });
});

router.get('/project', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  try {
    ok(res, { project: getProjectIntelligence(ownerId) });
  } catch (err) {
    fail(res, ErrorCodes.INTERNAL, err.message);
  }
});

router.get('/health', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  try {
    ok(res, { enabled: picEnabled(), health: getHealth(ownerId) });
  } catch (err) {
    fail(res, ErrorCodes.INTERNAL, err.message);
  }
});

router.post('/maintain', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  try {
    const consolidate = req.body?.consolidate !== false;
    ok(res, { ...maintain(ownerId, { consolidate }) });
  } catch (err) {
    fail(res, ErrorCodes.INTERNAL, err.message);
  }
});

/** Subject inspection: /lifecycle/fact/<id>, /lifecycle/uko/<id>, /lifecycle/entity/<id> */
router.get('/lifecycle/:kind/:id', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  const subject = `${req.params.kind}:${req.params.id}`;
  const lifecycle = getLifecycle(ownerId, subject);
  if (!lifecycle) return fail(res, ErrorCodes.NOT_FOUND, 'Unknown subject');
  ok(res, {
    subject, lifecycle,
    revisions: getHistory(ownerId, subject),
    confidenceTrajectory: confidenceTrajectory(ownerId, subject),
  });
});

router.get('/ledger', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  ok(res, { ledger: getLedger(ownerId, { limit }) });
});

// ── File Intelligence 2.0 (forensics + research + causal) ────────────────────
// Read-only, owner-scoped, every item evidence-cited. All four go through
// the PIC facade (fail-open, AQUA_PIC honored) — routes never touch stores.

/** Forensic report for the owner's knowledge space; ?file=<ukoId> for one file's dossier. */
router.get('/forensics', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  const out = getForensics(ownerId, { ukoId: req.query.file ?? null });
  if (out == null) return fail(res, ErrorCodes.NOT_FOUND, req.query.file ? 'file not found' : 'forensics unavailable');
  ok(res, { forensics: out });
});

/** Research intelligence — ?mode=consensus|hypotheses|gaps|overview (default consensus). */
router.get('/research', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  const out = getResearch(ownerId, { mode: String(req.query.mode ?? 'consensus') });
  if (out == null) return fail(res, ErrorCodes.UNAVAILABLE, 'research unavailable');
  ok(res, { mode: String(req.query.mode ?? 'consensus'), research: out });
});

/** Paper-vs-paper comparison — ?a=<ukoId>&b=<ukoId>. */
router.get('/compare', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  const { a, b } = req.query;
  if (!a || !b) return fail(res, ErrorCodes.BAD_REQUEST, 'a and b (uko ids) are required');
  const out = compareKnowledgeFiles(ownerId, a, b);
  if (out == null) return fail(res, ErrorCodes.NOT_FOUND, 'one or both files not found');
  ok(res, { comparison: out });
});

/** "Which event caused this?" — ?q=<effect text>. */
router.get('/cause', (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;
  const q = String(req.query.q ?? '').trim();
  if (!q) return fail(res, ErrorCodes.BAD_REQUEST, 'q is required');
  const out = whatCaused(ownerId, q);
  if (out == null) return fail(res, ErrorCodes.UNAVAILABLE, 'causal query unavailable');
  ok(res, { causal: out });
});

/** Orchestration 2.0 — run a request through the task-graph runtime directly.
 *  Body: { message, conversationId? }. Grounding = memory engine + PIC
 *  knowledge (the same lanes chat uses). Kill switch: AQUA_GRAPH=off. */
router.post('/orchestrate', async (req, res) => {
  if (String(process.env.AQUA_GRAPH ?? 'on').toLowerCase() === 'off') {
    return fail(res, ErrorCodes.UNAVAILABLE, 'orchestration disabled (AQUA_GRAPH=off)');
  }
  const ownerId = resolveOwner({ userId: req.aquaUserId ?? null, conversationId: req.body?.conversationId ?? null });
  if (!ownerId) return fail(res, ErrorCodes.BAD_REQUEST, 'No owner (no session and no conversationId)');
  const message = String(req.body?.message ?? '').trim();
  if (!message) return fail(res, ErrorCodes.BAD_REQUEST, 'message is required');
  try {
    const { classifyTask } = await import('../core/classifier.js');
    const { createExecutionPlan } = await import('../core/executionPlanner.js');
    const { memoryRetrieve } = await import('../memory/engine.js');
    const { runTaskGraph, getGraphMetrics } = await import('../orchestrator/graphRuntime.js');

    const { task: taskType, confidence } = classifyTask(message);
    const plan = createExecutionPlan(taskType, confidence);
    const memory = memoryRetrieve(ownerId, { query: message })?.block ?? '';
    const evidence = retrieveKnowledge(ownerId, message)?.block ?? '';

    const result = await runTaskGraph({
      userMessage: message, taskType, plan,
      context: { memory, evidence, search: '' },
      ctx: { requestId: `orch-${Date.now()}` },
    });
    ok(res, {
      answer: result.text, taskType,
      orchestration: result.orchestration2, latencyMs: result.latency,
      metrics: getGraphMetrics(),
    });
  } catch (err) {
    fail(res, ErrorCodes.UPSTREAM_FAILED, err.message);
  }
});

// ── Cognitive Intelligence Engine observability ──────────────────────────────
// Global aggregates (like /metrics — no owner needed): the CIE learns
// (taskType × cognitive style) planning patterns, not per-owner knowledge.

/** Planning decisions, monitor findings, escalations, reflection outcomes,
 *  confidence evolution, retrieval efficiency, plan-cache reuse. */
router.get('/cognition', (req, res) => {
  try {
    ok(res, { enabled: cieEnabled(), metrics: getCIEMetrics() });
  } catch (err) {
    fail(res, ErrorCodes.INTERNAL, err.message);
  }
});

/** Learned strategy aggregates — which cognitive styles are winning per
 *  task type (effectiveness EWMAs, outcomes, better-strategy hints). */
router.get('/cognition/strategies', (req, res) => {
  try {
    ok(res, { strategies: getCognitionSnapshot() });
  } catch (err) {
    fail(res, ErrorCodes.INTERNAL, err.message);
  }
});

export default router;
