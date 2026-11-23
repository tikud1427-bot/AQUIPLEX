/**
 * AQUA Connect — connection lifecycle service (Phase 1b)
 *
 * The engine API a future HTTP route (or job) calls. Every method takes an
 * authenticated PRINCIPAL (principal.js: principalFromRequest(req), built from
 * the server-side req.aquaUserId/session — never from client data) and acts only
 * on that user's connections: the owner is derived here
 * (memory/ownerResolver.js), never accepted from a caller, and every store read
 * is (ownerId, connectionId). A raw userId is accepted only when the service is
 * built with trustRawUserId (server-internal callers, tests).
 *
 *   connect({ principal, connectorId, input })      → connection view (no secrets)
 *   listConnections({ principal })               → views
 *   getConnection({ principal, connectionId })      → view
 *   sync({ principal, connectionId, mode, confirmMassDeletion })
 *                                                → { status, lastSync, aborted? }
 *   revokeCredentials({ principal, connectionId })  → revoke at source + wipe credentials; knowledge kept
 *   disconnect({ principal, connectionId })         → revoke + wipe + delete the source's knowledge + delete the record
 *
 *   Revoke/disconnect results report the two effects
 *   separately and never claim a revocation that failed or was not attempted:
 *     localCredentialsDeleted  true once the stored ciphertext is wiped
 *     providerRevocation       'revoked' | 'failed' | 'not_attempted'
 *     providerRevocationReason why it was not 'revoked' (fixed text, no provider output)
 *     revokedAtSource          kept for compatibility: providerRevocation === 'revoked'
 *   unregisterConnector(connectorId)             → only when no connection uses it
 *   connectorHealth(connectorId)                 → registry probe
 *
 * Authentication and execution are separate: connect()/refresh() are the only
 * calls that see raw credentials as input/output, and they go straight into the
 * vault; resource operations get a ctx whose credentials() opens the vault for
 * that one connection. Views returned to callers never include credentials.
 *
 * Concurrency: one lock per owner, shared by EVERY service
 * instance in this Node.js process, serialises sync, revoke and disconnect for
 * that user; sync also re-checks before every import batch and every removal
 * that the connection still exists, belongs to the owner and is 'active'.
 * Across processes: right after the in-process lock, every operation holds the
 * owner's connect LEASE (connect/ownerLease.js) and a WRITE FENCE
 * (core/storage/writeFence.js): a second instance waits (or gets BUSY), and a
 * holder whose lease expired or was taken over can no longer write.
 *
 * Unreadable credentials: if the stored credentials cannot be
 * opened (key missing, key changed, envelope corrupt or tampered) the connection
 * moves to 'needs_reauth' with a fixed "reconnect required" error.
 *
 * Key rotation (Phase 2A, credentialVault.js): the new key goes in
 * AQUA_CONNECTOR_KEY and the old one in AQUA_CONNECTOR_PREVIOUS_KEYS. Credentials
 * sealed by the old key still open, are re-encrypted under the new key on their
 * next use (credentialsFor) and by rotateCredentials(). LOSING a key (removing it
 * before every record was resealed) still makes those credentials unreadable:
 * the connection moves to needs_reauth and the user reconnects.
 */
import crypto from 'node:crypto';
import { ownerForUser } from '../memory/ownerResolver.js';
import * as externalDefault from '../files/externalSources.js';
import { runSync, MASS_DELETION, SyncStopped } from './syncEngine.js';
import { UNREADABLE_CREDENTIAL_CODES } from './credentialVault.js';
import { isPrincipal } from './principal.js';
import { secretValues, scrubSecrets, isAuthError } from './contract.js';
import { ownerLogId } from '../core/logSafety.js';
import { sanitizeInlineLabel } from '../core/untrustedContent.js';
import { withConnectLease, LeaseError, serializeConnectionWrite, currentOwnerEpoch } from './ownerLease.js';
import { currentFence } from '../core/storage/writeFence.js';
import { registerConnectionStoreForPurge, registerGrantRevokerForPurge } from './connectionStore.js';
import { isConfigured } from '../core/db/pool.js';

export class ConnectError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const REFRESH_SKEW_MS = 2 * 60 * 1000;
// Safety Fix 4: provider calls inside a connect operation are BOUNDED (well below
// the lease TTL) — an operation never holds its authority across an unbounded call.
const PROVIDER_CALL_TIMEOUT_MS = 15_000;
const bounded = (p, code, ms = PROVIDER_CALL_TIMEOUT_MS) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('provider call timed out'), { code })), ms); t.unref?.(); })])
    .finally(() => clearTimeout(t));
};

