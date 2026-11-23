/**
 * AQUA Connect — session-bound OAuth state + PKCE (Phase 2A)
 *
 * The connector OAuth flow's own protocol state, independent of passport and
 * of the platform's Google sign-in/link/reauth slots
 * (services/auth/googleOAuthOptions.service.js). It lives in the server-side
 * session under ONE key, `aquaConnectOAuth`, one entry per pending flow:
 *
 *   key        sha256(state) (hex). The raw state is never stored or logged.
 *   value      { connectorId, userId, verifier, redirectUri, createdAt, expiresAt }
 *
 * Guarantees (each tested in connect/tests/gmailOAuth.test.js):
 *   · random      state = 32 random bytes (base64url); PKCE verifier = 64 random
 *                 bytes (base64url, 86 chars, RFC 7636 43–128); challenge S256.
 *   · single use  consume() deletes the entry BEFORE any check, matched or not,
 *                 so a replayed callback finds nothing.
 *   · expiring    TTL (default 10 minutes); an expired entry is refused.
 *   · session     only the session that started the flow holds the entry.
 *   · principal   the entry records the authenticated user who started it; a
 *                 callback arriving on the same session for a DIFFERENT user
 *                 (sign-out + sign-in in between) is refused.
 *   · connector   an entry started for one connector cannot complete another.
 *   · bounded     at most MAX_PENDING entries per session (oldest dropped).
 *
 * The caller persists the session (req.session.save) before redirecting.
 */
import crypto from 'node:crypto';

export const SESSION_KEY = 'aquaConnectOAuth';
export const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING = 5;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;          // 32 bytes, base64url, unpadded

export class OAuthFlowError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const b64url = buf => buf.toString('base64url');
const hashState = state => crypto.createHash('sha256').update(state, 'utf8').digest('hex');
export const pkceChallengeS256 = verifier => b64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());

function slot(session, create) {
  if (!session || typeof session !== 'object') throw new OAuthFlowError('NO_SESSION', 'a session is required');
  let s = session[SESSION_KEY];
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    if (!create) return null;
    s = {};
    session[SESSION_KEY] = s;
  }
  return s;
}

/**
 * Start a flow: returns what the authorization URL needs. Stores nothing but
 * the hashed state and the verifier server-side.
 * @returns {{ state: string, codeChallenge: string, codeChallengeMethod: 'S256' }}
 */
export function beginFlow(session, { connectorId, userId, redirectUri, now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (typeof connectorId !== 'string' || !connectorId) throw new OAuthFlowError('BAD_FLOW', 'connectorId required');
  if (typeof userId !== 'string' || !userId) throw new OAuthFlowError('BAD_FLOW', 'userId required');
  if (typeof redirectUri !== 'string' || !redirectUri) throw new OAuthFlowError('BAD_FLOW', 'redirectUri required');
  const s = slot(session, true);
  // Drop expired entries, then bound the rest (oldest first).
  for (const [k, v] of Object.entries(s)) if (!v || typeof v.expiresAt !== 'number' || v.expiresAt <= now) delete s[k];
  const live = Object.entries(s).sort((a, b) => a[1].createdAt - b[1].createdAt);
  while (live.length >= MAX_PENDING) delete s[live.shift()[0]];

  const state = b64url(crypto.randomBytes(32));
  const verifier = b64url(crypto.randomBytes(64));
  s[hashState(state)] = { connectorId, userId, verifier, redirectUri, createdAt: now, expiresAt: now + ttlMs };
  return { state, codeChallenge: pkceChallengeS256(verifier), codeChallengeMethod: 'S256' };
}

/**
 * Consume a callback's state. The entry is deleted FIRST (single use), then
 * checked. Throws OAuthFlowError: STATE_INVALID (malformed/unknown/other
 * session), STATE_EXPIRED, STATE_WRONG_USER, STATE_WRONG_CONNECTOR.
 * @returns {{ verifier: string, redirectUri: string }}
 */
export function consumeFlow(session, { state, connectorId, userId, now = Date.now() } = {}) {
  if (typeof state !== 'string' || !STATE_RE.test(state)) throw new OAuthFlowError('STATE_INVALID', 'OAuth state is missing or malformed');
  const s = slot(session, false);
  const key = hashState(state);
  const entry = s && Object.prototype.hasOwnProperty.call(s, key) ? s[key] : null;
  if (s) delete s[key];                                   // single use: gone before any check
  if (!entry) throw new OAuthFlowError('STATE_INVALID', 'OAuth state is unknown, already used, or from another session');
  if (typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) throw new OAuthFlowError('STATE_EXPIRED', 'OAuth state has expired');
  if (entry.connectorId !== connectorId) throw new OAuthFlowError('STATE_WRONG_CONNECTOR', 'OAuth state was issued for another connector');
  if (typeof userId !== 'string' || entry.userId !== userId) throw new OAuthFlowError('STATE_WRONG_USER', 'OAuth state was issued to another user');
  if (typeof entry.verifier !== 'string' || typeof entry.redirectUri !== 'string') throw new OAuthFlowError('STATE_INVALID', 'OAuth state record is incomplete');
  return { verifier: entry.verifier, redirectUri: entry.redirectUri };
}

/** Number of pending (unexpired) flows in a session — diagnostics/tests only, never their contents. */
export function pendingFlows(session, now = Date.now()) {
  const s = session?.[SESSION_KEY];
  if (!s || typeof s !== 'object') return 0;
  return Object.values(s).filter(v => v && typeof v.expiresAt === 'number' && v.expiresAt > now).length;
}
