/**
 * AQUA Connect — synchronisation engine (Phase 1b)
 *
 * One run = bring one connection's knowledge in line with its source. It never
 * stores knowledge itself: imports go through files/externalSources.js
 * syncExternalResources (→ the existing ingestFiles pipeline, source-derived
 * identity, per-owner limits) and removals through deleteExternalResource.
 *
 *   mode 'full'         page through listResources. A FULL PASS may span several
 *                       runs: when a run reaches the page limit it stops, keeps
 *                       the listing cursor (conn.fullSync) and the next run
 *                       resumes from that page. Deletions are reconciled only
 *                       when a pass has listed the WHOLE source.
 *   mode 'incremental'  connector.syncChanges(checkpoint) → changed + removed.
 *   mode 'auto'         continue an unfinished full pass if there is one;
 *                       otherwise incremental when the connector supports it
 *                       and a checkpoint exists; otherwise full.
 *
 * Change detection: a listed resource whose version equals the stored version
 * is not fetched; identical bytes are "unchanged" by content identity (1a.2).
 * The per-run change limit is applied AFTER unchanged resources are set aside
 * so a large, mostly unchanged source keeps progressing.
 *
 * Mass-deletion guard: if a complete listing or a change feed
 * would remove at least MASS_DELETION.minCount resources AND more than
 * MASS_DELETION.maxFraction of what this connection holds, the removals are
 * WITHHELD (run 'partial', note, conn.pendingDeletion recorded). They are
 * applied only when (a) the NEXT complete listing / change feed proposes the
 * identical removal set, or (b) the caller passes confirmMassDeletion. Smaller
 * deletions apply normally.
 *
 * Failure semantics: transient errors are retried a bounded number of times;
 * a resource that still fails is reported in `failed`; the CHECKPOINT ADVANCES
 * ONLY ON A CLEAN RUN (no failures, no truncation, listing complete, nothing
 * withheld). An AUTH error stops the run; nothing imported is touched.
 *
 * Disconnect safety: `guard()` is called immediately before
 * every import batch and every removal; when it reports the connection is no
 * longer active (disconnecting, revoked, deleted) the run stops with state
 * 'aborted' and writes nothing further.
 *
 * Connector output is untrusted: refs and normalised resources pass
 * contract.sanitizeRef / normalizeOutput, and credential values are redacted.
 *
 * Single process only: callers serialise runs per owner with a process-wide
 * lock (connectService.js). NOT safe across processes or servers: run syncs
 * from one process.
 */
import crypto from 'node:crypto';
import * as externalDefault from '../files/externalSources.js';
import { sanitizeRef, normalizeOutput, isAuthError, isTransient, isNotFound, scrubSecrets } from './contract.js';

export const SYNC_LIMITS = Object.freeze({
  maxPages: 50,            // listResources pages per run (a full pass may span runs)
  maxChanges: 1000,        // resources NEEDING WORK per run (beyond: next run)
  retryAttempts: 3,        // per transient operation
  retryBaseMs: 250,
  maxFailedReported: 50,
  maxCursorChars: 2048,    // a listing cursor is persisted between runs; bounded so a connector cannot grow the record
});

/** Withhold a removal set this large without confirmation. */
export const MASS_DELETION = Object.freeze({ minCount: 3, maxFraction: 0.5 });

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

const removalKey = ids => crypto.createHash('sha256').update([...ids].sort().join('\u0000')).digest('hex').slice(0, 32);

/**
 * @param {object} a
 * @param {string} a.ownerId
 * @param {object} a.conn         connection record (sourceId, checkpoint, fullSync, pendingDeletion)
 * @param {object} a.connector    registry definition
 * @param {object} a.ctx          { connectionId, credentials() }
 * @param {string[]} a.secrets    credential values to redact
 * @param {'auto'|'full'|'incremental'} [a.mode]
 * @param {object} [a.external]   Phase 1a.2 API (injectable for tests)
 * @param {object} [a.retry]      { attempts, baseMs, sleep }
 * @param {() => Promise<boolean>} [a.guard]  true while the connection may still be written to
 * @param {boolean} [a.confirmMassDeletion]   apply a withheld mass deletion now (explicit user confirmation)
 * @param {object} [a.limits]     overrides SYNC_LIMITS (tests)
 * @returns {Promise<{ lastSync, checkpoint, fullSync, pendingDeletion, authFailed: boolean, aborted: boolean }>}
 */