// ── ONE lock map per Node.js process ─────────────────────────────────────────
// Module scope: every createConnectService() instance in this process (a route
// that builds one per request, a job and a route) shares it, so a disconnect
// cannot interleave with a running sync. It does NOT coordinate separate
// processes or servers: run connect operations from a single process until a
// shared cross-process lease exists.
const processLocks = new Map();
function withOwnerLock(ownerId, fn) {
  const prev = processLocks.get(ownerId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  processLocks.set(ownerId, tail);
  tail.then(() => { if (processLocks.get(ownerId) === tail) processLocks.delete(ownerId); });
  return run;
}
/** Test-only: whether this process currently holds or queues work for an owner. */
export const _ownerLockHeldForTests = ownerId => processLocks.has(ownerId);

const UNREADABLE = new Set(UNREADABLE_CREDENTIAL_CODES);
/** Gmail Phase 2: statuses a reconnect of the same account may refresh (never one being deleted). */
const REUSABLE_ON_RECONNECT = new Set(['active', 'needs_reauth', 'revoked']);
/** Gmail Phase 2: statuses whose sync may be paused/resumed by the user. */
const PAUSABLE = new Set(['active', 'needs_reauth', 'revoked']);

/**
 * @param {object} deps
 * @param {object} deps.registry   createConnectorRegistry() instance
 * @param {object} deps.store      connection store (connectionStore.js)
 * @param {object} deps.vault      createCredentialVault() instance
 * @param {object} [deps.external] Phase 1a.2 API (files/externalSources.js)
 * @param {object} [deps.syncLimits] engine limits (tests); default syncEngine.SYNC_LIMITS
 * @param {object} [deps.retry]    sync retry options (tests pass sleep: () => {})
 * @param {Function} [deps.now]
 * @param {boolean} [deps.singleInstance]  Safety Fix 4: allow a store that is NOT shared across
 *        processes (the memory adapter) while a database (and so multi-instance operation) is
 *        configured — tests and single-process tools only; refused otherwise.
 */
export function createConnectService({ registry, store, vault, external = externalDefault, retry = {}, now = Date.now, log = console, trustRawUserId = false, lease = {}, singleInstance = false, providerTimeoutMs = PROVIDER_CALL_TIMEOUT_MS, syncLimits = undefined } = {}) {
  if (!registry || !store || !vault) throw new ConnectError('MISCONFIGURED', 'connect service needs a registry, a store and a credential vault');
  registerConnectionStoreForPurge(store);   // an account purge clears every connection store in use

  // Safety Fix 4 — CONNECTION-STORE FENCING. With a database configured every
  // connect operation holds a lease with a monotonic EPOCH (connect/ownerLease.js).
  //   · its first act: stamp the owner's connection records with (epoch, token);
  //   · every write: `cw` — the store's conditional write (connectionStore.js
  //     FENCING) inside serializeConnectionWrite (ordered against acquisitions);
  //   · every read inside an operation accepts only records carrying ITS epoch,
  //     views only records carrying the owner's CURRENT epoch — a late insert
  //     of an older operation is invalid (and removed by the next operation).
  // A store that is not shared across processes cannot provide this: refused
  // for multi-instance operation unless `singleInstance` says so explicitly.
  const leaseMode = () => Boolean(lease.pool) || isConfigured();
  const cw = (ownerId, fn) => {
    const fence = currentFence();
    if (!fence) {
      if (leaseMode()) return Promise.reject(new ConnectError('CONNECTION_FENCE_MISSING', 'connection writes need a connect operation'));
      return fn(null);                                   // local mode: one process, no lease
    }
    return serializeConnectionWrite(fence, ownerId, fn, { pool: lease.pool ?? null });
  };
  /** Inside an operation (after its stamp) a record must carry ITS epoch (null epoch: local mode, all valid). */
  const validFor = (conn, epoch) => epoch == null || (typeof conn?.fenceEpoch === 'number' && conn.fenceEpoch === epoch);
  // Views outside an operation: a record of a live owner carrying an epoch not above the owner's current one.
  // (The owner-document store refuses stale inserts outright, so a lower epoch only means "not stamped yet".)
  const visibleAt = (conn, epoch) => epoch == null || (typeof conn?.fenceEpoch === 'number' && conn.fenceEpoch <= epoch);

  // Per-owner serialisation: the process-wide withOwnerLock above, then the
  // cross-process connect lease + write fence (ownerLease.withConnectLease).
  // `lease`: { pool, ttlMs, renewEveryMs, waitMs } — tests only.
  const withOwner = (ownerId, fn) => withOwnerLock(ownerId, () => {
    if (leaseMode() && store.crossInstance === false && !singleInstance) {
      return Promise.reject(new ConnectError('STORE_NOT_DISTRIBUTED', 'this connection store is not shared across instances; it cannot be used while a database (multi-instance operation) is configured'));
    }
    return withConnectLease(ownerId, async ctx => {
      if (ctx?.mode === 'lease') await cw(ownerId, f => store.stamp(ownerId, f));   // FIRST: every record now carries this epoch
      return fn(ctx);
    }, lease).catch(err => {
      if (err instanceof LeaseError) throw new ConnectError(err.code, err.message);
      if (err?.code === 'WRITE_FENCE_LOST') throw new ConnectError('LEASE_LOST', err.message);
      if (err?.code === 'OWNER_DELETED') throw new ConnectError('OWNER_DELETED', err.message);
      throw err;
    });
  });

  /**
   * IS-1 (G0): the owner comes ONLY from an authenticated principal
   * (principal.js — principalFromRequest(req) / principalForServerJob). Any
   * userId / ownerId in the call is IGNORED when a principal is given, so a
   * route that spreads client data into the call cannot impersonate anyone.
   * A raw userId is accepted only by a service built with trustRawUserId
   * (server-internal callers and tests) — never the default.
   */
  const ownerOf = ({ principal, userId } = {}) => {
    let id;
    if (principal !== undefined) {
      if (!isPrincipal(principal)) throw new ConnectError('UNAUTHENTICATED', 'an authenticated user is required');
      id = principal.userId;
    } else if (trustRawUserId) {
      id = typeof userId === 'string' || typeof userId === 'number' ? String(userId).trim() : '';
    } else {
      throw new ConnectError('UNAUTHENTICATED', 'an authenticated user is required');
    }
    const ownerId = ownerForUser(id);
    if (!id || !ownerId || ownerId === 'user:') throw new ConnectError('UNAUTHENTICATED', 'an authenticated user is required');
    return ownerId;
  };

  const binding = conn => ({ ownerId: conn.ownerId, connectionId: conn.connectionId, connectorId: conn.connectorId });

  /** Credential-free view. */
  const view = conn => conn && ({
    connectionId: conn.connectionId, connectorId: conn.connectorId, connectorVersion: conn.connectorVersion,
    status: conn.status, account: { label: conn.account?.label ?? null },
    scopes: [...(conn.scopes ?? [])], credentialsExpireAt: conn.credentialsExpireAt ?? null,
    hasCredentials: Boolean(conn.credentials), lastSync: conn.lastSync ?? null, syncCount: conn.syncCount ?? 0,
    syncPaused: conn.syncPaused === true,
    // Phase 1b.1: listing progress and a withheld mass deletion awaiting confirmation (no ids exposed).
    fullSyncInProgress: Boolean(conn.fullSync?.cursor),
    // 2026-11-23: a complete pass has given this connection a change position (an initial sync is complete).
    initialSyncComplete: conn.checkpoint != null,
    pendingDeletion: conn.pendingDeletion
      ? {
          count: conn.pendingDeletion.count, held: conn.pendingDeletion.held, origin: conn.pendingDeletion.origin, firstSeenAt: conn.pendingDeletion.firstSeenAt,
          // Phase 1b.2: earliest time a complete listing may confirm it (null until a full listing has recorded it). Ids are never exposed.
          confirmableAt: conn.pendingDeletion.firstSeenAt ? new Date(Date.parse(conn.pendingDeletion.firstSeenAt) + MASS_DELETION.confirmAfterMs).toISOString() : null,
        }
      : null,
    createdAt: conn.createdAt, updatedAt: conn.updatedAt,
  });

  async function load(ownerId, connectionId) {
    if (typeof connectionId !== 'string' || !/^conn_[0-9a-f]{20}$/.test(connectionId)) throw new ConnectError('NOT_FOUND', 'connection not found');
    const conn = await store.get(ownerId, connectionId);
    if (!conn) throw new ConnectError('NOT_FOUND', 'connection not found');   // same answer for "not yours" and "does not exist"
    const fence = currentFence();
    if (fence && fence.owner === ownerId) {
      // Inside an operation (after its stamp): only records carrying ITS epoch are valid.
      if (!validFor(conn, fence.epoch)) {
        // A late insert of an OLDER operation (its epoch is below this one): remove it, fenced.
        if (typeof conn.fenceEpoch === 'number' && conn.fenceEpoch < fence.epoch) await cw(ownerId, f => store.remove(ownerId, connectionId, { fence: f }));
        throw new ConnectError('NOT_FOUND', 'connection not found');
      }
    } else if (leaseMode()) {
      const current = await currentOwnerEpoch(ownerId, { pool: lease.pool ?? null });
      if (current == null || !visibleAt(conn, current)) throw new ConnectError('NOT_FOUND', 'connection not found');
    }
    return conn;
  }

  // ── connect ────────────────────────────────────────────────────────────────
  function connect(args = {}) {
    let ownerId;
    try { ownerId = ownerOf({ principal: args.principal, userId: args.userId }); } catch (err) { return Promise.reject(err); }
    return withOwner(ownerId, () => connectLocked(ownerId, args));
  }
  async function connectLocked(ownerId, { connectorId, input = {} } = {}) {
    if (!registry.has(connectorId)) throw new ConnectError('UNKNOWN_CONNECTOR', 'that connector is not available');
    // Refuse BEFORE the provider issues tokens we could not store.
    if (vault.unavailable) throw new ConnectError('CREDENTIAL_KEY_UNAVAILABLE', 'connecting is unavailable: the credential key is not configured');
    const connector = registry.get(connectorId);
    const connectionId = `conn_${crypto.randomBytes(10).toString('hex')}`;
    let result;
    const pending = Promise.resolve().then(() => connector.connect(input));
    try {
      result = await bounded(pending, 'CONNECT_TIMEOUT', providerTimeoutMs);   // credential exchange: bounded
    } catch (err) {
      registry.recordOutcome(connectorId, false, 'connect failed');
      // F2: the exchange may still complete after the timeout. Its credentials
      // will never be stored, so revoke them when (if) they arrive.
      if (err?.code === 'CONNECT_TIMEOUT') pending.then(late => revokeIssued(connector, late, { ownerId, connectorId, connectionId, stage: 'late after timeout' }), () => {});
      throw new ConnectError(isAuthError(err) ? 'AUTH_FAILED' : 'CONNECT_FAILED', 'the source refused the connection');   // never echo provider text: it may carry secrets
    }
    if (!result?.credentials || typeof result.credentials !== 'object') throw new ConnectError('CONNECT_FAILED', 'connector returned no credentials');
    const accountHash = result.account?.externalAccountId
      ? crypto.createHash('sha256').update(String(result.account.externalAccountId)).digest('hex').slice(0, 24) : null;

    // Gmail Phase 2 — RECONNECT WITHOUT DUPLICATES. The same external account
    // connected again (e.g. after needs_reauth or a revocation) refreshes the
    // EXISTING connection: same connectionId and sourceId, so its imported
    // knowledge, checkpoint and history stay. A connection that is being
    // deleted (disconnecting / disconnect_incomplete) is never revived — a new
    // one is created instead. The previous credentials are NOT revoked at the
    // provider: for Google, revoking any token of a grant revokes the whole
    // grant, including the one just issued; they are simply overwritten.
    const epoch = currentFence()?.epoch ?? null;
    const existing = accountHash
      ? (await store.listByOwner(ownerId)).find(c => validFor(c, epoch) && c.connectorId === connectorId
          && c.account?.externalAccountHash === accountHash && REUSABLE_ON_RECONNECT.has(c.status)) ?? null
      : null;
    if (existing) {
      let sealed = null;
      try {
        sealed = vault.seal(result.credentials, binding(existing));
        const updated = await cw(ownerId, f => store.update(ownerId, existing.connectionId, {
          credentials: sealed, credentialsExpireAt: result.expiresAt ?? null, status: 'active',
          connectorVersion: connector.version,
          scopes: (result.scopes ?? connector.auth.scopes ?? []).map(String),
          account: { label: sanitizeInlineLabel(result.account?.label ?? '', { max: 80 }) || null, externalAccountHash: accountHash },
        }, { fence: f }));
        if (!updated) throw new ConnectError('CONNECT_FAILED', 'the connection disappeared during reconnect');
      } catch (err) {
        // F2 on the reconnect path: keep the new grant only if the store holds exactly the envelope just sealed.
        let persisted = false;
        try { const cur = await store.get(ownerId, existing.connectionId); persisted = Boolean(sealed && cur?.credentials?.iv === sealed.iv); } catch { persisted = false; }
        if (!persisted) {
          registry.recordOutcome(connectorId, false, 'reconnect failed after the exchange');
          await revokeIssued(connector, result, { ownerId, connectorId, connectionId: existing.connectionId, stage: 'reconnect not stored' });
        }
        throw err;
      }
      registry.recordOutcome(connectorId, true);
      log.log?.(`[CONNECT] reconnected connector=${connectorId} owner=${ownerLogId(ownerId)} connection=${existing.connectionId}`);
      return view(await store.get(ownerId, existing.connectionId));
    }

    // F2: from here on the source has issued a grant. Unless the record is
    // PERSISTED, the grant is revoked (bounded, best effort) and the ORIGINAL
    // error is thrown — a seal failure, a store failure, or a lease/fence
    // rejection (the cw write below) never leaves a live, unstored grant.
    try {
      const doc = {
        connectionId, ownerId, connectorId, connectorVersion: connector.version,
        sourceId: `${connectorId}:${connectionId}`,
        status: 'active',
        account: {
          label: sanitizeInlineLabel(result.account?.label ?? '', { max: 80 }) || null,
          externalAccountHash: accountHash,
        },
        scopes: (result.scopes ?? connector.auth.scopes ?? []).map(String),
        credentials: null, credentialsExpireAt: result.expiresAt ?? null,
        checkpoint: null, lastSync: null, syncCount: 0,
      };
      doc.credentials = vault.seal(result.credentials, binding(doc));
      await cw(ownerId, f => store.create(doc, { fence: f }));
    } catch (err) {
      // An acknowledged write whose reply was lost is still a stored connection: keep its grant.
      let persisted = false;
      try { persisted = Boolean(await store.get(ownerId, connectionId)); } catch { persisted = false; }
      if (!persisted) {
        registry.recordOutcome(connectorId, false, 'connect failed after the exchange');
        await revokeIssued(connector, result, { ownerId, connectorId, connectionId, stage: 'not stored' });
      }
      throw err;
    }
    registry.recordOutcome(connectorId, true);
    log.log?.(`[CONNECT] connected connector=${connectorId} owner=${ownerLogId(ownerId)} connection=${connectionId}`);
    return view(await store.get(ownerId, connectionId));
  }

  /**
   * F2 — revoke credentials a connector issued that will NOT be stored, through
   * the connector's own revocation call. Bounded, never throws (the caller's
   * original error is what the user sees), never logs a credential.
   * @returns {Promise<'revoked'|'failed'|'not_attempted'>}
   */
  async function revokeIssued(connector, result, { ownerId, connectorId, connectionId, stage }) {
    const creds = result?.credentials;
    let outcome = 'not_attempted';
    if (creds && typeof creds === 'object' && typeof connector?.disconnect === 'function') {
      try {
        const ctx = Object.freeze({ connectionId, credentials: () => structuredClone(creds) });
        await bounded(Promise.resolve().then(() => connector.disconnect(ctx)), 'REVOKE_TIMEOUT', providerTimeoutMs);
        outcome = 'revoked';
      } catch { outcome = 'failed'; }
    }
    log.warn?.(`[CONNECT] connect failed after the source issued credentials (${stage}); grant revocation=${outcome} connector=${connectorId} owner=${ownerLogId(ownerId)}`);
    return outcome;
  }

  async function listConnections({ userId, principal } = {}) {
    const ownerId = ownerOf({ principal, userId });
    const rows = await store.listByOwner(ownerId);
    // Views outside an operation: only records carrying the owner's CURRENT epoch (none for a deleted account).
    const epoch = leaseMode() ? await currentOwnerEpoch(ownerId, { pool: lease.pool ?? null }) : null;
    if (leaseMode() && epoch == null) return [];
    const held = importedBySource(ownerId);
    return rows.filter(c => visibleAt(c, epoch)).map(c => withProgress(c, view(c), held));
  }

  /** 2026-11-23: resources currently held per source (counts only). */
  function importedBySource(ownerId) {
    try { return new Map((external.listExternalSources?.(ownerId) ?? []).map(x => [x.sourceId, x.items])); }
    catch { return new Map(); }
  }
  function withProgress(conn, v, held) {
    v.imported = held.get(conn.sourceId) ?? 0;
    // Gmail Phase 2: progress of an unfinished full listing (counts only; derived from the saved cursor).
    if (conn.fullSync?.cursor && registry.has(conn.connectorId)) {
      const c = registry.get(conn.connectorId);
      if (typeof c.progressOf === 'function') { try { v.progress = c.progressOf(conn.fullSync.cursor) ?? null; } catch { v.progress = null; } }
    }
    return v;
  }

  async function getConnection({ userId, principal, connectionId } = {}) {
    const ownerId = ownerOf({ principal, userId });
    const conn = await load(ownerId, connectionId);
    return withProgress(conn, view(conn), importedBySource(ownerId));
  }

  // 2026-11-23 — STOP REQUESTS. Pause, revoke and disconnect wait for the owner lock, which a
  // running sync holds. They register a stop request FIRST (keyed by owner + connection, so
  // only the owner's own request counts); the sync checks it before every fetch, import and
  // retry and aborts cleanly (what was made durable stays; nothing further is written).
  const stopRequests = new Map();   // key → pending request count
  const stopKey = (ownerId, connectionId) => `${ownerId}\u0000${connectionId}`;
  function withStopRequest(ownerId, connectionId, fn) {
    const k = stopKey(ownerId, String(connectionId ?? ''));
    stopRequests.set(k, (stopRequests.get(k) ?? 0) + 1);
    const done = () => { const n = (stopRequests.get(k) ?? 1) - 1; if (n > 0) stopRequests.set(k, n); else stopRequests.delete(k); };
    return Promise.resolve().then(fn).finally(done);
  }
  const stopRequested = (ownerId, connectionId) => stopRequests.has(stopKey(ownerId, connectionId));

  /** Gmail Phase 2: pause or resume synchronisation of one of the caller's connections. */
  function setSyncPaused({ userId, principal, connectionId } = {}, paused) {
    let ownerId;
    try { ownerId = ownerOf({ principal, userId }); } catch (err) { return Promise.reject(err); }
    if (paused === true) return withStopRequest(ownerId, connectionId, () => setSyncPausedLocked(ownerId, connectionId, true));
    return setSyncPausedLocked(ownerId, connectionId, false);
  }
  function setSyncPausedLocked(ownerId, connectionId, paused) {
    return withOwner(ownerId, async () => {
      const conn = await load(ownerId, connectionId);
      if (!PAUSABLE.has(conn.status)) throw new ConnectError('NOT_ACTIVE', `connection is ${conn.status}`);
      await cw(ownerId, f => store.update(ownerId, connectionId, { syncPaused: paused === true }, { fence: f }));
      log.log?.(`[CONNECT] sync ${paused ? 'paused' : 'resumed'} connection=${connectionId} owner=${ownerLogId(ownerId)}`);
      return view(await store.get(ownerId, connectionId));
    });
  }
  const pauseSync = args => setSyncPaused(args, true);
  const resumeSync = args => setSyncPaused(args, false);

  /**
   * Gmail Phase 2 — called by the account purge (connectPurge.js) BEFORE the
   * owner's records are deleted: revoke every stored grant at its provider,
   * bounded and best effort. The purge never waits on, or fails because of,
   * a provider; the outcome is reported, never claimed.
   */
  async function revokeOwnerGrantsForPurge(ownerId) {
    const out = { revoked: 0, failed: 0, notAttempted: 0 };
    let rows = [];
    try { rows = await store.listByOwner(ownerId); } catch { return out; }
    for (const conn of rows) {
      if (!conn.credentials) continue;
      const connector = registry.has(conn.connectorId) ? registry.get(conn.connectorId) : null;
      const r = await revokeAtSource(conn, connector);
      if (r.providerRevocation === 'revoked') out.revoked++;
      else if (r.providerRevocation === 'failed') out.failed++;
      else out.notAttempted++;
    }
    if (out.revoked + out.failed + out.notAttempted) log.log?.(`[CONNECT] purge revocation owner=${ownerLogId(ownerId)} revoked=${out.revoked} failed=${out.failed} not_attempted=${out.notAttempted}`);
    return out;
  }
  registerGrantRevokerForPurge(store, revokeOwnerGrantsForPurge);

  // ── credentials (open only for this connection; refresh when expiring) ─────
  async function credentialsFor(conn, connector) {
    if (!conn.credentials) throw new ConnectError('NO_CREDENTIALS', 'connection has no credentials');
    let creds;
    try { creds = vault.open(conn.credentials, binding(conn)); }
    catch (err) {
      if (UNREADABLE.has(err?.code)) throw new ConnectError('CREDENTIALS_UNREADABLE', 'reconnect required (stored credentials cannot be opened)');
      throw err;
    }
    const expiring = conn.credentialsExpireAt != null && conn.credentialsExpireAt - REFRESH_SKEW_MS <= now();
    if (expiring) {
      if (typeof connector.refresh !== 'function') throw new ConnectError('NEEDS_REAUTH', 'credentials expired');
      let r;
      try { r = await bounded(connector.refresh(creds), 'REFRESH_TIMEOUT'); }   // token refresh: bounded
      catch (err) {
        // A timeout is not a refusal: the status is left alone (the next sync retries).
        if (err?.code === 'REFRESH_TIMEOUT') throw new ConnectError('REFRESH_TIMEOUT', 'the credential refresh did not complete in time');
        throw new ConnectError('NEEDS_REAUTH', 'credentials could not be refreshed');
      }
      if (!r?.credentials) throw new ConnectError('NEEDS_REAUTH', 'credentials could not be refreshed');
      creds = r.credentials;
      await cw(conn.ownerId, f => store.update(conn.ownerId, conn.connectionId, {
        credentials: vault.seal(creds, binding(conn)), credentialsExpireAt: r.expiresAt ?? null,
      }, { fence: f }));
    } else if (vault.needsReseal?.(conn.credentials)) {
      // Phase 2A key rotation: opened with a PREVIOUS key → re-encrypt under the current one now.
      await cw(conn.ownerId, f => store.update(conn.ownerId, conn.connectionId, { credentials: vault.seal(creds, binding(conn)) }, { fence: f }));
    }
    return creds;
  }

  /**
   * Phase 2A key rotation: re-encrypt every one of the owner's stored
   * credentials that was sealed by a previous key under the current key.
   * Under the owner lock + connect lease like every other write. A record
   * that no key in the vault can open is NOT touched here (sync marks it
   * needs_reauth); it is counted as `unreadable`.
   */
  function rotateCredentials({ userId, principal } = {}) {
    let ownerId;
    try { ownerId = ownerOf({ principal, userId }); } catch (err) { return Promise.reject(err); }
    if (vault.unavailable) return Promise.reject(new ConnectError('CREDENTIAL_KEY_UNAVAILABLE', 'the credential key is not configured'));
    return withOwner(ownerId, async ctx => {
      const epoch = ctx?.mode === 'lease' ? currentFence()?.epoch ?? null : null;
      const out = { resealed: 0, current: 0, unreadable: 0, withoutCredentials: 0 };
      for (const conn of await store.listByOwner(ownerId)) {
        if (!validFor(conn, epoch)) continue;
        if (!conn.credentials) { out.withoutCredentials += 1; continue; }
        if (conn.credentials.keyId === vault.keyId) { out.current += 1; continue; }
        if (!vault.needsReseal(conn.credentials)) { out.unreadable += 1; continue; }
        let sealed;
        try { sealed = vault.reseal(conn.credentials, binding(conn)); }
        catch (err) { if (UNREADABLE.has(err?.code)) { out.unreadable += 1; continue; } throw err; }
        await cw(ownerId, f => store.update(ownerId, conn.connectionId, { credentials: sealed }, { fence: f }));
        out.resealed += 1;
      }
      log.log?.(`[CONNECT] credential rotation owner=${ownerLogId(ownerId)} resealed=${out.resealed} current=${out.current} unreadable=${out.unreadable}`);
      return out;
    });
  }

  const ctxFor = (conn, creds) => Object.freeze({
    connectionId: conn.connectionId,
    credentials: () => structuredClone(creds),
  });

  // ── sync ───────────────────────────────────────────────────────────────────
  function sync({ userId, principal, connectionId, mode = 'auto', confirmMassDeletion = false } = {}) {
    let ownerId;
    try { ownerId = ownerOf({ principal, userId }); } catch (err) { return Promise.reject(err); }   // identity errors reject like every other failure
    return withOwner(ownerId, async () => {
      const conn = await load(ownerId, connectionId);
      if (conn.status !== 'active') throw new ConnectError('NOT_ACTIVE', `connection is ${conn.status}`);
      if (conn.syncPaused === true) throw new ConnectError('PAUSED', 'synchronisation is paused for this connection');
      if (!registry.has(conn.connectorId)) throw new ConnectError('UNKNOWN_CONNECTOR', 'that connector is no longer available');
      const connector = registry.get(conn.connectorId);

      let creds;
      try { creds = await credentialsFor(conn, connector); }
      catch (err) {
        // NEEDS_REAUTH (expired / refused refresh) and CREDENTIALS_UNREADABLE
        // (key missing or changed, envelope corrupt) both mean the user
        // must reconnect. Anything else (e.g. the store failed while saving a
        // refreshed token) leaves the status alone.
        const reconnect = err.code === 'NEEDS_REAUTH' || err.code === 'CREDENTIALS_UNREADABLE';
        const error = err.code === 'CREDENTIALS_UNREADABLE' ? err.message : reconnect ? 'reconnect required' : 'credentials unavailable';
        const lastSync = { state: 'failed', complete: false, error, finishedAt: new Date().toISOString(), lastSuccessAt: conn.lastSync?.lastSuccessAt ?? null };
        await cw(ownerId, f => store.update(ownerId, connectionId, { status: reconnect ? 'needs_reauth' : conn.status, lastSync, pendingDeletion: null }, { fence: f }));
        if (err.code === 'CREDENTIALS_UNREADABLE') log.warn?.(`[CONNECT] credentials unreadable connection=${connectionId} owner=${ownerLogId(ownerId)}; marked needs_reauth`);
        throw new ConnectError(reconnect ? err.code : 'CREDENTIALS_UNAVAILABLE', error);
      }
      const secrets = secretValues(creds);

      await cw(ownerId, f => store.update(ownerId, connectionId, { lastSync: { ...(conn.lastSync ?? {}), state: 'running', startedAt: new Date().toISOString() } }, { fence: f }));
      // Re-read the record before every write batch. Ownership is part of
      // the store key; the explicit comparison also defends a misbehaving store.
      const guard = async () => {
        const cur = await store.get(ownerId, connectionId);
        // …and this process still holds the owner's connect lease (fence not lost).
        // 2026-11-23: …not paused (also by another instance), and no stop requested here.
        return Boolean(cur && cur.ownerId === ownerId && cur.connectionId === connectionId && cur.status === 'active' && cur.syncPaused !== true)
          && !currentFence()?.lost && !stopRequested(ownerId, connectionId);
      };
      let outcome;
      try {
        // 2026-11-23: the engine saves a full pass's position after each durable batch.
        // Only while the connection is still active, and under the owner's fence.
        const persistProgress = async fullSync => {
          if (!(await guard())) throw new SyncStopped();
          const saved = await cw(ownerId, f => store.update(ownerId, connectionId, { fullSync }, { fence: f }));
          if (!saved) throw new SyncStopped();
        };
        outcome = await runSync({ ownerId, conn, connector, ctx: ctxFor(conn, creds), secrets, mode, external, retry, guard, confirmMassDeletion: confirmMassDeletion === true, now, limits: syncLimits, persistProgress, shouldStop: () => stopRequested(ownerId, connectionId) });
      } catch (err) {
        outcome = {
          authFailed: false, aborted: false,
          checkpoint: conn.checkpoint ?? null, fullSync: conn.fullSync ?? null, pendingDeletion: null,   // a crashed run resets a pending mass deletion (1b.2)
          lastSync: { state: 'failed', complete: false, error: scrubSecrets(`sync crashed: ${err?.message ?? err}`, secrets).slice(0, 300), finishedAt: new Date().toISOString() },
        };
      }
      if (outcome.aborted) {
        // The connection was disconnected, revoked or deleted under us: do not
        // touch its status, credentials or positions. Record the outcome only if
        // the record still exists (it may already be gone).
        const cur = await store.get(ownerId, connectionId);
        // 1b.2: an aborted run also resets a pending mass deletion.
        const after = cur ? await cw(ownerId, f => store.update(ownerId, connectionId, { lastSync: { ...outcome.lastSync, lastSuccessAt: conn.lastSync?.lastSuccessAt ?? null }, pendingDeletion: null }, { fence: f })) : null;
        registry.recordOutcome(conn.connectorId, false, 'sync aborted');
        log.log?.(`[CONNECT] sync connection=${connectionId} owner=${ownerLogId(ownerId)} state=aborted`);
        return { status: after?.status ?? 'deleted', lastSync: outcome.lastSync, aborted: true };
      }
      // 2026-11-23: when the last SUCCESSFUL run finished (kept across later runs; status APIs).
      outcome.lastSync.lastSuccessAt = outcome.lastSync.state === 'succeeded' ? outcome.lastSync.finishedAt : (conn.lastSync?.lastSuccessAt ?? null);
      const patch = {
        lastSync: outcome.lastSync, checkpoint: outcome.checkpoint,
        fullSync: outcome.fullSync ?? null, pendingDeletion: outcome.pendingDeletion ?? null,
        syncCount: (conn.syncCount ?? 0) + 1,
        ...(outcome.authFailed ? { status: 'needs_reauth' } : {}),
      };
      const updated = await cw(ownerId, f => store.update(ownerId, connectionId, patch, { fence: f }));
      if (!updated) return { status: 'deleted', lastSync: outcome.lastSync, aborted: true };
      registry.recordOutcome(conn.connectorId, outcome.lastSync.state === 'succeeded', outcome.lastSync.error ?? (outcome.lastSync.state === 'partial' ? 'partial sync' : null));
      const c = outcome.lastSync.counts ?? {};
      log.log?.(`[CONNECT] sync connection=${connectionId} owner=${ownerLogId(ownerId)} state=${outcome.lastSync.state} created=${c.created ?? 0} updated=${c.updated ?? 0} unchanged=${c.unchanged ?? 0} removed=${c.removed ?? 0} failed=${c.failed ?? 0}${outcome.lastSync.retries ? ` retries=${outcome.lastSync.retries.total} rateLimited=${outcome.lastSync.retries.rateLimited} statuses=${Object.entries(outcome.lastSync.retries.byStatus).map(([k, v]) => `${k}:${v}`).join(',')} reasons=${Object.entries(outcome.lastSync.retries.byReason).map(([k, v]) => `${k}:${v}`).join(',') || '-'}` : ''}`);
      return { status: updated.status, lastSync: updated.lastSync };
    });
  }

  // ── revoke / disconnect ────────────────────────────────────────────────────
  /**
   * Best-effort provider-side revocation. Returns exactly what happened
   * Fixed reason text only, never provider output.
   */
  async function revokeAtSource(conn, connector) {
    if (!conn.credentials) return { providerRevocation: 'not_attempted', reason: 'no stored credentials' };
    if (!connector) return { providerRevocation: 'not_attempted', reason: 'connector no longer available' };
    if (typeof connector.disconnect !== 'function') return { providerRevocation: 'not_attempted', reason: 'connector has no revocation call' };
    let creds;
    try { creds = vault.open(conn.credentials, binding(conn)); }
    catch { return { providerRevocation: 'not_attempted', reason: 'stored credentials cannot be opened (credential key missing or changed); revoke access at the provider' }; }
    try {
      // Gmail Phase 2: bounded, like every other provider call of an operation.
      await bounded(Promise.resolve().then(() => connector.disconnect(ctxFor(conn, creds))), 'REVOKE_TIMEOUT', providerTimeoutMs);
      return { providerRevocation: 'revoked', reason: null };
    } catch {
      return { providerRevocation: 'failed', reason: 'the provider did not confirm revocation; revoke access at the provider' };
    }
  }
  const revocationFields = (revoke, localCredentialsDeleted) => ({
    localCredentialsDeleted,
    providerRevocation: revoke.providerRevocation,
    providerRevocationReason: revoke.reason,
    revokedAtSource: revoke.providerRevocation === 'revoked',
  });

  /** Revoke the credentials (at the source, then locally). Imported knowledge is kept. */
  function revokeCredentials({ userId, principal, connectionId } = {}) {
    let ownerId;
    try { ownerId = ownerOf({ principal, userId }); } catch (err) { return Promise.reject(err); }   // identity errors reject like every other failure
    return withStopRequest(ownerId, connectionId, () => withOwner(ownerId, async () => {
      const conn = await load(ownerId, connectionId);
      const connector = registry.has(conn.connectorId) ? registry.get(conn.connectorId) : null;
      const revoke = await revokeAtSource(conn, connector);
      await cw(ownerId, f => store.update(ownerId, connectionId, { credentials: null, credentialsExpireAt: null, status: 'revoked' }, { fence: f }));
      return { connection: view(await store.get(ownerId, connectionId)), ...revocationFields(revoke, true) };
    }));
  }

  /**
   * Disconnect and delete: revoke at the source (best effort), wipe the
   * credentials, delete every piece of knowledge from this connection's source
   * (Phase 1a.2), then delete the record. If the knowledge deletion is
   * incomplete the record stays as 'disconnect_incomplete' (no credentials) and
   * calling disconnect again finishes it.
   */
  function disconnect({ userId, principal, connectionId } = {}) {
    let ownerId;
    try { ownerId = ownerOf({ principal, userId }); } catch (err) { return Promise.reject(err); }   // identity errors reject like every other failure
    return withStopRequest(ownerId, connectionId, () => withOwner(ownerId, async () => {
      const conn = await load(ownerId, connectionId);
      const connector = registry.has(conn.connectorId) ? registry.get(conn.connectorId) : null;
      await cw(ownerId, f => store.update(ownerId, connectionId, { status: 'disconnecting' }, { fence: f }));
      const revoke = await revokeAtSource(conn, connector);
      await cw(ownerId, f => store.update(ownerId, connectionId, { credentials: null, credentialsExpireAt: null }, { fence: f }));
      let purge;
      try { purge = await external.deleteExternalSource(ownerId, conn.sourceId); }
      catch (err) { purge = { complete: false, errors: [String(err?.message ?? err)] }; }
      if (!purge.complete) {
        await cw(ownerId, f => store.update(ownerId, connectionId, { status: 'disconnect_incomplete', lastSync: { ...(conn.lastSync ?? {}), state: 'disconnect_incomplete', remaining: purge.remaining ?? null } }, { fence: f }));
        return { deleted: false, ...revocationFields(revoke, true), knowledgeRemoved: false, remaining: purge.remaining ?? null };
      }
      await cw(ownerId, f => store.remove(ownerId, connectionId, { fence: f }));
      log.log?.(`[CONNECT] disconnected connection=${connectionId} owner=${ownerLogId(ownerId)} removed=${purge.removed?.ukos ?? 0}`);
      return { deleted: true, ...revocationFields(revoke, true), knowledgeRemoved: true, removed: purge.removed };
    }));
  }

  async function unregisterConnector(connectorId) {
    const active = await store.countByConnector(connectorId);
    return registry.unregister(connectorId, { activeConnections: active });
  }

  return {
    connect, listConnections, getConnection, sync, revokeCredentials, disconnect, rotateCredentials, pauseSync, resumeSync,
    unregisterConnector, connectorHealth: id => registry.probe(id), listConnectors: () => registry.list(),
  };
}
