/**
 * AQUA Connect — deterministic FAKE connector (Phase 1b, test-only)
 *
 * Simulates an OAuth-style source entirely in memory, so the whole connector
 * lifecycle can be proven without any real account or network:
 *
 *   world = createFakeWorld()            the "remote service": accounts, resources,
 *                                        a change log, token issuance/revocation,
 *                                        and failure injection
 *   createFakeConnector({ world })       a contract-conformant connector over it
 *
 * Marked testOnly: the production registry (registry.js defaultRegistry)
 * refuses to register it, and no production module imports this file.
 *
 * Determinism: no clocks or randomness inside the world except an injectable
 * `now` and a counter for tokens; resource ordering is insertion order.
 */
import { ConnectorError } from '../contract.js';

// `now` is injectable; tests that control time pass the SAME clock to the
// connect service (createConnectService({ now })) so token expiry agrees.
export function createFakeWorld({ now = () => Date.now(), pageSize = 2, tokenTtlMs = 3_600_000 } = {}) {
  const accounts = new Map();     // account → { resources: Map<externalId, res>, log: [{ seq, op, externalId }] }
  const tokens = new Map();       // accessToken → { account, expiresAt, revoked }
  const refreshTokens = new Map();// refreshToken → { account, revoked }
  let tokenSeq = 0;
  let seq = 0;
  const failures = { fetch: new Map(), list: 0, listTransient: true, connect: false, refresh: false, down: false };
  const calls = [];               // [{ op, account, token, externalId? }] — what the connector actually did

  const acct = id => {
    if (!accounts.has(id)) accounts.set(id, { resources: new Map(), log: [] });
    return accounts.get(id);
  };

  return {
    now, pageSize, calls, failures,
    /** Add or modify a resource (bumps its version and the change log). */
    put(account, externalId, { name, content, url = null, title = null }) {
      const a = acct(account);
      const prev = a.resources.get(externalId);
      const version = String((prev ? Number(prev.version) : 0) + 1);
      a.resources.set(externalId, { externalId, name, content, url, title, version, updatedAt: new Date(now() + ++seq * 1000).toISOString() });
      a.log.push({ seq, op: 'put', externalId });
    },
    /** Delete a resource at the source. */
    remove(account, externalId) {
      const a = acct(account);
      if (a.resources.delete(externalId)) a.log.push({ seq: ++seq, op: 'remove', externalId });
    },
    /** Make fetchResource(externalId) fail `times` times (transient = retryable). */
    failFetch(externalId, { times = 1, transient = true } = {}) { failures.fetch.set(externalId, { times, transient }); },
    failList(times = 1, { transient = true } = {}) { failures.list = times; failures.listTransient = transient; },
    setDown(down) { failures.down = down; },
    issue(account) {
      const at = `fake-access-${account}-${++tokenSeq}-SECRETVALUE`;
      const rt = `fake-refresh-${account}-${tokenSeq}-SECRETVALUE`;
      tokens.set(at, { account, expiresAt: now() + tokenTtlMs, revoked: false });
      refreshTokens.set(rt, { account, revoked: false });
      return { accessToken: at, refreshToken: rt, expiresAt: now() + tokenTtlMs };
    },
    /** Resolve a token to its account, or throw AUTH (unknown, revoked, expired). */
    authorise(accessToken) {
      const t = tokens.get(accessToken);
      if (!t || t.revoked || t.expiresAt <= now()) throw new ConnectorError('AUTH', 'invalid or expired token');
      return t.account;
    },
    refresh(refreshToken) {
      const r = refreshTokens.get(refreshToken);
      if (failures.refresh || !r || r.revoked) throw new ConnectorError('AUTH', 'refresh refused');
      return this.issue(r.account);
    },
    revoke(accessToken) {
      const t = tokens.get(accessToken);
      if (t) t.revoked = true;
      for (const r of refreshTokens.values()) if (t && r.account === t.account) r.revoked = true;
    },
    expireAll() { for (const t of tokens.values()) t.expiresAt = 0; },
    accountOf: account => acct(account),
    tokenState: accessToken => tokens.get(accessToken) ?? null,
  };
}

/**
 * @param {{ world: object, id?: string, version?: string, overrides?: object }} opts
 *   overrides: replace any method (malicious-connector tests).
 */
