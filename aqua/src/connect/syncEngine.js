/**
 * AQUA Connect — synchronisation engine (Phase 1b)
 *
 * One run = bring one connection's knowledge in line with its source. It never
 * stores knowledge itself: imports go through files/externalSources.js
 * syncExternalResources (→ the existing ingestFiles pipeline, source-derived
 * identity, per-owner limits) and removals through deleteExternalResource.
 *
 *   mode 'full'         page through listResources; everything listed is
 *                       considered; anything we hold that the source no longer
 *                       lists is removed — but ONLY when the listing completed.
 *   mode 'incremental'  connector.syncChanges(checkpoint) → changed + removed.
 *   mode 'auto'         incremental when the connector supports it and a
 *                       checkpoint exists, otherwise full.
 *
 * Change detection: a listed resource whose version equals the version we
 * stored is not fetched at all; a fetched resource whose bytes are identical
 * is "unchanged" by content identity (Phase 1a.2). Both make re-runs idempotent.
 *
 * Failure semantics (retry-safe by construction):
 *   transient errors (TRANSIENT / 429 / 5xx / timeouts) are retried a bounded
 *   number of times inside the run; a resource that still fails is reported in
 *   `failed` and the run ends 'partial'. The CHECKPOINT ADVANCES ONLY ON A
 *   CLEAN RUN, so the next run re-covers everything a failed run missed;
 *   imports are idempotent, so nothing is duplicated. An AUTH error stops the
 *   run ('needs_reauth'); nothing already imported is touched.
 *
 * Connector output is untrusted: refs and normalised resources pass
 * contract.sanitizeRef / normalizeOutput, and any credential value that
 * appears in content, names or errors is redacted before it can be stored,
 * logged or reach a prompt.
 *
 * Single-process only: callers (connectService.js) serialise runs per owner
 * with an in-process lock. Not safe across instances: run syncs from one process.
 */
import * as externalDefault from '../files/externalSources.js';
import { sanitizeRef, normalizeOutput, isAuthError, isTransient, isNotFound, scrubSecrets } from './contract.js';

export const SYNC_LIMITS = Object.freeze({
  maxPages: 50,            // listResources pages per full run
  maxChanges: 1000,        // resources considered per run (beyond: next run)
  retryAttempts: 3,        // per transient operation
  retryBaseMs: 250,
  maxFailedReported: 50,
});

const realSleep = ms => new Promise(r => setTimeout(r, ms));

/** Run `fn`, retrying transient failures with exponential backoff. */
export async function withRetry(fn, { attempts = SYNC_LIMITS.retryAttempts, baseMs = SYNC_LIMITS.retryBaseMs, sleep = realSleep } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      await sleep(baseMs * 2 ** i);
    }
  }
  throw last;
}

/**
 * @param {object} a
 * @param {string} a.ownerId
 * @param {object} a.conn         connection record (sourceId, checkpoint, connectorId)
 * @param {object} a.connector    registry definition
 * @param {object} a.ctx          { connectionId, credentials() }
 * @param {string[]} a.secrets    credential values to redact
 * @param {'auto'|'full'|'incremental'} [a.mode]
 * @param {object} [a.external]   Phase 1a.2 API (injectable for tests)
 * @param {object} [a.retry]      { attempts, baseMs, sleep }
 * @returns {Promise<{ lastSync: object, checkpoint: any, authFailed: boolean }>}
 */
