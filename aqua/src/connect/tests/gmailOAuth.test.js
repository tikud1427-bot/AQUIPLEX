/**
 * Connect Phase 2A — Gmail OAuth infrastructure, proven with MOCK exchanges only.
 *
 *   routes/connect.js            start / callback / connections (a real express app on 127.0.0.1)
 *   connect/oauth/oauthFlow.js   session-bound state + PKCE S256
 *   connect/gmail/gmailOAuthConfig.js   exact redirect URI, env names only in problems
 *   connect/gmail/googleGmailTransport.js   the REAL transport over a FAKE fetch (no network)
 *   connect/credentialVault.js   key rotation (current + previous keys)
 *   connectService               rotateCredentials, lazy reseal, refresh, revoke, disconnect
 *
 * Isolation: testkit (temporary AQUA_DATA_DIR, env stripped, no DATABASE_URL, no
 * Mongo, in-memory connection store). Every non-loopback fetch and every
 * http(s).request is recorded and refused: no Google, no AI provider.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const K = await import('./testkit.js');

// ── network tripwire (installed before anything could dial out) ──────────────
const egress = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.hostname !== '127.0.0.1') { egress.push(`fetch ${u.host}`); throw new Error('network refused in tests'); }
  return realFetch(url, init);
};
for (const mod of [http, https]) {
  const orig = mod.request;
  mod.request = function (opts, ...rest) {
    const host = typeof opts === 'string' ? new URL(opts).hostname : opts?.hostname ?? opts?.host ?? (opts instanceof URL ? opts.hostname : '');
    if (host && host !== '127.0.0.1' && host !== 'localhost') { egress.push(`${mod === https ? 'https' : 'http'} ${host}`); throw new Error('network refused in tests'); }
    return orig.call(this, opts, ...rest);
  };
}

// ── log capture (console + the router/service logs) ───────────────────────────
const logged = [];
const capture = (...a) => logged.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
for (const m of ['log', 'warn', 'error', 'info', 'debug']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { capture(...a); if (process.env.GMAIL_OAUTH_TEST_VERBOSE) orig(...a); };
}
const routerLog = { log: capture, warn: capture, error: capture };

const express = (await import('express')).default;
const { createGmailConnector, GMAIL_READONLY_SCOPE } = await import('../gmail/gmailConnector.js');
const { createMockGmailService } = await import('../testing/mockGmailTransport.js');
const { buildGmailOAuth, CALLBACK_PATH, gmailConnectEnabled } = await import('../gmail/gmailOAuthConfig.js');
const { createGoogleGmailTransport } = await import('../gmail/googleGmailTransport.js');
const { beginFlow, consumeFlow, pkceChallengeS256, SESSION_KEY, MAX_PENDING } = await import('../oauth/oauthFlow.js');
const { createConnectRouter, productionConnectDeps, _resetProductionConnectDepsForTests } = await import('../../routes/connect.js');
const { principalForServerJob } = await import('../principal.js');
const { vaultFromEnv, createUnavailableVault } = await import('../credentialVault.js');
const DC = await import('../../core/dataClass.js');

const ORIGIN = 'https://aquiplex.com';
const REDIRECT = `${ORIGIN}${CALLBACK_PATH}`;
const CLIENT_ID = '1234567890-abcdefg.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-only-CLIENTSECRET-9f8e7d';
const ENV = Object.freeze({ AQUA_GMAIL_CONNECT: 'on', AQUA_GMAIL_CLIENT_ID: CLIENT_ID, AQUA_GMAIL_CLIENT_SECRET: CLIENT_SECRET, AQUA_GMAIL_REDIRECT_URI: REDIRECT, APP_URL: ORIGIN, NODE_ENV: 'production' });
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

const secretsSeen = new Set([CLIENT_SECRET]);   // every code / state / verifier / token a test handled
const wire = [];                                 // every response body + Location header

// ── a full stack: mock Google + connect service + routes on a loopback server ─
async function oauthStack({ vault = null, store = null, getDeps = null } = {}) {
  let t = Date.now();
  const clock = { now: () => t, advance: ms => { t += ms; } };
  const mock = createMockGmailService({ now: clock.now });
  const registry = K.createConnectorRegistry({ allowTestOnly: true });
  registry.register(createGmailConnector({ transport: mock.transport }));
  store ??= K.createMemoryConnectionStore();
  vault ??= K.createCredentialVault({ key: K.TEST_KEY });
  const service = K.createConnectService({ registry, store, vault, retry: { sleep: async () => {}, baseMs: 0 }, log: routerLog, now: clock.now });
  const built = buildGmailOAuth(ENV);
  assert.equal(built.ok, true, built.problems.join('; '));

  const sessions = new Map();
  const app = express();
  app.set('trust proxy', 1);
  app.use((req, res, next) => {        // stands in for express-session + requireLogin + aquaAccess
    const sid = req.get('x-sid') ?? 'none';
    if (!sessions.has(sid)) { const s = {}; Object.defineProperty(s, 'save', { value: cb => cb(), enumerable: false }); sessions.set(sid, s); }
    req.session = sessions.get(sid);
    if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
    req.aquaUserId = String(req.session.userId);
    next();
  });
  app.use('/api/aqua/connect', createConnectRouter({ getDeps: getDeps ?? (async () => ({ gmail: built.config, service, vault })), now: clock.now, log: routerLog }));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(path, sid, { method = 'GET' } = {}) {
    const r = await fetch(`${base}${path}`, { method, headers: { 'x-sid': sid }, redirect: 'manual' });
    const text = await r.text();
    const location = r.headers.get('location');
    wire.push(text, location ?? '');
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: r.status, location, headers: r.headers, body, text };
  }
  const login = (sid, userId) => { if (!sessions.has(sid)) { const s = {}; Object.defineProperty(s, 'save', { value: cb => cb(), enumerable: false }); sessions.set(sid, s); } sessions.get(sid).userId = userId; };
  async function start(sid) {
    const r = await call('/api/aqua/connect/gmail/start', sid);
    assert.equal(r.status, 302, r.text);
    const u = new URL(r.location);
    const p = Object.fromEntries(u.searchParams);
    secretsSeen.add(p.state);
    for (const v of Object.values(sessions.get(sid)[SESSION_KEY] ?? {})) secretsSeen.add(v.verifier);
    return { url: u, p, res: r };
  }
  /** What Google's consent screen would do: a code bound to the request's redirect URI and challenge. */
  function consent(p, { email = 'owner@example.test', scopes = [GMAIL_READONLY_SCOPE] } = {}) {
    const code = mock.authorizeCode(email, { redirectUri: p.redirect_uri, codeChallenge: p.code_challenge, scopes });
    secretsSeen.add(code);
    return code;
  }
  const callback = (sid, q) => call(`/api/aqua/connect/gmail/callback?${new URLSearchParams(q)}`, sid);
  const outcomeOf = r => { assert.equal(r.status, 303, r.text); const u = new URL(r.location, ORIGIN); return { result: u.searchParams.get('gmailConnect'), reason: u.searchParams.get('reason'), path: u.pathname }; };
  const exchanges = () => mock.calls.filter(c => c.op === 'exchangeCode').length;
  const close = () => new Promise(r => server.close(r));
  return { mock, service, store, vault, clock, sessions, call, login, start, consent, callback, outcomeOf, exchanges, close, config: built.config };
}

