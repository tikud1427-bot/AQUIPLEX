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
 *                       A connector that reports the position EXPIRED
 *                       (ConnectorError 'CURSOR_EXPIRED', e.g. Gmail history
 *                       gone) gets a full listing in the same run (auto) or a
 *                       failed run with the position cleared (incremental).
 *                       A full listing's last page may carry the source
 *                       position it started from (`checkpoint`); a clean
 *                       complete pass stores it for the next incremental run.
 *   mode 'auto'         continue an unfinished full pass if there is one;
 *                       otherwise incremental when the connector supports it
 *                       and a checkpoint exists; otherwise full.
 *
 * Change detection: a listed resource whose version equals the stored version
 * is not fetched; identical bytes are "unchanged" by content identity (1a.2).
 * The per-run change limit is applied AFTER unchanged resources are set aside
 * so a large, mostly unchanged source keeps progressing.
 *
 * Mass-deletion guard (Phase 1b.2): a removal set of at least
 * MASS_DELETION.minCount resources AND more than MASS_DELETION.maxFraction of
 * what this connection holds is WITHHELD (run 'partial', note,
 * conn.pendingDeletion recorded). It is applied only when either
 *   (a) a COMPLETE FULL LISTING records the exact set and its time, and a
 *       later complete full listing, at least MASS_DELETION.confirmAfterMs
 *       later, proposes exactly the same set — with no failed, aborted or
 *       incomplete run in between (any of those resets the sequence; a
 *       different set restarts it); or
 *   (b) the caller passes confirmMassDeletion === true (explicit user choice).
 * A change feed can never confirm: a mass removal reported by a feed is
 * withheld and auto mode then runs a full listing. Removals are never
 * proposed from an incomplete listing. Smaller deletions apply normally.
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
import { sanitizeRef, normalizeOutput, isAuthError, isTransient, isNotFound, isCursorExpired, isRefused, isRateLimited, scrubSecrets } from './contract.js';
import { dataClassOfSource } from '../core/dataClass.js';
import { runWithDataClass } from '../core/egressGuard.js';

export const SYNC_LIMITS = Object.freeze({
  maxPages: 50,            // listResources pages per run (a full pass may span runs)
  maxChanges: 1000,        // resources NEEDING WORK per run (beyond: next run)
  retryAttempts: 3,        // per transient operation
  retryBaseMs: 250,
  maxFailedReported: 50,
  maxCursorChars: 2048,    // a listing cursor is persisted between runs; bounded so a connector cannot grow the record
  maxRemovalChecks: 50,    // Gmail Phase 2: per-run source confirmations of proposed removals (beyond: kept, judged next run)
  fetchPaceMs: 50,         // 2026-11-23: minimum gap between resource fetches (≤ 20/s); doubles after a rate-limit response (≤ 2 s)
  maxPaceMs: 2_000,
});

/** Withhold a removal set this large without confirmation. */
export const MASS_DELETION = Object.freeze({ minCount: 3, maxFraction: 0.5, confirmAfterMs: 60 * 60 * 1000 });

const realSleep = ms => new Promise(r => setTimeout(r, ms));

/** Run `fn`, retrying transient failures with exponential backoff. */
/**
 * Gmail Phase 2 — a server-requested pause (HTTP Retry-After, carried as
 * err.retryAfterMs) is honoured inside a run only up to this bound. A longer
 * pause ends the attempt at once: the durable job's own backoff waits it out,
 * so a run never holds the owner's connect lease through a long sleep.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/**
 * 2026-11-23 — bounded retry of TRANSIENT failures (never an auth / refused / permanent one):
 *   · a server-requested pause (Retry-After) is honoured up to MAX_RETRY_AFTER_MS; a longer
 *     one ends the attempt at once (the run stops; a later Sync now resumes);
 *   · otherwise exponential backoff with equal jitter, each delay ≤ RETRY.maxDelayMs;
 *   · rate-limited failures get their own, longer budget (RETRY.rateLimit*);
 *   · the total time spent waiting is bounded (RETRY.maxElapsedMs);
 *   · `shouldContinue` is asked before every wait: a paused / disconnected connection stops
 *     the retry with err.stopped (the engine then aborts the run, writing nothing more).
 */
