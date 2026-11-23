/**
 * F1 — Gmail OAuth through the REAL application (live, isolated).
 *
 * The real index.js is booted as a child process (scripts/start-api.mjs, the
 * production API entrypoint) with:
 *   · its real middleware: express-session on connect-mongo, passport, CSRF,
 *     same-origin, rate limits, requireLogin → aquaAccess → aqua/router.js →
 *     routes/connect.js → connectService (owner lease + fencing, Postgres) →
 *     the PRODUCTION Mongo connection store (aqua_connection_sets) →
 *     credentialVault → the REAL Google REST transport;
 *   · Google replaced by a loopback fake (a preload re-routes only
 *     oauth2/gmail.googleapis.com; any other outbound host is refused and
 *     reported — asserted absent);
 *   · a working directory with NO .env (index.js loads .env from the cwd; dotenv
 *     reports what it injected — asserted zero), and an explicit, test-only env.
 *
 * SAFETY RAILS (refused, not skipped, when violated):
 *   MG1_DISPOSABLE_MONGO_URI   mongodb:// on 127.0.0.1/localhost, database exactly
 *                              aqua_disposable_g2a, which must be EMPTY at start; dropped at the end.
 *   DATABASE_URL (runner, from AQUA_TEST_DATABASE_URL)  localhost:55432/aqua_test only.
 * Skipped (with the reason) when either is absent.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.resolve(HERE, '../../..');
const ROOT = path.resolve(AQUA, '..');
const MONGO_URI = String(process.env.MG1_DISPOSABLE_MONGO_URI ?? '').trim();
const PG_URI = String(process.env.DATABASE_URL ?? '').trim();
const EXPECTED_DB = 'aqua_disposable_g2a';

function rails() {
  if (!MONGO_URI) return { skip: 'MG1_DISPOSABLE_MONGO_URI not set (aqua-test-mongo, database aqua_disposable_g2a)' };
  if (!PG_URI) return { skip: 'AQUA_TEST_DATABASE_URL not set (aqua-test-db :55432/aqua_test)' };
  let m, p;
  try { m = new URL(MONGO_URI); } catch { return { refuse: 'MG1_DISPOSABLE_MONGO_URI is not a URL' }; }
  if (m.protocol !== 'mongodb:') return { refuse: 'only mongodb:// (no +srv / Atlas)' };
  if (!['127.0.0.1', 'localhost'].includes(m.hostname)) return { refuse: `refusing non-local Mongo host ${m.hostname}` };
  if (m.pathname.replace(/^\//, '') !== EXPECTED_DB) return { refuse: `Mongo database must be exactly ${EXPECTED_DB}` };
  if (/mongodb\.net/i.test(MONGO_URI)) return { refuse: 'Atlas URI refused' };
  try { p = new URL(PG_URI); } catch { return { refuse: 'DATABASE_URL is not a URL' }; }
  if (!['127.0.0.1', 'localhost'].includes(p.hostname) || p.port !== '55432' || p.pathname !== '/aqua_test') return { refuse: 'Postgres must be localhost:55432/aqua_test' };
  return {};
}
const R = rails();
if (R.refuse) throw new Error(`F1 safety rail: ${R.refuse}`);
const skip = R.skip ?? false;

const require = createRequire(import.meta.url);
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const ORIGIN = 'https://f1.aquiplex.test';
const REDIRECT = `${ORIGIN}/api/aqua/connect/gmail/callback`;
const CLIENT_ID = `f1-${crypto.randomBytes(4).toString('hex')}.apps.googleusercontent.com`;
const CLIENT_SECRET = `F1SECRET-${crypto.randomBytes(12).toString('hex')}`;
const CONNECTOR_KEY = crypto.randomBytes(32);
const MAILBOX = 'f1.mailbox@example.test';

let child, base, fakeGoogle, fakeBase, mock, inst, pool, vaultMod, ownerLease, tmp, childCwd;
const out = [];                 // child stdout + stderr lines
const googleRequests = [];      // what the app sent to "Google" (no token values kept)
const users = {};
const owners = [];

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); s.on('error', rej); });
const formOf = async req => new URLSearchParams(await new Promise(r => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => r(b)); }));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

/** Fake Google over the deterministic mock (codes bound to redirect URI + PKCE challenge). */
function startFakeGoogle() {
  return new Promise(resolve => {
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      const [, host, ...rest] = u.pathname.split('/');
      const p = `/${rest.join('/')}`;
      try {
        if (host === 'oauth2.googleapis.com' && req.method === 'POST' && p === '/token') {
          const f = await formOf(req);
          googleRequests.push({ host, path: p, grant: f.get('grant_type'), redirectUri: f.get('redirect_uri'), pkce: Boolean(f.get('code_verifier')), clientOk: f.get('client_id') === CLIENT_ID && f.get('client_secret') === CLIENT_SECRET, secretInUrl: req.url.includes(CLIENT_SECRET) });
          if (f.get('client_id') !== CLIENT_ID || f.get('client_secret') !== CLIENT_SECRET) return json(res, 401, { error: 'invalid_client' });
          let r;
          try {
            r = f.get('grant_type') === 'authorization_code'
              ? await mock.transport.exchangeCode({ code: f.get('code'), redirectUri: f.get('redirect_uri'), codeVerifier: f.get('code_verifier') })
              : await mock.transport.refreshAccessToken(f.get('refresh_token'));
          } catch { return json(res, 400, { error: 'invalid_grant', error_description: 'F1-SENSITIVE-BODY' }); }
          return json(res, 200, { access_token: r.accessToken, ...(r.refreshToken ? { refresh_token: r.refreshToken } : {}), expires_in: Math.max(1, Math.round((r.expiresAt - Date.now()) / 1000)), ...(r.scopes ? { scope: r.scopes.join(' ') } : {}), token_type: 'Bearer' });
        }
        if (host === 'oauth2.googleapis.com' && req.method === 'POST' && p === '/revoke') {
          const f = await formOf(req);
          googleRequests.push({ host, path: p, tokenInUrl: u.search.length > 0 });
          try { await mock.transport.revokeToken(f.get('token')); return json(res, 200, {}); } catch { return json(res, 400, { error: 'invalid_token' }); }
        }
        if (host === 'gmail.googleapis.com' && req.method === 'GET' && p === '/gmail/v1/users/me/profile') {
          googleRequests.push({ host, path: p, bearer: /^Bearer \S+$/.test(req.headers.authorization ?? '') });
          try { return json(res, 200, await mock.transport.getProfile(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))); }
          catch (e) { return json(res, e?.status ?? 500, { error: { code: e?.status ?? 500 } }); }
        }
        googleRequests.push({ host, path: p, method: req.method, unexpected: true });
        return json(res, 404, {});
      } catch { return json(res, 500, {}); }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/** A browser: own cookie jar, never follows redirects, sends X-Forwarded-Proto like Render's proxy. */
function browser() {
  const jar = new Map();
  async function req(method, url, { form = null, origin = null } = {}) {
    const headers = { 'x-forwarded-proto': 'https' };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (origin) headers.origin = origin;
    const r = await fetch(base + url, { method, headers, body: form ? new URLSearchParams(form).toString() : undefined, redirect: 'manual' });
    for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch { body = null; }
    return { status: r.status, location: r.headers.get('location'), text, body };
  }
  return { get: (u, o) => req('GET', u, o), post: (u, o) => req('POST', u, o), del: (u, o) => req('DELETE', u, o), hasSession: () => jar.has('aidex_session') };
}

async function login(email, password) {
  const b = browser();
  const page = await b.get('/login');
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1];
  assert.ok(csrf, 'the login form carries a CSRF token');
  const r = await b.post('/login', { form: { email, password, _csrf: csrf } });
  assert.equal(r.status, 302, `login: ${r.status}`);
  assert.ok(b.hasSession());
  return b;
}

async function startFlow(b) {
  const r = await b.get('/api/aqua/connect/gmail/start');
  assert.equal(r.status, 302, `start: ${r.status} ${r.text.slice(0, 200)}`);
  const u = new URL(r.location);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  return Object.fromEntries(u.searchParams);
}
const consent = (p, email = MAILBOX) => mock.authorizeCode(email, { redirectUri: p.redirect_uri, codeChallenge: p.code_challenge });
async function callback(b, q) {
  const r = await b.get(`/api/aqua/connect/gmail/callback?${new URLSearchParams(q)}`);
  assert.equal(r.status, 303, `callback: ${r.status} ${r.text.slice(0, 200)}`);
  const u = new URL(r.location, ORIGIN);
  return { result: u.searchParams.get('gmailConnect'), reason: u.searchParams.get('reason') };
}
const setDoc = owner => inst.connection.db.collection('aqua_connection_sets').findOne({ _id: owner });

describe('F1 · Gmail OAuth through the real index.js → aqua/router.js → connect routes', { skip }, () => {
  let jobsBefore;

  before(async () => {
    const mongoose = require(path.join(ROOT, 'node_modules', 'mongoose'));
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));
    const pg = require(path.join(ROOT, 'node_modules', 'pg'));
    inst = new mongoose.Mongoose();
    await inst.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    const existing = await inst.connection.db.listCollections().toArray();
    if (existing.length) throw new Error(`F1 safety rail: ${EXPECTED_DB} is not empty (${existing.length} collections) — refusing`);
    pool = new pg.Pool({ connectionString: PG_URI, max: 3 });
    jobsBefore = (await pool.query('SELECT state, count(*)::int AS n FROM aqua_jobs GROUP BY 1 ORDER BY 1')).rows;

    // Two password accounts, through the platform's own User schema.
    const { schema } = require(path.join(ROOT, 'models', 'User.js'));
    const User = inst.model('User', schema);
    await User.init();
    for (const name of ['alice', 'bob']) {
      const password = `pw-${crypto.randomBytes(8).toString('hex')}`;
      const u = await User.create({ email: `f1-${name}-${crypto.randomBytes(3).toString('hex')}@platform.test`, password: await bcrypt.hash(password, 4), emailVerified: true, emailVerifiedVia: 'email', emailVerifiedAt: new Date() });
      users[name] = { email: u.email, password, id: String(u._id), owner: `user:${u._id}` };
      owners.push(users[name].owner);
    }

    vaultMod = await import(pathToFileURL(path.join(AQUA, 'src/connect/credentialVault.js')).href);
    ownerLease = await import(pathToFileURL(path.join(AQUA, 'src/connect/ownerLease.js')).href);
    const { createMockGmailService } = await import(pathToFileURL(path.join(AQUA, 'src/connect/testing/mockGmailTransport.js')).href);
    mock = createMockGmailService({ now: Date.now });
    fakeGoogle = await startFakeGoogle();
    fakeBase = `http://127.0.0.1:${fakeGoogle.address().port}`;

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-f1-'));
    const cwd = path.join(tmp, 'cwd'); fs.mkdirSync(cwd); childCwd = cwd;            // EMPTY: no .env for dotenv to find
    for (const d of ['data', 'artifacts', 'home']) fs.mkdirSync(path.join(tmp, d));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const keep = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
    const env = {
      ...keep,
      HOME: path.join(tmp, 'home'), USERPROFILE: path.join(tmp, 'home'),
      NODE_ENV: 'production', PORT: String(port), AQUA_ROLE: 'api',
      MONGO_URI, DATABASE_URL: PG_URI,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      RAZORPAY_KEY_ID: 'rzp_test_f1_inert', RAZORPAY_KEY_SECRET: 'f1-inert', RAZORPAY_WEBHOOK_SECRET: 'f1-inert',
      GOOGLE_CLIENT_ID: 'f1-signin-inert.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'f1-signin-inert',
      APP_URL: ORIGIN, ALLOWED_ORIGINS: ORIGIN,
      AQUA_GMAIL_CONNECT: 'on', AQUA_GMAIL_CLIENT_ID: CLIENT_ID, AQUA_GMAIL_CLIENT_SECRET: CLIENT_SECRET, AQUA_GMAIL_REDIRECT_URI: REDIRECT,
      AQUA_CONNECTOR_KEY: CONNECTOR_KEY.toString('base64'),
      AQUA_LOG_PSEUDONYM_KEY: crypto.randomBytes(32).toString('hex'),
      AQUA_DATA_DIR: path.join(tmp, 'data'), AQUA_ARTIFACTS_DIR: path.join(tmp, 'artifacts'),
      AQUA_DISABLE_MONGO_MIRROR: '1', AQUA_EMBEDDINGS: 'off',
      F1_FAKE_GOOGLE_URL: fakeBase,
    };
    const preload = pathToFileURL(path.join(HERE, 'fixtures', 'f1GooglePreload.mjs')).href;
    child = spawn(process.execPath, ['--import', preload, path.join(ROOT, 'scripts', 'start-api.mjs')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const s of [child.stdout, child.stderr]) s.on('data', d => out.push(...String(d).split(/\r?\n/).filter(Boolean)));
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (child.exitCode != null) throw new Error(`the app exited (${child.exitCode}):\n${out.slice(-40).join('\n')}`);
      try { const r = await fetch(`${base}/ready`); if (r.status === 200) break; } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`the app did not become ready:\n${out.slice(-40).join('\n')}`);
      await new Promise(r => setTimeout(r, 300));
    }
  });

  after(async () => {
    if (child && child.exitCode == null) { child.kill(); await new Promise(r => { child.once('exit', r); setTimeout(r, 5000); }); }
    await new Promise(r => (fakeGoogle ? fakeGoogle.close(r) : r()));
    if (pool) {
      for (const o of owners) await pool.query('DELETE FROM aqua_scheduler_leases WHERE name = $1', [ownerLease.connectLeaseName(o)]);
      await pool.end();
    }
    if (inst?.connection?.readyState === 1) {
      if (inst.connection.db.databaseName === EXPECTED_DB) await inst.connection.db.dropDatabase();
      await inst.disconnect();
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('boot: the real app is ready; .env was not loaded; Gmail Connect is enabled; no outbound host contacted', () => {
    const injected = out.filter(l => /injecting env \((\d+)\)/.test(l)).map(l => Number(/injecting env \((\d+)\)/.exec(l)[1]));
    assert.deepEqual(fs.readdirSync(childCwd), [], 'the app ran in an EMPTY directory: there was no .env to load');
    assert.ok(injected.every(n => n === 0), `dotenv injected variables: ${injected}`);
    process.stdout.write(`# F1 evidence: dotenv lines=${JSON.stringify(out.filter(l => /dotenv/.test(l)))}; mounted=${out.some(l => l.includes('AQUA engine mounted'))}
`);
    assert.ok(out.some(l => l.includes('AQUA engine mounted at /api/aqua')), 'aqua/router.js mounted');
    assert.ok(out.some(l => l.includes('[F1-PRELOAD]')));
  });

  test('unauthenticated: the real requireLogin answers 401 before any OAuth state exists', async () => {
    const r = await browser().get('/api/aqua/connect/gmail/start');
    assert.equal(r.status, 401);
  });

  test('connect: login → start → Google → callback → token exchange → sealed record in aqua_connection_sets under the owner lease', async () => {
    const a = await login(users.alice.email, users.alice.password);
    const p = await startFlow(a);
    assert.equal(p.redirect_uri, REDIRECT);
    assert.equal(p.scope, SCOPE);
    assert.equal(p.code_challenge_method, 'S256');
    assert.equal(p.client_id, CLIENT_ID);
    assert.deepEqual(await callback(a, { state: p.state, code: consent(p), scope: SCOPE }), { result: 'connected', reason: null });

    const tok = googleRequests.filter(g => g.path === '/token');
    assert.equal(tok.length, 1);
    assert.deepEqual({ grant: tok[0].grant, redirectUri: tok[0].redirectUri, pkce: tok[0].pkce, clientOk: tok[0].clientOk, secretInUrl: tok[0].secretInUrl }, { grant: 'authorization_code', redirectUri: REDIRECT, pkce: true, clientOk: true, secretInUrl: false });
    assert.ok(googleRequests.some(g => g.path === '/gmail/v1/users/me/profile' && g.bearer));

    // The PRODUCTION Mongo adapter's owner document, read directly.
    const d = await setDoc(users.alice.owner);
    assert.ok(d, 'aqua_connection_sets has the owner document');
    assert.equal(d.deleted, false);
    assert.equal(typeof d.fenceEpoch, 'number', 'stamped by the owner lease (fencing active)');
    const [id] = Object.keys(d.connections);
    const rec = d.connections[id];
    assert.match(id, /^conn_[0-9a-f]{20}$/);
    assert.equal(rec.connectorId, 'gmail');
    assert.equal(rec.status, 'active');
    assert.deepEqual(rec.scopes, [SCOPE]);
    assert.deepEqual(Object.keys(rec.credentials).sort(), ['alg', 'ct', 'iv', 'keyId', 'tag', 'v']);
    assert.ok(!JSON.stringify(d).includes('SECRETVALUE'), 'no plaintext token at rest');
    assert.ok(!JSON.stringify(d).includes(MAILBOX), 'no mailbox address at rest');

    // Sealing → retrieval: the stored envelope opens to the tokens Google issued, only with this binding.
    const vault = vaultMod.createCredentialVault({ key: CONNECTOR_KEY });
    const creds = vault.open(rec.credentials, { ownerId: users.alice.owner, connectionId: id, connectorId: 'gmail' });
    assert.match(creds.accessToken, /^mock-gmail-access-/);
    assert.match(creds.refreshToken, /^mock-gmail-refresh-/);
    assert.equal(mock.grantRevoked(creds.refreshToken), false);
    assert.throws(() => vault.open(rec.credentials, { ownerId: users.bob.owner, connectionId: id, connectorId: 'gmail' }), e => e.code === 'DECRYPT_FAILED');

    // The lease row of this owner (Postgres) — the operation held it.
    const lease = await pool.query('SELECT holder, acquired_at FROM aqua_scheduler_leases WHERE name = $1', [ownerLease.connectLeaseName(users.alice.owner)]);
    assert.equal(lease.rows.length, 1, 'the connect lease was taken in aqua_test');

    // Listing through the app: credential-free view.
    const list = await a.get('/api/aqua/connect/connections');
    assert.equal(list.status, 200);
    assert.equal(list.body.connections.length, 1);
    assert.equal(list.body.connections[0].connectionId, id);
    assert.equal(list.body.connections[0].hasCredentials, true);
    assert.ok(!list.text.includes('SECRETVALUE') && !list.text.includes(MAILBOX));
    users.alice.connectionId = id;
    users.alice.creds = creds;
    users.alice.browser = a;
  });

  test('replayed callback (same state + code): refused by the real session; no second exchange', async () => {
    const a = users.alice.browser;
    const p = await startFlow(a);
    const code = consent(p);
    assert.equal((await callback(a, { state: p.state, code })).result, 'connected');
    const exchanges = googleRequests.filter(g => g.path === '/token').length;
    assert.deepEqual(await callback(a, { state: p.state, code }), { result: 'failed', reason: 'STATE_INVALID' });
    assert.equal(googleRequests.filter(g => g.path === '/token').length, exchanges);
    const second = Object.keys((await setDoc(users.alice.owner)).connections).find(k => k !== users.alice.connectionId);
    users.alice.second = second;
  });

  test('owner isolation through the real app: Bob cannot see, revoke or delete Alice\'s connection; Alice\'s state is useless in Bob\'s session', async () => {
    const b = await login(users.bob.email, users.bob.password);
    users.bob.browser = b;
    assert.deepEqual((await b.get('/api/aqua/connect/connections')).body.connections, []);
    assert.equal((await b.post(`/api/aqua/connect/connections/${users.alice.connectionId}/revoke`, { origin: ORIGIN })).status, 404);
    assert.equal((await b.del(`/api/aqua/connect/connections/${users.alice.connectionId}`, { origin: ORIGIN })).status, 404);
    const p = await startFlow(users.alice.browser);
    assert.deepEqual(await callback(b, { state: p.state, code: consent(p) }), { result: 'failed', reason: 'STATE_INVALID' });
    assert.equal(await setDoc(users.bob.owner), null, 'nothing written for Bob');
    assert.equal(Object.keys((await setDoc(users.alice.owner)).connections).length, 2);
  });

  test('cross-site POST without our Origin is refused by the real same-origin guard', async () => {
    const r = await users.alice.browser.post(`/api/aqua/connect/connections/${users.alice.connectionId}/revoke`, { origin: 'https://evil.example.test' });
    assert.equal(r.status, 403);
    assert.equal((await setDoc(users.alice.owner)).connections[users.alice.connectionId].status, 'active');
  });

  test('revoke through the app: the stored refresh token is opened and revoked at Google; credentials wiped in Mongo; record kept', async () => {
    const a = users.alice.browser;
    const r = await a.post(`/api/aqua/connect/connections/${users.alice.connectionId}/revoke`, { origin: ORIGIN });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.providerRevocation, 'revoked');
    assert.equal(r.body.localCredentialsDeleted, true);
    assert.equal(mock.grantRevoked(users.alice.creds.refreshToken), true, 'Google saw the revocation of exactly the stored grant');
    const rec = (await setDoc(users.alice.owner)).connections[users.alice.connectionId];
    assert.equal(rec.status, 'revoked');
    assert.equal(rec.credentials, null);
    assert.ok(googleRequests.filter(g => g.path === '/revoke').every(g => g.tokenInUrl === false), 'tokens travel in the body');
  });

  test('disconnect through the app: revoked at Google and the record removed from the owner document', async () => {
    const a = users.alice.browser;
    const id = users.alice.second;
    const rec = (await setDoc(users.alice.owner)).connections[id];
    const creds = vaultMod.createCredentialVault({ key: CONNECTOR_KEY }).open(rec.credentials, { ownerId: users.alice.owner, connectionId: id, connectorId: 'gmail' });
    const r = await a.del(`/api/aqua/connect/connections/${id}`, { origin: ORIGIN });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.deleted, true);
    assert.equal(r.body.providerRevocation, 'revoked');
    assert.equal(mock.grantRevoked(creds.refreshToken), true);
    const d = await setDoc(users.alice.owner);
    assert.equal(d.connections[id], undefined);
    assert.ok(d.connections[users.alice.connectionId], 'the other connection is untouched');
  });

  test('F2 through the app: Google issues tokens, the profile call fails → the callback fails AND the grant is revoked; nothing stored', async () => {
    const b = users.bob.browser;
    const p = await startFlow(b);
    const before = mock.grants().length;
    mock.failNext('getProfile', 500);
    assert.equal((await callback(b, { state: p.state, code: consent(p, 'f1.bob.mailbox@example.test') })).result, 'failed');
    const issued = mock.grants().slice(before);
    assert.equal(issued.length, 1, 'Google issued a grant');
    assert.equal(issued[0].revoked, true, 'and it was revoked');
    assert.equal(await setDoc(users.bob.owner), null);
  });

  test('isolation: no outbound host but the fake Google; no secret or token in the app\'s output; no unexpected Google call', () => {
    const egress = out.filter(l => l.startsWith('[F1-EGRESS]'));
    assert.deepEqual(egress, []);
    assert.deepEqual(googleRequests.filter(g => g.unexpected), []);
    const text = out.join('\n');
    for (const s of [CLIENT_SECRET, CONNECTOR_KEY.toString('base64'), 'SECRETVALUE', 'F1-SENSITIVE-BODY', MAILBOX, 'code-f1.']) assert.ok(!text.includes(s), `app output contains ${s.slice(0, 12)}…`);
    assert.ok(out.some(l => l.includes('[CONNECT] gmail oauth callback')), 'the flow logged (outcome only)');
  });

  test('aqua_test was not disturbed: job counts by state unchanged', async () => {
    const now = (await pool.query('SELECT state, count(*)::int AS n FROM aqua_jobs GROUP BY 1 ORDER BY 1')).rows;
    assert.deepEqual(now, jobsBefore);
  });
});
