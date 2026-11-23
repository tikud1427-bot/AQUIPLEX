/**
 * AQUA Connect — production wiring, built lazily and only when AQUA_GMAIL_CONNECT=on.
 * Shared by the HTTP routes (routes/connect.js), the durable sync job
 * (connect/syncJob.js, run by the worker) and the account purge
 * (connect/connectPurge.js). Moved here from routes/connect.js in Gmail Phase 2.
 *
 * Never logs a value — only variable names.
 */
import { gmailConnectEnabled } from './gmail/gmailOAuthConfig.js';

export const CONNECT_SYNC_JOB_KIND = 'connect.sync.v1';
const SYNC_MODES = new Set(['auto', 'full', 'incremental']);
let depsPromise = null;

export function productionConnectDeps(env = process.env, log = console) {
  depsPromise ??= (async () => {
    if (!gmailConnectEnabled(env)) return { gmail: null, reason: 'disabled' };
    const { buildGmailOAuth } = await import('./gmail/gmailOAuthConfig.js');
    const built = buildGmailOAuth(env);
    if (!built.ok) {
      log.warn?.(`[CONNECT] Gmail Connect is ON but not configured; routes stay off: ${built.problems.join('; ')}`);
      return { gmail: null, reason: 'misconfigured' };
    }
    const [{ createGoogleGmailTransport }, { createGmailConnector }, { defaultRegistry }, { createMongoConnectionStore }, { vaultFromEnv }, { createConnectService }] = await Promise.all([
      import('./gmail/googleGmailTransport.js'),
      import('./gmail/gmailConnector.js'),
      import('./registry.js'),
      import('./connectionStore.js'),
      import('./credentialVault.js'),
      import('./connectService.js'),
    ]);
    const vault = vaultFromEnv(env);
    if (vault.unavailable) log.warn?.(`[CONNECT] Gmail Connect: the credential key is unavailable (${vault.code}); connecting is refused`);
    const connector = createGmailConnector({ transport: createGoogleGmailTransport(built.transportOptions) });
    if (!defaultRegistry.has(connector.id)) defaultRegistry.register(connector);
    const service = createConnectService({ registry: defaultRegistry, store: createMongoConnectionStore(), vault });
    const runner = createInProcessSyncRunner({ service, log });
    log.log?.('[CONNECT] Gmail Connect routes enabled (read-only scope)');
    return { gmail: built.config, service, vault, startSync: runner.start, isSyncing: runner.isRunning };
  })().catch(err => {
    depsPromise = null;   // a failed build is retried on the next request
    throw err;
  });
  return depsPromise;
}

/**
 * Finalization (2026-11-23) — a sync runs in the API process that received the
 * request, in the background after the 202, never inside the request.
 *
 * Why not the worker: a sync imports into the UKO store (files/ukoStore.js),
 * whose owners section has ONE writer — the server (AQUIPLEX_STORE_OWNERSHIP_MATRIX:
 * "uko — worker writers: none"). With partitions off (production) the store is an
 * in-memory map loaded once at boot and saved as a whole file, so a sync run by
 * the worker process (a) is never seen by the API that serves the Email page and
 * (b) overwrites, and is overwritten by, the API's own saves (uploads, deletions).
 * The worker also has no MongoDB connection for the connection store.
 *
 * Single flight per (owner, connection) in this process; a second request while
 * one runs reports it as running. connectService.sync still serialises per owner,
 * re-checks the connection before every batch and persists its position, so a
 * restart mid-run loses nothing: the next sync resumes. Errors are logged by code
 * only (never content); the outcome is on the connection record (lastSync).
 */
