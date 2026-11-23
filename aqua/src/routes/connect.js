/**
 * AQUA Connect — HTTP routes (Phase 2A: Gmail OAuth, read-only)
 *
 * Mounted at /api/aqua/connect (and the /v1 alias) by router.js, i.e. behind
 * the platform's aquaAccess chain: rate limits → requireLogin →
 * req.aquaUserId = req.session.userId. The caller is identified ONLY by
 * principalFromRequest(req) (connect/principal.js); no user id is read from
 * the query, body, params or headers.
 *
 *   GET    /gmail/start                 → 302 to Google consent (state + PKCE S256 in the session)
 *   GET    /gmail/callback              → state checked FIRST, then the code exchanged; 303 to /aqua/email?gmailConnect=…
 *   GET    /connections                 → the caller's connections (credential-free views, + `syncing`)
 *   GET    /connections/:id             → one of them, with last sync
 *   POST   /connections/:id/sync        → 202; the sync runs in THIS process after the response
 *   POST   /connections/:id/pause|resume
 *   POST   /connections/:id/revoke      → revoke at Google + wipe credentials; knowledge kept
 *   DELETE /connections/:id             → revoke + wipe + delete the source's knowledge + the record
 *
 * OFF BY DEFAULT: with AQUA_GMAIL_CONNECT unset every route answers 404 and no
 * transport, store, vault or service is imported or built (they are loaded
 * lazily in productionConnectDeps, after the gate check). With the gate
 * on but the configuration incomplete, 404 as well, and the boot log names the
 * missing variables (never values).
 *
 * Never logged or returned: the authorization code, the state, the PKCE
 * verifier, tokens, the client secret, email addresses or content. Responses
 * carry Cache-Control: no-store and Referrer-Policy: no-referrer (the callback
 * URL contains the code).
 */
import express from 'express';
import { ok, fail, ErrorCodes } from './envelope.js';
import { principalFromRequest } from '../connect/principal.js';
import { beginFlow, consumeFlow } from '../connect/oauth/oauthFlow.js';
import { productionConnectDeps, _resetProductionConnectDepsForTests } from '../connect/productionDeps.js';
import { ownerLogId } from '../core/logSafety.js';

const GMAIL = 'gmail';
const CODE_RE = /^[\x21-\x7e]{1,2048}$/;          // printable, no whitespace/control
const CONNECTION_ID_RE = /^conn_[0-9a-f]{20}$/;

// Fixed, public reason codes for the redirect back to the app (never provider text).
const PUBLIC_REASONS = new Set([
  'STATE_INVALID', 'STATE_EXPIRED', 'STATE_WRONG_USER', 'STATE_WRONG_CONNECTOR', 'NO_SESSION',
  'CONFIG_CHANGED', 'CODE_MISSING', 'PROVIDER_ERROR', 'AUTH_FAILED', 'CONNECT_FAILED',
  'CREDENTIAL_KEY_UNAVAILABLE', 'BUSY', 'LEASE_LOST', 'SESSION_SAVE_FAILED',
]);

const STATUS_FOR_CONNECT_ERROR = {
  UNAUTHENTICATED: ErrorCodes.UNAUTHORIZED,
  NOT_FOUND: ErrorCodes.NOT_FOUND,
  BUSY: ErrorCodes.CONFLICT,
  LEASE_LOST: ErrorCodes.CONFLICT,
  NOT_ACTIVE: ErrorCodes.CONFLICT,
  PAUSED: ErrorCodes.CONFLICT,
  BAD_REQUEST: ErrorCodes.BAD_REQUEST,
  CREDENTIAL_KEY_UNAVAILABLE: ErrorCodes.UNAVAILABLE,
  SYNC_QUEUE_UNAVAILABLE: ErrorCodes.UNAVAILABLE,
};
const SYNC_MODES = new Set(['auto', 'full', 'incremental']);

const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  next();
};

const saveSession = req => new Promise((resolve, reject) => {
  if (typeof req.session?.save !== 'function') return resolve();
  req.session.save(err => (err ? reject(err) : resolve()));
});

