/**
 * AQUA Connect — the REAL Gmail transport over Google's REST endpoints (Phase 2A)
 *
 * Implements exactly the read-only transport interface of gmailConnector.js.
 * No SDK, no dependency: `fetch` (injectable; Node's global by default).
 *
 * READ-ONLY BY CONSTRUCTION
 *   · Every request passes one gate (request()): https only, host allow-list,
 *     and per host a method + path allow-list:
 *       oauth2.googleapis.com   POST /token, POST /revoke
 *       gmail.googleapis.com    GET  /gmail/v1/users/me/{profile|messages|messages/<id>|threads/<id>|history}
 *     Anything else (another host, a non-GET Gmail call, any other path) is
 *     refused before a socket is opened. There is no send/modify/delete code.
 *   · Redirects are not followed (redirect: 'error').
 *
 * SECRETS
 *   · The client secret is held in this closure only; the returned object
 *     exposes methods, never configuration.
 *   · Tokens and the secret travel in headers or form bodies, never in a URL.
 *   · An error carries only an HTTP-like `status` (and, from the token
 *     endpoint, Google's fixed `error` code mapped to a status). Response
 *     bodies are never put into an Error, a log line or a return value.
 *   · This module logs nothing.
 *
 * EXCHANGE
 *   exchangeCode({ code, redirectUri, codeVerifier }) refuses — before any
 *   network call — a redirectUri that is not EXACTLY the configured one and a
 *   verifier that is not RFC 7636 shaped. The grant's `scope` (space-delimited)
 *   is returned as `scopes`; gmailConnector.connect() requires exactly
 *   gmail.readonly.
 */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

const ID_RE = /^[A-Za-z0-9]{1,64}$/;
const HISTORY_RE = /^\d{1,30}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const GMAIL_PATH_RE = /^\/gmail\/v1\/users\/me\/(profile|messages|messages\/[A-Za-z0-9]{1,64}|threads\/[A-Za-z0-9]{1,64}|history)$/;
const ALLOWED = Object.freeze({
  'oauth2.googleapis.com': { methods: new Set(['POST']), path: p => p === '/token' || p === '/revoke' },
  'gmail.googleapis.com': { methods: new Set(['GET']), path: p => GMAIL_PATH_RE.test(p) },
});

/** The request gate (pure): https, an allowed host, and that host's allowed method + path. */
export function requestAllowed(url, method) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const rule = Object.prototype.hasOwnProperty.call(ALLOWED, u.hostname) ? ALLOWED[u.hostname] : null;
  return u.protocol === 'https:' && Boolean(rule) && rule.methods.has(method) && rule.path(u.pathname) && !u.username && !u.password && !u.port;
}

/** A transport failure: status only (gmailConnector.mapError classifies it). */
const failure = (status, code = null) => Object.assign(new Error(`Google request failed (${status})`), { status, ...(code ? { code } : {}) });

/**
 * Gmail Phase 2 — HTTP Retry-After: delay-seconds or an HTTP-date → milliseconds
 * (null when absent or unparseable; never negative). Only a number travels on.
 */
export function parseRetryAfter(value, now = Date.now) {
  if (value == null) return null;
  const s = String(value).trim();
  if (/^\d{1,7}$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - now()) : null;
}
const withRetryAfter = (err, r) => (r?.retryAfterMs != null && (r.status === 429 || r.status === 403 || r.status >= 500) ? Object.assign(err, { retryAfterMs: r.retryAfterMs }) : err);

/**
 * 2026-11-23 — Google's STRUCTURED error identity, never its free text:
 *   reason: error.errors[0].reason (e.g. userRateLimitExceeded, insufficientPermissions)
 *           or an ErrorInfo detail's reason (e.g. ACCESS_TOKEN_SCOPE_INSUFFICIENT);
 *   googleStatus: error.status (e.g. PERMISSION_DENIED, RESOURCE_EXHAUSTED).
 * Only identifier-shaped values survive (letters, digits, _ . -; ≤ 64 chars).
 */
const CODE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const codeOr = v => (typeof v === 'string' && CODE_RE.test(v) ? v : null);
export function googleErrorOf(data) {
  const e = data && typeof data === 'object' ? data.error : null;
  if (!e || typeof e !== 'object') return { reason: null, googleStatus: null };
  const fromErrors = Array.isArray(e.errors) ? e.errors.map(x => codeOr(x?.reason)).find(Boolean) : null;
  const fromDetails = Array.isArray(e.details) ? e.details.map(x => codeOr(x?.reason)).find(Boolean) : null;
  return { reason: fromErrors ?? fromDetails ?? null, googleStatus: codeOr(e.status) };
}
const withGoogleError = (err, r) => {
  const g = googleErrorOf(r?.data);
  if (g.reason) err.reason = g.reason;
  if (g.googleStatus) err.googleStatus = g.googleStatus;
  return err;
};

export class GoogleTransportConfigError extends Error {
  constructor(message) { super(message); this.code = 'TRANSPORT_MISCONFIGURED'; }
}

/**
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.clientSecret
 * @param {string} opts.redirectUri   the exact registered redirect URI (gmailOAuthConfig.js)
 * @param {Function} [opts.fetch]     injectable (tests); default globalThis.fetch
 * @param {Function} [opts.now]
 * @param {number} [opts.timeoutMs]   per request (below connectService's 15 s bound)
 */