export async function runSync({
  ownerId, conn, connector, ctx, secrets = [], mode = 'auto', external = externalDefault, retry = {},
  guard = null, confirmMassDeletion = false, limits = SYNC_LIMITS,
}) {
  const started = Date.now();
  const scrub = s => scrubSecrets(s, secrets);
  const pass = conn.fullSync?.cursor ? conn.fullSync : null;   // an unfinished full pass
  const supportsIncremental = connector.capabilities.includes('incremental');
  // A withheld deletion found by a FULL listing can only be confirmed by
  // another full listing (a change feed may never report it), so auto mode
  // runs a full pass while one is pending.
  const fullPending = conn.pendingDeletion?.origin === 'full';
  const incremental = mode === 'incremental'
    || (mode === 'auto' && !pass && !fullPending && supportsIncremental && conn.checkpoint != null);

  const counts = { listed: 0, considered: 0, skippedSameVersion: 0, fetched: 0, created: 0, updated: 0, unchanged: 0, removed: 0, rejected: 0, failed: 0, withheldRemovals: 0 };
  const failed = [];
  const notes = [];
  const fail = (externalId, reason) => {
    counts.failed++;
    if (failed.length < limits.maxFailedReported) failed.push({ externalId: externalId == null ? null : String(externalId).slice(0, 200), reason: scrub(reason).slice(0, 300) });
  };
  const keep = { checkpoint: conn.checkpoint ?? null, fullSync: conn.fullSync ?? null, pendingDeletion: conn.pendingDeletion ?? null };

  if (mode === 'incremental' && !supportsIncremental) {
    return finish({ state: 'failed', error: 'connector does not support incremental sync' }, keep);
  }

  const heldIds = () => new Set(external.listExternalResources(ownerId, conn.sourceId).map(r => r.externalId));
  const held = new Map(external.listExternalResources(ownerId, conn.sourceId).map(r => [r.externalId, r]));

  let changed = [];
  let feedRemoved = [];
  let nextCheckpoint = conn.checkpoint ?? null;
  let listingComplete = false;
  let cursor = pass?.cursor ?? null;

  try {
    if (incremental) {
      const r = await withRetry(() => connector.syncChanges(ctx, { checkpoint: conn.checkpoint }), retry);
      changed = (r?.changed ?? []).map(sanitizeRef).filter(Boolean);
      feedRemoved = (r?.removed ?? []).filter(id => typeof id === 'string' && id.length <= 512);
      nextCheckpoint = r?.checkpoint ?? conn.checkpoint;
    } else {
      for (let page = 0; page < limits.maxPages; page++) {
        const r = await withRetry(() => connector.listResources(ctx, { cursor }), retry);
        for (const ref of r?.resources ?? []) { const s = sanitizeRef(ref); if (s) changed.push(s); }
        cursor = r?.cursor === '' ? null : (r?.cursor ?? null);   // '' ends the listing, as before
        if (cursor != null && (typeof cursor !== 'string' || cursor.length > limits.maxCursorChars)) {
          throw new Error('the source returned an invalid listing cursor');   // nothing has been written yet
        }
        if (!cursor) { listingComplete = true; break; }
      }
      counts.listed = changed.length;
    }
  } catch (err) {
    if (isAuthError(err)) return finish({ state: 'failed', error: 'authorisation refused by the source; reconnect required' }, keep, true);
    return finish({ state: 'failed', error: `discovery failed: ${scrub(err?.message ?? err)}` }, keep);
  }

  // De-duplicate (last mention wins); set unchanged resources aside FIRST, then
  // bound the work (the limit counts only resources that need work).
  const byId = new Map();
  for (const c of changed) byId.set(c.externalId, c);
  const all = [...byId.values()];
  counts.considered = all.length;
  const work = [];
  for (const ref of all) {
    const have = held.get(ref.externalId);
    if (have && ref.version && have.version === ref.version) counts.skippedSameVersion++;
    else work.push(ref);
  }
  const truncated = work.length > limits.maxChanges;
  const queue = truncated ? work.slice(0, limits.maxChanges) : work;
  if (truncated) notes.push(`${work.length - limits.maxChanges} changed resource(s) beyond the per-run limit of ${limits.maxChanges}; they are covered by the next run`);

  // Fetch + normalise.
  const resources = [];
  const goneAtFetch = [];
  for (const ref of queue) {
    const have = held.get(ref.externalId);
    let raw;
    try {
      raw = await withRetry(() => connector.fetchResource(ctx, ref), retry);
    } catch (err) {
      if (isAuthError(err)) return finish({ state: 'failed', error: 'authorisation refused by the source; reconnect required' }, keep, true);
      if (isNotFound(err)) { if (have) goneAtFetch.push(ref.externalId); continue; }
      fail(ref.externalId, `fetch failed: ${err?.message ?? err}`);
      continue;
    }
    counts.fetched++;
    let out;
    try { out = normalizeOutput(connector.normalize(raw, ref), ref); }
    catch (err) { out = { error: `normalize threw: ${err?.message ?? err}` }; }
    if (out.error) { fail(ref.externalId, out.error); continue; }
    const text = out.buffer.toString('utf8');
    const clean = scrub(text);
    resources.push({
      externalId: out.externalId, name: scrub(out.name),
      ...(clean === text ? { buffer: out.buffer } : { content: clean }),
      sourceUpdatedAt: out.sourceUpdatedAt, url: out.url ? scrub(out.url) : null,
      title: out.title ? scrub(out.title) : null, version: out.version,
    });
  }

  // Import, re-checking the connection before EVERY batch.
  const batch = external.EXTERNAL_LIMITS.resourcesPerSync;
  for (let i = 0; i < resources.length; i += batch) {
    if (guard && !(await guard())) return aborted();
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
      if (x.status === 'rejected' && failed.length < limits.maxFailedReported) failed.push({ externalId: x.externalId, reason: `rejected: ${x.reason}` });
    }
  }

  // Which removals does this run propose? (Only from a COMPLETE pass.)
  let nextFullSync = conn.fullSync ?? null;
  let proposed = null;   // null = this run cannot judge deletions
  if (incremental) {
    proposed = [...feedRemoved, ...goneAtFetch];
  } else {
    const now = heldIds();
    const seen = new Set([...(pass?.seenHeld ?? []), ...all.map(r => r.externalId).filter(id => now.has(id))]);
    if (!listingComplete) {
      nextFullSync = { cursor, startedAt: pass?.startedAt ?? new Date(started).toISOString(), runs: (pass?.runs ?? 0) + 1, seenHeld: [...seen] };
      notes.push(`listing incomplete after ${limits.maxPages} page(s); the next run continues from the saved position, and deletions wait until the whole source has been listed`);
      proposed = goneAtFetch.length ? goneAtFetch : null;   // a resource confirmed gone by fetch is still a valid single deletion
    } else {
      nextFullSync = null;
      proposed = [...[...now].filter(id => !seen.has(id)), ...goneAtFetch];
    }
  }

  // Mass-deletion guard.
  let nextPending = conn.pendingDeletion ?? null;
  let toRemove = [];
  if (proposed) {
    const now = heldIds();
    const removals = [...new Set(proposed)].filter(id => now.has(id));
    const judging = incremental || listingComplete;
    if (removals.length) {
      const key = removalKey(removals);
      const isMass = removals.length >= MASS_DELETION.minCount && removals.length / Math.max(1, now.size) > MASS_DELETION.maxFraction;
      const confirmedByRepeat = judging && conn.pendingDeletion?.key === key;
      if (isMass && !confirmMassDeletion && !confirmedByRepeat) {
        counts.withheldRemovals = removals.length;
        nextPending = { key, origin: incremental ? 'incremental' : 'full', count: removals.length, held: now.size, firstSeenAt: conn.pendingDeletion?.key === key ? conn.pendingDeletion.firstSeenAt : new Date(started).toISOString() };
        notes.push(`mass deletion withheld: the source no longer lists ${removals.length} of ${now.size} resource(s); applied only if the next complete listing agrees, or on explicit confirmation`);
      } else {
        toRemove = removals;
        if (judging) nextPending = null;
      }
    } else if (judging) {
      nextPending = null;   // nothing to remove: any earlier pending mass deletion resolved itself
    }
  }

  for (const id of toRemove) {
    if (guard && !(await guard())) return aborted();
    try {
      const d = await external.deleteExternalResource(ownerId, conn.sourceId, id);
      if (d.complete) counts.removed++; else fail(id, `removal incomplete: ${(d.errors ?? []).join('; ') || 'remaining artefacts'}`);
    } catch (err) {
      fail(id, `removal failed: ${err?.message ?? err}`);
    }
  }

  const withheld = counts.withheldRemovals > 0;
  const clean = counts.failed === 0 && !truncated && !withheld && (incremental || listingComplete);
  const checkpoint = clean ? (incremental ? nextCheckpoint : { fullSyncAt: new Date(started).toISOString() }) : (conn.checkpoint ?? null);
  return finish({
    state: clean ? 'succeeded' : 'partial',
    complete: clean,
    ...(notes.length ? { note: notes.join(' · ') } : {}),
  }, { checkpoint, fullSync: nextFullSync, pendingDeletion: nextPending });

  function aborted() {
    return finish({ state: 'aborted', note: 'the connection is no longer active (disconnecting, revoked or deleted); the sync stopped and wrote nothing further' }, keep, false, true);
  }

  function finish(extra, positions, authFailed = false, wasAborted = false) {
    return {
      authFailed,
      aborted: wasAborted,
      checkpoint: positions.checkpoint,
      fullSync: positions.fullSync,
      pendingDeletion: positions.pendingDeletion,
      lastSync: {
        mode: incremental ? 'incremental' : 'full',
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        complete: false,
        counts, failed,
        ...extra,
        ...(extra.error ? { error: scrub(extra.error).slice(0, 300) } : {}),
      },
    };
  }
}
