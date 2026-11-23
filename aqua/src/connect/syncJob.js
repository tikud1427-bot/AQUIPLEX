/**
 * AQUA Connect — the durable sync job `connect.sync.v1` (Gmail Phase 2).
 *
 * Queued by POST /api/aqua/connect/connections/:id/sync (productionDeps.enqueueSync)
 * on the EXISTING job queue and run by the EXISTING worker runtime
 * (core/jobs/workerRuntime.js HANDLERS). No new worker framework.
 *
 * Identity: the job's ownerId (set at enqueue from the authenticated principal)
 * is the ONLY source of the user; the payload carries just the connection id
 * and the mode. connectService.sync then loads the connection by (owner, id) —
 * another owner's connection id finds nothing.
 *
 * Outcomes:
 *   a sync that ran (any state, incl. partial/aborted)      → job completes
 *   nothing to do (paused, not active, gone, needs reauth,
 *   credentials unreadable, owner deleted, connect off)     → job completes as a no-op (reported)
 *   anything else (lease busy, store/provider transient)    → thrown: the queue retries with backoff
 */
import { principalForServerJob } from './principal.js';
import { productionConnectDeps } from './productionDeps.js';

const NOTHING_TO_DO = new Set(['PAUSED', 'NOT_ACTIVE', 'NOT_FOUND', 'NEEDS_REAUTH', 'CREDENTIALS_UNREADABLE', 'OWNER_DELETED', 'UNKNOWN_CONNECTOR', 'UNAUTHENTICATED']);
const MODES = new Set(['auto', 'full', 'incremental']);

export async function runConnectSyncJob(job, { getDeps = productionConnectDeps } = {}) {
  const owner = String(job?.ownerId ?? '');
  if (!owner.startsWith('user:') || owner.length <= 'user:'.length) return { skipped: 'not-a-user-owner' };
  const userId = owner.slice('user:'.length);
  const p = job?.payload ?? {};
  const mode = MODES.has(p.mode) ? p.mode : 'auto';
  const deps = await getDeps();
  if (!deps?.service) return { skipped: 'connect-disabled' };
  try {
    const r = await deps.service.sync({
      principal: principalForServerJob(userId),
      connectionId: String(p.connectionId ?? ''),
      mode,
      confirmMassDeletion: p.confirmMassDeletion === true,
    });
    return { state: r?.lastSync?.state ?? null, aborted: r?.aborted === true, status: r?.status ?? null };
  } catch (err) {
    if (NOTHING_TO_DO.has(err?.code)) return { skipped: err.code };
    throw err;
  }
}