export function createInProcessSyncRunner({ service, log = console, maxRuns = 500, pauseMs = 25 } = {}) {
  const running = new Map();
  const key = (ownerId, connectionId) => `${ownerId}\u0000${connectionId}`;
  function start({ principal, connectionId, mode = 'auto', confirmMassDeletion = false } = {}) {
    const userId = principal?.userId;
    if (typeof userId !== 'string' || !userId) throw Object.assign(new Error('Login required'), { code: 'UNAUTHENTICATED' });
    if (typeof connectionId !== 'string' || !/^conn_[0-9a-f]{20}$/.test(connectionId)) throw Object.assign(new Error('connection not found'), { code: 'NOT_FOUND' });
    if (!SYNC_MODES.has(mode)) throw Object.assign(new Error('mode must be auto, full or incremental'), { code: 'BAD_REQUEST' });
    const ownerId = `user:${userId}`;
    const k = key(ownerId, connectionId);
    if (running.has(k)) return { started: false, running: true };
    const run = (async () => {
      const [{ runWithDataClass }, { ownerLogId }] = await Promise.all([import('../core/egressGuard.js'), import('../core/logSafety.js')]);
      try {
        // 2026-11-23 — one request completes the whole pass: bounded runs back to back
        // while the engine reports `more` (an unfinished full listing, or changes beyond a
        // run's budget). Each run persists its position; the owner lock is released between
        // runs (a disconnect or pause gets in, and the next run then refuses).
        let failedInARow = 0;
        for (let i = 0; i < maxRuns; i++) {
          const r = await runWithDataClass('external:gmail', () => service.sync({
            principal, connectionId, mode: i === 0 ? mode : 'auto', confirmMassDeletion: i === 0 && confirmMassDeletion === true,
          }));
          const ls = r?.lastSync;
          if (r?.aborted || !ls || ls.more !== true) break;
          if (ls.state === 'failed') {
            // Only a failure the engine marks resumable (a dead listing position, discarded:
            // the next run lists from the start) continues — and only once in a row.
            if (++failedInARow > 1) break;
          } else {
            failedInARow = 0;
            const c = ls.counts ?? {};
            const touched = ['listed', 'skippedSameVersion', 'created', 'updated', 'unchanged', 'removed', 'rejected', 'failed'].reduce((n, k) => n + (Number(c[k]) || 0), 0);
            if (touched === 0) break;   // no progress: never spin
          }
          await new Promise(res => setTimeout(res, pauseMs));
        }
      } catch (err) {
        log.warn?.(`[CONNECT] sync did not run connection=${connectionId} owner=${ownerLogId(ownerId)} code=${typeof err?.code === 'string' ? err.code.slice(0, 40) : 'ERROR'}`);
      }
    })().finally(() => running.delete(k));
    running.set(k, run);
    return { started: true, running: true };
  }
  const isRunning = (ownerId, connectionId) => running.has(key(ownerId, connectionId));
  /** Tests: resolves when every sync started so far has finished. */
  const idle = () => Promise.all([...running.values()]).then(() => {});
  return { start, isRunning, idle };
}

/**
 * NOT USED by the routes since finalization (see createInProcessSyncRunner): kept
 * for its tests. Gmail Phase 2 — queue a sync of one connection on the EXISTING durable job
 * queue (core/jobs/jobQueue.js; run by the worker, connect/syncJob.js).
 * `ownerId` comes from the authenticated principal (routes) — never from the
 * request. At most one sync job per connection per minute (idempotency key);
 * the queue runs one job per owner at a time.
 * @returns {Promise<{ jobId: number, created: boolean }>}
 */
export async function enqueueSync({ ownerId, connectionId, mode = 'auto', confirmMassDeletion = false, now = Date.now() } = {}) {
  if (typeof ownerId !== 'string' || !ownerId.startsWith('user:')) throw Object.assign(new Error('a user owner is required'), { code: 'UNAUTHENTICATED' });
  if (typeof connectionId !== 'string' || !/^conn_[0-9a-f]{20}$/.test(connectionId)) throw Object.assign(new Error('connection not found'), { code: 'NOT_FOUND' });
  if (!SYNC_MODES.has(mode)) throw Object.assign(new Error('mode must be auto, full or incremental'), { code: 'BAD_REQUEST' });
  const { enqueue, queueConfigured } = await import('../core/jobs/jobQueue.js');
  if (!queueConfigured()) throw Object.assign(new Error('the job queue is not configured'), { code: 'SYNC_QUEUE_UNAVAILABLE' });
  const minute = Math.floor(now / 60_000);
  return enqueue({
    ownerId, kind: CONNECT_SYNC_JOB_KIND,
    payload: { connectionId, mode, confirmMassDeletion: confirmMassDeletion === true },
    idempotencyKey: `connect-sync:${connectionId}:${mode}:${confirmMassDeletion === true ? 'confirm' : 'plain'}:${minute}`,
    priority: 120, maxAttempts: 5,
  });
}

/** Test-only: forget the cached production dependencies. */
export function _resetProductionConnectDepsForTests() { depsPromise = null; }
