/**
 * AQUA Connect — Gmail OAuth configuration (Phase 2A)
 *
 *   AQUA_GMAIL_CONNECT        gate, 'on' enables the /api/aqua/connect routes (default off)
 *   AQUA_GMAIL_CLIENT_ID      OAuth client id (…apps.googleusercontent.com)
 *   AQUA_GMAIL_CLIENT_SECRET  SECRET. Held only inside the transport's closure.
 *   AQUA_GMAIL_REDIRECT_URI   the EXACT redirect URI registered at Google:
 *                             https://<APP_URL host>/api/aqua/connect/gmail/callback
 *
 * The redirect URI is not trusted because it is configured. It must:
 *   · be https (http only for localhost/127.0.0.1 outside production);
 *   · carry no credentials, query or fragment;
 *   · have exactly the path CALLBACK_PATH (the route that exists);
 *   · have the same origin as APP_URL, which production requires: the session
 *     cookie is host-only, so a callback on another host (www., *.onrender.com)
 *     would arrive without the session that holds the OAuth state.
 *
 * Problems are reported by VARIABLE NAME only — never a value.
 */
// The ONE scope Gmail Connect requests and accepts. Defined here (a module with
// no imports, loaded at boot by routes/connect.js); gmailConnector re-exports it.
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const CALLBACK_PATH = '/api/aqua/connect/gmail/callback';
export const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const CLIENT_ID_RE = /^[0-9A-Za-z._-]{1,200}\.apps\.googleusercontent\.com$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The gate. Exact, case-sensitive-free 'on' (registry: ON). */
export function gmailConnectEnabled(env = process.env) {
  return String(env.AQUA_GMAIL_CONNECT ?? '').toLowerCase() === 'on';
}

function checkRedirectUri(raw, env) {
  const problems = [];
  let u;
  try { u = new URL(String(raw)); } catch { return { problems: ['AQUA_GMAIL_REDIRECT_URI is not a URL'] }; }
  const production = String(env.NODE_ENV ?? '').toLowerCase() === 'production';
  const local = LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && !production)) problems.push('AQUA_GMAIL_REDIRECT_URI must be https (http only for localhost outside production)');
  if (local && production) problems.push('AQUA_GMAIL_REDIRECT_URI must not be a local address in production');
  if (u.username || u.password) problems.push('AQUA_GMAIL_REDIRECT_URI must not carry credentials');
  if (u.search || u.hash || String(raw).includes('?') || String(raw).includes('#')) problems.push('AQUA_GMAIL_REDIRECT_URI must not carry a query or fragment');
  if (u.pathname !== CALLBACK_PATH) problems.push(`AQUA_GMAIL_REDIRECT_URI path must be exactly ${CALLBACK_PATH}`);
  if (u.href !== `${u.origin}${CALLBACK_PATH}`) problems.push('AQUA_GMAIL_REDIRECT_URI must be in canonical form (origin + path, nothing else)');
  const appUrl = String(env.APP_URL ?? '').trim();
  if (appUrl) {
    let app = null;
    try { app = new URL(appUrl); } catch { problems.push('APP_URL is not a URL'); }
    if (app && app.origin !== u.origin) problems.push('AQUA_GMAIL_REDIRECT_URI must have the same origin as APP_URL (the session cookie is host-only)');
  } else if (production) {
    problems.push('APP_URL is required in production to verify AQUA_GMAIL_REDIRECT_URI');
  }
  return { problems, uri: problems.length ? null : u.href };
}

/**
 * @returns {{ ok: boolean, problems: string[], config: object|null, transportOptions: object|null }}
 *   config            safe to keep in a route (no secret): { clientId, redirectUri, scope, authorizationUrl() }
 *   transportOptions  { clientId, clientSecret, redirectUri } — hand to createGoogleGmailTransport, do not keep
 */
export function buildGmailOAuth(env = process.env) {
  const problems = [];
  const clientId = String(env.AQUA_GMAIL_CLIENT_ID ?? '').trim();
  const clientSecret = String(env.AQUA_GMAIL_CLIENT_SECRET ?? '').trim();
  const rawRedirect = String(env.AQUA_GMAIL_REDIRECT_URI ?? '').trim();
  if (!clientId) problems.push('AQUA_GMAIL_CLIENT_ID is not set');
  else if (!CLIENT_ID_RE.test(clientId)) problems.push('AQUA_GMAIL_CLIENT_ID is not a Google OAuth client id');
  if (!clientSecret) problems.push('AQUA_GMAIL_CLIENT_SECRET is not set');
  else if (clientSecret.length < 10 || /\s/.test(clientSecret)) problems.push('AQUA_GMAIL_CLIENT_SECRET is malformed');
  let redirectUri = null;
  if (!rawRedirect) problems.push('AQUA_GMAIL_REDIRECT_URI is not set');
  else { const r = checkRedirectUri(rawRedirect, env); problems.push(...r.problems); redirectUri = r.uri; }
  if (problems.length) return { ok: false, problems, config: null, transportOptions: null };

  const config = Object.freeze({
    clientId,
    redirectUri,
    scope: GMAIL_READONLY_SCOPE,
    /** The Google consent URL for one flow (state + S256 challenge from oauth/oauthFlow.js). */
    authorizationUrl({ state, codeChallenge }) {
      const u = new URL(GOOGLE_AUTHORIZATION_URL);
      u.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GMAIL_READONLY_SCOPE,            // ONLY read-only Gmail — no openid/email/profile
        access_type: 'offline',                 // a refresh token
        prompt: 'consent',                      // always show consent → a refresh token on every connect
        include_granted_scopes: 'false',        // never merge with other grants of this client (e.g. sign-in)
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      return u.href;
    },
    toJSON() { return { clientId: '[configured]', redirectUri, scope: GMAIL_READONLY_SCOPE }; },
  });
  return { ok: true, problems: [], config, transportOptions: { clientId, clientSecret, redirectUri } };
}