export const RETRY = Object.freeze({ maxDelayMs: 32_000, maxElapsedMs: 120_000, rateLimitAttempts: 5, rateLimitBaseMs: 1_000 });
export class SyncStopped extends Error { constructor() { super('sync stopped: the connection is no longer active'); this.stopped = true; } }
export async function withRetry(fn, {
  attempts = SYNC_LIMITS.retryAttempts, baseMs = SYNC_LIMITS.retryBaseMs, sleep = realSleep, random = Math.random,
  rateLimitAttempts = RETRY.rateLimitAttempts, rateLimitBaseMs = RETRY.rateLimitBaseMs,
  maxDelayMs = RETRY.maxDelayMs, maxElapsedMs = RETRY.maxElapsedMs, shouldContinue = null, onRetry = null,
} = {}) {
  let waited = 0;
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (err) {
      if (!isTransient(err)) throw err;
      const limited = isRateLimited(err);
      if (i >= (limited ? rateLimitAttempts : attempts) - 1) throw err;
      const ra = Number(err?.retryAfterMs);
      let delay;
      if (Number.isFinite(ra) && ra >= 0) {
        if (ra > MAX_RETRY_AFTER_MS) throw err;
        delay = ra;
      } else {
        const cap = Math.min(maxDelayMs, (limited ? rateLimitBaseMs : baseMs) * 2 ** i);
        delay = Math.round(cap / 2 + random() * (cap / 2));   // equal jitter: [cap/2, cap]
      }
      if (waited + delay > maxElapsedMs) throw err;
      if (shouldContinue && !(await shouldContinue())) throw new SyncStopped();
      try { onRetry?.(err, delay); } catch { /* reporting only */ }
      await sleep(delay);
      waited += delay;
    }
  }
}