export async function runSync({ ownerId, conn, connector, ctx, secrets = [], mode = 'auto', external = externalDefault, retry = {} }) {
  const started = Date.now();
  const scrub = s => scrubSecrets(s, secrets);
  const incremental = mode === 'incremental' || (mode === 'auto' && connector.capabilities.includes('incremental') && conn.checkpoint != null);
  if (mode === 'incremental' && !connector.capabilities.includes('incremental')) {
    return finish({ state: 'failed', error: 'connector does not support incremental sync' });
  }

  const counts = { listed: 0, considered: 0, skippedSameVersion: 0, fetched: 0, created: 0, updated: 0, unchanged: 0, removed: 0, rejected: 0, failed: 0 };
  const failed = [];
  const fail = (externalId, reason) => {
    counts.failed++;
    if (failed.length < SYNC_LIMITS.maxFailedReported) failed.push({ externalId: externalId == null ? null : String(externalId).slice(0, 200), reason: scrub(reason).slice(0, 300) });
  };

  // What we already hold for this source (Phase 1a.2), keyed by external id.
  const held = new Map(external.listExternalResources(ownerId, conn.sourceId).map(r => [r.externalId, r]));

  let changed = [];
  let removedIds = [];
  let nextCheckpoint = conn.checkpoint ?? null;
  let listingComplete = false;

  try {
    if (incremental) {
      const r = await withRetry(() => connector.syncChanges(ctx, { checkpoint: conn.checkpoint }), retry);
      changed = (r?.changed ?? []).map(sanitizeRef).filter(Boolean);
      removedIds = (r?.removed ?? []).filter(id => typeof id === 'string' && id.length <= 512);
      nextCheckpoint = r?.checkpoint ?? conn.checkpoint;
    } else {
      let cursor = null;
      for (let page = 0; page < SYNC_LIMITS.maxPages; page++) {
        const r = await withRetry(() => connector.listResources(ctx, { cursor }), retry);
        for (const ref of r?.resources ?? []) { const s = sanitizeRef(ref); if (s) changed.push(s); }
        cursor = r?.cursor ?? null;
        if (!cursor) { listingComplete = true; break; }
      }
      counts.listed = changed.length;
      // Deletions are inferred ONLY from a complete listing; a truncated or
      // failed listing must never make us delete knowledge.
      if (listingComplete) {
        const listed = new Set(changed.map(c => c.externalId));
        removedIds = [...held.keys()].filter(id => !listed.has(id));
      }
      nextCheckpoint = listingComplete ? { fullSyncAt: new Date(started).toISOString() } : conn.checkpoint;
    }
  } catch (err) {
    if (isAuthError(err)) return finish({ state: 'failed', error: 'authorisation refused by the source; reconnect required' }, true);
    return finish({ state: 'failed', error: `discovery failed: ${scrub(err?.message ?? err)}` });
  }

  // De-duplicate by external id (last mention wins) and bound the run.
  const byId = new Map();
  for (const c of changed) byId.set(c.externalId, c);
  let queue = [...byId.values()];
  let truncated = false;
  if (queue.length > SYNC_LIMITS.maxChanges) { queue = queue.slice(0, SYNC_LIMITS.maxChanges); truncated = true; }
  counts.considered = queue.length;

  // Fetch + normalise (version-equal resources are not fetched at all).
  const resources = [];
  for (const ref of queue) {
    const have = held.get(ref.externalId);
    if (have && ref.version && have.version === ref.version) { counts.skippedSameVersion++; continue; }
    let raw;
    try {
      raw = await withRetry(() => connector.fetchResource(ctx, ref), retry);
    } catch (err) {
      if (isAuthError(err)) return finish({ state: 'failed', error: 'authorisation refused by the source; reconnect required' }, true);
      if (isNotFound(err)) { if (have) removedIds.push(ref.externalId); continue; }   // gone between list and fetch
      fail(ref.externalId, `fetch failed: ${err?.message ?? err}`);
      continue;
    }
    counts.fetched++;
    let out;
    try { out = normalizeOutput(connector.normalize(raw, ref), ref); }
    catch (err) { out = { error: `normalize threw: ${err?.message ?? err}` }; }
    if (out.error) { fail(ref.externalId, out.error); continue; }
    // Credentials must never become knowledge, even if a connector echoes them.
    const text = out.buffer.toString('utf8');
    const clean = scrub(text);
    resources.push({
      externalId: out.externalId, name: scrub(out.name),
      ...(clean === text ? { buffer: out.buffer } : { content: clean }),
      sourceUpdatedAt: out.sourceUpdatedAt, url: out.url ? scrub(out.url) : null,
      title: out.title ? scrub(out.title) : null, version: out.version,
    });
  }

  // Import through the Phase 1a.2 lifecycle, in its per-call batch size.
  const batch = external.EXTERNAL_LIMITS.resourcesPerSync;
  for (let i = 0; i < resources.length; i += batch) {
    let r;
    try {
      r = await external.syncExternalResources({ ownerId, sourceId: conn.sourceId, resources: resources.slice(i, i + batch) });
    } catch (err) {
      for (const x of resources.slice(i, i + batch)) fail(x.externalId, `import failed: ${err?.message ?? err}`);
      continue;
    }
    for (const x of r.results) {
      if (x.status in counts) counts[x.status]++;
      if (x.status === 'failed') { counts.failed--; fail(x.externalId, x.reason ?? 'import failed'); }
      if (x.status === 'rejected') failed.length < SYNC_LIMITS.maxFailedReported && failed.push({ externalId: x.externalId, reason: `rejected: ${x.reason}` });
    }
  }

  // Remove what the source no longer has.
  for (const id of [...new Set(removedIds)]) {
    if (!held.has(id)) continue;
    try {
      const d = await external.deleteExternalResource(ownerId, conn.sourceId, id);
      if (d.complete) counts.removed++; else fail(id, `removal incomplete: ${(d.errors ?? []).join('; ') || 'remaining artefacts'}`);
    } catch (err) {
      fail(id, `removal failed: ${err?.message ?? err}`);
    }
  }

  const clean = counts.failed === 0 && !truncated;
  return finish({
    state: clean ? 'succeeded' : 'partial',
    ...(truncated ? { note: `more than ${SYNC_LIMITS.maxChanges} changes; the rest are covered by the next run` } : {}),
  }, false, clean ? nextCheckpoint : conn.checkpoint ?? null);

  function finish(extra, authFailed = false, checkpoint = conn.checkpoint ?? null) {
    return {
      authFailed,
      checkpoint,
      lastSync: {
        mode: incremental ? 'incremental' : 'full',
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        counts, failed,
        ...extra,
        ...(extra.error ? { error: scrub(extra.error).slice(0, 300) } : {}),
      },
    };
  }
}
