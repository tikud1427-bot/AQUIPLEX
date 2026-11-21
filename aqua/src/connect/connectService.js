/**
 * AQUA Connect — connection lifecycle service (Phase 1b)
 *
 * The engine API a future HTTP route (or job) calls. Every method takes the
 * AUTHENTICATED user id (the platform's req.aquaUserId) and acts only on that
 * user's connections: the owner is derived here (memory/ownerResolver.js), never
 * accepted from a caller, and every store read is (ownerId, connectionId).
 *
 *   connect({ userId, connectorId, input })      → connection view (no secrets)
 *   listConnections({ userId })                  → views
 *   getConnection({ userId, connectionId })      → view
 *   sync({ userId, connectionId, mode, confirmMassDeletion })
 *                                                → { status, lastSync, aborted? }
 *   revokeCredentials({ userId, connectionId })  → revoke at source + wipe credentials; knowledge kept
 *   disconnect({ userId, connectionId })         → revoke + wipe + delete the source's knowledge + delete the record
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
 * SINGLE PROCESS ONLY — separate processes or servers are not coordinated;
 * run connect operations from one process until a shared lease exists.
 *
 * Unreadable credentials: if the stored credentials cannot be
 * opened (key missing, key changed, envelope corrupt or tampered) the connection
 * moves to 'needs_reauth' with a fixed "reconnect required" error.
 *
 * Key stability: there is no key rotation. Changing or losing AQUA_CONNECTOR_KEY
 * makes every stored credential unreadable and every connection must reconnect
 * (the credentials cannot be recovered). Do not store real credentials until
 * key rotation exists.
 */
import crypto from 'node:crypto';
import { ownerForUser } from '../memory/ownerResolver.js';
import * as externalDefault from '../files/externalSources.js';
import { runSync, MASS_DELETION } from './syncEngine.js';
import { UNREADABLE_CREDENTIAL_CODES } from './credentialVault.js';
import { secretValues, scrubSecrets, isAuthError } from './contract.js';
import { ownerLogId } from '../core/logSafety.js';
import { sanitizeInlineLabel } from '../core/untrustedContent.js';

export class ConnectError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const REFRESH_SKEW_MS = 2 * 60 * 1000;

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

/**
 * @param {object} deps
 * @param {object} deps.registry   createConnectorRegistry() instance
 * @param {object} deps.store      connection store (connectionStore.js)
 * @param {object} deps.vault      createCredentialVault() instance
 * @param {object} [deps.external] Phase 1a.2 API (files/externalSources.js)
 * @param {object} [deps.retry]    sync retry options (tests pass sleep: () => {})
 * @param {Function} [deps.now]
 */