/** A connector-supplied checkpoint, kept only when it is a small plain object (it is persisted). */
function boundedCheckpoint(cp, limits) {
  if (cp == null || typeof cp !== 'object' || Array.isArray(cp)) return null;
  try { return JSON.stringify(cp).length <= limits.maxCursorChars ? JSON.parse(JSON.stringify(cp)) : null; } catch { return null; }
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
 * @param {(fullSync: object) => Promise<void>} [a.persistProgress]  2026-11-23: durably save a full pass's
 *        position after a batch (throws err.stopped when the connection is no longer active)
 * @param {() => boolean} [a.shouldStop]  2026-11-23: a pause / revoke / disconnect is waiting (checked before every fetch)
 * @param {() => number} [a.now]  clock (ms); injected so the confirmation interval is testable
 * @returns {Promise<{ lastSync, checkpoint, fullSync, pendingDeletion, authFailed: boolean, aborted: boolean }>}
 */
export function runSync(args) {
  // G1-2 — a sync fetches the source's content (listResources/fetchResource/
  // normalize) before the lifecycle stores it: all of it runs in the
  // connection's data class, so nothing in this request or job can send what
  // was fetched to a provider the class does not allow (core/egressGuard.js).
  return runWithDataClass(dataClassOfSource(args?.conn?.sourceId), () => runSyncScoped(args));
}

async function runSyncScoped({
  ownerId, conn, connector, ctx, secrets = [], mode = 'auto', external = externalDefault, retry = {},
  guard = null, confirmMassDeletion = false, limits = SYNC_LIMITS, now: clock = Date.now, persistProgress = null, shouldStop = null,
}) {
  const started = clock();
  // Phase 4B: RECOVERED retries are recorded too (the first real sync recovered from three
  // rate limits and left no trace of why). Numbers and identifier-shaped reason codes only —
  // never a token, a body or provider text.
  const retries = { total: 0, rateLimited: 0, byStatus: {}, byReason: {} };
  const REASON_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
  const noteRetry = e => {
    retries.total++;
    if (isRateLimited(e)) retries.rateLimited++;
    const st = Number(e?.status);
    if (Number.isInteger(st) && st >= 100 && st < 600) retries.byStatus[st] = (retries.byStatus[st] ?? 0) + 1;
    if (typeof e?.reason === 'string' && REASON_RE.test(e.reason)) retries.byReason[e.reason] = (retries.byReason[e.reason] ?? 0) + 1;
  };
  // 2026-11-23: every retry asks the guard first (a paused / disconnected connection stops it).
  const retryOpts = { ...retry, ...(guard ? { shouldContinue: guard } : {}), onRetry: noteRetry };
  // Pages listed by THIS run, in order: the ids each returned and the cursor after it.
  // A page is "done" when every resource of it that needed work has been processed;
  // the durable position may then move past it (persistProgress, per batch).
  const pages = [];
  const scrub = s => scrubSecrets(s, secrets);
  const pass = conn.fullSync?.cursor ? conn.fullSync : null;   // an unfinished full pass
  const supportsIncremental = connector.capabilities.includes('incremental');
  // A withheld mass deletion can only be confirmed by a complete full
  // listing, so auto mode runs a full pass while one is pending (whatever
  // found it).
  const fullPending = conn.pendingDeletion != null;
  let incremental = mode === 'incremental'
    || (mode === 'auto' && !pass && !fullPending && supportsIncremental && conn.checkpoint != null);

  const counts = { listed: 0, considered: 0, skippedSameVersion: 0, fetched: 0, created: 0, updated: 0, unchanged: 0, removed: 0, rejected: 0, failed: 0, withheldRemovals: 0 };
  const failed = [];
  const notes = [];
  // Failures (retryable) dirty a pass; rejections are deterministic (too large, invalid,
  // deleted since the sync started) and are reported in counts.rejected / `failed`, not retried.
  const passDirty = () => pass?.dirty === true || counts.failed > 0;
  const fail = (externalId, reason) => {
    counts.failed++;
    if (failed.length < limits.maxFailedReported) failed.push({ externalId: externalId == null ? null : String(externalId).slice(0, 200), reason: scrub(reason).slice(0, 300) });
  };
  // A failed or aborted run keeps its positions but RESETS any pending mass
  // deletion: the confirmation sequence must be two complete listings with
  // nothing failed in between (Phase 1b.2).
  const keep = { checkpoint: conn.checkpoint ?? null, fullSync: conn.fullSync ?? null, pendingDeletion: null };

  if (mode === 'incremental' && !supportsIncremental) {
    return finish({ state: 'failed', error: 'connector does not support incremental sync' }, keep);
  }

  // D-1 — observe the source BEFORE discovery, the run's first contact with the
  // connector: per-source lock + database clock (externalSources.observeSource).
  // Every batch below carries this `observedAt` to the understanding enqueue, so
  // a deletion that commits at any later point — even while this run is still
  // fetching — keeps what this run fetched from being enqueued. null (no
  // database / observation failed) makes the enqueue conservative; the sync
  // itself is never failed by it.
  let observedAt = null;
  if (typeof external.observeSource === 'function') {
    try { observedAt = await external.observeSource(ownerId, conn.sourceId); } catch { observedAt = null; }
  }

  const heldIds = () => new Set(external.listExternalResources(ownerId, conn.sourceId).map(r => r.externalId));
  const held = new Map(external.listExternalResources(ownerId, conn.sourceId).map(r => [r.externalId, r]));

  let changed = [];
  let feedRemoved = [];
  let nextCheckpoint = conn.checkpoint ?? null;
  let listingComplete = false;
  let cursor = pass?.cursor ?? null;
  // Gmail Phase 1 — a connector may return, with its LAST listing page, the
  // source position the listing started from (a change-feed start point). A
  // clean complete full pass then stores it as the checkpoint, so the next run
  // can be incremental. Connectors that return none behave as before.
  let listedCheckpoint = null;

  // 2026-11-23 — a full pass is listed only as far as this run can PROCESS: once the
  // resources needing work reach limits.maxChanges, listing stops at that page
  // boundary and the saved cursor points at the next page. Nothing listed in a
  // run is ever left unprocessed (previously, refs beyond maxChanges were dropped
  // while the cursor moved past them — silently skipped for the rest of the pass).
  const needsWork = ref => {
    const have = held.get(ref.externalId);
    return !(have && ref.version && have.version === ref.version);
  };
  const listFull = async () => {
    const pending = new Set();
    for (let page = 0; page < limits.maxPages; page++) {
      const r = await withRetry(() => connector.listResources(ctx, { cursor }), retryOpts);
      const ids = [];
      for (const ref of r?.resources ?? []) { const s = sanitizeRef(ref); if (s) { changed.push(s); ids.push(s.externalId); if (needsWork(s)) pending.add(s.externalId); } }
      cursor = r?.cursor === '' ? null : (r?.cursor ?? null);   // '' ends the listing, as before
      pages.push({ ids, cursorAfter: cursor });
      if (cursor != null && (typeof cursor !== 'string' || cursor.length > limits.maxCursorChars)) {
        throw new Error('the source returned an invalid listing cursor');   // nothing has been written yet
      }
      if (!cursor) { listingComplete = true; listedCheckpoint = boundedCheckpoint(r?.checkpoint, limits); break; }
      if (pending.size >= limits.maxChanges) break;   // this run's budget is listed; the rest of the pass is next run's
    }
    counts.listed = changed.length;
  };

  try {
    if (incremental) {
      try {
        const r = await withRetry(() => connector.syncChanges(ctx, { checkpoint: conn.checkpoint }), retryOpts);
        changed = (r?.changed ?? []).map(sanitizeRef).filter(Boolean);
        feedRemoved = (r?.removed ?? []).filter(id => typeof id === 'string' && id.length <= 512);
        nextCheckpoint = r?.checkpoint ?? conn.checkpoint;
      } catch (err) {
        // The saved change position no longer exists at the source (e.g. Gmail
        // history expired). Never retry it: auto mode lists the WHOLE source
        // now (deletions are judged only by that complete listing, under the
        // mass-deletion guard); an explicit incremental run fails and clears
        // the position so the next auto run is full.
        if (!isCursorExpired(err)) throw err;
        if (mode === 'incremental') {
          return finish({ state: 'failed', error: 'the saved change position expired at the source; the next run performs a full listing' }, { ...keep, checkpoint: null });
        }
        notes.push('the saved change position expired at the source; this run listed the whole source instead');
        incremental = false;
        changed = [];
        keep.checkpoint = null;   // whatever happens next, the expired position is not kept
        await listFull();
      }
    } else {
      await listFull();
    }
  } catch (err) {
    if (err?.stopped) return aborted();
    if (isAuthError(err)) return finish({ state: 'failed', error: `authorisation refused by the source (${scrub(err?.message ?? err)}); reconnect required` }, keep, true);
    if (isRefused(err)) return finish({ state: 'failed', error: `${scrub(err?.message ?? err)}` }, keep);
    if (isRateLimited(err)) return finish({ state: 'failed', error: `the source kept rate-limiting the listing (${scrub(err?.message ?? err)}); nothing was lost — try again later` }, keep);
    // Gmail Phase 2 — a RESUMED listing whose saved page position the source
    // itself declares dead (ConnectorError CURSOR_EXPIRED from listResources)
    // would fail the same way on every run: the position is discarded and the
    // next run lists from the start. Nothing is deleted on this path. Any other
    // failure — transient or permanent — keeps the position (Phase 1b.1: a run
    // that fails mid-pass neither restarts nor skips).
    if (pass && isCursorExpired(err)) {
      // more: the next run can proceed at once (from the start); nothing was written by this one.
      return finish({ state: 'failed', more: true, error: `discovery failed: ${scrub(err?.message ?? err)}; the saved listing position was discarded — the next run lists the source from the start` }, { ...keep, fullSync: null });
    }
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
    if (!needsWork(ref)) counts.skippedSameVersion++;
    else work.push(ref);
  }
  // A full pass was listed within budget (listFull): all of it is processed (at most one
  // page over maxChanges). Only a change feed can deliver more than a run may process;
  // then the checkpoint is not advanced and the next run replays the rest.
  const truncated = incremental && work.length > limits.maxChanges;
  const queue = truncated ? work.slice(0, limits.maxChanges) : work;
  if (truncated) notes.push(`${work.length - limits.maxChanges} changed resource(s) beyond the per-run limit of ${limits.maxChanges}; they are covered by the next run`);

  // 2026-11-23 — FETCH AND IMPORT IN BATCHES. Each batch (≤ resourcesPerSync, ~100) is
  // fetched, imported, made durable (flushImports) and — for a full pass — the durable
  // listing position is moved past every page whose resources are all done, BEFORE the
  // next batch is fetched. A later failure (auth, refusal, rate limit, crash) therefore
  // never loses an earlier batch, and a resumed run does not repeat it. Imports are
  // idempotent (identical content → "unchanged"), so a repeated batch is harmless.
  const goneAtFetch = [];
  const batch = external.EXTERNAL_LIMITS.resourcesPerSync;
  const workIds = new Set(queue.map(r => r.externalId));
  const processed = new Set();
  let progress = conn.fullSync ?? null;        // the last durably persisted pass position
  let donePages = 0;                           // pages[0..donePages) are fully processed
  let paceMs = Math.max(0, Number(limits.fetchPaceMs) || 0);
  let lastFetchAt = 0;
  const sleep = retry.sleep ?? realSleep;
  /** Positions for a run that stops early: whatever was durably reached, never more. */
  function positions() { return { checkpoint: conn.checkpoint ?? null, fullSync: progress, pendingDeletion: null }; }
  const stopFetch = (err) => {
    if (err?.stopped) return aborted();
    if (isAuthError(err)) return finish({ state: 'failed', error: `authorisation refused by the source (${scrub(err?.message ?? err)}); reconnect required` }, positions(), true);
    if (isRefused(err)) return finish({ state: 'failed', error: `${scrub(err?.message ?? err)}; progress so far was kept` }, positions());
    if (isRateLimited(err)) return finish({ state: 'failed', error: `the source kept rate-limiting this run (${scrub(err?.message ?? err)}); progress so far was kept — try again later` }, positions());
    return null;
  };

  for (let i = 0; i < queue.length; i += batch) {
    const chunk = queue.slice(i, i + batch);
    const resources = [];
    for (const ref of chunk) {
      // A pause / revoke / disconnect is waiting: stop before the next request (cheap, in-memory).
      if (shouldStop?.()) return aborted();
      const have = held.get(ref.externalId);
      // Pacing: a minimum gap between fetches, widened after a rate-limit response.
      const gap = lastFetchAt ? paceMs - (clock() - lastFetchAt) : 0;
      if (gap > 0) await sleep(gap);
      lastFetchAt = clock();
      let raw;
      try {
        raw = await withRetry(() => connector.fetchResource(ctx, ref), {
          ...retryOpts,
          onRetry: e => { noteRetry(e); if (isRateLimited(e)) paceMs = Math.min(limits.maxPaceMs ?? SYNC_LIMITS.maxPaceMs, Math.max(paceMs * 2, 250)); },
        });
      } catch (err) {
        const stop = stopFetch(err);
        if (stop) return stop;
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

    // Import this batch, re-checking the connection first.
    if (resources.length) {
      if (guard && !(await guard())) return aborted();
      let r = null;
      try {
        r = await external.syncExternalResources({ ownerId, sourceId: conn.sourceId, resources, observedAt });
      } catch (err) {
        for (const x of resources) fail(x.externalId, `import failed: ${err?.message ?? err}`);
      }
      for (const x of r?.results ?? []) {
        if (x.status in counts) counts[x.status]++;
        if (x.status === 'failed') { counts.failed--; fail(x.externalId, x.reason ?? 'import failed'); }
        if (x.status === 'rejected' && failed.length < limits.maxFailedReported) failed.push({ externalId: x.externalId, reason: `rejected: ${x.reason}` });
      }
      // Durable BEFORE anything moves on (and before the next batch is fetched).
      if (typeof external.flushImports === 'function') {
        try { await external.flushImports(); }
        catch (err) {
          return finish({ state: 'failed', error: `imported resources could not be made durable (${scrub(err?.message ?? err)}); positions not advanced` }, positions());
        }
      }
    }
    for (const ref of chunk) processed.add(ref.externalId);

    // Full pass: move the durable position past every page now fully processed.
    if (!incremental && typeof persistProgress === 'function') {
      while (donePages < pages.length && pages[donePages].ids.every(id => !workIds.has(id) || processed.has(id))) donePages++;
      const last = pages[donePages - 1];
      if (donePages > 0 && last.cursorAfter && last.cursorAfter !== progress?.cursor) {
        const now = heldIds();
        const seenIds = pages.slice(0, donePages).flatMap(p => p.ids).filter(id => now.has(id));
        const next = {
          cursor: last.cursorAfter, startedAt: pass?.startedAt ?? new Date(started).toISOString(), runs: pass?.runs ?? 0,
          seenHeld: [...new Set([...(pass?.seenHeld ?? []), ...seenIds])], ...(passDirty() ? { dirty: true } : {}),
        };
        try { await persistProgress(next); }
        catch (err) {
          if (err?.stopped) return aborted();
          return finish({ state: 'failed', error: `the sync position could not be saved (${scrub(err?.message ?? err)}); imported resources are kept and the next run resumes from the last saved position` }, positions());
        }
        progress = next;
      }
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
      // `dirty`: some run of this pass failed or rejected a resource. The cursor still moves
      // on (a permanently failing message must not stall the pass), but the pass then cannot
      // complete the sync: its last run is not clean, so no checkpoint is taken from it and
      // the next run lists the source again (resources already held are re-checked, the
      // failed ones retried).
      nextFullSync = { cursor, startedAt: pass?.startedAt ?? new Date(started).toISOString(), runs: (pass?.runs ?? 0) + 1, seenHeld: [...seen], ...(passDirty() ? { dirty: true } : {}) };
      // (passDirty is read here, BEFORE removals below add their own failures — those are
      // judged again by the next complete listing anyway.)
      notes.push(`listing incomplete after ${limits.maxPages} page(s); the next run continues from the saved position, and deletions wait until the whole source has been listed`);
      proposed = goneAtFetch.length ? goneAtFetch : null;   // a resource confirmed gone by fetch is still a valid single deletion
    } else {
      nextFullSync = null;
      proposed = [...[...now].filter(id => !seen.has(id)), ...goneAtFetch];
    }
  }

  // Mass-deletion guard (Phase 1b.2).
  // Only a COMPLETE FULL listing may start or confirm a sequence; a change
  // feed can only withhold (and request a full listing); an incomplete
  // listing resets; a different set restarts; confirmation needs the same set
  // at least confirmAfterMs after the first sighting.
  const fullComplete = !incremental && listingComplete;
  const prev = conn.pendingDeletion ?? null;
  // Only a sighting recorded by a complete full listing (exact ids + time) can be confirmed.
  const prevSighting = prev && prev.origin === 'full' && Array.isArray(prev.ids) && prev.firstSeenAt ? prev : null;
  let nextPending = (!incremental && !listingComplete) ? null : prev;   // incomplete listing → reset
  let toRemove = [];
  let massDecision = false;   // a mass deletion confirmed by the user or by a repeated complete listing
  if (proposed) {
    const now = heldIds();
    const removals = [...new Set(proposed)].filter(id => now.has(id)).sort();
    if (removals.length) {
      const key = removalKey(removals);
      const isMass = removals.length >= MASS_DELETION.minCount && removals.length / Math.max(1, now.size) > MASS_DELETION.maxFraction;
      const sameSet = fullComplete && prevSighting?.key === key;
      const firstSeenMs = sameSet ? Date.parse(prevSighting.firstSeenAt) : started;
      const confirmedByRepeat = sameSet && Number.isFinite(firstSeenMs) && started - firstSeenMs >= MASS_DELETION.confirmAfterMs;
      if (isMass && confirmMassDeletion !== true && !confirmedByRepeat) {
        counts.withheldRemovals = removals.length;
        if (fullComplete) {
          // First sighting, a repeat that is too early (keeps the original time), or a new set (restarts).
          nextPending = { key, ids: removals, origin: 'full', count: removals.length, held: now.size, firstSeenAt: new Date(firstSeenMs).toISOString() };
          const at = new Date(firstSeenMs + MASS_DELETION.confirmAfterMs).toISOString();
          notes.push(`mass deletion withheld: the source no longer lists ${removals.length} of ${now.size} resource(s); applied only if a complete listing at or after ${at} proposes exactly the same set, or on explicit confirmation`);
        } else {
          // A change feed (or a partial pass's fetch results) cannot start or confirm a sequence.
          nextPending = { key: null, ids: null, origin: 'feed', count: removals.length, held: now.size, firstSeenAt: null };
          notes.push(`mass deletion withheld: ${removals.length} of ${now.size} resource(s) reported removed; a complete full listing must confirm it, or explicit confirmation`);
        }
      } else {
        toRemove = removals;
        massDecision = isMass;
        if (isMass || fullComplete) nextPending = null;   // applied (or a complete listing judged): the sequence ends
      }
    } else if (fullComplete) {
      nextPending = null;   // a complete listing proposes nothing: any pending mass deletion resolved itself
    }
  }

  // Gmail Phase 2 — REMOVAL CONFIRMATION. A small removal (absent from a
  // complete listing, or reported by the change feed) is confirmed with the
  // source, id by id, before anything is deleted: a listing that skipped a
  // message is never taken as evidence that it was deleted. 'gone' = deleted
  // at the source or now out of scope; 'present' = still there (kept); any
  // other answer or failure = unknown (kept, and the run is not clean, so the
  // next run judges again). A resource a fetch already found gone (404) needs
  // no second check. A mass deletion confirmed by the user or by two complete
  // listings is not re-checked one by one. At most limits.maxRemovalChecks per run.
  let uncertainRemovals = false;
  if (toRemove.length && !massDecision && typeof connector.confirmRemoval === 'function') {
    const gone = new Set(goneAtFetch);
    const confirmed = [];
    let checks = 0, present = 0, unknown = 0;
    for (const id of toRemove) {
      if (gone.has(id)) { confirmed.push(id); continue; }
      if (checks >= (limits.maxRemovalChecks ?? SYNC_LIMITS.maxRemovalChecks)) { unknown++; continue; }
      checks++;
      let verdict = 'unknown';
      try { verdict = await withRetry(() => connector.confirmRemoval(ctx, id), retryOpts); }
      catch (err) {
        if (err?.stopped) return aborted();
        if (isAuthError(err)) return finish({ state: 'failed', error: `authorisation refused by the source (${scrub(err?.message ?? err)}); reconnect required` }, positions(), true);
        if (isRefused(err) || isRateLimited(err)) return finish({ state: 'failed', error: `${scrub(err?.message ?? err)}; removals were not judged — the next run checks again` }, positions());
        verdict = 'unknown';
      }
      if (verdict === 'gone') confirmed.push(id);
      else if (verdict === 'present') present++;
      else unknown++;
    }
    toRemove = confirmed;
    counts.keptStillPresent = present;
    counts.removalUnconfirmed = unknown;
    if (present) notes.push(`${present} resource(s) the listing did not return are still present at the source; kept`);
    if (unknown) { uncertainRemovals = true; notes.push(`${unknown} proposed removal(s) could not be confirmed with the source; kept until a later run confirms them`); }
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
  const expiredFallback = notes.some(n => n.startsWith('the saved change position expired'));
  const dirtyPass = !incremental && listingComplete && pass?.dirty === true;
  if (dirtyPass) notes.push('an earlier run of this full pass could not import every resource; the next run lists the source again');
  const clean = counts.failed === 0 && !truncated && !withheld && !uncertainRemovals && !dirtyPass && (incremental || listingComplete);
  const checkpoint = clean
    ? (incremental ? nextCheckpoint : (listedCheckpoint ?? { fullSyncAt: new Date(started).toISOString() }))
    // An expired position is never kept: the next run must list the source.
    : (expiredFallback ? null : (conn.checkpoint ?? null));

  // 2026-11-23 — positions are persisted by the caller right after this returns. Make
  // what this run imported and removed durable FIRST: a crash between the two must
  // never leave a cursor or checkpoint ahead of the stored messages. If that cannot
  // be done, nothing advances (the next run repeats this one; imports are idempotent).
  if (typeof external.flushImports === 'function') {
    try { await external.flushImports(); }
    catch (err) {
      return finish({ state: 'failed', error: `imported resources could not be made durable (${scrub(err?.message ?? err)}); positions not advanced` },
        { checkpoint: conn.checkpoint ?? null, fullSync: conn.fullSync ?? null, pendingDeletion: null });
    }
  }
  return finish({
    state: clean ? 'succeeded' : 'partial',
    complete: clean,
    // More of THIS pass / feed remains: a resumable full listing, or changes beyond this run's budget.
    more: truncated || (!incremental && !listingComplete),
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
        finishedAt: new Date(clock()).toISOString(),
        durationMs: clock() - started,
        complete: false,
        counts, failed,
        ...(retries.total ? { retries } : {}),
        ...extra,
        ...(extra.error ? { error: scrub(extra.error).slice(0, 300) } : {}),
      },
    };
  }
}
