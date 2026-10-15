/**
 * E12 — worker metrics reach /metrics through Postgres (2026-10-04).
 *
 * Each worker process publishes a snapshot of its in-memory counters to
 * aqua_process_metrics on an interval (migration 0020); the server's /metrics
 * reads every fresh row. No in-memory cross-process sync, no fabricated
 * values: a worker that stops publishing ages out and shows up as missing.
 *
 * The snapshot carries ONLY aggregates that are already PII-safe by
 * construction: telemetry stage/error counters (allowlisted), cost/token
 * counters (no content), E6 numeric counters, and the revision-voice / J3
 * counters (labels are fixed reason enumerations).
 */
import os from 'node:os';
import { getPool, isConfigured } from './db/pool.js';
import { getCostMetrics } from './costAccounting.js';
import { getTelemetryMetrics } from './telemetry.js';
import { getMetrics } from './observability.js';

export const PROCESS_ID = `${process.pid}@${(process.env.HOSTNAME ?? os.hostname() ?? 'local').slice(0, 40)}`;
const STARTED_AT = new Date();

/** The counters this process can honestly report, numbers only. */
export function processSnapshot() {
  const m = getMetrics() ?? {};
  const e6 = m.e6 ?? {};
  return {
    revisionVoice: m.revisionVoice ?? null,
    j3: m.j3 ?? null,
    proactive: m.proactive ?? null,
    cost: getCostMetrics(),
    telemetry: getTelemetryMetrics(),
    e6: Object.fromEntries(Object.entries(e6).filter(([, v]) => typeof v === 'number')),
  };
}

export async function publishProcessMetrics({ role = 'worker', pool = null, snapshot = processSnapshot(), processId = PROCESS_ID } = {}) {
  if (!pool && !isConfigured()) return false;
  const p = pool ?? await getPool();
  await p.query(
    `INSERT INTO aqua_process_metrics (process_id, role, started_at, updated_at, snapshot)
     VALUES ($1, $2, $3, now(), $4::jsonb)
     ON CONFLICT (process_id) DO UPDATE SET role=EXCLUDED.role, updated_at=now(), snapshot=EXCLUDED.snapshot`,
    [processId, role, STARTED_AT, JSON.stringify(snapshot)]);
  return true;
}

/** Start periodic publishing. Returns stop(). Failures are logged once per burst, never thrown. */
export function startMetricsPublisher({ role = 'worker', intervalMs = 15_000 } = {}) {
  let failing = false;
  const tick = () => publishProcessMetrics({ role }).then(
    () => { failing = false; },
    err => { if (!failing) console.warn(`[METRICS] snapshot publish failed: ${err?.message ?? err}`); failing = true; });
  tick();
  const t = setInterval(tick, Math.max(1000, intervalMs));
  t.unref?.();
  return async () => { clearInterval(t); await tick(); };
}

/** Fresh snapshots (default: updated in the last 2 minutes). */
export async function readProcessMetrics({ role = 'worker', maxAgeMs = 120_000, pool = null } = {}) {
  if (!pool && !isConfigured()) return [];
  const p = pool ?? await getPool();
  const { rows } = await p.query(
    `SELECT process_id, role, snapshot, EXTRACT(EPOCH FROM (now() - updated_at))::float AS age_s
       FROM aqua_process_metrics
      WHERE role=$1 AND updated_at >= now() - make_interval(secs => $2)
      ORDER BY process_id
      LIMIT 64`, [role, Math.max(1, maxAgeMs / 1000)]);
  return rows.map(r => ({ processId: r.process_id, role: r.role, ageSeconds: Number(r.age_s), snapshot: r.snapshot ?? {} }));
}