const trackTokens = async (store, ownerId, vault) => {
  for (const c of await store.listByOwner(ownerId)) {
    if (!c.credentials) continue;
    try { const o = vault.open(c.credentials, { ownerId: c.ownerId, connectionId: c.connectionId, connectorId: c.connectorId }); for (const v of Object.values(o)) if (v) secretsSeen.add(v); } catch { /* other key */ }
  }
};

// ══════════════════════════════════════════════════════════════════════════════
describe('Gmail OAuth configuration — exact redirect URI, names never values', () => {
  test('the approved production configuration is accepted; the consent URL requests ONLY gmail.readonly, offline, consent, PKCE S256', () => {
    const b = buildGmailOAuth(ENV);
    assert.equal(b.ok, true);
    assert.equal(b.config.redirectUri, 'https://aquiplex.com/api/aqua/connect/gmail/callback');
    const u = new URL(b.config.authorizationUrl({ state: 's'.repeat(43), codeChallenge: 'c'.repeat(43) }));
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    const p = Object.fromEntries(u.searchParams);
    assert.deepEqual(p, {
      client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: GMAIL_READONLY_SCOPE,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false',
      state: 's'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256',
    });
    assert.ok(!u.href.includes(CLIENT_SECRET), 'the client secret is never in a URL');
    assert.ok(!JSON.stringify(b.config).includes(CLIENT_SECRET), 'the safe config never serialises the secret');
  });

  const bad = [
    ['http in production', { AQUA_GMAIL_REDIRECT_URI: 'http://aquiplex.com/api/aqua/connect/gmail/callback' }, /https/],
    ['another host than APP_URL (www.)', { AQUA_GMAIL_REDIRECT_URI: 'https://www.aquiplex.com/api/aqua/connect/gmail/callback' }, /same origin as APP_URL/],
    ['the Render host', { AQUA_GMAIL_REDIRECT_URI: 'https://aquiplex.onrender.com/api/aqua/connect/gmail/callback' }, /same origin as APP_URL/],
    ['another path', { AQUA_GMAIL_REDIRECT_URI: 'https://aquiplex.com/auth/google/callback' }, /path must be exactly/],
    ['the /v1 alias', { AQUA_GMAIL_REDIRECT_URI: 'https://aquiplex.com/v1/connect/gmail/callback' }, /path must be exactly/],
    ['a trailing slash', { AQUA_GMAIL_REDIRECT_URI: 'https://aquiplex.com/api/aqua/connect/gmail/callback/' }, /path must be exactly/],
    ['a query', { AQUA_GMAIL_REDIRECT_URI: `${REDIRECT}?x=1` }, /query or fragment/],
    ['a fragment', { AQUA_GMAIL_REDIRECT_URI: `${REDIRECT}#x` }, /query or fragment/],
    ['credentials in the URL', { AQUA_GMAIL_REDIRECT_URI: 'https://u:p@aquiplex.com/api/aqua/connect/gmail/callback' }, /credentials/],
    ['a non-default port', { AQUA_GMAIL_REDIRECT_URI: 'https://aquiplex.com:8443/api/aqua/connect/gmail/callback' }, /same origin as APP_URL/],
    ['localhost in production', { AQUA_GMAIL_REDIRECT_URI: 'http://localhost:5055/api/aqua/connect/gmail/callback', APP_URL: 'http://localhost:5055' }, /local address in production|https/],
    ['no APP_URL in production', { APP_URL: '' }, /APP_URL is required/],
    ['a malformed client id', { AQUA_GMAIL_CLIENT_ID: 'not-a-client' }, /client id/],
    ['no client secret', { AQUA_GMAIL_CLIENT_SECRET: '' }, /CLIENT_SECRET is not set/],
  ];
  for (const [label, over, re] of bad) {
    test(`refused: ${label}`, () => {
      const b = buildGmailOAuth({ ...ENV, ...over });
      assert.equal(b.ok, false);
      assert.equal(b.config, null);
      assert.equal(b.transportOptions, null);
      assert.match(b.problems.join(' | '), re);
      assert.ok(!b.problems.join(' ').includes(CLIENT_SECRET), 'problems name variables, never values');
    });
  }

  test('localhost http is allowed only outside production (local testing)', () => {
    const b = buildGmailOAuth({ ...ENV, NODE_ENV: 'development', APP_URL: 'http://localhost:5055', AQUA_GMAIL_REDIRECT_URI: 'http://localhost:5055/api/aqua/connect/gmail/callback' });
    assert.equal(b.ok, true, b.problems.join('; '));
  });

  test('boot-time imports stay light: the config and state modules import nothing that builds a transport, store or service', async () => {
    const fs = await import('node:fs');
    const rd = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.doesNotMatch(rd('../gmail/gmailOAuthConfig.js'), /^import /m);
    assert.deepEqual([...rd('../oauth/oauthFlow.js').matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]), ['node:crypto']);
    const { GMAIL_READONLY_SCOPE: fromConfig } = await import('../gmail/gmailOAuthConfig.js');
    assert.equal(fromConfig, GMAIL_READONLY_SCOPE);
    assert.equal(GMAIL_READONLY_SCOPE, 'https://www.googleapis.com/auth/gmail.readonly');
  });

  test('the gate is off unless exactly on (any case)', () => {
    assert.equal(gmailConnectEnabled({}), false);
    for (const v of ['1', 'true', 'yes', 'enabled', ' on']) assert.equal(gmailConnectEnabled({ AQUA_GMAIL_CONNECT: v }), false, v);
    assert.equal(gmailConnectEnabled({ AQUA_GMAIL_CONNECT: 'ON' }), true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('OAuth state + PKCE (unit)', () => {
  const S = () => ({});
  test('state and verifier are random and well-formed; challenge = base64url(sha256(verifier)); only the HASHED state is stored', () => {
    const s = S();
    const a = beginFlow(s, { connectorId: 'gmail', userId: 'u1', redirectUri: REDIRECT });
    const b = beginFlow(s, { connectorId: 'gmail', userId: 'u1', redirectUri: REDIRECT });
    assert.match(a.state, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a.state, b.state);
    assert.equal(a.codeChallengeMethod, 'S256');
    const entries = Object.entries(s[SESSION_KEY]);
    assert.equal(entries.length, 2);
    assert.ok(!JSON.stringify(s).includes(a.state), 'raw state never stored');
    const verifier = entries.find(([k]) => k === crypto.createHash('sha256').update(a.state).digest('hex'))[1].verifier;
    assert.match(verifier, /^[A-Za-z0-9_-]{86}$/);
    assert.equal(a.codeChallenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
    assert.equal(pkceChallengeS256(verifier), a.codeChallenge);
  });

  test('single use: the entry is gone after the first consume, even a failing one', () => {
    const s = S();
    const a = beginFlow(s, { connectorId: 'gmail', userId: 'u1', redirectUri: REDIRECT });
    assert.throws(() => consumeFlow(s, { state: a.state, connectorId: 'gmail', userId: 'someone-else' }), e => e.code === 'STATE_WRONG_USER');
    assert.throws(() => consumeFlow(s, { state: a.state, connectorId: 'gmail', userId: 'u1' }), e => e.code === 'STATE_INVALID', 'a failed check still burns the state');
  });

  test('expired, wrong connector, malformed, unknown, no session', () => {
    const s = S();
    const t0 = 1_000_000;
    const a = beginFlow(s, { connectorId: 'gmail', userId: 'u1', redirectUri: REDIRECT, now: t0, ttlMs: 1000 });
    assert.throws(() => consumeFlow(s, { state: a.state, connectorId: 'gmail', userId: 'u1', now: t0 + 1000 }), e => e.code === 'STATE_EXPIRED');
    const b = beginFlow(s, { connectorId: 'gmail', userId: 'u1', redirectUri: REDIRECT });
    assert.throws(() => consumeFlow(s, { state: b.state, connectorId: 'drive', userId: 'u1' }), e => e.code === 'STATE_WRONG_CONNECTOR');
    for (const bad of [undefined, '', 'short', 'x'.repeat(44), ['a'], 'a'.repeat(42) + '!']) {
      assert.throws(() => consumeFlow(s, { state: bad, connectorId: 'gmail', userId: 'u1' }), e => e.code === 'STATE_INVALID');
    }
    assert.throws(() => consumeFlow(s, { state: 'A'.repeat(43), connectorId: 'gmail', userId: 'u1' }), e => e.code === 'STATE_INVALID');
    assert.throws(() => beginFlow(null, { connectorId: 'gmail', userId: 'u1', redirectUri: REDIRECT }), e => e.code === 'NO_SESSION');
  });

  test(`at most ${MAX_PENDING} pending flows per session (oldest dropped)`, () => {
    const s = S();
    const states = [];
    for (let i = 0; i < MAX_PENDING + 2; i++) states.push(beginFlow(s, { connectorId: 'gmail', userId: 'u1', redirectUri: REDIRECT, now: 1000 + i }).state);
    assert.equal(Object.keys(s[SESSION_KEY]).length, MAX_PENDING);
    assert.throws(() => consumeFlow(s, { state: states[0], connectorId: 'gmail', userId: 'u1', now: 2000 }), e => e.code === 'STATE_INVALID');
    assert.ok(consumeFlow(s, { state: states.at(-1), connectorId: 'gmail', userId: 'u1', now: 2000 }).verifier);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('routes: the OAuth flow end to end over the mock Google', () => {
  let S;
  before(async () => { S = await oauthStack(); });
  after(async () => { await S.close(); });

  test('start: 302 to Google with the exact redirect URI, readonly scope, offline, consent, S256; no-store; the verifier stays server-side', async () => {
    S.login('s-start', 'user-start');
    const { url, p, res } = await S.start('s-start');
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(p.redirect_uri, REDIRECT);
    assert.equal(p.scope, GMAIL_READONLY_SCOPE);
    assert.equal(p.access_type, 'offline');
    assert.equal(p.prompt, 'consent');
    assert.equal(p.code_challenge_method, 'S256');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const [entry] = Object.values(S.sessions.get('s-start')[SESSION_KEY]);
    assert.ok(!url.href.includes(entry.verifier), 'the verifier is never sent to the browser');
    assert.equal(p.code_challenge, pkceChallengeS256(entry.verifier));
    assert.equal(entry.userId, 'user-start');
  });

  test('valid state → the code is exchanged with the exact redirect URI and the PKCE verifier; credentials are sealed; views carry no secret', async () => {
    S.login('s-ok', 'user-ok');
    const { p } = await S.start('s-ok');
    const code = S.consent(p, { email: 'owner.ok@example.test' });
    const before = S.exchanges();
    const out = S.outcomeOf(await S.callback('s-ok', { state: p.state, code, scope: GMAIL_READONLY_SCOPE }));
    assert.deepEqual(out, { result: 'connected', reason: null, path: '/aqua/email' });
    assert.equal(S.exchanges(), before + 1);
    const ex = S.mock.calls.filter(c => c.op === 'exchangeCode').at(-1);
    assert.equal(ex.redirectUri, REDIRECT);
    assert.equal(ex.pkce, true);
    const list = await S.call('/api/aqua/connect/connections', 's-ok');
    assert.equal(list.status, 200);
    assert.equal(list.body.connections.length, 1);
    const view = list.body.connections[0];
    assert.equal(view.connectorId, 'gmail');
    assert.equal(view.status, 'active');
    assert.deepEqual(view.scopes, [GMAIL_READONLY_SCOPE]);
    assert.equal(view.hasCredentials, true);
    assert.equal(view.account.label, 'Gmail · o***@example.test');
    assert.ok(!list.text.includes('SECRETVALUE') && !list.text.includes('owner.ok@'), 'no token or full address in the response');
    const [rec] = await S.store.listByOwner('user:user-ok');
    assert.deepEqual(Object.keys(rec.credentials).sort(), ['alg', 'ct', 'iv', 'keyId', 'tag', 'v']);
    assert.ok(!JSON.stringify(rec).includes('SECRETVALUE'), 'only the sealed envelope is stored');
    await trackTokens(S.store, 'user:user-ok', S.vault);
    assert.equal(Object.keys(S.sessions.get('s-ok')[SESSION_KEY]).length, 0, 'the flow entry is consumed');
  });

  test('invalid, missing and forged state: refused BEFORE any exchange', async () => {
    S.login('s-bad', 'user-bad');
    const { p } = await S.start('s-bad');
    const code = S.consent(p);
    const before = S.exchanges();
    for (const q of [{ code }, { state: '', code }, { state: 'x', code }, { state: crypto.randomBytes(32).toString('base64url'), code }]) {
      assert.equal(S.outcomeOf(await S.callback('s-bad', q)).reason, 'STATE_INVALID');
    }
    const dup = await S.call(`/api/aqua/connect/gmail/callback?state=${p.state}&state=${p.state}&code=${code}`, 's-bad');
    assert.equal(S.outcomeOf(dup).reason, 'STATE_INVALID', 'a repeated state parameter is not a string');
    assert.equal(S.exchanges(), before, 'no code was exchanged');
    assert.equal((await S.call('/api/aqua/connect/connections', 's-bad')).body.connections.length, 0);
  });

  test('expired state: refused, nothing exchanged', async () => {
    S.login('s-exp', 'user-exp');
    const { p } = await S.start('s-exp');
    const code = S.consent(p);
    S.clock.advance(10 * 60 * 1000 + 1);
    const before = S.exchanges();
    assert.equal(S.outcomeOf(await S.callback('s-exp', { state: p.state, code })).reason, 'STATE_EXPIRED');
    assert.equal(S.exchanges(), before);
  });

  test('reused state (a replayed callback): refused, exchanged once only', async () => {
    S.login('s-replay', 'user-replay');
    const { p } = await S.start('s-replay');
    const code = S.consent(p);
    const before = S.exchanges();
    assert.equal(S.outcomeOf(await S.callback('s-replay', { state: p.state, code })).result, 'connected');
    assert.equal(S.outcomeOf(await S.callback('s-replay', { state: p.state, code })).reason, 'STATE_INVALID');
    assert.equal(S.exchanges(), before + 1);
    assert.equal((await S.call('/api/aqua/connect/connections', 's-replay')).body.connections.length, 1);
    await trackTokens(S.store, 'user:user-replay', S.vault);
  });

  test('state from another session is unknown here (login-CSRF / callback hand-off refused)', async () => {
    S.login('s-attacker', 'user-attacker');
    S.login('s-victim', 'user-victim');
    const { p } = await S.start('s-attacker');
    const code = S.consent(p, { email: 'attacker@example.test' });
    const before = S.exchanges();
    assert.equal(S.outcomeOf(await S.callback('s-victim', { state: p.state, code })).reason, 'STATE_INVALID');
    assert.equal(S.exchanges(), before);
    assert.equal((await S.call('/api/aqua/connect/connections', 's-victim')).body.connections.length, 0);
  });

  test('stale callback: the session changed user between start and callback → refused, nothing exchanged', async () => {
    S.login('s-stale', 'user-first');
    const { p } = await S.start('s-stale');
    const code = S.consent(p);
    S.login('s-stale', 'user-second');                     // sign-out + sign-in as someone else on the same browser
    const before = S.exchanges();
    assert.equal(S.outcomeOf(await S.callback('s-stale', { state: p.state, code })).reason, 'STATE_WRONG_USER');
    assert.equal(S.exchanges(), before);
    assert.equal((await S.store.listByOwner('user:user-second')).length, 0);
    assert.equal((await S.store.listByOwner('user:user-first')).length, 0);
  });

  test('PKCE: an attacker\'s code (bound to the attacker\'s challenge) injected into the victim\'s valid flow fails the exchange', async () => {
    S.login('s-pkce-a', 'user-pkce-attacker');
    S.login('s-pkce-v', 'user-pkce-victim');
    const atk = await S.start('s-pkce-a');
    const atkCode = S.consent(atk.p, { email: 'attacker@example.test' });
    const vic = await S.start('s-pkce-v');
    const out = S.outcomeOf(await S.callback('s-pkce-v', { state: vic.p.state, code: atkCode }));
    assert.equal(out.result, 'failed');
    assert.equal(out.reason, 'CONNECT_FAILED');
    assert.equal((await S.store.listByOwner('user:user-pkce-victim')).length, 0);
  });

  test('exact redirect URI: a code issued for another redirect URI fails the exchange', async () => {
    S.login('s-ru', 'user-ru');
    const { p } = await S.start('s-ru');
    const code = S.consent({ ...p, redirect_uri: 'https://evil.example.test/cb' });
    assert.equal(S.outcomeOf(await S.callback('s-ru', { state: p.state, code })).result, 'failed');
    assert.equal((await S.store.listByOwner('user:user-ru')).length, 0);
  });

  test('a flow started under another redirect URI (config changed) is refused before the exchange', async () => {
    S.login('s-cfg', 'user-cfg');
    const { p } = await S.start('s-cfg');
    const [entry] = Object.values(S.sessions.get('s-cfg')[SESSION_KEY]);
    entry.redirectUri = 'https://old.example.test/api/aqua/connect/gmail/callback';
    const before = S.exchanges();
    assert.equal(S.outcomeOf(await S.callback('s-cfg', { state: p.state, code: S.consent(p) })).reason, 'CONFIG_CHANGED');
    assert.equal(S.exchanges(), before);
  });

  test('authorization-code exchange failures (invalid_grant, 5xx, timeout-like): failed, no connection, state consumed', async () => {
    for (const [i, status] of [400, 500, 503].entries()) {
      const sid = `s-exfail-${i}`;
      S.login(sid, `user-exfail-${i}`);
      const { p } = await S.start(sid);
      const code = S.consent(p);
      S.mock.failNext('exchangeCode', status);
      const out = S.outcomeOf(await S.callback(sid, { state: p.state, code }));
      assert.equal(out.result, 'failed');
      assert.ok(['AUTH_FAILED', 'CONNECT_FAILED'].includes(out.reason), out.reason);
      assert.equal((await S.store.listByOwner(`user:user-exfail-${i}`)).length, 0);
      assert.equal(S.outcomeOf(await S.callback(sid, { state: p.state, code })).reason, 'STATE_INVALID', 'no retry with the same state');
    }
  });

  test('missing or malformed code; the user declined (access_denied): state consumed, nothing exchanged', async () => {
    S.login('s-deny', 'user-deny');
    const before = S.exchanges();
    let f = await S.start('s-deny');
    assert.deepEqual(S.outcomeOf(await S.callback('s-deny', { state: f.p.state, error: 'access_denied' })), { result: 'denied', reason: 'PROVIDER_ERROR', path: '/aqua/email' });
    f = await S.start('s-deny');
    assert.equal(S.outcomeOf(await S.callback('s-deny', { state: f.p.state })).reason, 'CODE_MISSING');
    f = await S.start('s-deny');
    assert.equal(S.outcomeOf(await S.callback('s-deny', { state: f.p.state, code: 'has space' })).reason, 'CODE_MISSING');
    assert.equal(S.exchanges(), before);
  });

  test('scope escalation: a grant with gmail.modify is refused and revoked at the provider; a grant without read-only is refused too', async () => {
    for (const [i, scopes, reason] of [[0, [GMAIL_READONLY_SCOPE, MODIFY], 'AUTH_FAILED'], [1, [MODIFY], 'AUTH_FAILED'], [2, ['openid', 'email'], 'AUTH_FAILED'], [3, [], 'AUTH_FAILED']]) {
      const sid = `s-scope-${i}`;
      S.login(sid, `user-scope-${i}`);
      const { p } = await S.start(sid);
      const revokesBefore = S.mock.calls.filter(c => c.op === 'revoke').length;
      const out = S.outcomeOf(await S.callback(sid, { state: p.state, code: S.consent(p, { scopes }) }));
      assert.equal(out.result, 'failed');
      assert.equal(out.reason, reason);
      assert.equal(S.mock.calls.filter(c => c.op === 'revoke').length, revokesBefore + 1, 'the over/under-scoped grant is revoked');
      assert.equal((await S.store.listByOwner(`user:user-scope-${i}`)).length, 0);
    }
  });

  test('owner isolation: another user can neither see, revoke nor delete a connection', async () => {
    S.login('s-iso-a', 'user-iso-a');
    S.login('s-iso-b', 'user-iso-b');
    const { p } = await S.start('s-iso-a');
    assert.equal(S.outcomeOf(await S.callback('s-iso-a', { state: p.state, code: S.consent(p) })).result, 'connected');
    await trackTokens(S.store, 'user:user-iso-a', S.vault);
    const [conn] = (await S.call('/api/aqua/connect/connections', 's-iso-a')).body.connections;
    assert.equal((await S.call('/api/aqua/connect/connections', 's-iso-b')).body.connections.length, 0);
    assert.equal((await S.call(`/api/aqua/connect/connections/${conn.connectionId}/revoke`, 's-iso-b', { method: 'POST' })).status, 404);
    assert.equal((await S.call(`/api/aqua/connect/connections/${conn.connectionId}`, 's-iso-b', { method: 'DELETE' })).status, 404);
    const still = (await S.call('/api/aqua/connect/connections', 's-iso-a')).body.connections;
    assert.equal(still.length, 1);
    assert.equal(still[0].status, 'active');
    // A user id smuggled in the query/body is never used.
    assert.equal((await S.call('/api/aqua/connect/connections?userId=user-iso-a&ownerId=user:user-iso-a', 's-iso-b')).body.connections.length, 0);
  });

  test('revocation: revoked at Google, credentials wiped, knowledge kept; disconnect deletes the record', async () => {
    S.login('s-rev', 'user-rev');
    const { p } = await S.start('s-rev');
    assert.equal(S.outcomeOf(await S.callback('s-rev', { state: p.state, code: S.consent(p, { email: 'rev@example.test' }) })).result, 'connected');
    const [rec] = await S.store.listByOwner('user:user-rev');
    const creds = S.vault.open(rec.credentials, { ownerId: rec.ownerId, connectionId: rec.connectionId, connectorId: 'gmail' });
    secretsSeen.add(creds.accessToken); secretsSeen.add(creds.refreshToken);
    const r = await S.call(`/api/aqua/connect/connections/${rec.connectionId}/revoke`, 's-rev', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(r.body.providerRevocation, 'revoked');
    assert.equal(r.body.localCredentialsDeleted, true);
    assert.equal(r.body.connection.status, 'revoked');
    assert.equal(r.body.connection.hasCredentials, false);
    assert.equal(S.mock.grantRevoked(creds.refreshToken), true);
    const d = await S.call(`/api/aqua/connect/connections/${rec.connectionId}`, 's-rev', { method: 'DELETE' });
    assert.equal(d.status, 200);
    assert.equal(d.body.deleted, true);
    assert.equal(d.body.providerRevocation, 'not_attempted', 'nothing left to revoke — reported, not claimed');
    assert.equal((await S.call('/api/aqua/connect/connections', 's-rev')).body.connections.length, 0);
  });

  test('disconnect of an active connection revokes at Google and removes it', async () => {
    S.login('s-dis', 'user-dis');
    const { p } = await S.start('s-dis');
    assert.equal(S.outcomeOf(await S.callback('s-dis', { state: p.state, code: S.consent(p) })).result, 'connected');
    const [rec] = await S.store.listByOwner('user:user-dis');
    const creds = S.vault.open(rec.credentials, { ownerId: rec.ownerId, connectionId: rec.connectionId, connectorId: 'gmail' });
    secretsSeen.add(creds.accessToken); secretsSeen.add(creds.refreshToken);
    const d = await S.call(`/api/aqua/connect/connections/${rec.connectionId}`, 's-dis', { method: 'DELETE' });
    assert.equal(d.body.deleted, true);
    assert.equal(d.body.providerRevocation, 'revoked');
    assert.equal(S.mock.grantRevoked(creds.accessToken), true);
    assert.equal((await S.store.listByOwner('user:user-dis')).length, 0);
  });

  test('unauthenticated callers get 401 and no flow; malformed connection ids 404', async () => {
    assert.equal((await S.call('/api/aqua/connect/gmail/start', 's-anon')).status, 401);
    assert.equal((await S.call('/api/aqua/connect/gmail/callback?state=x&code=y', 's-anon')).status, 401);
    S.login('s-ids', 'user-ids');
    assert.equal((await S.call('/api/aqua/connect/connections/../../x/revoke', 's-ids', { method: 'POST' })).status, 404);
    assert.equal((await S.call('/api/aqua/connect/connections/conn_zz', 's-ids', { method: 'DELETE' })).status, 404);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('routes: off by default, fail closed', () => {
  test('gate off (or config incomplete) → every route 404, nothing loaded or stored', async () => {
    const S = await oauthStack({ getDeps: async () => ({ gmail: null }) });
    try {
      S.login('s-off', 'user-off');
      for (const [path, method] of [['/api/aqua/connect/gmail/start', 'GET'], ['/api/aqua/connect/gmail/callback?state=a&code=b', 'GET'], ['/api/aqua/connect/connections', 'GET'], ['/api/aqua/connect/connections/conn_00000000000000000000', 'DELETE']]) {
        assert.equal((await S.call(path, 's-off', { method })).status, 404, path);
      }
      assert.equal(S.sessions.get('s-off')[SESSION_KEY], undefined);
    } finally { await S.close(); }
  });

  test('production wiring: disabled when unset; misconfigured names variables only, never values', async () => {
    const warns = [];
    _resetProductionConnectDepsForTests();
    assert.deepEqual(await productionConnectDeps({}, { warn: m => warns.push(m), log() {} }), { gmail: null, reason: 'disabled' });
    _resetProductionConnectDepsForTests();
    const d = await productionConnectDeps({ AQUA_GMAIL_CONNECT: 'on', AQUA_GMAIL_CLIENT_SECRET: CLIENT_SECRET }, { warn: m => warns.push(m), log() {} });
    assert.equal(d.gmail, null);
    assert.equal(d.reason, 'misconfigured');
    assert.match(warns.join('\n'), /AQUA_GMAIL_CLIENT_ID is not set/);
    assert.ok(!warns.join('\n').includes(CLIENT_SECRET));
    _resetProductionConnectDepsForTests();
  });

  test('credential key unavailable → start refuses before Google (503), no flow stored', async () => {
    const S = await oauthStack({ vault: createUnavailableVault('KEY_MISSING') });
    try {
      S.login('s-nokey', 'user-nokey');
      const r = await S.call('/api/aqua/connect/gmail/start', 's-nokey');
      assert.equal(r.status, 503);
      assert.equal(r.body.reason, 'CREDENTIAL_KEY_UNAVAILABLE');
      assert.equal(r.location, null);
      assert.equal(S.sessions.get('s-nokey')[SESSION_KEY], undefined);
    } finally { await S.close(); }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('refresh-token handling', () => {
  test('an expiring token is refreshed through the transport and resealed; a refresh stating broader scopes is refused (needs_reauth); a revoked grant → needs_reauth', async () => {
    const S = await oauthStack();
    try {
      S.login('s-ref', 'user-ref');
      const { p } = await S.start('s-ref');
      assert.equal(S.outcomeOf(await S.callback('s-ref', { state: p.state, code: S.consent(p, { email: 'ref@example.test' }) })).result, 'connected');
      const principal = principalForServerJob('user-ref');
      const [c0] = await S.store.listByOwner('user:user-ref');
      const binding = { ownerId: c0.ownerId, connectionId: c0.connectionId, connectorId: 'gmail' };
      const creds0 = S.vault.open(c0.credentials, binding);
      secretsSeen.add(creds0.accessToken); secretsSeen.add(creds0.refreshToken);

      S.clock.advance(3_600_000);                                   // the access token expires
      const r1 = await S.service.sync({ principal, connectionId: c0.connectionId });
      assert.notEqual(r1.status, 'needs_reauth');
      assert.equal(S.mock.calls.filter(c => c.op === 'refresh').length, 1);
      const [c1] = await S.store.listByOwner('user:user-ref');
      const creds1 = S.vault.open(c1.credentials, binding);
      secretsSeen.add(creds1.accessToken);
      assert.notEqual(creds1.accessToken, creds0.accessToken, 'a new access token');
      assert.equal(creds1.refreshToken, creds0.refreshToken, 'the refresh token is kept when Google does not rotate it');
      assert.ok(c1.credentialsExpireAt > S.clock.now());

      S.mock.setRefreshScopes([GMAIL_READONLY_SCOPE, MODIFY]);
      S.clock.advance(3_600_000);
      await assert.rejects(S.service.sync({ principal, connectionId: c0.connectionId }), e => e.code === 'NEEDS_REAUTH');
      assert.equal((await S.service.getConnection({ principal, connectionId: c0.connectionId })).status, 'needs_reauth');
    } finally { await S.close(); }
  });

  test('connector.refresh: no refresh token / refused refresh → AUTH; readonly-only refresh accepted', async () => {
    const mock = createMockGmailService();
    const c = createGmailConnector({ transport: mock.transport });
    await assert.rejects(c.refresh({ accessToken: 'a' }), e => e.kind === 'AUTH');
    await assert.rejects(c.refresh({ accessToken: 'a', refreshToken: 'unknown' }), e => e.kind !== undefined);
    const code = mock.authorizeCode('x@example.test');
    const conn = await c.connect({ code });
    mock.setRefreshScopes([GMAIL_READONLY_SCOPE]);
    const r = await c.refresh(conn.credentials);
    assert.ok(r.credentials.accessToken);
    mock.setRefreshScopes([]);
    await assert.rejects(c.refresh(conn.credentials), e => e.kind === 'AUTH');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('credential encryption and key rotation', () => {
  const bind = { ownerId: 'user:r1', connectionId: 'conn_0123456789abcdef0123', connectorId: 'gmail' };
  const A = crypto.randomBytes(32), B = crypto.randomBytes(32), C = crypto.randomBytes(32);

  test('current key seals; previous keys open only; needsReseal/reseal move a record to the current key', () => {
    const va = K.createCredentialVault({ key: A });
    const sealedA = va.seal({ refreshToken: 'rt-ROTATE-SECRET' }, bind);
    const vb = K.createCredentialVault({ key: B, previousKeys: [A] });
    assert.deepEqual(vb.previousKeyIds, [va.keyId]);
    assert.equal(vb.needsReseal(sealedA), true);
    assert.deepEqual(vb.open(sealedA, bind), { refreshToken: 'rt-ROTATE-SECRET' });
    const sealedB = vb.reseal(sealedA, bind);
    assert.equal(sealedB.keyId, vb.keyId);
    assert.equal(vb.needsReseal(sealedB), false);
    assert.notEqual(sealedB.ct, sealedA.ct);
    const bOnly = K.createCredentialVault({ key: B });
    assert.deepEqual(bOnly.open(sealedB, bind), { refreshToken: 'rt-ROTATE-SECRET' }, 'recovered after the old key is removed');
    assert.throws(() => bOnly.open(sealedA, bind), e => e.code === 'KEY_MISMATCH', 'an un-resealed record needs the old key');
    assert.throws(() => vb.open(sealedA, { ...bind, ownerId: 'user:other' }), e => e.code === 'DECRYPT_FAILED', 'binding still enforced under a previous key');
    assert.throws(() => K.createCredentialVault({ key: C, previousKeys: [B] }).open(sealedA, bind), e => e.code === 'KEY_MISMATCH');
    assert.equal(K.createCredentialVault({ key: A, previousKeys: [A] }).previousKeyIds.length, 0, 'the current key is not its own previous key');
  });

  test('environment: AQUA_CONNECTOR_PREVIOUS_KEYS parsed (comma/space, base64/hex); any malformed entry → unavailable vault (fail closed)', () => {
    const env = { AQUA_CONNECTOR_KEY: B.toString('base64'), AQUA_CONNECTOR_PREVIOUS_KEYS: `${A.toString('hex')}, ${C.toString('base64')}` };
    const v = vaultFromEnv(env);
    assert.equal(v.unavailable, undefined);
    assert.equal(v.previousKeyIds.length, 2);
    const bad = vaultFromEnv({ ...env, AQUA_CONNECTOR_PREVIOUS_KEYS: `${A.toString('hex')},not-a-key` });
    assert.equal(bad.unavailable, true);
    assert.equal(bad.code, 'KEY_INVALID');
    assert.equal(vaultFromEnv({ AQUA_CONNECTOR_KEY: B.toString('base64') }).previousKeyIds.length, 0);
  });

  test('service: rotateCredentials reseals every record under the current key; after removing the old key the connection still works (recovery)', async () => {
    const store = K.createMemoryConnectionStore();
    const S1 = await oauthStack({ store, vault: K.createCredentialVault({ key: A }) });
    let connId;
    try {
      S1.login('s-rot', 'user-rot');
      const { p } = await S1.start('s-rot');
      assert.equal(S1.outcomeOf(await S1.callback('s-rot', { state: p.state, code: S1.consent(p, { email: 'rot@example.test' }) })).result, 'connected');
      const [c] = await store.listByOwner('user:user-rot');
      connId = c.connectionId;
      const creds = K.createCredentialVault({ key: A }).open(c.credentials, { ownerId: c.ownerId, connectionId: c.connectionId, connectorId: 'gmail' });
      secretsSeen.add(creds.accessToken); secretsSeen.add(creds.refreshToken);
    } finally { await S1.close(); }

    const principal = principalForServerJob('user-rot');
    const rotating = K.createCredentialVault({ key: B, previousKeys: [A] });
    const S2 = await oauthStack({ store, vault: rotating });
    try {
      assert.deepEqual(await S2.service.rotateCredentials({ principal }), { resealed: 1, current: 0, unreadable: 0, withoutCredentials: 0 });
      assert.deepEqual(await S2.service.rotateCredentials({ principal }), { resealed: 0, current: 1, unreadable: 0, withoutCredentials: 0 }, 'idempotent');
    } finally { await S2.close(); }

    const S3 = await oauthStack({ store, vault: K.createCredentialVault({ key: B }) });   // old key removed
    try {
      const [c] = await store.listByOwner('user:user-rot');
      assert.equal(c.credentials.keyId, K.createCredentialVault({ key: B }).keyId);
      const view = await S3.service.getConnection({ principal, connectionId: connId });
      assert.equal(view.status, 'active');
      const opened = K.createCredentialVault({ key: B }).open(c.credentials, { ownerId: c.ownerId, connectionId: c.connectionId, connectorId: 'gmail' });
      assert.ok(opened.refreshToken, 'credentials recovered under the new key');
    } finally { await S3.close(); }
  });

  test('lazy reseal on use; a record whose key was removed before resealing → needs_reauth, never a guess', async () => {
    const store = K.createMemoryConnectionStore();
    const S1 = await oauthStack({ store, vault: K.createCredentialVault({ key: A }) });
    const ids = {};
    try {
      for (const u of ['lazy', 'lost']) {
        S1.login(`s-${u}`, `user-${u}`);
        const { p } = await S1.start(`s-${u}`);
        assert.equal(S1.outcomeOf(await S1.callback(`s-${u}`, { state: p.state, code: S1.consent(p, { email: `${u}@example.test` }) })).result, 'connected');
        ids[u] = (await store.listByOwner(`user:user-${u}`))[0].connectionId;
        await trackTokens(store, `user:user-${u}`, K.createCredentialVault({ key: A }));
      }
    } finally { await S1.close(); }
    const S2 = await oauthStack({ store, vault: K.createCredentialVault({ key: B, previousKeys: [A] }) });
    try {
      await S2.service.sync({ principal: principalForServerJob('user-lazy'), connectionId: ids.lazy }).catch(() => {});
      assert.equal((await store.listByOwner('user:user-lazy'))[0].credentials.keyId, K.createCredentialVault({ key: B }).keyId, 'resealed on first use');
    } finally { await S2.close(); }
    const S3 = await oauthStack({ store, vault: K.createCredentialVault({ key: B }) });
    try {
      await assert.rejects(S3.service.sync({ principal: principalForServerJob('user-lost'), connectionId: ids.lost }), e => e.code === 'CREDENTIALS_UNREADABLE');
      assert.equal((await store.listByOwner('user:user-lost'))[0].status, 'needs_reauth');
      assert.deepEqual(await S3.service.rotateCredentials({ principal: principalForServerJob('user-lost') }), { resealed: 0, current: 0, unreadable: 1, withoutCredentials: 0 });
    } finally { await S3.close(); }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('the REAL Google transport over a fake fetch (no network)', () => {
  function fakeGoogle(responder) {
    const reqs = [];
    const f = async (url, init = {}) => {
      reqs.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null, redirect: init.redirect });
      const { status = 200, body = {} } = (await responder({ url: new URL(url), init })) ?? {};
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    };
    return { f, reqs };
  }
  const transport = f => createGoogleGmailTransport({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, fetch: f, now: () => 1_000_000 });
  const VERIFIER = 'v'.repeat(64);

  test('exchange: form POST to the token endpoint with the exact redirect URI and verifier; secret in the body only; scopes parsed', async () => {
    const g = fakeGoogle(() => ({ body: { access_token: 'ya29.ACCESS-SECRET', refresh_token: '1//REFRESH-SECRET', expires_in: 3599, scope: GMAIL_READONLY_SCOPE, token_type: 'Bearer' } }));
    const r = await transport(g.f).exchangeCode({ code: '4/CODE-SECRET', redirectUri: REDIRECT, codeVerifier: VERIFIER });
    assert.deepEqual(r, { accessToken: 'ya29.ACCESS-SECRET', refreshToken: '1//REFRESH-SECRET', expiresAt: 1_000_000 + 3_599_000, scopes: [GMAIL_READONLY_SCOPE] });
    const [q] = g.reqs;
    assert.equal(q.url, 'https://oauth2.googleapis.com/token');
    assert.equal(q.method, 'POST');
    assert.equal(q.redirect, 'error');
    const form = Object.fromEntries(new URLSearchParams(q.body));
    assert.deepEqual(form, { grant_type: 'authorization_code', code: '4/CODE-SECRET', redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    assert.ok(!q.url.includes(CLIENT_SECRET) && !q.url.includes('CODE-SECRET'));
  });

  test('exchange refuses BEFORE the network: a redirect URI that is not exact, a missing/short verifier, a missing code', async () => {
    const g = fakeGoogle(() => ({}));
    const t = transport(g.f);
    for (const ru of [`${REDIRECT}/`, 'https://www.aquiplex.com/api/aqua/connect/gmail/callback', undefined]) {
      await assert.rejects(t.exchangeCode({ code: 'c', redirectUri: ru, codeVerifier: VERIFIER }), e => e.code === 'REDIRECT_URI_MISMATCH');
    }
    await assert.rejects(t.exchangeCode({ code: 'c', redirectUri: REDIRECT }), e => e.code === 'PKCE_VERIFIER_INVALID');
    await assert.rejects(t.exchangeCode({ code: 'c', redirectUri: REDIRECT, codeVerifier: 'short' }), e => e.code === 'PKCE_VERIFIER_INVALID');
    await assert.rejects(t.exchangeCode({ code: '', redirectUri: REDIRECT, codeVerifier: VERIFIER }), e => e.code === 'CODE_INVALID');
    assert.equal(g.reqs.length, 0);
  });

  test('token endpoint errors carry a status only — never the response body; invalid_grant → 401 (AUTH)', async () => {
    const g = fakeGoogle(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'SENSITIVE-BODY Bad Request code 4/CODE-SECRET' } }));
    const t = transport(g.f);
    const err = await t.exchangeCode({ code: '4/CODE-SECRET', redirectUri: REDIRECT, codeVerifier: VERIFIER }).catch(e => e);
    assert.equal(err.status, 401);
    assert.ok(!String(err.message + JSON.stringify(err)).includes('SENSITIVE') && !String(err.message).includes('CODE-SECRET'));
    const g5 = fakeGoogle(() => ({ status: 503, body: 'upstream SENSITIVE-BODY' }));
    assert.equal((await transport(g5.f).refreshAccessToken('1//R').catch(e => e)).status, 503);
    const gs = fakeGoogle(() => ({ body: { access_token: 'a', expires_in: 10 } }));
    assert.equal((await transport(gs.f).exchangeCode({ code: 'c', redirectUri: REDIRECT, codeVerifier: VERIFIER })).scopes, null, 'no scope stated → null → the connector refuses');
  });

  test('through the connector: a grant whose scope string includes gmail.modify is refused and its refresh token revoked', async () => {
    const g = fakeGoogle(({ url }) => (url.pathname === '/token'
      ? { body: { access_token: 'ya29.A', refresh_token: '1//R-ESCALATED', expires_in: 3600, scope: `${GMAIL_READONLY_SCOPE} ${MODIFY}` } }
      : { body: {} }));
    const c = createGmailConnector({ transport: transport(g.f) });
    await assert.rejects(c.connect({ code: 'c', redirectUri: REDIRECT, codeVerifier: VERIFIER }), e => e.kind === 'AUTH');
    const revoke = g.reqs.find(r => r.url === 'https://oauth2.googleapis.com/revoke');
    assert.ok(revoke, 'revoked');
    assert.equal(new URLSearchParams(revoke.body).get('token'), '1//R-ESCALATED');
    assert.ok(!revoke.url.includes('R-ESCALATED'), 'the token travels in the body, not the URL');
  });

  test('read-only by construction: GET only, Bearer header, fixed paths; ids validated before any request; no write-shaped method', async () => {
    const g = fakeGoogle(({ url }) => {
      if (url.pathname.endsWith('/profile')) return { body: { emailAddress: 'p@example.test', messagesTotal: 1, historyId: '42' } };
      if (url.pathname.endsWith('/messages')) return { body: { messages: [{ id: 'abc123', threadId: 't1' }] } };
      if (url.pathname.endsWith('/history')) return { body: { history: [], historyId: '43' } };
      return { body: { id: 'abc123' } };
    });
    const t = transport(g.f);
    await t.getProfile('ya29.TOKEN');
    await t.listMessages('ya29.TOKEN', { maxResults: 9999, includeSpamTrash: true });
    await t.getMessage('ya29.TOKEN', 'abc123', { format: 'full' });
    await t.getThread('ya29.TOKEN', 't1', { format: 'metadata' });
    await t.listHistory('ya29.TOKEN', { startHistoryId: '42' });
    for (const r of g.reqs) {
      assert.equal(r.method, 'GET');
      assert.equal(new URL(r.url).host, 'gmail.googleapis.com');
      assert.equal(r.headers.authorization, 'Bearer ya29.TOKEN');
      assert.ok(!r.url.includes('ya29.TOKEN'));
    }
    const list = new URL(g.reqs[1].url);
    assert.equal(list.searchParams.get('maxResults'), '500');
    assert.equal(list.searchParams.get('includeSpamTrash'), 'true', 'passed through as asked (the connector always asks false)');
    const n = g.reqs.length;
    for (const id of ['../../send', 'abc/def', 'a?b', '', 'x'.repeat(65)]) await assert.rejects(t.getMessage('ya29.TOKEN', id), e => e.status === 404);
    await assert.rejects(t.listHistory('ya29.TOKEN', { startHistoryId: '1;drop' }), e => e.status === 404);
    assert.equal(g.reqs.length, n, 'nothing sent for a malformed id');
    const methods = Object.keys(t).filter(k => typeof t[k] === 'function');
    assert.deepEqual(methods.sort(), ['exchangeCode', 'getMessage', 'getProfile', 'getThread', 'health', 'listHistory', 'listMessages', 'refreshAccessToken', 'revokeToken']);
    assert.equal(t.readOnly, true);
    assert.equal(t.testOnly, false);
    assert.ok(!JSON.stringify(t).includes(CLIENT_SECRET) && !Object.values(t).some(v => v === CLIENT_SECRET), 'the secret is not reachable from the transport object');
    const prod = K.createConnectorRegistry({ allowTestOnly: false });
    assert.equal(prod.register(createGmailConnector({ transport: t })).testOnly, false, 'the production registry accepts the real transport');
  });

  test('the request gate: only GET to fixed Gmail read paths and POST to /token, /revoke — every write-shaped or foreign request refused', async () => {
    const { requestAllowed } = await import('../gmail/googleGmailTransport.js');
    const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
    for (const [url, method] of [[`${G}/profile`, 'GET'], [`${G}/messages`, 'GET'], [`${G}/messages/abc123`, 'GET'], [`${G}/threads/t1`, 'GET'], [`${G}/history`, 'GET'],
      ['https://oauth2.googleapis.com/token', 'POST'], ['https://oauth2.googleapis.com/revoke', 'POST']]) {
      assert.equal(requestAllowed(url, method), true, `${method} ${url}`);
    }
    for (const [url, method] of [
      [`${G}/messages/send`, 'POST'], [`${G}/messages/abc123`, 'DELETE'], [`${G}/messages/abc123/trash`, 'POST'], [`${G}/messages/abc123/modify`, 'POST'],
      [`${G}/messages/batchModify`, 'POST'], [`${G}/messages/batchDelete`, 'POST'], [`${G}/drafts`, 'POST'], [`${G}/drafts`, 'GET'], [`${G}/settings/filters`, 'GET'],
      [`${G}/messages/abc123/attachments/x`, 'GET'], [`${G}/watch`, 'POST'], [`${G}/messages`, 'POST'], [`${G}/messages/import`, 'POST'], [`${G}/profile`, 'POST'],
      ['https://oauth2.googleapis.com/token', 'GET'], ['https://oauth2.googleapis.com/tokeninfo', 'POST'], ['http://gmail.googleapis.com/gmail/v1/users/me/profile', 'GET'],
      ['https://gmail.googleapis.com:444/gmail/v1/users/me/profile', 'GET'], ['https://evil.example.test/gmail/v1/users/me/profile', 'GET'],
      ['https://u:p@gmail.googleapis.com/gmail/v1/users/me/profile', 'GET'], [`${G.replace('/me', '/other@example.test')}/profile`, 'GET'], ['not a url', 'GET'],
      ['https://constructor/x', 'GET'], ['https://__proto__/x', 'GET'],
    ]) {
      assert.equal(requestAllowed(url, method), false, `${method} ${url}`);
    }
  });

  test('network failures and timeouts map to TRANSIENT; 401 to AUTH; a 404 on history to CURSOR_EXPIRED', async () => {
    const c = status => createGmailConnector({ transport: transport(async () => { if (status === 'net') throw Object.assign(new Error('x'), { name: 'TimeoutError' }); return new Response('{}', { status }); }) });
    const ctx = { connectionId: 'conn_x', credentials: () => ({ accessToken: 'a' }) };
    await assert.rejects(c('net').listResources(ctx, {}), e => e.kind === 'TRANSIENT');
    await assert.rejects(c(401).listResources(ctx, {}), e => e.kind === 'AUTH');
    await assert.rejects(c(503).listResources(ctx, {}), e => e.kind === 'TRANSIENT');
    await assert.rejects(c(404).syncChanges(ctx, { checkpoint: { historyId: '5' } }), e => e.kind === 'CURSOR_EXPIRED');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('no provider egress, no secret leakage', () => {
  test('Gmail content is classified external:gmail and no AI provider may receive it', () => {
    const cls = DC.dataClassOfSource('gmail:conn_0123456789abcdef0123');
    assert.equal(cls, 'external:gmail');
    for (const p of DC.PROVIDERS) assert.equal(DC.providerAllowedFor(cls, p), false, p);
  });

  test('no request left the machine during this file (no Google, no AI provider)', () => {
    assert.deepEqual(egress, []);
  });

  test('no code, state, verifier, token, client secret or mailbox address in any log line, response body or redirect', () => {
    const haystack = [...logged, ...wire].join('\n');
    // The ONE place a state legitimately appears is the /start response that sends the
    // browser to Google (its Location, and Express's "Redirecting to <that URL>" body).
    const googleBound = w => w.includes('https://accounts.google.com/o/oauth2/v2/auth?');
    const elsewhere = [...logged, ...wire.filter(w => !googleBound(w))].join('\n');
    const leaked = [...secretsSeen].filter(s => typeof s === 'string' && s.length >= 6 && elsewhere.includes(s));
    assert.deepEqual(leaked, [], 'leaked secrets');
    const googleText = wire.filter(googleBound).join('\n');
    const verifiersOrTokens = [...secretsSeen].filter(s => typeof s === 'string' && s.length > 43 && googleText.includes(s));
    assert.deepEqual(verifiersOrTokens, [], 'nothing but the state/challenge goes to Google');
    assert.ok(!haystack.includes('SECRETVALUE'), 'no mock token');
    assert.ok(!haystack.includes(CLIENT_SECRET), 'no client secret');
    assert.ok(!/[a-z0-9.]+@example\.test/i.test(logged.join('\n')), 'no mailbox address in logs');
    assert.ok(logged.some(l => l.includes('[CONNECT] gmail oauth callback')), 'the flow does log (so the check is meaningful)');
  });
});