export function createFakeConnector({ world, id = 'fake', version = '1.0.0', overrides = {} } = {}) {
  const token = ctx => ctx.credentials().accessToken;
  const base = {
    id, version, displayName: 'Fake Source (tests only)', testOnly: true,
    auth: { type: 'oauth2', scopes: ['fake.read'] },
    capabilities: ['list', 'fetch', 'sync', 'incremental', 'refresh'],
    resourceTypes: ['document'],
    permissions: ['read:documents'],

    async connect({ account, code } = {}) {
      if (world.failures.connect || code !== 'ok' || typeof account !== 'string') throw new ConnectorError('AUTH', 'authorisation code rejected');
      const issued = world.issue(account);
      return {
        account: { externalAccountId: `acct:${account}`, label: `Fake account ${account}` },
        credentials: { accessToken: issued.accessToken, refreshToken: issued.refreshToken },
        expiresAt: issued.expiresAt, scopes: ['fake.read'],
      };
    },
    async refresh(credentials) {
      const issued = world.refresh(credentials.refreshToken);
      return { credentials: { accessToken: issued.accessToken, refreshToken: issued.refreshToken }, expiresAt: issued.expiresAt };
    },
    async disconnect(ctx) {
      world.calls.push({ op: 'revoke', token: token(ctx) });
      world.revoke(token(ctx));
    },
    async listResources(ctx, { cursor = null } = {}) {
      const account = world.authorise(token(ctx));
      world.calls.push({ op: 'list', account, token: token(ctx), cursor });
      if (world.failures.down) throw new ConnectorError('TRANSIENT', 'service unavailable (503)');
      if (world.failures.list > 0) { world.failures.list--; throw new ConnectorError(world.failures.listTransient ? 'TRANSIENT' : 'PERMANENT', 'list failed (503)'); }
      const all = [...world.accountOf(account).resources.values()];
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + world.pageSize);
      const next = start + world.pageSize < all.length ? String(start + world.pageSize) : null;
      return { resources: page.map(r => ({ externalId: r.externalId, name: r.name, type: 'document', version: r.version, updatedAt: r.updatedAt })), cursor: next };
    },
    async fetchResource(ctx, ref) {
      const account = world.authorise(token(ctx));
      world.calls.push({ op: 'fetch', account, token: token(ctx), externalId: ref.externalId });
      if (world.failures.down) throw new ConnectorError('TRANSIENT', 'service unavailable (503)');
      const f = world.failures.fetch.get(ref.externalId);
      if (f && f.times > 0) { f.times--; throw new ConnectorError(f.transient ? 'TRANSIENT' : 'PERMANENT', `fetch failed for ${ref.externalId} (500)`); }
      const r = world.accountOf(account).resources.get(ref.externalId);
      if (!r) throw new ConnectorError('NOT_FOUND', 'no such resource');
      return { ...r };
    },
    normalize(raw) {
      return { externalId: raw.externalId, name: raw.name, content: raw.content, sourceUpdatedAt: raw.updatedAt, url: raw.url, title: raw.title, version: raw.version };
    },
    async syncChanges(ctx, { checkpoint } = {}) {
      const account = world.authorise(token(ctx));
      world.calls.push({ op: 'changes', account, token: token(ctx), checkpoint });
      if (world.failures.down) throw new ConnectorError('TRANSIENT', 'service unavailable (503)');
      const since = Number(checkpoint?.seq ?? 0);
      const a = world.accountOf(account);
      const entries = a.log.filter(e => e.seq > since);
      const changed = new Map(), removed = new Set();
      for (const e of entries) {
        if (e.op === 'put') { removed.delete(e.externalId); changed.set(e.externalId, true); }
        else { changed.delete(e.externalId); removed.add(e.externalId); }
      }
      const refs = [...changed.keys()].map(id => a.resources.get(id)).filter(Boolean)
        .map(r => ({ externalId: r.externalId, name: r.name, type: 'document', version: r.version, updatedAt: r.updatedAt }));
      const top = a.log.length ? a.log[a.log.length - 1].seq : since;
      return { changed: refs, removed: [...removed], checkpoint: { seq: Math.max(top, since) } };
    },
    async health() { return world.failures.down ? { ok: false, detail: 'down' } : { ok: true }; },
  };
  return { ...base, ...overrides };
}