export function createGoogleGmailTransport({ clientId, clientSecret, redirectUri, fetch: fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10_000 } = {}) {
  if (typeof clientId !== 'string' || !clientId) throw new GoogleTransportConfigError('clientId required');
  if (typeof clientSecret !== 'string' || !clientSecret) throw new GoogleTransportConfigError('clientSecret required');
  if (typeof redirectUri !== 'string' || !redirectUri) throw new GoogleTransportConfigError('redirectUri required');
  if (typeof fetchImpl !== 'function') throw new GoogleTransportConfigError('fetch is not available');

  /** The ONLY way out. Refuses anything outside the allow-list before a request is made. */
  async function request(url, { method = 'GET', headers = {}, body = undefined } = {}) {
    if (!requestAllowed(url, method)) throw failure(0, 'REQUEST_REFUSED');
    const u = new URL(url);
    let res;
    try {
      res = await fetchImpl(u.href, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw Object.assign(failure(0, timedOut ? 'ETIMEDOUT' : 'ECONNRESET'), { name: timedOut ? 'TimeoutError' : 'NetworkError' });
    }
    let data = null;
    const text = await res.text().catch(() => '');
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { status: res.status, ok: res.ok, data, retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after'), now) };
  }

  /** Token endpoint call (form body, client secret in the body — never the URL). */
  async function tokenCall(params) {
    const body = new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret }).toString();
    const r = await request(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
    if (!r.ok) {
      // Google's fixed error codes only. invalid_grant (bad/used/expired code, revoked
      // refresh token, PKCE or redirect mismatch) and invalid_client mean "not authorised".
      const e = typeof r.data?.error === 'string' ? r.data.error : '';
      if (e === 'invalid_grant' || e === 'invalid_client' || e === 'unauthorized_client' || r.status === 401) throw failure(401);
      throw withRetryAfter(failure(r.status >= 500 || r.status === 429 ? r.status : 400), r);
    }
    const d = r.data ?? {};
    if (typeof d.access_token !== 'string' || !d.access_token) throw failure(502);
    if (d.token_type != null && String(d.token_type).toLowerCase() !== 'bearer') throw failure(502);
    const ttl = Number(d.expires_in);
    return {
      accessToken: d.access_token,
      refreshToken: typeof d.refresh_token === 'string' && d.refresh_token ? d.refresh_token : null,
      expiresAt: Number.isFinite(ttl) && ttl > 0 ? now() + ttl * 1000 : null,
      scopes: typeof d.scope === 'string' ? d.scope.split(/\s+/).filter(Boolean) : null,   // null = not stated → the connector refuses
    };
  }

  async function gmailGet(accessToken, path, query = {}) {
    if (typeof accessToken !== 'string' || !accessToken) throw failure(401);
    const u = new URL(`${GMAIL_API_BASE}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    const r = await request(u.href, { method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
    if (!r.ok) throw withRetryAfter(withGoogleError(failure(r.status), r), r);
    if (!r.data || typeof r.data !== 'object') throw failure(502);
    return r.data;
  }

  const idOrFail = id => { if (typeof id !== 'string' || !ID_RE.test(id)) throw failure(404); return id; };
  const formatOf = f => (f === 'metadata' ? 'metadata' : 'full');

  return Object.freeze({
    readOnly: true,
    testOnly: false,

    async exchangeCode({ code, redirectUri: ru, codeVerifier } = {}) {
      if (typeof code !== 'string' || !code || code.length > 2048) throw failure(400, 'CODE_INVALID');
      if (ru !== redirectUri) throw failure(400, 'REDIRECT_URI_MISMATCH');          // exact match, before any network call
      if (typeof codeVerifier !== 'string' || !VERIFIER_RE.test(codeVerifier)) throw failure(400, 'PKCE_VERIFIER_INVALID');
      return tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier });
    },

    async refreshAccessToken(refreshToken) {
      if (typeof refreshToken !== 'string' || !refreshToken) throw failure(401);
      return tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken });
    },

    async revokeToken(token) {
      if (typeof token !== 'string' || !token) throw failure(400);
      const r = await request(GOOGLE_REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() });
      if (!r.ok) throw failure(r.status);
    },

    async getProfile(accessToken) {
      const d = await gmailGet(accessToken, '/profile');
      return { emailAddress: d.emailAddress, messagesTotal: d.messagesTotal, threadsTotal: d.threadsTotal, historyId: d.historyId };
    },

    async listMessages(accessToken, { pageToken, maxResults = 100, includeSpamTrash = false } = {}) {
      const n = Math.max(1, Math.min(500, Number(maxResults) || 100));
      return gmailGet(accessToken, '/messages', { pageToken: typeof pageToken === 'string' ? pageToken : undefined, maxResults: n, includeSpamTrash: includeSpamTrash === true ? 'true' : 'false' });
    },

    async getMessage(accessToken, id, { format = 'full' } = {}) {
      return gmailGet(accessToken, `/messages/${idOrFail(id)}`, { format: formatOf(format) });
    },

    async getThread(accessToken, threadId, { format = 'metadata' } = {}) {
      return gmailGet(accessToken, `/threads/${idOrFail(threadId)}`, { format: formatOf(format) });
    },

    async listHistory(accessToken, { startHistoryId, pageToken } = {}) {
      if (!HISTORY_RE.test(String(startHistoryId ?? ''))) throw failure(404);
      return gmailGet(accessToken, '/history', { startHistoryId: String(startHistoryId), pageToken: typeof pageToken === 'string' ? pageToken : undefined });
    },

    /** No network: configuration is present (a live probe would spend quota). */
    async health() { return { ok: true }; },
  });
}
