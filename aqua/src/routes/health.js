import express from 'express';
import { getHealthReport, getUptime } from '../core/health.js';
import { getRegistrySnapshot }        from '../providers/modelRegistry.js';
import { getMetrics, getRecentLogs }  from '../core/observability.js';
import { getStoreStats }              from '../memory/conversationStore.js';
import { getMemoryStats }             from '../memory/longTermMemory.js';
import { getProjectStats }            from '../project/workspaceManager.js';
import { listProfiles }               from '../orchestrator/executionProfiles.js';
import { getSearchHealth }            from '../search/searchManager.js';
import '../orchestrator/capabilities.js'; // side-effect: registers every capability definition
import { getAllCapabilities }         from '../orchestrator/capabilityRegistry.js';

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    status:    'ok',
    ts:        new Date().toISOString(),
    uptime:    getUptime(),
    providers: getHealthReport(),
    // Issue 5/6: every provider's models (not just OpenRouter's), each with
    // enabled/deprecated/rate_limited/cooldown state — single source of
    // truth is the central Model Registry, not a per-provider local map.
    models:    getRegistrySnapshot(),
    metrics:   getMetrics(),
    memory: {
      shortTerm: getStoreStats(),
      longTerm:  getMemoryStats(),   // unified store: owners/facts/contradictions
    },
    project: getProjectStats(),
    // Web Search: provider key pools (per-slot usage/cooldown — never key
    // material), circuit breakers, cache hit/miss, and effective config.
    search:  getSearchHealth(),
  });
});

router.get('/uptime', (req, res) => {
  res.json({ success: true, ...getUptime() });
});

router.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
  const logs  = getRecentLogs(limit);
  res.json({
    success: true,
    count:   logs.length,
    logs,
  });
});

// Phase 6 — Adaptive Tool Orchestrator: static registry introspection.
// Per-request decisions are already surfaced via metrics.orchestratorProfiles
// / metrics.orchestratorCapabilities above (and the [ORCHESTRATOR] server
// log for full per-request detail) — this endpoint shows what's *registered*
// (every profile and capability the orchestrator can choose between),
// which is the natural debugging surface for the spec's "Extensibility"
// requirement: a future plugin registering itself in capabilities.js
// shows up here automatically, with no change needed to this route.
router.get('/orchestrator', (req, res) => {
  res.json({
    success: true,
    profiles: listProfiles().map(p => ({
      id: p.id,
      label: p.label,
      description: p.description,
      requiredCapabilities: p.requiredCapabilities,
      budget: p.budget,
    })),
    capabilities: getAllCapabilities().map(c => ({
      id: c.id,
      label: c.label,
      group: c.group,
      estimated_cost: c.cost,
      estimated_latency: c.latency,
    })),
  });
});

export default router;