export function createConnectService({ registry, store, vault, external = externalDefault, retry = {}, now = Date.now, log = console } = {}) {
  if (!registry || !store || !vault) throw new ConnectError('MISCONFIGURED', 'connect service needs a registry, a store and a credential vault');

  // Per-owner serialisation: the process-wide withOwnerLock above.

  const ownerOf = userId => {
    const ownerId = ownerForUser(typeof userId === 'string' || typeof userId === 'number' ? String(userId).trim() : '');
    if (!ownerId || ownerId === 'user:') throw new ConnectError('UNAUTHENTICATED', 'an authenticated user is required');
    return ownerId;
  };

  const binding = conn => ({ ownerId: conn.ownerId, connectionId: conn.connectionId, connectorId: conn.connectorId });

  /** Credential-free view. */
  const view = conn => conn && ({
    connectionId: conn.connectionId, connectorId: conn.connectorId, connectorVersion: conn.connectorVersion,
    status: conn.status, account: { label: conn.account?.label ?? null },
    scopes: [...(conn.scopes ?? [])], credentialsExpireAt: conn.credentialsExpireAt ?? null,
    hasCredentials: Boolean(conn.credentials), lastSync: conn.lastSync ?? null, syncCount: conn.syncCount ?? 0,
    // Phase 1b.1: listing progress and a withheld mass deletion awaiting confirmation (no ids exposed).
    fullSyncInProgress: Boolean(conn.fullSync?.cursor),
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
    return conn;
  }

  // ── connect ────────────────────────────────────────────────────────────────
  async function connect({ userId, connectorId, input = {} } = {}) {
    const ownerId = ownerOf(userId);
    if (!registry.has(connectorId)) throw new ConnectError('UNKNOWN_CONNECTOR', 'that connector is not available');
    // Refuse BEFORE the provider issues tokens we could not store.
    if (vault.unavailable) throw new ConnectError('CREDENTIAL_KEY_UNAVAILABLE', 'connecting is unavailable: the credential key is not configured');
    const connector = registry.get(connectorId);
    const connectionId = `conn_${crypto.randomBytes(10).toString('hex')}`;
    let result;
    try {
      result = await connector.connect(input);
    } catch (err) {
      registry.recordOutcome(connectorId, false, 'connect failed');
      throw new ConnectError(isAuthError(err) ? 'AUTH_FAILED' : 'CONNECT_FAILED', 'the source refused the connection');   // never echo provider text: it may carry secrets
    }
    if (!result?.credentials || typeof result.credentials !== 'object') throw new ConnectError('CONNECT_FAILED', 'connector returned no credentials');
    const doc = {
      connectionId, ownerId, connectorId, connectorVersion: connector.version,
      sourceId: `${connectorId}:${connectionId}`,
      status: 'active',
      account: {
        label: sanitizeInlineLabel(result.account?.label ?? '', { max: 80 }) || null,
        externalAccountHash: result.account?.externalAccountId
          ? crypto.createHash('sha256').update(String(result.account.externalAccountId)).digest('hex').slice(0, 24) : null,
      },
      scopes: (result.scopes ?? connector.auth.scopes ?? []).map(String),
      credentials: null, credentialsExpireAt: result.expiresAt ?? null,
      checkpoint: null, lastSync: null, syncCount: 0,
    };
    doc.credentials = vault.seal(result.credentials, binding(doc));
    await store.create(doc);
    registry.recordOutcome(connectorId, true);
    log.log?.(`[CONNECT] connected connector=${connectorId} owner=${ownerLogId(ownerId)} connection=${connectionId}`);
    return view(await store.get(ownerId, connectionId));
  }

  async function listConnections({ userId } = {}) {
    return (await store.listByOwner(ownerOf(userId))).map(view);
  }

  async function getConnection({ userId, connectionId } = {}) {
    return view(await load(ownerOf(userId), connectionId));
  }

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
      try { r = await connector.refresh(creds); }
      catch { throw new ConnectError('NEEDS_REAUTH', 'credentials could not be refreshed'); }
      if (!r?.credentials) throw new ConnectError('NEEDS_REAUTH', 'credentials could not be refreshed');
      creds = r.credentials;
      await store.update(conn.ownerId, conn.connectionId, {
        credentials: vault.seal(creds, binding(conn)), credentialsExpireAt: r.expiresAt ?? null,
      });
    }
    return creds;
  }

  const ctxFor = (conn, creds) => Object.freeze({
    connectionId: conn.connectionId,
    credentials: () => structuredClone(creds),
  });

  // ── sync ───────────────────────────────────────────────────────────────────
  function sync({ userId, connectionId, mode = 'auto', confirmMassDeletion = false } = {}) {
    const ownerId = ownerOf(userId);
    return withOwnerLock(ownerId, async () => {
      const conn = await load(ownerId, connectionId);
      if (conn.status !== 'active') throw new ConnectError('NOT_ACTIVE', `connection is ${conn.status}`);
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
        const lastSync = { state: 'failed', complete: false, error, finishedAt: new Date().toISOString() };
        await store.update(ownerId, connectionId, { status: reconnect ? 'needs_reauth' : conn.status, lastSync, pendingDeletion: null });
        if (err.code === 'CREDENTIALS_UNREADABLE') log.warn?.(`[CONNECT] credentials unreadable connection=${connectionId} owner=${ownerLogId(ownerId)}; marked needs_reauth`);
        throw new ConnectError(reconnect ? err.code : 'CREDENTIALS_UNAVAILABLE', error);
      }
      const secrets = secretValues(creds);

      await store.update(ownerId, connectionId, { lastSync: { ...(conn.lastSync ?? {}), state: 'running', startedAt: new Date().toISOString() } });
      // Re-read the record before every write batch. Ownership is part of
      // the store key; the explicit comparison also defends a misbehaving store.
      const guard = async () => {
        const cur = await store.get(ownerId, connectionId);
        return Boolean(cur && cur.ownerId === ownerId && cur.connectionId === connectionId && cur.status === 'active');
      };
      let outcome;
      try {
        outcome = await runSync({ ownerId, conn, connector, ctx: ctxFor(conn, creds), secrets, mode, external, retry, guard, confirmMassDeletion: confirmMassDeletion === true, now });
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
        const after = cur ? await store.update(ownerId, connectionId, { lastSync: outcome.lastSync, pendingDeletion: null }) : null;
        registry.recordOutcome(conn.connectorId, false, 'sync aborted');
        log.log?.(`[CONNECT] sync connection=${connectionId} owner=${ownerLogId(ownerId)} state=aborted`);
        return { status: after?.status ?? 'deleted', lastSync: outcome.lastSync, aborted: true };
      }
      const patch = {
        lastSync: outcome.lastSync, checkpoint: outcome.checkpoint,
        fullSync: outcome.fullSync ?? null, pendingDeletion: outcome.pendingDeletion ?? null,
        syncCount: (conn.syncCount ?? 0) + 1,
        ...(outcome.authFailed ? { status: 'needs_reauth' } : {}),
      };
      const updated = await store.update(ownerId, connectionId, patch);
      if (!updated) return { status: 'deleted', lastSync: outcome.lastSync, aborted: true };
      registry.recordOutcome(conn.connectorId, outcome.lastSync.state === 'succeeded', outcome.lastSync.error ?? (outcome.lastSync.state === 'partial' ? 'partial sync' : null));
      const c = outcome.lastSync.counts ?? {};
      log.log?.(`[CONNECT] sync connection=${connectionId} owner=${ownerLogId(ownerId)} state=${outcome.lastSync.state} created=${c.created ?? 0} updated=${c.updated ?? 0} unchanged=${c.unchanged ?? 0} removed=${c.removed ?? 0} failed=${c.failed ?? 0}`);
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
      await connector.disconnect(ctxFor(conn, creds));
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
  function revokeCredentials({ userId, connectionId } = {}) {
    const ownerId = ownerOf(userId);
    return withOwnerLock(ownerId, async () => {
      const conn = await load(ownerId, connectionId);
      const connector = registry.has(conn.connectorId) ? registry.get(conn.connectorId) : null;
      const revoke = await revokeAtSource(conn, connector);
      await store.update(ownerId, connectionId, { credentials: null, credentialsExpireAt: null, status: 'revoked' });
      return { connection: view(await store.get(ownerId, connectionId)), ...revocationFields(revoke, true) };
    });
  }

  /**
   * Disconnect and delete: revoke at the source (best effort), wipe the
   * credentials, delete every piece of knowledge from this connection's source
   * (Phase 1a.2), then delete the record. If the knowledge deletion is
   * incomplete the record stays as 'disconnect_incomplete' (no credentials) and
   * calling disconnect again finishes it.
   */
  function disconnect({ userId, connectionId } = {}) {
    const ownerId = ownerOf(userId);
    return withOwnerLock(ownerId, async () => {
      const conn = await load(ownerId, connectionId);
      const connector = registry.has(conn.connectorId) ? registry.get(conn.connectorId) : null;
      await store.update(ownerId, connectionId, { status: 'disconnecting' });
      const revoke = await revokeAtSource(conn, connector);
      await store.update(ownerId, connectionId, { credentials: null, credentialsExpireAt: null });
      let purge;
      try { purge = await external.deleteExternalSource(ownerId, conn.sourceId); }
      catch (err) { purge = { complete: false, errors: [String(err?.message ?? err)] }; }
      if (!purge.complete) {
        await store.update(ownerId, connectionId, { status: 'disconnect_incomplete', lastSync: { ...(conn.lastSync ?? {}), state: 'disconnect_incomplete', remaining: purge.remaining ?? null } });
        return { deleted: false, ...revocationFields(revoke, true), knowledgeRemoved: false, remaining: purge.remaining ?? null };
      }
      await store.remove(ownerId, connectionId);
      log.log?.(`[CONNECT] disconnected connection=${connectionId} owner=${ownerLogId(ownerId)} removed=${purge.removed?.ukos ?? 0}`);
      return { deleted: true, ...revocationFields(revoke, true), knowledgeRemoved: true, removed: purge.removed };
    });
  }

  async function unregisterConnector(connectorId) {
    const active = await store.countByConnector(connectorId);
    return registry.unregister(connectorId, { activeConnections: active });
  }

  return {
    connect, listConnections, getConnection, sync, revokeCredentials, disconnect,
    unregisterConnector, connectorHealth: id => registry.probe(id), listConnectors: () => registry.list(),
  };
}