/**
 * @param {object} opts
 * @param {() => Promise<{ gmail: object|null, service?: object, vault?: object }>} opts.getDeps
 *        gmail = the safe config from gmailOAuthConfig.buildGmailOAuth (no secret), or null when off
 * @param {Function} [opts.now]
 * @param {object} [opts.log]
 * @param {string} [opts.returnPath]  where the callback sends the browser (same-origin path)
 */
export function createConnectRouter({ getDeps, now = Date.now, log = console, returnPath = '/aqua/email' } = {}) {
  if (typeof getDeps !== 'function') throw new TypeError('createConnectRouter needs getDeps');
  const router = express.Router();
  router.use(noStore);

  // Feature gate: 404 for every route while Gmail Connect is off or misconfigured.
  router.use(async (req, res, next) => {
    let deps;
    try { deps = await getDeps(); }
    catch { return fail(res, ErrorCodes.UNAVAILABLE, 'Connect is unavailable'); }
    if (!deps?.gmail || !deps.service) return fail(res, ErrorCodes.NOT_FOUND, `Not found: ${req.method} ${req.baseUrl}${req.path}`);
    req.aquaConnect = deps;
    next();
  });

  const principalOr401 = (req, res) => {
    try { return principalFromRequest(req); }
    catch { fail(res, ErrorCodes.UNAUTHORIZED, 'Login required'); return null; }
  };

  const backToApp = (res, outcome, reason = null) => {
    const r = reason && PUBLIC_REASONS.has(reason) ? reason : (reason ? 'CONNECT_FAILED' : null);
    res.redirect(303, `${returnPath}?gmailConnect=${outcome}${r ? `&reason=${r}` : ''}`);
  };

  // ── start ───────────────────────────────────────────────────────────────────
  router.get('/gmail/start', async (req, res) => {
    const principal = principalOr401(req, res);
    if (!principal) return;
    const { gmail, vault } = req.aquaConnect;
    // Refuse BEFORE Google issues anything we could not store.
    if (!vault || vault.unavailable) return fail(res, ErrorCodes.UNAVAILABLE, 'Connecting is unavailable right now', { reason: 'CREDENTIAL_KEY_UNAVAILABLE' });
    let flow;
    try {
      flow = beginFlow(req.session, { connectorId: GMAIL, userId: principal.userId, redirectUri: gmail.redirectUri, now: now() });
    } catch {
      return fail(res, ErrorCodes.UNAUTHORIZED, 'A session is required');
    }
    try { await saveSession(req); }
    catch { return fail(res, ErrorCodes.UNAVAILABLE, 'Connecting is unavailable right now', { reason: 'SESSION_SAVE_FAILED' }); }
    log.log?.(`[CONNECT] gmail oauth start owner=${ownerLogId(`user:${principal.userId}`)}`);
    return res.redirect(302, gmail.authorizationUrl({ state: flow.state, codeChallenge: flow.codeChallenge }));
  });

  // ── callback ────────────────────────────────────────────────────────────────
  router.get('/gmail/callback', async (req, res) => {
    const principal = principalOr401(req, res);
    if (!principal) return;
    const { gmail, service } = req.aquaConnect;
    const owner = ownerLogId(`user:${principal.userId}`);
    const outcome = (result, reason = null) => {
      log.log?.(`[CONNECT] gmail oauth callback owner=${owner} outcome=${result}${reason ? ` reason=${reason}` : ''}`);
      return backToApp(res, result, reason);
    };

    // 1. State FIRST — consumed (single use) whatever happens next. No exchange without it.
    let flow;
    try {
      flow = consumeFlow(req.session, { state: req.query.state, connectorId: GMAIL, userId: principal.userId, now: now() });
    } catch (err) {
      await saveSession(req).catch(() => {});
      return outcome('failed', err?.code ?? 'STATE_INVALID');
    }
    // Persist the consumption before the exchange (a replay on this session finds nothing).
    try { await saveSession(req); } catch { return outcome('failed', 'SESSION_SAVE_FAILED'); }

    // 2. The user declined (or Google reported an error): state already consumed, nothing exchanged.
    if (req.query.error !== undefined) return outcome(req.query.error === 'access_denied' ? 'denied' : 'failed', 'PROVIDER_ERROR');

    // 3. The redirect URI this flow was started with must still be the configured one.
    if (flow.redirectUri !== gmail.redirectUri) return outcome('failed', 'CONFIG_CHANGED');

    const code = req.query.code;
    if (typeof code !== 'string' || !CODE_RE.test(code)) return outcome('failed', 'CODE_MISSING');

    // 4. Exchange (connectService: bounded, sealed, owner-fenced). redirectUri and the
    //    verifier come from server-side config and the session — never from the request.
    try {
      await service.connect({ principal, connectorId: GMAIL, input: { code, redirectUri: gmail.redirectUri, codeVerifier: flow.verifier } });
      return outcome('connected');
    } catch (err) {
      return outcome('failed', typeof err?.code === 'string' ? err.code : 'CONNECT_FAILED');
    }
  });

  // ── connection management (JSON) ────────────────────────────────────────────
  // `syncing`: a sync of this connection is running in this process right now.
  // `syncPhase` (2026-11-23): not_started | initial_in_progress | initial_interrupted |
  //   initial_complete | incremental_in_progress | full_resync_in_progress | failed | paused.
  const syncPhaseOf = (c, syncing) => {
    if (c.syncPaused) return 'paused';
    if (syncing) return !c.initialSyncComplete ? 'initial_in_progress' : c.fullSyncInProgress ? 'full_resync_in_progress' : 'incremental_in_progress';
    if (!c.lastSync) return 'not_started';
    if (c.lastSync.state === 'failed') return 'failed';
    return c.initialSyncComplete ? 'initial_complete' : 'initial_interrupted';
  };
  const withSyncing = (req, principal, c) => {
    if (!c || typeof c !== 'object') return c;
    const syncing = req.aquaConnect.isSyncing?.(`user:${principal.userId}`, c.connectionId) === true;
    return { ...c, syncing, syncPhase: syncPhaseOf(c, syncing) };
  };
  const connectError = (res, err) => {
    const code = STATUS_FOR_CONNECT_ERROR[err?.code] ?? ErrorCodes.INTERNAL;
    return fail(res, code, code === ErrorCodes.INTERNAL ? 'Connect could not finish that request' : String(err?.message ?? 'failed').slice(0, 200));
  };

  router.get('/connections', async (req, res) => {
    const principal = principalOr401(req, res);
    if (!principal) return;
    try { return ok(res, { connections: (await req.aquaConnect.service.listConnections({ principal })).map(c => withSyncing(req, principal, c)) }); }
    catch (err) { return connectError(res, err); }
  });

  router.post('/connections/:id/revoke', async (req, res) => {
    const principal = principalOr401(req, res);
    if (!principal) return;
    if (!CONNECTION_ID_RE.test(String(req.params.id))) return fail(res, ErrorCodes.NOT_FOUND, 'connection not found');
    try { return ok(res, await req.aquaConnect.service.revokeCredentials({ principal, connectionId: req.params.id })); }
    catch (err) { return connectError(res, err); }
  });

  router.delete('/connections/:id', async (req, res) => {
    const principal = principalOr401(req, res);
    if (!principal) return;
    if (!CONNECTION_ID_RE.test(String(req.params.id))) return fail(res, ErrorCodes.NOT_FOUND, 'connection not found');
    try { return ok(res, await req.aquaConnect.service.disconnect({ principal, connectionId: req.params.id })); }
    catch (err) { return connectError(res, err); }
  });

  // ── Gmail Phase 2: status, sync, pause/resume ───────────────────────────────
  /** Status of one connection: credential-free view + last sync + listing progress (counts only). */
  router.get('/connections/:id', async (req, res) => {
    const principal = principalOr401(req, res);
    if (!principal) return;
    if (!CONNECTION_ID_RE.test(String(req.params.id))) return fail(res, ErrorCodes.NOT_FOUND, 'connection not found');
    try { return ok(res, { connection: withSyncing(req, principal, await req.aquaConnect.service.getConnection({ principal, connectionId: req.params.id })) }); }
    catch (err) { return connectError(res, err); }
  });

  /**
   * Queue a sync of one of the CALLER's connections on the durable job queue.
   * Body (optional): { mode: 'auto'|'full'|'incremental', confirmMassDeletion: boolean }.
   * The owner is the principal's; the connection is checked to be the caller's,
   * active and not paused BEFORE anything is queued. 202 { jobId, queued }.
   */
  router.post('/connections/:id/sync', async (req, res) => {
    const principal = principalOr401(req, res);
    if (!principal) return;
    const connectionId = String(req.params.id);
    if (!CONNECTION_ID_RE.test(connectionId)) return fail(res, ErrorCodes.NOT_FOUND, 'connection not found');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const unknown = Object.keys(body).filter(k => !['mode', 'confirmMassDeletion'].includes(k));
    if (unknown.length) return fail(res, ErrorCodes.BAD_REQUEST, 'only mode and confirmMassDeletion may be given');
    const mode = body.mode ?? 'auto';
    if (!SYNC_MODES.has(mode)) return fail(res, ErrorCodes.BAD_REQUEST, 'mode must be auto, full or incremental');
    if (body.confirmMassDeletion !== undefined && typeof body.confirmMassDeletion !== 'boolean') return fail(res, ErrorCodes.BAD_REQUEST, 'confirmMassDeletion must be a boolean');
    const { service, startSync } = req.aquaConnect;
    try {
      const conn = await service.getConnection({ principal, connectionId });   // the caller's, or NOT_FOUND
      if (conn.status !== 'active') return fail(res, ErrorCodes.CONFLICT, `connection is ${conn.status}`, { reason: 'NOT_ACTIVE' });
      if (conn.syncPaused) return fail(res, ErrorCodes.CONFLICT, 'synchronisation is paused for this connection', { reason: 'PAUSED' });
      if (typeof startSync !== 'function') return fail(res, ErrorCodes.UNAVAILABLE, 'synchronisation is unavailable', { reason: 'SYNC_QUEUE_UNAVAILABLE' });
      // Finalization: runs in THIS (API) process after the response — the UKO store's
      // only writer (connect/productionDeps.js createInProcessSyncRunner).
      const r = startSync({ principal, connectionId, mode, confirmMassDeletion: body.confirmMassDeletion === true });
      log.log?.(`[CONNECT] sync requested owner=${ownerLogId(`user:${principal.userId}`)} connection=${connectionId} mode=${mode} started=${r.started}`);
      res.status(202);
      return ok(res, { started: r.started, running: r.running });
    } catch (err) { return connectError(res, err); }
  });

  // ── Gmail Phase 5: model-free Gmail intelligence (the caller's own email only) ─
  // Every handler reads the caller's restricted Gmail knowledge through
  // connect/gmail/emailIntelligence.js (owner = principal; the read taints this
  // request with external:gmail, so nothing after it can reach an AI provider).
  // Structured data only — no model, no provider, no embeddings, no search.
  // Unknown query/body fields are refused; pages are bounded; errors never echo content.
  const intelligence = () => import('../connect/gmail/emailIntelligence.js');
  const PAGE_KEYS = ['limit', 'cursor'];
  const intParam = (v, dflt, min, max) => {
    if (v === undefined) return dflt;
    if (typeof v !== 'string' || !/^\d{1,6}$/.test(v)) return NaN;
    const n = Number(v);
    return n >= min && n <= max ? n : NaN;
  };
  const intelError = (res, err) => (err?.code === 'BAD_REQUEST'
    ? fail(res, ErrorCodes.BAD_REQUEST, 'unknown view')
    : err?.code === 'UNAUTHENTICATED' ? fail(res, ErrorCodes.UNAUTHORIZED, 'Login required')
      : fail(res, ErrorCodes.INTERNAL, 'Email intelligence could not be read'));

  router.get('/gmail/intelligence/overview', async (req, res) => {
    const principal = principalOr401(req, res);
    if (!principal) return;
    if (Object.keys(req.query).length) return fail(res, ErrorCodes.BAD_REQUEST, 'no query parameters are accepted');
    try { return ok(res, { generatedBy: 'deterministic', ...(await intelligence()).overview({ principal, now: now() }) }); }
    catch (err) { return intelError(res, err); }
  });

  router.get('/gmail/intelligence/view/:view', async (req, res) => {
    const principal = principalOr401(req, res);
    if (!principal) return;
    const I = await intelligence();
    if (!I.VIEWS.includes(String(req.params.view))) return fail(res, ErrorCodes.NOT_FOUND, 'unknown view');
    if (Object.keys(req.query).some(k => !PAGE_KEYS.includes(k))) return fail(res, ErrorCodes.BAD_REQUEST, 'only limit and cursor may be given');
    const limit = intParam(req.query.limit, I.PAGE.defaultLimit, 1, I.PAGE.maxLimit);
    const cursor = intParam(req.query.cursor, 0, 0, I.PAGE.maxCursor);
    if (Number.isNaN(limit) || Number.isNaN(cursor)) return fail(res, ErrorCodes.BAD_REQUEST, `limit must be 1–${I.PAGE.maxLimit} and cursor 0–${I.PAGE.maxCursor}`);
    try { return ok(res, { generatedBy: 'deterministic', ...I.view({ principal, view: req.params.view, limit, cursor, now: now() }) }); }
    catch (err) { return intelError(res, err); }
  });

  router.get('/gmail/intelligence/evidence/:id', async (req, res) => {
    const principal = principalOr401(req, res);
    if (!principal) return;
    if (!/^[0-9a-f]{16}$/.test(String(req.params.id))) return fail(res, ErrorCodes.NOT_FOUND, 'evidence not found');
    if (Object.keys(req.query).length) return fail(res, ErrorCodes.BAD_REQUEST, 'no query parameters are accepted');
    try {
      const d = (await intelligence()).evidenceDetail({ principal, id: req.params.id, now: now() });
      return d ? ok(res, { generatedBy: 'deterministic', ...d }) : fail(res, ErrorCodes.NOT_FOUND, 'evidence not found');   // another owner's id = not found
    } catch (err) { return intelError(res, err); }
  });

  router.post('/gmail/intelligence/ask', async (req, res) => {
    const principal = principalOr401(req, res);
    if (!principal) return;
    const I = await intelligence();
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (Object.keys(body).some(k => k !== 'question')) return fail(res, ErrorCodes.BAD_REQUEST, 'only question may be given');
    if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > I.MAX_QUESTION_CHARS) {
      return fail(res, ErrorCodes.BAD_REQUEST, `question must be 1–${I.MAX_QUESTION_CHARS} characters`);
    }
    try { return ok(res, { generatedBy: 'deterministic', modelUsed: false, ...I.ask({ principal, question: body.question, now: now() }) }); }
    catch (err) { return intelError(res, err); }
  });

  for (const [path, method] of [['pause', 'pauseSync'], ['resume', 'resumeSync']]) {
    router.post(`/connections/:id/${path}`, async (req, res) => {
      const principal = principalOr401(req, res);
      if (!principal) return;
      if (!CONNECTION_ID_RE.test(String(req.params.id))) return fail(res, ErrorCodes.NOT_FOUND, 'connection not found');
      try { return ok(res, { connection: await req.aquaConnect.service[method]({ principal, connectionId: req.params.id }) }); }
      catch (err) { return connectError(res, err); }
    });
  }

  return router;
}

// ── production wiring: connect/productionDeps.js (lazy; only when AQUA_GMAIL_CONNECT=on) ──
export { productionConnectDeps, _resetProductionConnectDepsForTests };

export default createConnectRouter({ getDeps: () => productionConnectDeps() });
