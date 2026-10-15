import express from 'express';
import { getHealthReport, getUptime } from '../core/health.js';
import { getRegistrySnapshot }        from '../providers/modelRegistry.js';
import { getMetrics, getRecentLogs }  from '../core/observability.js';
import { renderPrometheus }           from '../core/metricsExposition.js';
import { getCostMetrics }             from '../core/costAccounting.js';
import { queueStats, deadLetters, retryStats, queueConfigured as pgConfigured } from '../core/jobs/jobQueue.js';
import { getTelemetryMetrics }        from '../core/telemetry.js';
import { readEvalGateSummary }        from '../core/evalGateSummary.js';
import { readProcessMetrics }         from '../core/processMetrics.js';
import { evaluateDlq }                from '../core/jobs/dlqPolicy.js';
import { getStoreStats }              from '../memory/conversationStore.js';
import { getMemoryStats }             from '../memory/longTermMemory.js';
import { getProjectStats }            from '../project/workspaceManager.js';
import { listProfiles }               from '../orchestrator/executionProfiles.js';
import { getSearchHealth }            from '../search/searchManager.js';
import { getMirrorStatus }            from '../core/mongoMirror.js';
import '../orchestrator/capabilities.js'; // side-effect: registers every capability definition
import { getAllCapabilities }         from '../orchestrator/capabilityRegistry.js';
import { ok }                         from './envelope.js';
import keyPoolLib                     from '../providers/keyPool.cjs';

const { getCredentialDiagnostics, getProviderUsageSnapshot } = keyPoolLib;

const router = express.Router();

router.get('/', (req, res) => {
  ok(res, {
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
    // P0 — deploy-survival mirror: connected? canary round-trip ok? last
    // write? multi-writer alarm? THE thing to glance at after any deploy.
    mirror:  getMirrorStatus(),
    // Web Search: provider key pools (per-slot usage/cooldown — never key
    // material), circuit breakers, cache hit/miss, and effective config.
    search:  getSearchHealth(),
    // AI provider key pools: per-slot status (available/cooling/rejected),
    // health (unknown/verified/rejected — a populated env var is never
    // "valid"), duplicates ignored. Slot labels only, never key material.
    credentials:   getCredentialDiagnostics(),
    // Per provider/model/slot/purpose attempt counters, latency, TTFT, key
    // switches, rate-limit hints; tokens null where the provider reported none.
    providerUsage: getProviderUsageSnapshot(),
  });
});

// E12 — Prometheus scrape target. Same exposure level as GET / above (which
// already returns getMetrics()); adds cost counters and durable-queue / DLQ
// state. Queue state is fail-open: with no Postgres, or a DB error, the scrape
// still succeeds with the in-process metrics rather than 500-ing the monitor.
router.get('/metrics', (req, res) => sendPrometheus(req, res));

/** The one Prometheus exposition — the session route above and the
 *  token-authenticated machine scrape (metricsScrape.js) both send this. */
export async function sendPrometheus(req, res) {
  let queue = null, dlq = null, workers = null, servers = null;
  if (pgConfigured()) {
    try { workers = await readProcessMetrics({ role: 'worker' }); } catch { /* fail open */ }
    try { servers = await readProcessMetrics({ role: 'server' }); } catch { /* fail open */ }
    try {
      const [stats, dead, retries] = await Promise.all([queueStats(), deadLetters(200), retryStats()]);
      queue = { ...stats, byKind: retries };
      dlq = evaluateDlq({ stats, dead });
    } catch { /* fail open — see above */ }
  }
  res.type('text/plain; version=0.0.4; charset=utf-8')
     .send(renderPrometheus({ metrics: getMetrics(), cost: getCostMetrics(), queue, dlq,
       telemetry: getTelemetryMetrics(), evalGate: readEvalGateSummary(), workers, servers }));
}

router.get('/uptime', (req, res) => {
  ok(res, getUptime());
});

router.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
  const logs  = getRecentLogs(limit);
  ok(res, { count: logs.length, logs });
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
  ok(res, {
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
